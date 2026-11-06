import { createHash } from "node:crypto";
import { socialOf } from "../attention-filter.js";
import type { ConversationState } from "../conversation-state.js";
import { GOAL_BY_CATEGORY, type ConversationReader, type ObservedTurn } from "../conversation-state-store.js";
import type { KnowledgeAnswer } from "../knowledge-answers.js";
import { stripPaymentTalk } from "../payment-talk.js";
import { fold } from "../text-normalize.js";
import { classifyText } from "../text-handler.js";
import type { CatalogStudy } from "../types.js";
import type { AgentDecision, AgentModel, Capabilities, RecentEntry, Utterance } from "./contracts.js";
import { runAgentTurn } from "./pipeline.js";
import { conversationStateTool, createToolRegistry, findStudiesTool, labInfoTool, quoteStudiesTool } from "./tools.js";
import type { ToolDef } from "./contracts.js";

// Preparación del turno del agente conversacional: peticiones (una por mensaje de texto), pendientes de la memoria, mensajes recientes del historial y herramientas. Un fallo de cualquier parte
// (memoria, historial) no detiene la decisión: se decide con lo que haya. El texto del paciente solo viaja al modelo y NUNCA se registra (el registro lleva contadores y códigos).

export const SHADOW_LIMITS = { maxPending: 3, pendingMaxAgeMs: 24 * 3600 * 1000, maxTexts: 6, maxConcurrent: 4, runTimeoutMs: 60_000, flushMs: 90_000 } as const;

export interface AgentContextOptions {
  loadCatalog: () => Promise<readonly CatalogStudy[]>;
  // Conocimiento aprobado del laboratorio. Sin él no existe la herramienta lab_info.
  answer?: (question: string) => Promise<KnowledgeAnswer | undefined>;
  // Memoria estructurada opcional (pendientes y última cotización). Sin ella el agente decide con los mensajes recientes.
  reader?: ConversationReader;
  contactKeyFor(phone: string): string | undefined;
  // Mensajes recientes de la conversación (del historial).
  recent?: (input: { from: string; messageId: string; contactKey: string; excludeIds: readonly string[] }) => Promise<readonly RecentEntry[]>;
  capabilities?: Capabilities;
  now?: () => number;
}

// Un pedido largo (una lista de estudios, una receta transcrita) debe llegar entero: cortarlo cotizaría de menos en silencio.
const MAX_TEXT = 1500;


// Una petición por mensaje de TEXTO del lote (los audios, fotos y documentos siguen su ruta de siempre). El texto viaja tal cual lo escribió el paciente (decisión del dueño, 6-nov).
// Palabras que delatan que un mensaje que las reglas dejaron en «OTHER» sí habla del laboratorio: nunca se calla.
const LAB_WORDS = /laboratori|plusmedik|analisis|estudio|examen|muestra|resultado|sangre|orina|cotiz|precio|cuesta|receta|horario|sucursal|\bcita\b|turno/;
const labMention = (text: string): boolean => LAB_WORDS.test(fold(text));

export function utterancesOf(turns: readonly ObservedTurn[]): { utterances: Utterance[]; mediaSkipped: number } {
  const utterances: Utterance[] = [];
  let mediaSkipped = 0;
  for (const turn of turns) {
    if (turn.kind !== "TEXT") { mediaSkipped += 1; continue; }
    const text = turn.text?.trim();
    if (!text || utterances.length >= SHADOW_LIMITS.maxTexts) continue;
    const id = `U${utterances.length + 1}`;
    if (socialOf(text) !== undefined) { utterances.push({ id, topic: "SOCIAL", goal: "OTHER", text: text.slice(0, MAX_TEXT) }); continue; }
    const topic = labMention(text) && classifyText(text) === "OTHER" ? "OTHER_LAB" : classifyText(text);
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
