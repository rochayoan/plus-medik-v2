import { describe, expect, it, vi } from "vitest";
import { buildAgentTools, prepareAgentTurn, PREPARE_LIMITS, summarizeDecision, utterancesOf } from "../src/agent/shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createConversationReader, type ConversationStore, type ObservedTurn } from "../src/conversation-state-store.js";
import type { KnowledgeAnswer } from "../src/knowledge-answers.js";
import type { CatalogStudy } from "../src/types.js";
import type { AgentDecision } from "../src/agent/contracts.js";

// Preparación del turno del agente: los mensajes del lote (sin ids, sin pendientes), el desvío de lo médico al modo esencial, los mensajes recientes sin pagos y las herramientas según lo configurado.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CATALOG = [{ id: uuid(1), code: null, name: "HEMOGRAMA COMPLETO", normalizedName: normalizeStudyKey("HEMOGRAMA COMPLETO"), normalizedAliases: ["hemograma"], priceBs: 45, active: true, category: null, sampleType: null }] as unknown as CatalogStudy[];
const KEY = "a".repeat(64);
const text = (id: string, body: string): ObservedTurn => ({ messageId: id, kind: "TEXT", text: body });
const base = { loadCatalog: async () => CATALOG, contactKeyFor: (phone: string) => (phone === "59170000001" ? KEY : undefined) };
const emptyStore: ConversationStore = { append: async () => ({ recorded: 0, duplicate: 0 }), read: async () => [], contactsSince: async () => [] };

describe("utterancesOf: un mensaje por texto del lote, sin identificadores", () => {
  it("clasifica cada texto, marca los saludos y deja afuera lo que no es texto", () => {
    const { utterances, mediaSkipped } = utterancesOf([text("w1", "hola"), { messageId: "w2", kind: "IMAGE" }, text("w3", "cuanto cuesta un hemograma?"), { messageId: "w4", kind: "AUDIO" }]);
    expect(utterances).toEqual([{ topic: "SOCIAL", text: "hola" }, { topic: "RECIPE_OR_QUOTE", text: "cuanto cuesta un hemograma?" }]);
    expect(mediaSkipped).toBe(2);
    expect(JSON.stringify(utterances)).not.toMatch(/"id"|"goal"|"carried"|U1|P1/);
  });

  it("un mensaje de salud llega con su texto y el tema MEDICAL", () => {
    expect(utterancesOf([text("w1", "me duele mucho el pecho y tengo fiebre")]).utterances).toEqual([{ topic: "MEDICAL", text: "me duele mucho el pecho y tengo fiebre" }]);
  });

  it("un texto que las reglas dejan en OTHER pero habla del laboratorio se marca OTHER_LAB (nunca se calla); el verdaderamente ajeno queda OTHER", () => {
    const { utterances } = utterancesOf([text("w1", "jajaja mira el partido de anoche"), text("w2", "tengo turno con el dentista")]);
    expect(utterances.map((x) => x.topic)).toEqual(["OTHER", "OTHER_LAB"]);
  });

  it("acota la cantidad de textos y el largo de cada uno (un pedido largo llega casi entero)", () => {
    const many = utterancesOf(Array.from({ length: 10 }, (_, i) => text(`w${i}`, `quiero cotizar ${"x".repeat(2000)}`)));
    expect(many.utterances).toHaveLength(PREPARE_LIMITS.maxTexts);
    expect(many.utterances.every((x) => x.text.length <= 1500)).toBe(true);
  });
});

describe("prepareAgentTurn", () => {
  it("sin ningún texto no hay nada que decidir (los audios, fotos y documentos siguen su ruta de siempre)", async () => {
    expect(await prepareAgentTurn(base, "59170000001", [{ messageId: "w1", kind: "IMAGE" }])).toEqual({ kind: "skip", reason: "NO_TEXT", mediaSkipped: 1 });
  });

  it("SALUD sin pedir precio: no se conversa con el modelo (lo atiende el modo esencial, determinista); con un pedido de precio en el mismo mensaje sí se atiende", async () => {
    expect(await prepareAgentTurn(base, "59170000001", [text("w1", "me duele el pecho y tengo fiebre")])).toMatchObject({ kind: "skip", reason: "MEDICAL" });
    expect(await prepareAgentTurn(base, "59170000001", [text("w1", "tengo diabetes, cuanto cuesta la glucosa?")])).toMatchObject({ kind: "ready" });
  });

  it("incluye los mensajes recientes del historial SIN pagos (del paciente, de la recepción ni del asistente); un fallo del historial no detiene la decisión", async () => {
    const recent = vi.fn(async () => [
      { from: "PATIENT" as const, text: "hola, quiero cotizar hemograma y pago con qr" },
      { from: "ASSISTANT" as const, text: "Puedes pagar con tarjeta o efectivo." },
      { from: "STAFF" as const, text: "ya te atiendo" }
    ]);
    const ready = await prepareAgentTurn({ ...base, recent }, "59170000001", [text("w9", "gracias")]);
    expect(ready).toMatchObject({ kind: "ready", contactKey: KEY });
    if (ready.kind !== "ready") throw new Error("debía estar listo");
    expect(ready.recent).toEqual([{ from: "PATIENT", text: "hola, quiero cotizar hemograma" }, { from: "STAFF", text: "ya te atiendo" }]);
    expect(recent).toHaveBeenCalledWith({ from: "59170000001", messageId: "w9", contactKey: KEY, excludeIds: ["w9"] });
    const failing = await prepareAgentTurn({ ...base, recent: async () => { throw new Error("sin historial"); } }, "59170000001", [text("w1", "hola")]);
    expect(failing).toMatchObject({ kind: "ready", recent: [] });
  });

  it("las herramientas dependen de lo configurado: sin conocimiento no hay lab_info; sin cotización no hay quote_studies; con memoria y contacto hay conversation_state", () => {
    const names = (options: Partial<Parameters<typeof buildAgentTools>[0]>, contactKey: string | null = KEY) => buildAgentTools({ ...base, ...options }, contactKey ?? undefined).list().map((tool) => tool.name);
    const answer = async (): Promise<KnowledgeAnswer | undefined> => undefined;
    expect(names({})).toEqual(["find_studies", "quote_studies"]);
    expect(names({ answer })).toEqual(["lab_info", "find_studies", "quote_studies"]);
    expect(names({ answer, capabilities: { handoff: false, quote: false } })).toEqual(["lab_info", "find_studies"]);
    expect(names({ answer, reader: createConversationReader({ store: emptyStore }) })).toEqual(["lab_info", "find_studies", "quote_studies", "conversation_state"]);
    expect(names({ answer, reader: createConversationReader({ store: emptyStore }) }, null)).toEqual(["lab_info", "find_studies", "quote_studies"]);
  });
});

describe("el registro técnico de una decisión: solo códigos y contadores", () => {
  it("lleva el estado, las herramientas con su motivo, el plan ilegible y el error del modelo con su etapa; nunca texto", () => {
    const decision: AgentDecision = {
      status: "REJECTED",
      toolRuns: [{ tool: "lab_info", ok: false, error: "NO_DATA", why: "NO_TOPIC", factIds: [] }, { tool: "quote_studies", ok: true, factIds: ["quote_studies:1"] }],
      facts: [],
      violations: [{ code: "UNGROUNDED_FIGURE", detail: "20:00" }],
      planFallback: "plan_not_json",
      repairs: 1,
      firstViolations: [{ code: "PRICE_OUTSIDE_QUOTE" }],
      reply: "Texto de Maria Perez con 71234567",
      quoted: true,
      modelError: { cause: "INVALID_OUTPUT", stage: "respond", reason: "empty" },
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, calls: 2 }
    };
    const log = summarizeDecision(decision, { utterances: 1, mediaSkipped: 0, latencyMs: 12, model: "modelo-x" });
    expect(log).toMatchObject({
      status: "REJECTED", utterances: 1, tools: [{ tool: "lab_info", ok: false, error: "NO_DATA", why: "NO_TOPIC" }, { tool: "quote_studies", ok: true }], violations: ["UNGROUNDED_FIGURE"],
      planFallback: "plan_not_json", repairs: 1, firstViolations: ["PRICE_OUTSIDE_QUOTE"], withQuote: true, modelError: { cause: "INVALID_OUTPUT", stage: "respond", reason: "empty" }, model: "modelo-x"
    });
    expect(JSON.stringify(log)).not.toMatch(/Maria|71234567|20:00/);
  });
});
