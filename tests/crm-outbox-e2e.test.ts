import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createCrmReviewClient } from "../src/crm-outbox/client.js";
import { createCrmHandoffSink } from "../src/crm-outbox/handoff-sink.js";
import { createSupabaseOutboxRepository } from "../src/crm-outbox/repository.js";
import { CrmOutbox } from "../src/crm-outbox/service.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { BLOCKED_HANDOFF, createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { FakeCrm } from "./support/fake-crm.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Derivación al CRM de extremo a extremo: webhook REAL + manejador REAL + cola REAL (repositorio, servicio y cliente HTTP) + PostgreSQL real con las TRECE migraciones. Solo el CRM está simulado,
// con un receptor que reproduce el contrato real (tests/support/fake-crm.ts): apagado, token, mensaje aún no ingerido (409), duplicados por eventId y por mensaje. Kapso y los datos son de PRUEBA.

const bin = findPostgresBin();
if (!bin) console.warn("[crm-outbox-e2e] PostgreSQL no disponible: se omiten los escenarios de la cola de salida contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const OUTBOX_KEY = "clave-de-cifrado-del-outbox-0123456789-abcdef";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_5599";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const CATALOG = [study(1, "HEMOGRAMA DE PRUEBA", ["hemograma"], 45), study(2, "GLUCOSA DE PRUEBA", ["glucosa"], 30), study(7, "CREATININA SERICA", ["creatinina"], 20), study(8, "CREATININA EN ORINA", ["creatinina"], 22)];

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", from: phone, image: { id: tag }, kapso: { ...inbound, has_media: true } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const analysisOf = (kind: "COMPLETE" | "PARTIAL" | "NONE", ids: number[]) => {
  const lines = ids.map((n) => ({ id: uuid(n), code: null, name: CATALOG.find((s) => s.id === uuid(n))!.name, priceBs: 1, basis: ["EXACT"], texts: [] }));
  const outcome = kind === "COMPLETE" ? "AUTO_COMPLETE" : kind === "PARTIAL" ? "AUTO_PARTIAL" : "HUMAN_REVIEW";
  return { decision: kind === "COMPLETE" ? "AUTO_SAFE" : "HUMAN_REVIEW", outcome, reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [],
    publicQuote: kind === "NONE" ? undefined : { studies: [], totalBs: 0, totalLabel: "x", tariff: "PACIENTE" },
    internal: { outcome, recipeComplete: kind === "COMPLETE", reviewRequired: kind !== "COMPLETE", quoted: { lines, subtotalBs: 0 }, studies: [], pending: [], recipeStops: [], document: { type: "TEXT_EXPLICIT_REQUEST", zones: [] }, advisories: [], history: [] } } as unknown as AnalysisResult;
};

describe.skipIf(!bin)("derivación segura al CRM de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("crm_outbox_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  interface Options { crm?: FakeCrm; handoff?: boolean; sessions?: boolean; maxAttempts?: number; immediateAttempts?: number; verdicts?: Record<string, AnalysisResult>; token?: string }
  function setup(options: Options = {}) {
    const crm = options.crm ?? new FakeCrm();
    const sends: Array<{ to: string; body: string; casesAtSend: number }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const verdicts = options.verdicts ?? {};
    const world = { catalog: [...CATALOG] };
    const outbox = new CrmOutbox({
      repository: createSupabaseOutboxRepository(rpcOptions()), client: createCrmReviewClient({ baseUrl: "https://crm.example.test", token: options.token ?? crm.token, fetchFn: crm.fetchFn, timeoutMs: 400 }),
      encryptionKey: OUTBOX_KEY, phoneNumberId: LAB, log, immediateAttempts: options.immediateAttempts ?? 2, immediateDelayMs: 30, maxAttempts: options.maxAttempts ?? 8
    });
    const enabled = options.handoff !== false;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })), loadCatalog: vi.fn(async () => structuredClone(world.catalog)),
      analyze: vi.fn(async ({ imageBase64 }) => verdicts[/TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "?"] ?? analysisOf("COMPLETE", [1])),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body, casesAtSend: crm.cases.length }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        ...(enabled ? { crmHandoff: outbox } : {}),
        handlers: { text: createTextHandler({ log, handoff: enabled ? createCrmHandoffSink() : BLOCKED_HANDOFF }) },
        ...(options.sessions ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400 }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { crm, outbox, sends, logs, scheduled, world, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, p: { phone: string }, body: string, message = id("txt")) => {
    await send(w, textEvent(message, p.phone, body));
    return message;
  };
  const last = (w: World) => w.sends.at(-1)!.body;
  const events = async (key: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(o order by o.created_at, o.id), '[]') from (select id, created_at, event_id, kind, status, delivery, attempts, max_attempts, reason_codes, last_result, last_http_status, dead_reason, kapso_message_id, (payload_cipher is not null) as has_payload, evidence, next_attempt_at, expires_at from public.plusmedik_crm_outbox where contact_key = '${key}') o`));
  const attemptsOf = async (outboxId: string): Promise<string[]> => (await db.ok(`select coalesce(string_agg(result, ',' order by at, id), '') from public.plusmedik_crm_outbox_attempts where outbox_id = '${outboxId}'`)).split(",").filter(Boolean);
  const outboxIdOf = (eventId: string) => db.ok(`select id from public.plusmedik_crm_outbox where event_id = '${eventId}'`);
  // Hace vencer la espera del reintento (o el arrendamiento) de lo pendiente de un contacto, como si hubiera pasado el tiempo.
  const makeDue = (key: string) => db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set next_attempt_at = now() - interval '1 second', lease_expires_at = case when status = 'IN_FLIGHT' then now() - interval '1 second' else lease_expires_at end where contact_key = '${key}' and status in ('PENDING', 'IN_FLIGHT');`);
  const runs = (key: string) => db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${key}'`);
  const ingest = (w: World, p: { phone: string }, message: string, mediaId: string | null = null) => w.crm.ingest(message, p.phone, LAB, mediaId);

  it("APAGADO (sin cola): una persona pedida recibe el aviso de siempre, la derivación sigue BLOQUEADA y no se escribe nada en la cola ni se llama al CRM", async () => {
    const p = patient();
    const w = setup({ handoff: false });
    await say(w, p, "quiero hablar con una persona");
    expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
    expect(await events(p.key)).toEqual([]);
    expect(w.crm.calls).toEqual([]);
  });

  it("el CRM registra el caso → recién entonces se le confirma al paciente (el caso ya existía en el CRM cuando se envió el mensaje); el cuerpo se borra y queda la evidencia", async () => {
    const p = patient();
    const w = setup();
    const message = id("txt");
    ingest(w, p, message);
    await say(w, p, "quiero hablar con una persona", message);
    expect(w.sends).toHaveLength(1);
    expect(last(w)).toBe(DRAFT_TEXTS.handoff_confirmed);
    expect(w.sends[0]!.casesAtSend).toBe(1);
    expect(w.crm.cases).toHaveLength(1);
    expect(w.crm.cases[0]).toMatchObject({ kapsoMessageId: message, contactPhone: p.phone, phoneNumberId: LAB, recipeMediaId: null, detectedTests: [] });
    expect(w.crm.cases[0]!.failureReason).toBe("HUMAN_REQUEST: el paciente pidió hablar con una persona");
    expect(w.crm.cases[0]!.eventId).toBe(`plusmedik-review:${w.crm.cases[0]!.auditId}`);
    expect(w.crm.calls[0]!.authorization).toBe(`Bearer ${w.crm.token}`);
    expect(w.crm.calls[0]!.redirect).toBe("manual");
    const [event] = await events(p.key);
    expect(event).toMatchObject({ status: "SENT", delivery: "CREATED", has_payload: false, attempts: 1, reason_codes: ["HUMAN_REQUEST"], kind: "CONVERSATION", last_result: "CREATED", last_http_status: 200 });
    expect(await attemptsOf(await outboxIdOf(event!.event_id))).toEqual(["CREATED"]);
  });

  it("una consulta médica se registra (MEDICAL_QUERY) y la confirmación CONSERVA el aviso de urgencia", async () => {
    const p = patient();
    const w = setup();
    const message = id("txt");
    ingest(w, p, message);
    await say(w, p, "tengo mucho dolor de pecho", message);
    expect(last(w)).toBe(DRAFT_TEXTS.medical_handoff_confirmed);
    expect(last(w)).toContain("servicios de emergencia");
    expect(w.crm.cases[0]!.failureReason).toContain("MEDICAL_QUERY");
  });

  it("una pregunta sin respuesta aprobada se registra (NO_APPROVED_ANSWER) y se confirma solo con el caso registrado", async () => {
    const p = patient();
    const w = setup();
    const message = id("txt");
    ingest(w, p, message);
    await say(w, p, "¿a qué hora abren?", message);
    expect(last(w)).toBe(DRAFT_TEXTS.handoff_confirmed);
    expect(w.crm.cases[0]!.failureReason).toContain("NO_APPROVED_ANSWER");
  });

  describe("el CRM no registra el caso: NUNCA se confirma", () => {
    it("CRM apagado (503): el paciente recibe el aviso de «no disponible», el caso queda PENDING en la cola y, cuando el CRM vuelve, se entrega SIN escribirle otra vez al paciente", async () => {
      const p = patient();
      const w = setup();
      w.crm.enabled = false;
      const message = id("txt");
      ingest(w, p, message);
      await say(w, p, "quiero hablar con una persona", message);
      expect(w.sends).toHaveLength(1);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      expect(w.crm.cases).toEqual([]);
      const [pending] = await events(p.key);
      expect(pending).toMatchObject({ status: "PENDING", has_payload: true, attempts: 2, last_result: "UNAVAILABLE", last_http_status: 503 });
      w.crm.enabled = true;
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ claimed: 1, sent: 1 });
      expect(w.crm.cases).toHaveLength(1);
      expect((await events(p.key))[0]).toMatchObject({ status: "SENT", delivery: "CREATED", has_payload: false });
      expect(w.sends).toHaveLength(1);
    });

    it("409 message_not_ingested: aviso de «no disponible» ahora; cuando el CRM ingiere el mensaje original, el reintento lo registra (mismo eventId, mismo cuerpo)", async () => {
      const p = patient();
      const w = setup();
      const message = id("txt");
      await say(w, p, "quiero hablar con una persona", message);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      expect(w.crm.calls.map((c) => c.status)).toEqual([409, 409]);
      expect((await events(p.key))[0]).toMatchObject({ status: "PENDING", last_result: "MESSAGE_NOT_INGESTED", last_http_status: 409, attempts: 2 });
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ claimed: 1, sent: 0, retry: 1 });
      ingest(w, p, message);
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ claimed: 1, sent: 1 });
      expect(w.crm.cases).toHaveLength(1);
      expect(new Set(w.crm.calls.map((c) => c.bodyText)).size).toBe(1);
      expect(new Set(w.crm.calls.map((c) => c.eventId)).size).toBe(1);
      expect(w.sends).toHaveLength(1);
    });

    it("si el CRM responde «aún no ingerido» al primer intento pero ya lo tiene en el segundo (ingesta en curso), el caso se registra y SÍ se confirma", async () => {
      const p = patient();
      const w = setup();
      const message = id("txt");
      ingest(w, p, message);
      w.crm.script.push({ status: 409, body: { ok: false, code: "message_not_ingested" } });
      await say(w, p, "quiero hablar con una persona", message);
      expect(w.crm.calls.map((c) => c.status)).toEqual([409, 200]);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_confirmed);
      expect(w.crm.cases).toHaveLength(1);
      expect(await attemptsOf(await outboxIdOf((await events(p.key))[0]!.event_id))).toEqual(["MESSAGE_NOT_INGESTED", "CREATED"]);
    });

    it("un token equivocado (401) no confirma nada, no se reintenta enseguida (espera ≥ 30 min) y ni el token ni el cuerpo aparecen en los registros", async () => {
      const p = patient();
      const w = setup({ token: "otro-token-".padEnd(40, "z") });
      const message = id("txt");
      ingest(w, p, message);
      await say(w, p, `quiero hablar con una persona ${SENTINEL}`, message);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      const [event] = await events(p.key);
      expect(event).toMatchObject({ status: "PENDING", last_result: "UNAUTHORIZED", last_http_status: 401 });
      expect(new Date(event!.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
      expect(JSON.stringify(w.logs)).not.toMatch(new RegExp(`${w.crm.token}|zzzz|${p.phone}|${SENTINEL}`));
    });

    it("tiempo de espera agotado o caída de red: el caso queda pendiente y se reintenta; nada se confirma", async () => {
      const p = patient();
      const w = setup();
      const message = id("txt");
      ingest(w, p, message);
      w.crm.script.push("network", "timeout");
      await say(w, p, "quiero hablar con una persona", message);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      expect((await events(p.key))[0]).toMatchObject({ status: "PENDING", attempts: 2 });
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ sent: 1 });
      expect(w.crm.cases).toHaveLength(1);
    });
  });

  describe("idempotencia y recuperación", () => {
    it("el mismo mensaje entregado varias veces → UN evento, UN caso en el CRM y UNA confirmación", async () => {
      const p = patient();
      const w = setup();
      const message = id("dup");
      ingest(w, p, message);
      for (let i = 0; i < 4; i++) await send(w, textEvent(message, p.phone, "quiero hablar con una persona"));
      expect(w.sends).toHaveLength(1);
      expect(w.crm.cases).toHaveLength(1);
      expect(await events(p.key)).toHaveLength(1);
      expect(await runs(p.key)).toBe("1");
    });

    it("el CRM registró el caso pero no se pudo anotar el resultado (se cayó la base justo ahí): NO se confirma; al reintentar el CRM responde «duplicado» y queda SENT; sigue habiendo UN solo caso", async () => {
      const p = patient();
      const w = setup({ immediateAttempts: 1 });
      const message = id("txt");
      ingest(w, p, message);
      network.downFor.add("plusmedik_crm_outbox_record");
      try {
        await say(w, p, "quiero hablar con una persona", message);
      } finally {
        network.downFor.delete("plusmedik_crm_outbox_record");
      }
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      expect(w.crm.cases).toHaveLength(1);
      expect((await events(p.key))[0]).toMatchObject({ status: "IN_FLIGHT", has_payload: true });
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ claimed: 1, sent: 1 });
      const [event] = await events(p.key);
      expect(event).toMatchObject({ status: "SENT", delivery: "DUPLICATE", has_payload: false });
      expect(w.crm.cases).toHaveLength(1);
      expect(w.sends).toHaveLength(1);
    });

    it("un 409 distinto del esperado se reintenta de forma acotada y termina DEAD (a la vista); tras corregir la causa, el reencolado lo entrega", async () => {
      const p = patient();
      const w = setup({ maxAttempts: 3 });
      const message = id("txt");
      ingest(w, p, message);
      for (let i = 0; i < 3; i++) w.crm.script.push({ status: 409, body: { ok: false, code: "otra_cosa" } });
      await say(w, p, "quiero hablar con una persona", message);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      // un 409 desconocido no se reintenta en línea (no mejora en segundos): el primer intento fue el del turno y los otros dos los hace el reintentador
      expect(w.crm.calls).toHaveLength(1);
      for (let i = 0; i < 2; i++) {
        await makeDue(p.key);
        await w.outbox.drain();
      }
      const [dead] = await events(p.key);
      expect(dead).toMatchObject({ status: "DEAD", dead_reason: "EXHAUSTED", attempts: 3, has_payload: true, last_result: "CONFLICT_UNKNOWN" });
      const stats = await createSupabaseOutboxRepository(rpcOptions()).stats();
      expect(stats.counts.DEAD).toBeGreaterThanOrEqual(1);
      const repo = createSupabaseOutboxRepository(rpcOptions());
      expect(await repo.requeue(await outboxIdOf(dead!.event_id), "operator:laura")).toBe("requeued");
      expect(await w.outbox.drain()).toMatchObject({ sent: 1 });
      expect((await events(p.key))[0]).toMatchObject({ status: "SENT", delivery: "CREATED" });
      expect(w.crm.cases).toHaveLength(1);
    });

    it("un rechazo permanente del CRM (400) pasa a DEAD sin reintentos y sin confirmar; lo vencido se descarta sin enviar y su cuerpo se borra", async () => {
      const p = patient();
      const w = setup();
      const message = id("txt");
      ingest(w, p, message);
      w.crm.script.push({ status: 400, body: { ok: false, error: "Invalid review event" } });
      await say(w, p, "quiero hablar con una persona", message);
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      expect((await events(p.key))[0]).toMatchObject({ status: "DEAD", dead_reason: "REJECTED_INVALID", attempts: 1, last_http_status: 400 });
      expect(w.crm.calls).toHaveLength(1);

      const q = patient();
      const message2 = id("txt");
      w.crm.enabled = false;
      await say(w, q, "quiero hablar con una persona", message2);
      await db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set expires_at = now() - interval '1 second' where contact_key = '${q.key}';`);
      w.crm.enabled = true;
      ingest(w, q, message2);
      const callsBefore = w.crm.calls.length;
      await makeDue(q.key);
      expect(await w.outbox.drain()).toMatchObject({ claimed: 0 });
      expect((await events(q.key))[0]).toMatchObject({ status: "DEAD", dead_reason: "EXPIRED", has_payload: false });
      expect(w.crm.calls.length).toBe(callsBefore);
    });
  });

  describe("pausa humana y concurrencia", () => {
    it("un contacto pausado no se procesa (no hay caso nuevo ni mensaje); un caso ya encolado igual se entrega al CRM sin escribirle al paciente", async () => {
      const p = patient();
      const w = setup();
      w.crm.enabled = false;
      const message = id("txt");
      await say(w, p, "quiero hablar con una persona", message);
      const sentBefore = w.sends.length;
      await send(w, humanEvent(id("human"), p.phone), SENT);
      await say(w, p, "¿hay alguien?");
      expect(w.sends).toHaveLength(sentBefore);
      expect(await events(p.key)).toHaveLength(1);
      expect(await db.ok(`select state from public.plusmedik_attention_contacts where contact_key = '${p.key}'`)).toBe("HUMAN_PAUSED");
      w.crm.enabled = true;
      ingest(w, p, message);
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ sent: 1 });
      expect(w.crm.cases).toHaveLength(1);
      expect(w.sends).toHaveLength(sentBefore);
    });

    it("varios reintentadores a la vez (y el turno) NUNCA crean dos casos: cada evento se entrega una sola vez al CRM", async () => {
      const w = setup();
      w.crm.enabled = false;
      const people = Array.from({ length: 5 }, () => patient());
      const messages: string[] = [];
      for (const p of people) {
        const message = id("txt");
        messages.push(message);
        await say(w, p, "quiero hablar con una persona", message);
      }
      w.crm.enabled = true;
      people.forEach((p, index) => ingest(w, p, messages[index]!));
      for (const p of people) await makeDue(p.key);
      const summaries = await Promise.all([w.outbox.drain({ limit: 10 }), w.outbox.drain({ limit: 10 }), w.outbox.drain({ limit: 10 })]);
      expect(summaries.reduce((sum, s) => sum + s.claimed, 0)).toBe(5);
      expect(summaries.reduce((sum, s) => sum + s.sent, 0)).toBe(5);
      expect(w.crm.cases).toHaveLength(5);
      expect(new Set(w.crm.cases.map((c) => c.eventId)).size).toBe(5);
      for (const p of people) expect((await events(p.key))[0]).toMatchObject({ status: "SENT" });
    });

    it("mensajes simultáneos del mismo contacto: un caso por mensaje, todos distintos, ninguno repetido", async () => {
      const p = patient();
      const w = setup();
      const messages = Array.from({ length: 4 }, () => id("par"));
      messages.forEach((message) => ingest(w, p, message));
      await Promise.all(messages.map((message) => w.hook(signedPost(textEvent(message, p.phone, "quiero hablar con una persona"), RECEIVED))));
      await w.settle();
      expect(w.crm.cases).toHaveLength(4);
      expect(new Set(w.crm.cases.map((c) => c.kapsoMessageId))).toEqual(new Set(messages));
      expect((await events(p.key)).every((e) => e.status === "SENT")).toBe(true);
    });
  });

  describe("solicitudes de cotización en revisión (G4.0)", () => {
    const ambiguousThenListo = async (w: World, p: { phone: string }) => {
      const first = id("txt");
      const photo = id("img");
      await say(w, p, "hemograma y creatinina", first);
      await send(w, imageEvent(photo, p.phone, "PARTIAL"));
      const closing = await say(w, p, "listo");
      return { first, photo, closing };
    };
    const verdicts = () => ({ PARTIAL: analysisOf("PARTIAL", [1]) });

    it("cada mensaje dudoso se deriva como SU caso (mensaje y adjunto originales, candidatos del catálogo) y, con todos registrados, el aviso SÍ dice que una persona lo revisará; los precios no se dan", async () => {
      const p = patient();
      const w = setup({ sessions: true, verdicts: verdicts() });
      const { first, photo } = await (async () => {
        const first = id("txt");
        const photo = id("img");
        ingest(w, p, first);
        ingest(w, p, photo, "PARTIAL");
        return { first, photo };
      })();
      await say(w, p, "hemograma y creatinina", first);
      await send(w, imageEvent(photo, p.phone, "PARTIAL"));
      await say(w, p, "listo");
      expect(last(w)).toBe(QUOTE_TEXTS.review_confirmed);
      expect(last(w)).not.toMatch(/Bs\s?\d/);
      expect(w.crm.cases.map((c) => c.kapsoMessageId).sort()).toEqual([first, photo].sort());
      const text = w.crm.cases.find((c) => c.kapsoMessageId === first)!;
      const image = w.crm.cases.find((c) => c.kapsoMessageId === photo)!;
      expect(text.failureReason).toContain("AMBIGUOUS_STUDY");
      expect(text.recipeMediaId).toBeNull();
      expect(text.detectedTests).toEqual([
        { catalogTestId: uuid(1), name: "HEMOGRAMA DE PRUEBA" }, { catalogTestId: uuid(7), name: "CREATININA SERICA", ambiguousGroup: 1 }, { catalogTestId: uuid(8), name: "CREATININA EN ORINA", ambiguousGroup: 1 }
      ]);
      expect(image.recipeMediaId).toBe("PARTIAL");
      expect(image.failureReason).toContain("ENGINE_PARTIAL");
      expect(image.agentResult).toMatchObject({ itemStatus: "UNCERTAIN", source: "plusmedik-v2" });
      expect(await db.ok(`select count(*) from public.plusmedik_quote_reviews r join public.plusmedik_quote_sessions s on s.id = r.session_id where s.contact_key = '${p.key}'`)).toBe("1");
    });

    it("si el CRM aún no tiene alguno de los mensajes, el aviso NO promete una persona (queda el texto de siempre) y el resto de los casos se entrega cuando el CRM los ingiere", async () => {
      const p = patient();
      const w = setup({ sessions: true, verdicts: verdicts() });
      const { first, photo } = await ambiguousThenListo(w, p);
      expect(last(w)).toBe(QUOTE_TEXTS.review);
      expect(w.crm.cases).toEqual([]);
      const events1 = await events(p.key);
      expect(events1).toHaveLength(2);
      expect(events1.every((e) => e.status === "PENDING")).toBe(true);
      ingest(w, p, first);
      ingest(w, p, photo, "PARTIAL");
      await makeDue(p.key);
      expect(await w.outbox.drain()).toMatchObject({ sent: 2 });
      expect(w.crm.cases).toHaveLength(2);
      expect(w.sends.filter((s) => s.body === QUOTE_TEXTS.review_confirmed)).toEqual([]);
    });

    it("un estudio retirado del catálogo (motivo de TODA la solicitud) se ancla al mensaje que cerró la solicitud", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      const first = id("txt");
      const closing = id("txt");
      ingest(w, p, first);
      ingest(w, p, closing);
      await say(w, p, "hemograma", first);
      w.world.catalog = w.world.catalog.filter((candidate) => candidate.id !== uuid(1));
      await say(w, p, "listo", closing);
      expect(last(w)).toBe(QUOTE_TEXTS.review_confirmed);
      expect(w.crm.cases).toHaveLength(1);
      expect(w.crm.cases[0]).toMatchObject({ kapsoMessageId: closing });
      expect(w.crm.cases[0]!.failureReason).toContain("STUDY_UNAVAILABLE");
    });

    it("repetir el cierre (ejecución que reclama el turno) no duplica casos y decide el texto con el estado REAL del CRM", async () => {
      const p = patient();
      const w = setup({ sessions: true, verdicts: verdicts() });
      const first = id("txt");
      const photo = id("img");
      ingest(w, p, first);
      ingest(w, p, photo, "PARTIAL");
      await say(w, p, "hemograma y creatinina", first);
      await send(w, imageEvent(photo, p.phone, "PARTIAL"));
      const closing = id("txt");
      for (let i = 0; i < 3; i++) await send(w, textEvent(closing, p.phone, "listo"));
      expect(w.crm.cases).toHaveLength(2);
      expect(w.sends.filter((s) => s.body === QUOTE_TEXTS.review_confirmed)).toHaveLength(1);
    });
  });

  it("privacidad: ni la cola, ni la bitácora, ni los registros contienen el teléfono, el texto del paciente, el token ni el cuerpo del evento; el cuerpo cifrado se borra al entregar", async () => {
    const p = patient();
    const w = setup();
    w.crm.enabled = false;
    const message = id("txt");
    await say(w, p, `quiero hablar con una persona ${SENTINEL}`, message);
    const pendingDump = await db.ok(`select coalesce(json_agg(o), '[]') from public.plusmedik_crm_outbox o where contact_key = '${p.key}'`);
    expect(pendingDump).not.toMatch(new RegExp(`${p.phone}|${SENTINEL}|59170`));
    expect(pendingDump).toMatch(/"payload_cipher":"v1\./);
    w.crm.enabled = true;
    ingest(w, p, message);
    await makeDue(p.key);
    await w.outbox.drain();
    const doneDump = await db.ok(`select (select coalesce(json_agg(o), '[]') from public.plusmedik_crm_outbox o)::text || (select coalesce(json_agg(a), '[]') from public.plusmedik_crm_outbox_attempts a)::text`);
    expect(doneDump).not.toMatch(new RegExp(`${p.phone}|${SENTINEL}`));
    expect((await events(p.key))[0]!.has_payload).toBe(false);
    expect(JSON.stringify(w.logs) + JSON.stringify(w.sends.map((s) => s.body))).not.toMatch(new RegExp(`${p.phone}|${SENTINEL}|${w.crm.token}`));
  });
});
