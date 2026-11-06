import { describe, expect, it } from "vitest";
import type { Act, AgentModel, Fact, PlanInput, RespondInput, Utterance } from "../src/agent/contracts.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { createToolRegistry, labInfoTool } from "../src/agent/tools.js";
import { isPaymentOnly, stripPaymentTalk } from "../src/payment-talk.js";
import { answerFromKnowledge } from "../src/knowledge-answers.js";
import { KnowledgeService } from "../src/knowledge/index.js";
import { classifyText } from "../src/text-handler.js";
import { branch, MemoryStore, payment, schedule, T0 } from "./support/knowledge-fixtures.js";

// Métodos de pago IGNORADOS (no bloqueados): hasta que se implementen, nadie dice nada de cómo pagar (ni «sí se puede pagar con QR» ni montos), y el resto del mensaje se atiende como siempre.

const keep = (clause: string) => { const category = classifyText(clause); return category === "MEDICAL" || category === "HUMAN_REQUEST"; };

describe("stripPaymentTalk / isPaymentOnly: el texto del paciente", () => {
  it.each([
    ["se puede pagar con qr?", true],
    ["aceptan tarjeta?", true],
    ["voy a pagar por QR", true],
    ["puedo pagar en efectivo", true],
    ["cuales son los metodos de pago", true],
    ["hacen transferencia?", true],
    ["ya pagué", true],
    ["hola, quiero cotizar hemograma", false],
    ["cuanto pago por un hemograma?", false],
    ["quiero hablar con una persona para el pago", false],
    ["hola", false]
  ])("«%s» → solo de pagos: %s", (text, expected) => expect(isPaymentOnly(text, { keep }), text).toBe(expected));

  it("quita solo las frases de pago y deja el resto (varios mensajes y mensajes mezclados)", () => {
    expect(stripPaymentTalk("quiero cotizar hemograma y glucosa y pago con qr", { keep })).toBe("quiero cotizar hemograma y glucosa");
    expect(stripPaymentTalk("a que hora abren y se puede pagar con qr?", { keep })).toBe("a que hora abren");
    expect(stripPaymentTalk("quiero un hemograma, pagaré con tarjeta. gracias", { keep })).toBe("quiero un hemograma, gracias");
    expect(stripPaymentTalk("quiero cotizar hemograma", { keep })).toBe("quiero cotizar hemograma");
  });

  it("no toca una pregunta de PRECIO aunque diga «pago», ni salud ni pedir a una persona", () => {
    expect(stripPaymentTalk("cuanto pago por un hemograma?", { keep })).toBe("cuanto pago por un hemograma?");
    expect(stripPaymentTalk("me duele el pecho y pagaré con tarjeta", { keep })).toBe("me duele el pecho");
    expect(stripPaymentTalk("quiero hablar con una persona para el pago", { keep })).toBe("quiero hablar con una persona para el pago");
  });

  it("el texto que escribe el modelo se recorta por ORACIONES (no se parte una oración a medias)", () => {
    expect(stripPaymentTalk("Abrimos de 07:00 a 18:00. Y sí, puedes pagar con QR o tarjeta.", { split: "sentence" })).toBe("Abrimos de 07:00 a 18:00.");
    expect(stripPaymentTalk("Sí, puedes pagar con QR.", { split: "sentence" })).toBe("");
  });
});

describe("el agente nuevo ignora los pagos", () => {
  const HOURS: Fact = { id: "lab_info:1", source: "LAB_INFO", text: "Horario: lunes a viernes de 07:00 a 18:00.", refs: [] };
  const u = (id: string, text: string): Utterance => ({ id, topic: "INFO_REQUEST", goal: "LAB_INFO", text });
  const model = (text: string): AgentModel => ({
    async plan(_input: PlanInput) { return { toolCalls: [{ tool: "lab_info", input: { question: "horario" } }] }; },
    async respond(_input: RespondInput) { return { acts: [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] } as Act], text }; }
  });
  const tools = createToolRegistry([labInfoTool({ answer: async () => ({ status: "ANSWERED", body: HOURS.text, refs: [], topics: ["HOURS"], unavailable: [] }) as never })]);

  it("si el modelo menciona los pagos, esas oraciones se ignoran: el mensaje sale igual, con lo demás", async () => {
    const decision = await runAgentTurn({ model: model("Abrimos lunes a viernes de 07:00 a 18:00. Y sí, puedes pagar con QR."), tools }, { utterances: [u("U1", "horario y pago")] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toBe("Abrimos lunes a viernes de 07:00 a 18:00.");
  });

  it("si lo único que dijo eran pagos, no queda nada que enviar: se rechaza (responde el agente de siempre)", async () => {
    const decision = await runAgentTurn({ model: model("Sí, puedes pagar con QR."), tools }, { utterances: [u("U1", "se puede pagar con qr")] });
    expect(decision.status).toBe("REJECTED");
    expect(decision.reply).toBeUndefined();
  });
});

describe("conocimiento aprobado con skipPayment (la herramienta lab_info del agente nuevo y el agente de siempre)", () => {
  const service = () => new KnowledgeService({ store: new MemoryStore({ revision: 1, items: [branch(), schedule(), payment("efectivo")] }), now: () => T0 });

  it("un mensaje solo de pagos no tiene respuesta; uno mixto responde lo demás sin nada de pagos", async () => {
    expect(await answerFromKnowledge("se puede pagar con qr?", { service: service(), now: () => T0, skipPayment: true })).toBeUndefined();
    const mixed = await answerFromKnowledge("a que hora abren y se puede pagar con qr?", { service: service(), now: () => T0, skipPayment: true });
    expect(mixed?.body).toBeTruthy();
    expect(mixed!.body).not.toMatch(/pago|pagar|efectivo|qr|tarjeta/i);
  });

  it("sin la opción, responde los pagos como siempre (la capacidad sigue ahí para cuando se implementen)", async () => {
    expect((await answerFromKnowledge("se puede pagar con qr?", { service: service(), now: () => T0 }))?.body).toMatch(/efectivo/i);
  });
});
