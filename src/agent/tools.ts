import { z } from "zod";
import { searchCatalog } from "../catalog-search.js";
import type { ConversationReader } from "../conversation-state-store.js";
import { detectTopics, type KnowledgeAnswer } from "../knowledge-answers.js";
import { evaluateSession, extractStudyRequests, formatSessionQuote, optionsOf, QUOTE_TEXTS, type SessionItem } from "../quote-session.js";
import type { CatalogStudy } from "../types.js";
import { emojiFor, formatBs } from "../whatsapp-quote.js";
import type { Fact, ToolCall, ToolContext, ToolDef, ToolErrorCode, ToolRun } from "./contracts.js";

// Herramientas del agente conversacional: SOLO LECTURA y deterministas. Envuelven lo que ya funciona (conocimiento aprobado, catálogo, motor de cotización, memoria); no inventan datos, no envían y no derivan.
// Cada una devuelve HECHOS con procedencia; si no hay dato devuelve «sin datos» con un MOTIVO en código (eso no es un fallo: el agente lo sabe y responde con honestidad). Los precios JAMÁS van en un hecho: solo en
// el bloque de cotización que arma el motor con el catálogo y que el SISTEMA agrega al mensaje.

export const TOOL_LIMITS = { maxCalls: 4, timeoutMs: 4000, maxFactsPerCall: 6 } as const;

export interface ToolRegistry {
  list(): ReadonlyArray<{ name: string; description: string }>;
  get(name: string): ToolDef | undefined;
}

export function createToolRegistry(tools: readonly ToolDef[]): ToolRegistry {
  const byName = new Map<string, ToolDef>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`herramienta repetida: ${tool.name}`);
    if (tool.readOnly !== true) throw new Error(`la herramienta ${tool.name} no es de solo lectura`);
    byName.set(tool.name, tool);
  }
  return { list: () => [...byName.values()].map(({ name, description }) => ({ name, description })), get: (name) => byName.get(name) };
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | "TIMEOUT"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<"TIMEOUT">((resolve) => { timer = setTimeout(() => resolve("TIMEOUT"), ms); timer.unref?.(); })]).finally(() => { if (timer) clearTimeout(timer); });
};

// Lo que el modelo lee de una herramienta que no dio datos (sin cifras ni datos del paciente): «sin datos» es información, no un fallo.
const NOTE_BY_ERROR: Record<ToolErrorCode, string> = {
  UNKNOWN_TOOL: "no existe",
  INVALID_INPUT: "no se pudo consultar (pedido mal formado)",
  TOO_MANY_CALLS: "no se consultó (demasiadas consultas)",
  TIMEOUT: "no respondió a tiempo",
  FAILED: "no se pudo consultar ahora",
  NO_DATA: "sin datos aprobados sobre eso"
};

// Ejecuta las llamadas pedidas por el plan, de a una y en orden, con tope de cantidad y de tiempo. Nunca lanza: un fallo es un código y el turno sigue. `notes`: una línea por herramienta que no dio datos.
export async function runToolCalls(
  registry: ToolRegistry,
  calls: readonly ToolCall[],
  context: ToolContext,
  limits: { maxCalls?: number; timeoutMs?: number } = {}
): Promise<{ runs: ToolRun[]; facts: Fact[]; blocks: string[]; notes: string[] }> {
  const maxCalls = limits.maxCalls ?? TOOL_LIMITS.maxCalls;
  const timeoutMs = limits.timeoutMs ?? TOOL_LIMITS.timeoutMs;
  const runs: ToolRun[] = [];
  const facts: Fact[] = [];
  const blocks: string[] = [];
  const notes: string[] = [];
  let counter = 0;
  for (const [index, call] of calls.entries()) {
    const fail = (error: ToolErrorCode, why?: string): void => {
      runs.push({ tool: call.tool, ok: false, error, ...(why ? { why } : {}), factIds: [] });
      if (error !== "UNKNOWN_TOOL") notes.push(`${call.tool}: ${NOTE_BY_ERROR[error]}`);
    };
    if (index >= maxCalls) { fail("TOO_MANY_CALLS"); continue; }
    const tool = registry.get(call.tool);
    if (!tool) { fail("UNKNOWN_TOOL"); continue; }
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) { fail("INVALID_INPUT"); continue; }
    try {
      const result = await withTimeout(tool.run(parsed.data, context), timeoutMs);
      if (result === "TIMEOUT") fail("TIMEOUT");
      else if (!result) fail("NO_DATA");
      else if ("noData" in result) fail("NO_DATA", result.noData.slice(0, 40));
      else if (result.facts.length === 0) fail("NO_DATA");
      else {
        const added = result.facts.slice(0, TOOL_LIMITS.maxFactsPerCall).map((fact): Fact => ({ ...fact, id: `${tool.name}:${++counter}` }));
        facts.push(...added);
        blocks.push(...(result.blocks ?? []));
        runs.push({ tool: tool.name, ok: true, factIds: added.map((fact) => fact.id) });
      }
    } catch {
      fail("FAILED");
    }
  }
  return { runs, facts, blocks, notes };
}

// ───────────────────────────── las herramientas ─────────────────────────────

// Lo que el modelo puede preguntar sobre el laboratorio (horarios, sucursales y ubicación, políticas, preparación y plazos por estudio): lo contesta el conocimiento APROBADO y vigente que ya usa el agente.
// El conocimiento reconoce el tema por el texto: si la pregunta que armó el modelo no lo delata, se prueba con lo que el paciente escribió (así una paráfrasis no deja la consulta en «sin datos»).
// Motivos de «sin datos»: NO_TOPIC (ni la pregunta ni el mensaje tocan un tema del conocimiento) o NO_APPROVED_DATA (el tema existe pero no hay un dato aprobado y vigente).
export function labInfoTool(options: { answer: (question: string) => Promise<KnowledgeAnswer | undefined> }): ToolDef {
  return {
    name: "lab_info",
    description: "Datos aprobados del laboratorio: horarios, sucursales y ubicación, políticas, preparación y plazos por estudio (no precios). Pasa la pregunta del paciente.",
    readOnly: true,
    input: z.object({ question: z.string().min(2).max(300) }).strict(),
    async run(input, context) {
      const { question } = input as { question: string };
      const asked = [question, ...(context.patientText && context.patientText.trim() !== question.trim() ? [context.patientText.slice(0, 1500)] : [])];
      for (const text of asked) {
        const answer = await options.answer(text);
        if (answer && answer.status !== "CLARIFY" && answer.body.trim() !== "") {
          return { facts: [{ source: "LAB_INFO", text: answer.body, refs: answer.refs.map((ref) => `${ref.kind}:${ref.key}@${ref.version}:${ref.contentHash.slice(0, 12)}`) }] };
        }
      }
      return { noData: asked.some((text) => detectTopics(text, true).length > 0) ? "NO_APPROVED_DATA" : "NO_TOPIC" };
    }
  };
}

// Opciones del catálogo con su precio, armadas por el SISTEMA (el redactor nunca escribe precios). Sirven cuando el paciente escribió un nombre genérico, parcial o con erratas («drogas», «antidoping»):
// se le sugieren los estudios que más se parecen para que elija. Solo entran estudios activos con precio válido. Se incluye el tiempo de entrega si el catálogo lo trae.
const SUGGESTION_LIMIT = 5;
function formatStudyOptions(studies: readonly CatalogStudy[]): string | undefined {
  const valid = studies.filter((study) => study.active && Number.isFinite(study.priceBs) && study.priceBs >= 0).slice(0, SUGGESTION_LIMIT);
  if (valid.length === 0) return undefined;
  return ["🩺 *PlusMedik* · Opciones que encontré", "", ...valid.map((study) => `${emojiFor(study.name)} ${study.name} — ${formatBs(study.priceBs)}${study.turnaroundText ? ` (entrega: ${study.turnaroundText})` : ""}`), "", "Dime cuál te interesa y te armo la cotización. 😊"].join("\n");
}

// Qué estudios del catálogo corresponden a lo que el paciente nombró. NUNCA devuelve precios: un precio solo llega al paciente por la cotización del catálogo.
export function findStudiesTool(options: { loadCatalog: () => Promise<readonly CatalogStudy[]>; minScore?: number }): ToolDef {
  return {
    name: "find_studies",
    description: "Estudios del catálogo que coinciden con un nombre escrito por el paciente (sin precios).",
    readOnly: true,
    input: z.object({ query: z.string().min(2).max(120) }).strict(),
    async run(input) {
      const { query } = input as { query: string };
      const hits = searchCatalog(query, await options.loadCatalog(), { limit: 5, minScore: options.minScore ?? 0.6 });
      if (hits.length === 0) return { noData: "NO_MATCH" };
      const block = formatStudyOptions(hits.map((hit) => hit.study));
      return { facts: hits.map((hit) => ({ source: "CATALOG" as const, text: `Estudio del catálogo: ${hit.study.name}`, refs: [`study:${hit.study.id}`] })), ...(block ? { blocks: [block] } : {}) };
    }
  };
}

const quoteNote = "La cotización con los precios del catálogo la agrega el sistema al mensaje; no escribas precios ni totales.";

// La cotización: usa el MISMO motor de texto de las sesiones de cotización (nombres exactos y sinónimos del catálogo, ambigüedades y precios válidos). Cotiza los estudios identificados con certeza; si algo
// quedó dudoso, la cotización es PARCIAL y los hechos dicen qué aclarar (nombres de opciones, sin precios). Sin ningún estudio seguro no hay bloque, pero sí un hecho que dice qué no se pudo identificar.
export function quoteStudiesTool(options: { loadCatalog: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "quote_studies",
    description: "Cotiza estudios por su nombre tal como los escribió el paciente. El sistema agrega el detalle con precios del catálogo; tú nunca escribes precios.",
    readOnly: true,
    input: z.object({ studies: z.array(z.string().min(2).max(120)).min(1).max(20) }).strict(),
    async run(input) {
      const { studies } = input as { studies: string[] };
      const catalog = await options.loadCatalog();
      // El motor distingue «un pedido de estudios» de «charla» por el texto: un nombre que no está en el catálogo (o con una errata) solo cuenta como pedido si el texto habla de cotizar. Sin esta palabra la
      // herramienta devolvía «nada» (NO_DATA) y el agente no sabía que el estudio no se encontró (prueba real del 6-nov).
      const extraction = extractStudyRequests(`cotizar ${studies.join(", ")}`, catalog);
      if (!extraction || !extraction.isRequest) return { noData: "NO_STUDY_IN_REQUEST" };
      const result = extraction.result;
      const facts: Array<Omit<Fact, "id">> = [];
      if (extraction.matched.length > 0) facts.push({ source: "QUOTE_ENGINE", text: `Estudios identificados con certeza en el catálogo (${extraction.matched.length}): ${extraction.matched.map((study) => study.name).join("; ")}`, refs: extraction.matched.map((study) => `study:${study.id}`) });
      for (const group of result.ambiguous) {
        const names = optionsOf(group, catalog).map((option) => option.name);
        if (names.length > 0) facts.push({ source: "QUOTE_ENGINE", text: `Hay más de una opción en el catálogo para un estudio del pedido: ${names.join("; ")}`, refs: group.map((id) => `option:${id}`) });
      }
      if (result.unresolved > 0) facts.push({ source: "QUOTE_ENGINE", text: `No se pudo identificar con certeza ${result.unresolved} estudio${result.unresolved === 1 ? "" : "s"} del pedido en el catálogo`, refs: [] });
      const complete = result.status === "RESOLVED" && result.ambiguous.length === 0 && result.unresolved === 0 && extraction.matched.length > 0;
      // Si solo una parte quedó identificada con certeza, se cotiza ESA parte (con los precios del catálogo) y se avisa al redactor de que es parcial para que pregunte por el resto.
      if (extraction.matched.length > 0) {
        const item: SessionItem = { id: "agent", seq: 1, kind: "TEXT", status: "RESOLVED", studyIds: complete ? result.studyIds : extraction.matched.map((study) => study.id), ambiguous: [], unresolved: 0, reasons: [] };
        const evaluation = evaluateSession([item], [...catalog]);
        if (evaluation.kind === "QUOTE") {
          facts.push({ source: "QUOTE_ENGINE", text: complete ? quoteNote : `${quoteNote} La cotización es PARCIAL: solo incluye los estudios identificados con certeza; el total no cubre los que faltan por aclarar. Dilo y pregunta por ellos.`, refs: [] });
          return { facts, blocks: [formatSessionQuote(evaluation.lines, evaluation.duplicates, QUOTE_TEXTS)] };
        }
      }
      // Nada identificado con certeza (nombre genérico o con erratas): se sugieren los estudios más parecidos del catálogo, con precio, para que el paciente elija. No es una cotización.
      if (extraction.matched.length === 0) {
        const seen = new Map<string, CatalogStudy>();
        for (const text of studies) for (const hit of searchCatalog(text, catalog, { limit: SUGGESTION_LIMIT, minScore: 0.5 })) if (!seen.has(hit.study.id)) seen.set(hit.study.id, hit.study);
        const block = formatStudyOptions([...seen.values()]);
        if (block) return { facts: [...facts, { source: "CATALOG" as const, text: `Opciones parecidas en el catálogo (el sistema agrega sus precios): ${[...seen.values()].slice(0, SUGGESTION_LIMIT).map((study) => study.name).join("; ")}`, refs: [...seen.values()].slice(0, SUGGESTION_LIMIT).map((study) => `study:${study.id}`) }], blocks: [block] };
      }
      return facts.length > 0 ? { facts } : { noData: "NOT_QUOTABLE" };
    }
  };
}

// La última cotización entregada y la última receta leída (memoria): solo nombres del catálogo; nunca texto del paciente ni precios. Es lo único que la memoria estructurada aporta que el historial de mensajes no
// trae bien (qué estudios se cotizaron y qué leyó el motor de recetas de una foto).
export function conversationStateTool(options: { reader: ConversationReader; contactKey: string; loadCatalog?: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "conversation_state",
    description: "Los estudios de la última cotización entregada y de la última receta enviada por el paciente en esta conversación.",
    readOnly: true,
    input: z.object({}).strict(),
    async run() {
      const state = await options.reader.stateOf(options.contactKey);
      if (!state) return { noData: "NO_STATE" };
      const facts: Array<Omit<Fact, "id">> = [];
      const names = async (ids: readonly string[]): Promise<string[]> => {
        const byId = new Map((await options.loadCatalog?.() ?? []).map((study) => [study.id, study.name]));
        return ids.map((id) => byId.get(id)).filter((name): name is string => name !== undefined);
      };
      const lastQuote = [...state.artifacts].reverse().find((artifact) => artifact.kind === "QUOTE" && artifact.studyIds.length > 0);
      if (lastQuote && options.loadCatalog) {
        const list = await names(lastQuote.studyIds);
        if (list.length > 0) facts.push({ source: "CONVERSATION_STATE", text: `Última cotización entregada en esta conversación: ${list.join("; ")}`, refs: lastQuote.studyIds.map((id) => `study:${id}`) });
      }
      // La última receta leída por el motor de fotos (por nombres del catálogo) y cuántos puntos no se reconocieron.
      const lastRecipe = [...state.artifacts].reverse().find((artifact) => artifact.kind === "RECIPE");
      if (lastRecipe && options.loadCatalog && (lastRecipe.studyIds.length > 0 || lastRecipe.unrecognized > 0)) {
        const list = await names(lastRecipe.studyIds);
        const pending = lastRecipe.unrecognized > 0 ? ` y ${lastRecipe.unrecognized} punto${lastRecipe.unrecognized === 1 ? "" : "s"} sin reconocer` : "";
        facts.push({ source: "CONVERSATION_STATE", text: `Última receta enviada por el paciente: ${list.length > 0 ? list.join("; ") : "ningún estudio reconocido"}${pending}`, refs: lastRecipe.studyIds.map((id) => `study:${id}`) });
      }
      return facts.length > 0 ? { facts } : { noData: "NO_STATE" };
    }
  };
}
