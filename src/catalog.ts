import type { CatalogResolution, CatalogStudy, StudyObservation } from "./types.js";
import { normalizeStudyKey } from "./consensus.js";

export interface CatalogResolver {
  resolve(observation: StudyObservation): CatalogResolution;
}

export class ExactAliasCatalogResolver implements CatalogResolver {
  constructor(private studies: CatalogStudy[]) {}

  resolve(observation: StudyObservation): CatalogResolution {
    const wanted = normalizeStudyKey(observation.text);
    const matches = this.studies.filter((study) => {
      if (!study.active) return false;
      return [study.name, ...study.aliases].some((name) => normalizeStudyKey(name) === wanted);
    });

    if (matches.length === 1) {
      return { status: "MATCHED", observed: observation, study: matches[0]! };
    }
    if (matches.length > 1) {
      return { status: "AMBIGUOUS", observed: observation, candidates: matches };
    }
    return { status: "UNMATCHED", observed: observation };
  }
}
