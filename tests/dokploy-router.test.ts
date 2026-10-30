import { describe, expect, it } from "vitest";
import { routeDokployRequest } from "../server/router.js";

// Offline tests: never calls OpenAI, Supabase, Kapso, or Docker.
describe("Dokploy phase 1 safety", () => {
  it("reports live process health without claiming webhook readiness", async () => {
    const response = await routeDokployRequest(new Request("http://localhost:3000/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "plusmedik-dokploy", webhookReady: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not claim ready for Kapso cutover", async () => {
    const response = await routeDokployRequest(new Request("http://localhost:3000/readyz"));
    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe("DURABLE_WEBHOOK_QUEUE_NOT_IMPLEMENTED");
  });

  it("never acknowledges patient messages without a durable queue", async () => {
    for (const method of ["GET", "POST"] as const) {
      const request = new Request("http://localhost:3000/api/kapso/webhook", {
        method,
        ...(method === "POST" ? { body: JSON.stringify({ messages: [{ text: "texto sensible" }] }) } : {})
      });
      const response = await routeDokployRequest(request);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("texto sensible");
    }
  });

  it("rejects unknown routes and unsupported methods", async () => {
    expect((await routeDokployRequest(new Request("http://localhost:3000/not-a-route"))).status).toBe(404);
    expect((await routeDokployRequest(new Request("http://localhost:3000/api/web/catalog", { method: "PUT" }))).status).toBe(405);
  });
});
