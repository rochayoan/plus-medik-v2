import type { TurnContext } from "../guarded-turn.js";
import type { CatalogStudy } from "../types.js";
import type { CaseInput } from "./payload.js";

// Lo que el resto del agente necesita de la derivación al CRM (la implementa CrmOutbox). Nada aquí habla con el CRM directamente.
//
// Estado de un caso:
//   REGISTERED  el CRM respondió que creó el caso o que ya lo tenía (única condición para confirmarle algo al paciente)
//   PENDING     guardado en la cola y se reintentará (CRM apagado/sin el mensaje original/sin responder): NO se confirma nada
//   DEAD        la cola lo dio por perdido (rechazo permanente o intentos agotados): queda a la vista de una persona
//   FAILED      ni siquiera se pudo guardar en la cola (base caída, datos inválidos): NO se confirma nada
export type CaseState = "REGISTERED" | "PENDING" | "DEAD" | "FAILED";

export interface CaseOutcome {
  state: CaseState;
  eventId?: string;
  delivery?: "CREATED" | "DUPLICATE";
  // Código de motivo cuando no quedó registrado (nunca texto del servidor).
  code?: string;
}

export interface CrmHandoff {
  // Encola (idempotente por mensaje) y hace el primer intento en línea. Se ejecuta con el lease del turno en curso (ctx).
  submit(ctx: TurnContext, cases: readonly CaseInput[]): Promise<CaseOutcome[]>;
  // Deriva una solicitud de cotización cerrada en revisión (G4.0): un caso por mensaje dudoso, más uno anclado al mensaje de cierre si el motivo es de toda la solicitud.
  submitSessionReview(ctx: TurnContext, args: { sessionId: string; contactPhone: string; catalog: readonly CatalogStudy[] }): Promise<CaseOutcome[]>;
}
