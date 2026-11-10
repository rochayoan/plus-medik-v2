import { normalizeStudyKey } from "./consensus.js";
import { synonymsOf } from "./study-synonyms.js";
import type { CatalogStudy } from "./types.js";

// Búsqueda aproximada en el catálogo (nombres y alias aprobados de lab_tests ACTIVOS). Es la herramienta que usa el intérprete de estudios: tolera errores de ortografía, plurales, palabras
// de relleno y abreviaturas conocidas (study-synonyms.ts), pero NO decide nada: devuelve candidatos con una puntuación y el backend valida lo que se haga con ellos.
//   · Solo estudios activos del catálogo recibido; nunca precios (no forman parte del resultado).
//   · Determinista y sin red: la misma consulta sobre el mismo catálogo da siempre lo mismo.

export interface SearchHit {
  study: CatalogStudy;
  // 0..1. 1 = el texto coincide exactamente con el nombre o un alias; ≥ 0.8 = muy probable (errata, plural, nombre más largo); < 0.6 = parecido débil.
  score: number;
  // El nombre o alias del catálogo con el que más se parece.
  via: string;
}

// Palabras que no distinguen un estudio de otro en una búsqueda.
const STOP = new Set(["de", "del", "la", "el", "los", "las", "en", "un", "una", "unos", "unas", "para", "por", "mi", "mis", "con", "y", "e", "o", "estudio", "estudios", "examen", "examenes", "analisis", "prueba", "pruebas", "test", "laboratorio", "quiero", "necesito", "cotizar", "cotiza", "cotizame", "precio", "hacer", "hacerme", "realizar", "sacar", "favor", "hola", "buenas"]);

const tokensOf = (value: string): string[] => normalizeStudyKey(value).split(" ").filter(Boolean);
const meaningful = (tokens: readonly string[]): string[] => tokens.filter((token) => !STOP.has(token));

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const out = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index++) out.add(padded.slice(index, index + 3));
  return out;
}

function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

// Parecido entre dos palabras sueltas: igual = 1; prefijo/plural = 0.85; error de ortografía (distancia de edición acotada) < 0.95. Las palabras cortas (< 4) solo valen si son iguales.
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return 0;
  if (a.startsWith(b) || b.startsWith(a)) return shortest >= 5 || Math.abs(a.length - b.length) <= 1 ? 0.85 : 0;
  const longest = Math.max(a.length, b.length);
  const similarity = 1 - levenshtein(a, b) / longest;
  return similarity >= 0.75 ? similarity * 0.95 : 0;
}

interface Form {
  text: string;
  tokens: string[];
  grams: Set<string>;
}
interface IndexedStudy {
  study: CatalogStudy;
  forms: Form[];
}
const indexes = new WeakMap<readonly CatalogStudy[], IndexedStudy[]>();

function indexOf(catalog: readonly CatalogStudy[]): IndexedStudy[] {
  let index = indexes.get(catalog);
  if (!index) {
    index = catalog
      .filter((study) => study.active)
      .map((study) => ({
        study,
        forms: [...new Set([study.normalizedName, ...study.normalizedAliases].filter(Boolean))].map((text) => ({ text, tokens: meaningful(text.split(" ")).length > 0 ? meaningful(text.split(" ")) : text.split(" "), grams: trigrams(text) }))
      }));
    indexes.set(catalog, index);
  }
  return index;
}

function formScore(query: { text: string; tokens: string[]; grams: Set<string> }, form: Form): number {
  if (query.text === form.text) return 1;
  // Cuántas palabras de la consulta aparecen (aunque sea con errores) en el nombre y cuántas del nombre quedan cubiertas.
  let queryCovered = 0;
  const used = new Set<number>();
  for (const word of query.tokens) {
    let best = 0;
    let bestAt = -1;
    form.tokens.forEach((candidate, at) => {
      const similarity = tokenSimilarity(word, candidate);
      if (similarity > best) {
        best = similarity;
        bestAt = at;
      }
    });
    if (bestAt >= 0) used.add(bestAt);
    queryCovered += best;
  }
  const queryCoverage = query.tokens.length === 0 ? 0 : queryCovered / query.tokens.length;
  const formCoverage = form.tokens.length === 0 ? 0 : used.size / form.tokens.length;
  const byWords = queryCoverage * (0.7 + 0.3 * formCoverage);
  // Un nombre de la consulta pegado o mal separado («hemogramacompleto») lo capta la similitud de trigramas.
  const byLetters = dice(query.grams, form.grams) * 0.95;
  return Math.min(0.99, Math.max(byWords, byLetters));
}

export const SEARCH_LIMITS = { defaultLimit: 8, maxQueryChars: 120 } as const;

// Candidatos para una consulta, del más al menos parecido. Incluye las abreviaturas y sinónimos conocidos de la consulta. `minScore` descarta lo que apenas se parece.
export function searchCatalog(query: string, catalog: readonly CatalogStudy[], options: { limit?: number; minScore?: number } = {}): SearchHit[] {
  const limit = Math.max(1, Math.min(20, options.limit ?? SEARCH_LIMITS.defaultLimit));
  const minScore = options.minScore ?? 0.45;
  const base = normalizeStudyKey(String(query).slice(0, SEARCH_LIMITS.maxQueryChars));
  if (base === "") return [];
  const phrases = [base, ...synonymsOf(base)];
  const queries = phrases
    .map((text) => {
      const meaningfulTokens = meaningful(text.split(" "));
      return { text, tokens: meaningfulTokens, grams: trigrams(text) };
    })
    .filter((candidate) => candidate.tokens.length > 0);
  if (queries.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const { study, forms } of indexOf(catalog)) {
    let best: SearchHit | undefined;
    for (const form of forms) {
      for (const candidate of queries) {
        const score = formScore(candidate, form);
        if (!best || score > best.score) best = { study, score, via: form.text };
      }
    }
    if (best && best.score >= minScore) hits.push(best);
  }
  return hits.sort((a, b) => b.score - a.score || (a.study.id < b.study.id ? -1 : 1)).slice(0, limit);
}

// ¿Algún tramo de 1 a 3 palabras del mensaje se parece mucho a un estudio del catálogo? Sirve de puerta barata para decidir si vale la pena consultar al intérprete.
export function mentionsKnownStudy(text: string, catalog: readonly CatalogStudy[], threshold = 0.8): boolean {
  const tokens = meaningful(tokensOf(text.slice(0, 600))).filter((token) => token.length >= 4);
  const all = tokensOf(text.slice(0, 600));
  const seen = new Set<string>();
  for (let size = 1; size <= 3; size++) {
    for (let start = 0; start + size <= all.length; start++) {
      const window = all.slice(start, start + size);
      if (meaningful(window).length === 0 || !window.some((token) => tokens.includes(token))) continue;
      const phrase = window.join(" ");
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      if (searchCatalog(phrase, catalog, { limit: 1, minScore: threshold }).length > 0) return true;
    }
  }
  return false;
}
