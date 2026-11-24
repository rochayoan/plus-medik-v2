import { extractTokens } from "../conversation-facts.js";
import { fold } from "../text-normalize.js";
import { GUIDANCE_FIGURES } from "./clinical-guidance.js";
import type { Fact, Violation } from "./contracts.js";

// Verificador por PROCEDENCIA. No pregunta «¿suena a algo prohibido?» sino «¿de dónde salió cada dato?»:
//   · todo número, horario, teléfono, enlace, correo o día del texto debe estar en un hecho de las herramientas o en el propio mensaje del paciente;
//   · ninguna cifra de dinero sale del redactor (los precios solo los inyecta el sistema desde el catálogo);
//   · el texto no puede prometer que una persona atenderá si no hay una derivación registrada.
// Determinista y puro.

export const MAX_AGENT_REPLY_CHARS = 900;

// Una CIFRA de dinero: símbolo de moneda, o una moneda pegada a un número (en cifras o en letras). Nombrar una moneda sin cifra no es una cifra.
const UNIT = "(bs|bob|usd|bolivianos?|dolar(?:es)?|dollars?|pesos?)";
const AMOUNT_WORD = "(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte\\w*|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|mil)";
const CURRENCY = new RegExp(`[$€£¥]|\\d\\s*${UNIT}\\b|\\b${UNIT}\\.?\\s*\\d|\\b${AMOUNT_WORD}\\s+(y\\s+\\w+\\s+)?${UNIT}\\b`);
// Promesas de que una persona hará algo (derivar, registrar, contactar): solo con una derivación registrada. Solo lo que promete una acción de una persona del laboratorio: «una persona» o «el equipo» a secas
// (p. ej. «ven con una persona de confianza», «el equipo toma muestras de 7 a 10») no es una promesa.
const HUMAN_PROMISE = /\b(deriv\w*|registr\w* (tu|su|el|este) (caso|solicitud|pedido|consulta)|(te|le|les) (llam|escrib|contact|atend)\w*|(una|la) persona (de (recepcion|atencion|nuestro|la)|del (laboratorio|equipo)|que (te|le|les))|un asesor|una asesora|un agente|un operador|un ejecutivo|(nuestro|el) equipo (te|le|les|se) \w+|recepcion (te|le|les|se) \w+|alguien (te|le|les))\b/;
// Una negativa honesta («no puedo pasarte con una persona por este medio») menciona a una persona sin prometerla: esa oración no cuenta como promesa.
const REFUSAL = /\b(no (puedo|podemos|es posible|tengo|disponemos|cuento|contamos|esta disponible|hay)|por (ahora|el momento) no|todavia no|aun no)\b/;
// Marcadores de lista de un menú de opciones («1️⃣ Cotizar», «2. Ubicación»): un número SOLO al inicio de línea, seguido de la insignia de teclado o de «.»/«)», y del 1 al 5. No cuenta como cifra; cualquier otro
// número («2 estudios», «Bs 45», un horario) sigue exigiendo procedencia. Se aplica al texto original, antes de normalizarlo (la normalización borra la insignia y dejaría «1 »).
const LIST_MARKER = /^[ 	]*[1-5](?:️?⃣|[.)])[ 	]+/gm;
// Voseo (el laboratorio trata de «tú»): formas verbales inequívocas del voseo, CON su tilde (sin tilde, «pasame» o «mira» también son de «tú»). Se pide reescribir.
const VOSEO = /(?<![\p{L}])(querés|podés|tenés|sabés|venís|decís|hacés|necesitás|preferís|decime|contame|escribime|avisá|mirá)(?![\p{L}])/iu;
// Cortesías que parecen datos pero no lo son.
const COURTESY = /\bbuen(os|as)? (dias?|tardes?|noches?)\b/g;

// `patientText`: lo que el paciente escribió en este turno (puede citar sus propias cifras sin que sean un dato inventado). `handoff`: true si se registrará la derivación (entonces el texto puede decir que una persona
// atenderá). Se verifica SOLO el texto del redactor: la cotización la agrega el sistema después.
// `guidanceFigures`: la respuesta da orientación general de preparación (src/agent/clinical-guidance.ts): puede decir cantidades con su unidad («8 a 12 horas», «20 ml») sin que estén en los datos.
export function verifyReply(input: { text: string; facts: readonly Fact[]; patientText?: string; handoff?: boolean; guidanceFigures?: boolean }): Violation[] {
  const problems: Violation[] = [];
  const body = input.text.replaceAll("\r\n", "\n").trim();
  if (body.length < 2) return [{ code: "EMPTY_REPLY" }];
  if (body.length > MAX_AGENT_REPLY_CHARS) problems.push({ code: "REPLY_TOO_LONG" });
  // Pueden aparecer las cifras del paciente y las de lo que devolvieron las herramientas (los nombres de estudios del catálogo, que pueden llevar números como «vitamina B12», no llevan precios).
  const allowed = new Set<string>(extractTokens(input.patientText ?? ""));
  for (const fact of input.facts) for (const token of extractTokens(fact.text)) allowed.add(token);
  const folded = fold(body.replace(LIST_MARKER, "- ")).replace(COURTESY, " ");
  if (CURRENCY.test(folded)) problems.push({ code: "PRICE_OUTSIDE_QUOTE" });
  const loose = [...extractTokens(input.guidanceFigures ? folded.replace(GUIDANCE_FIGURES, " ") : folded)].filter((token) => !allowed.has(token));
  if (loose.length > 0) problems.push({ code: "UNGROUNDED_FIGURE", detail: loose.slice(0, 5).map((token) => token.split(":")[0]).join(",") });
  if (VOSEO.test(body)) problems.push({ code: "VOSEO" });
  if (!input.handoff && folded.split(/[.!?¡¿\n,;]+|\bpero\b/).some((sentence) => HUMAN_PROMISE.test(sentence) && !REFUSAL.test(sentence))) problems.push({ code: "UNREGISTERED_HANDOFF_PROMISE" });
  return problems;
}
