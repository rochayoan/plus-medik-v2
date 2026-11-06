import { z } from "zod";
import { searchCatalog } from "../catalog-search.js";
import type { ConversationReader } from "../conversation-state-store.js";
import type { KnowledgeAnswer } from "../knowledge-answers.js";
import { evaluateSession, extractStudyRequests, formatSessionQuote, optionsOf, QUOTE_TEXTS, type SessionItem } from "../quote-session.js";
import type { CatalogStudy } from "../types.js";
import type { Fact, ToolCall, ToolContext, ToolDef, ToolErrorCode, ToolResult, ToolRun } from "./contracts.js";

// Herramientas del núcleo conversacional (Fase 2): SOLO LECTURA y deterministas. Envuelven lo que ya funciona (conocimiento aprobado, catálogo, motor de cotización, memoria de la Fase 1); no inventan
// datos, no envían y no derivan. Cada una devuelve HECHOS con procedencia; si no hay dato devuelve «sin dato», nunca un texto de relleno. Los precios JAMÁS van en un hecho: solo en el bloque de cotización
// que arma el motor con el catálogo y que el SISTEMA agrega al mensaje.

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

// Ejecuta las llamadas pedidas por el plan, de a una y en orden, con tope de cantidad y de tiempo. Nunca lanza: un fallo es un código y el turno sigue.
export async function runToolCalls(
  registry: ToolRegistry,
  calls: readonly ToolCall[],
  context: ToolContext,
  limits: { maxCalls?: number; timeoutMs?: number } = {}
): Promise<{ runs: ToolRun[]; facts: Fact[]; blocks: string[] }> {
  const maxCalls = limits.maxCalls ?? TOOL_LIMITS.maxCalls;
  const timeoutMs = limits.timeoutMs ?? TOOL_LIMITS.timeoutMs;
  const runs: ToolRun[] = [];
  const facts: Fact[] = [];
  const blocks: string[] = [];
  let counter = 0;
  for (const [index, call] of calls.entries()) {
    const fail = (error: ToolErrorCode): void => { runs.push({ tool: call.tool, ok: false, error, factIds: [] }); };
    if (index >= maxCalls) { fail("TOO_MANY_CALLS"); continue; }
    const tool = registry.get(call.tool);
    if (!tool) { fail("UNKNOWN_TOOL"); continue; }
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) { fail("INVALID_INPUT"); continue; }
    let outcome: ToolResult;
    try {
      const result = await withTimeout(tool.run(parsed.data, context), timeoutMs);
      if (result === "TIMEOUT") outcome = { ok: false, error: "TIMEOUT" };
      else if (!result || result.facts.length === 0) outcome = { ok: false, error: "NO_DATA" };
      else outcome = { ok: true, facts: result.facts.slice(0, TOOL_LIMITS.maxFactsPerCall).map((fact) => ({ ...fact, id: `${tool.name}:${++counter}` })), blocks: result.blocks ?? [] };
    } catch {
      outcome = { ok: false, error: "FAILED" };
    }
    if (outcome.ok) { facts.push(...outcome.facts); blocks.push(...outcome.blocks); runs.push({ tool: tool.name, ok: true, factIds: outcome.facts.map((fact) => fact.id) }); }
    else fail(outcome.error);
  }
  return { runs, facts, blocks };
}

// ───────────────────────────── las herramientas ─────────────────────────────

// Lo que el modelo puede preguntar sobre el laboratorio (horarios, sucursales, políticas, preparación por estudio): lo contesta el conocimiento APROBADO y vigente que ya usa el agente.
export function labInfoTool(options: { answer: (question: string) => Promise<KnowledgeAnswer | undefined> }): ToolDef {
  return {
    name: "lab_info",
    description: "Datos aprobados del laboratorio: horarios, sucursales, políticas, preparación y plazos por estudio. Pasa la pregunta del paciente.",
    readOnly: true,
    input: z.object({ question: z.string().min(2).max(300) }).strict(),
    async run(input) {
      const { question } = input as { question: string };
      const answer = await options.answer(question);
      if (!answer || answer.status === "CLARIFY" || answer.body.trim() === "") return undefined;
      return { facts: [{ source: "LAB_INFO", text: answer.body, refs: answer.refs.map((ref) => `${ref.kind}:${ref.key}@${ref.version}:${ref.contentHash.slice(0, 12)}`) }] };
    }
  };
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
      if (hits.length === 0) return undefined;
      return { facts: hits.map((hit) => ({ source: "CATALOG" as const, text: `Estudio del catálogo: ${hit.study.name}`, refs: [`study:${hit.study.id}`] })) };
    }
  };
}

const quoteNote = "La cotización con los precios del catálogo la agrega el sistema al mensaje; no escribas precios ni totales.";

// La cotización: usa el MISMO motor de texto de las sesiones de cotización (nombres exactos y sinónimos del catálogo, ambigüedades y precios válidos). Cotiza los estudios identificados con certeza; si algo
// quedó dudoso, la cotización es PARCIAL y los hechos dicen qué aclarar (nombres de opciones, sin precios). Sin ningún estudio seguro no hay bloque. El bloque con precios sale del catálogo recargado ahora y solo lo agrega el sistema.
export function quoteStudiesTool(options: { loadCatalog: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "quote_studies",
    description: "Cotiza estudios por su nombre tal como los escribió el paciente. El sistema agrega el detalle con precios del catálogo; tú nunca escribes precios.",
    readOnly: true,
    input: z.object({ studies: z.array(z.string().min(2).max(120)).min(1).max(20) }).strict(),
    async run(input) {
      const { studies } = input as { studies: string[] };
      const catalog = await options.loadCatalog();
      const extraction = extractStudyRequests(studies.join(", "), catalog);
      if (!extraction || !extraction.isRequest) return undefined;
      const result = extraction.result;
      const facts: Array<Omit<Fact, "id">> = [];
      if (extraction.matched.length > 0) facts.push({ source: "QUOTE_ENGINE", text: `Estudios identificados con certeza en el catálogo (${extraction.matched.length}): ${extraction.matched.map((study) => study.name).join("; ")}`, refs: extraction.matched.map((study) => `study:${study.id}`) });
      for (const group of result.ambiguous) {
        const names = optionsOf(group, catalog).map((option) => option.name);
        if (names.length > 0) facts.push({ source: "QUOTE_ENGINE", text: `Hay más de una opción en el catálogo para un estudio del pedido: ${names.join("; ")}`, refs: group.map((id) => `option:${id}`) });
      }
      if (result.unresolved > 0) facts.push({ source: "QUOTE_ENGINE", text: `No se pudo identificar con certeza ${result.unresolved} estudio${result.unresolved === 1 ? "" : "s"} del pedido en el catálogo`, refs: [] });
      const complete = result.status === "RESOLVED" && result.ambiguous.length === 0 && result.unresolved === 0 && extraction.matched.length > 0;
      // Si solo una parte quedó identificada con certeza, se cotiza ESA parte (con los precios del catálogo) y se avisa al redactor de que es parcial para que pregunte por el resto: antes un solo estudio dudoso
      // dejaba sin cotizar a todos los demás.
      if (extraction.matched.length > 0) {
        const item: SessionItem = { id: "agent", seq: 1, kind: "TEXT", status: "RESOLVED", studyIds: complete ? result.studyIds : extraction.matched.map((study) => study.id), ambiguous: [], unresolved: 0, reasons: [] };
        const evaluation = evaluateSession([item], [...catalog]);
        if (evaluation.kind === "QUOTE") {
          facts.push({ source: "QUOTE_ENGINE", text: complete ? quoteNote : `${quoteNote} La cotización es PARCIAL: solo incluye los estudios identificados con certeza; el total no cubre los que faltan por aclarar. Dilo y pregunta por ellos.`, refs: [] });
          return { facts, blocks: [formatSessionQuote(evaluation.lines, evaluation.duplicates, QUOTE_TEXTS)] };
        }
      }
      return facts.length > 0 ? { facts } : undefined;
    }
  };
}

// Lo que quedó pendiente de la conversación y la última cotización entregada (memoria de la Fase 1): solo temas, motivos y nombres del catálogo; nunca texto del paciente ni precios.
export function conversationStateTool(options: { reader: ConversationReader; contactKey: string; loadCatalog?: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "conversation_state",
    description: "Peticiones del paciente que siguen sin atender en esta conversación y los estudios de la última cotización entregada.",
    readOnly: true,
    input: z.object({}).strict(),
    async run() {
      const state = await options.reader.stateOf(options.contactKey);
      if (!state) return undefined;
      const facts: Array<Omit<Fact, "id">> = [];
      const open = state.questions.filter((question) => question.status === "OPEN" || question.status === "CARRIED");
      if (open.length > 0) facts.push({ source: "CONVERSATION_STATE", text: `Pendiente: ${open.map((question) => `${question.topic}${question.reason ? ` (${question.reason})` : ""}`).join("; ")}`, refs: open.map((question) => `question:${question.id}`) });
      const lastQuote = [...state.artifacts].reverse().find((artifact) => artifact.kind === "QUOTE" && artifact.studyIds.length > 0);
      if (lastQuote && options.loadCatalog) {
        const byId = new Map((await options.loadCatalog()).map((study) => [study.id, study.name]));
        const names = lastQuote.studyIds.map((id) => byId.get(id)).filter((name): name is string => name !== undefined);
        if (names.length > 0) facts.push({ source: "CONVERSATION_STATE", text: `Última cotización entregada en esta conversación: ${names.join("; ")}`, refs: lastQuote.studyIds.map((id) => `study:${id}`) });
      }
      // La última receta leída por el motor de fotos (por nombres del catálogo) y cuántos puntos no se reconocieron: así el agente puede retomar «mi receta» aunque no se haya cotizado entera.
      const lastRecipe = [...state.artifacts].reverse().find((artifact) => artifact.kind === "RECIPE");
      if (lastRecipe && options.loadCatalog && (lastRecipe.studyIds.length > 0 || lastRecipe.unrecognized > 0)) {
        const byId = new Map((await options.loadCatalog()).map((study) => [study.id, study.name]));
        const names = lastRecipe.studyIds.map((id) => byId.get(id)).filter((name): name is string => name !== undefined);
        const pending = lastRecipe.unrecognized > 0 ? ` y ${lastRecipe.unrecognized} punto${lastRecipe.unrecognized === 1 ? "" : "s"} sin reconocer` : "";
        facts.push({ source: "CONVERSATION_STATE", text: `Última receta enviada por el paciente: ${names.length > 0 ? names.join("; ") : "ningún estudio reconocido"}${pending}`, refs: lastRecipe.studyIds.map((id) => `study:${id}`) });
      }
      return facts.length > 0 ? { facts } : undefined;
    }
  };
}
