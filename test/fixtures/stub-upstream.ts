import http from "node:http";
import zlib from "node:zlib";

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
}

export interface StubUpstream {
  baseUrl: string;
  receivedRequests: ReceivedRequest[];
  close: () => Promise<void>;
}

/**
 * A real local HTTP server standing in for "the model API" in tests, so the
 * end-to-end proxy test never spends real API credits. It records every
 * request it actually receives (so tests can assert on exactly what
 * Contextor forwarded upstream) and returns small, deterministic,
 * distinguishable canned responses that tests can check came back through
 * Contextor byte-for-byte unchanged.
 */
export async function startStubUpstream(): Promise<StubUpstream> {
  const receivedRequests: ReceivedRequest[] = [];
  let messagesCallCount = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://stub.local");
      receivedRequests.push({ method: req.method ?? "GET", path: url.pathname, headers: req.headers, rawBody });

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        messagesCallCount += 1;
        const body = JSON.stringify({
          id: `msg_stub_${messagesCallCount}`,
          type: "message",
          role: "assistant",
          model: "claude-stub",
          content: [{ type: "text", text: `stub response #${messagesCallCount}` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }

      if (url.pathname === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "claude-stub" }] }));
        return;
      }

      if (url.pathname === "/v1/gzip-test" && req.method === "GET") {
        const payload = JSON.stringify({ hello: "world", compressed: true });
        const gzipped = zlib.gzipSync(Buffer.from(payload, "utf8"));
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipped);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found in stub upstream" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected stub upstream to be listening on a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    receivedRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
