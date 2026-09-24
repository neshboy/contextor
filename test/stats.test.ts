import { describe, it, expect } from "vitest";
import { summarize, formatSummary } from "../src/stats.js";
import type { DedupEvent } from "../src/rewrite.js";

function makeEvent(overrides: Partial<DedupEvent> = {}): DedupEvent {
  return {
    timestamp: "2026-09-24T00:00:00.000Z",
    conversationKey: "conv-1",
    requestId: "req-1",
    messageIndex: 2,
    role: "user",
    blockIndex: 0,
    blockType: "tool_result",
    hash: "abc123",
    originalBytes: 5000,
    replacedBytes: 120,
    estimatedTokensSaved: 900,
    referencedTurnLabel: "request req-0, message[0] (user) block[0] (tool_result)",
    referencedFirstSeenAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarize", () => {
  it("returns all-zero totals for an empty event list", () => {
    const summary = summarize([]);
    expect(summary).toEqual({
      totalEvents: 0,
      conversations: 0,
      originalBytes: 0,
      replacedBytes: 0,
      bytesSaved: 0,
      estimatedTokensSaved: 0,
      byBlockType: {},
    });
  });

  it("sums bytes/tokens across events and counts distinct conversations", () => {
    const events = [
      makeEvent({ conversationKey: "conv-1", originalBytes: 5000, replacedBytes: 120, estimatedTokensSaved: 900 }),
      makeEvent({ conversationKey: "conv-1", originalBytes: 3000, replacedBytes: 100, estimatedTokensSaved: 600 }),
      makeEvent({ conversationKey: "conv-2", originalBytes: 1000, replacedBytes: 80, estimatedTokensSaved: 200, blockType: "text" }),
    ];

    const summary = summarize(events);

    expect(summary.totalEvents).toBe(3);
    expect(summary.conversations).toBe(2);
    expect(summary.originalBytes).toBe(9000);
    expect(summary.replacedBytes).toBe(300);
    expect(summary.bytesSaved).toBe(8700);
    expect(summary.estimatedTokensSaved).toBe(1700);
    expect(summary.byBlockType).toEqual({ tool_result: 2, text: 1 });
  });
});

describe("formatSummary", () => {
  it("reports a friendly message when there are no events yet", () => {
    const text = formatSummary(summarize([]));
    expect(text).toContain("No dedup events recorded yet");
  });

  it("includes bytes saved, percentage, and token estimate in the rendered summary", () => {
    const events = [makeEvent({ originalBytes: 1000, replacedBytes: 100, estimatedTokensSaved: 200 })];
    const text = formatSummary(summarize(events));

    expect(text).toContain("bytes before dedup:      1000");
    expect(text).toContain("bytes after dedup:       100");
    expect(text).toContain("bytes saved:             900 (90.0%)");
    expect(text).toContain("estimated tokens saved:  200");
    expect(text).toContain("tool_result:");
  });
});
