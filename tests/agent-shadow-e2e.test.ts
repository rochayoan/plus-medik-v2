import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Act, AgentModel, PlanInput, RespondInput } from "../src/agent/contracts.js";
import { createAgentShadow, type AgentShadow, type AgentShadowRecord } from "../src/agent/shadow.js";
import { createReplyGate, createRepeatTracker, type AttentionConfig } from "../src/attention-filter.js";
import { createSupabaseAuditRepository, createSupabaseRpc } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createConversationReader, createSupabaseConversationStore, resolveConversationState, type ConversationRecorder } from "../src/conversation-state-store.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import type { KnowledgeAnswer } from "../src/knowledge-answers.js";
import { createMessageHistory, createSupabaseHistoryStore } from "../src/message-history.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Núcleo conversacional EN SOMBRA (Fase 2 del plan G7) de extremo a extremo: webhook REAL + turnos REALES + manejador de texto REAL + repositorios REALES + PostgreSQL REAL con TODAS las migraciones.
// Solo se simulan Kapso (envíos), OpenAI (el modelo del agente es un doble), el catálogo y el motor de recetas. Lo central: con el agente en sombra, lo que el paciente recibe es EXACTAMENTE lo de siempre.

const bin = findPostgresBin();
if (!bin) console.warn("[agent-shadow-e2e] PostgreSQL no disponible: se omiten los escenarios del agente en sombra contra la base real.");
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
const humanEvent = (id: string, phone: string, body = "Hola, le atiende recepción") => ({ message: { id, timestamp: nowSeconds(), type: "text", to: phone, text: { body }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

interface Seen { plans: PlanInput[]; responds: RespondInput[] }
function fakeAgentModel(options: { calls?: Array<{ tool: string; input: unknown }>; acts?: (input: RespondInput) => Act[]; reply?: string; fail?: Error; hang?: boolean } = {}): AgentModel & { seen: Seen } {
  const seen: Seen = { plans: [], responds: [] };
  return {
    seen,
    async plan(input) { seen.plans.push(input); if (options.hang) return new Promise(() => undefined); if (options.fail) throw options.fail; return { toolCalls: options.calls ?? [] }; },
    async respond(input) { seen.responds.push(input); return { acts: options.acts ? options.acts(input) : [{ kind: "ACK", utterances: input.utterances.map((utterance) => utterance.id) }], text: options.reply ?? "¡Hola! ¿En qué te puedo ayudar?" }; }
  };
}

describe.skipIf(!bin)("núcleo conversacional en sombra de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("agent_shadow");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  interface Options { agent?: AgentModel; agentOptions?: Partial<Parameters<typeof createAgentShadow>[0]>; memory?: boolean; sessions?: boolean }
  function setup(options: Options = {}) {
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const records: AgentShadowRecord[] = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const history = createMessageHistory({ store: createSupabaseHistoryStore({ rpc: createSupabaseRpc(rpcOptions()) }), accountId: LAB, contactKeyFor, log });
    const store = createSupabaseConversationStore({ rpc: createSupabaseRpc(rpcOptions()) });
    const convState: ConversationRecorder | undefined = options.memory ? resolveConversationState({ PLUSMEDIK_CONV_STATE: "shadow" }, log, { contactKeyFor, store }) : undefined;
    const agentShadow: AgentShadow | undefined = options.agent
      ? createAgentShadow({
          model: options.agent, modelName: "modelo-x", loadCatalog: async () => CATALOG(), contactKeyFor, log, record: (record) => { records.push(record); },
          answer: async () => ({ body: "Lunes a viernes de 07:00 a 18:00", refs: [], status: "ANSWERED", topics: [], unavailable: [] }) as unknown as KnowledgeAnswer,
          ...(options.memory ? { reader: createConversationReader({ store }) } : {}), ...options.agentOptions
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
        contactKeyFor, busyDelayMs: 20, busyRetries: 400, attention, ...(convState ? { convState } : {}), ...(agentShadow ? { agentShadow } : {}),
        handlers: { text: createTextHandler({ log, attention: true }) },
        ...(options.sessions !== false ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, attention: { gate: attention.gate, settleMs: attention.settleMs }, ownTexts: Object.values(DRAFT_TEXTS) }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, history, ...(convState ? { convState } : {}), humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, records, network, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
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
  const agentLogs = (w: World) => w.logs.filter(([event]) => event === "agent_shadow").map(([, data]) => data);

  // ───────────────────────────── lo que recibe el paciente no cambia ─────────────────────────────

  describe("con el agente en sombra, el paciente recibe lo de siempre", () => {
    const SCRIPT = ["hola", "quiero cotizar mis estudios", "cotiza hemograma y glucosa", "a que hora abren", "me duele el pecho", "gracias"];

    async function run(agent: AgentModel | undefined, memory: boolean) {
      const p = patient();
      const w = setup({ ...(agent ? { agent } : {}), memory });
      for (const body of SCRIPT) await say(w, p.phone, body);
      await send(w, humanEvent(id("human"), p.phone), SENT);
      await say(w, p.phone, "cotiza tsh por favor");
      return { p, w, sends: w.sends.map((s) => s.body), statuses: await runStatuses(p.phone), history: await historyShape(p.key) };
    }

    it("mismos envíos, mismas corridas de auditoría, mismo historial y mismas llamadas a la base salvo las de la memoria; ningún registro nuevo salvo agent_shadow y conv_state", async () => {
      const off = await run(undefined, false);
      const model = fakeAgentModel({ calls: [{ tool: "lab_info", input: { question: "a que hora abren" } }, { tool: "quote_studies", input: { studies: ["hemograma"] } }], acts: (input) => [{ kind: "ACK", utterances: input.utterances.map((u) => u.id) }] });
      const on = await run(model, true);
      expect(on.sends).toEqual(off.sends);
      expect(on.sends.length).toBeGreaterThanOrEqual(3);
      expect(on.statuses).toBe(off.statuses);
      expect(on.history).toBe(off.history);
      const rpcs = (w: World) => w.network.calls.filter((name) => !name.startsWith("plusmedik_conv_")).sort();
      expect(rpcs(on.w)).toEqual(rpcs(off.w));
      const names = (w: World) => new Set(w.logs.map(([event]) => event));
      expect([...names(on.w)].filter((name) => !names(off.w).has(name)).sort()).toEqual(["agent_shadow", "conv_state"]);
      // decidió en sombra (el modelo recibió peticiones) y lo dejó en el registro con códigos
      expect(model.seen.plans.length).toBeGreaterThan(3);
      expect(agentLogs(on.w).length).toBeGreaterThan(3);
      expect(off.w.records).toEqual([]);
    });

    it("el modelo del agente no puede enviar nada: no hay ninguna vía de envío en el ejecutor, y sus propuestas quedan solo en el registro inyectado", async () => {
      const p = patient();
      const model = fakeAgentModel({ reply: "ESTA PROPUESTA NO DEBE LLEGAR AL PACIENTE" });
      const w = setup({ agent: model });
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).not.toContain("ESTA PROPUESTA NO DEBE LLEGAR AL PACIENTE");
      expect(w.sends).toHaveLength(1);
      expect(w.records[0]!.decision.reply).toBe("ESTA PROPUESTA NO DEBE LLEGAR AL PACIENTE");
    });
  });

  // ───────────────────────────── qué decide ─────────────────────────────

  describe("qué decide en sombra", () => {
    it("una cotización del catálogo: el modelo no ve precios y la propuesta lleva el bloque del sistema con los precios del catálogo", async () => {
      const p = patient();
      const model = fakeAgentModel({
        calls: [{ tool: "quote_studies", input: { studies: ["hemograma", "glucosa"] } }],
        acts: () => [{ kind: "QUOTE", utterances: ["U1"] }],
        reply: "¡Claro! Aquí tienes el detalle de tu cotización."
      });
      const w = setup({ agent: model });
      await say(w, p.phone, "cotiza hemograma y glucosa");
      expect(JSON.stringify(model.seen.responds)).not.toMatch(/\b45\b|\b30[.,]5|Bs/);
      expect(agentLogs(w)[0]).toMatchObject({ status: "VERIFIED", withQuote: true, acts: { QUOTE: 1 } });
      expect(w.records[0]!.decision.reply).toMatch(/HEMOGRAMA COMPLETO[\s\S]*GLUCOSA EN AYUNAS[\s\S]*75[.,]5/);
      // y lo que el agente de siempre envió fue su propia cotización, intacta
      expect(w.sends).toHaveLength(1);
    });

    it("continuidad: lo que quedó pospuesto en un turno anterior vuelve como petición pendiente en el siguiente", async () => {
      const p = patient();
      const model = fakeAgentModel({ acts: (input) => [{ kind: "ACK", utterances: input.utterances.map((u) => u.id) }] });
      const w = setup({ agent: model, memory: true });
      const first = await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.send_recipe]);
      await say(w, p.phone, "hola?");
      const second = model.seen.plans.at(-1)!;
      expect(second.utterances.map((u) => `${u.topic}:${u.carried ?? false}`)).toEqual(["GREETING:false", "RECIPE_OR_QUOTE:true"]);
      expect(first).toBeTruthy();
    });

    it("una pregunta de salud llega al modelo con su texto y el tema MEDICAL; el agente solo puede aplazar o derivar", async () => {
      const p = patient();
      const model = fakeAgentModel({ acts: () => [{ kind: "DEFER", utterances: ["U1"], reason: "NOT_SUPPORTED" }], reply: "Eso es algo que conviene consultar con tu médico." });
      const w = setup({ agent: model });
      await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      expect(model.seen.plans[0]!.utterances).toEqual([{ id: "U1", topic: "MEDICAL", goal: "HUMAN_ATTENTION", text: `me duele el pecho ${SENTINEL}` }]);
      expect(agentLogs(w)[0]).toMatchObject({ status: "VERIFIED", acts: { DEFER: 1 } });
    });
  });

  // ───────────────────────────── invariantes de producción ─────────────────────────────

  describe("conserva idempotencia, pausa humana y un solo envío por lote", () => {
    it("el mismo webhook entregado tres veces: una sola respuesta y una sola decisión en sombra", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ agent: model });
      const event = textEvent(id("txt"), p.phone, "quiero cotizar mis estudios");
      await send(w, event);
      await send(w, event);
      await send(w, event);
      expect(w.sends).toHaveLength(1);
      expect(model.seen.plans).toHaveLength(1);
    });

    it("un lote de varios mensajes: una sola respuesta real y UNA decisión con una petición por mensaje", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ agent: model });
      const batch = { type: "whatsapp.message.received", batch: true, data: [textEvent(id("a"), p.phone, "hola"), textEvent(id("b"), p.phone, "cotiza hemograma"), textEvent(id("c"), p.phone, "a que hora abren")] };
      await send(w, batch, { ...RECEIVED, "x-webhook-batch": "true" });
      expect(w.sends).toHaveLength(1);
      expect(model.seen.plans).toHaveLength(1);
      expect(model.seen.plans[0]!.utterances.map((u) => u.topic)).toEqual(["SOCIAL", "RECIPE_OR_QUOTE", "INFO_REQUEST"]);
    });

    it("pausa humana: lo que el paciente escribe tras la recepción no se responde ni se decide (el agente no toca la conversación)", async () => {
      const p = patient();
      const model = fakeAgentModel();
      const w = setup({ agent: model, memory: true });
      await say(w, p.phone, "hola");
      await send(w, humanEvent(id("human"), p.phone), SENT);
      const before = { sends: w.sends.length, plans: model.seen.plans.length };
      await say(w, p.phone, "cotiza hemograma por favor");
      expect(w.sends).toHaveLength(before.sends);
      expect(model.seen.plans).toHaveLength(before.plans);
    });
  });

  describe("si el agente en sombra falla, lo demás sigue igual", () => {
    it("un modelo que falla (429 de cuota) deja un código en el registro y no cambia lo que recibe el paciente ni las corridas de auditoría", async () => {
      const reference = patient();
      const p = patient();
      const ref = setup();
      await say(ref, reference.phone, "quiero cotizar mis estudios");
      const quota = Object.assign(new Error(`secreto ${SENTINEL}`), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
      const w = setup({ agent: fakeAgentModel({ fail: quota }) });
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).toEqual(ref.sends.map((s) => s.body));
      expect(await runStatuses(p.phone)).toBe(await runStatuses(reference.phone));
      expect(agentLogs(w)[0]).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "QUOTA_OR_BILLING", httpStatus: 429 } });
      expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
    });

    it("un modelo que no responde no retrasa lo que recibe el paciente más allá del plazo propio de la sombra", async () => {
      const p = patient();
      const w = setup({ agent: fakeAgentModel({ hang: true }), agentOptions: { runTimeoutMs: 150, flushMs: 200 } });
      const started = Date.now();
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(w.sends).toHaveLength(1);
      expect(agentLogs(w).some((entry) => entry.reason === "RUN_TIMEOUT")).toBe(true);
    });

    it("PRIVACIDAD: el registro del agente no lleva el texto del paciente, de las propuestas ni de los hechos; la sombra no escribe en ninguna tabla", async () => {
      const p = patient();
      const model = fakeAgentModel({ calls: [{ tool: "lab_info", input: { question: "a que hora abren" } }], acts: () => [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }], reply: "Atendemos de lunes a viernes de 07:00 a 18:00." });
      const w = setup({ agent: model });
      await say(w, p.phone, `a que hora abren ${SENTINEL}`);
      const dump = JSON.stringify(w.logs.filter(([event]) => event === "agent_shadow"));
      for (const secret of [SENTINEL, "a que hora abren", "Atendemos", "07:00", p.phone, "wamid"]) expect(dump, secret).not.toContain(secret);
      expect(await db.ok(`select count(*) from public.plusmedik_conv_events where contact_key = '${p.key}'`)).toBe("0");
    });
  });
});
