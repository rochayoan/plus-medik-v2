import OpenAI from "openai";
import { z } from "zod";
import { cachedAiCall, usageFromResponses, type AiUsage } from "./cache.js";
import { normalizeStudyKey } from "./consensus.js";
import type { CatalogStudy } from "./types.js";

// FASE 3A — MODO SOMBRA: GPT como matcher principal de catálogo.
// Todo estudio visual final pasa por GPT (también los que el matcher exacto ya resuelve), viendo el catálogo ACTIVO COMPLETO
// (cobertura garantizada: no hay preselección que pueda excluir un candidato). GPT solo elige refs; los UUID y los precios
// salen siempre del catálogo. La decisión no depende de la confianza del modelo: la respuesta pasa por una verificación
// determinística (contradicciones de calificadores, variantes hermanas sobre el catálogo completo, alternativas, composición)
// y por un acuerdo entre dos pasadas independientes (catálogo y textos en distinto orden).
// Este módulo NO modifica el pipeline real: solo calcula y simula.

export type ShadowStatus = "MATCH" | "AMBIGUOUS" | "NO_MATCH" | "COMPOSITE";
export type Support = "EXACT" | "LEXICAL" | "SEMANTIC";

export interface ShadowQuery {
  literalText: string;
}

// Contexto impreso del documento que ayuda a distinguir variantes del catálogo. `lines` son líneas textuales (título, instrucciones) que
// GPT puede leer; `muestra` y `tiempo` son las ÚNICAS declaraciones que el verificador aplica, y solo existen si ambas lecturas
// independientes del documento coincidieron y el texto de la línea las respalda. Sin declaración (o con declaraciones contradictorias)
// el contexto no desambigua nada.
export interface ShadowContext {
  lines: string[];
  muestra?: string;
  tiempo?: string;
}

export type Outcome =
  | { kind: "MATCH"; studyId: string; support: Support; notes: string[] }
  | { kind: "AMBIGUOUS"; studyIds: string[]; reason: string }
  | { kind: "NO_MATCH"; reason: string }
  | { kind: "COMPOSITE"; components: Array<{ studyId: string; fragment: string; support: Support }>; reason: string }
  | { kind: "REJECTED"; studyIds: string[]; reason: string };

export interface FinalShadow {
  literalText: string;
  outcome: Outcome;
  // true si las dos pasadas independientes coincidieron.
  agreement: boolean;
  passes: [Outcome, Outcome];
  // Lo que GPT dijo en la primera pasada (informativo; nunca decide por sí solo).
  modelNotes: { reading: string; confidence: string; reason: string; rawStatuses: [ShadowStatus, ShadowStatus]; contextUsed?: string[] };
}

// ───────────────────────────── identidad clínica (determinística) ─────────────────────────────

export type Dim = "isotipo" | "libreTotal" | "cuantificacion" | "metodo" | "poblacion" | "muestra" | "tiempo";

const DIM_TOKENS: Record<Dim, Set<string>> = {
  isotipo: new Set(["igg", "igm", "iga", "ige", "igd"]),
  libreTotal: new Set(["libre", "total"]),
  cuantificacion: new Set(["cualitativo", "cuantitativo", "semicuantitativo"]),
  metodo: new Set(["eclia", "fia", "elisa", "clia", "ifi", "qpcr", "rt", "inmuno", "rapido", "fluorescencia", "inmunofluorescencia", "automatizado", "convencional"]),
  poblacion: new Set(["neonatal", "pediatrico", "varon", "mujer"]),
  muestra: new Set(["orina", "heces", "sangre", "saliva", "liquido", "esputo", "semen", "vaginal", "uretral", "nasal", "ocular", "faringea", "bronquial", "conjuntival", "bucal", "endocervical", "exocervical", "catete", "punta"]),
  tiempo: new Set(["24h", "2h", "ocasional", "seriado", "simple"])
};
const DIMS = Object.keys(DIM_TOKENS) as Dim[];
// Si el texto no dice nada en estas dimensiones y existe otra variante que sí las distingue, hay ambigüedad.
// La población se excluye: un estudio sin calificador de población es el general, no el neonatal/pediátrico/por sexo.
const NO_DEFAULT_DIMS: Dim[] = ["isotipo", "libreTotal", "cuantificacion", "metodo", "muestra", "tiempo"];

const CONNECTORS = new Set(["de", "del", "la", "las", "el", "los", "en", "con", "por", "para", "un", "una", "y", "o", "a", "e", "al", "se"]);

const FOLD: Record<string, string> = {
  cualitativa: "cualitativo", cuantitativa: "cuantitativo", semicuantitativa: "semicuantitativo",
  serico: "sangre", serica: "sangre", suero: "sangre", plasma: "sangre",
  urinario: "orina", urinaria: "orina", fecal: "heces", fecales: "heces",
  pediatrica: "pediatrico", neonatales: "neonatal", varones: "varon", hombre: "varon", masculino: "varon", femenino: "mujer",
  ocasionales: "ocasional", ocacional: "ocasional", rapida: "rapido", totales: "total", liquidos: "liquido", seriada: "seriado", simples: "simple"
};

// Orden: unir "Ig M" -> igm, "semi cuantitativo", "24 horas" -> 24h antes de separar en tokens.
export function identityTokens(text: string): string[] {
  const normalized = normalizeStudyKey(text.normalize("NFKD"))
    .replace(/\big ([a-z])\b/g, "ig$1")
    .replace(/\bsemi cuantitativ/g, "semicuantitativ")
    .replace(/\b24 (horas|hrs|hr|h)\b/g, "24h")
    .replace(/\b2 (horas|hrs|hr|h)\b/g, "2h")
    .replace(/\brt qpcr\b/g, "rt qpcr");
  return normalized.split(" ").filter(Boolean).map((token) => FOLD[token] ?? token);
}

const stem = (token: string) => (token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);

export type Qualifiers = Record<Dim, Set<string>>;

export function qualifiersOf(tokens: string[]): Qualifiers {
  const result = Object.fromEntries(DIMS.map((dim) => [dim, new Set<string>()])) as Qualifiers;
  for (const token of tokens) for (const dim of DIMS) if (DIM_TOKENS[dim].has(token)) result[dim].add(token);
  return result;
}

const BLOOD_CATEGORIES = new Set(["QUIMICA SANGUINEA", "HORMONAS", "VITAMINAS", "INMUNOSEROLOGIA", "SEROLOGIA", "AUTOINMUNIDAD", "MARCADORES TUMORALES", "HEMATOLOGIA", "PRUEBAS ESPECIALES", "OXIDOLOGIA", "METALES PESADOS"]);
function impliedSample(category?: string | null): string[] {
  if (!category) return [];
  if (BLOOD_CATEGORIES.has(category)) return ["sangre"];
  if (category === "URIANALISIS") return ["orina"];
  if (category === "PARASITOLOGIA") return ["heces"];
  if (category === "LIQUIDOS BIOLOGICOS") return ["liquido"];
  if (category === "FERTILIDAD") return ["semen"];
  return [];
}

export function studyQualifiers(study: CatalogStudy): Qualifiers {
  const q = qualifiersOf(identityTokens(study.normalizedName));
  if (q.muestra.size === 0) for (const sample of impliedSample(study.category)) q.muestra.add(sample);
  return q;
}

// Clave de analito: nombre sin calificadores, conectores ni plurales. Dos estudios con la misma clave son "variantes hermanas".
// Las siglas cortas entre paréntesis ("(Mg)", "(P)", "(Ro)") no cambian el analito y no deben impedir reconocer a las hermanas.
const stripShortParens = (name: string) => name.replace(/\([^()]{1,4}\)/g, " ");

export function baseKey(study: CatalogStudy): string {
  const all = new Set(DIMS.flatMap((dim) => [...DIM_TOKENS[dim]]));
  return identityTokens(stripShortParens(study.name))
    .filter((token) => !all.has(token) && !CONNECTORS.has(token))
    .map(stem)
    .sort()
    .join(" ");
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((value) => b.has(value));
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((value) => b.has(value));

// Contenido del nombre sin conectores y con plural simplificado; incluye calificadores.
const contentTokens = (text: string): string[] => identityTokens(text).filter((token) => !CONNECTORS.has(token)).map(stem);

// Las listas de componentes entre paréntesis ("(HIERRO, FERRITINA, ...)", "(sodio, potasio, cloro)") no son el analito del estudio.
const withoutComponentLists = (name: string) => name.replace(/\([^()]*[,/][^()]*\)/g, " ");

// Un rival de familia debe ser un estudio simple: no un perfil, panel, combo, curva ni una lista larga de analitos.
function isSingleAnalyte(study: CatalogStudy): boolean {
  const name = study.name;
  if (/^\s*(perfil|panel|curva|paquete)\b/i.test(name) || /\bcombo\b/i.test(name) || name.includes("+")) return false;
  if ((name.match(/,/g) ?? []).length >= 2) return false;
  return contentTokens(withoutComponentLists(name)).length <= 10;
}

// "Calcio" -> CALCIO SERICO: el texto es solo una parte del nombre (falta "sérico") y existen otros estudios simples que también contienen
// lo que el texto dice (CALCIO IONICO, CALCIURIA...). Si el texto ya nombra el estudio completo ("Glucosa" -> GLUCOSA) no hay familia
// que desambiguar. Si el texto no comparte palabras con ningún otro estudio (sinónimos, abreviaturas, errores), la regla no actúa.
export function familyRivals(text: string, chosen: CatalogStudy, fullCatalog: CatalogStudy[]): CatalogStudy[] {
  const t = new Set(contentTokens(text));
  if (t.size === 0) return [];
  const methods = DIM_TOKENS.metodo;
  const extra = contentTokens(stripShortParens(chosen.name)).filter((token) => !methods.has(token) && !t.has(token));
  if (extra.length === 0) return [];
  return fullCatalog.filter((other) => {
    if (other.id === chosen.id || !other.active || !isSingleAnalyte(other)) return false;
    const tokens = new Set(contentTokens(withoutComponentLists(other.name)));
    return [...t].every((token) => tokens.has(token));
  });
}

export interface IdentityCheck {
  ok: boolean;
  problems: string[];
  // Variantes hermanas (sobre el catálogo COMPLETO) igualmente plausibles que la elegida.
  plausibleSiblings: CatalogStudy[];
}

// Verifica que el estudio elegido sea compatible con el texto leído, con independencia de lo que el modelo diga.
export function checkIdentity(text: string, chosen: CatalogStudy, fullCatalog: CatalogStudy[], context?: ShadowContext): IdentityCheck {
  const t = qualifiersOf(identityTokens(text));
  const c = studyQualifiers(chosen);
  const problems: string[] = [];
  // El contexto solo completa lo que el texto del estudio NO dice (lo que el texto afirma siempre prevalece) y solo para desambiguar
  // variantes: nunca agrega calificadores al estudio elegido ni lo rechaza si no existe una variante compatible con el contexto.
  const declared: Array<[Dim, Set<string>]> = [];
  if (context?.muestra && t.muestra.size === 0) declared.push(["muestra", new Set([context.muestra])]);
  if (context?.tiempo && t.tiempo.size === 0) declared.push(["tiempo", new Set([context.tiempo])]);
  const te: Qualifiers = { ...t };
  for (const [dim, values] of declared) te[dim] = values;

  for (const dim of DIMS) {
    if (t[dim].size === 0) continue;
    // "total" es un calificador redundante cuando el estudio no distingue libre/total ("Calcio total", "IgG total"); "libre" sí exige respaldo.
    const redundantTotal = dim === "libreTotal" && t[dim].size === 1 && t[dim].has("total");
    if (c[dim].size === 0) {
      if (!redundantTotal) problems.push(`el texto indica ${dim} (${[...t[dim]].join("/")}) y el estudio no lo especifica`);
    } else if (!intersects(t[dim], c[dim])) problems.push(`contradicción en ${dim}: el texto dice ${[...t[dim]].join("/")} y el estudio ${[...c[dim]].join("/")}`);
  }

  const key = baseKey(chosen);
  const plausibleSiblings = key === "" ? [] : fullCatalog.filter((other) => {
    if (other.id === chosen.id || !other.active || baseKey(other) !== key) return false;
    const o = studyQualifiers(other);
    // compatible con el texto: todo lo que el texto afirma también lo cumple la hermana
    if (!DIMS.every((dim) => subset(te[dim], o[dim]))) return false;
    // y se distingue del elegido en algo sobre lo que ni el texto ni el contexto dicen nada
    return NO_DEFAULT_DIMS.some((dim) => te[dim].size === 0 && !(subset(o[dim], c[dim]) && subset(c[dim], o[dim])));
  });

  // Si el contexto declara una característica y el estudio elegido la contradice mientras existe una variante que sí la cumple,
  // se eligió contra el contexto. Si no existe tal variante (p. ej. un coproparasitológico en un formulario "de sangre"), el contexto no aplica.
  for (const [dim, values] of declared) {
    if (c[dim].size > 0 && !intersects(values, c[dim]) && key !== "") {
      const better = fullCatalog.some((other) => other.id !== chosen.id && other.active && baseKey(other) === key && intersects(values, studyQualifiers(other)[dim]));
      if (better) problems.push(`el contexto del documento indica ${dim} (${[...values].join("/")}) y existe una variante compatible; el estudio elegido es de ${[...c[dim]].join("/")}`);
    }
  }

  const rivals = new Map(plausibleSiblings.map((sibling) => [sibling.id, sibling]));
  for (const rival of familyRivals(text, chosen, fullCatalog)) {
    // una rival de familia que el contexto declarado contradice (otra muestra, otra recolección) no es plausible
    const q = studyQualifiers(rival);
    if (declared.some(([dim, values]) => q[dim].size > 0 && !intersects(values, q[dim]))) continue;
    rivals.set(rival.id, rival);
  }
  return { ok: problems.length === 0, problems, plausibleSiblings: [...rivals.values()] };
}

export function supportOf(text: string, study: CatalogStudy): Support {
  const norm = normalizeStudyKey(text);
  if (norm === study.normalizedName || study.normalizedAliases.includes(norm)) return "EXACT";
  const content = (tokens: string[]) => tokens.filter((token) => !CONNECTORS.has(token)).map(stem);
  const textTokens = new Set(content(identityTokens(text)));
  const nameTokens = new Set([...content(identityTokens(study.normalizedName)), ...study.normalizedAliases.flatMap((alias) => content(identityTokens(alias)))]);
  const allDimTokens = new Set(DIMS.flatMap((dim) => [...DIM_TOKENS[dim]]));
  const base = content(identityTokens(study.normalizedName)).filter((token) => !allDimTokens.has(token));
  if (base.length > 0 && base.every((token) => textTokens.has(token))) return "LEXICAL";
  if ([...textTokens].every((token) => nameTokens.has(token))) return "LEXICAL";
  return "SEMANTIC";
}

// ───────────────────────────── llamada a GPT ─────────────────────────────

const decisionSchema = z.object({
  index: z.number().int(),
  status: z.enum(["MATCH", "AMBIGUOUS", "NO_MATCH", "COMPOSITE"]),
  refs: z.array(z.string()),
  alternatives: z.array(z.string()),
  componentFragments: z.array(z.string()),
  reading: z.string(),
  qualifiersInText: z.array(z.string()),
  // Líneas textuales del contexto impreso que se usaron para elegir entre variantes ([] si ninguna). Solo auditoría.
  contextUsed: z.array(z.string()).default([]),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string()
});
const responseSchema = z.object({ decisions: z.array(decisionSchema) });
const rawResponseSchema = z.object({ decisions: z.array(z.unknown()) });

export const MAX_NAME_CHARS = 160;
const clip = (name: string) => (name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name);

const instructions = `
Eres un resolvedor CONSERVADOR de catálogo de laboratorio clínico. Recibes (1) el catálogo COMPLETO y cerrado de estudios
(una línea por estudio: ref|nombre|categoría|~alias aprobados) y (2) textos leídos de una solicitud médica. Para cada texto
decide qué estudio del catálogo se pidió. No hay precios en este problema y nunca debes mencionarlos.

Debes entender mayúsculas/minúsculas, errores ortográficos, abreviaturas médicas (p. ej. TGO, BUN, VSG, HbA1c), sinónimos
clínicos y distintas formas de escribir el mismo estudio.

Reglas estrictas:
- Solo puedes usar refs del catálogo recibido. Nunca inventes refs, estudios ni componentes.
- MATCH: exactamente UN estudio es, sin duda razonable, lo que pide el texto. refs = [ref]. En "alternatives" lista cualquier OTRO
  estudio del catálogo que también podría ser lo pedido (si hay alguna, probablemente debas responder AMBIGUOUS).
- AMBIGUOUS: dos o más estudios son plausibles. refs = todos los plausibles (≥2).
- NO_MATCH: ningún estudio del catálogo es claramente lo pedido, o el texto es un perfil/panel sin composición definida. refs = [].
- COMPOSITE: el texto NOMBRA EXPLÍCITAMENTE varios estudios (lista, barra, "+", paréntesis con la lista). refs = un ref por cada estudio
  nombrado, y componentFragments = para cada ref, el fragmento EXACTO del texto que lo nombra (misma longitud y orden que refs).
  Nunca agregues componentes que el texto no nombre. Si el texto dice solo "Perfil X" sin listar componentes y el catálogo no tiene
  un estudio único con ese nombre, responde NO_MATCH (no adivines la composición). Si el catálogo SÍ tiene un único estudio que es ese
  perfil/panel (p. ej. "PERFIL ENA"), responde MATCH.
- Sé MUY estricto con las variantes: método (ECLIA, FIA, ELISA, CLIA, IFI, RT-qPCR, prueba rápida), isotipo (IgG, IgM, IgA, IgE),
  libre/total, cuantitativo/cualitativo/semicuantitativo, muestra (suero, orina, heces, líquidos), orina de 24 horas u ocasional,
  serie simple/seriada. Si el texto NO especifica la variante y el catálogo tiene varios estudios que difieren en ella, responde AMBIGUOUS.
  No elijas una variante "por defecto" ni la más común. Una única excepción: si el texto no menciona población y existe un estudio general
  y otro neonatal/pediátrico/por sexo, el general es el pedido (no consideres plausible el especial).
- Si el texto nombra varios sinónimos separados por barras como alternativas del mismo estudio (p. ej. "Nitrógeno ureico/Urea/NUS") y el
  catálogo tiene estudios distintos para ellos, responde AMBIGUOUS.
- No uses el diagnóstico ni conocimiento clínico para completar lo que el texto no dice. Un perfil no equivale a uno solo de sus componentes.
- reading: tu interpretación en una frase (qué significa el texto). qualifiersInText: los calificadores que el texto afirma explícitamente
  (isotipo, método, muestra, cuantitativo/cualitativo, libre/total, población, tiempo), vacío si ninguno.
- confidence es solo informativa. En reason explica en una frase por qué, nombrando los estudios por su nombre (no por su ref).
- Responde una decisión por cada texto, con su "index".
`;

export interface ShadowRequest {
  promptText: string;
  catalogLines: number;
  items: Array<{ index: number; literalText: string }>;
}

export interface ShadowDeps {
  complete: (request: ShadowRequest) => Promise<{ value: unknown; usage?: AiUsage }>;
  model: string;
  reasoning: string;
}

function openaiParams(model: string, reasoning: string) {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(responseSchema);
  return {
    model,
    reasoning: { effort: reasoning as "low" | "medium" | "high" | "xhigh" | "max" },
    text: { format: { type: "json_schema" as const, name: "catalog_shadow_matching", strict: true, schema } }
  };
}

function defaultDeps(): ShadowDeps {
  const model = process.env.OPENAI_CATALOG_MODEL ?? "gpt-6.1-sol";
  const reasoning = process.env.OPENAI_CATALOG_REASONING ?? "medium";
  return {
    model,
    reasoning,
    complete: async (request) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is required (define it in .env)");
      const client = new OpenAI({ apiKey });
      const response = await client.responses.create({
        ...openaiParams(model, reasoning),
        input: [{ role: "user", content: [{ type: "input_text", text: request.promptText }] }]
      });
      return { value: JSON.parse(response.output_text), usage: usageFromResponses(response.usage) };
    }
  };
}

export interface RawDecision {
  index: number;
  status: ShadowStatus;
  studies: CatalogStudy[];
  alternatives: CatalogStudy[];
  fragments: string[];
  reading: string;
  confidence: string;
  reason: string;
  notes: string[];
  contextUsed?: string[];
}

// Convierte la respuesta cruda en decisiones con refs validadas (existen en el catálogo recibido). Pura: se prueba sin red.
export function parseDecisions(args: { queries: ShadowQuery[]; refMap: Map<string, CatalogStudy>; rawDecisions: unknown[]; context?: ShadowContext }): RawDecision[] {
  const contextKeys = (args.context?.lines ?? []).map((line) => normalizeStudyKey(line));
  return args.queries.map((query, index) => {
    const parsed = args.rawDecisions
      .map((raw) => decisionSchema.safeParse(raw))
      .find((result) => result.success && result.data.index === index);
    const empty: RawDecision = { index, status: "NO_MATCH", studies: [], alternatives: [], fragments: [], reading: "", confidence: "low", reason: "", notes: [], contextUsed: [] };
    if (!parsed || !parsed.success) return { ...empty, reason: "El modelo no devolvió una decisión válida para este texto.", notes: ["respuesta ausente o inválida"] };
    const d = parsed.data;
    const notes: string[] = [];
    const resolve = (refs: string[]) => {
      const out: CatalogStudy[] = [];
      for (const ref of [...new Set(refs)]) {
        const study = args.refMap.get(ref);
        if (study) out.push(study);
        else notes.push(`ref inexistente rechazada: ${ref}`);
      }
      return out;
    };
    const studies = resolve(d.refs);
    const alternatives = resolve(d.alternatives).filter((alt) => !studies.some((s) => s.id === alt.id));
    let status = d.status;
    if (status === "MATCH" && studies.length !== 1) { notes.push(`MATCH con ${studies.length} refs válidas`); status = studies.length > 1 ? "AMBIGUOUS" : "NO_MATCH"; }
    if (status === "AMBIGUOUS" && studies.length < 2) { notes.push("AMBIGUOUS con menos de 2 refs válidas"); status = "NO_MATCH"; }
    if (status === "COMPOSITE" && (studies.length < 2 || d.componentFragments.length !== d.refs.length)) { notes.push("COMPOSITE sin componentes válidos o sin un fragmento por componente"); status = "NO_MATCH"; }
    // Solo se registran citas del contexto que de verdad existen en el documento (verbatim, normalizadas).
    const contextUsed = d.contextUsed.filter((quote) => {
      const key = normalizeStudyKey(quote);
      const real = key !== "" && contextKeys.some((line) => line.includes(key));
      if (!real) notes.push(`cita de contexto inexistente descartada: ${quote}`);
      return real;
    });
    return { index, status, studies: status === "NO_MATCH" ? [] : studies, alternatives, fragments: d.componentFragments, reading: d.reading, confidence: d.confidence, reason: d.reason, notes, contextUsed };
  });
}

// ───────────────────────────── verificación ─────────────────────────────

export const GENERIC_PROFILE_WORDS = new Set(["perfil", "panel", "paquete", "estudio", "estudios", "examen", "examenes", "pruebas"]);

function itemsOf(text: string): string[] {
  return text.split(/[,;/+()]|\sy\s/i).map((part) => part.trim()).filter(Boolean);
}

// ───────────────────────────── paquetes aprobados ─────────────────────────────
// Un alias aprobado del catálogo manda sobre la descomposición: "ELECTROLITOS EN SANGRE (NA, K Y CL)" es el alias de 413 IONOGRAMA 1
// (sodio, potasio, cloro), un estudio único con su propio precio, no tres cobros. Antes de aceptar el paquete se verifica que los
// componentes propuestos por el modelo sean EXACTAMENTE los que el nombre del paquete lista (misma muestra); si no, revisión humana.

// El estudio activo cuyo nombre o alias aprobado es exactamente el texto (mismo criterio que el matcher exacto). Único o nada.
export function approvedPackage(text: string, catalog: CatalogStudy[]): CatalogStudy | undefined {
  const key = normalizeStudyKey(text);
  if (key === "") return undefined;
  const hits = catalog.filter((study) => study.active && (study.normalizedName === key || study.normalizedAliases.includes(key)));
  return hits.length === 1 ? hits[0] : undefined;
}

// Componentes que el nombre del paquete lista entre paréntesis: "IONOGRAMA 1 (sodio, potasio, cloro)" -> [sodio, potasio, cloro].
export function packageItems(pkg: CatalogStudy): string[] {
  for (const match of [...pkg.name.matchAll(/\(([^()]+)\)/g)].reverse()) {
    const items = match[1]!.split(/\s*(?:,|;|\+|\/|\sy\s)\s*/i).map((item) => item.trim()).filter(Boolean);
    if (items.length >= 2) return items;
  }
  return [];
}

// Clave de analito de un texto suelto: sin calificadores, conectores ni plurales (igual que baseKey para estudios).
function itemKey(item: string): string {
  const all = new Set(DIMS.flatMap((dim) => [...DIM_TOKENS[dim]]));
  return identityTokens(item).filter((token) => !all.has(token) && !CONNECTORS.has(token)).map(stem).sort().join(" ");
}

function sampleCompatible(a: Qualifiers, b: Qualifiers): boolean {
  return (["muestra", "tiempo"] as const).every((dim) => a[dim].size === 0 || b[dim].size === 0 || intersects(a[dim], b[dim]));
}

export function verifyPackageComposition(pkg: CatalogStudy, components: CatalogStudy[]): { ok: boolean; reason: string } {
  const items = packageItems(pkg);
  if (items.length < 2) return { ok: false, reason: "el paquete no lista sus componentes en el nombre: no se puede verificar la composición" };
  if (items.length !== components.length) return { ok: false, reason: `el paquete lista ${items.length} componentes (${items.join(", ")}) y se propusieron ${components.length}` };
  if (components.some((component) => !component.active)) return { ok: false, reason: "un componente propuesto no está activo" };
  const packageQualifiers = studyQualifiers(pkg);
  const unused = new Set(components);
  for (const item of items) {
    const key = itemKey(item);
    const hit = [...unused].find((component) => baseKey(component) === key && sampleCompatible(studyQualifiers(component), packageQualifiers));
    if (!hit) return { ok: false, reason: `el componente "${item}" del paquete no está entre los propuestos (o es de otra muestra)` };
    unused.delete(hit);
  }
  return { ok: true, reason: "" };
}

export function verifyDecision(text: string, raw: RawDecision, fullCatalog: CatalogStudy[], context?: ShadowContext): Outcome {
  if (raw.status === "NO_MATCH") return { kind: "NO_MATCH", reason: raw.reason || raw.notes.join("; ") || "sin coincidencia" };
  if (raw.status === "AMBIGUOUS") return { kind: "AMBIGUOUS", studyIds: raw.studies.map((s) => s.id), reason: raw.reason };

  if (raw.status === "MATCH") {
    const chosen = raw.studies[0]!;
    if (!chosen.active) return { kind: "REJECTED", studyIds: [chosen.id], reason: "el estudio elegido no está activo" };
    const identity = checkIdentity(text, chosen, fullCatalog, context);
    if (!identity.ok) return { kind: "REJECTED", studyIds: [chosen.id], reason: `verificación de identidad: ${identity.problems.join("; ")}` };
    const rivals = new Map<string, CatalogStudy>();
    for (const sibling of identity.plausibleSiblings) rivals.set(sibling.id, sibling);
    for (const alt of raw.alternatives) {
      // una alternativa que contradice lo que el texto afirma no cuenta como plausible
      if (alt.active && checkIdentity(text, alt, fullCatalog, context).ok) rivals.set(alt.id, alt);
    }
    if (rivals.size > 0) {
      return {
        kind: "AMBIGUOUS",
        studyIds: [chosen.id, ...rivals.keys()],
        reason: `existen variantes igualmente plausibles que el texto no distingue (${[...rivals.values()].map((s) => s.code ?? s.name).join(", ")}); el modelo eligió "${chosen.name}"`
      };
    }
    return { kind: "MATCH", studyId: chosen.id, support: supportOf(text, chosen), notes: raw.notes };
  }

  // COMPOSITE. Primero, un alias aprobado de un paquete del catálogo manda: se acepta el paquete único si la composición coincide.
  const pkg = approvedPackage(text, fullCatalog);
  if (pkg) {
    const composition = verifyPackageComposition(pkg, raw.studies);
    if (!composition.ok) {
      return { kind: "REJECTED", studyIds: [pkg.id, ...raw.studies.map((s) => s.id)], reason: `el texto es el alias aprobado de «${pkg.name}», pero ${composition.reason}` };
    }
    return { kind: "MATCH", studyId: pkg.id, support: "EXACT", notes: [`paquete aprobado «${pkg.name}»: componentes verificados (${packageItems(pkg).join(", ")})`] };
  }

  // Sin paquete: cada componente debe estar nombrado en el texto, ser compatible por sí mismo y la lista debe quedar cubierta.
  const textNorm = normalizeStudyKey(text);
  // La muestra declarada en el texto FUERA de los fragmentos ("ELECTROLITOS EN SANGRE (NA, K Y CL)") califica a todos los componentes;
  // la que pertenece a un fragmento ("Glucosa y orina completa") no se traslada a los demás.
  let remainder = textNorm;
  for (const fragment of raw.fragments) {
    const fragNorm = normalizeStudyKey(fragment);
    if (fragNorm !== "") remainder = remainder.replace(fragNorm, " ");
  }
  const sharedSample = qualifiersOf(identityTokens(remainder)).muestra;
  const inherited: ShadowContext = { lines: context?.lines ?? [], muestra: sharedSample.size === 1 ? [...sharedSample][0] : context?.muestra, tiempo: context?.tiempo };
  const components: Array<{ studyId: string; fragment: string; support: Support }> = [];
  for (let i = 0; i < raw.studies.length; i++) {
    const study = raw.studies[i]!;
    const fragment = raw.fragments[i] ?? "";
    const fragNorm = normalizeStudyKey(fragment);
    if (fragNorm === "" || !textNorm.includes(fragNorm)) return { kind: "REJECTED", studyIds: raw.studies.map((s) => s.id), reason: `el fragmento "${fragment}" no aparece en el texto` };
    if (!study.active) return { kind: "REJECTED", studyIds: [study.id], reason: "un componente no está activo" };
    const identity = checkIdentity(fragment, study, fullCatalog, inherited);
    if (!identity.ok) return { kind: "REJECTED", studyIds: [study.id], reason: `componente "${fragment}": ${identity.problems.join("; ")}` };
    if (identity.plausibleSiblings.length > 0) {
      return { kind: "AMBIGUOUS", studyIds: [study.id, ...identity.plausibleSiblings.map((s) => s.id)], reason: `el componente "${fragment}" tiene variantes plausibles` };
    }
    components.push({ studyId: study.id, fragment, support: supportOf(fragment, study) });
  }
  if (new Set(components.map((c) => c.studyId)).size !== components.length) return { kind: "REJECTED", studyIds: raw.studies.map((s) => s.id), reason: "componentes repetidos" };

  const fragments = components.map((c) => normalizeStudyKey(c.fragment));
  const uncovered = itemsOf(text).filter((item, position) => {
    const norm = normalizeStudyKey(item);
    if (fragments.some((f) => norm.includes(f) || f.includes(norm))) return false;
    const generic = norm.split(" ").some((word) => GENERIC_PROFILE_WORDS.has(word));
    return !(position === 0 && generic);
  });
  if (uncovered.length > 0) return { kind: "REJECTED", studyIds: raw.studies.map((s) => s.id), reason: `elementos de la lista sin componente: ${uncovered.join(", ")}` };
  return { kind: "COMPOSITE", components, reason: raw.reason };
}

const sameOutcome = (a: Outcome, b: Outcome): boolean => {
  if (a.kind !== b.kind) return false;
  const ids = (o: Outcome): string[] =>
    o.kind === "MATCH" ? [o.studyId] : o.kind === "COMPOSITE" ? o.components.map((c) => c.studyId) : o.kind === "AMBIGUOUS" || o.kind === "REJECTED" ? o.studyIds : [];
  const x = ids(a).slice().sort().join("|");
  const y = ids(b).slice().sort().join("|");
  return a.kind === "NO_MATCH" ? true : x === y;
};

function combine(a: Outcome, b: Outcome): { outcome: Outcome; agreement: boolean } {
  if (sameOutcome(a, b)) return { outcome: a, agreement: true };
  const ids = new Set<string>();
  for (const o of [a, b]) {
    if (o.kind === "MATCH") ids.add(o.studyId);
    else if (o.kind === "AMBIGUOUS" || o.kind === "REJECTED") o.studyIds.forEach((id) => ids.add(id));
    else if (o.kind === "COMPOSITE") o.components.forEach((c) => ids.add(c.studyId));
  }
  const describe = (o: Outcome) => (o.kind === "MATCH" ? `MATCH ${o.studyId}` : o.kind);
  return { outcome: { kind: "AMBIGUOUS", studyIds: [...ids], reason: `las dos pasadas independientes no coinciden (${describe(a)} vs ${describe(b)})` }, agreement: false };
}

// ───────────────────────────── ejecución ─────────────────────────────

export interface PassResult {
  decisions: RawDecision[];
  usage?: AiUsage;
  calledModel: boolean;
}

export function activeCatalog(catalog: CatalogStudy[]): CatalogStudy[] {
  return catalog.filter((study) => study.active);
}

// Bloque de contexto impreso (solo si existe). Las reglas acotan su uso: desambiguar variantes, nunca agregar ni completar estudios.
export function contextBlock(context?: ShadowContext): string {
  if (!context || context.lines.length === 0) return "";
  const declarations = [context.muestra ? `muestra=${context.muestra}` : "", context.tiempo ? `recolección=${context.tiempo}` : ""].filter(Boolean);
  return `
CONTEXTO IMPRESO DEL DOCUMENTO (líneas del encabezado o de las instrucciones; NO son estudios a resolver):
${context.lines.map((line) => `- "${line}"`).join("\n")}
DECLARACIONES VERIFICADAS DEL CONTEXTO: ${declarations.length > 0 ? declarations.join("; ") : "ninguna"}
Reglas del contexto:
- Úsalo SOLO para distinguir variantes del catálogo que difieren en lo que una declaración verificada establece (muestra; orina de 24 horas u ocasional), cuando el texto del estudio no lo dice. Nunca para agregar estudios ni para completar lo que el texto no dice.
- Lo que el propio texto del estudio afirma prevalece sobre el contexto.
- Si no hay declaración verificada para esa característica, no uses el contexto: responde AMBIGUOUS si hay variantes plausibles.
- No asumas que todos los estudios comparten la muestra del título: aplica solo lo declarado, y si un estudio por su naturaleza no admite esa muestra, no fuerces la variante.
- En contextUsed copia textualmente las líneas del contexto que usaste para elegir entre variantes ([] si no usaste ninguna).
`;
}

export function buildPrompt(order: CatalogStudy[], refOf: Map<string, string>, items: Array<{ index: number; literalText: string }>, context?: ShadowContext): string {
  const lines = order.map((study) => {
    const aliases = study.normalizedAliases.length > 0 ? `|~${study.normalizedAliases.join(";")}` : "";
    return `${refOf.get(study.id)}|${clip(study.name)}|${study.category ?? ""}${aliases}`;
  });
  return `${instructions}${contextBlock(context)}\nCATÁLOGO (${order.length} estudios activos):\n${lines.join("\n")}\n\nTEXTOS A RESOLVER:\n${JSON.stringify(items)}`;
}

// variant "A": orden del catálogo; variant "B": catálogo y textos en orden inverso con otras refs.
export async function runShadowPass(args: { queries: ShadowQuery[]; catalog: CatalogStudy[]; variant: "A" | "B"; deps?: Partial<ShadowDeps>; context?: ShadowContext }): Promise<PassResult> {
  const resolved = { ...defaultDeps(), ...args.deps };
  const active = activeCatalog(args.catalog);
  const order = args.variant === "A" ? active : [...active].reverse();
  const refOf = new Map(order.map((study, i) => [study.id, `s${i + 1}`]));
  const refMap = new Map(order.map((study) => [refOf.get(study.id)!, study]));
  const itemOrder = args.queries.map((q, index) => ({ index, literalText: q.literalText }));
  const items = args.variant === "A" ? itemOrder : [...itemOrder].reverse();
  const promptText = buildPrompt(order, refOf, items, args.context);

  let usage: AiUsage | undefined;
  let called = false;
  const { decisions } = await cachedAiCall({
    label: "openai-catalog-shadow",
    provider: "openai",
    model: resolved.model,
    imageBase64: "",
    config: { prompt: promptText, params: openaiParams(resolved.model, resolved.reasoning) },
    parse: (raw) => rawResponseSchema.parse(raw),
    call: async () => {
      called = true;
      const response = await resolved.complete({ promptText, catalogLines: order.length, items });
      usage = response.usage;
      return { value: rawResponseSchema.parse(response.value), usage: response.usage };
    }
  });
  return { decisions: parseDecisions({ queries: args.queries, refMap, rawDecisions: decisions, context: args.context }), usage, calledModel: called };
}

export interface ShadowBatch {
  results: FinalShadow[];
  usage: AiUsage[];
  calls: number;
  cacheHits: number;
  model: string;
  reasoning: string;
  catalogSize: number;
}

export async function shadowMatch(args: { queries: ShadowQuery[]; catalog: CatalogStudy[]; deps?: Partial<ShadowDeps>; context?: ShadowContext }): Promise<ShadowBatch> {
  const resolved = { ...defaultDeps(), ...args.deps };
  const fullCatalog = activeCatalog(args.catalog);
  if (args.queries.length === 0) return { results: [], usage: [], calls: 0, cacheHits: 0, model: resolved.model, reasoning: resolved.reasoning, catalogSize: fullCatalog.length };
  const [a, b] = await Promise.all([
    runShadowPass({ ...args, variant: "A", deps: args.deps }),
    runShadowPass({ ...args, variant: "B", deps: args.deps })
  ]);
  const results: FinalShadow[] = args.queries.map((query, i) => {
    const outA = verifyDecision(query.literalText, a.decisions[i]!, fullCatalog, args.context);
    const outB = verifyDecision(query.literalText, b.decisions[i]!, fullCatalog, args.context);
    const { outcome, agreement } = combine(outA, outB);
    const first = a.decisions[i]!;
    return { literalText: query.literalText, outcome, agreement, passes: [outA, outB], modelNotes: { reading: first.reading, confidence: first.confidence, reason: first.reason, rawStatuses: [first.status, b.decisions[i]!.status], contextUsed: [...new Set([...(first.contextUsed ?? []), ...(b.decisions[i]!.contextUsed ?? [])])] } };
  });
  return {
    results,
    usage: [a.usage, b.usage].filter((u): u is AiUsage => Boolean(u)),
    calls: [a, b].filter((p) => p.calledModel).length,
    cacheHits: [a, b].filter((p) => !p.calledModel).length,
    model: resolved.model,
    reasoning: resolved.reasoning,
    catalogSize: fullCatalog.length
  };
}

// ───────────────────────────── simulación de política (NO es el safety real) ─────────────────────────────

export type ShadowReason =
  | "handwritten_out_of_scope"
  | "not_a_request"
  | "document_type_uncertain"
  | "document_not_complete"
  | "visual_disputes_unresolved"
  | "no_requested_studies"
  | "non_high_certainty_study"
  | "shadow_ambiguous"
  | "shadow_no_match"
  | "shadow_composite_requires_policy"
  | "shadow_rejected_by_verifier"
  | "shadow_passes_disagree";

export interface SimulatedLine { id: string; code: string | null; name: string; priceBs: number; support: Support | "COMPOSITE" }

export interface SimulatedDecision {
  decision: "AUTO_SAFE" | "HUMAN_REVIEW";
  reasons: ShadowReason[];
  perStudy: Array<{ literalText: string; ok: boolean; reason?: ShadowReason }>;
  // Solo estudios verificados; los precios salen siempre del catálogo, nunca del modelo.
  verifiedLines: SimulatedLine[];
  verifiedSubtotalBs: number;
  complete: boolean;
  quote?: { lines: SimulatedLine[]; totalBs: number; tariff: "PACIENTE" };
}

export interface DocumentGate {
  documentType: "TEXT_EXPLICIT_REQUEST" | "MARK_DEPENDENT_FORM" | "HANDWRITTEN_REQUEST" | "NOT_A_REQUEST" | "UNKNOWN";
  completeDocumentVisible: boolean;
}

export function simulateShadowPolicy(args: {
  // Señal de tipo de documento (mismas reglas que safety.ts). Si falta, se trata como incierta: nunca AUTO.
  document: DocumentGate | undefined;
  unresolvedVisualDisputes: number;
  studies: Array<{ literalText: string; confidence: "high" | "medium" | "low" }>;
  results: FinalShadow[];
  catalog: CatalogStudy[];
  allowExplicitComposites: boolean;
}): SimulatedDecision {
  const byId = new Map(args.catalog.map((study) => [study.id, study]));
  const reasons = new Set<ShadowReason>();
  const doc = args.document;
  if (!doc || doc.documentType === "UNKNOWN") reasons.add("document_type_uncertain");
  else if (doc.documentType === "HANDWRITTEN_REQUEST") reasons.add("handwritten_out_of_scope");
  else if (doc.documentType === "NOT_A_REQUEST") reasons.add("not_a_request");
  if (doc && !doc.completeDocumentVisible) reasons.add("document_not_complete");
  if (args.unresolvedVisualDisputes > 0) reasons.add("visual_disputes_unresolved");
  if (args.studies.length === 0) reasons.add("no_requested_studies");
  if (args.studies.some((study) => study.confidence !== "high")) reasons.add("non_high_certainty_study");

  const lines = new Map<string, SimulatedLine>();
  const perStudy: SimulatedDecision["perStudy"] = [];
  const addLine = (id: string, support: SimulatedLine["support"]) => {
    const study = byId.get(id);
    if (study && !lines.has(id)) lines.set(id, { id, code: study.code, name: study.name, priceBs: study.priceBs, support });
  };

  args.results.forEach((result) => {
    const o = result.outcome;
    let reason: ShadowReason | undefined;
    if (!result.agreement) reason = "shadow_passes_disagree";
    else if (o.kind === "AMBIGUOUS") reason = "shadow_ambiguous";
    else if (o.kind === "NO_MATCH") reason = "shadow_no_match";
    else if (o.kind === "REJECTED") reason = "shadow_rejected_by_verifier";
    else if (o.kind === "COMPOSITE" && !args.allowExplicitComposites) reason = "shadow_composite_requires_policy";
    if (reason) reasons.add(reason);
    perStudy.push({ literalText: result.literalText, ok: !reason, reason });
    if (!reason) {
      if (o.kind === "MATCH") addLine(o.studyId, o.support);
      else if (o.kind === "COMPOSITE") for (const component of o.components) addLine(component.studyId, "COMPOSITE");
    }
  });

  const verifiedLines = [...lines.values()];
  const verifiedSubtotalBs = verifiedLines.reduce((sum, line) => sum + line.priceBs, 0);
  const complete = perStudy.every((p) => p.ok) && perStudy.length > 0;
  const decision = reasons.size === 0 ? "AUTO_SAFE" : "HUMAN_REVIEW";
  return {
    decision,
    reasons: [...reasons],
    perStudy,
    verifiedLines,
    verifiedSubtotalBs,
    complete,
    quote: decision === "AUTO_SAFE" ? { lines: verifiedLines, totalBs: verifiedSubtotalBs, tariff: "PACIENTE" } : undefined
  };
}
