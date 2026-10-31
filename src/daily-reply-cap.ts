// Tope de respuestas del agente por contacto en una ventana móvil (APAGADO por defecto: PLUSMEDIK_DAILY_REPLY_CAP=on). Por defecto 5 respuestas cada 24 horas.
//
// Qué cuenta: cada respuesta que el agente reservó para enviar (texto, cotización, foto, aviso técnico); un envío incierto también cuenta. Los mensajes de las recepcionistas (CRM o WhatsApp
// Business) no son del agente: nunca se cuentan ni se limitan. El contador vive en Supabase (se deriva de las corridas de auditoría) y lo aplica la base dentro de la reserva de envío
// (migración 18), con el bloqueo por contacto: reintentos y mensajes simultáneos no duplican ni se saltan el tope. Al alcanzarlo el agente deja de responder a ese contacto hasta que
// sus respuestas más antiguas salgan de la ventana.
//
//   PLUSMEDIK_DAILY_REPLY_CAP=on            activa el tope (exige PLUSMEDIK_TURNS=on y la 18ª migración aplicada: sin ella no se envía nada, falla cerrado)
//   PLUSMEDIK_DAILY_REPLY_CAP_MAX           opcional, 1-1000 (por defecto 5)
//   PLUSMEDIK_DAILY_REPLY_CAP_HOURS         opcional, 1-168 (por defecto 24)
// Cualquier valor inválido deja el tope APAGADO y se registra solo un código.

export interface DailyReplyCap {
  max: number;
  windowSeconds: number;
}

export const DAILY_REPLY_CAP_DEFAULTS: DailyReplyCap = { max: 5, windowSeconds: 24 * 3600 };

export type DailyReplyCapConfigError = "TURNS_REQUIRED" | "INVALID_MAX" | "INVALID_HOURS";

function integerIn(value: string | undefined, min: number, max: number): number | undefined | "INVALID" {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{1,4}$/.test(value.trim())) return "INVALID";
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : "INVALID";
}

export function resolveDailyReplyCap(
  env: Record<string, string | undefined>,
  log: (event: string, data: Record<string, unknown>) => void,
  options: { turnsActive: boolean }
): DailyReplyCap | undefined {
  if (env.PLUSMEDIK_DAILY_REPLY_CAP?.trim().toLowerCase() !== "on") return undefined;
  const fail = (error: DailyReplyCapConfigError): undefined => {
    log("daily_reply_cap_config_invalid", { error });
    return undefined;
  };
  // Sin los turnos no hay corridas con contacto que contar.
  if (!options.turnsActive) return fail("TURNS_REQUIRED");
  const max = integerIn(env.PLUSMEDIK_DAILY_REPLY_CAP_MAX, 1, 1000);
  if (max === "INVALID") return fail("INVALID_MAX");
  const hours = integerIn(env.PLUSMEDIK_DAILY_REPLY_CAP_HOURS, 1, 168);
  if (hours === "INVALID") return fail("INVALID_HOURS");
  return { max: max ?? DAILY_REPLY_CAP_DEFAULTS.max, windowSeconds: hours !== undefined ? hours * 3600 : DAILY_REPLY_CAP_DEFAULTS.windowSeconds };
}
