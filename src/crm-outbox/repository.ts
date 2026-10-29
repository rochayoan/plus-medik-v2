import { AuditWriteError, createSupabaseRpc, type AuditLease, type SupabaseRpcOptions } from "../audit.js";
import type { CaseKind, CrmReason } from "./payload.js";
import type { CrmResult } from "./client.js";

// Acceso a la cola de salida (funciones de la migración 13). Nada de esto toca el CRM: solo la base de PlusMedik V2.

export type OutboxState = "PENDING" | "IN_FLIGHT" | "SENT" | "DEAD";

export interface EnqueueInput {
  originRunId: string;
  kind: CaseKind;
  kapsoMessageId: string;
  reasons: readonly CrmReason[];
  cipher: string;
  hash: string;
  evidence: Record<string, unknown>;
  sessionId?: string;
  ttlSeconds: number;
  maxAttempts: number;
}
export interface EnqueueResult {
  status: "created" | "exists";
  outboxId: string;
  eventId: string;
  state: OutboxState;
  delivery?: "CREATED" | "DUPLICATE";
}
export interface ClaimedEvent {
  outboxId: string;
  eventId: string;
  cipher: string;
  attempt: number;
  fence: number;
}
export type RecordOutcome = { status: "sent"; delivery: "CREATED" | "DUPLICATE" } | { status: "retry"; afterSeconds: number } | { status: "dead"; reason: string } | { status: "already_sent" } | { status: "lost" };

export interface ReviewTargets {
  found: boolean;
  sessionReasons: string[];
  closing: { runId: string; kapsoMessageId: string };
  items: Array<{ runId: string; kapsoMessageId: string; mediaId: string | null; kind: "IMAGE" | "TEXT"; status: "AMBIGUOUS" | "UNRESOLVED" | "UNCERTAIN"; studyIds: string[]; ambiguous: string[][]; unresolved: number; reasons: string[] }>;
}

export interface OutboxRepository {
  enqueue(runId: string, lease: AuditLease, input: EnqueueInput): Promise<EnqueueResult>;
  claim(owner: string, options: { limit: number; leaseSeconds: number; outboxId?: string; force?: boolean }): Promise<ClaimedEvent[]>;
  record(outboxId: string, owner: string, fence: number, outcome: { result: CrmResult; httpStatus?: number; durationMs?: number }): Promise<RecordOutcome>;
  status(eventIds: readonly string[]): Promise<Array<{ eventId: string; state: OutboxState; delivery?: "CREATED" | "DUPLICATE"; attempts: number; lastResult?: string }>>;
  stats(): Promise<{ counts: Record<string, number>; oldestPendingSeconds?: number; deadByReason: Record<string, number> }>;
  list(options?: { status?: OutboxState; limit?: number }): Promise<Array<Record<string, unknown>>>;
  requeue(outboxId: string, actor: string): Promise<"requeued" | "not_dead" | "expired">;
  purge(): Promise<number>;
  reviewTargets(runId: string, lease: AuditLease, sessionId: string): Promise<ReviewTargets | undefined>;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function createSupabaseOutboxRepository(options: SupabaseRpcOptions = {}): OutboxRepository {
  // Perezoso: importar el módulo (o armar la configuración) no exige tener Supabase configurado.
  let call: ReturnType<typeof createSupabaseRpc> | undefined;
  const rpc: ReturnType<typeof createSupabaseRpc> = (name, args) => (call ??= createSupabaseRpc(options))(name, args);
  const leaseArgs = (runId: string, lease: AuditLease) => ({ p_run_id: runId, p_owner: lease.owner, p_fence: lease.fence });
  return {
    async enqueue(runId, lease, input) {
      const result = await rpc("plusmedik_crm_outbox_enqueue", {
        ...leaseArgs(runId, lease), p_origin_run_id: input.originRunId, p_kind: input.kind, p_kapso_message_id: input.kapsoMessageId, p_reasons: [...input.reasons], p_cipher: input.cipher,
        p_hash: input.hash, p_evidence: input.evidence, p_session_id: input.sessionId ?? null, p_ttl_seconds: input.ttlSeconds, p_max_attempts: input.maxAttempts
      });
      const outboxId = str(result.outboxId);
      const eventId = str(result.eventId);
      const state = str(result.state) as OutboxState | undefined;
      if ((result.status !== "created" && result.status !== "exists") || !outboxId || !eventId || !state) throw new AuditWriteError("REJECTED");
      const delivery = str(result.delivery);
      return { status: result.status, outboxId, eventId, state, ...(delivery === "CREATED" || delivery === "DUPLICATE" ? { delivery } : {}) };
    },
    async claim(owner, claimOptions) {
      const result = await rpc("plusmedik_crm_outbox_claim", {
        p_owner: owner, p_lease_seconds: claimOptions.leaseSeconds, p_limit: claimOptions.limit, p_outbox_id: claimOptions.outboxId ?? null, p_force: claimOptions.force ?? false
      });
      const rows = Array.isArray(result.claimed) ? (result.claimed as Array<Record<string, unknown>>) : [];
      return rows.flatMap((row) => {
        const outboxId = str(row.outboxId);
        const eventId = str(row.eventId);
        const cipher = str(row.cipher);
        return outboxId && eventId && cipher ? [{ outboxId, eventId, cipher, attempt: num(row.attempt), fence: num(row.fence) }] : [];
      });
    },
    async record(outboxId, owner, fence, outcome) {
      try {
        const result = await rpc("plusmedik_crm_outbox_record", { p_outbox_id: outboxId, p_owner: owner, p_fence: fence, p_http_status: outcome.httpStatus ?? null, p_outcome: outcome.result, p_duration_ms: outcome.durationMs ?? null });
        if (result.status === "sent") return { status: "sent", delivery: result.delivery === "DUPLICATE" ? "DUPLICATE" : "CREATED" };
        if (result.status === "retry") return { status: "retry", afterSeconds: num(result.afterSeconds) };
        if (result.status === "dead") return { status: "dead", reason: str(result.reason) ?? "UNKNOWN" };
        if (result.status === "already_sent") return { status: "already_sent" };
        throw new AuditWriteError("REJECTED");
      } catch (error) {
        // El arrendamiento ya es de otro: su resultado vale, no el nuestro.
        if (error instanceof AuditWriteError && error.kind === "LEASE_LOST") return { status: "lost" };
        throw error;
      }
    },
    async status(eventIds) {
      const result = await rpc("plusmedik_crm_outbox_status", { p_event_ids: [...eventIds] });
      const rows = Array.isArray(result.events) ? (result.events as Array<Record<string, unknown>>) : [];
      return rows.flatMap((row) => {
        const eventId = str(row.eventId);
        const state = str(row.state) as OutboxState | undefined;
        if (!eventId || !state) return [];
        const delivery = str(row.delivery);
        return [{ eventId, state, ...(delivery === "CREATED" || delivery === "DUPLICATE" ? { delivery } : {}), attempts: num(row.attempts), ...(str(row.lastResult) ? { lastResult: str(row.lastResult)! } : {}) }];
      });
    },
    async stats() {
      const result = await rpc("plusmedik_crm_outbox_stats", {});
      return {
        counts: (result.counts as Record<string, number>) ?? {}, deadByReason: (result.deadByReason as Record<string, number>) ?? {},
        ...(typeof result.oldestPendingSeconds === "number" ? { oldestPendingSeconds: result.oldestPendingSeconds } : {})
      };
    },
    async list(listOptions = {}) {
      const result = await rpc("plusmedik_crm_outbox_list", { p_status: listOptions.status ?? null, p_limit: listOptions.limit ?? 100 });
      return Array.isArray(result.items) ? (result.items as Array<Record<string, unknown>>) : [];
    },
    async requeue(outboxId, actor) {
      const result = await rpc("plusmedik_crm_outbox_requeue", { p_outbox_id: outboxId, p_actor: actor });
      return result.status === "requeued" ? "requeued" : result.status === "expired" ? "expired" : "not_dead";
    },
    async purge() {
      const result = await rpc("plusmedik_crm_outbox_purge", {});
      return num((result as Record<string, unknown>).purged);
    },
    async reviewTargets(runId, lease, sessionId) {
      const result = await rpc("plusmedik_quote_review_targets", { ...leaseArgs(runId, lease), p_session_id: sessionId });
      if (result.found !== true) return undefined;
      const closing = (result.closing ?? {}) as Record<string, unknown>;
      const items = Array.isArray(result.items) ? (result.items as Array<Record<string, unknown>>) : [];
      return {
        found: true,
        sessionReasons: Array.isArray(result.sessionReasons) ? result.sessionReasons.filter((r): r is string => typeof r === "string") : [],
        closing: { runId: str(closing.runId) ?? "", kapsoMessageId: str(closing.kapsoMessageId) ?? "" },
        items: items.map((item) => ({
          runId: str(item.runId) ?? "", kapsoMessageId: str(item.kapsoMessageId) ?? "", mediaId: str(item.mediaId) ?? null, kind: item.kind === "IMAGE" ? "IMAGE" : "TEXT",
          status: item.status as "AMBIGUOUS" | "UNRESOLVED" | "UNCERTAIN", studyIds: Array.isArray(item.studyIds) ? (item.studyIds as string[]) : [],
          ambiguous: Array.isArray(item.ambiguous) ? (item.ambiguous as string[][]) : [], unresolved: num(item.unresolved), reasons: Array.isArray(item.reasons) ? (item.reasons as string[]) : []
        }))
      };
    }
  };
}
