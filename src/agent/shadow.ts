import { createHash } from "node:crypto";
import { socialOf } from "../attention-filter.js";
import type { ConversationReader, ObservedTurn } from "../conversation-state-store.js";
import type { KnowledgeAnswer } from "../knowledge-answers.js";
import { stripPaymentTalk } from "../payment-talk.js";
import { fold } from "../text-normalize.js";
import { asksForPrice, classifyText } from "../text-handler.js";
import type { CatalogStudy } from "../types.js";
import type { AgentDecision, Capabilities, RecentEntry, ToolDef, Utterance } from "./contracts.js";
import { conversationStateTool, createToolRegistry, findStudiesTool, labInfoTool, quoteStudiesTool } from "./tools.js";

// Preparación del turno del agente conversacional: los mensajes de texto del lote, los mensajes recientes del historial y las herramientas. Un fallo del historial no detiene la decisión: se decide con lo que haya.
// El texto del paciente solo viaja al modelo y NUNCA se registra (el registro lleva contadores y códigos).

export const PREPARE_LIMITS = { maxTexts: 6 } as const;

export interface AgentContextOptions {
  loadCatalog: () => Promise<readonly CatalogStudy[]>;
  // Conocimiento aprobado del laboratorio. Sin él no existe la herramienta lab_info.
  answer?: (question: string) => Promise<KnowledgeAnswer | undefined>;
  // Memoria persistente (última cotización y última receta por nombres del catálogo). Sin ella el agente decide con los mensajes recientes.
  reader?: ConversationReader;
  contactKeyFor(phone: string): string | undefined;
  // Mensajes recientes de la conversación (del historial).
  recent?: (input: { from: string; messageId: string; contactKey: string; excludeIds: readonly string[] }) => Promise<readonly RecentEntry[]>;
  capabilities?: Capabilities;
}

// Un pedido largo (una lista de estudios, una receta transcrita) debe llegar entero: cortarlo cotizaría de menos en silencio.
const MAX_TEXT = 1500;

// Palabras que delatan que un mensaje que las reglas dejaron en «OTHER» sí habla del laboratorio: nunca se calla.
const LAB_WORDS = /laboratori|plusmedik|analisis|estudio|examen|muestra|resultado|sangre|orina|cotiz|precio|cuesta|receta|horario|sucursal|\bcita\b|turno/;
const labMention = (text: string): boolean => LAB_WORDS.test(fold(text));

// Un mensaje por texto del lote (los audios, fotos y documentos siguen su ruta de siempre). El texto viaja tal cual lo escribió el paciente (decisión del dueño, 6-nov).
export function utterancesOf(turns: readonly ObservedTurn[]): { utterances: Utterance[]; mediaSkipped: number } {
  const utterances: Utterance[] = [];
  let mediaSkipped = 0;
  for (const turn of turns) {
    if (turn.kind !== "TEXT") { mediaSkipped += 1; continue; }
    const text = turn.text?.trim();
    if (!text || utterances.length >= PREPARE_LIMITS.maxTexts) continue;
    const topic = socialOf(text) !== undefined ? "SOCIAL" : labMention(text) && classifyText(text) === "OTHER" ? "OTHER_LAB" : classifyText(text);
    utterances.push({ topic, text: text.slice(0, MAX_TEXT) });
  }
  return { utterances, mediaSkipped };
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);

// Registro técnico de una decisión: contadores y CÓDIGOS, nunca texto del paciente ni del agente.
export function summarizeDecision(decision: AgentDecision, extra: { utterances: number; mediaSkipped: number; latencyMs: number; model: string }): Record<string, unknown> {
  return {
    status: decision.status,
    utterances: extra.utterances,
    mediaSkipped: extra.mediaSkipped,
    tools: decision.toolRuns.map((run) => ({ tool: run.tool, ok: run.ok, ...(run.error ? { error: run.error } : {}), ...(run.why ? { why: run.why } : {}) })),
    violations: decision.violations.map((violation) => violation.code),
    ...(decision.planFallback ? { planFallback: decision.planFallback } : {}),
    ...(decision.repairs ? { repairs: decision.repairs, firstViolations: (decision.firstViolations ?? []).map((violation) => violation.code) } : {}),
    ...(decision.reply ? { replyChars: decision.reply.length, replyHash: hashOf(decision.reply), withQuote: decision.quoted === true } : {}),
    ...(decision.modelError ? { modelError: decision.modelError } : {}),
    ...(decision.usage ? { usage: decision.usage } : {}),
    latencyMs: extra.latencyMs,
    model: extra.model
  };
}

// Todo lo que el agente necesita para decidir UN lote de un contacto: los mensajes de texto, las herramientas y los mensajes recientes.
export type PreparedTurn =
  | { kind: "skip"; reason: "NO_TEXT" | "MEDICAL"; mediaSkipped: number }
  | { kind: "ready"; utterances: Utterance[]; mediaSkipped: number; contactKey: string | undefined; recent: readonly RecentEntry[]; tools: ReturnType<typeof createToolRegistry> };

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
  const contactKey = options.contactKeyFor(from);
  const { utterances, mediaSkipped } = utterancesOf(turns);
  if (utterances.length === 0) return { kind: "skip", reason: "NO_TEXT", mediaSkipped };
  // SALUD: un mensaje de salud (síntomas, medicamentos, interpretar resultados) sin pedir precio de estudios no se conversa con el modelo: lo atiende el modo esencial, que es determinista (texto fijo y derivación
  // registrada). Si en el mismo mensaje piden precios, el agente los atiende (no aconseja ni interpreta).
  if (utterances.some((utterance) => utterance.topic === "MEDICAL") && !utterances.some((utterance) => asksForPrice(utterance.text))) return { kind: "skip", reason: "MEDICAL", mediaSkipped };
  let recent: readonly RecentEntry[] = [];
  if (options.recent && contactKey) {
    try { recent = await options.recent({ from, messageId: turns[0]!.messageId, contactKey, excludeIds: turns.map((turn) => turn.messageId) }); } catch { /* sin historial: el agente decide con lo demás */ }
  }
  // Métodos de pago ignorados: tampoco llegan al modelo como mensajes anteriores (del paciente, de la recepción ni del propio asistente).
  recent = recent.map((entry) => ({ ...entry, text: stripPaymentTalk(entry.text, { keep: keepSafety }) })).filter((entry) => entry.text.trim() !== "");
  return { kind: "ready", utterances, mediaSkipped, contactKey, recent, tools: buildAgentTools(options, contactKey) };
}
