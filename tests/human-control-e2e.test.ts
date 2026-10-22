import { createHmac } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, type AuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { forever, gate, withFaults } from "./support/faults.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Apagado automático por intervención humana de extremo a extremo: el webhook REAL (src/kapso-webhook.ts) + handleImageMessage REAL + los repositorios REALES
// (src/audit.ts, src/human-control.ts) + PostgreSQL REAL. Lo único simulado es la red hacia Supabase (adaptador que traduce RPC a SQL), Kapso (contador de envíos)
// y el motor de recetas (resultado fijo). Los eventos tienen el formato de Kapso v2. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[human-control-e2e] PostgreSQL no disponible: se omiten los escenarios de atención humana contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATIONS = ["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql", "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"].map((name) => join(__dirname, "..", "supabase", "migrations", name));
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const PHONE = "59170000000";
const OTHER_PHONE = "59171111111";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY = contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: PHONE })!;
const OTHER_KEY = contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: OTHER_PHONE })!;

const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

// ── eventos de Kapso v2
const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const imageEvent = (id: string, phone = PHONE) => ({
  message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", from: phone, image: { id: "media-1" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: true, media_url: "https://example.test/img.jpg" } },
  conversation: conversation(phone), phone_number_id: LAB
});
const outboundEvent = (origin: string | undefined, id: string, options: { status?: string; phone?: string; secondsAgo?: number } = {}) => ({
  message: { id, timestamp: String(Math.floor(Date.now() / 1000) - (options.secondsAgo ?? 0)), type: "text", to: options.phone ?? PHONE, text: { body: "TEXTO_CLINICO_SENTINELA" }, kapso: { direction: "outbound", status: options.status ?? "sent", ...(origin ? { origin } : {}) } },
  conversation: conversation(options.phone ?? PHONE), phone_number_id: LAB
});
const signedPost = (payload: unknown, headers: Record<string, string> = {}, secret: string | null = SECRET) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", ...(secret ? { "x-webhook-signature": createHmac("sha256", secret).update(body).digest("hex") } : {}), ...headers } });
};
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };

describe.skipIf(!bin)("apagado automático por intervención humana (extremo a extremo contra PostgreSQL real)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("humanctl");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(file);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 20_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;

  function setup(options: { quote?: Partial<QuoteDeps>; audit?: (real: AuditRepository) => AuditRepository } = {}) {
    const sends: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const realAudit = createSupabaseAuditRepository(rpcOptions());
    const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log: (event, data) => logs.push([event, data]),
      audit: options.audit ? options.audit(realAudit) : realAudit,
      leaseRenewIntervalMs: 3_600_000,
      requireAuditGuard: true,
      humanControl: { contactKeyFor },
      ...options.quote
    };
    const deps: KapsoWebhookDeps = {
      secret: SECRET,
      allowedPhones: undefined,
      quote,
      schedule: (task) => { scheduled.push(task); },
      humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) },
      log: (event, data) => logs.push([event, data])
    };
    return { deps, quote, sends, logs, scheduled, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  const contactState = async (key: string): Promise<Record<string, any> | undefined> => {
    const out = await db.ok(`select coalesce((select to_json(c) from public.plusmedik_attention_contacts c where contact_key = '${key}')::text, '')`);
    return out ? JSON.parse(out) : undefined;
  };
  const eventKinds = (key: string) => db.ok(`select coalesce(string_agg(kind || ':' || outcome, ',' order by received_at, id), '') from public.plusmedik_attention_events where contact_key = '${key}'`);
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const hasRun = (message: string) => db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  const resume = (key: string) => createAttentionRepository(rpcOptions()).resume(key, "MANUAL_RESUME", "ops_user");
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  // Cada escenario usa un paciente distinto, así que los estados no se mezclan entre pruebas.
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone })! };
  };

  it("un saliente confirmado desde WhatsApp Business pausa a ese contacto (y solo a él): la fila se crea, con motivo, fuente y revisión", async () => {
    const p = patient();
    const other = patient();
    const w = setup();
    expect(await contactState(p.key)).toBeUndefined();
    const response = await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
    expect(response.status).toBe(200);
    expect(await contactState(p.key)).toMatchObject({ state: "HUMAN_PAUSED", revision: 2, pause_reason: "HUMAN_WHATSAPP_BUSINESS_APP", pause_source: "kapso_business_app" });
    expect(await contactState(other.key)).toBeUndefined();
    expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED");
    expect(logsOf(w.logs, "human_event")).toEqual([expect.objectContaining({ outcome: "PAUSED", revision: 2 })]);
  });

  it("un saliente del propio bot (origin cloud_api), los estados de entrega y el historial NO pausan, y la IA sigue respondiendo", async () => {
    const p = patient();
    const w = setup();
    for (const [event, headers] of [
      [outboundEvent("cloud_api", id("bot"), { phone: p.phone }), SENT],
      [outboundEvent("business_app", id("delivered"), { phone: p.phone, status: "delivered" }), { "x-webhook-event": "whatsapp.message.delivered" }],
      [outboundEvent("business_app", id("read"), { phone: p.phone, status: "read" }), { "x-webhook-event": "whatsapp.message.read" }],
      [outboundEvent("history_sync", id("hist"), { phone: p.phone }), SENT]
    ] as const) expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    expect(await contactState(p.key)).toBeUndefined();
    expect(await eventKinds(p.key)).toBe("");
    const message = id("img");
    expect((await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED))).status).toBe(200);
    await w.settle();
    expect(w.sends).toHaveLength(1);
    expect(await phase(message)).toBe("SENT_ACCEPTED");
  });

  it("origen desconocido: se registra como desconocido, sin inventar una intervención humana", async () => {
    const p = patient();
    const w = setup();
    await w.hook(signedPost(outboundEvent(undefined, id("unk"), { phone: p.phone }), SENT));
    await w.hook(signedPost(outboundEvent("origen_futuro", id("unk"), { phone: p.phone }), SENT));
    expect(await contactState(p.key)).toBeUndefined();
    expect(await eventKinds(p.key)).toBe("UNKNOWN_ORIGIN:RECORDED,UNKNOWN_ORIGIN:RECORDED");
  });

  describe("el cliente escribe mientras la IA está pausada", () => {
    it("pausa ANTES de iniciar el análisis: no se descarga, no se analiza, no se crea corrida, no se responde, y queda el evento de supresión", async () => {
      const p = patient();
      const w = setup();
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      const message = id("img");
      expect((await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED))).status).toBe(200); // el ACK de la imagen no cambia
      await w.settle();
      expect(w.quote.downloadImage).not.toHaveBeenCalled();
      expect(w.quote.analyze).not.toHaveBeenCalled();
      expect(w.sends).toEqual([]);
      expect(await hasRun(message)).toBe("0");
      expect(logsOf(w.logs, "duplicate_ignored")).toEqual([{ processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" }]);
      expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED,PATIENT_SUPPRESSED:SUPPRESSED");
      // escribir otra vez (o reenviar la misma foto) sigue sin respuesta y no duplica el evento
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(await db.ok(`select count(*) from public.plusmedik_attention_events where event_key = 'inbound:${message}'`)).toBe("1");
    });

    it("mensajes de texto del paciente durante la pausa no activan nada y no cambian el estado", async () => {
      const p = patient();
      const w = setup();
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      const text = { message: { id: id("txt"), type: "text", from: p.phone, text: { body: "TEXTO_CLINICO_SENTINELA" }, kapso: { direction: "inbound", status: "received", origin: "cloud_api" } }, conversation: conversation(p.phone), phone_number_id: LAB };
      expect((await w.hook(signedPost(text, RECEIVED))).status).toBe(200);
      expect(w.scheduled).toHaveLength(0);
      expect((await contactState(p.key))!.state).toBe("HUMAN_PAUSED");
    });

    it("al reactivar de forma legítima la IA vuelve a responder", async () => {
      const p = patient();
      const w = setup();
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      await w.hook(signedPost(imageEvent(id("img"), p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(await resume(p.key)).toBe("RESUMED");
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(await phase(message)).toBe("SENT_ACCEPTED");
    });
  });

  describe("la pausa llega en distintos momentos del procesamiento", () => {
    it("DURANTE el análisis: el procesamiento pendiente se bloquea y no se envía nada", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ quote: { analyze: vi.fn(async () => { await hold.hook(); return okAnalysis(); }) } });
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await hold.arrived;
      const response = await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      expect(response.status).toBe(200);
      expect(logsOf(w.logs, "human_event")).toEqual([expect.objectContaining({ outcome: "PAUSED", blockedRuns: 1, lateReservedRuns: 0 })]);
      hold.open();
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "blocked" }]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED", reply_state: "NOT_ATTEMPTED" });
      expect(await phase(message)).toBe("CLOSED_NO_SEND");
    });

    it("DESPUÉS del análisis y ANTES de reservar el envío: la reserva se deniega", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ audit: (real) => withFaults(real, { reserveSend: { before: hold.hook } }) });
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await hold.arrived;
      expect(await phase(message)).toBe("ANALYZED_UNSENT");
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      hold.open();
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
    });

    it("DESPUÉS de reservar y ANTES de la comprobación final: se libera la reserva, no se envía, y la carrera queda registrada", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ audit: (real) => withFaults(real, { reserveSend: { after: hold.hook } }) });
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await hold.arrived;
      expect((await run(message)).send_state).toBe("RESERVED");
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      expect(logsOf(w.logs, "human_event")).toEqual([expect.objectContaining({ outcome: "PAUSED", blockedRuns: 0, lateReservedRuns: 1 })]);
      expect(await run(message)).toMatchObject({ send_state: "RESERVED", attention_reason: "HUMAN_PAUSE_AFTER_RESERVATION" });
      hold.open();
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "blocked" }]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED", attention_reason: null });
      expect(await db.ok(`select late_reserved_runs from public.plusmedik_attention_events where contact_key = '${p.key}' and kind = 'HUMAN_BUSINESS_APP'`)).toBe("1");
    });

    it("DURANTE la llamada externa: el envío YA no se puede cancelar; se envía una vez y la carrera queda registrada como evento auditable", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ quote: { sendText: vi.fn(async (_to: string, body: string) => { w.sends.push(body); await hold.hook(); return { providerMessageId: "wamid.out-late" }; }) } });
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await hold.arrived; // Kapso está procesando el envío
      expect(w.sends).toHaveLength(1);
      const response = await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      expect(response.status).toBe(200);
      expect(logsOf(w.logs, "human_event")).toEqual([expect.objectContaining({ outcome: "PAUSED", lateReservedRuns: 1 })]);
      hold.open();
      await w.settle();
      expect(w.sends).toHaveLength(1); // no hay cancelación ni duplicado
      expect(await run(message)).toMatchObject({ send_state: "ACCEPTED", attention_reason: "HUMAN_PAUSE_AFTER_RESERVATION" });
      expect(await db.ok(`select late_reserved_runs from public.plusmedik_attention_events where contact_key = '${p.key}' and kind = 'HUMAN_BUSINESS_APP'`)).toBe("1");
      expect((await contactState(p.key))!.state).toBe("HUMAN_PAUSED"); // los siguientes mensajes ya no se responden
    });
  });

  describe("duplicados, retrasos y orden de eventos", () => {
    it("el mismo evento entregado dos veces (reintento de Kapso) pausa una sola vez", async () => {
      const p = patient();
      const w = setup();
      const event = outboundEvent("business_app", id("human"), { phone: p.phone });
      expect((await w.hook(signedPost(event, { ...SENT, "x-idempotency-key": "idem-A" }))).status).toBe(200);
      expect((await w.hook(signedPost(event, { ...SENT, "x-idempotency-key": "idem-A" }))).status).toBe(200);
      expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED");
      expect((await contactState(p.key))!.revision).toBe(2);
      expect(logsOf(w.logs, "human_event").map((entry) => entry.outcome)).toEqual(["PAUSED", "DUPLICATE"]);
    });

    it("un evento retrasado anterior a una reactivación legítima NO vuelve a pausar; uno posterior sí", async () => {
      const p = patient();
      const w = setup();
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone, secondsAgo: 60 }), SENT));
      await resume(p.key);
      const stale = await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone, secondsAgo: 30 }), SENT));
      expect(stale.status).toBe(200);
      expect((await contactState(p.key))!.state).toBe("ACTIVE");
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      await sleep(1100);
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      expect((await contactState(p.key))!.state).toBe("HUMAN_PAUSED");
      expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED,MANUAL_RESUME:RESUMED,HUMAN_BUSINESS_APP:STALE_IGNORED,HUMAN_BUSINESS_APP:PAUSED");
    });

    it("eventos FUERA DE ORDEN: el más reciente no se pierde aunque llegue primero el más antiguo, y la revisión solo avanza con el cambio de estado", async () => {
      const p = patient();
      const w = setup();
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone, secondsAgo: 5 }), SENT));
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone, secondsAgo: 50 }), SENT));
      await w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone, secondsAgo: 1 }), SENT));
      expect(await contactState(p.key)).toMatchObject({ state: "HUMAN_PAUSED", revision: 2 });
      expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED,HUMAN_BUSINESS_APP:ALREADY_PAUSED,HUMAN_BUSINESS_APP:ALREADY_PAUSED");
    });

    it("el estado de entrega de un mensaje humano que llega después de la pausa no cambia nada", async () => {
      const p = patient();
      const w = setup();
      const message = id("human");
      await w.hook(signedPost(outboundEvent("business_app", message, { phone: p.phone }), SENT));
      const before = await contactState(p.key);
      await w.hook(signedPost(outboundEvent("business_app", message, { phone: p.phone, status: "delivered" }), { "x-webhook-event": "whatsapp.message.delivered" }));
      await w.hook(signedPost(outboundEvent("business_app", message, { phone: p.phone, status: "read" }), { "x-webhook-event": "whatsapp.message.read" }));
      expect(await contactState(p.key)).toEqual(before);
      expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED");
    });
  });

  describe("concurrencia de webhooks", () => {
    it("varios webhooks con el mismo evento humano a la vez: una sola pausa y un solo registro", async () => {
      const p = patient();
      const w = setup();
      const event = outboundEvent("business_app", id("human"), { phone: p.phone });
      const responses = await Promise.all(Array.from({ length: 5 }, (_v, i) => w.hook(signedPost(event, { ...SENT, "x-idempotency-key": `idem-${i}` }))));
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await eventKinds(p.key)).toBe("HUMAN_BUSINESS_APP:PAUSED");
      expect(logsOf(w.logs, "human_event").map((entry) => entry.outcome).sort()).toEqual(["DUPLICATE", "DUPLICATE", "DUPLICATE", "DUPLICATE", "PAUSED"]);
    });

    it("la imagen del paciente y el mensaje humano llegan a la vez: nunca se responde después de que la pausa quedó registrada", async () => {
      const p = patient();
      const w = setup({ quote: { analyze: vi.fn(async () => { await sleep(400); return okAnalysis(); }) } });
      const message = id("img");
      await Promise.all([
        w.hook(signedPost(imageEvent(message, p.phone), RECEIVED)),
        (async () => { await sleep(150); return w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT)); })()
      ]);
      await w.settle();
      expect(w.sends).toEqual([]);
      expect((await contactState(p.key))!.state).toBe("HUMAN_PAUSED");
    });

    it("pacientes distintos no se afectan entre sí aunque los eventos lleguen en paralelo", async () => {
      const a = patient();
      const b = patient();
      const w = setup();
      const imageB = id("img");
      await Promise.all([
        w.hook(signedPost(outboundEvent("business_app", id("human"), { phone: a.phone }), SENT)),
        w.hook(signedPost(imageEvent(imageB, b.phone), RECEIVED))
      ]);
      await w.settle();
      expect((await contactState(a.key))!.state).toBe("HUMAN_PAUSED");
      expect(await contactState(b.key)).toBeUndefined();
      expect(w.sends).toHaveLength(1);
      expect(await phase(imageB)).toBe("SENT_ACCEPTED");
    });
  });

  describe("Supabase no disponible", () => {
    it("un evento humano que no se puede registrar responde 503 (Kapso reintenta) y no cambia el estado; el reintento lo registra", async () => {
      const p = patient();
      const w = setup();
      const request = () => signedPost(outboundEvent("business_app", "wamid.retry-" + p.phone, { phone: p.phone }), SENT);
      network.down = true;
      let failed: Response;
      try {
        failed = await w.hook(request());
      } finally {
        network.down = false;
      }
      expect(failed.status).toBe(503);
      expect(w.scheduled).toHaveLength(0);
      expect(await contactState(p.key)).toBeUndefined();
      expect(logsOf(w.logs, "human_event_failed")).toEqual([{ error: "UNKNOWN_OUTCOME" }]);
      expect((await w.hook(request())).status).toBe(200); // el reintento de Kapso
      expect((await contactState(p.key))!.state).toBe("HUMAN_PAUSED");
    });

    it("con la base caída NO se envía nada automático: ni siquiera al paciente que nunca fue pausado (falla cerrada)", async () => {
      const p = patient();
      const w = setup();
      network.down = true;
      try {
        await w.hook(signedPost(imageEvent(id("img"), p.phone), RECEIVED));
        await w.settle();
      } finally {
        network.down = false;
      }
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "audit_guard_unavailable" }]);
      expect(w.quote.downloadImage).not.toHaveBeenCalled();
    });

    it("si la base cae justo en la reserva o en la comprobación final, tampoco se envía (la corrida queda para conciliar)", async () => {
      const reserveDown = patient();
      const a = setup();
      network.downFor.add("plusmedik_audit_reserve_send");
      try {
        await a.hook(signedPost(imageEvent(id("img"), reserveDown.phone), RECEIVED));
        await a.settle();
      } finally {
        network.downFor.delete("plusmedik_audit_reserve_send");
      }
      expect(a.sends).toEqual([]);
      expect(logsOf(a.logs, "reply_withheld")).toEqual([{ reason: "unavailable" }]);

      const confirmDown = patient();
      const b = setup();
      const message = id("img");
      network.downFor.add("plusmedik_audit_confirm_send");
      try {
        await b.hook(signedPost(imageEvent(message, confirmDown.phone), RECEIVED));
        await b.settle();
      } finally {
        network.downFor.delete("plusmedik_audit_confirm_send");
      }
      expect(b.sends).toEqual([]);
      expect(logsOf(b.logs, "reply_withheld")).toEqual([{ reason: "unavailable" }]);
      expect((await run(message)).send_state).toBe("RESERVED"); // el recuperador la marcará como desconocida; jamás se reenvía
    });
  });

  describe("autenticación del webhook", () => {
    it("sin firma, con firma de otro secreto o alterada: 401, sin cambiar ningún estado ni procesar nada", async () => {
      const p = patient();
      const w = setup();
      const event = outboundEvent("business_app", id("human"), { phone: p.phone });
      expect((await w.hook(signedPost(event, SENT, null))).status).toBe(401);
      expect((await w.hook(signedPost(event, SENT, "otro-secreto"))).status).toBe(401);
      const tampered = signedPost(event, SENT);
      const forged = new Request(tampered.url, { method: "POST", body: JSON.stringify({ ...event, extra: 1 }), headers: tampered.headers });
      expect((await w.hook(forged)).status).toBe(401);
      expect(await contactState(p.key)).toBeUndefined();
      expect(await eventKinds(p.key)).toBe("");
      expect(w.scheduled).toHaveLength(0);
      const image = await w.hook(signedPost(imageEvent(id("img"), p.phone), RECEIVED, null));
      expect(image.status).toBe(401);
      expect(w.quote.downloadImage).not.toHaveBeenCalled();
    });
  });

  describe("compatibilidad con leases y reservas (F1.3)", () => {
    it("una ejecución interrumpida se reanuda con el lease vencido y responde una vez si no hubo pausa", async () => {
      const p = patient();
      const message = id("img");
      const crashed = setup({ quote: { analyze: vi.fn(async () => forever()) } });
      await crashed.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await sleep(1500);
      await db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 hour' where kapso_message_id = '${message}';`);
      const redelivery = setup();
      await redelivery.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await redelivery.settle();
      expect(redelivery.sends).toHaveLength(1);
      expect(crashed.sends).toEqual([]);
      expect(await run(message)).toMatchObject({ lease_attempts: 2, send_state: "ACCEPTED", contact_key: p.key });
    });

    it("si mientras tanto una recepcionista intervino, la reanudación NO responde", async () => {
      const p = patient();
      const message = id("img");
      const crashed = setup({ quote: { analyze: vi.fn(async () => forever()) } });
      await crashed.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await sleep(1500);
      await crashed.hook(signedPost(outboundEvent("business_app", id("human"), { phone: p.phone }), SENT));
      await db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 hour' where kapso_message_id = '${message}';`);
      const redelivery = setup();
      await redelivery.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await redelivery.settle();
      expect(redelivery.sends).toEqual([]);
      expect(logsOf(redelivery.logs, "duplicate_ignored")).toEqual([{ processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" }]);
    });
  });

  it("un teléfono distinto del contacto no comparte estado: la clave está acotada al contacto y al número del laboratorio", async () => {
    expect(KEY).not.toBe(OTHER_KEY);
    expect(await contactState(KEY)).toBeUndefined();
  });
});
