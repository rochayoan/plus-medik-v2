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
  it("si la Dra ya atiende un resultado en el chat (sin que el agente haya pedido nada): silencio", () => {
    for (const text of ["verifico", "Ya está listo su _Resultado de Laboratorio_, puede pasar a recogerlo o consultarlo en linea.", "aun sigue en proceso", "su resultado previo ya esta, el final sale el miercoles", "Nombre del paciente", "foto de su comprobante porfavor"]) {
      expect(resultsStageOf([{ from: "PATIENT", text: "ya estan mis resultados?" }, { from: "STAFF", text }]), text).toBe("THANKED");
    }
  });
  it("una respuesta de la Dra que no es sobre un resultado (precio, horario, tiempo de entrega) no cuenta", () => {
    for (const text of ["45bs en dos horas su resultado", "entrega de resultados en 2 a 3 horas", "atendemos 24 horas todos los dias"]) expect(resultsStageOf([{ from: "STAFF", text }]), text).toBeUndefined();
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
  it.each([
    "¿Y cuándo me entregarían los resultados disculpe?",
    "En cuanto salen los resultados?",
    "Cuántas horas el resultado??",
    "y cuando estaria los resultados",
    "Disculpe en que tiempo son los resultados es para la caja petrolera"
  ])("cuánto TARDA (antes de hacerse el estudio, p. ej. tras una cotización): flujo normal, no se piden datos: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("NORMAL");
  });
  it.each(["En cuanto salen los resultados? ya me tomaron la muestra", "Me hice ayer el hemograma, en cuanto tiempo sale el resultado?", "ya estan mis resultados? en cuanto salen"])("cuánto falta para un estudio YA hecho: camino de resultados: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("READY_CHECK");
  });
  it("«Dejé una muestra anoche, ¿me puede enviar los resultados?»: la muestra ya se entregó, es del camino de resultados", () => {
    expect(routeResultsMessage("Dejé una muestra de heces anoche\nMe puede enviar los resultados")).toBe("READY_CHECK");
    expect(routeResultsMessage("¿Cómo se toma la muestra de orina para el resultado?")).toBe("NORMAL");
  });
  it.each(["me pide contraseña y orden para poder entrar ?", "No logro entrar a su sistema", "No puedo ingresar a la pagina con mi clave"])("problemas para ver el resultado en línea: camino de resultados: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("READY_CHECK");
  });
  it.each(["no puedo abrir el link de la ubicacion", "Quiero cotizar, no puedo entrar a la pagina"])("otros «no puedo entrar» siguen su flujo: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("NORMAL");
  });
  it.each([
    "Necesito mis resultados urgente",
    "Estoy hospitalizado, necesito resultados urgente",
    "Acá todo es urgente por el estado delicado de mi hijo, estos resultados necesito"
  ])("una URGENCIA se trata como cualquier consulta de resultados (se piden los datos; dueño, 21-nov): «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("READY_CHECK");
  });
  it.each(["¿Qué significa mi resultado?", "mi resultado salió alto es normal?", "¿Mi resultado positivo significa una enfermedad?"])("la interpretación sigue en silencio: «%s»", (text) => {
    expect(routeResultsMessage(text)).toBe("SILENT");
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
