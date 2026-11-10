import { auditErrorFields, createSupabaseRpc } from "./audit.js";
import { socialOf } from "./attention-filter.js";
import {
  encodeEvent, pending, stateFromRows, type ConversationEvent, type ConversationState, type EventRow, type GoalKind, type PatientItem, type Question, type ReplyQuality
} from "./conversation-state.js";
import { QUOTE_TEXTS } from "./quote-session.js";
import { classifyText, DRAFT_TEXTS } from "./text-handler.js";

// Persistencia, lectura y REGISTRO EN SOMBRA de la memoria de conversación (Fase 1 del plan G7). Ver src/conversation-state.ts (dominio puro) y supabase/migrations/20261112000000 (tabla de eventos).
//
// MODO SOMBRA (la bandera del agente conversacional; ausente u «off» = apagado; cualquier otro valor = apagado y un código en el registro): solo OBSERVA. No cambia ninguna respuesta, no toma ni espera
// ningún lease, no bloquea ningún envío y ningún fallo se propaga: cada escritura es de mejor esfuerzo, con tiempo acotado y SIN lanzar. Lo que se escribe son hechos mínimos e idempotentes (ver la
// migración): ids y códigos, nunca texto de pacientes ni precios. El texto de un mensaje pasa por la memoria del proceso solo para clasificarlo y se descarta.
// Seguridad de la concurrencia: cada evento tiene una clave única (reintentos de Kapso o turnos repetidos no duplican nada) y el orden se reconstruye por instante; un turno que perdió su lease no puede
// enviar (la reserva lo impide), de modo que tampoco emite su respuesta.

// ───────────────────────────── almacén (solo funciones de la base) ─────────────────────────────

export interface ConversationStore {
  append(contactKey: string, rows: readonly EventRow[], retentionDays?: number): Promise<{ recorded: number; duplicate: number }>;
  read(contactKey: string, since: Date, limit?: number): Promise<unknown[]>;
  contactsSince(since: Date, limit?: number): Promise<Array<{ contactKey: string; lastAt: string }>>;
}

export const CONVERSATION_DEFAULTS = { retentionDays: 30, readLimit: 2000, timeoutMs: 3000, flushMs: 2500 } as const;

export function createSupabaseConversationStore(options: { rpc?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}): ConversationStore {
  let rpc = options.rpc;
  const call = (name: string, args: Record<string, unknown>) => (rpc ??= createSupabaseRpc({ requestTimeoutMs: CONVERSATION_DEFAULTS.timeoutMs, retryDelayMs: 200 }))(name, args);
  return {
    async append(contactKey, rows, retentionDays = CONVERSATION_DEFAULTS.retentionDays) {
      const result = await call("plusmedik_conv_append", { p_contact_key: contactKey, p_events: rows, p_retention_days: retentionDays });
      return { recorded: Number(result.recorded ?? 0), duplicate: Number(result.duplicate ?? 0) };
    },
    async read(contactKey, since, limit = CONVERSATION_DEFAULTS.readLimit) {
      const result = await call("plusmedik_conv_events_read", { p_contact_key: contactKey, p_since: since.toISOString(), p_limit: limit });
      return Array.isArray(result.events) ? result.events : [];
    },
    async contactsSince(since, limit = 500) {
      const result = await call("plusmedik_conv_contacts_since", { p_since: since.toISOString(), p_limit: limit });
      const contacts = Array.isArray(result.contacts) ? result.contacts : [];
      return contacts.flatMap((row) => (typeof row === "object" && row !== null && typeof (row as { contact_key?: unknown }).contact_key === "string" ? [{ contactKey: (row as { contact_key: string }).contact_key, lastAt: String((row as { last_at?: unknown }).last_at ?? "") }] : []));
    }
  };
}

// ───────────────────────────── lectura: el estado de un contacto y lo pendiente ─────────────────────────────

export interface ConversationReader {
  // Estado reconstruido desde los eventos vigentes. Ante cualquier fallo devuelve undefined (nunca lanza): «no se sabe», no «no hay nada».
  stateOf(contactKey: string, options?: { sinceMs?: number; now?: number }): Promise<ConversationState | undefined>;
  // Contactos con preguntas sin atender desde hace al menos `minAgeMs` (para la recepción). Solo ids y códigos.
  pendingContacts(options?: { windowMs?: number; minAgeMs?: number; now?: number; limit?: number }): Promise<Array<{ contactKey: string; questions: Array<Pick<Question, "id" | "messageId" | "topic" | "status" | "reason" | "openedAt" | "attempts">> }> | undefined>;
}

export function createConversationReader(options: { store: ConversationStore; now?: () => number }): ConversationReader {
  const now = options.now ?? Date.now;
  const day = 24 * 3600 * 1000;
  return {
    async stateOf(contactKey, opts = {}) {
      try {
        return stateFromRows(await options.store.read(contactKey, new Date((opts.now ?? now()) - (opts.sinceMs ?? 7 * day))));
      } catch {
        return undefined;
      }
    },
    async pendingContacts(opts = {}) {
      try {
        const at = opts.now ?? now();
        const contacts = await options.store.contactsSince(new Date(at - (opts.windowMs ?? 2 * day)), opts.limit ?? 500);
        const out: NonNullable<Awaited<ReturnType<ConversationReader["pendingContacts"]>>> = [];
        for (const { contactKey } of contacts) {
          const state = stateFromRows(await options.store.read(contactKey, new Date(at - (opts.windowMs ?? 2 * day))));
          const questions = pending(state, at, opts.minAgeMs ?? 0).map(({ id, messageId, topic, status, reason, openedAt, attempts }) => ({ id, messageId, topic, status, reason, openedAt, attempts }));
          if (questions.length > 0) out.push({ contactKey, questions });
        }
        return out;
      } catch {
        return undefined;
      }
    }
  };
}

// ───────────────────────────── de un mensaje o una respuesta a eventos (reglas deterministas, sin texto guardado) ─────────────────────────────

export interface ObservedTurn { messageId: string; kind: "TEXT" | "IMAGE" | "AUDIO" | "OTHER"; text?: string; timestamp?: number }

export const GOAL_BY_CATEGORY: Record<string, GoalKind> = { RECIPE_OR_QUOTE: "QUOTE", INFO_REQUEST: "LAB_INFO", MEDICAL: "HUMAN_ATTENTION", HUMAN_REQUEST: "HUMAN_ATTENTION", OTHER: "OTHER", GREETING: "OTHER" };

// Las peticiones que un lote del paciente le pide al agente: una por foto/audio y una por el conjunto de textos que no sean solo un saludo o un agradecimiento. Nada de texto en el resultado.
export function patientItemsOf(turns: readonly ObservedTurn[]): PatientItem[] {
  const items: PatientItem[] = [];
  for (const turn of turns) {
    if (turn.kind === "IMAGE") items.push({ messageId: turn.messageId, topic: "MEDIA_IMAGE", goal: "QUOTE" });
    else if (turn.kind === "AUDIO") items.push({ messageId: turn.messageId, topic: "MEDIA_AUDIO", goal: "MEDIA" });
    else if (turn.kind === "OTHER") items.push({ messageId: turn.messageId, topic: "MEDIA_OTHER", goal: "MEDIA" });
  }
  const texts = turns.filter((turn) => turn.kind === "TEXT" && typeof turn.text === "string" && turn.text.trim() !== "");
  if (texts.length > 0 && !texts.every((turn) => socialOf(turn.text!) !== undefined)) {
    const category = classifyText(texts.map((turn) => turn.text).join(" "));
    items.push({ messageId: texts[0]!.messageId, topic: category, goal: GOAL_BY_CATEGORY[category] ?? "OTHER" });
  }
  return items;
}

const GENERIC_TEXTS: ReadonlySet<string> = new Set([DRAFT_TEXTS.greeting, DRAFT_TEXTS.send_recipe, DRAFT_TEXTS.fallback]);
const BLOCKED_TEXTS: ReadonlySet<string> = new Set([DRAFT_TEXTS.handoff_unavailable, DRAFT_TEXTS.medical_unavailable]);
const RESOLVED_NO_QUOTE: ReadonlySet<string> = new Set([QUOTE_TEXTS.cancelled, QUOTE_TEXTS.nothing_to_cancel]);

// ¿La respuesta del agente atendió de verdad lo pedido? (un mensaje de varias partes cuenta como respuesta si alguna parte NO es un texto fijo)
export function replyQualityOf(reply: { body: string; result: string; generic?: boolean; quality?: ReplyQuality }): ReplyQuality {
  // El productor que SABE qué hizo (el agente del piloto: respondió, cotizó o aplazó) lo dice; el resto se deduce del texto fijo.
  if (reply.quality) return reply.quality;
  if (reply.result === "technical_issue") return "TECHNICAL";
  if (reply.result === "quoted") return "QUOTE";
  const parts = reply.body.split(/\n{2,}/).map((part) => part.trim()).filter((part) => part !== "");
  const free = parts.filter((part) => !GENERIC_TEXTS.has(part) && !BLOCKED_TEXTS.has(part));
  if (free.length === 0) return parts.some((part) => BLOCKED_TEXTS.has(part)) ? "BLOCKED" : "GENERIC";
  if (reply.result === "no_quote" && !parts.every((part) => RESOLVED_NO_QUOTE.has(part))) return "UNRESOLVED";
  if (reply.generic === true && free.length === parts.length && parts.length === 1) return "GENERIC";
  return "ANSWER";
}

// ───────────────────────────── el registrador en sombra ─────────────────────────────

export interface ConversationRecorder {
  readonly mode: "shadow";
  // Un lote (o un mensaje suelto) de un contacto. `paused`: el turno no se reclamó porque una persona tiene la palabra (el mensaje no se atiende solo, pero queda registrado).
  patientBatch(input: { from: string; turns: readonly ObservedTurn[]; paused?: boolean }): void;
  // Una respuesta que Kapso ACEPTÓ (un envío incierto o retenido no cuenta como respuesta).
  agentReply(input: { from: string; messageId: string; replyTo: string; reply: { body: string; result: string; generic?: boolean; quality?: ReplyQuality; closes?: readonly string[] } }): void;
  humanMessage(input: { contactKey: string; eventKey: string; at?: string }): void;
  humanResume(input: { contactKey: string; operationId: string }): void;
  artifact(input: { from: string; key: string; kind: "RECIPE" | "QUOTE"; studyIds: readonly string[]; unrecognized?: number }): void;
  // Espera (acotada) a que terminen las escrituras pendientes. Nunca lanza. Quien responde a Kapso lo usa dentro de waitUntil.
  flush(timeoutMs?: number): Promise<void>;
}

const safeId = (value: string) => /^[A-Za-z0-9_.=:+/-]{1,128}$/.test(value);

export function createConversationRecorder(options: {
  store: ConversationStore;
  contactKeyFor(phone: string): string | undefined;
  log(event: string, data: Record<string, unknown>): void;
  now?: () => number;
  retentionDays?: number;
}): ConversationRecorder {
  const clock = options.now ?? Date.now;
  // Reloj estrictamente creciente: dos hechos del mismo proceso en el mismo milisegundo (la receta leída y su cotización) conservan su orden aunque sus escrituras lleguen a la base al revés.
  let lastTick = 0;
  const now = () => (lastTick = Math.max(clock(), lastTick + 1));
  const inflight = new Set<Promise<void>>();
  // Instante con que ESTE proceso observó cada lote (por id de mensaje): la respuesta lo declara para no dar por atendido lo que llegó mientras respondía. Acotado; solo vive lo que dura la ejecución.
  const observedAt = new Map<string, number>();

  const write = (contactKey: string | undefined, event: ConversationEvent): void => {
    if (!contactKey || !safeId(event.id)) return;
    const task: Promise<void> = (async () => {
      try {
        const result = await options.store.append(contactKey, [encodeEvent(event)], options.retentionDays);
        options.log("conv_state", { op: "WRITE", kind: event.type, outcome: result.recorded > 0 ? "RECORDED" : "DUPLICATE" });
      } catch (error) {
        // Nunca el texto del error ni el contenido: solo el tipo de evento y el código (estado HTTP / código del servidor) del fallo.
        options.log("conv_state_write_failed", { eventType: event.type, ...auditErrorFields(error) });
      }
    })().finally(() => inflight.delete(task));
    inflight.add(task);
  };

  return {
    mode: "shadow",
    patientBatch({ from, turns, paused }) {
      try {
        const claimed = turns.filter((turn) => safeId(turn.messageId));
        const items = patientItemsOf(claimed);
        if (items.length === 0) return;
        // El instante de OBSERVACIÓN (reloj propio, estrictamente creciente y con precisión de milisegundo), no la marca de Kapso (precisión de segundo): así un lote siempre queda antes de la respuesta que le
        // da el mismo proceso y después de las respuestas anteriores, aunque ocurran en el mismo segundo.
        const at = now();
        for (const turn of claimed) {
          observedAt.set(turn.messageId, at);
          if (observedAt.size > 200) observedAt.delete(observedAt.keys().next().value!);
        }
        write(options.contactKeyFor(from), { id: `batch:${claimed[0]!.messageId}`, type: "PATIENT_BATCH", at, items, ...(paused ? { paused: true } : {}) });
      } catch {
        // la sombra nunca interrumpe un turno
      }
    },
    agentReply({ from, messageId, replyTo, reply }) {
      try {
        write(options.contactKeyFor(from), { id: `reply:${safeId(messageId) ? messageId : replyTo}`, type: "AGENT_REPLY", at: now(), quality: replyQualityOf(reply), ...(reply.closes && reply.closes.length > 0 ? { closes: reply.closes.filter(safeId).slice(0, 10) } : {}), ...(observedAt.has(replyTo) ? { upto: observedAt.get(replyTo)! } : {}) });
      } catch {
        // idem
      }
    },
    // Como todo evento, se fecha con el instante de OBSERVACIÓN (reloj propio en milisegundos): la marca de Kapso tiene precisión de segundo y, mezclada con estos instantes, ordenaría mal «el paciente escribió»,
    // «la recepción contestó» y «el agente respondió» cuando ocurren en el mismo segundo. `at` se acepta por compatibilidad y no se usa.
    humanMessage({ contactKey, eventKey }) {
      write(contactKey, { id: `human:${eventKey}`, type: "HUMAN_MESSAGE", at: now() });
    },
    humanResume({ contactKey, operationId }) {
      write(contactKey, { id: `resume:${operationId}`, type: "HUMAN_RESUME", at: now() });
    },
    artifact({ from, key, kind, studyIds, unrecognized }) {
      try {
        const ids = [...new Set(studyIds)].filter(safeId).slice(0, 60);
        write(options.contactKeyFor(from), { id: `${kind.toLowerCase()}:${key}`, type: "ARTIFACT", at: now(), artifact: { id: `${kind === "RECIPE" ? "R" : "Q"}:${key}`.slice(0, 128), kind, studyIds: ids, unrecognized: Math.max(0, Math.min(999, Math.trunc(unrecognized ?? 0))) } });
      } catch {
        // idem
      }
    },
    async flush(timeoutMs = CONVERSATION_DEFAULTS.flushMs) {
      if (inflight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...inflight]), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}

// ───────────────────────────── configuración ─────────────────────────────

// La memoria persistente es parte NORMAL del agente conversacional: se enciende con la misma bandera (la bandera del agente conversacional) y no tiene variables propias. Exige la migración 24, PLUSMEDIK_CONTACT_HMAC_KEY
// y KAPSO_PHONE_NUMBER_ID; si la base no responde, el agente decide con los mensajes recientes del historial y nunca se detiene.
export function resolveConversationState(
  env: Record<string, string | undefined>,
  log: (event: string, data: Record<string, unknown>) => void,
  options: { contactKeyFor?: (phone: string) => string | undefined; store?: ConversationStore; now?: () => number }
): ConversationRecorder | undefined {
  if (env.PLUSMEDIK_LLM_CONVERSATION?.trim().toLowerCase() !== "on") return undefined;
  return createConversationRecorder({
    store: options.store ?? createSupabaseConversationStore(),
    contactKeyFor: options.contactKeyFor ?? (() => undefined),
    log,
    ...(options.now ? { now: options.now } : {})
  });
}
