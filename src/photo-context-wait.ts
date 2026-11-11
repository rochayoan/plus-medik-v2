import type { Produced, TurnProducer } from "./guarded-turn.js";

// Espera de contexto para una foto DUDOSA. Una foto que parece solicitud pero no se pudo cotizar (estudios sin identificar con certeza, borrosa) suele ir seguida, al rato, del texto con lo que el paciente
// pedía («amonio sérico», «panel respiratorio»). Antes de decir «no pude identificar…» se espera hasta N segundos: si el paciente escribe de nuevo, ese mensaje lo atiende por su cuenta (con contexto) y la
// respuesta de la foto se descarta; si no escribe nada, la foto responde como siempre. Una foto que sí se cotizó, o que se calla, no espera.

export const DEFAULT_PHOTO_CONTEXT_WAIT_SECONDS = 45;
const MAX_SECONDS = 120;

// PLUSMEDIK_PHOTO_CONTEXT_WAIT_SECONDS: vacío = 45 s; número 1–120 = esos segundos; off / 0 = sin espera.
export function resolvePhotoContextWaitMs(env: Record<string, string | undefined>): number {
  const raw = env.PLUSMEDIK_PHOTO_CONTEXT_WAIT_SECONDS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_PHOTO_CONTEXT_WAIT_SECONDS * 1000;
  if (raw === "off" || raw === "false" || raw === "0") return 0;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= MAX_SECONDS ? seconds * 1000 : DEFAULT_PHOTO_CONTEXT_WAIT_SECONDS * 1000;
}

// ¿Hay un turno más nuevo (cualquier mensaje) del contacto que el de esta foto? Lectura del contador de turnos del contacto; ante cualquier duda dice «no» (la foto responde como siempre).
export function createNewerTurnCheck(options: { baseUrl?: string; serviceKey?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {}): (contactKey: string, seq: number) => Promise<boolean> {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchFn = options.fetchFn ?? fetch;
  return async (contactKey, seq) => {
    if (!baseUrl || !serviceKey || !/^[0-9a-f]{64}$/.test(contactKey)) return false;
    try {
      const response = await fetchFn(`${baseUrl}/rest/v1/plusmedik_contact_turns?contact_key=eq.${contactKey}&select=last_seq&limit=1`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, signal: AbortSignal.timeout(options.timeoutMs ?? 2500) });
      if (!response.ok) return false;
      const rows = (await response.json().catch(() => undefined)) as unknown;
      const last = Array.isArray(rows) ? (rows[0] as { last_seq?: unknown } | undefined)?.last_seq : undefined;
      return typeof last === "number" && last > seq;
    } catch {
      return false;
    }
  };
}

export interface PhotoContextWaitOptions {
  waitMs: number;
  pollMs?: number;
  contactKeyFor(phone: string): string | undefined;
  newerTurn(contactKey: string, seq: number): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  log?(event: string, fields: Record<string, unknown>): void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Envuelve el productor de UNA foto que se atiende sola. Solo espera cuando la respuesta es un «no se pudo cotizar» que iba a enviarse.
export function withPhotoContextWait(producer: TurnProducer, from: string, options: PhotoContextWaitOptions): TurnProducer {
  const sleep = options.sleep ?? realSleep;
  const pollMs = options.pollMs ?? 3000;
  return async (ctx): Promise<Produced> => {
    const produced = await producer(ctx);
    if (options.waitMs <= 0 || produced.kind !== "reply" || produced.result !== "no_quote" || produced.quiet === true || ctx.seq === undefined) return produced;
    const contactKey = options.contactKeyFor(from);
    if (!contactKey) return produced;
    let waited = 0;
    while (waited < options.waitMs) {
      const step = Math.min(pollMs, options.waitMs - waited);
      await sleep(step);
      waited += step;
      if (await options.newerTurn(contactKey, ctx.seq)) {
        options.log?.("photo_context_wait", { outcome: "TEXT_ARRIVED", waitedMs: waited });
        // El mensaje nuevo lo atiende con su contexto: esta respuesta se descarta (la corrida se cierra sin respuesta).
        return { ...produced, quiet: true };
      }
    }
    options.log?.("photo_context_wait", { outcome: "NO_TEXT", waitedMs: waited });
    return produced;
  };
}
