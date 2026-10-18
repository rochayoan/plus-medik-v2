import type { FusedVisualReading, StudyObservation, VisionReading, VisualDispute } from "./types.js";

export function normalizeStudyKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bestByKey(items: StudyObservation[]): Map<string, StudyObservation> {
  const map = new Map<string, StudyObservation>();
  for (const item of items) {
    const key = normalizeStudyKey(item.text);
    const previous = map.get(key);
    if (!previous || score(item) > score(previous)) map.set(key, item);
  }
  return map;
}

function score(item: StudyObservation): number {
  return item.certainty === "HIGH" ? 3 : item.certainty === "MEDIUM" ? 2 : 1;
}

export function fuseIndependentReadings(a: VisionReading, b: VisionReading): FusedVisualReading {
  const aMap = bestByKey(a.requested);
  const bMap = bestByKey(b.requested);
  const keys = new Set([...aMap.keys(), ...bMap.keys()]);
  const agreed: StudyObservation[] = [];
  const disputes: VisualDispute[] = [];

  for (const key of keys) {
    const readerA = aMap.get(key);
    const readerB = bMap.get(key);
    if (readerA && readerB) {
      agreed.push(readerA.certainty === "HIGH" ? readerA : readerB);
    } else {
      disputes.push({ key, readerA, readerB });
    }
  }

  return {
    documentType: a.documentType === b.documentType ? a.documentType : "UNKNOWN",
    completeDocumentVisible: a.completeDocumentVisible && b.completeDocumentVisible,
    agreed,
    disputes,
    uncertain: [...a.uncertain, ...b.uncertain],
    readerA: a,
    readerB: b
  };
}
