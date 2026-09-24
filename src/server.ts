import http from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { DedupMemory } from "./memory.js";
import { rewriteRequest, type DedupEvent } from "./rewrite.js";
import { deriveConversationKey } from "./conversation.js";
import { appendEvents } from "./log.js";
import type { AnthropicMessagesRequest } from "./types.js";

/** Request headers Contextor never forwards verbatim, because they either
 * describe the *incoming* connection (hop-by-hop) or describe a body size
 * that may change once we rewrite the JSON payload. `fetch` computes correct
 * replacements for these automatically. */
const EXCLUDED_REQUEST_HEADERS = new Set(["host", "content-length", "connection"]);

/** Response headers Contextor never forwards verbatim. Node's `fetch`
 * transparently decompresses gzip/deflate/br responses, so `content-encoding`
 * and `content-length` on the *original* upstream response no longer
 * describe the bytes we're about to write; forwarding them unchanged would
 * make the client try to gunzip already-decoded bytes. Dropping them and
 * letting Node's http server use chunked transfer encoding keeps the
 * response byte-for-byte correct for the client either way. */
const EXCLUDED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

const CONVERSATION_ID_HEADER = "x-contextor-conversation-id";

export interface ServeOptions {
  /** Base URL of the real upstream model API, e.g. "https://api.anthropic.com". */
  upstream: string;
  port: number;
  /** Path to the JSON Lines transparency log. */
  logPath: string;
  /** Content blocks smaller than this (in UTF-8 bytes) are never deduped. */
  minBlockBytes: number;
  /** Enable near-duplicate (whitespace-normalized) hashing. See hash.ts. */
  normalizeWhitespace: boolean;
  /** Called with the events produced by each rewritten request, after they've been logged. Mainly for tests. */
  onEvents?: (events: DedupEvent[]) => void;
}

function collectRequestHeaders(req: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || EXCLUDED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function collectResponseHeaders(res: Response): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of res.headers.entries()) {
    if (EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * If this looks like an Anthropic Messages API request (POST /v1/messages
 * with a JSON body containing a `messages` array), rewrites it to dedupe
 * repeated content and returns the rewritten body plus any transparency-log
 * events. Otherwise — a different path, a non-POST method, an empty body, or
 * a body that isn't valid JSON matching the expected shape — returns the
 * original bytes untouched. Contextor only ever rewrites requests it's
 * confident it understands; anything else is forwarded as-is rather than
 * risking sending upstream a request it can't parse.
 */
function maybeRewrite(
  pathname: string,
  method: string,
  rawBody: Buffer,
  memory: DedupMemory,
  options: ServeOptions,
  conversationIdHeader: string | undefined,
): { body: Buffer; events: DedupEvent[] } {
  const looksLikeMessagesRequest = method === "POST" && pathname === "/v1/messages" && rawBody.length > 0;
  if (!looksLikeMessagesRequest) {
    return { body: rawBody, events: [] };
  }

  let parsed: AnthropicMessagesRequest;
  try {
    parsed = JSON.parse(rawBody.toString("utf8")) as AnthropicMessagesRequest;
  } catch {
    return { body: rawBody, events: [] };
  }

  if (!Array.isArray(parsed.messages)) {
    return { body: rawBody, events: [] };
  }

  const conversationKey = conversationIdHeader ?? deriveConversationKey(parsed);
  const requestId = randomUUID();

  const { request, events } = rewriteRequest(parsed, {
    memory,
    conversationKey,
    requestId,
    minBlockBytes: options.minBlockBytes,
    normalizeWhitespace: options.normalizeWhitespace,
  });

  return { body: Buffer.from(JSON.stringify(request), "utf8"), events };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  memory: DedupMemory,
  options: ServeOptions,
): Promise<void> {
  const rawBody = await readRequestBody(req);
  const upstreamUrl = new URL(req.url ?? "/", options.upstream);
  const conversationIdHeader = req.headers[CONVERSATION_ID_HEADER];

  const { body, events } = maybeRewrite(
    upstreamUrl.pathname,
    req.method ?? "GET",
    rawBody,
    memory,
    options,
    Array.isArray(conversationIdHeader) ? conversationIdHeader[0] : conversationIdHeader,
  );

  if (events.length > 0) {
    options.onEvents?.(events);
    try {
      await appendEvents(options.logPath, events);
    } catch (err) {
      process.stderr.write(`[contextor] warning: failed to write transparency log: ${String(err)}\n`);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: collectRequestHeaders(req),
    body: hasBody ? body : undefined,
  });

  res.writeHead(upstreamResponse.status, collectResponseHeaders(upstreamResponse));

  if (upstreamResponse.body) {
    await new Promise<void>((resolve, reject) => {
      const nodeStream = Readable.fromWeb(upstreamResponse.body as WebReadableStream<Uint8Array>);
      nodeStream.on("error", reject);
      res.on("error", reject);
      res.on("finish", resolve);
      nodeStream.pipe(res);
    });
  } else {
    res.end();
  }
}

/**
 * Creates (but does not start) the Contextor proxy server. Call `.listen()`
 * on the result, as with any `http.Server`.
 *
 * Every request is forwarded to `options.upstream` unchanged, EXCEPT that a
 * `POST /v1/messages` request's body is rewritten first to replace
 * already-seen content blocks with short references (see rewrite.ts). The
 * upstream's response is always streamed back to the client byte-for-byte,
 * with only hop-by-hop and compression-describing headers stripped (see
 * `EXCLUDED_RESPONSE_HEADERS`) — Contextor never alters answer content.
 */
export function createServer(options: ServeOptions): http.Server {
  const memory = new DedupMemory();

  return http.createServer((req, res) => {
    handleRequest(req, res, memory, options).catch((err: unknown) => {
      process.stderr.write(`[contextor] error handling request: ${String(err)}\n`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: { type: "contextor_proxy_error", message: String(err) } }));
    });
  });
}
