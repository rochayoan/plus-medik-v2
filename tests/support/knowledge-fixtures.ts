import type { KnowledgeStore, RawSnapshot } from "../../src/knowledge/store.js";
import type { KnowledgeKind } from "../../src/knowledge/types.js";

// FIXTURES DE PRUEBA del conocimiento. Ningún valor es información del laboratorio: todos dicen "PRUEBA" y solo existen aquí. Producción no incluye datos de conocimiento.

export const STUDY_A = "11111111-1111-4111-8111-111111111111";
export const STUDY_B = "22222222-2222-4222-8222-222222222222";
export const STUDY_INACTIVE = "33333333-3333-4333-8333-333333333333";
export const STUDY_NO_RECORD = "44444444-4444-4444-8444-444444444444";
export const CATALOG = [
  { id: STUDY_A, name: "ESTUDIO A DE PRUEBA", active: true },
  { id: STUDY_B, name: "ESTUDIO B DE PRUEBA", active: true },
  { id: STUDY_INACTIVE, name: "ESTUDIO INACTIVO DE PRUEBA", active: false },
  { id: STUDY_NO_RECORD, name: "ESTUDIO SIN REGISTRO DE PRUEBA", active: true }
];

export const T0 = new Date("2026-11-02T15:00:00.000Z"); // lunes 11:00 en America/La_Paz (UTC-4)
export const iso = (offsetDays: number, from: Date = T0) => new Date(from.getTime() + offsetDays * 86_400_000).toISOString();

export interface ItemInput {
  kind: KnowledgeKind;
  key: string;
  payload: unknown;
  version?: number;
  validFrom?: string | null;
  validUntil?: string | null;
}
export const item = (input: ItemInput) => ({
  kind: input.kind,
  key: input.key,
  classification: input.kind === "STUDY_PREPARATION" ? "CLINICAL" : "ADMINISTRATIVE",
  version: input.version ?? 1,
  versionId: `00000000-0000-4000-8000-${String(Math.abs(hash(input.kind + input.key))).padStart(12, "0").slice(0, 12)}`,
  payload: input.payload,
  validFrom: input.validFrom === undefined ? iso(-30) : input.validFrom,
  validUntil: input.validUntil === undefined ? iso(60) : input.validUntil,
  approvedAt: iso(-30),
  approvedBy: "crm:approver-prueba",
  contentHash: "a".repeat(64)
});
function hash(text: string): number {
  let value = 7;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 999_999_999_989;
  return value;
}

export const branch = (key = "branch-prueba", overrides: Partial<ItemInput> = {}) => item({ kind: "BRANCH", key, payload: { name: "SUCURSAL DE PRUEBA", address: "DIRECCION DE PRUEBA" }, ...overrides });
export const schedule = (overrides: Partial<ItemInput> & { payload?: unknown } = {}) =>
  item({
    kind: "SCHEDULE", key: "schedule:branch-prueba:office",
    payload: { branchKey: "branch-prueba", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "12:00" }, { day: 1, opens: "14:00", closes: "18:00" }, { day: 6, opens: "09:00", closes: "11:00" }], exceptions: [{ date: "2026-11-09", closed: true, note: "FERIADO DE PRUEBA" }, { date: "2026-11-10", closed: false, opens: "10:00", closes: "11:00" }] },
    ...overrides
  });
export const policy = (overrides: Partial<ItemInput> = {}) => item({ kind: "POLICY", key: "policy:prueba", payload: { topic: "PRUEBA", title: "POLITICA DE PRUEBA", body: "TEXTO DE PRUEBA" }, ...overrides });
export const payment = (method: string, accepted = true, overrides: Partial<ItemInput> = {}) => item({ kind: "PAYMENT_METHOD", key: `payment:${method}`, payload: { method, label: `METODO ${method.toUpperCase()} DE PRUEBA`, accepted }, ...overrides });
export const faq = (key = "faq:prueba", tags: string[] = ["prueba"], overrides: Partial<ItemInput> = {}) => item({ kind: "FAQ", key, payload: { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA", tags }, ...overrides });
export const preparation = (studyId: string, payload: Record<string, unknown> = { prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" }, overrides: Partial<ItemInput> = {}) =>
  item({ kind: "STUDY_PREPARATION", key: `study:${studyId}`, payload: { labTestId: studyId, ...payload }, ...overrides });

// Almacén en memoria SOLO PARA PRUEBAS, con contadores y fallos inyectables.
export class MemoryStore implements KnowledgeStore {
  revisionCalls = 0;
  snapshotCalls = 0;
  failRevision = false;
  failSnapshot = false;
  snapshotDelayMs = 0;
  constructor(public current: RawSnapshot = { revision: 1, items: [] }) {}
  set(items: unknown[], revision = this.current.revision + 1) { this.current = { revision, items }; }
  async revision() {
    this.revisionCalls++;
    if (this.failRevision) throw new Error("base caída");
    return this.current.revision;
  }
  async snapshot() {
    this.snapshotCalls++;
    if (this.failSnapshot) throw new Error("base caída");
    const taken = structuredClone(this.current);
    if (this.snapshotDelayMs) await new Promise((resolve) => setTimeout(resolve, this.snapshotDelayMs));
    return taken;
  }
}
