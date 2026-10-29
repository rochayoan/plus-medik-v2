import { createHash } from "node:crypto";
import type { AnalysisResult } from "./analyze.js";
import { catalogFingerprint, processingFailureCode, type AuditLease, type AuditRepository, type ProcessingPhase } from "./audit.js";
import { withAiCallObserver, type AiCallEvent } from "./cache.js";
import type { Produced, TurnContext, TurnProducer } from "./guarded-turn.js";
import {
  assertSafeQuoteTexts, DEFAULT_QUOTE_SESSIONS, evaluateSession, extractStudyRequests, formatAck, formatSessionQuote, formatTextReply, isGeneralQuestion, optionsOf, parseSessionCommand, parseSessionReply, QUOTE_TEXTS,
  summarizeSession, type ItemResult, type QuoteBeginResult, type QuoteCloseInput, type QuoteCloseResult, type QuoteReadResult, type QuoteSessionsConfig, type QuoteTexts, type SessionItem, type SessionReply, type TextDoubt
} from "./quote-session.js";
import { looksAutomated, looksLikeOwnReply } from "./reply-guard.js";
import { asksForPrice, classifyText } from "./text-handler.js";
import type { CatalogStudy } from "./types.js";
import { buildAnalysisLog, detectImageMime, MAX_IMAGE_BYTES, maskPhone, TECHNICAL_ISSUE_MESSAGE, type IncomingImage, type QuoteDeps } from "./whatsapp-quote.js";

// El TRABAJO de los turnos en modo sesión (G4.0): imágenes y textos NO se responden con una cotización inmediata; se agregan a la sesión del contacto y la cotización sale
// solo cuando el paciente escribe «listo». Todo lo demás (claim con lease, reserva de envío, pausa humana, guarda antibucles, un envío incierto jamás se reenvía) sigue siendo
// la máquina común de guarded-turn.ts. Con sesiones apagadas este archivo no se usa y el flujo de imágenes (whatsapp-quote.ts) queda exactamente como estaba.

class SessionUnavailableError extends Error {
  constructor(readonly stage: string) {
    super(`quote session unavailable: ${stage}`);
    this.name = "SessionUnavailableError";
  }
}

export interface SessionTurn {
  messageId: string;
  from: string;
  // Solo en memoria: el contenido de un mensaje de texto NUNCA se registra.
  text?: string;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const UNREADABLE = (reason: "UNREADABLE_IMAGE" | "UNSUPPORTED_IMAGE"): ItemResult => ({ status: "UNREADABLE", studyIds: [], ambiguous: [], unresolved: 0, reasons: [reason] });

// Lo que el motor de recetas decidió sobre UNA foto, traducido a lo que la sesión necesita: solo cuenta como identificada si el motor la cotizó COMPLETA; un resultado parcial es
// dudoso (la sesión no cotiza sobre dudas) y una foto sin cotización posible es ilegible (se pide otra). No se interpreta nada por cuenta propia.
export function itemFromAnalysis(analysis: AnalysisResult): ItemResult {
  const lines = analysis.internal?.quoted.lines ?? analysis.quote?.lines ?? [];
  const studyIds = [...new Set(lines.map((line) => line.id))];
  const hasQuote = Boolean(analysis.publicQuote) || Boolean(analysis.quote);
  if (analysis.outcome === "HUMAN_REVIEW" || !hasQuote || studyIds.length === 0) return UNREADABLE("UNREADABLE_IMAGE");
  const complete = analysis.outcome ? analysis.outcome === "AUTO_COMPLETE" : analysis.decision === "AUTO_SAFE";
  return complete
    ? { status: "RESOLVED", studyIds, ambiguous: [], unresolved: 0, reasons: [] }
    : { status: "UNCERTAIN", studyIds, ambiguous: [], unresolved: 0, reasons: ["ENGINE_PARTIAL"] };
}

const namesOf = (ids: readonly string[], catalog: readonly CatalogStudy[]): string[] => {
  const byId = new Map(catalog.map((study) => [study.id, study.name]));
  return ids.map((id) => byId.get(id)).filter((name): name is string => Boolean(name));
};

function needs<K extends "quoteBegin" | "quoteFinish" | "quoteRead" | "quoteClose">(audit: AuditRepository, method: K): NonNullable<AuditRepository[K]> {
  const fn = audit[method];
  if (!fn) throw new SessionUnavailableError(method);
  return fn.bind(audit) as NonNullable<AuditRepository[K]>;
}

// Ejecuta una operación de sesión con el lease de ESTA ejecución y devuelve su resultado. Un fallo (base caída, migración sin aplicar, lease perdido) no se oculta: el turno sigue por
// la ruta de fallo técnico y NUNCA se responde como si se hubiera anotado algo.
async function withSession<T>(ctx: TurnContext, stage: string, action: (audit: AuditRepository, runId: string, lease: AuditLease) => Promise<T>): Promise<T> {
  if (!ctx.guarded) throw new SessionUnavailableError(stage);
  let value: { v: T } | undefined;
  const ok = await ctx.persist(stage, async (audit, runId, lease) => {
    value = { v: await action(audit, runId, lease) };
  });
  if (!ok || !value) throw new SessionUnavailableError(stage);
  return value.v;
}

const failureReply = (): Produced => ({ kind: "reply", body: TECHNICAL_ISSUE_MESSAGE, result: "technical_issue", processingStatus: "FAILED", stale: "NEWER_TURN" });
const plain = (body: string): Produced => ({ kind: "reply", body, result: "no_quote", processingStatus: "COMPLETED", stale: "NONE" });
// Pregunta al paciente (una duda por aclarar, o si ya terminó): su firma lleva la cantidad de mensajes, así dos preguntas distintas no cuentan como una repetición para la guarda antibucles.
const ask = (body: string, count: number): Produced => ({ kind: "reply", body, result: "conversation", processingStatus: "COMPLETED", stale: "NEWER_TURN", signature: `QUOTE_ASK:${count}` });
const ack = (body: string, position: number): Produced => ({ kind: "reply", body, result: "conversation", processingStatus: "COMPLETED", stale: "NEWER_TURN", signature: `QUOTE_ADDED:${position}` });

export function resolveQuoteSessionsConfig(config?: Partial<QuoteSessionsConfig>): QuoteSessionsConfig {
  assertSafeQuoteTexts(QUOTE_TEXTS);
  return { ...DEFAULT_QUOTE_SESSIONS, ...config };
}

// ───────────────────────────── imagen ─────────────────────────────

export function sessionImageProducer(image: IncomingImage, deps: QuoteDeps, config: QuoteSessionsConfig, texts: QuoteTexts = QUOTE_TEXTS): TurnProducer {
  const who = maskPhone(image.from);
  const begin = (ctx: TurnContext, input: { imageHash?: string; result?: ItemResult }): Promise<QuoteBeginResult> =>
    withSession(ctx, "quote_begin", (audit, runId, lease) => needs(audit, "quoteBegin")(runId, lease, { kind: "IMAGE", ...input, ttlSeconds: config.ttlSeconds, maxItems: config.maxItems }));
  return async (ctx): Promise<Produced> => {
    const aiCalls: AiCallEvent[] = [];
    let phase: ProcessingPhase = "MEDIA_DOWNLOAD";
    let evidenceAttempted = false;
    let began = false;
    try {
      const { bytes } = await deps.downloadImage(image);
      phase = "OTHER";
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        deps.log("image_rejected_size", { messageId: image.messageId, phone: who, bytes: bytes.length });
        // la sesión debe saber que hubo una foto que no se pudo usar (si no, «listo» cotizaría sin ella)
        await begin(ctx, { result: UNREADABLE("UNSUPPORTED_IMAGE") });
        await ctx.persist("image", (audit, runId, lease) => audit.recordIgnored(runId, "IMAGE_SIZE", lease));
        return { kind: "none" };
      }
      const mimeType = detectImageMime(bytes);
      if (!mimeType) {
        deps.log("image_rejected_type", { messageId: image.messageId, phone: who });
        await begin(ctx, { result: UNREADABLE("UNSUPPORTED_IMAGE") });
        await ctx.persist("image", (audit, runId, lease) => audit.recordIgnored(runId, "IMAGE_TYPE", lease));
        return plain(texts.unreadable_image);
      }

      // El hash identifica la MISMA foto reenviada en la sesión: se detecta antes de gastar un análisis.
      const imageHash = createHash("sha256").update(bytes).digest("hex");
      const begun = await begin(ctx, { imageHash });
      began = true;
      deps.log("quote_session", { event: "image_item", status: begun.status, ...("position" in begun ? { position: begun.position } : {}) });
      if (begun.status === "full") return plain(texts.full);
      if (begun.status === "duplicate") return plain(texts.duplicate_image);

      phase = "CATALOG_LOAD";
      const catalog = await deps.loadCatalog();
      if (begun.status === "exists" && begun.itemStatus !== "PROCESSING") {
        // Una ejecución anterior ya terminó el análisis de ESTA foto (reclamó el lease tras una caída): no se vuelve a analizar.
        return ack(formatAck({ texts, kind: "IMAGE", names: namesOf(begun.studyIds, catalog), position: begun.position, hasDoubt: begun.itemStatus !== "RESOLVED", repeated: 0 }), begun.position);
      }
      phase = "AI_ANALYSIS";
      const analysis = await withAiCallObserver(
        (event) => aiCalls.push(event),
        () => deps.analyze({ imageBase64: Buffer.from(bytes).toString("base64"), mimeType, catalog })
      );
      phase = "OTHER";
      deps.log("analysis", { messageId: image.messageId, phone: who, ...buildAnalysisLog(analysis) });
      evidenceAttempted = true;
      await ctx.persist("evidence", (audit, runId, lease) => audit.recordEvidence(runId, { analysis, aiCalls, catalog: catalogFingerprint(catalog) }, lease));
      const item = itemFromAnalysis(analysis);
      await withSession(ctx, "quote_finish", (audit, runId, lease) => needs(audit, "quoteFinish")(runId, lease, item));
      if (item.status === "UNREADABLE") return plain(texts.unreadable_image);
      return ack(formatAck({ texts, kind: "IMAGE", names: namesOf(item.studyIds, catalog), position: begun.position, hasDoubt: item.status !== "RESOLVED", repeated: 0 }), begun.position);
    } catch (error) {
      const errorCode = processingFailureCode(error instanceof SessionUnavailableError ? "OTHER" : phase);
      deps.log("processing_failed", { messageId: image.messageId, phone: who, errorCode, ...(error instanceof SessionUnavailableError ? { stage: error.stage } : {}) });
      if (!evidenceAttempted) await ctx.persist("evidence", (audit, runId, lease) => audit.recordEvidence(runId, { aiCalls }, lease));
      // Si la foto ya estaba en la sesión «en proceso», se marca ilegible: «listo» pedirá otra en vez de quedarse esperando algo que no llegará.
      if (began) await ctx.persist("quote_finish", async (audit, runId, lease) => { await needs(audit, "quoteFinish")(runId, lease, UNREADABLE("UNREADABLE_IMAGE")); });
      await ctx.persist("failure", (audit, runId, lease) => audit.recordFailure(runId, errorCode, lease));
      return failureReply();
    }
  };
}

// ───────────────────────────── texto ─────────────────────────────

function replayReply(read: Extract<QuoteReadResult, { state: "replay" }>, texts: QuoteTexts): Produced {
  if (read.outcome === "QUOTED" && read.lines && read.lines.length > 0) return { kind: "reply", body: formatSessionQuote(read.lines, 0, texts), result: "quoted", processingStatus: "COMPLETED", stale: "NONE" };
  if (read.outcome === "NEEDS_REVIEW") return plain(texts.review);
  if (read.outcome === "NEEDS_RESEND") return plain(texts.resend);
  if (read.outcome === "CANCELLED") return plain(texts.cancelled);
  return plain(texts.empty);
}

// Cómo se cierra una sesión desde un mensaje de texto: LISTO (el paciente declara que terminó), CANCEL, o AUTO (G5.9: sin «listo»; pidió cotizar con una lista clara de estudios, o respondió SÍ a «¿eso es todo?»).
type Settled = Exclude<QuoteReadResult, { state: "pending" }>;
type CloseCommand = "FINALIZE" | "CANCEL" | "AUTO";

// El mismo catálogo que se usa para identificar estudios escritos, entregado como opciones numeradas, y lo que se anotó hasta ahora.
function describeSession(items: readonly SessionItem[], catalog: readonly CatalogStudy[]): { names: string[]; options: string[]; doubt: TextDoubt } {
  const summary = summarizeSession(items);
  const first = summary.pendingGroups[0];
  const options = first ? optionsOf(first, catalog).map((option) => option.name) : [];
  const doubt: TextDoubt =
    summary.pendingGroups.length > 0 ? (options.length >= 2 ? "OPTIONS" : "UNRESOLVED")
    : summary.unresolved > 0 || summary.uncertain ? "UNRESOLVED"
    : summary.unreadable > 0 ? "RESEND"
    : "NONE";
  return { names: namesOf(summary.studyIds, catalog), options, doubt };
}

export function sessionTextProducer(turn: SessionTurn, deps: QuoteDeps, config: QuoteSessionsConfig, delegate: () => TurnProducer, texts: QuoteTexts = QUOTE_TEXTS, recentQuote?: (ctx: TurnContext) => Promise<boolean>): TurnProducer {
  const who = maskPhone(turn.from);
  const sleep = config.sleep ?? realSleep;
  const catalogForText = () => (config.catalogForText ?? deps.loadCatalog)();
  const attention = config.attention;
  // G6.0: el número de este mensaje entre los de su contacto (solo con la atención selectiva) y si ya llegó uno más nuevo QUE TAMBIÉN va a responder. El número se toma al inicio, de forma síncrona (así
  // respeta el orden de llegada); un mensaje que termina en manos del manejador de texto o sin respuesta se retira y no silencia a los anteriores.
  let ticket: number | undefined;
  const retire = () => {
    if (attention && ticket !== undefined) attention.gate.retire(turn.from, ticket);
  };
  const handOver = (ctx: TurnContext): Promise<Produced> => {
    retire();
    return delegate()(ctx);
  };
  const superseded = () => attention !== undefined && ticket !== undefined && !attention.gate.isLatest(turn.from, ticket);
  // Cierra el turno SIN respuesta (queda auditado como sin respuesta): lo que se pidió ya está en la solicitud o no pedía nada.
  async function quiet(ctx: TurnContext, event: string): Promise<Produced> {
    deps.log("quote_session", { event });
    retire();
    await ctx.persist("close", (audit, runId, lease) => audit.recordIgnored(runId, "NO_REPLY", lease));
    return { kind: "none" };
  }
  // «listo» sin nada abierto: si hubo una cotización reciente es un acuse («listo, gracias»), no un cierre sin estudios. Sin ella se avisa que no hay nada anotado, como siempre.
  async function nothingOpen(ctx: TurnContext): Promise<Produced> {
    if (!attention) return plain(texts.empty);
    let recent = false;
    try {
      recent = (await recentQuote?.(ctx)) === true;
    } catch {
      recent = false;
    }
    return recent ? quiet(ctx, "ack_after_quote") : plain(texts.empty);
  }

  async function close(ctx: TurnContext, input: QuoteCloseInput): Promise<QuoteCloseResult> {
    return withSession(ctx, "quote_close", (audit, runId, lease) => needs(audit, "quoteClose")(runId, lease, input));
  }

  const beginText = (ctx: TurnContext, result: ItemResult): Promise<QuoteBeginResult> =>
    withSession(ctx, "quote_begin", (audit, runId, lease) => needs(audit, "quoteBegin")(runId, lease, { kind: "TEXT", result, ttlSeconds: config.ttlSeconds, maxItems: config.maxItems }));

  // Solicitud en revisión: con la derivación al CRM configurada se registra un caso por mensaje dudoso y SOLO si el CRM los registró todos se le dice al paciente que una persona lo revisará.
  // Si algo queda pendiente, no se pudo guardar o no hay derivación, el aviso no promete nada. Repetir esto es seguro: la cola es idempotente por mensaje.
  async function reviewReply(ctx: TurnContext, sessionId: string, catalog: readonly CatalogStudy[]): Promise<Produced> {
    const crm = deps.turns?.crmHandoff;
    if (!crm) return plain(texts.review);
    let outcomes: Awaited<ReturnType<typeof crm.submitSessionReview>> = [];
    try {
      outcomes = await crm.submitSessionReview(ctx, { sessionId, contactPhone: turn.from, catalog });
    } catch {
      deps.log("quote_session", { event: "review_handoff_failed" });
    }
    const registered = outcomes.length > 0 && outcomes.every((outcome) => outcome.state === "REGISTERED");
    deps.log("quote_session", { event: "review_handoff", cases: outcomes.length, registered });
    return plain(registered ? texts.review_confirmed : texts.review);
  }

  // Lee la sesión del contacto. Con `wait`, antes de decidir se espera (acotado) a que terminen los mensajes ANTERIORES que aún se procesan: «listo» justo después de una foto no debe cotizar sin
  // ella. Sin `wait` es un solo intento. `undefined` = todavía hay mensajes anteriores en proceso.
  async function readSession(ctx: TurnContext, wait: boolean): Promise<Settled | undefined> {
    let read: QuoteReadResult | undefined;
    const retries = wait ? config.waitRetries : 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      read = await withSession(ctx, "quote_read", (audit, runId, lease) => needs(audit, "quoteRead")(runId, lease));
      if (read.state !== "pending") break;
      deps.log("quote_session", { event: "waiting_previous", pending: read.pending, attempt });
      if (attempt < retries) await sleep(config.waitDelayMs);
    }
    return read && read.state !== "pending" ? read : undefined;
  }

  async function finalize(ctx: TurnContext, command: CloseCommand, whenNone?: () => Promise<Produced>): Promise<Produced> {
    const read = await readSession(ctx, true);
    if (!read) return plain(texts.waiting);
    if (read.state === "replay") {
      if (read.outcome !== "NEEDS_REVIEW") {
        const reply = replayReply(read, texts);
        if (reply.kind !== "reply" || reply.result !== "quoted" || !read.lines || !deps.quotePreparations) return reply;
        try {
          const catalog = await deps.loadCatalog();
          const body = await deps.quotePreparations(reply.body, read.lines.map((line) => line.studyId), catalog, ctx);
          return { ...reply, body };
        } catch {
          return reply;
        }
      }
      // Ejecución que reclama el turno tras el cierre: el caso se vuelve a presentar (idempotente) para decidir con el estado REAL del CRM qué texto corresponde.
      try {
        return await reviewReply(ctx, read.sessionId, await deps.loadCatalog());
      } catch {
        return plain(texts.review);
      }
    }
    if (read.state === "none") {
      if (whenNone) return whenNone();
      return plain(command === "CANCEL" ? texts.nothing_to_cancel : texts.empty);
    }

    if (command === "CANCEL") {
      const closed = await close(ctx, { sessionId: read.sessionId, outcome: "CANCELLED" });
      deps.log("quote_session", { event: "cancelled", status: closed.status });
      return closed.status === "closed" || closed.status === "replayed" ? plain(texts.cancelled) : plain(closed.status === "pending" ? texts.waiting : texts.nothing_to_cancel);
    }

    // Catálogo RECARGADO ahora (sin caché): los estudios y precios vigentes son los de este instante.
    const catalog = await deps.loadCatalog();
    const evaluation = evaluateSession(read.items, catalog);
    deps.log("quote_session", { event: "evaluated", mode: command, kind: evaluation.kind, items: read.items.length, ...(evaluation.kind === "QUOTE" ? { studies: evaluation.lines.length, duplicates: evaluation.duplicates } : {}), ...(evaluation.kind === "REVIEW" ? { reasons: evaluation.reasons } : {}) });
    if (evaluation.kind === "EMPTY") return plain(texts.empty);
    // Sin «listo» NUNCA se manda una solicitud con dudas a revisión por iniciativa del agente: se le pregunta al paciente (opciones del catálogo o el nombre exacto). Solo lo que el paciente no puede
    // arreglar escribiendo (un estudio retirado del catálogo, un precio inválido) se cierra como revisión.
    if (command === "AUTO" && evaluation.kind === "REVIEW" && !evaluation.reasons.some((reason) => reason === "STUDY_UNAVAILABLE" || reason === "PRICE_INVALID")) {
      const asked = describeSession(read.items, catalog);
      deps.log("quote_session", { event: "clarify", doubt: asked.doubt, reasons: evaluation.reasons });
      return ask(formatTextReply({ texts, names: asked.names, options: asked.options, doubt: asked.doubt === "NONE" ? "UNRESOLVED" : asked.doubt, repeated: 0 }), read.items.length);
    }
    const input: QuoteCloseInput =
      evaluation.kind === "QUOTE" ? { sessionId: read.sessionId, outcome: "QUOTED", lines: evaluation.lines, totalBs: evaluation.totalBs, catalogFingerprint: catalogFingerprint(catalog).hash }
      : evaluation.kind === "REVIEW" ? { sessionId: read.sessionId, outcome: "NEEDS_REVIEW", reasons: evaluation.reasons }
      : { sessionId: read.sessionId, outcome: "NEEDS_RESEND" };
    const closed = await close(ctx, input);
    if (closed.status === "pending") return plain(texts.waiting);
    if (closed.status === "not_open") return plain(texts.empty);
    if (evaluation.kind === "QUOTE") {
      let body = formatSessionQuote(evaluation.lines, evaluation.duplicates, texts);
      if (deps.quotePreparations) {
        try {
          body = await deps.quotePreparations(body, evaluation.lines.map((line) => line.studyId), catalog, ctx);
        } catch {
          deps.log("quote_preparation_skipped", { reason: "APPEND_FAILED" });
        }
      }
      return { kind: "reply", body, result: "quoted", processingStatus: "COMPLETED", stale: "NONE" };
    }
    if (evaluation.kind === "REVIEW") return reviewReply(ctx, read.sessionId, catalog);
    return plain(texts.resend);
  }

  // Responde a un estudio escrito que ya quedó anotado: qué hay en la solicitud hasta ahora y, si hay una duda, la pregunta; si no, si eso es todo. Una sola lectura (sin esperar): si hay mensajes
  // anteriores aún en proceso se responde solo con lo de este mensaje. Con el agrupamiento de mensajes seguidos (G6.0) sí se espera, acotado, a que terminen los anteriores (están por cerrar sin respuesta):
  // el que confirma debe ver TODOS los estudios.
  async function replyAfterAdd(ctx: TurnContext, begun: Exclude<QuoteBeginResult, { status: "full" }>, own: ItemResult, catalog: readonly CatalogStudy[], repeated: number): Promise<Produced> {
    // G6.0: varios mensajes seguidos. Se espera un instante antes de confirmar; si llegó uno más nuevo, este calla (su estudio ya quedó anotado) y el más nuevo confirma todo junto.
    if (attention && attention.settleMs > 0) {
      await sleep(attention.settleMs);
      if (superseded()) return quiet(ctx, "ack_superseded");
    }
    let read: Settled | undefined;
    try {
      read = await readSession(ctx, Boolean(attention && attention.settleMs > 0));
    } catch {
      read = undefined;
    }
    const items: SessionItem[] = read && read.state === "ready" ? read.items : [{ id: begun.itemId, seq: 1, kind: "TEXT", ...own }];
    const described = describeSession(items, catalog);
    deps.log("quote_session", { event: "text_reply", doubt: described.doubt, studies: described.names.length, summary: read?.state === "ready" });
    return ack(formatTextReply({ texts, head: texts.added_text, names: described.names, options: described.options, doubt: described.doubt, repeated }), begun.position);
  }

  // «sí», «no» o el número de una opción: solo significan algo con una solicitud abierta; sin ella es un mensaje cualquiera.
  async function answer(ctx: TurnContext, reply: SessionReply): Promise<Produced> {
    if (reply.kind === "YES") return finalize(ctx, "AUTO", () => handOver(ctx));
    let read: Settled | undefined;
    try {
      read = await readSession(ctx, false);
    } catch {
      return handOver(ctx);
    }
    if (!read || read.state !== "ready") return handOver(ctx);
    if (reply.kind === "NO") return ask(texts.not_done, read.items.length);
    const group = summarizeSession(read.items).pendingGroups[0];
    if (!group) return handOver(ctx);
    const catalog = await catalogForText();
    const options = optionsOf(group, catalog);
    const chosen = options.length >= 2 ? options[reply.index - 1] : undefined;
    if (!chosen) return ask(texts.choose_invalid, read.items.length);
    // La opción elegida entra a la sesión como un estudio identificado con certeza; eso aclara el grupo ambiguo (la base aplica la misma regla al cerrar).
    const own: ItemResult = { status: "RESOLVED", studyIds: [chosen.id], ambiguous: [], unresolved: 0, reasons: [] };
    const begun = await beginText(ctx, own);
    deps.log("quote_session", { event: "choice_item", status: begun.status });
    if (begun.status === "full") return plain(texts.full);
    return replyAfterAdd(ctx, begun, own, catalog, 0);
  }

  return async (ctx): Promise<Produced> => {
    const text = turn.text ?? "";
    if (attention) ticket = attention.gate.enter(turn.from, ctx.seq);
    // Mensajes automáticos y ecos nunca entran a la sesión ni la cierran (los descarta el manejador de texto como siempre).
    if (config.loopProtection && (looksAutomated(text) || looksLikeOwnReply(text, config.ownTexts ?? []))) {
      retire();
      // Sin respuesta (no hay bucle si nadie contesta): el turno se cierra y queda auditado como sin respuesta.
      deps.log("text_turn", { category: "AUTOMATED" });
      await ctx.persist("close", (audit, runId, lease) => audit.recordIgnored(runId, "NO_REPLY", lease));
      return { kind: "none" };
    }
    try {
      const command = parseSessionCommand(text);
      if (command) {
        return await finalize(ctx, command, command === "FINALIZE" && attention ? () => nothingOpen(ctx) : undefined);
      }

      const category = classifyText(text);
      if (category === "MEDICAL" || category === "HUMAN_REQUEST" || category === "INFO_REQUEST" || category === "GREETING") return await handOver(ctx);
      if (config.isInfoQuestion?.(text)) return await handOver(ctx);
      const reply = parseSessionReply(text);
      if (reply) return await answer(ctx, reply);
      // Una pregunta general (qué es, para qué sirve...) no es una lista de estudios: la atiende el manejador de siempre.
      if (isGeneralQuestion(text)) return await handOver(ctx);
      let catalog: CatalogStudy[];
      try {
        catalog = await catalogForText();
      } catch {
        // Sin catálogo no se pueden identificar estudios escritos: el mensaje se trata como cualquier otro texto.
        deps.log("quote_session", { event: "catalog_unavailable_for_text" });
        return await handOver(ctx);
      }
      const extraction = extractStudyRequests(text, catalog);
      if (!extraction) {
        // «¿cuánto es en total?» sin estudios nuevos: pide el precio de lo que ya está anotado. Sin una solicitud abierta es un mensaje cualquiera.
        if (asksForPrice(text)) return await finalize(ctx, "AUTO", () => handOver(ctx));
        return await handOver(ctx);
      }


      const begun = await beginText(ctx, extraction.result);
      deps.log("quote_session", { event: "text_item", status: begun.status, itemStatus: extraction.result.status, studies: extraction.matched.length, ambiguous: extraction.result.ambiguous.length, unresolved: extraction.result.unresolved, wantsQuote: extraction.wantsQuote });
      if (begun.status === "full") return plain(texts.full);
      // Una lista CLARA (todo identificado con certeza) con un pedido explícito de cotizar se cotiza ya, junto con lo que la solicitud tuviera acumulado; con cualquier duda se pregunta.
      if (extraction.wantsQuote && extraction.result.status === "RESOLVED") return await finalize(ctx, "AUTO");
      return await replyAfterAdd(ctx, begun, extraction.result, catalog, extraction.repeatedInMessage);
    } catch (error) {
      const errorCode = processingFailureCode("OTHER");
      deps.log("processing_failed", { messageId: turn.messageId, phone: who, errorCode, ...(error instanceof SessionUnavailableError ? { stage: error.stage } : {}) });
      await ctx.persist("failure", (audit, runId, lease) => audit.recordFailure(runId, errorCode, lease));
      return failureReply();
    }
  };
}
