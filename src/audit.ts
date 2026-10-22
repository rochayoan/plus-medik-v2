import { createHash } from "node:crypto";
import type { AnalysisResult } from "./analyze.js";
import type { AiCallEvent } from "./cache.js";
import type { CatalogStudy } from "./types.js";
import type { IncomingImage, QuoteResult } from "./whatsapp-quote.js";

// Versión del contrato de lo que se persiste. Las filas anteriores a la telemetría (Fase 6) no la tienen (NULL = versión 1, sin telemetría).
export const AUDIT_SCHEMA_VERSION = 2;

export type AuditClaim =
  | { kind: "claimed"; runId: string }
  | { kind: "duplicate"; processingStatus: string };

export type ReplyAuditState = "ACCEPTED" | "UNKNOWN";

export interface AuditRepository {
  claim(image: Pick<IncomingImage, "messageId" | "mediaId">): Promise<AuditClaim>;
  recordIgnored(runId: string, reason: "IMAGE_SIZE" | "IMAGE_TYPE"): Promise<void>;
  // TODAS las evidencias del procesamiento (resumen del análisis, estudios, llamadas de IA y verificaciones) en UNA transacción idempotente (ver AuditWriteError).
  recordEvidence(runId: string, evidence: AnalysisEvidence): Promise<void>;
  recordFailure(runId: string, errorCode: AuditErrorCode): Promise<void>;
  recordReply(runId: string, reply: { state: ReplyAuditState; result: QuoteResult; processingStatus: "COMPLETED" | "FAILED"; providerMessageId?: string }): Promise<void>;
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
export type AuditWriteErrorKind = "REJECTED" | "CONFLICT" | "UNKNOWN_OUTCOME";
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

export function createSupabaseAuditRepository(options: SupabaseAuditOptions = {}): AuditRepository {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("Supabase audit configuration is required");
  const fetchFn = options.fetchFn ?? fetch;
  const flags = sanitizeFlags(options.runtime?.flags);
  const rawEngineVersion = options.runtime?.engineVersion ?? process.env.VERCEL_GIT_COMMIT_SHA;
  const engineVersion = rawEngineVersion && COMMIT_SHA.test(rawEngineVersion) ? rawEngineVersion.toLowerCase() : null;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const timeoutMs = options.requestTimeoutMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 300;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetchFn(`${baseUrl}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`audit_http_${response.status}`);
    return response;
  }

  // Llamada a una función transaccional e IDEMPOTENTE de la base. El cuerpo se serializa una vez: si una petición termina sin respuesta (timeout, red caída,
  // 5xx) no se sabe si la transacción se confirmó; se repite UNA vez con exactamente el mismo contenido, y la base responde 'already_recorded' si ya estaba
  // confirmada. Si tampoco hay respuesta, el resultado queda DESCONOCIDO (UNKNOWN_OUTCOME): no se reintenta más y el procesamiento sigue (fail-open).
  // Nunca se lee ni se propaga el cuerpo de un error del servidor.
  async function rpc(name: string, args: Json): Promise<"recorded" | "already_recorded"> {
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
        const result = (await response.json().catch(() => undefined)) as { status?: unknown } | undefined;
        return result?.status === "already_recorded" ? "already_recorded" : "recorded";
      }
      if (response && response.status === 409) throw new AuditWriteError("CONFLICT", 409);
      if (response && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new AuditWriteError("REJECTED", response.status);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    throw new AuditWriteError("UNKNOWN_OUTCOME");
  }

  async function patchRun(runId: string, body: Json): Promise<void> {
    await request(`plusmedik_audit_runs?id=eq.${encodeURIComponent(runId)}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  return {
    async claim(image) {
      const response = await request("plusmedik_audit_runs?on_conflict=kapso_message_id", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ kapso_message_id: image.messageId, kapso_media_id: image.mediaId ?? null, processing_status: "PROCESSING", audit_schema_version: AUDIT_SCHEMA_VERSION, engine_version: engineVersion, flags })
      });
      const rows = await response.json() as Array<{ id?: unknown }>;
      const insertedId = typeof rows[0]?.id === "string" ? rows[0].id : undefined;
      if (insertedId) return { kind: "claimed", runId: insertedId };

      const duplicate = await request(`plusmedik_audit_runs?kapso_message_id=eq.${encodeURIComponent(image.messageId)}&select=processing_status&limit=1`);
      const existing = await duplicate.json() as Array<{ processing_status?: unknown }>;
      return { kind: "duplicate", processingStatus: typeof existing[0]?.processing_status === "string" ? existing[0].processing_status : "UNKNOWN" };
    },
    async recordIgnored(runId, reason) {
      await patchRun(runId, { processing_status: "IGNORED", error_code: reason, completed_at: new Date().toISOString() });
    },
    async recordEvidence(runId, evidence) {
      const payload = buildEvidencePayload(evidence, { engineVersion, flags });
      if (payload) await rpc("plusmedik_audit_record_evidence", { p_run_id: runId, p_payload: payload });
    },
    async recordFailure(runId, errorCode) {
      await patchRun(runId, { processing_status: "FAILED", error_code: errorCode, completed_at: new Date().toISOString() });
    },
    async recordReply(runId, reply) {
      // Ciclo de vida + verificación REPLY en una sola transacción de la base. El envío a WhatsApp ya ocurrió y nunca se repite desde aquí.
      await rpc("plusmedik_audit_record_reply", {
        p_run_id: runId,
        p_reply: { state: reply.state, result: reply.result, processing_status: reply.processingStatus, ...(reply.providerMessageId ? { provider_message_id: reply.providerMessageId } : {}) }
      });
    }
  };
}
