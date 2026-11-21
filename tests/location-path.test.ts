import { describe, expect, it, vi } from "vitest";
import { AT_DOOR_MESSAGE, isAtClosedDoor } from "../src/at-door.js";
import type { AuditRepository } from "../src/audit.js";
import { answerFromBusinessData } from "../src/business-answers.js";
import { detectTopics } from "../src/knowledge-answers.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Camino 3 del menú «Ubicación y horarios» (dueño, 21-nov). Frases del historial real (4–12 nov).

describe("qué cuenta como pregunta de horario o de ubicación", () => {
  it.each(["¿puedo ir mañana a las 7 de la mañana a hacerme un hemograma?", "¿Están abiertos ahora?", "¿Puedo pasar hoy en la noche?", "¿podemos ir el domingo?", "¿Atienden los domingos?"])("horario: «%s»", (text) => {
    expect(detectTopics(text).some((topic) => topic.kind === "HOURS")).toBe(true);
  });
  it.each(["¿Atienden en La Paz?", "tienen sucursal en Montero?", "¿Tienen otra sede?", "¿en qué ciudad están?", "Mañana atienden en La Paz? Su dirección por favor"])("ubicación (otra ciudad o sede): «%s»", (text) => {
    expect(detectTopics(text).some((topic) => topic.kind === "LOCATION")).toBe(true);
  });
  it.each(["Quiero cotizar un hemograma", "¿Cuánto cuesta la glucosa?"])("no es horario ni ubicación: «%s»", (text) => {
    expect(detectTopics(text).some((topic) => topic.kind === "HOURS" || topic.kind === "LOCATION")).toBe(false);
  });
});

describe("datos aprobados que llegan al agente", () => {
  it("otra ciudad: la sede única, con la dirección y el mapa", () => {
    const answer = answerFromBusinessData("¿Atienden en La Paz?");
    expect(answer?.body).toContain("Es la ÚNICA sede de PLUSMEDIK");
    expect(answer?.body).toContain("Calle Cuellar casi esquina Santa Bárbara");
    expect(answer?.body).toContain("https://maps.app.goo.gl/DU3r4eedeEWKHHZ2A");
  });
  it("«¿puedo ir mañana a las 7?»: el horario de 24 horas", () => {
    expect(answerFromBusinessData("¿puedo ir mañana a las 7 de la mañana?")?.body).toContain("las 24 horas, todos los días del año");
  });
  it("el precio es el mismo a cualquier hora (va con el horario)", () => {
    expect(answerFromBusinessData("¿el precio cambia según el horario?")?.body).toContain("El precio de los estudios es el mismo a cualquier hora y cualquier día.");
  });
});

describe("alguien está en la puerta y la encuentra cerrada", () => {
  it.each([
    "Estoy esperando aquí afuera y la puerta esta cerrado",
    "ya estoy en la puerta y está cerrado",
    "Llegué al laboratorio y no me abren",
    "toco el timbre y nadie sale",
    "estamos afuera, está cerrado?",
    "nadie me abre la puerta"
  ])("SÍ: «%s»", (text) => {
    expect(isAtClosedDoor(text)).toBe(true);
  });
  it.each([
    "¿A qué hora cierran?",
    "la otra vez estaba cerrado",
    "ayer fui y estaba cerrado",
    "Estoy afuera de Santa Cruz, tienen sucursal?",
    "el frasco tiene que estar cerrado?",
    "estoy en la puerta",
    "la muestra va en un tubo cerrado, estoy afuera esperando al yango"
  ])("no: «%s»", (text) => {
    expect(isAtClosedDoor(text)).toBe(false);
  });

  const from = "59170000002";
  const lease = { owner: "owner", fence: 1 };
  const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });
  const build = (withCrm: boolean) => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-d", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const handler = vi.fn(async () => ({ body: "NO DEBE SALIR" }));
    const submit = vi.fn(async () => [{ state: "REGISTERED" }]);
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(),
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      log: vi.fn(),
      turns: { handlers: { text: handler }, contactKeyFor: () => "b".repeat(64), ...(withCrm ? { crmHandoff: { submit, submitSessionReview: vi.fn() } } : {}) } as unknown as NonNullable<QuoteDeps["turns"]>
    } as unknown as QuoteDeps;
    return { deps, sendText, handler, submit, audit };
  };
  it("sale el texto fijo del dueño (sin modelo); sin CRM igual", async () => {
    const { deps, sendText, handler } = build(false);
    await processTurns([turn("Estoy esperando aquí afuera y la puerta esta cerrado", "d-1")], deps);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toBe(AT_DOOR_MESSAGE);
    expect(AT_DOOR_MESSAGE).toBe("Espéranos un momento, por favor 🙏 Acabo de informar al personal, en un momento llega.");
    expect(handler).not.toHaveBeenCalled();
  });
  it("con la cola al CRM, el caso va con la etiqueta AT_DOOR", async () => {
    const { deps, submit } = build(true);
    await processTurns([turn("Llegué al laboratorio y no me abren", "d-2")], deps);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0] as unknown as [unknown, Array<{ label: string; kapsoMessageId: string }>])[1][0]).toMatchObject({ label: "AT_DOOR", kapsoMessageId: "d-2" });
  });
  it("es lo más urgente del lote: UNA sola respuesta aunque venga junto con otra cosa (también resultados)", async () => {
    const { deps, sendText, handler, audit } = build(false);
    await processTurns([turn("Buenas, vengo a recoger mis resultados", "d-3"), turn("estoy en la puerta y está cerrado", "d-4")], deps);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect((sendText.mock.calls[0] as unknown as [string, string])[1]).toBe(AT_DOOR_MESSAGE);
    expect(handler).not.toHaveBeenCalled();
    expect(audit.recordIgnored).toHaveBeenCalledTimes(1);
  });
});
