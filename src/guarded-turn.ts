import { AuditWriteError, type AuditLease, type AuditRepository, type SendableResult, type SendConfirmation, type SendReservation, type StalePolicy, type TurnKind } from "./audit.js";
import type { AttentionConfig } from "./attention-filter.js";
import type { ConversationMemory } from "./conversation-memory.js";
import type { CrmHandoff } from "./crm-outbox/types.js";
import type { QuoteSessionsConfig } from "./quote-session.js";
import type { ReplyGuardConfig } from "./reply-guard.js";
import type { TurnHandlers } from "./turns.js";
import type { QuoteDeps } from "./whatsapp-quote.js";

export type { StalePolicy, TurnKind };

// Máquina de seguridad del envío, común a cualquier mensaje entrante (imagen, texto u otro). Es la que antes vivía dentro de handleImageMessage, sin cambios de
// comportamiento (ver supabase/migrations/20261023000000_plusmedik_audit_leases.sql):
//   claim (lease) -> TRABAJO del turno -> RESERVA de envío -> comprobación final -> Kapso -> resultado.
// La llamada a Kapso solo ocurre tras una reserva concedida por la base a la ejecución que posee el lease. Cualquier otra cosa (reserva denegada, lease perdido,
// reserva de resultado desconocido, base no disponible) significa NO enviar: un mensaje no enviado se concilia después; uno duplicado no se puede deshacer.
//
// Modo turnos (deps.turns, migración 6): además, el claim numera el turno dentro de su contacto, la reserva admite un solo envío en vuelo por contacto ('busy': se
// espera y se reintenta, con tope) y descarta la respuesta si quedó obsoleta ('superseded'). Sin deps.turns el flujo es exactamente el anterior.

export const DEFAULT_BUSY_RETRIES = 8;
export const DEFAULT_BUSY_DELAY_MS = 1500;

export interface TurnsConfig {
  // Clave estable (HMAC) del contacto; SIN ella el modo turnos no responde (falla cerrado).
  contactKeyFor(phone: string): string | undefined;
  // Cuántas veces se reintenta una reserva 'busy' (otro envío del contacto en vuelo) y cuánto se espera entre intentos. Superado el tope no se envía.
  busyRetries?: number;
  busyDelayMs?: number;
  sleep?(ms: number): Promise<void>;
  // G3.2 (apagado si falta): tope de respuestas por contacto y señales de bucle, aplicados por la base dentro de la reserva (migración 10). Solo afecta a las respuestas
  // conversacionales (texto y otros tipos); las imágenes y sus cotizaciones nunca se limitan.
  replyGuard?: ReplyGuardConfig;
  // G4.0 (apagado si falta): sesiones de cotización. Las fotos y los estudios escritos se agregan a la sesión del contacto y solo se cotiza cuando el paciente escribe «listo».
  // Exige el manejador de texto (sin él nadie podría escribir «listo»). Con esto ausente el flujo de imágenes es exactamente el de siempre.
  quoteSessions?: QuoteSessionsConfig;
  // Opt-in para que CADA fotografía se cotice inmediatamente con el motor original, sin entrar a la sesión ni pedir LISTO.
  // Las listas escritas siguen usando quoteSessions; no cambia el comportamiento de otros contactos.
  instantPhotoQuotes?: boolean;
  // G4.1: cuánto tiempo después de una cotización entregada se considera «la última cotización» del contacto para responder por sus estudios sin que los nombre (por defecto 24 h).
  studyInfoContextSeconds?: number;
  // G5.0 (apagado si falta): derivación segura de casos al CRM (cola de salida persistente e idempotente). Sin esto la derivación a una persona sigue bloqueada.
  crmHandoff?: CrmHandoff;
  // G6.0 (apagado si falta): atención selectiva. Descarta las repeticiones literales ANTES de reclamar el turno y, con las sesiones de cotización, agrupa las confirmaciones de varios mensajes seguidos.
  // El resto del filtro (saludos, cortesías y ruido) lo aplica el manejador de texto. Ver src/attention-filter.ts.
  attention?: AttentionConfig;
  // Tope de respuestas del agente por contacto en una ventana móvil (apagado si falta; ver src/daily-reply-cap.ts). Lo aplica la base dentro de la reserva de envío y cuenta TODO lo que el agente envía
  // (texto, cotizaciones y fotos); los mensajes humanos de recepción no se cuentan.
  dailyCap?: { max: number; windowSeconds: number };
  // Memoria conversacional corta (apagada si falta; ver src/conversation-memory.ts): se guardan los mensajes de texto del paciente y las respuestas conversacionales confirmadas como enviadas.
  memory?: ConversationMemory;
  // Quién responde a los mensajes que no son imágenes. Sin manejador, ese tipo de mensaje ni se reclama ni se responde.
  handlers?: TurnHandlers;
}

export interface TurnRef {
  messageId: string;
  mediaId?: string;
  from: string;
  kind: TurnKind;
  // Teléfono enmascarado para los registros.
  who: string;
}

// Lo que el trabajo de un turno decide: nada que enviar (el trabajo ya cerró la corrida si hacía falta) o una respuesta.
export type Produced =
  | { kind: "none" }
  | { kind: "reply"; body: string; result: SendableResult; processingStatus: "COMPLETED" | "FAILED"; stale?: StalePolicy; signature?: string };

export interface TurnContext {
  // Número del turno dentro de su contacto, en el orden de llegada a la base (solo en modo turnos).
  seq?: number;
  // true si hay corrida con lease (auditoría activa); si no, persist no hace nada.
  guarded: boolean;
  // Escribe en la auditoría con el lease de esta ejecución. Un fallo se registra (solo su código) y no interrumpe el turno; LEASE_LOST impide enviar.
  // Devuelve true solo si la escritura se confirmó (false si no hay auditoría, falló o no se supo el resultado).
  persist(stage: string, action: (audit: AuditRepository, runId: string, lease: AuditLease) => Promise<void>): Promise<boolean>;
}

export type TurnProducer = (ctx: TurnContext) => Promise<Produced>;
export type TurnOutcome = SendableResult | "ignored";

export interface ClaimedTurn {
  run(produce: TurnProducer): Promise<TurnOutcome>;
  // Lote de Kapso (buffering de 15 s): varios mensajes del MISMO contacto se atienden como una sola solicitud con UNA sola respuesta, enviada por el turno que responde (`run`).
  // `absorb` hace el trabajo de este turno (sesión de cotización, análisis de la foto, etc., con su propio lease) pero NO reserva ni envía nada: devuelve lo que habría respondido para que
  // el turno que responde lo integre, y cierra esta corrida como «sin respuesta propia». Las escrituras de las etapas `redirectStages` (rastro de las versiones aprobadas
  // usadas en la respuesta) se hacen en la corrida que SÍ envía (`into`), para que ese rastro sea el de la corrida que envió el mensaje.
  absorb(produce: TurnProducer, into: TurnContext, redirectStages: ReadonlySet<string>): Promise<Produced>;
  // Mensaje del lote cuyo contenido ya viaja dentro de otro turno (varios textos seguidos se leen como uno): se reclama (deduplicación) y se cierra sin respuesta ni trabajo.
  skip(): Promise<void>;
}

const writeErrorKind = (error: unknown) => (error instanceof AuditWriteError ? { kind: error.kind } : {});
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Fase 1: el claim. En un lote se llama UNO por UNO, en el orden de los mensajes, para que la numeración del contacto respete ese orden; el trabajo (fase 2) puede
// luego correr en paralelo. Si el turno no debe procesarse (duplicado, pausa humana, sin clave de contacto, base caída con la guarda obligatoria) devuelve ended.
// inFlight: el mensaje ya lo está atendiendo OTRA ejecución (lease vigente o envío en curso). Lo usa processTurns para no repartirse con ella los demás mensajes del mismo lote.
export async function beginTurn(ref: TurnRef, deps: QuoteDeps): Promise<{ claimed: ClaimedTurn } | { ended: "ignored"; inFlight?: true }> {
  // Atención humana / turnos: sin una clave estable del contacto, o sin la auditoría que concede los leases y las reservas, no hay forma de comprobar la pausa -> no se responde.
  // Control acotado: solo los contactos de la lista explícita se tratan como con control humano; los demás siguen el flujo de siempre (ni clave de contacto ni guarda obligatoria).
  const scoped = !deps.humanControl && !deps.turns && deps.scopedControl?.covers(ref.from) ? deps.scopedControl : undefined;
  const keySource = deps.turns ?? deps.humanControl ?? scoped;
  let contactKey: string | undefined;
  if (keySource) {
    contactKey = keySource.contactKeyFor(ref.from);
    if (!contactKey || !deps.audit) {
      deps.log("reply_withheld", { reason: contactKey ? "audit_guard_unavailable" : "contact_unidentified" });
      return { ended: "ignored" };
    }
  }

  let auditRunId: string | undefined;
  let lease: AuditLease | undefined;
  let turnSeq: number | undefined;
  if (deps.audit) {
    try {
      const claimRef = { messageId: ref.messageId, mediaId: ref.mediaId };
      const claim = deps.turns ? await deps.audit.claim(claimRef, { contactKey: contactKey!, turnKind: ref.kind }) : contactKey ? await deps.audit.claim(claimRef, { contactKey }) : await deps.audit.claim(claimRef);
      if (claim.kind === "duplicate") {
        deps.log("duplicate_ignored", { processingStatus: claim.processingStatus, ...(claim.reason ? { reason: claim.reason } : {}) });
        return { ended: "ignored", ...(claim.reason === "BUSY" || claim.reason === "IN_DOUBT" ? { inFlight: true as const } : {}) };
      }
      auditRunId = claim.runId;
      lease = claim.lease;
      turnSeq = claim.seq;
      if (claim.takeover) deps.log("lease_taken_over", { fence: claim.lease.fence });
    } catch (error) {
      deps.log("audit_unavailable", { stage: "claim", ...writeErrorKind(error) });
      // Sin claim no hay lease ni reserva: la exclusión del envío no se puede demostrar. Por defecto se responde igual (política heredada: el webhook ya
      // confirmó la recepción, así que un duplicado exigiría una segunda entrega mientras la base no responde); requireAuditGuard, el control humano y los
      // turnos lo impiden.
      if (deps.requireAuditGuard || deps.humanControl || deps.turns || scoped) {
        deps.log("reply_withheld", { reason: "audit_guard_unavailable" });
        return { ended: "ignored" };
      }
    }
  }
  const guarded = Boolean(deps.audit && auditRunId && lease);

  // Latido del lease: solo mejora la disponibilidad. La seguridad NO depende de él (la reserva de envío comprueba owner + fence bajo bloqueo de fila).
  let leaseLost = false;
  const heartbeat = guarded
    ? setInterval(() => {
        deps.audit!.renewLease(auditRunId!, lease!).then((alive) => { if (!alive) leaseLost = true; }, () => undefined);
      }, deps.leaseRenewIntervalMs ?? 40_000)
    : undefined;
  heartbeat?.unref?.();

  const context: TurnContext = {
    ...(turnSeq !== undefined ? { seq: turnSeq } : {}),
    guarded,
    async persist(stage, action) {
      if (!guarded) return false;
      try {
        await action(deps.audit!, auditRunId!, lease!);
        return true;
      } catch (error) {
        if (error instanceof AuditWriteError && error.kind === "LEASE_LOST") leaseLost = true;
        // Solo el código del fallo de escritura (nunca texto del servidor): REJECTED, CONFLICT, LEASE_LOST o UNKNOWN_OUTCOME (no se supo si se confirmó).
        deps.log("audit_unavailable", { stage, ...writeErrorKind(error) });
        return false;
      }
    }
  };

  async function deliver(produced: Extract<Produced, { kind: "reply" }>): Promise<TurnOutcome> {
    const { body: reply, result, processingStatus } = produced;
    // RESERVA DE ENVÍO: la única autorización para llamar a Kapso. Se concede una sola vez, a la ejecución que posee el lease vigente y mientras nadie haya
    // bloqueado la respuesta. Sin reserva NO se envía (la base concilia lo pendiente; ver plusmedik_audit_recover_stale).
    if (guarded) {
      if (leaseLost) {
        deps.log("reply_withheld", { reason: "lease_lost" });
        return "ignored";
      }
      const stale: StalePolicy = produced.stale ?? "NONE";
      const maxBusy = deps.turns?.busyRetries ?? DEFAULT_BUSY_RETRIES;
      let busy = 0;
      let reservation: SendReservation | "unavailable" | "busy_timeout";
      for (;;) {
        try {
          // La guarda (G3.2) solo acompaña a lo conversacional; la base lo vuelve a comprobar (una imagen o una cotización nunca se limitan).
          const guard = deps.turns?.replyGuard && ref.kind !== "IMAGE" && (result === "conversation" || result === "technical_issue") ? { config: deps.turns.replyGuard, ...(produced.signature ? { signature: produced.signature } : {}) } : undefined;
          reservation = deps.turns ? await deps.audit!.reserveSend(auditRunId!, result, lease!, { stale, ...(guard ? { guard } : {}), ...(deps.turns.dailyCap ? { cap: deps.turns.dailyCap } : {}) }) : await deps.audit!.reserveSend(auditRunId!, result, lease!);
        } catch (error) {
          reservation = "unavailable";
          deps.log("audit_unavailable", { stage: "reserve", ...writeErrorKind(error) });
        }
        if (reservation !== "busy") break;
        // Otro envío del mismo contacto está en vuelo: se espera (acotado) a que termine para no cruzar ni reordenar mensajes al paciente.
        busy++;
        deps.log("turn_busy", { attempt: busy });
        if (busy > maxBusy) {
          reservation = "busy_timeout";
          break;
        }
        await (deps.turns?.sleep ?? realSleep)(deps.turns?.busyDelayMs ?? DEFAULT_BUSY_DELAY_MS);
        if (leaseLost) {
          deps.log("reply_withheld", { reason: "lease_lost" });
          return "ignored";
        }
      }
      if (reservation !== "reserved") {
        deps.log("reply_withheld", { reason: reservation });
        // Espera agotada: el turno no se pierde. Se libera su lease (marcado BUSY_TIMEOUT) para que un reenvío del mensaje lo reclame de nuevo, o el recuperador lo
        // cierre sin responder. Liberar nunca envía ni reserva: no puede producir un envío duplicado.
        if (reservation === "busy_timeout") await context.persist("release", (audit, runId, held) => audit.releaseTurn?.(runId, "BUSY_TIMEOUT", held) ?? Promise.resolve());
        return "ignored";
      }
    }

    // Comprobación final, lo más cerca posible de la llamada a Kapso: si el contacto se pausó tras la reserva, se libera la reserva y NO se envía. Un evento humano
    // que llegue después de esta comprobación (o durante la llamada) ya no puede cancelar el envío: queda registrado como carrera, no evitado.
    if (guarded) {
      let confirmation: SendConfirmation | "unavailable";
      try {
        confirmation = await deps.audit!.confirmSend(auditRunId!, lease!);
      } catch (error) {
        confirmation = "unavailable";
        deps.log("audit_unavailable", { stage: "confirm", ...writeErrorKind(error) });
      }
      if (confirmation !== "proceed") {
        deps.log("reply_withheld", { reason: confirmation });
        return "ignored";
      }
    }

    let delivered: { providerMessageId?: string } | undefined;
    try {
      const sent = await deps.sendText(ref.from, reply);
      delivered = sent ?? {};
      deps.log("reply_sent", { messageId: ref.messageId, phone: ref.who, result });
      await context.persist("reply", (audit, runId, held) => audit.recordReply(runId, { state: "ACCEPTED", result, processingStatus, providerMessageId: sent?.providerMessageId }, held));
    } catch (error) {
      deps.log("send_failed", { messageId: ref.messageId, phone: ref.who, errorCode: "KAPSO_SEND_UNCERTAIN" });
      // No se reintenta: un error de transporte no demuestra que Kapso no aceptó el mensaje.
      await context.persist("reply", (audit, runId, held) => audit.recordReply(runId, { state: "UNKNOWN", result, processingStatus }, held));
    }
    // Memoria conversacional: SOLO una respuesta que Kapso aceptó (un envío incierto no se guarda) y solo lo conversacional (las cotizaciones y las fotos no). Fuera del try: una falla de la memoria nunca altera el resultado del envío.
    if (delivered && result === "conversation" && contactKey && deps.turns?.memory) {
      await deps.turns.memory.rememberReply({ contactKey, messageId: delivered.providerMessageId ?? `reply:${ref.messageId}`, text: reply });
    }
    return result;
  }

  return {
    claimed: {
      async run(produce) {
        try {
          const produced = await produce(context);
          return produced.kind === "none" ? "ignored" : await deliver(produced);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      },
      async absorb(produce, into, redirectStages) {
        // Si el trabajo dejó un fallo registrado (etapa "failure"), esa marca se conserva tal cual: es la verdad de la auditoría y no bloquea nada (no es un estado pendiente).
        let failed = false;
        const redirected: TurnContext = {
          ...context,
          persist(stage, action) {
            if (stage === "failure") failed = true;
            return redirectStages.has(stage) ? into.persist(stage, action) : context.persist(stage, action);
          }
        };
        let produced: Produced;
        let crashed = false;
        try {
          produced = await produce(redirected);
        } catch {
          // Los productores atrapan sus propios errores; esto es solo una red de seguridad. Nunca se registra el texto del error.
          deps.log("turn_failed", { stage: "batch_absorb", kind: ref.kind });
          produced = { kind: "none" };
          crashed = true;
        }
        try {
          // Todo productor que devuelve «none» ya cerró su corrida (sin respuesta, foto descartada...). Solo si devolvió una respuesta —que se enviará dentro del mensaje del lote, desde OTRA corrida— o
          // si falló a medias, esta corrida se cierra aquí como «sin respuesta propia»: así no queda «en proceso» (las sesiones de cotización esperan a los turnos anteriores en proceso) ni se
          // puede reclamar de nuevo y repetir la foto o el mensaje.
          // Con evidencia del análisis registrada (ANALYZED) la base solo permite terminar la corrida sin enviar con foldTurn; sin él (repositorio sin la migración) se intenta el cierre «sin respuesta».
          if ((produced.kind === "reply" && !failed) || crashed) await context.persist("fold", (audit, runId, held) => (audit.foldTurn ? audit.foldTurn(runId, held) : audit.recordIgnored(runId, "NO_REPLY", held)));
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
        return produced;
      },
      async skip() {
        try {
          await context.persist("close", (audit, runId, held) => audit.recordIgnored(runId, "NO_REPLY", held));
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      }
    }
  };
}

// Atajo para un solo turno: claim + trabajo + envío.
export async function runGuardedTurn(ref: TurnRef, deps: QuoteDeps, produce: TurnProducer): Promise<TurnOutcome> {
  const begun = await beginTurn(ref, deps);
  return "ended" in begun ? begun.ended : begun.claimed.run(produce);
}
