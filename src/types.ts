/**
 * A documented subset of the Anthropic Messages API request/response shape
 * (https://docs.claude.com/en/api/messages), covering exactly what Contextor
 * needs to inspect: `system`, `messages`, and the content-block variants it
 * knows how to dedupe (`text`, `tool_result`) plus a passthrough fallback for
 * every other block type (`image`, `tool_use`, `thinking`, `document`, etc.)
 * so unfamiliar or future block shapes are never mutated or dropped.
 *
 * Contextor only ever reads/rewrites the *request* shape below. The response
 * body is never parsed or typed — it is forwarded byte-for-byte, since
 * Contextor's one hard rule is that it never alters answer content.
 */

export type AnthropicRole = "user" | "assistant";

/** A block Contextor understands and may rewrite. */
export interface AnthropicTextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

/** A tool_result block Contextor understands and may rewrite. */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
  [key: string]: unknown;
}

/**
 * Any other documented or future block type (`image`, `tool_use`,
 * `thinking`, `redacted_thinking`, `document`, `server_tool_use`, ...).
 * Contextor passes these through completely untouched — see README
 * Limitations.
 */
export interface AnthropicOtherBlock {
  type: string;
  [key: string]: unknown;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolResultBlock
  | AnthropicOtherBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
  [key: string]: unknown;
}

/**
 * The subset of request fields Contextor cares about. `[key: string]:
 * unknown` preserves every other field (model, max_tokens, temperature,
 * tools, tool_choice, metadata, stream, ...) exactly as received, so nothing
 * is lost when the request is re-serialized after dedup.
 */
export interface AnthropicMessagesRequest {
  model?: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  [key: string]: unknown;
}

export function isTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
  return block.type === "text" && typeof (block as AnthropicTextBlock).text === "string";
}

export function isToolResultBlock(
  block: AnthropicContentBlock,
): block is AnthropicToolResultBlock {
  return block.type === "tool_result";
}
