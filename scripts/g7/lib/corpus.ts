// G7 · Fase 0 — Lectura, verificación, agrupación en lotes y métricas de línea base del corpus de conversaciones. Funciones puras.
// Los informes que produce llevan SOLO contadores y códigos (nunca texto), salvo `fixture`, que ya viene seudonimizado.

import { socialOf } from "../../../src/attention-filter.js";
import { classifyText, DRAFT_TEXTS } from "../../../src/text-handler.js";
import { ANSWER_TEXTS } from "../../../src/knowledge-answers.js";
import { QUOTE_TEXTS } from "../../../src/quote-session.js";
import { plain, words } from "../../../src/text-normalize.js";
import { FixtureConversation, RawMessage, type FixtureBatch, type FixtureMessage } from "./schema.js";
import { createPseudonymizer, maskResidualNames, residualNameCandidates } from "./pseudonymize.js";

export const KAPSO_WINDOW_SECONDS = 15;

// ───────────────────────────── lectura ─────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { out.push(cell); cell = ""; }
    else cell += char;
  }
  out.push(cell);
  return out;
}

// Une las líneas de un CSV con celdas entre comillas que contienen saltos de línea.
function csvRecords(raw: string): string[] {
  const records: string[] = [];
  let current = "";
  let quotes = 0;
  for (const line of raw.split(/\r?\n/)) {
    current = current === "" ? line : `${current}\n${line}`;
    quotes += (line.match(/"/g) ?? []).length;
    if (quotes % 2 === 0) { if (current !== "") records.push(current); current = ""; quotes = 0; }
  }
  if (current !== "") records.push(current);
  return records;
}

export interface ReadResult { messages: RawMessage[]; invalid: number; format: "jsonl" | "csv" | "sql-rows" }

// Formato de una consulta directa a la tabla plusmedik_message_history (columnas de la base): seq, occurred_at, contact_phone, contact_key, direction, actor, origin, message_type, body, delivery_state,
// provider_message_id. No trae replyTo ni auditRunId (esos vínculos solo los entrega el exportador oficial).
const KIND_BY_TYPE: Record<string, RawMessage["kind"]> = { text: "TEXT", image: "IMAGE", audio: "AUDIO" };
export function fromHistoryRow(row: Record<string, unknown>): Record<string, unknown> {
  const body = typeof row.body === "string" && row.body !== "" ? row.body : undefined;
  const type = typeof row.message_type === "string" ? row.message_type.toLowerCase() : "";
  return {
    seq: row.seq, at: row.occurred_at, contactKey: row.contact_key, contactPhone: row.contact_phone ?? null, messageId: row.provider_message_id,
    direction: row.direction, actor: row.actor, origin: row.origin ?? null, kind: KIND_BY_TYPE[type] ?? "OTHER", messageType: type || null, mediaRef: null,
    state: row.delivery_state, deliveryAt: null, auditRunId: null, replyTo: null, textStatus: body === undefined ? "NONE" : "OK", ...(body !== undefined ? { text: body } : {})
  };
}

export function readRaw(content: string): ReadResult {
  const trimmed = content.trimStart();
  const messages: RawMessage[] = [];
  let invalid = 0;
  if (trimmed.startsWith("{")) {
    let sqlRows = false;
    for (const line of content.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        let record = JSON.parse(line) as Record<string, unknown>;
        if ("occurred_at" in record && "provider_message_id" in record) { sqlRows = true; record = fromHistoryRow(record); }
        const parsed = RawMessage.safeParse(record);
        if (parsed.success) messages.push(parsed.data); else invalid++;
      } catch { invalid++; }
    }
    return { messages, invalid, format: sqlRows ? "sql-rows" : "jsonl" };
  }
  const [header, ...rows] = csvRecords(content);
  const columns = parseCsvLine(header ?? "");
  for (const row of rows) {
    const cells = parseCsvLine(row);
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      let value: unknown = cells[index] ?? "";
      if (typeof value === "string" && /^'[=+\-@\t\r]/.test(value)) value = value.slice(1); // neutralización de fórmulas del exportador
      if (value === "") value = column === "text" ? undefined : null;
      if (column === "seq" && typeof value === "string") value = Number(value);
      record[column] = value;
    });
    const parsed = RawMessage.safeParse(record);
    if (parsed.success) messages.push(parsed.data); else invalid++;
  }
  return { messages, invalid, format: "csv" };
}

// ───────────────────────────── verificación ─────────────────────────────

const seconds = (iso: string) => Date.parse(iso) / 1000;
const tally = <T extends string>(values: readonly T[]) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));

export interface VerifyReport {
  format: "jsonl" | "csv" | "sql-rows";
  total: number;
  invalidRecords: number;
  matchesExpectedTotal: boolean | null;
  duplicateMessageIds: number;
  contacts: number;
  messagesPerContact: { min: number; median: number; max: number };
  range: { from: string; to: string } | null;
  byActor: Record<string, number>;
  byKind: Record<string, number>;
  byState: Record<string, number>;
  textStatus: Record<string, number>;
  withTextPct: number;
  seqOutOfOrderByTime: number;
  replyToOrphans: number;
  missingTimestamp: number;
  withoutPhone: number;
  daysCovered: string[];
}

export function verify(read: ReadResult, expectedTotal?: number): VerifyReport {
  const { messages } = read;
  const ids = new Set<string>();
  let duplicates = 0;
  for (const message of messages) { if (ids.has(message.messageId)) duplicates++; ids.add(message.messageId); }
  const perContact = new Map<string, number>();
  for (const message of messages) perContact.set(message.contactKey, (perContact.get(message.contactKey) ?? 0) + 1);
  const counts = [...perContact.values()].sort((a, b) => a - b);
  const times = messages.map((message) => seconds(message.at)).filter((value) => Number.isFinite(value));
  const bySeq = [...messages].sort((a, b) => a.seq - b.seq);
  let outOfOrder = 0;
  for (let index = 1; index < bySeq.length; index++) if (seconds(bySeq[index]!.at) + 1 < seconds(bySeq[index - 1]!.at)) outOfOrder++;
  const withText = messages.filter((message) => message.textStatus === "OK").length;
  return {
    format: read.format,
    total: messages.length,
    invalidRecords: read.invalid,
    matchesExpectedTotal: expectedTotal === undefined ? null : messages.length === expectedTotal,
    duplicateMessageIds: duplicates,
    contacts: perContact.size,
    messagesPerContact: { min: counts[0] ?? 0, median: counts[Math.floor(counts.length / 2)] ?? 0, max: counts[counts.length - 1] ?? 0 },
    range: times.length > 0 ? { from: new Date(Math.min(...times) * 1000).toISOString(), to: new Date(Math.max(...times) * 1000).toISOString() } : null,
    byActor: tally(messages.map((message) => message.actor)),
    byKind: tally(messages.map((message) => `${message.direction}:${message.messageType ?? message.kind}`)),
    byState: tally(messages.map((message) => message.state)),
    textStatus: tally(messages.map((message) => message.textStatus)),
    withTextPct: messages.length === 0 ? 0 : Number(((withText / messages.length) * 100).toFixed(1)),
    seqOutOfOrderByTime: outOfOrder,
    replyToOrphans: messages.filter((message) => message.replyTo && !ids.has(message.replyTo)).length,
    missingTimestamp: messages.filter((message) => !Number.isFinite(seconds(message.at))).length,
    withoutPhone: messages.filter((message) => !message.contactPhone).length,
    daysCovered: [...new Set(messages.map((message) => message.at.slice(0, 10)))].sort()
  };
}

// ───────────────────────────── seudonimización + lotes ─────────────────────────────

export interface BuildResult {
  conversations: FixtureConversation[];
  equivalences: { phones: Record<string, string>; contacts: Record<string, string> };
  stats: ReturnType<typeof createPseudonymizer>["stats"];
  residualNameTexts: number;
  // Solo para revisión local: candidatos a nombre residual (id de mensaje → palabras). NO va al informe.
  residualCandidates: Record<string, string[]>;
}

export function buildFixture(messages: readonly RawMessage[], options: { maskResidual?: boolean } = {}): BuildResult {
  const pseudo = createPseudonymizer();
  const byContact = new Map<string, RawMessage[]>();
  for (const message of messages) byContact.set(message.contactKey, [...(byContact.get(message.contactKey) ?? []), message]);
  // Los seudónimos de contacto se asignan por orden de aparición (seq mínimo) para que sean estables.
  const order = [...byContact.entries()].sort((a, b) => Math.min(...a[1].map((m) => m.seq)) - Math.min(...b[1].map((m) => m.seq)));
  const idOf = new Map<string, string>();
  let counter = 0;
  const messageLabel = (id: string) => idOf.get(id) ?? (idOf.set(id, `M${String(++counter).padStart(4, "0")}`), idOf.get(id)!);
  // Primero se asignan todos los ids para que replyTo apunte a mensajes posteriores sin problema.
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) messageLabel(message.messageId);

  const conversations: FixtureConversation[] = [];
  let residual = 0;
  const residualCandidates: Record<string, string[]> = {};
  for (const [contactKey, list] of order) {
    const sorted = [...list].sort((a, b) => seconds(a.at) - seconds(b.at) || a.seq - b.seq);
    const conversationId = pseudo.contact(contactKey);
    pseudo.phone(sorted.find((message) => message.contactPhone)?.contactPhone);
    const fixtureMessages: FixtureMessage[] = sorted.map((message) => {
      let text = message.textStatus === "OK" && typeof message.text === "string" ? pseudo.text(message.text) : null;
      if (text) {
        const candidates = residualNameCandidates(text);
        if (candidates.length > 0) { residual++; residualCandidates[messageLabel(message.messageId)] = candidates; }
        if (options.maskResidual !== false) text = maskResidualNames(text).text;
      }
      return { id: messageLabel(message.messageId), at: message.at, actor: message.actor, kind: message.kind, state: message.state, replyTo: message.replyTo ? messageLabel(message.replyTo) : null, hasAuditRun: Boolean(message.auditRunId), messageType: message.messageType ?? null, origin: message.origin ?? null, text };
    });
    conversations.push(FixtureConversation.parse({ id: conversationId, messageCount: fixtureMessages.length, batches: toBatches(conversationId, fixtureMessages) }));
  }
  return { conversations, equivalences: pseudo.equivalences(), stats: pseudo.stats, residualNameTexts: residual, residualCandidates };
}

// Reconstruye los lotes que Kapso habría entregado: mensajes del paciente dentro de una ventana FIJA de 15 s desde el primero, sin otro actor en medio. Todo lo demás es un lote de un mensaje.
export function toBatches(conversationId: string, messages: readonly FixtureMessage[]): FixtureBatch[] {
  const batches: FixtureBatch[] = [];
  let open: { start: number; batch: FixtureBatch } | undefined;
  for (const message of messages) {
    const at = seconds(message.at);
    if (message.actor === "PATIENT") {
      if (open && at - open.start <= KAPSO_WINDOW_SECONDS) { open.batch.messages.push(message); continue; }
      const batch: FixtureBatch = { id: `${conversationId}-B${String(batches.length + 1).padStart(3, "0")}`, startedAt: message.at, messages: [message] };
      batches.push(batch);
      open = { start: at, batch };
    } else {
      batches.push({ id: `${conversationId}-B${String(batches.length + 1).padStart(3, "0")}`, startedAt: message.at, messages: [message] });
      open = undefined;
    }
  }
  return batches;
}

// ───────────────────────────── métricas de línea base (solo contadores) ─────────────────────────────

const FIXED: Array<{ code: string; text: string }> = [
  ...Object.entries(DRAFT_TEXTS).map(([key, text]) => ({ code: `DRAFT:${key}`, text })),
  ...Object.entries(ANSWER_TEXTS).filter(([, text]) => typeof text === "string").map(([key, text]) => ({ code: `ANSWER:${key}`, text: text as string })),
  ...Object.entries(QUOTE_TEXTS).filter(([, text]) => typeof text === "string").map(([key, text]) => ({ code: `QUOTE:${key}`, text: text as string }))
];
const GENERIC_CODES = new Set(["DRAFT:greeting", "DRAFT:send_recipe", "DRAFT:fallback"]);
const BLOCKED_CODES = new Set(["DRAFT:handoff_unavailable", "DRAFT:medical_unavailable"]);

// Códigos de los textos fijos que contiene una respuesta del agente (puede ser un mensaje combinado de varias partes).
export function fixedTextsIn(body: string): string[] {
  const parts = body.split(/\n{2,}/).map((part) => part.trim());
  const codes = new Set<string>();
  for (const part of parts) for (const fixed of FIXED) if (part === fixed.text.trim()) codes.add(fixed.code);
  return [...codes];
}

const percentile = (values: number[], q: number) => (values.length === 0 ? null : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!);
const questionCount = (text: string) => (text.match(/\?/g) ?? []).length;
const jaccard = (a: string, b: string) => {
  const sa = new Set(words(plain(a))); const sb = new Set(words(plain(b)));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0; for (const token of sa) if (sb.has(token)) inter++;
  return inter / (sa.size + sb.size - inter);
};

export interface BaselineReport {
  conversations: number;
  batches: number;
  patientBatches: number;
  agentReplies: number;
  agentReplyShare: { generic: number; blockedHandoff: number; otherFixed: number; free: number };
  fixedByCode: Record<string, number>;
  unansweredPatientBatches: { total: number; socialOnly: number; followedByHuman: number; other: number };
  multiQuestion: { patientMessagesWithTwoPlusQuestions: number; batchesWithTwoPlusQuestionsAndOneAgentReply: number };
  humanLoop: { humanMessages: number; patientBatchesWithin30MinAfterHuman: number; agentRepliedWithin30MinAfterHuman: number };
  reAsks: { patientRepeatsAfterAgentReply: number };
  latencySeconds: { p50: number | null; p90: number | null; max: number | null; samples: number };
  routing: Record<string, number>;
  patientMessages: Record<string, number>;
  deliveryFailures: number;
}

export function baseline(conversations: readonly FixtureConversation[]): BaselineReport {
  const fixedByCode: Record<string, number> = {};
  const share = { generic: 0, blockedHandoff: 0, otherFixed: 0, free: 0 };
  const unanswered = { total: 0, socialOnly: 0, followedByHuman: 0, other: 0 };
  const routing: Record<string, number> = {};
  const latencies: number[] = [];
  const human = { humanMessages: 0, patientBatchesWithin30MinAfterHuman: 0, agentRepliedWithin30MinAfterHuman: 0 };
  const pm: Record<string, number> = {};
  let batchCount = 0, patientBatches = 0, agentReplies = 0, multiMsgs = 0, multiBatches = 0, reAsks = 0, failures = 0;

  for (const conversation of conversations) {
    const batches = conversation.batches;
    batchCount += batches.length;
    let lastHumanAt: number | undefined;
    const agentAtAfterHuman = new Set<number>();
    for (const [index, batch] of batches.entries()) {
      const first = batch.messages[0]!;
      if (first.actor === "HUMAN") { human.humanMessages++; lastHumanAt = seconds(first.at); }
      if (first.state === "FAILED") failures++;
      if (first.actor === "AGENT") {
        agentReplies++;
        const codes = first.text ? fixedTextsIn(first.text) : [];
        for (const code of codes) fixedByCode[code] = (fixedByCode[code] ?? 0) + 1;
        if (codes.some((code) => GENERIC_CODES.has(code))) share.generic++;
        else if (codes.some((code) => BLOCKED_CODES.has(code))) share.blockedHandoff++;
        else if (codes.length > 0) share.otherFixed++;
        else share.free++;
        if (lastHumanAt !== undefined && seconds(first.at) - lastHumanAt <= 1800 && !agentAtAfterHuman.has(lastHumanAt)) { human.agentRepliedWithin30MinAfterHuman++; agentAtAfterHuman.add(lastHumanAt); }
        // Respuestas repetidas del agente tras repreguntas del paciente
        continue;
      }
      if (first.actor !== "PATIENT") continue;
      patientBatches++;
      if (lastHumanAt !== undefined && seconds(first.at) - lastHumanAt <= 1800) human.patientBatchesWithin30MinAfterHuman++;
      let batchQuestions = 0;
      for (const message of batch.messages) {
        const type = message.messageType ?? message.kind.toLowerCase(); pm[type] = (pm[type] ?? 0) + 1;
        if (message.text) {
          const category = classifyText(message.text);
          routing[category] = (routing[category] ?? 0) + 1;
          const questions = questionCount(message.text);
          batchQuestions += questions;
          if (questions >= 2) multiMsgs++;
        }
      }
      // ¿Quién contesta antes del siguiente lote del paciente?
      const next = batches.slice(index + 1);
      const untilNextPatient = next.findIndex((candidate) => candidate.messages[0]!.actor === "PATIENT");
      const window = untilNextPatient < 0 ? next : next.slice(0, untilNextPatient);
      const replies = window.filter((candidate) => candidate.messages[0]!.actor === "AGENT");
      const humans = window.filter((candidate) => candidate.messages[0]!.actor === "HUMAN");
      const lastAt = seconds(batch.messages[batch.messages.length - 1]!.at);
      if (replies.length > 0) latencies.push(seconds(replies[0]!.messages[0]!.at) - lastAt);
      if (batchQuestions >= 2 && replies.length === 1) multiBatches++;
      if (replies.length === 0) {
        unanswered.total++;
        const texts = batch.messages.map((message) => message.text).filter((text): text is string => Boolean(text));
        if (texts.length > 0 && texts.every((text) => socialOf(text) !== undefined)) unanswered.socialOnly++;
        else if (humans.length > 0) unanswered.followedByHuman++;
        else unanswered.other++;
      }
      // Repregunta: el paciente repite (casi) lo mismo después de que el agente contestó
      const nextPatient = untilNextPatient >= 0 ? next[untilNextPatient] : undefined;
      if (nextPatient && replies.length > 0) {
        const a = batch.messages.map((message) => message.text ?? "").join(" ");
        const b = nextPatient.messages.map((message) => message.text ?? "").join(" ");
        if (a.trim() !== "" && b.trim() !== "" && jaccard(a, b) >= 0.7) reAsks++;
      }
    }
  }
  return {
    conversations: conversations.length,
    batches: batchCount,
    patientBatches,
    agentReplies,
    agentReplyShare: share,
    fixedByCode,
    unansweredPatientBatches: unanswered,
    multiQuestion: { patientMessagesWithTwoPlusQuestions: multiMsgs, batchesWithTwoPlusQuestionsAndOneAgentReply: multiBatches },
    humanLoop: human,
    reAsks: { patientRepeatsAfterAgentReply: reAsks },
    latencySeconds: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9), max: latencies.length ? Math.max(...latencies) : null, samples: latencies.length },
    routing,
    patientMessages: pm,
    deliveryFailures: failures
  };
}
