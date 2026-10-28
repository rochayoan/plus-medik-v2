import { AuditWriteError, createSupabaseRpc, type SupabaseRpcOptions } from "../audit.js";
import { PAYLOAD_SCHEMAS, type KnowledgeKind } from "./types.js";

// ADMINISTRACIÓN del conocimiento: contrato de referencia de las funciones que usará el CRM (ver docs/g3/02-contrato-crm.md). NO lo importa el agente en ejecución:
// el webhook y los manejadores solo usan la lectura (store.ts / service.ts), y una prueba lo verifica. Las reglas (quién puede qué, cuatro ojos, caducidad, importes) las hace
// cumplir la BASE; este cliente solo valida la forma antes de llamar para dar errores claros.

export type ActorRole = "EDITOR" | "ADMIN_APPROVER" | "CLINICAL_APPROVER" | "AI_DRAFTER";
export interface KnowledgeActor {
  // Seudónimo estable (p. ej. "crm:<uuid>"). Nunca nombre, correo ni teléfono.
  id: string;
  type: "HUMAN" | "AI";
  role: ActorRole;
}

export type KnowledgeAdminErrorCode = "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INVALID" | "UNAVAILABLE";
export class KnowledgeAdminError extends Error {
  constructor(readonly code: KnowledgeAdminErrorCode, readonly httpStatus?: number) {
    super(`knowledge_admin_${code.toLowerCase()}`);
    this.name = "KnowledgeAdminError";
  }
}

export interface DraftInput {
  kind: KnowledgeKind;
  key: string;
  payload: unknown;
  sourceRef?: string;
  validFrom?: Date | string;
  validUntil?: Date | string;
}

const iso = (value: Date | string | undefined): string | null => (value === undefined ? null : value instanceof Date ? value.toISOString() : value);

export interface KnowledgeAdminRepository {
  createDraft(input: DraftInput, actor: KnowledgeActor): Promise<{ documentId: string; versionId: string; version: number }>;
  editDraft(versionId: string, input: Omit<DraftInput, "kind" | "key">, actor: KnowledgeActor, kind: KnowledgeKind): Promise<void>;
  submit(versionId: string, actor: KnowledgeActor): Promise<"submitted" | "already_submitted">;
  reject(versionId: string, actor: KnowledgeActor, reason: string): Promise<void>;
  approve(versionId: string, actor: KnowledgeActor): Promise<{ status: "approved" | "already_approved"; revision?: number }>;
  deactivate(versionId: string, actor: KnowledgeActor, reason: string): Promise<{ status: "deactivated" | "already_inactive"; revision?: number }>;
  restore(versionId: string, actor: KnowledgeActor, reason: string): Promise<{ status: "restored" | "already_approved"; revision?: number }>;
  history(kind: KnowledgeKind, key: string): Promise<{ versions: Record<string, unknown>[]; events: Record<string, unknown>[] }>;
  list(filter?: { status?: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "INACTIVE"; kind?: KnowledgeKind; limit?: number }): Promise<Record<string, unknown>[]>;
}

export function createKnowledgeAdminRepository(options: SupabaseRpcOptions = {}): KnowledgeAdminRepository {
  const rpc = createSupabaseRpc(options);
  const who = (actor: KnowledgeActor) => ({ p_actor_id: actor.id, p_actor_type: actor.type, p_actor_role: actor.role });
  // Una escritura sin respuesta (UNKNOWN_OUTCOME) puede haberse confirmado: antes de repetirla, consultar el historial.
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await rpc(name, args);
    } catch (error) {
      if (error instanceof AuditWriteError) {
        if (error.kind === "CONFLICT") throw new KnowledgeAdminError("CONFLICT", 409);
        if (error.kind === "UNKNOWN_OUTCOME") throw new KnowledgeAdminError("UNAVAILABLE");
        if (error.httpStatus === 403) throw new KnowledgeAdminError("FORBIDDEN", 403);
        if (error.httpStatus === 404) throw new KnowledgeAdminError("NOT_FOUND", 404);
        throw new KnowledgeAdminError("INVALID", error.httpStatus);
      }
      throw error;
    }
  }
  const checked = (kind: KnowledgeKind, payload: unknown): unknown => {
    const parsed = PAYLOAD_SCHEMAS[kind].safeParse(payload);
    if (!parsed.success) throw new KnowledgeAdminError("INVALID");
    return parsed.data;
  };
  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  return {
    async createDraft(input, actor) {
      const result = await call("plusmedik_kb_create_draft", { p_kind: input.kind, p_key: input.key, p_payload: checked(input.kind, input.payload), ...who(actor), p_source_ref: input.sourceRef ?? null, p_valid_from: iso(input.validFrom), p_valid_until: iso(input.validUntil) });
      return { documentId: str(result.document_id), versionId: str(result.version_id), version: Number(result.version) };
    },
    async editDraft(versionId, input, actor, kind) {
      await call("plusmedik_kb_edit_draft", { p_version_id: versionId, p_payload: checked(kind, input.payload), ...who(actor), p_source_ref: input.sourceRef ?? null, p_valid_from: iso(input.validFrom), p_valid_until: iso(input.validUntil) });
    },
    async submit(versionId, actor) {
      return (await call("plusmedik_kb_submit", { p_version_id: versionId, ...who(actor) })).status === "already_submitted" ? "already_submitted" : "submitted";
    },
    async reject(versionId, actor, reason) {
      await call("plusmedik_kb_reject", { p_version_id: versionId, ...who(actor), p_reason: reason });
    },
    async approve(versionId, actor) {
      const result = await call("plusmedik_kb_approve", { p_version_id: versionId, ...who(actor) });
      return { status: result.status === "already_approved" ? "already_approved" : "approved", ...(typeof result.revision === "number" ? { revision: result.revision } : {}) };
    },
    async deactivate(versionId, actor, reason) {
      const result = await call("plusmedik_kb_deactivate", { p_version_id: versionId, ...who(actor), p_reason: reason });
      return { status: result.status === "already_inactive" ? "already_inactive" : "deactivated", ...(typeof result.revision === "number" ? { revision: result.revision } : {}) };
    },
    async restore(versionId, actor, reason) {
      const result = await call("plusmedik_kb_restore", { p_version_id: versionId, ...who(actor), p_reason: reason });
      return { status: result.status === "already_approved" ? "already_approved" : "restored", ...(typeof result.revision === "number" ? { revision: result.revision } : {}) };
    },
    async history(kind, key) {
      const result = await call("plusmedik_kb_history", { p_kind: kind, p_key: key });
      return { versions: Array.isArray(result.versions) ? (result.versions as Record<string, unknown>[]) : [], events: Array.isArray(result.events) ? (result.events as Record<string, unknown>[]) : [] };
    },
    async list(filter = {}) {
      const result = await call("plusmedik_kb_list", { p_status: filter.status ?? null, p_kind: filter.kind ?? null, p_limit: filter.limit ?? 100 });
      return Array.isArray(result.items) ? (result.items as Record<string, unknown>[]) : [];
    }
  };
}
