import { z } from "zod";
import { mentionsAmount, type Classification, type UnavailableReason } from "../knowledge/types.js";

// Datos APROBADOS por estudio para el paciente (G4.1): tipo de muestra y requisitos especiales, y plazo de entrega. La preparación y el ayuno ya viven en G3 (STUDY_PREPARATION).
// Esta capa NO conoce recetas, cotizaciones ni precios, y NO duplica el catálogo: cada registro se refiere a lab_tests.id y solo guarda lo que el catálogo no tiene. Si no hay un dato
// aprobado y vigente, el resultado es siempre "no disponible" (ver supabase/migrations/20261031000000_plusmedik_study_facts.sql).

export const STUDY_FACT_KINDS = ["SAMPLE", "TURNAROUND"] as const;
export type StudyFactKind = (typeof STUDY_FACT_KINDS)[number];
export const factClassificationOf = (kind: StudyFactKind): Classification => (kind === "SAMPLE" ? "CLINICAL" : "ADMINISTRATIVE");

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !mentionsAmount(value), "no se permiten importes");

// Tipo de muestra y requisitos especiales. «Sin requisitos especiales» es una afirmación explícita y exclusiva; con requisitos debe decir cuáles.
export const samplePayload = z
  .strictObject({
    labTestId: uuid,
    sampleType: text(80),
    requirementsState: z.enum(["HAS_REQUIREMENTS", "NO_SPECIAL_REQUIREMENTS"]),
    requirements: z.array(text(200)).min(1).max(6).optional()
  })
  .superRefine((value, ctx) => {
    if (value.requirementsState === "NO_SPECIAL_REQUIREMENTS" && value.requirements !== undefined) ctx.addIssue({ code: "custom", message: "sin requisitos no admite una lista" });
    if (value.requirementsState === "HAS_REQUIREMENTS" && value.requirements === undefined) ctx.addIssue({ code: "custom", message: "con requisitos debe indicar cuáles" });
  });

// Plazo de entrega: HORAS (1–720) o DÍAS (1–60, hábiles o calendario), desde la toma o desde la recepción de la muestra. Cada estudio conserva su unidad: no se convierte.
export const turnaroundPayload = z
  .strictObject({
    labTestId: uuid,
    unit: z.enum(["HOURS", "DAYS"]),
    min: z.number().int().min(1).max(719).optional(),
    max: z.number().int().min(1).max(720),
    dayType: z.enum(["BUSINESS", "CALENDAR"]).optional(),
    countedFrom: z.enum(["SAMPLE_COLLECTION", "SAMPLE_RECEIPT"]),
    note: text(200).optional()
  })
  .superRefine((value, ctx) => {
    if (value.unit === "HOURS" && value.dayType !== undefined) ctx.addIssue({ code: "custom", message: "las horas no llevan tipo de día" });
    if (value.unit === "DAYS" && value.dayType === undefined) ctx.addIssue({ code: "custom", message: "los días deben ser hábiles o calendario" });
    if (value.unit === "DAYS" && value.max > 60) ctx.addIssue({ code: "custom", message: "máximo 60 días" });
    if (value.min !== undefined && value.min >= value.max) ctx.addIssue({ code: "custom", message: "el mínimo debe ser menor que el máximo" });
  });

export type SamplePayload = z.infer<typeof samplePayload>;
export type TurnaroundPayload = z.infer<typeof turnaroundPayload>;
export const FACT_SCHEMAS = { SAMPLE: samplePayload, TURNAROUND: turnaroundPayload } as const;

export const factSnapshotItem = z.object({
  kind: z.enum(STUDY_FACT_KINDS),
  labTestId: uuid,
  classification: z.enum(["ADMINISTRATIVE", "CLINICAL"]),
  version: z.number().int().min(1),
  versionId: z.string(),
  payload: z.unknown(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  contentHash: z.string()
});
export type FactSnapshotItem = z.infer<typeof factSnapshotItem>;
export const factSnapshotEnvelope = z.object({ revision: z.number().int().min(0), items: z.array(z.unknown()) });

// ───────────────────────────── resultados ─────────────────────────────
export interface FactProvenance {
  kind: StudyFactKind;
  labTestId: string;
  version: number;
  approvedAt: string | null;
  approvedBy: string | null;
  validUntil: string | null;
  contentHash: string;
}
export type FactResult<T> = { status: "AVAILABLE"; data: T; provenance: FactProvenance } | { status: "UNAVAILABLE"; reason: UnavailableReason; kind: StudyFactKind; labTestId: string };

export interface StudyFactItem<T> {
  studyId: string;
  studyName?: string;
  result: FactResult<T>;
}
// AVAILABLE = todos los estudios consultados tienen el dato aprobado y vigente; PARTIAL = algunos; UNAVAILABLE = ninguno. Cada estudio se informa por separado.
export interface StudyFactsResult<T> {
  status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  items: Array<StudyFactItem<T>>;
}
