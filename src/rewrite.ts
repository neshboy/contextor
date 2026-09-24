import { byteLength, contentHash, type NormalizeOptions } from "./hash.js";
import { countTokensSimple } from "./tokens.js";
import type { DedupMemory, SeenEntry } from "./memory.js";
import {
  isTextBlock,
  isToolResultBlock,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicMessagesRequest,
  type AnthropicRole,
} from "./types.js";

/** The kinds of content Contextor knows how to compare and dedupe in v1. */
export type DedupBlockType = "message_string" | "text" | "tool_result";

/** One transparency-log-worthy dedup decision. */
export interface DedupEvent {
  timestamp: string;
  conversationKey: string;
  requestId: string;
  messageIndex: number;
  role: AnthropicRole;
  blockIndex: number;
  blockType: DedupBlockType;
  hash: string;
  originalBytes: number;
  replacedBytes: number;
  estimatedTokensSaved: number;
  referencedTurnLabel: string;
  referencedFirstSeenAt: string;
}

export interface RewriteOptions {
  memory: DedupMemory;
  conversationKey: string;
  requestId: string;
  /** Content blocks smaller than this (in UTF-8 bytes) are never deduped, even if repeated. */
  minBlockBytes: number;
  /** See {@link NormalizeOptions}. */
  normalizeWhitespace: boolean;
}

export interface RewriteResult {
  request: AnthropicMessagesRequest;
  events: DedupEvent[];
}

function buildTurnLabel(
  requestId: string,
  messageIndex: number,
  role: AnthropicRole,
  blockType: DedupBlockType,
  blockIndex: number,
): string {
  return `request ${requestId}, message[${messageIndex}] (${role}) block[${blockIndex}] (${blockType})`;
}

function buildPlaceholder(prior: SeenEntry, hash: string, originalBytes: number): string {
  return (
    `[contextor: duplicate content omitted — identical to content already sent in ` +
    `${prior.turnLabel} (${originalBytes} bytes, sha256:${hash.slice(0, 12)})]`
  );
}

interface DedupContext {
  opts: RewriteOptions;
  normOpts: NormalizeOptions;
  now: string;
  events: DedupEvent[];
}

/**
 * Core dedup decision for one piece of dedupable text. Either returns the
 * placeholder string to substitute in (and records a transparency-log
 * event), or returns `undefined` to leave the original content untouched
 * (either because it's below the size floor, is the first time this exact
 * content has been seen in this conversation, or because — right at the
 * size floor — the placeholder itself wouldn't actually be smaller).
 *
 * Side effect: the first time a given hash is seen for a conversation, it is
 * always remembered (via `opts.memory.remember`), regardless of whether a
 * substitution happens, so later occurrences can be recognized.
 */
function tryDedupBlock(
  text: string,
  messageIndex: number,
  role: AnthropicRole,
  blockIndex: number,
  blockType: DedupBlockType,
  ctx: DedupContext,
): string | undefined {
  const originalBytes = byteLength(text);
  if (originalBytes < ctx.opts.minBlockBytes) return undefined;

  const hash = contentHash(text, ctx.normOpts);
  const prior = ctx.opts.memory.lookup(ctx.opts.conversationKey, hash);

  if (prior) {
    const placeholder = buildPlaceholder(prior, hash, originalBytes);
    const replacedBytes = byteLength(placeholder);

    // Dedup should never make things worse. This can only happen right at
    // the --min-bytes boundary, where the placeholder text itself costs
    // more bytes than the (small) content it would replace.
    if (replacedBytes >= originalBytes) return undefined;

    ctx.events.push({
      timestamp: ctx.now,
      conversationKey: ctx.opts.conversationKey,
      requestId: ctx.opts.requestId,
      messageIndex,
      role,
      blockIndex,
      blockType,
      hash,
      originalBytes,
      replacedBytes,
      estimatedTokensSaved: Math.max(0, countTokensSimple(text) - countTokensSimple(placeholder)),
      referencedTurnLabel: prior.turnLabel,
      referencedFirstSeenAt: prior.firstSeenAt,
    });

    return placeholder;
  }

  const turnLabel = buildTurnLabel(ctx.opts.requestId, messageIndex, role, blockType, blockIndex);
  ctx.opts.memory.remember(ctx.opts.conversationKey, hash, {
    turnLabel,
    sizeBytes: originalBytes,
    firstSeenAt: ctx.now,
  });
  return undefined;
}

/**
 * Extracts a flat string to hash/compare from a `tool_result` block's
 * `content` field, which per the Anthropic API may be a plain string or an
 * array of content blocks. Returns `undefined` (meaning: skip dedup for this
 * block) when `content` is absent, or when it contains anything other than
 * plain text blocks (e.g. an image) — collapsing a mixed-content array down
 * to a single placeholder string would lose non-text sub-blocks, so v1
 * leaves those untouched. See README Limitations.
 */
function toolResultText(content: string | AnthropicContentBlock[] | undefined): string | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return content;
  if (content.every(isTextBlock)) {
    return content.map((block) => block.text).join("\n");
  }
  return undefined;
}

function rewriteMessage(
  message: AnthropicMessage,
  messageIndex: number,
  ctx: DedupContext,
): AnthropicMessage {
  if (typeof message.content === "string") {
    const replaced = tryDedupBlock(message.content, messageIndex, message.role, 0, "message_string", ctx);
    return replaced === undefined ? message : { ...message, content: replaced };
  }

  const content = message.content.map((block, blockIndex): AnthropicContentBlock => {
    if (isTextBlock(block)) {
      const replaced = tryDedupBlock(block.text, messageIndex, message.role, blockIndex, "text", ctx);
      return replaced === undefined ? block : { ...block, text: replaced };
    }

    if (isToolResultBlock(block)) {
      const text = toolResultText(block.content);
      if (text === undefined) return block;
      const replaced = tryDedupBlock(text, messageIndex, message.role, blockIndex, "tool_result", ctx);
      return replaced === undefined ? block : { ...block, content: replaced };
    }

    return block;
  });

  return { ...message, content };
}

/**
 * Rewrites an Anthropic Messages API request, replacing any content block
 * that is byte-identical (or near-duplicate, if normalization is enabled)
 * to content already sent earlier in the same conversation with a short
 * reference placeholder.
 *
 * Message count, message order, and each message's `role` are always
 * preserved exactly; only the `text`/`content` payload of an individual
 * block is ever replaced, and only when doing so is strictly smaller. This
 * guarantees the rewritten request has exactly the same shape the upstream
 * API already accepted for the original, so it remains a valid request.
 */
export function rewriteRequest(req: AnthropicMessagesRequest, opts: RewriteOptions): RewriteResult {
  const ctx: DedupContext = {
    opts,
    normOpts: { normalizeWhitespace: opts.normalizeWhitespace },
    now: new Date().toISOString(),
    events: [],
  };

  const messages = req.messages.map((message, messageIndex) => rewriteMessage(message, messageIndex, ctx));

  return { request: { ...req, messages }, events: ctx.events };
}
