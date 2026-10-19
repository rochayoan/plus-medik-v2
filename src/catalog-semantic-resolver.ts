import OpenAI from "openai";
import { z } from "zod";
import { cachedAiCall, usageFromResponses, type AiUsage } from "./cache.js";
import { normalizeStudyKey } from "./consensus.js";
import type { CatalogStudy } from "./types.js";

// FASE 2E — Segunda capa de resolución de catálogo SOLO para textos que el matcher exacto/alias dejó UNMATCHED.
// El modelo solo puede elegir entre candidatos que le enviamos; un MATCH nunca produce AUTO (lo decide analyze.ts).

export type SemanticConfidence = "high" | "medium" | "low";

export type SemanticResolution =
  | { status: "MATCH"; studyId: string; confidence: SemanticConfidence; reason: string }
  | { status: "AMBIGUOUS"; candidateStudyIds: string[]; reason: string }
  | { status: "NO_MATCH"; reason: string };

export interface SemanticQuery {
  literalText: string;
  // Lo que normalizó el lector: SOLO contexto secundario, nunca la fuente principal.
  normalizedName?: string;
}

export interface CandidateInfo {
  sent: number;
  studyIds: string[];
  truncated: boolean;
  fullCatalog: boolean;
}

export interface SemanticItemResult {
  literalText: string;
  resolution: SemanticResolution;
  candidates: CandidateInfo;
  // Se rellena cuando la respuesta del modelo fue rechazada o corregida por una guarda del código.
  note?: string;
}

export interface SemanticBatchResult {
  items: SemanticItemResult[];
  model: string;
  reasoning: string;
  // false cuando todo salió del cache o no hubo llamada.
  calledModel: boolean;
  cacheHit: boolean;
  usage?: AiUsage;
  candidatesSentToModel: number;
}

// ---------------------------------------------------------------------------------------------
// Preselección determinista (NO decide el match: solo reduce lo que ve el modelo)
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set(["de", "del", "la", "las", "el", "los", "en", "y", "o", "a", "e", "con", "por", "para", "un", "una"]);

export const MAX_CANDIDATES = 100;
const MIN_RELATIVE_SCORE = 0.35;

const tokensOf = (value: string): string[] =>
  normalizeStudyKey(value.normalize("NFKD")).split(" ").filter((token) => token !== "" && !STOPWORDS.has(token));

function trigrams(token: string): Set<string> {
  const padded = `  ${token} `;
  return new Set(Array.from({ length: padded.length - 2 }, (_, i) => padded.slice(i, i + 3)));
}

function dice(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const gram of ta) if (tb.has(gram)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

// 1 = igual; 0.8 = prefijo (hemog -> hemograma); 0.6 = parecido por trigramas (prolactnia -> prolactina); 0 = nada.
function tokenStrength(query: string, target: string): number {
  if (query === target) return 1;
  if (Math.min(query.length, target.length) >= 3 && (target.startsWith(query) || query.startsWith(target))) return 0.8;
  if (query.length >= 5 && target.length >= 5 && dice(query, target) >= 0.5) return 0.6;
  return 0;
}

export interface Preselection {
  studies: CatalogStudy[];
  truncated: boolean;
  // Sin ninguna señal léxica: se envía el catálogo completo (compacto) para no perder candidatos.
  fullCatalog: boolean;
}

export function preselectCandidates(query: SemanticQuery, catalog: CatalogStudy[]): Preselection {
  const queryTokens = [...new Set([...tokensOf(query.literalText), ...tokensOf(query.normalizedName ?? "")])];
  if (queryTokens.length === 0) return { studies: [], truncated: false, fullCatalog: false };

  const pools = catalog.map((study) => new Set([...tokensOf(study.normalizedName), ...study.normalizedAliases.flatMap(tokensOf)]));
  const documentFrequency = new Map<string, number>();
  for (const pool of pools) for (const token of pool) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const weight = (token: string) => Math.log(1 + catalog.length / (documentFrequency.get(token) ?? 1));
  const total = queryTokens.reduce((sum, token) => sum + weight(token), 0);

  const scored = catalog.map((study, index) => {
    let score = 0;
    for (const token of queryTokens) {
      let best = 0;
      for (const target of pools[index]!) best = Math.max(best, tokenStrength(token, target));
      score += weight(token) * best;
    }
    return { study, score: score / total, index };
  });

  const positive = scored.filter((entry) => entry.score > 0);
  if (positive.length === 0) return { studies: catalog, truncated: false, fullCatalog: true };

  const kept = positive
    .filter((entry) => entry.score >= MIN_RELATIVE_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (kept.length === 0) return { studies: catalog, truncated: false, fullCatalog: true };

  const truncated = kept.length > MAX_CANDIDATES;
  const chosen = kept.slice(0, MAX_CANDIDATES).sort((a, b) => a.index - b.index);
  return { studies: chosen.map((entry) => entry.study), truncated, fullCatalog: false };
}

// ---------------------------------------------------------------------------------------------
// Guarda determinística contra elecciones arbitrarias entre variantes
// ---------------------------------------------------------------------------------------------

const QUALIFIER_TOKENS = new Set([
  // métodos
  "eclia", "fia", "elisa", "clia", "ifi", "pcr", "qpcr", "rt", "fluorescencia", "inmunofluorescencia", "quimioluminiscencia",
  "turbidimetria", "nefelometria", "automatizado",
  // isotipos
  "igg", "igm", "iga", "ige",
  // forma / población / formato
  "neonatal", "libre", "total", "directa", "indirecta", "cualitativo", "cuantitativo", "semi", "pediatrico", "rapida", "prueba",
  "basal", "inversa", "ocasional", "24", "horas", "hrs", "hr", "2h", "60", "120", "min", "simple", "doble", "cadena", "convencional",
  "varon", "mujer", "hombre", "femenino", "masculino",
  // muestra
  "orina", "heces", "saliva", "sangre", "plasma", "suero", "liquido", "esputo", "secrecion"
]);

// Para comparar variantes NO se descartan letras sueltas ("Hepatitis A", "Vitamina B2"); solo conectores.
const BASE_CONNECTORS = new Set(["de", "del", "la", "las", "el", "los", "en", "con", "por", "para", "un", "una", "y"]);
const baseTokens = (text: string): string[] =>
  normalizeStudyKey(text.normalize("NFKD")).split(" ").filter((token) => token !== "" && !BASE_CONNECTORS.has(token));

const FOLD: Record<string, string> = { cuantitativa: "cuantitativo", cualitativa: "cualitativo", cualitativo: "cualitativo", pediatrica: "pediatrico" };
const foldToken = (token: string) => FOLD[token] ?? token;

function qualifiersOf(text: string): Set<string> {
  return new Set(baseTokens(text).map(foldToken).filter((token) => QUALIFIER_TOKENS.has(token)));
}

const baseKey = (study: CatalogStudy) =>
  baseTokens(study.normalizedName).map(foldToken).filter((token) => !QUALIFIER_TOKENS.has(token)).sort().join(" ");

const isSubset = (small: Set<string>, large: Set<string>) => [...small].every((token) => large.has(token));

// Si el texto leído no basta para distinguir entre el estudio elegido y otras variantes del mismo estudio
// (otro método, IgG/IgM, libre/total, neonatal, sexo...), un MATCH del modelo se degrada a AMBIGUOUS.
export function variantAmbiguity(chosen: CatalogStudy, literalText: string, sent: CatalogStudy[]): CatalogStudy[] {
  const textQualifiers = qualifiersOf(literalText);
  const chosenQualifiers = qualifiersOf(chosen.normalizedName);
  const chosenBase = baseKey(chosen);
  if (chosenBase === "") return [];
  const compatibleSiblings = sent.filter((other) => {
    if (other.id === chosen.id || baseKey(other) !== chosenBase) return false;
    const otherQualifiers = qualifiersOf(other.normalizedName);
    return isSubset(textQualifiers, chosenQualifiers) && isSubset(textQualifiers, otherQualifiers);
  });
  return compatibleSiblings;
}

// ---------------------------------------------------------------------------------------------
// Prompt, esquema y validación de la respuesta
// ---------------------------------------------------------------------------------------------

const decisionSchema = z.object({
  index: z.number().int(),
  status: z.enum(["MATCH", "AMBIGUOUS", "NO_MATCH"]),
  refs: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string()
});
const responseSchema = z.object({ decisions: z.array(decisionSchema) });
const rawResponseSchema = z.object({ decisions: z.array(z.unknown()) });

const instructions = `
Eres un resolvedor CONSERVADOR de catálogo de laboratorio clínico. Recibes textos leídos de una solicitud de
estudios (puede haber errores de tipeo, abreviaturas o palabras cortadas) y, para cada texto, una lista cerrada
de candidatos del catálogo real. Decide cuál estudio del catálogo corresponde a lo que está escrito.

Reglas estrictas:
- Solo puedes elegir candidatos de la lista del propio texto (campo candidateRefs), usando su "ref". Nunca inventes refs,
  estudios ni códigos. No hay precios en este problema.
- MATCH: solo si exactamente UN candidato es, sin duda razonable, el mismo estudio que dice el texto (se permiten
  errores de tipeo, abreviaturas comunes y orden de palabras). refs debe tener un único ref.
- AMBIGUOUS: si más de un candidato podría ser correcto. refs debe listar todos los plausibles (al menos 2).
- NO_MATCH: si ningún candidato es claramente ese estudio o no hay evidencia suficiente. refs debe ir vacío.
- Sé MUY conservador con las variantes. Si el texto NO especifica la variante y existen candidatos que difieren en ella, responde AMBIGUOUS:
  método (ECLIA / FIA / ELISA / CLIA / RT-qPCR), isotipo (IgG / IgM / IgA / IgE), libre / total, neonatal,
  cuantitativo / cualitativo, muestra (suero, orina, heces...), 24 horas, sexo o población, y perfiles, paneles o estudios compuestos.
- No elijas una variante "por defecto" ni la más común. No uses el diagnóstico ni conocimiento clínico para completar
  lo que el texto no dice. Un perfil o panel no equivale a uno solo de sus componentes.
- El campo readerNormalizedName es solo contexto secundario del lector y puede estar equivocado: manda literalText.
- confidence: high solo si la correspondencia es inequívoca. En "reason" explica en una frase por qué (qué coincide y qué variantes distinguirían), nombrando los estudios por su nombre: NO menciones los refs (c1, c2...) en reason.
- Responde una decisión por cada item, con su "index".
`;

export interface SemanticModelRequest {
  promptText: string;
  catalog: Array<{ ref: string; code: string | null; name: string; aliases?: string[]; category?: string; sampleType?: string }>;
  items: Array<{ index: number; literalText: string; readerNormalizedName?: string; candidateRefs: string[] }>;
}

export interface SemanticDeps {
  complete: (request: SemanticModelRequest) => Promise<{ value: unknown; usage?: AiUsage }>;
  model: string;
  reasoning: string;
}

// Los paneles tienen nombres de cientos de palabras; con el inicio basta para identificarlos y se ahorran tokens.
export const MAX_NAME_CHARS = 200;
const clip = (name: string) => (name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS)}…` : name);

const MATRIX_TOKENS = new Set(["orina", "heces", "suero", "sangre", "plasma", "saliva", "esputo", "liquido", "secrecion", "24", "horas", "hrs"]);

function openaiParams(model: string, reasoning: string) {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(responseSchema);
  return {
    model,
    reasoning: { effort: reasoning as "low" | "medium" | "high" | "xhigh" | "max" },
    text: {
      format: {
        type: "json_schema" as const,
        name: "catalog_semantic_resolution",
        strict: true,
        schema
      }
    }
  };
}

function defaultDeps(): SemanticDeps {
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

interface PreparedItem {
  index: number;
  query: SemanticQuery;
  candidates: CatalogStudy[];
  info: CandidateInfo;
}

function noMatch(literalText: string, reason: string, info: CandidateInfo, note?: string): SemanticItemResult {
  return { literalText, resolution: { status: "NO_MATCH", reason }, candidates: info, note };
}

// Convierte las decisiones crudas del modelo en resoluciones validadas. Pura: se prueba sin red.
export function applySemanticDecisions(args: {
  items: Array<{ index: number; query: SemanticQuery; candidates: CatalogStudy[]; info: CandidateInfo }>;
  refMap: Map<string, CatalogStudy>;
  rawDecisions: unknown[];
}): SemanticItemResult[] {
  return args.items.map((item) => {
    const literalText = item.query.literalText;
    const allowed = new Map(item.candidates.map((study) => [study.id, study]));
    const decision = args.rawDecisions
      .map((raw) => decisionSchema.safeParse(raw))
      .find((parsed) => parsed.success && parsed.data.index === item.index)?.data;

    if (!decision) return noMatch(literalText, "El modelo no devolvió una decisión válida para este texto.", item.info, "respuesta ausente o inválida");

    // Solo refs que existen Y pertenecen a los candidatos de ESTE texto.
    const valid: CatalogStudy[] = [];
    const rejected: string[] = [];
    for (const ref of [...new Set(decision.refs)]) {
      const study = args.refMap.get(ref);
      if (study && allowed.has(study.id)) valid.push(study);
      else rejected.push(ref);
    }
    const rejectionNote = rejected.length > 0 ? `refs rechazadas por no pertenecer a los candidatos enviados: ${rejected.join(", ")}` : undefined;

    if (decision.status === "NO_MATCH") {
      return { literalText, resolution: { status: "NO_MATCH", reason: decision.reason }, candidates: item.info, note: rejectionNote };
    }

    if (decision.status === "AMBIGUOUS") {
      if (valid.length >= 2) {
        return { literalText, resolution: { status: "AMBIGUOUS", candidateStudyIds: valid.map((s) => s.id), reason: decision.reason }, candidates: item.info, note: rejectionNote };
      }
      return noMatch(literalText, `El modelo marcó AMBIGUOUS sin al menos 2 candidatos válidos. ${decision.reason}`, item.info, rejectionNote ?? "AMBIGUOUS con menos de 2 candidatos válidos");
    }

    // MATCH
    if (valid.length === 0) {
      return noMatch(literalText, `El modelo propuso un estudio fuera de los candidatos enviados; se rechazó. ${decision.reason}`, item.info, rejectionNote ?? "MATCH sin ref válida");
    }
    if (valid.length > 1) {
      return {
        literalText,
        resolution: { status: "AMBIGUOUS", candidateStudyIds: valid.map((s) => s.id), reason: `El modelo devolvió varios candidatos para un MATCH. ${decision.reason}` },
        candidates: item.info,
        note: rejectionNote ?? "MATCH con varios refs"
      };
    }

    const chosen = valid[0]!;
    const siblings = variantAmbiguity(chosen, literalText, item.candidates);
    if (siblings.length > 0) {
      return {
        literalText,
        resolution: {
          status: "AMBIGUOUS",
          candidateStudyIds: [chosen, ...siblings].map((s) => s.id),
          reason: `Guarda determinística: el texto no distingue entre variantes del mismo estudio (método, isotipo, libre/total, neonatal, sexo, muestra...). El modelo había elegido "${chosen.name}". ${decision.reason}`
        },
        candidates: item.info,
        note: "MATCH degradado a AMBIGUOUS por variantes no distinguibles"
      };
    }
    return {
      literalText,
      resolution: { status: "MATCH", studyId: chosen.id, confidence: decision.confidence, reason: decision.reason },
      candidates: item.info,
      note: rejectionNote
    };
  });
}

export async function resolveCatalogSemantically(
  args: { queries: SemanticQuery[]; catalog: CatalogStudy[] },
  deps: Partial<SemanticDeps> = {}
): Promise<SemanticBatchResult> {
  const resolved = { ...defaultDeps(), ...deps };
  const { model, reasoning } = resolved;
  const results: Array<SemanticItemResult | undefined> = args.queries.map(() => undefined);
  const prepared: PreparedItem[] = [];

  args.queries.forEach((query, position) => {
    const selection = preselectCandidates(query, args.catalog);
    const info: CandidateInfo = {
      sent: selection.studies.length,
      studyIds: selection.studies.map((study) => study.id),
      truncated: selection.truncated,
      fullCatalog: selection.fullCatalog
    };
    if (selection.studies.length === 0) {
      results[position] = noMatch(query.literalText, "Texto vacío o sin contenido utilizable; no se consultó al modelo.", info);
      return;
    }
    prepared.push({ index: position, query, candidates: selection.studies, info });
  });

  const emptyBatch = (): SemanticBatchResult => ({
    items: results as SemanticItemResult[],
    model,
    reasoning,
    calledModel: false,
    cacheHit: false,
    candidatesSentToModel: 0
  });
  if (prepared.length === 0) return emptyBatch();

  // Catálogo compacto compartido (unión de candidatos) con refs estables; sin precios.
  const union = new Map<string, CatalogStudy>();
  for (const item of prepared) for (const study of item.candidates) union.set(study.id, study);
  const orderedUnion = args.catalog.filter((study) => union.has(study.id));
  const refOf = new Map(orderedUnion.map((study, i) => [study.id, `c${i + 1}`]));
  const refMap = new Map(orderedUnion.map((study) => [refOf.get(study.id)!, study]));

  const needsSample = (query: SemanticQuery) => tokensOf(`${query.literalText} ${query.normalizedName ?? ""}`).some((token) => MATRIX_TOKENS.has(token));
  const wantsSample = prepared.some((item) => needsSample(item.query));

  const catalogPayload = orderedUnion.map((study) => ({
    ref: refOf.get(study.id)!,
    code: study.code,
    name: clip(study.name),
    ...(study.normalizedAliases.length > 0 ? { aliases: study.normalizedAliases } : {}),
    ...(study.category ? { category: study.category } : {}),
    ...(wantsSample && study.sampleType ? { sampleType: study.sampleType } : {})
  }));
  const itemsPayload = prepared.map((item) => ({
    index: item.index,
    literalText: item.query.literalText,
    ...(item.query.normalizedName ? { readerNormalizedName: item.query.normalizedName } : {}),
    candidateRefs: item.candidates.map((study) => refOf.get(study.id)!)
  }));
  const promptText = `${instructions}\nCatálogo (candidatos):\n${catalogPayload.map((entry) => JSON.stringify(entry)).join("\n")}\n\nTextos a resolver:\n${JSON.stringify(itemsPayload)}`;
  const request: SemanticModelRequest = { promptText, catalog: catalogPayload, items: itemsPayload };

  let liveUsage: AiUsage | undefined;
  let called = false;
  const { decisions } = await cachedAiCall({
    label: "openai-catalog",
    provider: "openai",
    model,
    imageBase64: "", // sin imagen: la clave depende del prompt (textos + candidatos), modelo, reasoning y esquema
    config: { prompt: promptText, params: openaiParams(model, reasoning) },
    parse: (raw) => rawResponseSchema.parse(raw),
    call: async () => {
      called = true;
      const response = await resolved.complete(request);
      liveUsage = response.usage;
      return { value: rawResponseSchema.parse(response.value), usage: response.usage };
    }
  });

  const applied = applySemanticDecisions({ items: prepared, refMap, rawDecisions: decisions });
  prepared.forEach((item, i) => {
    results[item.index] = applied[i];
  });

  return {
    items: results as SemanticItemResult[],
    model,
    reasoning,
    calledModel: called,
    cacheHit: !called,
    usage: liveUsage,
    candidatesSentToModel: orderedUnion.length
  };
}
