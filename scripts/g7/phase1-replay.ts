// G7 · Fase 1 (prototipo) — Pasa el corpus real seudonimizado por los reductores de preguntas/objetivos pendientes y mide qué habría visto la recepción. TODO LOCAL, sin red ni modelos.
//
//   npx tsx scripts/g7/phase1-replay.ts [--in private-data/g7/pseudo.json] [--alert-minutes 15]
//
// Convierte cada lote del paciente en preguntas (reglas deterministas, sin leer ni imprimir texto), cada respuesta del agente en AGENT_REPLY con su calidad (texto fijo genérico / «no puedo derivar» /
// cotización / libre) y cada mensaje humano en HUMAN_MESSAGE. Solo imprime contadores. NO decide nada del agente real: es una simulación de lo que HABRÍA mostrado una cola de pendientes.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { socialOf } from "../../src/attention-filter.js";
import { classifyText } from "../../src/text-handler.js";
import { replyKind } from "./lib/analysis.js";
import { FixtureConversation, type FixtureMessage } from "./lib/schema.js";
import { invariantViolations, pending, reduce, emptyState, type ConversationEvent, type GoalKind, type PatientItem } from "./phase1/conversation-state.js";

const root = resolve(import.meta.dirname, "..", "..");
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; };
const input = resolve(root, arg("in", join("private-data", "g7", "pseudo.json")));
const alertMs = Number(arg("alert-minutes", "15")) * 60_000;
const { conversations } = z.object({ conversations: z.array(FixtureConversation) }).parse(JSON.parse(readFileSync(input, "utf8")));

const GOAL_BY_CATEGORY: Record<string, GoalKind> = { RECIPE_OR_QUOTE: "QUOTE", INFO_REQUEST: "LAB_INFO", MEDICAL: "HUMAN_ATTENTION", HUMAN_REQUEST: "HUMAN_ATTENTION", OTHER: "OTHER", GREETING: "OTHER" };
function itemsOf(messages: readonly FixtureMessage[]): PatientItem[] {
  const items: PatientItem[] = [];
  const texts = messages.filter((m) => m.text).map((m) => m.text!);
  const media = messages.filter((m) => (m.messageType ?? "text") !== "text" && m.messageType !== "reaction" && m.messageType !== "sticker");
  for (const m of media) items.push({ messageId: m.id, topic: `MEDIA_${(m.messageType ?? m.kind).toUpperCase()}`, goal: m.messageType === "image" ? "QUOTE" : "MEDIA" });
  if (texts.length > 0 && !texts.every((t) => socialOf(t) !== undefined)) {
    const joined = texts.join(" ");
    const category = classifyText(joined);
    items.push({ messageId: messages.find((m) => m.text)!.id, topic: category, goal: GOAL_BY_CATEGORY[category] ?? "OTHER" });
  }
  return items;
}

const stat = { conversations: conversations.length, questionsOpened: 0, closedByAgent: 0, closedByStaff: 0, carriedHumanPaused: 0, carriedBlocked: 0, carriedFixedOnly: 0, stillPendingAtEnd: 0, invariantViolations: 0 };
const closeMinutes: number[] = [];
const alerts = { questionsEverOverThreshold: 0, whileHumanHolds: 0, peakQueue: 0, conversationsWithAlert: 0 };
const endPending: Record<string, number> = {};

for (const conversation of conversations) {
  let state = emptyState();
  const overdue = new Set<string>();
  let flagged = false;
  const flat = conversation.batches.map((batch) => ({ batch, at: Date.parse(batch.messages[batch.messages.length - 1]!.at), first: batch.messages[0]! })).sort((a, b) => a.at - b.at);
  for (const [index, { batch, at, first }] of flat.entries()) {
    let event: ConversationEvent | undefined;
    if (first.actor === "PATIENT") { const items = itemsOf(batch.messages); if (items.length > 0) event = { id: `${batch.id}`, type: "PATIENT_BATCH", at, items }; }
    else if (first.actor === "HUMAN") event = { id: batch.id, type: "HUMAN_MESSAGE", at };
    else if (first.actor === "AGENT") { const kind = replyKind(first.text); event = { id: batch.id, type: "AGENT_REPLY", at, quality: kind === "QUOTE" ? "QUOTE" : kind === "GENERIC_FIXED" ? "GENERIC" : kind === "BLOCKED_HANDOFF" ? "BLOCKED" : "ANSWER" }; }
    if (event) state = reduce(state, event);
    // ¿Qué habría visto la recepción en este instante? (se evalúa justo antes del siguiente evento)
    const nextAt = flat[index + 1]?.at ?? at + 2 * 3600_000;
    const probe = Math.min(nextAt, at + 24 * 3600_000);
    const queue = pending(state, probe, alertMs);
    for (const question of queue) if (!overdue.has(question.id)) { overdue.add(question.id); alerts.questionsEverOverThreshold++; if (state.holder === "HUMAN") alerts.whileHumanHolds++; flagged = true; }
    alerts.peakQueue = Math.max(alerts.peakQueue, pending(state, probe, 0).length);
  }
  if (flagged) alerts.conversationsWithAlert++;
  stat.invariantViolations += invariantViolations(state).length;
  for (const question of state.questions) {
    stat.questionsOpened++;
    if (question.status === "ANSWERED") { if (question.closedBy === "AGENT") stat.closedByAgent++; else stat.closedByStaff++; if (question.closedAt) closeMinutes.push((question.closedAt - question.openedAt) / 60000); }
    if (question.status === "CARRIED") { stat.stillPendingAtEnd++; if (question.reason === "HUMAN_PAUSED") stat.carriedHumanPaused++; else if (question.reason === "HANDOFF_UNAVAILABLE") stat.carriedBlocked++; else stat.carriedFixedOnly++; endPending[question.topic] = (endPending[question.topic] ?? 0) + 1; }
    if (question.status === "OPEN") { stat.stillPendingAtEnd++; endPending[question.topic] = (endPending[question.topic] ?? 0) + 1; }
  }
}
const pct = (values: number[], q: number) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!.toFixed(1) : null);
console.log(JSON.stringify({ alertThresholdMinutes: alertMs / 60000, ...stat, minutesToClose: { p50: pct(closeMinutes, 0.5), p90: pct(closeMinutes, 0.9) }, alerts, pendingAtEndByTopic: endPending,
  note: "Simulación sobre un día. 'closedByAgent' supone que todo texto libre del agente responde la pregunta (optimista). 'closedByStaff' supone que el primer mensaje humano atiende lo pendiente. No es una medida de calidad." }, null, 2));
