import { describe, expect, it, vi } from "vitest";
import type { Act, AgentModel, PlanInput, RespondInput } from "../src/agent/contracts.js";
import { pendingUtterances, SHADOW_LIMITS, utterancesOf } from "../src/agent/shadow.js";
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

  it("un texto que las reglas dejan en OTHER pero habla del laboratorio se marca OTHER_LAB (nunca se calla); el verdaderamente ajeno queda OTHER", () => {
    const { utterances } = utterancesOf([text("w1", "jajaja mira el partido de anoche"), text("w2", "tengo turno con el dentista")]);
    expect(utterances.map((x) => x.topic)).toEqual(["OTHER", "OTHER_LAB"]);
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
