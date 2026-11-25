import { z } from "zod";
import { searchCatalog } from "../catalog-search.js";
import { normalizeStudyKey } from "../consensus.js";
import type { ConversationReader } from "../conversation-state-store.js";
import { detectTopics, type KnowledgeAnswer } from "../knowledge-answers.js";
import { formatDoctorConfirms, formatGroupedOptions, OPTIONS_PER_MENTION, OPTIONS_TOTAL_LIMIT } from "../quote-options.js";
import { evaluateSession, extractWithNotes, formatSessionQuote, isKnownStudyPhrase, preferredByMethod, preferredBySample, QUOTE_TEXTS, type SessionItem } from "../quote-session.js";
import { splitStudyMentions } from "../study-mentions.js";
import type { CatalogStudy } from "../types.js";
import { emojiFor, formatBs, turnaroundSuffix } from "../whatsapp-quote.js";
import type { Fact, ToolCall, ToolContext, ToolDef, ToolErrorCode, ToolRun } from "./contracts.js";
import { chooseAmong, knownNamesOf, reviewFuzzy, sampleAsAdjective, typoSuggestions, coreOfMention, allNameWords, namedChoice, namesWord, IG_WORDS, FORM_WORDS, STOP_WORDS, isPanel, hasWord, versionBase, withVersionSiblings, chooseVersions, withJoinedAcronyms, groupOf } from "../study-choice.js";
export { chooseVersions, coreOfMention, sampleAsAdjective, withVersionSiblings } from "../study-choice.js";

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
  return ["🩺 *PlusMedik* · Opciones que encontré", "", ...valid.map((study) => `${emojiFor(study.name)} ${study.name} — ${formatBs(study.priceBs)}${study.turnaroundText ? turnaroundSuffix(study.turnaroundText) : ""}`), "", "Dime cuál te interesa y te armo la cotización. 😊"].join("\n");
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
  "seriado", "seriada", "simple", "convencional", "automatizado", "automatizada", "urinario", "urinaria", "sanguineo", "sanguinea", "plasmatico", "plasmatica", "heces", "liquido", "liquidos", "ocasional",
  "total", "libre", "directa", "indirecta", "igg", "igm", "iga", "ige", "de", "del", "en", "la", "el", "y", "o", "sangre", "orina", "serico", "serica", "rapida", "rapido", "cuantitativo", "cualitativo", "tipo", "patogenos"]);




// La cotización: usa el MISMO motor de texto de las sesiones de cotización, CON la búsqueda por parecido (erratas, nombres comunes, método preferido; el mismo umbral que la ruta de siempre). Cotiza los estudios
// identificados con certeza; lo DUDOSO (varias opciones plausibles, o un nombre que solo se parece) no se rechaza: se ofrece debajo, con su precio y fuera del total, para que el paciente confirme. Solo lo que
// no se parece a nada del catálogo queda como «no encontrado».
export function quoteStudiesTool(options: { loadCatalog: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "quote_studies",
    description: "Cotiza estudios por su nombre tal como los escribió el paciente. El sistema agrega el detalle con precios del catálogo; tú nunca escribes precios.",
    readOnly: true,
    // Acepta lo que el modelo separe como sea: una lista entera en un solo texto (hasta 600 caracteres) o variantes sueltas («hepatitis b», «c»). Antes una «c» suelta hacía fallar TODA la cotización.
    // `guesses` (opcional, revisión del 23-nov): lo que el modelo CREE que quiso escribir el paciente cuando ve una errata o una abreviatura («hgc» → «beta hcg»). Solo se usa si lo escrito no aparece en el
    // catálogo (ni por errata), y siempre como SUGERENCIA para que el paciente confirme: nunca entra solo a la cotización.
    input: z.object({ studies: z.array(z.string().max(600)).min(1).max(30), guesses: z.array(z.object({ written: z.string().max(120), guess: z.string().max(120) }).strict()).max(10).optional() }).strict(),
    async run(input) {
      const catalog = withJoinedAcronyms(await options.loadCatalog());
      // Cada estudio por separado aunque vengan en una lista («testosterona total y libre», «hepatitis b y c», «clamidia igg-igm», viñetas, comas): ver src/study-mentions.ts.
      const known = knownNamesOf(catalog);
      // Lo que mandó el modelo se une en orden (un nombre por línea): una variante suelta («c» tras «hepatitis b») hereda la palabra común de la anterior.
      const written = (input as { studies: string[] }).studies.map((text) => text.trim()).filter((text) => text !== "");
      const guesses = ((input as { guesses?: Array<{ written: string; guess: string }> }).guesses ?? []).filter((item) => item.written.trim() !== "" && item.guess.trim() !== "");
      if (written.length === 0) return { noData: "NOT_QUOTABLE" };
      const mentions = splitStudyMentions(written.join("\n"), { isKnownName: (name) => known.has(name) || isKnownStudyPhrase(name) });
      const studies = mentions.length > 0 ? mentions : written.filter((text) => text.length >= 2);
      const byId = new Map(catalog.map((study) => [study.id, study]));
      const sure = new Map<string, CatalogStudy>();
      const doubtful = new Map<string, CatalogStudy>();
      const notFound: string[] = [];
      // Cada nombre por separado: así lo dudoso de uno no tapa lo seguro de otro. El motor distingue «un pedido de estudios» de «charla» por el texto: un nombre que no está en el catálogo (o con una errata)
      // solo cuenta como pedido si el texto habla de cotizar (prueba real del 6-nov); por eso se antepone «cotizar».
      // Las opciones dudosas se agrupan por lo que pidió el paciente («Para «pcr»: …»): así entiende por qué aparece cada una.
      const doubtGroups = new Map<string, CatalogStudy[]>();
      // Los grupos que salieron de una errata o de lo que cree el modelo: con una sola opción se pregunta «¿Quisiste decir…?» (src/quote-options.ts).
      const typoLabels = new Set<string>();
      const groupNotes = new Set<string>();
      const doubt = (mention: string, list: readonly CatalogStudy[]) => {
        for (const study of list) {
          doubtful.set(study.id, study);
          const group = doubtGroups.get(mention) ?? [];
          if (!group.some((item) => item.id === study.id)) group.push(study);
          doubtGroups.set(mention, group);
        }
      };
      const resolve = (text: string): { matched: CatalogStudy[]; groups: string[][]; unresolved: boolean; forms: string[]; fuzzy: Set<string> } => {
        // «prueba de vih», «dosaje de ácido valproico», «examen de orina»: también se prueba el nombre sin la palabra de relleno (la que no es parte del estudio).
        // «zinc sérico o plasmático»: la muestra en sangre no cambia el estudio; también se prueba sin esas palabras.
        const core = coreOfMention(text);
        const withoutBlood = core.replace(/\b(?:serico|serica|plasmatico|plasmatica|sanguineo|sanguinea|en sangre)\b/g, " ").replace(/\s+/g, " ").trim();
        // La muestra dicha con «de/en + sustantivo» donde el catálogo usa el adjetivo (caso real 21-nov: «frotis de sangre periférica» = MORFOLOGIA DE FROTIS SANGUINEO; iba a «confirma la doctora»).
        const asAdjective = sampleAsAdjective(core);
        const forms = [...new Set([text, core, asAdjective, withoutBlood].filter((form) => form.length >= 2))];
        for (const form of forms) {
          const { extraction, notes } = extractWithNotes(`cotizar ${form}`, catalog, { fuzzy: true });
          if (!extraction?.isRequest || (extraction.matched.length === 0 && extraction.result.ambiguous.length === 0)) continue;
          // Los que salieron solo por PARECIDO (no por nombre, alias o sinónimo).
          const fuzzy = new Set(notes.interpreted.map((item) => item.studyName));
          return { matched: extraction.matched, groups: extraction.result.ambiguous, unresolved: extraction.result.unresolved > 0, forms, fuzzy };
        }
        return { matched: [], groups: [], unresolved: true, forms, fuzzy: new Set() };
      };
      // Lo que el modelo cree que quiso escribir el paciente con `text` (si lo dijo): los estudios del catálogo que corresponden a esa idea, por nombre o por parecido fuerte. Nunca seguros.
      const guessedStudies = (text: string): CatalogStudy[] => {
        const keys = new Set([normalizeStudyKey(text), normalizeStudyKey(coreOfMention(text))]);
        const guess = guesses.find((item) => keys.has(normalizeStudyKey(item.written)) || keys.has(normalizeStudyKey(coreOfMention(item.written))))?.guess;
        if (!guess || normalizeStudyKey(guess) === normalizeStudyKey(text)) return [];
        const found = studiesOf(resolve(guess));
        const studies = found.length > 0 ? found : searchCatalog(guess, catalog, { limit: 3, minScore: 0.75 }).map((hit) => hit.study);
        return studies.filter((study) => !sure.has(study.id)).slice(0, OPTIONS_PER_MENTION);
      };
      const studiesOf = (result: { matched: CatalogStudy[]; groups: string[][] }) => [...result.matched, ...result.groups.flat().map((id) => byId.get(id)).filter((study): study is CatalogStudy => study !== undefined)];
      const queue = [...studies];
      for (let index = 0; index < queue.length && index < 40; index++) {
        const text = queue[index]!;
        // Nombre de un perfil («transaminasas», «perfil lipídico»): sus estudios, como los cotiza la Dra.
        const group = groupOf(coreOfMention(text), catalog);
        if (group) {
          if (group.pending) {
            if (!group.hideOptions) doubt(text, group.studies.filter((study) => !sure.has(study.id)));
          } else for (const study of group.studies) sure.set(study.id, study);
          if (group.note) groupNotes.add(group.note);
          // Depende de un dato que solo tiene el paciente (dueño, 25-nov): se le pide; ninguna opción se cotiza sola.
          if (group.ask) groupNotes.add(`«${text}»: no elijas ni cotices ninguna opción; pídele al paciente este dato con tus palabras, en una o dos frases: ${group.ask}`);
          continue;
        }
        const { matched, groups, unresolved, forms, fuzzy } = resolve(text);
        // «t3 t4 tsh» (solo espacios): si el conjunto no es un estudio pero CADA palabra sí lo es, se cotiza cada una por separado. También si el conjunto solo salió por PARECIDO y cada palabra es un
        // estudio por su nombre («calcio sodio» no es el «IONOGRAMA 2»). Nunca con palabras que solas no son un estudio («panel pcr 13 patogenos»), y cada palabra tiene que NOMBRAR el estudio
        // (estar en su nombre, ser un alias aprobado o un sinónimo de la lista), no solo parecerse: «copro seriado» no es «coprocultivo» + «… seriado».
        const words = text.split(" ").filter((word) => word.length >= 2);
        const onlyByLikeness = matched.length > 0 && groups.length === 0 && matched.every((study) => fuzzy.has(study.name));
        if ((matched.length === 0 && groups.length === 0 || onlyByLikeness) && words.length >= 2 && words.length <= 6 && words.every((word) => !NOT_ALONE.has(word) && !/^\d+$/.test(word))
          && words.every((word) => { const one = resolve(word); return (one.matched.length > 0 || one.groups.length > 0) && (!onlyByLikeness || one.fuzzy.size === 0) && namesWord(word, studiesOf(one)); })) {
          queue.push(...words);
          continue;
        }
        const candidateGroups = groups.map((ids) => ids.map((id) => byId.get(id)).filter((study): study is CatalogStudy => study !== undefined));
        for (const study of matched) {
          if (!fuzzy.has(study.name)) {
            // Encontrado por su nombre, pero el paciente escribió algo más que ese nombre no tiene y UN estudio sí lo tiene todo: «hemoglobina glicosilad» → la glicosilada, no la «HEMOGLOBINA».
            const review = reviewFuzzy(study, text, catalog);
            sure.set("replace" in review ? review.replace.id : study.id, "replace" in review ? review.replace : study);
            continue;
          }
          const review = reviewFuzzy(study, text, catalog);
          if ("keep" in review) sure.set(review.keep.id, review.keep);
          else if ("replace" in review) sure.set(review.replace.id, review.replace);
          else candidateGroups.push(review.doubt);
        }
        for (const candidates of candidateGroups) {
          // Muestra por defecto EN SANGRE (decisión del dueño, 19-nov): «fósforo», «calcio», «creatinina» a secas → la versión en sangre con ese mismo nombre, si hay UNA. Nunca elige entre dos en sangre.
          // Muestra en sangre, nombre completo, alias compartido y versiones del mismo estudio: la misma decisión que usa la foto de la receta (study-choice.ts).
          const fixed = chooseAmong(candidates, text, catalog);
          if (fixed) for (const study of fixed) sure.set(study.id, study);
          else doubt(text, candidates);
        }
        if (!unresolved) continue;
        // Lo que el motor no resolvió: los estudios más parecidos del catálogo como POSIBLES (nunca como cotización segura). Sin nada seguro en este nombre, la búsqueda es más amplia (como antes).
        const nothing = matched.length === 0 && groups.length === 0;
        const hits = forms.flatMap((form) => searchCatalog(form, catalog, { limit: nothing ? SUGGESTION_LIMIT : 3, minScore: nothing ? 0.5 : 0.6 })).sort((a, b) => b.score - a.score).map((hit) => hit.study).filter((study) => !sure.has(study.id));
        if (hits.length > 0) doubt(text, [...new Map(hits.map((study) => [study.id, study])).values()].slice(0, nothing ? SUGGESTION_LIMIT : 3));
        else if (nothing) {
          // Antes de dejárselo a la doctora: ¿es una errata de algo del catálogo («hgc» → HCG, «lipsaa» → LIPASA)? Y si no, ¿qué cree el modelo que quiso escribir? Las dos son solo SUGERENCIAS.
          // Errata de un nombre con elección del laboratorio («hgc» → «hcg» → la HCG cualitativa): se sugiere esa.
          const typos = typoSuggestions(forms, catalog, sure);
          const suggested = typos.length > 0 ? typos : guessedStudies(text);
          if (suggested.length > 0) {
            doubt(text, [...new Map(suggested.map((study) => [study.id, study])).values()].slice(0, SUGGESTION_LIMIT));
            typoLabels.add(text);
          } else notFound.push(text);
        }
      }
      const possible = [...doubtful.values()].filter((study) => !sure.has(study.id));
      const optionGroups = [...doubtGroups].map(([label, list]) => ({ label, studies: list.filter((study) => !sure.has(study.id)), typo: typoLabels.has(label) })).filter((item) => item.studies.length > 0);
      const facts: Array<Omit<Fact, "id">> = [];
      if (sure.size > 0) facts.push({ source: "QUOTE_ENGINE", text: `Estudios identificados con certeza en el catálogo (${sure.size}): ${[...sure.values()].map((study) => study.name).join("; ")}`, refs: [...sure.keys()].map((id) => `study:${id}`) });
      if (possible.length > 0) facts.push({ source: "CATALOG", text: `Estudios POSIBLES para lo que pidió, sin confirmar (el sistema los muestra numerados con su precio, fuera del total, agrupados por lo que pidió): ${optionGroups.map((item) => `«${item.label}»: ${item.studies.slice(0, OPTIONS_PER_MENTION).map((study) => study.name).join("; ")}`).join(" · ")}`, refs: possible.slice(0, OPTIONS_TOTAL_LIMIT).map((study) => `option:${study.id}`) });
      for (const note of groupNotes) facts.push({ source: "QUOTE_ENGINE", text: note, refs: [] });
      const typoGroups = optionGroups.filter((item) => item.typo);
      if (typoGroups.length > 0) facts.push({ source: "CATALOG", text: `Lo que escribió como ${typoGroups.map((item) => `«${item.label}»`).join(", ")} parece un error de tipeo o una abreviatura: el sistema le muestra debajo lo que quizá quiso decir, con su precio, para que lo confirme. En una frase pregúntale si es eso (sin repetir nombres ni precios); si responde que sí, se agrega a la cotización.`, refs: [] });
      // Lo que no se parece a nada del catálogo: lo confirma LA DOCTORA (indicación del laboratorio, 20-nov). El sistema lo dice en un bloque fijo; el modelo no debe decir que no lo tenemos.
      if (notFound.length > 0) facts.push({ source: "QUOTE_ENGINE", text: `Estudios que confirma la doctora (el sistema ya lo dice en un bloque debajo, con la lista): ${notFound.join("; ")}. NO sabes si se realizan: no digas que sí ni que no (ni «podemos hacerlos» ni «no los tenemos»), no menciones otros laboratorios y no los enumeres en tu texto; solo que esos se los confirma la doctora.`, refs: [] });
      const blocks: string[] = [];
      if (sure.size > 0) {
        const item: SessionItem = { id: "agent", seq: 1, kind: "TEXT", status: "RESOLVED", studyIds: [...sure.keys()], ambiguous: [], unresolved: 0, reasons: [] };
        const evaluation = evaluateSession([item], [...catalog]);
        if (evaluation.kind === "QUOTE") {
          const complete = possible.length === 0 && notFound.length === 0;
          facts.push({ source: "QUOTE_ENGINE", text: complete ? quoteNote : `${quoteNote} La cotización es PARCIAL: solo suma los estudios identificados con certeza.${possible.length > 0 ? " Debajo van los POSIBLES con su precio: pregunta en una frase si quiere agregar alguno." : ""}${notFound.length > 0 ? " Debajo también va el aviso de los que confirma la doctora." : ""}`, refs: [] });
          // Cada estudio con su tiempo de entrega junto al precio (dueño, 20-nov); «Tu cotización»: el paciente escribió los estudios, no mandó una receta.
          blocks.push(formatSessionQuote(evaluation.lines, evaluation.duplicates, QUOTE_TEXTS, { catalog, title: "Tu cotización" }));
          // El tiempo de entrega va en el bloque, pero el redactor no lo veía y decía «no tengo confirmado el tiempo de entrega» encima de «(entrega: en el día)» (caso real 21-nov, progesterona).
          const turnarounds = [...sure.values()].map((study) => `${study.name}: ${study.turnaroundText?.trim() || "lo confirma la doctora"}`);
          facts.push({ source: "QUOTE_ENGINE", text: `Tiempo de entrega de cada estudio cotizado (ya va en la cotización, junto a su precio): ${turnarounds.join("; ")}. Si pregunta cuánto tarda o cuándo sale, dilo con estos datos o di que va en la cotización; nunca digas que no tienes el tiempo de entrega.`, refs: [] });
        }
      }
      const optionsBlock = formatGroupedOptions(optionGroups, blocks.length > 0);
      if (optionsBlock) blocks.push(optionsBlock);
      const doctorBlock = formatDoctorConfirms(notFound);
      if (doctorBlock) blocks.push(doctorBlock);
      if (blocks.length > 0) return { facts, blocks };
      return facts.length > 0 ? { facts } : { noData: "NOT_QUOTABLE" };
    }
  };
}

// ───────────── PREPARACIÓN de un estudio (revisión del 24-nov): el texto de la lista del laboratorio («Preparacion:» de lab_tests.notes) ─────────────
// Qué estudios nombra un texto libre («¿para un hemograma es necesario ir en ayunas?»): tramos de 1 a 4 palabras que son un perfil conocido o que se parecen MUCHO a un estudio del catálogo (nombre, alias o
// sinónimo). Del tramo más largo al más corto; cada palabra se usa una sola vez. Solo para responder la preparación: nunca cotiza.
const PREP_SKIP = new Set(["para", "un", "una", "el", "la", "los", "las", "de", "del", "en", "es", "son", "que", "y", "o", "como", "cual", "cuales", "necesario", "necesita", "necesito", "vaya", "ir", "voy", "tengo", "tiene", "hay", "sin", "comer", "ayuno", "ayunas", "preparacion", "prepararme", "debo", "puedo", "hacer", "hacerme", "examen", "estudio", "analisis", "prueba", "muestra", "junto", "recojo", "llevo", "traigo", "me", "mi", "se", "si", "no", "con", "por", "favor", "hola", "buenas", "dias", "tardes", "noches", "cuanto", "tiempo", "horas", "requiere", "requisito", "requisitos", "24", "hrs"]);
export function studiesNamedIn(text: string, catalog: readonly CatalogStudy[], limit = 6): CatalogStudy[] {
  const tokens = normalizeStudyKey(text.slice(0, 600)).split(" ").filter(Boolean);
  const used = new Set<number>();
  const found = new Map<string, CatalogStudy>();
  for (let size = Math.min(4, tokens.length); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const indices = Array.from({ length: size }, (_, offset) => start + offset);
      if (indices.some((index) => used.has(index))) continue;
      const window = indices.map((index) => tokens[index]!);
      if (PREP_SKIP.has(window[0]!) || PREP_SKIP.has(window[window.length - 1]!) || window.every((word) => PREP_SKIP.has(word) || word.length < 3)) continue;
      const phrase = window.join(" ");
      const group = groupOf(phrase, catalog);
      const hits = group ? group.studies : (() => {
        // El nombre del estudio EMPIEZA con lo escrito («microalbuminuria» → «MICROALBUMINURIA OCASIONAL (…)»); si no, el parecido fuerte del buscador.
        const starts = catalog.filter((study) => study.active && !isPanel(study) && (study.normalizedName === phrase || study.normalizedName.startsWith(`${phrase} `) || (study.normalizedAliases ?? []).includes(phrase)));
        const ranked = starts.length > 0 && starts.length <= 4 ? starts : (() => {
          const list = searchCatalog(phrase, catalog, { limit: 4, minScore: 0.8 });
          const best = list[0]?.score ?? 0;
          return list.filter((hit) => hit.score >= best - 0.05 && !isPanel(hit.study)).slice(0, 3).map((hit) => hit.study);
        })();
        // Varias versiones del mismo estudio: la que se cotizaría («tsh» → TSH (ECLIA), no la neonatal).
        return ranked.length > 1 ? chooseVersions(ranked, phrase) ?? ranked : ranked;
      })();
      if (hits.length === 0) continue;
      for (const study of hits) found.set(study.id, study);
      for (const index of indices) used.add(index);
    }
  }
  return [...found.values()].slice(0, limit);
}

// «Mismas condiciones que Ionograma en orina»: también va la preparación de ese estudio.
const SAME_AS = /mismas condiciones que (?:el |la |los |las )?(.+?)[.\s]*$/i;
export const PREPARATION_GUIDE = "Dila con tus palabras, clara y breve, SIN cambiar ni agregar indicaciones. Si indica ayuno de 8 a 12 horas, recomiéndale que la toma sea dentro de ese rango, ayúdale a calcular la hora según la hora de su última comida (si te la dice) y adviértele que un ayuno de más de 12 horas puede alterar el resultado. No le digas que lo consulte con su médico.";
export function preparationFactsFor(studies: readonly CatalogStudy[], catalog: readonly CatalogStudy[]): Array<Omit<Fact, "id">> {
  const lines: string[] = [];
  const refs: string[] = [];
  for (const study of studies) {
    const text = study.preparationText?.trim();
    if (!text) continue;
    const same = SAME_AS.exec(text)?.[1];
    const referenced = same ? studiesNamedIn(same, catalog, 1)[0] : undefined;
    const extra = referenced?.preparationText && referenced.id !== study.id ? ` (${referenced.name}: ${referenced.preparationText})` : "";
    lines.push(`«${study.name}»: ${text}${extra}`);
    refs.push(`preparation:${study.id}`);
  }
  if (lines.length === 0) return [];
  return [{ source: "CATALOG", text: `Preparación indicada por el laboratorio (su lista de estudios): ${lines.join(" · ")}. ${PREPARATION_GUIDE}`, refs }];
}
export function studyPreparationTool(options: { loadCatalog: () => Promise<readonly CatalogStudy[]> }): ToolDef {
  return {
    name: "study_preparation",
    description: "Preparación, ayuno y condiciones de toma de muestra de los estudios que nombra el paciente (texto de la lista del laboratorio). Pasa en \"text\" los estudios o la pregunta.",
    readOnly: true,
    input: z.object({ text: z.string().min(2).max(1500) }).strict(),
    async run(input) {
      const catalog = withJoinedAcronyms(await options.loadCatalog());
      const facts = preparationFactsFor(studiesNamedIn((input as { text: string }).text, catalog), catalog);
      return facts.length > 0 ? { facts } : { noData: "NO_STUDY" };
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
