import { plain } from "./text-normalize.js";

// Protección contra bucles y exceso de respuestas (G3.2). Tres capas, todas APAGADAS por defecto (PLUSMEDIK_REPLY_GUARD):
//   1. La BASE decide el tope y las señales de bucle dentro de la reserva de envío (migración 10, plusmedik_turn_reserve_send_guarded): atómico bajo el bloqueo del contacto,
//      compatible con la idempotencia, el fencing, 'busy', 'superseded' y la pausa humana. Aquí solo se arma la configuración que se le envía.
//   2. Un detector de MENSAJES AUTOMÁTICOS (respuestas automáticas de otros negocios, avisos de no responder, ecos de nuestros propios textos): a esos no se les responde jamás.
//   3. La firma de la respuesta (un código cerrado, sin texto) para detectar que se está dando una y otra vez la misma respuesta al mismo contacto.
// Solo se limita lo CONVERSACIONAL (texto y otros tipos). Una imagen y su cotización nunca se limitan.

export interface WindowRule {
  windowSeconds: number;
  max: number;
}

export interface ReplyGuardConfig {
  // Tope de respuestas conversacionales por contacto: cualquier regla excedida limita (ventana deslizante; se libera sola).
  rules: WindowRule[];
  // Ráfaga: tantos mensajes de texto entrantes en tan pocos segundos no son humanos -> supresión temporal.
  burst: WindowRule;
  // Repetición: la misma respuesta (firma) dada tantas veces al mismo contacto -> supresión temporal.
  repeat: WindowRule;
  // Cuánto dura una supresión (siempre caduca; la base la limita a 24 h).
  cooldownSeconds: number;
}

// Valores iniciales conservadores para un laboratorio pequeño: 8 respuestas en 10 min o 40 en un día; 8 mensajes en un minuto es una ráfaga; la misma respuesta 3 veces en 15 min
// es un bucle; la supresión dura 15 min. Se ajustan con PLUSMEDIK_REPLY_GUARD_CONFIG.
export const DEFAULT_REPLY_GUARD: ReplyGuardConfig = {
  rules: [
    { windowSeconds: 600, max: 8 },
    { windowSeconds: 86_400, max: 40 }
  ],
  burst: { windowSeconds: 60, max: 8 },
  repeat: { windowSeconds: 900, max: 3 },
  cooldownSeconds: 900
};

// Lo que viaja a la base en cada reserva: la configuración y la firma de ESTA respuesta (código cerrado).
export interface ReplyGuardRequest {
  config: ReplyGuardConfig;
  signature?: string;
}

export type ReplyGuardResolution = { enabled: false } | { enabled: true; config: ReplyGuardConfig } | { enabled: true; error: string };

const isInt = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isRule = (value: unknown, minMax: number): value is WindowRule => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const rule = value as Record<string, unknown>;
  return keys.length === 2 && keys.every((key) => key === "windowSeconds" || key === "max") && isInt(rule.windowSeconds, 1, 86_400) && isInt(rule.max, minMax, 1000);
};

// Mismos rangos que valida la base (plusmedik_reply_guard_valid): un valor fuera de rango se rechaza aquí con un código, nunca se corrige en silencio.
export function validateReplyGuardConfig(value: unknown): { ok: true; config: ReplyGuardConfig } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "CONFIG_NOT_OBJECT" };
  const input = value as Record<string, unknown>;
  const known = new Set(["rules", "burst", "repeat", "cooldownSeconds"]);
  if (Object.keys(input).some((key) => !known.has(key))) return { ok: false, error: "CONFIG_UNKNOWN_KEY" };
  const merged = { ...DEFAULT_REPLY_GUARD, ...input } as Record<string, unknown>;
  if (!Array.isArray(merged.rules) || merged.rules.length < 1 || merged.rules.length > 4 || !merged.rules.every((rule) => isRule(rule, 1))) return { ok: false, error: "CONFIG_RULES" };
  if (!isRule(merged.burst, 2)) return { ok: false, error: "CONFIG_BURST" };
  if (!isRule(merged.repeat, 2)) return { ok: false, error: "CONFIG_REPEAT" };
  if (!isInt(merged.cooldownSeconds, 1, 86_400)) return { ok: false, error: "CONFIG_COOLDOWN" };
  return { ok: true, config: merged as unknown as ReplyGuardConfig };
}

// PLUSMEDIK_REPLY_GUARD=on (exacto, como las demás banderas) la activa; PLUSMEDIK_REPLY_GUARD_CONFIG (JSON, opcional) ajusta los umbrales. Una configuración inválida con la
// guarda encendida NO se ignora ni se reemplaza por los valores iniciales: se informa y quien llama debe dejar de responder texto (falla cerrado).
export function resolveReplyGuard(env: Record<string, string | undefined>): ReplyGuardResolution {
  if (env.PLUSMEDIK_REPLY_GUARD?.trim().toLowerCase() !== "on") return { enabled: false };
  const raw = env.PLUSMEDIK_REPLY_GUARD_CONFIG?.trim();
  if (!raw) return { enabled: true, config: DEFAULT_REPLY_GUARD };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: true, error: "CONFIG_NOT_JSON" };
  }
  const checked = validateReplyGuardConfig(parsed);
  return checked.ok ? { enabled: true, config: checked.config } : { enabled: true, error: checked.error };
}

// Firma de una respuesta: categoría y temas, en un código cerrado (nunca el texto). La base solo acepta [A-Z0-9_.:-] hasta 64 caracteres.
export function replySignature(category: string, topics: readonly string[] = []): string {
  const clean = (value: string) => value.toUpperCase().replace(/[^A-Z0-9_.:-]/g, "_");
  return [clean(category), ...[...topics].map(clean).sort()].join(":").slice(0, 64);
}

// ───────────────────────────── mensajes automáticos ─────────────────────────────
// Un bot que escribe a un laboratorio no espera respuesta; contestarle abre un bucle. Esta lista es CONSERVADORA a propósito: reconoce frases de autorrespuesta que un paciente
// no escribiría (no «me llegó un mensaje automático», que es un paciente hablando de uno). Un falso negativo lo cubren el tope y las señales de bucle de la base; un falso
// positivo solo deja sin respuesta ese mensaje (jamás suprime al contacto) y queda auditado.
const AUTOMATED_STRONG: RegExp[] = [
  /^(respuesta|mensaje|aviso) automatic\w*\b/,
  /\b(este|esta|esto) (es|fue) (un |una )?(mensaje|respuesta|correo|aviso) (generad\w+ )?(de forma |de manera )?automatic\w*/,
  /\b(mensaje|respuesta|aviso|correo) (fue |ha sido |es )?(generad\w+|enviad\w+) (de forma |de manera |de modo )?automatic\w*/,
  /\bauto ?(respuesta|respuestas|reply|responder|responde)\b/,
  /\bautorr?espuesta\w*\b/,
  /\bno (me )?(responda|respondas|responder|conteste|contestes|contestar)(s)? (a )?(este|esta|el|la|ese|esa) (mensaje|correo|numero|chat|cuenta)\b/,
  /\bno (es posible )?(responder|contestar) a este (mensaje|numero|chat)\b/,
  /\b(do not|don t|dont) reply\b/,
  /\bno ?reply\b/,
  /\b(this is )?an? automat\w+ (message|response|reply|notification)\b/,
  /\bautomated (message|response|reply|notification)\b/,
  /\bout of (the )?office\b/,
  /\bfuera de (la )?oficina\b/
];
const THANKS_FOR_CONTACTING = /\bgracias por (comunicarte|comunicarse|contactarte|contactarnos|contactar|escribirnos|escribir|tu mensaje|su mensaje)\b/;
const AWAY = /\b(en este momento|por el momento|actualmente) (no (estamos|nos encontramos|podemos|me encuentro|estoy|hay)|fuera de)\b|\bte responderemos (lo antes posible|a la brevedad|en breve|pronto)\b|\bnuestro horario de atencion es\b|\bhorario de atencion\b.*\bdisponib/;

export function looksAutomated(text: string): boolean {
  const clipped = plain(text.slice(0, 1500));
  if (clipped === "") return false;
  if (AUTOMATED_STRONG.some((pattern) => pattern.test(clipped))) return true;
  return THANKS_FOR_CONTACTING.test(clipped) && AWAY.test(clipped);
}

// Eco de nuestros propios textos: si lo que llega es (el comienzo de) algo que NOSOTROS decimos, es un eco o un bot que nos devuelve la respuesta. Se compara por el comienzo
// normalizado (los primeros 40 caracteres) de cada texto fijo; los textos más cortos que eso no se usan (no distinguirían).
const ECHO_PREFIX = 40;
export function looksLikeOwnReply(text: string, ownTexts: readonly string[]): boolean {
  const clipped = plain(text.slice(0, 1500));
  if (clipped.length < ECHO_PREFIX) return false;
  return ownTexts.some((own) => {
    const prefix = plain(own).slice(0, ECHO_PREFIX);
    return prefix.length >= ECHO_PREFIX && clipped.includes(prefix);
  });
}
