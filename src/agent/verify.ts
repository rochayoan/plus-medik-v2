import { extractTokens } from "../conversation-facts.js";
import { fold } from "../text-normalize.js";
import type { Act, Capabilities, Fact, Intent, Utterance, Violation } from "./contracts.js";

// Verificador por PROCEDENCIA (reemplaza la lista de palabras prohibidas de guardModelReply en este camino). No pregunta «¿suena a algo prohibido?» sino «¿de dónde salió cada dato?»:
//   · todo número, horario, teléfono, enlace, correo o día del texto debe estar en un hecho citado o en el propio mensaje del paciente;
//   · ninguna cifra de dinero sale del redactor (los precios solo los inyecta el sistema desde el catálogo);
//   · el texto no puede prometer que una persona atenderá si los actos no piden una derivación registrada;
//   · cada petición tiene al menos un acto, y un tema médico solo se deriva o se aplaza, nunca se responde.
// Determinista y puro.

export const MAX_AGENT_REPLY_CHARS = 900;

// ───────────────────────────── los actos ─────────────────────────────

export function validateActs(acts: readonly Act[], utterances: readonly Utterance[], facts: readonly Fact[], context: { capabilities: Capabilities; hasQuoteBlock: boolean; read?: ReadonlyMap<string, Intent> }): Violation[] {
  const problems: Violation[] = [];
  if (acts.length === 0) return [{ code: "NO_ACTS" }];
  const known = new Map(utterances.map((utterance) => [utterance.id, utterance]));
  const factIds = new Set(facts.map((fact) => fact.id));
  const covered = new Set<string>();
  for (const act of acts) {
    if (act.utterances.length === 0) problems.push({ code: "UNCOVERED_UTTERANCE", detail: "empty-act" });
    for (const id of act.utterances) {
      if (!known.has(id)) problems.push({ code: "UNKNOWN_UTTERANCE", detail: id });
      else covered.add(id);
    }
    if (act.kind === "ANSWER") {
      if (act.factIds.length === 0) problems.push({ code: "ANSWER_WITHOUT_FACTS", detail: act.utterances.join(",") });
      for (const id of act.factIds) if (!factIds.has(id)) problems.push({ code: "UNKNOWN_FACT", detail: id });
    }
    if (act.kind === "HANDOFF" && !context.capabilities.handoff) problems.push({ code: "HANDOFF_UNAVAILABLE", detail: act.utterances.join(",") });
    if (act.kind === "QUOTE") {
      if (!context.capabilities.quote) problems.push({ code: "QUOTE_UNAVAILABLE" });
      else if (!context.hasQuoteBlock) problems.push({ code: "QUOTE_WITHOUT_BLOCK" });
    }
  }
  for (const utterance of utterances) if (!covered.has(utterance.id)) problems.push({ code: "UNCOVERED_UTTERANCE", detail: utterance.id });
  // Un tema médico (síntomas, medicamentos, interpretación) solo se deriva, se aplaza o se cotiza (la cotización la arma el sistema con el catálogo y no interpreta nada): ninguna respuesta con datos.
  for (const utterance of utterances) {
    // Decide el MODELO: si leyó la petición y no es de salud, la etiqueta de las reglas (una expresión regular amplia: «vitamina», «diabetes»…) no la bloquea. Sin lectura del modelo rige la etiqueta.
    const reading = context.read?.get(utterance.id);
    const medical = reading !== undefined ? reading === "MEDICAL" : utterance.topic === "MEDICAL";
    if (!medical) continue;
    const own = acts.filter((act) => act.utterances.includes(utterance.id));
    if (own.some((act) => act.kind !== "HANDOFF" && act.kind !== "DEFER" && act.kind !== "QUOTE")) problems.push({ code: "MEDICAL_NOT_HANDED_OFF", detail: utterance.id });
  }
  return problems;
}

// ───────────────────────────── el texto ─────────────────────────────

// Una CIFRA de dinero: símbolo de moneda, o una moneda pegada a un número (en cifras o en letras). Nombrar una moneda sin cifra no es una cifra.
const UNIT = "(bs|bob|usd|bolivianos?|dolar(?:es)?|dollars?|pesos?)";
const AMOUNT_WORD = "(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte\\w*|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|mil)";
const CURRENCY = new RegExp(`[$€£¥]|\\d\\s*${UNIT}\\b|\\b${UNIT}\\.?\\s*\\d|\\b${AMOUNT_WORD}\\s+(y\\s+\\w+\\s+)?${UNIT}\\b`);
// Promesas de que una persona hará algo (derivar, registrar, contactar): solo con un acto HANDOFF.
// Solo lo que promete una acción de una persona del laboratorio: «una persona» o «el equipo» a secas (p. ej. «ven con una persona de confianza», «el equipo toma muestras de 7 a 10») no es una promesa.
const HUMAN_PROMISE = /\b(deriv\w*|registr\w* (tu|su|el|este) (caso|solicitud|pedido|consulta)|(te|le|les) (llam|escrib|contact|atend)\w*|(una|la) persona (de (recepcion|atencion|nuestro|la)|del (laboratorio|equipo)|que (te|le|les))|un asesor|una asesora|un agente|un operador|un ejecutivo|(nuestro|el) equipo (te|le|les|se) \w+|recepcion (te|le|les|se) \w+|alguien (te|le|les))\b/;
// Una negativa honesta («no puedo pasarte con una persona por este medio») menciona a una persona sin prometerla: esa oración no cuenta como promesa.
const REFUSAL = /\b(no (puedo|podemos|es posible|tengo|disponemos|cuento|contamos|esta disponible|hay)|por (ahora|el momento) no|todavia no|aun no)\b/;
// Cortesías que parecen datos pero no lo son.
const COURTESY = /\bbuen(os|as)? (dias?|tardes?|noches?)\b/g;

// `patientText`: lo que el paciente escribió en este turno (puede citar sus propias cifras sin que sean un dato inventado). Se verifica SOLO el texto del redactor: la cotización la agrega el sistema después.
export function verifyReply(input: { text: string; acts: readonly Act[]; facts: readonly Fact[]; patientText?: string }): Violation[] {
  const problems: Violation[] = [];
  const body = input.text.replaceAll("\r\n", "\n").trim();
  if (body.length < 2) return [{ code: "EMPTY_REPLY" }];
  if (body.length > MAX_AGENT_REPLY_CHARS) problems.push({ code: "REPLY_TOO_LONG" });
  const cited = new Set(input.acts.flatMap((act) => (act.kind === "ANSWER" ? act.factIds : [])));
  const allowed = new Set<string>(extractTokens(input.patientText ?? ""));
  // Los nombres de estudios del catálogo (que pueden llevar números, p. ej. «vitamina B12») se pueden nombrar sin citarlos: no llevan precios. Todo lo demás exige que un acto cite el hecho.
  for (const fact of input.facts) if (cited.has(fact.id) || fact.source === "CATALOG" || fact.source === "QUOTE_ENGINE") for (const token of extractTokens(fact.text)) allowed.add(token);
  const folded = fold(body).replace(COURTESY, " ");
  if (CURRENCY.test(folded)) problems.push({ code: "PRICE_OUTSIDE_QUOTE" });  const loose = [...extractTokens(folded)].filter((token) => !allowed.has(token));
  if (loose.length > 0) problems.push({ code: "UNGROUNDED_FIGURE", detail: loose.slice(0, 5).map((token) => token.split(":")[0]).join(",") });
  if (!input.acts.some((act) => act.kind === "HANDOFF") && folded.split(/[.!?¡¿\n,;]+|\bpero\b/).some((sentence) => HUMAN_PROMISE.test(sentence) && !REFUSAL.test(sentence))) problems.push({ code: "UNREGISTERED_HANDOFF_PROMISE" });
  return problems;
}
