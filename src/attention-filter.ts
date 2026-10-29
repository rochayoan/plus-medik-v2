import { createHash } from "node:crypto";
import { plain, words } from "./text-normalize.js";
import type { TextCategory } from "./text-handler.js";

// Atención selectiva (G6.0, APAGADA por defecto: PLUSMEDIK_ATTENTION_FILTER). Decide, con reglas deterministas y ANTES de cualquier modelo, visión o consulta costosa, si un mensaje de
// texto merece atención. Principio rector: CONSERVADOR. Solo se descarta lo que, por construcción, no contiene ninguna solicitud: un saludo aislado, una cortesía o un agradecimiento hecho
// SOLO de palabras de un vocabulario cerrado, un mensaje sin letras (emoji, signos) y la repetición literal de un mensaje reciente. Ante cualquier duda —una posible solicitud de análisis, una
// pregunta, un tema de salud o de una persona, un horario, una palabra que no está en el vocabulario— el mensaje SE PROCESA.
//
// Lo que este módulo NO hace: no toca la red ni la base, no llama a modelos y no guarda el texto del paciente (solo una huella de sesión en memoria, que caduca). Las excepciones de seguridad
// (urgencias y temas médicos, pedir a una persona, mensajes largos que requieren a una persona) nunca se descartan aquí.

export type IgnoreReason = "GREETING_ALONE" | "COURTESY_ALONE" | "NOISE" | "REPEAT";
export type AttentionDecision = { action: "PROCESS" } | { action: "IGNORE"; reason: IgnoreReason };

export interface SocialMessage {
  kind: "GREETING" | "COURTESY" | "NOISE";
}

// Vocabulario CERRADO de saludos y cortesías. Ninguna palabra de aquí nombra un estudio, un precio, un horario ni un pedido: un mensaje hecho solo de estas palabras no pide nada.
const GREETING_VOCAB = new Set(["hola", "holaa", "holaaa", "buenas", "buenos", "buen", "dia", "dias", "tarde", "tardes", "noche", "noches", "hey", "saludos", "que", "tal", "como", "estas", "esta", "estan", "doctor", "doctora", "amigos", "amigo", "amiga", "equipo"]);
const COURTESY_VOCAB = new Set([
  "gracias", "muchas", "mil", "muchisimas", "muy", "agradezco", "agradecido", "agradecida", "te", "le", "les", "lo", "por", "su", "tu", "la", "el", "ayuda", "atencion", "amabilidad", "amable", "amables", "atento", "atentos", "respuesta", "informacion", "tiempo",
  "rapida", "rapido", "bendiciones", "dios", "bendiga", "hasta", "luego", "chao", "chau", "adios", "igualmente", "excelente", "perfecto", "perfecta", "genial", "super", "bien", "bueno", "buenisimo",
  "ok", "okay", "vale", "listo", "lista", "entendido", "claro", "enterado", "enterada", "anotado", "recibido", "de", "nada", "no", "si", "dale", "correcto", "exacto", "ya", "eso", "es", "todo", "nomas", "solo", "mas",
  "cuidese", "cuidate", "un", "abrazo", "feliz", "gusto", "mucho", "favor", "thanks", "gracia"
]);
// Una cortesía necesita al menos UNA palabra ancla (agradecimiento, acuse, despedida): sin ella («por favor», «ayuda») no se descarta nada.
const ANCHOR = new Set(["gracias", "gracia", "thanks", "agradezco", "agradecido", "agradecida", "ok", "okay", "vale", "listo", "lista", "entendido", "claro", "enterado", "enterada", "anotado", "recibido", "perfecto", "perfecta", "genial", "excelente", "super", "bien", "bueno", "buenisimo", "dale", "correcto", "exacto", "adios", "chao", "chau", "hasta", "bendiciones", "igualmente", "si", "no", "cuidese", "cuidate", "abrazo", "saludos"]);
// Ninguna de estas palabras puede aparecer en una cortesía: si aparece, hay algo más que cortesía.
const NOT_JUST_SOCIAL = /\b(cotiz\w*|precio\w*|cuesta\w*|costo\w*|estudio\w*|analisis|examen\w*|receta\w*|horario\w*|urgen\w*|dolor\w*|persona|asesor\w*|ayudar|ayudame|necesito|quiero|quisiera)\b/;
const LAUGH = /^(?:(?:[jh][aeiou]){2,}[jh]?|xd+|lol)$/;
// Con un «no» solo se descarta el rechazo cortés («no, gracias», «nada más, gracias»). «no entiendo», «no está bien», «no hay» y demás negaciones son mensajes con contenido.
const NO_REPLY_OK = new Set(["no", "gracias", "gracia", "muchas", "muchisimas", "mil", "thanks", "nada", "mas", "eso", "es", "todo", "por", "ahora", "ya", "nomas", "solo", "favor"]);
const MAX_SOCIAL_TOKENS = 8;
const MAX_NOISE_CHARS = 24;

// ¿El mensaje es solo un saludo, una cortesía o ruido? Devuelve undefined si podría contener cualquier otra cosa.
export function socialOf(text: string): SocialMessage | undefined {
  const raw = text.trim();
  if (raw === "" || raw.length > 160) return undefined;
  // Un signo de pregunta suele ser un mensaje con contenido («?», «¿hola?» —¿hay alguien?—, «¿gracias?»). Solo un saludo de varias palabras lo admite («hola, ¿cómo están?»).
  const question = /[?¿]/.test(raw);
  const tokens = words(plain(raw));
  if (tokens.length === 0) {
    // Sin letras ni cifras: emoji o signos (un pulgar arriba incluido: un acuse no confirma nada).
    return raw.length <= MAX_NOISE_CHARS && !question ? { kind: "NOISE" } : undefined;
  }
  if (tokens.length > MAX_SOCIAL_TOKENS) return undefined;
  if (tokens.every((token) => LAUGH.test(token))) return question ? undefined : { kind: "NOISE" };
  if (NOT_JUST_SOCIAL.test(tokens.join(" "))) return undefined;
  if (tokens.includes("no") && !tokens.every((token) => NO_REPLY_OK.has(token))) return undefined;
  if (tokens.every((token) => GREETING_VOCAB.has(token))) return question && tokens.length < 2 ? undefined : { kind: "GREETING" };
  if (tokens.every((token) => GREETING_VOCAB.has(token) || COURTESY_VOCAB.has(token)) && (tokens.some((token) => ANCHOR.has(token)) || tokens.join(" ") === "de nada") && !question) {
    return { kind: "COURTESY" };
  }
  return undefined;
}

// La decisión sobre un mensaje YA clasificado por el manejador de texto. Sin contexto de la conversación: las respuestas que dependen de una solicitud abierta («sí», «el segundo», «eso nomás»)
// las atienden primero las sesiones; lo que llega aquí son los mensajes que NINGUNA solicitud abierta reclamó.
export function decideAttention(text: string, category: TextCategory): AttentionDecision {
  // Seguridad primero: urgencias y temas médicos, pedir a una persona (y los mensajes tan largos que requieren a una persona) nunca se descartan.
  if (category === "MEDICAL" || category === "HUMAN_REQUEST") return { action: "PROCESS" };
  const social = socialOf(text);
  if (!social) return { action: "PROCESS" };
  return { action: "IGNORE", reason: social.kind === "GREETING" ? "GREETING_ALONE" : social.kind === "NOISE" ? "NOISE" : "COURTESY_ALONE" };
}

// ───────────────────────────── repeticiones ─────────────────────────────

// ¿Este mensaje puede descartarse si es una repetición literal? No las respuestas cortas a una pregunta («sí», «2», «listo»), no lo médico ni lo humano y no los mensajes de una sola palabra.
export function repeatCandidate(text: string, category: TextCategory, isSessionShaped: boolean): boolean {
  if (category === "MEDICAL" || category === "HUMAN_REQUEST" || isSessionShaped) return false;
  return words(plain(text.slice(0, 1500))).length >= 2;
}

// Memoria de corta duración (por instancia, MEJOR ESFUERZO) de los mensajes recién procesados de cada contacto. Guarda solo una huella SHA-256 (sin el texto) y caduca sola. Si la instancia cambia o la
// huella caduca, el mensaje se procesa: la falla es siempre hacia procesar, nunca hacia perder una solicitud.
export interface RepeatTracker {
  // true si este mismo mensaje (mismo contacto, mismo texto normalizado) ya se procesó dentro de la ventana; si no, lo registra y devuelve false. Una repetición NO prolonga la ventana.
  seen(from: string, text: string): boolean;
  // El mensaje no llegó a buen término (falla técnica, sin envío): si el paciente lo repite, debe procesarse.
  forget(from: string, text: string): void;
}

export interface MemoryOptions {
  now?: () => number;
  maxEntries?: number;
}

const fingerprint = (from: string, text: string): string => createHash("sha256").update(`${from}\u0000${plain(text.slice(0, 1500))}`).digest("hex").slice(0, 24);

export function createRepeatTracker(options: MemoryOptions & { windowMs: number }): RepeatTracker {
  const now = options.now ?? Date.now;
  const max = options.maxEntries ?? 2000;
  const entries = new Map<string, number>();
  const prune = (at: number) => {
    if (entries.size < max) return;
    for (const [key, expires] of entries) if (expires <= at) entries.delete(key);
    // Todavía lleno: se descartan los más antiguos (el Map conserva el orden de inserción).
    for (const key of entries.keys()) {
      if (entries.size < max) break;
      entries.delete(key);
    }
  };
  return {
    seen(from, text) {
      const at = now();
      const key = fingerprint(from, text);
      const expires = entries.get(key);
      if (expires !== undefined && expires > at) return true;
      prune(at);
      entries.set(key, at + options.windowMs);
      return false;
    },
    forget(from, text) {
      entries.delete(fingerprint(from, text));
    }
  };
}

// ───────────────────────────── agrupar mensajes seguidos ─────────────────────────────

// Cuando un paciente escribe varios mensajes seguidos, cada uno que acumula estudios tomaría su "turno" para responder. La puerta ordena los mensajes de cada contacto por el número de turno que les dio la base
// (el orden REAL de llegada; por instancia, MEJOR ESFUERZO): quien espera un instante antes de confirmar comprueba si llegó uno más nuevo QUE TAMBIÉN va a responder y, si es así, calla (su estudio YA quedó anotado;
// el más nuevo ve todos los estudios y confirma todo junto). Un mensaje que no va a responder por esta vía (un saludo ignorado, una pregunta que atiende otro manejador) se "retira" y no silencia a nadie. Si la
// instancia cambia, se responde como antes: nunca se pierde un mensaje, a lo sumo hay una confirmación de más.
export interface ReplyGate {
  // seq: el número de turno que asignó la base; sin él se usa el orden de llamada. Devuelve el número del mensaje en la puerta.
  enter(from: string, seq?: number): number;
  retire(from: string, ticket: number): void;
  isLatest(from: string, ticket: number): boolean;
}

export function createReplyGate(options: MemoryOptions & { ttlMs?: number } = {}): ReplyGate {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 120_000;
  const max = options.maxEntries ?? 2000;
  const entries = new Map<string, { highest: number; live: Map<number, number>; at: number }>();
  const key = (from: string) => createHash("sha256").update(from).digest("hex").slice(0, 24);
  return {
    enter(from, seq) {
      const at = now();
      const id = key(from);
      if (entries.size >= max) for (const [other, entry] of entries) if (at - entry.at > ttlMs) entries.delete(other);
      const entry = entries.get(id) ?? { highest: 0, live: new Map<number, number>(), at };
      const ticket = seq !== undefined && Number.isSafeInteger(seq) && seq > 0 ? seq : entry.highest + 1;
      entry.highest = Math.max(entry.highest, ticket);
      entry.live.set(ticket, at);
      entry.at = at;
      entries.set(id, entry);
      return ticket;
    },
    retire(from, ticket) {
      entries.get(key(from))?.live.delete(ticket);
    },
    isLatest(from, ticket) {
      const entry = entries.get(key(from));
      if (!entry?.live.has(ticket)) return true;
      const at = now();
      for (const [other, enteredAt] of entry.live) if (other > ticket && at - enteredAt <= ttlMs) return false;
      return true;
    }
  };
}

// ───────────────────────────── configuración ─────────────────────────────

export interface AttentionConfig {
  repeats: RepeatTracker;
  gate: ReplyGate;
  // Cuánto espera una confirmación de "anotado" antes de enviarse, para que un mensaje más nuevo la reemplace (0 = no espera ni agrupa).
  settleMs: number;
}

export type AttentionResolution = { enabled: false } | { enabled: true; config: AttentionConfig } | { enabled: true; error: string };

export const DEFAULT_REPEAT_SECONDS = 90;
export const DEFAULT_SETTLE_MS = 2000;

const integerIn = (value: string | undefined, min: number, max: number): number | undefined | "INVALID" => {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{1,6}$/.test(value.trim())) return "INVALID";
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : "INVALID";
};

// PLUSMEDIK_ATTENTION_FILTER=on (exacto) la activa. Opcionales: PLUSMEDIK_ATTENTION_REPEAT_SECONDS (5–600, por defecto 90) y PLUSMEDIK_ATTENTION_SETTLE_MS (0–10000, por defecto 2000). Un valor inválido NO se corrige
// en silencio: el filtro queda APAGADO (todo se procesa como antes) y se informa un código.
export function resolveAttentionFilter(env: Record<string, string | undefined>): AttentionResolution {
  if (env.PLUSMEDIK_ATTENTION_FILTER?.trim().toLowerCase() !== "on") return { enabled: false };
  const repeatSeconds = integerIn(env.PLUSMEDIK_ATTENTION_REPEAT_SECONDS, 5, 600);
  if (repeatSeconds === "INVALID") return { enabled: true, error: "INVALID_REPEAT_SECONDS" };
  const settleMs = integerIn(env.PLUSMEDIK_ATTENTION_SETTLE_MS, 0, 10_000);
  if (settleMs === "INVALID") return { enabled: true, error: "INVALID_SETTLE_MS" };
  return { enabled: true, config: { repeats: createRepeatTracker({ windowMs: (repeatSeconds ?? DEFAULT_REPEAT_SECONDS) * 1000 }), gate: createReplyGate(), settleMs: settleMs ?? DEFAULT_SETTLE_MS } };
}
