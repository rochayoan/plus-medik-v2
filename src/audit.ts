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
  recordAnalysis(runId: string, analysis: AnalysisResult, context?: AnalysisAuditContext): Promise<void>;
  recordAiCalls(runId: string, events: readonly AiCallEvent[]): Promise<void>;
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

export interface AnalysisAuditContext {
  catalog?: CatalogFingerprint;
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

function serializeStudies(runId: string, analysis: AnalysisResult): Json[] {
  const internal = analysis.internal;
  if (!internal) return [];
  const pending = new Map(internal.pending.filter((item) => item.kind === "STUDY").map((item) => [item.key, item]));
  const quotedById = new Map(internal.quoted.lines.map((line) => [line.id, line]));
  return internal.studies.map((study, studyIndex) => {
    const pendingItem = pending.get(study.key);
    const quotedLines = study.lineIds.flatMap((id) => {
      const line = quotedById.get(id);
      return line ? [{ labTestId: line.id, code: line.code, priceBs: line.priceBs, basis: line.basis }] : [];
    });
    return {
      run_id: runId,
      study_index: studyIndex,
      decision: study.decision,
      blockers: study.blockers,
      catalog_match_status: analysis.matches[studyIndex]?.status ?? null,
      quoted_lines: quotedLines,
      candidate_codes: pendingItem?.candidates?.map((candidate) => ({ id: candidate.id, code: candidate.code, priceBs: candidate.priceBs })) ?? [],
      risk_class: study.risk?.class ?? null
    };
  });
}

function safeChecks(runId: string, analysis: AnalysisResult): Json[] {
  const internal = analysis.internal;
  return [
    {
      run_id: runId,
      check_kind: "DOCUMENT",
      check_status: internal?.document.complete ? "PASS" : "REVIEW",
      summary: documentSummary(analysis)
    },
    {
      run_id: runId,
      check_kind: "JUDGE",
      check_status: analysis.unresolvedDisputes.length === 0 ? "PASS" : "REVIEW",
      summary: {
        confirmed: analysis.judgeResolved.filter((item) => item.verdict === "confirmed").length,
        rejected: analysis.judgeResolved.filter((item) => item.verdict === "rejected").length,
        unresolved: analysis.unresolvedDisputes.length
      }
    },
    {
      run_id: runId,
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
function serializeAiCalls(runId: string, events: readonly AiCallEvent[]): Json[] {
  return events.map((event) => ({
    run_id: runId,
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

export function createSupabaseAuditRepository(options: SupabaseAuditOptions = {}): AuditRepository {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("Supabase audit configuration is required");
  const fetchFn = options.fetchFn ?? fetch;
  const flags = sanitizeFlags(options.runtime?.flags);
  const rawEngineVersion = options.runtime?.engineVersion ?? process.env.VERCEL_GIT_COMMIT_SHA;
  const engineVersion = rawEngineVersion && COMMIT_SHA.test(rawEngineVersion) ? rawEngineVersion.toLowerCase() : null;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetchFn(`${baseUrl}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) throw new Error(`audit_http_${response.status}`);
    return response;
  }

  async function insert(table: string, rows: Json | Json[], prefer = "return=minimal"): Promise<void> {
    await request(table, { method: "POST", headers: { Prefer: prefer }, body: JSON.stringify(rows) });
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
    async recordAnalysis(runId, analysis, context) {
      const internal = analysis.internal;
      await patchRun(runId, {
        processing_status: "ANALYZED",
        catalog_hash: context?.catalog?.hash ?? null,
        catalog_size: context?.catalog?.size ?? null,
        analysis_decision: analysis.decision,
        analysis_outcome: analysis.outcome ?? analysis.decision,
        review_required: internal?.reviewRequired ?? analysis.decision === "HUMAN_REVIEW",
        recipe_stops: internal?.recipeStops ?? analysis.reasons,
        document_summary: documentSummary(analysis)
      });
      const studies = serializeStudies(runId, analysis);
      if (studies.length) await insert("plusmedik_audit_studies", studies);
      await insert("plusmedik_audit_checks", safeChecks(runId, analysis));
    },
    async recordAiCalls(runId, events) {
      const rows = serializeAiCalls(runId, events);
      if (rows.length === 0) return;
      await insert("plusmedik_audit_model_calls", rows);
      await patchRun(runId, { config_hash: computeConfigHash({ engineVersion, flags, events }) });
    },
    async recordFailure(runId, errorCode) {
      await patchRun(runId, { processing_status: "FAILED", error_code: errorCode, completed_at: new Date().toISOString() });
    },
    async recordReply(runId, reply) {
      await patchRun(runId, {
        processing_status: reply.processingStatus,
        reply_state: reply.state,
        reply_kind: reply.result,
        kapso_outbound_message_id: reply.providerMessageId ?? null,
        completed_at: new Date().toISOString()
      });
      await insert("plusmedik_audit_checks", {
        run_id: runId,
        check_kind: "REPLY",
        check_status: reply.state,
        summary: { result: reply.result, providerAccepted: reply.state === "ACCEPTED" }
      });
    }
  };
}
