import { createSupabaseRpc } from "./audit.js";
import type { MenuOption } from "./greeting-menu.js";

// Medición del MENÚ de intención (migración 26): cuándo salió, cuándo no salió porque el paciente siguió escribiendo, qué opción eligió y cómo (número o palabras). Solo códigos cerrados y la clave HMAC del
// contacto: nunca texto ni teléfonos. Mejor esfuerzo: nunca lanza ni retrasa la respuesta (si la migración no está aplicada, solo queda un código en el registro).

export type MenuEvent =
  | { event: "SHOWN" | "SKIPPED" | "INVALID_CHOICE" }
  | { event: "CHOSEN"; option: MenuOption["code"] | "OTHER"; via: "NUMBER" | "WORDS" };

export type MenuEventRecorder = (contactKey: string, event: MenuEvent) => Promise<void>;

export function createMenuEventRecorder(options: { rpc?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>; log?(event: string, data: Record<string, unknown>): void } = {}): MenuEventRecorder {
  let rpc = options.rpc;
  let failures = 0;
  return async (contactKey, event) => {
    if (!/^[0-9a-f]{64}$/.test(contactKey)) return;
    try {
      rpc ??= createSupabaseRpc({ requestTimeoutMs: 2000, retryDelayMs: 100 });
      await rpc("plusmedik_agent_menu_event", { p_contact_key: contactKey, p_event: event.event, p_option: event.event === "CHOSEN" ? event.option : null, p_via: event.event === "CHOSEN" ? event.via : null });
      failures = 0;
    } catch {
      // Un aviso por racha de fallos (p. ej. migración 26 sin aplicar), no uno por mensaje.
      if (failures++ === 0) options.log?.("agent_menu_event_unrecorded", {});
    }
  };
}
