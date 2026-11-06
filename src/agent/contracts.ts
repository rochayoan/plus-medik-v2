import type { ZodType } from "zod";
import type { ProviderErrorInfo } from "../provider-error.js";

// Agente conversacional ÚNICO (G7): CONTRATOS. El modelo conversa con naturalidad; solo consulta herramientas de lectura cuando necesita datos reales (precios, ubicación, horarios...). Todo lo que afirma sale
// de HECHOS con procedencia que producen esas herramientas; los precios y la derivación a una persona solo los ejecutan los mecanismos existentes (cotización del catálogo y derivación registrada), nunca el texto libre.

// ───────────────────────────── hechos (lo único que el agente puede afirmar) ─────────────────────────────

export type FactSource = "LAB_INFO" | "CATALOG" | "CONVERSATION_STATE" | "QUOTE_ENGINE";

export interface Fact {
  // Único dentro del turno (lo asigna la herramienta): `${tool}:${n}`. Solo para el registro técnico.
  id: string;
  source: FactSource;
  // Texto aprobado que el redactor puede reutilizar. Cifras, horarios, teléfonos, enlaces y días solo pueden salir de aquí o del propio mensaje del paciente. Nunca precios (los inyecta el sistema).
  text: string;
  // Registros que respaldan el hecho (id, versión, hash): para auditar de dónde salió. Nunca texto de pacientes.
  refs: string[];
}

// ───────────────────────────── el mensaje y las capacidades ─────────────────────────────

// Un mensaje de texto del paciente en este turno. `topic` es la etiqueta de las reglas (solo una pista y para el silencio).
export interface Utterance {
  text: string;
  topic: string;
}

export type HandoffReason = "HUMAN_REQUEST" | "MEDICAL" | "OUT_OF_SCOPE";

export interface ToolCall { tool: string; input: unknown }

// Qué puede hacer el sistema HOY (lo decide la configuración, no el modelo). Sin derivación registrada el agente no puede prometer a una persona.
export interface Capabilities {
  handoff: boolean;
  quote: boolean;
}

// ───────────────────────────── herramientas (solo lectura) ─────────────────────────────

export type ToolErrorCode = "UNKNOWN_TOOL" | "INVALID_INPUT" | "TOO_MANY_CALLS" | "TIMEOUT" | "FAILED" | "NO_DATA";

export interface ToolContext {
  // Instante del turno (para vigencias).
  now: Date;
  // Lo que el paciente escribió en este turno (para que una herramienta no dependa de cómo el modelo parafrasea la pregunta). Nunca se registra.
  patientText?: string;
}

// Lo que devuelve una herramienta: hechos (y, si corresponde, bloques que el SISTEMA agrega al mensaje, como la cotización con precios); `noData` es el motivo (un código) cuando no hay nada que decir. `undefined` = sin datos.
export type ToolOutcome = { facts: Array<Omit<Fact, "id">>; blocks?: string[] } | { noData: string } | undefined;

export interface ToolDef {
  name: string;
  description: string;
  // Solo lectura: ninguna herramienta envía, deriva ni escribe. Los efectos los ejecutan los mecanismos existentes, después de verificar.
  readOnly: true;
  input: ZodType<unknown>;
  run(input: unknown, context: ToolContext): Promise<ToolOutcome>;
}

// ───────────────────────────── el modelo (puerto) ─────────────────────────────

export interface RecentEntry { from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string }

export interface ModelUsage { inputTokens: number; outputTokens: number; reasoningTokens: number; calls: number }

export interface PlanInput {
  utterances: readonly Utterance[];
  // Mensajes recientes de la conversación (del historial); vacío si no hay.
  recent: readonly RecentEntry[];
  tools: ReadonlyArray<{ name: string; description: string }>;
  capabilities: Capabilities;
}

// Qué consultar antes de responder. `silent`: todo lo escrito es CLARAMENTE ajeno al laboratorio (el sistema exige además sus propias condiciones). `handoff`: pide una persona, salud u otra cosa que solo una persona resuelve.
// `fallback`: código de por qué la salida del plan no se pudo leer (entonces se responde sin herramientas, nunca se falla el turno).
export interface PlanOutput {
  toolCalls: ToolCall[];
  silent?: boolean;
  handoff?: HandoffReason;
  fallback?: string;
  usage?: Partial<ModelUsage>;
}

export interface RespondInput {
  utterances: readonly Utterance[];
  recent: readonly RecentEntry[];
  facts: readonly Fact[];
  // Herramientas que se consultaron y no dieron datos (texto breve por herramienta): «sin datos» es información, no un fallo.
  notes: readonly string[];
  // Si el sistema calculó una cotización con precios del catálogo y la agregará debajo del texto.
  hasQuoteBlock: boolean;
  capabilities: Capabilities;
  // true: se registrará la derivación a una persona y el texto puede decirlo.
  handoff: boolean;
  // Segundo intento: lo que el verificador rechazó del primero (SOLO códigos), para que el modelo lo corrija. Ausente en el primer intento.
  feedback?: ReadonlyArray<{ code: ViolationCode; detail?: string }>;
}

// Un solo puerto con dos llamadas acotadas: planificar (qué consultar) y responder (texto libre).
export interface AgentModel {
  plan(input: PlanInput): Promise<PlanOutput>;
  respond(input: RespondInput): Promise<{ text: string; usage?: Partial<ModelUsage> }>;
}

// ───────────────────────────── resultado de un turno (rastro de decisión) ─────────────────────────────

export type ViolationCode = "UNGROUNDED_FIGURE" | "PRICE_OUTSIDE_QUOTE" | "UNREGISTERED_HANDOFF_PROMISE" | "EMPTY_REPLY" | "REPLY_TOO_LONG";

export interface Violation { code: ViolationCode; detail?: string }

// `why`: motivo en código cuando una herramienta no dio datos (p. ej. NO_TOPIC, NO_APPROVED_DATA).
export interface ToolRun { tool: string; ok: boolean; error?: ToolErrorCode; why?: string; factIds: string[] }

// HANDOFF_FAILED: se pedía pasar con una persona y la derivación registrada no se pudo completar; no hay mensaje (quien responde usa el modo esencial).
// SILENT: el mensaje es CLARAMENTE ajeno al laboratorio: no se responde (el turno se cierra sin respuesta).
export type AgentStatus = "VERIFIED" | "REJECTED" | "MODEL_ERROR" | "HANDOFF_FAILED" | "SILENT";

export interface AgentDecision {
  status: AgentStatus;
  toolRuns: ToolRun[];
  facts: Fact[];
  // El mensaje verificado del redactor y, si hubo cotización, el bloque del sistema con los precios del catálogo. Ausente si no pasó la verificación.
  reply?: string;
  violations: Violation[];
  // Causa codificada si falló el modelo (lista blanca; nunca el mensaje del error).
  modelError?: ProviderErrorInfo | { cause: "INVALID_OUTPUT"; stage?: "plan" | "respond"; reason: string; detail?: string };
  // true si el mensaje lleva la cotización del sistema, y si esa cotización es PARCIAL.
  quoted?: boolean;
  quotePartial?: boolean;
  // El plan pidió pasar con una persona; true si se ejecutó la derivación registrada.
  handoffRequested?: boolean;
  handoffRegistered?: boolean;
  // Código de por qué la salida del plan no se pudo leer (se respondió sin herramientas).
  planFallback?: string;
  usage?: ModelUsage;
  // 1 si hizo falta un segundo intento tras un rechazo (con o sin éxito), y qué rechazó el primero.
  repairs?: number;
  firstViolations?: Violation[];
}
