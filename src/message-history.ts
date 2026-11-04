import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createSupabaseRpc } from "./audit.js";
import type { ClassifiedKapsoEvent } from "./human-control.js";

// Historial de TODOS los mensajes (ENCENDIDO por defecto, sin variables nuevas; PLUSMEDIK_HISTORY=off lo apaga). Guarda lo que los pacientes escriben, lo que el agente responde y lo que la recepción humana
// escribe, para conservar las conversaciones completas en Supabase y poder usarlas desde otros proyectos o auditarlas. El texto se guarda EN CLARO (columna body); si se define PLUSMEDIK_HISTORY_KEY se guarda
// CIFRADO (AES-256-GCM). NO es la memoria conversacional (src/conversation-memory.ts, contexto corto para el modelo con filtros y vencimiento de 7 días) ni la auditoría de ejecución (src/audit.ts, solo
// códigos): es un módulo aparte, con tabla y retención propias, y NUNCA influye en lo que el agente decide o responde.
//
// Qué registra (migraciones 21 y 22, supabase/migrations/20261109000000_plusmedik_message_history.sql y 20261110000000_plusmedik_message_history_plaintext.sql):
//   · entrantes del paciente (texto, y de audios e imágenes solo el tipo y el identificador del medio; la transcripción de un audio se agrega al transcribirse),
//   · respuestas del agente que Kapso ACEPTÓ para envío (estado ACCEPTED; UNCERTAIN si el envío falló sin saber si salió) con el id del mensaje al que responde y la corrida de auditoría,
//   · mensajes de la recepción humana (y de otras apps / agente de Meta) cuando Kapso los informa, sin confundirlos con los automáticos,
//   · el estado de entrega (SENT, DELIVERED, READ, FAILED) que Kapso informa después; solo avanza. Aceptado por Kapso NO significa entregado.
// Qué NO registra: respuestas canceladas (pausa humana, tope diario, obsoletas: nunca se enviaron), enlaces ni credenciales de medios, teléfonos (solo la clave HMAC del contacto), ni claves.
// Protección: RLS sin privilegios directos sobre las tablas y acceso solo por funciones de service_role; sin vencimiento por defecto (tope opcional en días); exportación con motivo y rastro. Con PLUSMEDIK_HISTORY_KEY
// (fuera de la base, distinta de las demás claves) el texto se cifra y el contacto, línea, dirección y mensaje van como dato autenticado. Ninguna falla del historial interrumpe un mensaje: se registra un código y
// la conciliación (plusmedik_history_gaps) la detecta.

// Retención: por defecto NO hay vencimiento (el historial completo se conserva en Supabase); un tope opcional, en días, la limita.
export const HISTORY_DEFAULTS = { maxRetentionDays: 3650, textChars: 4096, timeoutMs: 3000, concurrency: 4, exportPageSize: 500 } as const;
export const MIN_HISTORY_KEY_LENGTH = 32;

export type HistoryDirection = "IN" | "OUT";
export type HistoryActor = "PATIENT" | "AGENT" | "HUMAN" | "OTHER_APP" | "META_AGENT" | "UNKNOWN";
export type HistoryKind = "TEXT" | "AUDIO" | "IMAGE" | "OTHER";
export type DeliveryState = "RECEIVED" | "ACCEPTED" | "UNCERTAIN" | "SENT" | "DELIVERED" | "READ" | "FAILED";
export type DeliveryUpdate = "SENT" | "DELIVERED" | "READ" | "FAILED";

// ───────────────────────────── cifrado en reposo ─────────────────────────────

export class HistoryCipherError extends Error {
  constructor() {
    super("message_history_cipher");
    this.name = "HistoryCipherError";
  }
}
export interface CipherContext {
  accountId: string;
  contactKey: string;
  direction: HistoryDirection;
  messageId: string;
}
const keyBytes = (secret: string): Buffer => {
  if (secret.length < MIN_HISTORY_KEY_LENGTH) throw new HistoryCipherError();
  return createHash("sha256").update(`plusmedik-history-v1:${secret}`).digest();
};
// Huella corta (no reversible) de la clave: identifica con cuál se cifró cada fila, para rotarla sin perder lo anterior.
export const keyIdOf = (secret: string): string => createHash("sha256").update("plusmedik-history-key-id:").update(keyBytes(secret)).digest("hex").slice(0, 8);
const b64 = (buffer: Buffer) => buffer.toString("base64url");
const aadOf = (context: CipherContext) => Buffer.from(`plusmedik-history-v1|${context.accountId}|${context.contactKey}|${context.direction}|${context.messageId}`);

// v1.<iv>.<tag>.<texto cifrado>. Una fila cifrada no se puede pasar por la de otro contacto, línea, dirección ni mensaje.
export function sealMessage(text: string, secret: string, context: CipherContext): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(secret), iv);
  cipher.setAAD(aadOf(context));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
}

export function openMessage(sealed: string, secret: string, context: CipherContext): string {
  try {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new HistoryCipherError();
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(secret), Buffer.from(iv, "base64url"));
    decipher.setAAD(aadOf(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new HistoryCipherError();
  }
}

// ───────────────────────────── almacén (solo funciones de la base) ─────────────────────────────

export interface HistoryRow {
  accountId: string;
  contactKey: string;
  // Teléfono del contacto, solo dígitos (migración 23). contactKey sigue siendo lo que separa una conversación de otra; el teléfono solo dice de quién es.
  contactPhone?: string;
  messageId: string;
  direction: HistoryDirection;
  actor: HistoryActor;
  origin?: string;
  kind: HistoryKind;
  messageType?: string;
  // El texto, en claro (body) o cifrado (bodyCipher + keyId); nunca los dos.
  body?: string;
  bodyCipher?: string;
  keyId?: string;
  mediaRef?: string;
  state: DeliveryState;
  auditRunId?: string;
  replyTo?: string;
  occurredAt?: Date;
}

export interface ExportedRow {
  seq: number;
  contactKey: string;
  contactPhone: string | null;
  messageId: string;
  direction: HistoryDirection;
  actor: HistoryActor;
  origin: string | null;
  kind: HistoryKind;
  messageType: string | null;
  body: string | null;
  bodyCipher: string | null;
  keyId: string | null;
  mediaRef: string | null;
  state: DeliveryState;
  auditRunId: string | null;
  replyTo: string | null;
  occurredAt: string;
  deliveryAt: string | null;
}

export interface HistoryStore {
  record(row: HistoryRow): Promise<"RECORDED" | "DUPLICATE">;
  // La transcripción de un audio: en claro (body) o cifrada (bodyCipher + keyId).
  attachText(input: { accountId: string; contactKey: string; messageId: string; body?: string; bodyCipher?: string; keyId?: string }): Promise<"UPDATED" | "NOOP" | "MISSING">;
  delivery(input: { accountId: string; messageId: string; state: DeliveryUpdate; at?: Date }): Promise<"UPDATED" | "NOOP" | "MISSING">;
  exportPage(input: { reason: string; contactKey?: string; from?: Date; to?: Date; afterSeq?: number; limit?: number }): Promise<{ rows: ExportedRow[]; next?: number }>;
  erase(input: { contactKey: string; reason: string }): Promise<number>;
  purge(limit?: number): Promise<number>;
  gaps(input: { since?: Date; limit?: number }): Promise<{ inbound: string[]; outbound: string[] }>;
}

const outcomeOf = z.object({ outcome: z.string() });
const exportShape = z.object({
  rows: z.array(
    z.object({
      seq: z.number(), contact_key: z.string(), contact_phone: z.string().nullish(), message_id: z.string(), direction: z.enum(["IN", "OUT"]),
      actor: z.enum(["PATIENT", "AGENT", "HUMAN", "OTHER_APP", "META_AGENT", "UNKNOWN"]), origin: z.string().nullable(),
      content_kind: z.enum(["TEXT", "AUDIO", "IMAGE", "OTHER"]), message_type: z.string().nullable(), body: z.string().nullish(), body_cipher: z.string().nullable(), key_id: z.string().nullable(),
      media_ref: z.string().nullable(), delivery_state: z.enum(["RECEIVED", "ACCEPTED", "UNCERTAIN", "SENT", "DELIVERED", "READ", "FAILED"]),
      audit_run_id: z.string().nullable(), reply_to: z.string().nullable(), occurred_at: z.string(), delivery_at: z.string().nullable()
    })
  ),
  next_after_seq: z.number().nullable()
});
const gapsShape = z.object({ inbound_missing: z.array(z.string()), outbound_missing: z.array(z.string()) });
const deletedShape = z.object({ deleted: z.number() });

export interface SupabaseHistoryStoreOptions {
  retentionDays?: number;
  rpc?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  requestTimeoutMs?: number;
}

export function createSupabaseHistoryStore(options: SupabaseHistoryStoreOptions = {}): HistoryStore {
  let rpc = options.rpc;
  const call = (name: string, args: Record<string, unknown>) => (rpc ??= createSupabaseRpc({ requestTimeoutMs: options.requestTimeoutMs ?? HISTORY_DEFAULTS.timeoutMs, retryDelayMs: 200 }))(name, args);
  const stateOf = (result: Record<string, unknown>): "UPDATED" | "NOOP" | "MISSING" => {
    const outcome = outcomeOf.parse(result).outcome;
    return outcome === "updated" ? "UPDATED" : outcome === "noop" ? "NOOP" : "MISSING";
  };
  return {
    async record(row) {
      // Con teléfono (migración 23) se usa plusmedik_history_put; sin él (no debería pasar: el contacto se identifica por su teléfono), plusmedik_history_save.
      const result = await call(row.contactPhone ? "plusmedik_history_put" : "plusmedik_history_save", {
        p_account_id: row.accountId, p_contact_key: row.contactKey, p_message_id: row.messageId, p_direction: row.direction, p_actor: row.actor, p_origin: row.origin ?? null,
        p_content_kind: row.kind, p_message_type: row.messageType ?? null, p_body: row.body ?? null, p_body_cipher: row.bodyCipher ?? null, p_key_id: row.keyId ?? null, p_media_ref: row.mediaRef ?? null,
        p_delivery_state: row.state, p_audit_run_id: row.auditRunId ?? null, p_reply_to: row.replyTo ?? null, p_occurred_at: (row.occurredAt ?? new Date()).toISOString(),
        p_retention_days: options.retentionDays ?? null,
        ...(row.contactPhone ? { p_contact_phone: row.contactPhone } : {})
      });
      return outcomeOf.parse(result).outcome === "recorded" ? "RECORDED" : "DUPLICATE";
    },
    async attachText(input) {
      return stateOf(await call("plusmedik_history_attach", { p_account_id: input.accountId, p_contact_key: input.contactKey, p_message_id: input.messageId, p_body: input.body ?? null, p_body_cipher: input.bodyCipher ?? null, p_key_id: input.keyId ?? null }));
    },
    async delivery(input) {
      return stateOf(await call("plusmedik_history_delivery", { p_account_id: input.accountId, p_message_id: input.messageId, p_state: input.state, p_at: (input.at ?? new Date()).toISOString() }));
    },
    async exportPage(input) {
      const parsed = exportShape.parse(
        await call("plusmedik_history_export", {
          p_reason: input.reason, p_contact_key: input.contactKey ?? null, p_from: input.from?.toISOString() ?? null, p_to: input.to?.toISOString() ?? null,
          p_after_seq: input.afterSeq ?? null, p_limit: input.limit ?? HISTORY_DEFAULTS.exportPageSize
        })
      );
      return {
        rows: parsed.rows.map((row) => ({
          seq: row.seq, contactKey: row.contact_key, contactPhone: row.contact_phone ?? null, messageId: row.message_id, direction: row.direction, actor: row.actor, origin: row.origin, kind: row.content_kind, messageType: row.message_type,
          body: row.body ?? null, bodyCipher: row.body_cipher, keyId: row.key_id, mediaRef: row.media_ref, state: row.delivery_state, auditRunId: row.audit_run_id, replyTo: row.reply_to, occurredAt: row.occurred_at, deliveryAt: row.delivery_at
        })),
        ...(parsed.next_after_seq !== null ? { next: parsed.next_after_seq } : {})
      };
    },
    async erase(input) {
      return deletedShape.parse(await call("plusmedik_history_erase", { p_contact_key: input.contactKey, p_reason: input.reason })).deleted;
    },
    async purge(limit) {
      return deletedShape.parse(await call("plusmedik_history_purge", { p_limit: limit ?? null })).deleted;
    },
    async gaps(input) {
      const parsed = gapsShape.parse(await call("plusmedik_history_gaps", { p_since: input.since?.toISOString() ?? null, p_limit: input.limit ?? null }));
      return { inbound: parsed.inbound_missing, outbound: parsed.outbound_missing };
    }
  };
}

// ───────────────────────────── extracción de eventos de Kapso (pura) ─────────────────────────────

const ID = /^[A-Za-z0-9_.=:+/-]{1,255}$/;
const TYPE = /^[a-z_]{1,30}$/;
const ORIGIN = /^[a-z_]{1,40}$/;
const clip = (text: string) => Array.from(text).slice(0, HISTORY_DEFAULTS.textChars).join("");
const validId = (value: unknown): string | undefined => (typeof value === "string" && ID.test(value.trim()) ? value.trim() : undefined);

export interface WebhookEntry {
  messageId: string;
  contactPhone: string;
  direction: HistoryDirection;
  actor: HistoryActor;
  origin?: string;
  kind: HistoryKind;
  messageType?: string;
  text?: string;
  mediaRef?: string;
  state: DeliveryState;
  occurredAt?: Date;
}
export interface WebhookStatus {
  messageId: string;
  state: DeliveryUpdate;
  at?: Date;
}

// Lo que dice el nombre del evento o el estado del mensaje sobre su entrega.
export function deliveryUpdateOf(eventName: string | undefined, kapsoStatus: unknown): DeliveryUpdate | undefined {
  const words: Record<string, DeliveryUpdate> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
  const suffix = eventName?.startsWith("whatsapp.message.") ? eventName.slice("whatsapp.message.".length) : undefined;
  if (suffix && words[suffix]) return words[suffix];
  if (!suffix && typeof kapsoStatus === "string") return words[kapsoStatus.toLowerCase()];
  return undefined;
}

const ACTOR_OF: Partial<Record<ClassifiedKapsoEvent["kind"], HistoryActor>> = { HUMAN_BUSINESS_APP: "HUMAN", OTHER_APP_OUTBOUND: "OTHER_APP", META_AGENT_OUTBOUND: "META_AGENT", UNKNOWN_ORIGIN: "UNKNOWN" };

// Contenido de UN mensaje de Kapso: texto, tipo y referencia del medio. Nunca enlaces de medios.
function contentOf(message: Record<string, any>): { kind: HistoryKind; messageType: string; text?: string; mediaRef?: string } {
  const declared = typeof message.type === "string" ? message.type.toLowerCase() : message.text ? "text" : message.image ? "image" : message.audio ? "audio" : "";
  const messageType = TYPE.test(declared) ? declared : "unknown";
  const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? clip(value) : undefined);
  if (messageType === "text") {
    const body = text(message.text?.body);
    return { kind: "TEXT", messageType, ...(body ? { text: body } : {}) };
  }
  if (messageType === "image") {
    const caption = text(message.image?.caption);
    const mediaRef = validId(message.image?.id);
    return { kind: "IMAGE", messageType, ...(caption ? { text: caption } : {}), ...(mediaRef ? { mediaRef } : {}) };
  }
  if (messageType === "audio") {
    const mediaRef = validId(message.audio?.id);
    return { kind: "AUDIO", messageType, ...(mediaRef ? { mediaRef } : {}) };
  }
  return { kind: "OTHER", messageType };
}

// De los eventos de UN envío de Kapso, lo que va al historial: mensajes entrantes, mensajes salientes de humanos / otras apps y estados de entrega. Los ecos del propio agente (origen cloud_api) NO se insertan
// (el agente registra su respuesta al enviarla): solo actualizan el estado de entrega. Lo importado del historial de WhatsApp y los eventos que no son de mensajes se ignoran.
export function historyEntriesOf(raws: readonly Record<string, any>[], classified: readonly ClassifiedKapsoEvent[]): { entries: WebhookEntry[]; statuses: WebhookStatus[] } {
  const entries: WebhookEntry[] = [];
  const statuses: WebhookStatus[] = [];
  classified.forEach((event, index) => {
    const message = raws[index]?.message;
    if (typeof message !== "object" || message === null) return;
    const messageId = validId(message.id);
    if (!messageId) return;
    // Lo reimportado del historial de WhatsApp (Kapso lo marca como entrante) no es una conversación con el agente: nunca se guarda.
    if (event.origin === "history_sync" || event.kind === "HISTORY_SYNC") return;
    const at = event.occurredAt ? new Date(event.occurredAt) : undefined;
    const origin = event.origin && ORIGIN.test(event.origin) ? event.origin : undefined;
    const update = deliveryUpdateOf(event.eventName, message.kapso?.status);
    if (event.kind === "STATUS_UPDATE" || event.kind === "BOT_OUTBOUND") {
      if (update) statuses.push({ messageId, state: update, ...(at ? { at } : {}) });
      return;
    }
    if (!event.contactPhone) return;
    if (event.kind === "PATIENT_MESSAGE") {
      entries.push({ messageId, contactPhone: event.contactPhone, direction: "IN", actor: "PATIENT", ...(origin ? { origin } : {}), ...contentOf(message), state: "RECEIVED", ...(at ? { occurredAt: at } : {}) });
      return;
    }
    const actor = ACTOR_OF[event.kind];
    if (actor) entries.push({ messageId, contactPhone: event.contactPhone, direction: "OUT", actor, ...(origin ? { origin } : {}), ...contentOf(message), state: update ?? "SENT", ...(at ? { occurredAt: at } : {}) });
  });
  return { entries, statuses };
}

// ───────────────────────────── el historial que usa el agente ─────────────────────────────

export interface MessageHistory {
  // Los eventos de un POST de Kapso (ya clasificados). `inScope`: solo los contactos que el agente atiende. Nunca lanza.
  observe(input: { raws: readonly Record<string, any>[]; classified: readonly ClassifiedKapsoEvent[]; inScope(phone: string): boolean }): Promise<void>;
  // Una respuesta del agente que Kapso aceptó para envío (ACCEPTED) o cuyo envío falló sin saber si salió (UNCERTAIN). Nunca lanza.
  recordAgentReply(input: { to: string; messageId: string; replyTo: string; text: string; state: "ACCEPTED" | "UNCERTAIN"; auditRunId?: string; at?: Date }): Promise<void>;
  // La transcripción de un audio entrante. Nunca lanza.
  recordTranscript(input: { from: string; messageId: string; text: string; at?: Date }): Promise<void>;
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface MessageHistoryOptions {
  store: HistoryStore;
  // Clave de cifrado dedicada (>= 32 caracteres), opcional: sin ella el texto se guarda en claro. Y la línea de WhatsApp del laboratorio.
  secret?: string;
  accountId: string;
  contactKeyFor(phone: string): string | undefined;
  log(event: string, data: Record<string, unknown>): void;
  timeoutMs?: number;
}

export function createMessageHistory(options: MessageHistoryOptions): MessageHistory {
  const { store, secret, accountId, log } = options;
  const timeoutMs = options.timeoutMs ?? HISTORY_DEFAULTS.timeoutMs;
  const keyId = secret ? keyIdOf(secret) : undefined;
  const run = <T>(work: Promise<T>) => bounded(work, timeoutMs);
  // El texto de un mensaje: en claro por defecto; cifrado si hay clave.
  const textOf = (text: string, contactKey: string, direction: HistoryDirection, messageId: string): Pick<HistoryRow, "body" | "bodyCipher" | "keyId"> =>
    secret ? { bodyCipher: sealMessage(text, secret, { accountId, contactKey, direction, messageId }), keyId: keyId! } : { body: text };
  // El teléfono se guarda solo con dígitos (los mismos con que se calcula contactKey); si no tiene un largo razonable, la fila se guarda igual, sin teléfono.
  const phoneOf = (phone: string): Pick<HistoryRow, "contactPhone"> => {
    const digits = phone.replace(/\D/g, "");
    return /^\d{6,20}$/.test(digits) ? { contactPhone: digits } : {};
  };
  const rowOf = (base: Omit<HistoryRow, "accountId" | "body" | "bodyCipher" | "keyId" | "contactPhone">, contactKey: string, text: string | undefined, phone: string): HistoryRow => ({
    accountId, ...base, ...phoneOf(phone),
    ...(text ? textOf(text, contactKey, base.direction, base.messageId) : {})
  });

  return {
    async observe({ raws, classified, inScope }) {
      try {
        const { entries, statuses } = historyEntriesOf(raws, classified);
        const counts = { recorded: 0, duplicate: 0, statusUpdated: 0, statusIgnored: 0, failed: 0, skipped: 0 };
        // Otra línea de WhatsApp: su clave de contacto se calcularía con la línea equivocada, así que no se registra.
        const sameLine = (index: number) => {
          const raw = raws[index];
          const number = typeof raw?.phone_number_id === "string" ? raw.phone_number_id : typeof raw?.conversation?.phone_number_id === "string" ? raw.conversation.phone_number_id : undefined;
          return !number || number === accountId;
        };
        const lineOk = new Set<string>();
        classified.forEach((event, index) => {
          if (event.messageId && sameLine(index)) lineOk.add(event.messageId);
        });
        const jobs: Array<() => Promise<void>> = [];
        for (const entry of entries) {
          if (!lineOk.has(entry.messageId) || !inScope(entry.contactPhone)) {
            counts.skipped++;
            continue;
          }
          jobs.push(async () => {
            const contactKey = options.contactKeyFor(entry.contactPhone);
            if (!contactKey) {
              counts.skipped++;
              return;
            }
            try {
              const row = rowOf(
                { messageId: entry.messageId, direction: entry.direction, actor: entry.actor, ...(entry.origin ? { origin: entry.origin } : {}), kind: entry.kind, ...(entry.messageType ? { messageType: entry.messageType } : {}), ...(entry.mediaRef ? { mediaRef: entry.mediaRef } : {}), state: entry.state, contactKey, ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}) },
                contactKey,
                entry.text,
                entry.contactPhone
              );
              (await run(store.record(row))) === "RECORDED" ? counts.recorded++ : counts.duplicate++;
            } catch {
              counts.failed++;
            }
          });
        }
        for (const status of statuses) {
          if (!lineOk.has(status.messageId)) continue;
          jobs.push(async () => {
            try {
              (await run(store.delivery({ accountId, messageId: status.messageId, state: status.state, ...(status.at ? { at: status.at } : {}) }))) === "UPDATED" ? counts.statusUpdated++ : counts.statusIgnored++;
            } catch {
              counts.failed++;
            }
          });
        }
        for (let start = 0; start < jobs.length; start += HISTORY_DEFAULTS.concurrency) await Promise.all(jobs.slice(start, start + HISTORY_DEFAULTS.concurrency).map((job) => job()));
        // Solo contadores: nunca texto, ids ni teléfonos.
        log("message_history", { op: "OBSERVE", ...counts });
        if (counts.failed > 0) log("message_history_write_failed", { op: "OBSERVE", failed: counts.failed });
      } catch {
        log("message_history_write_failed", { op: "OBSERVE", failed: -1 });
      }
    },

    async recordAgentReply({ to, messageId, replyTo, text, state, auditRunId, at }) {
      try {
        const contactKey = options.contactKeyFor(to);
        if (!contactKey || !ID.test(messageId) || text.trim() === "") {
          log("message_history", { op: "OUT", outcome: "SKIPPED" });
          return;
        }
        const row = rowOf(
          { messageId, direction: "OUT", actor: "AGENT", origin: "cloud_api", kind: "TEXT", messageType: "text", state, contactKey, ...(auditRunId ? { auditRunId } : {}), ...(ID.test(replyTo) ? { replyTo } : {}), occurredAt: at ?? new Date() },
          contactKey,
          clip(text),
          to
        );
        log("message_history", { op: "OUT", outcome: await run(store.record(row)), state });
      } catch {
        // Nunca el texto del error: puede traer filas o el mensaje.
        log("message_history_write_failed", { op: "OUT", failed: 1 });
      }
    },

    async recordTranscript({ from, messageId, text, at }) {
      try {
        const contactKey = options.contactKeyFor(from);
        if (!contactKey || !ID.test(messageId) || text.trim() === "") {
          log("message_history", { op: "TRANSCRIPT", outcome: "SKIPPED" });
          return;
        }
        const clipped = clip(text);
        let outcome = await run(store.attachText({ accountId, contactKey, messageId, ...textOf(clipped, contactKey, "IN", messageId) }));
        // El registro del audio (que se hace aparte, al llegar el webhook) aún no existe: se escribe completo, con la transcripción.
        if (outcome === "MISSING") {
          const row = rowOf({ messageId, direction: "IN", actor: "PATIENT", kind: "AUDIO", messageType: "audio", state: "RECEIVED", contactKey, ...(at ? { occurredAt: at } : {}) }, contactKey, clipped, from);
          await run(store.record(row));
          outcome = "UPDATED";
        }
        log("message_history", { op: "TRANSCRIPT", outcome });
      } catch {
        log("message_history_write_failed", { op: "TRANSCRIPT", failed: 1 });
      }
    }
  };
}

// ───────────────────────────── configuración ─────────────────────────────

export type HistoryConfigError = "INVALID_KEY" | "KEY_NOT_DEDICATED" | "CONTACT_KEY_REQUIRED" | "INVALID_RETENTION";

// La clave del historial no puede ser igual a NINGUNA otra clave, secreto o token del entorno (HMAC de contactos, memoria, cola, webhook, service role, APIs…): una sola filtración no debe abrir dos cosas.
const OWN_NAMES = new Set(["PLUSMEDIK_HISTORY_KEY", "PLUSMEDIK_HISTORY_KEY_PREVIOUS"]);
const reusesAnotherSecret = (env: Record<string, string | undefined>, secret: string): boolean =>
  Object.entries(env).some(([name, value]) => !OWN_NAMES.has(name) && /(_KEY|_SECRET|_TOKEN)$/.test(name) && value?.trim() === secret);

function retentionOf(value: string | undefined): number | undefined | "INVALID" {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{1,4}$/.test(value.trim())) return "INVALID";
  const parsed = Number(value.trim());
  return parsed >= 1 && parsed <= HISTORY_DEFAULTS.maxRetentionDays ? parsed : "INVALID";
}

// Devuelve el historial ENCENDIDO por defecto, sin ninguna variable nueva: solo necesita lo que el agente ya tiene (la clave HMAC de contactos, con la que se calcula `contactKeyFor`, y KAPSO_PHONE_NUMBER_ID).
// PLUSMEDIK_HISTORY=off lo apaga. Opcionales: PLUSMEDIK_HISTORY_KEY (>= 32 caracteres y distinta de cualquier otra clave) para guardar el texto CIFRADO en vez de en claro, y
// PLUSMEDIK_HISTORY_RETENTION_DAYS (1-3650) para poner un tope; sin ellos el texto va en claro y no vence. Una configuración inválida lo deja apagado y deja un código en el registro.
export function resolveMessageHistory(
  env: Record<string, string | undefined>,
  log: (event: string, data: Record<string, unknown>) => void,
  options: { contactKeyFor(phone: string): string | undefined; store?: HistoryStore }
): MessageHistory | undefined {
  if (env.PLUSMEDIK_HISTORY?.trim().toLowerCase() === "off") return undefined;
  const fail = (error: HistoryConfigError): undefined => {
    log("message_history_config_invalid", { error });
    return undefined;
  };
  const accountId = env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!accountId || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId) || (env.PLUSMEDIK_CONTACT_HMAC_KEY?.trim().length ?? 0) < MIN_HISTORY_KEY_LENGTH) return fail("CONTACT_KEY_REQUIRED");
  const rawSecret = env.PLUSMEDIK_HISTORY_KEY?.trim();
  const secret = rawSecret === "" ? undefined : rawSecret;
  if (secret !== undefined && secret.length < MIN_HISTORY_KEY_LENGTH) return fail("INVALID_KEY");
  if (secret !== undefined && reusesAnotherSecret(env, secret)) return fail("KEY_NOT_DEDICATED");
  const retentionDays = retentionOf(env.PLUSMEDIK_HISTORY_RETENTION_DAYS);
  if (retentionDays === "INVALID") return fail("INVALID_RETENTION");
  const store = options.store ?? createSupabaseHistoryStore({ ...(retentionDays !== undefined ? { retentionDays } : {}) });
  return createMessageHistory({ store, ...(secret !== undefined ? { secret } : {}), accountId, contactKeyFor: options.contactKeyFor, log });
}

// ───────────────────────────── exportación autorizada ─────────────────────────────

export interface ExportedMessage {
  seq: number;
  at: string;
  contactKey: string;
  contactPhone: string | null;
  messageId: string;
  direction: HistoryDirection;
  actor: HistoryActor;
  origin: string | null;
  kind: HistoryKind;
  messageType: string | null;
  mediaRef: string | null;
  state: DeliveryState;
  deliveryAt: string | null;
  auditRunId: string | null;
  replyTo: string | null;
  // NONE: no tiene texto (audio sin transcripción, imagen sin pie, otro tipo). UNREADABLE: no se pudo descifrar (otra clave o fila manipulada).
  textStatus: "OK" | "NONE" | "UNREADABLE";
  text?: string;
}

// Lee el historial por páginas (deja un rastro con el motivo). El texto en claro se entrega tal cual; el cifrado se descifra aquí, con las claves que se le pasen (la actual y, si se rotó, las anteriores; pueden ser ninguna).
export async function* exportHistory(options: { store: HistoryStore; accountId: string; keys: readonly string[]; reason: string; contactKey?: string; from?: Date; to?: Date; pageSize?: number }): AsyncGenerator<ExportedMessage> {
  const byId = new Map(options.keys.map((key) => [keyIdOf(key), key] as const));
  let afterSeq: number | undefined;
  for (;;) {
    const page = await options.store.exportPage({ reason: options.reason, ...(options.contactKey ? { contactKey: options.contactKey } : {}), ...(options.from ? { from: options.from } : {}), ...(options.to ? { to: options.to } : {}), ...(afterSeq !== undefined ? { afterSeq } : {}), limit: options.pageSize ?? HISTORY_DEFAULTS.exportPageSize });
    for (const row of page.rows) {
      let textStatus: ExportedMessage["textStatus"] = "NONE";
      let text: string | undefined;
      if (row.body) {
        text = row.body;
        textStatus = "OK";
      } else if (row.bodyCipher) {
        const key = row.keyId ? byId.get(row.keyId) : undefined;
        try {
          if (!key) throw new HistoryCipherError();
          text = openMessage(row.bodyCipher, key, { accountId: options.accountId, contactKey: row.contactKey, direction: row.direction, messageId: row.messageId });
          textStatus = "OK";
        } catch {
          textStatus = "UNREADABLE";
        }
      }
      yield {
        seq: row.seq, at: row.occurredAt, contactKey: row.contactKey, contactPhone: row.contactPhone, messageId: row.messageId, direction: row.direction, actor: row.actor, origin: row.origin, kind: row.kind, messageType: row.messageType,
        mediaRef: row.mediaRef, state: row.state, deliveryAt: row.deliveryAt, auditRunId: row.auditRunId, replyTo: row.replyTo, textStatus, ...(text !== undefined ? { text } : {})
      };
    }
    if (page.next === undefined) return;
    afterSeq = page.next;
  }
}

// CSV para abrir en una hoja de cálculo: las celdas que empiezan con = + - @ se neutralizan (un mensaje de un paciente no debe poder ejecutar una fórmula).
export const CSV_COLUMNS = ["seq", "at", "direction", "actor", "origin", "kind", "messageType", "state", "deliveryAt", "contactPhone", "contactKey", "messageId", "replyTo", "auditRunId", "mediaRef", "textStatus", "text"] as const;
export function csvLine(message: ExportedMessage): string {
  const cell = (value: unknown): string => {
    let text = value === undefined || value === null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return CSV_COLUMNS.map((column) => cell(message[column as keyof ExportedMessage])).join(",");
}
