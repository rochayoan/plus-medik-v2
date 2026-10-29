import { createHmac } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, type AuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { BLOCKED_HANDOFF, createTextHandler, DRAFT_TEXTS, type HandoffRequest, type HandoffSink } from "../src/text-handler.js";
import type { TurnHandlers } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { forever, gate, withFaults } from "./support/faults.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Conversación de texto de extremo a extremo: webhook REAL + manejador de texto REAL + coordinación de turnos REAL + repositorios REALES + PostgreSQL REAL con las
// SIETE migraciones. Solo se simulan la red hacia Supabase (RPC -> SQL), Kapso (contador de envíos) y el motor de recetas. Se omite, con aviso, sin PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[text-conversation-e2e] PostgreSQL no disponible: se omiten los escenarios de conversación de texto contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATIONS = [
  "20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql",
  "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql", "20261025000000_plusmedik_turns.sql", "20261026000000_plusmedik_turn_recovery.sql"
].map((name) => join(__dirname, "..", "supabase", "migrations", name));
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_8842";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const now = (secondsAgo = 0) => String(Math.floor(Date.now() / 1000) - secondsAgo);
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body: string, secondsAgo = 0) => ({ message: { id, timestamp: now(secondsAgo), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "image", from: phone, image: { id: "media-1" }, kapso: { ...inbound, has_media: true, media_url: "https://example.test/img.jpg" } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

describe.skipIf(!bin)("conversación de texto (extremo a extremo contra PostgreSQL real)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("text_conversation");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(file);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 20_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  function setup(options: { handoff?: HandoffSink; wrap?: (inner: NonNullable<TurnHandlers["text"]>) => NonNullable<TurnHandlers["text"]>; audit?: (real: AuditRepository) => AuditRepository; quote?: Partial<QuoteDeps>; busyRetries?: number; busyDelayMs?: number } = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const inner = createTextHandler({ handoff: options.handoff, log });
    const realAudit = createSupabaseAuditRepository(rpcOptions());
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log,
      audit: options.audit ? options.audit(realAudit) : realAudit,
      leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor, handlers: { text: options.wrap ? options.wrap(inner) : inner }, busyDelayMs: options.busyDelayMs ?? 20, busyRetries: options.busyRetries ?? 400 },
      ...options.quote
    };
    const deps: KapsoWebhookDeps = {
      secret: SECRET, allowedPhones: undefined, quote,
      schedule: (task) => { scheduled.push(task); },
      humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) },
      log
    };
    return { quote, sends, logs, scheduled, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const hasRun = (message: string) => db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  const seqOf = async (message: string): Promise<number> => Number(await db.ok(`select t.seq from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id where r.kapso_message_id = '${message}'`));
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 second' where kapso_message_id = '${message}';`);
  const operationalSink = (after?: () => Promise<void>) => {
    const requests: HandoffRequest[] = [];
    const handoff: HandoffSink = { operational: true, record: vi.fn(async (request: HandoffRequest): Promise<"RECORDED"> => { requests.push(request); await after?.(); return "RECORDED"; }) };
    return { handoff, requests };
  };

  describe("funcionamiento y privacidad", () => {
    it("un saludo recibe el texto fijo UNA vez, auditado como turno TEXT 'conversation'; el texto del paciente y su teléfono no existen en ninguna tabla ni log", async () => {
      const p = patient();
      const w = setup();
      const message = id("txt");
      expect((await w.hook(signedPost(textEvent(message, p.phone, `hola ${SENTINEL}`), RECEIVED))).status).toBe(200);
      await w.settle();
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.fallback }]);
      expect(await run(message)).toMatchObject({ send_kind: "conversation", send_state: "ACCEPTED", reply_kind: "conversation", processing_status: "COMPLETED", contact_key: p.key });
      expect(await seqOf(message)).toBe(1);
      const dump = await db.ok(`select string_agg(t, ' ') from (
        select to_json(x)::text t from public.plusmedik_audit_runs x union all select to_json(x)::text from public.plusmedik_audit_checks x union all
        select to_json(x)::text from public.plusmedik_attention_events x union all select to_json(x)::text from public.plusmedik_turns x union all select to_json(x)::text from public.plusmedik_contact_turns x) rows_`);
      for (const secret of [SENTINEL, p.phone]) {
        expect(dump).not.toContain(secret);
        expect(JSON.stringify(w.logs)).not.toContain(secret);
      }
      expect(logsOf(w.logs, "text_turn")).toEqual([{ category: "OTHER", handoff: "none" }]);
    });

    it("cada categoría recibe su texto fijo y NINGUNA respuesta contiene cifras, precios, horarios ni datos médicos", async () => {
      const p = patient();
      const w = setup();
      const expected: Array<[string, string]> = [["hola", DRAFT_TEXTS.greeting], ["quiero cotizar", DRAFT_TEXTS.send_recipe], ["a qué hora abren", DRAFT_TEXTS.handoff_unavailable], ["quiero hablar con una persona", DRAFT_TEXTS.handoff_unavailable], ["me duele el pecho", DRAFT_TEXTS.medical_unavailable], ["gracias", DRAFT_TEXTS.fallback]];
      for (const [body, answer] of expected) {
        const before = w.sends.length;
        await w.hook(signedPost(textEvent(id("txt"), p.phone, body), RECEIVED));
        await w.settle();
        expect(w.sends.slice(before), body).toEqual([{ to: p.phone, body: answer }]);
      }
      for (const { body } of w.sends) expect(body).not.toMatch(/\d|\bBs\b/);
    });

    it("la derivación está BLOQUEADA por defecto: ningún texto de respuesta promete que una persona atenderá, y no se registra ninguna solicitud", async () => {
      const p = patient();
      const w = setup({ handoff: BLOCKED_HANDOFF });
      for (const body of ["quiero hablar con una persona", "tengo una urgencia, me duele", "a qué hora atienden"]) await w.hook(signedPost(textEvent(id("txt"), p.phone, body), RECEIVED));
      await w.settle();
      expect(w.sends.length).toBeGreaterThan(0);
      for (const { body } of w.sends) expect(body).not.toBe(DRAFT_TEXTS.handoff_confirmed);
      expect(logsOf(w.logs, "text_turn").every((entry) => entry.handoff === "blocked")).toBe(true);
    });
  });

  describe("sin duplicados", () => {
    it("el mismo texto entregado dos veces a la vez y una tercera después: una sola respuesta", async () => {
      const p = patient();
      const w = setup();
      const message = id("txt");
      await Promise.all([w.hook(signedPost(textEvent(message, p.phone, "hola"), RECEIVED)), w.hook(signedPost(textEvent(message, p.phone, "hola"), RECEIVED))]);
      await w.settle();
      await w.hook(signedPost(textEvent(message, p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(await seqOf(message)).toBe(1);
    });

    it("la solicitud de derivación es idempotente: reprocesar el mismo mensaje (toma del lease) usa la misma clave y se responde una sola vez", async () => {
      const p = patient();
      const hold = gate();
      const s = operationalSink();
      let calls = 0;
      const w = setup({ handoff: s.handoff, wrap: (inner) => async (turn) => { if (++calls === 1) await hold.hook(); return inner(turn); } });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone, "quiero un asesor"), RECEIVED));
      await hold.arrived;
      await expire(message);
      await w.hook(signedPost(textEvent(message, p.phone, "quiero un asesor"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
      hold.open();
      await w.settle();
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.handoff_confirmed }]);
      expect(new Set(s.requests.map((r) => r.eventId))).toEqual(new Set([`handoff:${message}`]));
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "lost" }]);
    });
  });

  describe("mensajes consecutivos del mismo contacto", () => {
    it("varios textos a la vez: los envíos nunca se solapan en Kapso y, si se envían varios, salen en el orden de los turnos (nunca uno viejo después de uno nuevo)", async () => {
      const p = patient();
      let active = 0;
      let maxActive = 0;
      const sentOrder: string[] = [];
      const w = setup({
        quote: {
          sendText: vi.fn(async (_to: string, body: string) => { active++; maxActive = Math.max(maxActive, active); await sleep(120); sentOrder.push(body); active--; return { providerMessageId: "wamid.out" }; })
        }
      });
      const messages = Array.from({ length: 4 }, () => id("txt"));
      await Promise.all(messages.map((message) => w.hook(signedPost(textEvent(message, p.phone, "hola"), RECEIVED))));
      await w.settle();
      expect(maxActive).toBe(1);
      expect(sentOrder.length).toBeGreaterThanOrEqual(1);
      // orden REAL de los envíos (por el instante de la reserva) = orden de los turnos
      const sentSeqs = (await db.ok(`select coalesce(string_agg(t.seq::text, ',' order by r.send_reserved_at), '') from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id where t.contact_key = '${p.key}' and r.send_state = 'ACCEPTED'`)).split(",").filter(Boolean).map(Number);
      expect(sentSeqs).toEqual([...sentSeqs].sort((a, b) => a - b));
      // todo turno quedó cerrado: respondido o descartado por obsoleto; ninguno quedó pendiente ni con envío reservado
      for (const message of messages) expect(["SENT_ACCEPTED", "CLOSED_NO_SEND"]).toContain(await phase(message));
      expect(sentSeqs.length).toBe(sentOrder.length);
    });

    it("OBSOLETA: la respuesta conversacional lenta del primer texto se descarta si el segundo ya respondió; y nunca llega después", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ wrap: (inner) => async (turn) => { if (turn.text === "hola lento") await hold.hook(); return inner(turn); } });
      const first = id("txt");
      const second = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone, "hola lento"), RECEIVED));
      await hold.arrived;
      await w.hook(signedPost(textEvent(second, p.phone, "quiero cotizar"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
      hold.open();
      await w.settle();
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.send_recipe]);
      expect(await run(first)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "SUPERSEDED" });
    });

    it("una COTIZACIÓN nunca se descarta: la imagen lenta se entrega completa aunque dos textos posteriores ya hayan sido respondidos", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ quote: { analyze: vi.fn(async () => { await hold.hook(); return okAnalysis(); }) } });
      const image = id("img");
      await w.hook(signedPost(imageEvent(image, p.phone), RECEIVED));
      await hold.arrived;
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "gracias"), RECEIVED));
      await vi.waitFor(() => expect(w.sends.length).toBeGreaterThanOrEqual(1), { timeout: 15_000, interval: 25 });
      hold.open();
      await w.settle();
      const quoted = w.sends.filter((s) => s.body.includes("Cotización de tu receta"));
      expect(quoted).toHaveLength(1);
      expect(await run(image)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
    });

    it("la CONFIRMACIÓN de una derivación persistida tampoco se descarta, aunque otro texto haya respondido antes: la evidencia de la solicitud y su aviso se conservan", async () => {
      const p = patient();
      const hold = gate();
      const s = operationalSink(async () => { await hold.hook(); });
      const w = setup({ handoff: s.handoff });
      const first = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone, "quiero hablar con un asesor"), RECEIVED));
      await hold.arrived; // la solicitud ya se está persistiendo
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
      hold.open();
      await w.settle();
      expect(s.requests).toHaveLength(1);
      expect(w.sends.map((x) => x.body)).toEqual([DRAFT_TEXTS.greeting, DRAFT_TEXTS.handoff_confirmed]);
      expect(await run(first)).toMatchObject({ send_state: "ACCEPTED" });
    });

    it("con derivación bloqueada, en cambio, el aviso 'no disponible' obsoleto sí se descarta y no se registra ninguna solicitud", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ handoff: BLOCKED_HANDOFF, wrap: (inner) => async (turn) => { if (turn.text === "quiero un asesor") await hold.hook(); return inner(turn); } });
      const first = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone, "quiero un asesor"), RECEIVED));
      await hold.arrived;
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
      hold.open();
      await w.settle();
      expect(w.sends.map((x) => x.body)).toEqual([DRAFT_TEXTS.greeting]);
      expect(await run(first)).toMatchObject({ send_block_reason: "SUPERSEDED" });
    });
  });

  describe("'busy' agotado: el turno es recuperable y no hay envíos duplicados", () => {
    it("un envío colgado de otro turno del contacto: este espera, desiste SIN enviar, queda marcado y un reenvío lo responde UNA vez cuando el primero termina", async () => {
      const p = patient();
      const stuck = gate();
      let sendCalls = 0;
      const w = setup({
        busyRetries: 3,
        busyDelayMs: 15,
        quote: { sendText: vi.fn(async (to: string, body: string) => { sendCalls++; if (sendCalls === 1) await stuck.hook(); w.sends.push({ to, body }); return { providerMessageId: `wamid.out-${sendCalls}` }; }) }
      });
      const a = id("txt");
      const b = id("txt");
      await w.hook(signedPost(textEvent(a, p.phone, "hola"), RECEIVED));
      await stuck.arrived; // el envío de A está en vuelo (reservado) y colgado
      await w.hook(signedPost(textEvent(b, p.phone, "quiero cotizar"), RECEIVED));
      await vi.waitFor(() => expect(logsOf(w.logs, "reply_withheld")).toContainEqual({ reason: "busy_timeout" }), { timeout: 15_000, interval: 25 });
      // el log se emite ANTES de que termine el RPC que libera el turno: se espera a la liberación (BUSY_TIMEOUT) para no depender del orden
      await vi.waitFor(async () => expect((await run(b)).attention_reason).toBe("BUSY_TIMEOUT"), { timeout: 15_000, interval: 25 });
      expect(sendCalls).toBe(1); // B no llegó a llamar a Kapso
      expect(await run(b)).toMatchObject({ send_state: "NOT_RESERVED", attention_reason: "BUSY_TIMEOUT" });
      expect(await phase(b)).toBe("NEEDS_ATTENTION");
      const seq = await seqOf(b);

      stuck.open(); // A termina y libera al contacto
      await w.settle();
      expect(await phase(a)).toBe("SENT_ACCEPTED");

      // el reenvío de B (Kapso, o el paciente) lo reclama de nuevo: mismo turno, mismo número, UNA respuesta
      await w.hook(signedPost(textEvent(b, p.phone, "quiero cotizar"), RECEIVED));
      await w.settle();
      expect(logsOf(w.logs, "lease_taken_over")).toEqual([{ fence: 2 }]);
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.greeting, DRAFT_TEXTS.send_recipe]);
      expect(await seqOf(b)).toBe(seq);
      expect(await phase(b)).toBe("SENT_ACCEPTED");

      // un tercer reenvío no responde otra vez
      await w.hook(signedPost(textEvent(b, p.phone, "quiero cotizar"), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(2);
    });

    it("si nadie reenvía el mensaje, el recuperador cierra el turno SIN responder (queda para atención) y nunca envía", async () => {
      const p = patient();
      const stuck = gate();
      let sendCalls = 0;
      const w = setup({ busyRetries: 2, busyDelayMs: 10, quote: { sendText: vi.fn(async () => { sendCalls++; if (sendCalls === 1) await stuck.hook(); return { providerMessageId: "wamid.out" }; }) } });
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await stuck.arrived;
      const b = id("txt");
      await w.hook(signedPost(textEvent(b, p.phone, "quiero cotizar"), RECEIVED));
      await vi.waitFor(() => expect(logsOf(w.logs, "reply_withheld")).toContainEqual({ reason: "busy_timeout" }), { timeout: 15_000, interval: 25 });
      // el log se emite ANTES de que termine el RPC que libera el turno: se espera a la liberación (BUSY_TIMEOUT) para no depender del orden
      await vi.waitFor(async () => expect((await run(b)).attention_reason).toBe("BUSY_TIMEOUT"), { timeout: 15_000, interval: 25 });
      const result = JSON.parse((await db.ok(`set role service_role; select public.plusmedik_audit_recover_stale(0, 0, 500);`)).split("\n").at(-1)!);
      expect(result.abandoned_before_send).toBeGreaterThanOrEqual(1);
      expect(await run(b)).toMatchObject({ send_state: "NOT_APPLICABLE", attention_reason: "ABANDONED_BEFORE_SEND", reply_state: "NOT_ATTEMPTED" });
      stuck.open();
      await w.settle();
      expect(sendCalls).toBe(1);
    });
  });

  describe("pausa humana", () => {
    it("pausa ANTES del texto: no se reclama, no hay corrida ni turno y no se responde", async () => {
      const p = patient();
      const s = operationalSink();
      const w = setup({ handoff: s.handoff });
      await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT));
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone, "quiero un asesor"), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(s.requests).toEqual([]);
      expect(await hasRun(message)).toBe("0");
      expect(logsOf(w.logs, "duplicate_ignored")).toEqual([{ processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" }]);
    });

    it("pausa DURANTE la solicitud de derivación: la solicitud ya persistida se conserva, pero la confirmación NO se envía (la recepcionista ya tomó el caso)", async () => {
      const p = patient();
      const hold = gate();
      const s = operationalSink(async () => { await hold.hook(); });
      const w = setup({ handoff: s.handoff });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone, "quiero un asesor"), RECEIVED));
      await hold.arrived;
      expect((await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT))).status).toBe(200);
      hold.open();
      await w.settle();
      expect(s.requests).toHaveLength(1);
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "blocked" }]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
    });

    it("pausa ENTRE la reserva y el envío: la comprobación final libera la reserva y no se envía", async () => {
      const p = patient();
      let paused = false;
      const w = setup({ audit: (real) => withFaults(real, { confirmSend: { before: async () => { if (!paused) { paused = true; await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT)); } } } }) });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED" });
    });

    it("tras reactivar, el contacto vuelve a recibir respuestas y la secuencia continúa", async () => {
      const p = patient();
      const w = setup();
      await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT));
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(await createAttentionRepository(rpcOptions()).resume(p.key, "MANUAL_RESUME", "ops_user")).toBe("RESUMED");
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(await seqOf(message)).toBe(1);
    });
  });

  describe("fallos de persistencia y de infraestructura", () => {
    it("el sumidero de derivación falla: NO se confirma, se avisa que no está disponible, y no se filtra el error ni el texto", async () => {
      const p = patient();
      const handoff: HandoffSink = { operational: true, record: vi.fn(async () => { throw new Error(`persistencia caída ${SENTINEL}`); }) };
      const w = setup({ handoff });
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "quiero hablar con un asesor"), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.handoff_unavailable }]);
      expect(logsOf(w.logs, "text_turn")).toEqual([{ category: "HUMAN_REQUEST", handoff: "failed" }]);
      expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
    });

    it("la base cae al reclamar: el manejador no corre ni se responde (falla cerrado)", async () => {
      const p = patient();
      const s = operationalSink();
      const w = setup({ handoff: s.handoff });
      network.downFor.add("plusmedik_turn_claim");
      try {
        await w.hook(signedPost(textEvent(id("txt"), p.phone, "quiero un asesor"), RECEIVED));
        await w.settle();
      } finally {
        network.downFor.delete("plusmedik_turn_claim");
      }
      expect(s.requests).toEqual([]);
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "text_turn")).toEqual([]);
    });

    it("la base cae al reservar: no se envía y el turno sigue recuperable; el siguiente mensaje se responde", async () => {
      const p = patient();
      const w = setup();
      network.downFor.add("plusmedik_turn_reserve_send");
      const first = id("txt");
      try {
        await w.hook(signedPost(textEvent(first, p.phone, "hola"), RECEIVED));
        await w.settle();
      } finally {
        network.downFor.delete("plusmedik_turn_reserve_send");
      }
      expect(w.sends).toEqual([]);
      expect(await phase(first)).toBe("RECOVERABLE");
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
    });

    it("un envío con resultado incierto no se reintenta y no bloquea al contacto", async () => {
      const p = patient();
      let attempts = 0;
      const w = setup({ quote: { sendText: vi.fn(async (to: string, body: string) => { if (++attempts === 1) throw new Error("red caída"); w.sends.push({ to, body }); return { providerMessageId: "wamid.ok" }; }) } });
      const first = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(await phase(first)).toBe("SEND_UNKNOWN");
      await w.hook(signedPost(textEvent(first, p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(attempts).toBe(1); // el reenvío del mismo mensaje no reintenta el envío incierto
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "hola"), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
    });

    it("una ejecución que se cae a mitad del trabajo no impide atender los mensajes siguientes", async () => {
      const p = patient();
      let calls = 0;
      const w = setup({ wrap: (inner) => async (turn) => { if (++calls === 1) return forever(); return inner(turn); } });
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "uno"), RECEIVED));
      await sleep(100);
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "dos"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
    });
  });

  describe("identificación de mensajes entrantes", () => {
    it("no generan respuesta: un texto viejo, uno importado del historial, uno de un evento 'sent'/'delivered' o un mensaje saliente", async () => {
      const p = patient();
      const w = setup();
      const history = textEvent(id("hist"), p.phone, "hola");
      (history.message.kapso as Record<string, string>).origin = "history_sync";
      await w.hook(signedPost(textEvent(id("old"), p.phone, "hola", 3 * 3600), RECEIVED));
      await w.hook(signedPost(history, RECEIVED));
      await w.hook(signedPost(textEvent(id("sentevt"), p.phone, "hola"), SENT));
      await w.hook(signedPost(textEvent(id("deliv"), p.phone, "hola"), { "x-webhook-event": "whatsapp.message.delivered" }));
      await w.settle();
      expect(w.scheduled).toHaveLength(0);
      expect(w.sends).toEqual([]);
    });

    it("las IMÁGENES conservan su comportamiento: cotización idéntica, tipo 'quoted' y la política de siempre", async () => {
      const p = patient();
      const w = setup();
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("Cotización de tu receta");
      expect(w.sends[0]!.body).toContain("HEMOGRAMA — Bs 45");
      expect(await run(message)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
    });
  });
});
