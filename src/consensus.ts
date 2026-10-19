import type { SimpleReading } from "./ai.js";
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

// Consenso simple entre dos SimpleReading (Gemini vs OpenAI). No resuelve disputas.
export type SimpleStudy = SimpleReading["requestedStudies"][number];

export type SimpleDisputeReason =
  | "partial_transcription"
  | "requested_by_one_reader_only"
  | "requested_with_uncertainty_in_other"
  | "not_high_confidence_in_both"
  | "uncertain_only";

export interface SimpleDispute {
  key: string;
  reason: SimpleDisputeReason;
  readerA: { requested?: SimpleStudy; uncertain: string[] };
  readerB: { requested?: SimpleStudy; uncertain: string[] };
  // Solo en partial_transcription: la transcripción más completa (los dos lectores ven la misma fila; uno la copió truncada).
  preferred?: SimpleStudy;
}

export interface SimpleConsensus {
  agreedStudies: SimpleStudy[];
  disputes: SimpleDispute[];
  hasDisputes: boolean;
}

const confidenceScore = { high: 3, medium: 2, low: 1 } as const;

// Normalización simple del texto visible: minúsculas, sin tildes, puntuación/espacios normalizados,
// "Ig M" -> "igm" y repetición del mismo isotipo al final ("Ig M IgM") colapsada. Sin equivalencias clínicas.
export function normalizeVisibleKey(value: string): string {
  const tokens = normalizeStudyKey(value.normalize("NFKD")).replace(/\big ([a-z])\b/g, "ig$1").split(" ").filter(Boolean);
  while (tokens.length > 1 && tokens[tokens.length - 1] === tokens[tokens.length - 2]) tokens.pop();
  return tokens.join(" ");
}

interface KeyedStudy {
  study: SimpleStudy;
  literalKey: string;
  nameKey: string;
}

const variantOnly = new Set(["iga", "igg", "igm", "ige"]);

// Dos claves son el mismo texto visible si tienen las mismas letras ignorando espaciado/puntuación ("UREA/NUS" vs "UREANUS") o, con las
// mismas palabras, solo difieren en una "s" final de palabras largas ("BILIRRUBINAS" vs "BILIRRUBINA"). Las variantes clínicas
// (IgG/IgM, T3/T4) son palabras cortas o difieren en una letra interior: siguen siendo distintas.
const squash = (key: string): string => key.replace(/ /g, "");
const singular = (token: string): string => (token.length >= 6 && token.endsWith("s") ? token.slice(0, -1) : token);
function sameKey(a: string, b: string): boolean {
  if (a === b || squash(a) === squash(b)) return true;
  const tokensA = a.split(" ").filter(Boolean);
  const tokensB = b.split(" ").filter(Boolean);
  return tokensA.length === tokensB.length && tokensA.every((token, index) => singular(token) === singular(tokensB[index]!));
}
export const sameVisibleText = (a: string, b: string): boolean => sameKey(normalizeVisibleKey(a), normalizeVisibleKey(b));

// `short` es un prefijo estricto de `long` por palabras ("nitrogeno ureico" vs "nitrogeno ureico urea nus"): una transcripción truncada.
// No cuenta si el texto corto es solo una variante ("igg") o no deja ninguna palabra que identifique el estudio.
export function isTruncationOf(short: string, long: string): boolean {
  const s = short.split(" ").filter(Boolean);
  const l = long.split(" ").filter(Boolean);
  if (s.length === 0 || s.length >= l.length) return false;
  if (s.every((token) => variantOnly.has(token))) return false;
  return s.every((token, index) => token === l[index]);
}

function keyStudies(studies: SimpleStudy[]): KeyedStudy[] {
  const byLiteral = new Map<string, KeyedStudy>();
  for (const study of studies) {
    const literalKey = normalizeVisibleKey(study.literalText) || normalizeVisibleKey(study.normalizedName);
    const previous = byLiteral.get(literalKey);
    if (!previous || confidenceScore[study.confidence] > confidenceScore[previous.study.confidence]) {
      byLiteral.set(literalKey, { study, literalKey, nameKey: normalizeVisibleKey(study.normalizedName) });
    }
  }
  return [...byLiteral.values()];
}

interface Pair {
  a?: KeyedStudy;
  b?: KeyedStudy;
  // Los dos lectores ven la misma fila, pero uno transcribió solo el comienzo del texto: lo decide el juez, con el texto completo.
  partial?: boolean;
}

// Empareja primero por literalText (ignorando el espaciado); lo que quede sin pareja se intenta por normalizedName y, por último,
// por transcripción truncada (solo si la relación es única en ambos sentidos: nunca se adivina entre varias filas posibles).
function pairStudies(a: KeyedStudy[], b: KeyedStudy[]): Pair[] {
  const pairs: Pair[] = [];
  const remainingB = new Set(b);
  const unmatchedA: KeyedStudy[] = [];
  for (const itemA of a) {
    const match = [...remainingB].find((itemB) => sameKey(itemB.literalKey, itemA.literalKey));
    if (match) {
      remainingB.delete(match);
      pairs.push({ a: itemA, b: match });
    } else {
      unmatchedA.push(itemA);
    }
  }
  for (const itemA of unmatchedA) {
    const match = [...remainingB].find((itemB) => itemB.nameKey === itemA.nameKey);
    if (match) remainingB.delete(match);
    pairs.push({ a: itemA, b: match });
  }
  // Transcripciones truncadas entre lo que quedó sin pareja.
  const lonelyA = pairs.filter((pair) => pair.a && !pair.b);
  const related = (x: KeyedStudy, y: KeyedStudy) => isTruncationOf(x.literalKey, y.literalKey) || isTruncationOf(y.literalKey, x.literalKey);
  for (const pair of lonelyA) {
    const candidates = [...remainingB].filter((itemB) => related(pair.a!, itemB));
    if (candidates.length !== 1) continue;
    const reverse = lonelyA.filter((other) => related(other.a!, candidates[0]!));
    if (reverse.length !== 1) continue;
    pair.b = candidates[0];
    pair.partial = true;
    remainingB.delete(candidates[0]!);
  }
  for (const itemB of remainingB) pairs.push({ b: itemB });
  return pairs;
}

const variantTokens = new Set(["iga", "igg", "igm", "ige"]);

// Una incertidumbre se relaciona con un estudio si los tokens de uno incluyen todos los del otro,
// o si, ignorando la variante (IgG/IgM/...), comparten la misma determinación:
// "B2 Glicoproteína IgG" cuestiona a "B2 Glicoproteína IgM" porque no se sabe cuál variante es.
// Una incertidumbre que es solo la variante ("IgG") sigue exigiendo que el estudio la contenga.
function isRelated(a: string, b: string): boolean {
  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const subset = (small: Set<string>, large: Set<string>) => [...small].every((token) => large.has(token));
  if (subset(tokensA, tokensB) || subset(tokensB, tokensA)) return true;

  const coreA = new Set([...tokensA].filter((token) => !variantTokens.has(token)));
  const coreB = new Set([...tokensB].filter((token) => !variantTokens.has(token)));
  if (coreA.size === 0 || coreB.size === 0) return false;
  return subset(coreA, coreB) || subset(coreB, coreA);
}

export function buildSimpleConsensus(a: SimpleReading, b: SimpleReading): SimpleConsensus {
  const uncertainA = a.uncertainStudies.map((text) => ({ text, key: normalizeVisibleKey(text), used: false }));
  const uncertainB = b.uncertainStudies.map((text) => ({ text, key: normalizeVisibleKey(text), used: false }));

  const agreedStudies: SimpleStudy[] = [];
  const disputes: SimpleDispute[] = [];

  for (const pair of pairStudies(keyStudies(a.requestedStudies), keyStudies(b.requestedStudies))) {
    const studyA = pair.a?.study;
    const studyB = pair.b?.study;
    const allKeys = [pair.a?.literalKey, pair.a?.nameKey, pair.b?.literalKey, pair.b?.nameKey]
      .filter((value): value is string => Boolean(value));
    const key = allKeys[0] ?? "";
    // Un texto visible que es solo la variante ("Ig G") no identifica el estudio: no sirve para relacionar incertidumbres.
    const keys = allKeys.filter((value) => value.split(" ").some((token) => !variantTokens.has(token)));
    const relatedA = uncertainA.filter((item) => keys.some((studyKey) => isRelated(item.key, studyKey)));
    const relatedB = uncertainB.filter((item) => keys.some((studyKey) => isRelated(item.key, studyKey)));
    for (const item of [...relatedA, ...relatedB]) item.used = true;

    const readerA = { requested: studyA, uncertain: relatedA.map((item) => item.text) };
    const readerB = { requested: studyB, uncertain: relatedB.map((item) => item.text) };
    const hasUncertainty = relatedA.length > 0 || relatedB.length > 0;

    if (studyA && studyB && pair.partial) {
      // El estudio es el de la transcripción más completa; el juez confirma o rechaza esa fila visible.
      const fuller = isTruncationOf(pair.a!.literalKey, pair.b!.literalKey) ? studyB : studyA;
      const fullerKey = fuller === studyB ? pair.b!.literalKey : pair.a!.literalKey;
      disputes.push({ key: fullerKey, reason: "partial_transcription", readerA, readerB, preferred: fuller });
    } else if (studyA && studyB) {
      if (studyA.confidence === "high" && studyB.confidence === "high" && !hasUncertainty) {
        agreedStudies.push(studyA);
      } else {
        disputes.push({ key, reason: "not_high_confidence_in_both", readerA, readerB });
      }
    } else {
      disputes.push({
        key,
        reason: hasUncertainty ? "requested_with_uncertainty_in_other" : "requested_by_one_reader_only",
        readerA,
        readerB
      });
    }
  }

  // Incertidumbres sin estudio pedido relacionado: no se descartan en silencio.
  const leftovers = new Map<string, SimpleDispute>();
  for (const [reader, items] of [["readerA", uncertainA], ["readerB", uncertainB]] as const) {
    for (const item of items.filter((candidate) => !candidate.used)) {
      const dispute = leftovers.get(item.key) ?? {
        key: item.key,
        reason: "uncertain_only" as const,
        readerA: { uncertain: [] },
        readerB: { uncertain: [] }
      };
      dispute[reader].uncertain.push(item.text);
      leftovers.set(item.key, dispute);
    }
  }
  disputes.push(...leftovers.values());

  return { agreedStudies, disputes, hasDisputes: disputes.length > 0 };
}
