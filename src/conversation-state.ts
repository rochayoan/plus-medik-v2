import { z } from "zod";

// Memoria estructurada de una conversación (Fase 1 del plan G7): preguntas/peticiones pendientes, objetivos, recetas y cotizaciones POR IDS, y quién tiene la palabra (agente o persona).
//
// Es DOMINIO PURO: reductores sobre eventos, sin red, sin base de datos, sin modelos, sin reloj y sin texto de pacientes. La persistencia está en src/conversation-state-store.ts (tabla de eventos de la
// migración 24) y el cableado en modo sombra en src/conversation-state-shadow.ts. En la Fase 1 NADA de esto cambia lo que el agente responde: solo registra y calcula lo pendiente.
//
// Reglas (probadas en tests/conversation-state.test.ts):
//   1. Cada petición del paciente nace OPEN con su objetivo (o CARRIED/HUMAN_PAUSED si la palabra la tiene una persona): nada se pierde en silencio.
//   2. Una respuesta del agente CON CONTENIDO o con COTIZACIÓN cierra lo abierto. Un texto fijo genérico, «no puedo derivar», un aviso técnico o «no pudimos identificar» NO cierran: la pregunta
//      queda pospuesta con motivo (visible para quien deba atenderla).
//   3. Un mensaje de una persona cierra lo pendiente como ANSWERED(STAFF) (aproximación de la Fase 1; la Fase 2 lo precisa con el contenido) y le pasa la palabra.
//   4. HUMAN_RESUME (la reanudación sigue siendo MANUAL) reabre lo que esperaba por la pausa.
//   5. Un objetivo se cumple cuando todas sus preguntas se cerraron y caduca tras 24 h sin actividad.
//   6. Eventos idempotentes por id; el reductor nunca muta el estado recibido; el resultado depende solo de los eventos (en orden).
// Los artefactos guardan solo ids de estudios y cantidades: NUNCA precios (siempre se recalculan del catálogo).

export type QuestionStatus = "OPEN" | "ANSWERED" | "CARRIED" | "DROPPED";
export type CloseActor = "AGENT" | "STAFF" | "SYSTEM";
export type CarryReason = "HUMAN_PAUSED" | "HANDOFF_UNAVAILABLE" | "FIXED_REPLY_ONLY" | "TECHNICAL_ISSUE" | "NOT_RESOLVED";
export type GoalKind = "QUOTE" | "LAB_INFO" | "STUDY_INFO" | "RESULTS" | "HUMAN_ATTENTION" | "MEDIA" | "OTHER";
export type GoalStatus = "ACTIVE" | "FULFILLED" | "ABANDONED" | "EXPIRED";
// Calidad de una respuesta del agente (lo que importa para saber si la pregunta quedó atendida).
export type ReplyQuality = "ANSWER" | "QUOTE" | "GENERIC" | "BLOCKED" | "TECHNICAL" | "UNRESOLVED";

export interface Question {
  id: string;
  messageId: string;
  topic: string;
  goalId: string;
  status: QuestionStatus;
  openedAt: number;
  attempts: number;
  closedAt?: number;
  closedBy?: CloseActor;
  reason?: CarryReason;
}
export interface Goal { id: string; kind: GoalKind; status: GoalStatus; openedAt: number; updatedAt: number }
export interface Artifact { id: string; kind: "RECIPE" | "QUOTE"; at: number; studyIds: string[]; unrecognized: number }
export interface ConversationState {
  version: number;
  holder: "AGENT" | "HUMAN";
  lastHumanAt?: number;
  questions: Question[];
  goals: Goal[];
  artifacts: Artifact[];
  // Idempotencia: un evento ya aplicado no se aplica dos veces.
  applied: string[];
}
export const emptyState = (): ConversationState => ({ version: 0, holder: "AGENT", questions: [], goals: [], artifacts: [], applied: [] });

export interface PatientItem { messageId: string; topic: string; goal: GoalKind }
export type ConversationEvent =
  | { id: string; type: "PATIENT_BATCH"; at: number; items: PatientItem[]; paused?: boolean }
  // closes: ids de mensajes de peticiones PENDIENTES (de turnos anteriores) que esta respuesta atendió de verdad (lo declara quien respondió y lo sabe: el agente del piloto). Se cierran aunque el tema sea otro.
  // upto: instante del último lote al que esta respuesta contestó (lo anotó quien respondió). Sin él se asume «todo lo anterior a la respuesta»; con él, un mensaje que llegó MIENTRAS se respondía no se da por atendido.
  | { id: string; type: "AGENT_REPLY"; at: number; quality: ReplyQuality; closes?: string[]; upto?: number }
  | { id: string; type: "HUMAN_MESSAGE"; at: number }
  | { id: string; type: "HUMAN_RESUME"; at: number }
  | { id: string; type: "ARTIFACT"; at: number; artifact: Omit<Artifact, "at"> }
  | { id: string; type: "DROP"; at: number; questionId: string; reason: "AUTOMATED" | "RETRACTED" | "DUPLICATE" };

const GOAL_TTL_MS = 24 * 3600 * 1000;
const clone = (state: ConversationState): ConversationState => structuredClone(state);

function ensureGoal(state: ConversationState, kind: GoalKind, at: number): Goal {
  const existing = state.goals.find((goal) => goal.kind === kind && goal.status === "ACTIVE" && at - goal.updatedAt <= GOAL_TTL_MS);
  if (existing) { existing.updatedAt = at; return existing; }
  const goal: Goal = { id: `G${state.goals.length + 1}`, kind, status: "ACTIVE", openedAt: at, updatedAt: at };
  state.goals.push(goal);
  return goal;
}

function close(question: Question, at: number, by: CloseActor): void {
  question.status = "ANSWERED";
  question.closedAt = at;
  question.closedBy = by;
  delete question.reason;
}

function settleGoals(state: ConversationState, at: number): void {
  for (const goal of state.goals) {
    if (goal.status !== "ACTIVE") continue;
    const own = state.questions.filter((question) => question.goalId === goal.id);
    if (own.length > 0 && own.every((question) => question.status === "ANSWERED" || question.status === "DROPPED")) { goal.status = "FULFILLED"; goal.updatedAt = at; }
    else if (at - goal.updatedAt > GOAL_TTL_MS) { goal.status = "EXPIRED"; goal.updatedAt = at; }
  }
}

const CARRY_FOR: Record<Exclude<ReplyQuality, "ANSWER" | "QUOTE">, CarryReason> = { GENERIC: "FIXED_REPLY_ONLY", BLOCKED: "HANDOFF_UNAVAILABLE", TECHNICAL: "TECHNICAL_ISSUE", UNRESOLVED: "NOT_RESOLVED" };

// Reductor puro: devuelve un estado nuevo; nunca muta el recibido. Un evento repetido (mismo id) no cambia nada.
export function reduce(previous: ConversationState, event: ConversationEvent): ConversationState {
  if (previous.applied.includes(event.id)) return previous;
  const state = clone(previous);
  state.applied.push(event.id);
  state.version += 1;

  switch (event.type) {
    case "PATIENT_BATCH": {
      for (const item of event.items) {
        const goal = ensureGoal(state, item.goal, event.at);
        const question: Question = { id: `Q${state.questions.length + 1}`, messageId: item.messageId, topic: item.topic, goalId: goal.id, status: "OPEN", openedAt: event.at, attempts: 0 };
        // Durante la pausa humana nada se responde solo: queda explícitamente en espera, visible para la recepción.
        if (state.holder === "HUMAN" || event.paused === true) { question.status = "CARRIED"; question.reason = "HUMAN_PAUSED"; }
        state.questions.push(question);
      }
      break;
    }
    case "AGENT_REPLY": {
      const answered = event.quality === "ANSWER" || event.quality === "QUOTE";
      const topics = new Set<string>();
      const horizon = Math.min(event.at, event.upto ?? event.at);
      for (const question of state.questions) {
        if (question.status !== "OPEN" || question.openedAt > horizon) continue;
        question.attempts += 1;
        if (answered) { close(question, event.at, "AGENT"); topics.add(question.topic); }
        else { question.status = "CARRIED"; question.reason = CARRY_FOR[event.quality as Exclude<ReplyQuality, "ANSWER" | "QUOTE">]; }
      }
      // Una respuesta con contenido también atiende lo que había quedado pospuesto por un texto fijo, un fallo o «no puedo derivar» SI es del mismo tema (la foto ilegible y la foto nueva), y una cotización
      // cumple lo que se pospuso con el objetivo de cotizar. Lo pospuesto por la pausa humana no se toca: durante la pausa el agente no responde. Ante la duda sigue pendiente (mejor de más que de menos).
      if (answered) {
        for (const question of state.questions) {
          if (question.status !== "CARRIED" || question.reason === "HUMAN_PAUSED" || question.openedAt > horizon) continue;
          const goal = state.goals.find((candidate) => candidate.id === question.goalId)?.kind;
          if (topics.has(question.topic) || (event.quality === "QUOTE" && goal === "QUOTE")) close(question, event.at, "AGENT");
        }
      }
      // Lo que la respuesta DECLARÓ haber atendido (peticiones pendientes de antes): se cierra por id, sea cual sea el tema o la calidad del resto del mensaje. Lo que espera por la pausa humana no se toca.
      if (event.closes && event.closes.length > 0) {
        for (const question of state.questions) {
          if ((question.status === "OPEN" || question.status === "CARRIED") && question.reason !== "HUMAN_PAUSED" && event.closes.includes(question.messageId)) close(question, event.at, "AGENT");
        }
      }
      break;
    }
    case "HUMAN_MESSAGE": {
      state.holder = "HUMAN";
      state.lastHumanAt = event.at;
      for (const question of state.questions) if ((question.status === "OPEN" || question.status === "CARRIED") && question.openedAt <= event.at) close(question, event.at, "STAFF");
      break;
    }
    case "HUMAN_RESUME": {
      state.holder = "AGENT";
      for (const question of state.questions) if (question.status === "CARRIED" && question.reason === "HUMAN_PAUSED") { question.status = "OPEN"; delete question.reason; }
      break;
    }
    case "ARTIFACT": {
      state.artifacts.push({ ...event.artifact, at: event.at });
      break;
    }
    case "DROP": {
      const question = state.questions.find((candidate) => candidate.id === event.questionId);
      if (question && (question.status === "OPEN" || question.status === "CARRIED")) { question.status = "DROPPED"; question.closedAt = event.at; question.closedBy = "SYSTEM"; }
      break;
    }
  }
  settleGoals(state, event.at);
  return state;
}

export const replayEvents = (events: readonly ConversationEvent[], from: ConversationState = emptyState()): ConversationState => events.reduce(reduce, from);

// Lo que debe ver la recepción (y el agente al reanudar): preguntas sin atender desde hace al menos `minAgeMs`.
export function pending(state: ConversationState, now: number, minAgeMs = 0): Question[] {
  return state.questions.filter((question) => (question.status === "OPEN" || question.status === "CARRIED") && now - question.openedAt >= minAgeMs);
}

// Invariantes que toda secuencia de eventos debe conservar (se usan en pruebas de propiedad).
export function invariantViolations(state: ConversationState): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const question of state.questions) {
    if (ids.has(question.id)) problems.push(`id duplicado ${question.id}`);
    ids.add(question.id);
    if ((question.status === "ANSWERED" || question.status === "DROPPED") && (question.closedAt === undefined || !question.closedBy)) problems.push(`${question.id}: cerrada sin cierre`);
    if (question.status === "CARRIED" && !question.reason) problems.push(`${question.id}: pospuesta sin motivo`);
    if (question.status === "OPEN" && (question.closedAt !== undefined || question.reason)) problems.push(`${question.id}: abierta con datos de cierre`);
    if (!state.goals.some((goal) => goal.id === question.goalId)) problems.push(`${question.id}: sin objetivo`);
  }
  for (const artifact of state.artifacts) if ("priceBs" in artifact || "totalBs" in artifact) problems.push("un artefacto no puede guardar precios");
  return problems;
}

// ───────────────────────────── codificación hacia y desde la tabla de eventos (migración 24) ─────────────────────────────
// En la base solo entran identificadores y códigos cortos (la propia base lo exige). Aquí se fija la forma exacta de cada payload.

export interface EventRow { event_key: string; kind: ConversationEvent["type"]; payload: Record<string, unknown>; occurred_at: string }

const CODE = /^[A-Za-z0-9_.=:+/-]{1,128}$/;
const GOALS = ["QUOTE", "LAB_INFO", "STUDY_INFO", "RESULTS", "HUMAN_ATTENTION", "MEDIA", "OTHER"] as const;
const QUALITIES = ["ANSWER", "QUOTE", "GENERIC", "BLOCKED", "TECHNICAL", "UNRESOLVED"] as const;
const code = z.string().regex(CODE);

export function encodeEvent(event: ConversationEvent): EventRow {
  const occurred_at = new Date(event.at).toISOString();
  switch (event.type) {
    case "PATIENT_BATCH": return { event_key: event.id, kind: event.type, occurred_at, payload: { items: event.items.map((item) => ({ m: item.messageId, t: item.topic, g: item.goal })), ...(event.paused ? { p: true } : {}) } };
    case "AGENT_REPLY": return { event_key: event.id, kind: event.type, occurred_at, payload: { q: event.quality, ...(event.closes && event.closes.length > 0 ? { c: event.closes.slice(0, 10) } : {}), ...(event.upto !== undefined ? { u: event.upto } : {}) } };
    case "HUMAN_MESSAGE":
    case "HUMAN_RESUME": return { event_key: event.id, kind: event.type, occurred_at, payload: {} };
    case "ARTIFACT": return { event_key: event.id, kind: event.type, occurred_at, payload: { a: { id: event.artifact.id, k: event.artifact.kind, s: event.artifact.studyIds, u: event.artifact.unrecognized } } };
    case "DROP": return { event_key: event.id, kind: event.type, occurred_at, payload: { q: event.questionId, r: event.reason } };
  }
}

const rowSchema = z.object({ key: code, kind: z.enum(["PATIENT_BATCH", "AGENT_REPLY", "HUMAN_MESSAGE", "HUMAN_RESUME", "ARTIFACT", "DROP"]), at: z.string(), payload: z.record(z.string(), z.unknown()) });
const batchPayload = z.object({ items: z.array(z.object({ m: code, t: code, g: z.enum(GOALS) })).max(50), p: z.boolean().optional() });
const replyPayload = z.object({ q: z.enum(QUALITIES), c: z.array(code).max(10).optional(), u: z.number().int().positive().optional() });
const artifactPayload = z.object({ a: z.object({ id: code, k: z.enum(["RECIPE", "QUOTE"]), s: z.array(code).max(60), u: z.number().int().min(0).max(999) }) });
const dropPayload = z.object({ q: code, r: z.enum(["AUTOMATED", "RETRACTED", "DUPLICATE"]) });

// Una fila ilegible (versión futura, contenido inesperado) se IGNORA: nunca rompe la lectura de la conversación.
export function decodeRow(row: unknown): ConversationEvent | undefined {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) return undefined;
  const { key, kind, at, payload } = parsed.data;
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return undefined;
  switch (kind) {
    case "PATIENT_BATCH": { const p = batchPayload.safeParse(payload); return p.success ? { id: key, type: kind, at: time, items: p.data.items.map((i) => ({ messageId: i.m, topic: i.t, goal: i.g })), ...(p.data.p ? { paused: true } : {}) } : undefined; }
    case "AGENT_REPLY": { const p = replyPayload.safeParse(payload); return p.success ? { id: key, type: kind, at: time, quality: p.data.q, ...(p.data.c && p.data.c.length > 0 ? { closes: p.data.c } : {}), ...(p.data.u !== undefined ? { upto: p.data.u } : {}) } : undefined; }
    case "HUMAN_MESSAGE":
    case "HUMAN_RESUME": return { id: key, type: kind, at: time };
    case "ARTIFACT": { const p = artifactPayload.safeParse(payload); return p.success ? { id: key, type: kind, at: time, artifact: { id: p.data.a.id, kind: p.data.a.k, studyIds: p.data.a.s, unrecognized: p.data.a.u } } : undefined; }
    case "DROP": { const p = dropPayload.safeParse(payload); return p.success ? { id: key, type: kind, at: time, questionId: p.data.q, reason: p.data.r } : undefined; }
  }
}

// Estado de un contacto a partir de las filas que devuelve plusmedik_conv_events_read (ya en orden).
export function stateFromRows(rows: readonly unknown[]): ConversationState {
  const events = rows.map(decodeRow).filter((event): event is ConversationEvent => event !== undefined);
  // Orden estable por instante: los eventos de turnos concurrentes pueden llegar a la base en otro orden.
  return replayEvents(events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).map(({ event }) => event));
}
