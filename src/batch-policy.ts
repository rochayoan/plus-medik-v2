import type { BatchIntent, BatchUnderstanding } from "./batch-understanding.js";
import type { ItemResult, ReviewReason } from "./quote-session.js";

// POLÍTICA DE DECISIÓN DE UN LOTE DE KAPSO (Fase 1 del rediseño; función pura, aún sin conectar al webhook).
//
// Recibe la comprensión global del lote (batch-understanding.ts) y lo que dejaron las fotos del mismo lote, y devuelve un PLAN TIPADO: qué bloques tiene la respuesta, no el texto. Quien lo ejecute
// (fase posterior) anota la sesión, cotiza o pregunta, y redacta cada bloque con los textos de siempre. Como el plan tiene UN solo bloque principal, la respuesta no necesita adivinar qué cadenas
// sobran: nada de acuses intermedios, ni frases genéricas que luego haya que descartar.
//
// Reglas (en orden de prioridad):
//  1. Seguridad: lo médico y pedir a una persona SIEMPRE van en el plan, igual que los errores y avisos. Nada de lo demás puede suprimirlos.
//  2. Cancelar: descarta la solicitud anterior; nunca cotiza. Pedir NO cotizar («no quiero cotizar») se respeta: tampoco cotiza ni insiste.
//  3. Dudas: si queda algo ambiguo, sin identificar, ilegible o incierto, NO se cotiza; se pregunta solo lo necesario («listo» con dudas cierra a revisión, como siempre).
//  4. Intención clara de cotizar (o confirmar) con todo resuelto: COTIZA directamente, sin pedir otra confirmación. Los precios no se deciden aquí: salen del catálogo vigente al ejecutar.
//  5. Estudios sin intención de cotizar: se anotan y se pregunta si falta algo.
//  6. Sin estudios: se pide lo que falta o se calla, según el caso. Lo genérico es una decisión explícita de la política, solo cuando no hay nada más concreto.
// Esta función no lee ni escribe nada y no conoce precios, textos de pacientes ni teléfonos.

export interface PhotoOutcome {
  status: "RESOLVED" | "UNCERTAIN" | "UNREADABLE" | "DUPLICATE" | "FAILED" | "FULL";
  // Ids de lab_tests que el motor de recetas identificó en esa foto (vacío si no hubo).
  studyIds: readonly string[];
}

export interface PolicyInput {
  understanding: BatchUnderstanding;
  // Resultado de las fotos de ESTE lote (ya analizadas y anotadas).
  photos?: readonly PhotoOutcome[];
  // Hubo una cotización entregada hace poco (para tomar «listo, gracias» como acuse y no como un cierre vacío).
  recentQuote?: boolean;
  // La solicitud ya no admite más ítems.
  sessionFull?: boolean;
  // Atención selectiva encendida: un mensaje solo social o ruido no se contesta.
  silenceSocial?: boolean;
}

export type SafetyBlock = { kind: "MEDICAL" | "HUMAN_REQUEST"; fragmentIds: string[]; split: boolean };

export type Notice =
  | { kind: "TECHNICAL_ERROR"; count: number }
  | { kind: "UNREADABLE_PHOTOS"; count: number }
  | { kind: "DUPLICATE_PHOTOS"; count: number }
  | { kind: "SESSION_FULL" }
  | { kind: "STUDIES_NOT_IN_CATALOG"; mentions: string[] };

export type Question =
  // Cuál de varios estudios del catálogo (ids de lab_tests); solo el primer grupo sin aclarar, y cuántos más quedan.
  | { kind: "OPTIONS"; candidateIds: string[]; remainingGroups: number; invalidChoice: boolean }
  // El nombre exacto de algo que parece un estudio y no se pudo identificar.
  | { kind: "NAME"; mentions: string[] };

export type Core =
  // Cotizar ya: el ejecutor anota, cierra la sesión y calcula los precios con el catálogo vigente. `closeBy`: intención clara, «sí» o «listo».
  | { kind: "QUOTE"; studyIds: string[]; closeBy: "INTENT" | "YES" | "FINALIZE" }
  // «Listo» con dudas que el paciente no aclaró: se cierra como solicitud en revisión (nunca se cotiza a medias).
  | { kind: "REVIEW"; studyIds: string[]; reasons: ReviewReason[] }
  | { kind: "CLARIFY"; studyIds: string[]; questions: Question[] }
  // Lo anotado hasta ahora y si falta algo.
  | { kind: "SUMMARY"; studyIds: string[]; askMore: boolean }
  | { kind: "CANCELLED" }
  // Pidió NO cotizar («no quiero cotizar»): no se cotiza ni se insiste; lo anotado se conserva.
  | { kind: "DECLINED"; studyIds: string[] }
  | { kind: "NOTHING_TO_CANCEL" }
  // «Listo» sin nada anotado.
  | { kind: "EMPTY_REQUEST" }
  // Pedir estudios o la receta: la única respuesta genérica, y solo cuando no hay nada más concreto.
  | { kind: "PROMPT"; reason: "QUOTE_WITHOUT_STUDIES" | "GREETING" | "OTHER" }
  | { kind: "NONE"; reason: "ACK_AFTER_QUOTE" | "SOCIAL" | "HANDLED_ELSEWHERE" | "NOTHING_TO_SAY" };

export type PlanReason =
  | "SAFETY_PRESENT" | "CANCEL" | "DECLINED" | "BLOCKED_AMBIGUOUS" | "BLOCKED_UNCLEAR" | "BLOCKED_UNREADABLE" | "BLOCKED_UNCERTAIN" | "BLOCKED_INVALID_CHOICE"
  | "QUOTE_BY_INTENT" | "QUOTE_BY_CONFIRMATION" | "FINALIZED_WITH_DOUBTS" | "STUDIES_WITHOUT_INTENT" | "CONFIRM_SUPERSEDED" | "NO_STUDIES" | "NEGATION_UNCLEAR";

export interface ReplyPlan {
  // Bloques que nunca se suprimen. Los textos y la derivación los resuelve el manejador de siempre.
  safety: SafetyBlock[];
  // Preguntas de información y conversación que sigue el camino de siempre (conocimiento aprobado, derivación).
  delegatedQuestionIds: string[];
  notices: Notice[];
  core: Core;
  // Descartar primero la solicitud abierta (el lote trae una cancelación).
  cancelPrevious: boolean;
  // Lo que se anota en la sesión por el texto de este lote (un solo ítem), o undefined si no trae estudios.
  record: ItemResult | undefined;
  // Códigos cerrados para el registro (nunca texto).
  reasons: PlanReason[];
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function decideBatch(input: PolicyInput): ReplyPlan {
  const { understanding: u } = input;
  const photos = input.photos ?? [];
  const reasons: PlanReason[] = [];

  // 1. Seguridad y avisos: se calculan primero y no dependen de nada de lo demás.
  const safety: SafetyBlock[] = [];
  if (u.safety.medical.length > 0 || u.safety.medicalSplit) safety.push({ kind: "MEDICAL", fragmentIds: u.safety.medical.length > 0 ? [...u.safety.medical] : [...u.safety.splitFragmentIds], split: u.safety.medical.length === 0 });
  if (u.safety.humanRequest.length > 0 || u.safety.humanRequestSplit) safety.push({ kind: "HUMAN_REQUEST", fragmentIds: u.safety.humanRequest.length > 0 ? [...u.safety.humanRequest] : [...u.safety.splitFragmentIds], split: u.safety.humanRequest.length === 0 });
  if (safety.length > 0) reasons.push("SAFETY_PRESENT");

  const count = (status: PhotoOutcome["status"]) => photos.filter((photo) => photo.status === status).length;
  const failed = count("FAILED");
  const unreadablePhotos = count("UNREADABLE");
  const duplicates = count("DUPLICATE");
  const notices: Notice[] = [];
  if (failed > 0) notices.push({ kind: "TECHNICAL_ERROR", count: failed });
  if (unreadablePhotos > 0) notices.push({ kind: "UNREADABLE_PHOTOS", count: unreadablePhotos });
  if (duplicates > 0) notices.push({ kind: "DUPLICATE_PHOTOS", count: duplicates });
  if (input.sessionFull === true || count("FULL") > 0) notices.push({ kind: "SESSION_FULL" });
  if (u.studies.notFound.length > 0) notices.push({ kind: "STUDIES_NOT_IN_CATALOG", mentions: [...u.studies.notFound] });

  // 2. La solicitud completa: texto del lote + sesión + fotos.
  const photoStudyIds = photos.filter((photo) => photo.status === "RESOLVED" || photo.status === "UNCERTAIN").flatMap((photo) => photo.studyIds);
  const studyIds = unique([...u.request.studyIds, ...photoStudyIds]);
  const hasStudies = studyIds.length > 0;
  const pending = u.request.pendingGroups;
  const unresolved = u.request.unresolved;
  const invalidChoices = u.studies.invalidChoices;
  // Una foto que falló cuenta como ilegible: queda en la solicitud como algo que hay que reenviar.
  const unreadable = u.request.unreadable + unreadablePhotos + failed;
  const uncertain = u.request.uncertain || count("UNCERTAIN") > 0;
  // Una opción inválida solo importa si hay una duda pendiente: viaja dentro de la pregunta de opciones y no es un bloqueo por sí sola.
  const needsAnswer = pending.length > 0 || unresolved > 0;
  const hasBlocker = needsAnswer || unreadable > 0 || uncertain;
  if (pending.length > 0) reasons.push("BLOCKED_AMBIGUOUS");
  if (unresolved > 0) reasons.push("BLOCKED_UNCLEAR");
  if (invalidChoices > 0 && pending.length > 0) reasons.push("BLOCKED_INVALID_CHOICE");
  if (unreadable > 0) reasons.push("BLOCKED_UNREADABLE");
  if (uncertain) reasons.push("BLOCKED_UNCERTAIN");
  if (u.confirmSuperseded) reasons.push("CONFIRM_SUPERSEDED");

  const intent: BatchIntent = u.intent;
  const questions: Question[] = [];
  const firstPending = pending[0];
  if (firstPending) questions.push({ kind: "OPTIONS", candidateIds: [...firstPending], remainingGroups: pending.length - 1, invalidChoice: invalidChoices > 0 });
  if (unresolved > 0) questions.push({ kind: "NAME", mentions: [...u.studies.unclear] });

  const hasConcreteElsewhere = safety.length > 0 || u.delegated.questions.length > 0 || notices.length > 0;
  const core = ((): Core => {
    // 3. Cancelar: nunca cotiza.
    if (intent === "CANCEL") {
      reasons.push("CANCEL");
      return u.sessionWasOpen || hasStudies ? { kind: "CANCELLED" } : { kind: "NOTHING_TO_CANCEL" };
    }
    // Pidió no cotizar: se respeta y no se pregunta nada más (las dudas por aclarar ya no importan porque no se va a cotizar).
    if (intent === "DECLINE") {
      reasons.push("DECLINED");
      return { kind: "DECLINED", studyIds };
    }
    // 4. Dudas: no se cotiza a medias.
    if (hasBlocker && hasStudies) {
      // Lo ilegible se arregla reenviando la foto, no con una pregunta; «listo» no lo convierte en revisión (primero hay que reenviar).
      if (unreadable === 0 && u.confirmedBy === "FINALIZE") {
        reasons.push("FINALIZED_WITH_DOUBTS");
        const why: ReviewReason[] = [];
        if (pending.length > 0) why.push("AMBIGUOUS_STUDY");
        if (unresolved > 0) why.push("UNRESOLVED_TEXT");
        if (uncertain) why.push("ENGINE_PARTIAL");
        return { kind: "REVIEW", studyIds, reasons: why };
      }
      if (questions.length > 0) return { kind: "CLARIFY", studyIds, questions };
      return { kind: "SUMMARY", studyIds, askMore: false };
    }
    if (hasBlocker) {
      // Sin ningún estudio anotado y con algo por aclarar (p. ej. solo un nombre sin identificar).
      if (questions.length > 0) return { kind: "CLARIFY", studyIds, questions };
      return hasConcreteElsewhere ? { kind: "NONE", reason: "HANDLED_ELSEWHERE" } : { kind: "PROMPT", reason: "OTHER" };
    }
    // 5. Todo resuelto.
    if (hasStudies) {
      // Una negación cuyo alcance no está claro («no quiero» y el objeto en otro mensaje, «no, mejor...» tras una petición, negar algo ya anotado): jamás se cotiza por INFERENCIA. Solo un «listo» explícito
      // cierra; en cualquier otro caso se resume lo anotado y se pregunta.
      const negationUnclear = u.negationDoubts.length > 0;
      if (intent === "QUOTE") {
        if (negationUnclear) {
          reasons.push("NEGATION_UNCLEAR");
          return { kind: "SUMMARY", studyIds, askMore: true };
        }
        reasons.push("QUOTE_BY_INTENT");
        return { kind: "QUOTE", studyIds, closeBy: "INTENT" };
      }
      if (intent === "CONFIRM") {
        if (negationUnclear && u.confirmedBy !== "FINALIZE") {
          reasons.push("NEGATION_UNCLEAR");
          return { kind: "SUMMARY", studyIds, askMore: true };
        }
        reasons.push("QUOTE_BY_CONFIRMATION");
        return { kind: "QUOTE", studyIds, closeBy: u.confirmedBy ?? "YES" };
      }
      reasons.push("STUDIES_WITHOUT_INTENT");
      return { kind: "SUMMARY", studyIds, askMore: true };
    }
    // 6. Sin estudios.
    reasons.push("NO_STUDIES");
    if (intent === "CONFIRM") return input.recentQuote === true ? { kind: "NONE", reason: "ACK_AFTER_QUOTE" } : { kind: "EMPTY_REQUEST" };
    if (intent === "QUOTE") return { kind: "PROMPT", reason: "QUOTE_WITHOUT_STUDIES" };
    if (hasConcreteElsewhere) return { kind: "NONE", reason: "HANDLED_ELSEWHERE" };
    if (u.delegated.greetings.length > 0 && u.delegated.talk.length === 0) return { kind: "PROMPT", reason: "GREETING" };
    if (u.delegated.talk.length > 0) return { kind: "PROMPT", reason: "OTHER" };
    if (u.delegated.social.length > 0) return input.silenceSocial === true ? { kind: "NONE", reason: "SOCIAL" } : { kind: "PROMPT", reason: "OTHER" };
    return { kind: "NONE", reason: "NOTHING_TO_SAY" };
  })();

  if (u.negationDoubts.length > 0 && hasStudies) reasons.push("NEGATION_UNCLEAR");

  return {
    safety,
    delegatedQuestionIds: [...u.delegated.questions],
    notices,
    core,
    cancelPrevious: u.cancelled && u.sessionWasOpen,
    record: u.item,
    reasons: unique(reasons)
  };
}
