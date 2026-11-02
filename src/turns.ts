import { repeatCandidate } from "./attention-filter.js";
import { AuditWriteError, processingFailureCode, type KnowledgeRefRecord } from "./audit.js";
import { beginTurn, type ClaimedTurn, type Produced, type StalePolicy, type TurnKind, type TurnOutcome, type TurnProducer, type TurnRef } from "./guarded-turn.js";
import type { CaseOutcome } from "./crm-outbox/types.js";
import { parseSessionCommand, parseSessionReply, summarizeSession } from "./quote-session.js";
import { sessionImageProducer, sessionTextProducer } from "./quote-session-turns.js";
import { classifyText, DRAFT_TEXTS } from "./text-handler.js";
import { joinStudyFragments } from "./text-fragments.js";
import { deferClosing, mergeContactTurns, mergeProduced, type BatchUnit } from "./turn-batch.js";
import { imageProducer, maskPhone, TECHNICAL_ISSUE_MESSAGE, type IncomingImage, type QuoteDeps } from "./whatsapp-quote.js";

// Turnos conversacionales (G2.0): cualquier mensaje ENTRANTE de un contacto (imagen, texto u otro) se procesa con la misma máquina de seguridad que ya protegía a las
// imágenes (guarded-turn.ts: claim con lease, reserva de envío, comprobación de pausa humana, un envío incierto jamás se reenvía) más lo que necesitan varios
// mensajes consecutivos del mismo contacto (migración 6): numeración por contacto, un solo envío en vuelo por contacto y descarte de respuestas obsoletas.
//
// Esta capa NO decide qué responder a un texto: eso lo hace un manejador inyectado (TurnHandlers). Sin manejador, un texto o un mensaje de otro tipo ni se reclama, ni
// se registra, ni se responde (el comportamiento de hoy). Las imágenes siguen yendo al motor de recetas, sin cambiar ninguna de sus reglas.

export interface IncomingTurn {
  messageId: string;
  from: string;
  kind: TurnKind;
  // Solo en memoria: el contenido de un mensaje de texto NUNCA se registra, ni en el log ni en la auditoría.
  text?: string;
  mediaUrl?: string;
  mediaId?: string;
  // Instante del mensaje (segundos desde la época) si Kapso lo informa; solo se usa para ordenar un lote.
  timestamp?: number;
}

// La respuesta de un manejador. stale: NEWER_TURN (por defecto en una conversación) descarta la respuesta si un turno más nuevo del contacto ya respondió; NONE la
// envía siempre.
// Respuesta basada en conocimiento aprobado: sus referencias se registran ANTES de reservar el envío. Si no se pueden registrar, NO se envía esa respuesta y se usa `fallback` (lo
// que se habría respondido sin conocimiento).
export interface TurnKnowledge {
  refs: readonly KnowledgeRefRecord[];
  fallback(): Promise<TurnReply | undefined>;
}
export interface TurnReply {
  body: string;
  stale?: StalePolicy;
  knowledge?: TurnKnowledge;
  // Código cerrado de lo que se responde (categoría y temas; nunca texto). Con la guarda de respuestas (G3.2) permite detectar que se da la misma respuesta una y otra vez.
  signature?: string;
}

// Contexto que el productor del turno pone a disposición del manejador (G4.1). Se consulta SOLO si hace falta (p. ej. el paciente pregunta «¿cuándo estarán?» sin nombrar el estudio).
// Estado reciente de la conversación de un contacto (G6.0), derivado de la sesión de cotización y de la última cotización entregada. Solo cantidades y banderas: nunca nombres, precios ni texto de mensajes.
export interface ConversationMemory {
  openRequest: boolean;
  openStudies: number;
  openDoubt: boolean;
  recentQuoteStudies: number;
}

export interface TurnHandlerContext {
  // G6.0 (solo con la atención selectiva y las sesiones de cotización): el estado reciente de la conversación de este contacto. Se calcula SOLO si se pide (p. ej. antes de consultar al modelo) y es undefined si no se pudo.
  memory?(): Promise<ConversationMemory | undefined>;
  // G5.0 (solo con la derivación al CRM configurada): guarda en la cola el caso de ESTE mensaje y hace el primer intento. El estado es REGISTERED solo si el CRM ya lo registró.
  registerCase?(reason: "HUMAN_REQUEST" | "MEDICAL_QUERY" | "NO_APPROVED_ANSWER"): Promise<CaseOutcome["state"]>;
  // ids de lab_tests de la ÚLTIMA cotización entregada a este contacto (vacío si no hay una reciente o no se pudo consultar; nunca precios).
  quotedStudyIds(): Promise<string[]>;
}

export interface TurnHandlers {
  text?(turn: IncomingTurn, context?: TurnHandlerContext): Promise<TurnReply | undefined>;
  other?(turn: IncomingTurn): Promise<TurnReply | undefined>;
}

// ───────────────────────────── payload de Kapso ─────────────────────────────

// Mensajes ENTRANTES del paciente. No son turnos: salientes, estados de entrega, reacciones y eventos sin mensaje. Un texto sin contenido o una imagen sin medio
// tampoco. El resultado sale ordenado por el instante del mensaje (estable si empatan; los que no lo informan, al final y en su orden), de modo que un lote se
// numere en el orden en que el paciente escribió.
// freshness (opt-in; el webhook de turnos lo usa siempre): solo para texto y otros tipos —las IMÁGENES no cambian—, descarta
//   · cualquier evento que no sea de mensaje RECIBIDO (enviado, entregado, leído, fallido, de conversación...), según la cabecera x-webhook-event;
//   · mensajes importados del historial (origin history_sync);
//   · mensajes viejos (más de maxAgeSeconds), del futuro lejano o sin instante conocido: nadie debe recibir una respuesta a un mensaje de hace horas.
export interface ExtractOptions {
  eventName?: string | null;
  nowSeconds?: number;
  maxAgeSeconds?: number;
}
export const DEFAULT_MAX_AGE_SECONDS = 600;
const FUTURE_SKEW_SECONDS = 300;

export function extractIncomingTurns(payload: Record<string, any>, batchHeader?: string | null, options: ExtractOptions = {}): IncomingTurn[] {
  const eventName = options.eventName?.trim().toLowerCase();
  const notReceivedEvent = Boolean(eventName) && !eventName!.endsWith(".received");
  const fresh = (timestamp: number | undefined, origin: unknown): boolean => {
    if (options.nowSeconds === undefined) return true;
    if (notReceivedEvent || origin === "history_sync") return false;
    if (timestamp === undefined) return false;
    const age = options.nowSeconds - timestamp;
    return age <= (options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS) && age >= -FUTURE_SKEW_SECONDS;
  };
  const isBatch = payload.batch === true || batchHeader === "true";
  const events: Record<string, any>[] = isBatch && Array.isArray(payload.data) ? payload.data : [payload];
  const out: IncomingTurn[] = [];
  for (const event of events) {
    const message = event?.message;
    if (!message || typeof message !== "object") continue;
    const direction = message.kapso?.direction;
    if (direction && direction !== "inbound") continue;
    const from = String(message.from ?? event.conversation?.phone_number ?? "");
    const messageId = String(message.id ?? "");
    if (!from || !messageId) continue;
    const type = typeof message.type === "string" ? message.type.toLowerCase() : message.image ? "image" : "";
    const seconds = Number(message.timestamp);
    const timestamp = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
    const base = { messageId, from, ...(timestamp !== undefined ? { timestamp } : {}) };

    if (type === "image" || message.image) {
      const candidates = [message.kapso?.media_url, message.kapso?.media_data?.url, message.image?.link, message.image?.url];
      const mediaUrl = candidates.find((c): c is string => typeof c === "string" && c.trim() !== "")?.trim();
      const mediaId = typeof message.image?.id === "string" ? message.image.id : undefined;
      if (!mediaUrl && !mediaId) continue;
      out.push({ ...base, kind: "IMAGE", mediaUrl, mediaId });
    } else if (type === "text") {
      const body = message.text?.body;
      if (typeof body !== "string" || body.trim() === "") continue;
      if (!fresh(timestamp, message.kapso?.origin)) continue;
      out.push({ ...base, kind: "TEXT", text: body });
    } else if (type && type !== "reaction") {
      if (!fresh(timestamp, message.kapso?.origin)) continue;
      out.push({ ...base, kind: "OTHER" });
    }
  }
  return out
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => (a.turn.timestamp ?? Number.POSITIVE_INFINITY) - (b.turn.timestamp ?? Number.POSITIVE_INFINITY) || a.index - b.index)
    .map(({ turn }) => turn);
}

// ───────────────────────────── procesamiento ─────────────────────────────

export interface TurnReport {
  messageId: string;
  // skipped = no hay manejador para ese tipo: ni siquiera se reclamó.
  result: TurnOutcome | "skipped";
}

const imageOf = (turn: IncomingTurn): IncomingImage => ({ messageId: turn.messageId, from: turn.from, mediaUrl: turn.mediaUrl, mediaId: turn.mediaId });
const refOf = (turn: IncomingTurn): TurnRef => ({ messageId: turn.messageId, mediaId: turn.mediaId, from: turn.from, kind: turn.kind, who: maskPhone(turn.from) });

const DEFAULT_CONTEXT_SECONDS = 86_400;

// Respuestas fijas que solo piden al paciente que escriba sus estudios o envíe la receta (saludo, «con gusto te ayudo a cotizar», «¿sobre qué quieres saber?»). Dentro de un lote de Kapso se descartan si
// el lote ya trae algo más concreto (ver mergeProduced). Se reconocen por su texto fijo; con textos personalizados no se marca nada y se conserva todo (el caso seguro).
const GENERIC_PROMPTS: ReadonlySet<string> = new Set([DRAFT_TEXTS.greeting, DRAFT_TEXTS.send_recipe, DRAFT_TEXTS.fallback]);

export function conversationProducer(turn: IncomingTurn, handler: (turn: IncomingTurn, context?: TurnHandlerContext) => Promise<TurnReply | undefined>, deps: QuoteDeps): TurnProducer {
  return async (ctx) => {
    try {
      // Contexto perezoso: la última cotización solo se consulta si el manejador lo pide, con el lease de ESTA ejecución. Si no se puede consultar, no hay contexto (se pedirá el estudio).
      const crm = deps.turns?.crmHandoff;
      const context: TurnHandlerContext = {
        ...(crm
          ? {
              async registerCase(reason) {
                const [outcome] = await crm.submit(ctx, [{ kapsoMessageId: turn.messageId, contactPhone: turn.from, kind: "CONVERSATION", reasons: [reason] }]);
                return outcome?.state ?? "FAILED";
              }
            }
          : {}),
        ...(deps.turns?.attention && deps.turns.quoteSessions
          ? {
              async memory(): Promise<ConversationMemory | undefined> {
                let memory: ConversationMemory | undefined;
                const ok = await ctx.persist("conversation_memory", async (audit, runId, lease) => {
                  const read = await audit.quoteRead?.(runId, lease);
                  const summary = read?.state === "ready" ? summarizeSession(read.items) : undefined;
                  const recent = (await audit.quoteLastStudies?.(runId, lease, deps.turns?.studyInfoContextSeconds ?? DEFAULT_CONTEXT_SECONDS)) ?? [];
                  memory = {
                    openRequest: Boolean(summary) && read?.state === "ready" && read.items.length > 0,
                    openStudies: summary?.studyIds.length ?? 0,
                    openDoubt: Boolean(summary) && (summary!.pendingGroups.length > 0 || summary!.unresolved > 0 || summary!.uncertain),
                    recentQuoteStudies: recent.length
                  };
                });
                return ok ? memory : undefined;
              }
            }
          : {}),
        async quotedStudyIds() {
          let ids: string[] = [];
          const ok = await ctx.persist("quote_context", async (audit, runId, lease) => {
            ids = (await audit.quoteLastStudies?.(runId, lease, deps.turns?.studyInfoContextSeconds ?? DEFAULT_CONTEXT_SECONDS)) ?? [];
          });
          return ok ? ids : [];
        }
      };
      let reply = await handler(turn, context);
      if (reply?.knowledge) {
        const { refs, fallback } = reply.knowledge;
        // Conocimiento de G3 y datos por estudio de G4.1 se rastrean por separado; las DOS escrituras deben confirmarse antes de reservar el envío.
        const factKinds = new Set<string>(["SAMPLE", "TURNAROUND"]);
        const factRefs = refs.filter((ref) => factKinds.has(ref.kind));
        const knowledgeRefs = refs.filter((ref) => !factKinds.has(ref.kind));
        const traced = await ctx.persist("knowledge", async (audit, runId, lease) => {
          if (knowledgeRefs.length > 0 && (await audit.recordKnowledgeRefs?.(runId, knowledgeRefs, lease)) !== "recorded") throw new AuditWriteError("REJECTED");
          if (factRefs.length > 0) {
            const records = factRefs.map((ref) => ({ kind: ref.kind as "SAMPLE" | "TURNAROUND", labTestId: ref.key, version: ref.version, contentHash: ref.contentHash }));
            if ((await audit.recordFactRefs?.(runId, records, lease)) !== "recorded") throw new AuditWriteError("REJECTED");
          }
        });
        if (!traced) {
          // Sin rastro de qué versiones aprobadas respaldan la respuesta, no se envía: se responde lo que correspondería sin conocimiento.
          deps.log("knowledge_trace_failed", { refs: refs.length });
          reply = await fallback();
        }
      }
      if (!reply || reply.body.trim() === "") {
        // Nada que decir: el turno se cierra sin respuesta (queda auditado), no se reserva ni se envía nada.
        await ctx.persist("close", (audit, runId, lease) => audit.recordIgnored(runId, "NO_REPLY", lease));
        return { kind: "none" };
      }
      return { kind: "reply", body: reply.body, result: "conversation", processingStatus: "COMPLETED", stale: reply.stale ?? "NEWER_TURN", ...(reply.signature ? { signature: reply.signature } : {}), ...(GENERIC_PROMPTS.has(reply.body) ? { generic: true as const } : {}) };
    } catch {
      // Nunca se registra el texto del error (puede traer el contenido del mensaje): solo el código de la etapa.
      const errorCode = processingFailureCode("OTHER");
      deps.log("processing_failed", { messageId: turn.messageId, phone: maskPhone(turn.from), errorCode });
      await ctx.persist("failure", (audit, runId, lease) => audit.recordFailure(runId, errorCode, lease));
      return { kind: "reply", body: TECHNICAL_ISSUE_MESSAGE, result: "technical_issue", processingStatus: "FAILED", stale: "NEWER_TURN" };
    }
  };
}

// Qué turnos se procesan con la configuración actual: las imágenes siempre; un texto u otro tipo solo si hay un manejador para ese tipo.
export function producerFor(turn: IncomingTurn, deps: QuoteDeps): TurnProducer | undefined {
  const handlers = deps.turns?.handlers;
  const sessions = deps.turns?.quoteSessions;
  // Con sesiones, la foto no se cotiza sola: se agrega a la sesión del contacto (la cotización sale con «listo»). Solo si hay manejador de texto (si no, nadie podría cerrar la sesión).
  if (turn.kind === "IMAGE") return sessions && handlers?.text && !deps.turns?.instantPhotoQuotes ? sessionImageProducer(imageOf(turn), deps, sessions) : imageProducer(imageOf(turn), deps);
  const handler = turn.kind === "TEXT" ? handlers?.text : handlers?.other;
  if (!handler) return undefined;
  const conversation = () => conversationProducer(turn, (t, c) => handler.call(handlers, t, c), deps);
  // G6.0: ¿hubo una cotización entregada hace poco? Solo se consulta cuando alguien escribe «listo» sin nada abierto (para tomarlo como acuse) y reutiliza la misma memoria de la última cotización de G4.1.
  const recentQuote = async (ctx: Parameters<TurnProducer>[0]): Promise<boolean> => {
    let recent = false;
    const ok = await ctx.persist("quote_recent", async (audit, runId, lease) => {
      recent = ((await audit.quoteLastStudies?.(runId, lease, deps.turns?.studyInfoContextSeconds ?? DEFAULT_CONTEXT_SECONDS)) ?? []).length > 0;
    });
    return ok && recent;
  };
  return withPatientMemory(turn, sessions && turn.kind === "TEXT" ? sessionTextProducer(turn, deps, sessions, conversation, undefined, recentQuote) : conversation(), deps);
}

// Memoria conversacional (apagada si falta): el mensaje de texto del paciente se guarda al empezar su turno, ANTES de producir la respuesta (el filtro de contenido decide qué se guarda de verdad). Nunca lanza ni retrasa más del tope de la memoria.
function withPatientMemory(turn: IncomingTurn, producer: TurnProducer, deps: QuoteDeps): TurnProducer {
  const memory = deps.turns?.memory;
  if (!memory || turn.kind !== "TEXT" || typeof turn.text !== "string") return producer;
  const text = turn.text;
  return async (ctx) => {
    const contactKey = deps.turns!.contactKeyFor(turn.from);
    if (contactKey) await memory.rememberPatient({ contactKey, messageId: turn.messageId, text, ...(turn.timestamp ? { at: new Date(turn.timestamp * 1000) } : {}) });
    return producer(ctx);
  };
}

// G6.0: ¿es la repetición literal de un mensaje de texto recién procesado del mismo contacto? Solo con la atención selectiva. No aplica a lo médico, a pedir a una persona, a las respuestas cortas de una
// solicitud abierta («sí», «2», «listo») ni a mensajes de una palabra. La huella vive en memoria unos segundos y no contiene el texto.
function isRepeatedMessage(turn: IncomingTurn, deps: QuoteDeps): boolean {
  const attention = deps.turns?.attention;
  if (!attention || turn.kind !== "TEXT" || typeof turn.text !== "string") return false;
  const sessionShaped = Boolean(parseSessionCommand(turn.text) || parseSessionReply(turn.text));
  if (!repeatCandidate(turn.text, classifyText(turn.text), sessionShaped)) return false;
  return attention.repeats.seen(turn.from, turn.text);
}

export const hasProcessableTurns = (turns: IncomingTurn[], deps: QuoteDeps): boolean => turns.some((turn) => turn.kind === "IMAGE" || (turn.kind === "TEXT" ? deps.turns?.handlers?.text : deps.turns?.handlers?.other));

// Procesa los turnos recibidos EN EL ORDEN DADO (extractIncomingTurns ya los ordena por el instante del mensaje):
//   1. los claims se hacen UNO por UNO, en ese orden, así la numeración del contacto respeta el orden en que el paciente escribió;
//   2. el trabajo de los turnos reclamados corre después en paralelo; la reserva de envío de la base impide que dos respuestas al mismo contacto se crucen y
//      descarta las que quedaron obsoletas.
// Lote de Kapso (buffering de 15 s, ver turn-batch.ts): si un contacto trae VARIOS mensajes en el mismo envío, todos se reclaman igual (deduplicación por mensaje), pero se atienden como UNA
// solicitud con UNA respuesta: los textos seguidos se leen como uno, cada foto conserva su análisis y todo sale en un solo mensaje, con una sola reserva de envío (cuenta una vez para el
// tope de respuestas, y la pausa humana se comprueba una vez). Un contacto con un solo mensaje sigue exactamente la ruta de siempre.
// Un fallo en un turno no impide los demás. Nunca se registra el contenido de un mensaje.
export async function processTurns(turns: IncomingTurn[], deps: QuoteDeps): Promise<TurnReport[]> {
  const reports: TurnReport[] = turns.map((turn) => ({ messageId: turn.messageId, result: "skipped" }));
  const live: number[] = [];
  for (const [index, turn] of turns.entries()) {
    if (!producerFor(turn, deps)) continue;
    if (isRepeatedMessage(turn, deps)) {
      // Ni se reclama ni se responde: es el mismo mensaje que ya se está atendiendo. Solo un código en el registro.
      deps.log("attention_filter", { action: "IGNORE", reason: "REPEAT" });
      continue;
    }
    live.push(index);
  }
  const perContact = new Map<string, number[]>();
  for (const index of live) {
    const from = turns[index]!.from;
    perContact.set(from, [...(perContact.get(from) ?? []), index]);
  }
  const batched = new Set([...perContact.entries()].filter(([, indices]) => indices.length > 1).map(([from]) => from));

  const claims = new Map<number, ClaimedTurn>();
  // Exclusión del MISMO lote entregado a la vez (reintento de Kapso, doble entrega): las ejecuciones reclaman en el mismo orden, así que solo UNA gana el primer mensaje de un contacto. La que
  // encuentra un mensaje ya EN CURSO en otra ejecución (no uno terminado) cede el resto de ese contacto: la otra lo atiende todo y responde una sola vez. Sin esto, cada una se llevaría una parte de
  // los mensajes y el paciente recibiría dos respuestas. Un mensaje ya terminado (duplicado de una entrega anterior) NO cede el grupo: los nuevos del mismo lote se siguen atendiendo.
  const yielded = new Map<string, number>();
  for (const index of live) {
    const turn = turns[index]!;
    if (yielded.has(turn.from)) {
      yielded.set(turn.from, yielded.get(turn.from)! + 1);
      reports[index] = { messageId: turn.messageId, result: "ignored" };
      continue;
    }
    try {
      const begun = await beginTurn(refOf(turn), deps);
      if ("ended" in begun) {
        reports[index] = { messageId: turn.messageId, result: begun.ended };
        if (begun.inFlight) yielded.set(turn.from, 0);
      } else claims.set(index, begun.claimed);
    } catch {
      deps.log("turn_failed", { stage: "claim", kind: turn.kind });
      reports[index] = { messageId: turn.messageId, result: "ignored" };
    }
  }

  for (const [from, skipped] of yielded) if (skipped > 0) deps.log("turn_batch_yield", { phone: maskPhone(from), skipped });

  const forget = (source: IncomingTurn) => {
    if (deps.turns?.attention && source.kind === "TEXT" && source.text) deps.turns.attention.repeats.forget(source.from, source.text);
  };
  const work: Promise<void>[] = [];
  for (const index of live) {
    const turn = turns[index]!;
    const claimed = claims.get(index);
    if (!claimed || batched.has(turn.from)) continue;
    work.push((async () => {
      try {
        const result = await claimed.run(producerFor(turn, deps)!);
        reports[index] = { messageId: turn.messageId, result };
        // Un mensaje que no llegó a buen término (falla técnica, respuesta retenida) se puede repetir y debe procesarse.
        if (result === "ignored" || result === "technical_issue") forget(turn);
      } catch {
        forget(turn);
        deps.log("turn_failed", { stage: "run", kind: turn.kind });
        reports[index] = { messageId: turn.messageId, result: "ignored" };
      }
    })());
  }
  for (const from of batched) work.push(processContactBatch(perContact.get(from)!, turns, claims, reports, deps, forget));
  await Promise.all(work);
  return reports;
}

// Etapas de `persist` que dejan el rastro de las versiones aprobadas usadas en una respuesta (conocimiento, preparación y datos por estudio de la cotización): en un lote se escriben en la
// corrida que envía el mensaje combinado.
const BATCH_TRACE_STAGES: ReadonlySet<string> = new Set(["knowledge", "quote_preparation", "quote_study_details"]);

// Atiende los mensajes de UN contacto que llegaron juntos (ya reclamados) como una sola solicitud con una sola respuesta.
async function processContactBatch(
  indices: number[],
  turns: IncomingTurn[],
  claims: Map<number, ClaimedTurn>,
  reports: TurnReport[],
  deps: QuoteDeps,
  forget: (source: IncomingTurn) => void
): Promise<void> {
  // Solo participan los mensajes que ESTA ejecución reclamó: un duplicado (ya atendido) o un claim fallido no se vuelve a leer ni se une a nada. Así un texto no se pierde ni se repite
  // aunque el último mensaje del lote no se haya podido reclamar.
  const mine = indices.filter((index) => claims.has(index));
  const contactTurns = mine.map((index) => turns[index]!);
  const indexOf = new Map(contactTurns.map((turn, position) => [turn, mine[position]!] as const));
  // Con sesiones de cotización cada texto conserva su clasificación (un texto médico o de información no debe tragarse los estudios que se escribieron al lado) y todos alimentan la MISMA
  // sesión; sin sesiones, los textos seguidos se leen como uno solo.
  const sessions = Boolean(deps.turns?.quoteSessions && deps.turns.handlers?.text);
  let units = mergeContactTurns(contactTurns, () => sessions);
  // Nombres de estudios partidos entre mensajes contiguos («hemograma» + «completo»): se reconstruyen ANTES de interpretar, con la regla estricta de text-fragments.ts (nunca se unen intenciones distintas).
  // Se usa el mismo catálogo con el que se interpretan los textos; si no se puede leer, no se une nada.
  const textUnits = units.length;
  if (sessions && units.length > 1) {
    const quoteSessions = deps.turns!.quoteSessions!;
    units = await joinStudyFragments(units, () => (quoteSessions.catalogForText ?? deps.loadCatalog)());
  }
  deps.log("turn_batch", { phone: maskPhone(turns[indices[0]!]!.from), messages: indices.length, claimed: mine.length, requests: units.length, textsMerged: contactTurns.length - textUnits, ...(textUnits !== units.length ? { fragmentsJoined: textUnits - units.length } : {}) });

  const runnable: Array<{ unit: BatchUnit; index: number; claimed: ClaimedTurn; produce: TurnProducer }> = [];
  const quiet: Promise<void>[] = [];
  for (const unit of units) {
    const lead = unit.members[unit.members.length - 1]!;
    for (const member of unit.members) {
      if (member === lead) continue;
      // Su contenido ya viaja dentro del texto unido: solo se deja constancia (deduplicación) y se cierra sin respuesta.
      const index = indexOf.get(member)!;
      reports[index] = { messageId: member.messageId, result: "ignored" };
      quiet.push(claims.get(index)!.skip().catch(() => undefined));
    }
    const index = indexOf.get(lead)!;
    const produce = producerFor(unit.turn, deps);
    if (produce) runnable.push({ unit, index, claimed: claims.get(index)!, produce });
  }

  if (runnable.length > 0) {
    const responder = runnable[runnable.length - 1]!;
    const drafts = runnable.slice(0, -1);
    let included: boolean[] = [];
    // El último turno es el que responde: hace su trabajo y, además, integra lo que produjeron los anteriores (que no reservan ni envían nada por su cuenta).
    const produce: TurnProducer = drafts.length === 0
      ? responder.produce
      : async (ctx) => {
          const own = deferClosing(ctx);
          // Primero los demás mensajes del lote (en paralelo entre sí) y DESPUÉS el que responde: con sesiones de cotización, «listo» debe encontrar la solicitud ya abierta y sin turnos anteriores en proceso.
          // Si empezara a la vez, podría leer la sesión antes de que la primera foto la abra y contestar «todavía no tengo estudios anotados».
          const absorbed = await Promise.all(drafts.map((draft) => draft.claimed.absorb(draft.produce, ctx, BATCH_TRACE_STAGES)));
          // Red de seguridad: si el trabajo del último turno se rompe, lo de los demás no se pierde.
          const last = await responder.produce(own.ctx).catch((): Produced => {
            deps.log("turn_failed", { stage: "batch_responder", kind: responder.unit.turn.kind });
            return { kind: "none" };
          });
          const settled = [...absorbed, last];
          const merged = mergeProduced(settled);
          included = merged.included;
          // Nada que enviar: la corrida del último turno se cierra como habría hecho por su cuenta. Si hay algo que enviar, ese cierre se omite (la corrida termina con el envío).
          if (merged.produced.kind === "none") await own.flush();
          return merged.produced;
        };
    let outcome: TurnReport["result"];
    try {
      outcome = await responder.claimed.run(produce);
    } catch {
      deps.log("turn_failed", { stage: "run", kind: responder.unit.turn.kind });
      outcome = "ignored";
    }
    for (const [position, item] of runnable.entries()) {
      // el turno que responde es quien envía el mensaje del lote, aunque su propia respuesta estuviera vacía
      const delivered = drafts.length === 0 || position === runnable.length - 1 || included[position] === true;
      reports[item.index] = { messageId: item.unit.turn.messageId, result: delivered ? outcome : "ignored" };
    }
    if (outcome === "ignored" || outcome === "technical_issue") for (const item of runnable) for (const member of item.unit.members) forget(member);
  }
  await Promise.all(quiet);
}
