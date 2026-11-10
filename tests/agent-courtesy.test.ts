import { describe, expect, it, vi } from "vitest";
import { isCourtesyOnly } from "../src/agent/courtesy.js";
import { runAgentTurn } from "../src/agent/pipeline.js";

describe("cortesías que no merecen respuesta", () => {
  it.each(["gracias", "Muchas gracias!", "ok gracias", "gracias, hasta luego", "ya me atendieron gracias", "Ya me atendieron", "👍", "jajaja"])("«%s» se calla", (text) => {
    expect(isCourtesyOnly(text)).toBe(true);
  });
  it.each(["hola", "buenas tardes", "ok", "listo", "sí", "gracias, cuánto cuesta el hemograma", "gracias, quiero hablar con una persona", "gracias?", "ya me atendieron pero quiero cotizar", "no gracias, mejor otro estudio", ""])("«%s» NO se calla", (text) => {
    expect(isCourtesyOnly(text)).toBe(false);
  });
  it("el agente no llama al modelo ante un agradecimiento y cierra el turno en silencio", async () => {
    const model = { plan: vi.fn(), respond: vi.fn() };
    const decision = await runAgentTurn({ model: model as never, tools: {} as never }, { utterances: [{ text: "gracias", topic: "OTHER" }], recent: [{ from: "ASSISTANT", text: "Listo, ahí tienes la cotización." }] });
    expect(decision.status).toBe("SILENT");
    expect(model.plan).not.toHaveBeenCalled();
    expect(model.respond).not.toHaveBeenCalled();
  });
});
