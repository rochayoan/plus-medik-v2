import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { createSupabaseAuditRepository } from "../src/audit.js";
import { createCrmAttentionRepository, handleCrmAttention, type CrmControlConfig } from "../src/crm-attention.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Fase 1 de la integración con el CRM de extremo a extremo: las rutas REALES de atención (status/action) + el webhook REAL de Kapso + el manejador de texto REAL + PostgreSQL REAL con las 15 migraciones.
// Se comprueba que una pausa pedida por el CRM silencia de verdad al agente (texto y fotos, también a mitad de un procesamiento), que la reactivación lo devuelve a la vida y que repetir una operación
// no cambia nada. Solo se simulan Kapso (contador de envíos), el catálogo y el motor de recetas. Ninguna prueba toca el CRM, Supabase real, Kapso ni un modelo.

const bin = findPostgresBin();
if (!bin) console.warn("[crm-attention-e2e] PostgreSQL no disponible: se omiten los escenarios de la pausa manual del CRM contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const TOKEN = "token-de-prueba-solo-para-tests-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_5521";
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const now = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: now(), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "image", from: phone, image: { id: "media-1" }, kapso: { ...inbound, has_media: true, media_url: "https://example.test/img.jpg" } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);

describe.skipIf(!bin)("control de atención desde el CRM, de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("crm_attention_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => `5917${String(++counter).padStart(7, "0")}`;

  function setup(options: { gate?: Promise<void>; controlReady?: boolean; configured?: boolean } = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => {
        await options.gate;
        return okAnalysis();
      }),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor, busyDelayMs: 20, busyRetries: 100, handlers: { text: createTextHandler({ log }) } }
    };
    const webhook: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    const config: CrmControlConfig | undefined = options.configured === false ? undefined : { token: TOKEN, labPhoneNumberId: LAB, hmacKey: HMAC_KEY, controlReady: options.controlReady ?? true };
    const crm = { config, repository: () => createCrmAttentionRepository(rpcOptions()), log };
    const endpoint = async (route: "status" | "action", body: Record<string, unknown>, token: string | null = TOKEN) => {
      const response = await handleCrmAttention(
        new Request(`https://agente.example.test/api/internal/crm/attention/${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }),
        route, crm
      );
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    return { sends, logs, scheduled, quote, hook: (request: Request) => handleKapsoWebhook(request, webhook), settle: () => Promise.all(scheduled), endpoint };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, phone: string, body: string) => {
    const message = id("txt");
    await send(w, textEvent(message, phone, body));
    return message;
  };
  const last = (w: World) => w.sends.at(-1)!.body;
  const statusOf = (w: World, phone: string) => w.endpoint("status", { contactPhone: phone, phoneNumberId: LAB });
  const actionOf = (w: World, phone: string, action: "pause" | "resume", operationId: string, actor = "crm:system") =>
    w.endpoint("action", { operationId, action, contactPhone: phone, phoneNumberId: LAB, reasonCode: action === "pause" ? "CRM_MANUAL_PAUSE" : "CRM_MANUAL_RESUME", actor });
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const events = (phone: string) => db.ok(`select coalesce(string_agg(kind || ':' || outcome, ',' order by received_at, id), '') from public.plusmedik_attention_events where contact_key = '${contactKeyFor(phone)}'`);
  const op = () => `op-${String(++counter).padStart(6, "0")}-${Date.now()}`;

  it("ciclo completo: el agente responde → el CRM pausa → el agente calla → el CRM reactiva → el agente responde", async () => {
    const w = setup();
    const phone = patient();
    expect(await statusOf(w, phone)).toEqual({ status: 200, body: { ok: true, available: true, state: "ACTIVE", revision: 0 } });

    await say(w, phone, "quiero cotizar mis estudios");
    expect(w.sends).toHaveLength(1);

    const paused = await actionOf(w, phone, "pause", op(), "crm:3f2a9c");
    expect(paused).toMatchObject({ status: 200, body: { ok: true, confirmed: true, state: "HUMAN_PAUSED", revision: 2, outcome: "PAUSED", replayed: false } });
    expect(await statusOf(w, phone)).toEqual({ status: 200, body: { ok: true, available: true, state: "HUMAN_PAUSED", revision: 2 } });

    // el paciente sigue escribiendo mientras la persona atiende: el agente NO responde (ni a texto ni a fotos)
    const silent = await say(w, phone, "quiero cotizar mis estudios por favor");
    await send(w, imageEvent(id("img"), phone));
    expect(w.sends).toHaveLength(1);
    expect(w.quote.analyze).not.toHaveBeenCalled();
    // ni siquiera se reclamó un procesamiento: no hay corrida con envío para ese mensaje
    expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${silent}' and send_state <> 'NOT_RESERVED'`)).toBe("0");

    const resumed = await actionOf(w, phone, "resume", op());
    expect(resumed).toMatchObject({ status: 200, body: { confirmed: true, state: "ACTIVE", revision: 3, outcome: "RESUMED" } });
    await say(w, phone, "quiero cotizar mis estudios otra vez");
    expect(w.sends).toHaveLength(2);
    expect(last(w)).toBe(DRAFT_TEXTS.send_recipe);
    expect(await events(phone)).toMatch(/^CRM_MANUAL_PAUSE:PAUSED,.*PATIENT_SUPPRESSED:SUPPRESSED.*CRM_MANUAL_RESUME:RESUMED$/s);
  });

  it("idempotencia por la ruta real: repetir la misma operación devuelve lo ya confirmado y NO agrega un evento", async () => {
    const w = setup();
    const phone = patient();
    const operation = op();
    const first = await actionOf(w, phone, "pause", operation);
    const again = await actionOf(w, phone, "pause", operation);
    expect(first.body).toMatchObject({ confirmed: true, state: "HUMAN_PAUSED", revision: 2, replayed: false });
    expect(again.body).toMatchObject({ confirmed: true, state: "HUMAN_PAUSED", revision: 2, replayed: true });
    expect(await events(phone)).toBe("CRM_MANUAL_PAUSE:PAUSED");
    // reactivar un contacto que ya está ACTIVE confirma ACTIVE (lo que el CRM espera de la reactivación automática repetida)
    const resumeOp = op();
    await actionOf(w, phone, "resume", resumeOp);
    expect((await actionOf(w, phone, "resume", op())).body).toMatchObject({ confirmed: true, state: "ACTIVE", outcome: "ALREADY_ACTIVE" });
    expect((await actionOf(w, phone, "resume", resumeOp)).body).toMatchObject({ confirmed: true, state: "ACTIVE", replayed: true });
  });

  it("un operationId reutilizado para otra acción es un conflicto 409 sin confirmar, y el estado no cambia", async () => {
    const w = setup();
    const phone = patient();
    const operation = op();
    await actionOf(w, phone, "pause", operation);
    const clash = await actionOf(w, phone, "resume", operation);
    expect(clash).toEqual({ status: 409, body: { ok: false, confirmed: false, error: "operation_conflict" } });
    expect((await statusOf(w, phone)).body).toMatchObject({ state: "HUMAN_PAUSED", revision: 2 });
  });

  it("pausa A MITAD de un procesamiento: la respuesta ya calculada NO se envía (la reserva de envío se bloquea)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const w = setup({ gate });
    const phone = patient();
    const message = id("img");
    const hook = w.hook(signedPost(imageEvent(message, phone), RECEIVED));
    expect((await hook).status).toBe(200);
    // espera a que el análisis esté en curso, pausa desde el CRM y recién entonces suelta el análisis
    for (let i = 0; i < 200 && !(w.quote.analyze as ReturnType<typeof vi.fn>).mock.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(w.quote.analyze).toHaveBeenCalledTimes(1);
    const paused = await actionOf(w, phone, "pause", op());
    expect(paused.body).toMatchObject({ confirmed: true, state: "HUMAN_PAUSED" });
    release();
    await w.settle();
    expect(w.sends).toEqual([]);
    expect(w.logs).toContainEqual(["reply_withheld", { reason: "blocked" }]);
    expect(await run(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
  });

  it("coexiste con la pausa por un mensaje humano real de WhatsApp Business: ambas pausan y el CRM puede reactivar", async () => {
    const w = setup();
    const phone = patient();
    await send(w, humanEvent(id("human"), phone), SENT);
    expect((await statusOf(w, phone)).body).toMatchObject({ state: "HUMAN_PAUSED", revision: 2 });
    expect((await actionOf(w, phone, "pause", op())).body).toMatchObject({ confirmed: true, outcome: "ALREADY_PAUSED", revision: 2 });
    expect((await actionOf(w, phone, "resume", op())).body).toMatchObject({ confirmed: true, state: "ACTIVE", outcome: "RESUMED" });
    await say(w, phone, "quiero cotizar mis estudios");
    expect(w.sends).toHaveLength(1);
  });

  it("token equivocado o ausente: 401 y el estado del contacto NO cambia; el agente sigue respondiendo", async () => {
    const w = setup();
    const phone = patient();
    for (const token of ["otro-token-de-prueba-0123456789-abcdefgh", null]) {
      expect((await w.endpoint("action", { operationId: op(), action: "pause", contactPhone: phone, phoneNumberId: LAB, reasonCode: "CRM_MANUAL_PAUSE", actor: "crm:system" }, token)).status).toBe(401);
    }
    expect(await events(phone)).toBe("");
    await say(w, phone, "quiero cotizar mis estudios");
    expect(w.sends).toHaveLength(1);
  });

  it("phoneNumberId de otro número: 403 y no se escribe nada en la base", async () => {
    const w = setup();
    const phone = patient();
    const out = await w.endpoint("action", { operationId: op(), action: "pause", contactPhone: phone, phoneNumberId: "999999999999999", reasonCode: "CRM_MANUAL_PAUSE", actor: "crm:system" });
    expect(out.status).toBe(403);
    expect(await events(phone)).toBe("");
  });

  it("apagado por defecto (sin configuración): 503 y la base ni se consulta; con el control humano apagado: available:false y no se muta", async () => {
    const off = setup({ configured: false });
    const phone = patient();
    expect(await statusOf(off, phone)).toMatchObject({ status: 503 });
    expect(await actionOf(off, phone, "pause", op())).toMatchObject({ status: 503 });
    expect(await events(phone)).toBe("");

    const notReady = setup({ controlReady: false });
    expect(await statusOf(notReady, phone)).toEqual({ status: 200, body: { ok: true, available: false, reason: "control_disabled" } });
    expect(await actionOf(notReady, phone, "pause", op())).toMatchObject({ status: 200, body: { confirmed: false, available: false } });
    expect(await events(phone)).toBe("");
    await say(notReady, phone, "quiero cotizar mis estudios");
    expect(notReady.sends).toHaveLength(1);
  });

  it("contactos distintos no se afectan: pausar a uno no silencia a otro", async () => {
    const w = setup();
    const [a, b] = [patient(), patient()];
    await actionOf(w, a, "pause", op());
    await say(w, a, "quiero cotizar mis estudios");
    await say(w, b, "quiero cotizar mis estudios");
    expect(w.sends.map((s) => s.to)).toEqual([b]);
    expect((await statusOf(w, b)).body).toMatchObject({ state: "ACTIVE" });
  });

  it("nada sensible en el registro: ni teléfonos, ni contact_key, ni token, ni operationId", async () => {
    const w = setup();
    const phone = patient();
    const operation = op();
    await actionOf(w, phone, "pause", operation, "crm:3f2a9c");
    await statusOf(w, phone);
    const text = JSON.stringify(w.logs.filter(([event]) => event === "crm_attention"));
    for (const secret of [phone, contactKeyFor(phone)!, TOKEN, operation, HMAC_KEY, "crm:3f2a9c"]) expect(text).not.toContain(secret);
    expect(text).toContain("PAUSED");
  });
});
