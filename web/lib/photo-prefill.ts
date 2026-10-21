import type { AnalysisReason, AnalysisResult } from "@core/analyze";
import type { PhotoPrefill, ReviewItem } from "./catalog-types";

// Avisos para el usuario según los motivos del core. Los que no tienen texto se reflejan ítem por ítem.
const WARNINGS: Partial<Record<AnalysisReason, string>> = {
  handwritten_out_of_scope: "La orden parece manuscrita: la lectura automática no es confiable. Revisa cada estudio contra la foto.",
  not_a_request: "La imagen no parece una orden de laboratorio.",
  document_type_uncertain: "No se pudo confirmar el tipo de documento. Revisa los estudios contra la foto.",
  document_not_complete: "La foto parece cortada o tapada: verifica que estén todos los estudios.",
  visual_disputes_unresolved: "Hay estudios que solo una de las lecturas vio: confírmalos mirando la foto.",
  visual_partial_transcription: "Algún texto se leyó incompleto: verifica contra la foto.",
  no_requested_studies: "No se detectaron estudios en la foto. Búscalos manualmente.",
  non_high_certainty_study: "Algunos estudios se leyeron con poca certeza: confírmalos."
};

// Convierte el resultado del core en una precarga del carrito. Nunca incluye precios (salen de la tarifa del usuario).
// Solo es "seguro" lo que el core resolvió de forma única con certeza alta; lo demás requiere un toque del usuario.
export function prefillFromAnalysis(result: AnalysisResult): PhotoPrefill {
  const warnings = [...new Set(result.reasons.map((reason) => WARNINGS[reason]).filter((text): text is string => Boolean(text)))];

  if (result.decision === "AUTO_SAFE" && result.quote) {
    const textById = new Map<string, string>();
    for (const match of result.matches) {
      for (const id of [match.study?.id, ...(match.components ?? []).map((component) => component.id)]) {
        if (id && !textById.has(id)) textById.set(id, match.matchedText);
      }
    }
    return {
      decision: "AUTO_SAFE",
      warnings,
      items: result.quote.lines.map((line) => ({ kind: "sure", text: textById.get(line.id) ?? line.name, studyId: line.id }))
    };
  }

  const items: ReviewItem[] = [];
  for (const match of result.matches) {
    const text = match.matchedText;
    // La versión truncada de un texto que ya aparece completo no genera ítem propio.
    if (match.partialTranscriptionOf) continue;
    const highCertainty = match.visual.confidence === "high";
    switch (match.status) {
      case "MATCHED":
        items.push(highCertainty
          ? { kind: "sure", text, studyId: match.study!.id }
          : { kind: "confirm", text, studyIds: [match.study!.id], hint: "Leído con poca certeza" });
        break;
      case "AMBIGUOUS":
        items.push({ kind: "choose", text, candidateIds: (match.candidates ?? []).map((candidate) => candidate.id) });
        break;
      case "MODEL_SUGGESTED":
        items.push({ kind: "confirm", text, studyIds: [match.study!.id], hint: "Sugerencia: confirma que es el estudio pedido" });
        break;
      case "SEMANTIC_CANDIDATE":
        items.push(match.components?.length
          ? { kind: "confirm", text, studyIds: match.components.map((component) => component.id), hint: "El texto nombra varios estudios" }
          : { kind: "confirm", text, studyIds: [match.study!.id], hint: "Sugerencia: confirma que es el estudio pedido" });
        break;
      case "UNMATCHED":
        items.push(match.candidates?.length
          ? { kind: "choose", text, candidateIds: match.candidates.map((candidate) => candidate.id) }
          : { kind: "not_found", text });
        break;
    }
  }

  for (const dispute of result.unresolvedDisputes) {
    items.push({ kind: "not_found", text: dispute.key, hint: "Posible estudio que no se pudo confirmar: verifícalo en la foto" });
  }

  return { decision: "HUMAN_REVIEW", warnings, items };
}
