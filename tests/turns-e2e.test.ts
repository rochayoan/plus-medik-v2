import { createHmac } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, type AuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import type { IncomingTurn, TurnHandlers } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { forever, gate, withFaults } from "./support/faults.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Turnos consecutivos de un mismo contacto de extremo a extremo: el webhook REAL (src/kapso-webhook.ts) + el procesamiento de turnos REAL (src/turns.ts,
// src/guarded-turn.ts) + los repositorios REALES (src/audit.ts, src/human-control.ts) + PostgreSQL REAL con las SEIS migraciones. Solo se simulan la red hacia Supabase
// (adaptador RPC -> SQL), Kapso (contador de envíos) y el motor de recetas / el manejador de texto. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[turns-e2e] PostgreSQL no disponible: se omiten los escenarios de turnos contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATIONS = [
  "20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql",
  "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql", "20261025000000_plusmedik_turns.sql"
].map((name) => join(__dirname, "..", "supabase", "migrations", name));
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_5521";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Espera una CONDICIÓN (no un tiempo fijo). vi.waitFor trae 1 s por defecto, que no alcanza cuando la suite completa corre muchos archivos con PostgreSQL en paralelo: aquí 60 s de tope,
// y una prueba sana sigue terminando en cuanto la condición se cumple.
const until = (condition: () => void) => vi.waitFor(condition, { timeout: 60_000, interval: 20 });
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

// ── eventos de Kapso v2
const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const now = (secondsAgo = 0) => String(Math.floor(Date.now() / 1000) - secondsAgo);
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body = "hola", secondsAgo = 0) => ({ message: { id, timestamp: now(secondsAgo), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "image", from: phone, image: { id: "media-1" }, kapso: { ...inbound, has_media: true, media_url: "https://example.test/img.jpg" } }, conversation: conversation(phone), phone_number_id: LAB });
const audioEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "audio", from: phone, audio: { id: "audio-1" }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

describe.skipIf(!bin)("turnos consecutivos de un contacto (extremo a extremo contra PostgreSQL real)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("turns_extremo");
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

  function setup(options: { handlers?: TurnHandlers; audit?: (real: AuditRepository) => AuditRepository; quote?: Partial<QuoteDeps>; busyDelayMs?: number; busyRetries?: number } = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const realAudit = createSupabaseAuditRepository(rpcOptions());
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log: (event, data) => logs.push([event, data]),
      audit: options.audit ? options.audit(realAudit) : realAudit,
      leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor, handlers: options.handlers, busyDelayMs: options.busyDelayMs ?? 20, busyRetries: options.busyRetries ?? 400 },
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

  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const hasRun = (message: string) => db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  const turnOf = async (message: string): Promise<Record<string, any> | undefined> => {
    const out = await db.ok(`select coalesce((select to_json(t) from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id where r.kapso_message_id = '${message}')::text, '')`);
    return out ? JSON.parse(out) : undefined;
  };
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 second' where kapso_message_id = '${message}';`);
  const reply = (body = "respuesta"): TurnHandlers => ({ text: async () => ({ body }) });

  it("un texto con manejador se procesa como turno 1 de su contacto: una respuesta, auditada como 'conversation', y el contenido del mensaje no existe en ninguna tabla", async () => {
    const p = patient();
    const w = setup({ handlers: { text: async (turn: IncomingTurn) => ({ body: `Recibimos tu mensaje (${turn.text!.length} caracteres)` }) } });
    const message = id("txt");
    expect((await w.hook(signedPost(textEvent(message, p.phone, `${SENTINEL} tengo dolor`), RECEIVED))).status).toBe(200);
    await w.settle();
    expect(w.sends).toEqual([{ to: p.phone, body: expect.stringContaining("Recibimos tu mensaje") }]);
    expect(await run(message)).toMatchObject({ contact_key: p.key, send_state: "ACCEPTED", send_kind: "conversation", reply_kind: "conversation", reply_state: "ACCEPTED", processing_status: "COMPLETED" });
    expect(await turnOf(message)).toMatchObject({ contact_key: p.key, seq: 1, turn_kind: "TEXT" });
    expect(await phase(message)).toBe("SENT_ACCEPTED");
    // ninguna tabla de PlusMedik contiene el texto del paciente ni su teléfono
    const dump = await db.ok(`select string_agg(t, ' ') from (
      select to_json(x)::text t from public.plusmedik_audit_runs x union all select to_json(x)::text from public.plusmedik_audit_studies x union all
      select to_json(x)::text from public.plusmedik_audit_model_calls x union all select to_json(x)::text from public.plusmedik_audit_checks x union all
      select to_json(x)::text from public.plusmedik_attention_contacts x union all select to_json(x)::text from public.plusmedik_attention_events x union all
      select to_json(x)::text from public.plusmedik_turns x union all select to_json(x)::text from public.plusmedik_contact_turns x) all_rows`);
    expect(dump).not.toContain(SENTINEL);
    expect(dump).not.toContain(p.phone);
    expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(w.logs)).not.toContain(p.phone);
  });

  it("sin manejador de texto todo sigue como hoy: el texto no se reclama, no deja corrida ni turno y no se responde (y una imagen sí se procesa como turno)", async () => {
    const p = patient();
    const w = setup();
    const text = id("txt");
    expect((await w.hook(signedPost(textEvent(text, p.phone), RECEIVED))).status).toBe(200);
    expect(w.scheduled).toHaveLength(0);
    expect(await hasRun(text)).toBe("0");
    const image = id("img");
    await w.hook(signedPost(imageEvent(image, p.phone), RECEIVED));
    await w.settle();
    expect(w.sends).toHaveLength(1);
    expect(await turnOf(image)).toMatchObject({ seq: 1, turn_kind: "IMAGE" });
    expect(await phase(image)).toBe("SENT_ACCEPTED");
    expect(await run(image)).toMatchObject({ send_kind: "quoted" });
  });

  it("sin el modo turnos (comportamiento de antes) el texto se ignora y la imagen no deja turno", async () => {
    const p = patient();
    const w = setup({ quote: { turns: undefined, humanControl: { contactKeyFor } } });
    await w.hook(signedPost(textEvent(id("txt"), p.phone), RECEIVED));
    const image = id("img");
    await w.hook(signedPost(imageEvent(image, p.phone), RECEIVED));
    await w.settle();
    expect(w.sends).toHaveLength(1);
    expect(await turnOf(image)).toBeUndefined();
    expect(await run(image)).toMatchObject({ send_kind: "quoted" });
  });

  describe("sin duplicados", () => {
    it("el mismo mensaje entregado dos veces a la vez y una tercera después: el manejador corre una vez y el paciente recibe una sola respuesta", async () => {
      const p = patient();
      const handler = vi.fn(async () => ({ body: "hola" }));
      const w = setup({ handlers: { text: handler } });
      const message = id("txt");
      const [a, b] = await Promise.all([w.hook(signedPost(textEvent(message, p.phone), RECEIVED)), w.hook(signedPost(textEvent(message, p.phone), RECEIVED))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      await w.settle();
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(w.sends).toHaveLength(1);
      expect(await db.ok(`select count(*) from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id where r.kapso_message_id = '${message}'`)).toBe("1");
      expect(logsOf(w.logs, "duplicate_ignored").length).toBeGreaterThanOrEqual(1);
    });

    it("una ejecución que se cuelga y otra que reclama su lease vencido: responde la segunda, una sola vez; si la primera revive, ya no puede enviar", async () => {
      const p = patient();
      const hold = gate();
      let calls = 0;
      const handler = vi.fn(async () => {
        if (++calls === 1) await hold.hook();
        return { body: "respuesta" };
      });
      const w = setup({ handlers: { text: handler } });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await hold.arrived;
      await expire(message);
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await until(() => expect(w.sends).toHaveLength(1));
      expect(logsOf(w.logs, "lease_taken_over")).toEqual([{ fence: 2 }]);
      expect(await turnOf(message)).toMatchObject({ seq: 1 });
      hold.open();
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "lost" }]);
      expect(await phase(message)).toBe("SENT_ACCEPTED");
    });

    it("un envío con resultado incierto no se reintenta y no bloquea al contacto: el siguiente mensaje se responde", async () => {
      const p = patient();
      let attempts = 0;
      const w = setup({ handlers: reply(), quote: { sendText: vi.fn(async (to: string, body: string) => { if (++attempts === 1) throw new Error("red caída"); w.sends.push({ to, body }); return { providerMessageId: "wamid.ok" }; }) } });
      const first = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone), RECEIVED));
      await w.settle();
      expect(await phase(first)).toBe("SEND_UNKNOWN");
      const second = id("txt");
      await w.hook(signedPost(textEvent(second, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(await phase(second)).toBe("SENT_ACCEPTED");
      expect(await turnOf(second)).toMatchObject({ seq: 2 });
    });
  });

  describe("carreras entre turnos consecutivos", () => {
    it("RESPUESTA OBSOLETA: si el turno siguiente ya respondió, la respuesta del anterior (más lenta) se descarta y no llega después de la nueva", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ handlers: { text: async (turn: IncomingTurn) => { if (turn.text === "primero") await hold.hook(); return { body: `re:${turn.text}` }; } } });
      const first = id("txt");
      const second = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone, "primero"), RECEIVED));
      await hold.arrived;
      await w.hook(signedPost(textEvent(second, p.phone, "segundo"), RECEIVED));
      await until(() => expect(w.sends).toHaveLength(1));
      hold.open();
      await w.settle();
      expect(w.sends.map((s) => s.body)).toEqual(["re:segundo"]);
      expect(await run(first)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "SUPERSEDED", processing_status: "COMPLETED" });
      expect(await phase(first)).toBe("CLOSED_NO_SEND");
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "superseded" }]);
      expect(await phase(second)).toBe("SENT_ACCEPTED");
      expect([(await turnOf(first))!.seq, (await turnOf(second))!.seq]).toEqual([1, 2]);
    });

    it("una cotización (imagen) lenta NO se descarta aunque un texto posterior ya haya respondido: se envía después, completa y una sola vez", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ handlers: reply("ya te atendemos"), quote: { analyze: vi.fn(async () => { await hold.hook(); return okAnalysis(); }) } });
      const image = id("img");
      await w.hook(signedPost(imageEvent(image, p.phone), RECEIVED));
      await hold.arrived;
      const text = id("txt");
      await w.hook(signedPost(textEvent(text, p.phone), RECEIVED));
      await until(() => expect(w.sends).toHaveLength(1));
      expect(w.sends[0]!.body).toBe("ya te atendemos");
      hold.open();
      await w.settle();
      expect(w.sends).toHaveLength(2);
      expect(w.sends[1]!.body).toContain("Cotización de tu receta");
      expect(await run(image)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
      expect(await run(text)).toMatchObject({ send_kind: "conversation", send_state: "ACCEPTED" });
    });

    it("UN SOLO ENVÍO EN VUELO: dos respuestas listas a la vez para el mismo contacto nunca se solapan en Kapso; las dos se entregan, una tras otra", async () => {
      const p = patient();
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];
      const w = setup({
        handlers: { text: async (turn: IncomingTurn) => ({ body: turn.text!, stale: "NONE" }) },
        quote: {
          sendText: vi.fn(async (_to: string, body: string) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await sleep(150);
            order.push(body);
            active--;
            return { providerMessageId: `wamid.out-${body}` };
          })
        }
      });
      const messages = [id("txt"), id("txt"), id("txt")];
      await Promise.all(messages.map((message, index) => w.hook(signedPost(textEvent(message, p.phone, `m${index}`), RECEIVED))));
      await w.settle();
      expect(maxActive).toBe(1);
      expect(order.slice().sort()).toEqual(["m0", "m1", "m2"]);
      for (const message of messages) expect(await phase(message)).toBe("SENT_ACCEPTED");
      expect(logsOf(w.logs, "turn_busy").length).toBeGreaterThan(0);
    });

    it("contactos distintos no se esperan entre sí: sus envíos sí pueden ir a la vez", async () => {
      const a = patient();
      const b = patient();
      let active = 0;
      let maxActive = 0;
      // Punto de encuentro en vez de un tiempo fijo: cada envío espera a que el OTRO también haya empezado. Si los contactos se esperaran entre sí, el segundo nunca empezaría mientras el
      // primero espera y el tope (5 s) se agotaría con maxActive = 1. Así la prueba no depende de cuánto tarden en arrancar los procesos de la base bajo carga.
      let bothSending!: () => void;
      const meeting = new Promise<void>((resolve) => { bothSending = resolve; });
      const w = setup({
        handlers: reply(),
        quote: { sendText: vi.fn(async (to: string, body: string) => { active++; maxActive = Math.max(maxActive, active); if (active >= 2) bothSending(); await Promise.race([meeting, sleep(5000)]); active--; w.sends.push({ to, body }); }) }
      });
      await Promise.all([w.hook(signedPost(textEvent(id("txt"), a.phone), RECEIVED)), w.hook(signedPost(textEvent(id("txt"), b.phone), RECEIVED))]);
      await w.settle();
      expect(w.sends.map((s) => s.to).sort()).toEqual([a.phone, b.phone].sort());
      expect(maxActive).toBe(2);
    });

    it("un lote con varios mensajes desordenados se numera en el orden en que el paciente los escribió", async () => {
      const p = patient();
      const w = setup({ handlers: { text: async (turn: IncomingTurn) => ({ body: turn.text!, stale: "NONE" }) } });
      const [late, early, middle] = [id("txt"), id("txt"), id("txt")];
      const payload = { batch: true, data: [textEvent(late, p.phone, "tercero", 1), textEvent(early, p.phone, "primero", 30), textEvent(middle, p.phone, "segundo", 10)] };
      expect((await w.hook(signedPost(payload, { ...RECEIVED, "x-webhook-batch": "true" }))).status).toBe(200);
      await w.settle();
      expect(await Promise.all([early, middle, late].map(async (m) => (await turnOf(m))!.seq))).toEqual([1, 2, 3]);
      expect(w.sends.map((s) => s.body).sort()).toEqual(["primero", "segundo", "tercero"]);
    });

    it("un mensaje de otro tipo (audio) solo se procesa si hay manejador; con él es un turno más de la secuencia", async () => {
      const p = patient();
      const w = setup({ handlers: { other: async () => ({ body: "recibimos tu audio" }) } });
      const first = id("aud");
      const second = id("img");
      await w.hook(signedPost(audioEvent(first, p.phone), RECEIVED));
      // cada webhook solo PROGRAMA su trabajo: para fijar el orden de llegada a la base se espera a que el primero termine
      await w.settle();
      await w.hook(signedPost(imageEvent(second, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends.map((s) => s.body)).toEqual(expect.arrayContaining(["recibimos tu audio"]));
      expect(await turnOf(first)).toMatchObject({ seq: 1, turn_kind: "OTHER" });
      expect(await turnOf(second)).toMatchObject({ seq: 2, turn_kind: "IMAGE" });
    });

    it("un manejador que no responde nada cierra el turno sin respuesta: queda auditado como cerrado, sin envío", async () => {
      const p = patient();
      const w = setup({ handlers: { text: async () => undefined } });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(await run(message)).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "IGNORED", error_code: "NO_REPLY" });
      expect(await phase(message)).toBe("CLOSED_NO_SEND");
    });

    it("un manejador que falla: el paciente recibe el aviso técnico (sin el error), la corrida queda FAILED y el texto del error no se registra", async () => {
      const p = patient();
      const w = setup({ handlers: { text: async () => { throw new Error(`falla ${SENTINEL}`); } } });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).not.toContain(SENTINEL);
      expect(await run(message)).toMatchObject({ processing_status: "FAILED", error_code: "UNEXPECTED_PROCESSING_FAILED", send_kind: "technical_issue", send_state: "ACCEPTED" });
      expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
    });
  });

  describe("pausa humana", () => {
    it("pausa ANTES del mensaje: no se reclama, no hay corrida ni turno, el manejador no corre y no se responde", async () => {
      const p = patient();
      const handler = vi.fn(async () => ({ body: "x" }));
      const w = setup({ handlers: { text: handler } });
      await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT));
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(handler).not.toHaveBeenCalled();
      expect(w.sends).toEqual([]);
      expect(await hasRun(message)).toBe("0");
      expect(logsOf(w.logs, "duplicate_ignored")).toEqual([{ processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" }]);
    });

    it("pausa DURANTE el trabajo del manejador: la respuesta se bloquea y no se envía", async () => {
      const p = patient();
      const hold = gate();
      const w = setup({ handlers: { text: async () => { await hold.hook(); return { body: "tarde" }; } } });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await hold.arrived;
      expect((await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT))).status).toBe(200);
      hold.open();
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "blocked" }]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
    });

    it("pausa ENTRE la reserva y el envío: la comprobación final libera la reserva y no se envía", async () => {
      const p = patient();
      let paused = false;
      const w = setup({
        handlers: reply(),
        audit: (real) => withFaults(real, { confirmSend: { before: async () => { if (!paused) { paused = true; await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT)); } } } })
      });
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "blocked" }]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED" });
    });

    it("tras una pausa y su reactivación la secuencia continúa sin huecos: los mensajes durante la pausa no consumen número", async () => {
      const p = patient();
      const w = setup({ handlers: reply(), busyDelayMs: 20 });
      const first = id("txt");
      await w.hook(signedPost(textEvent(first, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT));
      await w.hook(signedPost(textEvent(id("txt"), p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(await createAttentionRepository(rpcOptions()).resume(p.key, "MANUAL_RESUME", "ops_user")).toBe("RESUMED");
      const third = id("txt");
      await w.hook(signedPost(textEvent(third, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(2);
      expect(await turnOf(third)).toMatchObject({ seq: 2 });
    });
  });

  describe("fallo cerrado", () => {
    it("si la base no responde al reclamar, el modo turnos no responde a nadie (aunque requireAuditGuard no esté definido)", async () => {
      const p = patient();
      const handler = vi.fn(async () => ({ body: "x" }));
      const w = setup({ handlers: { text: handler } });
      network.downFor.add("plusmedik_turn_claim");
      try {
        await w.hook(signedPost(textEvent(id("txt"), p.phone), RECEIVED));
        await w.settle();
      } finally {
        network.downFor.delete("plusmedik_turn_claim");
      }
      expect(handler).not.toHaveBeenCalled();
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "audit_guard_unavailable" }]);
    });

    it("si la base cae al reservar, no se envía; el turno queda recuperable y no consume el envío del contacto", async () => {
      const p = patient();
      const w = setup({ handlers: reply() });
      network.downFor.add("plusmedik_turn_reserve_send");
      const first = id("txt");
      try {
        await w.hook(signedPost(textEvent(first, p.phone), RECEIVED));
        await w.settle();
      } finally {
        network.downFor.delete("plusmedik_turn_reserve_send");
      }
      expect(w.sends).toEqual([]);
      expect(await phase(first)).toBe("RECOVERABLE");
      const second = id("txt");
      await w.hook(signedPost(textEvent(second, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(await phase(second)).toBe("SENT_ACCEPTED");
    });

    it("una ejecución que se cae a mitad de trabajo (promesa que nunca termina) no impide que el contacto sea atendido por los mensajes siguientes", async () => {
      const p = patient();
      let calls = 0;
      const w = setup({ handlers: { text: async () => { if (++calls === 1) return forever(); return { body: "ok" }; } } });
      await w.hook(signedPost(textEvent(id("txt"), p.phone, "uno"), RECEIVED));
      // el primer mensaje ya está en el manejador (el que se cuelga) antes de que llegue el segundo: se espera ese hecho, no 100 ms
      await until(() => expect(calls).toBe(1));
      const second = id("txt");
      await w.hook(signedPost(textEvent(second, p.phone, "dos"), RECEIVED));
      await until(() => expect(w.sends).toHaveLength(1));
      // el envío ya salió, pero el resultado se asienta un instante después: se espera ese ESTADO, no solo el envío
      await until(async () => expect(await phase(second)).toBe("SENT_ACCEPTED"));
    });
  });
});
