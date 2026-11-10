import { catalogFingerprint, processingFailureCode } from "./audit.js";
import { composeReply, composeTextsFor, type ComposedReply, type CoreOverride, type DelegatedReply } from "./batch-compose.js";
import { decideBatch, type Notice, type PhotoOutcome, type ReplyPlan } from "./batch-policy.js";
import { EMPTY_SESSION, understandBatch, type BatchFragment, type BatchUnderstanding, type SessionContext, type UnderstandInput } from "./batch-understanding.js";
import type { Produced, TurnContext } from "./guarded-turn.js";
import {
  compactQuote, evaluateSession, formatInterpretationNote, formatSessionQuote, optionsOf, QUOTE_TEXTS, summarizeSession, withNote,
  type QuoteBeginResult, type QuoteCloseInput, type QuoteCloseResult, type QuoteReadResult, type QuoteSessionsConfig, type QuoteTexts, type ShadowPeekResult
} from "./quote-session.js";
import { namesOf, needs, SessionUnavailableError, withSession } from "./quote-session-turns.js";
import { looksAutomated, looksLikeOwnReply } from "./reply-guard.js";
import { DRAFT_TEXTS } from "./text-handler.js";
import type { CatalogStudy } from "./types.js";
import { maskPhone, TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "./whatsapp-quote.js";

// EJECUTORES DEL PLAN DE UN LOTE (Fase 2 del rediseño; todavía NO conectado al webhook ni a los turnos).
//
// `produceBatchReply` recorre el camino completo de UN lote de un contacto y devuelve la ÚNICA respuesta (`Produced`) que el turno que responde enviaría por la máquina de siempre
// (guarded-turn: claim, reserva de envío, pausa humana, tope diario):
//   leer la sesión abierta -> comprender el lote entero (batch-understanding) -> decidir el plan (batch-policy) -> atender lo delegado (seguridad, preguntas) -> ejecutar el bloque principal contra las
//   sesiones de siempre (anotar, cotizar, cancelar) -> componer UN mensaje (batch-compose).
//
// Se reutilizan, sin cambiarlas, las sesiones y las cotizaciones existentes: las mismas operaciones de auditoría (quoteRead/quoteBegin/quoteClose, con owner + fence), la misma evaluación de la sesión y
// el mismo formato de cotización. Los PRECIOS salen siempre del catálogo (lab_tests) recargado en el instante de cotizar; nada de este módulo ni del plan lleva un precio.
//
// Garantías:
//  · Lo médico y pedir a una persona siempre reciben su respuesta: la da el manejador de siempre (`delegate`) y, si ese manejador falla, se usa el texto fijo seguro (nunca promete una persona).
//    Esa respuesta sale aunque falle la lectura de la sesión, el catálogo o el cierre: en ese caso se agrega el aviso técnico y se conserva lo demás.
//  · Una cotización solo se emite tras cerrar la sesión en la base, que verifica que lo cotizado sea exactamente lo identificado. Si al cerrar la solicitud resulta distinta de la prevista
//    (apareció una duda, cambió el catálogo), manda lo que dice la evaluación real, nunca el plan.
//  · Nunca se registra el texto de un mensaje: solo códigos y cantidades.

export interface DelegationRequest {
  kind: "MEDICAL" | "HUMAN_REQUEST" | "QUESTION";
  fragmentIds: readonly string[];
}

export interface BatchTurnInput {
  ctx: TurnContext;
  deps: QuoteDeps;
  config: QuoteSessionsConfig;
  // Teléfono del contacto (solo para registrar casos de revisión en el CRM; nunca se registra en el log).
  from: string;
  // Los mensajes de texto del lote, en orden.
  fragments: readonly BatchFragment[];
  // Lo que dejaron las fotos de ESTE lote (ya analizadas y anotadas por su propio turno).
  photos?: readonly PhotoOutcome[];
  // El manejador de siempre para lo que no es un pedido de estudios: urgencias médicas, atención humana, preguntas de información. Devuelve el texto YA RESUELTO (con el rastro de conocimiento y la
  // derivación al CRM ya registrados), o undefined si no hay nada que decir.
  delegate(request: DelegationRequest): Promise<DelegatedReply | undefined>;
  understand?: Pick<UnderstandInput, "interpret" | "modelUse" | "isInfoQuestion" | "isIgnorable" | "isSocial" | "maxModelChars">;
  // Atención selectiva encendida: un mensaje solo social no se contesta.
  silenceSocial?: boolean;
  texts?: QuoteTexts;
  // Las respuestas genéricas (saludo, «con gusto te ayudo a cotizar», charla) las da el manejador de texto de siempre en vez de los textos fijos del motor: así conservan su atención selectiva,
  // su modelo de conversación y su memoria. Si el manejador no dice nada, no se dice nada.
  delegatePrompts?: boolean;
  // Lote mixto (texto y fotos u otros mensajes): la base solo muestra a cada turno los ítems de los turnos ANTERIORES y del propio, y un turno que ya tiene su propio ítem (una foto) no puede anotar el texto.
  // Por eso, cuando el último mensaje del lote no es texto, el texto lo LEE, lo anota (y descarta la solicitud anterior si el lote la cancela) el turno de texto más reciente (`recordCtx`), y el
  // turno que responde (`ctx`, el último del lote, que sí ve todo) cierra la solicitud y cotiza. Sin `recordCtx`, todo lo hace `ctx`.
  recordCtx?: TurnContext;
  // Se llama tras anotar y ANTES de leer para cerrar: quien lo pasó cierra aquí el turno de `recordCtx` (la base cuenta como «pendientes» los turnos anteriores aún en proceso, y el cierre esperaría).
  beforeClose?(): Promise<void>;
}

// Qué se hizo, solo con códigos (sirve para el registro y para el modo sombra de una fase posterior).
export interface BatchTurnTrace {
  plan: ReplyPlan;
  understanding: BatchUnderstanding;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_CONTEXT_SECONDS = 86_400;
type Settled = Exclude<QuoteReadResult, { state: "pending" }>;

// Textos seguros si el manejador de siempre falla: nunca prometen una persona ni dan orientación.
const FALLBACK_DELEGATED: Record<DelegationRequest["kind"], string | undefined> = {
  MEDICAL: DRAFT_TEXTS.medical_unavailable,
  HUMAN_REQUEST: DRAFT_TEXTS.handoff_unavailable,
  QUESTION: undefined
};

function toProduced(reply: ComposedReply | undefined): Produced {
  if (!reply) return { kind: "none" };
  return { kind: "reply", body: reply.body, result: reply.result, processingStatus: reply.processingStatus, stale: reply.stale, ...(reply.signature ? { signature: reply.signature } : {}) };
}

export async function produceBatchReply(input: BatchTurnInput): Promise<Produced> {
  const { produced } = await runBatchTurn(input);
  return produced;
}

// Igual que `produceBatchReply`, pero devuelve además el plan y la comprensión (para registrar códigos o comparar en modo sombra).
export async function runBatchTurn(input: BatchTurnInput): Promise<{ produced: Produced; trace?: BatchTurnTrace }> {
  const { ctx, deps, config, fragments } = input;
  const texts = input.texts ?? QUOTE_TEXTS;
  const composeTexts = { ...composeTextsFor(TECHNICAL_ISSUE_MESSAGE), quote: texts };
  const sleep = config.sleep ?? realSleep;
  const log = (event: string, data: Record<string, unknown>) => deps.log(event, data);
  const delegatedReplies: DelegatedReply[] = [];
  let delegationsDone = false;

  // Atiende lo delegado (urgencias, atención humana, preguntas) UNA vez. Un fallo del manejador no deja al paciente sin su aviso de seguridad.
  const delegateAll = async (plan: ReplyPlan): Promise<void> => {
    if (delegationsDone) return;
    delegationsDone = true;
    const requests: DelegationRequest[] = [
      ...plan.safety.map((block): DelegationRequest => ({ kind: block.kind, fragmentIds: block.fragmentIds })),
      ...(plan.delegatedQuestionIds.length > 0 ? [{ kind: "QUESTION" as const, fragmentIds: plan.delegatedQuestionIds }] : [])
    ];
    for (const request of requests) await delegateOne(request);
  };
  const delegateOne = async (request: DelegationRequest): Promise<void> => {
    try {
      const reply = await input.delegate(request);
      if (reply && reply.body.trim() !== "") delegatedReplies.push(reply);
      else if (FALLBACK_DELEGATED[request.kind] && request.kind !== "QUESTION") delegatedReplies.push({ body: FALLBACK_DELEGATED[request.kind]! });
    } catch {
      log("batch_delegate_failed", { kind: request.kind });
      const fallback = FALLBACK_DELEGATED[request.kind];
      if (fallback) delegatedReplies.push({ body: fallback });
    }
  };

  let understanding: BatchUnderstanding | undefined;
  let plan: ReplyPlan | undefined;
  try {
    const catalog = await (config.catalogForText ?? deps.loadCatalog)();

    // 1. La solicitud abierta (esperando, acotado, a que terminen los mensajes anteriores aún en proceso).
    const read = await readSession(input.recordCtx ?? ctx, deps, config, sleep, true);
    if (read === "pending") {
      // Sigue habiendo mensajes anteriores en proceso: no se decide sobre una solicitud a medias. Se atiende lo de seguridad y se pide repetir en un momento.
      const safe = decideBatch({ understanding: await understandBatch({ fragments, catalog, session: EMPTY_SESSION, ...(input.understand ?? {}) }) });
      await delegateAll(safe);
      log("batch_turn", { outcome: "WAITING" });
      return { produced: toProduced(composeWith(safe, { delegated: delegatedReplies, override: { body: texts.waiting, result: "no_quote" } }, composeTexts, catalog)) };
    }
    if (read.state === "replay") {
      // Este turno ya cerró la solicitud (se reclamó de nuevo tras una caída): se repite EXACTAMENTE la misma respuesta guardada.
      const safe = decideBatch({ understanding: await understandBatch({ fragments, catalog, session: EMPTY_SESSION, ...(input.understand ?? {}) }) });
      await delegateAll(safe);
      const override = await replayOverride(read, deps, ctx, texts);
      log("batch_turn", { outcome: "REPLAY" });
      return { produced: toProduced(composeWith(safe, { delegated: delegatedReplies, override }, composeTexts, catalog)) };
    }
    const session: SessionContext =
      read.state === "ready" ? { open: true, ...pick(summarizeSession(read.items)) } : EMPTY_SESSION;

    // 2. Comprender el lote entero y decidir.
    understanding = await understandBatch({ fragments, catalog, session, ...understandBase(config), ...(input.understand ?? {}) });
    const recentQuote = understanding.intent === "CONFIRM" && understanding.request.studyIds.length === 0 && (input.photos ?? []).length === 0 ? await hadRecentQuote(ctx, deps) : false;
    plan = decideBatch({ understanding, ...(input.photos ? { photos: input.photos } : {}), recentQuote, ...(input.silenceSocial ? { silenceSocial: true } : {}) });
    log("batch_plan", {
      core: plan.core.kind, reasons: plan.reasons, intent: understanding.intent, intentSource: understanding.intentSource, model: understanding.model,
      messages: fragments.length, studies: "studyIds" in plan.core ? plan.core.studyIds.length : understanding.request.studyIds.length, safety: plan.safety.map((block) => block.kind), notices: plan.notices.map((notice) => notice.kind)
    });

    // 3. Lo delegado se atiende ANTES de tocar nada más: la seguridad no depende de que la sesión o el cierre funcionen.
    await delegateAll(plan);
    if (input.delegatePrompts && plan.core.kind === "PROMPT") {
      // Lo genérico lo contesta el manejador de siempre sobre el texto del lote; el bloque principal queda vacío para no repetirlo.
      await delegateOne({ kind: "QUESTION", fragmentIds: fragments.map((fragment) => fragment.id) });
      plan = { ...plan, core: { kind: "NONE", reason: "HANDLED_ELSEWHERE" } };
    }

    // 4. Ejecutar.
    const outcome = await executePlan({ ctx, recordCtx: input.recordCtx ?? ctx, beforeClose: input.beforeClose, deps, config, texts, plan, understanding, catalog, from: input.from, sleep });
    // Canceló la solicitud anterior en este mismo turno: lo nuevo queda anotado y se pide confirmar (la política decide qué falta, como si no hubiera intención de cotizar).
    if (outcome.deferQuote) plan = decideBatch({ understanding: { ...understanding, intent: "NONE", intentSource: "NONE", confirmedBy: undefined }, ...(input.photos ? { photos: input.photos } : {}), ...(input.silenceSocial ? { silenceSocial: true } : {}) });
    const notices: Notice[] = [...plan.notices, ...outcome.notices];
    const interpretedNote = formatInterpretationNote({ notFound: [], interpreted: understanding.studies.interpreted });
    const quote = outcome.quote ? { body: withNote(outcome.quote.body, interpretedNote) } : undefined;
    const reply = composeWith({ ...plan, notices }, {
      delegated: delegatedReplies,
      ...(quote ? { quote } : {}),
      ...(outcome.override ? { override: outcome.override } : {}),
      ...(outcome.deferQuote ? { leading: [texts.cancelled] } : {}),
      repeated: understanding.studies.repeated,
      position: outcome.position ?? understanding.request.studyIds.length,
      ...(interpretedNote ? { interpretedNote } : {})
    }, composeTexts, catalog);
    if (!reply) {
      // Nada que decir: el turno se cierra sin respuesta (queda auditado como sin respuesta).
      await ctx.persist("close", (audit, runId, lease) => audit.recordIgnored(runId, "NO_REPLY", lease));
      return { produced: { kind: "none" }, trace: { plan, understanding } };
    }
    return { produced: toProduced(reply), trace: { plan, understanding } };
  } catch (error) {
    // Nunca el texto del error ni del mensaje: solo el código de la etapa.
    const code = processingFailureCode("OTHER");
    log("processing_failed", { phone: maskPhone(input.from), errorCode: code, ...(error instanceof SessionUnavailableError ? { stage: error.stage } : {}) });
    if (!delegationsDone) {
      // La seguridad no puede depender de la sesión ni del catálogo: se calcula con lo que no necesita ni uno ni otro.
      try {
        const safe = decideBatch({ understanding: await understandBatch({ fragments, catalog: [], session: EMPTY_SESSION, ...(input.understand ? { isInfoQuestion: input.understand.isInfoQuestion, isIgnorable: input.understand.isIgnorable } : {}) }) });
        await delegateAll(safe);
      } catch {
        // sin seguridad que atender
      }
    }
    await ctx.persist("failure", (audit, runId, lease) => audit.recordFailure(runId, code, lease));
    const fallbackPlan: ReplyPlan = { safety: [], delegatedQuestionIds: [], notices: [{ kind: "TECHNICAL_ERROR", count: 1 }], core: { kind: "NONE", reason: "HANDLED_ELSEWHERE" }, cancelPrevious: false, record: undefined, reasons: [] };
    return { produced: toProduced(composeReply(fallbackPlan, { namesOf: () => [], optionsOf: () => [], delegated: delegatedReplies }, composeTexts)), ...(plan && understanding ? { trace: { plan, understanding } } : {}) };
  }
}

const pick = (summary: ReturnType<typeof summarizeSession>) => ({ studyIds: summary.studyIds, pendingGroups: summary.pendingGroups, unresolved: summary.unresolved, uncertain: summary.uncertain, unreadable: summary.unreadable });

// Lo que la configuración de las sesiones aporta a la comprensión (mensajes automáticos o ecos, y preguntas de información). Una sola definición para el motor y para el modo sombra.
const understandBase = (config: QuoteSessionsConfig): Pick<UnderstandInput, "isIgnorable" | "isInfoQuestion"> => ({
  ...(config.loopProtection ? { isIgnorable: (text: string) => looksAutomated(text) || looksLikeOwnReply(text, config.ownTexts ?? []) } : {}),
  ...(config.isInfoQuestion ? { isInfoQuestion: (text: string) => config.isInfoQuestion!(text) } : {})
});

// ───────────────────────────── modo sombra (ESTRICTAMENTE de solo lectura) ─────────────────────────────
// El modo sombra decide como lo haría el motor nuevo SIN ejecutar nada: no anota, no cierra, no cotiza, no atiende lo delegado (ni conocimiento ni CRM), no consulta al modelo y no envía.
// Solo lee, y lo hace con UNA función de la base declarada STABLE (migración 20, plusmedik_quote_shadow_peek): PostgreSQL no permite que una función STABLE escriba ni tome bloqueos de fila, así que ni
// siquiera marca como vencidas las sesiones vencidas (cosa que sí hace la lectura de siempre). NUNCA usa quoteRead, quoteLastStudies, quoteBegin, quoteClose ni nada que escriba. Si la migración 20
// no está aplicada, la lectura falla y el modo sombra se salta (queda un código); jamás recurre a la lectura que escribe. El catálogo sale del mismo caché de los textos.

export type SessionSnapshot = { state: "ok"; session: SessionContext; recentQuote: boolean } | { state: "skipped"; reason: "PENDING" | "REPLAY" | "UNAVAILABLE" };

export async function snapshotSession(ctx: TurnContext, deps: QuoteDeps): Promise<SessionSnapshot> {
  let peek: ShadowPeekResult | undefined;
  const ok = await ctx.persist("shadow_peek", async (audit, runId, lease) => {
    if (!audit.quoteShadowPeek) throw new SessionUnavailableError("quoteShadowPeek");
    peek = await audit.quoteShadowPeek(runId, lease, deps.turns?.studyInfoContextSeconds ?? DEFAULT_CONTEXT_SECONDS);
  });
  if (!ok || !peek) return { state: "skipped", reason: "UNAVAILABLE" };
  if (peek.state === "pending") return { state: "skipped", reason: "PENDING" };
  if (peek.state === "replay") return { state: "skipped", reason: "REPLAY" };
  if (peek.state === "unavailable" || peek.state === "lease_lost") return { state: "skipped", reason: "UNAVAILABLE" };
  return { state: "ok", session: peek.state === "ready" ? { open: true, ...pick(summarizeSession(peek.items)) } : EMPTY_SESSION, recentQuote: peek.recent };
}

export interface PreviewInput {
  deps: QuoteDeps;
  config: QuoteSessionsConfig;
  fragments: readonly BatchFragment[];
  session: SessionContext;
  // ¿Hubo una cotización entregada hace poco? (lo informa la misma lectura de solo lectura)
  recentQuote: boolean;
  understand?: Pick<UnderstandInput, "isSocial" | "maxModelChars">;
}

// Todo lo que el modo sombra necesita LEER, antes de que la ruta de siempre trabaje (con la corrida todavía abierta). Lo que dejen las fotos del lote se conoce después y entra en `previewPlan`.
export interface PreviewState {
  understanding: BatchUnderstanding;
  recentQuote: boolean;
}

export async function previewUnderstanding(input: PreviewInput): Promise<PreviewState> {
  const { deps, config } = input;
  const catalog = await (config.catalogForText ?? deps.loadCatalog)();
  // Sin modelo, siempre: el modo sombra no gasta llamadas ni depende de un servicio externo.
  const understanding = await understandBatch({ fragments: input.fragments, catalog, session: input.session, ...understandBase(config), ...(input.understand ?? {}), modelUse: "never" });
  return { understanding, recentQuote: input.recentQuote };
}

// Prueba previa del motor (modo encendido): ¿puede ENTENDER y DECIDIR este lote? Solo lee el catálogo y calcula (sin sesión, sin modelo, sin escribir nada). Si lanza, quien la llama deja el lote a la ruta
// de siempre, que todavía no ha tocado nada. No sustituye a la ejecución real: ahí la sesión sí cuenta.
export async function probeBatch(input: { deps: QuoteDeps; config: QuoteSessionsConfig; fragments: readonly BatchFragment[]; understand?: Pick<UnderstandInput, "isSocial" | "maxModelChars"> }): Promise<{ cancelled: boolean }> {
  const catalog = await (input.config.catalogForText ?? input.deps.loadCatalog)();
  const understanding = await understandBatch({ fragments: input.fragments, catalog, session: EMPTY_SESSION, ...understandBase(input.config), ...(input.understand ?? {}), modelUse: "never" });
  decideBatch({ understanding });
  return { cancelled: understanding.cancelled };
}

// Función pura: la decisión del motor nuevo con lo que ya se leyó y lo que dejaron las fotos.
export function previewPlan(state: PreviewState, photos: readonly PhotoOutcome[], silenceSocial: boolean): BatchTurnTrace {
  const plan = decideBatch({ understanding: state.understanding, ...(photos.length > 0 ? { photos } : {}), recentQuote: state.recentQuote, ...(silenceSocial ? { silenceSocial: true } : {}) });
  return { plan, understanding: state.understanding };
}

function composeWith(plan: ReplyPlan, facts: Omit<Parameters<typeof composeReply>[1], "namesOf" | "optionsOf">, texts: Parameters<typeof composeReply>[2], catalog: readonly CatalogStudy[]): ComposedReply | undefined {
  return composeReply(plan, { ...facts, namesOf: (ids) => namesOf(ids, catalog), optionsOf: (ids) => optionsOf(ids, catalog).map((option) => option.name) }, texts);
}

// ───────────────────────────── sesión ─────────────────────────────

async function readSession(ctx: TurnContext, deps: QuoteDeps, config: QuoteSessionsConfig, sleep: (ms: number) => Promise<void>, wait: boolean): Promise<Settled | "pending"> {
  let read: QuoteReadResult | undefined;
  const retries = wait ? config.waitRetries : 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    read = await withSession(ctx, "quote_read", (audit, runId, lease) => needs(audit, "quoteRead")(runId, lease));
    if (read.state !== "pending") break;
    deps.log("quote_session", { event: "waiting_previous", pending: read.pending, attempt });
    if (attempt < retries) await sleep(config.waitDelayMs);
  }
  return read && read.state !== "pending" ? read : "pending";
}

async function hadRecentQuote(ctx: TurnContext, deps: QuoteDeps): Promise<boolean> {
  let recent = false;
  const ok = await ctx.persist("quote_recent", async (audit, runId, lease) => {
    recent = ((await audit.quoteLastStudies?.(runId, lease, deps.turns?.studyInfoContextSeconds ?? DEFAULT_CONTEXT_SECONDS)) ?? []).length > 0;
  });
  return ok && recent;
}

async function replayOverride(read: Extract<Settled, { state: "replay" }>, deps: QuoteDeps, ctx: TurnContext, texts: QuoteTexts): Promise<CoreOverride> {
  if (read.outcome === "QUOTED" && read.lines && read.lines.length > 0) {
    let body = formatSessionQuote(read.lines, 0, texts);
    if (deps.quotePreparations) {
      try {
        body = await deps.quotePreparations(body, read.lines.map((line) => line.studyId), await deps.loadCatalog(), ctx);
      } catch {
        deps.log("quote_preparation_skipped", { reason: "APPEND_FAILED" });
      }
    }
    return { body: compactQuote(body), result: "quoted" };
  }
  if (read.outcome === "NEEDS_REVIEW") return { body: texts.review, result: "no_quote" };
  if (read.outcome === "NEEDS_RESEND") return { body: texts.resend, result: "no_quote" };
  if (read.outcome === "CANCELLED") return { body: texts.cancelled, result: "no_quote" };
  return { body: texts.empty, result: "no_quote" };
}

// ───────────────────────────── ejecución del plan ─────────────────────────────

interface Outcome {
  quote?: { body: string };
  override?: CoreOverride;
  notices: Notice[];
  position?: number;
  // Este turno ya usó su único cierre de sesión (canceló la anterior): no puede cerrar también la nueva en el mismo turno. Se anota lo nuevo y se pide confirmar en lugar de cotizar.
  deferQuote?: boolean;
}

async function executePlan(args: { ctx: TurnContext; recordCtx: TurnContext; beforeClose?: () => Promise<void>; deps: QuoteDeps; config: QuoteSessionsConfig; texts: QuoteTexts; plan: ReplyPlan; understanding: BatchUnderstanding; catalog: readonly CatalogStudy[]; from: string; sleep: (ms: number) => Promise<void> }): Promise<Outcome> {
  const { ctx, recordCtx, deps, config, texts, plan } = args;
  const outcome: Outcome = { notices: [] };

  // 1. Descartar la solicitud anterior si el lote trae una cancelación (antes de anotar lo que venga después).
  let closedHere = false;
  if (plan.cancelPrevious) {
    const read = await readSession(recordCtx, deps, config, args.sleep, false);
    if (read !== "pending" && read.state === "ready") {
      const closed = await closeSession(recordCtx, { sessionId: read.sessionId, outcome: "CANCELLED" });
      closedHere = closed.status === "closed" || closed.status === "replayed";
      deps.log("quote_session", { event: "cancelled", status: closed.status });
    }
  }

  // 2. Anotar el texto de este lote como UN solo ítem de la sesión.
  if (plan.record) {
    const record = plan.record;
    const begun: QuoteBeginResult = await withSession(recordCtx, "quote_begin", (audit, runId, lease) => needs(audit, "quoteBegin")(runId, lease, { kind: "TEXT", result: record, ttlSeconds: config.ttlSeconds, maxItems: config.maxItems }));
    deps.log("quote_session", { event: "batch_item", status: begun.status, itemStatus: record.status, studies: record.studyIds.length, ambiguous: record.ambiguous.length, unresolved: record.unresolved });
    if (begun.status === "full") outcome.notices.push({ kind: "SESSION_FULL" });
    else outcome.position = begun.position;
  }

  // Lo que sigue lo hace el turno que responde: antes se libera el turno que anotó (si es otro), para que no cuente como pendiente.
  await args.beforeClose?.();

  // 3. Cotizar (o cerrar a revisión): la sesión decide, con los precios del catálogo recargado. Un turno cierra una sola solicitud: si ESTE mismo turno acaba de cancelar la anterior, la nueva queda para confirmar.
  if ((plan.core.kind === "QUOTE" || plan.core.kind === "REVIEW") && closedHere && recordCtx === ctx) {
    outcome.deferQuote = true;
    deps.log("quote_session", { event: "batch_close_deferred", planned: plan.core.kind });
  } else if (plan.core.kind === "QUOTE" || plan.core.kind === "REVIEW") {
    const closed = await closeAndRender({ ctx, deps, config, texts, from: args.from, sleep: args.sleep, planned: plan.core.kind, plannedIds: plan.core.studyIds });
    if (closed.quote) outcome.quote = closed.quote;
    if (closed.override) outcome.override = closed.override;
    deps.log("quote_session", { event: "batch_closed", planned: plan.core.kind, actual: closed.actual, ...(closed.mismatch ? { mismatch: true } : {}) });
  }
  return outcome;
}

const closeSession = (ctx: TurnContext, input: QuoteCloseInput): Promise<QuoteCloseResult> =>
  withSession(ctx, "quote_close", (audit, runId, lease) => needs(audit, "quoteClose")(runId, lease, input));

// Cierra la sesión según la evaluación REAL de lo que hay en la base y devuelve el texto correspondiente. Es el mismo cierre de siempre: catálogo recargado, evaluación, verificación de la base y
// preparaciones aprobadas anexadas a la cotización.
async function closeAndRender(args: { ctx: TurnContext; deps: QuoteDeps; config: QuoteSessionsConfig; texts: QuoteTexts; from: string; sleep: (ms: number) => Promise<void>; planned: "QUOTE" | "REVIEW"; plannedIds: readonly string[] }): Promise<{ quote?: { body: string }; override?: CoreOverride; actual: string; mismatch?: boolean }> {
  const { ctx, deps, config, texts } = args;
  const read = await readSession(ctx, deps, config, args.sleep, true);
  if (read === "pending") return { override: { body: texts.waiting, result: "no_quote" }, actual: "WAITING" };
  if (read.state === "replay") return { override: await replayOverride(read, deps, ctx, texts), actual: "REPLAY" };
  if (read.state === "none") return { override: { body: texts.empty, result: "no_quote" }, actual: "EMPTY" };

  // Catálogo RECARGADO ahora (sin caché): los estudios y precios vigentes son los de este instante.
  const catalog = await deps.loadCatalog();
  const evaluation = evaluateSession(read.items, catalog);
  // Discrepancia entre lo previsto por el plan y lo que dice la evaluación real (solo para el registro; manda siempre la evaluación).
  const mismatch = evaluation.kind !== args.planned || (evaluation.kind === "QUOTE" && [...new Set(evaluation.lines.map((line) => line.studyId))].sort().join() !== [...new Set(args.plannedIds)].sort().join());
  deps.log("quote_session", { event: "evaluated", mode: "BATCH", kind: evaluation.kind, items: read.items.length, ...(evaluation.kind === "QUOTE" ? { studies: evaluation.lines.length, duplicates: evaluation.duplicates } : {}), ...(evaluation.kind === "REVIEW" ? { reasons: evaluation.reasons } : {}) });
  if (evaluation.kind === "EMPTY") return { override: { body: texts.empty, result: "no_quote" }, actual: "EMPTY", mismatch };
  const input: QuoteCloseInput =
    evaluation.kind === "QUOTE" ? { sessionId: read.sessionId, outcome: "QUOTED", lines: evaluation.lines, totalBs: evaluation.totalBs, catalogFingerprint: catalogFingerprint(catalog).hash }
    : evaluation.kind === "REVIEW" ? { sessionId: read.sessionId, outcome: "NEEDS_REVIEW", reasons: evaluation.reasons }
    : { sessionId: read.sessionId, outcome: "NEEDS_RESEND" };
  const closed = await closeSession(ctx, input);
  if (closed.status === "pending") return { override: { body: texts.waiting, result: "no_quote" }, actual: "WAITING", mismatch };
  if (closed.status === "not_open") return { override: { body: texts.empty, result: "no_quote" }, actual: "EMPTY", mismatch };

  if (evaluation.kind === "QUOTE") {
    deps.turns?.convState?.artifact({ from: args.from, key: read.sessionId, kind: "QUOTE", studyIds: evaluation.lines.map((line) => line.studyId) });
    let body = formatSessionQuote(evaluation.lines, evaluation.duplicates, texts);
    if (deps.quotePreparations) {
      try {
        body = await deps.quotePreparations(body, evaluation.lines.map((line) => line.studyId), catalog, ctx);
      } catch {
        deps.log("quote_preparation_skipped", { reason: "APPEND_FAILED" });
      }
    }
    return { quote: { body: compactQuote(body) }, actual: "QUOTE", mismatch };
  }
  if (evaluation.kind === "REVIEW") {
    // Con la derivación al CRM configurada se registra un caso por mensaje dudoso y SOLO si el CRM los registró todos se le dice al paciente que una persona lo revisará.
    const crm = deps.turns?.crmHandoff;
    let registered = false;
    if (crm) {
      try {
        const outcomes = await crm.submitSessionReview(ctx, { sessionId: read.sessionId, contactPhone: args.from, catalog });
        registered = outcomes.length > 0 && outcomes.every((outcome) => outcome.state === "REGISTERED");
        deps.log("quote_session", { event: "review_handoff", cases: outcomes.length, registered });
      } catch {
        deps.log("quote_session", { event: "review_handoff_failed" });
      }
    }
    return { override: { body: registered ? texts.review_confirmed : texts.review, result: "no_quote" }, actual: "REVIEW", mismatch };
  }
  return { override: { body: texts.resend, result: "no_quote" }, actual: "RESEND", mismatch };
}
