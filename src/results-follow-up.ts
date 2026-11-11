export const RESULTS_CHECK_SIGNATURE = "RESULTS_READY_CHECK";
export const AWAITING_PERSON_HOURS = 6;

// ¿Se le envió a este contacto, en las últimas 6 horas, el mensaje que pide el nombre del paciente o el comprobante para verificar un resultado? Lee el registro de firmas de respuesta (código cerrado, sin
// texto) del guarda de respuestas. Si un humano ya respondió, el contacto queda en pausa humana y el agente calla de todos modos. Ante cualquier duda o error dice «no» (el flujo normal).
export function createAwaitingPersonCheck(options: { baseUrl?: string; serviceKey?: string; fetchFn?: typeof fetch; timeoutMs?: number; now?: () => number } = {}): (contactKey: string) => Promise<boolean> {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  return async (contactKey) => {
    if (!baseUrl || !serviceKey || !/^[0-9a-f]{64}$/.test(contactKey)) return false;
    try {
      const since = new Date(now() - AWAITING_PERSON_HOURS * 3_600_000).toISOString();
      const response = await fetchFn(`${baseUrl}/rest/v1/plusmedik_reply_guard_marks?contact_key=eq.${contactKey}&signature=eq.${RESULTS_CHECK_SIGNATURE}&created_at=gte.${encodeURIComponent(since)}&select=run_id&limit=1`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 2500)
      });
      if (!response.ok) return false;
      const rows = (await response.json().catch(() => undefined)) as unknown;
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false;
    }
  };
}
