import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../src/audit.js";
import { HUMAN_REQUEST_MESSAGE, isHumanRequest, waitingForPerson } from "../src/human-request.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Camino 5 del menú «Hablar con una persona» (dueño, 21-nov).

describe("qué es pedir una persona", () => {
  it.each(["Quiero hablar con una persona", "Quisiera hablar con una persona porfavor", "Me comunica con un asesor por favor", "necesito hablar con la doctora", "me pueden llamar por favor", "quiero atención humana"])("SÍ: «%s»", (text) => {
    expect(isHumanRequest(text)).toBe(true);
  });
  it.each(["Quiero cotizar un hemograma", "¿La doctora atiende hoy?", "una persona puede recoger mis resultados?", "hola"])("no: «%s»", (text) => {
    expect(isHumanRequest(text)).toBe(false);
  });
  it("se espera a la persona si el texto fijo está en los mensajes recientes del asistente", () => {
    expect(waitingForPerson([{ from: "ASSISTANT", text: HUMAN_REQUEST_MESSAGE }, { from: "PATIENT", text: "es por una cotización" }])).toBe(true);
    expect(waitingForPerson([{ from: "ASSISTANT", text: "¡Hola! ¿En qué te ayudo?" }])).toBe(false);
  });
});

describe("por los turnos", () => {
  const from = "59170000004";
  const lease = { owner: "owner", fence: 1 };
  const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });
  const build = (waiting: boolean, withCrm = false, pilot = true) => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-p", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const handler = vi.fn(async () => ({ body: "Respuesta del manejador" }));
    const submit = vi.fn(async () => [{ state: "REGISTERED" }]);
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => { throw new Error("sin análisis"); }),
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      log: vi.fn(),
      turns: { handlers: { text: handler }, contactKeyFor: () => "d".repeat(64), waitingForPerson: vi.fn(async () => waiting), agentPilot: { isPilot: () => pilot, produce: vi.fn(async () => undefined) }, ...(withCrm ? { crmHandoff: { submit, submitSessionReview: vi.fn() } } : {}) } as unknown as NonNullable<QuoteDeps["turns"]>
    } as unknown as QuoteDeps;
    return { deps, sendText, handler, submit };
  };
  it("el pedido recibe el texto fijo (sin modelo), aunque no haya CRM", async () => {
    const { deps, sendText, handler } = build(false);
    await processTurns([turn("Quiero hablar con una persona", "p-1")], deps);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toBe(HUMAN_REQUEST_MESSAGE);
    expect(handler).not.toHaveBeenCalled();
  });
  it("con la cola al CRM, el caso va como HUMAN_REQUEST", async () => {
    const { deps, submit } = build(false, true);
    await processTurns([turn("Me comunica con un asesor por favor", "p-2")], deps);
    expect((submit.mock.calls[0] as unknown as [unknown, Array<{ reasons: string[] }>])[1][0]!.reasons).toEqual(["HUMAN_REQUEST"]);
  });
  it("mientras se espera a la persona (24 h), el agente calla con todo: cotizaciones, fotos, otro pedido", async () => {
    for (const batch of [[turn("Quiero cotizar un hemograma", "p-3")], [{ kind: "IMAGE", from, messageId: "p-4", mediaId: "m" } as IncomingTurn], [turn("Quiero hablar con una persona", "p-5")]]) {
      const { deps, sendText, handler } = build(true);
      await processTurns(batch, deps);
      expect(sendText).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
  });
  it("un contacto fuera del agente conversacional sigue la ruta de respaldo de siempre", async () => {
    const { deps, sendText, handler } = build(true, false, false);
    await processTurns([turn("Quiero hablar con una persona", "p-7")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).not.toBe(HUMAN_REQUEST_MESSAGE);
  });
  it("sin pedido ni espera, todo sigue como siempre", async () => {
    const { deps, handler } = build(false);
    await processTurns([turn("Quiero cotizar un hemograma", "p-6")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
