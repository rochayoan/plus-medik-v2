import type { AttentionRepository } from "./human-control.js";

// Vencimiento de la pausa por atención humana. Una persona que escribe desde WhatsApp Business pausa al agente en ese contacto (src/human-control.ts), pero la pausa nunca vencía: un paciente atendido
// hace días y que vuelve a escribir se quedaba sin respuesta para siempre. Aquí, si el contacto sigue pausado y la última actividad humana fue hace más de N horas, se reanuda (misma función de la base
// que usa el CRM: plusmedik_attention_resume) justo antes de reclamar el turno. Si una persona vuelve a escribir, la pausa se reactiva sola. Cualquier fallo deja la pausa como está (falla cerrado).

export const DEFAULT_PAUSE_EXPIRY_HOURS = 12;
const MAX_HOURS = 24 * 30;

// PLUSMEDIK_PAUSE_EXPIRY_HOURS: vacío = 12 h; número entre 1 y 720 = esas horas; off / 0 / false = apagado (la pausa no vence).
export function resolvePauseExpiryHours(env: Record<string, string | undefined>): number | undefined {
  const raw = env.PLUSMEDIK_PAUSE_EXPIRY_HOURS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_PAUSE_EXPIRY_HOURS;
  if (raw === "off" || raw === "false" || raw === "0") return undefined;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 1 && hours <= MAX_HOURS ? hours : DEFAULT_PAUSE_EXPIRY_HOURS;
}

export interface PauseExpiryOptions {
  hours: number;
  attention: Pick<AttentionRepository, "resume">;
  baseUrl?: string;
  serviceKey?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type PauseExpiryOutcome = "RESUMED" | "KEPT" | "NOT_PAUSED" | "UNKNOWN";

export function createPauseExpiry(options: PauseExpiryOptions): (contactKey: string) => Promise<PauseExpiryOutcome> {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const limitMs = options.hours * 3_600_000;
  return async (contactKey) => {
    // La clave es un HMAC hexadecimal de 64 caracteres; cualquier otra cosa no se consulta.
    if (!baseUrl || !serviceKey || !/^[0-9a-f]{64}$/.test(contactKey)) return "UNKNOWN";
    try {
      const response = await fetchFn(`${baseUrl}/rest/v1/plusmedik_attention_contacts?contact_key=eq.${contactKey}&select=state,last_human_event_at&limit=1`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2500)
      });
      if (!response.ok) return "UNKNOWN";
      const rows = (await response.json().catch(() => undefined)) as unknown;
      const row = Array.isArray(rows) ? (rows[0] as { state?: unknown; last_human_event_at?: unknown } | undefined) : undefined;
      if (!row || row.state !== "HUMAN_PAUSED") return "NOT_PAUSED";
      const last = typeof row.last_human_event_at === "string" ? Date.parse(row.last_human_event_at) : Number.NaN;
      // Sin fecha de la última actividad humana no se asume nada: la pausa se conserva.
      if (!Number.isFinite(last) || now() - last < limitMs) return "KEPT";
      const result = await options.attention.resume(contactKey, "AUTO_PAUSE_EXPIRED", "agent");
      options.log?.("pause_expired", { result, hours: options.hours });
      return result === "RESUMED" ? "RESUMED" : "NOT_PAUSED";
    } catch {
      return "UNKNOWN";
    }
  };
}
