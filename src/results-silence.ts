import { fold, plain } from "./text-normalize.js";

// Recibos, accesos e interpretación de resultados corresponden al personal.
// La decisión se toma ANTES de cualquier modelo. Los pedidos de cotización,
// citas, preparación o atención humana explícita siguen su propio flujo.
const RESULTS = /\b(resultado\w*|informe\w*)\b/;
const RESULTS_STATUS = /\b(salio|salieron|est[aá]n listos|est[aá] listo|ya esta|ya estan)\b/;
const STUDY = /\b(hemograma|glucosa|analisis|estudio\w*|examen\w*)\b/;
// «quería recoger mis estudios»: el paciente va a retirar algo que ya se hizo.
const PICKUP = /\b(recoger\w*|recojo|retirar\w*|retiro|buscar\w*)\b/;
const OTHER_INTENT = /\b(cotiz\w*|cotic\w*|precio\w*|cuesta\w*|costo\w*|presupuesto\w*|tarifa\w*|cuanto (sale|cuesta|cuestan|vale|valen)|ayuno\w*|preparacion\w*|muestra\w*|direccion\w*|ubicacion\w*|sucursal\w*|turno\w*|cita\w*|agendar\w*|reserva\w*|pago\w*|pagar\w*|factura\w*|receta\w*|orden medica|persona|asesor\w*|recepcion|humano|hablar con|llamenme|llamame|dolor\w*|fiebre\w*|sangrad\w*|sangrand\w*|medicamento\w*)\b/;
const OFFICE_HOURS = /\b(horario\w* (de )?(atencion|apertura|la sucursal|laboratorio)|horario\w* del laboratorio|a que hora (abren|abre|atienden|atiende|cierran|cierra)|hasta que hora (abren|atienden|atiende|estan abiertos)|desde que hora (abren|atienden)|cuando (abren|atienden)|a que hora abre el laboratorio)\b/;
const RESULTS_HOURS = /\b(horario\w* (de )?(entrega|retiro|recogida) (de )?resultado\w*|a que hora (entregan|salen|estan) (los |mis )?resultado\w*)\b/;

// Consultas sobre un resultado YA realizado (¿ya está?, ¿puedo recogerlo?, enviarlo, contraseña, acceso): una persona verifica con el nombre del paciente o el comprobante. Se distinguen de preguntar
// cuánto TARDA un resultado (información para hacerse un estudio), que sigue el flujo normal con los tiempos del catálogo.
const READY_INTENT = /\b(ya (esta|estan|salio|salieron|llego|llegaron|puedo|pueden)|estan? listos?|cuando (me |nos )?(entregan|entregaran|estan|esta|salen|sale|llegan)|como (va|vas|van)|recoger|recojo|retirar|retiro|buscar|pasar\w* (a|por|el|los)|enviar\w*|mandar\w*|por este medio|link|enlace|contrasena|clave|acceso|entrar|ingresar|sistema|descarg\w*|pdf|a que hora (entregan|puedo|pasar|salen|estan))\b/;
const TURNAROUND_INFO = /\b(cuanto (tiempo )?(demora|demoran|tarda|tardan|tardara|tardaran)|en cuanto tiempo|en cuantos dias|cuantos dias (demora|tarda|tardan))\b/;
const MINE = /\b(mis|mi|me|nos|ya esta|ya estan|ya salio|ya salieron|recoger|enlace|link|contrasena|sistema)\b/;
const INTERPRET = /\b(significa\w*|interpret\w*|positivo|negativo|alto|baja|bajo|normal|enfermedad|diagnos\w*|urgente\w*|hospital\w*)\b/;

export type ResultsRouting = "SILENT" | "READY_CHECK" | "OFFICE_HOURS" | "NORMAL";

// «mis estudios que me realicé ayer»: el estudio YA se hizo (se pregunta por el resultado, no por hacérselo).
const DONE_ALREADY = /\b(que me (hice|realice|saque|tome|hicieron|tomaron|sacaron)|me (hice|realice|saque) (el|los|la|las|unos|unas|ayer|hoy|el dia|en la manana))\b/;

// Se analiza el lote completo. Solo las consultas inequívocas se redirigen.
// La frase de horario es canónica: jamás se traslada la parte privada de
// resultados a las herramientas, al LLM ni a la respuesta.
export function routeResultsMessage(text: string): ResultsRouting {
  const message = plain(text.slice(0, 4000));
  if (!message) return "NORMAL";
  const resultsContext = RESULTS.test(message) || (STUDY.test(message) && (RESULTS_STATUS.test(message) || PICKUP.test(message) || DONE_ALREADY.test(message)));
  if (!resultsContext) return "NORMAL";
  // «¿Puede recoger otra persona mis resultados?»: es del camino de resultados (no un pedido de hablar con una persona).
  if (asksOtherPersonPickup(message)) return "READY_CHECK";
  if (OTHER_INTENT.test(message)) return "NORMAL";
  if (OFFICE_HOURS.test(message) && !RESULTS_HOURS.test(message)) return "OFFICE_HOURS";
  // Interpretación o urgencia: sigue en silencio (no se orienta sobre resultados).
  if (INTERPRET.test(message)) return "SILENT";
  // Cuánto tarda un resultado, sin hablar de uno propio: información para hacerse el estudio (flujo normal).
  if (TURNAROUND_INFO.test(message) && !MINE.test(message)) return "NORMAL";
  // Cualquier otra consulta sobre un resultado propio («quiero consultar mis resultados», «resultado de Juan Pérez»): recepción verifica con los datos del paciente (decisión del dueño, 19-nov: ya no se calla).
  return "READY_CHECK";
}

export function isResultsOnlyRequest(text: string): boolean {
  const routing = routeResultsMessage(text);
  return routing === "SILENT" || routing === "READY_CHECK";
}

// Saludo según la hora de Bolivia (UTC-4, sin horario de verano).
export function boliviaGreeting(date: Date): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "America/La_Paz" }).format(date)) % 24;
  return hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
}

// ───────────────────────────── camino 2 del menú: «Consultar resultados» (decisión del dueño, 21-nov) ─────────────────────────────
// El agente NO sabe si un resultado está listo (no tiene acceso al sistema del laboratorio): su trabajo es dejarle a la Dra los datos con los que ella lo busca, los mismos que pide en el chat (nombre completo del
// paciente, o la foto del comprobante; el estudio y el día ayudan), para ahorrarle la vuelta de «verifico, ¿nombre del paciente?». Pasos:
//   1. Pide los datos (ASK). Si ya vinieron en el mismo mensaje, agradece directo.
//   2. Si el nombre llegó incompleto («señor Porfidio») o no llegó nada, lo pide UNA vez más (NAME_ASK). La segunda respuesta se agradece tal cual: nunca se insiste más.
//   3. Agradece (THANKS) y desde ahí, SILENCIO en todo lo de resultados: lo atiende la Dra.
// Ya no depende de que el caso quede registrado en el CRM (antes, sin CRM, la opción 2 no respondía nada).

export type ResultsStage = "ASKED" | "NAME_ASKED" | "THANKED";
export type ResultsAction = "ASK" | "NAME_ASK" | "THANKS" | "PICKUP_INFO" | "SILENT";
export type PatientData = "COMPLETE" | "PARTIAL" | "NONE";

export function resultsAskMessage(date: Date): string {
  return [`${boliviaGreeting(date)}, gracias por preferirnos 😊 Para verificar tu resultado, pásame por favor:`, "👤 Nombre completo del paciente", "🧪 Qué estudio te hiciste y qué día", "o la foto de tu comprobante de pago 🧾"].join("\n");
}
export const RESULTS_NAME_ASK = "¿Me pasas el nombre completo del paciente (nombre y apellidos), por favor? 🙏";
export const RESULTS_THANKS = "Gracias 🙏 ya tengo tus datos. La doctora verifica tu resultado y te lo envía por aquí.";
// Lo que dijo la Dra (6-nov), confirmado por el dueño (21-nov).
export const RESULTS_PICKUP_INFO = "Sí, otra persona puede recoger el resultado presentando el comprobante de pago 🧾";
export const RESULTS_SIGNATURES: Record<Exclude<ResultsAction, "SILENT">, string> = { ASK: "RESULTS_READY_CHECK", NAME_ASK: "RESULTS_NAME_ASK", THANKS: "RESULTS_DATA_THANKS", PICKUP_INFO: "RESULTS_PICKUP_INFO" };

export function resultsReplyBody(action: Exclude<ResultsAction, "SILENT">, date: Date): string {
  return action === "ASK" ? resultsAskMessage(date) : action === "NAME_ASK" ? RESULTS_NAME_ASK : action === "THANKS" ? RESULTS_THANKS : RESULTS_PICKUP_INFO;
}

// En qué paso está el contacto, según los mensajes recientes (24 h) que le envió el asistente: el más reciente de los textos de este camino manda. Si la Dra escribió DESPUÉS de uno de ellos, ella ya lo atiende
// (cuenta como agradecido: silencio). Se lee el texto (no una marca aparte) para que funcione igual si el paciente respondió con una foto.
const STAGE_MARKERS: ReadonlyArray<readonly [ResultsStage, string]> = [
  ["THANKED", plain("ya tengo tus datos. La doctora verifica tu resultado")],
  ["NAME_ASKED", plain("¿Me pasas el nombre completo del paciente (nombre y apellidos)")],
  ["ASKED", plain("Para verificar tu resultado, pásame por favor")],
  ["ASKED", plain("Ve pasándome el nombre completo del paciente")] // texto anterior (hasta el 21-nov)
];
export function resultsStageOf(recent: ReadonlyArray<{ readonly from: string; readonly text: string }>): ResultsStage | undefined {
  let staffSpoke = false;
  for (let index = recent.length - 1; index >= 0; index--) {
    const entry = recent[index]!;
    if (entry.from === "STAFF") staffSpoke = true;
    if (entry.from !== "ASSISTANT") continue;
    const text = plain(entry.text);
    const hit = STAGE_MARKERS.find(([, marker]) => text.includes(marker));
    if (hit) return staffSpoke ? "THANKED" : hit[0];
  }
  return undefined;
}

// ¿Trae el lote los datos con los que la Dra busca el resultado? COMPLETO: una foto (comprobante, orden), un número de orden o un nombre de al menos dos palabras (nombre y apellido). PARCIAL: una sola
// palabra de nombre («señor Porfidio»). Determinista y local: el texto de resultados nunca va a un modelo.
const TITLES = new Set(["senor", "senora", "sr", "sra", "srta", "senorita", "don", "dona", "dr", "dra", "doctor", "doctora", "lic"]);
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y"]);
const NOT_NAME = /^(resultado\w*|estudio\w*|analisis|examen\w*|laboratorio\w*|prueba\w*|muestra\w*|orden|comprobante|pago|recibo|hola|buen\w*|tardes|noches|dias|gracias|favor|porfa\w*|disculpe|quiero|quisiera|queria|saber|consultar|ya|esta\w*|listo\w*|salio|salieron|cuando|hoy|ayer|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana|hice|hizo|realice|saque|me|yo|mis?|tus?|su|sus|el|lo|le|les|un|una|que|para|por|con|sin|en|es|son|si|no|ok\w*|nombre|paciente|apellido\w*|hemograma|glucosa|orina|heces|sangre|cultivo|urocultivo|hemocultivo|coprocultivo|vitamina|perfil|panel|patologia|biopsia|eco\w*|placa|rayos|tomografia|edad|anos|meses|cama|piso|sala)$/;
const NAME_MARKER = /(?:\bsoy(?: (?:el|la))?(?: paciente)?|\bme llamo|\bmi nombre(?: completo)?(?: es)?|\bnombre(?: completo)?(?: del paciente)?(?: es)?\s*:|\ba nombre de|\bcon el nombre de|\bpaciente(?: es)?|\bpx)\s*[:.-]?\s+([^\n,.;:!?¿¡()]+)/g;
const TITLE_MARKER = /\b(?:senor|senora|sr|sra|don|dona)\s+([^\n,.;:!?¿¡()]+)/g;
const ORDER = /\b(orden|n(ro|umero)?\.? de orden|codigo)\s*(n(ro|°|º)?\.?\s*)?\d{3,}/;
const nameTokens = (span: string): number => {
  const tokens = plain(span).split(" ").filter(Boolean);
  while (tokens.length > 0 && TITLES.has(tokens[0]!)) tokens.shift();
  if (tokens.length > 0 && PARTICLES.has(tokens[0]!)) return 0;
  let count = 0;
  for (const token of tokens.slice(0, 7)) {
    if (!/^[a-zñ]+$/.test(token) || NOT_NAME.test(token)) break;
    if (!PARTICLES.has(token)) count++;
  }
  return count;
};
const wholeNameTokens = (text: string): number => {
  const tokens = plain(fold(text).replace(/\b\d{1,3}\s*(anos|meses)\b/g, " ")).split(" ").filter(Boolean).filter((token) => !TITLES.has(token));
  if (tokens.length === 0 || tokens.length > 7) return 0;
  if (tokens.some((token) => !/^[a-zñ]+$/.test(token) || (NOT_NAME.test(token) && !PARTICLES.has(token)))) return 0;
  return tokens.filter((token) => !PARTICLES.has(token)).length;
};
export function patientDataIn(texts: readonly string[], hasImage: boolean): PatientData {
  if (hasImage) return "COMPLETE";
  let best = 0;
  for (const text of texts) {
    const folded = fold(text.slice(0, 1000));
    if (ORDER.test(folded)) return "COMPLETE";
    best = Math.max(best, wholeNameTokens(text));
    for (const match of folded.matchAll(NAME_MARKER)) best = Math.max(best, nameTokens(match[1]!));
    for (const match of folded.matchAll(TITLE_MARKER)) best = Math.max(best, nameTokens(match[1]!));
  }
  return best >= 2 ? "COMPLETE" : best === 1 ? "PARTIAL" : "NONE";
}

// Solo cortesía («ok», «gracias», «muy amable», un emoji): no pide nada.
const COURTESY = /^((ok|okey|okis|oki|si|sip|gracias|muchas|mil|listo|vale|bueno|esta|bien|perfecto|dale|de|acuerdo|ya|entendido|muy|amable|claro)\s*)*$/;
export const isCourtesy = (text: string): boolean => COURTESY.test(plain(text.slice(0, 200)));

// «¿Puede recoger otra persona?»: se responde con lo que indicó la Dra (antes de agradecer los datos; después, silencio).
const OTHER_PERSON = /\b(otra persona|alguien mas|un familiar|familiar|un tercero|mi (esposo|esposa|hijo|hija|mama|papa|hermano|hermana|amigo|amiga|novio|novia|pareja))\b/;
const PICKUP_WORDS = /\b(recoger\w*|recog\w*|retirar\w*|buscar\w*|pasar a)\b/;
export const asksOtherPersonPickup = (text: string): boolean => {
  const message = plain(text.slice(0, 500));
  return OTHER_PERSON.test(message) && PICKUP_WORDS.test(message);
};

// Qué hacer con el lote. `query`: es una consulta de resultados (READY_CHECK). Sin paso previo y sin consulta, no es de este camino (undefined: sigue el flujo normal).
export function decideResultsAction(input: { stage?: ResultsStage; query: boolean; data: PatientData; courtesy: boolean; pickup?: boolean }): ResultsAction | undefined {
  const { stage, query, data, courtesy, pickup } = input;
  if (stage === "THANKED") return "SILENT";
  if (pickup && data !== "COMPLETE") return "PICKUP_INFO";
  if (!stage) return query ? (data === "COMPLETE" ? "THANKS" : data === "PARTIAL" ? "NAME_ASK" : "ASK") : undefined;
  if (data === "COMPLETE") return "THANKS";
  if (courtesy) return "SILENT";
  return stage === "NAME_ASKED" ? "THANKS" : "NAME_ASK";
}

// Un mensaje corto que parece el dato pedido (nombre del paciente, número de orden, comprobante): sin preguntas ni pedidos propios (cotizar, precio, hablar con una persona, ubicación, horario).
const OWN_REQUEST = /\b(cotiz\w*|cotic\w*|precio\w*|cuesta\w*|costo\w*|cuanto\w*|persona|asesor\w*|humano|ubicacion|direccion|horario\w*|abren|atienden|resultado\w*|domicilio)\b/;
export function looksLikeIdentification(text: string): boolean {
  const message = plain(text.slice(0, 500));
  if (!message || text.includes("?") || text.includes("¿")) return false;
  return message.split(/\s+/).length <= 8 && !OWN_REQUEST.test(message);
}
