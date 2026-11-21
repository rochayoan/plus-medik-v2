import type { AnalysisReason } from "./analyze.js";

// QUÉ CLASE DE INCERTIDUMBRE hay detrás de cada bloqueo. Solo clasifica (diagnóstico y triage del laboratorio); NO cambia ninguna decisión.
//
//  - READING:  no está claro QUÉ dice la receta (transcripción, discrepancia entre lectores, certeza insuficiente, una fila que ningún lector transcribió).
//  - IDENTITY: lo leído está claro pero no se sabe CUÁL estudio del catálogo es (sin coincidencia, ambiguo, rechazado por el verificador, agrupación de línea).
//  - DOCUMENT: la hoja en sí no permite confiar (zona que no se ve, no es una solicitud, tipo de documento dudoso, texto no entero).
//  - POLICY:   el estudio se entiende pero una regla comercial o de datos exige decisión humana (compuesto, precio inválido, alcance del manuscrito).
//
// El Record obliga (en compilación) a clasificar cada motivo nuevo: no puede quedar un bloqueo sin clase.
export type UncertaintyKind = "READING" | "IDENTITY" | "DOCUMENT" | "POLICY";

export const UNCERTAINTY_OF: Record<AnalysisReason, UncertaintyKind> = {
  visual_disputes_unresolved: "READING",
  visual_partial_transcription: "READING",
  no_requested_studies: "READING",
  non_high_certainty_study: "READING",
  readers_variant_mismatch: "READING",
  line_item_unrepresented: "READING",

  catalog_unmatched: "IDENTITY",
  catalog_ambiguous: "IDENTITY",
  catalog_model_suggested: "IDENTITY",
  semantic_unavailable: "IDENTITY",
  semantic_ambiguous: "IDENTITY",
  semantic_no_match: "IDENTITY",
  semantic_rejected_by_verifier: "IDENTITY",
  semantic_passes_disagree: "IDENTITY",
  semantic_contradicts_exact: "IDENTITY",
  package_component_overlap: "IDENTITY",
  package_alternative_unresolved: "IDENTITY",
  package_line_unreconstructable: "IDENTITY",
  line_service_not_covered: "IDENTITY",

  not_a_request: "DOCUMENT",
  document_type_uncertain: "DOCUMENT",
  document_not_complete: "DOCUMENT",
  document_impact_unverified: "DOCUMENT",
  document_may_alter_study: "DOCUMENT",
  document_study_not_fully_visible: "DOCUMENT",
  document_context_unverified: "DOCUMENT",

  handwritten_out_of_scope: "POLICY",
  semantic_composite_requires_policy: "POLICY",
  semantic_auto_not_enabled: "POLICY",
  catalog_price_invalid: "POLICY"
};

// Zonas del documento que no se ven (CUT_EDGE, ERASED...) también son incertidumbre documental.
const ZONE_KINDS: ReadonlySet<string> = new Set(["CUT_EDGE", "HIDDEN", "EDGE_UNVERIFIED", "ERASED", "INVALID_BOX", "UNEXPLAINED_DOUBT", "UNTYPED"]);

// Clases distintas presentes en una lista de motivos (en orden estable). Un motivo desconocido no se clasifica (texto libre de una disputa, por ejemplo).
export function uncertaintyKinds(reasons: readonly string[]): UncertaintyKind[] {
  const found = new Set<UncertaintyKind>();
  for (const reason of reasons) {
    if (reason in UNCERTAINTY_OF) found.add(UNCERTAINTY_OF[reason as AnalysisReason]);
    else if (ZONE_KINDS.has(reason)) found.add("DOCUMENT");
  }
  return (["READING", "IDENTITY", "DOCUMENT", "POLICY"] as const).filter((kind) => found.has(kind));
}
