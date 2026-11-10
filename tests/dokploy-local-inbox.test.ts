import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueWebhook, resolveInboxConfig, type InboxConfig } from "../server/inbox.js";
import { LocalInboxRepository } from "../server/local-inbox.js";
import { runInboxJob } from "../server/worker.js";

const key = randomBytes(32);
const baseConfig: InboxConfig = {
  baseUrl: "https://example.supabase.co",
  serviceKey: "synthetic-key",
  webhookSecret: "synthetic-secret",
  encryptionKey: key
};
const raw = JSON.stringify({ message: { id: "wamid.synthetic-local", type: "image", image: { id: "synthetic-media-id" } } });
const signature = createHmac("sha256", baseConfig.webhookSecret).update(raw).digest("hex");
const signed = () => new Request("http://localhost/api/kapso/webhook", {
  method: "POST", headers: { "x-webhook-signature": signature, "content-type": "application/json" }, body: raw
});
const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "plusmedik-local-"));
  dirs.push(dir);
  return { dir, store: new LocalInboxRepository(dir, key) };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Dokploy local encrypted inbox (no Supabase SQL)", () => {
  it("requires explicit durable-volume acknowledgement and all real runtime credentials", () => {
    const env = {
      PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK: "on", PLUSMEDIK_DOKPLOY_WORKER: "on",
      REQUIRE_AUDIT_GUARD: "on",
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fake",
      KAPSO_API_KEY: "fake", KAPSO_PHONE_NUMBER_ID: "fake",
      OPENAI_API_KEY: "fake", OPENROUTER_API_KEY: "fake",
      WEBHOOK_SECRET: "fake",
      PLUSMEDIK_DOKPLOY_INBOX_KEY: key.toString("base64"),
      PLUSMEDIK_DOKPLOY_INBOX_STORAGE: "local",
      PLUSMEDIK_DOKPLOY_SPOOL_DIR: "/data/plusmedik-inbox",
      PLUSMEDIK_DOKPLOY_VOLUME_CONFIRMED: "on"
    };
    expect(resolveInboxConfig(env)?.storage).toBe("local");
    expect(resolveInboxConfig({ ...env, PLUSMEDIK_DOKPLOY_VOLUME_CONFIRMED: "off" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, PLUSMEDIK_DOKPLOY_SPOOL_DIR: "/app/tmp" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, PLUSMEDIK_DOKPLOY_SPOOL_DIR: "/data/../unsafe" })).toBeUndefined();
    expect(resolveInboxConfig({ ...env, REQUIRE_AUDIT_GUARD: "off" })).toBeUndefined();
  });

  it("persists encrypted payload before ACK, survives repository restart and deduplicates", async () => {
    const { dir, store } = fresh();
    expect(await store.ready()).toBe(true);
    expect((await enqueueWebhook(signed(), baseConfig, undefined, store)).status).toBe(200);
    const files = readdirSync(dir).filter(name => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), "utf8")).not.toContain("synthetic-media-id");
    const restored = new LocalInboxRepository(dir, key);
    expect((await enqueueWebhook(signed(), baseConfig, undefined, restored)).status).toBe(200);
    expect(readdirSync(dir).filter(name => name.endsWith(".json"))).toHaveLength(1);
    const claimed = await restored.claim(randomUUID());
    expect(claimed?.encrypted.ciphertext).toBeTruthy();
  });

  it("worker completes after scheduled tasks and persistent state survives restart without replay", async () => {
    const { dir, store } = fresh();
    expect((await enqueueWebhook(signed(), baseConfig, undefined, store)).status).toBe(200);
    let complete = false;
    const owner = randomUUID();
    const handled = await runInboxJob(store, baseConfig, owner, async (request, schedule) => {
      expect(await request.text()).toBe(raw);
      schedule(Promise.resolve().then(() => { complete = true; }));
      return new Response("ok", { status: 200 });
    }, () => undefined);
    expect(handled).toBe(true);
    expect(complete).toBe(true);
    const record = readFileSync(join(dir, readdirSync(dir).find(name => name.endsWith(".json"))!), "utf8");
    expect(record).toContain('"status":"completed"');
    expect(record).not.toContain('"encrypted"');
    expect(await new LocalInboxRepository(dir, key).claim(randomUUID())).toBeUndefined();
    expect((await enqueueWebhook(signed(), baseConfig, undefined, store)).status).toBe(200);
    expect(await store.claim(randomUUID())).toBeUndefined();
  });

  it("protects lease owner and generation; retries failed work", async () => {
    const { store } = fresh();
    expect((await enqueueWebhook(signed(), baseConfig, undefined, store)).status).toBe(200);
    const owner = randomUUID();
    const job = (await store.claim(owner))!;
    expect(job.generation).toBe(1);
    expect(await store.claim(randomUUID())).toBeUndefined();
    expect(await store.renew(job, randomUUID())).toBe(false);
    expect(await store.finish(job, randomUUID(), true)).toBe(false);
    expect(await store.finish({ ...job, generation: 2 }, owner, true)).toBe(false);
    expect(await store.finish(job, owner, false)).toBe(true);
    expect(await store.claim(randomUUID())).toBeUndefined(); // retry backoff
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    const next = (await store.claim(randomUUID()))!;
    expect(next.generation).toBe(2);
    expect(await store.finish(job, owner, true)).toBe(false);
    expect(await store.finish(next, next.id, true)).toBe(false);
    clock.mockRestore();
  });

  it("fails closed when the local disk cannot write; never ACKs unverified signature", async () => {
    const broken = new LocalInboxRepository("/app/ephemeral", key);
    expect(await broken.ready()).toBe(false);
    expect((await enqueueWebhook(signed(), baseConfig, undefined, broken)).status).toBe(503);
    const { store } = fresh();
    const response = await enqueueWebhook(new Request("http://localhost/api/kapso/webhook", {
      method: "POST", headers: { "x-webhook-signature": "invalid" }, body: raw
    }), baseConfig, undefined, store);
    expect(response.status).toBe(401);
  });
});
