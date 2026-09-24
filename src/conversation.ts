import { createHash } from "node:crypto";
import type { AnthropicMessagesRequest } from "./types.js";

/**
 * Derives a stable key identifying "the same ongoing conversation" across
 * separate HTTP requests, with no header or client-side change required —
 * matching Contextor's core promise that the agent's own code never needs to
 * change.
 *
 * Coding-agent CLIs that talk to a stateless chat-completions-style API
 * resend the *entire* growing message history on every call: request 2's
 * `messages` array is request 1's array plus whatever was appended since.
 * The one thing that reliably stays constant across that whole sequence is
 * the system prompt plus the very first message (typically the user's
 * initial task/prompt, or the agent harness's fixed preamble). Hashing those
 * together gives a key that stays the same across a session's requests
 * without needing any session/cookie machinery.
 *
 * This is a heuristic, not a cryptographic session identifier: two genuinely
 * different conversations that happen to start with an identical system
 * prompt and an identical first message (e.g. two parallel runs of a fixed
 * template before any variable content has been added) will be treated as
 * the same conversation until they diverge. See README Limitations. Callers
 * that want a guaranteed-unique key can bypass the heuristic entirely by
 * sending an `x-contextor-conversation-id` header (see server.ts).
 */
export function deriveConversationKey(req: AnthropicMessagesRequest): string {
  const systemPart = typeof req.system === "string" ? req.system : JSON.stringify(req.system ?? "");
  const firstMessage = req.messages[0];
  const firstPart = firstMessage ? JSON.stringify(firstMessage) : "";
  return createHash("sha256")
    .update(systemPart + "\u0000" + firstPart, "utf8")
    .digest("hex");
}
