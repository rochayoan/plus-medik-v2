import { AuditWriteError } from "./audit.js";
import { classifyKapsoEvent, eventsOf, type AttentionRepository, type ClassifiedKapsoEvent, type KapsoEventKind } from "./human-control.js";
import { extractIncomingTurns, hasProcessableTurns, processTurns } from "./turns.js";
import { extractIncomingImages, handleImageMessage, isAllowedPhone, maskPhone, verifyWebhookSignature, type QuoteDeps } from "./whatsapp-quote.js";

// POST /api/kapso/webhook (lógica, sin acoplarse a Vercel): verifica la firma, clasifica los eventos de Kapso y
//   · mensajes SALIENTES confirmados desde WhatsApp Business (origin "business_app") -> pausa persistente de la IA para ese contacto;
//   · imágenes ENTRANTES -> motor de recetas en segundo plano (política de ACK sin cambios);
//   · todo lo demás (estados de entrega, mensajes del propio bot, historial importado, eventos de conversación...) -> se ignora sin pausar.
//
// POLÍTICA DE ACK (explicación y consecuencias)
//   · Imágenes: se responde 200 de inmediato y se procesa en segundo plano (waitUntil), igual que antes. Consecuencia: si el claim falla después del 200, Kapso NO
//     reintentará (ya confirmado). Con el control de atención activo el envío exige el claim y una reserva (falla cerrado): el paciente no recibe respuesta automática
//     y puede reenviar la foto; queda registrado "reply_withheld". No se cambió esta política: esperar el claim antes del 200 sería una mejora para otra fase.
//   · Eventos humanos: se registra la pausa ANTES de responder (con plazos cortos, bien por debajo de los 10 s que Kapso concede). Si falla se responde 503 y Kapso
//     reintenta (a los 10 s y 40 s, máximo 3 intentos); el registro es idempotente por event_key. Si se agotan los reintentos, el evento se pierde: riesgo residual.

export interface KapsoWebhookDeps {
  secret: string | undefined;
  allowedPhones: string | undefined;
  quote: QuoteDeps;
  // Piloto original para TURNOS + texto. Los contactos adicionales se autorizan
  // por separado; todos los demás conservan la ruta de imágenes.
  textPilotPhone?: string;
  textPilotExtraPhones?: readonly string[];
  // Configuración anterior para fotografías de contactos fuera del piloto.
  // Mantiene requireAuditGuard sin depender del flag global de turnos.
  legacyQuote?: QuoteDeps;
  // waitUntil de Vercel: mantiene viva la ejecución tras responder.
  schedule(task: Promise<unknown>): void;
  // Ausente = control de atención apagado: los eventos humanos se ignoran (comportamiento anterior).
  humanControl?: {
    // Número de WhatsApp del laboratorio (KAPSO_PHONE_NUMBER_ID): acota las claves de contacto y descarta eventos de otros números.
    labPhoneNumberId: string | undefined;
    contactKeyFor(phone: string): string | undefined;
    attention: AttentionRepository;
  };
  log(event: string, data: Record<string, unknown>): void;
}

const text = (status: number, body: string) => new Response(body, { status });

export async function handleKapsoWebhook(request: Request, deps: KapsoWebhookDeps): Promise<Response> {
  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-webhook-signature"), deps.secret)) return text(401, "unauthorized");
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return text(400, "invalid json");
  }
  if (typeof payload !== "object" || payload === null) return text(400, "invalid json");

  const raws = eventsOf(payload, request.headers.get("x-webhook-batch"));
  const eventName = request.headers.get("x-webhook-event");
  const idempotencyKey = request.headers.get("x-idempotency-key");
  const classified = raws.map((raw) => classifyKapsoEvent(raw, eventName));
  const counts: Partial<Record<KapsoEventKind, number>> = {};
  for (const event of classified) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  deps.log("webhook_events", { counts });

  // Control de atención humana: se registra ANTES de responder (ver política de ACK).
  const control = deps.humanControl;
  let humanFailed = false;
  for (const [index, event] of classified.entries()) {
    if (event.kind === "HUMAN_BUSINESS_APP" || event.kind === "UNKNOWN_ORIGIN" || event.kind === "OTHER_APP_OUTBOUND" || event.kind === "META_AGENT_OUTBOUND") {
      if (!control) {
        if (event.kind === "HUMAN_BUSINESS_APP") deps.log("human_event_ignored", { reason: "control_disabled" });
        continue;
      }
      const raw = raws[index];
      const eventNumber = typeof raw?.phone_number_id === "string" ? raw.phone_number_id : typeof raw?.conversation?.phone_number_id === "string" ? raw.conversation.phone_number_id : undefined;
      if (control.labPhoneNumberId && eventNumber && eventNumber !== control.labPhoneNumberId) {
        deps.log("human_event_ignored", { reason: "other_phone_number" });
        continue;
      }
      if (event.contactPhone && !isAllowedPhone(event.contactPhone, deps.allowedPhones)) {
        deps.log("human_event_ignored", { reason: "phone_not_allowed" });
        continue;
      }
      if (!(await registerControlEvent(event, idempotencyKey, control, deps))) humanFailed = true;
    }
  }
  // Un evento humano que no se pudo registrar se reintenta: se responde 503 y NO se arranca ningún procesamiento de este envío (el reintento lo hará).
  if (humanFailed) return text(503, "retry");

  // Modo turnos (deps.quote.turns, apagado por defecto): imágenes y, si hay manejador, texto u otros mensajes se procesan como turnos del contacto (ver turns.ts).
  // La política de ACK no cambia: 200 de inmediato y el trabajo en segundo plano.
  if (deps.quote.turns) {
    const turns = extractIncomingTurns(payload, request.headers.get("x-webhook-batch"), { eventName: eventName, nowSeconds: Date.now() / 1000 })
      .filter((turn) => isAllowedPhone(turn.from, deps.allowedPhones));
    if (!deps.textPilotPhone) {
      if (!hasProcessableTurns(turns, deps.quote)) return text(200, "ignored");
      deps.schedule(processTurns(turns, deps.quote));
      return text(200, "ok");
    }

    const pilotScope = [deps.textPilotPhone, ...(deps.textPilotExtraPhones ?? [])].join(",");

    // Separar por CONTACTO, no por la lista global ALLOWED_PHONES.
    // En el mismo lote pueden venir imágenes de otros pacientes y texto piloto:
    // cada subconjunto mantiene su ruta. No duplicar imágenes del piloto.
    const pilotTurns = turns.filter((turn) => isAllowedPhone(turn.from, pilotScope));
    const otherImages = extractIncomingImages(payload, request.headers.get("x-webhook-batch"))
      .filter((image) => isAllowedPhone(image.from, deps.allowedPhones) && !isAllowedPhone(image.from, pilotScope));
    const hasPilot = hasProcessableTurns(pilotTurns, deps.quote);
    if (!hasPilot && otherImages.length === 0) return text(200, "ignored");
    if (hasPilot) deps.schedule(processTurns(pilotTurns, deps.quote));
    if (otherImages.length > 0) {
      const legacy = deps.legacyQuote ?? { ...deps.quote, turns: undefined };
      deps.schedule(Promise.all(otherImages.map((image) => handleImageMessage(image, legacy))));
    }
    return text(200, "ok");
  }

  const images = extractIncomingImages(payload, request.headers.get("x-webhook-batch")).filter((image) => isAllowedPhone(image.from, deps.allowedPhones));
  if (images.length === 0) return text(200, "ignored");
  // Se responde 200 de inmediato (así Kapso no reintenta) y el trabajo sigue en segundo plano.
  deps.schedule(Promise.all(images.map((image) => handleImageMessage(image, deps.quote))));
  return text(200, "ok");
}

// true = registrado (o nada que registrar); false = fallo que exige el reintento de Kapso.
async function registerControlEvent(event: ClassifiedKapsoEvent, idempotencyKey: string | null, control: NonNullable<KapsoWebhookDeps["humanControl"]>, deps: KapsoWebhookDeps): Promise<boolean> {
  const contactKey = event.contactPhone ? control.contactKeyFor(event.contactPhone) : undefined;
  const eventKey = event.messageId ? `${event.kind.toLowerCase()}:${event.messageId}` : idempotencyKey ? `${event.kind.toLowerCase()}:idem:${idempotencyKey}` : undefined;
  if (event.kind !== "HUMAN_BUSINESS_APP") {
    // Informativo: no cambia ningún estado, así que un fallo no justifica pedir el reintento.
    if (!eventKey) return true;
    try {
      await control.attention.recordEvent({ eventKey, contactKey, kind: event.kind as "UNKNOWN_ORIGIN" | "OTHER_APP_OUTBOUND" | "META_AGENT_OUTBOUND", occurredAt: event.occurredAt, detail: { origin: (event.origin ?? "missing").replace(/[^a-z0-9_]/g, "_").slice(0, 40) } });
    } catch (error) {
      deps.log("attention_event_not_recorded", { kind: event.kind, ...(error instanceof AuditWriteError ? { error: error.kind } : {}) });
    }
    return true;
  }
  if (!contactKey || !eventKey) {
    // No se puede identificar al contacto (o al evento): reintentar no ayuda. Con el control activo las respuestas automáticas fallan cerradas igualmente.
    deps.log("human_event_unidentified", { reason: contactKey ? "event_without_id" : "contact_unidentified" });
    return true;
  }
  try {
    const result = await control.attention.registerHumanMessage({ eventKey, contactKey, occurredAt: event.occurredAt });
    deps.log("human_event", { outcome: result.outcome, revision: result.revision, blockedRuns: result.blockedRuns, lateReservedRuns: result.lateReservedRuns, repliedAfterEventRuns: result.repliedAfterEventRuns, phone: maskPhone(event.contactPhone) });
    return true;
  } catch (error) {
    deps.log("human_event_failed", error instanceof AuditWriteError ? { error: error.kind } : {});
    return false;
  }
}
