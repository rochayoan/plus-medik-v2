import { createHash } from "node:crypto";
import { socialOf } from "../attention-filter.js";
import type { ConversationState } from "../conversation-state.js";
import { GOAL_BY_CATEGORY, type ConversationReader, type ObservedTurn } from "../conversation-state-store.js";
import type { KnowledgeAnswer } from "../knowledge-answers.js";
import { stripPaymentTalk } from "../payment-talk.js";
import { classifyText } from "../text-handler.js";
import type { CatalogStudy } from "../types.js";
import type { AgentDecision, AgentModel, Capabilities, RecentEntry, Utterance } from "./contracts.js";
import { runAgentTurn } from "./pipeline.js";
import { conversationStateTool, createToolRegistry, findStudiesTool, labInfoTool, quoteStudiesTool } from "./tools.js";
import type { ToolDef } from "./contracts.js";

// Ejecución EN SOMBRA del núcleo conversacional (Fase 2 del plan G7). Por cada lote que ESTA ejecución reclamó, decide qué haría el agente y lo registra, SIN ENVIAR NADA: no recibe ninguna función de envío,
// no toma ni espera ningún lease, no cambia la pausa humana, el tope diario ni la respuesta real. Corre en segundo plano (el webhook lo espera con `schedule`, no antes de responder). Un fallo de cualquier
// parte (memoria, herramientas, modelo, verificación) se convierte en un código en el registro; nunca se propaga.
//
// Privacidad: el texto del paciente solo viaja al modelo (saneado, acotado y sin contenido de salud: un mensaje de salud llega sin su texto) y NUNCA se registra. El registro lleva contadores y códigos; el
// mensaje propuesto solo se entrega al `record` inyectado (en pruebas), no al registro de Vercel (solo su largo y una huella).

export const SHADOW_LIMITS = { maxPending: 3, pendingMaxAgeMs: 24 * 3600 * 1000, maxTexts: 6, maxConcurrent: 4, runTimeoutMs: 60_000, flushMs: 90_000 } as const;

export interface AgentShadowRecord {
  from: string;
  messageId: string;
  decision: AgentDecision;
  utterances: readonly Utterance[];
}

export interface AgentShadow {
  readonly mode: "shadow";
  // Un lote de UN contacto que esta ejecución reclamó. No espera y no lanza.
  observe(input: { from: string; turns: readonly ObservedTurn[] }): void;
  // Espera (acotada) a que terminen las decisiones en curso. Nunca lanza. El webhook lo registra con `schedule`.
  flush(timeoutMs?: number): Promise<void>;
}

export interface AgentShadowOptions {
  model: AgentModel;
  modelName: string;
  // Porcentaje de lotes que se deciden (1–100): control de costo. Determinista por mensaje.
  sample?: number;
  loadCatalog: () => Promise<readonly CatalogStudy[]>;
  // Conocimiento aprobado del laboratorio (el mismo que usa el agente de siempre). Sin él no existe la herramienta lab_info.
  answer?: (question: string) => Promise<KnowledgeAnswer | undefined>;
  // Memoria de la Fase 1 (pendientes y última cotización). Sin ella el agente decide sin memoria.
  reader?: ConversationReader;
  contactKeyFor(phone: string): string | undefined;
  // Mensajes recientes ya saneados (si la memoria conversacional los tiene).
  recent?: (input: { from: string; messageId: string; contactKey: string; excludeIds: readonly string[] }) => Promise<readonly RecentEntry[]>;
  capabilities?: Capabilities;
  log(event: string, data: Record<string, unknown>): void;
  now?: () => number;
  record?: (record: AgentShadowRecord) => void;
  // Plazos propios (por omisión SHADOW_LIMITS): cuánto puede tardar una decisión y cuánto espera el webhook a las que siguen en curso.
  runTimeoutMs?: number;
  flushMs?: number;
}

// Un pedido largo (una lista de estudios, una receta transcrita) debe llegar entero: cortarlo cotizaría de menos en silencio.
const MAX_TEXT = 1500;


// Una petición por mensaje de TEXTO del lote (los audios, fotos y documentos siguen su ruta de siempre). El texto viaja tal cual lo escribió el paciente (decisión del dueño, 6-nov).
export function utterancesOf(turns: readonly ObservedTurn[]): { utterances: Utterance[]; mediaSkipped: number } {
  const utterances: Utterance[] = [];
  let mediaSkipped = 0;
  for (const turn of turns) {
    if (turn.kind !== "TEXT") { mediaSkipped += 1; continue; }
    const text = turn.text?.trim();
    if (!text || utterances.length >= SHADOW_LIMITS.maxTexts) continue;
    const id = `U${utterances.length + 1}`;
    if (socialOf(text) !== undefined) { utterances.push({ id, topic: "SOCIAL", goal: "OTHER", text: text.slice(0, MAX_TEXT) }); continue; }
    const topic = classifyText(text);
    utterances.push({ id, topic, goal: GOAL_BY_CATEGORY[topic] ?? "OTHER", text: text.slice(0, MAX_TEXT) });
  }
  return { utterances, mediaSkipped };
}

// Lo que quedó pospuesto de turnos anteriores (por un texto fijo, un fallo o «no puedo derivar») o REABIERTO tras una reanudación manual de la recepción, con cuidado de no repetir lo de este lote ni lo que
// espera por la pausa humana.
export function pendingUtterances(state: ConversationState | undefined, now: number, currentMessageIds: ReadonlySet<string>, startAt: number): Utterance[] {
  if (!state || state.holder === "HUMAN") return [];
  const carried = state.questions
    .filter((question) => (question.status === "CARRIED" || question.status === "OPEN") && question.reason !== "HUMAN_PAUSED" && !currentMessageIds.has(question.messageId) && now - question.openedAt <= SHADOW_LIMITS.pendingMaxAgeMs)
    .slice(-SHADOW_LIMITS.maxPending);
  return carried.map((question, index): Utterance => {
    const goal = state.goals.find((candidate) => candidate.id === question.goalId)?.kind ?? "OTHER";
    return { id: `P${startAt + index}`, topic: question.topic, goal, carried: true, ref: question.messageId };
  });
}

const sampled = (messageId: string, percent: number): boolean => percent >= 100 || createHash("sha256").update(messageId).digest().readUInt16BE(0) % 100 < percent;

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

function summarize(decision: AgentDecision, extra: { utterances: number; carried: number; mediaSkipped: number; latencyMs: number; model: string }): Record<string, unknown> {
  const acts: Record<string, number> = {};
  for (const act of decision.acts ?? []) acts[act.kind] = (acts[act.kind] ?? 0) + 1;
  const error = decision.modelError;
  return {
    status: decision.status,
    utterances: extra.utterances,
    carried: extra.carried,
    mediaSkipped: extra.mediaSkipped,
    acts,
    tools: decision.toolRuns.map((run) => ({ tool: run.tool, ok: run.ok, ...(run.error ? { error: run.error } : {}) })),
    violations: decision.violations.map((violation) => violation.code),
    ...(decision.repairs ? { repairs: decision.repairs, firstViolations: (decision.firstViolations ?? []).map((violation) => violation.code) } : {}),
    ...(decision.reply ? { replyChars: decision.reply.length, replyHash: hashOf(decision.reply), withQuote: (decision.acts ?? []).some((act) => act.kind === "QUOTE") } : {}),
    ...(error ? { modelError: error } : {}),
    ...(decision.usage ? { usage: decision.usage } : {}),
    latencyMs: extra.latencyMs,
    model: extra.model
  };
}

// Todo lo que el núcleo necesita para decidir UN lote de un contacto: peticiones (una por mensaje de texto + lo pendiente de antes), herramientas, mensajes recientes y memoria. Lo usan por igual la sombra y el
// piloto, de modo que deciden exactamente con lo mismo.
export type AgentContextOptions = Pick<AgentShadowOptions, "loadCatalog" | "answer" | "reader" | "contactKeyFor" | "recent" | "now"> & { capabilities?: Capabilities };

export type PreparedTurn =
  | { kind: "skip"; reason: "NO_TEXT" | "HUMAN_HOLDER"; mediaSkipped: number }
  | { kind: "ready"; utterances: Utterance[]; current: number; carried: number; mediaSkipped: number; contactKey: string | undefined; recent: readonly RecentEntry[]; tools: ReturnType<typeof createToolRegistry> };

export function buildAgentTools(options: AgentContextOptions, contactKey: string | undefined) {
  const capabilities = options.capabilities ?? { handoff: false, quote: true };
  const tools: ToolDef[] = [];
  if (options.answer) tools.push(labInfoTool({ answer: options.answer }));
  tools.push(findStudiesTool({ loadCatalog: options.loadCatalog }));
  if (capabilities.quote) tools.push(quoteStudiesTool({ loadCatalog: options.loadCatalog }));
  if (options.reader && contactKey) tools.push(conversationStateTool({ reader: options.reader, contactKey, loadCatalog: options.loadCatalog }));
  return createToolRegistry(tools);
}

// Una frase de salud o de pedir a una persona se conserva aunque nombre un pago.
const keepSafety = (clause: string): boolean => { const category = classifyText(clause); return category === "MEDICAL" || category === "HUMAN_REQUEST"; };

export async function prepareAgentTurn(options: AgentContextOptions, from: string, turns: readonly ObservedTurn[]): Promise<PreparedTurn> {
  const now = options.now ?? Date.now;
  const contactKey = options.contactKeyFor(from);
  const { utterances: current, mediaSkipped } = utterancesOf(turns);
  if (current.length === 0) return { kind: "skip", reason: "NO_TEXT", mediaSkipped };
  const state = options.reader && contactKey ? await options.reader.stateOf(contactKey) : undefined;
  // Con una persona al mando el agente no decide nada (la pausa humana manda).
  if (state?.holder === "HUMAN") return { kind: "skip", reason: "HUMAN_HOLDER", mediaSkipped };
  const carried = pendingUtterances(state, now(), new Set(turns.map((turn) => turn.messageId)), 1);
  let recent: readonly RecentEntry[] = [];
  if (options.recent && contactKey) {
    try { recent = await options.recent({ from, messageId: turns[0]!.messageId, contactKey, excludeIds: turns.map((turn) => turn.messageId) }); } catch { /* sin historial: el agente decide con lo demás */ }
  }
  // Métodos de pago ignorados: tampoco llegan al modelo como mensajes anteriores (del paciente, de la recepción ni del propio asistente).
  recent = recent.map((entry) => ({ ...entry, text: stripPaymentTalk(entry.text, { keep: keepSafety }) })).filter((entry) => entry.text.trim() !== "");
  return { kind: "ready", utterances: [...current, ...carried], current: current.length, carried: carried.length, mediaSkipped, contactKey, recent, tools: buildAgentTools(options, contactKey) };
}

export const summarizeDecision = summarize;

export function createAgentShadow(options: AgentShadowOptions): AgentShadow {
  const now = options.now ?? Date.now;
  const sample = options.sample ?? 100;
  const capabilities: Capabilities = options.capabilities ?? { handoff: false, quote: true };
  const inflight = new Set<Promise<void>>();
  const runTimeoutMs = options.runTimeoutMs ?? SHADOW_LIMITS.runTimeoutMs;
  const flushMs = options.flushMs ?? SHADOW_LIMITS.flushMs;

  async function decide(from: string, turns: readonly ObservedTurn[]): Promise<void> {
    const started = now();
    const messageId = turns[0]!.messageId;
    const prepared = await prepareAgentTurn(options, from, turns);
    if (prepared.kind === "skip") { options.log("agent_shadow", { status: "SKIPPED", reason: prepared.reason, ...(prepared.reason === "NO_TEXT" ? { mediaSkipped: prepared.mediaSkipped } : {}) }); return; }
    const decision = await runAgentTurn({ model: options.model, tools: prepared.tools }, { utterances: prepared.utterances, recent: prepared.recent, capabilities, now: new Date(now()) });
    options.log("agent_shadow", summarize(decision, { utterances: prepared.current, carried: prepared.carried, mediaSkipped: prepared.mediaSkipped, latencyMs: now() - started, model: options.modelName }));
    try { options.record?.({ from, messageId, decision, utterances: prepared.utterances }); } catch { /* el registro nunca interrumpe */ }
  }

  return {
    mode: "shadow",
    observe({ from, turns }) {
      try {
        if (turns.length === 0 || !sampled(turns[0]!.messageId, sample)) return;
        if (inflight.size >= SHADOW_LIMITS.maxConcurrent) { options.log("agent_shadow", { status: "SKIPPED", reason: "BUSY" }); return; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<void>((resolve) => { timer = setTimeout(() => { options.log("agent_shadow", { status: "SKIPPED", reason: "RUN_TIMEOUT" }); resolve(); }, runTimeoutMs); timer.unref?.(); });
        const task: Promise<void> = Promise.race([decide(from, turns), limit])
          .catch(() => { options.log("agent_shadow", { status: "FAILED" }); })
          .finally(() => { if (timer) clearTimeout(timer); inflight.delete(task); });
        inflight.add(task);
      } catch {
        // la sombra nunca interrumpe un turno
      }
    },
    async flush(timeoutMs = flushMs) {
      if (inflight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...inflight]), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}
