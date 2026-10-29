import { AuditWriteError, createSupabaseRpc, type SupabaseRpcOptions } from "../audit.js";
import { FACT_SCHEMAS, type StudyFactKind } from "./types.js";

// ADMINISTRACIÓN de los datos por estudio: contrato de referencia de las funciones que usará el CRM (o un script de carga de borradores). NO lo importa el agente en ejecución
// (una prueba lo verifica). Las reglas (quién puede qué, cuatro ojos, caducidad, estudio activo en lab_tests) las hace cumplir la BASE; esto solo valida la forma antes de llamar.

// Quién actúa (seudónimo estable; nunca nombre, correo ni teléfono). Mismos roles que el conocimiento de G3.
export type FactActorRole = "EDITOR" | "ADMIN_APPROVER" | "CLINICAL_APPROVER" | "AI_DRAFTER";
export interface KnowledgeActor {
  id: string;
  type: "HUMAN" | "AI";
  role: FactActorRole;
}

export type StudyFactAdminErrorCode = "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INVALID" | "UNAVAILABLE";
export class StudyFactAdminError extends Error {
  constructor(readonly code: StudyFactAdminErrorCode, readonly httpStatus?: number) {
    super(`study_facts_admin_${code.toLowerCase()}`);
    this.name = "StudyFactAdminError";
  }
}

export interface FactDraftInput {
  kind: StudyFactKind;
  labTestId: string;
  payload: unknown;
  sourceRef?: string;
  validFrom?: Date | string;
  validUntil?: Date | string;
}
const iso = (value: Date | string | undefined): string | null => (value === undefined ? null : value instanceof Date ? value.toISOString() : value);

export interface StudyFactsAdminRepository {
  createDraft(input: FactDraftInput, actor: KnowledgeActor): Promise<{ factId: string; version: number }>;
  editDraft(factId: string, kind: StudyFactKind, input: Omit<FactDraftInput, "kind" | "labTestId">, actor: KnowledgeActor): Promise<void>;
  submit(factId: string, actor: KnowledgeActor): Promise<"submitted" | "already_submitted">;
  reject(factId: string, actor: KnowledgeActor, reason: string): Promise<void>;
  approve(factId: string, actor: KnowledgeActor): Promise<{ status: "approved" | "already_approved"; revision?: number }>;
  deactivate(factId: string, actor: KnowledgeActor, reason: string): Promise<{ status: "deactivated" | "already_inactive"; revision?: number }>;
  list(filter?: { status?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "INACTIVE"; limit?: number }): Promise<Record<string, unknown>[]>;
}

export function createStudyFactsAdminRepository(options: SupabaseRpcOptions = {}): StudyFactsAdminRepository {
  const rpc = createSupabaseRpc(options);
  const who = (actor: KnowledgeActor) => ({ p_actor_id: actor.id, p_actor_type: actor.type, p_actor_role: actor.role });
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await rpc(name, args);
    } catch (error) {
      if (error instanceof AuditWriteError) {
        if (error.kind === "CONFLICT") throw new StudyFactAdminError("CONFLICT", 409);
        if (error.kind === "UNKNOWN_OUTCOME") throw new StudyFactAdminError("UNAVAILABLE");
        if (error.httpStatus === 403) throw new StudyFactAdminError("FORBIDDEN", 403);
        if (error.httpStatus === 404) throw new StudyFactAdminError("NOT_FOUND", 404);
        throw new StudyFactAdminError("INVALID", error.httpStatus);
      }
      throw error;
    }
  }
  const checked = (kind: StudyFactKind, payload: unknown): unknown => {
    const parsed = FACT_SCHEMAS[kind].safeParse(payload);
    if (!parsed.success) throw new StudyFactAdminError("INVALID");
    return parsed.data;
  };
  return {
    async createDraft(input, actor) {
      const result = await call("plusmedik_study_fact_create_draft", { p_kind: input.kind, p_lab_test_id: input.labTestId, p_payload: checked(input.kind, input.payload), ...who(actor), p_source_ref: input.sourceRef ?? null, p_valid_from: iso(input.validFrom), p_valid_until: iso(input.validUntil) });
      return { factId: String(result.fact_id ?? ""), version: Number(result.version) };
    },
    async editDraft(factId, kind, input, actor) {
      await call("plusmedik_study_fact_edit_draft", { p_fact_id: factId, p_payload: checked(kind, input.payload), ...who(actor), p_source_ref: input.sourceRef ?? null, p_valid_from: iso(input.validFrom), p_valid_until: iso(input.validUntil) });
    },
    async submit(factId, actor) {
      return (await call("plusmedik_study_fact_submit", { p_fact_id: factId, ...who(actor) })).status === "already_submitted" ? "already_submitted" : "submitted";
    },
    async reject(factId, actor, reason) {
      await call("plusmedik_study_fact_reject", { p_fact_id: factId, ...who(actor), p_reason: reason });
    },
    async approve(factId, actor) {
      const result = await call("plusmedik_study_fact_approve", { p_fact_id: factId, ...who(actor) });
      return { status: result.status === "already_approved" ? "already_approved" : "approved", ...(typeof result.revision === "number" ? { revision: result.revision } : {}) };
    },
    async deactivate(factId, actor, reason) {
      const result = await call("plusmedik_study_fact_deactivate", { p_fact_id: factId, ...who(actor), p_reason: reason });
      return { status: result.status === "already_inactive" ? "already_inactive" : "deactivated", ...(typeof result.revision === "number" ? { revision: result.revision } : {}) };
    },
    async list(filter = {}) {
      const result = await call("plusmedik_study_facts_list", { p_status: filter.status ?? null, p_limit: filter.limit ?? 100 });
      return Array.isArray(result.items) ? (result.items as Record<string, unknown>[]) : [];
    }
  };
}
