/**
 * Puerta estricta de activación del piloto de cotización por texto.
 *
 * Con PLUSMEDIK_TEXT_PILOT_GUARD=on, se exige UN solo teléfono piloto en
 * PLUSMEDIK_AGENT_CONTROL_PHONES. ALLOWED_PHONES es una política INDEPENDIENTE
 * del webhook anterior: puede estar vacía (todos) o contener varios teléfonos,
 * pero si está limitada DEBE incluir al piloto.
 *
 * La puerta devuelve un número únicamente para el ruteo interno; nunca debe
 * aparecer en logs o errores. Los otros contactos conservan la ruta de imagen
 * sin turnos. Apagada por defecto = comportamiento previo sin cambios.
 */
export type TextPilotGate =
  | { enabled: false; ready: true }
  | { enabled: true; ready: true; pilotPhone: string }
  | { enabled: true; ready: false; reason: "INVALID_FLAG" | "PILOT_SCOPE_MISSING_OR_MISMATCH" };

const PHONE = /^[+]?[0-9]{8,15}$/;
const normalizePhone = (value: string) => value.replace(/^[+]/, "");

function exactlyOnePhone(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 1 || !PHONE.test(parts[0]!)) return undefined;
  return normalizePhone(parts[0]!);
}

function isPilotAllowedByExistingFilter(pilot: string, raw: string | undefined): boolean {
  if (!raw?.trim()) return true; // ALLOWED_PHONES vacío = todos, como antes.
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.some((s) => !PHONE.test(s))) return false;
  return parts.map(normalizePhone).includes(pilot);
}

export function resolveTextPilotGate(env: Record<string, string | undefined>): TextPilotGate {
  const flag = env.PLUSMEDIK_TEXT_PILOT_GUARD?.trim().toLowerCase();
  if (flag === undefined || flag === "" || flag === "off") return { enabled: false, ready: true };
  if (flag !== "on") return { enabled: true, ready: false, reason: "INVALID_FLAG" };

  const pilot = exactlyOnePhone(env.PLUSMEDIK_AGENT_CONTROL_PHONES);
  if (!pilot || !isPilotAllowedByExistingFilter(pilot, env.ALLOWED_PHONES)) {
    return { enabled: true, ready: false, reason: "PILOT_SCOPE_MISSING_OR_MISMATCH" };
  }
  return { enabled: true, ready: true, pilotPhone: pilot };
}
