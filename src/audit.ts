import { createHash, randomUUID } from "node:crypto";
import type { AnalysisResult } from "./analyze.js";
import type { AiCallEvent } from "./cache.js";
import type { QuoteBeginResult, QuoteCloseInput, QuoteCloseResult, QuoteReadResult, ItemResult } from "./quote-session.js";
import type { ReplyGuardRequest } from "./reply-guard.js";
import type { CatalogStudy } from "./types.js";
import type { IncomingImage, QuoteResult } from "./whatsapp-quote.js";

// Versión del contrato de lo que se persiste. Las filas anteriores a la telemetría (Fase 6) no la tienen (NULL = versión 1, sin telemetría).
export const AUDIT_SCHEMA_VERSION = 2;

// Lease de una ejecución: propietario único + generación (fence). Toda escritura de una corrida con lease los presenta; si otra ejecución reclamó el lease
// (o el recuperador cerró la corrida) la generación ya no coincide y la base rechaza la escritura (PT410 -> AuditWriteError LEASE_LOST).
export interface AuditLease {
  owner: string;
  fence: number;
}

//   claimed    esta ejecución posee el lease (takeover = lo reclamó de una ejecución anterior cuyo lease había vencido, sin envío reservado).
//   duplicate  NO se procesa: BUSY (otra ejecución con lease vigente), IN_DOUBT (hay o pudo haber un envío en curso: nunca se reabre),
//              FINISHED (ya terminó), EXHAUSTED (demasiados intentos; lo cierra el recuperador) o HUMAN_PAUSED (atención humana activa para el contacto).
//   seq        (solo en modo turnos) número del turno dentro de su contacto, en orden de llegada a la base.
export type AuditClaim =
  | { kind: "claimed"; runId: string; lease: AuditLease; takeover: boolean; seq?: number }
  | { kind: "duplicate"; processingStatus: string; reason?: "BUSY" | "IN_DOUBT" | "FINISHED" | "EXHAUSTED" | "HUMAN_PAUSED" };

export type ReplyAuditState = "ACCEPTED" | "UNKNOWN";

// Referencia a un registro de conocimiento APROBADO que respalda la respuesta de un turno (sin texto de pacientes ni de respuestas).
export interface FactRefRecord {
  kind: "SAMPLE" | "TURNAROUND";
  labTestId: string;
  version: number;
  contentHash: string;
}
export interface KnowledgeRefRecord {
  kind: string;
  key: string;
  version: number;
  contentHash: string;
}

// Turnos conversacionales (G2.0, migración 6): un turno es un mensaje entrante de un contacto y ES una corrida de auditoría.
//   TurnKind     tipo del mensaje entrante.
//   StalePolicy  qué hacer con la respuesta de un turno cuando un turno MÁS NUEVO del mismo contacto ya reservó o envió la suya:
//                NONE = se envía igual (p. ej. una cotización nunca se descarta en silencio); NEWER_TURN = se descarta (llegaría después de la nueva).
export type TurnKind = "IMAGE" | "TEXT" | "OTHER";
export type StalePolicy = "NONE" | "NEWER_TURN";

// Resultado de pedir autorización para llamar a Kapso. SOLO "reserved" autoriza el envío; cualquier otro resultado (o un error) significa NO enviar.
// busy y superseded solo existen en modo turnos: busy = otro envío del mismo contacto está en vuelo (esperar y reintentar); superseded = respuesta obsoleta (descartada).
// limited (G3.2, solo con la guarda de respuestas): tope de respuestas por contacto o sospecha de bucle; la respuesta se descarta y la corrida queda cerrada con su motivo.
export type SendReservation = "reserved" | "blocked" | "lost" | "busy" | "superseded" | "limited";
// Comprobación final antes de llamar a Kapso: "proceed" es la única que permite enviar.
export type SendConfirmation = "proceed" | "blocked" | "lost";
export type SendableResult = Exclude<QuoteResult, "ignored"> | "conversation";

export interface AuditRepository {
  // contactKey (HMAC del contacto, ver human-control.ts) activa el control de atención humana: un contacto pausado no se procesa.
  // turnKind (exige contactKey) reclama el mensaje como TURNO del contacto (plusmedik_turn_claim): además de lo anterior le asigna su número de secuencia.
  claim(image: Pick<IncomingImage, "messageId" | "mediaId">, options?: { contactKey?: string; turnKind?: TurnKind }): Promise<AuditClaim>;
  // false = el lease se perdió (otra ejecución lo reclamó o el recuperador cerró la corrida). Un fallo de red NO es "perdido": lanza.
  renewLease(runId: string, lease: AuditLease): Promise<boolean>;
  // NO_REPLY (turno sin respuesta por diseño) y IMAGE_SIZE son cierres finales; IMAGE_TYPE sigue con un aviso que debe reservarse.
  recordIgnored(runId: string, reason: "IMAGE_SIZE" | "IMAGE_TYPE" | "NO_REPLY", lease: AuditLease): Promise<void>;
  // TODAS las evidencias del procesamiento (resumen del análisis, estudios, llamadas de IA y verificaciones) en UNA transacción idempotente (ver AuditWriteError).
  recordEvidence(runId: string, evidence: AnalysisEvidence, lease: AuditLease): Promise<void>;
  recordFailure(runId: string, errorCode: AuditErrorCode, lease: AuditLease): Promise<void>;
  // Reserva de envío bajo bloqueo de fila: debe concederse ANTES de llamar a Kapso y es la comprobación de pausa (ver block_send en la migración).
  // options.stale (modo turnos) usa plusmedik_turn_reserve_send: además un solo envío en vuelo por contacto y el descarte de respuestas obsoletas.
  // options.guard (G3.2) usa plusmedik_turn_reserve_send_guarded: además el tope por contacto y ventana y las señales de bucle, atómicos con la reserva.
  reserveSend(runId: string, kind: SendableResult, lease: AuditLease, options?: { stale: StalePolicy; guard?: ReplyGuardRequest }): Promise<SendReservation>;
  // Comprobación final, lo más cerca posible de la llamada a Kapso: si el contacto se pausó, la reserva (aún sin usar) se libera. No elimina la carrera residual
  // entre esta respuesta y la llamada externa.
  confirmSend(runId: string, lease: AuditLease): Promise<SendConfirmation>;
  // Modo turnos: desiste de esperar un envío en vuelo (BUSY_TIMEOUT). Vence el lease del turno y lo marca para atención, de modo que un reenvío del mensaje pueda
  // reclamarlo de nuevo; NUNCA envía, reserva ni cierra nada. Opcional: un repositorio que no lo implemente deja el comportamiento anterior (el lease vence solo).
  releaseTurn?(runId: string, reason: "BUSY_TIMEOUT", lease: AuditLease): Promise<void>;
  // Modo turnos: registra, ANTES de reservar el envío, qué versiones aprobadas de conocimiento respaldan la respuesta. 'closed' = ya no se puede (el envío se reservó o el turno se
  // cerró). Opcional: sin él, una respuesta basada en conocimiento no se puede enviar (no hay rastro).
  recordKnowledgeRefs?(runId: string, refs: readonly KnowledgeRefRecord[], lease: AuditLease): Promise<"recorded" | "closed">;
  // G4.1 (migración 12): lo mismo para los datos por estudio aprobados (tipo de muestra / requisitos y plazo de entrega). Opcional: sin él, una respuesta con esos datos no se puede enviar.
  recordFactRefs?(runId: string, refs: readonly FactRefRecord[], lease: AuditLease): Promise<"recorded" | "closed">;
  // G4.1: ids (sin precios) de los estudios de la última cotización entregada al contacto del turno, si es más nueva que maxAgeSeconds. Solo lectura, con owner + fence.
  quoteLastStudies?(runId: string, lease: AuditLease, maxAgeSeconds: number): Promise<string[]>;
  // Sesiones de cotización (G4.0, migración 11). Opcionales: sin ellos el modo sesiones no puede funcionar (falla cerrado). Todas con owner + fence e idempotentes por corrida.
  quoteBegin?(runId: string, lease: AuditLease, input: { kind: "IMAGE" | "TEXT"; imageHash?: string; result?: ItemResult; ttlSeconds: number; maxItems: number }): Promise<QuoteBeginResult>;
  quoteFinish?(runId: string, lease: AuditLease, result: ItemResult): Promise<void>;
  quoteRead?(runId: string, lease: AuditLease): Promise<QuoteReadResult>;
  quoteClose?(runId: string, lease: AuditLease, input: QuoteCloseInput): Promise<QuoteCloseResult>;
  recordReply(runId: string, reply: { state: ReplyAuditState; result: SendableResult; processingStatus: "COMPLETED" | "FAILED"; providerMessageId?: string }, lease: AuditLease): Promise<void>;
}

export interface RecoverySummary {
  sendOutcomeUnknown: number;
  abandonedBeforeSend: number;
}

// Operaciones de mantenimiento (no forman parte del flujo de un mensaje).
export interface AuditMaintenance {
  // Cierra de forma segura lo interrumpido. NUNCA envía ni reintenta envíos.
  recoverStale(options?: { reservedGraceSeconds?: number; abandonGraceSeconds?: number; limit?: number }): Promise<RecoverySummary>;
  // Preparación para una intervención humana: impide una respuesta pendiente si todavía no se reservó el envío.
  blockSend(messageId: string, reason: string): Promise<"blocked" | "too_late" | "not_found" | "closed" | "unsupported">;
}

export type AuditErrorCode =
  | "MEDIA_DOWNLOAD_FAILED"
  | "CATALOG_LOAD_FAILED"
  | "AI_PROCESSING_FAILED"
  | "UNEXPECTED_PROCESSING_FAILED";

// Etapa del procesamiento en la que se lanzó el error. La clasificación depende de DÓNDE falló el flujo (estructura conocida por el código que lo ejecuta),
// nunca del texto del mensaje, que es arbitrario y puede traer datos sensibles. El detalle de un fallo de IA queda por llamada (model_calls.error_kind).
export type ProcessingPhase = "MEDIA_DOWNLOAD" | "CATALOG_LOAD" | "AI_ANALYSIS" | "OTHER";

const FAILURE_CODE_BY_PHASE: Record<ProcessingPhase, AuditErrorCode> = {
  MEDIA_DOWNLOAD: "MEDIA_DOWNLOAD_FAILED",
  CATALOG_LOAD: "CATALOG_LOAD_FAILED",
  AI_ANALYSIS: "AI_PROCESSING_FAILED",
  OTHER: "UNEXPECTED_PROCESSING_FAILED"
};

export function processingFailureCode(phase: ProcessingPhase): AuditErrorCode {
  return FAILURE_CODE_BY_PHASE[phase];
}

// Huella del catálogo con el que se analizó (identidad, aliases, precios y estado). Se calcula sobre lo ya cargado: no hay lecturas ni llamadas adicionales.
export interface CatalogFingerprint {
  hash: string;
  size: number;
}

// Lo que se confirma en una sola transacción. Sin `analysis` (el análisis falló) solo se registran las llamadas de IA que sí ocurrieron.
export interface AnalysisEvidence {
  analysis?: AnalysisResult;
  aiCalls: readonly AiCallEvent[];
  catalog?: CatalogFingerprint;
}

// Fallo de una escritura que debe ser transaccional. Solo lleva un código (nunca texto del servidor ni del contenido).
//   REJECTED         el servidor rechazó el contenido (HTTP 4xx): no se reintenta, no hay nada confirmado.
//   CONFLICT         ya había evidencia confirmada con OTRO contenido (HTTP 409): lo confirmado no se modifica.
//   UNKNOWN_OUTCOME  no se supo si se confirmó (timeout, red caída, 5xx) tras agotar los reintentos idénticos: puede haberse confirmado o no.
//   LEASE_LOST       la ejecución ya no posee el lease (HTTP 410): no debe escribir ni enviar nada más.
export type AuditWriteErrorKind = "REJECTED" | "CONFLICT" | "UNKNOWN_OUTCOME" | "LEASE_LOST";
export class AuditWriteError extends Error {
  constructor(readonly kind: AuditWriteErrorKind, readonly httpStatus?: number) {
    super(`audit_write_${kind.toLowerCase()}`);
    this.name = "AuditWriteError";
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function catalogFingerprint(catalog: readonly CatalogStudy[]): CatalogFingerprint {
  const rows = [...catalog]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((study) => [study.id, study.code, study.name, study.normalizedName, [...study.normalizedAliases].sort(), study.priceBs, study.active, study.category ?? null, study.sampleType ?? null]);
  return { hash: sha256(JSON.stringify(rows)), size: catalog.length };
}

export type AuditFlags = Record<string, string | number | boolean>;

// Solo banderas funcionales con nombre y valor cortos y simples: nunca se copia un valor arbitrario (por ejemplo, un secreto) al registro.
const FLAG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FLAG_TEXT = /^[A-Za-z0-9_.-]{1,32}$/;
const SENSITIVE_FLAG_KEY = /key|secret|token|password|credential|auth/i;
export function sanitizeFlags(flags: Record<string, unknown> | undefined): AuditFlags {
  const clean: AuditFlags = {};
  for (const key of Object.keys(flags ?? {}).sort()) {
    const value = flags![key];
    if (!FLAG_KEY.test(key) || SENSITIVE_FLAG_KEY.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && FLAG_TEXT.test(value))) clean[key] = value;
  }
  return clean;
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

// Hash de la configuración que produjo el análisis: versión del motor, versión del contrato de auditoría, banderas y, de las llamadas OBSERVADAS, etapa,
// proveedor, modelo y parámetros (esquema de salida y razonamiento). Un procesamiento que ejecutó otras etapas (por ejemplo, con juez) tiene otro hash.
export function computeConfigHash(input: { engineVersion?: string | null; flags: AuditFlags; events: readonly AiCallEvent[] }): string {
  const stages = [...new Set(input.events.map((event) => [event.label, event.provider, event.model, event.paramsHash ?? "unknown"].join("|")))].sort();
  return sha256(JSON.stringify({ engine: input.engineVersion ?? "unknown", auditSchema: AUDIT_SCHEMA_VERSION, flags: input.flags, stages }));
}

type Json = Record<string, unknown> | unknown[];

export interface SupabaseAuditOptions {
  baseUrl?: string;
  serviceKey?: string;
  fetchFn?: typeof fetch;
  // Identifica qué produjo cada análisis. engineVersion por defecto: VERCEL_GIT_COMMIT_SHA (desconocida si no existe, p. ej. fuera de Vercel).
  runtime?: { engineVersion?: string; flags?: Record<string, unknown> };
  // Cada petición a Supabase se corta a los requestTimeoutMs (por defecto 5 s). Las escrituras transaccionales se repiten UNA vez, idénticas, si no se
  // supo su resultado; retryDelayMs es la espera entre ambos intentos.
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  // Duración del lease al reclamar un mensaje y de la reserva de envío (segundos). Por defecto 120. La seguridad NO depende de estos plazos (ver reserva).
  leaseSeconds?: number;
  sendLeaseSeconds?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function enumValues(value: unknown, key: string): string[] {
  return [...new Set((Array.isArray(value) ? value : []).flatMap((item) => {
    const candidate = asRecord(item)[key];
    return typeof candidate === "string" ? [candidate] : [];
  }))].sort();
}

// Convierte las respuestas ya parseadas de los modelos a un resumen permitido. Nunca devuelve texto, notas, prompts, razones libres o payloads.
export function safeModelReading(label: string, value: unknown): Json {
  const row = asRecord(value);
  if (label === "gemini-openrouter" || label === "gemini-aistudio" || label === "openai-reader") {
    const requested = Array.isArray(row.requestedStudies) ? row.requestedStudies : [];
    const uncertain = Array.isArray(row.uncertainStudies) ? row.uncertainStudies : [];
    return {
      kind: "READER",
      requestedCount: requested.length,
      uncertainCount: uncertain.length,
      evidence: enumValues(requested, "evidence"),
      confidence: enumValues(requested, "confidence")
    };
  }
  if (label === "openai-judge") {
    const decisions = Array.isArray(row.decisions) ? row.decisions : [];
    return { kind: "JUDGE", decisionCount: decisions.length, verdicts: enumValues(decisions, "verdict") };
  }
  if (label.startsWith("openai-document")) {
    const signal = asRecord(row.signal);
    return {
      kind: "DOCUMENT",
      documentType: typeof signal.documentType === "string" ? signal.documentType : undefined,
      completeDocumentVisible: typeof signal.completeDocumentVisible === "boolean" ? signal.completeDocumentVisible : undefined,
      callCount: finite(row.calls),
      cacheHits: finite(row.cacheHits)
    };
  }
  if (label.includes("catalog")) {
    const decisions = Array.isArray(row.decisions) ? row.decisions : [];
    return { kind: "CATALOG", decisionCount: decisions.length, outcomes: enumValues(decisions, "kind") };
  }
  return { kind: "OTHER", available: value !== undefined };
}

function documentSummary(analysis: AnalysisResult): Json {
  const document = analysis.internal?.document;
  return {
    type: document?.type ?? analysis.document?.documentType,
    complete: document?.complete ?? analysis.document?.completeDocumentVisible,
    issueKinds: document?.issueKinds ?? analysis.document?.integrityKinds ?? [],
    zoneKinds: document?.zones.map((zone) => zone.kind) ?? [],
    functionVerdict: document?.function?.verdict ?? analysis.document?.function?.verdict,
    impactAvailable: document?.impact?.available,
    impactQualifierRisk: document?.impact?.qualifierRisk
  };
}

// Código del catálogo: informativo y de texto corto, sin caracteres de control (la base lo exige). Se recorta, no se inventa.
const catalogCode = (code: string | null | undefined): string | null => (typeof code === "string" ? code.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64) : null);

function serializeStudies(analysis: AnalysisResult): Json[] {
  const internal = analysis.internal;
  if (!internal) return [];
  const pending = new Map(internal.pending.filter((item) => item.kind === "STUDY").map((item) => [item.key, item]));
  const quotedById = new Map(internal.quoted.lines.map((line) => [line.id, line]));
  return internal.studies.map((study, studyIndex) => {
    const pendingItem = pending.get(study.key);
    const quotedLines = study.lineIds.flatMap((id) => {
      const line = quotedById.get(id);
      return line ? [{ labTestId: line.id, code: catalogCode(line.code), priceBs: line.priceBs, basis: line.basis }] : [];
    });
    return {
      study_index: studyIndex,
      decision: study.decision,
      blockers: study.blockers,
      catalog_match_status: analysis.matches[studyIndex]?.status ?? null,
      quoted_lines: quotedLines,
      candidate_codes: pendingItem?.candidates?.map((candidate) => ({ id: candidate.id, code: catalogCode(candidate.code), priceBs: candidate.priceBs })) ?? [],
      risk_class: study.risk?.class ?? null
    };
  });
}

function safeChecks(analysis: AnalysisResult): Json[] {
  const internal = analysis.internal;
  return [
    {
      check_kind: "DOCUMENT",
      check_status: internal?.document.complete ? "PASS" : "REVIEW",
      summary: documentSummary(analysis)
    },
    {
      check_kind: "JUDGE",
      check_status: analysis.unresolvedDisputes.length === 0 ? "PASS" : "REVIEW",
      summary: {
        confirmed: analysis.judgeResolved.filter((item) => item.verdict === "confirmed").length,
        rejected: analysis.judgeResolved.filter((item) => item.verdict === "rejected").length,
        unresolved: analysis.unresolvedDisputes.length
      }
    },
    {
      check_kind: "CATALOG",
      check_status: (internal?.pending.length ?? 0) === 0 ? "PASS" : "REVIEW",
      summary: {
        quotedCount: internal?.quoted.lines.length ?? 0,
        pendingCount: internal?.pending.length ?? 0,
        recipeStops: internal?.recipeStops ?? []
      }
    }
  ];
}

const nonNegativeInt = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
const positiveInt = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null);
const shortCode = (value: unknown, pattern: RegExp): string | null => (typeof value === "string" && pattern.test(value) ? value : null);
const iso = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

// Todas las filas llevan las MISMAS claves (PostgREST lo exige en un lote). Lo que no se midió queda NULL (desconocido), nunca un valor inventado.
// Un cache hit no consumió tokens ni costo en este procesamiento: el uso guardado en la caché es de una ejecución anterior y no se persiste.
function serializeAiCalls(events: readonly AiCallEvent[]): Json[] {
  return events.map((event) => ({
    stage: event.label,
    provider: event.provider,
    model: event.model,
    outcome: event.outcome,
    cache_hit: event.cacheHit,
    input_tokens: event.cacheHit ? null : event.usage?.inputTokens ?? null,
    output_tokens: event.cacheHit ? null : event.usage?.outputTokens ?? null,
    reasoning_tokens: event.cacheHit ? null : event.usage?.reasoningTokens ?? null,
    cost_usd: event.cacheHit ? null : event.usage?.costUsd ?? null,
    cost_status: event.cacheHit ? "NO_PROVIDER_CALL" : event.usage?.costUsd !== undefined ? "PROVIDER_REPORTED" : event.usage ? "TOKENS_ONLY" : "UNAVAILABLE",
    safe_reading: safeModelReading(event.label, event.value),
    call_seq: positiveInt(event.callSeq),
    completion_seq: positiveInt(event.completionSeq),
    attempt: positiveInt(event.attempt),
    started_at: iso(event.startedAt),
    duration_ms: nonNegativeInt(event.durationMs),
    reasoning_effort: shortCode(event.reasoningEffort, /^[A-Za-z_.]{1,32}$/),
    params_hash: shortCode(event.paramsHash, /^[0-9a-f]{64}$/),
    error_kind: shortCode(event.errorKind, /^[A-Z_]{1,24}$/)
  }));
}

export const EVIDENCE_CONTRACT = 1;

// Contenido de la RPC plusmedik_audit_record_evidence. Se construye UNA vez: un reintento envía exactamente los mismos bytes (la base reconoce el hash).
// Devuelve undefined si no hay nada que registrar (sin análisis y sin llamadas de IA).
export function buildEvidencePayload(evidence: AnalysisEvidence, runtime: { engineVersion: string | null; flags: AuditFlags }): Json | undefined {
  const { analysis, aiCalls, catalog } = evidence;
  if (!analysis && aiCalls.length === 0) return undefined;
  const run: Record<string, unknown> = {};
  if (analysis) {
    const internal = analysis.internal;
    Object.assign(run, {
      analysis_decision: analysis.decision,
      analysis_outcome: analysis.outcome ?? analysis.decision,
      review_required: internal?.reviewRequired ?? analysis.decision === "HUMAN_REVIEW",
      recipe_stops: internal?.recipeStops ?? analysis.reasons,
      document_summary: documentSummary(analysis)
    });
    if (catalog) Object.assign(run, { catalog_hash: catalog.hash, catalog_size: catalog.size });
  }
  if (aiCalls.length > 0) run.config_hash = computeConfigHash({ engineVersion: runtime.engineVersion, flags: runtime.flags, events: aiCalls });
  return {
    contract: EVIDENCE_CONTRACT,
    run,
    studies: analysis ? serializeStudies(analysis) : [],
    model_calls: serializeAiCalls(aiCalls),
    checks: analysis ? safeChecks(analysis) : []
  };
}

export interface SupabaseRpcOptions {
  baseUrl?: string;
  serviceKey?: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}

// Cliente mínimo de las funciones RPC de Supabase (PostgREST), compartido por la auditoría y el control de atención. Solo hace POST a /rest/v1/rpc/<nombre>.
export function createSupabaseRpc(options: SupabaseRpcOptions = {}): (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("Supabase audit configuration is required");
  const fetchFn = options.fetchFn ?? fetch;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 300;

  // Llamada a una función transaccional e IDEMPOTENTE de la base. El cuerpo se serializa una vez: si una petición termina sin respuesta (timeout, red caída,
  // 5xx) no se sabe si la transacción se confirmó; se repite UNA vez con exactamente el mismo contenido (todas las funciones usadas aquí responden igual ante
  // el mismo contenido y el mismo owner/fence). Si tampoco hay respuesta, el resultado queda DESCONOCIDO (UNKNOWN_OUTCOME): no se reintenta más. Nunca se lee
  // ni se propaga el cuerpo de un error del servidor. 410 = lease perdido (no se reintenta), 409 = conflicto, otros 4xx = rechazo.
  return async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(args);
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetchFn(`${baseUrl}/rest/v1/rpc/${name}`, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        response = undefined; // timeout o fallo de red: puede haberse confirmado
      }
      if (response?.ok) {
        const result = (await response.json().catch(() => undefined)) as unknown;
        return typeof result === "object" && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
      }
      if (response && response.status === 410) throw new AuditWriteError("LEASE_LOST", 410);
      if (response && response.status === 409) throw new AuditWriteError("CONFLICT", 409);
      if (response && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new AuditWriteError("REJECTED", response.status);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    throw new AuditWriteError("UNKNOWN_OUTCOME");
  };
}

export function createSupabaseAuditRepository(options: SupabaseAuditOptions = {}): AuditRepository & AuditMaintenance {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("Supabase audit configuration is required");
  const fetchFn = options.fetchFn ?? fetch;
  const flags = sanitizeFlags(options.runtime?.flags);
  const rawEngineVersion = options.runtime?.engineVersion ?? process.env.VERCEL_GIT_COMMIT_SHA;
  const engineVersion = rawEngineVersion && COMMIT_SHA.test(rawEngineVersion) ? rawEngineVersion.toLowerCase() : null;
  const rpc = createSupabaseRpc({ baseUrl, serviceKey, fetchFn, requestTimeoutMs: options.requestTimeoutMs, retryDelayMs: options.retryDelayMs });
  const leaseSeconds = options.leaseSeconds ?? 120;
  const sendLeaseSeconds = options.sendLeaseSeconds ?? 120;

  const leaseArgs = (runId: string, lease: AuditLease) => ({ p_run_id: runId, p_owner: lease.owner, p_fence: lease.fence });
  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

  return {
    async claim(image, claimOptions) {
      // Cada ejecución tiene su propio propietario. La reclamación es atómica en la base (inserta, reconoce un duplicado o reclama un lease vencido).
      const owner = randomUUID();
      const turnKind = claimOptions?.turnKind;
      // Un turno exige la clave del contacto (la secuencia es por contacto): sin ella no se llama a la base.
      if (turnKind && !claimOptions?.contactKey) throw new AuditWriteError("REJECTED");
      const result = await rpc(turnKind ? "plusmedik_turn_claim" : "plusmedik_audit_claim_run", {
        p_message_id: image.messageId,
        p_media_id: image.mediaId ?? null,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
        p_schema_version: AUDIT_SCHEMA_VERSION,
        p_engine_version: engineVersion,
        p_flags: flags,
        ...(claimOptions?.contactKey ? { p_contact_key: claimOptions.contactKey } : {}),
        ...(turnKind ? { p_turn_kind: turnKind } : {})
      });
      const outcome = str(result.outcome);
      if (outcome === "paused") return { kind: "duplicate", processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" };
      if ((outcome === "claimed" || outcome === "taken_over") && str(result.run_id) && typeof result.fence === "number") {
        return {
          kind: "claimed",
          runId: str(result.run_id)!,
          lease: { owner, fence: result.fence },
          takeover: outcome === "taken_over",
          ...(typeof result.seq === "number" ? { seq: result.seq } : {})
        };
      }
      const reasons = { busy: "BUSY", in_doubt: "IN_DOUBT", finished: "FINISHED", exhausted: "EXHAUSTED" } as const;
      return { kind: "duplicate", processingStatus: str(result.status) ?? "UNKNOWN", reason: reasons[outcome as keyof typeof reasons] };
    },
    async renewLease(runId, lease) {
      try {
        await rpc("plusmedik_audit_renew_lease", { ...leaseArgs(runId, lease), p_lease_seconds: leaseSeconds });
        return true;
      } catch (error) {
        if (error instanceof AuditWriteError && error.kind === "LEASE_LOST") return false;
        throw error;
      }
    },
    async recordIgnored(runId, reason, lease) {
      // Imagen demasiado grande o vacía: no habrá respuesta (cierre final). Tipo no soportado: se cierra el análisis y sigue un aviso, que debe reservarse.
      // Un turno que no genera respuesta (NO_REPLY) también es un cierre final.
      await rpc("plusmedik_audit_fenced_close", { ...leaseArgs(runId, lease), p_close: { status: "IGNORED", error_code: reason, final: reason === "IMAGE_SIZE" || reason === "NO_REPLY" } });
    },
    async recordEvidence(runId, evidence, lease) {
      const payload = buildEvidencePayload(evidence, { engineVersion, flags });
      if (payload) await rpc("plusmedik_audit_fenced_record_evidence", { ...leaseArgs(runId, lease), p_payload: payload });
    },
    async recordFailure(runId, errorCode, lease) {
      await rpc("plusmedik_audit_fenced_close", { ...leaseArgs(runId, lease), p_close: { status: "FAILED", error_code: errorCode, final: false } });
    },
    async reserveSend(runId, kind, lease, reserveOptions) {
      try {
        // Modo turnos: la función de turnos envuelve a la de siempre (misma pausa humana y mismo fencing) y agrega 'busy' y 'superseded'.
        const turnArgs = { ...leaseArgs(runId, lease), p_kind: kind, p_lease_seconds: sendLeaseSeconds, p_stale_policy: reserveOptions?.stale };
        const result = reserveOptions?.guard
          ? await rpc("plusmedik_turn_reserve_send_guarded", { ...turnArgs, p_guard: { ...reserveOptions.guard.config, ...(reserveOptions.guard.signature ? { signature: reserveOptions.guard.signature } : {}) } })
          : reserveOptions
            ? await rpc("plusmedik_turn_reserve_send", turnArgs)
            : await rpc("plusmedik_audit_reserve_send", { ...leaseArgs(runId, lease), p_kind: kind, p_lease_seconds: sendLeaseSeconds });
        if (result.status === "reserved" || result.status === "blocked") return result.status;
        if (reserveOptions && (result.status === "busy" || result.status === "superseded")) return result.status;
        if (reserveOptions?.guard && result.status === "limited") return "limited";
        return "lost";
      } catch (error) {
        if (error instanceof AuditWriteError && error.kind === "LEASE_LOST") return "lost";
        throw error; // CONFLICT / REJECTED / UNKNOWN_OUTCOME: quien llama NO envía
      }
    },
    async confirmSend(runId, lease) {
      try {
        const result = await rpc("plusmedik_audit_confirm_send", leaseArgs(runId, lease));
        return result.status === "proceed" ? "proceed" : result.status === "blocked" ? "blocked" : "lost";
      } catch (error) {
        if (error instanceof AuditWriteError && error.kind === "LEASE_LOST") return "lost";
        throw error; // CONFLICT / REJECTED / UNKNOWN_OUTCOME: quien llama NO envía
      }
    },
    async recordReply(runId, reply, lease) {
      // Ciclo de vida + verificación REPLY en una sola transacción de la base. El envío a WhatsApp ya ocurrió y nunca se repite desde aquí.
      await rpc("plusmedik_audit_fenced_record_reply", {
        ...leaseArgs(runId, lease),
        p_reply: { state: reply.state, result: reply.result, processing_status: reply.processingStatus, ...(reply.providerMessageId ? { provider_message_id: reply.providerMessageId } : {}) }
      });
    },
    async recordKnowledgeRefs(runId, refs, lease) {
      const result = await rpc("plusmedik_turn_record_knowledge", { ...leaseArgs(runId, lease), p_refs: refs });
      return result.status === "recorded" ? "recorded" : "closed";
    },
    async quoteBegin(runId, lease, input) {
      const result = await rpc("plusmedik_quote_item_begin", {
        ...leaseArgs(runId, lease),
        p_kind: input.kind,
        p_image_hash: input.imageHash ?? null,
        p_result: input.result ?? null,
        p_ttl_seconds: input.ttlSeconds,
        p_max_items: input.maxItems
      });
      const sessionId = str(result.sessionId);
      if (!sessionId) throw new AuditWriteError("REJECTED");
      if (result.status === "full") return { status: "full", sessionId, count: Number(result.count ?? 0) };
      const itemId = str(result.itemId);
      if ((result.status !== "created" && result.status !== "exists" && result.status !== "duplicate") || !itemId) throw new AuditWriteError("REJECTED");
      return {
        status: result.status,
        itemId,
        sessionId,
        itemStatus: (str(result.itemStatus) ?? "PROCESSING") as never,
        position: Number(result.position ?? 1),
        studyIds: Array.isArray(result.studyIds) ? result.studyIds.filter((id): id is string => typeof id === "string") : [],
        unresolved: Number(result.unresolved ?? 0),
        ambiguousGroups: Number(result.ambiguousGroups ?? 0)
      };
    },
    async quoteFinish(runId, lease, result) {
      await rpc("plusmedik_quote_item_finish", { ...leaseArgs(runId, lease), p_result: result });
    },
    async quoteRead(runId, lease) {
      const result = await rpc("plusmedik_quote_session_read", leaseArgs(runId, lease));
      const state = str(result.state);
      if (state === "none") return { state: "none" };
      if (state === "pending") return { state: "pending", pending: Number(result.pending ?? 1) };
      const sessionId = str(result.sessionId);
      if (state === "ready" && sessionId && Array.isArray(result.items)) return { state: "ready", sessionId, items: result.items as never };
      if (state === "replay" && sessionId) {
        return {
          state: "replay",
          sessionId,
          outcome: str(result.outcome) as never,
          reasons: Array.isArray(result.reasons) ? result.reasons.filter((reason): reason is string => typeof reason === "string") : [],
          ...(Array.isArray(result.lines) ? { lines: result.lines as never, totalBs: Number(result.totalBs) } : {})
        };
      }
      throw new AuditWriteError("REJECTED");
    },
    async quoteClose(runId, lease, input) {
      const result = await rpc("plusmedik_quote_session_close", {
        ...leaseArgs(runId, lease),
        p_session_id: input.sessionId,
        p_outcome: input.outcome,
        p_lines: input.outcome === "QUOTED" ? input.lines : null,
        p_total: input.outcome === "QUOTED" ? input.totalBs : null,
        p_reasons: input.outcome === "NEEDS_REVIEW" ? input.reasons : null,
        p_catalog_fingerprint: input.outcome === "QUOTED" ? input.catalogFingerprint : null
      });
      const status = str(result.status);
      if (status === "closed" || status === "replayed") return { status, outcome: str(result.outcome) ?? input.outcome };
      if (status === "pending" || status === "not_open") return { status };
      throw new AuditWriteError("REJECTED");
    },
    async recordFactRefs(runId, refs, lease) {
      const result = await rpc("plusmedik_turn_record_facts", { ...leaseArgs(runId, lease), p_refs: refs });
      return result.status === "recorded" ? "recorded" : "closed";
    },
    async quoteLastStudies(runId, lease, maxAgeSeconds) {
      const result = await rpc("plusmedik_quote_last_studies", { ...leaseArgs(runId, lease), p_max_age_seconds: maxAgeSeconds });
      return Array.isArray(result.studyIds) ? result.studyIds.filter((id): id is string => typeof id === "string") : [];
    },
    async releaseTurn(runId, reason, lease) {
      await rpc("plusmedik_turn_release", { ...leaseArgs(runId, lease), p_reason: reason });
    },
    async recoverStale(recovery = {}) {
      const result = await rpc("plusmedik_audit_recover_stale", {
        p_reserved_grace_seconds: recovery.reservedGraceSeconds ?? 60,
        p_abandon_grace_seconds: recovery.abandonGraceSeconds ?? 900,
        p_limit: recovery.limit ?? 50
      });
      return { sendOutcomeUnknown: Number(result.send_outcome_unknown ?? 0), abandonedBeforeSend: Number(result.abandoned_before_send ?? 0) };
    },
    async blockSend(messageId, reason) {
      const result = await rpc("plusmedik_audit_block_send", { p_message_id: messageId, p_reason: reason });
      const status = str(result.status);
      return status === "blocked" || status === "too_late" || status === "not_found" || status === "closed" ? status : "unsupported";
    }
  };
}
