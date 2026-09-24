import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvents, readEvents } from "../src/log.js";
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

describe("transparency log", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty array when the log file does not exist yet", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "contextor-log-"));
    const events = await readEvents(path.join(dir, "does-not-exist.jsonl"));
    expect(events).toEqual([]);
  });

  it("round-trips events written with appendEvents through readEvents", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "contextor-log-"));
    const logPath = path.join(dir, "contextor.log.jsonl");

    const first = makeEvent({ requestId: "req-1" });
    const second = makeEvent({ requestId: "req-2", messageIndex: 5 });

    await appendEvents(logPath, [first]);
    await appendEvents(logPath, [second]);

    const events = await readEvents(logPath);
    expect(events).toEqual([first, second]);
  });

  it("writes exactly one JSON line per event (greppable JSONL format)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "contextor-log-"));
    const logPath = path.join(dir, "contextor.log.jsonl");

    await appendEvents(logPath, [makeEvent(), makeEvent()]);

    const raw = await readFile(logPath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("does nothing when appendEvents is called with an empty array", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "contextor-log-"));
    const logPath = path.join(dir, "contextor.log.jsonl");

    await appendEvents(logPath, []);
    const events = await readEvents(logPath);
    expect(events).toEqual([]);
  });

  it("skips malformed lines with a warning instead of throwing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "contextor-log-"));
    const logPath = path.join(dir, "contextor.log.jsonl");

    const goodEvent = makeEvent();
    await appendFile(logPath, JSON.stringify(goodEvent) + "\n" + "{not valid json\n");

    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const events = await readEvents(logPath);
    warnSpy.mockRestore();

    expect(events).toEqual([goodEvent]);
  });
});
