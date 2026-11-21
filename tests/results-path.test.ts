import { describe, expect, it } from "vitest";
import { asksOtherPersonPickup, decideResultsAction, isCourtesy, patientDataIn, RESULTS_NAME_ASK, RESULTS_THANKS, resultsAskMessage, resultsStageOf, routeResultsMessage } from "../src/results-silence.js";

// Camino 2 «Consultar resultados» (decisión del dueño, 21-nov). Frases tomadas del historial real (4–12 nov), con nombres inventados.

describe("el mensaje que pide los datos (aprobado por el dueño)", () => {
  it("pide lo mismo que la Dra: nombre completo, estudio y día, o el comprobante (sin carnet)", () => {
    const text = resultsAskMessage(new Date("2026-11-21T19:00:00Z"));
    expect(text).toBe("Buenas tardes, gracias por preferirnos 😊 Para verificar tu resultado, pásame por favor:\n👤 Nombre completo del paciente\n🧪 Qué estudio te hiciste y qué día\no la foto de tu comprobante de pago 🧾");
    expect(text).not.toMatch(/carnet/i);
  });
});

describe("¿trae los datos con los que la Dra busca el resultado?", () => {
  it.each([
    [["Disculpe podría recoger mis análisis soy la paciente Ana María Rojas Paz"]],
    [["Quiero saber sobre mis estudios que me realicé el día de ayer Mi nombre : Luis diego arroyo Chávez"]],
    [["Buenos días, quisiera saber si mis resultados ya están, me lo hice el domingo, soy lisbeth condo cuaje"]],
    [["¿Ya están mis resultados?", "Mi nombre es Mayra Molina"]],
    [["Una consulta ya están mis resultados?", "Me los realicé ayer a las 7am", "Con el nombre de Rebeca Ortiz Copa"]],
    [["Me puede enviar los resultados", "A nombre de justina estrada"]],
    [["La paciente es Sofía Camacho Franco"]],
    [["Porfirio Lozada Rivas"]],
    [["Heidy fajardo dorado"]],
    [["Jonh Emmanuel Ramirez Choque 4 años"]],
    [["Orden 29150"]]
  ])("COMPLETO: %j", (texts) => {
    expect(patientDataIn(texts, false)).toBe("COMPLETE");
  });
  it("una foto (comprobante, orden) siempre cuenta como dato completo", () => {
    expect(patientDataIn([], true)).toBe("COMPLETE");
    expect(patientDataIn(["¿Ya están mis resultados?"], true)).toBe("COMPLETE");
  });
  it.each([[["Cómo va el resultado", "De señor porfirio"]], [["Porfirio"]]])("PARCIAL (solo un nombre): %j", (texts) => {
    expect(patientDataIn(texts, false)).toBe("PARTIAL");
  });
  it.each([
    [["Quería que me envíe el link de mis resultados"]],
    [["Quiero consultar mis resultados"]],
    [["Le pagué por QR"]],
    [["hemograma, me lo hice ayer"]],
    [["soy de santa cruz y quiero mis resultados"]],
    [["ok gracias"]],
    [["70044829"]]
  ])("NADA: %j", (texts) => {
    expect(patientDataIn(texts, false)).toBe("NONE");
  });
});

describe("en qué paso está el contacto (mensajes recientes del asistente)", () => {
  const ask = { from: "ASSISTANT", text: resultsAskMessage(new Date()) };
  it("el texto más reciente de este camino manda", () => {
    expect(resultsStageOf([ask])).toBe("ASKED");
    expect(resultsStageOf([ask, { from: "PATIENT", text: "Porfirio" }, { from: "ASSISTANT", text: RESULTS_NAME_ASK }])).toBe("NAME_ASKED");
    expect(resultsStageOf([ask, { from: "PATIENT", text: "Porfirio Lozada" }, { from: "ASSISTANT", text: RESULTS_THANKS }])).toBe("THANKED");
  });
  it("el texto anterior (hasta el 21-nov) también cuenta como datos pedidos", () => {
    expect(resultsStageOf([{ from: "ASSISTANT", text: "Buenas tardes, gracias por preferirnos 😊 Verifico. Ve pasándome el nombre completo del paciente y su carnet de identidad, o el comprobante de pago, por favor." }])).toBe("ASKED");
  });
  it("otras respuestas del asistente después no lo borran", () => {
    expect(resultsStageOf([{ from: "ASSISTANT", text: RESULTS_THANKS }, { from: "PATIENT", text: "cuánto cuesta un hemograma" }, { from: "ASSISTANT", text: "🩺 *PlusMedik* · Tu cotización …" }])).toBe("THANKED");
  });
  it("si la Dra escribió después, ella ya lo atiende: silencio", () => {
    expect(resultsStageOf([ask, { from: "STAFF", text: "verifico" }])).toBe("THANKED");
  });
  it("sin textos de este camino: ningún paso", () => {
    expect(resultsStageOf([])).toBeUndefined();
    expect(resultsStageOf([{ from: "ASSISTANT", text: "¡Hola! ¿En qué te ayudo?" }, { from: "STAFF", text: "Buenos días" }])).toBeUndefined();
  });
});

describe("qué hacer", () => {
  it.each([
    [{ query: true, data: "NONE" }, "ASK"],
    [{ query: true, data: "PARTIAL" }, "NAME_ASK"],
    [{ query: true, data: "COMPLETE" }, "THANKS"],
    [{ query: false, data: "COMPLETE" }, undefined],
    [{ stage: "ASKED", query: false, data: "COMPLETE" }, "THANKS"],
    [{ stage: "ASKED", query: false, data: "PARTIAL" }, "NAME_ASK"],
    [{ stage: "ASKED", query: true, data: "NONE" }, "NAME_ASK"],
    [{ stage: "ASKED", query: false, data: "NONE", courtesy: true }, "SILENT"],
    [{ stage: "NAME_ASKED", query: false, data: "PARTIAL" }, "THANKS"],
    [{ stage: "NAME_ASKED", query: false, data: "NONE", courtesy: true }, "SILENT"],
    [{ stage: "THANKED", query: true, data: "COMPLETE" }, "SILENT"],
    [{ stage: "THANKED", query: true, data: "NONE", pickup: true }, "SILENT"],
    [{ query: true, data: "NONE", pickup: true }, "PICKUP_INFO"]
  ] as const)("%j → %s", (input, expected) => {
    expect(decideResultsAction({ courtesy: false, ...input })).toBe(expected);
  });
});

describe("qué es una consulta de resultados (ajustes del 21-nov con casos reales)", () => {
  it.each([
    "Quiero saber sobre mis estudios que me realicé el día de ayer",
    "quisiera saber si mis resultados ya están de ácidos biliares en sangre",
    "¿Puede recoger otra persona mis resultados?",
    "mi esposa puede pasar a recoger los resultados?"
  ])("«%s» es del camino de resultados", (text) => {
    expect(routeResultsMessage(text)).toBe("READY_CHECK");
  });
  it.each(["Tengo sangrado y necesito mis resultados", "Quiero hablar con una persona por mis resultados", "Quiero cotizar unos exámenes que me hice el año pasado"])("«%s» no cambia (sigue su flujo)", (text) => {
    expect(routeResultsMessage(text)).not.toBe("READY_CHECK");
  });
  it("«¿puede recoger otra persona?» solo con recoger/retirar y otra persona", () => {
    expect(asksOtherPersonPickup("¿Puede recoger otra persona mis resultados?")).toBe(true);
    expect(asksOtherPersonPickup("quiero recoger mis resultados")).toBe(false);
  });
  it("cortesía", () => {
    for (const text of ["ok", "Ok gracias", "Muy amable, gracias", "👍", "Está bien"]) expect(isCourtesy(text), text).toBe(true);
    for (const text of ["Porfirio", "Le pagué por QR"]) expect(isCourtesy(text), text).toBe(false);
  });
});
