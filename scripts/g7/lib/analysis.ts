// G7 · Fase 0 — Análisis de causas de fallo sobre el corpus seudonimizado. Determinista y local: sin red ni modelos.
// `report` lleva SOLO contadores y códigos (se puede imprimir). `cases` lleva extractos seudonimizados para que el DUEÑO los revise en un archivo privado: no deben imprimirse en terminal compartida.

import { socialOf } from "../../../src/attention-filter.js";
import { detectTopics } from "../../../src/knowledge-answers.js";
import { classifyText } from "../../../src/text-handler.js";
import { plain, words } from "../../../src/text-normalize.js";
import { fixedTextsIn } from "./corpus.js";
import type { FixtureConversation, FixtureMessage } from "./schema.js";

const FOOTER = "Respóndenos por este chat para continuar.";
const sec = (iso: string) => Date.parse(iso) / 1000;
const BOLIVIA_OFFSET_H = -4;
const hourBo = (iso: string) => (new Date(iso).getUTCHours() + 24 + BOLIVIA_OFFSET_H) % 24;
const count = <T extends string>(map: Record<string, number>, key: T) => { map[key] = (map[key] ?? 0) + 1; };

export type ReplyKind = "QUOTE" | "GENERIC_FIXED" | "BLOCKED_HANDOFF" | "SESSION_FIXED" | "FREE";
export function replyKind(text: string | null): ReplyKind {
  if (!text) return "FREE";
  if (text.includes(FOOTER) || (/total/i.test(text) && /ds*Bs|Bs.?s*d/i.test(text))) return "QUOTE";
  const codes = fixedTextsIn(text);
  if (codes.some((code) => code === "DRAFT:handoff_unavailable" || code === "DRAFT:medical_unavailable")) return "BLOCKED_HANDOFF";
  if (codes.some((code) => code === "DRAFT:greeting" || code === "DRAFT:send_recipe" || code === "DRAFT:fallback")) return "GENERIC_FIXED";
  if (codes.some((code) => code.startsWith("QUOTE:"))) return "SESSION_FIXED";
  return "FREE";
}

const UNSUPPORTED = new Set(["document", "location", "reaction", "sticker", "contacts", "unsupported"]);
const jaccard = (a: string, b: string) => {
  const sa = new Set(words(plain(a))); const sb = new Set(words(plain(b)));
  if (!sa.size || !sb.size) return 0;
  let inter = 0; for (const token of sa) if (sb.has(token)) inter++;
  return inter / (sa.size + sb.size - inter);
};

export interface Case { cause: string; conversation: string; batch: string; hourBolivia: number; patient: string[]; next: Array<{ actor: string; type: string | null; kind?: ReplyKind; text: string | null }> }

export interface FailureReport {
  conversations: Record<string, number>;
  openedBy: Record<string, number>;
  pausedBatches: { total: number; answeredByHuman: number; abandoned: number; byConversationOpener: Record<string, number>; abandonedAfterAgentHadReplied: number };
  humanLedConversations: { openedByHumanOrHumanFirstWithoutAgent: number; patientOpenedButAgentNeverReplied: number };
  unansweredBatchCauses: Record<string, number>;
  unansweredByHourBolivia: Record<string, number>;
  agentReplies: { byKind: Record<string, number>; toConcreteQuestion: number; genericOrBlockedToConcrete: number; byPatientCategory: Record<string, Record<string, number>> };
  blockedHandoff: { replies: number; humanTookOverWithin60Min: number; patientInsistedWithin5Min: number; patientCategories: Record<string, number> };
  humanTakeover: { conversationsWithHuman: number; firstResponderHuman: number; humanAfterAgentFixedReply: number; delaysMinutes: { p50: number | null; p90: number | null } };
  agentAfterHuman: { conversationsWithAgentAfterHuman: number; agentRepliesAfterHuman: number };
  media: { patient: Record<string, number>; imagesWithAgentReplyWithin5Min: number; imagesWithoutAgentReply: number; imagesWithQuoteWithin30Min: number; audioWithAgentReplyWithin5Min: number; unsupportedTypesIgnored: number };
  quotes: { quotesIssued: number; conversationsWithQuote: number; quotesToConversationsWithImages: number };
  caps: { conversationsWithFivePlusAgentReplies: number; maxAgentRepliesInOneConversation: number; unansweredAfterFifthReply: number };
  humanAnswered: { patientBatchesAnsweredOnlyByHuman: number; byCategory: Record<string, number>; byTopic: Record<string, number>; withMedia: number };
  agentLatency: { p50: number | null; p90: number | null };
  humanLatency: { p50: number | null; p90: number | null };
}

const pct = (values: number[], q: number) => (values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]! : null);
const textOf = (messages: readonly FixtureMessage[]) => messages.map((m) => m.text ?? "").filter(Boolean).join(" ");

export function analyze(conversations: readonly FixtureConversation[]): { report: FailureReport; cases: Case[] } {
  const cases: Case[] = [];
  const addCase = (c: Case) => { if (cases.filter((x) => x.cause === c.cause).length < 8) cases.push(c); };
  const typology: Record<string, number> = {};
  const openedBy: Record<string, number> = {};
  const paused = { total: 0, answeredByHuman: 0, abandoned: 0, byConversationOpener: {} as Record<string, number>, abandonedAfterAgentHadReplied: 0 };
  const humanLed = { openedByHumanOrHumanFirstWithoutAgent: 0, patientOpenedButAgentNeverReplied: 0 };
  const causes: Record<string, number> = {};
  const byHour: Record<string, number> = {};
  const agentKinds: Record<string, number> = {};
  const byPatientCategory: Record<string, Record<string, number>> = {};
  const blocked = { replies: 0, humanTookOverWithin60Min: 0, patientInsistedWithin5Min: 0, patientCategories: {} as Record<string, number> };
  const takeover = { conversationsWithHuman: 0, firstResponderHuman: 0, humanAfterAgentFixedReply: 0 };
  const takeoverDelays: number[] = [];
  const afterHuman = { conversationsWithAgentAfterHuman: 0, agentRepliesAfterHuman: 0 };
  const media = { patient: {} as Record<string, number>, imagesWithAgentReplyWithin5Min: 0, imagesWithoutAgentReply: 0, imagesWithQuoteWithin30Min: 0, audioWithAgentReplyWithin5Min: 0, unsupportedTypesIgnored: 0 };
  const quotes = { quotesIssued: 0, conversationsWithQuote: 0, quotesToConversationsWithImages: 0 };
  const caps = { conversationsWithFivePlusAgentReplies: 0, maxAgentRepliesInOneConversation: 0, unansweredAfterFifthReply: 0 };
  const humanAnswered = { patientBatchesAnsweredOnlyByHuman: 0, byCategory: {} as Record<string, number>, byTopic: {} as Record<string, number>, withMedia: 0 };
  let toConcrete = 0, genericToConcrete = 0;
  const agentLat: number[] = [];
  const humanLat: number[] = [];

  for (const conversation of conversations) {
    const items = conversation.batches.flatMap((batch) => batch.messages.map((message) => ({ batch, message, at: sec(message.at) }))).sort((a, b) => a.at - b.at);
    const actors = new Set(items.map((item) => item.message.actor));
    count(openedBy, items[0]?.message.actor ?? "NADIE");
    if (items[0]?.message.actor === "HUMAN") humanLed.openedByHumanOrHumanFirstWithoutAgent++;
    else if (items[0]?.message.actor === "PATIENT" && !items.some((i) => i.message.actor === "AGENT")) humanLed.patientOpenedButAgentNeverReplied++;
    const firstNonPatient = items.find((item) => item.message.actor === "AGENT" || item.message.actor === "HUMAN");
    count(typology, actors.has("AGENT") && actors.has("HUMAN") ? "AGENT_Y_HUMANO" : actors.has("AGENT") ? "SOLO_AGENTE" : actors.has("HUMAN") ? "SOLO_HUMANO" : "NADIE_RESPONDIO");
    const agentItems = items.filter((item) => item.message.actor === "AGENT");
    const humanItems = items.filter((item) => item.message.actor === "HUMAN");
    if (humanItems.length) takeover.conversationsWithHuman++;
    if (firstNonPatient?.message.actor === "HUMAN") takeover.firstResponderHuman++;
    if (agentItems.length >= 5) caps.conversationsWithFivePlusAgentReplies++;
    caps.maxAgentRepliesInOneConversation = Math.max(caps.maxAgentRepliesInOneConversation, agentItems.length);
    const agentAfterHuman = agentItems.filter((agent) => humanItems.some((human) => human.at < agent.at));
    if (agentAfterHuman.length) { afterHuman.conversationsWithAgentAfterHuman++; afterHuman.agentRepliesAfterHuman += agentAfterHuman.length; }
    const hasImage = items.some((item) => item.message.actor === "PATIENT" && item.message.messageType === "image");
    const quoteItems = agentItems.filter((item) => replyKind(item.message.text) === "QUOTE");
    quotes.quotesIssued += quoteItems.length;
    if (quoteItems.length) { quotes.conversationsWithQuote++; if (hasImage) quotes.quotesToConversationsWithImages++; }

    const batches = conversation.batches;
    for (const [index, batch] of batches.entries()) {
      const first = batch.messages[0]!;
      const start = sec(first.at);
      const end = sec(batch.messages[batch.messages.length - 1]!.at);
      if (first.actor === "AGENT") {
        const kind = replyKind(first.text);
        count(agentKinds, kind);
        // ¿A qué estaba respondiendo? El último lote del paciente anterior.
        const prev = [...batches.slice(0, index)].reverse().find((candidate) => candidate.messages[0]!.actor === "PATIENT");
        if (prev) {
          const prevText = textOf(prev.messages);
          const category = prevText ? classifyText(prevText) : "SIN_TEXTO";
          const concrete = prevText.includes("?") || ["INFO_REQUEST", "RECIPE_OR_QUOTE", "MEDICAL", "HUMAN_REQUEST"].includes(category);
          (byPatientCategory[category] ??= {})[kind] = (byPatientCategory[category]![kind] ?? 0) + 1;
          if (concrete) { toConcrete++; if (kind === "GENERIC_FIXED" || kind === "BLOCKED_HANDOFF") { genericToConcrete++; addCase({ cause: "AGENTE_GENERICO_ANTE_PREGUNTA_CONCRETA", conversation: conversation.id, batch: batch.id, hourBolivia: hourBo(first.at), patient: prev.messages.map((m) => m.text ?? `[${m.messageType}]`), next: [{ actor: "AGENT", type: first.messageType, kind, text: first.text }] }); } }
          agentLat.push(start - sec(prev.messages[prev.messages.length - 1]!.at));
        }
        if (kind === "BLOCKED_HANDOFF") {
          blocked.replies++;
          const laterHuman = humanItems.find((item) => item.at > start && item.at - start <= 3600);
          if (laterHuman) { blocked.humanTookOverWithin60Min++; takeoverDelays.push((laterHuman.at - start) / 60); }
          const insisted = batches.slice(index + 1).find((candidate) => candidate.messages[0]!.actor === "PATIENT" && sec(candidate.messages[0]!.at) - start <= 300);
          if (insisted) blocked.patientInsistedWithin5Min++;
          if (prev) count(blocked.patientCategories, classifyText(textOf(prev.messages)) || "SIN_TEXTO");
        }
        if (kind === "GENERIC_FIXED" || kind === "BLOCKED_HANDOFF") {
          const later = humanItems.find((item) => item.at > start && item.at - start <= 3600);
          if (later) takeover.humanAfterAgentFixedReply++;
        }
        continue;
      }
      if (first.actor === "HUMAN") {
        const prev = [...batches.slice(0, index)].reverse().find((candidate) => candidate.messages[0]!.actor === "PATIENT");
        if (prev) humanLat.push(start - sec(prev.messages[prev.messages.length - 1]!.at));
        continue;
      }
      if (first.actor !== "PATIENT") continue;

      // Tipos de mensaje del paciente
      for (const message of batch.messages) count(media.patient, message.messageType ?? message.kind.toLowerCase());
      const types = batch.messages.map((m) => m.messageType ?? m.kind.toLowerCase());
      const texts = batch.messages.map((m) => m.text).filter((t): t is string => Boolean(t));
      const next = batches.slice(index + 1);
      const untilNext = next.findIndex((c) => c.messages[0]!.actor === "PATIENT" && sec(c.messages[0]!.at) > end);
      const window = (untilNext < 0 ? next : next.slice(0, untilNext)).filter((c) => sec(c.messages[0]!.at) - end <= 7200);
      const agentReplies = window.filter((c) => c.messages[0]!.actor === "AGENT");
      const humanReplies = window.filter((c) => c.messages[0]!.actor === "HUMAN");
      const category = texts.length ? classifyText(texts.join(" ")) : "SIN_TEXTO";
      const topics = texts.length ? detectTopics(texts.join(" "), true).map((t) => t.kind) : [];
      const hasMedia = types.some((t) => t === "image" || t === "document" || t === "audio");
      const hr = String(hourBo(first.at)).padStart(2, "0");

      // Medios
      const agentWithin = (seconds: number) => items.some((i) => i.message.actor === "AGENT" && i.at > end && i.at - end <= seconds);
      if (types.includes("image")) { if (agentWithin(300)) media.imagesWithAgentReplyWithin5Min++; else media.imagesWithoutAgentReply++; if (quoteItems.some((q) => q.at > end && q.at - end <= 1800)) media.imagesWithQuoteWithin30Min++; }
      if (types.includes("audio") && agentWithin(300)) media.audioWithAgentReplyWithin5Min++;

      if (agentReplies.length === 0) {
        // ¿Causa?
        const socialOnly = texts.length > 0 && texts.every((t) => socialOf(t) !== undefined) && !types.some((t) => t !== "text");
        const unsupportedOnly = types.every((t) => UNSUPPORTED.has(t));
        const lastHuman = [...humanItems].reverse().find((h) => h.at < start);
        const pausedByHuman = Boolean(lastHuman) && !agentItems.some((a) => a.at > lastHuman!.at && a.at < start);
        const agentRepliesBefore = agentItems.filter((a) => a.at < start && start - a.at <= 86400).length;
        const mergedSoon = (() => { const nextAgent = agentItems.find((a) => a.at > end); if (!nextAgent || nextAgent.at - end > 90) return false; return !humanItems.some((h) => h.at > end && h.at < nextAgent.at); })();
        let cause: string;
        if (socialOnly) cause = "SOCIAL_SIN_RESPUESTA (esperado)";
        else if (unsupportedOnly) { cause = "TIPO_NO_SOPORTADO_IGNORADO"; media.unsupportedTypesIgnored++; }
        else if (pausedByHuman) { cause = "PAUSA_HUMANA_ACTIVA"; paused.total++; count(paused.byConversationOpener, items[0]?.message.actor ?? "NADIE"); if (humanReplies.length) paused.answeredByHuman++; else { paused.abandoned++; if (agentItems.some((a) => a.at < start)) paused.abandonedAfterAgentHadReplied++; } }
        else if (agentRepliesBefore >= 5) cause = "TOPE_5_RESPUESTAS_24H";
        else if (mergedSoon) cause = "FUSIONADO_CON_LA_SIGUIENTE_RESPUESTA";
        else if (types.includes("image")) cause = "FOTO_SIN_RESPUESTA_INMEDIATA";
        else if (types.includes("audio")) cause = "AUDIO_SIN_RESPUESTA";
        else cause = humanReplies.length ? "SIN_AGENTE_RESPONDIO_HUMANO" : "SIN_RESPUESTA_CAUSA_DESCONOCIDA";
        count(causes, cause);
        if (!socialOnly) count(byHour, hr);
        if (agentRepliesBefore >= 5 && !socialOnly) caps.unansweredAfterFifthReply++;
        if (humanReplies.length && agentReplies.length === 0 && !pausedByHuman) { /* el humano contestó sin pausa previa */ }
        if (humanReplies.length > 0 && agentReplies.length === 0 && !socialOnly) {
          humanAnswered.patientBatchesAnsweredOnlyByHuman++;
          count(humanAnswered.byCategory, category);
          for (const topic of new Set(topics)) count(humanAnswered.byTopic, topic);
          if (hasMedia) humanAnswered.withMedia++;
        }
        if (!socialOnly) addCase({ cause, conversation: conversation.id, batch: batch.id, hourBolivia: hourBo(first.at), patient: batch.messages.map((m) => m.text ?? `[${m.messageType}]`), next: window.slice(0, 2).map((c) => ({ actor: c.messages[0]!.actor, type: c.messages[0]!.messageType, text: c.messages[0]!.text })) });
      }
      // Repregunta tras respuesta del agente
      if (agentReplies.length > 0 && untilNext >= 0) {
        const nextPatient = next[untilNext]!;
        if (sec(nextPatient.messages[0]!.at) - sec(agentReplies[0]!.messages[0]!.at) <= 300 && jaccard(textOf(batch.messages), textOf(nextPatient.messages)) >= 0.6) addCase({ cause: "PACIENTE_REPITE_TRAS_RESPUESTA", conversation: conversation.id, batch: batch.id, hourBolivia: hourBo(first.at), patient: batch.messages.map((m) => m.text ?? `[${m.messageType}]`), next: [{ actor: "AGENT", type: null, kind: replyKind(agentReplies[0]!.messages[0]!.text), text: agentReplies[0]!.messages[0]!.text }] });
      }
    }
  }

  const report: FailureReport = {
    conversations: typology,
    openedBy,
    pausedBatches: paused,
    humanLedConversations: humanLed,
    unansweredBatchCauses: causes,
    unansweredByHourBolivia: Object.fromEntries(Object.entries(byHour).sort()),
    agentReplies: { byKind: agentKinds, toConcreteQuestion: toConcrete, genericOrBlockedToConcrete: genericToConcrete, byPatientCategory },
    blockedHandoff: blocked,
    humanTakeover: { ...takeover, delaysMinutes: { p50: pct(takeoverDelays, 0.5), p90: pct(takeoverDelays, 0.9) } },
    agentAfterHuman: afterHuman,
    media,
    quotes,
    caps,
    humanAnswered,
    agentLatency: { p50: pct(agentLat, 0.5), p90: pct(agentLat, 0.9) },
    humanLatency: { p50: pct(humanLat, 0.5), p90: pct(humanLat, 0.9) }
  };
  return { report, cases };
}
