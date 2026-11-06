import { describe, expect, it, vi } from "vitest";
import type { Act, AgentModel, PlanInput, RespondInput } from "../src/agent/contracts.js";
import { createAgentShadow, pendingUtterances, SHADOW_LIMITS, utterancesOf, type AgentShadowRecord } from "../src/agent/shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createConversationReader, type ConversationStore, type ObservedTurn } from "../src/conversation-state-store.js";
import { encodeEvent, replayEvents, type ConversationEvent } from "../src/conversation-state.js";
import type { KnowledgeAnswer } from "../src/knowledge-answers.js";
import type { CatalogStudy } from "../src/types.js";

// Ejecución en sombra del núcleo conversacional: arma las peticiones desde el lote y la memoria, decide con un modelo SIMULADO y registra SOLO códigos. No hay ninguna función de envío en ninguna parte.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CATALOG = [{ id: uuid(1), code: null, name: "HEMOGRAMA COMPLETO", normalizedName: normalizeStudyKey("HEMOGRAMA COMPLETO"), normalizedAliases: ["hemograma"], priceBs: 45, active: true }] as unknown as CatalogStudy[];
const KEY = "a".repeat(64);
const text = (id: string, body: string): ObservedTurn => ({ messageId: id, kind: "TEXT", text: body });
const NOW = 1_800_000_000_000;

function memoryStore(events: ConversationEvent[]): ConversationStore {
  const rows = events.map((event) => { const row = encodeEvent(event); return { key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }; });
  return { append: async () => ({ recorded: 0, duplicate: 0 }), read: async () => rows, contactsSince: async () => [] };
}

interface Seen { plans: PlanInput[]; responds: RespondInput[] }
function fakeModel(options: { calls?: Array<{ tool: string; input: unknown }>; acts?: (input: RespondInput) => Act[]; reply?: string; fail?: Error; hang?: boolean } = {}): AgentModel & { seen: Seen } {
  const seen: Seen = { plans: [], responds: [] };
  return {
    seen,
    async plan(input) {
      seen.plans.push(input);
      if (options.hang) return new Promise(() => undefined);
      if (options.fail) throw options.fail;
      return { toolCalls: options.calls ?? [], usage: { inputTokens: 10, outputTokens: 2 } };
    },
    async respond(input) {
      seen.responds.push(input);
      return { acts: options.acts ? options.acts(input) : [{ kind: "ACK", utterances: input.utterances.map((utterance) => utterance.id) }], text: options.reply ?? "¡Hola! ¿En qué te puedo ayudar?", usage: { inputTokens: 20, outputTokens: 8 } };
    }
  };
}

function make(overrides: Partial<Parameters<typeof createAgentShadow>[0]> = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const records: AgentShadowRecord[] = [];
  const model = fakeModel();
  const shadow = createAgentShadow({
    model, modelName: "modelo-x", loadCatalog: async () => CATALOG, contactKeyFor: (phone) => (phone === "59170000001" ? KEY : undefined),
    log: (event, data) => { logs.push([event, data]); }, record: (record) => { records.push(record); }, now: () => NOW, ...overrides
  });
  return { shadow, logs, records, model: (overrides.model as ReturnType<typeof fakeModel> | undefined) ?? model };
}
const shadowLogs = (logs: Array<[string, Record<string, unknown>]>) => logs.filter(([event]) => event === "agent_shadow").map(([, data]) => data);

describe("utterancesOf: una petición por mensaje de texto", () => {
  it("clasifica cada texto, marca los saludos y deja afuera lo que no es texto", () => {
    const { utterances, mediaSkipped } = utterancesOf([text("w1", "hola"), text("w2", "cuanto cuesta un hemograma"), text("w3", "a que hora abren"), { messageId: "w4", kind: "IMAGE" }, { messageId: "w5", kind: "AUDIO" }, text("w6", "   ")]);
    expect(mediaSkipped).toBe(2);
    expect(utterances.map((x) => `${x.id}:${x.topic}:${x.goal}`)).toEqual(["U1:SOCIAL:OTHER", "U2:RECIPE_OR_QUOTE:QUOTE", "U3:INFO_REQUEST:LAB_INFO"]);
    expect(utterances[1]!.text).toBe("cuanto cuesta un hemograma");
  });

  it("un mensaje de salud llega con su texto y el tema MEDICAL (el agente solo puede aplazar o derivar)", () => {
    const { utterances } = utterancesOf([text("w1", "me duele mucho el pecho y tengo fiebre")]);
    expect(utterances).toEqual([{ id: "U1", topic: "MEDICAL", goal: "HUMAN_ATTENTION", text: "me duele mucho el pecho y tengo fiebre" }]);
  });

  it("acota la cantidad de textos y el largo de cada uno", () => {
    const many = utterancesOf(Array.from({ length: 10 }, (_, i) => text(`w${i}`, `quiero cotizar ${"x".repeat(2000)}`)));
    expect(many.utterances).toHaveLength(SHADOW_LIMITS.maxTexts);
    expect(many.utterances.every((x) => (x.text?.length ?? 0) <= 1500)).toBe(true);
  });
});

describe("pendingUtterances: lo que quedó pospuesto de antes", () => {
  const batch = (id: string, at: number, topic = "MEDIA_IMAGE"): ConversationEvent => ({ id: `batch:${id}`, type: "PATIENT_BATCH", at, items: [{ messageId: id, topic, goal: "QUOTE" }] });
  const reply = (id: string, at: number, quality: "GENERIC" | "ANSWER" | "UNRESOLVED"): ConversationEvent => ({ id: `reply:${id}`, type: "AGENT_REPLY", at, quality });

  it("solo lo pospuesto por un texto fijo, fallo o sin resolver, reciente, que no sea de este lote ni de la pausa humana", () => {
    const state = replayEvents([batch("old", NOW - 3600_000), reply("r1", NOW - 3500_000, "GENERIC"), batch("stale", NOW - 3 * 24 * 3600_000), reply("r2", NOW - 3 * 24 * 3600_000 + 1000, "GENERIC"), batch("now", NOW - 1000, "INFO_REQUEST")]);
    const carried = pendingUtterances(state, NOW, new Set(["now"]), 1);
    expect(carried).toEqual([{ id: "P1", topic: "MEDIA_IMAGE", goal: "QUOTE", carried: true, ref: "old" }]);
  });

  it("con una persona al mando no hay pendientes que atender, y lo respondido no cuenta", () => {
    expect(pendingUtterances(replayEvents([{ id: "h", type: "HUMAN_MESSAGE", at: NOW - 5000 }, batch("w1", NOW - 4000)]), NOW, new Set(), 1)).toEqual([]);
    expect(pendingUtterances(replayEvents([batch("w1", NOW - 4000), reply("r", NOW - 3000, "ANSWER")]), NOW, new Set(), 1)).toEqual([]);
    expect(pendingUtterances(undefined, NOW, new Set(), 1)).toEqual([]);
  });

  it("como mucho tres, numerados desde donde se indique", () => {
    const events: ConversationEvent[] = [];
    for (let i = 0; i < 5; i++) events.push(batch(`m${i}`, NOW - 10_000 + i), reply(`r${i}`, NOW - 9_000 + i, "UNRESOLVED"));
    expect(pendingUtterances(replayEvents(events), NOW, new Set(), 4).map((x) => x.id)).toEqual(["P4", "P5", "P6"]);
  });
});

describe("el ejecutor en sombra", () => {
  it("decide en segundo plano, registra SOLO códigos y contadores (nunca texto) y entrega la decisión completa al registro inyectado", async () => {
    const { shadow, logs, records, model } = make();
    shadow.observe({ from: "59170000001", turns: [text("wamid.A", "hola, soy Maria Perez y mi cédula es 12345678")] });
    await shadow.flush();
    const [entry] = shadowLogs(logs);
    expect(entry).toMatchObject({ status: "VERIFIED", utterances: 1, carried: 0, mediaSkipped: 0, acts: { ACK: 1 }, violations: [], model: "modelo-x", usage: { calls: 2, inputTokens: 30, outputTokens: 10 } });
    expect(entry).toMatchObject({ replyChars: expect.any(Number), replyHash: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(JSON.stringify(logs)).not.toMatch(/Maria|Perez|12345678|Hola|ayudar|wamid|59170000001/);
    expect(records).toHaveLength(1);
    expect(records[0]!.decision.reply).toBe("¡Hola! ¿En qué te puedo ayudar?");
    expect(model.seen.plans).toHaveLength(1);
  });

  it("registra por qué falla el modelo con códigos de la lista blanca, sin su mensaje, y no lanza", async () => {
    const quota = Object.assign(new Error("secreto del proveedor"), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
    const { shadow, logs } = make({ model: fakeModel({ fail: quota }) });
    expect(() => shadow.observe({ from: "59170000001", turns: [text("w1", "hola")] })).not.toThrow();
    await expect(shadow.flush()).resolves.toBeUndefined();
    expect(shadowLogs(logs)[0]).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "QUOTA_OR_BILLING", httpStatus: 429 } });
    expect(JSON.stringify(logs)).not.toContain("secreto");
  });

  it("un fallo de la memoria o del historial no lo detiene: decide con lo que tenga", async () => {
    const reader = createConversationReader({ store: { ...memoryStore([]), read: async () => { throw new Error("down"); } } });
    const recent = vi.fn(async () => { throw new Error("sin historial"); });
    const { shadow, logs, model } = make({ reader, recent });
    shadow.observe({ from: "59170000001", turns: [text("w1", "hola")] });
    await shadow.flush();
    expect(shadowLogs(logs)[0]).toMatchObject({ status: "VERIFIED" });
    expect(recent).toHaveBeenCalledOnce();
    expect(model.seen.plans[0]!.recent).toEqual([]);
  });

  it("incluye lo pendiente de antes como peticiones que hay que cubrir, y los mensajes recientes saneados por quien los provee", async () => {
    const state: ConversationEvent[] = [
      { id: "batch:old", type: "PATIENT_BATCH", at: NOW - 3600_000, items: [{ messageId: "old", topic: "MEDIA_IMAGE", goal: "QUOTE" }] },
      { id: "reply:r", type: "AGENT_REPLY", at: NOW - 3500_000, quality: "GENERIC" }
    ];
    const reader = createConversationReader({ store: memoryStore(state), now: () => NOW });
    const recent = vi.fn(async () => [{ from: "PATIENT" as const, text: "mande una receta" }]);
    const model = fakeModel({ acts: (input) => [{ kind: "ACK", utterances: input.utterances.filter((x) => !x.carried).map((x) => x.id) }] });
    const { shadow, logs } = make({ model, reader, recent });
    shadow.observe({ from: "59170000001", turns: [text("wamid.NEW", "hola")] });
    await shadow.flush();
    expect(model.seen.plans[0]!.utterances.map((x) => `${x.id}:${x.topic}:${x.carried ?? false}`)).toEqual(["U1:SOCIAL:false", "P1:MEDIA_IMAGE:true"]);
    expect(model.seen.plans[0]!.recent).toEqual([{ from: "PATIENT", text: "mande una receta" }]);
    // el acto del modelo no cubrió la pendiente: la invariante de cobertura lo rechaza y queda visible en el registro
    expect(shadowLogs(logs)[0]).toMatchObject({ status: "REJECTED", carried: 1, violations: ["UNCOVERED_UTTERANCE"] });
  });

  it("con una persona al mando no decide nada y no llama al modelo", async () => {
    const reader = createConversationReader({ store: memoryStore([{ id: "h", type: "HUMAN_MESSAGE", at: NOW - 1000 }]), now: () => NOW });
    const { shadow, logs, model } = make({ reader });
    shadow.observe({ from: "59170000001", turns: [text("w1", "hola")] });
    await shadow.flush();
    expect(shadowLogs(logs)).toEqual([{ status: "SKIPPED", reason: "HUMAN_HOLDER" }]);
    expect(model.seen.plans).toHaveLength(0);
  });

  it("un lote solo de fotos o audios no se decide (siguen su ruta de siempre)", async () => {
    const { shadow, logs, model } = make();
    shadow.observe({ from: "59170000001", turns: [{ messageId: "i1", kind: "IMAGE" }, { messageId: "a1", kind: "AUDIO" }] });
    await shadow.flush();
    expect(shadowLogs(logs)).toEqual([{ status: "SKIPPED", reason: "NO_TEXT", mediaSkipped: 2 }]);
    expect(model.seen.plans).toHaveLength(0);
  });

  it("las herramientas dependen de lo configurado: sin conocimiento no hay lab_info; sin cotización no hay quote_studies; con memoria y contacto hay conversation_state", async () => {
    const names = async (overrides: Partial<Parameters<typeof createAgentShadow>[0]>) => {
      const { shadow, model } = make({ model: fakeModel(), ...overrides });
      shadow.observe({ from: "59170000001", turns: [text("w1", "hola")] });
      await shadow.flush();
      return model.seen.plans[0]!.tools.map((tool) => tool.name);
    };
    expect(await names({})).toEqual(["find_studies", "quote_studies"]);
    expect(await names({ answer: async () => ({ body: "x", refs: [], status: "ANSWERED", topics: [], unavailable: [] }) as unknown as KnowledgeAnswer })).toEqual(["lab_info", "find_studies", "quote_studies"]);
    expect(await names({ capabilities: { handoff: false, quote: false }, reader: createConversationReader({ store: memoryStore([]) }) })).toEqual(["find_studies", "conversation_state"]);
  });

  it("ejecuta las herramientas reales: la cotización y la información del laboratorio salen del catálogo y del conocimiento", async () => {
    const model = fakeModel({
      calls: [{ tool: "lab_info", input: { question: "a que hora abren" } }, { tool: "quote_studies", input: { studies: ["hemograma"] } }],
      acts: () => [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }, { kind: "QUOTE", utterances: ["U2"] }],
      reply: "Abrimos de lunes a viernes de 07:00 a 18:00. Abajo tienes el detalle."
    });
    const answer = async () => ({ body: "Lunes a viernes de 07:00 a 18:00", refs: [], status: "ANSWERED", topics: [], unavailable: [] }) as unknown as KnowledgeAnswer;
    const { shadow, logs, records } = make({ model, answer });
    shadow.observe({ from: "59170000001", turns: [text("w1", "a que hora abren"), text("w2", "cotiza hemograma")] });
    await shadow.flush();
    expect(shadowLogs(logs)[0]).toMatchObject({ status: "VERIFIED", acts: { ANSWER: 1, QUOTE: 1 }, withQuote: true, tools: [{ tool: "lab_info", ok: true }, { tool: "quote_studies", ok: true }] });
    expect(records[0]!.decision.reply).toMatch(/HEMOGRAMA COMPLETO[\s\S]*45/);
    expect(JSON.stringify(logs)).not.toMatch(/HEMOGRAMA|45|07:00/);
  });

  it("el muestreo es determinista por mensaje y respeta el porcentaje", async () => {
    const run = async (percent: number, ids: string[]) => {
      const { shadow, model } = make({ sample: percent, model: fakeModel() });
      for (const id of ids) shadow.observe({ from: "59170000001", turns: [text(id, "hola")] });
      await shadow.flush();
      return model.seen.plans.length;
    };
    const ids = Array.from({ length: 40 }, (_, i) => `wamid.sample-${i}`);
    // el tope de concurrencia no interviene: se observan en tandas
    const decided = async (percent: number) => { let total = 0; for (let i = 0; i < ids.length; i += 4) total += await run(percent, ids.slice(i, i + 4)); return total; };
    expect(await decided(100)).toBe(40);
    const half = await decided(50);
    expect(half).toBeGreaterThan(8);
    expect(half).toBeLessThan(32);
    expect(await decided(50)).toBe(half);
    expect(await decided(1)).toBeLessThan(10);
  });

  it("tope de concurrencia: lo que excede se descarta con un código, y flush está acotado aunque el modelo no responda", async () => {
    const { shadow, logs } = make({ model: fakeModel({ hang: true }) });
    for (let i = 0; i < SHADOW_LIMITS.maxConcurrent + 2; i++) shadow.observe({ from: "59170000001", turns: [text(`w${i}`, "hola")] });
    expect(shadowLogs(logs).filter((entry) => entry.reason === "BUSY")).toHaveLength(2);
    const started = Date.now();
    await shadow.flush(40);
    expect(Date.now() - started).toBeLessThan(1000);
    const idle = make().shadow;
    await expect(idle.flush(10_000)).resolves.toBeUndefined();
  });

  it("un registro inyectado que falla no interrumpe nada", async () => {
    const { shadow, logs } = make({ record: () => { throw new Error("sumidero caído"); } });
    shadow.observe({ from: "59170000001", turns: [text("w1", "hola")] });
    await expect(shadow.flush()).resolves.toBeUndefined();
    expect(shadowLogs(logs)[0]).toMatchObject({ status: "VERIFIED" });
  });
});

