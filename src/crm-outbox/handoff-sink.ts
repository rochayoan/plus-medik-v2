import type { HandoffRequest, HandoffSink } from "../text-handler.js";
import type { TurnHandlerContext } from "../turns.js";

// Sumidero de derivación OPERATIVO (G5.0) para el manejador de texto: `record` solo resuelve cuando el CRM YA registró el caso (así el manejador puede confirmárselo al paciente).
// Si el caso quedó pendiente en la cola, no se pudo guardar o el CRM lo rechazó, lanza: el manejador responde el aviso de «no disponible» (nunca promete una persona).
// Mientras no haya un contexto de turno con cola configurada, no hay forma de registrar: falla cerrado.

export class HandoffNotRegisteredError extends Error {
  constructor(readonly state: string) {
    super(`handoff_not_registered_${state.toLowerCase()}`);
    this.name = "HandoffNotRegisteredError";
  }
}

const REASON_OF: Record<HandoffRequest["reason"], "HUMAN_REQUEST" | "MEDICAL_QUERY" | "NO_APPROVED_ANSWER"> = { HUMAN_REQUEST: "HUMAN_REQUEST", MEDICAL: "MEDICAL_QUERY", INFO_REQUEST: "NO_APPROVED_ANSWER" };

export function createCrmHandoffSink(): HandoffSink {
  return {
    operational: true,
    async record(request: HandoffRequest, context?: TurnHandlerContext) {
      if (!context?.registerCase) throw new HandoffNotRegisteredError("UNAVAILABLE");
      const state = await context.registerCase(REASON_OF[request.reason]);
      if (state !== "REGISTERED") throw new HandoffNotRegisteredError(state);
      return "RECORDED";
    }
  };
}
