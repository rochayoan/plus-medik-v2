import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { verifyWebhookSignature } from "../src/whatsapp-quote.js";

export interface InboxConfig {
  baseUrl: string;
  serviceKey: string;
  encryptionKey: Buffer;
  webhookSecret: string;
}

export interface EncryptedEnvelope {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface InboxJob {
  id: string;
  generation: number;
  encrypted: EncryptedEnvelope;
}

export interface QueuedRequest {
  rawBody: string;
  signature: string;
  event: string | null;
  batch: string | null;
  idempotency: string | null;
}

const json = (status: number, reason: string) =>
  new Response(JSON.stringify({ ok: status === 200, reason }), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

export function inboxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveInboxConfig(env) !== undefined;
}

export function resolveInboxConfig(env: NodeJS.ProcessEnv = process.env): InboxConfig | undefined {
  if (env.PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK?.trim().toLowerCase() !== "on"
      || env.PLUSMEDIK_DOKPLOY_WORKER?.trim().toLowerCase() !== "on"
      || env.REQUIRE_AUDIT_GUARD?.trim().toLowerCase() !== "on") return undefined;
  const baseUrl = env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const webhookSecret = env.WEBHOOK_SECRET;
  const encoded = env.PLUSMEDIK_DOKPLOY_INBOX_KEY;
  // Never ACK an event if its worker has no transport, models or catalogue access.
  const requiredRuntime = [
    env.KAPSO_API_KEY, env.KAPSO_PHONE_NUMBER_ID,
    env.OPENAI_API_KEY, env.OPENROUTER_API_KEY
  ];
  if (requiredRuntime.some(value => !value?.trim())) return undefined;
  if (!baseUrl || !/^https:\/\//.test(baseUrl) || !serviceKey || !webhookSecret || !encoded
      || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return undefined;
  const encryptionKey = Buffer.from(encoded, "base64");
  if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== encoded) return undefined;
  return { baseUrl, serviceKey, webhookSecret, encryptionKey };
}

export function encryptPayload(value: QueuedRequest, key: Buffer): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptPayload(value: EncryptedEnvelope, key: Buffer): QueuedRequest {
  const iv = Buffer.from(value.iv, "base64");
  const tag = Buffer.from(value.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("INVALID_ENVELOPE");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]);
  const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("INVALID_ENVELOPE");
  const x = parsed as Record<string, unknown>;
  if (typeof x.rawBody !== "string" || typeof x.signature !== "string"
    || (x.event !== null && typeof x.event !== "string")
    || (x.batch !== null && typeof x.batch !== "string")
    || (x.idempotency !== null && typeof x.idempotency !== "string")) throw new Error("INVALID_ENVELOPE");
  return x as unknown as QueuedRequest;
}

type JsonFetch = typeof fetch;
export class InboxRepository {
  constructor(readonly config: InboxConfig, private readonly fetchFn: JsonFetch = fetch) {}

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchFn(`${this.config.baseUrl}/rest/v1/rpc/plusmedik_dokploy_${name}`, {
      method: "POST",
      headers: {
        apikey: this.config.serviceKey,
        Authorization: `Bearer ${this.config.serviceKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) throw new Error("INBOX_RPC_FAILED");
    return response.json();
  }

  async ready(): Promise<boolean> {
    try { return (await this.rpc("health", {})) === true; } catch { return false; }
  }

  async enqueue(value: QueuedRequest): Promise<void> {
    const encrypted = encryptPayload(value, this.config.encryptionKey);
    // Signature covers the raw body. A replay with mutated ancillary headers
    // remains one job; original verified headers are replayed to the core.
    const digest = createHmac("sha256", this.config.encryptionKey).update("inbox-id-v1\0").update(value.rawBody).digest("hex");
    const response = await this.rpc("enqueue", {
      p_sha: digest, p_iv: encrypted.iv, p_tag: encrypted.tag, p_ciphertext: encrypted.ciphertext
    });
    if (typeof response !== "string" || !/^[0-9a-f-]{36}$/i.test(response)) throw new Error("INBOX_INVALID_RECEIPT");
  }

  async claim(owner: string): Promise<InboxJob | undefined> {
    const value = await this.rpc("claim", { p_owner: owner });
    if (!Array.isArray(value)) throw new Error("INBOX_INVALID_CLAIM");
    const row = value[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (typeof row.job_id !== "string" || typeof row.job_generation !== "number"
      || typeof row.job_iv !== "string" || typeof row.job_tag !== "string"
      || typeof row.job_ciphertext !== "string") throw new Error("INBOX_INVALID_CLAIM");
    return {
      id: row.job_id,
      generation: row.job_generation,
      encrypted: { iv: row.job_iv, tag: row.job_tag, ciphertext: row.job_ciphertext }
    };
  }

  async renew(job: InboxJob, owner: string): Promise<boolean> {
    return (await this.rpc("renew", {
      p_id: job.id, p_owner: owner, p_generation: job.generation
    })) === true;
  }

  async finish(job: InboxJob, owner: string, ok: boolean): Promise<boolean> {
    return (await this.rpc("finish", {
      p_id: job.id, p_owner: owner, p_generation: job.generation, p_ok: ok
    })) === true;
  }
}

export async function enqueueWebhook(
  request: Request, config: InboxConfig | undefined, fetchFn?: JsonFetch
): Promise<Response> {
  if (!config) return json(503, "INBOX_NOT_READY");
  if (request.method !== "POST") return json(405, "METHOD_NOT_ALLOWED");
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > 1024 * 1024) return json(413, "PAYLOAD_TOO_LARGE");
  const signature = request.headers.get("x-webhook-signature");
  if (!verifyWebhookSignature(body, signature, config.webhookSecret)) return json(401, "UNAUTHORIZED");
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return json(400, "INVALID_JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return json(400, "INVALID_JSON");
  const value: QueuedRequest = {
    rawBody: body,
    signature: signature!,
    event: request.headers.get("x-webhook-event"),
    batch: request.headers.get("x-webhook-batch"),
    idempotency: request.headers.get("x-idempotency-key")
  };
  try {
    await new InboxRepository(config, fetchFn).enqueue(value);
    // Never ACK before the database confirms durable storage.
    return json(200, "QUEUED");
  } catch {
    return json(503, "INBOX_UNAVAILABLE");
  }
}

export function restoreWebhookRequest(value: QueuedRequest, config: InboxConfig): Request {
  if (!verifyWebhookSignature(value.rawBody, value.signature, config.webhookSecret)) throw new Error("INVALID_SIGNATURE");
  const headers = new Headers({ "x-webhook-signature": value.signature, "content-type": "application/json" });
  if (value.event) headers.set("x-webhook-event", value.event);
  if (value.batch) headers.set("x-webhook-batch", value.batch);
  if (value.idempotency) headers.set("x-idempotency-key", value.idempotency);
  return new Request("http://localhost/api/kapso/webhook", { method: "POST", headers, body: value.rawBody });
}
