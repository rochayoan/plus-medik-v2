import { ExactAliasCatalogResolver } from "@core/catalog";
import { normalizeStudyKey } from "@core/consensus";
import type { CatalogStudy } from "@core/types";
import type { ClientStudy, ReviewItem } from "./catalog-types";
import type { StudySearch } from "./search";

// Separa una lista pegada (WhatsApp, receta digital, notas) en fragmentos: por línea, coma, punto y coma o viñeta.
// "/" no separa: "GOT/GPT" o "Sodio/Potasio" se tratan como un solo texto y la revisión decide.
export function splitPastedList(text: string): string[] {
  const seen = new Set<string>();
  const fragments: string[] = [];
  for (const raw of text.split(/[\n\r;,•·\t]+/)) {
    const cleaned = raw
      .replace(/^\s*(?:[-*+>]|\d{1,3}\s*[.)-])\s*/, "")
      .replace(/[.:]+\s*$/, "")
      .trim();
    const key = normalizeStudyKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fragments.push(cleaned);
  }
  return fragments;
}

// ¿Parece una lista y no una búsqueda? (para interceptar el pegado en el buscador)
export function looksLikeList(text: string): boolean {
  return splitPastedList(text).length >= 2;
}

const asCatalogStudy = (study: ClientStudy): CatalogStudy => ({
  id: study.id,
  code: study.code,
  name: study.name,
  normalizedName: normalizeStudyKey(study.normalizedName || study.name),
  normalizedAliases: study.aliases.map(normalizeStudyKey).filter(Boolean),
  priceBs: study.priceBs,
  active: true
});

// Resolución sin IA ($0): coincidencia exacta nombre/alias del core => seguro; si no, las mejores opciones del buscador para elegir con un toque.
export function resolvePastedList(text: string, studies: ClientStudy[], search: StudySearch): ReviewItem[] {
  const resolver = new ExactAliasCatalogResolver(studies.map(asCatalogStudy));
  return splitPastedList(text).map((fragment): ReviewItem => {
    const resolution = resolver.resolve({ text: fragment, evidenceType: "PRINTED_TEXT", certainty: "HIGH", evidenceSummary: "lista pegada" });
    if (resolution.status === "MATCHED") return { kind: "sure", text: fragment, studyId: resolution.study.id };
    if (resolution.status === "AMBIGUOUS") return { kind: "choose", text: fragment, candidateIds: resolution.candidates.map((study) => study.id) };
    const candidates = search.search(fragment, 3);
    if (candidates.length === 0) return { kind: "not_found", text: fragment };
    return { kind: "choose", text: fragment, candidateIds: candidates.map((study) => study.id) };
  });
}
