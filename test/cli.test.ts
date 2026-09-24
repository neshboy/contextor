import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { startStubUpstream, type StubUpstream } from "./fixtures/stub-upstream.js";
import { SAMPLE_FILE_CONTENT } from "./fixtures/sample-content.js";

/** See the identical helper in e2e.test.ts: JSON escapes newlines, so raw-body
 * substring checks against a multi-line fixture must compare against the
 * escaped form, not the original string. */
function asJsonStringLiteral(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Integration test for the packaged CLI itself (dist/cli.js, built by
 * `npm run build` via the `pretest` script) - not just the library code it
 * calls. Spawns the real CLI as a real child process, exactly as a user
 * would run `contextor serve`/`contextor stats` from a shell, and drives it
 * with real HTTP requests against a real stub upstream.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP port"));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, matcher: RegExp, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${matcher} in: ${buffer}`)), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (matcher.test(buffer)) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
  });
}

describe("contextor CLI (real built binary, real child process)", () => {
  let stub: StubUpstream;
  let logDir: string;
  let logPath: string;
  let child: ChildProcessWithoutNullStreams;
  let port: number;

  beforeAll(async () => {
    stub = await startStubUpstream();
    logDir = await mkdtemp(path.join(tmpdir(), "contextor-cli-"));
    logPath = path.join(logDir, "contextor.log.jsonl");
    port = await getFreePort();

    child = spawn(
      process.execPath,
      [cliPath, "serve", "--upstream", stub.baseUrl, "--port", String(port), "--log", logPath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    await waitForLine(child, /listening on http:\/\/localhost:\d+/);
  });

  afterAll(async () => {
    child.kill();
    await stub.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it("serves real requests through the real spawned CLI process", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test-model",
        max_tokens: 1024,
        system: "cli-test-system-prompt",
        messages: [
          { role: "user", content: [{ type: "text", text: "read foo.ts" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SAMPLE_FILE_CONTENT }] },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: { text: string }[] };
    expect(body.content[0].text).toBe("stub response #1");
    expect(stub.receivedRequests[0].rawBody).toContain(asJsonStringLiteral(SAMPLE_FILE_CONTENT));
  });

  it("reports real savings via `contextor stats` reading the log the running server wrote", async () => {
    // Send a second request that repeats the same content, so the running
    // server (still up from the previous test) logs a real dedup event.
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-test-model",
        max_tokens: 1024,
        system: "cli-test-system-prompt",
        messages: [
          { role: "user", content: [{ type: "text", text: "read foo.ts" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: SAMPLE_FILE_CONTENT }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: SAMPLE_FILE_CONTENT }] },
        ],
      }),
    });

    const statsOutput = await new Promise<string>((resolve, reject) => {
      const statsChild = spawn(process.execPath, [cliPath, "stats", "--log", logPath], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      statsChild.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      statsChild.on("error", reject);
      statsChild.on("close", (code) => {
        if (code !== 0) reject(new Error(`contextor stats exited with code ${code}`));
        else resolve(stdout);
      });
    });

    // Both t1 and t2 in the second request repeat content already sent in
    // the first request, so both get deduped: 2 events in the log.
    expect(statsOutput).toContain("[contextor] savings summary");
    expect(statsOutput).toMatch(/dedup events:\s+2/);
    expect(statsOutput).toMatch(/bytes saved:\s+\d+/);
    expect(statsOutput).toMatch(/estimated tokens saved:\s+\d+/);
  });

  it("prints usage and a non-zero exit code for an unknown command", async () => {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const badChild = spawn(process.execPath, [cliPath, "not-a-real-command"], { stdio: ["ignore", "ignore", "pipe"] });
      badChild.on("error", reject);
      badChild.on("close", resolve);
    });
    expect(exitCode).toBe(1);
  });
});
