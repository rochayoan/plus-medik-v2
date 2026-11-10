import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createSupabaseRpc } from "./audit.js";
import { looksMedical, sanitizeForModel, type HistoryEntry } from "./conversation-model.js";
import { classifyText } from "./text-handler.js";
import { fold } from "./text-normalize.js";

// Memoria conversacional corta (APAGADA por defecto: PLUSMEDIK_CONVERSATION_MEMORY=on). Guarda los mensajes de TEXTO del paciente y las respuestas del agente confirmadas como enviadas, por
// contacto y línea de WhatsApp, y antes de consultar al modelo recupera los últimos 5 para dárselos como contexto. Sin listas de teléfonos: vale para todos los pacientes que ya atienda el agente
// (el alcance lo siguen decidiendo ALLOWED_PHONES y la puerta del piloto de texto).
//
// Protección de datos (migración 17, supabase/migrations/20261105000000_plusmedik_conversation_memory.sql):
//   · La clave del contacto es el HMAC de los turnos (incluye la línea de WhatsApp): pacientes y líneas quedan separados y no se guarda el teléfono.
//   · El texto se SANEA (sin enlaces, correos ni números largos) y se CIFRA aquí (AES-256-GCM, clave dedicada); la base no lo ve en claro. Vence a los 7 días (1-30) y se conservan 40 por contacto.
//   · NO se guarda (ni se envía al modelo) lo que parece de salud, un mensaje automático ni un pedido de cotización con estudios: eso requiere la autorización del laboratorio.
//   · Ninguna falla de la memoria interrumpe una respuesta: sin memoria el modelo solo ve el mensaje actual. El registro lleva códigos y contadores, nunca texto.

export const MEMORY_DEFAULTS = { limit: 5, retentionDays: 7, entryChars: 300, totalChars: 1200, storeChars: 500, timeoutMs: 3000 } as const;
export const MIN_MEMORY_KEY_LENGTH = 32;

export type MemoryDirection = "IN" | "OUT";
export interface StoredMessage {
  direction: MemoryDirection;
  text: string;
  at: string;
}

export interface MemoryStore {
  record(input: { contactKey: string; direction: MemoryDirection; messageId: string; text: string; at: Date }): Promise<"RECORDED" | "DUPLICATE">;
  // Más reciente primero. Solo mensajes vigentes de ESE contacto, sin el mensaje entrante `excludeMessageId`.
  recent(input: { contactKey: string; limit: number; excludeMessageId?: string }): Promise<StoredMessage[]>;
}

// ───────────────────────────── cifrado en reposo ─────────────────────────────

export class MemoryCipherError extends Error {
  constructor() {
    super("conversation_memory_cipher");
    this.name = "MemoryCipherError";
  }
}
const keyBytes = (secret: string): Buffer => {
  if (secret.length < MIN_MEMORY_KEY_LENGTH) throw new MemoryCipherError();
  return createHash("sha256").update(`plusmedik-memory-v1:${secret}`).digest();
};
const b64 = (buffer: Buffer) => buffer.toString("base64url");
const aadOf = (contactKey: string, direction: MemoryDirection, messageId: string) => Buffer.from(`${contactKey}|${direction}|${messageId}`);

// v1.<iv>.<tag>.<texto cifrado>. El contacto, la dirección y el id del mensaje van como dato autenticado: una fila cifrada no se puede pasar por la de otro contacto ni por otro mensaje.
export function sealText(text: string, secret: string, contactKey: string, direction: MemoryDirection, messageId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(secret), iv);
  cipher.setAAD(aadOf(contactKey, direction, messageId));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
}

export function openText(sealed: string, secret: string, contactKey: string, direction: MemoryDirection, messageId: string): string {
  try {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new MemoryCipherError();
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(secret), Buffer.from(iv, "base64url"));
    decipher.setAAD(aadOf(contactKey, direction, messageId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new MemoryCipherError();
  }
}

// ───────────────────────────── qué se guarda ─────────────────────────────

export interface StoragePolicy {
  // ¿Parece un mensaje automático (autorrespuesta de otro negocio)? Lo inyecta el cableado.
  isAutomated?: (text: string) => boolean;
}

// El texto saneado que se puede guardar de un mensaje del paciente, o undefined si NO se debe guardar: vacío, de salud, automático o pedido de cotización (nombra estudios).
export function storablePatientText(text: string, policy: StoragePolicy = {}): string | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  if (looksMedical(text) || classifyText(text) === "MEDICAL" || classifyText(text) === "RECIPE_OR_QUOTE" || policy.isAutomated?.(text)) return undefined;
  const clean = sanitizeForModel(text, MEMORY_DEFAULTS.storeChars);
  return clean === "" ? undefined : clean;
}

// La respuesta del agente: mismo criterio, salvo que su contenido es del propio laboratorio (no se filtra por cotización). Tampoco se guardan sus avisos médicos («no puedo darte orientación médica»):
// pertenecen a una conversación de salud cuyo mensaje del paciente no se guardó.
export function storableReplyText(text: string, policy: StoragePolicy = {}): string | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  if (looksMedical(text) || /\bmedic\w*/.test(fold(text)) || policy.isAutomated?.(text)) return undefined;
  const clean = sanitizeForModel(text, MEMORY_DEFAULTS.storeChars);
  return clean === "" ? undefined : clean;
}

// ───────────────────────────── lo que recibe el modelo ─────────────────────────────

export interface PreparedHistory {
  entries: HistoryEntry[];
  dropped: number;
}

// Los últimos `limit` mensajes en orden cronológico. Vuelve a aplicar el filtro de contenido (defensa en profundidad: lo guardado antes de un cambio de reglas tampoco sale) y acota el tamaño.
export function prepareHistory(rows: readonly StoredMessage[], options: { limit?: number; policy?: StoragePolicy } = {}): PreparedHistory {
  const limit = Math.max(1, Math.min(MEMORY_DEFAULTS.limit, options.limit ?? MEMORY_DEFAULTS.limit));
  const latest = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
  const kept: HistoryEntry[] = [];
  for (const row of latest) {
    const text = row.direction === "IN" ? storablePatientText(row.text, options.policy) : storableReplyText(row.text, options.policy);
    if (text) kept.push({ from: row.direction === "IN" ? "PATIENT" : "ASSISTANT", text: text.slice(0, MEMORY_DEFAULTS.entryChars) });
  }
  // Tope de tamaño: se descarta primero lo más antiguo (kept va del más nuevo al más viejo).
  let size = 0;
  const bounded: HistoryEntry[] = [];
  for (const entry of kept) {
    size += entry.text.length;
    if (size > MEMORY_DEFAULTS.totalChars) break;
    bounded.push(entry);
  }
  return { entries: bounded.reverse(), dropped: latest.length - bounded.length };
}

// ───────────────────────────── almacén en Supabase (solo funciones) ─────────────────────────────

const recentRows = z.object({
  messages: z.array(z.object({ d: z.enum(["IN", "OUT"]), m: z.string(), c: z.string(), t: z.string() }))
});

export interface SupabaseMemoryStoreOptions {
  // Clave de cifrado dedicada (>= 32 caracteres). Distinta de la clave HMAC de contactos y de la del outbox.
  secret: string;
  retentionDays?: number;
  rpc?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export function createSupabaseMemoryStore(options: SupabaseMemoryStoreOptions): MemoryStore {
  let rpc = options.rpc;
  const call = (name: string, args: Record<string, unknown>) => (rpc ??= createSupabaseRpc({ requestTimeoutMs: MEMORY_DEFAULTS.timeoutMs, retryDelayMs: 200 }))(name, args);
  return {
    async record({ contactKey, direction, messageId, text, at }) {
      const result = await call("plusmedik_memory_record", {
        p_contact_key: contactKey,
        p_direction: direction,
        p_message_id: messageId,
        p_body_cipher: sealText(text, options.secret, contactKey, direction, messageId),
        p_occurred_at: at.toISOString(),
        p_retention_days: options.retentionDays ?? MEMORY_DEFAULTS.retentionDays
      });
      return result.outcome === "recorded" ? "RECORDED" : "DUPLICATE";
    },
    async recent({ contactKey, limit, excludeMessageId }) {
      const result = recentRows.parse(await call("plusmedik_memory_recent", { p_contact_key: contactKey, p_limit: limit, p_exclude_message_id: excludeMessageId ?? null }));
      const rows: StoredMessage[] = [];
      for (const row of result.messages) {
        try {
          rows.push({ direction: row.d, text: openText(row.c, options.secret, contactKey, row.d, row.m), at: row.t });
        } catch {
          // Una fila que no se puede descifrar (otra clave, manipulada) se ignora.
        }
      }
      return rows;
    }
  };
}

// ───────────────────────────── la memoria que usan los turnos ─────────────────────────────

export interface ConversationMemory {
  // Ninguna de las tres lanza: sin memoria el turno sigue como siempre.
  rememberPatient(input: { contactKey: string; messageId: string; text: string; at?: Date }): Promise<void>;
  // Solo se llama con la respuesta ya CONFIRMADA como enviada.
  rememberReply(input: { contactKey: string; messageId: string; text: string; at?: Date }): Promise<void>;
  history(input: { contactKey: string; currentMessageId: string }): Promise<HistoryEntry[]>;
}

// Ninguna llamada a la base retrasa un turno más de MEMORY_DEFAULTS.timeoutMs (el cliente RPC puede reintentar una vez).
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createConversationMemory(options: { store: MemoryStore; log: (event: string, data: Record<string, unknown>) => void; limit?: number; isAutomated?: (text: string) => boolean; now?: () => number }): ConversationMemory {
  const policy: StoragePolicy = { isAutomated: options.isAutomated };
  const now = options.now ?? Date.now;
  const limit = options.limit ?? MEMORY_DEFAULTS.limit;
  const remember = (op: "IN" | "OUT") => async (input: { contactKey: string; messageId: string; text: string; at?: Date }): Promise<void> => {
    const text = op === "IN" ? storablePatientText(input.text, policy) : storableReplyText(input.text, policy);
    if (!text) {
      options.log("conversation_memory", { op: `RECORD_${op}`, outcome: "SKIPPED" });
      return;
    }
    try {
      const outcome = await bounded(options.store.record({ contactKey: input.contactKey, direction: op, messageId: input.messageId, text, at: input.at ?? new Date(now()) }), MEMORY_DEFAULTS.timeoutMs);
      options.log("conversation_memory", { op: `RECORD_${op}`, outcome });
    } catch {
      // Nunca el texto del error: puede traer filas o el mensaje.
      options.log("conversation_memory", { op: `RECORD_${op}`, outcome: "FAILED" });
    }
  };
  return {
    rememberPatient: remember("IN"),
    rememberReply: remember("OUT"),
    async history({ contactKey, currentMessageId }) {
      try {
        const rows = await bounded(options.store.recent({ contactKey, limit, excludeMessageId: currentMessageId }), MEMORY_DEFAULTS.timeoutMs);
        const { entries, dropped } = prepareHistory(rows, { limit, policy });
        options.log("conversation_memory", { op: "READ", outcome: "OK", count: entries.length, dropped });
        return entries;
      } catch {
        options.log("conversation_memory", { op: "READ", outcome: "FAILED" });
        return [];
      }
    }
  };
}

// ───────────────────────────── configuración ─────────────────────────────

export type MemoryConfigError = "CONVERSATION_REQUIRED" | "MISSING_KEY" | "INVALID_RETENTION" | "INVALID_LIMIT";

function integerIn(value: string | undefined, min: number, max: number): number | undefined | "INVALID" {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{1,3}$/.test(value.trim())) return "INVALID";
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : "INVALID";
}

// Devuelve la memoria SOLO si la bandera está en «on» y TODA la configuración es válida; si no, undefined (y un código en el registro si estaba habilitada).
export function resolveConversationMemory(
  env: Record<string, string | undefined>,
  log: (event: string, data: Record<string, unknown>) => void,
  options: { conversationActive: boolean; store?: MemoryStore; isAutomated?: (text: string) => boolean; now?: () => number }
): ConversationMemory | undefined {
  if (env.PLUSMEDIK_CONVERSATION_MEMORY?.trim().toLowerCase() !== "on") return undefined;
  const fail = (error: MemoryConfigError): undefined => {
    log("conversation_memory_config_invalid", { error });
    return undefined;
  };
  // Sin la conversación con modelo no hay a quién darle el contexto (y no tiene sentido guardar nada).
  if (!options.conversationActive) return fail("CONVERSATION_REQUIRED");
  const secret = env.PLUSMEDIK_MEMORY_KEY?.trim();
  if (!options.store && (!secret || secret.length < MIN_MEMORY_KEY_LENGTH)) return fail("MISSING_KEY");
  const retentionDays = integerIn(env.PLUSMEDIK_MEMORY_RETENTION_DAYS, 1, 30);
  if (retentionDays === "INVALID") return fail("INVALID_RETENTION");
  const limit = integerIn(env.PLUSMEDIK_MEMORY_LIMIT, 1, MEMORY_DEFAULTS.limit);
  if (limit === "INVALID") return fail("INVALID_LIMIT");
  const store = options.store ?? createSupabaseMemoryStore({ secret: secret!, ...(retentionDays !== undefined ? { retentionDays } : {}) });
  return createConversationMemory({ store, log, ...(limit !== undefined ? { limit } : {}), ...(options.isAutomated ? { isAutomated: options.isAutomated } : {}), ...(options.now ? { now: options.now } : {}) });
}
