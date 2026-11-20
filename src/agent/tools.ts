import { z } from "zod";
import { searchCatalog } from "../catalog-search.js";
import { normalizeStudyKey } from "../consensus.js";
import type { ConversationReader } from "../conversation-state-store.js";
import { detectTopics, type KnowledgeAnswer } from "../knowledge-answers.js";
import { formatGroupedOptions, OPTIONS_PER_MENTION, OPTIONS_TOTAL_LIMIT } from "../quote-options.js";
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
  "seriado", "seriada", "simple", "convencional", "automatizado", "automatizada", "urinario", "urinaria", "sanguineo", "sanguinea", "plasmatico", "plasmatica", "heces", "liquido", "liquidos", "ocasional",
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
// Se mira el nombre ENTERO (también lo que va entre paréntesis: «PROTEINA C REACTIVA (PCR CUANTITATIVO)»), y una opción con una palabra de VARIANTE que el paciente no escribió no es lo que pidió:
// «pcr cuantitativo» no es la SEMI cuantitativa (pasaba porque a ese nombre del catálogo le falta el «)»).
const VARIANT_WORDS = new Set(["semi", "semicuantitativo", "semicuantitativa", "cualitativo", "cualitativa", "cuantitativo", "cuantitativa", "total", "libre", "igg", "igm", "iga", "ige", "ss", "ds", "neonatal", "inversa"]);
const nameWords = (value: string): Set<string> => new Set(normalizeStudyKey(value.replace(/\([^)]*\)/g, " ")).split(" ").filter(Boolean));
const allNameWords = (value: string): Set<string> => new Set(normalizeStudyKey(value).split(" ").filter(Boolean));
// El estudio sin su variante ni su método: «PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO» y «(PCR CUANTITATIVO) (FIA Fluorescencia)» son el mismo; «HEPATITIS B ANTIGENO…» y «HEPATITIS B ANTICORE…» no.
const METHOD_WORDS = new Set(["eclia", "clia", "cmia", "elisa", "ifi", "fia", "fluorescencia", "inmunofluorescencia", "prueba", "rapida", "rapido", "test", "latex", "hep2"]);
const variantBase = (value: string): string => [...allNameWords(value)].filter((word) => !VARIANT_WORDS.has(word) && !METHOD_WORDS.has(word)).sort().join(" ");
function namedChoice(candidates: readonly CatalogStudy[], mention: string): CatalogStudy | undefined {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter(Boolean);
  if (asked.length < 2) return undefined;
  const askedSet = new Set(asked);
  // Un panel solo se elige si el paciente pidió un panel: su lista larga tiene casi cualquier palabra («vih 1 y 2» no es el PANEL INTIMA PLUS de Bs 1250 porque su lista diga «VIH» y «Herpes simple 1»).
  const options = askedSet.has("panel") || askedSet.has("perfil") ? candidates : candidates.filter((candidate) => !isPanel(candidate));
  // Solo entre versiones del MISMO estudio se descarta la que agrega una variante no pedida; entre estudios distintos rige la regla de siempre.
  const sameStudy = options.length > 1 && options.every((candidate) => variantBase(candidate.name) === variantBase(options[0]!.name));
  const withAll = options.filter((candidate) => {
    const words = sameStudy ? allNameWords(candidate.name) : nameWords(candidate.name);
    return asked.every((word) => words.has(word)) && (!sameStudy || [...words].every((word) => !VARIANT_WORDS.has(word) || askedSet.has(word)));
  });
  if (withAll.length === 1) return withAll[0];
  if (withAll.length > 1) {
    const byMethod = preferredByMethod(withAll);
    return byMethod && withAll.every((candidate) => candidate === byMethod || sameWithoutMethod(candidate, byMethod)) ? byMethod : undefined;
  }
  return undefined;
}
// ¿La palabra NOMBRA a estos estudios? Está en el nombre de cada uno (palabra entera), es un alias aprobado de cada uno o es una frase de la lista de sinónimos.
function namesWord(word: string, studies: readonly CatalogStudy[]): boolean {
  if (studies.length === 0) return false;
  if (isKnownStudyPhrase(word)) return true;
  return studies.every((study) => nameWords(study.name).has(word) || normalizeStudyKey(study.name).split(" ").includes(word) || (study.normalizedAliases ?? []).includes(word));
}
// Dos opciones que solo se diferencian por el método entre paréntesis («PSA TOTAL (ECLIA)» y «PSA TOTAL (FIA Fluorescencia)»).
const sameWithoutMethod = (a: CatalogStudy, b: CatalogStudy): boolean => normalizeStudyKey(a.name.replace(/\([^)]*\)/g, " ")) === normalizeStudyKey(b.name.replace(/\([^)]*\)/g, " "));

// ───────────── Versiones de un MISMO estudio cuando el médico no las especifica (dueño y cotizaciones reales de la Dra, 20-nov) ─────────────
// Se elige como la Dra, sin preguntar al paciente, solo entre versiones del mismo estudio (mismo nombre sin método, cuantificación, clase de anticuerpo ni muestra):
//   · muestra: en SANGRE (19-nov) — «LDH» no es la «LDH de LÍQUIDOS»;
//   · clase de anticuerpo: IgG + IgM juntas (la Dra en citomegalovirus, rubéola, toxo, clamidia, Epstein-Barr, tuberculosis, herpes 2 y hepatitis A); nunca IgA sola;
//   · método / cuantificación: ECLIA si hay una (12-nov; TSH, hepatitis B antígeno); si no, la de MENOR TIEMPO DE ENTREGA (dueño 20-nov: «la prueba rápida»; PCR → cuantitativa en 1 hora, anti-CCP → FIA);
//   · si empatan, o difieren en total/libre (T3, T4, PSA, testosterona) o en otra cosa (herpes zóster vs. tipo 2), NO se elige: se pregunta al paciente.
const QUANT_WORDS = new Set(["semi", "semicuantitativo", "semicuantitativa", "cualitativo", "cualitativa", "cuantitativo", "cuantitativa"]);
const IG_WORDS = new Set(["igg", "igm", "iga", "ige", "igd"]);
const FORM_WORDS = new Set(["total", "libre", "neonatal", "inversa", "ss", "ds", "simple", "doble", "cadena"]);
const VERSION_METHOD_WORDS = new Set([...METHOD_WORDS, "inmuno", "inmunocromatografia", "quimioluminiscencia", "electroquimioluminiscencia", "automatizado", "automatizada", "convencional"]);
const OTHER_SAMPLE = /\b(?:orina|urin\w*|\w+uria|24|heces|liquido|liquidos|lcr|esputo|semen|saliva|hisopado|secrecion)\b/;
const STOP_WORDS = new Set(["de", "del", "en", "y", "la", "el"]);
const isPanel = (study: CatalogStudy): boolean => study.name.length > 90 || /^(?:panel|perfil)\b/i.test(study.name.trim());
// Las palabras pedidas están en el nombre (las de 5+ letras por su raíz, sin las 2 últimas letras: «reumatoide» ↔ «reumatoideo», «glicosilad» ↔ «glicosilada»; pero «electrolitos» ≠ «electroforesis»).
const hasWord = (words: ReadonlySet<string>, asked: string): boolean => {
  if (asked.length < 5) return words.has(asked);
  const root = asked.slice(0, Math.max(5, asked.length - 2));
  return [...words].some((word) => word.startsWith(root));
};
// El nombre del estudio sin lo que va entre paréntesis (también un paréntesis sin cerrar) ni método, cuantificación, clase, forma o muestra.
const versionBase = (name: string): Set<string> => {
  const words = normalizeStudyKey(name.replace(/\([^)]*\)/g, " ").replace(/\([^)]*$/, " ")).split(" ");
  // «IgG E IgM»: la «e» une dos clases (no es la hepatitis E).
  const joinsClasses = words.filter((word) => IG_WORDS.has(word)).length > 1;
  return new Set(words.filter((word) => word !== "" && !VERSION_METHOD_WORDS.has(word) && !QUANT_WORDS.has(word) && !IG_WORDS.has(word) && !FORM_WORDS.has(word) && !STOP_WORDS.has(word)
    && !OTHER_SAMPLE.test(word) && !(joinsClasses && (word === "e" || word === "y"))));
};
const hoursOf = (text: string | null | undefined): number | undefined => {
  const value = normalizeStudyKey(text ?? "");
  const n = Number(value.match(/\d+/)?.[0] ?? NaN);
  if (/minuto/.test(value)) return Number.isNaN(n) ? undefined : n / 60;
  if (/hora/.test(value)) return Number.isNaN(n) ? undefined : n;
  if (/en el dia|mismo dia/.test(value)) return 10;
  if (/dia/.test(value)) return Number.isNaN(n) ? undefined : n * 24;
  if (/semana/.test(value)) return Number.isNaN(n) ? undefined : n * 168;
  return undefined;
};
// ECLIA si hay UNA; si no, la de menor tiempo de entrega si es UNA. Lo que el paciente dijo (método o cuantificación) manda.
function fastestVersion(pool: readonly CatalogStudy[], asked: readonly string[]): CatalogStudy | undefined {
  let candidates = [...pool];
  const said = asked.filter((word) => VERSION_METHOD_WORDS.has(word) || QUANT_WORDS.has(word));
  if (said.length > 0) candidates = candidates.filter((study) => said.every((word) => hasWord(allNameWords(study.name), word)));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  const eclia = candidates.filter((study) => allNameWords(study.name).has("eclia"));
  if (eclia.length === 1) return eclia[0];
  if (eclia.length > 1) return undefined;
  const hours = candidates.map((study) => hoursOf(study.turnaroundText));
  if (hours.some((value) => value === undefined)) return undefined;
  const best = Math.min(...(hours as number[]));
  const fastest = candidates.filter((_, index) => hours[index] === best);
  return fastest.length === 1 ? fastest[0] : undefined;
}
export function chooseVersions(candidates: readonly CatalogStudy[], mention: string): CatalogStudy[] | undefined {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter((word) => word !== "" && !STOP_WORDS.has(word));
  if (asked.length === 0 || candidates.length < 2) return undefined;
  // «doble cadena» = ds, «simple cadena» = ss
  const askedForms = new Set(asked.filter((word) => FORM_WORDS.has(word)));
  if (askedForms.has("doble")) askedForms.add("ds");
  if (askedForms.has("simple")) askedForms.add("ss");
  let pool = candidates.filter((study) => !isPanel(study));
  if (!asked.some((word) => OTHER_SAMPLE.test(word))) {
    const blood = pool.filter((study) => !OTHER_SAMPLE.test(normalizeStudyKey(study.name)));
    if (blood.length > 0) pool = blood;
  }
  pool = pool.filter((study) => { const words = allNameWords(study.name); return asked.every((word) => FORM_WORDS.has(word) || hasWord(words, word)); });
  if (pool.length === 0) return undefined;
  // Solo las versiones «puras» (las demás agregan algo más al nombre: «CARGA VIRAL», «pneumoniae», «H.A.I.»).
  const bases = pool.map((study) => versionBase(study.name));
  const minimal = [...bases].sort((a, b) => a.size - b.size)[0]!;
  if (!bases.every((base) => [...minimal].every((word) => base.has(word)))) return undefined;
  pool = pool.filter((_, index) => bases[index]!.size === minimal.size);
  // Forma (total/libre/neonatal/ss/ds): la que no agrega una forma no pedida; si todas agregan una, se pregunta.
  const formsOf = (study: CatalogStudy) => [...allNameWords(study.name)].filter((word) => FORM_WORDS.has(word) && word !== "cadena");
  const plain = pool.filter((study) => formsOf(study).every((word) => askedForms.has(word)));
  if (plain.length === 0) return undefined;
  pool = plain;
  if (pool.length === 1) return pool;
  // Clase de anticuerpo: IgG + IgM (o la que pidió).
  const igOf = (study: CatalogStudy) => [...allNameWords(study.name)].filter((word) => IG_WORDS.has(word));
  if (pool.some((study) => igOf(study).length > 0)) {
    // Si además hay una prueba que trae las dos clases juntas («DENGUE TEST RAPIDO IgG E IgM»), no se elige: la Dra a veces cotiza esa (más rápida) y a veces otra.
    if (pool.some((study) => igOf(study).length > 1)) return undefined;
    const askedIg = asked.filter((word) => IG_WORDS.has(word));
    const present = new Set(pool.flatMap(igOf));
    const classes = (askedIg.length > 0 ? askedIg : ["igg", "igm"]).filter((cls) => present.has(cls));
    if (classes.length === 0) return undefined;
    const out: CatalogStudy[] = [];
    for (const cls of classes) {
      const pick = fastestVersion(pool.filter((study) => { const ig = igOf(study); return ig.length === 1 && ig[0] === cls; }), asked);
      if (!pick) return undefined;
      out.push(pick);
    }
    return out;
  }
  const pick = fastestVersion(pool, asked);
  return pick ? [pick] : undefined;
}

// Siglas con puntos en el catálogo («H.I.V 1,2», «H.A.I. TOXO», «CELULAS L.E.»): normalizadas quedan «h i v», que nadie escribe así. Se agrega (solo en memoria, sin tocar el catálogo) el alias
// con la sigla junta («hiv 1 2», «hai toxo»). Así la prueba rápida de HIV de Bs 50 aparece entre las opciones de «vih».
const dottedCache = new WeakMap<readonly CatalogStudy[], readonly CatalogStudy[]>();
export function withJoinedAcronyms(catalog: readonly CatalogStudy[]): readonly CatalogStudy[] {
  const cached = dottedCache.get(catalog);
  if (cached) return cached;
  const out = catalog.map((study) => {
    if (!/\b(?:[A-Za-z]\.){2,}/.test(study.name)) return study;
    const joined = normalizeStudyKey(study.name.replace(/\b((?:[A-Za-z]\.){2,}[A-Za-z]?)\.?/g, (acronym) => acronym.replace(/\./g, "")));
    const bare = normalizeStudyKey(study.name.replace(/\([^)]*\)/g, " ").replace(/\b((?:[A-Za-z]\.){2,}[A-Za-z]?)\.?/g, (acronym) => acronym.replace(/\./g, "")));
    const extra = [joined, bare].filter((alias) => alias !== "" && alias !== study.normalizedName && !(study.normalizedAliases ?? []).includes(alias));
    return extra.length > 0 ? { ...study, normalizedAliases: [...(study.normalizedAliases ?? []), ...new Set(extra)] } : study;
  });
  dottedCache.set(catalog, out);
  return out;
}

// ───────────── Nombres de GRUPO: lo que la Dra cotiza cuando el médico escribe el nombre del perfil (capturas 4–20 nov) ─────────────
// Si el catálogo tiene un estudio con ese nombre (un panel), manda el catálogo. «pending»: el laboratorio aún no confirmó la composición → se ofrecen como opciones (no se cotizan solos).
const STUDY_GROUPS: ReadonlyArray<{ phrases: readonly string[]; components: readonly string[]; pending?: true }> = [
  { phrases: ["transaminasas", "transaminasa", "transa"], components: ["TRANSAMINASA GOT", "TRANSAMINASA GPT"] },
  { phrases: ["perfil lipidico", "perfil de lipidos", "lipidograma", "perfil lipidico completo"], components: ["COLESTEROL TOTAL", "COLESTEROL HDL", "COLESTEROL LDL", "TRIGLICERIDOS"] },
  { phrases: ["perfil hepatico", "hepatograma", "pruebas hepaticas", "funcion hepatica", "hepatico", "perfil hepatico completo"], components: ["TRANSAMINASA GOT", "TRANSAMINASA GPT", "BILIRRUBINA TOTAL Y FRACCIONES", "FOSFATASA ALCALINA", "GAMA GLUTAMIL TRANSFERASA GGT"] },
  { phrases: ["perfil renal", "funcion renal", "pruebas renales", "perfil renal completo"], components: ["CREATININA", "UREA", "EXAMEN GENERAL DE ORINA COMPLETA"] },
  { phrases: ["coagulograma", "pruebas de coagulacion", "perfil de coagulacion", "coagulacion"], components: ["TIEMPO DE PROTROMBINA + INR", "TIEMPO PARCIAL DE TROMBOPLASTINA (APTT)", "TIEMPO DE COAGULACION", "TIEMPO DE SANGRIA"], pending: true }
];
function groupOf(mention: string, catalog: readonly CatalogStudy[]): { studies: CatalogStudy[]; pending: boolean } | undefined {
  const key = normalizeStudyKey(mention);
  const group = STUDY_GROUPS.find((item) => item.phrases.includes(key));
  if (!group || catalog.some((study) => normalizeStudyKey(study.name) === key || (study.normalizedAliases ?? []).includes(key))) return undefined;
  const byName = new Map(catalog.map((study) => [normalizeStudyKey(study.name), study]));
  const studies = group.components.map((name) => byName.get(normalizeStudyKey(name))).filter((study): study is CatalogStudy => study !== undefined);
  return studies.length > 0 ? { studies, pending: group.pending === true } : undefined;
}

// ───────────── La búsqueda por parecido nunca elige SOLA una variante que el paciente no escribió ─────────────
// «hepatitis» → «HEPATITIS E» (la «e» no se escribió y hay otras hepatitis); «testosterona» → «TOTAL» (existe la LIBRE). Ni se queda con un nombre al que le falta lo escrito:
// «hemoglobina glicosilad» → «HEMOGLOBINA» (falta «glicosilada»). En esos casos el resultado pasa a ser una duda entre las opciones que sí tienen todo lo escrito.
const SIGNIFICANT = (word: string): boolean => word.length >= 4 && !STOP_WORDS.has(word);
function reviewFuzzy(study: CatalogStudy, mention: string, catalog: readonly CatalogStudy[]): { keep: CatalogStudy } | { replace: CatalogStudy } | { doubt: CatalogStudy[] } {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter((word) => word !== "");
  const words = allNameWords(study.name);
  if (asked.filter(SIGNIFICANT).some((word) => !hasWord(words, word))) {
    const alternatives = catalog.filter((other) => !isPanel(other) && asked.filter(SIGNIFICANT).every((word) => hasWord(allNameWords(other.name), word)));
    if (alternatives.length === 1) return { replace: alternatives[0]! };
    if (alternatives.length > 1 && alternatives.length <= 8) return { doubt: alternatives };
    return { keep: study };
  }
  const extra = [...words].filter((word) => !asked.includes(word) && (/^[a-e]$/.test(word) || FORM_WORDS.has(word) || IG_WORDS.has(word)));
  if (extra.length === 0) return { keep: study };
  const siblings = catalog.filter((other) => other.id !== study.id && !isPanel(other) && asked.every((word) => hasWord(allNameWords(other.name), word)));
  return siblings.length === 0 ? { keep: study } : { doubt: [study, ...siblings].slice(0, 8) };
}

// Palabras de relleno delante del nombre de un estudio («prueba de», «dosaje de», «examen de»).
const FILLER = /^(?:(?:la|el|una?|unos?|las|los)\s+)?(?:pruebas?|examen(?:es)?|analisis|estudios?|dosajes?|dosificacion|test|nivel(?:es)?)(?!\s+rapid)\s+(?:de\s+(?:la\s+|el\s+|los\s+|las\s+)?|del\s+|para\s+(?:el\s+|la\s+)?)?/;
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
      const catalog = withJoinedAcronyms(await options.loadCatalog());
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
      // Las opciones dudosas se agrupan por lo que pidió el paciente («Para «pcr»: …»): así entiende por qué aparece cada una.
      const doubtGroups = new Map<string, CatalogStudy[]>();
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
        const forms = [...new Set([text, core, withoutBlood].filter((form) => form.length >= 2))];
        for (const form of forms) {
          const { extraction, notes } = extractWithNotes(`cotizar ${form}`, catalog, { fuzzy: true });
          if (!extraction?.isRequest || (extraction.matched.length === 0 && extraction.result.ambiguous.length === 0)) continue;
          // Los que salieron solo por PARECIDO (no por nombre, alias o sinónimo).
          const fuzzy = new Set(notes.interpreted.map((item) => item.studyName));
          return { matched: extraction.matched, groups: extraction.result.ambiguous, unresolved: extraction.result.unresolved > 0, forms, fuzzy };
        }
        return { matched: [], groups: [], unresolved: true, forms, fuzzy: new Set() };
      };
      const studiesOf = (result: { matched: CatalogStudy[]; groups: string[][] }) => [...result.matched, ...result.groups.flat().map((id) => byId.get(id)).filter((study): study is CatalogStudy => study !== undefined)];
      const queue = [...studies];
      for (let index = 0; index < queue.length && index < 40; index++) {
        const text = queue[index]!;
        // Nombre de un perfil («transaminasas», «perfil lipídico»): sus estudios, como los cotiza la Dra.
        const group = groupOf(coreOfMention(text), catalog);
        if (group) {
          if (group.pending) doubt(text, group.studies.filter((study) => !sure.has(study.id)));
          else for (const study of group.studies) sure.set(study.id, study);
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
          const blood = preferredBySample(candidates, text);
          // «psa total»: entre PSA TOTAL (ECLIA), PSA TOTAL (FIA) y PSA LIBRE (ECLIA) quedan los que tienen TODAS las palabras pedidas, y entre esos el método preferido (el mismo de la ruta de siempre).
          const named = blood ? undefined : namedChoice(candidates, text);
          // Versiones del mismo estudio sin especificar: como las elige la Dra (ver chooseVersions).
          const chosen = blood ? [blood] : named ? [named] : chooseVersions(candidates, text);
          // Si a lo elegido le falta algo que el paciente escribió y UN estudio lo tiene todo, es ese («hemoglobina glicosilad» no es la «HEMOGLOBINA» en sangre).
          const fixed = chosen?.map((study) => { const review = reviewFuzzy(study, text, catalog); return "replace" in review ? review.replace : study; });
          if (fixed) for (const study of fixed) sure.set(study.id, study);
          else doubt(text, candidates);
        }
        if (!unresolved) continue;
        // Lo que el motor no resolvió: los estudios más parecidos del catálogo como POSIBLES (nunca como cotización segura). Sin nada seguro en este nombre, la búsqueda es más amplia (como antes).
        const nothing = matched.length === 0 && groups.length === 0;
        const hits = forms.flatMap((form) => searchCatalog(form, catalog, { limit: nothing ? SUGGESTION_LIMIT : 3, minScore: nothing ? 0.5 : 0.6 })).sort((a, b) => b.score - a.score).map((hit) => hit.study).filter((study) => !sure.has(study.id));
        if (hits.length > 0) doubt(text, [...new Map(hits.map((study) => [study.id, study])).values()].slice(0, nothing ? SUGGESTION_LIMIT : 3));
        else if (nothing) notFound.push(text);
      }
      const possible = [...doubtful.values()].filter((study) => !sure.has(study.id));
      const optionGroups = [...doubtGroups].map(([label, list]) => ({ label, studies: list.filter((study) => !sure.has(study.id)) })).filter((item) => item.studies.length > 0);
      const facts: Array<Omit<Fact, "id">> = [];
      if (sure.size > 0) facts.push({ source: "QUOTE_ENGINE", text: `Estudios identificados con certeza en el catálogo (${sure.size}): ${[...sure.values()].map((study) => study.name).join("; ")}`, refs: [...sure.keys()].map((id) => `study:${id}`) });
      if (possible.length > 0) facts.push({ source: "CATALOG", text: `Estudios POSIBLES para lo que pidió, sin confirmar (el sistema los muestra numerados con su precio, fuera del total, agrupados por lo que pidió): ${optionGroups.map((item) => `«${item.label}»: ${item.studies.slice(0, OPTIONS_PER_MENTION).map((study) => study.name).join("; ")}`).join(" · ")}`, refs: possible.slice(0, OPTIONS_TOTAL_LIMIT).map((study) => `option:${study.id}`) });
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
      const optionsBlock = formatGroupedOptions(optionGroups, blocks.length > 0);
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
