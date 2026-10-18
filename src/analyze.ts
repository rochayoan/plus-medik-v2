import { readImageWithGemini, readImageWithOpenAI, type SimpleReading } from "./ai.js";
import { ExactAliasCatalogResolver, uniqueMatchedStudies } from "./catalog.js";
import { buildSimpleConsensus, type SimpleConsensus, type SimpleStudy } from "./consensus.js";
import { judgeDisputesWithOpenAI, type SimpleJudgement } from "./judge.js";
import type { CatalogResolution, CatalogStudy, StudyObservation } from "./types.js";

export type VisualSource = "agreed" | "judge_confirmed";

export interface FinalVisualStudy extends SimpleStudy {
  source: VisualSource;
}

export interface CatalogCandidate {
  id: string;
  code: string | null;
  name: string;
  priceBs: number;
}

export interface StudyMatch {
  visual: FinalVisualStudy;
  // El input de matching es SIEMPRE literalText.
  matchedText: string;
  status: CatalogResolution["status"];
  study?: CatalogCandidate;
  candidates?: CatalogCandidate[];
  // Solo diagnóstico: qué pasaría con normalizedName. Nunca influye en la decisión ni en la cotización.
  diagnosticNormalizedName: { text: string; status: CatalogResolution["status"] };
}

export type AnalysisReason =
  | "visual_disputes_unresolved"
  | "no_requested_studies"
  | "non_high_certainty_study"
  | "catalog_unmatched"
  | "catalog_ambiguous";

export interface AnalysisQuote {
  lines: CatalogCandidate[];
  totalBs: number;
  tariff: "PACIENTE";
}

export interface AnalysisResult {
  decision: "AUTO_SAFE" | "HUMAN_REVIEW";
  reasons: AnalysisReason[];
  finalVisualStudies: FinalVisualStudy[];
  disputes: Array<{ key: string; reason: string }>;
  judgeResolved: Array<{ key: string; verdict: "confirmed" | "rejected"; reason: string }>;
  unresolvedDisputes: Array<{ key: string; reason: string }>;
  matches: StudyMatch[];
  // Resumen de lo que no se pudo resolver; el detalle completo está en matches.
  unmatched: string[];
  ambiguous: Array<{ literalText: string; candidates: CatalogCandidate[] }>;
  quote?: AnalysisQuote;
}

const toCandidate = (study: CatalogStudy): CatalogCandidate => ({
  id: study.id,
  code: study.code,
  name: study.name,
  priceBs: study.priceBs
});

const observationFor = (text: string): StudyObservation => ({
  text,
  evidenceType: "PRINTED_TEXT",
  certainty: "HIGH",
  evidenceSummary: "catalog lookup"
});

// Ensamblado puro (sin red): consenso + juez + catálogo -> decisión y cotización.
export function assembleAnalysis(args: {
  consensus: SimpleConsensus;
  judgement: SimpleJudgement;
  catalog: CatalogStudy[];
}): AnalysisResult {
  const { consensus, judgement, catalog } = args;

  // Estudios visuales finales: acordados + confirmados por el juez. Los rechazados se excluyen.
  const finalVisualStudies: FinalVisualStudy[] = [
    ...consensus.agreedStudies.map((study) => ({ ...study, source: "agreed" as const })),
    ...judgement.resolvedStudies
      .filter((resolved) => resolved.verdict === "confirmed")
      .map((resolved) => ({ ...resolved.study, source: "judge_confirmed" as const }))
  ];

  // Cualquier disputa sin decisión explícita del juez cuenta como no resuelta (fail closed).
  const decidedKeys = new Set([
    ...judgement.resolvedStudies.map((resolved) => resolved.key),
    ...judgement.unresolvedDisputes.map((unresolved) => unresolved.dispute.key)
  ]);
  const unresolvedDisputes = [
    ...judgement.unresolvedDisputes.map((unresolved) => ({ key: unresolved.dispute.key, reason: unresolved.reason })),
    ...consensus.disputes
      .filter((dispute) => !decidedKeys.has(dispute.key))
      .map((dispute) => ({ key: dispute.key, reason: "Disputa sin decisión del juez." }))
  ];

  const resolver = new ExactAliasCatalogResolver(catalog);
  const matches: StudyMatch[] = finalVisualStudies.map((visual) => {
    const resolution = resolver.resolve(observationFor(visual.literalText));
    const diagnostic = resolver.resolve(observationFor(visual.normalizedName));
    return {
      visual,
      matchedText: visual.literalText,
      status: resolution.status,
      study: resolution.status === "MATCHED" ? toCandidate(resolution.study) : undefined,
      candidates: resolution.status === "AMBIGUOUS" ? resolution.candidates.map(toCandidate) : undefined,
      diagnosticNormalizedName: { text: visual.normalizedName, status: diagnostic.status }
    };
  });

  const unmatchedMatches = matches.filter((match) => match.status === "UNMATCHED");
  const ambiguousMatches = matches.filter((match) => match.status === "AMBIGUOUS");

  const reasons: AnalysisReason[] = [];
  if (unresolvedDisputes.length > 0) reasons.push("visual_disputes_unresolved");
  if (finalVisualStudies.length === 0) reasons.push("no_requested_studies");
  if (finalVisualStudies.some((study) => study.confidence !== "high")) reasons.push("non_high_certainty_study");
  if (unmatchedMatches.length > 0) reasons.push("catalog_unmatched");
  if (ambiguousMatches.length > 0) reasons.push("catalog_ambiguous");

  const decision = reasons.length === 0 ? "AUTO_SAFE" : "HUMAN_REVIEW";

  // Cotización solo si todo está resuelto; deduplicada por lab_tests.id y con price_bs (tarifa Paciente).
  let quote: AnalysisQuote | undefined;
  if (decision === "AUTO_SAFE") {
    const resolutions: CatalogResolution[] = matches.flatMap((match) => {
      const study = catalog.find((candidate) => candidate.id === match.study?.id);
      return study ? [{ status: "MATCHED" as const, observed: observationFor(match.matchedText), study }] : [];
    });
    const lines = uniqueMatchedStudies(resolutions).map(toCandidate);
    quote = { lines, totalBs: lines.reduce((sum, line) => sum + line.priceBs, 0), tariff: "PACIENTE" };
  }

  return {
    decision,
    reasons,
    finalVisualStudies,
    disputes: consensus.disputes.map((dispute) => ({ key: dispute.key, reason: dispute.reason })),
    judgeResolved: judgement.resolvedStudies.map((resolved) => ({
      key: resolved.key,
      verdict: resolved.verdict,
      reason: resolved.reason
    })),
    unresolvedDisputes,
    matches,
    unmatched: unmatchedMatches.map((match) => match.matchedText),
    ambiguous: ambiguousMatches.map((match) => ({ literalText: match.matchedText, candidates: match.candidates ?? [] })),
    quote
  };
}

export interface AnalyzeDeps {
  readGemini: typeof readImageWithGemini;
  readOpenAI: typeof readImageWithOpenAI;
  judge: typeof judgeDisputesWithOpenAI;
}

const defaultDeps: AnalyzeDeps = {
  readGemini: readImageWithGemini,
  readOpenAI: readImageWithOpenAI,
  judge: judgeDisputesWithOpenAI
};

// Flujo completo: lectores (con cache) -> consenso -> juez solo si hay disputas -> catálogo -> decisión.
export async function analyzeImage(
  args: { imageBase64: string; mimeType: string; catalog: CatalogStudy[] },
  deps: AnalyzeDeps = defaultDeps
): Promise<AnalysisResult> {
  const { imageBase64, mimeType, catalog } = args;
  const [gemini, openai]: [SimpleReading, SimpleReading] = await Promise.all([
    deps.readGemini(imageBase64, mimeType),
    deps.readOpenAI(imageBase64, mimeType)
  ]);

  const consensus = buildSimpleConsensus(gemini, openai);
  const judgement: SimpleJudgement = consensus.hasDisputes
    ? await deps.judge({ imageBase64, mimeType, gemini, openai, disputes: consensus.disputes })
    : { resolvedStudies: [], unresolvedDisputes: [] };

  return assembleAnalysis({ consensus, judgement, catalog });
}
