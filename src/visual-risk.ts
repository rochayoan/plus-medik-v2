import { hasContextSensitiveVariants } from "./catalog-shadow.js";
import type { AnalysisReason } from "./analyze.js";
import type { StudyImpactResult } from "./study-impact.js";
import type { CatalogStudy } from "./types.js";

// Riesgo visual POR ESTUDIO. Un corte, un sello, un objeto o un trazo ilegible ya no detienen toda la receta: crean una ZONA DESCONOCIDA (que
// solo se registra en el CRM) y cada estudio visible se clasifica según lo que se pueda DEMOSTRAR sobre su relación con esa zona:
//
//   CLEAR        no hay zonas desconocidas: el estudio no depende de nada que no se vea.
//   INDEPENDENT  dos lecturas independientes confirmaron que su fila y su marca se ven enteras y que ninguna zona puede afectarlo.
//   AFFECTED     una zona lo afecta, podría afectarlo o le tapa el texto o la marca (casilla cubierta, línea cortada): queda pendiente.
//   UNKNOWN      no se pudo comprobar nada (sin verificación, error, sin respuesta) o un título oculto podría calificarlo: queda pendiente.
//
// Solo CLEAR e INDEPENDENT pueden cotizarse. Lo que hay debajo de un objeto nunca se supone.

export type ZoneKind = "CUT_EDGE" | "HIDDEN" | "EDGE_UNVERIFIED" | "ERASED" | "INVALID_BOX" | "UNEXPLAINED_DOUBT" | "UNTYPED";
export type StudyRiskClass = "CLEAR" | "INDEPENDENT" | "AFFECTED" | "UNKNOWN";

export interface UnknownZone {
  kind: ZoneKind;
  // Una zona "localizada" es una que el modelo describió (qué se cortó, qué se tapó): la verificación de impacto sabe responder si oculta un título.
  // Una no localizada (trazos borrados, caja inválida, duda sin causa, problema sin tipo) no permite descartar que oculte un calificador.
  located: boolean;
}

export interface StudyRisk {
  class: StudyRiskClass;
  blocker?: AnalysisReason;
  note?: string;
}

const KINDS: ReadonlySet<string> = new Set<ZoneKind>(["CUT_EDGE", "HIDDEN", "EDGE_UNVERIFIED", "ERASED", "INVALID_BOX", "UNEXPLAINED_DOUBT", "UNTYPED"]);
const LOCATED: ReadonlySet<string> = new Set<ZoneKind>(["CUT_EDGE", "HIDDEN", "EDGE_UNVERIFIED"]);

// Zonas desconocidas a partir de los tipos de problema del documento. Un documento incompleto sin tipo conocido es una zona UNTYPED.
export function zonesOf(args: { kinds: readonly string[]; incomplete: boolean }): UnknownZone[] {
  if (!args.incomplete) return [];
  const known = [...new Set(args.kinds.filter((kind): kind is ZoneKind => KINDS.has(kind)))];
  const kinds: ZoneKind[] = known.length > 0 ? known : ["UNTYPED"];
  return kinds.map((kind) => ({ kind, located: LOCATED.has(kind) }));
}

export function classifyStudyRisk(zones: UnknownZone[], input: { key: string; contextSensitive: boolean; impact?: StudyImpactResult }): StudyRisk {
  if (zones.length === 0) return { class: "CLEAR" };
  const impact = input.impact;
  if (!impact?.available) return { class: "UNKNOWN", blocker: "document_impact_unverified", note: "no se pudo comprobar si las zonas que no se ven lo afectan" };
  // Compatibilidad: sin veredicto por estudio, quien no está confirmado se considera afectado.
  const status = impact.findings?.get(input.key) ?? (impact.unaffected.has(input.key) ? "INDEPENDENT" : "AFFECTED");
  switch (status) {
    case "AFFECTED":
      return { class: "AFFECTED", blocker: "document_may_alter_study", note: "una zona que no se ve lo afecta" };
    case "POSSIBLY_AFFECTED":
      return { class: "AFFECTED", blocker: "document_may_alter_study", note: "no se puede descartar que una zona que no se ve lo afecte" };
    case "NOT_FULLY_VISIBLE":
      return { class: "AFFECTED", blocker: "document_study_not_fully_visible", note: "su texto o su marca no se ven enteros" };
    case "NO_ANSWER":
      return { class: "UNKNOWN", blocker: "document_impact_unverified", note: "la verificación no respondió sobre este estudio" };
    case "INDEPENDENT": {
      // Un título o instrucción oculto podría calificar al estudio (muestra, 24 h, población). Si la zona no se pudo localizar, no se descarta.
      const qualifiersMayBeHidden = impact.qualifierRisk || zones.some((zone) => !zone.located);
      if (qualifiersMayBeHidden && input.contextSensitive) return { class: "UNKNOWN", blocker: "document_context_unverified", note: "un título oculto podría calificar a este estudio (muestra, tiempo o población)" };
      return { class: "INDEPENDENT" };
    }
  }
}

// ¿El estudio aprobado tiene variantes que dependen de un título o instrucción impresa (muestra, 24 h)? Sin catálogo del estudio: sí (falla cerrado).
export function contextSensitive(studies: Array<CatalogStudy | undefined>, catalog: CatalogStudy[]): boolean {
  return studies.some((study) => (study ? hasContextSensitiveVariants(study, catalog) : true));
}
