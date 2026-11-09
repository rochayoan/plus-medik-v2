import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { groundedQuoteCalls, operationalPlan } from "../src/agent/intent-guard.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { createToolRegistry } from "../src/agent/tools.js";
import type { AgentModel, Utterance } from "../src/agent/contracts.js";

const u = (text: string): Utterance => ({ text, topic: "OTHER_LAB" });
const caps = { handoff: false, quote: true };

describe("auditoría noviembre: prioridad a las solicitudes reales del paciente", () => {
  it("los horarios y la disponibilidad administrativa se consultan sin planificador generativo", async () => {
    const plan = vi.fn(async () => ({ toolCalls: [] }));
    const respond = vi.fn(async () => ({ text: "No tengo ese horario confirmado." }));
    const query = vi.fn(async () => ({ noData: "NO_APPROVED_DATA" }));
    const model: AgentModel = { plan, respond };
    const tools = createToolRegistry([{
      name: "lab_info", description: "conocimiento aprobado", readOnly: true,
      input: z.object({ question: z.string().min(2).max(300) }).strict(), run: query
    }]);
    for (const msg of ["¿A qué hora abren?", "¿Cuándo estarán mis resultados?", "¿Me pasan el enlace de mis resultados?"]) {
      const result = await runAgentTurn({ model, tools }, { utterances: [u(msg)] });
      expect(result.status).toBe("VERIFIED");
      expect(result.quoted).toBeUndefined();
      expect(result.usage?.calls).toBe(1);
    }
    expect(plan).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("una consulta de resultados no puede convertirse en cotización por un plan equivocado", () => {
    const plan = operationalPlan([u("Quisiera el enlace para mis resultados, adjunto comprobante")], [{ name: "lab_info" }, { name: "quote_studies" }], caps);
    expect(plan?.toolCalls).toEqual([{ tool: "lab_info", input: { question: "Quisiera el enlace para mis resultados, adjunto comprobante" } }]);
    expect(plan?.handoff).toBeUndefined();
  });

  it("puerta cerrada: derivación solo con capacidad registrada; nunca dispara cotización", () => {
    const input = [u("Estoy afuera del laboratorio y la puerta está cerrada")];
    expect(operationalPlan(input, [{ name: "lab_info" }], { handoff: true, quote: true }))
      .toMatchObject({ handoff: "OUT_OF_SCOPE", toolCalls: [{ tool: "lab_info" }] });
    expect(operationalPlan(input, [{ name: "lab_info" }], caps)?.handoff).toBeUndefined();
  });

  it("una solicitud explícita de precio con horarios sigue por el motor de cotización", () => {
    expect(operationalPlan([u("Cuánto cuesta un hemograma y cuáles son los horarios?")], [{ name: "lab_info" }], caps)).toBeUndefined();
  });

  it("descarta TODOS los estudios sugeridos si alguno no apareció en el contexto del paciente", () => {
    const calls = [{ tool: "quote_studies", input: { studies: ["hemograma", "ácido úrico"] } }];
    expect(groundedQuoteCalls(calls, [u("Cotiza hemograma completo")], [])).toEqual({ calls: [], rejected: true });
    expect(groundedQuoteCalls([{ tool: "quote_studies", input: { studies: ["hemograma"] } }], [u("Cotiza hemograma completo")], []))
      .toMatchObject({ rejected: false });
  });

  it("permite estudios de mensajes previos del paciente, nunca de otra persona", () => {
    const calls = [{ tool: "quote_studies", input: { studies: ["glucosa"] } }];
    expect(groundedQuoteCalls(calls, [u("Sí, cotiza el último")], [{ from: "PATIENT", text: "Glucosa" }]).rejected).toBe(false);
    expect(groundedQuoteCalls(calls, [u("Sí, cotiza el último")], [{ from: "STAFF", text: "Glucosa" }]).rejected).toBe(true);
  });

  it("saludos no cambian de flujo y siguen usando planificación actual", () => {
    expect(operationalPlan([u("Hola buenas tardes")], [{ name: "lab_info" }], caps)).toBeUndefined();
  });
});
