// G7 · Fase 0 — Esquemas del corpus de conversaciones y de los escenarios de evaluación. Solo tipos y validación (sin red ni efectos).
import { z } from "zod";

// ───────────────────────────── crudo (lo que exporta scripts/history-export.ts) ─────────────────────────────

export const RawMessage = z.object({
  seq: z.number().int(),
  at: z.string(),
  contactKey: z.string(),
  contactPhone: z.string().nullable().optional(),
  messageId: z.string(),
  direction: z.enum(["IN", "OUT"]),
  actor: z.enum(["PATIENT", "AGENT", "HUMAN", "OTHER_APP", "META_AGENT", "UNKNOWN"]),
  origin: z.string().nullable().optional(),
  kind: z.enum(["TEXT", "AUDIO", "IMAGE", "OTHER"]),
  messageType: z.string().nullable().optional(),
  mediaRef: z.string().nullable().optional(),
  state: z.string(),
  deliveryAt: z.string().nullable().optional(),
  auditRunId: z.string().nullable().optional(),
  replyTo: z.string().nullable().optional(),
  textStatus: z.enum(["OK", "NONE", "UNREADABLE"]),
  text: z.string().optional()
});
export type RawMessage = z.infer<typeof RawMessage>;

// ───────────────────────────── seudonimizado ─────────────────────────────

export const FixtureMessage = z.object({
  // Identificadores sustituidos: C### (conversación), M#### (mensaje)
  id: z.string(),
  at: z.string(),
  actor: z.enum(["PATIENT", "AGENT", "HUMAN", "OTHER_APP", "META_AGENT", "UNKNOWN"]),
  kind: z.enum(["TEXT", "AUDIO", "IMAGE", "OTHER"]),
  state: z.string(),
  replyTo: z.string().nullable(),
  // Hay evidencia de análisis de la foto en la auditoría (se vincula después por auditRunId; aquí solo se conserva si existía el vínculo)
  hasAuditRun: z.boolean(),
  // Tipo original del mensaje (text, image, audio, document, reaction, sticker, location…) y origen en Kapso (cloud_api = agente; business_app = recepción humana)
  messageType: z.string().nullable().default(null),
  origin: z.string().nullable().default(null),
  text: z.string().nullable()
});
export type FixtureMessage = z.infer<typeof FixtureMessage>;

export const FixtureBatch = z.object({
  // Mensajes del paciente que Kapso habría entregado juntos (ventana fija de 15 s) o un mensaje humano/agente suelto
  id: z.string(),
  startedAt: z.string(),
  messages: z.array(FixtureMessage)
});
export type FixtureBatch = z.infer<typeof FixtureBatch>;

export const FixtureConversation = z.object({
  id: z.string(),
  messageCount: z.number().int(),
  batches: z.array(FixtureBatch)
});
export type FixtureConversation = z.infer<typeof FixtureConversation>;

// ───────────────────────────── escenarios sintéticos de evaluación ─────────────────────────────

export const CAPABILITIES = ["MEMORY", "MULTI_QUESTION", "RECIPE_RECALL", "COREFERENCE", "HUMAN_RESUME", "PENDING_QUESTION", "OPS_QUERY", "MEDICAL_SAFETY", "HUMAN_REQUEST", "QUOTE_FLOW", "GOAL_PERSISTENCE", "SOCIAL", "ADVERSARIAL"] as const;
export type Capability = (typeof CAPABILITIES)[number];

// Lo que se espera de la capa de clasificación actual para un mensaje del paciente (sirve para medir la comprensión determinista de hoy).
export const ExpectedCategory = z.enum(["MEDICAL", "HUMAN_REQUEST", "INFO_REQUEST", "RECIPE_OR_QUOTE", "GREETING", "OTHER"]);

export const ScenarioMessage = z.object({
  ref: z.string(),
  actor: z.enum(["PATIENT", "HUMAN", "AGENT"]),
  text: z.string(),
  // Solo PATIENT: la categoría que un lector humano le daría y los enunciados (preguntas/peticiones) que contiene.
  expectedCategory: ExpectedCategory.optional(),
  utterances: z.array(z.object({ id: z.string(), kind: z.enum(["QUESTION", "REQUEST", "INFO", "SOCIAL", "MEDICAL", "HUMAN"]), topic: z.string() })).optional()
});

export const Expectation = z.object({
  // Enunciados que NO pueden quedar sin destino al terminar el lote
  mustCover: z.array(z.string()).default([]),
  // Hechos/artefactos que la respuesta debe referenciar (receta, cotización, objetivo)
  mustReference: z.array(z.string()).default([]),
  // Expresiones que la respuesta NO puede contener (precio inventado, promesa sin respaldo, consejo médico…)
  mustNotMatch: z.array(z.string()).default([]),
  // Estado esperado del gestor de objetivos después del lote
  stateAfter: z.object({ goals: z.array(z.object({ kind: z.string(), status: z.string() })).default([]), openQuestions: z.number().int().default(0) }).optional(),
  // La respuesta no debe ser un texto genérico fijo
  notGeneric: z.boolean().default(true),
  // Debe derivarse a una persona (solo cuenta si el caso queda registrado)
  mustHandoff: z.boolean().default(false),
  mustStaySilent: z.boolean().default(false)
});

export const ScenarioTurn = z.object({
  // Mensajes del lote (Kapso) en orden
  batch: z.array(ScenarioMessage).min(1),
  // Percepciones previas (resultado del análisis de una foto en este lote): estudios reconocidos y no reconocidos
  perceptions: z.array(z.object({ ref: z.string(), recognized: z.array(z.string()), unrecognized: z.array(z.string()) })).default([]),
  // El equipo humano intervino antes de este lote
  humanBefore: z.string().optional(),
  paused: z.boolean().default(false),
  expect: Expectation
});

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1),
  severity: z.enum(["S0", "S1", "S2", "S3"]),
  turns: z.array(ScenarioTurn).min(1)
});
export type Scenario = z.infer<typeof Scenario>;
