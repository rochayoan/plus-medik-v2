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

export type ResultsRouting = "SILENT" | "OFFICE_HOURS" | "NORMAL";

// Se analiza el lote completo. Solo las consultas inequívocas se redirigen.
// La frase de horario es canónica: jamás se traslada la parte privada de
// resultados a las herramientas, al LLM ni a la respuesta.
export function routeResultsMessage(text: string): ResultsRouting {
  const message = plain(text.slice(0, 4000));
  if (!message) return "NORMAL";
  const resultsContext = RESULTS.test(message) || (STUDY.test(message) && RESULTS_STATUS.test(message));
  if (!resultsContext || OTHER_INTENT.test(message)) return "NORMAL";
  if (OFFICE_HOURS.test(message) && !RESULTS_HOURS.test(message)) return "OFFICE_HOURS";
  return "SILENT";
}

export function isResultsOnlyRequest(text: string): boolean {
  return routeResultsMessage(text) === "SILENT";
}
