export type DocumentType =
  | "TEXT_EXPLICIT_REQUEST"
  | "MARK_DEPENDENT_FORM"
  | "HANDWRITTEN_REQUEST"
  | "NOT_A_REQUEST"
  | "UNKNOWN";

export type EvidenceType =
  | "PRINTED_TEXT"
  | "X_MARK"
  | "CHECK"
  | "CIRCLE"
  | "UNDERLINE"
  | "STRIKE"
  | "SCRIBBLE"
  | "OTHER"
  | "UNCLEAR";

export type Certainty = "HIGH" | "MEDIUM" | "LOW";

export interface StudyObservation {
  text: string;
  evidenceType: EvidenceType;
  certainty: Certainty;
  evidenceSummary: string;
}

export interface VisionReading {
  reader: string;
  documentType: DocumentType;
  completeDocumentVisible: boolean;
  requested: StudyObservation[];
  uncertain: StudyObservation[];
  globalUncertainty: string[];
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface VisualDispute {
  key: string;
  readerA?: StudyObservation;
  readerB?: StudyObservation;
}

export interface FusedVisualReading {
  documentType: DocumentType;
  completeDocumentVisible: boolean;
  agreed: StudyObservation[];
  disputes: VisualDispute[];
  uncertain: StudyObservation[];
  readerA: VisionReading;
  readerB: VisionReading;
}

export interface JudgeDecision {
  requested: StudyObservation[];
  rejectedKeys: string[];
  unresolvedKeys: string[];
  usage?: ModelUsage;
}

export interface CatalogStudy {
  code: string;
  name: string;
  aliases: string[];
  priceBs: number;
  active: boolean;
}

export type CatalogResolution =
  | { status: "MATCHED"; observed: StudyObservation; study: CatalogStudy }
  | { status: "AMBIGUOUS"; observed: StudyObservation; candidates: CatalogStudy[] }
  | { status: "UNMATCHED"; observed: StudyObservation };

export type FinalDecision = "AUTO_SAFE" | "HUMAN_REVIEW";

export interface SafetyDecision {
  decision: FinalDecision;
  reasons: string[];
}

export interface PipelineResult {
  visual: {
    fused: FusedVisualReading;
    judge?: JudgeDecision;
    finalRequested: StudyObservation[];
    unresolvedVisualKeys: string[];
  };
  catalog: CatalogResolution[];
  safety: SafetyDecision;
  quote?: {
    lines: Array<{ code: string; name: string; priceBs: number }>;
    totalBs: number;
    tariff: "PACIENTE";
  };
}
