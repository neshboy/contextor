import type { DedupEvent } from "./rewrite.js";

export interface StatsSummary {
  totalEvents: number;
  conversations: number;
  originalBytes: number;
  replacedBytes: number;
  bytesSaved: number;
  estimatedTokensSaved: number;
  byBlockType: Record<string, number>;
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

/** Aggregates a flat list of transparency-log events into a savings summary. */
export function summarize(events: DedupEvent[]): StatsSummary {
  const byBlockType: Record<string, number> = {};
  for (const event of events) {
    byBlockType[event.blockType] = (byBlockType[event.blockType] ?? 0) + 1;
  }

  const originalBytes = sum(events.map((e) => e.originalBytes));
  const replacedBytes = sum(events.map((e) => e.replacedBytes));

  return {
    totalEvents: events.length,
    conversations: new Set(events.map((e) => e.conversationKey)).size,
    originalBytes,
    replacedBytes,
    bytesSaved: originalBytes - replacedBytes,
    estimatedTokensSaved: sum(events.map((e) => e.estimatedTokensSaved)),
    byBlockType,
  };
}

/** Renders a human-readable multi-line summary suitable for stdout. */
export function formatSummary(summary: StatsSummary): string {
  if (summary.totalEvents === 0) {
    return "[contextor] No dedup events recorded yet. Run `contextor serve` and proxy some real traffic first.";
  }

  const pct =
    summary.originalBytes > 0 ? ((summary.bytesSaved / summary.originalBytes) * 100).toFixed(1) : "0.0";

  const lines = [
    "[contextor] savings summary",
    `  conversations tracked:   ${summary.conversations}`,
    `  dedup events:            ${summary.totalEvents}`,
    ...Object.entries(summary.byBlockType).map(
      ([type, count]) => `    - ${type}:${" ".repeat(Math.max(1, 20 - type.length))}${count}`,
    ),
    `  bytes before dedup:      ${summary.originalBytes}`,
    `  bytes after dedup:       ${summary.replacedBytes}`,
    `  bytes saved:             ${summary.bytesSaved} (${pct}%)`,
    `  estimated tokens saved:  ${summary.estimatedTokensSaved}`,
  ];

  return lines.join("\n");
}
