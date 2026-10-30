/**
 * Puerta de despliegue piloto para G2/G4/G5.9 (texto y sesiones).
 *
 * Apagada por defecto: no cambia el comportamiento anterior del agente.
 * Con PLUSMEDIK_TEXT_PILOT_GUARD=on, exige que ALLOWED_PHONES y
 * PLUSMEDIK_AGENT_CONTROL_PHONES contengan exactamente el mismo número
 * internacional. Impide habilitar los turnos de todos los pacientes si alguien
 * dejó ALLOWED_PHONES sin definir (caso que el webhook interpreta como "todos").
 *
 * No lee ni devuelve los números en mensajes de error ni en logs.
 */
export type TextPilotGate =
  | { enabled: false; ready: true }
  | { enabled: true; ready: true }
  | { enabled: true; ready: false; reason: "INVALID_FLAG" | "PILOT_SCOPE_MISSING_OR_MISMATCH" };

const PHONE = new RegExp("^[+]?[0-9]{8,15}$");

function exactlyOnePhone(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 1 || !PHONE.test(parts[0]!)) return undefined;
  return parts[0]!.replace(/^[+]/, "");
}

export function resolveTextPilotGate(env: Record<string, string | undefined>): TextPilotGate {
  const flag = env.PLUSMEDIK_TEXT_PILOT_GUARD?.trim().toLowerCase();
  if (flag === undefined || flag === "" || flag === "off") return { enabled: false, ready: true };
  if (flag !== "on") return { enabled: true, ready: false, reason: "INVALID_FLAG" };

  const allowed = exactlyOnePhone(env.ALLOWED_PHONES);
  const controlled = exactlyOnePhone(env.PLUSMEDIK_AGENT_CONTROL_PHONES);
  if (!allowed || !controlled || allowed !== controlled) {
    return { enabled: true, ready: false, reason: "PILOT_SCOPE_MISSING_OR_MISMATCH" };
  }
  return { enabled: true, ready: true };
}
