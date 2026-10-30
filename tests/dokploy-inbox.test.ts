import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decryptPayload, encryptPayload, enqueueWebhook, resolveInboxConfig,
  restoreWebhookRequest, type InboxConfig, type QueuedRequest
} from "../server/inbox.js";
import { runInboxJob } from "../server/worker.js";

const key = randomBytes(32);
const config: InboxConfig = {
  baseUrl: "https://example.supabase.co",
  serviceKey: "fake-test-only",
  webhookSecret: "fake-signature-secret",
  encryptionKey: key
};
const rawBody = JSON.stringify({ message: { id: "wamid.synthetic", type: "text", text: { body: "hemograma" } } });
const signed = (body = rawBody) => createHmac("sha256", config.webhookSecret).update(body).digest("hex");
const req = (signature: string | undefined = signed(), body = rawBody) => new Request("http://localhost/api/kapso/webhook", {
  method: "POST",
  headers: { ...(signature ? { "x-webhook-signature": signature } : {}), "x-webhook-event": "messages", "content-type": "application/json" },
  body
});
const stored = (body = rawBody): QueuedRequest => ({ rawBody: body, signature: signed(body), event: "messages", batch: null, idempotency: null });

describe("Dokploy encrypted inbox: no real network", () => {
  it("stays disabled without all explicit flags, dedicated key, and audited sending", () => {
    const env = { PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK: "on", PLUSMEDIK_DOKPLOY_WORKER: "on",
      REQUIRE_AUDIT_GUARD: "on", SUPABASE_URL: config.baseUrl,
      SUPABASE_SERVICE_ROLE_KEY: config.serviceKey, WEBHOOK_SECRET: config.webhookSecret,
      KAPSO_API_KEY: "synthetic-kapso", KAPSO_PHONE_NUMBER_ID: "synthetic-phone-id",
      OPENAI_API_KEY: "synthetic-openai", OPENROUTER_API_KEY: "synthetic-openrouter",
      PLUSMEDIK_DOKPLOY_INBOX_KEY: key.toString("base64") };
    expect(resolveInboxConfig(env)?.encryptionKey).toEqual(key);
    expect(resolveInboxConfig({ ...env, REQUIRE_AUDIT_GUARD: "off" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, KAPSO_API_KEY: "" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, OPENAI_API_KEY: "" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, OPENROUTER_API_KEY: "" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, PLUSMEDIK_DOKPLOY_WORKER: "off" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, PLUSMEDIK_DOKPLOY_INBOX_KEY: "invalid" })).toBeUndefined();
  });

  it("blocks accidental all-contact activation and incomplete pilot configuration", () => {
    const base = {
      PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK: "on",
      PLUSMEDIK_DOKPLOY_WORKER: "on", REQUIRE_AUDIT_GUARD: "on",
      SUPABASE_URL: config.baseUrl, SUPABASE_SERVICE_ROLE_KEY: config.serviceKey,
      WEBHOOK_SECRET: config.webhookSecret,
      KAPSO_API_KEY: "synthetic-kapso", KAPSO_PHONE_NUMBER_ID: "synthetic-phone-id",
      OPENAI_API_KEY: "synthetic-openai", OPENROUTER_API_KEY: "synthetic-openrouter",
      PLUSMEDIK_DOKPLOY_INBOX_KEY: key.toString("base64"),
      PLUSMEDIK_TURNS: "on", PLUSMEDIK_TEXT_HANDLER: "on",
      PLUSMEDIK_REPLY_GUARD: "on", PLUSMEDIK_TEXT_PILOT_GUARD: "on",
      PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000001",
      ALLOWED_PHONES: "59170000001,59170000002",
      PLUSMEDIK_CONTACT_HMAC_KEY: "synthetic-contact-hmac-key-32-chars-minimum"
    };
    expect(resolveInboxConfig(base)).toBeDefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_TEXT_PILOT_GUARD: "off" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_AGENT_CONTROL_PHONES: "59170000001,59170000002" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, ALLOWED_PHONES: "59170000002" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_REPLY_GUARD: "off" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_CONTACT_HMAC_KEY: "" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_TURNS: "off" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_LLM_CONVERSATION: "on" })).toBeUndefined();
    expect(resolveInboxConfig({ ...base, PLUSMEDIK_LLM_CONVERSATION: "on", OPENAI_CONVERSATION_MODEL: "synthetic-model" })).toBeDefined();
  });

  it("denies unverified or malformed requests before contacting Supabase", async () => {
    const network = vi.fn(async () => new Response(JSON.stringify(randomUUID()), { status: 200 }));
    expect((await enqueueWebhook(req("invalid"), config, network)).status).toBe(401);
    expect((await enqueueWebhook(req(undefined, "not-json"), config, network)).status).toBe(401);
    expect((await enqueueWebhook(req(signed("{}"), "{}"), undefined, network)).status).toBe(503);
    expect(network).not.toHaveBeenCalled();
  });

  it("ACKs only after persistent RPC receipt and never sends patient plaintext to storage", async () => {
    let record: Record<string, string> = {};
    const network = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      record = JSON.parse(String(init?.body)) as Record<string, string>;
      return new Response(JSON.stringify(randomUUID()), { status: 200 });
    });
    const response = await enqueueWebhook(req(), config, network);
    expect(response.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(record)).not.toContain("hemograma");
    expect(record.p_sha).toMatch(/^[0-9a-f]{64}$/);
    const restored = decryptPayload({ iv: record.p_iv!, tag: record.p_tag!, ciphertext: record.p_ciphertext! }, key);
    expect(restored).toEqual(stored());
    const replay = restoreWebhookRequest(restored, config);
    expect(await replay.text()).toBe(rawBody);
    expect(replay.headers.get("x-webhook-signature")).toBe(signed());
  });

  it("returns retryable 503 when database insert fails, not a misleading ACK", async () => {
    const bad = vi.fn(async () => new Response("database error", { status: 500 }));
    expect((await enqueueWebhook(req(), config, bad)).status).toBe(503);
    expect((await enqueueWebhook(req(), undefined, bad)).status).toBe(503);
  });

  it("rejects corrupt AES-GCM payload and rejects replay with invalid signature", () => {
    const envelope = encryptPayload(stored(), key);
    expect(decryptPayload(envelope, key)).toEqual(stored());
    expect(() => decryptPayload({ ...envelope, tag: randomBytes(16).toString("base64") }, key)).toThrow();
    expect(() => restoreWebhookRequest({ ...stored(), signature: "bad" }, config)).toThrow("INVALID_SIGNATURE");
  });

  it("worker awaits every scheduled task before marking job completed", async () => {
    const envelope = encryptPayload(stored(), key);
    const job = { id: randomUUID(), generation: 1, encrypted: envelope };
    let settle!: () => void;
    let completed = false;
    const scheduled = new Promise<void>(resolve => { settle = () => { completed = true; resolve(); }; });
    const finish = vi.fn(async () => { expect(completed).toBe(true); return true; });
    const repo = { claim: vi.fn(async () => job), renew: vi.fn(async () => true), finish };
    const work = runInboxJob(repo, config, randomUUID(), async (request, schedule) => {
      expect(await request.text()).toBe(rawBody);
      schedule(scheduled);
      return new Response("ok", { status: 200 });
    }, () => undefined);
    await Promise.resolve(); await Promise.resolve();
    settle();
    expect(await work).toBe(true);
    expect(finish).toHaveBeenCalledWith(job, expect.any(String), true);
  });

  it("worker reschedules failed work; does not lie about delivery", async () => {
    const job = { id: randomUUID(), generation: 3, encrypted: encryptPayload(stored(), key) };
    const finish = vi.fn(async () => true);
    const repo = { claim: vi.fn(async () => job), renew: vi.fn(async () => true), finish };
    const worked = await runInboxJob(repo, config, randomUUID(), async (_request, schedule) => {
      schedule(Promise.reject(new Error("synthetic failure")));
      return new Response("ok", { status: 200 });
    }, () => undefined);
    expect(worked).toBe(true);
    expect(finish).toHaveBeenCalledWith(job, expect.any(String), false);
  });
});
