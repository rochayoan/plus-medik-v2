import { z } from "zod";

// Conocimiento del laboratorio: tipos, validación de contenido y resultados de consulta. Esta capa NO conoce recetas, cotizaciones, precios ni imágenes: solo lee lo que
// el laboratorio APROBÓ (ver supabase/migrations/20261027000000_plusmedik_knowledge.sql). Si no hay un dato aprobado y vigente, el resultado es siempre "no disponible".

export const KNOWLEDGE_KINDS = ["BRANCH", "SCHEDULE", "POLICY", "PAYMENT_METHOD", "FAQ", "STUDY_PREPARATION"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type Classification = "ADMINISTRATIVE" | "CLINICAL";
export const classificationOf = (kind: KnowledgeKind): Classification => (kind === "STUDY_PREPARATION" ? "CLINICAL" : "ADMINISTRATIVE");

export const SCHEDULE_SERVICES = ["OFFICE", "SAMPLE_COLLECTION", "RESULTS_PICKUP", "HOME_SAMPLING", "HUMAN_SUPPORT"] as const;
export type ScheduleService = (typeof SCHEDULE_SERVICES)[number];

// Misma regla que plusmedik_kb_text_ok (SQL): un texto del conocimiento no puede mencionar un importe. Los precios salen SOLO del catálogo (lab_tests.price_bs).
const AMOUNT = /(\b(bs|bob|usd|us\$|bolivianos?|d[oó]lar(es)?)\.?\s*\d|\$\s*\d|\d\s*(bs|bob|usd|bolivianos?|d[oó]lar(es)?)\b)/i;
export const mentionsAmount = (text: string): boolean => AMOUNT.test(text);
const text = (max = 2000) => z.string().trim().min(1).max(max).refine((value) => !mentionsAmount(value), "no se permiten importes en el conocimiento");

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,95}$/);

export const branchPayload = z.strictObject({
  name: text(200), address: text(400), mapsUrl: z.string().regex(/^https:\/\/\S{1,255}$/).optional(), phone: z.string().regex(/^[+0-9 ()-]{5,30}$/).optional(), notes: text().optional()
});
export const schedulePayload = z
  .strictObject({
    branchKey: slug,
    service: z.enum(SCHEDULE_SERVICES),
    timezone: z.string().regex(/^[A-Za-z]+(\/[A-Za-z_]+){1,2}$/),
    weekly: z.array(z.strictObject({ day: z.number().int().min(0).max(6), opens: hhmm, closes: hhmm })).min(1).max(28),
    exceptions: z.array(z.strictObject({ date: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/), closed: z.boolean(), opens: hhmm.optional(), closes: hhmm.optional(), note: text().optional() })).max(400).optional(),
    notes: text().optional()
  })
  .superRefine((value, ctx) => {
    for (const entry of value.weekly) if (entry.opens >= entry.closes) ctx.addIssue({ code: "custom", message: "apertura debe ser anterior al cierre" });
    for (const entry of value.exceptions ?? []) {
      if (entry.closed && (entry.opens !== undefined || entry.closes !== undefined)) ctx.addIssue({ code: "custom", message: "un día cerrado no lleva horas" });
      if (!entry.closed && (entry.opens === undefined || entry.closes === undefined || entry.opens >= entry.closes)) ctx.addIssue({ code: "custom", message: "un día abierto exige horas válidas" });
    }
  });
export const policyPayload = z.strictObject({ topic: z.string().regex(/^[A-Z][A-Z_]{1,39}$/), title: text(200), body: text() });
export const paymentMethodPayload = z.strictObject({ method: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/), label: text(120), accepted: z.boolean(), notes: text().optional() });
export const faqPayload = z.strictObject({ question: text(400), answer: text(), tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,29}$/)).max(12).optional() });
// "Sin preparación" es una afirmación clínica EXPLÍCITA y exclusiva; con preparación debe decir cuál. La ausencia de un registro nunca equivale a "sin preparación".
export const studyPreparationPayload = z
  .strictObject({
    labTestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    prepState: z.enum(["NO_PREPARATION_REQUIRED", "HAS_PREPARATION"]),
    fastingHours: z.number().int().min(0).max(48).optional(),
    instructions: text().optional(),
    collectionWindow: text(200).optional()
  })
  .superRefine((value, ctx) => {
    if (value.prepState === "NO_PREPARATION_REQUIRED" && (value.fastingHours !== undefined || value.instructions !== undefined || value.collectionWindow !== undefined)) ctx.addIssue({ code: "custom", message: "sin preparación no admite indicaciones" });
    if (value.prepState === "HAS_PREPARATION" && value.fastingHours === undefined && value.instructions === undefined) ctx.addIssue({ code: "custom", message: "con preparación debe indicar cuál" });
  });

export type BranchPayload = z.infer<typeof branchPayload>;
export type SchedulePayload = z.infer<typeof schedulePayload>;
export type PolicyPayload = z.infer<typeof policyPayload>;
export type PaymentMethodPayload = z.infer<typeof paymentMethodPayload>;
export type FaqPayload = z.infer<typeof faqPayload>;
export type StudyPreparationPayload = z.infer<typeof studyPreparationPayload>;

export const PAYLOAD_SCHEMAS = {
  BRANCH: branchPayload,
  SCHEDULE: schedulePayload,
  POLICY: policyPayload,
  PAYMENT_METHOD: paymentMethodPayload,
  FAQ: faqPayload,
  STUDY_PREPARATION: studyPreparationPayload
} as const;

// ───────────────────────────── instantánea publicada por la base ─────────────────────────────
export const snapshotItem = z.object({
  kind: z.enum(KNOWLEDGE_KINDS),
  key: z.string(),
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
export type SnapshotItem = z.infer<typeof snapshotItem>;
export const snapshotEnvelope = z.object({ revision: z.number().int().min(0), items: z.array(z.unknown()) });

// ───────────────────────────── resultados de consulta ─────────────────────────────
// Conocimiento no disponible: SIEMPRE un resultado estructurado, nunca un texto inventado ni un "no hay nada que preparar".
export type UnavailableReason =
  | "NO_APPROVED_VERSION" // no existe una versión aprobada (nunca se cargó, se retiró o no se aprobó)
  | "EXPIRED" // existe pero su caducidad ya pasó
  | "NOT_YET_VALID" // aprobada pero con vigencia futura
  | "INVALID_CONTENT" // lo publicado no cumple el contrato: no se usa
  | "STORE_UNAVAILABLE" // no se pudo consultar la base y la copia local ya no es confiable
  | "UNKNOWN_STUDY" // el identificador no está en el catálogo
  | "INACTIVE_STUDY" // el estudio está inactivo en el catálogo
  | "CATALOG_UNAVAILABLE" // no se dispone del catálogo para verificar el estudio
  | "AMBIGUOUS"; // más de un resultado vigente donde debía haber uno

export interface Provenance {
  kind: KnowledgeKind;
  key: string;
  version: number;
  approvedAt: string | null;
  approvedBy: string | null;
  validUntil: string | null;
  contentHash: string;
}
export interface OmittedItem {
  key: string;
  reason: UnavailableReason;
}
export interface Unavailable {
  status: "UNAVAILABLE";
  reason: UnavailableReason;
  kind: KnowledgeKind;
  key?: string;
}
export interface Available<T> {
  status: "AVAILABLE";
  data: T;
  provenance: Provenance[];
  // Elementos de una lista que NO se pudieron usar (vencidos, inválidos...). Quien redacta una respuesta debe saber que la lista puede estar incompleta.
  omitted: OmittedItem[];
}
export type KnowledgeResult<T> = Available<T> | Unavailable;

export const available = <T>(data: T, provenance: Provenance[], omitted: OmittedItem[] = []): Available<T> => ({ status: "AVAILABLE", data, provenance, omitted });
export const unavailable = (kind: KnowledgeKind, reason: UnavailableReason, key?: string): Unavailable => ({ status: "UNAVAILABLE", reason, kind, ...(key !== undefined ? { key } : {}) });
