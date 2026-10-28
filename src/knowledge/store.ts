import { createSupabaseRpc, type SupabaseRpcOptions } from "../audit.js";
import { snapshotEnvelope } from "./types.js";

// Acceso de SOLO LECTURA al conocimiento aprobado. El agente en ejecución usa únicamente esto: nunca las funciones de administración (src/knowledge/admin.ts).

export interface RawSnapshot {
  revision: number;
  // Cada elemento se valida por separado en el servicio: uno inválido no tumba a los demás, pero tampoco se usa.
  items: unknown[];
}

export interface KnowledgeStore {
  // Revisión actual (barata). Cambia en la misma transacción que cualquier cambio de lo aprobado.
  revision(): Promise<number>;
  // Todo lo aprobado (incluso vencido) + la revisión, de una misma foto de la base.
  snapshot(): Promise<RawSnapshot>;
}

export function createSupabaseKnowledgeStore(options: SupabaseRpcOptions = {}): KnowledgeStore {
  const rpc = createSupabaseRpc(options);
  return {
    async revision() {
      const result = await rpc("plusmedik_kb_revision", {});
      const revision = result.revision;
      if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) throw new Error("respuesta de revisión inválida");
      return revision;
    },
    async snapshot() {
      const result = await rpc("plusmedik_kb_snapshot", {});
      const parsed = snapshotEnvelope.safeParse(result);
      if (!parsed.success) throw new Error("instantánea inválida");
      return parsed.data;
    }
  };
}
