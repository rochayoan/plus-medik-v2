import { uncertaintyKinds, type UncertaintyKind } from "./uncertainty.js";
import { createHash } from "node:crypto";
import { isPackageComponent } from "./catalog-shadow.js";
import { droppedLineItemDetails, heldPackageGroups, lineServiceGap } from "./line-groups.js";
import { normalizeStudyKey } from "./consensus.js";
import type { DocumentFunctionInfo } from "./document-function.js";
import type { ImpactStudy, StudyImpactResult } from "./study-impact.js";
import { classifyStudyRisk, contextSensitive, zonesOf, type StudyRisk, type UnknownZone } from "./visual-risk.js";
import type { AnalysisReason, CatalogCandidate, FinalVisualStudy, QuoteBasis, StudyMatch } from "./analyze.js";
import type { CatalogStudy } from "./types.js";

// AUTO PARCIAL. Cada estudio se decide por separado (AUTO o HUMAN_REVIEW). El paciente recibe EXCLUSIVAMENTE los estudios cotizados con
// seguridad, con su precio y el importe de esos estudios (PublicQuote). Todo lo dudoso, oculto o no resuelto queda en el registro interno
// para el CRM (InternalRecord) y NUNCA viaja en la salida pública.
//
//   AUTO_COMPLETE  nada pendiente: toda la receta se identificó y cotizó (equivale al AUTO_SAFE de siempre).
//   AUTO_PARTIAL   hay estudios cotizados y también pendientes (estudios dudosos, disputas o zonas de la receta que no se ven).
//   HUMAN_REVIEW   ningún estudio verificable, o un motivo que invalida toda la lectura: no se genera cotización automática.

export type QuoteOutcome = "AUTO_COMPLETE" | "AUTO_PARTIAL" | "HUMAN_REVIEW";

// La etiqueta describe lo que suma el importe: los estudios cotizados. No afirma que cubra toda la receta.
export const PUBLIC_TOTAL_LABEL = "Total de los estudios cotizados";

export interface StudyDecision {
  key: string;
  text: string;
  decision: "AUTO" | "HUMAN_REVIEW";
  blockers: AnalysisReason[];
  // Qué clase de incertidumbre hay detrás de los bloqueos (lectura, identidad, documento, política). Solo diagnóstico.
  uncertainty: UncertaintyKind[];
  // UUID que aporta este estudio a la cotización (vacío si quedó pendiente).
  lineIds: string[];
  // Riesgo visual (solo si el estudio no tenía otros bloqueos y se evaluó frente a las zonas que no se ven). Solo para el CRM.
  risk?: StudyRisk;
}

export interface PendingItem {
  key: string;
  kind: "STUDY" | "DISPUTE" | "UNSEEN_REGION";
  text?: string;
  blockers: string[];
  uncertainty: UncertaintyKind[];
  candidates?: CatalogCandidate[];
}

export interface InternalLine extends CatalogCandidate {
  basis: Array<QuoteBasis | "HUMAN">;
  texts: string[];
}

export interface HumanEvent {
  at: string;
  reviewer: string;
  action: "ASSIGN" | "NOT_REQUESTED" | "CONFIRM_NO_MORE_STUDIES";
  pendingKey: string;
  detail: string;
}

// Lo ÚNICO que ve el paciente: estudios, precios y el importe de esos estudios. Sin estados, advertencias, motivos, UUID ni pendientes.
export interface PublicQuote {
  studies: Array<{ name: string; priceBs: number }>;
  totalBs: number;
  totalLabel: string;
  tariff: "PACIENTE";
}

// Registro interno (CRM): todo lo que el paciente no debe ver.
export interface InternalRecord {
  outcome: QuoteOutcome;
  // true solo si no queda nada pendiente (ni estudios, ni disputas, ni zonas que no se ven).
  recipeComplete: boolean;
  reviewRequired: boolean;
  quoted: { lines: InternalLine[]; subtotalBs: number };
  studies: StudyDecision[];
  pending: PendingItem[];
  // Motivos que invalidan TODA la lectura (si hay alguno no se cotiza nada automáticamente).
  recipeStops: AnalysisReason[];
  document: {
    type?: string;
    // Función del documento comprobada (por qué no es una solicitud, o por qué se dudó). Solo para el CRM.
    function?: DocumentFunctionInfo;
    complete: boolean;
    issueKinds: string[];
    problems: string[];
    unseenRegion: boolean;
    // Zonas desconocidas del documento (cortes, objetos, trazos ilegibles...). Solo para el CRM.
    zones: UnknownZone[];
    impact?: { available: boolean; qualifierRisk: boolean; notes: string[] };
    // Si hay zonas que no se ven, qué estudios (sin otros bloqueos) necesitan la verificación de impacto.
    impactCheck: { needed: boolean; candidates: ImpactStudy[] };
  };
  // Avisos para el laboratorio (no cambian la cotización): p. ej. un paquete del catálogo cubre varios estudios cotizados por separado.
  advisories: string[];
  revision: string;
  history: HumanEvent[];
}

export interface PartialInput {
  studies: FinalVisualStudy[];
  matches: StudyMatch[];
  // Motivos propios de cada estudio (certeza, transcripción parcial, catálogo, matching semántico), alineados con `studies`.
  studyReasons: AnalysisReason[][];
  catalogById: Map<string, CatalogStudy>;
  catalog: CatalogStudy[];
  unresolvedDisputes: Array<{ key: string; reason: string }>;
  recipeStops: AnalysisReason[];
  // Hay zonas cortadas, ocultas o ilegibles que no invalidan la lectura de los demás estudios pero pueden contener MÁS estudios o afectar a los visibles.
  unseenRegion: boolean;
  documentType?: string;
  documentFunction?: DocumentFunctionInfo;
  documentComplete: boolean;
  documentKinds: string[];
  documentProblems: string[];
  impact?: StudyImpactResult;
  // Estudios cuyas dos lecturas difieren en alguna variante explícita.
  variantMismatch: Set<string>;
}

const BILLABLE = new Set(["CONFIRMS_EXACT", "SEMANTIC_ONLY", "SEMANTIC_COMPOSITE"]);
const validPrice = (priceBs: number) => Number.isFinite(priceBs) && priceBs >= 0;

export const studyKeyOf = (text: string): string => normalizeStudyKey(text);

// Los UUID (y el motivo de cada línea) que un estudio aporta SI queda aprobado.
export function linesOf(match: StudyMatch): Array<{ id: string; basis: QuoteBasis }> {
  const info = match.semanticPrimary;
  if (info) {
    if (!BILLABLE.has(info.contrast)) return [];
    if (info.contrast === "SEMANTIC_COMPOSITE") return info.studyIds.map((id) => ({ id, basis: "COMPOSITE_COMPONENT" as const }));
    return info.studyIds.slice(0, 1).map((id) => ({ id, basis: info.contrast === "CONFIRMS_EXACT" ? ("EXACT_CONFIRMED" as const) : ("SEMANTIC" as const) }));
  }
  return match.status === "MATCHED" && match.study ? [{ id: match.study.id, basis: "EXACT_CONFIRMED" as const }] : [];
}

function candidatesOf(match: StudyMatch, catalogById: Map<string, CatalogStudy>): CatalogCandidate[] | undefined {
  const toCandidate = (study: CatalogStudy): CatalogCandidate => ({ id: study.id, code: study.code, name: study.name, priceBs: study.priceBs });
  const ids = [...(match.candidates?.map((c) => c.id) ?? []), ...(match.semanticPrimary?.studyIds ?? []), ...(match.status === "MODEL_SUGGESTED" && match.study ? [match.study.id] : [])];
  const unique = [...new Set(ids)].map((id) => catalogById.get(id)).filter((study): study is CatalogStudy => Boolean(study));
  return unique.length > 0 ? unique.map(toCandidate) : undefined;
}

// Bloqueos propios de cada estudio, SIN la verificación de impacto del documento.
function baseBlockers(input: PartialInput): AnalysisReason[][] {
  return input.studies.map((study, index) => {
    const blockers = new Set<AnalysisReason>(input.studyReasons[index] ?? []);
    const match = input.matches[index]!;
    if (input.variantMismatch.has(studyKeyOf(study.literalText))) blockers.add("readers_variant_mismatch");
    const lines = linesOf(match);
    // La línea original (lineText) no se pierde: un paquete nombrado que las filas no reconstruyen, o un servicio pedido que el estudio no cubre.
    if (study.lineProblem) blockers.add("package_line_unreconstructable");
    const chosen = lines.map((line) => input.catalogById.get(line.id)).filter((candidate): candidate is CatalogStudy => Boolean(candidate));
    if (chosen.length > 0 && lineServiceGap(study, chosen).length > 0) blockers.add("line_service_not_covered");
    if (lines.length === 0 && blockers.size === 0) blockers.add("catalog_unmatched");
    if (lines.some((line) => !validPrice(input.catalogById.get(line.id)?.priceBs ?? Number.NaN))) blockers.add("catalog_price_invalid");
    return [...blockers];
  });
}

// Estudios que, sin otros bloqueos, dependen de comprobar que las zonas que no se ven no los afectan.
// Lo que se le muestra al verificador de impacto para UN estudio. El verificador trabaja sobre la IMAGEN, así que recibe lo que está ESCRITO en la fila
// (el texto literal de los lectores) y, si el estudio fue reconstruido (variante suelta que heredó el analito, filas reunidas en un paquete), la línea
// completa donde está escrito. El texto reconstruido nunca se le presenta como si estuviera en la imagen. La clave sigue siendo la del estudio final.
export function impactStudyOf(study: FinalVisualStudy): ImpactStudy {
  const key = studyKeyOf(study.literalText);
  const reconstructed = study.inheritedFrom !== undefined || study.collapsedFrom !== undefined;
  if (!reconstructed) return { key, text: study.literalText };
  const written = study.readerPairs?.length ? study.readerPairs.map((pair) => pair.a) : (study.collapsedFrom ?? [study.inheritedFrom!]);
  return { key, text: written.join(" | "), ...(study.lineText ? { line: study.lineText } : {}) };
}

export function impactCandidates(input: PartialInput): ImpactStudy[] {
  if (!input.unseenRegion || input.recipeStops.length > 0) return [];
  const base = baseBlockers(input);
  return input.studies.flatMap((study, index) => (base[index]!.length === 0 ? [impactStudyOf(study)] : []));
}

export function evaluatePartial(input: PartialInput): { outcome: QuoteOutcome; record: InternalRecord; publicQuote?: PublicQuote } {
  const blockers = baseBlockers(input);
  const keys = input.studies.map((study) => studyKeyOf(study.literalText));

  // Las zonas que no se ven: cada estudio visible solo pasa si se DEMUESTRA que no depende de ellas (dos lecturas). Sin verificación, ninguno pasa.
  const zones = zonesOf({ kinds: input.documentKinds, incomplete: input.unseenRegion });
  const risks: Array<StudyRisk | undefined> = input.studies.map(() => undefined);
  if (zones.length > 0) {
    input.studies.forEach((_study, index) => {
      if (blockers[index]!.length > 0) return;
      const catalogStudies = linesOf(input.matches[index]!).map((line) => input.catalogById.get(line.id));
      const risk = classifyStudyRisk(zones, { key: keys[index]!, contextSensitive: contextSensitive(catalogStudies, input.catalog), impact: input.impact });
      risks[index] = risk;
      if (risk.blocker) blockers[index]!.push(risk.blocker);
    });
  }

  // Paquete y componente: si un estudio aprobado es un paquete, otro estudio que sea uno de sus componentes no se cobra aparte.
  const idsOf = (index: number) => (blockers[index]!.length === 0 ? linesOf(input.matches[index]!).map((line) => line.id) : []);
  const approvedIds = [...new Set(input.studies.flatMap((_study, index) => idsOf(index)))];
  for (const pkgId of approvedIds) {
    const pkg = input.catalogById.get(pkgId);
    if (!pkg) continue;
    for (const componentId of approvedIds) {
      const component = input.catalogById.get(componentId);
      if (!component || !isPackageComponent(pkg, component)) continue;
      input.studies.forEach((_study, index) => {
        const mine = idsOf(index);
        if (mine.includes(componentId) && !mine.includes(pkgId)) blockers[index]!.push("package_component_overlap");
      });
    }
  }

  // Componentes que juntos forman un paquete activo: no se sabe si se pidieron por separado o como la expresión del paquete que los lectores separaron
  // (el precio aplicable lo decide el laboratorio), así que ese grupo queda pendiente. Si solo están algunos componentes, no hay grupo.
  const groupIds = new Set<string>();
  // Salvo que cada componente se haya pedido en SU PROPIA línea (lineText): eso es evidencia de pedido por separado.
  const pairs = input.studies.flatMap((study, index) => idsOf(index).flatMap((id) => { const found = input.catalogById.get(id); return found ? [{ study: found, source: study }] : []; }));
  const groups = heldPackageGroups(pairs, input.catalog);
  for (const group of groups) for (const part of group.parts) groupIds.add(part.id);
  if (groupIds.size > 0) {
    input.studies.forEach((_study, index) => {
      if (idsOf(index).some((id) => groupIds.has(id))) blockers[index]!.push("package_alternative_unresolved");
    });
  }

  const studies: StudyDecision[] = input.studies.map((study, index) => ({
    key: keys[index]!,
    text: study.literalText,
    decision: blockers[index]!.length === 0 ? "AUTO" : "HUMAN_REVIEW",
    blockers: blockers[index]!,
    uncertainty: uncertaintyKinds(blockers[index]!),
    lineIds: blockers[index]!.length === 0 ? linesOf(input.matches[index]!).map((line) => line.id) : [],
    ...(risks[index] ? { risk: risks[index] } : {})
  }));

  // Una línea por UUID (aunque lo aporten varios estudios), con el precio SIEMPRE del catálogo.
  const lineMap = new Map<string, InternalLine>();
  input.studies.forEach((study, index) => {
    if (studies[index]!.decision !== "AUTO") return;
    for (const line of linesOf(input.matches[index]!)) {
      const catalogStudy = input.catalogById.get(line.id)!;
      const existing = lineMap.get(line.id) ?? { id: catalogStudy.id, code: catalogStudy.code, name: catalogStudy.name, priceBs: catalogStudy.priceBs, basis: [], texts: [] };
      if (!existing.basis.includes(line.basis)) existing.basis.push(line.basis);
      if (!existing.texts.includes(study.literalText)) existing.texts.push(study.literalText);
      lineMap.set(line.id, existing);
    }
  });

  const dropped = droppedLineItemDetails(input.studies);
  const pending: PendingItem[] = [
    ...input.studies.flatMap((study, index): PendingItem[] =>
      studies[index]!.decision === "AUTO" ? [] : [{ key: keys[index]!, kind: "STUDY", text: study.literalText, blockers: studies[index]!.blockers, uncertainty: studies[index]!.uncertainty, candidates: candidatesOf(input.matches[index]!, input.catalogById) }]
    ),
    // Un elemento que la línea nombra y ninguna fila representa es un estudio posiblemente pedido y no leído: la receta no puede quedar completa.
    ...dropped.map((entry): PendingItem => ({ key: `line:${normalizeStudyKey(entry.item)}`, kind: "STUDY", text: entry.item, blockers: ["line_item_unrepresented"], uncertainty: uncertaintyKinds(["line_item_unrepresented"]) })),
    ...input.unresolvedDisputes.map((dispute): PendingItem => ({ key: `dispute:${dispute.key}`, kind: "DISPUTE", text: dispute.key, blockers: [dispute.reason], uncertainty: ["READING"] })),
    ...(zones.length > 0 ? [{ key: "UNSEEN_REGION", kind: "UNSEEN_REGION" as const, blockers: zones.map((zone) => zone.kind), uncertainty: ["DOCUMENT" as const] }] : [])
  ];

  const allLines = [...lineMap.values()];
  // Aviso para el laboratorio: qué paquete forman los estudios retenidos y por qué (qué precio aplica, paquete o suma, es una decisión comercial).
  const advisories = [...dropped.map((entry) => entry.message), ...groups.map((group) => `los estudios ${group.parts.map((p) => p.code ?? p.name).join(" + ")} forman el paquete «${group.pkg.name}» (${group.pkg.code ?? "sin código"}); quedaron pendientes porque no se puede saber si se pidieron por separado o como ese paquete`)];
  const quotedLines = input.recipeStops.length === 0 ? allLines : [];
  const outcome: QuoteOutcome = quotedLines.length === 0 ? "HUMAN_REVIEW" : pending.length === 0 ? "AUTO_COMPLETE" : "AUTO_PARTIAL";
  const subtotalBs = quotedLines.reduce((sum, line) => sum + line.priceBs, 0);
  const candidates = impactCandidates(input);

  const record: InternalRecord = {
    outcome,
    recipeComplete: outcome === "AUTO_COMPLETE",
    reviewRequired: outcome !== "AUTO_COMPLETE",
    quoted: { lines: quotedLines, subtotalBs },
    studies,
    pending,
    recipeStops: input.recipeStops,
    document: {
      type: input.documentType,
      ...(input.documentFunction ? { function: input.documentFunction } : {}),
      complete: input.documentComplete,
      issueKinds: input.documentKinds,
      problems: input.documentProblems,
      unseenRegion: input.unseenRegion,
      zones,
      impact: input.impact && { available: input.impact.available, qualifierRisk: input.impact.qualifierRisk, notes: input.impact.notes },
      impactCheck: { needed: input.unseenRegion && input.recipeStops.length === 0, candidates }
    },
    advisories,
    revision: revisionOf(quotedLines, pending),
    history: []
  };
  return { outcome, record, publicQuote: outcome === "HUMAN_REVIEW" ? undefined : buildPublicQuote(quotedLines) };
}

export function buildPublicQuote(lines: Array<Pick<CatalogCandidate, "name" | "priceBs">>): PublicQuote {
  return {
    studies: lines.map((line) => ({ name: line.name, priceBs: line.priceBs })),
    totalBs: lines.reduce((sum, line) => sum + line.priceBs, 0),
    totalLabel: PUBLIC_TOTAL_LABEL,
    tariff: "PACIENTE"
  };
}

// Identifica el estado de la cotización: toda resolución humana debe referirse a esta revisión (evita completar sobre algo desactualizado).
export function revisionOf(lines: Array<{ id: string }>, pending: Array<{ key: string }>): string {
  return createHash("sha256").update(JSON.stringify({ lines: lines.map((l) => l.id).sort(), pending: pending.map((p) => p.key).sort() })).digest("hex").slice(0, 16);
}
