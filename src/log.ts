import { appendFile, readFile } from "node:fs/promises";
import type { DedupEvent } from "./rewrite.js";

/**
 * The transparency log is a JSON Lines (`.jsonl`) file: one `DedupEvent`
 * (see rewrite.ts) per line, appended-only, human-readable, and trivially
 * greppable/parseable by other tools. Every field needed to answer "what
 * got dropped, why, how big was it, and what earlier turn does it point at"
 * is present on every line — nothing is summarized away at write time.
 */

/** Appends one line per event to the transparency log at `logPath`, creating the file if needed. */
export async function appendEvents(logPath: string, events: DedupEvent[]): Promise<void> {
  if (events.length === 0) return;
  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await appendFile(logPath, lines, "utf8");
}

/**
 * Reads and parses every event from the transparency log at `logPath`.
 * Blank lines are skipped. Malformed lines are skipped with a warning
 * written to stderr rather than aborting the whole read, since a
 * transparency log that's 99% readable is far more useful than refusing to
 * report anything because of one corrupt trailing line (e.g. from a killed
 * process mid-write).
 */
export async function readEvents(logPath: string): Promise<DedupEvent[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const events: DedupEvent[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as DedupEvent);
    } catch {
      process.stderr.write(
        `[contextor] warning: skipping malformed transparency log line ${index + 1} in ${logPath}\n`,
      );
    }
  }
  return events;
}
