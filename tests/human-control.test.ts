import { createHash, createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditWriteError, type AuditLease, type AuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { classifyKapsoEvent, contactKeyOf, createAttentionRepository, eventsOf, type AttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { handleImageMessage, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";

// Clasificación de eventos de Kapso, clave estable del contacto, webhook (firma, ACK, reintentos) y reglas de envío con atención humana. Sin red ni base de datos;
// el comportamiento transaccional real se prueba en tests/human-control-db.test.ts y de extremo a extremo en tests/human-control-e2e.test.ts.

const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const PHONE = "59170000000";
const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };

// ── formato de eventos tal como lo documenta Kapso (v2)
const message = (kapso: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  message: { id: "wamid.evt-1", timestamp: "1761000000", type: "text", ...extra, kapso: { has_media: false, ...kapso } },
  conversation: { id: "conv_1", phone_number: PHONE, phone_number_id: LAB, contact_name: "NOMBRE_SENTINELA" },
  phone_number_id: LAB
});
const inboundText = () => message({ direction: "inbound", status: "received", origin: "cloud_api" }, { from: PHONE, text: { body: "TEXTO_CLINICO_SENTINELA" } });
const inboundImage = (id = "wamid.img-1") => message({ direction: "inbound", status: "received", origin: "cloud_api", media_url: "https://example.test/img.jpg" }, { id, type: "image", from: PHONE, image: { id: "media-1" } });
const outbound = (origin: string | undefined, status = "sent", id = "wamid.out-1") =>
  message({ direction: "outbound", status, ...(origin ? { origin } : {}), statuses: [{ id, status, timestamp: "1761000005", recipient_id: PHONE }] }, { id, to: PHONE, text: { body: "TEXTO_CLINICO_SENTINELA" } });

describe("clasificación de eventos de Kapso", () => {
  it.each([
    ["mensaje entrante del paciente", inboundText(), "whatsapp.message.received", "PATIENT_MESSAGE"],
    ["imagen entrante (aunque su origin sea cloud_api: manda la dirección)", inboundImage(), "whatsapp.message.received", "PATIENT_MESSAGE"],
    ["saliente enviado por la API de Kapso = el propio bot", outbound("cloud_api"), "whatsapp.message.sent", "BOT_OUTBOUND"],
    ["saliente desde WhatsApp Business = intervención humana", outbound("business_app"), "whatsapp.message.sent", "HUMAN_BUSINESS_APP"],
    ["historial importado (nunca es una intervención nueva)", outbound("history_sync"), "whatsapp.message.sent", "HISTORY_SYNC"],
    ["saliente de otra app en un número compartido", outbound("other_app"), "whatsapp.message.sent", "OTHER_APP_OUTBOUND"],
    ["saliente del agente de Meta", outbound("meta_business_agent"), "whatsapp.message.sent", "META_AGENT_OUTBOUND"],
    ["saliente sin origen: desconocido, no humano", outbound(undefined), "whatsapp.message.sent", "UNKNOWN_ORIGIN"],
    ["saliente con un origen no reconocido: desconocido, no humano", outbound("algo_nuevo"), "whatsapp.message.sent", "UNKNOWN_ORIGIN"],
    ["entregado de un mensaje de business_app: estado, no intervención", outbound("business_app", "delivered"), "whatsapp.message.delivered", "STATUS_UPDATE"],
    ["leído de un mensaje de business_app", outbound("business_app", "read"), "whatsapp.message.read", "STATUS_UPDATE"],
    ["fallido de un mensaje de business_app", outbound("business_app", "failed"), "whatsapp.message.failed", "STATUS_UPDATE"],
    ["estado de entrega sin encabezado de evento (se deduce de message.kapso.status)", outbound("business_app", "delivered"), null, "STATUS_UPDATE"],
    ["evento de conversación", { conversation: { id: "conv_1" } }, "whatsapp.conversation.ended", "NON_MESSAGE"],
    ["evento de thread de un número compartido", outbound("other_app"), "whatsapp.thread.standby", "NON_MESSAGE"],
    ["evento sin mensaje", { conversation: { id: "conv_1" } }, null, "UNKNOWN_EVENT"],
    ["mensaje sin dirección y sin encabezado: no se asume nada", message({ origin: "business_app", status: "sent" }, { to: PHONE }), null, "UNKNOWN_EVENT"],
    ["mayúsculas en origin y dirección", message({ direction: "OUTBOUND", status: "SENT", origin: "Business_App" }, { to: PHONE }), "whatsapp.message.sent", "HUMAN_BUSINESS_APP"]
  ])("%s", (_name, event, header, expected) => {
    expect(classifyKapsoEvent(event as Record<string, any>, header).kind).toBe(expected);
  });

  it("extrae el id, el contacto y el instante: el teléfono del contacto sale de la conversación o, si falta, del destinatario/remitente", () => {
    const human = classifyKapsoEvent(outbound("business_app"), "whatsapp.message.sent");
    expect(human).toMatchObject({ kind: "HUMAN_BUSINESS_APP", messageId: "wamid.out-1", contactPhone: PHONE, occurredAt: "2025-10-20T22:40:00.000Z", origin: "business_app" });
    const withoutConversation = { message: { ...outbound("business_app").message, to: "+591 7000-0000" } };
    expect(classifyKapsoEvent(withoutConversation, "whatsapp.message.sent").contactPhone).toBe("59170000000");
    const inbound = { message: { ...inboundText().message, from: "59171111111" } };
    expect(classifyKapsoEvent(inbound, "whatsapp.message.received").contactPhone).toBe("59171111111");
  });

  it("sin teléfono o sin instante válido quedan sin definir (no se inventan)", () => {
    const bare = { message: { id: "wamid.x", timestamp: "no-es-un-numero", kapso: { direction: "outbound", status: "sent", origin: "business_app" } } };
    expect(classifyKapsoEvent(bare, "whatsapp.message.sent")).toMatchObject({ kind: "HUMAN_BUSINESS_APP", contactPhone: undefined, occurredAt: undefined });
  });

  it("un lote (type/batch/data) se descompone evento por evento y un evento suelto se devuelve tal cual", () => {
    const a = inboundImage("wamid.a");
    const b = outbound("business_app", "sent", "wamid.b");
    expect(eventsOf({ type: "whatsapp.message.received", batch: true, data: [a, b] })).toEqual([a, b]);
    expect(eventsOf({ data: [a] }, "true")).toEqual([a]);
    expect(eventsOf(a)).toEqual([a]);
  });
});

describe("clave estable del contacto (HMAC dedicado)", () => {
  const key = (overrides: Partial<Parameters<typeof contactKeyOf>[0]> = {}) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: PHONE, ...overrides });

  it("es un HMAC-SHA256 de 64 hex, determinista y sin rastro del número", () => {
    const value = key()!;
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(key()).toBe(value);
    expect(value).not.toContain(PHONE);
    expect(value).toBe(createHmac("sha256", HMAC_KEY).update(`plusmedik-contact-v1|${LAB}|${PHONE}`).digest("hex"));
  });

  it("es estable al formato del número y cambia con el contacto, con el número del laboratorio y con la clave", () => {
    expect(key({ contactPhone: "+591 7000-0000" })).toBe(key());
    expect(key({ contactPhone: "59171111111" })).not.toBe(key());
    expect(key({ labPhoneNumberId: "999" })).not.toBe(key());
    expect(key({ hmacKey: `${HMAC_KEY}-otra` })).not.toBe(key());
  });

  it("sin clave dedicada válida, sin número del laboratorio o sin teléfono, el contacto no se puede identificar", () => {
    expect(key({ hmacKey: undefined })).toBeUndefined();
    expect(key({ hmacKey: "corta" })).toBeUndefined();
    expect(key({ labPhoneNumberId: undefined })).toBeUndefined();
    expect(key({ labPhoneNumberId: "  " })).toBeUndefined();
    expect(key({ contactPhone: undefined })).toBeUndefined();
    expect(key({ contactPhone: "sin dígitos" })).toBeUndefined();
  });
});

describe("repositorio del estado de atención (cliente de las funciones de la base)", () => {
  const server = (replies: Record<string, { status: number; body?: unknown } | "network">) => {
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const name = String(input).split("/rest/v1/rpc/")[1]!;
      calls.push({ name, args: JSON.parse(String(init?.body)) });
      const reply = replies[name] ?? { status: 200, body: {} };
      if (reply === "network") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(reply.body ?? "SECRETO_DEL_SERVIDOR"), { status: reply.status });
    }) as typeof fetch;
    return { repository: createAttentionRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn, retryDelayMs: 0 }), calls };
  };
  const contactKey = "a".repeat(64);

  it("registra el mensaje humano con el motivo HUMAN_WHATSAPP_BUSINESS_APP y traduce el resultado", async () => {
    const { repository, calls } = server({ plusmedik_attention_register_human_message: { status: 200, body: { outcome: "PAUSED", revision: 2, blocked_runs: 1, late_reserved_runs: 0, replied_after_event_runs: 0 } } });
    expect(await repository.registerHumanMessage({ eventKey: "k1", contactKey, occurredAt: "2025-10-20T22:40:00.000Z" })).toEqual({ outcome: "PAUSED", revision: 2, blockedRuns: 1, lateReservedRuns: 0, repliedAfterEventRuns: 0 });
    expect(calls[0]!.args).toEqual({ p_event_key: "k1", p_contact_key: contactKey, p_occurred_at: "2025-10-20T22:40:00.000Z", p_reason: "HUMAN_WHATSAPP_BUSINESS_APP", p_source: "kapso_business_app" });
    for (const [outcome, expected] of [["ALREADY_PAUSED", "ALREADY_PAUSED"], ["STALE_IGNORED", "STALE_IGNORED"], ["duplicate", "DUPLICATE"]] as const) {
      const other = server({ plusmedik_attention_register_human_message: { status: 200, body: { outcome } } });
      expect((await other.repository.registerHumanMessage({ eventKey: "k", contactKey })).outcome).toBe(expected);
    }
  });

  it("una respuesta inesperada nunca se interpreta como 'pausado': falla para que se pida el reintento", async () => {
    const odd = server({ plusmedik_attention_register_human_message: { status: 200, body: { outcome: "algo" } } });
    await expect(odd.repository.registerHumanMessage({ eventKey: "k", contactKey })).rejects.toBeInstanceOf(AuditWriteError);
    const empty = server({ plusmedik_attention_register_human_message: { status: 200, body: {} } });
    await expect(empty.repository.registerHumanMessage({ eventKey: "k", contactKey })).rejects.toBeInstanceOf(AuditWriteError);
    const down = server({ plusmedik_attention_register_human_message: "network" });
    await expect(down.repository.registerHumanMessage({ eventKey: "k", contactKey })).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });
  });

  it("consulta el estado, registra eventos informativos y reactiva", async () => {
    const { repository } = server({
      plusmedik_attention_status: { status: 200, body: { exists: true, state: "HUMAN_PAUSED", revision: 3 } },
      plusmedik_attention_record_event: { status: 200, body: { outcome: "RECORDED" } },
      plusmedik_attention_resume: { status: 200, body: { outcome: "resumed", revision: 4 } }
    });
    expect(await repository.status(contactKey)).toEqual({ state: "HUMAN_PAUSED", revision: 3, exists: true });
    expect(await repository.recordEvent({ eventKey: "k", kind: "UNKNOWN_ORIGIN" })).toBe("RECORDED");
    expect(await repository.resume(contactKey, "MANUAL", "ops")).toBe("RESUMED");
    expect(await server({ plusmedik_attention_status: { status: 200, body: {} } }).repository.status(contactKey)).toEqual({ state: "ACTIVE", revision: 0, exists: false });
  });
});

// ───────────────────────────── webhook ─────────────────────────────

const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body, "utf8").digest("hex");
const post = (payload: unknown, headers: Record<string, string> = {}, secret: string | null = SECRET) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", ...(secret ? { "x-webhook-signature": sign(body, secret) } : {}), ...headers } });
};

function attentionSpy(overrides: Partial<AttentionRepository> = {}): AttentionRepository {
  return {
    status: vi.fn(async () => ({ state: "ACTIVE" as const, revision: 0, exists: false })),
    registerHumanMessage: vi.fn(async () => ({ outcome: "PAUSED" as const, revision: 2, blockedRuns: 0, lateReservedRuns: 0, repliedAfterEventRuns: 0 })),
    recordEvent: vi.fn(async () => "RECORDED" as const),
    resume: vi.fn(async () => "RESUMED" as const),
    ...overrides
  };
}
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

function webhook(options: { control?: boolean; attention?: AttentionRepository; allowedPhones?: string; secret?: string | undefined; hmacKey?: string | undefined; quote?: Partial<QuoteDeps> } = {}) {
  const scheduled: Promise<unknown>[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const attention = options.attention ?? attentionSpy();
  const sendText = vi.fn(async () => ({ providerMessageId: "wamid.sent" }));
  const quote: QuoteDeps = { downloadImage: vi.fn(async () => ({ bytes: jpeg })), loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => okAnalysis()), sendText, log: () => undefined, ...options.quote };
  const deps: KapsoWebhookDeps = {
    secret: "secret" in options ? options.secret : SECRET,
    allowedPhones: options.allowedPhones,
    quote,
    schedule: (task) => { scheduled.push(task); },
    humanControl: options.control === false ? undefined : { labPhoneNumberId: LAB, contactKeyFor: (phone) => contactKeyOf({ hmacKey: "hmacKey" in options ? options.hmacKey : HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone }), attention },
    log: (event, data) => logs.push([event, data])
  };
  return { deps, attention, scheduled, logs, sendText, quote, call: (request: Request) => handleKapsoWebhook(request, deps) };
}
const logged = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
const HUMAN_HEADERS = { "x-webhook-event": "whatsapp.message.sent", "x-idempotency-key": "idem-1" };

describe("webhook: autenticación (sin firma válida no cambia ningún estado)", () => {
  it.each([
    ["sin firma", null, SECRET],
    ["firma de otro secreto", SECRET + "x", SECRET],
    ["secreto del servidor sin configurar", SECRET, undefined]
  ])("%s -> 401, sin tocar la base ni arrancar procesamientos", async (_name, signWith, serverSecret) => {
    const w = webhook({ secret: serverSecret });
    const response = await w.call(post(outbound("business_app"), HUMAN_HEADERS, signWith));
    expect(response.status).toBe(401);
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(w.attention.recordEvent).not.toHaveBeenCalled();
    expect(w.scheduled).toHaveLength(0);
    expect(w.logs).toEqual([]);
  });

  it("una firma mal formada o alterada (cuerpo modificado) también se rechaza; JSON inválido con firma válida es 400", async () => {
    const w = webhook();
    const tampered = new Request("https://example.test/x", { method: "POST", body: JSON.stringify(outbound("business_app")), headers: { "x-webhook-signature": sign('{"otro":1}') } });
    expect((await w.call(tampered)).status).toBe(401);
    const malformed = new Request("https://example.test/x", { method: "POST", body: "{}", headers: { "x-webhook-signature": "no-es-hex" } });
    expect((await w.call(malformed)).status).toBe(401);
    expect((await w.call(post("{no es json"))).status).toBe(400);
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
  });
});

describe("webhook: qué pausa y qué no", () => {
  it("un saliente confirmado desde WhatsApp Business pausa a ESE contacto, con el id del mensaje y su instante, y responde 200", async () => {
    const w = webhook();
    const response = await w.call(post(outbound("business_app"), HUMAN_HEADERS));
    expect(response.status).toBe(200);
    expect(w.attention.registerHumanMessage).toHaveBeenCalledTimes(1);
    expect(w.attention.registerHumanMessage).toHaveBeenCalledWith({ eventKey: "human_business_app:wamid.out-1", contactKey: contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: PHONE }), occurredAt: "2025-10-20T22:40:00.000Z" });
    expect(w.scheduled).toHaveLength(0);
  });

  it("los mensajes del propio bot (cloud_api) NO pausan", async () => {
    const w = webhook();
    expect((await w.call(post(outbound("cloud_api"), HUMAN_HEADERS))).status).toBe(200);
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(w.attention.recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["delivered", "whatsapp.message.delivered"],
    ["read", "whatsapp.message.read"],
    ["failed", "whatsapp.message.failed"]
  ])("el estado %s de un mensaje de business_app NO es una intervención", async (status, event) => {
    const w = webhook();
    expect((await w.call(post(outbound("business_app", status), { "x-webhook-event": event }))).status).toBe(200);
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(logged(w.logs, "webhook_events")).toEqual([{ counts: { STATUS_UPDATE: 1 } }]);
  });

  it("el historial importado y los mensajes del paciente NO pausan; los de otra app o del agente de Meta solo se registran", async () => {
    const w = webhook();
    await w.call(post(outbound("history_sync"), HUMAN_HEADERS));
    await w.call(post(inboundText(), { "x-webhook-event": "whatsapp.message.received" }));
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(w.attention.recordEvent).not.toHaveBeenCalled();
    await w.call(post(outbound("other_app", "sent", "wamid.o"), HUMAN_HEADERS));
    await w.call(post(outbound("meta_business_agent", "sent", "wamid.m"), HUMAN_HEADERS));
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(vi.mocked(w.attention.recordEvent).mock.calls.map(([event]) => event.kind)).toEqual(["OTHER_APP_OUTBOUND", "META_AGENT_OUTBOUND"]);
  });

  it("un saliente de origen DESCONOCIDO se registra como desconocido y no pausa", async () => {
    const w = webhook();
    await w.call(post(outbound(undefined, "sent", "wamid.u"), HUMAN_HEADERS));
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(w.attention.recordEvent).toHaveBeenCalledWith({ eventKey: "unknown_origin:wamid.u", contactKey: contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: PHONE }), kind: "UNKNOWN_ORIGIN", occurredAt: "2025-10-20T22:40:00.000Z", detail: { origin: "missing" } });
  });

  it("un fallo al registrar un evento informativo no pide el reintento (no cambia ningún estado)", async () => {
    const w = webhook({ attention: attentionSpy({ recordEvent: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }) });
    expect((await w.call(post(outbound("other_app"), HUMAN_HEADERS))).status).toBe(200);
    expect(logged(w.logs, "attention_event_not_recorded")).toEqual([{ kind: "OTHER_APP_OUTBOUND", error: "UNKNOWN_OUTCOME" }]);
  });

  it("con el control apagado los eventos humanos se ignoran (comportamiento anterior) y nada toca la base", async () => {
    const w = webhook({ control: false });
    expect((await w.call(post(outbound("business_app"), HUMAN_HEADERS))).status).toBe(200);
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(logged(w.logs, "human_event_ignored")).toEqual([{ reason: "control_disabled" }]);
  });

  it("se descartan los eventos de otro número del laboratorio y los de teléfonos fuera del piloto", async () => {
    const w = webhook({ allowedPhones: "59179999999" });
    const otherNumber = outbound("business_app");
    (otherNumber as any).phone_number_id = "otro-numero";
    (otherNumber.conversation as any).phone_number_id = "otro-numero";
    await w.call(post(otherNumber, HUMAN_HEADERS));
    await w.call(post(outbound("business_app", "sent", "wamid.p"), HUMAN_HEADERS));
    expect(w.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(logged(w.logs, "human_event_ignored").map((entry) => entry.reason)).toEqual(["other_phone_number", "phone_not_allowed"]);
  });

  it("sin clave dedicada o sin teléfono no se puede identificar al contacto: se registra el aviso y no se pausa a ciegas", async () => {
    const noKey = webhook({ hmacKey: undefined });
    expect((await noKey.call(post(outbound("business_app"), HUMAN_HEADERS))).status).toBe(200);
    expect(noKey.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(logged(noKey.logs, "human_event_unidentified")).toEqual([{ reason: "contact_unidentified" }]);
    const noPhone = webhook();
    const bare = { message: { id: "wamid.n", timestamp: "1761000000", kapso: { direction: "outbound", status: "sent", origin: "business_app" } } };
    await noPhone.call(post(bare, HUMAN_HEADERS));
    expect(noPhone.attention.registerHumanMessage).not.toHaveBeenCalled();
  });

  it("sin id de mensaje se usa la clave de idempotencia de la entrega; sin ninguna de las dos no hay forma de deduplicar", async () => {
    const withIdem = webhook();
    const noId = outbound("business_app");
    delete (noId.message as any).id;
    await withIdem.call(post(noId, { "x-webhook-event": "whatsapp.message.sent", "x-idempotency-key": "idem-77" }));
    expect(vi.mocked(withIdem.attention.registerHumanMessage).mock.calls[0]![0].eventKey).toBe("human_business_app:idem:idem-77");
    const none = webhook();
    await none.call(post(noId, { "x-webhook-event": "whatsapp.message.sent" }));
    expect(none.attention.registerHumanMessage).not.toHaveBeenCalled();
    expect(logged(none.logs, "human_event_unidentified")).toEqual([{ reason: "event_without_id" }]);
  });

  it("un lote con eventos mezclados procesa cada uno según su clase", async () => {
    const w = webhook();
    const batch = { type: "whatsapp.message.received", batch: true, data: [inboundImage("wamid.img-9"), outbound("business_app", "sent", "wamid.h-9"), outbound("cloud_api", "sent", "wamid.b-9")] };
    const response = await w.call(post(batch, { "x-webhook-batch": "true", "x-webhook-event": "whatsapp.message.sent" }));
    expect(response.status).toBe(200);
    expect(vi.mocked(w.attention.registerHumanMessage).mock.calls.map(([event]) => event.eventKey)).toEqual(["human_business_app:wamid.h-9"]);
    expect(w.scheduled).toHaveLength(1);
    await Promise.all(w.scheduled);
  });
});

describe("webhook: política de ACK", () => {
  it("IMÁGENES: se responde 200 de inmediato y el procesamiento sigue en segundo plano (sin cambios)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const w = webhook({ control: false, quote: { analyze: vi.fn(async () => { await gate; return okAnalysis(); }) } });
    const response = await w.call(post(inboundImage(), { "x-webhook-event": "whatsapp.message.received" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(w.scheduled).toHaveLength(1);
    expect(w.sendText).not.toHaveBeenCalled(); // la respuesta HTTP salió antes de terminar el análisis
    release();
    await Promise.all(w.scheduled);
    expect(w.sendText).toHaveBeenCalledTimes(1);
  });

  it("EVENTOS HUMANOS: la pausa se registra ANTES de responder", async () => {
    const order: string[] = [];
    const attention = attentionSpy({ registerHumanMessage: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); order.push("registered"); return { outcome: "PAUSED" as const, revision: 2, blockedRuns: 0, lateReservedRuns: 0, repliedAfterEventRuns: 0 }; }) });
    const w = webhook({ attention });
    await w.call(post(outbound("business_app"), HUMAN_HEADERS));
    order.push("responded");
    expect(order).toEqual(["registered", "responded"]);
  });

  it("si la pausa no se pudo registrar se responde 503 (Kapso reintenta) y no se arranca ningún procesamiento", async () => {
    const attention = attentionSpy({ registerHumanMessage: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) });
    const w = webhook({ attention });
    const batch = { type: "whatsapp.message.received", batch: true, data: [inboundImage("wamid.img-5"), outbound("business_app", "sent", "wamid.h-5")] };
    const response = await w.call(post(batch, { "x-webhook-batch": "true" }));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("retry");
    expect(w.scheduled).toHaveLength(0);
    expect(logged(w.logs, "human_event_failed")).toEqual([{ error: "UNKNOWN_OUTCOME" }]);
  });

  it("el reintento de Kapso es seguro: el mismo evento reenviado produce la misma clave de deduplicación", async () => {
    const w = webhook();
    await w.call(post(outbound("business_app"), HUMAN_HEADERS));
    await w.call(post(outbound("business_app"), { ...HUMAN_HEADERS, "x-idempotency-key": "idem-2" }));
    const keys = vi.mocked(w.attention.registerHumanMessage).mock.calls.map(([event]) => event.eventKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("los registros no incluyen teléfonos completos, nombres ni texto de los mensajes", async () => {
    const w = webhook({ attention: attentionSpy({ registerHumanMessage: vi.fn(async () => { throw new Error(`falló ${PHONE}`); }) }) });
    await w.call(post(outbound("business_app"), HUMAN_HEADERS));
    const ok = webhook();
    await ok.call(post(outbound("business_app"), HUMAN_HEADERS));
    const dump = JSON.stringify([w.logs, ok.logs]);
    for (const forbidden of [PHONE, "NOMBRE_SENTINELA", "TEXTO_CLINICO_SENTINELA"]) expect(dump).not.toContain(forbidden);
  });
});

// ───────────────────────────── handleImageMessage con atención humana ─────────────────────────────

const image: IncomingImage = { messageId: "wamid.hc-1", from: PHONE, mediaId: "media-1" };
const KEY = contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: PHONE })!;

function audit(overrides: Partial<AuditRepository> = {}): AuditRepository {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1", lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => "reserved" as const),
    confirmSend: vi.fn(async () => "proceed" as const),
    recordReply: vi.fn(async () => undefined),
    ...overrides
  };
}
function flow(repo: AuditRepository | undefined, overrides: Partial<QuoteDeps> = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const sendText = vi.fn(async (_to: string, _body: string) => ({ providerMessageId: "wamid.out" }));
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => okAnalysis()),
    sendText,
    log: (event, data) => logs.push([event, data]),
    audit: repo,
    leaseRenewIntervalMs: 3_600_000,
    humanControl: { contactKeyFor: (phone) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone }) },
    ...overrides
  };
  return { deps, logs, sendText };
}

describe("responder con el control de atención humana activo", () => {
  it("el claim lleva la clave estable del contacto (nunca el teléfono) y todo el flujo normal funciona", async () => {
    const repo = audit();
    const { deps, sendText } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(vi.mocked(repo.claim)).toHaveBeenCalledWith({ messageId: image.messageId, mediaId: image.mediaId }, { contactKey: KEY });
    expect(JSON.stringify(vi.mocked(repo.claim).mock.calls)).not.toContain(PHONE);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("un contacto con la IA pausada (el claim lo informa) no se descarga, analiza, reserva ni responde", async () => {
    const repo = audit({ claim: vi.fn(async () => ({ kind: "duplicate" as const, processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" as const })) });
    const { deps, sendText, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(deps.downloadImage).not.toHaveBeenCalled();
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(vi.mocked(repo.reserveSend)).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(logs.filter(([event]) => event === "duplicate_ignored").map(([, data]) => data)).toEqual([{ processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" }]);
  });

  it.each([
    ["la reserva fue denegada porque la IA se pausó", () => audit({ reserveSend: vi.fn(async () => "blocked" as const) }), "blocked"],
    ["la comprobación final detectó la pausa y liberó la reserva", () => audit({ confirmSend: vi.fn(async () => "blocked" as const) }), "blocked"],
    ["se perdió el lease antes de la comprobación final", () => audit({ confirmSend: vi.fn(async () => "lost" as const) }), "lost"],
    ["la comprobación final no obtuvo respuesta", () => audit({ confirmSend: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }), "unavailable"]
  ])("NO se envía si %s", async (_name, build, reason) => {
    const repo = build();
    const { deps, sendText, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(sendText).not.toHaveBeenCalled();
    expect(vi.mocked(repo.recordReply)).not.toHaveBeenCalled();
    expect(logs.filter(([event]) => event === "reply_withheld").map(([, data]) => data)).toEqual([{ reason }]);
  });

  it("la comprobación final ocurre después de la reserva y justo antes de la llamada a Kapso", async () => {
    const repo = audit();
    const { deps, sendText } = flow(repo);
    await handleImageMessage(image, deps);
    const reserve = vi.mocked(repo.reserveSend).mock.invocationCallOrder[0]!;
    const confirm = vi.mocked(repo.confirmSend).mock.invocationCallOrder[0]!;
    const send = sendText.mock.invocationCallOrder[0]!;
    expect(reserve).toBeLessThan(confirm);
    expect(confirm).toBeLessThan(send);
    expect(vi.mocked(repo.confirmSend)).toHaveBeenCalledWith("run-1", LEASE);
  });

  it("falla cerrada: sin clave del contacto, sin auditoría o con el claim caído NO se responde (aunque requireAuditGuard no esté activo)", async () => {
    const noKey = flow(audit(), { humanControl: { contactKeyFor: () => undefined } });
    await expect(handleImageMessage(image, noKey.deps)).resolves.toBe("ignored");
    expect(noKey.sendText).not.toHaveBeenCalled();
    expect(noKey.logs.filter(([event]) => event === "reply_withheld").map(([, data]) => data)).toEqual([{ reason: "contact_unidentified" }]);

    const noAudit = flow(undefined);
    await expect(handleImageMessage(image, noAudit.deps)).resolves.toBe("ignored");
    expect(noAudit.sendText).not.toHaveBeenCalled();
    expect(noAudit.logs.filter(([event]) => event === "reply_withheld").map(([, data]) => data)).toEqual([{ reason: "audit_guard_unavailable" }]);

    const down = flow(audit({ claim: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }));
    await expect(handleImageMessage(image, down.deps)).resolves.toBe("ignored");
    expect(down.sendText).not.toHaveBeenCalled();
    expect(down.deps.requireAuditGuard).toBeUndefined();
    expect(down.logs.map(([event]) => event)).toEqual(["audit_unavailable", "reply_withheld"]);
  });

  it("sin control de atención y sin requireAuditGuard se conserva la política heredada (responde aunque el claim falle)", async () => {
    const { deps, sendText } = flow(audit({ claim: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }), { humanControl: undefined });
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────── migración ─────────────────────────────

describe("migración de control de atención humana", () => {
  const dir = join(__dirname, "..", "supabase", "migrations");
  const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

  it("es la última, las anteriores no se modificaron y solo agrega lo necesario", async () => {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.slice(-2)).toEqual(["20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"]);
    expect(sha(await readFile(join(dir, "20261023000000_plusmedik_audit_leases.sql"), "utf8"))).toBe("1b6546c2a44142a00b771f303dccc43f5ea408cd912a340c3b3e406e63185ee7");
    const sql = (await readFile(join(dir, "20261024000000_plusmedik_human_control.sql"), "utf8")).replace(/--.*$/gm, "");
    // solo dos tablas nuevas (estado por contacto y eventos); el resto reutiliza runs
    expect([...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((match) => match[1])).toEqual(["plusmedik_attention_contacts", "plusmedik_attention_events"]);
    // lo único que se elimina es la firma anterior del claim (para que no quede una vía sin comprobación de pausa)
    expect([...sql.matchAll(/\bdrop\s+[^;]+/gi)].map((match) => match[0].replace(/\s+/g, " ").trim())).toEqual(["drop function if exists public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer)"]);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\s+(table\s+)?public/i);
    expect(sql).not.toMatch(/\bexecute\s+(format|'|\()/i); // sin SQL dinámico
    expect(sql).not.toMatch(/\b(phone|body|content)\b\s+(text|jsonb)/i); // ni teléfonos ni texto de mensajes
    for (const definition of sql.split(/create or replace function/i).slice(1)) if (/security definer/i.test(definition)) expect(definition).toMatch(/set search_path = ''/);
    for (const name of ["plusmedik_attention_status", "plusmedik_attention_register_human_message", "plusmedik_attention_record_event", "plusmedik_attention_resume", "plusmedik_audit_confirm_send"]) expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\(`));
  });
});
