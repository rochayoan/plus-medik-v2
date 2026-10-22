import type { AuditRepository } from "../../src/audit.js";

// Inyección de interrupciones para pruebas de extremo a extremo. Una "caída" es una ejecución que deja de avanzar para siempre (una promesa que nunca se
// resuelve), como una función de Vercel que se corta; una "compuerta" es una pausa que se puede reanudar después.

export const forever = (): Promise<never> => new Promise<never>(() => undefined);

export type Fault = { before?: () => Promise<void>; after?: () => Promise<void> };

// Envuelve un repositorio de auditoría para detener la ejecución antes o después de que la base conteste en un método.
export function withFaults(real: AuditRepository, faults: Partial<Record<keyof AuditRepository, Fault>>): AuditRepository {
  const wrap = <K extends keyof AuditRepository>(method: K) =>
    (async (...args: unknown[]) => {
      await faults[method]?.before?.();
      const result = await (real[method] as (...a: unknown[]) => Promise<unknown>)(...args);
      await faults[method]?.after?.();
      return result;
    }) as AuditRepository[K];
  return {
    claim: wrap("claim"), renewLease: wrap("renewLease"), recordIgnored: wrap("recordIgnored"), recordEvidence: wrap("recordEvidence"), recordFailure: wrap("recordFailure"),
    reserveSend: wrap("reserveSend"), confirmSend: wrap("confirmSend"), recordReply: wrap("recordReply")
  };
}

export const crashPoint = () => {
  let reached!: () => void;
  const signal = new Promise<void>((resolve) => (reached = resolve));
  return { hook: async () => { reached(); await forever(); }, reached: signal };
};

// Una ejecución "colgada" que se puede reanudar después (para probar al ejecutor que revive o un evento que llega en medio).
export const gate = () => {
  let open!: () => void;
  let reached!: () => void;
  const passed = new Promise<void>((resolve) => (open = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return { hook: async () => { reached(); await passed; }, open, arrived };
};
