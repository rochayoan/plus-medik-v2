// ¿El paciente ya escribió algo DESPUÉS del saludo que Kapso todavía no entregó al webhook?
//
// Kapso agrupa los mensajes de un contacto ~20 s antes de mandarlos (docs/g6/01-buffer-nativo-kapso.md). La espera del menú (GREETING_WAIT_MS) solo ve los mensajes ya entregados, así que un «necesito
// cotizar» escrito ~35 s después del «buen día» seguía retenido en Kapso cuando el menú salía (caso real del 21-nov: el mensaje estaba en Kapso 6 s antes de enviarse el menú). Kapso guarda el mensaje
// apenas lo recibe de WhatsApp: se le pregunta directamente por los entrantes de este número posteriores al saludo.
//
// Mejor esfuerzo: ante cualquier error o demora responde false (el menú sale como antes). Solo lee hora y remitente; nunca el texto.

export interface KapsoMessageQuery {
  (input: { phoneNumberId: string; direction: "inbound"; since: string; limit: number; fields: string }): Promise<{ data?: unknown[] }>;
}

const digits = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : "");

export function createPendingInboundCheck(options: {
  query: KapsoMessageQuery;
  phoneNumberId: () => string;
  timeoutMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}): (from: string, afterSeconds: number) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 3000;
  return async (from, afterSeconds) => {
    const patient = digits(from);
    if (!patient || !Number.isFinite(afterSeconds)) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"TIMEOUT">((resolve) => { timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs); });
      const result = await Promise.race([
        options.query({ phoneNumberId: options.phoneNumberId(), direction: "inbound", since: new Date(afterSeconds * 1000).toISOString(), limit: 50, fields: "kapso(direction,phone_number)" }),
        timeout
      ]);
      if (result === "TIMEOUT") {
        options.log?.("kapso_pending_inbound", { outcome: "TIMEOUT" });
        return false;
      }
      const rows = Array.isArray(result.data) ? result.data : [];
      return rows.some((row) => {
        if (typeof row !== "object" || row === null) return false;
        const message = row as { from?: unknown; timestamp?: unknown; kapso?: { phoneNumber?: unknown; phone_number?: unknown; direction?: unknown } };
        if (message.kapso?.direction !== undefined && message.kapso.direction !== "inbound") return false;
        const sender = digits(message.from) || digits(message.kapso?.phoneNumber) || digits(message.kapso?.phone_number);
        return sender === patient && Number(message.timestamp) > afterSeconds;
      });
    } catch {
      options.log?.("kapso_pending_inbound", { outcome: "ERROR" });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
