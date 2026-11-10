/**
 * Puerta estricta de activación del piloto de cotización por texto.
 *
 * Con PLUSMEDIK_TEXT_PILOT_GUARD=on, PLUSMEDIK_AGENT_CONTROL_PHONES sigue
 * exigiendo exactamente UN teléfono piloto original (no se amplía el control CRM).
 * PLUSMEDIK_TEXT_PILOT_EXTRA_PHONES puede añadir hasta dos contactos a los
 * turnos de texto, conservando el flujo de imágenes de los demás pacientes.
 * ALLOWED_PHONES, si está definida, debe incluir a todos los pilotos.
 * Se falla cerrado ante cualquier error. Nunca registrar números del piloto.
 */
export type TextPilotGate =
  | { enabled: false; ready: true }
  | { enabled: true; ready: true; pilotPhone: string; extraPhones?: readonly string[] }
  | { enabled: true; ready: false; reason: "INVALID_FLAG" | "PILOT_SCOPE_MISSING_OR_MISMATCH" };

const PHONE = /^[+]?[0-9]{8,15}$/;
const normalizePhone = (value: string) => value.replace(/^[+]/, "");

function exactlyOnePhone(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 1 || !PHONE.test(parts[0]!)) return undefined;
  return normalizePhone(parts[0]!);
}

function parseExtraPhones(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return [];
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length > 2 || parts.some((s) => !PHONE.test(s))) return undefined;
  const normalized = parts.map(normalizePhone);
  if (new Set(normalized).size !== normalized.length) return undefined;
  return normalized;
}

function arePilotsAllowedByExistingFilter(pilots: readonly string[], raw: string | undefined): boolean {
  if (!raw?.trim()) return true; // ALLOWED_PHONES vacío = todos, como antes.
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.some((s) => !PHONE.test(s))) return false;
  const allowed = new Set(parts.map(normalizePhone));
  return pilots.every((pilot) => allowed.has(pilot));
}

export function resolveTextPilotGate(env: Record<string, string | undefined>): TextPilotGate {
  const flag = env.PLUSMEDIK_TEXT_PILOT_GUARD?.trim().toLowerCase();
  if (flag === undefined || flag === "" || flag === "off") return { enabled: false, ready: true };
  if (flag !== "on") return { enabled: true, ready: false, reason: "INVALID_FLAG" };

  const pilotPhone = exactlyOnePhone(env.PLUSMEDIK_AGENT_CONTROL_PHONES);
  const extraPhones = parseExtraPhones(env.PLUSMEDIK_TEXT_PILOT_EXTRA_PHONES);
  if (!pilotPhone || !extraPhones || extraPhones.includes(pilotPhone)
      || !arePilotsAllowedByExistingFilter([pilotPhone, ...extraPhones], env.ALLOWED_PHONES)) {
    return { enabled: true, ready: false, reason: "PILOT_SCOPE_MISSING_OR_MISMATCH" };
  }
  return extraPhones.length === 0
    ? { enabled: true, ready: true, pilotPhone }
    : { enabled: true, ready: true, pilotPhone, extraPhones };
}
