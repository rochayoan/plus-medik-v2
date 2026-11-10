import { processingFailureCode } from "./audit.js";
import type { AudioPipeline } from "./audio/service.js";
import type { AudioFailureCode } from "./audio/types.js";
import type { ClaimedTurn, Produced, TurnProducer } from "./guarded-turn.js";
import type { ItemResult } from "./quote-session.js";
import { needs, SessionUnavailableError, withSession } from "./quote-session-turns.js";
import type { IncomingTurn } from "./turns.js";
import { maskPhone, TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "./whatsapp-quote.js";

// Los audios dentro de los turnos (Fase 5). Un audio es un mensaje del paciente que primero hay que ESCUCHAR:
//   · `resolveAudioTurns` transcribe los audios YA RECLAMADOS de un contacto (un duplicado ya se descartó en el claim, así que nunca se transcribe dos veces) y reemplaza cada uno, EN SU LUGAR, por un texto
//     (la transcripción) o por un aviso de falla. Hasta que todos terminan, el contacto no se atiende: el agente no responde antes de completar los audios necesarios. El orden del lote no cambia.
//   · La transcripción entra al agente como un texto más del paciente (seguridad médica, atención humana, estudios validados contra el catálogo y precios de Supabase como siempre). No se inventa nada:
//     lo que no se pudo escuchar se avisa y se pide reenviar o escribir.
// Nunca se registra el contenido del audio ni de la transcripción: solo códigos.

export const AUDIO_TEXTS = {
  invalid: "No pude abrir tu audio. ¿Puedes enviarlo de nuevo o escribirme los estudios que necesitas?",
  unintelligible: "No logré entender tu audio. ¿Puedes grabarlo de nuevo con menos ruido o escribirme los estudios?",
  unavailable: "En este momento no pude procesar tu audio. ¿Puedes escribirme los estudios o enviarlo de nuevo en unos minutos?",
  too_long: "Tu audio es demasiado largo para procesarlo completo. ¿Puedes enviarlo más corto o escribirme los estudios?",
  too_many: "Recibí muchos audios a la vez y no pude escuchar todos. ¿Puedes escribirme lo que falta?"
} as const;
export type AudioTexts = Record<keyof typeof AUDIO_TEXTS, string>;

// Los avisos no llevan cifras, precios ni promesas (misma regla que los textos de las cotizaciones).
const FORBIDDEN = /\d|\$|\b(bs|bob|usd|gratis|gratuito|descuento|promocion|inmediat[a-z]*|persona|equipo|asesor|llamaremos|escribira)\b/;
export function assertSafeAudioTexts(texts: AudioTexts = AUDIO_TEXTS): void {
  for (const [key, value] of Object.entries(texts)) {
    if (typeof value !== "string" || value.trim() === "" || value.length > 300 || FORBIDDEN.test(value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase())) throw new Error(`unsafe audio text: ${key}`);
  }
}

export function failureTextKey(code: AudioFailureCode): keyof AudioTexts {
  switch (code) {
    case "INVALID_AUDIO":
    case "UNSUPPORTED_FORMAT":
    case "MEDIA_EXPIRED":
    case "MEDIA_UNAVAILABLE": return "invalid";
    case "UNINTELLIGIBLE": return "unintelligible";
    case "TOO_LARGE":
    case "TOO_LONG": return "too_long";
    case "TOO_MANY": return "too_many";
    default: return "unavailable";
  }
}

// Un audio que no se pudo escuchar cuenta en la solicitud como algo ILEGIBLE (igual que una foto ilegible): «listo» no cotiza como si no existiera, pide reenviar.
const UNHEARD: ItemResult = { status: "UNREADABLE", studyIds: [], ambiguous: [], unresolved: 0, reasons: ["UNREADABLE_IMAGE"] };

export function audioFailureProducer(turn: IncomingTurn, deps: QuoteDeps, texts: AudioTexts = AUDIO_TEXTS): TurnProducer {
  return async (ctx): Promise<Produced> => {
    const code = turn.audioFailure ?? "UNAVAILABLE";
    const key = failureTextKey(code);
    deps.log("audio_turn", { outcome: "FAILED", code, phone: maskPhone(turn.from) });
    const sessions = deps.turns?.quoteSessions;
    try {
      if (sessions) {
        await withSession(ctx, "quote_begin", (audit, runId, lease) => needs(audit, "quoteBegin")(runId, lease, { kind: "TEXT", result: UNHEARD, ttlSeconds: sessions.ttlSeconds, maxItems: sessions.maxItems }));
      }
    } catch (error) {
      // Sin poder anotar que hay un audio sin escuchar, no se puede responder como si todo estuviera bien: aviso técnico de siempre.
      const errorCode = processingFailureCode("OTHER");
      deps.log("processing_failed", { messageId: turn.messageId, phone: maskPhone(turn.from), errorCode, ...(error instanceof SessionUnavailableError ? { stage: error.stage } : {}) });
      await ctx.persist("failure", (audit, runId, lease) => audit.recordFailure(runId, errorCode, lease));
      // Un fallo técnico NO se le muestra al paciente si va solo: quien atiende ve el audio en el chat.
      return { kind: "reply", body: TECHNICAL_ISSUE_MESSAGE, result: "technical_issue", processingStatus: "FAILED", stale: "NEWER_TURN", quiet: true };
    }
    // Un audio que no se pudo escuchar, SOLO, no genera mensaje: pedirle al paciente que lo reenvíe o lo escriba gasta un mensaje en vano (muchos audios son de laboratorios aliados o de
    // conversaciones que ya atiende una persona). Si viaja con otro mensaje del paciente en el mismo lote, el aviso se conserva para que sepa que esa parte no se escuchó.
    return { kind: "reply", body: texts[key], result: "no_quote", processingStatus: "COMPLETED", stale: "NONE", quiet: true };
  };
}

// Transcribe los audios reclamados de UN contacto y los sustituye en `turns` (en su lugar).
export async function resolveAudioTurns(args: { indices: readonly number[]; turns: IncomingTurn[]; claims: ReadonlyMap<number, ClaimedTurn>; audio: AudioPipeline; deps: QuoteDeps }): Promise<void> {
  const { audio, turns } = args;
  const mine = args.indices.filter((index) => turns[index]?.kind === "AUDIO" && args.claims.has(index));
  await Promise.all(
    mine.map(async (index, position) => {
      const turn = turns[index]!;
      if (position >= audio.maxPerBatch) {
        turns[index] = { ...turn, kind: "OTHER", audioFailure: "TOO_MANY" };
        return;
      }
      try {
        const resolved = await audio.resolve({ messageId: turn.messageId, from: turn.from, ...(turn.mediaUrl ? { mediaUrl: turn.mediaUrl } : {}), ...(turn.mediaId ? { mediaId: turn.mediaId } : {}) });
        turns[index] = resolved.ok ? { ...turn, kind: "TEXT", text: resolved.text, fromAudio: true } : { ...turn, kind: "OTHER", audioFailure: resolved.code };
        args.deps.log("audio_turn", { outcome: resolved.ok ? "TRANSCRIBED" : "FAILED", ...(resolved.ok ? {} : { code: resolved.code }) });
        // Historial de auditoría: la transcripción se agrega al registro del audio (nunca lanza ni altera el turno).
        if (resolved.ok) await args.deps.history?.recordTranscript({ from: turn.from, messageId: turn.messageId, text: resolved.text, ...(turn.timestamp ? { at: new Date(turn.timestamp * 1000) } : {}) });
      } catch {
        turns[index] = { ...turn, kind: "OTHER", audioFailure: "UNAVAILABLE" };
      }
    })
  );
}
