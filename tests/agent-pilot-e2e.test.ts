import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModel, PlanInput, PlanOutput, RespondInput } from "../src/agent/contracts.js";
import { createAgentPilot, createPilotSwitch, createRecentProvider, type AgentPilot } from "../src/agent/pilot.js";
import { createReplyGate, createRepeatTracker, type AttentionConfig } from "../src/attention-filter.js";
import { createSupabaseAuditRepository, createSupabaseRpc } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createConversationReader, createSupabaseConversationStore, resolveConversationState, type ConversationRecorder } from "../src/conversation-state-store.js";
import { pending } from "../src/conversation-state.js";
import type { CrmHandoff } from "../src/crm-outbox/types.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { createMessageHistory, createSupabaseHistoryStore } from "../src/message-history.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { fixtureAnswer } from "../scripts/g7/lib/agent-scenarios.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// PILOTO del nuevo agente de extremo a extremo: webhook REAL + turnos REALES + manejador de texto REAL + repositorios REALES + PostgreSQL REAL con TODAS las migraciones (incluida la 25, el interruptor).
// Solo se simulan Kapso (envíos), OpenAI (el modelo del agente es un doble), el catálogo, el motor de recetas y la cola al CRM. Lo central: el piloto responde SOLO al número permitido y SOLO con el interruptor
// encendido; todos los demás contactos reciben EXACTAMENTE lo de siempre; y la respuesta del piloto sale por la misma máquina de envío (un solo envío por lote, idempotencia, pausa humana, tope).

const bin = findPostgresBin();
if (!bin) console.warn("[agent-pilot-e2e] PostgreSQL no disponible: se omiten los escenarios del piloto contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_7741";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null } as CatalogStudy);
const CATALOG = (): CatalogStudy[] => [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(4, "TSH", ["tsh"], 80)];
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", quote: { lines: [{ id: uuid(1), code: null, name: "HEMOGRAMA COMPLETO", priceBs: 45 }], totalBs: 45, tariff: "PACIENTE" }, publicQuote: { studies: [{ name: "HEMOGRAMA COMPLETO", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as unknown as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: { ...inbound } }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: nowSeconds(), type: "image", from: phone, image: { id: tag, caption: "mi receta" }, kapso: { ...inbound, has_media: true, media_url: `https://example.test/${tag}.jpg` } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string, body = "Hola, le atiende recepción") => ({ message: { id, timestamp: nowSeconds(), type: "text", to: phone, text: { body }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

interface Script { calls?: Array<{ tool: string; input: unknown }>; plan?: Partial<PlanOutput>; text?: string; fail?: Error; hang?: boolean }
function fakeAgentModel(script: Script = {}): AgentModel & { plans: PlanInput[]; responds: RespondInput[] } {
  const model = {
    plans: [] as PlanInput[],
    responds: [] as RespondInput[],
    async plan(input: PlanInput) { model.plans.push(input); if (script.hang) return new Promise<never>(() => undefined); if (script.fail) throw script.fail; return { toolCalls: script.calls ?? [], ...script.plan }; },
    async respond(input: RespondInput) { model.responds.push(input); return { text: script.text ?? "¡Hola! ¿En qué te puedo ayudar?" }; }
  };
  return model;
}

describe.skipIf(!bin)("piloto del nuevo agente de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("agent_pilot_flow");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });
  // Cada escenario parte con el interruptor APAGADO (su estado inicial real).
  beforeEach(async () => { await db.ok(`select public.plusmedik_agent_pilot_set(false, 'inicio de cada escenario de prueba');`); });

  const switchTo = (on: boolean) => db.ok(`select public.plusmedik_agent_pilot_set(${on}, 'cambio hecho por la prueba');`);
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  interface Options {
    // phones = piloto (lista); everyone = alcance global (todos los contactos elegibles menos los excluidos).
    pilot?: { phones?: string[]; everyone?: { exclude?: string[] }; model: AgentModel; handoffEnabled?: boolean; deadlineMs?: number };
    // Memoria de la fase 1 (la exige el piloto en producción; también el mundo de referencia la usa para comparar lo mismo).
    memory?: boolean;
    cap?: { max: number; windowSeconds: number };
    crm?: CrmHandoff;
    sessions?: boolean;
  }
  function setup(options: Options = {}) {
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const history = createMessageHistory({ store: createSupabaseHistoryStore({ rpc: createSupabaseRpc(rpcOptions()) }), accountId: LAB, contactKeyFor, log });
    const store = createSupabaseConversationStore({ rpc: createSupabaseRpc(rpcOptions()) });
    const memory = options.memory ?? Boolean(options.pilot);
    const convState: ConversationRecorder | undefined = memory ? resolveConversationState({ PLUSMEDIK_LLM_CONVERSATION: "on" }, log, { contactKeyFor, store }) : undefined;
    const pilot: AgentPilot | undefined = options.pilot
      ? createAgentPilot({
          model: options.pilot.model, modelName: "modelo-x",
          ...(options.pilot.phones ? { phones: new Set(options.pilot.phones) } : {}),
          ...(options.pilot.everyone ? { everyone: { exclude: new Set(options.pilot.everyone.exclude ?? []), contactKeyFor } } : {}),
          switch: createPilotSwitch({ rpc: createSupabaseRpc(rpcOptions()), ttlMs: 0, log }),
          handoffEnabled: options.pilot.handoffEnabled ?? false,
          // piloto: tope propio de 40 por omisión; global: solo si se indica (si no, rige el tope global de siempre)
          ...(options.pilot.deadlineMs ? { deadlineMs: options.pilot.deadlineMs } : {}),
          context: { loadCatalog: async () => CATALOG(), answer: fixtureAnswer, ...(memory ? { reader: createConversationReader({ store }) } : {}), contactKeyFor, recent: createRecentProvider({ rpc: createSupabaseRpc(rpcOptions()) }), capabilities: { handoff: false, quote: true } },
          log
        })
      : undefined;
    const attention: AttentionConfig = { repeats: createRepeatTracker({ windowMs: 90_000 }), gate: createReplyGate(), settleMs: 0 };
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => CATALOG()),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}-${++counter}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000, history,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400, attention, ...(convState ? { convState } : {}), ...(pilot ? { agentPilot: pilot } : {}), ...(options.cap ? { dailyCap: options.cap } : {}), ...(options.crm ? { crmHandoff: options.crm } : {}),
        handlers: { text: createTextHandler({ log, attention: true }) }, ignorePayment: true,
        ...(options.sessions !== false ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, attention: { gate: attention.gate, settleMs: attention.settleMs }, ownTexts: Object.values(DRAFT_TEXTS) }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, history, ...(convState ? { convState } : {}), humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, network, store, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers: Record<string, string> = RECEIVED) => {
    const response = await w.hook(signedPost(event, headers));
    expect(response.status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    await send(w, textEvent(message, phone, body));
    return message;
  };
  const runStatuses = (phone: string) => db.ok(`select coalesce(string_agg(processing_status || ':' || coalesce(error_code, '-'), ',' order by created_at), '') from public.plusmedik_audit_runs where contact_key = '${contactKeyFor(phone)}'`);
  const historyShape = (key: string) => db.ok(`select coalesce(string_agg(direction || '/' || actor || '/' || content_kind || '/' || delivery_state, ',' order by seq), '') from public.plusmedik_message_history where contact_key = '${key}'`);
  const eventKinds = async (key: string): Promise<string[]> => JSON.parse(await db.ok(`select coalesce(json_agg(kind order by seq), '[]') from public.plusmedik_conv_events where contact_key = '${key}'`));
  const stateOf = (w: World, key: string) => createConversationReader({ store: w.store }).stateOf(key);
  const pilotLogs = (w: World) => w.logs.filter(([event]) => event === "agent_pilot").map(([, data]) => data);
  const called = (w: World, name: string) => w.network.calls.filter((call) => call === name).length;

  // ───────────────────────────── aislamiento por número ─────────────────────────────

  describe("los demás contactos no notan nada", () => {
    const SCRIPT = ["hola", "quiero cotizar mis estudios", "cotiza hemograma y glucosa", "a que hora abren", "me duele el pecho", "gracias"];

    it("con el piloto ENCENDIDO para otro número: mismos envíos, corridas de auditoría, historial y llamadas a la base; ni una consulta del interruptor ni del historial reciente; el modelo no se toca", async () => {
      const pilotPhone = patient().phone;
      const run = async (withPilot: boolean) => {
        const p = patient();
        const model = fakeAgentModel();
        const w = setup({ memory: true, ...(withPilot ? { pilot: { phones: [pilotPhone], model } } : {}) });
        if (withPilot) await switchTo(true);
        for (const body of SCRIPT) await say(w, p.phone, body);
        await send(w, imageEvent(id("img"), p.phone, "IMG1"));
        await send(w, humanEvent(id("human"), p.phone), SENT);
        await say(w, p.phone, "cotiza tsh por favor");
        return { p, w, model, sends: w.sends.map((s) => s.body), statuses: await runStatuses(p.phone), history: await historyShape(p.key) };
      };
      const reference = await run(false);
      const piloted = await run(true);
      expect(piloted.sends).toEqual(reference.sends);
      expect(piloted.sends.length).toBeGreaterThanOrEqual(3);
      expect(piloted.statuses).toBe(reference.statuses);
      expect(piloted.history).toBe(reference.history);
      expect(piloted.w.network.calls.slice().sort()).toEqual(reference.w.network.calls.slice().sort());
      expect(called(piloted.w, "plusmedik_agent_pilot_state")).toBe(0);
      expect(called(piloted.w, "plusmedik_history_recent")).toBe(0);
      expect(piloted.model.plans).toEqual([]);
      const names = (w: World) => new Set(w.logs.map(([event]) => event));
      expect([...names(piloted.w)].filter((name) => !names(reference.w).has(name))).toEqual([]);
    });
  });

  // ───────────────────────────── el piloto responde ─────────────────────────────

  describe("el número del piloto, con el interruptor encendido", () => {
    it("responde el agente nuevo por la ruta de envío de siempre: una sola respuesta, cotización con precios del catálogo, historial y memoria", async () => {
      const p = patient();
      const model = fakeAgentModel({
        calls: [{ tool: "lab_info", input: { question: "a que hora abren" } }, { tool: "quote_studies", input: { studies: ["hemograma", "glucosa"] } }],
        text: "¡Hola! Atendemos de lunes a viernes de 07:00 a 18:00 y los sábados de 08:00 a 12:00. Abajo tienes el detalle de tu cotización."
      });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      const first = id("a");
      const second = id("b");
      await send(w, { type: "whatsapp.message.received", batch: true, data: [textEvent(first, p.phone, "a que hora abren?"), textEvent(second, p.phone, "cuanto cuesta un hemograma y una glucosa?")] }, { ...RECEIVED, "x-webhook-batch": "true" });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.to).toBe(p.phone);
      expect(w.sends[0]!.body).toMatch(/^¡Hola! Atendemos de lunes a viernes de 07:00 a 18:00/);
      expect(w.sends[0]!.body).toMatch(/HEMOGRAMA COMPLETO[\s\S]*GLUCOSA EN AYUNAS[\s\S]*75[.,]5/);
      expect(model.plans).toHaveLength(1);
      expect(model.plans[0]!.utterances.map((u) => u.topic)).toEqual(["INFO_REQUEST", "RECIPE_OR_QUOTE"]);
      expect(JSON.stringify(model.responds)).not.toMatch(/\b45\b|30[.,]5|Bs/);
      expect(await historyShape(p.key)).toBe("IN/PATIENT/TEXT/RECEIVED,IN/PATIENT/TEXT/RECEIVED,OUT/AGENT/TEXT/ACCEPTED");
      // la corrida de auditoría del lote responde; la otra queda cerrada sin respuesta
      expect((await runStatuses(p.phone)).split(",").length).toBe(2);
      expect(await runStatuses(p.phone)).not.toMatch(/FAILED/);
      expect(pilotLogs(w).at(-1)).toMatchObject({ status: "VERIFIED", withQuote: true });
      // memoria: la respuesta quedó como cotizada y la cotización como artefacto (por ids de estudios)
      await w.settle();
      const state = (await stateOf(w, p.key))!;
      expect(state.artifacts.map((a) => `${a.kind}:${a.studyIds.length}`)).toEqual(["QUOTE:2"]);
      expect(pending(state, Date.now())).toEqual([]);
    });

    it("SILENCIO ante lo claramente ajeno al laboratorio: no se envía nada, no queda pendiente y el siguiente mensaje normal se atiende", async () => {
      const p = patient();
      const model = fakeAgentModel({ plan: { silent: true }, text: "RESPUESTA DEL AGENTE NUEVO" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, "jajaja mira el partido de anoche");
      expect(w.sends).toEqual([]);
      expect(model.responds).toEqual([]);
      expect(pilotLogs(w).at(-1)).toMatchObject({ status: "SILENT" });
      expect(await historyShape(p.key)).toBe("IN/PATIENT/TEXT/RECEIVED");
      await w.settle();
      const state = await stateOf(w, p.key);
      expect(state ? pending(state, Date.now()) : []).toEqual([]);
      // con una pregunta del laboratorio el modelo ya no la lee como ajena y sí se responde
      const lab = fakeAgentModel({ text: "Atendemos de lunes a viernes." });
      const w2 = setup({ pilot: { phones: [p.phone], model: lab } });
      await say(w2, p.phone, "a que hora abren?");
      expect(w2.sends).toHaveLength(1);
    });

    it("MÉTODOS DE PAGO IGNORADOS en un lote: «hola», «quiero cotizar…» y «voy a pagar por QR» → se cotiza y del QR no se dice nada; el modelo ni siquiera recibe el mensaje de pago", async () => {
      const p = patient();
      const model = fakeAgentModel({
        calls: [{ tool: "quote_studies", input: { studies: ["hemograma", "glucosa"] } }],
        text: "¡Hola! Abajo tienes el detalle de tu cotización. Y sí, puedes pagar con QR."
      });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await send(w, { type: "whatsapp.message.received", batch: true, data: [textEvent(id("a"), p.phone, "hola"), textEvent(id("b"), p.phone, "quiero cotizar hemograma y glucosa"), textEvent(id("c"), p.phone, "voy a pagar por QR")] }, { ...RECEIVED, "x-webhook-batch": "true" });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toMatch(/HEMOGRAMA COMPLETO[\s\S]*GLUCOSA EN AYUNAS[\s\S]*75[.,]5/);
      expect(w.sends[0]!.body).not.toMatch(/qr|pagar|pago/i);
      expect(model.plans[0]!.utterances.map((u) => u.text)).toEqual(["hola", "quiero cotizar hemograma y glucosa"]);
      expect(JSON.stringify(model.plans) + JSON.stringify(model.responds)).not.toMatch(/qr|pagar/i);
    });

    it("MÉTODOS DE PAGO IGNORADOS con el agente de siempre: el mismo lote con y sin el mensaje de pago recibe exactamente la misma respuesta", async () => {
      const withPay = patient();
      const without = patient();
      const a = setup({ memory: true });
      const b = setup({ memory: true });
      await send(a, { type: "whatsapp.message.received", batch: true, data: [textEvent(id("a"), withPay.phone, "hola"), textEvent(id("b"), withPay.phone, "quiero cotizar hemograma"), textEvent(id("c"), withPay.phone, "voy a pagar por QR")] }, { ...RECEIVED, "x-webhook-batch": "true" });
      await send(b, { type: "whatsapp.message.received", batch: true, data: [textEvent(id("a"), without.phone, "hola"), textEvent(id("b"), without.phone, "quiero cotizar hemograma")] }, { ...RECEIVED, "x-webhook-batch": "true" });
      expect(a.sends.map((s) => s.body)).toEqual(b.sends.map((s) => s.body));
      expect(a.sends.length).toBeGreaterThan(0);
      expect(a.sends.map((s) => s.body).join(" ")).not.toMatch(/qr|pagar/i);
    });

    it("MÉTODOS DE PAGO IGNORADOS: una pregunta solo de pagos no recibe respuesta de nadie (ni el agente nuevo ni el de siempre), con el interruptor encendido o apagado, y no queda pendiente", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "RESPUESTA DEL AGENTE NUEVO" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await say(w, p.phone, "se puede pagar con qr?");
      await switchTo(true);
      await say(w, p.phone, "aceptan tarjeta?");
      expect(w.sends).toEqual([]);
      expect(model.plans).toEqual([]);
      await w.settle();
      const state = await stateOf(w, p.key);
      expect(state ? pending(state, Date.now()) : []).toEqual([]);
      // después, una pregunta normal sí se atiende
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends).toHaveLength(1);
    });

    it("el interruptor de la base manda: apagado, el MISMO número recibe lo de siempre y el modelo no se toca", async () => {
      const reference = patient();
      const refWorld = setup({ memory: true });
      await say(refWorld, reference.phone, "quiero cotizar mis estudios");
      const p = patient();
      const model = fakeAgentModel({ text: "RESPUESTA DEL AGENTE NUEVO" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).toEqual(refWorld.sends.map((s) => s.body));
      expect(model.plans).toEqual([]);
      expect(called(w, "plusmedik_agent_pilot_state")).toBe(1);
      expect(pilotLogs(w)).toEqual([{ status: "FALLBACK", reason: "SWITCH_OFF" }]);
    });

    it("DESACTIVACIÓN INMEDIATA: se apaga desde la base y el siguiente mensaje ya lo atiende el agente de siempre, sin redesplegar", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "Respuesta del agente nuevo. ¿Algo más?" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, "hola buenas, tengo una consulta");
      expect(w.sends.at(-1)!.body).toBe("Respuesta del agente nuevo. ¿Algo más?");
      await switchTo(false);
      const before = model.plans.length;
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(model.plans).toHaveLength(before);
      expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.send_recipe);
      await switchTo(true);
      await say(w, p.phone, "y a que hora abren?");
      expect(model.plans).toHaveLength(before + 1);
    });

    it("FALLA CERRADO: si la base no responde al leer el interruptor, atiende el agente de siempre", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "NO DEBE SALIR" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      w.network.downFor.add("plusmedik_agent_pilot_state");
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.send_recipe]);
      expect(model.plans).toEqual([]);
      expect(w.logs.some(([event, data]) => event === "agent_pilot_switch" && data.unreadable === true)).toBe(true);
    });
  });

  // ───────────────────────────── garantías de la máquina de envío ─────────────────────────────

  describe("conserva idempotencia, un solo envío por lote, pausa humana y tope", () => {
    it("el mismo webhook entregado tres veces: una sola respuesta y una sola decisión", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      const event = textEvent(id("txt"), p.phone, "hola, quiero una cotización");
      await send(w, event);
      await send(w, event);
      await send(w, event);
      expect(w.sends).toHaveLength(1);
      expect(model.plans).toHaveLength(1);
    });

    it("entregas SIMULTÁNEAS del mismo lote: una sola respuesta", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      const batch = { type: "whatsapp.message.received", batch: true, data: [textEvent(id("a"), p.phone, "hola"), textEvent(id("b"), p.phone, "quiero cotizar"), textEvent(id("c"), p.phone, "a que hora abren")] };
      await Promise.all([1, 2, 3].map(() => w.hook(signedPost(batch, { ...RECEIVED, "x-webhook-batch": "true" }))));
      await w.settle();
      expect(w.sends).toHaveLength(1);
    });

    it("un lote de tres mensajes: UNA respuesta del agente, con una petición por mensaje", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "¡Hola! Con gusto te ayudo con eso." });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await send(w, { type: "whatsapp.message.received", batch: true, data: [textEvent(id("a"), p.phone, "hola"), textEvent(id("b"), p.phone, "cotiza hemograma"), textEvent(id("c"), p.phone, "a que hora abren")] }, { ...RECEIVED, "x-webhook-batch": "true" });
      expect(w.sends.map((s) => s.body)).toEqual(["¡Hola! Con gusto te ayudo con eso."]);
      expect(model.plans[0]!.utterances.map((u) => u.topic)).toEqual(["SOCIAL", "RECIPE_OR_QUOTE", "INFO_REQUEST"]);
    });

    it("PAUSA HUMANA: tras escribir la recepción, el agente nuevo no responde ni se consulta al modelo", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, "hola, quiero una cotización");
      await send(w, humanEvent(id("human"), p.phone, `Hola, le atendemos ${SENTINEL}`), SENT);
      const before = { sends: w.sends.length, plans: model.plans.length };
      await say(w, p.phone, "cotiza hemograma por favor");
      expect(w.sends).toHaveLength(before.sends);
      expect(model.plans).toHaveLength(before.plans);
    });

    it("las fotos siguen por el motor de recetas de siempre: un lote con una imagen no pasa por el agente nuevo", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "NO DEBE SALIR" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await send(w, imageEvent(id("img"), p.phone, "IMG1"));
      expect(model.plans).toEqual([]);
      expect(w.sends.length).toBeGreaterThanOrEqual(1);
      expect(w.sends.map((s) => s.body).join("")).not.toContain("NO DEBE SALIR");
    });

    it("UN solo tope: las respuestas del agente cuentan igual que las demás (el límite de la reserva de envío); al alcanzarlo el paciente no recibe más ese día", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "Claro, aquí estoy para ayudarte." });
      const w = setup({ pilot: { phones: [p.phone], model }, cap: { max: 2, windowSeconds: 3600 } });
      await switchTo(true);
      for (const body of ["hola, buenas", "tengo una consulta", "quiero saber algo más"]) await say(w, p.phone, body);
      expect(w.sends.filter((s) => s.to === p.phone)).toHaveLength(2);
    });
  });

  // ───────────────────────────── respaldo ─────────────────────────────

  describe("si el agente nuevo no puede o no debe responder, responde el de siempre", () => {
    it("modelo caído (429 de cuota), verificación fallida (cifra inventada o precio escrito) y plazo vencido: el paciente recibe EXACTAMENTE lo de siempre, una sola vez", async () => {
      const reference = patient();
      const refWorld = setup({ memory: true });
      await say(refWorld, reference.phone, "quiero cotizar mis estudios");
      const expected = refWorld.sends.map((s) => s.body);
      const quota = Object.assign(new Error(`secreto ${SENTINEL}`), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
      const scripts: Array<[string, Script, number?]> = [["cuota", { fail: quota }], ["cifra inventada", { text: "Te respondemos en 24 horas sin falta." }], ["precio", { text: "El hemograma cuesta Bs 45." }], ["plazo", { hang: true }, 150]];
      for (const [name, script, deadline] of scripts) {
        const p = patient();
        const w = setup({ pilot: { phones: [p.phone], model: fakeAgentModel(script), ...(deadline ? { deadlineMs: deadline } : {}) } });
        await switchTo(true);
        await say(w, p.phone, "quiero cotizar mis estudios");
        expect(w.sends.map((s) => s.body), name).toEqual(expected);
        expect(JSON.stringify(w.logs), name).not.toContain(SENTINEL);
      }
    });
  });

  // ───────────────────────────── memoria y continuidad ─────────────────────────────

  describe("memoria, continuidad y pendientes", () => {
    it("la continuidad viene del historial: lo que se habló con el modo esencial llega al agente nuevo como mensajes recientes (sin identificadores ni pendientes)", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "¡Hola! Sobre tu cotización de antes: envíame la foto de tu receta o escribe los nombres de tus estudios." });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await say(w, p.phone, "quiero cotizar mis estudios"); // interruptor apagado: lo de siempre (texto fijo)
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.send_recipe]);
      await switchTo(true);
      await say(w, p.phone, "hola?");
      expect(model.plans[0]!.utterances).toEqual([{ topic: "GREETING", text: "hola?" }]);
      expect(model.plans[0]!.recent).toEqual([{ from: "PATIENT", text: "quiero cotizar mis estudios" }, { from: "ASSISTANT", text: DRAFT_TEXTS.send_recipe }]);
      expect(w.sends.at(-1)!.body).toMatch(/^¡Hola! Sobre tu cotización de antes/);
    });

    it("un mensaje de SALUD sin pedir precio no se conversa con el modelo: responde el modo esencial (determinista) y el modelo ni se toca", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "RESPUESTA DEL AGENTE NUEVO" });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      expect(model.plans).toEqual([]);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).not.toContain("RESPUESTA DEL AGENTE NUEVO");
      expect(w.sends[0]!.body).not.toContain(SENTINEL);
      expect(pilotLogs(w).at(-1)).toMatchObject({ status: "FALLBACK", reason: "MEDICAL" });
    });

    it("SOLO HISTORIAL (sin la memoria estructurada ni la migración 24 en uso): el agente nuevo responde igual, con los mensajes recientes como contexto y sin la herramienta de memoria ni escrituras de eventos", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ pilot: { phones: [p.phone], model }, memory: false });
      await switchTo(true);
      await say(w, p.phone, "hola, necesito cotizar vitamina b12");
      await say(w, p.phone, "y ese cuanto demora?");
      expect(w.sends).toHaveLength(2);
      const second = model.plans[1]!;
      expect(second.recent.map((entry) => entry.from)).toEqual(["PATIENT", "ASSISTANT"]);
      expect(second.recent[0]!.text).toBe("hola, necesito cotizar vitamina b12");
      expect(second.tools.map((tool) => tool.name)).not.toContain("conversation_state");
      expect(called(w, "plusmedik_conv_append")).toBe(0);
      expect(called(w, "plusmedik_conv_events_read")).toBe(0);
    });

    it("recibe los mensajes recientes del historial (sin el lote actual)", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, "hola, necesito cotizar vitamina b12");
      await say(w, p.phone, "gracias");
      const secondPlan = model.plans[1]!;
      expect(secondPlan.recent.map((entry) => entry.from)).toEqual(["PATIENT", "ASSISTANT"]);
      expect(secondPlan.recent[0]!.text).toBe("hola, necesito cotizar vitamina b12");
      expect(secondPlan.recent.map((entry) => entry.text).join(" ")).not.toContain("gracias");
      expect(called(w, "plusmedik_history_recent")).toBeGreaterThanOrEqual(2);
    });

    it("cambio de tema entre mensajes: cada lote se decide con sus propias peticiones y lo anterior solo como contexto", async () => {
      const p = patient();
      const model = fakeAgentModel({ text: "Claro, con gusto." });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, "cuanto cuesta el hemograma?");
      await say(w, p.phone, "mejor dime a que hora abren");
      expect(model.plans[1]!.utterances.map((u) => u.topic)).toEqual(["INFO_REQUEST"]);
      expect(model.plans[1]!.recent.some((entry) => /hemograma/.test(entry.text))).toBe(true);
    });
  });

  // ───────────────────────────── derivación humana al CRM ─────────────────────────────

  describe("derivación humana al CRM", () => {
    const humanScript: Script = { plan: { handoff: "HUMAN_REQUEST" }, text: "Claro, te paso con una persona del laboratorio." };
    const crmOf = (state: "REGISTERED" | "FAILED") => {
      const submit = vi.fn(async (_ctx: unknown, _cases: unknown) => [{ state }]);
      return { submit, crm: { submit, submitSessionReview: async () => [] } as unknown as CrmHandoff };
    };

    it("hoy no hay cola al CRM: el agente nuevo no puede derivar, no promete a una persona y responde el de siempre", async () => {
      const p = patient();
      const w = setup({ pilot: { phones: [p.phone], model: fakeAgentModel(humanScript), handoffEnabled: true } });
      await switchTo(true);
      await say(w, p.phone, "quiero hablar con una persona");
      expect(w.sends.map((s) => s.body)).not.toContain("Claro, te paso con una persona del laboratorio.");
      expect(pilotLogs(w).at(-1)).toMatchObject({ status: "REJECTED", violations: ["UNREGISTERED_HANDOFF_PROMISE"] });
    });

    it("con la cola al CRM y la derivación habilitada: el caso se registra con el mensaje del lote ANTES de responder, y solo entonces el agente dice que una persona atenderá", async () => {
      const p = patient();
      const { submit, crm } = crmOf("REGISTERED");
      const w = setup({ pilot: { phones: [p.phone], model: fakeAgentModel(humanScript), handoffEnabled: true }, crm });
      await switchTo(true);
      const message = await say(w, p.phone, "quiero hablar con una persona");
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]![1]).toEqual([{ kapsoMessageId: message, contactPhone: p.phone, kind: "CONVERSATION", reasons: ["HUMAN_REQUEST"] }]);
      expect(w.sends.map((s) => s.body)).toEqual(["Claro, te paso con una persona del laboratorio."]);
      expect(pilotLogs(w).at(-1)).toMatchObject({ status: "VERIFIED", handoff: "REGISTERED" });
    });

    it("si el CRM no registra el caso, NO se promete nada: responde el de siempre", async () => {
      const p = patient();
      const { submit, crm } = crmOf("FAILED");
      const w = setup({ pilot: { phones: [p.phone], model: fakeAgentModel(humanScript), handoffEnabled: true }, crm });
      await switchTo(true);
      await say(w, p.phone, "quiero hablar con una persona");
      expect(submit).toHaveBeenCalled();
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).not.toBe("Claro, te paso con una persona del laboratorio.");
      expect(pilotLogs(w).at(-1)).toMatchObject({ status: "HANDOFF_FAILED" });
    });

    it("tras la derivación, cuando la recepción escribe el agente se pausa, y al REANUDAR (manual) lo pendiente vuelve a estar a su alcance", async () => {
      const p = patient();
      const { crm } = crmOf("REGISTERED");
      const model = fakeAgentModel({ ...humanScript });
      const w = setup({ pilot: { phones: [p.phone], model, handoffEnabled: true }, crm });
      await switchTo(true);
      await say(w, p.phone, "quiero hablar con una persona");
      await send(w, humanEvent(id("human"), p.phone, "Hola, le atiende recepción"), SENT);
      const plans = model.plans.length;
      await say(w, p.phone, "cotiza hemograma por favor"); // en pausa: nadie responde solo
      expect(model.plans).toHaveLength(plans);
      await w.settle();
      let state = (await stateOf(w, p.key))!;
      expect(state.holder).toBe("HUMAN");
      expect(state.questions.at(-1)).toMatchObject({ status: "CARRIED", reason: "HUMAN_PAUSED" });
      // la recepción reanuda manualmente (la ruta del CRM escribe este evento): lo pospuesto por la pausa se reabre para el agente
      const recorder = resolveConversationState({ PLUSMEDIK_LLM_CONVERSATION: "on" }, () => undefined, { contactKeyFor, store: w.store })!;
      recorder.humanResume({ contactKey: p.key, operationId: `op-${counter}` });
      await recorder.flush();
      state = (await stateOf(w, p.key))!;
      expect(state.holder).toBe("AGENT");
      expect(state.questions.at(-1)).toMatchObject({ status: "OPEN" });
      expect(await eventKinds(p.key)).toContain("HUMAN_RESUME");
    });
  });

  // ───────────────────────────── alcance global (PLUSMEDIK_AGENT=live) ─────────────────────────────

  describe("alcance global: todos los pacientes, con el agente de siempre como respaldo", () => {
    const reference = async (body: string) => {
      const r = patient();
      const w = setup({ memory: true });
      await say(w, r.phone, body);
      return w.sends.map((s) => s.body);
    };

    it("CUALQUIER paciente recibe al agente nuevo (cada uno su propia respuesta, una sola vez), sin lista de números ni porcentajes", async () => {
      const model = fakeAgentModel({ text: "Hola, con gusto te ayudo. ¿Qué necesitas?" });
      const w = setup({ pilot: { everyone: {}, model } });
      await switchTo(true);
      const [a, b, c] = [patient(), patient(), patient()];
      for (const p of [a, b, c]) await say(w, p.phone, "hola, tengo una consulta");
      expect(w.sends.map((s) => (s.to === a.phone ? "a" : s.to === b.phone ? "b" : "c") + ":" + s.body).sort()).toEqual(["a:Hola, con gusto te ayudo. ¿Qué necesitas?", "b:Hola, con gusto te ayudo. ¿Qué necesitas?", "c:Hola, con gusto te ayudo. ¿Qué necesitas?"]);
      expect(model.plans).toHaveLength(3);
    });

    it("un número EXCLUIDO sigue con el agente de siempre aunque el alcance sea todos", async () => {
      const expected = await reference("quiero cotizar mis estudios");
      const excluded = patient();
      const model = fakeAgentModel({ text: "RESPUESTA DEL AGENTE NUEVO" });
      const w = setup({ pilot: { everyone: { exclude: [excluded.phone] }, model } });
      await switchTo(true);
      await say(w, excluded.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).toEqual(expected);
      expect(model.plans).toEqual([]);
      const included = patient();
      await say(w, included.phone, "hola, tengo una consulta");
      expect(w.sends.at(-1)!.body).toBe("RESPUESTA DEL AGENTE NUEVO");
    });

    it("REVERSIÓN INMEDIATA: al apagar el interruptor desde la base, TODOS vuelven al agente de siempre en el siguiente mensaje, sin redesplegar", async () => {
      const model = fakeAgentModel({ text: "Respuesta del agente nuevo, con gusto." });
      const w = setup({ pilot: { everyone: {}, model } });
      const [a, b] = [patient(), patient()];
      await switchTo(true);
      await say(w, a.phone, "hola, tengo una consulta");
      await say(w, b.phone, "hola, tengo una consulta");
      expect(model.plans).toHaveLength(2);
      await switchTo(false);
      const expected = await reference("quiero cotizar mis estudios");
      await say(w, a.phone, "quiero cotizar mis estudios");
      await say(w, b.phone, "quiero cotizar mis estudios");
      expect(w.sends.filter((s) => s.to === a.phone).at(-1)!.body).toBe(expected[0]);
      expect(w.sends.filter((s) => s.to === b.phone).at(-1)!.body).toBe(expected[0]);
      expect(model.plans).toHaveLength(2);
    });

    it("CAÍDA DEL PROVEEDOR: tras 3 fallos seguidos el corta-circuito deja de esperar al modelo; ningún paciente se queda sin respuesta y todos reciben exactamente lo de siempre", async () => {
      const expected = await reference("quiero cotizar mis estudios");
      const quota = Object.assign(new Error("x"), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
      const model = fakeAgentModel({ fail: quota });
      const w = setup({ pilot: { everyone: {}, model } });
      await switchTo(true);
      const patients = [patient(), patient(), patient(), patient(), patient()];
      for (const p of patients) await say(w, p.phone, "quiero cotizar mis estudios");
      for (const p of patients) expect(w.sends.filter((s) => s.to === p.phone).map((s) => s.body)).toEqual(expected);
      expect(model.plans).toHaveLength(3);
      expect(w.logs.some(([event, data]) => event === "agent_pilot_breaker" && data.open === true)).toBe(true);
      expect(pilotLogs(w).filter((entry) => entry.reason === "BREAKER_OPEN")).toHaveLength(2);
    });

    it("el tope de 6 respuestas por contacto cada 24 horas es el MISMO para el agente y para el modo esencial", async () => {
      const p = patient();
      const w = setup({ pilot: { everyone: {}, model: fakeAgentModel({ text: "Claro, aquí estoy para ayudarte." }) }, cap: { max: 6, windowSeconds: 86_400 } });
      await switchTo(true);
      for (const body of ["hola 1", "hola 2", "hola 3", "hola 4", "hola 5", "hola 6", "hola 7", "hola 8"]) await say(w, p.phone, body);
      expect(w.sends.filter((s) => s.to === p.phone)).toHaveLength(6);
    });

    it("las garantías de la máquina de envío no cambian con el alcance global: una entrega repetida 3 veces y simultánea produce UNA respuesta; la pausa humana se respeta; las fotos van por la ruta de siempre", async () => {
      const model = fakeAgentModel({ text: "Respuesta del agente nuevo, con gusto." });
      const w = setup({ pilot: { everyone: {}, model } });
      await switchTo(true);
      const p = patient();
      const event = textEvent(id("txt"), p.phone, "hola, quiero una cotización");
      await send(w, event);
      await send(w, event);
      await Promise.all([1, 2].map(() => w.hook(signedPost(event, RECEIVED))));
      await w.settle();
      expect(w.sends.filter((s) => s.to === p.phone)).toHaveLength(1);
      const q = patient();
      await say(w, q.phone, "hola buenas");
      await send(w, humanEvent(id("human"), q.phone), SENT);
      const before = { sends: w.sends.length, plans: model.plans.length };
      await say(w, q.phone, "cotiza hemograma por favor");
      expect(w.sends).toHaveLength(before.sends);
      expect(model.plans).toHaveLength(before.plans);
      const r = patient();
      const plans = model.plans.length;
      await send(w, imageEvent(id("img"), r.phone, "IMG1"));
      expect(model.plans).toHaveLength(plans);
      expect(w.sends.some((s) => s.to === r.phone)).toBe(true);
    });
  });

  // ───────────────────────────── privacidad ─────────────────────────────

  describe("privacidad", () => {
    it("el registro del piloto lleva solo códigos y contadores: ni texto del paciente, ni del agente, ni teléfonos, ni ids de mensaje; la base solo recibe lo ya habitual", async () => {
      const p = patient();
      const model = fakeAgentModel({ calls: [{ tool: "lab_info", input: { question: "a que hora abren" } }], text: "Atendemos de lunes a viernes de 07:00 a 18:00 y los sábados de 08:00 a 12:00." });
      const w = setup({ pilot: { phones: [p.phone], model } });
      await switchTo(true);
      await say(w, p.phone, `a que hora abren ${SENTINEL}`);
      const dump = JSON.stringify(w.logs.filter(([event]) => event.startsWith("agent_pilot")));
      for (const secret of [SENTINEL, "a que hora abren", "Atendemos", "07:00", p.phone, "wamid"]) expect(dump, secret).not.toContain(secret);
      expect((await eventKinds(p.key)).sort()).toEqual(["AGENT_REPLY", "PATIENT_BATCH"]);
      expect(await db.ok(`select count(*) from public.plusmedik_conv_events where contact_key = '${p.key}' and payload::text ~ '(07:00|abren|Atendemos)'`)).toBe("0");
    });
  });
});
