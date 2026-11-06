import type { ZodType } from "zod";
import type { GoalKind } from "../conversation-state.js";
import type { ProviderErrorInfo } from "../provider-error.js";

// Núcleo conversacional (Fase 2 del plan G7): CONTRATOS. Ver docs/g7/11 y docs/g7/12. El modelo de lenguaje decide qué pidió el paciente y cómo decirlo; todo lo que afirma el agente sale de HECHOS con
// procedencia que producen herramientas deterministas, y los precios y la derivación a una persona solo los ejecutan los mecanismos existentes (cotización del catálogo y derivación registrada), nunca el
// texto libre del modelo. En esta fase el núcleo solo DECIDE en sombra: no envía nada.

// ───────────────────────────── hechos (lo único que el agente puede afirmar) ─────────────────────────────

export type FactSource = "LAB_INFO" | "CATALOG" | "CONVERSATION_STATE" | "QUOTE_ENGINE";

export interface Fact {
  // Único dentro del turno (lo asigna la herramienta): `${tool}:${n}`.
  id: string;
  source: FactSource;
  // Texto aprobado que el redactor puede reutilizar. Cifras, horarios, teléfonos, enlaces y días solo pueden salir de aquí o del propio mensaje del paciente. Nunca precios (los inyecta el sistema).
  text: string;
  // Registros que respaldan el hecho (id, versión, hash): para auditar de dónde salió. Nunca texto de pacientes.
  refs: string[];
}

// ───────────────────────────── qué pidió el paciente y qué hará el agente ─────────────────────────────

// Una petición dentro del turno. `text` solo viaja al modelo (saneado y acotado); nunca se registra ni se guarda. Un mensaje de salud llega SIN texto.
export interface Utterance {
  id: string;
  topic: string;
  goal: GoalKind;
  text?: string;
  // true: viene de la memoria (algo que quedó pendiente en un turno anterior), no de este lote.
  carried?: boolean;
  // Id del mensaje de la petición pendiente (solo en memoria del proceso; nunca viaja al modelo): sirve para declarar que la respuesta la atendió.
  ref?: string;
}

export type ClarifyCode = "WHICH_STUDY" | "SEND_RECIPE" | "SPECIFY_REQUEST";
export type HandoffReason = "HUMAN_REQUEST" | "MEDICAL" | "OUT_OF_SCOPE";
export type DeferReason = "NO_DATA" | "TOOL_FAILED" | "NOT_SUPPORTED";

// Un acto puede atender varias peticiones a la vez (`utterances`): el paciente suele partir una misma idea en varios mensajes. Cada petición debe quedar cubierta por al menos un acto.
export type Act =
  // Responde SOLO con los hechos citados.
  | { kind: "ANSWER"; utterances: string[]; factIds: string[] }
  // Pide un dato que falta; el texto es una pregunta, sin afirmar nada.
  | { kind: "CLARIFY"; utterances: string[]; code: ClarifyCode }
  // Incluye la cotización que calculó el sistema (herramienta quote_studies, con precios del catálogo): el redactor no escribe precios.
  | { kind: "QUOTE"; utterances: string[] }
  // Pide derivar a una persona con la derivación registrada. Solo con este acto el texto puede decir que una persona atenderá. Solo si la capacidad existe.
  | { kind: "HANDOFF"; utterances: string[]; reason: HandoffReason }
  // Saludo o agradecimiento: cortesía sin datos.
  | { kind: "ACK"; utterances: string[] }
  // Dice con honestidad que no puede resolverlo ahora, sin inventar ni prometer.
  | { kind: "DEFER"; utterances: string[]; reason: DeferReason };

export interface ToolCall { tool: string; input: unknown }

// Qué puede hacer el sistema HOY (lo decide la configuración, no el modelo). Sin derivación registrada no existe el acto HANDOFF.
export interface Capabilities {
  handoff: boolean;
  quote: boolean;
}

// ───────────────────────────── herramientas (solo lectura en esta fase) ─────────────────────────────

export type ToolErrorCode = "UNKNOWN_TOOL" | "INVALID_INPUT" | "TOO_MANY_CALLS" | "TIMEOUT" | "FAILED" | "NO_DATA";
export type ToolResult = { ok: true; facts: Fact[]; blocks: string[] } | { ok: false; error: ToolErrorCode };

export interface ToolContext {
  // Instante del turno (para vigencias).
  now: Date;
}

export interface ToolDef {
  name: string;
  description: string;
  // Solo lectura: ninguna herramienta de esta fase envía, deriva ni escribe. Los efectos los ejecutan los mecanismos existentes, después de verificar.
  readOnly: true;
  input: ZodType<unknown>;
  // `blocks`: texto que el SISTEMA agrega tal cual al mensaje si el plan lo pide (la cotización con precios del catálogo). El modelo nunca lo escribe ni lo ve con precios.
  run(input: unknown, context: ToolContext): Promise<{ facts: Omit<Fact, "id">[]; blocks?: string[] } | undefined>;
}

// ───────────────────────────── el modelo (puerto) ─────────────────────────────

export interface RecentEntry { from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string }

export interface ModelUsage { inputTokens: number; outputTokens: number; reasoningTokens: number; calls: number }

export interface PlanInput {
  utterances: readonly Utterance[];
  // Mensajes recientes de la conversación (ya saneados); vacío si no hay.
  recent: readonly RecentEntry[];
  tools: ReadonlyArray<{ name: string; description: string }>;
  capabilities: Capabilities;
}

// Qué entendió el modelo de cada petición. La intención la decide el modelo (no una expresión regular); MEDICAL obliga a derivar o aplazar aunque la etiqueta de las reglas no lo detectara.
export type Intent = "QUOTE" | "INFO" | "GREETING" | "THANKS" | "MEDICAL" | "HUMAN" | "OFF_TOPIC" | "FOLLOW_UP" | "OTHER";
export const INTENTS: readonly Intent[] = ["QUOTE", "INFO", "GREETING", "THANKS", "MEDICAL", "HUMAN", "OFF_TOPIC", "FOLLOW_UP", "OTHER"];
export interface IntentReading { utterance: string; intent: Intent }

export interface RespondInput {
  utterances: readonly Utterance[];
  recent: readonly RecentEntry[];
  facts: readonly Fact[];
  // Cuántas herramientas dieron resultado y si hay una cotización calculada por el sistema (disponible para el acto QUOTE).
  hasQuoteBlock: boolean;
  capabilities: Capabilities;
  // Segundo intento: lo que el verificador rechazó del primero (SOLO códigos y ids, nunca texto), para que el modelo lo corrija. Ausente en el primer intento.
  feedback?: ReadonlyArray<{ code: ViolationCode; detail?: string }>;
  // Lo que el propio modelo entendió de cada petición en el paso anterior (la intención la decide el modelo; la etiqueta de las reglas es solo una pista).
  intents?: ReadonlyArray<IntentReading>;
}

// Un solo puerto con dos llamadas acotadas (no un bucle libre): entender y pedir datos, luego decidir y redactar. Se implementa con la API Responses de OpenAI; las pruebas usan uno simulado.
export interface AgentModel {
  plan(input: PlanInput): Promise<{ toolCalls: ToolCall[]; intents?: IntentReading[]; usage?: Partial<ModelUsage> }>;
  respond(input: RespondInput): Promise<{ acts: Act[]; text: string; usage?: Partial<ModelUsage> }>;
}

// ───────────────────────────── resultado de un turno (rastro de decisión) ─────────────────────────────

export type ViolationCode =
  | "UNCOVERED_UTTERANCE"
  | "UNKNOWN_UTTERANCE"
  | "ANSWER_WITHOUT_FACTS"
  | "UNKNOWN_FACT"
  | "MEDICAL_NOT_HANDED_OFF"
  | "HANDOFF_UNAVAILABLE"
  | "QUOTE_UNAVAILABLE"
  | "QUOTE_WITHOUT_BLOCK"
  | "NO_ACTS"
  | "UNGROUNDED_FIGURE"
  | "PRICE_OUTSIDE_QUOTE"
  | "UNREGISTERED_HANDOFF_PROMISE"
  | "EMPTY_REPLY"
  | "REPLY_TOO_LONG";

export interface Violation { code: ViolationCode; detail?: string }

export interface ToolRun { tool: string; ok: boolean; error?: ToolErrorCode; factIds: string[] }

// HANDOFF_FAILED: el plan pedía pasar con una persona y la derivación registrada no se pudo completar; no hay mensaje (quien responde usa su ruta de siempre).
export type AgentStatus = "VERIFIED" | "REJECTED" | "MODEL_ERROR" | "HANDOFF_FAILED";

export interface AgentDecision {
  status: AgentStatus;
  acts?: Act[];
  toolRuns: ToolRun[];
  facts: Fact[];
  // El mensaje propuesto (solo en sombra: NO se envía): el texto verificado del redactor y, si el plan lo pidió, la cotización del sistema. Ausente si no pasó la verificación.
  reply?: string;
  violations: Violation[];
  // Causa codificada si falló el modelo (lista blanca; nunca el mensaje del error).
  modelError?: ProviderErrorInfo | { cause: "INVALID_OUTPUT" };
  intents?: IntentReading[];
  // true si se ejecutó una derivación registrada (la persona del laboratorio ya tiene el caso).
  handoffRegistered?: boolean;
  usage?: ModelUsage;
  // 1 si hizo falta un segundo intento tras un rechazo (con o sin éxito), y qué rechazó el primero.
  repairs?: number;
  firstViolations?: Violation[];
}
