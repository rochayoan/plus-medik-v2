import type { Core, Notice, Question, ReplyPlan } from "./batch-policy.js";
import { normalizeStudyKey } from "./consensus.js";
import { formatInterpretationNote, formatTextReply, QUOTE_TEXTS, type QuoteTexts, type TextDoubt } from "./quote-session.js";
import { DRAFT_TEXTS, type ConversationTexts } from "./text-handler.js";

// COMPOSICIÓN TIPADA DE LA RESPUESTA DE UN LOTE (Fase 2 del rediseño; función pura, aún sin conectar al webhook).
//
// Convierte el PLAN de `batch-policy.ts` en UN solo mensaje, con los textos fijos de siempre. Como el plan trae un solo bloque principal y los avisos aparte, aquí no se adivina qué cadenas sobran:
// el orden es fijo (lo que atienden los manejadores de seguridad e información, los avisos y, al final, el bloque principal) y nada se descarta ni se repite por parecerse a otra cosa.
//
// Nunca recibe ni repite texto del paciente: solo nombres del catálogo (por id), respuestas YA RESUELTAS de los manejadores de siempre y, si se cotizó, el cuerpo de la cotización que armó quien cotizó
// con los precios vigentes de lab_tests. Esta función no calcula ni toca ningún precio.

// Qué hacer con la respuesta si un turno más nuevo del contacto ya respondió (el mismo contrato que usa la máquina de envío; aquí solo se declara, no se importa).
export type StalePolicy = "NONE" | "NEWER_TURN";

// Textos fijos propios de la política de lote. Sin cifras, moneda ni promesas, igual que los demás.
export interface BatchTexts {
  declined: string;
}

export const BATCH_TEXTS: BatchTexts = {
  declined: "Entendido, por ahora no preparo la cotización. Cuando quieras, escribe LISTO o envíame los estudios que falten."
};

export class UnsafeBatchTextError extends Error {
  constructor(readonly key: string) {
    super(`texto de lote no permitido: ${key}`);
    this.name = "UnsafeBatchTextError";
  }
}

const FORBIDDEN = /\d|\$|\b(bs|bob|usd|gratis|gratuito|descuento|promocion|inmediat[a-z]*|persona|equipo|asesor|llamaremos|escribira)\b/;
export function assertSafeBatchTexts(texts: BatchTexts = BATCH_TEXTS): void {
  for (const [key, value] of Object.entries(texts)) if (typeof value !== "string" || value.trim() === "" || value.length > 400 || FORBIDDEN.test(normalizeStudyKey(value))) throw new UnsafeBatchTextError(key);
}

export interface ComposeTexts {
  quote: QuoteTexts;
  // Los tres textos fijos que piden estudios o la receta.
  prompts: Pick<ConversationTexts, "greeting" | "send_recipe" | "fallback">;
  batch: BatchTexts;
  // Aviso técnico (la foto o el procesamiento falló).
  technicalIssue: string;
}

// Lo que un manejador de siempre respondió a lo que se le delegó (seguridad, preguntas de información), ya resuelto: texto final, con el rastro de conocimiento ya registrado.
export interface DelegatedReply {
  body: string;
  stale?: StalePolicy;
}

// Cuando al EJECUTAR el bloque principal la solicitud se resolvió de otra forma que la prevista por el plan (p. ej. al cotizar apareció una duda, o el cierre pasó a revisión), el ejecutor entrega aquí
// el texto de esa salida en lugar del bloque principal.
export interface CoreOverride {
  body: string;
  result: "no_quote" | "conversation" | "quoted";
}

export interface ComposeFacts {
  // Nombres del catálogo para ids de lab_tests (en el orden dado). Nunca texto del paciente.
  namesOf(ids: readonly string[]): string[];
  // Nombres numerables de las opciones de un grupo ambiguo.
  optionsOf(ids: readonly string[]): string[];
  delegated?: readonly DelegatedReply[];
  // Cotización ya armada (precios de lab_tests al momento de cotizar), cuando el bloque principal fue QUOTE.
  quote?: { body: string };
  override?: CoreOverride;
  // Estudios repetidos que se contaron una vez.
  repeated?: number;
  // Cuántos mensajes lleva la solicitud (para la firma de la guarda antibucles).
  position?: number;
  // Nota de lo que el modelo interpretó con otro nombre (formatInterpretationNote), si hay.
  interpretedNote?: string;
  // Líneas fijas que van justo después de lo que atienden los manejadores y antes de los avisos (p. ej. «borré tu solicitud» cuando el mismo lote la cancela y abre otra).
  leading?: readonly string[];
}

export interface ComposedReply {
  body: string;
  result: "quoted" | "no_quote" | "conversation" | "technical_issue";
  processingStatus: "COMPLETED" | "FAILED";
  stale: StalePolicy;
  signature?: string;
}

// Los textos fijos de siempre (sesiones, saludo/pedido de estudios) más los del lote. El aviso técnico lo aporta quien ejecuta (es el mismo de las imágenes).
export function composeTextsFor(technicalIssue: string): ComposeTexts {
  return { quote: QUOTE_TEXTS, prompts: DRAFT_TEXTS, batch: BATCH_TEXTS, technicalIssue };
}

const list = (names: readonly string[]) => names.map((name) => name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).join(", ");

function renderNotice(notice: Notice, texts: ComposeTexts): string {
  switch (notice.kind) {
    case "TECHNICAL_ERROR":
      return texts.technicalIssue;
    case "UNREADABLE_PHOTOS":
      return texts.quote.resend;
    case "DUPLICATE_PHOTOS":
      return texts.quote.duplicate_image;
    case "SESSION_FULL":
      return texts.quote.full;
    case "STUDIES_NOT_IN_CATALOG":
      // Se dice cuáles faltan en el catálogo, con las palabras del paciente ya limpias de enlaces y contactos (las limpió quien entendió el lote).
      return formatInterpretationNote({ notFound: [...notice.mentions], interpreted: [] }) ?? "";
  }
}

function renderQuestions(questions: readonly Question[], names: readonly string[], facts: ComposeFacts, texts: ComposeTexts, note: string | undefined, repeated: number): string {
  const options = questions.find((question): question is Extract<Question, { kind: "OPTIONS" }> => question.kind === "OPTIONS");
  const needsName = questions.some((question) => question.kind === "NAME");
  const doubt: TextDoubt = options ? "OPTIONS" : "UNRESOLVED";
  const body = formatTextReply({ texts: texts.quote, head: options?.invalidChoice ? texts.quote.choose_invalid : texts.quote.added_text, names, options: options ? facts.optionsOf(options.candidateIds) : [], doubt, repeated, ...(note ? { note } : {}) });
  // Con una duda de opciones Y algo sin identificar se preguntan las dos cosas, una vez cada una.
  return options && needsName ? `${body}\n${texts.quote.ask_unresolved}` : body;
}

function renderCore(core: Core, facts: ComposeFacts, texts: ComposeTexts): { body: string | undefined; result: ComposedReply["result"]; signature?: string } {
  const repeated = facts.repeated ?? 0;
  const note = facts.interpretedNote;
  switch (core.kind) {
    case "QUOTE":
      if (!facts.quote) throw new Error("QUOTE sin cotización armada");
      return { body: facts.quote.body, result: "quoted" };
    case "REVIEW":
      return { body: texts.quote.review, result: "no_quote" };
    case "CLARIFY": {
      const names = facts.namesOf(core.studyIds);
      return { body: renderQuestions(core.questions, names, facts, texts, note, repeated), result: "conversation", signature: `QUOTE_ASK:${facts.position ?? names.length}` };
    }
    case "SUMMARY": {
      const names = facts.namesOf(core.studyIds);
      const position = facts.position ?? names.length;
      if (core.askMore) return { body: formatTextReply({ texts: texts.quote, head: texts.quote.added_text, names, options: [], doubt: "NONE", repeated, ...(note ? { note } : {}) }), result: "conversation", signature: `QUOTE_ADDED:${position}` };
      // Algo impide cotizar (una foto ilegible o dudosa): se dice qué quedó anotado y el aviso correspondiente va en los avisos; no se pide confirmar.
      const lines = [texts.quote.added_text, ...(names.length > 0 ? [`${texts.quote.identified_so_far} ${list(names)}.`] : []), ...(repeated > 0 ? [texts.quote.repeated_note] : []), ...(note ? [note] : [])];
      return { body: lines.join("\n"), result: "conversation", signature: `QUOTE_ADDED:${position}` };
    }
    case "DECLINED": {
      const names = facts.namesOf(core.studyIds);
      return { body: [texts.batch.declined, ...(names.length > 0 ? [`${texts.quote.identified_so_far} ${list(names)}.`] : [])].join("\n"), result: "conversation" };
    }
    case "CANCELLED":
      return { body: texts.quote.cancelled, result: "no_quote" };
    case "NOTHING_TO_CANCEL":
      return { body: texts.quote.nothing_to_cancel, result: "no_quote" };
    case "EMPTY_REQUEST":
      return { body: texts.quote.empty, result: "no_quote" };
    case "PROMPT":
      return { body: core.reason === "GREETING" ? texts.prompts.greeting : core.reason === "QUOTE_WITHOUT_STUDIES" ? texts.prompts.send_recipe : texts.prompts.fallback, result: "conversation" };
    case "NONE":
      return { body: undefined, result: "conversation" };
  }
}

// El mensaje final del lote, o undefined si no hay nada que decir (todo se calla). Orden fijo: lo que atienden los manejadores de siempre (urgencias, atención humana, información), los avisos, y el bloque
// principal. Cada pieza sale una sola vez.
export function composeReply(plan: ReplyPlan, facts: ComposeFacts, texts: ComposeTexts): ComposedReply | undefined {
  const parts: string[] = [];
  const delegated = facts.delegated ?? [];
  for (const reply of delegated) if (reply.body.trim() !== "") parts.push(reply.body.trim());
  for (const line of facts.leading ?? []) if (line.trim() !== "") parts.push(line.trim());
  for (const notice of plan.notices) {
    const text = renderNotice(notice, texts);
    if (text.trim() !== "") parts.push(text.trim());
  }
  const rendered = facts.override ? { body: facts.override.body, result: facts.override.result } : renderCore(plan.core, facts, texts);
  if (rendered.body && rendered.body.trim() !== "") parts.push(rendered.body.trim());
  if (parts.length === 0) return undefined;

  const technical = plan.notices.some((notice) => notice.kind === "TECHNICAL_ERROR");
  const onlyTechnical = technical && delegated.length === 0 && !(rendered.body && rendered.body.trim() !== "") && plan.notices.every((notice) => notice.kind === "TECHNICAL_ERROR");
  const result: ComposedReply["result"] = onlyTechnical ? "technical_issue" : rendered.body ? rendered.result : "conversation";
  // Una cotización o una salida «plana» no se descarta por obsoleta; lo conversacional sí, salvo que un manejador (p. ej. una derivación ya registrada) lo pida.
  const stale: StalePolicy = result === "quoted" || result === "no_quote" || delegated.some((reply) => reply.stale === "NONE") ? "NONE" : "NEWER_TURN";
  return { body: parts.join("\n\n"), result, processingStatus: technical ? "FAILED" : "COMPLETED", stale, ...(rendered.body && "signature" in rendered && rendered.signature ? { signature: rendered.signature } : {}) };
}
