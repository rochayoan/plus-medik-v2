import { repeatCandidate } from "./attention-filter.js";
import { AuditWriteError, processingFailureCode, type KnowledgeRefRecord } from "./audit.js";
import { beginTurn, type ClaimedTurn, type StalePolicy, type TurnKind, type TurnOutcome, type TurnProducer, type TurnRef } from "./guarded-turn.js";
import type { CaseOutcome } from "./crm-outbox/types.js";
import { parseSessionCommand, parseSessionReply, summarizeSession } from "./quote-session.js";
import { sessionImageProducer, sessionTextProducer } from "./quote-session-turns.js";
import { classifyText } from "./text-handler.js";
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
      return { kind: "reply", body: reply.body, result: "conversation", processingStatus: "COMPLETED", stale: reply.stale ?? "NEWER_TURN", ...(reply.signature ? { signature: reply.signature } : {}) };
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
  return sessions && turn.kind === "TEXT" ? sessionTextProducer(turn, deps, sessions, conversation, undefined, recentQuote) : conversation();
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
// Un fallo en un turno no impide los demás. Nunca se registra el contenido de un mensaje.
export async function processTurns(turns: IncomingTurn[], deps: QuoteDeps): Promise<TurnReport[]> {
  const reports: TurnReport[] = turns.map((turn) => ({ messageId: turn.messageId, result: "skipped" }));
  const claimed: Array<{ index: number; turn: ClaimedTurn; produce: TurnProducer }> = [];
  for (const [index, turn] of turns.entries()) {
    const produce = producerFor(turn, deps);
    if (!produce) continue;
    if (isRepeatedMessage(turn, deps)) {
      // Ni se reclama ni se responde: es el mismo mensaje que ya se está atendiendo. Solo un código en el registro.
      deps.log("attention_filter", { action: "IGNORE", reason: "REPEAT" });
      continue;
    }
    try {
      const begun = await beginTurn(refOf(turn), deps);
      if ("ended" in begun) reports[index] = { messageId: turn.messageId, result: begun.ended };
      else claimed.push({ index, turn: begun.claimed, produce });
    } catch {
      deps.log("turn_failed", { stage: "claim", kind: turn.kind });
      reports[index] = { messageId: turn.messageId, result: "ignored" };
    }
  }
  await Promise.all(
    claimed.map(async ({ index, turn, produce }) => {
      try {
        const result = await turn.run(produce);
        reports[index] = { messageId: turns[index]!.messageId, result };
        // Un mensaje que no llegó a buen término (falla técnica, respuesta retenida) se puede repetir y debe procesarse.
        const source = turns[index]!;
        if ((result === "ignored" || result === "technical_issue") && deps.turns?.attention && source.kind === "TEXT" && source.text) deps.turns.attention.repeats.forget(source.from, source.text);
      } catch {
        const failed = turns[index]!;
        if (deps.turns?.attention && failed.kind === "TEXT" && failed.text) deps.turns.attention.repeats.forget(failed.from, failed.text);
        deps.log("turn_failed", { stage: "run", kind: turns[index]!.kind });
        reports[index] = { messageId: turns[index]!.messageId, result: "ignored" };
      }
    })
  );
  return reports;
}
