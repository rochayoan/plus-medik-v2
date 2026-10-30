import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { routeDokployRequest } from "./router.js";

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024; // Kapso batches are not accepted in phase 1.

class RequestTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  let total = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    const bytes: Uint8Array = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new RequestTooLarge();
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    // Reject large bodies before reading; no payload data appears in logs.
    const length = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      response.writeHead(413).end();
      return;
    }
    // Reject a live Kapso webhook *before* reading potentially sensitive data.
    if (pathname === "/api/kapso/webhook") {
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, reason: "DURABLE_WEBHOOK_QUEUE_NOT_IMPLEMENTED" }));
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    }
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
    const origin = "http://localhost";
    const webRequest = new Request(new URL(request.url ?? "/", origin), {
      method,
      headers,
      ...(body && body.byteLength ? { body: body as BodyInit } : {})
    });
    const webResponse = await routeDokployRequest(webRequest);
    const responseHeaders: Record<string, string> = {};
    webResponse.headers.forEach((value, key) => { responseHeaders[key] = value; });
    response.writeHead(webResponse.status, responseHeaders);
    if (method === "HEAD") response.end();
    else response.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    const status = error instanceof RequestTooLarge ? 413 : 500;
    if (!response.headersSent) response.writeHead(status, { "cache-control": "no-store" });
    response.end();
  }
}

const portRaw = process.env.PORT ?? String(DEFAULT_PORT);
const port = Number(portRaw);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const server = createServer((req, res) => { void serve(req, res); });
server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ service: "plusmedik-dokploy", event: "listening", port, webhookReady: false }));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
