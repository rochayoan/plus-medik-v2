import type { CatalogResolution, DocumentType, SafetyDecision, StudyObservation } from "./types.js";

export function evaluateSafety(args: {
  documentType: DocumentType;
  completeDocumentVisible: boolean;
  requested: StudyObservation[];
  unresolvedVisualKeys: string[];
  catalog: CatalogResolution[];
  visualUncertaintyCount: number;
}): SafetyDecision {
  const reasons: string[] = [];

  if (args.documentType === "HANDWRITTEN_REQUEST") reasons.push("handwritten_out_of_scope");
  if (args.documentType === "NOT_A_REQUEST") reasons.push("not_a_request");
  if (args.documentType === "UNKNOWN") reasons.push("document_type_uncertain");
  if (!args.completeDocumentVisible) reasons.push("document_not_complete");
  if (args.requested.length === 0) reasons.push("no_requested_studies");
  if (args.unresolvedVisualKeys.length > 0) reasons.push("visual_disputes_unresolved");
  if (args.visualUncertaintyCount > 0) reasons.push("visual_uncertainty");
  if (args.requested.some((study) => study.certainty !== "HIGH")) reasons.push("non_high_certainty_study");
  if (args.catalog.some((r) => r.status === "UNMATCHED")) reasons.push("catalog_unmatched");
  if (args.catalog.some((r) => r.status === "AMBIGUOUS")) reasons.push("catalog_ambiguous");

  return {
    decision: reasons.length === 0 ? "AUTO_SAFE" : "HUMAN_REVIEW",
    reasons
  };
}
