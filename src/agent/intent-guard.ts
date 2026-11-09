import { plain } from "../text-normalize.js";
import { asksForPrice } from "../text-handler.js";
import type { Capabilities, PlanOutput, RecentEntry, ToolCall, Utterance } from "./contracts.js";

// Ruta administrativa cerrada: reduce una llamada al modelo y obliga a consultar
// conocimiento APROBADO. Nunca introduce horarios, enlaces ni afirmaciones médicas.
const ADMIN = /\b(horario\w*|atienden|abren|abre|cierran|cierra|a que hora|desde que hora|hasta que hora|domingo|sabado|feriado|ubicaci\w*|direccion\w*|sucursal\w*|donde (esta|estan|queda|quedan)|como llego|mapa|resultado\w*|recog\w*|retir\w*|boleta\w*|comprobante\w*|enlace\w*|link\w*|ayuno\w*|ayunas|preparaci\w*|toma de muestra|tipo de muestra|demora\w*|tiempo de entrega|puerta cerrad\w*|afuera)\b/;
const ACCESS_ISSUE = /\b(puerta cerrad\w*|puerta no abre|esperando afuera|estoy afuera|no hay nadie|local cerrado)\b/;
const PERSON = /\b(hablar con (una |un )?(persona|asesor\w*|recepcion\w*)|quiero (un |una )?(asesor\w*|persona)|atencion humana|comunic\w* con recepcion)\b/;

// Las preguntas administrativas SIN precio no necesitan planificación generativa.
// En problemas de acceso presencial se solicita derivación SOLO si existe un ejecutor
// capaz de registrarla; de otro modo nunca se promete atención humana.
export function operationalPlan(
  utterances: readonly Utterance[],
  tools: ReadonlyArray<{ name: string }>,
  capabilities: Capabilities
): PlanOutput | undefined {
  const text = utterances.map((item) => item.text.trim()).filter(Boolean).join("\n").slice(0, 4000);
  if (!text || asksForPrice(text)) return undefined;
  const normalized = plain(text);
  const incident = ACCESS_ISSUE.test(normalized);
  const human = PERSON.test(normalized);
  if (!ADMIN.test(normalized) && !incident) return undefined;
  const canRead = tools.some((tool) => tool.name === "lab_info");
  if (!canRead && !incident && !human) return undefined;
  return {
    toolCalls: canRead ? [{ tool: "lab_info", input: { question: text.slice(0, 300) } }] : [],
    ...(capabilities.handoff && (incident || human) ? { handoff: human ? "HUMAN_REQUEST" : "OUT_OF_SCOPE" } : {})
  };
}

// Ni una etiqueta de estudio inventada por el planificador debe llegar a la
// cotización del catálogo. Los nombres deben figurar literalmente en el mensaje
// del paciente, en sus mensajes anteriores o en una cotización previa validada.
// Ante ambigüedad se descarta LA LLAMADA (no se cobra un subconjunto ocultamente).
export function groundedQuoteCalls(
  calls: readonly ToolCall[],
  utterances: readonly Utterance[],
  recent: readonly RecentEntry[]
): { calls: ToolCall[]; rejected: boolean } {
  const prior = recent.filter((entry) =>
    entry.from === "PATIENT" ||
    (entry.from === "ASSISTANT" && /cotizaci[oó]n|estudios cotizados/i.test(entry.text))
  );
  const corpus = ` ${plain([...prior.map((entry) => entry.text), ...utterances.map((entry) => entry.text)].join(" "))} `;
  let rejected = false;
  const kept = calls.filter((call) => {
    if (call.tool !== "quote_studies") return true;
    const studies = (call.input as { studies?: unknown } | null)?.studies;
    if (!Array.isArray(studies) || !studies.every((study) => typeof study === "string")) return true; // schema ordinario
    const grounded = studies.length > 0 && studies.every((study) => {
      const name = plain(study);
      return name.length >= 2 && corpus.includes(` ${name} `);
    });
    if (!grounded) rejected = true;
    return grounded;
  });
  return { calls: kept, rejected };
}
