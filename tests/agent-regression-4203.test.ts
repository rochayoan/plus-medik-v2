import { describe, expect, it } from "vitest";
import type { AgentModel } from "../src/agent/contracts.js";
import { answerFromKnowledge } from "../src/knowledge-answers.js";
import { KnowledgeService } from "../src/knowledge/index.js";
import { createAgentModel, parseActs, parsePlanFull, PLAN_INSTRUCTIONS, type AgentClient } from "../src/agent/openai.js";
import { branch, MemoryStore, schedule, T0 } from "./support/knowledge-fixtures.js";
import { AgentOutputError, runAgentTurn } from "../src/agent/pipeline.js";
import { createToolRegistry, quoteStudiesTool } from "../src/agent/tools.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

// Regresión de la prueba real del 6-nov (contacto …4203): intención QUOTE, quote_studies y lab_info en NO_DATA, y luego agent_pilot MODEL_ERROR con modelError.cause=INVALID_OUTPUT (se respondió por el modo esencial).
// Causas comprobadas: (1) quote_studies le pasaba al motor SOLO los nombres de estudios, sin ninguna palabra de pedido: un nombre que no está en el catálogo (o con una errata) no contaba como pedido y la herramienta
// devolvía «nada» (NO_DATA) en vez de decir que no pudo identificarlo; (2) el esquema estricto permite etiquetas cruzadas (DEFER con un motivo de derivación, CLARIFY sin código) y el parseo las rechazaba enteras.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null }) as unknown as CatalogStudy;
const CATALOG = [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5)];
const ctx = { now: new Date("2026-11-06T09:00:00Z") };

describe("quote_studies: un nombre que no se encuentra NO es «sin datos»", () => {
  const quote = quoteStudiesTool({ loadCatalog: async () => CATALOG });

  it("estudios que no están en el catálogo (o con errata) devuelven un hecho «no se pudo identificar», sin bloque ni precios, para que el agente pregunte", async () => {
    for (const studies of [["perfil tiroideo completo"], ["hemogrma"], ["ecografia abdominal", "resonancia"]]) {
      const result = await quote.run({ studies }, ctx);
      expect(result, studies.join(",")).toBeDefined();
      expect(result!.blocks ?? []).toEqual([]);
      expect(result!.facts.some((fact) => /No se pudo identificar con certeza \d+ estudio/.test(fact.text))).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/\b45\b|30[.,]5|Bs/);
    }
  });

  it("lo que ya funcionaba sigue igual: nombres del catálogo se cotizan, uno seguro junto a uno desconocido es PARCIAL", async () => {
    expect((await quote.run({ studies: ["hemograma", "glucosa"] }, ctx))?.blocks).toHaveLength(1);
    const partial = await quote.run({ studies: ["hemograma", "perfil tiroideo completo"] }, ctx);
    expect(partial?.blocks).toHaveLength(1);
    expect(partial!.facts.some((fact) => /PARCIAL/.test(fact.text))).toBe(true);
  });
});

describe("la respuesta estructurada: etiquetas cruzadas se normalizan en vez de invalidar todo el turno", () => {
  const reply = (act: Record<string, unknown>) => JSON.stringify({ acts: [{ utterances: ["U1"], factIds: [], code: null, reason: null, ...act }], text: "No encontré ese estudio en el catálogo. ¿Me dices cómo se llama exactamente?" });

  it("DEFER con un motivo de derivación (u omitido) conserva el acto; CLARIFY sin código usa SPECIFY_REQUEST; HANDOFF con un motivo de aplazo usa OUT_OF_SCOPE", () => {
    expect(parseActs(reply({ kind: "DEFER", reason: "OUT_OF_SCOPE" })).acts).toEqual([{ kind: "DEFER", utterances: ["U1"], reason: "NOT_SUPPORTED" }]);
    expect(parseActs(reply({ kind: "DEFER", reason: "HUMAN_REQUEST" })).acts[0]).toMatchObject({ kind: "DEFER", reason: "NOT_SUPPORTED" });
    expect(parseActs(reply({ kind: "DEFER", reason: null })).acts[0]).toMatchObject({ kind: "DEFER", reason: "NO_DATA" });
    expect(parseActs(reply({ kind: "DEFER", reason: "NO_DATA" })).acts[0]).toMatchObject({ kind: "DEFER", reason: "NO_DATA" });
    expect(parseActs(reply({ kind: "CLARIFY", code: null })).acts).toEqual([{ kind: "CLARIFY", utterances: ["U1"], code: "SPECIFY_REQUEST" }]);
    expect(parseActs(reply({ kind: "CLARIFY", code: "WHICH_STUDY" })).acts[0]).toMatchObject({ code: "WHICH_STUDY" });
    expect(parseActs(reply({ kind: "HANDOFF", reason: "NO_DATA" })).acts[0]).toMatchObject({ kind: "HANDOFF", reason: "OUT_OF_SCOPE" });
  });

  it("lo que sigue siendo salida inválida (no es JSON, forma incorrecta, tipo de acto desconocido) falla con un MOTIVO en código y el detalle del campo, nunca con datos del paciente", () => {
    const reasonOf = (fn: () => unknown) => { try { fn(); } catch (error) { return error as AgentOutputError; } return undefined; };
    const notJson = reasonOf(() => parseActs("esto no es json con datos de Maria Perez"));
    expect(notJson).toBeInstanceOf(AgentOutputError);
    expect(notJson!.reason).toBe("not_json");
    const shape = reasonOf(() => parseActs(JSON.stringify({ acts: [{ kind: "INVENTADO", utterances: ["U1"], factIds: [], code: null, reason: null }], text: "Maria Perez 71234567" })));
    expect(shape!.reason).toBe("respond_shape");
    expect(shape!.detail).toBe("acts.0.kind:invalid_value");
    expect(JSON.stringify([shape!.reason, shape!.detail, shape!.message])).not.toMatch(/Maria|71234567/);
    const plan = reasonOf(() => parsePlanFull(JSON.stringify({ toolCalls: "no", intents: [] })));
    expect(plan!.reason).toBe("plan_shape");
    expect(plan!.detail).toMatch(/^toolCalls/);
  });
});

describe("el registro técnico de INVALID_OUTPUT lleva el motivo y la etapa", () => {
  const tools = createToolRegistry([]);
  const u = [{ id: "U1", topic: "RECIPE_OR_QUOTE", goal: "QUOTE" as const, text: "cotiza perfil tiroideo" }];

  it("un fallo en la respuesta queda como {cause: INVALID_OUTPUT, stage: respond, reason, detail}; un fallo en el plan, stage: plan", async () => {
    const badRespond: AgentModel = { async plan() { return { toolCalls: [] }; }, async respond() { throw new AgentOutputError("respond_shape", "acts.0.kind:invalid_value", "respond"); } };
    const a = await runAgentTurn({ model: badRespond, tools }, { utterances: u });
    expect(a.status).toBe("MODEL_ERROR");
    expect(a.modelError).toEqual({ cause: "INVALID_OUTPUT", stage: "respond", reason: "respond_shape", detail: "acts.0.kind:invalid_value" });
    const badPlan: AgentModel = { async plan() { throw new AgentOutputError("not_json", undefined, "plan"); }, async respond() { throw new Error("no debía llamarse"); } };
    const b = await runAgentTurn({ model: badPlan, tools }, { utterances: u });
    expect(b.modelError).toEqual({ cause: "INVALID_OUTPUT", stage: "plan", reason: "not_json" });
    // un error cualquiera (sin forma de salida) sigue sin exponer su mensaje
    const c = await runAgentTurn({ model: { async plan() { throw new Error("secreto de Maria Perez"); }, async respond() { return { acts: [], text: "" }; } }, tools }, { utterances: u });
    expect(JSON.stringify(c.modelError)).not.toMatch(/secreto|Maria/);
  });
});

describe("lab_info y las preguntas de precio", () => {
  it("el conocimiento aprobado no tiene tema de precios: una pregunta de precio da «sin datos» (comportamiento esperado, no un fallo) y el plan ya no debe llamar a lab_info para eso", async () => {
    const service = new KnowledgeService({ store: new MemoryStore({ revision: 1, items: [branch(), schedule()] }), now: () => T0 });
    expect(await answerFromKnowledge("cuanto cuesta el perfil tiroideo completo", { service, now: () => T0 })).toBeUndefined();
    expect(PLAN_INSTRUCTIONS).toMatch(/NO la uses para precios ni cotizaciones/);
  });
});

describe("de punta a punta con el adaptador real (cliente simulado): la salida con etiquetas cruzadas ya no tumba el turno", () => {
  it("QUOTE sin datos y un DEFER con motivo de derivación → el mensaje honesto sale verificado (antes: MODEL_ERROR INVALID_OUTPUT y modo esencial)", async () => {
    const outputs = [
      JSON.stringify({ toolCalls: [{ tool: "quote_studies", text: null, studies: ["perfil tiroideo completo"] }], intents: [{ utterance: "U1", intent: "QUOTE" }] }),
      JSON.stringify({ acts: [{ kind: "DEFER", utterances: ["U1"], factIds: [], code: null, reason: "OUT_OF_SCOPE" }], text: "No encontré ese estudio en el catálogo. ¿Me dices cómo se llama exactamente?" })
    ];
    const client: AgentClient = { run: async () => ({ text: outputs.shift()!, usage: { inputTokens: 10, outputTokens: 5 } }) };
    const tools = createToolRegistry([quoteStudiesTool({ loadCatalog: async () => CATALOG })]);
    const decision = await runAgentTurn({ model: createAgentModel({ client }), tools }, { utterances: [{ id: "U1", topic: "RECIPE_OR_QUOTE", goal: "QUOTE", text: "quiero cotizar un perfil tiroideo completo" }] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.modelError).toBeUndefined();
    expect(decision.toolRuns).toEqual([{ tool: "quote_studies", ok: true, factIds: ["quote_studies:1"] }]);
    expect(decision.acts).toEqual([{ kind: "DEFER", utterances: ["U1"], reason: "NOT_SUPPORTED" }]);
    expect(decision.reply).toMatch(/No encontré ese estudio/);
  });
});
