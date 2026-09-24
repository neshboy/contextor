#!/usr/bin/env node
import path from "node:path";
import { createServer } from "./server.js";
import { readEvents } from "./log.js";
import { summarize, formatSummary } from "./stats.js";

const DEFAULT_PORT = 8787;
const DEFAULT_LOG_PATH = "./contextor.log.jsonl";
const DEFAULT_MIN_BLOCK_BYTES = 200;

function printUsage(): void {
  process.stderr.write(
    "contextor - a model-and-vendor-agnostic, token-saving proxy for coding agents\n\n" +
      "Usage:\n" +
      "  contextor serve --upstream <url> [--port <port>] [--log <path>] [--min-bytes <n>] [--normalize-whitespace]\n" +
      "  contextor stats [--log <path>]\n\n" +
      "Examples:\n" +
      "  contextor serve --upstream https://api.anthropic.com --port 8787\n" +
      "  contextor stats --log ./contextor.log.jsonl\n\n" +
      "Point your coding agent's API base URL at http://localhost:<port> instead of\n" +
      "the real upstream, and Contextor forwards every request unchanged except for\n" +
      "deduplicating content it has already sent upstream earlier in the same\n" +
      "conversation. Every dedup decision is appended to the transparency log.\n",
  );
}

function parseFlags(args: string[], booleanFlags: Set<string>): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      process.stderr.write(`[contextor] warning: ignoring unexpected argument "${arg}"\n`);
      continue;
    }
    const name = arg.slice(2);
    if (booleanFlags.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = args[++i];
    if (value === undefined) {
      process.stderr.write(`[contextor] error: flag --${name} requires a value\n`);
      process.exitCode = 1;
      continue;
    }
    flags.set(name, value);
  }
  return flags;
}

async function runServe(args: string[]): Promise<void> {
  const flags = parseFlags(args, new Set(["normalize-whitespace"]));

  const upstream = flags.get("upstream");
  if (typeof upstream !== "string") {
    process.stderr.write("[contextor] error: --upstream <url> is required\n\n");
    printUsage();
    process.exitCode = 1;
    return;
  }

  const portRaw = flags.get("port");
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`[contextor] error: --port must be a positive number, got "${String(portRaw)}"\n`);
    process.exitCode = 1;
    return;
  }

  const logPath = (flags.get("log") as string | undefined) ?? DEFAULT_LOG_PATH;

  const minBytesRaw = flags.get("min-bytes");
  const minBlockBytes = minBytesRaw === undefined ? DEFAULT_MIN_BLOCK_BYTES : Number(minBytesRaw);
  if (!Number.isFinite(minBlockBytes) || minBlockBytes < 0) {
    process.stderr.write(`[contextor] error: --min-bytes must be a non-negative number, got "${String(minBytesRaw)}"\n`);
    process.exitCode = 1;
    return;
  }

  const normalizeWhitespace = flags.get("normalize-whitespace") === true;

  new URL(upstream); // throws if not a valid absolute URL

  const server = createServer({ upstream, port, logPath, minBlockBytes, normalizeWhitespace });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });

  // Report the actual bound port (relevant when --port 0 was passed to ask
  // the OS for any free port) rather than blindly echoing the requested one.
  const address = server.address();
  const boundPort = address && typeof address !== "string" ? address.port : port;

  process.stderr.write(
    `[contextor] listening on http://localhost:${boundPort}\n` +
      `[contextor] forwarding to ${upstream}\n` +
      `[contextor] transparency log: ${path.resolve(logPath)}\n`,
  );

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runStats(args: string[]): Promise<void> {
  const flags = parseFlags(args, new Set());
  const logPath = (flags.get("log") as string | undefined) ?? DEFAULT_LOG_PATH;

  const events = await readEvents(logPath);
  const summary = summarize(events);
  process.stdout.write(formatSummary(summary) + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "serve") {
    await runServe(argv.slice(1));
  } else if (command === "stats") {
    await runStats(argv.slice(1));
  } else {
    printUsage();
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[contextor] fatal error: ${message}\n`);
  process.exit(1);
});
