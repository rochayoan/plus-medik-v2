import type { AnalysisResult } from "./analyze.js";
import type { AiCallEvent } from "./cache.js";
import type { IncomingImage, QuoteResult } from "./whatsapp-quote.js";

export type AuditClaim =
  | { kind: "claimed"; runId: string }
  | { kind: "duplicate"; processingStatus: string };

export type ReplyAuditState = "ACCEPTED" | "UNKNOWN";

export interface AuditRepository {
  claim(image: Pick<IncomingImage, "messageId" | "mediaId">): Promise<AuditClaim>;
  recordIgnored(runId: string, reason: "IMAGE_SIZE" | "IMAGE_TYPE"): Promise<void>;
  recordAnalysis(runId: string, analysis: AnalysisResult): Promise<void>;
  recordAiCalls(runId: string, events: readonly AiCallEvent[]): Promise<void>;
  recordFailure(runId: string, errorCode: AuditErrorCode): Promise<void>;
  recordReply(runId: string, reply: { state: ReplyAuditState; result: QuoteResult; processingStatus: "COMPLETED" | "FAILED"; providerMessageId?: string }): Promise<void>;
}

export type AuditErrorCode =
  | "MEDIA_DOWNLOAD_FAILED"
  | "CATALOG_LOAD_FAILED"
  | "AI_PROCESSING_FAILED"
  | "UNEXPECTED_PROCESSING_FAILED";

export function categorizeProcessingError(error: unknown): AuditErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (/media|download|image/i.test(message)) return "MEDIA_DOWNLOAD_FAILED";
  if (/catalog|supabase|lab_tests|lab_test_aliases/i.test(message)) return "CATALOG_LOAD_FAILED";
  if (/openai|gemini|model|response|reasoning/i.test(message)) return "AI_PROCESSING_FAILED";
  return "UNEXPECTED_PROCESSING_FAILED";
}

type Json = Record<string, unknown> | unknown[];

export interface SupabaseAuditOptions {
  baseUrl?: string;
  serviceKey?: string;
  fetchFn?: typeof fetch;
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

function serializeAiCalls(runId: string, events: readonly AiCallEvent[]): Json[] {
  return events.map((event) => ({
    run_id: runId,
    stage: event.label,
    provider: event.provider,
    model: event.model,
    outcome: event.outcome,
    cache_hit: event.cacheHit,
    input_tokens: event.usage?.inputTokens ?? null,
    output_tokens: event.usage?.outputTokens ?? null,
    reasoning_tokens: event.usage?.reasoningTokens ?? null,
    cost_usd: event.cacheHit ? null : event.usage?.costUsd ?? null,
    cost_status: event.cacheHit ? "NO_PROVIDER_CALL" : event.usage?.costUsd !== undefined ? "PROVIDER_REPORTED" : event.usage ? "TOKENS_ONLY" : "UNAVAILABLE",
    safe_reading: safeModelReading(event.label, event.value)
  }));
}

export function createSupabaseAuditRepository(options: SupabaseAuditOptions = {}): AuditRepository {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error("Supabase audit configuration is required");
  const fetchFn = options.fetchFn ?? fetch;
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
        body: JSON.stringify({ kapso_message_id: image.messageId, kapso_media_id: image.mediaId ?? null, processing_status: "PROCESSING" })
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
    async recordAnalysis(runId, analysis) {
      const internal = analysis.internal;
      await patchRun(runId, {
        processing_status: "ANALYZED",
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
      if (rows.length) await insert("plusmedik_audit_model_calls", rows);
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
