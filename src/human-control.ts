import { createHmac } from "node:crypto";
import { AuditWriteError, createSupabaseRpc, type SupabaseRpcOptions } from "./audit.js";

// Control de atención humana. Reutiliza el criterio de La Fija (un mensaje SALIENTE con message.kapso.origin === "business_app" es una intervención humana)
// pero no su modelo de datos ni su lógica de restaurante, y corrige lo que ese repositorio no distingue: estados de entrega, bots propios, orígenes
// desconocidos, duplicados y eventos fuera de orden.
//
// Formato de eventos de Kapso (v2) verificado en su documentación (https://docs.kapso.ai/docs/platform/webhooks/message-events):
//   · encabezados: X-Webhook-Event (whatsapp.message.received|sent|delivered|read|failed y eventos de conversación/contacto/thread), X-Webhook-Signature,
//     X-Idempotency-Key (estable entre reintentos de UNA entrega; message.id lo comparten el envío y sus estados delivered/read/failed), X-Webhook-Batch.
//   · message.kapso.direction: "inbound" | "outbound"; message.kapso.status: received | sent | delivered | failed (+ read);
//     message.kapso.origin: cloud_api (enviado por la API de Kapso: NUESTRO bot) | business_app (WhatsApp Business) | history_sync | other_app | meta_business_agent.
//   · conversation.phone_number (puede faltar), message.to (salientes), message.timestamp (segundos epoch como texto), phone_number_id (nivel superior).
// No se documenta en qué evento llega exactamente un eco de business_app: por eso se clasifica por direction + origin + estado, no solo por el nombre del evento.

export type KapsoEventKind =
  | "PATIENT_MESSAGE" // entrante del paciente
  | "BOT_OUTBOUND" // saliente enviado por la API de Kapso (origin cloud_api): el propio bot, jamás pausa
  | "HUMAN_BUSINESS_APP" // saliente confirmado desde WhatsApp Business: intervención humana
  | "OTHER_APP_OUTBOUND" // saliente de otra app en un número compartido (no se interpreta como intervención)
  | "META_AGENT_OUTBOUND" // saliente del agente de Meta (no se interpreta como intervención)
  | "HISTORY_SYNC" // mensaje reimportado del historial: nunca es una intervención nueva
  | "UNKNOWN_ORIGIN" // saliente cuyo origen falta o no se reconoce: se registra como desconocido, sin inventar que fue humano
  | "STATUS_UPDATE" // delivered / read / failed (o un estado de entrega): nunca es una intervención
  | "NON_MESSAGE" // eventos de conversación, contacto o thread
  | "UNKNOWN_EVENT"; // sin mensaje utilizable o dirección desconocida

export interface ClassifiedKapsoEvent {
  kind: KapsoEventKind;
  messageId?: string;
  // Teléfono del contacto (paciente), solo dígitos. Puede faltar.
  contactPhone?: string;
  // Instante del mensaje (ISO) si Kapso lo informa.
  occurredAt?: string;
  origin?: string;
  eventName?: string;
}

const digits = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : "");
const STATUS_ONLY = new Set(["delivered", "read", "failed"]);
const ORIGIN_KIND: Record<string, KapsoEventKind> = {
  cloud_api: "BOT_OUTBOUND",
  business_app: "HUMAN_BUSINESS_APP",
  history_sync: "HISTORY_SYNC",
  other_app: "OTHER_APP_OUTBOUND",
  meta_business_agent: "META_AGENT_OUTBOUND"
};

function isoFromEpoch(value: unknown): string | undefined {
  const seconds = Number(typeof value === "string" || typeof value === "number" ? value : Number.NaN);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 4_102_444_800) return undefined;
  return new Date(seconds * 1000).toISOString();
}

// Clasifica UN evento de Kapso. Pura: no escribe ni registra nada.
export function classifyKapsoEvent(event: Record<string, any>, eventNameHeader?: string | null): ClassifiedKapsoEvent {
  const eventName = typeof eventNameHeader === "string" && eventNameHeader.trim() ? eventNameHeader.trim().toLowerCase() : undefined;
  if (eventName && !eventName.startsWith("whatsapp.message.")) return { kind: "NON_MESSAGE", eventName };
  const message = event?.message;
  if (typeof message !== "object" || message === null) return { kind: "UNKNOWN_EVENT", eventName };

  const kapso = typeof message.kapso === "object" && message.kapso !== null ? message.kapso : {};
  const direction = typeof kapso.direction === "string" ? kapso.direction.toLowerCase() : undefined;
  const status = typeof kapso.status === "string" ? kapso.status.toLowerCase() : undefined;
  const origin = typeof kapso.origin === "string" ? kapso.origin.toLowerCase() : undefined;
  const messageId = typeof message.id === "string" && message.id.trim() ? message.id.trim() : undefined;
  const statuses: Array<Record<string, unknown>> = Array.isArray(kapso.statuses) ? kapso.statuses : [];
  const outbound = direction === "outbound";
  const phone = digits(event?.conversation?.phone_number) || digits(outbound ? message.to : message.from);
  const occurredAt = isoFromEpoch(message.timestamp) ?? isoFromEpoch(statuses.at(-1)?.timestamp);
  const base = { messageId, contactPhone: phone || undefined, occurredAt, origin, eventName };

  // Estados de entrega/lectura/fallo: comparten message.id con el mensaje original y NO son un mensaje nuevo ni una intervención.
  const suffix = eventName?.slice("whatsapp.message.".length);
  if ((suffix && STATUS_ONLY.has(suffix)) || (!suffix && status && STATUS_ONLY.has(status))) return { kind: "STATUS_UPDATE", ...base };

  if (direction === "inbound" || (!direction && suffix === "received")) return { kind: "PATIENT_MESSAGE", ...base };
  if (!outbound) return { kind: "UNKNOWN_EVENT", ...base };
  return { kind: (origin && ORIGIN_KIND[origin]) || "UNKNOWN_ORIGIN", ...base };
}

// Un POST de Kapso puede traer un lote (type/batch/data[]) o un solo evento.
export function eventsOf(payload: Record<string, any>, batchHeader?: string | null): Record<string, any>[] {
  const isBatch = payload.batch === true || batchHeader === "true";
  return isBatch && Array.isArray(payload.data) ? payload.data : [payload];
}

// ───────────────────────────── clave estable del contacto ─────────────────────────────

export const CONTACT_KEY_VERSION = "plusmedik-contact-v1";
export const MIN_CONTACT_HMAC_KEY_LENGTH = 32;

// HMAC-SHA256 con una clave DEDICADA (PLUSMEDIK_CONTACT_HMAC_KEY, ≥ 32 caracteres), acotado al número de WhatsApp del laboratorio (KAPSO_PHONE_NUMBER_ID) y al
// teléfono del contacto en dígitos. Es estable entre conversaciones y no permite recuperar el número. Sin clave válida, sin número del laboratorio o sin
// teléfono del contacto devuelve undefined: el contacto no se puede identificar.
export function contactKeyOf(input: { hmacKey: string | undefined; labPhoneNumberId: string | undefined; contactPhone: string | null | undefined }): string | undefined {
  const phone = digits(input.contactPhone);
  const lab = (input.labPhoneNumberId ?? "").trim();
  if (!input.hmacKey || input.hmacKey.length < MIN_CONTACT_HMAC_KEY_LENGTH || !lab || !phone) return undefined;
  return createHmac("sha256", input.hmacKey).update(`${CONTACT_KEY_VERSION}|${lab}|${phone}`, "utf8").digest("hex");
}

// ───────────────────────────── estado de atención (Supabase) ─────────────────────────────

export type AttentionState = "ACTIVE" | "HUMAN_PAUSED";
export type HumanMessageOutcome = "PAUSED" | "ALREADY_PAUSED" | "STALE_IGNORED" | "DUPLICATE";

export interface HumanMessageResult {
  outcome: HumanMessageOutcome;
  revision: number;
  blockedRuns: number;
  // Carreras que no se pueden evitar (ya había un envío reservado o ya se respondió después del mensaje humano). Quedan registradas.
  lateReservedRuns: number;
  repliedAfterEventRuns: number;
}

export interface AttentionRepository {
  status(contactKey: string): Promise<{ state: AttentionState; revision: number; exists: boolean }>;
  registerHumanMessage(event: { eventKey: string; contactKey: string; occurredAt?: string }): Promise<HumanMessageResult>;
  recordEvent(event: { eventKey: string; contactKey?: string; kind: "UNKNOWN_ORIGIN" | "OTHER_APP_OUTBOUND" | "META_AGENT_OUTBOUND"; occurredAt?: string; detail?: Record<string, string> }): Promise<"RECORDED" | "DUPLICATE">;
  // Reactivación explícita (uso futuro desde un panel). Los eventos humanos anteriores a este momento ya no vuelven a pausar.
  resume(contactKey: string, reason: string, actor: string): Promise<"RESUMED" | "ALREADY_ACTIVE">;
  // Reanudación transaccional tras 10 minutos sin intervención desde WhatsApp Business.
  // Opcional para conservar compatibilidad con dobles de prueba existentes.
  resumeIfIdle?(contactKey: string): Promise<"RESUMED" | "NOT_DUE" | "ALREADY_ACTIVE" | "MANUAL_PAUSED">;
}

export const HUMAN_PAUSE_REASON = "HUMAN_WHATSAPP_BUSINESS_APP";
export const HUMAN_PAUSE_SOURCE = "kapso_business_app";

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function createAttentionRepository(options: SupabaseRpcOptions = {}): AttentionRepository {
  const rpc = createSupabaseRpc(options);
  return {
    async status(contactKey) {
      const result = await rpc("plusmedik_attention_status", { p_contact_key: contactKey });
      return { state: result.state === "HUMAN_PAUSED" ? "HUMAN_PAUSED" : "ACTIVE", revision: num(result.revision), exists: result.exists === true };
    },
    async registerHumanMessage(event) {
      const result = await rpc("plusmedik_attention_register_human_message", {
        p_event_key: event.eventKey,
        p_contact_key: event.contactKey,
        p_occurred_at: event.occurredAt ?? null,
        p_reason: HUMAN_PAUSE_REASON,
        p_source: HUMAN_PAUSE_SOURCE
      });
      const outcome = result.outcome === "PAUSED" || result.outcome === "ALREADY_PAUSED" || result.outcome === "STALE_IGNORED" || result.outcome === "duplicate" ? result.outcome : undefined;
      // Una respuesta inesperada nunca se interpreta como "pausado": se trata como fallo para que el webhook pida el reintento.
      if (!outcome) throw new AuditWriteError("REJECTED");
      return { outcome: outcome === "duplicate" ? "DUPLICATE" : outcome, revision: num(result.revision), blockedRuns: num(result.blocked_runs), lateReservedRuns: num(result.late_reserved_runs), repliedAfterEventRuns: num(result.replied_after_event_runs) };
    },
    async recordEvent(event) {
      const result = await rpc("plusmedik_attention_record_event", {
        p_event_key: event.eventKey,
        p_contact_key: event.contactKey ?? null,
        p_kind: event.kind,
        p_occurred_at: event.occurredAt ?? null,
        p_detail: event.detail ?? {}
      });
      return result.outcome === "RECORDED" ? "RECORDED" : "DUPLICATE";
    },
    async resumeIfIdle(contactKey) {
      const result = await rpc("plusmedik_attention_resume_if_idle", { p_contact_key: contactKey });
      const outcome = result?.outcome;
      if (outcome !== "RESUMED" && outcome !== "NOT_DUE" && outcome !== "ALREADY_ACTIVE" && outcome !== "MANUAL_PAUSED") throw new AuditWriteError("REJECTED");
      return outcome;
    },
    async resume(contactKey, reason, actor) {
      const result = await rpc("plusmedik_attention_resume", { p_contact_key: contactKey, p_reason: reason, p_actor: actor });
      return result.outcome === "resumed" ? "RESUMED" : "ALREADY_ACTIVE";
    }
  };
}
