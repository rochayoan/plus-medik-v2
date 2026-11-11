import { describe, expect, it } from "vitest";
import { createAgentModel, parsePlan, PLAN_INSTRUCTIONS, RESPOND_INSTRUCTIONS, type AgentClient } from "../src/agent/openai.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { createToolRegistry, labInfoTool, quoteStudiesTool } from "../src/agent/tools.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { answerFromKnowledge } from "../src/knowledge-answers.js";
import { KnowledgeService } from "../src/knowledge/index.js";
import type { CatalogStudy } from "../src/types.js";
import { branch, MemoryStore, schedule, T0 } from "./support/knowledge-fixtures.js";

// Regresión de la prueba real del 6-nov (contacto …4203): intención QUOTE, quote_studies y lab_info en NO_DATA, y luego MODEL_ERROR con cause INVALID_OUTPUT (se respondió por el modo esencial).
// Causas comprobadas y su solución de raíz:
//   1. INVALID_OUTPUT: la respuesta del modelo era un JSON estricto de «actos» con ids y etiquetas que el parseo rechazaba entero por una etiqueta cruzada. Ahora la respuesta es TEXTO LIBRE: no existe esa clase de error.
//   2. NO_DATA de quote_studies: la herramienta pasaba al motor solo los nombres, sin palabra de pedido; un nombre fuera del catálogo (o con errata) no contaba como pedido y devolvía «nada».
//   3. «Sin datos» ya no es un fallo: pasa al modelo como una nota y se responde con honestidad.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null }) as unknown as CatalogStudy;
const CATALOG = [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5)];
const ctx = { now: new Date("2026-11-06T09:00:00Z") };

describe("quote_studies: un nombre que no se encuentra NO es «sin datos»", () => {
  const quote = quoteStudiesTool({ loadCatalog: async () => CATALOG });

  it("estudios fuera del catálogo (o con errata) devuelven un hecho «no se pudo identificar» sin precios; a lo sumo el sistema sugiere opciones parecidas (nunca una cotización con total)", async () => {
    for (const studies of [["perfil tiroideo completo"], ["hemogrma"], ["ecografia abdominal", "resonancia"]]) {
      const result = (await quote.run({ studies }, ctx)) as { facts: Array<{ text: string }>; blocks?: string[] };
      expect((result.blocks ?? []).join(" "), studies.join(",")).not.toMatch(/Cotización|Total/);
      expect(result.facts.some((fact) => /No se pudo identificar con certeza \d+ estudio/.test(fact.text))).toBe(true);
      expect(JSON.stringify(result.facts)).not.toMatch(/\b45\b|30[.,]5|Bs/);
    }
  });
});

describe("lab_info y las preguntas de precio", () => {
  it("el conocimiento aprobado no tiene tema de precios: «sin datos» es lo esperado, y el plan ya no debe llamar a lab_info para eso", async () => {
    const service = new KnowledgeService({ store: new MemoryStore({ revision: 1, items: [branch(), schedule()] }), now: () => T0 });
    expect(await answerFromKnowledge("cuanto cuesta el perfil tiroideo completo", { service, now: () => T0 })).toBeUndefined();
    expect(PLAN_INSTRUCTIONS).toMatch(/NO la uses para precios ni cotizaciones/);
  });
});

describe("de punta a punta con el adaptador real (cliente simulado)", () => {
  const run = async (outputs: string[], utterance = "quiero cotizar un perfil tiroideo completo") => {
    const queue = [...outputs];
    const client: AgentClient = { run: async () => ({ text: queue.shift()!, usage: { inputTokens: 10, outputTokens: 5 } }) };
    const tools = createToolRegistry([quoteStudiesTool({ loadCatalog: async () => CATALOG }), labInfoTool({ answer: async () => undefined })]);
    return runAgentTurn({ model: createAgentModel({ client }), tools }, { utterances: [{ topic: "RECIPE_OR_QUOTE", text: utterance }] });
  };
  const plan = (calls: unknown[] = []) => JSON.stringify({ toolCalls: calls, silent: false, handoff: null });

  it("QUOTE sin datos: el estudio no se encontró, el modelo lo sabe y el mensaje honesto sale verificado (antes: MODEL_ERROR INVALID_OUTPUT y modo esencial)", async () => {
    const decision = await run([
      plan([{ tool: "quote_studies", text: null, studies: ["perfil tiroideo completo"] }, { tool: "lab_info", text: "precio del perfil tiroideo", studies: null }]),
      "No encontré ese estudio en el catálogo. ¿Me dices cómo se llama exactamente?"
    ]);
    expect(decision.status).toBe("VERIFIED");
    expect(decision.modelError).toBeUndefined();
    expect(decision.toolRuns).toEqual([
      { tool: "quote_studies", ok: true, factIds: ["quote_studies:1"] },
      { tool: "lab_info", ok: false, error: "NO_DATA", why: "NO_TOPIC", factIds: [] }
    ]);
    expect(decision.reply).toBe("No encontré ese estudio en el catálogo. ¿Me dices cómo se llama exactamente?");
  });

  it("la respuesta es texto libre: cualquier redacción válida pasa, sin formato que respetar; ya no existe una salida «inválida» en la respuesta", async () => {
    const decision = await run([plan(), "¡Claro!\n\nCon gusto. Dime qué estudios necesitas y te ayudo — sin apuro."], "hola");
    expect(decision).toMatchObject({ status: "VERIFIED", reply: "¡Claro!\n\nCon gusto. Dime qué estudios necesitas y te ayudo — sin apuro." });
  });

  it("un plan ilegible (texto, JSON roto, forma incorrecta) NO tumba el turno: se responde sin herramientas y el motivo queda en el registro", async () => {
    for (const [bad, code] of [["claro, te ayudo", "plan_not_json"], ['{"toolCalls": "no"}', "plan_shape"]] as const) {
      const decision = await run([bad, "Con gusto, ¿qué necesitas?"], "hola");
      expect(decision.status, bad).toBe("VERIFIED");
      expect(decision.planFallback?.startsWith(code), bad).toBe(true);
      expect(decision.toolRuns).toEqual([]);
    }
    expect(parsePlan('{"toolCalls": []}').fallback).toBeUndefined();
  });

  it("las instrucciones de la respuesta no piden estructura: sin actos, ids ni formularios", () => {
    expect(RESPOND_INSTRUCTIONS).not.toMatch(/\bACK\b|\bDEFER\b|\bCLARIFY\b|factIds|\bU1\b/);
  });
});
