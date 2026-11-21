import { describe, expect, it, vi } from "vitest";
import type { AuditRepository } from "../src/audit.js";
import { HOME_VISIT_THANKS, homeVisitMessage, homeVisitStageOf, looksLikeHomeVisitData, type HomeVisitStage } from "../src/home-visit.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Camino 4 del menú «Estudios a domicilio» (dueño, 21-nov). Frases del historial real (4–12 nov), con nombres inventados.

describe("el texto fijo", () => {
  it("avisa brevemente que el transporte va aparte y que la toma se paga antes de ir", () => {
    const text = homeVisitMessage(false);
    expect(text).toContain("el transporte tiene un costo aparte y la toma de muestra se paga antes de ir");
    expect(text).toContain("si está internado: servicio, piso y cama");
    expect(text).not.toMatch(/Bs|\d+ ?bs/i);
  });
});

describe("datos del paciente para la visita", () => {
  it.each([
    "Daniel Suárez Mora 8 años 3er piso cama 326",
    "Tercer piso de pediatría Erick López Rivas",
    "4 y 9 meses",
    "Medicina interna sala de varones cama 3",
    "Cama 3, bloque B, sala de observación pediátrica",
    "Caja Petrolera",
    "Está internado en UTI hospital San Juan de Dios cama 11",
    "Calle Libertad 123, barrio Las Palmas",
    "Rosa Peña Vaca"
  ])("DATO: «%s»", (text) => {
    expect(looksLikeHomeVisitData(text)).toBe(true);
  });
  it.each(["Quiero un hemograma", "¿Cuánto sale el transporte?", "ok gracias", "¿A qué hora vienen?"])("no (pedido, pregunta o cortesía): «%s»", (text) => {
    expect(looksLikeHomeVisitData(text)).toBe(false);
  });
});

describe("en qué paso está el contacto", () => {
  it("texto fijo enviado → ASKED; agradecido → THANKED; la Dra escribió después → THANKED", () => {
    expect(homeVisitStageOf([{ from: "ASSISTANT", text: homeVisitMessage(false) }])).toBe("ASKED");
    expect(homeVisitStageOf([{ from: "ASSISTANT", text: homeVisitMessage(true) }, { from: "PATIENT", text: "Rosa Peña" }, { from: "ASSISTANT", text: HOME_VISIT_THANKS }])).toBe("THANKED");
    expect(homeVisitStageOf([{ from: "ASSISTANT", text: homeVisitMessage(false) }, { from: "STAFF", text: "me envía el comprobante" }])).toBe("THANKED");
    expect(homeVisitStageOf([{ from: "ASSISTANT", text: "¡Hola! ¿En qué te ayudo?" }])).toBeUndefined();
  });
});

describe("por los turnos", () => {
  const from = "59170000003";
  const lease = { owner: "owner", fence: 1 };
  const turn = (text: string, id: string): IncomingTurn => ({ kind: "TEXT", text, from, messageId: id });
  const build = (stage: HomeVisitStage | undefined) => {
    const audit = {
      claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-h", lease })),
      renewLease: vi.fn(async () => true),
      recordIgnored: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      recordReply: vi.fn(async () => undefined),
      reserveSend: vi.fn(async () => "reserved" as const),
      confirmSend: vi.fn(async () => "proceed" as const)
    } as unknown as AuditRepository;
    const sendText = vi.fn(async () => undefined);
    const handler = vi.fn(async () => ({ body: "Respuesta del manejador" }));
    const homeVisitStage = vi.fn(async () => stage);
    const deps = {
      audit, sendText, loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => { throw new Error("sin análisis en esta prueba"); }),
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      log: vi.fn(),
      turns: { handlers: { text: handler }, contactKeyFor: () => "c".repeat(64), homeVisitStage } as unknown as NonNullable<QuoteDeps["turns"]>
    } as unknown as QuoteDeps;
    const sent = () => sendText.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    return { deps, sent, sendText, handler, homeVisitStage, audit };
  };

  it("tras el texto fijo, los datos del paciente se agradecen UNA vez (aunque lleguen en varios mensajes)", async () => {
    const { deps, sent, handler, audit } = build("ASKED");
    await processTurns([turn("Daniel Suárez Mora", "h-1"), turn("8 años", "h-2"), turn("3er piso cama 326", "h-3")], deps);
    expect(sent()).toEqual([HOME_VISIT_THANKS]);
    expect(handler).not.toHaveBeenCalled();
    expect(audit.recordIgnored).toHaveBeenCalledTimes(2);
  });
  it("solo cortesía: silencio", async () => {
    const { deps, sendText, handler } = build("ASKED");
    await processTurns([turn("ok gracias", "h-4")], deps);
    expect(sendText).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("estudios o una pregunta: flujo normal (se cotizan o se responden)", async () => {
    for (const stage of ["ASKED", "THANKED"] as const) {
      const { deps, handler, sent } = build(stage);
      await processTurns([turn("Quiero un hemograma", `h-5-${stage}`)], deps);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(sent()).not.toContain(HOME_VISIT_THANKS);
    }
  });
  it("después de agradecer, silencio en todo lo del domicilio (datos, cortesía o fotos)", async () => {
    for (const batch of [[turn("Rosa Peña Vaca, cama 5", "h-6")], [turn("gracias", "h-7")], [{ kind: "IMAGE", from, messageId: "h-8", mediaId: "m-8" } as IncomingTurn]]) {
      const { deps, sendText, handler } = build("THANKED");
      await processTurns(batch, deps);
      expect(sendText).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    }
  });
  it("sin el texto fijo antes, un nombre o una cama se atienden como siempre", async () => {
    const { deps, handler, sent } = build(undefined);
    await processTurns([turn("Rosa Peña Vaca, cama 5", "h-9")], deps);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain(HOME_VISIT_THANKS);
  });
});
