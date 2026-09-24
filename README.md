# Contextor

A model-and-vendor-agnostic proxy that sits between any CLI coding agent and its model API, **deduplicating repeated file reads and tool outputs already seen earlier in the conversation** — with a transparent "what got dropped and why" log — to cut token spend without the agent's own code needing to change at all.

## Why

Chat-completions-style APIs (Anthropic Messages, OpenAI-compatible, etc.) are stateless: every single request has to resend the *entire* conversation history, because the server remembers nothing between calls. A coding agent that reads `src/math.ts` on turn 2 keeps that file's full content sitting in the `messages` array it resends on turn 3, turn 4, turn 12 — forever, unchanged, at full size — even though nothing about it needs to be re-read. Many agents make this worse by re-reading or re-fetching things they've already seen (rechecking a file after an edit, re-running a search, re-fetching a URL), pasting the same large blob into the conversation a second time.

Every one of those repeated bytes gets tokenized and billed again, on every subsequent turn, for the lifetime of the session. This is a real, compounding cost problem, and it has nothing to do with what the agent's tools return — it's purely an artifact of how stateless history has to be resent.

Contextor sits in front of the model API as a transparent HTTP proxy. It never changes what the model is asked or what it answers — it only intervenes on the *redundant context* going out on the request side, replacing content it has already forwarded upstream earlier in the same conversation with a short reference, and logging exactly what it did.

### Contextor vs. mcpsqueeze

This is a sibling project to [mcpsqueeze](https://github.com/neshboy/mcpsqueeze), and the two are deliberately independent, non-overlapping implementations at different layers:

- **mcpsqueeze** sits at the **MCP protocol layer**: it wraps an MCP server and deduplicates/truncates individual `tools/call` *results* as they come back from that one tool server, before the agent's own context-management logic ever sees them.
- **Contextor** sits at the **model API layer**: it proxies the raw HTTP calls to the chat-completions endpoint itself — the full `messages` array, however it got built (MCP tool results, plain file reads, shell output, anything) — regardless of whether the agent uses MCP at all.

You can use either one alone, or both together (mcpsqueeze shrinking individual tool results, Contextor deduplicating whatever still ends up repeated in the resent history).

## How it works

1. Point your coding agent's model API base URL at Contextor instead of the real API. Contextor forwards every request to the real upstream and streams the real response straight back — for anything it doesn't touch, it's byte-for-byte invisible.
2. For `POST /v1/messages` requests (the [Anthropic Messages API](https://docs.claude.com/en/api/messages) shape — see Limitations for other shapes), Contextor inspects the `messages` array. Each `text` content block, `tool_result` block, and whole-message string content is hashed (SHA-256) and compared against everything it has already forwarded upstream earlier **in the same conversation** — including in *previous* HTTP requests, not just earlier in the current one.
3. Anything byte-identical (or, with `--normalize-whitespace`, identical after collapsing whitespace — a real, simple, deterministic "near-duplicate" mode) to something already sent gets replaced with a short reference, e.g.:

   ```
   [contextor: duplicate content omitted — identical to content already sent in request 098102aa-6ba1-4f8d-9565-7c4bb9146a3d, message[2] (user) block[0] (tool_result) (5600 bytes, sha256:0c93a487fc6a)]
   ```

   Message count, message order, and every message's `role` are always preserved exactly, and only a block's `text`/`content` payload is ever swapped — never its `type` or other structural fields (like `tool_use_id`) — so the rewritten request is still exactly the shape the upstream API already accepted. Substitution only happens when it's a strict size win; if the reference itself would be bigger than the original (only possible for content right at the size floor), the original is left untouched.
4. Every substitution is appended to a local **transparency log** (see format below) recording what was dropped, its original/replaced size, and exactly which earlier turn it pointed at.
5. The upstream's response is streamed back to the client exactly as received — Contextor never parses, rewrites, or even buffers the response body. **The model's actual answer is never touched, only the redundant context sent to produce it.**

Conversations are correlated across separate HTTP requests **without any special header or agent-side change**: Contextor hashes the request's `system` prompt plus its first message to derive a stable per-conversation key, since that's the one thing that reliably stays constant across a session's growing, resent history. (Callers that want a guaranteed-unique key instead of the heuristic can send an `x-contextor-conversation-id` header — useful for testing, or for forcing two requests to be treated as unrelated even if they happen to start identically.)

## Install / quick start

```bash
git clone <this-repo>
cd contextor
npm install
npm run build
```

Start the proxy, pointing it at the real upstream API:

```bash
node dist/cli.js serve --upstream https://api.anthropic.com --port 8787
# or, after `npm link` (or a global install), just:
contextor serve --upstream https://api.anthropic.com --port 8787
```

Then point your coding agent's API base URL at Contextor instead of the real endpoint. For any Anthropic-SDK-based CLI agent, that's typically an environment variable:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
# run your coding agent as normal - it still uses its own real API key,
# Contextor just relays it upstream unchanged.
```

Nothing else about the agent needs to change: it still sends its real API key (Contextor forwards auth headers untouched), still gets real model responses, and has no idea Contextor is there — except that a growing fraction of its repeated context stops costing tokens.

Once you've proxied some real traffic, see the savings:

```bash
node dist/cli.js stats --log ./contextor.log.jsonl
```

```
[contextor] savings summary
  conversations tracked:   1
  dedup events:            2
    - tool_result:         2
  bytes before dedup:      11200
  bytes after dedup:       400
  bytes saved:             10800 (96.4%)
  estimated tokens saved:  3052
```

(That's real output, from a two-turn example where a ~5.6KB file gets read once, then read again — once as resent history, once as a fresh re-read — two turns later. See [test/e2e.test.ts](./test/e2e.test.ts) for the exact scenario.)

### CLI reference

```
contextor serve --upstream <url> [--port <port>] [--log <path>] [--min-bytes <n>] [--normalize-whitespace]
contextor stats [--log <path>]
```

- `--upstream <url>` (required for `serve`) — base URL of the real model API, e.g. `https://api.anthropic.com`.
- `--port <port>` — port Contextor listens on (default `8787`).
- `--log <path>` — path to the transparency log (default `./contextor.log.jsonl`), used by both `serve` (to write) and `stats` (to read).
- `--min-bytes <n>` — content blocks smaller than this many UTF-8 bytes are never deduped, even if repeated (default `200`). Keeps Contextor from bothering with trivially small text where a reference wouldn't save anything meaningful.
- `--normalize-whitespace` — enables near-duplicate mode: collapses whitespace before hashing, so content that differs only in incidental whitespace (re-pasted with different trailing newlines, blank-line-only diffs, etc.) is still recognized as a duplicate.

## Transparency log format

The log at `--log <path>` (default `./contextor.log.jsonl`) is [JSON Lines](https://jsonlines.org/): one JSON object per dedup decision, one per line, append-only. Nothing is summarized away at write time — every field needed to answer "what got dropped, why, how big was it, and what earlier turn does it point at" is on every line:

```json
{
  "timestamp": "2026-09-24T10:28:39.932Z",
  "conversationKey": "559834ebd0e4ae06acace30c5b0850f8c323ea4c8bc4394a3d0b475cfd635a7c",
  "requestId": "d6f3b666-9844-4760-8309-9054899eb613",
  "messageIndex": 5,
  "role": "user",
  "blockIndex": 0,
  "blockType": "tool_result",
  "hash": "0c93a487fc6ac7ad854164f075bc0587b9aff5ae5cfae3137a61ce35cd74ff92",
  "originalBytes": 5600,
  "replacedBytes": 200,
  "estimatedTokensSaved": 1526,
  "referencedTurnLabel": "request 098102aa-6ba1-4f8d-9565-7c4bb9146a3d, message[2] (user) block[0] (tool_result)",
  "referencedFirstSeenAt": "2026-09-24T10:28:39.825Z"
}
```

| Field | Meaning |
|---|---|
| `timestamp` | When this dedup decision was made. |
| `conversationKey` | Contextor's internal key for "which conversation" (see How it works). |
| `requestId` | A fresh UUID generated per incoming HTTP request, so events from the same request share it. |
| `messageIndex` / `blockIndex` | Where in *this* request's `messages` array the duplicate was found. |
| `role` | The message's `role` (`user`/`assistant`). |
| `blockType` | `text` (a `text` content block), `tool_result`, or `message_string` (a whole message whose `content` was a plain string). |
| `hash` | The SHA-256 content hash used for the comparison. |
| `originalBytes` / `replacedBytes` | UTF-8 byte size before/after substitution. |
| `estimatedTokensSaved` | See Token estimation below. |
| `referencedTurnLabel` | Human-readable description of the earlier occurrence this one was recognized as a duplicate of. |
| `referencedFirstSeenAt` | When that earlier occurrence was first seen. |

Run `contextor stats` to aggregate the log into a summary (see above), or parse it yourself — it's just JSONL.

## Token estimation

Contextor counts tokens using [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer)'s `o200k_base` BPE encoding (the real GPT-4o-family tokenizer, not a fake stand-in). Anthropic does not publish an offline tokenizer for Claude models, so there is no way to get an exact Claude token count without calling Anthropic's own (paid, network-dependent) `count_tokens` endpoint on every request, which would defeat the purpose of a cost-saving proxy. `o200k_base` is used as a well-documented, deterministic approximation: BPE tokenizers across model families tend to agree within roughly 10-20% on ordinary English/code text, since they're trained on similar corpora with similar merge heuristics. Treat the absolute `estimatedTokensSaved` numbers as directionally meaningful, not exact Claude billing figures — the **byte-savings percentage** in `contextor stats` is the more trustworthy number, since a systematic tokenizer mismatch affects "before" and "after" by roughly the same factor and mostly cancels out in the ratio. If the tokenizer implementation ever throws on unusual input, Contextor falls back to a labeled `chars/4` heuristic rather than failing the request.

## Testing

```bash
npm test
```

This runs `tsc` to build `dist/` (via `pretest`), then `vitest run`, covering:

- **dedup detection** (`test/hash.test.ts`, part of `test/rewrite.test.ts`) — byte-identical hashing, the `--normalize-whitespace` near-duplicate mode, and per-conversation isolation.
- **message-restructuring** (`test/rewrite.test.ts`) — proves message count/role order/block types are preserved exactly after substitution, that only a strict size win ever triggers a substitution, and documents which block shapes are (and aren't) deduped.
- **a real end-to-end proxy test** (`test/e2e.test.ts`) — starts a real stub "upstream model API" (a real local `http.Server`, so no real API credits are spent) and the real Contextor proxy server, then makes real `fetch()` HTTP calls against Contextor's own listening port across two sequential requests with a deliberately duplicated large content block. Asserts the stub upstream actually received the full content on request 1 and a short reference on request 2, and that Contextor's response to the client matches the stub's response byte-for-byte both times. No request handler is ever called directly/in-process — everything goes over real sockets.
- **a real CLI integration test** (`test/cli.test.ts`) — spawns the actual built `dist/cli.js` as a real child process (`contextor serve`, then `contextor stats`) and drives it the same way.
- **token-estimate tests** (`test/tokens.test.ts`) and **stats-log parsing tests** (`test/log.test.ts`, `test/stats.test.ts`).

## Limitations

This is a focused v1, not a complete solution. Known limitations:

- **Only the Anthropic Messages API request shape is rewritten in v1.** `POST /v1/messages` bodies are inspected and deduped; every other path/method is forwarded completely untouched. OpenAI-compatible chat-completions-shaped APIs (`/v1/chat/completions`) are a natural extension (the same hash-and-substitute approach applies to their `messages`/`content` shape) but are not implemented here.
- **Streaming (`stream: true`) requests are supported for pass-through, but the request-side dedup logic only inspects the JSON request body**, which is unaffected by whether the *response* streams — request rewriting works the same either way. The response is always streamed back byte-for-byte regardless.
- **Dedup memory is in-memory and per-process.** Restarting `contextor serve` clears all conversation history; running multiple instances behind a load balancer would not share dedup state.
- **Conversation correlation is a heuristic, not a guaranteed session identifier.** Two genuinely different conversations that happen to start with an identical system prompt and an identical first message will be treated as the same conversation until they diverge (see How it works). Send `x-contextor-conversation-id` to opt out.
- **Only `text` and `tool_result` content blocks are dedup candidates.** `image`, `tool_use`, `thinking`, and other block types are always passed through untouched, even if repeated — substituting them would risk losing information Contextor doesn't have a safe placeholder for. A `tool_result` whose `content` is an array containing anything other than plain `text` sub-blocks is also left untouched, for the same reason.
- **Near-duplicate detection is whitespace-normalization only.** `--normalize-whitespace` is a real, simple, deterministic normalization (collapse+trim whitespace before hashing) — not fuzzy/semantic similarity matching.
- **Token counts are an estimate**, using GPT-4o-family BPE tokenization as a documented proxy for Claude's (non-public) tokenizer. See Token estimation above.
- **No persistence for the dedup index.** Only the transparency log persists across restarts; the hash index used to detect duplicates does not.

## License

MIT — see [LICENSE](./LICENSE).
