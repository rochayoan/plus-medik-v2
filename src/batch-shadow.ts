import type { Notice, ReplyPlan } from "./batch-policy.js";
import type { BatchUnderstanding } from "./batch-understanding.js";
import type { Produced } from "./guarded-turn.js";
import type { QuoteTexts } from "./quote-session.js";

// MODO SOMBRA DEL MOTOR DE LOTES (Fase 3; funciones puras).
//
// Compara lo que decidiría el motor nuevo (el plan) con lo que la ruta de siempre YA respondió para el mismo lote. Las dos decisiones se llevan a una misma clasificación cerrada (`DecisionClass`) y el
// informe son solo códigos y cantidades: nunca textos de pacientes, estudios, precios ni teléfonos. Aquí no hay lecturas, escrituras ni envíos: quien lo conecta decide cuándo calcular el plan.

export type DecisionClass =
  | "QUOTE" // se entregó una cotización
  | "REVIEW" // la solicitud pasó a revisión (o hay que reenviar fotos)
  | "SESSION_REPLY" // lo anotado hasta ahora, con o sin pregunta de aclaración
  | "CANCELLED"
  | "NOTHING_TO_CANCEL"
  | "EMPTY" // «listo» sin nada anotado
  | "DECLINED" // pidió no cotizar (solo el motor nuevo lo distingue)
  | "CONVERSATION" // respuesta del manejador de texto (seguridad, información, saludo, charla)
  | "SILENT" // no se responde
  | "TECHNICAL" // aviso técnico
  | "WAITING"
  | "OTHER";

export type Direction =
  | "SAME"
  // la comparación no es fiable (ver `limits`): no cuenta ni como acuerdo ni como desacuerdo
  | "INCONCLUSIVE"
  // el motor nuevo cotizaría y la ruta de siempre no
  | "SHADOW_QUOTES_MORE"
  // la ruta de siempre cotizó y el motor nuevo no
  | "SHADOW_QUOTES_LESS"
  | "DIFFERENT";

// Qué hizo la ruta de siempre, según lo que quedó listo para enviar. Se reconoce por el resultado, la firma y los textos fijos (con textos personalizados no coincide ninguno y queda como OTHER/CONVERSATION).
export function classifyProduced(produced: Produced, texts: Pick<QuoteTexts, "empty" | "cancelled" | "nothing_to_cancel" | "review" | "review_confirmed" | "resend" | "waiting">): DecisionClass {
  if (produced.kind === "none") return "SILENT";
  if (produced.result === "quoted") return "QUOTE";
  if (produced.result === "technical_issue") return "TECHNICAL";
  const body = produced.body;
  if (body.includes(texts.review) || body.includes(texts.review_confirmed) || body.includes(texts.resend)) return "REVIEW";
  if (body.includes(texts.cancelled)) return "CANCELLED";
  if (body.includes(texts.nothing_to_cancel)) return "NOTHING_TO_CANCEL";
  if (body.includes(texts.empty)) return "EMPTY";
  if (body.includes(texts.waiting)) return "WAITING";
  if (produced.signature?.startsWith("QUOTE_")) return "SESSION_REPLY";
  return produced.result === "conversation" ? "CONVERSATION" : "OTHER";
}

const noticeKinds = (notices: readonly Notice[]) => [...new Set(notices.map((notice) => notice.kind))];

// Qué respondería el motor nuevo, en la misma clasificación. Las respuestas genéricas (saludo, charla, preguntas de información) las decide el manejador de texto de siempre —que puede callar por la atención
// selectiva—, así que el motor nuevo no sabe de antemano si habrá respuesta: acepta CONVERSATION y SILENT. Solo la seguridad (médico, atención humana) garantiza una respuesta.
export function expectedClasses(plan: ReplyPlan): DecisionClass[] {
  const core = plan.core;
  switch (core.kind) {
    case "QUOTE": return ["QUOTE"];
    case "REVIEW": return ["REVIEW"];
    case "CLARIFY":
    case "SUMMARY": return ["SESSION_REPLY"];
    case "CANCELLED": return ["CANCELLED"];
    case "NOTHING_TO_CANCEL": return ["NOTHING_TO_CANCEL"];
    case "DECLINED": return ["DECLINED"];
    case "EMPTY_REQUEST": return ["EMPTY"];
    case "PROMPT": return ["CONVERSATION", "SILENT"];
    case "NONE": {
      if (plan.safety.length > 0) return ["CONVERSATION"];
      if (plan.delegatedQuestionIds.length > 0) return ["CONVERSATION", "SILENT"];
      if (core.reason === "HANDLED_ELSEWHERE" && plan.notices.length > 0) return [plan.notices.some((notice) => notice.kind === "TECHNICAL_ERROR") ? "TECHNICAL" : "OTHER"];
      return ["SILENT"];
    }
  }
}

// La clase principal (la primera aceptable).
export const classifyPlan = (plan: ReplyPlan): DecisionClass => expectedClasses(plan)[0]!;

// Por qué una comparación no es fiable:
//  · MODEL_NEEDED: la ruta de siempre consulta a OpenAI cuando un texto queda sin identificar o no se reconoce, y el modo sombra NUNCA lo hace; si hay modelo configurado, lo que decida cada una puede
//    diferir solo por eso.
//  · LEGACY_WAITING / LEGACY_FAILED: la ruta de siempre no llegó a decidir (esperó a mensajes anteriores o falló): su salida no es una decisión que comparar.
export type ShadowLimit = "MODEL_NEEDED" | "LEGACY_WAITING" | "LEGACY_FAILED";

export interface ShadowComparison {
  // null = no concluyente (ver `limits`); no cuenta como acuerdo ni como desacuerdo.
  agree: boolean | null;
  direction: Direction;
  current: DecisionClass;
  shadow: DecisionClass;
  limits: ShadowLimit[];
}

export function compareClasses(current: DecisionClass, shadow: DecisionClass | readonly DecisionClass[], limits: readonly ShadowLimit[] = []): ShadowComparison {
  const accepted = typeof shadow === "string" ? [shadow] : [...shadow];
  const primary = accepted[0]!;
  const found = accepted.includes(current) ? current : primary;
  if (limits.length > 0) return { agree: null, direction: "INCONCLUSIVE", current, shadow: found, limits: [...limits] };
  if (accepted.includes(current)) return { agree: true, direction: "SAME", current, shadow: current, limits: [] };
  const direction: Direction = primary === "QUOTE" ? "SHADOW_QUOTES_MORE" : current === "QUOTE" ? "SHADOW_QUOTES_LESS" : "DIFFERENT";
  return { agree: false, direction, current, shadow: primary, limits: [] };
}

// Lo único que el modo sombra registra por lote: códigos y cantidades.
export interface ShadowReport extends ShadowComparison {
  core: ReplyPlan["core"]["kind"];
  reasons: ReplyPlan["reasons"];
  intent: BatchUnderstanding["intent"];
  intentSource: BatchUnderstanding["intentSource"];
  confirmedBy: BatchUnderstanding["confirmedBy"] | null;
  sessionOpen: boolean;
  messages: number;
  photos: number;
  studies: number;
  negated: number;
  negationDoubts: BatchUnderstanding["negationDoubts"];
  safety: Array<ReplyPlan["safety"][number]["kind"]>;
  notices: Array<Notice["kind"]>;
}

export function buildShadowReport(args: { plan: ReplyPlan; understanding: BatchUnderstanding; current: Produced; texts: Parameters<typeof classifyProduced>[1]; messages: number; photos: number; modelConfigured: boolean }): ShadowReport {
  const { plan, understanding: u } = args;
  const current = classifyProduced(args.current, args.texts);
  const limits: ShadowLimit[] = [];
  if (args.modelConfigured && u.modelWouldHelp.studies) limits.push("MODEL_NEEDED");
  if (current === "WAITING") limits.push("LEGACY_WAITING");
  if (current === "TECHNICAL") limits.push("LEGACY_FAILED");
  const comparison = compareClasses(current, expectedClasses(plan), limits);
  return {
    ...comparison,
    core: plan.core.kind,
    reasons: plan.reasons,
    intent: u.intent,
    intentSource: u.intentSource,
    confirmedBy: u.confirmedBy ?? null,
    sessionOpen: u.sessionWasOpen,
    messages: args.messages,
    photos: args.photos,
    studies: "studyIds" in plan.core ? plan.core.studyIds.length : u.request.studyIds.length,
    negated: u.negatedFragmentIds.length,
    negationDoubts: u.negationDoubts,
    safety: plan.safety.map((block) => block.kind),
    notices: noticeKinds(plan.notices)
  };
}
