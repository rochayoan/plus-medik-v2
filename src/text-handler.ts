import type { ConversationModel, ConversationOutcome, ModelCategory } from "./conversation-model.js";
import { decideAttention } from "./attention-filter.js";
import { ANSWER_TEXTS, answerFromKnowledge, detectTopics, type AnswerOptions } from "./knowledge-answers.js";
import { looksAutomated, looksLikeOwnReply, replySignature } from "./reply-guard.js";
import { fold, plain, words } from "./text-normalize.js";
import type { IncomingTurn, TurnHandlerContext, TurnReply } from "./turns.js";

// Manejador de texto MÍNIMO (G2.1). Determinista: no llama a ningún modelo. Clasifica el mensaje con reglas y responde con textos fijos. Lo que NO hace, a propósito:
//   · no responde horarios, políticas, preparación, precios ni nada médico (no hay datos aprobados; llegan en G3/G4);
//   · no promete que una persona responderá salvo que la derivación esté PERSISTIDA de forma garantizada (HandoffSink operativo);
//   · no guarda ni registra el texto del paciente (solo un código de categoría).
// Los textos por defecto son BORRADORES que debe aprobar el laboratorio antes de activarlos (decisión 5 de G0). El constructor rechaza cualquier texto con cifras,
// moneda, plazos u horarios: la configuración no puede introducir un dato inventado.

export type TextCategory = "MEDICAL" | "HUMAN_REQUEST" | "INFO_REQUEST" | "RECIPE_OR_QUOTE" | "GREETING" | "OTHER";
export type HandoffReason = "HUMAN_REQUEST" | "INFO_REQUEST" | "MEDICAL";

const WINDOW = 4000;
// Palabras de precio: un mensaje que las lleva es un pedido de cotización aunque también pregunte por el plazo o la muestra (G4.1).
// «cuánto sería todo», «cuánto me sale», «cuánto es en total» (G6.0: referencias a lo ya anotado).
const HOW_MUCH = "cuanto (me |nos |te )?(sale|salen|saldria|saldrian|es|seria|serian|sera|vale|valen|valdria|cobran|cobrarian|costaria|costarian)";
const PRICE_WORDS = new RegExp(`\\b(precio\\w*|cuesta\\w*|costo\\w*|${HOW_MUCH}|cotiz\\w*|cotic\\w*|presupuesto\\w*|tarifa\\w*|cobran|el total|monto total|total a pagar|en total)\\b`);
// ¿Pide cotizar o pregunta un precio? (G5.9: una lista clara de estudios con este pedido se cotiza sin pedir «listo».)
export const asksForPrice = (text: string): boolean => PRICE_WORDS.test(plain(text.slice(0, WINDOW)));

// Palabras raíz, sin tildes. El orden de las categorías es la prioridad (la más conservadora primero): lo médico gana a todo, pedir a una persona gana a la información,
// y la información gana a cotizar. Ante la duda el mensaje va a la rama que NO inventa una respuesta.
const MEDICAL = /\b(dolor\w*|duele\w*|fiebre\w*|sintoma\w*|mareo\w*|vomit\w*|sangr\w*|medicament\w*|medicina\w*|pastilla\w*|dosis|diagnostic\w*|interpret\w*|enferm\w*|emergencia\w*|urgencia\w*|urgente\w*|embaraz\w*|diabet\w*|hipertens\w*|infeccion\w*|alergi\w*)\b/;
const HUMAN = /\b(persona|personas|humano|humana|asesor\w*|agente|recepcion\w*|operador\w*|ejecutiv\w*|encargad\w*|hablar con|comunicar\w* con|comunicame|llamenme|llamame|llamen me|llamada\w*)\b/;
const INFO = /\b(horario\w*|abren|abre|cierran|atienden|atencion|direccion\w*|ubicaci\w*|ubicad\w*|donde (esta|estan|queda|quedan|los encuentro)|sucursal\w*|pago\w*|pagar|pagamos|tarjeta\w*|qr|transferencia\w*|factura\w*|ayuno\w*|preparaci\w*|prepararme|domicilio\w*|resultado\w*|convenio\w*|seguro\w*|promocion\w*|descuento\w*|feriado\w*|sabado\w*|domingo\w*|requisito\w*)\b/;
const RECIPE = /\b(cotiz\w*|receta\w*|precio\w*|cuanto (cuesta|cuestan|sale|salen|es|vale|valen|cobran)|costo\w*|tarifa\w*|presupuesto\w*|orden medica|estudio\w*|analisis|examen\w*|laboratorio)\b/;
const GREETING_WORDS = new Set(["hola", "holaa", "buenas", "buenos", "buen", "dias", "dia", "tardes", "noches", "hey", "saludos", "que", "tal", "como", "estas", "estan", "estan", "doctor", "doctora", "amigos"]);

// Preguntas de precio y temas clínicos por estudio (preparación, muestra, tiempo de entrega): se resuelven SIEMPRE con Supabase (catálogo / datos aprobados), nunca con el modelo.
const PRICE_QUESTION = new RegExp(`\\b(precio\\w*|cuesta\\w*|costo\\w*|${HOW_MUCH}|tarifa\\w*|cobran)\\b`);
const touchesClinicalTopics = (text: string): boolean => detectTopics(text, true).some((topic) => topic.kind === "PREPARATION" || topic.kind === "TURNAROUND" || topic.kind === "SAMPLE");
// Conversación (saludos, aclaraciones, cómo cotizar): cualquier mensaje que no pregunte por precios ni por lo clínico.
function isPlainTalk(text: string): boolean {
  return !PRICE_QUESTION.test(plain(text.slice(0, WINDOW))) && !touchesClinicalTopics(text);
}
// Pregunta comercial (sucursales, horarios, teléfonos, servicios, pagos, políticas): además, sin pedir cotización.
function isCommercialQuestion(text: string): boolean {
  return !PRICE_WORDS.test(plain(text.slice(0, WINDOW))) && !touchesClinicalTopics(text);
}

export function classifyText(text: string): TextCategory {
  const clipped = plain(text.slice(0, WINDOW));
  if (MEDICAL.test(clipped)) return "MEDICAL";
  if (HUMAN.test(clipped)) return "HUMAN_REQUEST";
  if (INFO.test(clipped)) return "INFO_REQUEST";
  if (RECIPE.test(clipped)) return "RECIPE_OR_QUOTE";
  const tokens = words(clipped);
  if (tokens.length > 0 && tokens.length <= 5 && tokens.every((token) => GREETING_WORDS.has(token))) return "GREETING";
  // Un mensaje más largo que lo que se examina y sin nada reconocible en ese tramo necesita a una persona.
  return text.length > WINDOW ? "HUMAN_REQUEST" : "OTHER";
}

// ───────────────────────────── textos ─────────────────────────────

export interface ConversationTexts {
  greeting: string;
  send_recipe: string;
  fallback: string;
  handoff_confirmed: string;
  handoff_unavailable: string;
  medical_unavailable: string;
  // G5.0: cuando el caso médico YA quedó registrado en el CRM. Conserva el aviso de urgencia: derivar no reemplaza la advertencia.
  medical_handoff_confirmed: string;
}

// BORRADORES pendientes de aprobación del laboratorio. Sin cifras, moneda, plazos ni horarios; solo uno promete a una persona (handoff_confirmed) y solo se usa con
// la derivación persistida.
export const DRAFT_TEXTS: ConversationTexts = {
  greeting: "¡Hola! 👋 Soy la recepcionista virtual de PlusMedik. ¿En qué puedo ayudarte? Puedes escribir tus estudios o enviarme una foto de tu receta para cotizar.",
  send_recipe: "Con gusto te ayudo a cotizar. Puedes escribir los nombres de tus estudios o enviar una foto clara y completa de tu receta.",
  fallback: "Con gusto te oriento. ¿Sobre qué te gustaría saber más? También puedes escribir tus estudios o enviar una foto de tu receta para cotizar.",
  handoff_confirmed: "Recibimos tu solicitud. Una persona del equipo la revisará y te escribirá por este chat.",
  handoff_unavailable: "Recibimos tu mensaje, pero por ahora no puedo derivarlo a una persona desde este chat. Si quieres una cotización, envíame una foto clara y completa de tu receta.",
  medical_unavailable: "Recibimos tu mensaje. No puedo darte orientación médica por este chat. Si es una urgencia, comunícate con los servicios de emergencia de tu localidad.",
  medical_handoff_confirmed: "Recibimos tu mensaje. No puedo darte orientación médica por este chat. Si es una urgencia, comunícate con los servicios de emergencia de tu localidad. Una persona del equipo revisará tu mensaje y te escribirá por este chat."
};

export class UnsafeTextError extends Error {
  constructor(readonly key: string) {
    super(`texto no permitido: ${key}`);
    this.name = "UnsafeTextError";
  }
}

// Un texto fijo no puede afirmar datos que no tenemos aprobados: nada de cifras, moneda, plazos, días ni horarios, ni promesas de gratuidad o descuento.
const FORBIDDEN = /\d|\$|\b(bs|bob|usd|hora|horas|minuto|minutos|dia|dias|semana|semanas|mes|meses|lunes|martes|miercoles|jueves|viernes|sabado|domingo|gratis|gratuito|descuento|promocion|inmediato|hoy|manana)\b/;
function assertSafe(texts: ConversationTexts): void {
  for (const key of Object.keys(DRAFT_TEXTS) as Array<keyof ConversationTexts>) {
    const value = texts[key];
    if (typeof value !== "string" || value.trim() === "" || value.length > 600 || FORBIDDEN.test(fold(value))) throw new UnsafeTextError(key);
  }
}

// ───────────────────────────── derivación a una persona ─────────────────────────────

export interface HandoffRequest {
  // Clave de idempotencia estable por mensaje: reprocesar el mismo mensaje no crea otra solicitud.
  eventId: string;
  kapsoMessageId: string;
  // Solo en memoria hacia el sumidero (el contrato del CRM la necesita); nunca se registra.
  contactPhone: string;
  reason: HandoffReason;
}

// Dónde queda registrada una derivación. SOLO un sumidero `operational` cuyo `record` resuelve cuando la solicitud está guardada de forma durable Y la puede ver una
// persona (hoy: el contrato receptor del CRM, que está apagado) permite confirmar la derivación al paciente. Cualquier excepción significa "no persistido".
export interface HandoffSink {
  operational: boolean;
  // context (G5.0): lo que el productor del turno pone a disposición del sumidero (p. ej. registrar el caso en la cola hacia el CRM con el lease del turno).
  record(request: HandoffRequest, context?: TurnHandlerContext): Promise<"RECORDED" | "DUPLICATE">;
}

export const BLOCKED_HANDOFF: HandoffSink = {
  operational: false,
  record: async () => {
    throw new Error("la derivación a una persona está bloqueada");
  }
};

// ───────────────────────────── manejador ─────────────────────────────

export interface TextHandlerOptions {
  texts?: ConversationTexts;
  handoff?: HandoffSink;
  // Respuestas con conocimiento aprobado del laboratorio (G3.1A). Ausente = el comportamiento de G2.1, sin consultar nada. Solo aplica a información general (INFO_REQUEST) y a
  // mensajes sin clasificar (OTHER); lo médico y pedir a una persona NUNCA se responden con conocimiento.
  knowledge?: AnswerOptions;
  // Protección contra bucles (G3.2; apagada si falta): a un mensaje que parece automático (autorrespuesta de otro negocio, «no responder») o que repite uno de nuestros propios textos
  // NO se le responde (el turno queda cerrado y auditado como sin respuesta), y cada respuesta lleva su firma (un código cerrado) para que la base detecte repeticiones.
  loopProtection?: boolean;
  // Atención selectiva (G6.0; ausente = apagada): un saludo aislado, una cortesía o un agradecimiento hecho solo de un vocabulario cerrado y un mensaje sin letras NO se responden (el turno queda cerrado y
  // auditado como sin respuesta, sin modelo ni consultas). Lo médico, pedir a una persona y cualquier mensaje que pueda contener una solicitud siguen su camino de siempre.
  attention?: boolean;
  // Capa conversacional con un modelo (G5.3; ausente = apagada, el comportamiento determinista de siempre). Solo la consultan los mensajes que NO tienen un camino propio (saludos y mensajes sin
  // clasificar, y opcionalmente pedidos de cotización sin foto): lo médico, pedir a una persona y la información del laboratorio NUNCA llegan al modelo, y si el modelo mismo los reconoce, su texto
  // se descarta y el mensaje sigue por el camino determinista. Cualquier falla del modelo responde con el texto fijo.
  conversation?: ConversationModel;
  log(event: string, data: Record<string, unknown>): void;
}

const HANDOFF_REASON: Partial<Record<TextCategory, HandoffReason>> = { MEDICAL: "MEDICAL", HUMAN_REQUEST: "HUMAN_REQUEST", INFO_REQUEST: "INFO_REQUEST" };

export function createTextHandler(options: TextHandlerOptions): (turn: IncomingTurn, context?: TurnHandlerContext) => Promise<TurnReply | undefined> {
  const texts = options.texts ?? DRAFT_TEXTS;
  assertSafe(texts);
  const handoff = options.handoff ?? BLOCKED_HANDOFF;
  const ownTexts = [...Object.values(texts), ...Object.values(ANSWER_TEXTS)];
  const sign = (reply: TurnReply, category: TextCategory, topics?: readonly string[]): TurnReply => (options.loopProtection ? { ...reply, signature: replySignature(category, topics) } : reply);

  // Consulta al modelo (G5.3/G5.6). Nunca propaga una falla: sin resultado se responde con el texto fijo.
  async function askModel(turn: IncomingTurn, category: ModelCategory, turnContext?: TurnHandlerContext): Promise<ConversationOutcome | undefined> {
    const conversation = options.conversation;
    if (!conversation) return undefined;
    try {
      // G6.0: el único contexto que recibe el modelo es el ESTADO de la conversación (cuántos estudios lleva la solicitud abierta, si hay una duda, si hubo una cotización reciente), calculado por el sistema.
      // Nunca el texto de mensajes anteriores. Si no se puede calcular, el modelo recibe solo el mensaje.
      const context = options.attention ? await turnContext?.memory?.().catch(() => undefined) : undefined;
      return await conversation.reply({ text: turn.text ?? "", category, ...(context ? { context } : {}) });
    } catch {
      // Nunca el texto del error ni del mensaje.
      options.log("llm_conversation", { outcome: "FALLBACK", reason: "ERROR", category });
      return undefined;
    }
  }
  // Una respuesta con datos del laboratorio (BUSINESS_INFO) contesta una pregunta y no se descarta aunque llegue otra después; la conversación sí puede descartarse como cualquier texto fijo.
  const fromModel = (outcome: Extract<ConversationOutcome, { status: "REPLY" }>, category: TextCategory): TurnReply =>
    outcome.intent === "BUSINESS_INFO" ? sign({ body: outcome.body, stale: "NONE" }, category, ["BUSINESS"]) : sign({ body: outcome.body, stale: "NEWER_TURN" }, category);

  // El camino de G2.1 (sin conocimiento): derivación bloqueada o textos fijos. Es también lo que se responde cuando no hay conocimiento disponible.
  async function baseReply(turn: IncomingTurn, category: TextCategory, extra: Record<string, unknown> = {}, context?: TurnHandlerContext, allowModel = true): Promise<TurnReply> {
    const reason = HANDOFF_REASON[category];
    const log = (state: "none" | "blocked" | "recorded" | "failed") => options.log("text_turn", { category, handoff: state, ...extra });

    if (reason) {
      const unavailable = reason === "MEDICAL" ? texts.medical_unavailable : texts.handoff_unavailable;
      if (!handoff.operational) {
        log("blocked");
        return sign({ body: unavailable, stale: "NEWER_TURN" }, category);
      }
      try {
        // Se persiste ANTES de decirle al paciente que se derivó.
        await handoff.record({ eventId: `handoff:${turn.messageId}`, kapsoMessageId: turn.messageId, contactPhone: turn.from, reason }, context);
      } catch {
        // Nunca el texto del error: puede traer el contenido del mensaje.
        log("failed");
        return sign({ body: unavailable, stale: "NEWER_TURN" }, category);
      }
      log("recorded");
      // Confirmar una derivación ya persistida nunca se descarta por obsolescencia.
      return sign({ body: reason === "MEDICAL" ? texts.medical_handoff_confirmed : texts.handoff_confirmed, stale: "NONE" }, category);
    }

    // G5.3: conversación natural SOLO para lo que no tiene camino propio. Si el modelo reconoce que el mensaje pide información, salud o una persona, ese camino se retoma sin el modelo.
    // Un mensaje de precios o clínico (preparación, muestra, tiempos de entrega) nunca se conversa con el modelo, sea cual sea su categoría.
    if (allowModel && options.conversation && (category === "GREETING" || category === "OTHER" || category === "RECIPE_OR_QUOTE") && isPlainTalk(turn.text ?? "")) {
      const outcome = await askModel(turn, category, context);
      if (outcome?.status === "REROUTE") return route(turn, outcome.category, context, false);
      if (outcome?.status === "REPLY") {
        log("none");
        return fromModel(outcome, category);
      }
    }

    log("none");
    const body = category === "GREETING" ? texts.greeting : category === "RECIPE_OR_QUOTE" ? texts.send_recipe : texts.fallback;
    return sign({ body, stale: "NEWER_TURN" }, category);
  }

  // Camino de un mensaje ya clasificado: conocimiento aprobado (si lo hay) y, si no, la respuesta base. `allowModel` es falso al retomar un camino por indicación del modelo (así el modelo
  // se consulta una sola vez por mensaje).
  async function route(turn: IncomingTurn, category: TextCategory, context: TurnHandlerContext | undefined, allowModel: boolean): Promise<TurnReply> {
    const text = turn.text ?? "";
    // G5.6: preguntas COMERCIALES (sucursales, direcciones, horarios, teléfonos, servicios, métodos de pago, políticas) con los datos confirmados del archivo principal, solo si esa bandera está
    // encendida. Precios, estudios, preparación, muestra y tiempos de entrega NUNCA pasan por aquí: siguen por el catálogo / conocimiento aprobado / derivación al CRM. Si el modelo no puede
    // responder con sus datos, o reconoce salud o una persona, el mensaje sigue por el camino de siempre (una sola consulta al modelo).
    if (allowModel && category === "INFO_REQUEST" && options.conversation?.businessInfo && isCommercialQuestion(text)) {
      const outcome = await askModel(turn, "INFO_REQUEST", context);
      if (outcome?.status === "REROUTE") return route(turn, outcome.category, context, false);
      if (outcome?.status === "REPLY") {
        options.log("text_turn", { category, handoff: "none", model: "reply" });
        return fromModel(outcome, category);
      }
    }
    // G4.1: «¿cuánto demora el hemograma?» / «¿qué muestra necesito?» puede venir clasificado como pedido de cotización («estudio», «examen»...). Si pregunta por el plazo, la muestra o los
    // requisitos y NO por el precio, se responde con los datos aprobados del estudio; si menciona el precio, sigue el camino de cotización (que nunca da precios sin completar la solicitud).
    const asksStudyFacts =
      Boolean(options.knowledge?.studyFacts) && category === "RECIPE_OR_QUOTE" && !PRICE_WORDS.test(plain(text.slice(0, WINDOW)))
      && detectTopics(text, true).some((topic) => topic.kind === "TURNAROUND" || topic.kind === "SAMPLE");
    if (options.knowledge && (category === "INFO_REQUEST" || category === "OTHER" || asksStudyFacts)) {
      let answer: Awaited<ReturnType<typeof answerFromKnowledge>>;
      try {
        answer = await answerFromKnowledge(text, context ? { ...options.knowledge, contextStudyIds: () => context.quotedStudyIds() } : options.knowledge);
      } catch {
        // Nunca el texto del error ni del mensaje: se responde como si no hubiera conocimiento.
        options.log("knowledge_failed", { category });
        return baseReply(turn, category, { knowledge: "failed" }, context, allowModel);
      }
      if (!answer) return baseReply(turn, category, { knowledge: "unavailable" }, context, allowModel);
      options.log("text_turn", { category, handoff: "none", knowledge: answer.status.toLowerCase() });
      options.log("knowledge_answer", { topics: answer.topics, status: answer.status, refs: answer.refs.map((ref) => ({ kind: ref.kind, key: ref.key, version: ref.version })), unavailable: answer.unavailable });
      // Una respuesta informativa a una pregunta NO se descarta aunque llegue otra después (si no, el paciente se quedaría sin la respuesta a su primera pregunta). Si sus
      // referencias no se pueden registrar, se responde lo que correspondería sin conocimiento (el productor lo decide).
      return sign(
        {
          body: answer.body,
          stale: "NONE",
          ...(answer.refs.length > 0 ? { knowledge: { refs: answer.refs, fallback: () => baseReply(turn, category, { knowledge: "trace_failed" }, context, allowModel) } } : {})
        },
        category,
        answer.topics
      );
    }

    return baseReply(turn, category, {}, context, allowModel);
  }

  return async (turn, context) => {
    if (typeof turn.text !== "string" || turn.text.trim() === "") return undefined;
    if (options.loopProtection && (looksAutomated(turn.text) || looksLikeOwnReply(turn.text, ownTexts))) {
      // Ni siquiera se clasifica: lo médico o una urgencia dentro de una autorrespuesta no es un paciente pidiendo ayuda. Sin respuesta no hay bucle.
      options.log("text_turn", { category: "AUTOMATED", handoff: "none" });
      return undefined;
    }
    const category = classifyText(turn.text);
    if (options.attention) {
      const decision = decideAttention(turn.text, category);
      if (decision.action === "IGNORE") {
        // Solo códigos: nunca el texto del paciente. Sin respuesta, sin modelo y sin consultas.
        options.log("attention_filter", { action: "IGNORE", reason: decision.reason, category });
        return undefined;
      }
    }
    return route(turn, category, context, true);
  };
}
