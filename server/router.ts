import { enqueueWebhook, resolveInboxConfig } from "./inbox.js";
import { createInboxStorage } from "./inbox-storage.js";
// Dokploy phase 1: HTTP adapter for existing pure Request/Response handlers.
// The webhook stays closed until a durable queue and all runtime flags are present.
// Local mode uses an encrypted, fsynced Dokploy volume; Supabase is unchanged.
type HttpHandler = (request: Request) => Response | Promise<Response>;
type HttpModule = Record<string, unknown>;

const routes: Record<string, () => Promise<HttpModule>> = {
  "/api/web/catalog": () => import("../api/web/catalog.js"),
  "/api/web/quote": () => import("../api/web/quote.js"),
  "/api/internal/crm/attention/status": () => import("../api/internal/crm/attention/status.js"),
  "/api/internal/crm/attention/action": () => import("../api/internal/crm/attention/action.js"),
  "/api/audit/recover": () => import("../api/audit/recover.js"),
  "/api/outbox/drain": () => import("../api/outbox/drain.js")
};

function json(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export async function routeDokployRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
    return json(200, { ok: true, service: "plusmedik-dokploy", webhookReady: false });
  }
  if (path === "/readyz" && (request.method === "GET" || request.method === "HEAD")) {
    const config = resolveInboxConfig(process.env);
    if (!config || !(await createInboxStorage(config).ready())) {
      return json(503, { ok: false, reason: "DURABLE_WEBHOOK_QUEUE_NOT_IMPLEMENTED" });
    }
    return json(200, { ok: true, service: "plusmedik-dokploy", webhookReady: true });
  }
  if (path === "/api/kapso/webhook") {
    const config = resolveInboxConfig(process.env);
    if (!config) return json(503, { ok: false, reason: "DURABLE_WEBHOOK_QUEUE_NOT_IMPLEMENTED" });
    const storage = createInboxStorage(config);
    if (!(await storage.ready())) return json(503, { ok: false, reason: "INBOX_UNAVAILABLE" });
    return enqueueWebhook(request, config, undefined, storage);
  }

  const loader = routes[path];
  if (!loader) return json(404, { ok: false, reason: "NOT_FOUND" });
  if (request.method !== "GET" && request.method !== "POST") {
    return json(405, { ok: false, reason: "METHOD_NOT_ALLOWED" });
  }
  try {
    const module = await loader();
    const handler = module[request.method];
    if (typeof handler !== "function") return json(405, { ok: false, reason: "METHOD_NOT_ALLOWED" });
    return await (handler as HttpHandler)(request);
  } catch {
    // Never leak URLs, query values, patient data, or credentials in responses.
    return json(500, { ok: false, reason: "INTERNAL_ERROR" });
  }
}
