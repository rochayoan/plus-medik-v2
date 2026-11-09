import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { filterAdministrativeQuoteCalls } from "../src/agent/intent-guard.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { createToolRegistry } from "../src/agent/tools.js";
import type { AgentModel, Utterance } from "../src/agent/contracts.js";

const u = (text: string): Utterance => ({ text, topic: "INFO_REQUEST" });

describe("Plusmedik: resultados administrativos no son cotizaciones", () => {
  it("bloquea quote_studies erróneo cuando solo solicitan un enlace de resultados", async () => {
    const wronglyQuoted = vi.fn(async () => ({ facts: [{ source: "QUOTE_ENGINE" as const, text: "cotizado", refs: [] }], blocks: ["COTIZACIÓN INCORRECTA"] }));
    const knowledge = vi.fn(async () => ({ noData: "NO_APPROVED_DATA" }));
    const model: AgentModel = {
      plan: vi.fn(async () => ({ toolCalls: [
        { tool: "quote_studies", input: { studies: ["hemograma"] } },
        { tool: "lab_info", input: { question: "¿Dónde veo mis resultados?" } }
      ] })),
      respond: vi.fn(async () => ({ text: "No tengo ese enlace de resultados confirmado." }))
    };
    const tools = createToolRegistry([
      { name: "quote_studies", description: "precios", readOnly: true, input: z.object({ studies: z.array(z.string()) }).strict(), run: wronglyQuoted },
      { name: "lab_info", description: "conocimiento aprobado", readOnly: true, input: z.object({ question: z.string() }).strict(), run: knowledge }
    ]);
    const result = await runAgentTurn({ model, tools }, { utterances: [u("¿Me pasan el enlace de mis resultados?")] });
    expect(result.status).toBe("VERIFIED");
    expect(result.quoted).toBeUndefined();
    expect(result.reply).not.toContain("COTIZACIÓN INCORRECTA");
    expect(result.planFallback).toBe("administrative_quote_suppressed");
    expect(wronglyQuoted).not.toHaveBeenCalled();
    expect(knowledge).toHaveBeenCalledTimes(1);
    expect(result.usage?.calls).toBe(2);
  });

  it("permite cotizar si el paciente pide un precio incluso con la palabra resultados", () => {
    const calls = [{ tool: "quote_studies", input: { studies: ["hemograma"] } }];
    expect(filterAdministrativeQuoteCalls(calls, [u("¿Cuánto cuesta un hemograma y cuándo están los resultados?")])).toEqual({ calls, suppressed: false });
  });

  it("preserva la continuidad de la última cotización y los aliases del catálogo", () => {
    const calls = [{ tool: "quote_studies", input: { studies: ["creatinina en orina"] } }];
    expect(filterAdministrativeQuoteCalls(calls, [u("Sí, lo mismo de la última cotización")])).toEqual({ calls, suppressed: false });
  });

  it("no altera estudios nombrados en un nuevo pedido", () => {
    const calls = [{ tool: "quote_studies", input: { studies: ["hemograma"] } }];
    expect(filterAdministrativeQuoteCalls(calls, [u("Necesito hemograma completo")])).toEqual({ calls, suppressed: false });
  });

  it("un comprobante para resultados no activa el motor de recetas", () => {
    const calls = [{ tool: "quote_studies", input: { studies: ["glucosa"] } }];
    expect(filterAdministrativeQuoteCalls(calls, [u("Adjunto comprobante para descargar mis resultados")])).toEqual({ calls: [], suppressed: true });
  });
});
