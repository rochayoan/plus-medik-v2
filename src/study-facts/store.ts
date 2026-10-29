import { createSupabaseRpc, type SupabaseRpcOptions } from "../audit.js";
import { factSnapshotEnvelope } from "./types.js";

// Acceso de SOLO LECTURA a los datos por estudio aprobados. El agente en ejecución usa únicamente esto: nunca las funciones de administración (admin.ts).
// La revisión es la MISMA que la del conocimiento de G3 (plusmedik_kb_revision): cualquier cambio de lo aprobado la sube en la misma transacción.

export interface StudyFactsStore {
  revision(): Promise<number>;
  snapshot(): Promise<{ revision: number; items: unknown[] }>;
}

export function createSupabaseStudyFactsStore(options: SupabaseRpcOptions = {}): StudyFactsStore {
  const rpc = createSupabaseRpc(options);
  return {
    async revision() {
      const result = await rpc("plusmedik_kb_revision", {});
      const revision = result.revision;
      if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) throw new Error("respuesta de revisión inválida");
      return revision;
    },
    async snapshot() {
      const parsed = factSnapshotEnvelope.safeParse(await rpc("plusmedik_study_facts_snapshot", {}));
      if (!parsed.success) throw new Error("instantánea inválida");
      return parsed.data;
    }
  };
}
