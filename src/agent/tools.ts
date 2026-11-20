import { z } from "zod";
import { searchCatalog } from "../catalog-search.js";
import { normalizeStudyKey } from "../consensus.js";
import type { ConversationReader } from "../conversation-state-store.js";
import { detectTopics, type KnowledgeAnswer } from "../knowledge-answers.js";
import { DOUBTFUL_LIMIT, formatDoubtfulOptions } from "../quote-options.js";
import { evaluateSession, extractWithNotes, formatSessionQuote, isKnownStudyPhrase, preferredByMethod, preferredBySample, QUOTE_TEXTS, type SessionItem } from "../quote-session.js";
import { splitStudyMentions } from "../study-mentions.js";
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

// Palabras que solas no nombran un estudio: una lista separada solo por espacios nunca se corta en ellas.
const NOT_ALONE = new Set(["panel", "perfil", "prueba", "pruebas", "test", "examen", "examenes", "analisis", "estudio", "estudios", "virus", "antigeno", "anticuerpos", "cultivo", "completo", "completa",
  "total", "libre", "directa", "indirecta", "igg", "igm", "iga", "ige", "de", "del", "en", "la", "el", "y", "o", "sangre", "orina", "serico", "serica", "rapida", "rapido", "cuantitativo", "cualitativo", "tipo", "patogenos"]);

// Nombres (y alias aprobados y sinónimos) que el catálogo conoce ENTEROS: no se cortan por su «y» («bilirrubina total y fracciones», «grupo sanguíneo y factor Rh»).
const knownCache = new WeakMap<readonly CatalogStudy[], Set<string>>();
function knownNamesOf(catalog: readonly CatalogStudy[]): Set<string> {
  const cached = knownCache.get(catalog);
  if (cached) return cached;
  const names = new Set<string>();
  for (const study of catalog) {
    const bare = normalizeStudyKey(study.name.replace(/\([^)]*\)/g, " "));
    names.add(normalizeStudyKey(study.name));
    names.add(bare);
    names.add(normalizeStudyKey(bare.replace(/\btipo\b/g, " "))); // «HERPES tipo 1 y 2 IgG (Elisa)» = «herpes 1 y 2 igg»
    for (const alias of study.normalizedAliases ?? []) names.add(normalizeStudyKey(alias));
  }
  knownCache.set(catalog, names);
  return names;
}

// Entre varias opciones, la que tiene TODAS las palabras que el paciente escribió («psa total» → las dos PSA TOTAL, no la LIBRE); si quedan varias que solo cambian de método, el método preferido.
const nameWords = (value: string): Set<string> => new Set(normalizeStudyKey(value.replace(/\([^)]*\)/g, " ")).split(" ").filter(Boolean));
function namedChoice(candidates: readonly CatalogStudy[], mention: string): CatalogStudy | undefined {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter(Boolean);
  if (asked.length < 2) return undefined;
  const withAll = candidates.filter((candidate) => {
    const words = nameWords(candidate.name);
    return asked.every((word) => words.has(word));
  });
  if (withAll.length === 1) return withAll[0];
  if (withAll.length > 1) {
    const byMethod = preferredByMethod(withAll);
    return byMethod && withAll.every((candidate) => candidate === byMethod || sameWithoutMethod(candidate, byMethod)) ? byMethod : undefined;
  }
  return undefined;
}
// Dos opciones que solo se diferencian por el método entre paréntesis («PSA TOTAL (ECLIA)» y «PSA TOTAL (FIA Fluorescencia)»).
const sameWithoutMethod = (a: CatalogStudy, b: CatalogStudy): boolean => normalizeStudyKey(a.name.replace(/\([^)]*\)/g, " ")) === normalizeStudyKey(b.name.replace(/\([^)]*\)/g, " "));

// Palabras de relleno delante del nombre de un estudio («prueba de», «dosaje de», «examen de»).
const FILLER = /^(?:(?:la|el|una?|unos?|las|los)\s+)?(?:pruebas?|examen(?:es)?|analisis|estudios?|dosajes?|dosificacion|test|nivel(?:es)?)\s+(?:de\s+(?:la\s+|el\s+|los\s+|las\s+)?|del\s+|para\s+(?:el\s+|la\s+)?)?/;
export const coreOfMention = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(FILLER, "").trim();
// La cotización: usa el MISMO motor de texto de las sesiones de cotización, CON la búsqueda por parecido (erratas, nombres comunes, método preferido; el mismo umbral que la ruta de siempre). Cotiza los estudios
// identificados con certeza; lo DUDOSO (varias opciones plausibles, o un nombre que solo se parece) no se rechaza: se ofrece debajo, con su precio y fuera del total, para que el paciente confirme. Solo lo que
// no se parece a nada del catálogo queda como «no encontrado».
export function quoteStudiesTool(options: { loadCatalog: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "quote_studies",
    description: "Cotiza estudios por su nombre tal como los escribió el paciente. El sistema agrega el detalle con precios del catálogo; tú nunca escribes precios.",
    readOnly: true,
    // Acepta lo que el modelo separe como sea: una lista entera en un solo texto (hasta 600 caracteres) o variantes sueltas («hepatitis b», «c»). Antes una «c» suelta hacía fallar TODA la cotización.
    input: z.object({ studies: z.array(z.string().max(600)).min(1).max(30) }).strict(),
    async run(input) {
      const catalog = await options.loadCatalog();
      // Cada estudio por separado aunque vengan en una lista («testosterona total y libre», «hepatitis b y c», «clamidia igg-igm», viñetas, comas): ver src/study-mentions.ts.
      const known = knownNamesOf(catalog);
      // Lo que mandó el modelo se une en orden (un nombre por línea): una variante suelta («c» tras «hepatitis b») hereda la palabra común de la anterior.
      const written = (input as { studies: string[] }).studies.map((text) => text.trim()).filter((text) => text !== "");
      if (written.length === 0) return { noData: "NOT_QUOTABLE" };
      const mentions = splitStudyMentions(written.join("\n"), { isKnownName: (name) => known.has(name) || isKnownStudyPhrase(name) });
      const studies = mentions.length > 0 ? mentions : written.filter((text) => text.length >= 2);
      const byId = new Map(catalog.map((study) => [study.id, study]));
      const sure = new Map<string, CatalogStudy>();
      const doubtful = new Map<string, CatalogStudy>();
      const notFound: string[] = [];
      // Cada nombre por separado: así lo dudoso de uno no tapa lo seguro de otro. El motor distingue «un pedido de estudios» de «charla» por el texto: un nombre que no está en el catálogo (o con una errata)
      // solo cuenta como pedido si el texto habla de cotizar (prueba real del 6-nov); por eso se antepone «cotizar».
      const resolve = (text: string): { matched: CatalogStudy[]; groups: string[][]; unresolved: boolean; forms: string[] } => {
        // «prueba de vih», «dosaje de ácido valproico», «examen de orina»: también se prueba el nombre sin la palabra de relleno (la que no es parte del estudio).
        // «zinc sérico o plasmático»: la muestra en sangre no cambia el estudio; también se prueba sin esas palabras.
        const core = coreOfMention(text);
        const withoutBlood = core.replace(/\b(?:serico|serica|plasmatico|plasmatica|sanguineo|sanguinea|en sangre)\b/g, " ").replace(/\s+/g, " ").trim();
        const forms = [...new Set([text, core, withoutBlood].filter((form) => form.length >= 2))];
        for (const form of forms) {
          const { extraction } = extractWithNotes(`cotizar ${form}`, catalog, { fuzzy: true });
          if (!extraction?.isRequest || (extraction.matched.length === 0 && extraction.result.ambiguous.length === 0)) continue;
          return { matched: extraction.matched, groups: extraction.result.ambiguous, unresolved: extraction.result.unresolved > 0, forms };
        }
        return { matched: [], groups: [], unresolved: true, forms };
      };
      const queue = [...studies];
      for (let index = 0; index < queue.length && index < 40; index++) {
        const text = queue[index]!;
        const { matched, groups, unresolved, forms } = resolve(text);
        // «t3 t4 tsh» (solo espacios): si el conjunto no es un estudio pero CADA palabra sí lo es, se cotiza cada una por separado.
        // Nunca con palabras que solas no son un estudio («panel pcr 13 patogenos» no es «panel» + «pcr» + «13» + «patogenos»).
        const words = text.split(" ").filter((word) => word.length >= 2);
        if (matched.length === 0 && groups.length === 0 && words.length >= 2 && words.length <= 6 && words.every((word) => !NOT_ALONE.has(word) && !/^\d+$/.test(word))
          && words.every((word) => { const one = resolve(word); return one.matched.length > 0 || one.groups.length > 0; })) {
          queue.push(...words);
          continue;
        }
        for (const study of matched) sure.set(study.id, study);
        for (const group of groups) {
          const candidates = group.map((id) => byId.get(id)).filter((study): study is CatalogStudy => study !== undefined);
          // Muestra por defecto EN SANGRE (decisión del dueño, 19-nov): «fósforo», «calcio», «creatinina» a secas → la versión en sangre con ese mismo nombre, si hay UNA. Nunca elige entre dos en sangre.
          const blood = preferredBySample(candidates, text);
          // «psa total»: entre PSA TOTAL (ECLIA), PSA TOTAL (FIA) y PSA LIBRE (ECLIA) quedan los que tienen TODAS las palabras pedidas, y entre esos el método preferido (el mismo de la ruta de siempre).
          const named = blood ? undefined : namedChoice(candidates, text);
          const chosen = blood ?? named;
          if (chosen) sure.set(chosen.id, chosen);
          else for (const study of candidates) doubtful.set(study.id, study);
        }
        if (!unresolved) continue;
        // Lo que el motor no resolvió: los estudios más parecidos del catálogo como POSIBLES (nunca como cotización segura). Sin nada seguro en este nombre, la búsqueda es más amplia (como antes).
        const nothing = matched.length === 0 && groups.length === 0;
        const hits = forms.flatMap((form) => searchCatalog(form, catalog, { limit: nothing ? SUGGESTION_LIMIT : 3, minScore: nothing ? 0.5 : 0.6 })).sort((a, b) => b.score - a.score).map((hit) => hit.study).filter((study) => !sure.has(study.id));
        if (hits.length > 0) for (const study of hits.slice(0, nothing ? SUGGESTION_LIMIT : 3)) doubtful.set(study.id, study);
        else if (nothing) notFound.push(text);
      }
      const possible = [...doubtful.values()].filter((study) => !sure.has(study.id));
      const facts: Array<Omit<Fact, "id">> = [];
      if (sure.size > 0) facts.push({ source: "QUOTE_ENGINE", text: `Estudios identificados con certeza en el catálogo (${sure.size}): ${[...sure.values()].map((study) => study.name).join("; ")}`, refs: [...sure.keys()].map((id) => `study:${id}`) });
      if (possible.length > 0) facts.push({ source: "CATALOG", text: `Estudios POSIBLES para lo que pidió, sin confirmar (el sistema los muestra numerados con su precio, fuera del total): ${possible.slice(0, DOUBTFUL_LIMIT).map((study) => study.name).join("; ")}`, refs: possible.slice(0, DOUBTFUL_LIMIT).map((study) => `option:${study.id}`) });
      if (notFound.length > 0) facts.push({ source: "QUOTE_ENGINE", text: `No se encontró en el catálogo nada parecido a: ${notFound.join("; ")}`, refs: [] });
      const blocks: string[] = [];
      if (sure.size > 0) {
        const item: SessionItem = { id: "agent", seq: 1, kind: "TEXT", status: "RESOLVED", studyIds: [...sure.keys()], ambiguous: [], unresolved: 0, reasons: [] };
        const evaluation = evaluateSession([item], [...catalog]);
        if (evaluation.kind === "QUOTE") {
          const complete = possible.length === 0 && notFound.length === 0;
          facts.push({ source: "QUOTE_ENGINE", text: complete ? quoteNote : `${quoteNote} La cotización es PARCIAL: solo suma los estudios identificados con certeza.${possible.length > 0 ? " Debajo van los POSIBLES con su precio: pregunta en una frase si quiere agregar alguno." : ""}${notFound.length > 0 ? " Di cuál no encontraste." : ""}`, refs: [] });
          blocks.push(formatSessionQuote(evaluation.lines, evaluation.duplicates, QUOTE_TEXTS));
        }
      }
      const optionsBlock = formatDoubtfulOptions(possible, blocks.length > 0);
      if (optionsBlock) blocks.push(optionsBlock);
      if (blocks.length > 0) return { facts, blocks };
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
