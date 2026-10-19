import { readImageWithGemini, readImageWithOpenAI, type SimpleReading } from "./ai.js";
import { ExactAliasCatalogResolver, uniqueMatchedStudies } from "./catalog.js";
import { buildSimpleConsensus, isTruncationOf, normalizeStudyKey, normalizeVisibleKey, sameVisibleText, type SimpleConsensus, type SimpleStudy } from "./consensus.js";
import { activeCatalog, GENERIC_PROFILE_WORDS, identityTokens, qualifiersOf, shadowMatch, type Outcome, type ShadowBatch, type Support } from "./catalog-shadow.js";
import type { AiUsage } from "./cache.js";
import { readDocumentSignal, type DocumentSignal } from "./document-signal.js";
import { judgeDisputesWithOpenAI, type SimpleJudgement } from "./judge.js";
import {
  resolveCatalogSemantically,
  type SemanticBatchResult,
  type SemanticConfidence,
  type SemanticItemResult,
  type SemanticResolution
} from "./catalog-semantic-resolver.js";
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
  // MODEL_SUGGESTED: el matcher exacto no encontró nada y el modelo sugirió un estudio (nunca produce AUTO).
  // SEMANTIC_CANDIDATE: solo con la integración semántica principal; GPT verificado eligió un estudio que el matcher exacto no resolvió
  // (candidato a AUTO, todavía sin autorización de facturación).
  status: CatalogResolution["status"] | "MODEL_SUGGESTED" | "SEMANTIC_CANDIDATE";
  study?: CatalogCandidate;
  // Compuesto explícito verificado (SEMANTIC_CANDIDATE): un estudio por componente, con su UUID y precio del catálogo.
  components?: Array<CatalogCandidate & { fragment: string }>;
  candidates?: CatalogCandidate[];
  // Resultado de la segunda capa (solo para textos que el matcher exacto dejó UNMATCHED).
  semanticResolution?: SemanticResolution;
  semanticNote?: string;
  // Solo diagnóstico: qué pasaría con normalizedName. Nunca influye en la decisión ni en la cotización.
  diagnosticNormalizedName: { text: string; status: CatalogResolution["status"] };
  semanticPrimary?: SemanticPrimaryMatch;
  // Este texto es un comienzo truncado de otro estudio final de la misma receta (se indica el texto completo).
  partialTranscriptionOf?: string;
}

// Contraste entre el resolvedor semántico principal (GPT + verificador, catálogo completo) y el matcher exacto/alias.
// SEMANTIC_COMPOSITE: el texto nombra explícitamente varios estudios y cada componente quedó verificado (candidato, sin autorizar).
export type SemanticContrast = "CONFIRMS_EXACT" | "SEMANTIC_ONLY" | "SEMANTIC_COMPOSITE" | "CONTRADICTS_EXACT" | "NO_SEMANTIC_MATCH" | "UNAVAILABLE";

// Un compuesto explícito se descompone en estudios individuales solo si son pocos y el texto no es un perfil/panel genérico.
export const MAX_COMPOSITE_COMPONENTS = 4;

export interface SemanticPrimaryMatch {
  kind: Outcome["kind"] | "UNAVAILABLE";
  // Las dos pasadas independientes coincidieron.
  agreement: boolean;
  studyIds: string[];
  support?: Support;
  // Solo en compuestos explícitos: el fragmento del texto que nombra cada componente.
  components?: Array<{ studyId: string; fragment: string; support: Support }>;
  contrast: SemanticContrast;
  reading: string;
  reason: string;
}

export type AnalysisReason =
  | "handwritten_out_of_scope"
  | "not_a_request"
  | "document_type_uncertain"
  | "document_not_complete"
  | "visual_disputes_unresolved"
  | "visual_partial_transcription"
  | "no_requested_studies"
  | "non_high_certainty_study"
  | "catalog_unmatched"
  | "catalog_ambiguous"
  | "catalog_model_suggested"
  // Integración semántica principal (bandera CATALOG_SEMANTIC_PRIMARY).
  | "semantic_unavailable"
  | "semantic_ambiguous"
  | "semantic_no_match"
  | "semantic_composite_requires_policy"
  | "semantic_rejected_by_verifier"
  | "semantic_passes_disagree"
  | "semantic_contradicts_exact"
  | "semantic_auto_not_enabled"
  | "catalog_price_invalid";

// Por qué una línea entró en la cotización (solo con la integración semántica principal): auditoría, no afecta al cobro.
export type QuoteBasis = "EXACT_CONFIRMED" | "SEMANTIC" | "COMPOSITE_COMPONENT";

export interface AnalysisQuote {
  lines: CatalogCandidate[];
  totalBs: number;
  tariff: "PACIENTE";
  audit?: Array<{ id: string; basis: QuoteBasis[]; texts: string[] }>;
}

// Señal de documento que usa la decisión (mismas reglas que src/safety.ts). Sin señal: fail closed.
export interface DocumentGate {
  documentType: DocumentSignal["documentType"];
  completeDocumentVisible: boolean;
  agreement?: boolean;
  // Por qué la zona de estudios no pudo comprobarse completa (vacío si lo está) y qué recortes irrelevantes se ignoraron.
  integrityProblems?: string[];
  irrelevantCrops?: string[];
  // Bordes a los que se acercaba la zona de estudios y que la verificación enfocada confirmó completos (no bloquean).
  verifiedEdges?: string[];
  edgeNotes?: string[];
  // Objetos que tapaban partes de la hoja y que la verificación enfocada confirmó que solo ocultaban guiones, márgenes o espacio vacío.
  hiddenVerified?: boolean;
  hiddenNotes?: string[];
  // Contexto impreso que se entregó al resolvedor semántico (solo lo que ambas lecturas coincidieron en ver).
  context?: { lines: string[]; muestra?: string; tiempo?: string; conflicts: string[] };
}

export interface AnalysisResult {
  decision: "AUTO_SAFE" | "HUMAN_REVIEW";
  reasons: AnalysisReason[];
  document?: DocumentGate;
  finalVisualStudies: FinalVisualStudy[];
  disputes: Array<{ key: string; reason: string }>;
  judgeResolved: Array<{ key: string; verdict: "confirmed" | "rejected"; reason: string }>;
  unresolvedDisputes: Array<{ key: string; reason: string }>;
  matches: StudyMatch[];
  // Resumen de lo que no se pudo resolver; el detalle completo está en matches.
  unmatched: string[];
  ambiguous: Array<{ literalText: string; candidates: CatalogCandidate[] }>;
  // Sugerencias del modelo (requieren revisión humana; nunca entran a una cotización AUTO).
  modelSuggested: Array<{ literalText: string; study: CatalogCandidate; confidence: SemanticConfidence; reason: string }>;
  semantic?: Pick<SemanticBatchResult, "model" | "reasoning" | "calledModel" | "cacheHit" | "usage" | "candidatesSentToModel">;
  // Solo con la integración semántica principal activa. `decision` sigue siendo la de producción (más estricta, con el contraste exacto);
  // autoCandidate registra qué pasaría si los MATCH semánticos fueran facturables, sin autorizarlo.
  semanticPrimary?: {
    // true si los MATCH semánticos verificados pueden ser facturables (CATALOG_SEMANTIC_AUTO); false: solo candidatos.
    autoEnabled: boolean;
    model: string;
    reasoning: string;
    catalogSize: number;
    calls: number;
    cacheHits: number;
    usage: AiUsage[];
    error?: string;
    autoCandidate: { decision: "AUTO_SAFE" | "HUMAN_REVIEW"; reasons: AnalysisReason[]; quote?: AnalysisQuote };
  };
  // Solo con CATALOG_HANDWRITTEN_AUTO=shadow y un pedido manuscrito: qué pasaría si los manuscritos legibles pudieran ser AUTO. NUNCA cambia
  // `decision` (el manuscrito sigue en HUMAN_REVIEW con handwritten_out_of_scope) ni produce una cotización real.
  handwrittenShadow?: {
    eligible: boolean;
    blockers: string[];
    simulatedDecision: "AUTO_SAFE" | "HUMAN_REVIEW";
    quote?: AnalysisQuote;
  };
  quote?: AnalysisQuote;
}

export type HandwrittenAutoMode = "off" | "shadow";

// Bandera del AUTO manuscrito. Solo existe el modo "shadow" (evaluar y reportar sin autorizar nada); cualquier otro valor la deja apagada.
export function handwrittenAutoMode(env: NodeJS.ProcessEnv = process.env): HandwrittenAutoMode {
  return env.CATALOG_HANDWRITTEN_AUTO?.trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

// Mismas variantes explícitas (isotipo, libre/total, cualitativo, método, población, muestra, seriado/simple, 24 h...) en dos transcripciones.
function sameVariants(a: string, b: string): boolean {
  const qa = qualifiersOf(identityTokens(a));
  const qb = qualifiersOf(identityTokens(b));
  return (Object.keys(qa) as Array<keyof typeof qa>).every((dim) => qa[dim].size === qb[dim].size && [...qa[dim]].every((value) => qb[dim].has(value)));
}

// Evaluación en SOMBRA del AUTO manuscrito. Exige TODO: documento verificado completo y legible; dos lecturas concordantes sin juez, con certeza
// alta y las mismas variantes explícitas; cada estudio resuelto por el matching semántico verificado; y cualquier otro motivo de revisión ausente.
// Ante la menor duda el resultado simulado es HUMAN_REVIEW.
function evaluateHandwrittenShadow(args: {
  document: DocumentGate;
  consensus: SimpleConsensus;
  studies: FinalVisualStudy[];
  primary: SemanticPrimaryInput | undefined;
  otherReasons: AnalysisReason[];
  lines?: { lines: CatalogCandidate[]; audit: NonNullable<AnalysisQuote["audit"]> };
}): NonNullable<AnalysisResult["handwrittenShadow"]> {
  const { document, consensus, studies, primary, otherReasons, lines } = args;
  const blockers: string[] = [];
  if (!primary) blockers.push("requiere la integración semántica principal (matching verificado)");
  else if (primary.error || !primary.batch) blockers.push("el resolvedor semántico no estuvo disponible");
  if (!document.completeDocumentVisible || (document.integrityProblems?.length ?? 0) > 0) blockers.push("el documento no se verificó completo y legible");
  if (document.agreement === false) blockers.push("las dos lecturas del documento no coinciden en el tipo");
  if (studies.length === 0) blockers.push("no hay estudios");
  if (consensus.disputes.length > 0) blockers.push("hubo disputas entre lectores: se exige concordancia directa, sin juez");
  for (const study of studies) {
    if (study.source !== "agreed") { blockers.push(`«${study.literalText}» no fue acordado directamente por ambos lectores`); continue; }
    if (study.confidence !== "high") blockers.push(`«${study.literalText}» no tiene certeza alta`);
    const pair = consensus.agreedPairs?.find((candidate) => candidate.a.literalText === study.literalText);
    if (!pair) blockers.push(`no constan las dos lecturas de «${study.literalText}»`);
    else {
      if (pair.a.confidence !== "high" || pair.b.confidence !== "high") blockers.push(`«${study.literalText}» no tiene certeza alta en ambos lectores`);
      if (!sameVariants(pair.a.literalText, pair.b.literalText)) blockers.push(`los lectores difieren en una variante de «${pair.a.literalText}» / «${pair.b.literalText}»`);
    }
  }
  for (const reason of otherReasons) blockers.push(`motivo de revisión pendiente: ${reason}`);
  const eligible = blockers.length === 0 && Boolean(lines) && lines!.lines.length > 0;
  if (blockers.length === 0 && !eligible) blockers.push("no se pudo construir la cotización simulada");
  return {
    eligible,
    blockers,
    simulatedDecision: eligible ? "AUTO_SAFE" : "HUMAN_REVIEW",
    quote: eligible ? { lines: lines!.lines, totalBs: lines!.lines.reduce((sum, line) => sum + line.priceBs, 0), tariff: "PACIENTE", audit: lines!.audit } : undefined
  };
}

// Resultado de la capa semántica principal para el ensamblado: el lote verificado, o el error que la dejó no disponible.
export interface SemanticPrimaryInput {
  batch?: ShadowBatch;
  error?: string;
}

// Un compuesto solo se descompone si el texto NOMBRA los estudios (el verificador ya exigió fragmento, identidad, sin variantes
// plausibles y lista cubierta). Aquí se agregan las reglas de la integración: nunca perfiles/paneles genéricos, tope de componentes y
// UUID vigentes en el catálogo. Devuelve el problema que lo deja en revisión, o undefined si es inequívoco.
function compositeProblem(
  text: string,
  components: Array<{ studyId: string; fragment: string }>,
  catalogById: Map<string, CatalogStudy>
): { reason: AnalysisReason; message: string } | undefined {
  const isGeneric = (value: string) => normalizeStudyKey(value).split(" ").some((word) => GENERIC_PROFILE_WORDS.has(word) || word.startsWith("perfil"));
  if (isGeneric(text) || components.some((component) => isGeneric(component.fragment))) {
    return { reason: "semantic_composite_requires_policy", message: "perfil o panel genérico: la composición requiere política de laboratorio" };
  }
  if (components.length < 2 || components.length > MAX_COMPOSITE_COMPONENTS) {
    return { reason: "semantic_composite_requires_policy", message: `compuesto con ${components.length} componentes (permitido: 2 a ${MAX_COMPOSITE_COMPONENTS})` };
  }
  const seen = new Set<string>();
  for (const component of components) {
    const study = catalogById.get(component.studyId);
    if (!study || !study.active) return { reason: "semantic_rejected_by_verifier", message: "un componente no existe o no está activo en el catálogo" };
    if (seen.has(component.studyId) || component.fragment.trim() === "") return { reason: "semantic_rejected_by_verifier", message: "componente repetido o sin fragmento" };
    seen.add(component.studyId);
  }
  return undefined;
}

// Juzga un estudio visual: resultado semántico verificado frente a lo que dice el matcher exacto/alias. Pura.
function contrastWithExact(
  match: StudyMatch,
  result: ShadowBatch["results"][number] | undefined,
  catalogById: Map<string, CatalogStudy>,
  semanticAuto: boolean
): { info: SemanticPrimaryMatch; reasons: AnalysisReason[] } {
  const notBillable: AnalysisReason[] = semanticAuto ? [] : ["semantic_auto_not_enabled"];
  if (!result) {
    return { info: { kind: "UNAVAILABLE", agreement: false, studyIds: [], contrast: "UNAVAILABLE", reading: "", reason: "sin resultado semántico para este texto" }, reasons: ["semantic_unavailable"] };
  }
  const outcome = result.outcome;
  const exactId = match.status === "MATCHED" ? match.study?.id : undefined;
  const base = { kind: outcome.kind, agreement: result.agreement, reading: result.modelNotes.reading };
  const ids = outcome.kind === "MATCH" ? [outcome.studyId]
    : outcome.kind === "COMPOSITE" ? outcome.components.map((component) => component.studyId)
    : outcome.kind === "NO_MATCH" ? [] : outcome.studyIds;
  const reasonText = outcome.kind === "MATCH" ? "" : outcome.reason;

  if (!result.agreement) {
    return {
      info: { ...base, studyIds: ids, contrast: exactId ? "CONTRADICTS_EXACT" : "NO_SEMANTIC_MATCH", reason: reasonText },
      reasons: ["semantic_passes_disagree", ...(exactId ? ["semantic_contradicts_exact" as const] : [])]
    };
  }
  if (outcome.kind === "MATCH") {
    const study = catalogById.get(outcome.studyId);
    // El UUID debe existir en el catálogo cargado de Supabase y estar activo (nunca se confía en el modelo).
    if (!study || !study.active) {
      return { info: { ...base, kind: "REJECTED", studyIds: ids, contrast: "NO_SEMANTIC_MATCH", reason: "el UUID elegido no existe o no está activo en el catálogo" }, reasons: ["semantic_rejected_by_verifier"] };
    }
    const info = { ...base, studyIds: ids, support: outcome.support, reason: "" };
    if (exactId === outcome.studyId) return { info: { ...info, contrast: "CONFIRMS_EXACT" }, reasons: [] };
    if (match.status === "UNMATCHED") return { info: { ...info, contrast: "SEMANTIC_ONLY" }, reasons: notBillable };
    // El exacto resolvió otro estudio (o varios): contradicción, siempre revisión humana.
    return { info: { ...info, contrast: "CONTRADICTS_EXACT", reason: "el matcher exacto/alias resuelve distinto" }, reasons: ["semantic_contradicts_exact"] };
  }
  if (outcome.kind === "COMPOSITE") {
    const info = { ...base, studyIds: ids, components: outcome.components, reason: reasonText };
    // El exacto/alias ya resolvió el texto completo a algo (cobraría solo una parte del compuesto): contradicción.
    if (match.status !== "UNMATCHED") {
      return { info: { ...info, contrast: "CONTRADICTS_EXACT", reason: "el matcher exacto/alias resuelve el texto completo de otra forma" }, reasons: ["semantic_contradicts_exact"] };
    }
    const problem = compositeProblem(match.matchedText, outcome.components, catalogById);
    if (problem) return { info: { ...info, contrast: "NO_SEMANTIC_MATCH", reason: problem.message }, reasons: [problem.reason] };
    return { info: { ...info, contrast: "SEMANTIC_COMPOSITE" }, reasons: notBillable };
  }
  const reasons: AnalysisReason[] = [
    outcome.kind === "AMBIGUOUS" ? "semantic_ambiguous"
      : outcome.kind === "NO_MATCH" ? "semantic_no_match"
      : "semantic_rejected_by_verifier"
  ];
  // Si el exacto sí resolvió un estudio y GPT no lo respalda (ni entre sus plausibles), es contradicción.
  if (exactId && !ids.includes(exactId)) reasons.push("semantic_contradicts_exact");
  else if (exactId && (outcome.kind === "NO_MATCH" || outcome.kind === "REJECTED")) reasons.push("semantic_contradicts_exact");
  return { info: { ...base, studyIds: ids, contrast: reasons.includes("semantic_contradicts_exact") ? "CONTRADICTS_EXACT" : "NO_SEMANTIC_MATCH", reason: reasonText }, reasons };
}

// Líneas que el contraste semántico respalda: coincidencias confirmadas por el exacto, MATCH semánticos y componentes de compuestos
// explícitos verificados. Un estudio, una línea, un cobro (UUID), con el precio siempre del catálogo de Supabase.
function semanticBillableLines(matches: StudyMatch[], catalogById: Map<string, CatalogStudy>): { lines: CatalogCandidate[]; audit: NonNullable<AnalysisQuote["audit"]>; invalidPrice: boolean } {
  const lines = new Map<string, CatalogCandidate>();
  const audit = new Map<string, { id: string; basis: QuoteBasis[]; texts: string[] }>();
  let invalidPrice = false;
  for (const match of matches) {
    const info = match.semanticPrimary;
    if (!info) continue;
    const basis: QuoteBasis | undefined = info.contrast === "CONFIRMS_EXACT" ? "EXACT_CONFIRMED" : info.contrast === "SEMANTIC_ONLY" ? "SEMANTIC" : info.contrast === "SEMANTIC_COMPOSITE" ? "COMPOSITE_COMPONENT" : undefined;
    if (!basis) continue;
    const ids = info.contrast === "SEMANTIC_COMPOSITE" ? info.studyIds : info.studyIds.slice(0, 1);
    for (const id of ids) {
      const study = catalogById.get(id);
      if (!study) continue;
      if (!Number.isFinite(study.priceBs) || study.priceBs < 0) invalidPrice = true;
      if (!lines.has(id)) lines.set(id, toCandidate(study));
      const entry = audit.get(id) ?? { id, basis: [], texts: [] };
      if (!entry.basis.includes(basis)) entry.basis.push(basis);
      if (!entry.texts.includes(match.matchedText)) entry.texts.push(match.matchedText);
      audit.set(id, entry);
    }
  }
  return { lines: [...lines.values()], audit: [...audit.values()], invalidPrice };
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

// Estudios visuales finales: acordados + confirmados por el juez. Los rechazados se excluyen.
export function finalVisualStudiesOf(consensus: SimpleConsensus, judgement: SimpleJudgement): FinalVisualStudy[] {
  const all = [
    ...consensus.agreedStudies.map((study) => ({ ...study, source: "agreed" as const })),
    ...judgement.resolvedStudies
      .filter((resolved) => resolved.verdict === "confirmed")
      .map((resolved) => ({ ...resolved.study, source: "judge_confirmed" as const }))
  ];
  // Una selección visual, un estudio: el mismo texto (ignorando espaciado y puntuación) no se cuenta dos veces.
  const kept: FinalVisualStudy[] = [];
  for (const study of all) if (!kept.some((other) => sameVisibleText(other.literalText, study.literalText))) kept.push(study);
  return kept;
}

// Estudios finales cuyo texto es un comienzo truncado de OTRO estudio final ("NITROGENO UREICO" frente a "NITROGENO UREICO/UREA/NUS").
// Pueden ser dos transcripciones de la misma fila; la versión incompleta nunca puede producir una coincidencia por sí sola.
export function partialTranscriptions(studies: FinalVisualStudy[]): Map<string, string> {
  const partial = new Map<string, string>();
  for (const short of studies) {
    const shortKey = normalizeVisibleKey(short.literalText);
    const fuller = studies.find((other) => other !== short && isTruncationOf(shortKey, normalizeVisibleKey(other.literalText)));
    if (fuller) partial.set(short.literalText, fuller.literalText);
  }
  return partial;
}

// Ensamblado puro (sin red): consenso + juez + catálogo (+ resolución semántica ya calculada) -> decisión y cotización.
export function assembleAnalysis(args: {
  consensus: SimpleConsensus;
  judgement: SimpleJudgement;
  catalog: CatalogStudy[];
  semantic?: SemanticBatchResult;
  document?: DocumentGate;
  primary?: SemanticPrimaryInput;
  // Solo con `primary`: los MATCH semánticos verificados (y compuestos explícitos) pueden ser AUTO. Apagado por defecto.
  semanticAuto?: boolean;
  // Evalúa (sin autorizar) qué pasaría con un pedido manuscrito si pudiera ser AUTO. Requiere `primary` para tener algún resultado útil.
  handwrittenShadow?: boolean;
}): AnalysisResult {
  const { consensus, judgement, catalog, semantic, document, primary } = args;
  const semanticAuto = Boolean(primary && args.semanticAuto);
  const finalVisualStudies = finalVisualStudiesOf(consensus, judgement);
  const partialOf = partialTranscriptions(finalVisualStudies);
  const semanticByText = new Map<string, SemanticItemResult>((semantic?.items ?? []).map((item) => [item.literalText, item]));

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
  const catalogById = new Map(catalog.map((study) => [study.id, study]));
  const matches: StudyMatch[] = finalVisualStudies.map((visual) => {
    const resolution = resolver.resolve(observationFor(visual.literalText));
    const diagnostic = resolver.resolve(observationFor(visual.normalizedName));
    const match: StudyMatch = {
      visual,
      matchedText: visual.literalText,
      status: resolution.status,
      study: resolution.status === "MATCHED" ? toCandidate(resolution.study) : undefined,
      candidates: resolution.status === "AMBIGUOUS" ? resolution.candidates.map(toCandidate) : undefined,
      diagnosticNormalizedName: { text: visual.normalizedName, status: diagnostic.status }
    };

    // Segunda capa: SOLO si el matcher exacto/alias dejó UNMATCHED. Un MATCH del modelo es solo una sugerencia.
    if (resolution.status === "UNMATCHED") {
      const semanticItem = semanticByText.get(visual.literalText);
      if (semanticItem) {
        match.semanticResolution = semanticItem.resolution;
        match.semanticNote = semanticItem.note;
        const suggested = semanticItem.resolution.status === "MATCH" ? catalogById.get(semanticItem.resolution.studyId) : undefined;
        if (suggested) {
          match.status = "MODEL_SUGGESTED";
          match.study = toCandidate(suggested);
        } else if (semanticItem.resolution.status === "AMBIGUOUS") {
          match.candidates = semanticItem.resolution.candidateStudyIds
            .map((id) => catalogById.get(id))
            .filter((study): study is CatalogStudy => Boolean(study))
            .map(toCandidate);
        }
      }
    }
    const truncatedOf = partialOf.get(visual.literalText);
    if (truncatedOf) match.partialTranscriptionOf = truncatedOf;
    return match;
  });

  // Integración semántica principal: contraste por estudio. Cualquier fallo (GPT, catálogo, verificación) deja el estudio sin respaldo.
  const semanticReasons: AnalysisReason[] = [];
  if (primary) {
    const resultByText = new Map((primary.error ? [] : primary.batch?.results ?? []).map((result) => [result.literalText, result]));
    if (primary.error || !primary.batch) semanticReasons.push("semantic_unavailable");
    for (const match of matches) {
      if (match.partialTranscriptionOf) {
        // La versión incompleta no puede producir coincidencia; el motivo global ya fuerza revisión.
        match.semanticPrimary = { kind: "NO_MATCH", agreement: true, studyIds: [], contrast: "NO_SEMANTIC_MATCH", reading: "", reason: `transcripción parcial de «${match.partialTranscriptionOf}»` };
        continue;
      }
      const judged = contrastWithExact(match, resultByText.get(match.matchedText), catalogById, semanticAuto);
      match.semanticPrimary = judged.info;
      semanticReasons.push(...judged.reasons);
      if (judged.info.contrast === "SEMANTIC_ONLY") {
        match.status = "SEMANTIC_CANDIDATE";
        match.study = toCandidate(catalogById.get(judged.info.studyIds[0]!)!);
      } else if (judged.info.contrast === "SEMANTIC_COMPOSITE") {
        match.status = "SEMANTIC_CANDIDATE";
        match.components = (judged.info.components ?? []).map((component) => ({ ...toCandidate(catalogById.get(component.studyId)!), fragment: component.fragment }));
      }
    }
  }

  const semanticLines = primary ? semanticBillableLines(matches, catalogById) : undefined;
  // Un precio inválido en cualquier línea semántica impide cobrar (nunca se cotiza con un importe que no sea del catálogo).
  if (semanticLines?.invalidPrice) semanticReasons.push("catalog_price_invalid");

  const unmatchedMatches = matches.filter((match) => match.status === "UNMATCHED");
  const ambiguousMatches = matches.filter((match) => match.status === "AMBIGUOUS");
  const suggestedMatches = matches.filter((match) => match.status === "MODEL_SUGGESTED");

  const reasons: AnalysisReason[] = [];
  // Compuerta de documento (README: "documento soportado y visible completo"). Sin señal, nunca AUTO.
  if (!document || document.documentType === "UNKNOWN") reasons.push("document_type_uncertain");
  else if (document.documentType === "HANDWRITTEN_REQUEST") reasons.push("handwritten_out_of_scope");
  else if (document.documentType === "NOT_A_REQUEST") reasons.push("not_a_request");
  if (document && !document.completeDocumentVisible) reasons.push("document_not_complete");
  if (unresolvedDisputes.length > 0) reasons.push("visual_disputes_unresolved");
  if (partialOf.size > 0) reasons.push("visual_partial_transcription");
  if (finalVisualStudies.length === 0) reasons.push("no_requested_studies");
  if (finalVisualStudies.some((study) => study.confidence !== "high")) reasons.push("non_high_certainty_study");
  // Con la integración semántica principal el contraste por estudio reemplaza los motivos de catálogo del flujo clásico.
  const documentReasons = [...reasons];
  if (primary) {
    reasons.push(...new Set(semanticReasons));
  } else {
    if (unmatchedMatches.length > 0) reasons.push("catalog_unmatched");
    if (ambiguousMatches.length > 0) reasons.push("catalog_ambiguous");
    // Cualquier sugerencia del modelo exige revisión humana.
    if (suggestedMatches.length > 0) reasons.push("catalog_model_suggested");
  }

  const decision = reasons.length === 0 ? "AUTO_SAFE" : "HUMAN_REVIEW";

  // Candidato a AUTO semántico (sin autorizar): ¿qué pasaría si los MATCH semánticos fueran facturables?
  let semanticPrimary: AnalysisResult["semanticPrimary"];
  if (primary) {
    const candidateReasons = [...new Set([...documentReasons, ...semanticReasons.filter((reason) => reason !== "semantic_auto_not_enabled")])];
    const candidateDecision = candidateReasons.length === 0 ? "AUTO_SAFE" : "HUMAN_REVIEW";
    const lines = candidateDecision === "AUTO_SAFE" ? semanticLines!.lines : [];
    semanticPrimary = {
      autoEnabled: semanticAuto,
      model: primary.batch?.model ?? "",
      reasoning: primary.batch?.reasoning ?? "",
      catalogSize: primary.batch?.catalogSize ?? 0,
      calls: primary.batch?.calls ?? 0,
      cacheHits: primary.batch?.cacheHits ?? 0,
      usage: primary.batch?.usage ?? [],
      error: primary.error,
      autoCandidate: {
        decision: candidateDecision,
        reasons: candidateReasons,
        quote: candidateDecision === "AUTO_SAFE" ? { lines, totalBs: lines.reduce((sum, line) => sum + line.priceBs, 0), tariff: "PACIENTE", audit: semanticLines!.audit } : undefined
      }
    };
  }

  // Cotización solo si todo está resuelto; deduplicada por lab_tests.id y con price_bs (tarifa Paciente).
  let quote: AnalysisQuote | undefined;
  if (decision === "AUTO_SAFE" && semanticAuto) {
    // AUTO semántico habilitado: todas las líneas (exactas confirmadas, semánticas y componentes) con su auditoría.
    const lines = semanticLines!.lines;
    quote = { lines, totalBs: lines.reduce((sum, line) => sum + line.priceBs, 0), tariff: "PACIENTE", audit: semanticLines!.audit };
  } else if (decision === "AUTO_SAFE") {
    const resolutions: CatalogResolution[] = matches.flatMap((match) => {
      if (match.status !== "MATCHED") return []; // MODEL_SUGGESTED jamás entra a una cotización
      const study = catalogById.get(match.study?.id ?? "");
      return study ? [{ status: "MATCHED" as const, observed: observationFor(match.matchedText), study }] : [];
    });
    const lines = uniqueMatchedStudies(resolutions).map(toCandidate);
    quote = { lines, totalBs: lines.reduce((sum, line) => sum + line.priceBs, 0), tariff: "PACIENTE" };
  }

  // Modo sombra del AUTO manuscrito: solo se evalúa y se informa; la decisión de producción no cambia.
  let handwrittenShadow: AnalysisResult["handwrittenShadow"];
  if (args.handwrittenShadow && document?.documentType === "HANDWRITTEN_REQUEST") {
    const otherReasons = [...new Set([...documentReasons, ...semanticReasons.filter((reason) => reason !== "semantic_auto_not_enabled")])].filter((reason) => reason !== "handwritten_out_of_scope");
    handwrittenShadow = evaluateHandwrittenShadow({ document, consensus, studies: finalVisualStudies, primary, otherReasons, lines: semanticLines });
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
    document,
    matches,
    unmatched: unmatchedMatches.map((match) => match.matchedText),
    ambiguous: ambiguousMatches.map((match) => ({ literalText: match.matchedText, candidates: match.candidates ?? [] })),
    modelSuggested: suggestedMatches.map((match) => {
      const resolution = match.semanticResolution as Extract<SemanticResolution, { status: "MATCH" }>;
      return { literalText: match.matchedText, study: match.study!, confidence: resolution.confidence, reason: resolution.reason };
    }),
    semantic: semantic && {
      model: semantic.model,
      reasoning: semantic.reasoning,
      calledModel: semantic.calledModel,
      cacheHit: semantic.cacheHit,
      usage: semantic.usage,
      candidatesSentToModel: semantic.candidatesSentToModel
    },
    semanticPrimary,
    handwrittenShadow,
    quote
  };
}

export interface AnalyzeDeps {
  readGemini: typeof readImageWithGemini;
  readOpenAI: typeof readImageWithOpenAI;
  judge: typeof judgeDisputesWithOpenAI;
  resolveSemantic: typeof resolveCatalogSemantically;
  readDocument: (args: { imageBase64: string; mimeType: string }) => Promise<{ signal: DocumentSignal }>;
  shadowMatch: typeof shadowMatch;
}

export const defaultAnalyzeDeps: AnalyzeDeps = {
  readGemini: readImageWithGemini,
  readOpenAI: readImageWithOpenAI,
  judge: judgeDisputesWithOpenAI,
  resolveSemantic: resolveCatalogSemantically,
  readDocument: readDocumentSignal,
  shadowMatch
};

// Bandera del AUTO semántico: solo tiene efecto con la integración semántica principal encendida. Apagada por defecto.
export function semanticAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CATALOG_SEMANTIC_AUTO?.trim().toLowerCase() === "on";
}

// Bandera de la integración semántica principal (GPT sobre el catálogo completo). Apagada por defecto.
export function semanticPrimaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CATALOG_SEMANTIC_PRIMARY?.trim().toLowerCase() === "on";
}

// Flujo completo: lectores (con cache) -> consenso -> juez solo si hay disputas -> catálogo -> decisión.
export async function analyzeImage(
  args: { imageBase64: string; mimeType: string; catalog: CatalogStudy[]; semanticPrimary?: boolean; semanticAuto?: boolean; handwrittenAuto?: HandwrittenAutoMode },
  deps: AnalyzeDeps = defaultAnalyzeDeps
): Promise<AnalysisResult> {
  const { imageBase64, mimeType, catalog } = args;
  const primaryEnabled = args.semanticPrimary ?? semanticPrimaryEnabled();
  const autoEnabled = primaryEnabled && (args.semanticAuto ?? semanticAutoEnabled());
  const handwrittenShadow = primaryEnabled && (args.handwrittenAuto ?? handwrittenAutoMode()) === "shadow";
  const [gemini, openai, documentRead]: [SimpleReading, SimpleReading, { signal: DocumentSignal }] = await Promise.all([
    deps.readGemini(imageBase64, mimeType),
    deps.readOpenAI(imageBase64, mimeType),
    deps.readDocument({ imageBase64, mimeType })
  ]);
  const signal = documentRead.signal;
  const document: DocumentGate = {
    documentType: signal.documentType,
    completeDocumentVisible: signal.completeDocumentVisible,
    agreement: signal.agreement,
    integrityProblems: signal.integrity.problems,
    irrelevantCrops: signal.integrity.irrelevantCrops,
    verifiedEdges: signal.integrity.verifiedEdges,
    edgeNotes: signal.integrity.edgeNotes,
    hiddenVerified: signal.integrity.hiddenVerified,
    hiddenNotes: signal.integrity.hiddenNotes,
    context: signal.context && { lines: signal.context.lines, muestra: signal.context.muestra, tiempo: signal.context.tiempo, conflicts: signal.context.conflicts }
  };

  const consensus = buildSimpleConsensus(gemini, openai);
  const judgement: SimpleJudgement = consensus.hasDisputes
    ? await deps.judge({ imageBase64, mimeType, gemini, openai, disputes: consensus.disputes })
    : { resolvedStudies: [], unresolvedDisputes: [] };

  if (primaryEnabled) {
    // Capa semántica principal: TODOS los estudios visuales finales pasan por GPT (catálogo activo completo, dos pasadas, verificador).
    // Cualquier fallo no autoriza AUTO: el resultado queda con semantic_unavailable y HUMAN_REVIEW.
    const literalTexts = [...new Set(finalVisualStudiesOf(consensus, judgement).map((visual) => visual.literalText))];
    let primary: SemanticPrimaryInput;
    try {
      if (activeCatalog(catalog).length === 0) throw new Error("el catálogo activo está vacío");
      const batch = await deps.shadowMatch({ queries: literalTexts.map((literalText) => ({ literalText })), catalog, context: signal.context });
      primary = { batch };
    } catch (error) {
      primary = { error: error instanceof Error ? error.message : String(error) };
    }
    return assembleAnalysis({ consensus, judgement, catalog, document, primary, semanticAuto: autoEnabled, handwrittenShadow });
  }

  // Segunda capa: solo los textos que el matcher exacto/alias deja UNMATCHED, todos en UNA sola llamada.
  // Si el matcher exacto resuelve todo, no se llama a GPT.
  const exact = new ExactAliasCatalogResolver(catalog);
  const unmatchedStudies = finalVisualStudiesOf(consensus, judgement).filter(
    (visual) => exact.resolve(observationFor(visual.literalText)).status === "UNMATCHED"
  );
  const queries = [...new Map(unmatchedStudies.map((visual) => [visual.literalText, { literalText: visual.literalText, normalizedName: visual.normalizedName }])).values()];
  const semantic = queries.length > 0 ? await deps.resolveSemantic({ queries, catalog }) : undefined;

  return assembleAnalysis({ consensus, judgement, catalog, semantic, document });
}
