import type { CatalogResolution, CatalogStudy, StudyObservation } from "./types.js";
import { normalizeStudyKey } from "./consensus.js";

export interface CatalogResolver {
  resolve(observation: StudyObservation): CatalogResolution;
}

// Resolver determinístico: solo coincidencia exacta con normalized_name o normalized_alias.
// Sin fuzzy, sin embeddings, sin inferencias clínicas. La identidad es lab_tests.id (UUID), nunca code.
export class ExactAliasCatalogResolver implements CatalogResolver {
  constructor(private studies: CatalogStudy[]) {}

  resolve(observation: StudyObservation): CatalogResolution {
    const wanted = normalizeStudyKey(observation.text);
    if (wanted === "") return { status: "UNMATCHED", observed: observation };

    // Candidatos por UUID: un estudio que coincide por nombre y por alias cuenta una sola vez.
    const candidates = new Map<string, CatalogStudy>();
    for (const study of this.studies) {
      if (!study.active) continue;
      if (study.normalizedName === wanted || study.normalizedAliases.includes(wanted)) {
        candidates.set(study.id, study);
      }
    }

    const matches = [...candidates.values()];
    if (matches.length === 1) {
      return { status: "MATCHED", observed: observation, study: matches[0]! };
    }
    if (matches.length > 1) {
      return { status: "AMBIGUOUS", observed: observation, candidates: matches };
    }
    return { status: "UNMATCHED", observed: observation };
  }
}

// Dos observaciones que resuelven al mismo UUID producen un solo estudio (una línea, un cobro).
export function uniqueMatchedStudies(catalog: CatalogResolution[]): CatalogStudy[] {
  const byId = new Map<string, CatalogStudy>();
  for (const resolution of catalog) {
    if (resolution.status === "MATCHED" && !byId.has(resolution.study.id)) {
      byId.set(resolution.study.id, resolution.study);
    }
  }
  return [...byId.values()];
}
