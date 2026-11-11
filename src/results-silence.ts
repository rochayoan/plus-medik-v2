import { plain } from "./text-normalize.js";

// Recibos, accesos e interpretación de resultados corresponden al personal.
// La decisión se toma ANTES de cualquier modelo. Los pedidos de cotización,
// citas, preparación o atención humana explícita siguen su propio flujo.
const RESULTS = /\b(resultado\w*|informe\w*)\b/;
const RESULTS_STATUS = /\b(salio|salieron|est[aá]n listos|est[aá] listo|ya esta|ya estan)\b/;
const STUDY = /\b(hemograma|glucosa|analisis|estudio\w*)\b/;
const OTHER_INTENT = /\b(cotiz\w*|cotic\w*|precio\w*|cuesta\w*|costo\w*|presupuesto\w*|tarifa\w*|cuanto (sale|cuesta|cuestan|vale|valen)|ayuno\w*|preparacion\w*|muestra\w*|direccion\w*|ubicacion\w*|sucursal\w*|turno\w*|cita\w*|agendar\w*|reserva\w*|pago\w*|pagar\w*|factura\w*|receta\w*|orden medica|persona|asesor\w*|recepcion|humano|hablar con|llamenme|llamame|dolor\w*|fiebre\w*|sangr\w*|medicamento\w*)\b/;
const OFFICE_HOURS = /\b(horario\w* (de )?(atencion|apertura|la sucursal|laboratorio)|horario\w* del laboratorio|a que hora (abren|abre|atienden|atiende|cierran|cierra)|hasta que hora (abren|atienden|atiende|estan abiertos)|desde que hora (abren|atienden)|cuando (abren|atienden)|a que hora abre el laboratorio)\b/;
const RESULTS_HOURS = /\b(horario\w* (de )?(entrega|retiro|recogida) (de )?resultado\w*|a que hora (entregan|salen|estan) (los |mis )?resultado\w*)\b/;

// Consultas sobre un resultado YA realizado (¿ya está?, ¿puedo recogerlo?, enviarlo, contraseña, acceso): una persona verifica con el nombre del paciente o el comprobante. Se distinguen de preguntar
// cuánto TARDA un resultado (información para hacerse un estudio), que sigue el flujo normal con los tiempos del catálogo.
const READY_INTENT = /\b(ya (esta|estan|salio|salieron|llego|llegaron|puedo|pueden)|estan? listos?|cuando (me |nos )?(entregan|entregaran|estan|esta|salen|sale|llegan)|como (va|vas|van)|recoger|recojo|retirar|retiro|buscar|pasar\w* (a|por|el|los)|enviar\w*|mandar\w*|por este medio|link|enlace|contrasena|clave|acceso|entrar|ingresar|sistema|descarg\w*|pdf|a que hora (entregan|puedo|pasar|salen|estan))\b/;
const TURNAROUND_INFO = /\b(cuanto (tiempo )?(demora|demoran|tarda|tardan|tardara|tardaran)|en cuanto tiempo|en cuantos dias|cuantos dias (demora|tarda|tardan))\b/;
const MINE = /\b(mis|mi|me|nos|ya esta|ya estan|ya salio|ya salieron|recoger|enlace|link|contrasena|sistema)\b/;
const INTERPRET = /\b(significa\w*|interpret\w*|positivo|negativo|alto|baja|bajo|normal|enfermedad|diagnos\w*|urgente\w*|hospital\w*)\b/;

export type ResultsRouting = "SILENT" | "READY_CHECK" | "OFFICE_HOURS" | "NORMAL";

// Se analiza el lote completo. Solo las consultas inequívocas se redirigen.
// La frase de horario es canónica: jamás se traslada la parte privada de
// resultados a las herramientas, al LLM ni a la respuesta.
export function routeResultsMessage(text: string): ResultsRouting {
  const message = plain(text.slice(0, 4000));
  if (!message) return "NORMAL";
  const resultsContext = RESULTS.test(message) || (STUDY.test(message) && RESULTS_STATUS.test(message));
  if (!resultsContext || OTHER_INTENT.test(message)) return "NORMAL";
  if (OFFICE_HOURS.test(message) && !RESULTS_HOURS.test(message)) return "OFFICE_HOURS";
  // Interpretación o urgencia: sigue en silencio (no se orienta sobre resultados).
  if (INTERPRET.test(message)) return "SILENT";
  // Cuánto tarda un resultado, sin hablar de uno propio: información para hacerse el estudio (flujo normal).
  if (TURNAROUND_INFO.test(message) && !MINE.test(message)) return "NORMAL";
  if (READY_INTENT.test(message)) return "READY_CHECK";
  return "SILENT";
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

// Respuesta de recepción ante «¿ya está mi resultado?»: cálida, sin estado ni contraseñas; pide UN solo dato para que la persona verifique. Texto fijo definido por el dueño (11-nov).
export function resultsCheckMessage(date: Date): string {
  return `${boliviaGreeting(date)}, gracias por preferirnos 😊 Verifico. Ve pasándome el nombre completo del paciente o el comprobante de pago, por favor (con uno de los dos me basta).`;
}

// Un mensaje corto que parece el dato pedido (nombre del paciente, número de orden, comprobante): sin preguntas ni pedidos propios (cotizar, precio, hablar con una persona, ubicación, horario).
const OWN_REQUEST = /\b(cotiz\w*|cotic\w*|precio\w*|cuesta\w*|costo\w*|cuanto\w*|persona|asesor\w*|humano|ubicacion|direccion|horario\w*|abren|atienden|resultado\w*|domicilio)\b/;
export function looksLikeIdentification(text: string): boolean {
  const message = plain(text.slice(0, 500));
  if (!message || text.includes("?") || text.includes("¿")) return false;
  return message.split(/\s+/).length <= 8 && !OWN_REQUEST.test(message);
}
