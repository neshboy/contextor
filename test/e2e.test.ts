import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createServer } from "../src/server.js";
import { readEvents } from "../src/log.js";
import { startStubUpstream, type StubUpstream } from "./fixtures/stub-upstream.js";
import { SAMPLE_FILE_CONTENT } from "./fixtures/sample-content.js";

/**
 * Real end-to-end proxy test.
 *
 * This starts TWO real local HTTP servers with real sockets:
 *   1. a stub "upstream model API" (test/fixtures/stub-upstream.ts) so the
 *      test never spends real API credits, and
 *   2. the actual Contextor proxy (src/server.ts's `createServer`, the exact
 *      code `contextor serve` runs), pointed at that stub.
 *
 * It then makes real HTTP requests with Node's global `fetch` against
 * Contextor's own listening port — exactly as an agent's HTTP client would —
 * and inspects what the stub upstream actually received on the wire, plus
 * what Contextor actually sent back to the client. No request handler is
 * called directly/in-process anywhere in this file.
 */

async function startContextor(options: {
  upstream: string;
  logPath: string;
  minBlockBytes?: number;
  normalizeWhitespace?: boolean;
}): Promise<{ baseUrl: string; server: http.Server; close: () => Promise<void> }> {
  const server = createServer({
    upstream: options.upstream,
    port: 0,
    logPath: options.logPath,
    minBlockBytes: options.minBlockBytes ?? 200,
    normalizeWhitespace: options.normalizeWhitespace ?? false,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected Contextor to be listening on a TCP port");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function messagesRequestBody(messages: unknown[]): string {
  return JSON.stringify({
    model: "claude-test-model",
    max_tokens: 1024,
    system: "You are a coding assistant operating in a sandboxed repository.",
    messages,
  });
}

/**
 * The raw wire-format bytes of a JSON request/response body escape control
 * characters like newlines (a real multi-line file's actual `\n` byte
 * becomes the two literal characters `\` and `n` inside a JSON string). To
 * check whether a raw HTTP body contains a given piece of content
 * byte-for-byte as it would appear *inside* a JSON string field, compare
 * against this JSON-escaped form rather than the original multi-line string.
 */
function asJsonStringLiteral(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

describe("Contextor end-to-end proxy", () => {
  let stub: StubUpstream;
  let contextor: { baseUrl: string; close: () => Promise<void> };
  let logDir: string;
  let logPath: string;

  beforeAll(async () => {
    stub = await startStubUpstream();
    logDir = await mkdtemp(path.join(tmpdir(), "contextor-e2e-"));
    logPath = path.join(logDir, "contextor.log.jsonl");
    contextor = await startContextor({ upstream: stub.baseUrl, logPath });
  });

  afterAll(async () => {
    await contextor.close();
    await stub.close();
    await rm(logDir, { recursive: true, force: true });
  });

  const firstUserMessage = { role: "user", content: [{ type: "text", text: "Please read foo.ts and summarize it." }] };
  const turn1Messages = [
    firstUserMessage,
    { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "read_file", input: { path: "foo.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: SAMPLE_FILE_CONTENT }] },
  ];

  it("turn 1: forwards a brand-new large content block to upstream in full, and passes the response back unchanged", async () => {
    const res = await fetch(`${contextor.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key-not-real" },
      body: messagesRequestBody(turn1Messages),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; content: { text: string }[] };
    expect(body.content[0].text).toBe("stub response #1");

    // The stub upstream must have received the full file content, byte for byte.
    expect(stub.receivedRequests).toHaveLength(1);
    expect(stub.receivedRequests[0].path).toBe("/v1/messages");
    expect(stub.receivedRequests[0].rawBody).toContain(asJsonStringLiteral(SAMPLE_FILE_CONTENT));
    // Real auth headers are forwarded to upstream untouched.
    expect(stub.receivedRequests[0].headers["x-api-key"]).toBe("test-key-not-real");

    // First time seeing this content in this conversation - nothing to dedupe yet.
    const events = await readEvents(logPath);
    expect(events).toHaveLength(0);
  });

  it("turn 2: dedupes the repeated large content block before it reaches upstream, and still passes the response back unchanged", async () => {
    // A stateless chat-completions-style API means the whole growing history
    // (including turn 1's file read) is resent, plus a new, deliberately
    // duplicated occurrence of the exact same large content block.
    const turn2Messages = [
      ...turn1Messages,
      { role: "assistant", content: [{ type: "text", text: "Got it — let me double check that." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_2", name: "read_file", input: { path: "foo.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: SAMPLE_FILE_CONTENT }] },
    ];

    const res = await fetch(`${contextor.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key-not-real" },
      body: messagesRequestBody(turn2Messages),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; content: { text: string }[] };
    // Contextor never touches answer content - the client gets exactly what
    // the stub's SECOND canned response was, proving passthrough is unchanged.
    expect(body.content[0].text).toBe("stub response #2");
    expect(body.id).toBe("msg_stub_2");

    // The critical assertion: the large content block must NOT have reached
    // upstream a second time, in either its resent-history position or its
    // brand-new position - both get replaced with a short reference.
    expect(stub.receivedRequests).toHaveLength(2);
    const secondRawBody = stub.receivedRequests[1].rawBody;
    expect(secondRawBody).not.toContain(asJsonStringLiteral(SAMPLE_FILE_CONTENT));
    const placeholderOccurrences = secondRawBody.split("[contextor: duplicate content omitted").length - 1;
    expect(placeholderOccurrences).toBe(2);

    // The rewritten request upstream received must still be valid,
    // same-shaped JSON: same number of messages, same roles, in order.
    const forwarded = JSON.parse(secondRawBody) as { messages: { role: string }[] };
    expect(forwarded.messages).toHaveLength(turn2Messages.length);
    expect(forwarded.messages.map((m) => m.role)).toEqual(turn2Messages.map((m) => m.role));

    // And the transparency log now has exactly two dedup events, both
    // pointing back at the same original occurrence from turn 1.
    const events = await readEvents(logPath);
    expect(events).toHaveLength(2);
    expect(events[0].referencedTurnLabel).toBe(events[1].referencedTurnLabel);
    expect(events[0].referencedTurnLabel).toContain("message[2]");
    for (const event of events) {
      expect(event.blockType).toBe("tool_result");
      expect(event.originalBytes).toBeGreaterThan(5000);
      // The placeholder is always strictly smaller than what it replaces
      // (guaranteed by rewriteRequest's net-loss guard), and in practice a
      // small constant-ish size regardless of how large the original was.
      expect(event.replacedBytes).toBeLessThan(event.originalBytes);
      expect(event.replacedBytes).toBeLessThan(300);
    }
  });

  it("passes through non-messages requests (arbitrary path/method) completely untouched", async () => {
    const res = await fetch(`${contextor.baseUrl}/v1/models`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: [{ id: "claude-stub" }] });
  });

  it("correctly relays a gzip-compressed upstream response without double-decoding it", async () => {
    const res = await fetch(`${contextor.baseUrl}/v1/gzip-test`, { method: "GET" });
    expect(res.status).toBe(200);
    // Node's fetch auto-decompresses; if Contextor forwarded the stale
    // content-encoding/content-length headers from upstream alongside the
    // already-decoded bytes it re-streams, this client-side fetch would
    // try to gunzip plain JSON and fail. Getting a clean parse here proves
    // the header-stripping in server.ts is correct.
    const body = await res.json();
    expect(body).toEqual({ hello: "world", compressed: true });
  });

  it("does not dedupe between conversations that opt out of the default heuristic via distinct conversation-id headers", async () => {
    const isolatedMessages = [
      { role: "user", content: [{ type: "text", text: "unrelated task" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "iso_1", content: SAMPLE_FILE_CONTENT }] },
    ];

    const first = await fetch(`${contextor.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-contextor-conversation-id": "isolated-a" },
      body: messagesRequestBody(isolatedMessages),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${contextor.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-contextor-conversation-id": "isolated-b" },
      body: messagesRequestBody(isolatedMessages),
    });
    expect(second.status).toBe(200);

    const lastRawBody = stub.receivedRequests[stub.receivedRequests.length - 1].rawBody;
    // Different conversation id -> treated as a brand-new conversation ->
    // the "repeated" content is actually forwarded in full, not deduped.
    expect(lastRawBody).toContain(asJsonStringLiteral(SAMPLE_FILE_CONTENT));
  });
});
