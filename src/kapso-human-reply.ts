// ¿Una persona ya le escribió al paciente desde WhatsApp Business mientras el agente preparaba su respuesta?
//
// La pausa por atención humana se aplica cuando llega a nuestro webhook el eco del mensaje de la persona (src/human-control.ts). Ese eco tarda 1-2 s, y el agente tarda ~20-30 s en preparar su respuesta
// (espera de Kapso + modelo): si la persona escribe justo en ese intervalo, la comprobación final de la reserva (confirmSend) todavía no ve la pausa y salen las DOS respuestas. Caso real (21-nov, 01:18):
// la Dra escribió a las 01:18:07, el eco pausó al contacto a las 01:18:09 y la respuesta del agente salió en ese mismo segundo.
//
// Kapso guarda el mensaje de la persona apenas WhatsApp se lo entrega: justo antes de enviar se le pregunta por los salientes de origen `business_app` a este número posteriores al mensaje del paciente.
// Si hay uno, se registra la pausa con la MISMA clave de evento que usa el webhook (`human_business_app:<id>`), así que cuando llegue el eco será un duplicado inofensivo. La comprobación final de siempre
// ve la pausa y libera la reserva sin enviar: este módulo no decide nada por su cuenta.
//
// Mejor esfuerzo: ante cualquier error o demora no se registra nada (el envío sigue como antes). Solo lee hora, origen, destinatario e id; nunca el texto.

import type { AttentionRepository } from "./human-control.js";

export interface KapsoOutboundQuery {
  (input: { phoneNumberId: string; direction: "outbound"; since: string; limit: number; fields: string }): Promise<{ data?: unknown[] }>;
}

export type HumanReplyOutcome = "PAUSED" | "NONE" | "UNKNOWN";

const digits = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : "");
const MESSAGE_ID = /^[A-Za-z0-9_.=:-]{1,180}$/;

// Primer mensaje saliente de una persona (WhatsApp Business) a este paciente posterior a `afterSeconds`.
export function humanReplyIn(rows: readonly unknown[], patientPhone: string, afterSeconds: number): { messageId: string; occurredAt: string } | undefined {
  const patient = digits(patientPhone);
  if (!patient) return undefined;
  let found: { messageId: string; at: number } | undefined;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const message = row as { id?: unknown; to?: unknown; timestamp?: unknown; kapso?: { direction?: unknown; origin?: unknown; phoneNumber?: unknown; phone_number?: unknown } };
    const kapso = message.kapso ?? {};
    if (kapso.direction !== undefined && kapso.direction !== "outbound") continue;
    if (typeof kapso.origin !== "string" || kapso.origin.toLowerCase() !== "business_app") continue;
    const recipient = digits(message.to) || digits(kapso.phoneNumber) || digits(kapso.phone_number);
    if (recipient !== patient) continue;
    const at = Number(message.timestamp);
    if (!Number.isFinite(at) || at <= afterSeconds) continue;
    if (typeof message.id !== "string" || !MESSAGE_ID.test(message.id)) continue;
    if (!found || at < found.at) found = { messageId: message.id, at };
  }
  return found ? { messageId: found.messageId, occurredAt: new Date(found.at * 1000).toISOString() } : undefined;
}

export function createHumanReplyCheck(options: {
  query: KapsoOutboundQuery;
  phoneNumberId: () => string;
  attention: Pick<AttentionRepository, "registerHumanMessage">;
  timeoutMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}): (input: { from: string; contactKey: string; afterSeconds: number }) => Promise<HumanReplyOutcome> {
  const timeoutMs = options.timeoutMs ?? 2500;
  return async ({ from, contactKey, afterSeconds }) => {
    if (!digits(from) || !contactKey || !Number.isFinite(afterSeconds)) return "UNKNOWN";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<"TIMEOUT">((resolve) => { timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs); });
      const result = await Promise.race([
        options.query({ phoneNumberId: options.phoneNumberId(), direction: "outbound", since: new Date(afterSeconds * 1000).toISOString(), limit: 50, fields: "kapso(direction,origin,phone_number)" }),
        timeout
      ]);
      if (timer) clearTimeout(timer);
      if (result === "TIMEOUT") {
        options.log?.("kapso_human_reply", { outcome: "TIMEOUT" });
        return "UNKNOWN";
      }
      const human = humanReplyIn(Array.isArray(result.data) ? result.data : [], from, afterSeconds);
      if (!human) return "NONE";
      // Misma clave que el webhook (src/kapso-webhook.ts, registerControlEvent): el eco que llegue después es un duplicado.
      const registered = await options.attention.registerHumanMessage({ eventKey: `human_business_app:${human.messageId}`, contactKey, occurredAt: human.occurredAt });
      options.log?.("kapso_human_reply", { outcome: "PAUSED", registration: registered.outcome });
      return "PAUSED";
    } catch {
      options.log?.("kapso_human_reply", { outcome: "ERROR" });
      return "UNKNOWN";
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
