import { describe, it, expect } from "vitest";
import { DedupMemory } from "../src/memory.js";
import { rewriteRequest, type RewriteOptions } from "../src/rewrite.js";
import type { AnthropicMessage, AnthropicMessagesRequest } from "../src/types.js";
import { SAMPLE_FILE_CONTENT, OTHER_FILE_CONTENT } from "./fixtures/sample-content.js";

function baseOptions(overrides: Partial<RewriteOptions> = {}): RewriteOptions {
  return {
    memory: new DedupMemory(),
    conversationKey: "conv-1",
    requestId: "req-1",
    minBlockBytes: 200,
    normalizeWhitespace: false,
    ...overrides,
  };
}

function request(messages: AnthropicMessage[]): AnthropicMessagesRequest {
  return { model: "claude-test", max_tokens: 1024, messages };
}

describe("rewriteRequest: dedup detection", () => {
  it("dedupes an identical tool_result block that reappears later in the same request", () => {
    const req = request([
      { role: "user", content: [{ type: "text", text: "read foo.ts" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "read_file", input: { path: "foo.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: SAMPLE_FILE_CONTENT }] },
      { role: "assistant", content: [{ type: "text", text: "ok, I see the file" }] },
      { role: "user", content: [{ type: "text", text: "read foo.ts again please" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_2", name: "read_file", input: { path: "foo.ts" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_2", content: SAMPLE_FILE_CONTENT }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(1);
    expect(events[0].blockType).toBe("tool_result");
    expect(events[0].messageIndex).toBe(6);
    expect(events[0].originalBytes).toBeGreaterThan(5000);
    expect(events[0].replacedBytes).toBeLessThan(events[0].originalBytes);
    expect(events[0].estimatedTokensSaved).toBeGreaterThan(0);

    const firstResultBlock = rewritten.messages[2].content;
    const secondResultBlock = rewritten.messages[6].content;
    if (typeof firstResultBlock === "string" || typeof secondResultBlock === "string") {
      throw new Error("expected array content");
    }

    // First occurrence: untouched, full content still present.
    expect(firstResultBlock[0]).toMatchObject({ type: "tool_result", tool_use_id: "tool_1", content: SAMPLE_FILE_CONTENT });

    // Second occurrence: replaced with a short reference, but tool_use_id (a
    // required, structural field) is preserved exactly.
    const secondBlock = secondResultBlock[0] as { type: string; tool_use_id: string; content: string };
    expect(secondBlock.type).toBe("tool_result");
    expect(secondBlock.tool_use_id).toBe("tool_2");
    expect(secondBlock.content).toContain("[contextor: duplicate content omitted");
    expect(secondBlock.content).toContain("message[2]");
    expect(secondBlock.content.length).toBeLessThan(300);
  });

  it("leaves content below --min-bytes untouched even when repeated", () => {
    const small = "same short result"; // well under the 200-byte default floor
    const req = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: small }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: small }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions({ minBlockBytes: 200 }));

    expect(events).toHaveLength(0);
    expect((rewritten.messages[1].content as { content: string }[])[0]).toMatchObject({ content: small });
  });

  it("never replaces content with a placeholder that would be larger (net-loss guard)", () => {
    const tiny = "hi"; // 2 bytes; the placeholder text is always far larger than that
    const req = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: tiny }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: tiny }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions({ minBlockBytes: 0 }));

    expect(events).toHaveLength(0);
    expect((rewritten.messages[1].content as { content: string }[])[0].content).toBe(tiny);
  });

  it("does not confuse two different large content blocks with each other", () => {
    const req = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SAMPLE_FILE_CONTENT }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: OTHER_FILE_CONTENT }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(0);
    expect((rewritten.messages[0].content as { content: string }[])[0].content).toBe(SAMPLE_FILE_CONTENT);
    expect((rewritten.messages[1].content as { content: string }[])[0].content).toBe(OTHER_FILE_CONTENT);
  });

  it("isolates dedup memory per conversation key", () => {
    const memory = new DedupMemory();

    // conv-a sees the content twice in one request -> second occurrence deduped.
    const reqA = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: SAMPLE_FILE_CONTENT }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a2", content: SAMPLE_FILE_CONTENT }] },
    ]);
    const resultA = rewriteRequest(reqA, baseOptions({ memory, conversationKey: "conv-a" }));
    expect(resultA.events).toHaveLength(1);

    // conv-b sees the *same* content for the first time -> must not be
    // treated as a duplicate just because conv-a already saw it.
    const reqB = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: SAMPLE_FILE_CONTENT }] },
    ]);
    const resultB = rewriteRequest(reqB, baseOptions({ memory, conversationKey: "conv-b" }));
    expect(resultB.events).toHaveLength(0);
  });

  it("dedupes across two separate sequential requests sharing a conversation key and memory", () => {
    const memory = new DedupMemory();

    // "Turn 1": the agent reads a file for the first time.
    const turn1 = request([
      { role: "user", content: [{ type: "text", text: "read foo.ts" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SAMPLE_FILE_CONTENT }] },
    ]);
    const result1 = rewriteRequest(turn1, baseOptions({ memory, conversationKey: "conv-x", requestId: "req-1" }));
    expect(result1.events).toHaveLength(0); // first time seeing it - nothing to dedupe against yet

    // "Turn 2": a stateless API means the whole history (including the file
    // read above) gets resent, plus a brand-new occurrence of the same file.
    const turn2 = request([
      ...turn1.messages,
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: SAMPLE_FILE_CONTENT }] },
    ]);
    const result2 = rewriteRequest(turn2, baseOptions({ memory, conversationKey: "conv-x", requestId: "req-2" }));

    // Both the resent historical copy AND the new copy get recognized as
    // duplicates of the content that was first sent in turn 1.
    expect(result2.events).toHaveLength(2);
    for (const event of result2.events) {
      expect(event.referencedTurnLabel).toContain("req-1");
    }
  });
});

describe("rewriteRequest: message-restructuring / shape preservation", () => {
  it("preserves message count, role order, and every block's type when substituting content", () => {
    const toolUseBlock = { type: "tool_use", id: "tu1", name: "search", input: { q: "add" } };
    const req = request([
      { role: "user", content: [{ type: "text", text: SAMPLE_FILE_CONTENT }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "sure, here's what I found" }, toolUseBlock],
      },
      { role: "user", content: [{ type: "text", text: SAMPLE_FILE_CONTENT }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(1);
    expect(rewritten.messages).toHaveLength(req.messages.length);
    expect(rewritten.messages.map((m) => m.role)).toEqual(req.messages.map((m) => m.role));

    const middleContent = rewritten.messages[1].content;
    if (typeof middleContent === "string") throw new Error("expected array content");
    expect(middleContent.map((b) => b.type)).toEqual(["text", "tool_use"]);
    // tool_use block is passed through byte-for-byte untouched.
    expect(middleContent[1]).toEqual(toolUseBlock);
  });

  it("passes through unknown/non-dedupable block types completely untouched, even when repeated", () => {
    const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const req = request([
      { role: "user", content: [imageBlock, imageBlock] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(0);
    expect(rewritten.messages[0].content).toEqual([imageBlock, imageBlock]);
  });

  it("dedupes whole-message string content while keeping it a string", () => {
    const req = request([
      { role: "user", content: SAMPLE_FILE_CONTENT },
      { role: "assistant", content: "ack" },
      { role: "user", content: SAMPLE_FILE_CONTENT },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(1);
    expect(events[0].blockType).toBe("message_string");
    expect(typeof rewritten.messages[2].content).toBe("string");
    expect(rewritten.messages[2].content as string).toContain("[contextor: duplicate content omitted");
    expect(rewritten.messages[0].content).toBe(SAMPLE_FILE_CONTENT);
  });

  it("collapses a tool_result content array of plain text blocks into a placeholder string when deduped", () => {
    const content = [{ type: "text" as const, text: SAMPLE_FILE_CONTENT }, { type: "text" as const, text: "part 2" }];
    const req = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(1);
    const second = (rewritten.messages[1].content as { content: unknown }[])[0];
    expect(typeof second.content).toBe("string");
    expect(second.content as string).toContain("[contextor: duplicate content omitted");
  });

  it("skips dedup for tool_result content arrays containing non-text blocks (documented limitation)", () => {
    const content = [
      { type: "text" as const, text: SAMPLE_FILE_CONTENT },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ];
    const req = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content }] },
    ]);

    const { request: rewritten, events } = rewriteRequest(req, baseOptions());

    expect(events).toHaveLength(0);
    expect((rewritten.messages[1].content as { content: unknown }[])[0].content).toEqual(content);
  });
});

describe("rewriteRequest: near-duplicate (whitespace-normalized) mode", () => {
  it("dedupes content that differs only by whitespace when normalizeWhitespace is enabled", () => {
    const withExtraBlankLines = SAMPLE_FILE_CONTENT.replace(/\n/g, "\n\n") + "   ";
    const req = request([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SAMPLE_FILE_CONTENT }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: withExtraBlankLines }] },
    ]);

    const exact = rewriteRequest(req, baseOptions({ normalizeWhitespace: false }));
    expect(exact.events).toHaveLength(0);

    const nearDup = rewriteRequest(req, baseOptions({ normalizeWhitespace: true }));
    expect(nearDup.events).toHaveLength(1);
  });
});
