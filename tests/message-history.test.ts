import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyKapsoEvent } from "../src/human-control.js";
import {
  createMessageHistory, CSV_COLUMNS, csvLine, deliveryUpdateOf, exportHistory, HistoryCipherError, historyEntriesOf, keyIdOf, openMessage, resolveMessageHistory, sealMessage,
  type DeliveryUpdate, type ExportedRow, type HistoryRow, type HistoryStore
} from "../src/message-history.js";

// Historial de mensajes para auditoría (src/message-history.ts): cifrado, extracción de eventos de Kapso, servicio que nunca lanza ni bloquea, configuración y exportación. Sin base de datos ni red.

const KEY = "clave-de-historial-solo-para-pruebas-0123456789";
const OTHER_KEY = "otra-clave-de-historial-solo-para-pruebas-9876";
const ACCOUNT = "123456789012345";
const CONTACT = "a".repeat(64);
const SENTINEL = "TEXTO_CLINICO_SENTINELA_5521";
const PHONE = "59170001234";
const context = { accountId: ACCOUNT, contactKey: CONTACT, direction: "IN" as const, messageId: "wamid.AAA" };
const contactKeyFor = (phone: string) => (phone === PHONE ? CONTACT : phone === "59170009999" ? "b".repeat(64) : undefined);

describe("cifrado en reposo", () => {
  it("ida y vuelta; el texto no queda en claro y cada cifrado es distinto (IV aleatorio)", () => {
    const sealed = sealMessage(`me duele la cabeza ${SENTINEL} ñandú 😀`, KEY, context);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(SENTINEL);
    expect(openMessage(sealed, KEY, context)).toBe(`me duele la cabeza ${SENTINEL} ñandú 😀`);
    expect(sealMessage("hola", KEY, context)).not.toBe(sealMessage("hola", KEY, context));
  });

  it("una fila cifrada NO sirve para otro contacto, otra línea, otra dirección ni otro mensaje, ni con otra clave", () => {
    const sealed = sealMessage("hola", KEY, context);
    for (const wrong of [{ ...context, contactKey: "b".repeat(64) }, { ...context, accountId: "999" }, { ...context, direction: "OUT" as const }, { ...context, messageId: "wamid.BBB" }]) {
      expect(() => openMessage(sealed, KEY, wrong)).toThrow(HistoryCipherError);
    }
    expect(() => openMessage(sealed, OTHER_KEY, context)).toThrow(HistoryCipherError);
  });

  it("una fila manipulada o con formato inválido falla sin revelar nada", () => {
    const sealed = sealMessage("hola", KEY, context);
    const [version, iv, tag, body] = sealed.split(".");
    expect(() => openMessage(`${version}.${iv}.${tag}.${body!.slice(0, -2)}AA`, KEY, context)).toThrow(HistoryCipherError);
    expect(() => openMessage("v2.a.b.c", KEY, context)).toThrow(HistoryCipherError);
    expect(() => openMessage("basura", KEY, context)).toThrow(HistoryCipherError);
  });

  it("una clave corta se rechaza; la huella de la clave es estable, corta y distinta por clave", () => {
    expect(() => sealMessage("hola", "corta", context)).toThrow(HistoryCipherError);
    expect(keyIdOf(KEY)).toMatch(/^[0-9a-f]{8}$/);
    expect(keyIdOf(KEY)).toBe(keyIdOf(KEY));
    expect(keyIdOf(KEY)).not.toBe(keyIdOf(OTHER_KEY));
  });
});

// ───────────────────────────── eventos de Kapso ─────────────────────────────

const base = (over: Record<string, any>) => ({ conversation: { phone_number: PHONE, phone_number_id: ACCOUNT }, phone_number_id: ACCOUNT, ...over });
const patientText = (id: string, body: string) => base({ message: { id, timestamp: "1767225600", type: "text", from: PHONE, text: { body }, kapso: { direction: "inbound", status: "received", origin: "cloud_api" } } });
const entriesOf = (raws: Record<string, any>[], eventName: string | null = "whatsapp.message.received") => historyEntriesOf(raws, raws.map((raw) => classifyKapsoEvent(raw, eventName)));

describe("historyEntriesOf: qué sale de un envío de Kapso", () => {
  it("texto entrante: texto, paciente, RECEIVED y el instante del mensaje", () => {
    const { entries, statuses } = entriesOf([patientText("wamid.T1", "hola, quisiera una cita")]);
    expect(statuses).toEqual([]);
    expect(entries).toEqual([{ messageId: "wamid.T1", contactPhone: PHONE, direction: "IN", actor: "PATIENT", origin: "cloud_api", kind: "TEXT", messageType: "text", text: "hola, quisiera una cita", state: "RECEIVED", occurredAt: new Date("2026-01-01T00:00:00.000Z") }]);
  });

  it("audio e imagen entrantes: solo tipo y referencia del medio (jamás los enlaces); el pie de la imagen sí es texto del paciente", () => {
    const audio = base({ message: { id: "wamid.A1", timestamp: "1767225600", type: "audio", from: PHONE, audio: { id: "media-a", link: "https://lookaside.fbsbx.com/x", url: "https://mmg.whatsapp.net/y" }, kapso: { direction: "inbound", origin: "cloud_api", media_url: "https://media.kapso.ai/secreto.ogg" } } });
    const image = base({ message: { id: "wamid.I1", timestamp: "1767225600", type: "image", from: PHONE, image: { id: "media-i", caption: "mi receta" }, kapso: { direction: "inbound", origin: "cloud_api", media_url: "https://media.kapso.ai/receta.jpg" } } });
    const { entries } = entriesOf([audio, image]);
    expect(entries.map((e) => [e.kind, e.messageType, e.mediaRef, e.text])).toEqual([["AUDIO", "audio", "media-a", undefined], ["IMAGE", "image", "media-i", "mi receta"]]);
    expect(JSON.stringify(entries)).not.toMatch(/http|kapso\.ai|fbsbx|whatsapp\.net/);
  });

  it("otros tipos (documento, ubicación, reacción) quedan como OTHER con su tipo; un tipo raro no se copia", () => {
    const doc = base({ message: { id: "wamid.D1", timestamp: "1767225600", type: "document", from: PHONE, document: { id: "m" }, kapso: { direction: "inbound", origin: "cloud_api" } } });
    const weird = base({ message: { id: "wamid.W1", timestamp: "1767225600", type: "<script>", from: PHONE, kapso: { direction: "inbound", origin: "cloud_api" } } });
    expect(entriesOf([doc, weird]).entries.map((e) => [e.kind, e.messageType])).toEqual([["OTHER", "document"], ["OTHER", "unknown"]]);
  });

  it("mensajes de la recepción humana, de otra app y del agente de Meta se distinguen de los automáticos", () => {
    const outbound = (id: string, origin: string, status = "sent") => base({ message: { id, timestamp: "1767225600", type: "text", to: PHONE, text: { body: `respuesta ${origin}` }, kapso: { direction: "outbound", status, origin } } });
    const { entries } = entriesOf([outbound("wamid.H1", "business_app"), outbound("wamid.H2", "other_app"), outbound("wamid.H3", "meta_business_agent"), outbound("wamid.H4", "algo_raro")], "whatsapp.message.sent");
    expect(entries.map((e) => [e.actor, e.direction, e.text])).toEqual([["HUMAN", "OUT", "respuesta business_app"], ["OTHER_APP", "OUT", "respuesta other_app"], ["META_AGENT", "OUT", "respuesta meta_business_agent"], ["UNKNOWN", "OUT", "respuesta algo_raro"]]);
  });

  it("el eco del propio agente (cloud_api) NO se inserta: solo actualiza el estado; los estados de entrega tampoco son mensajes nuevos", () => {
    const echo = base({ message: { id: "wamid.OUT1", timestamp: "1767225600", type: "text", to: PHONE, text: { body: "respuesta del agente" }, kapso: { direction: "outbound", status: "sent", origin: "cloud_api" } } });
    expect(entriesOf([echo], "whatsapp.message.sent")).toEqual({ entries: [], statuses: [{ messageId: "wamid.OUT1", state: "SENT", at: new Date("2026-01-01T00:00:00.000Z") }] });
    const delivered = base({ message: { id: "wamid.OUT1", timestamp: "1767225700", kapso: { direction: "outbound", status: "delivered", origin: "cloud_api" } } });
    expect(entriesOf([delivered], "whatsapp.message.delivered")).toMatchObject({ entries: [], statuses: [{ messageId: "wamid.OUT1", state: "DELIVERED" }] });
    expect(entriesOf([delivered], "whatsapp.message.read").statuses[0]!.state).toBe("READ");
    expect(entriesOf([delivered], "whatsapp.message.failed").statuses[0]!.state).toBe("FAILED");
  });

  it("lo importado del historial, los eventos de conversación y los mensajes sin id válido se ignoran", () => {
    const sync = base({ message: { id: "wamid.S1", timestamp: "1767225600", type: "text", from: PHONE, text: { body: "viejo" }, kapso: { direction: "inbound", origin: "history_sync" } } });
    expect(entriesOf([sync]).entries).toEqual([]);
    expect(entriesOf([patientText("wamid.C1", "hola")], "whatsapp.conversation.created")).toEqual({ entries: [], statuses: [] });
    expect(entriesOf([patientText("id con espacios \n y símbolos <>", "hola")]).entries).toEqual([]);
    expect(entriesOf([{ conversation: {} }])).toEqual({ entries: [], statuses: [] });
  });

  it("un lote (batch) trae varios eventos y cada uno se registra con su orden", () => {
    const { entries } = entriesOf([patientText("wamid.B1", "uno"), patientText("wamid.B2", "dos"), patientText("wamid.B3", "tres")]);
    expect(entries.map((e) => e.text)).toEqual(["uno", "dos", "tres"]);
  });

  it("deliveryUpdateOf: por el nombre del evento o, sin él, por el estado del mensaje", () => {
    expect(deliveryUpdateOf("whatsapp.message.sent", undefined)).toBe("SENT");
    expect(deliveryUpdateOf("whatsapp.message.received", "delivered")).toBeUndefined();
    expect(deliveryUpdateOf(undefined, "Read")).toBe("READ");
    expect(deliveryUpdateOf(undefined, "received")).toBeUndefined();
    expect(deliveryUpdateOf(undefined, 5)).toBeUndefined();
  });
});

// ───────────────────────────── servicio ─────────────────────────────

interface Fake extends HistoryStore {
  rows: HistoryRow[];
  deliveries: Array<{ messageId: string; state: DeliveryUpdate }>;
  attached: Array<{ messageId: string; bodyCipher: string }>;
}
function fakeStore(over: Partial<HistoryStore> = {}): Fake {
  const rows: HistoryRow[] = [];
  const deliveries: Fake["deliveries"] = [];
  const attached: Fake["attached"] = [];
  return {
    rows, deliveries, attached,
    record: vi.fn(async (row: HistoryRow) => {
      if (rows.some((r) => r.messageId === row.messageId)) return "DUPLICATE" as const;
      rows.push(row);
      return "RECORDED" as const;
    }),
    attachText: vi.fn(async (input) => {
      const row = rows.find((r) => r.messageId === input.messageId);
      if (!row) return "MISSING" as const;
      if (row.kind !== "AUDIO" || row.bodyCipher) return "NOOP" as const;
      row.bodyCipher = input.bodyCipher;
      attached.push({ messageId: input.messageId, bodyCipher: input.bodyCipher });
      return "UPDATED" as const;
    }),
    delivery: vi.fn(async (input) => {
      deliveries.push({ messageId: input.messageId, state: input.state });
      return rows.some((r) => r.messageId === input.messageId) ? ("UPDATED" as const) : ("MISSING" as const);
    }),
    exportPage: vi.fn(async () => ({ rows: [] })),
    erase: vi.fn(async () => 0),
    purge: vi.fn(async () => 0),
    gaps: vi.fn(async () => ({ inbound: [], outbound: [] })),
    ...over
  } as Fake;
}
function service(store: HistoryStore, over: { timeoutMs?: number } = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const history = createMessageHistory({ store, secret: KEY, accountId: ACCOUNT, contactKeyFor, log: (event, data) => { logs.push([event, data]); }, ...over });
  return { history, logs };
}
const inScope = () => true;
const observe = (history: ReturnType<typeof service>["history"], raws: Record<string, any>[], eventName: string | null = "whatsapp.message.received", scope: (phone: string) => boolean = inScope) =>
  history.observe({ raws, classified: raws.map((raw) => classifyKapsoEvent(raw, eventName)), inScope: scope });

describe("servicio: observe", () => {
  it("registra el texto CIFRADO (nunca en claro) con la clave del contacto, y se puede descifrar con el contexto correcto", async () => {
    const store = fakeStore();
    const { history, logs } = service(store);
    await observe(history, [patientText("wamid.T1", `dolor de cabeza ${SENTINEL}`)]);
    expect(store.rows).toHaveLength(1);
    const row = store.rows[0]!;
    expect(row).toMatchObject({ accountId: ACCOUNT, contactKey: CONTACT, messageId: "wamid.T1", direction: "IN", actor: "PATIENT", kind: "TEXT", state: "RECEIVED", keyId: keyIdOf(KEY) });
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect(JSON.stringify(row)).not.toContain(PHONE);
    expect(openMessage(row.bodyCipher!, KEY, { accountId: ACCOUNT, contactKey: CONTACT, direction: "IN", messageId: "wamid.T1" })).toBe(`dolor de cabeza ${SENTINEL}`);
    expect(logs).toEqual([["message_history", { op: "OBSERVE", recorded: 1, duplicate: 0, statusUpdated: 0, statusIgnored: 0, failed: 0, skipped: 0 }]]);
  });

  it("el mismo evento dos veces (reintento del webhook): una sola fila, contado como duplicado", async () => {
    const store = fakeStore();
    const { history, logs } = service(store);
    await observe(history, [patientText("wamid.T1", "hola")]);
    await observe(history, [patientText("wamid.T1", "hola")]);
    expect(store.rows).toHaveLength(1);
    expect(logs[1]![1]).toMatchObject({ recorded: 0, duplicate: 1 });
  });

  it("solo los contactos que el agente atiende (inScope) y solo la línea de WhatsApp del laboratorio", async () => {
    const store = fakeStore();
    const { history, logs } = service(store);
    const otherLine = base({ phone_number_id: "OTRA_LINEA", conversation: { phone_number: PHONE, phone_number_id: "OTRA_LINEA" }, message: { id: "wamid.L1", timestamp: "1767225600", type: "text", from: PHONE, text: { body: "otra línea" }, kapso: { direction: "inbound", origin: "cloud_api" } } });
    await observe(history, [patientText("wamid.T1", "dentro"), otherLine], "whatsapp.message.received", (phone) => phone === PHONE);
    expect(store.rows.map((r) => r.messageId)).toEqual(["wamid.T1"]);
    const outOfScope = service(fakeStore());
    await observe(outOfScope.history, [patientText("wamid.T2", "fuera de alcance")], "whatsapp.message.received", () => false);
    expect(outOfScope.logs[0]![1]).toMatchObject({ recorded: 0, skipped: 1 });
    // Sin clave de contacto calculable no se puede separar al paciente: no se guarda.
    const noKey = service(fakeStore());
    const unknown = base({ message: { id: "wamid.U1", timestamp: "1767225600", type: "text", from: "59171110000", text: { body: "x" }, kapso: { direction: "inbound", origin: "cloud_api" } }, conversation: { phone_number: "59171110000", phone_number_id: ACCOUNT } });
    await observe(noKey.history, [unknown]);
    expect(noKey.logs[0]![1]).toMatchObject({ recorded: 0, skipped: 1 });
    expect(logs).toHaveLength(1);
  });

  it("los estados de entrega actualizan el mensaje saliente; uno que no existe no crea nada", async () => {
    const store = fakeStore();
    const { history } = service(store);
    const echo = base({ message: { id: "wamid.OUT1", timestamp: "1767225600", kapso: { direction: "outbound", status: "delivered", origin: "cloud_api" } } });
    await observe(history, [echo], "whatsapp.message.delivered");
    expect(store.deliveries).toEqual([{ messageId: "wamid.OUT1", state: "DELIVERED" }]);
    expect(store.rows).toEqual([]);
  });

  it("si la base falla, NO lanza, no se pierde en silencio (queda un código en el registro) y el resto del lote sigue", async () => {
    let calls = 0;
    const store = fakeStore({ record: vi.fn(async (row: HistoryRow) => { if (++calls === 2) throw new Error(`falla con ${SENTINEL} y ${PHONE}`); return "RECORDED" as const; }) });
    const { history, logs } = service(store);
    await expect(observe(history, [patientText("wamid.F1", "uno"), patientText("wamid.F2", "dos"), patientText("wamid.F3", "tres")])).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(logs).toEqual([["message_history", expect.objectContaining({ recorded: 2, failed: 1 })], ["message_history_write_failed", { op: "OBSERVE", failed: 1 }]]);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(PHONE);
  });

  it("una base que no responde no retrasa más del plazo (acotado) y no bloquea", async () => {
    const store = fakeStore({ record: vi.fn(() => new Promise<never>(() => undefined)) });
    const { history, logs } = service(store, { timeoutMs: 30 });
    const started = Date.now();
    await observe(history, [patientText("wamid.Z1", "hola")]);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(logs.at(-1)).toEqual(["message_history_write_failed", { op: "OBSERVE", failed: 1 }]);
  });

  it("los registros solo llevan contadores y códigos: ni texto, ni teléfono, ni ids de mensaje, ni claves", async () => {
    const store = fakeStore();
    const { history, logs } = service(store);
    await observe(history, [patientText("wamid.SECRETO", `hola ${SENTINEL}`)]);
    await history.recordAgentReply({ to: PHONE, messageId: "wamid.OUTSECRETO", replyTo: "wamid.SECRETO", text: `respuesta ${SENTINEL}`, state: "ACCEPTED" });
    const dump = JSON.stringify(logs);
    for (const secret of [SENTINEL, PHONE, "wamid.SECRETO", "wamid.OUTSECRETO", KEY, CONTACT]) expect(dump).not.toContain(secret);
  });
});

describe("servicio: respuestas del agente y transcripciones", () => {
  it("una respuesta aceptada se guarda cifrada como AGENTE, ACCEPTED, con el mensaje al que responde y la corrida", async () => {
    const store = fakeStore();
    const { history } = service(store);
    const at = new Date("2026-01-01T00:00:05.000Z");
    await history.recordAgentReply({ to: PHONE, messageId: "wamid.OUT1", replyTo: "wamid.IN1", text: "Te enviamos la cotización", state: "ACCEPTED", auditRunId: "11111111-1111-4111-8111-111111111111", at });
    expect(store.rows[0]).toMatchObject({ accountId: ACCOUNT, contactKey: CONTACT, messageId: "wamid.OUT1", direction: "OUT", actor: "AGENT", origin: "cloud_api", kind: "TEXT", state: "ACCEPTED", replyTo: "wamid.IN1", auditRunId: "11111111-1111-4111-8111-111111111111", occurredAt: at });
    expect(openMessage(store.rows[0]!.bodyCipher!, KEY, { accountId: ACCOUNT, contactKey: CONTACT, direction: "OUT", messageId: "wamid.OUT1" })).toBe("Te enviamos la cotización");
  });

  it("un envío incierto queda como UNCERTAIN (no se afirma que se entregó)", async () => {
    const store = fakeStore();
    const { history } = service(store);
    await history.recordAgentReply({ to: PHONE, messageId: "uncertain:wamid.IN1", replyTo: "wamid.IN1", text: "respuesta", state: "UNCERTAIN" });
    expect(store.rows[0]).toMatchObject({ state: "UNCERTAIN", actor: "AGENT" });
  });

  it("sin clave de contacto, con un id inválido o con texto vacío no se guarda; si la base falla no lanza", async () => {
    const store = fakeStore();
    const { history, logs } = service(store);
    await history.recordAgentReply({ to: "59171110000", messageId: "wamid.O1", replyTo: "wamid.I1", text: "x", state: "ACCEPTED" });
    await history.recordAgentReply({ to: PHONE, messageId: "id inválido <>", replyTo: "wamid.I1", text: "x", state: "ACCEPTED" });
    await history.recordAgentReply({ to: PHONE, messageId: "wamid.O2", replyTo: "wamid.I1", text: "   ", state: "ACCEPTED" });
    expect(store.rows).toEqual([]);
    expect(logs.every(([, data]) => data.outcome === "SKIPPED")).toBe(true);
    const failing = service(fakeStore({ record: vi.fn(async () => { throw new Error(SENTINEL); }) }));
    await expect(failing.history.recordAgentReply({ to: PHONE, messageId: "wamid.O3", replyTo: "wamid.I1", text: "hola", state: "ACCEPTED" })).resolves.toBeUndefined();
    expect(failing.logs).toEqual([["message_history_write_failed", { op: "OUT", failed: 1 }]]);
  });

  it("la transcripción de un audio se agrega a su registro; si el registro aún no existe, se escribe completo con la transcripción", async () => {
    const store = fakeStore();
    const { history } = service(store);
    await observe(history, [base({ message: { id: "wamid.A1", timestamp: "1767225600", type: "audio", from: PHONE, audio: { id: "media-a" }, kapso: { direction: "inbound", origin: "cloud_api" } } })]);
    expect(store.rows[0]).toMatchObject({ kind: "AUDIO", mediaRef: "media-a" });
    expect(store.rows[0]!.bodyCipher).toBeUndefined();
    await history.recordTranscript({ from: PHONE, messageId: "wamid.A1", text: `quiero un hemograma ${SENTINEL}` });
    expect(openMessage(store.rows[0]!.bodyCipher!, KEY, { accountId: ACCOUNT, contactKey: CONTACT, direction: "IN", messageId: "wamid.A1" })).toBe(`quiero un hemograma ${SENTINEL}`);
    // Carrera: la transcripción llega antes que el registro del webhook.
    await history.recordTranscript({ from: PHONE, messageId: "wamid.A2", text: "otro audio" });
    expect(store.rows.find((r) => r.messageId === "wamid.A2")).toMatchObject({ kind: "AUDIO", direction: "IN", state: "RECEIVED" });
    expect(openMessage(store.rows.find((r) => r.messageId === "wamid.A2")!.bodyCipher!, KEY, { accountId: ACCOUNT, contactKey: CONTACT, direction: "IN", messageId: "wamid.A2" })).toBe("otro audio");
  });
});

// ───────────────────────────── configuración ─────────────────────────────

describe("resolveMessageHistory", () => {
  const valid = { PLUSMEDIK_HISTORY: "on", PLUSMEDIK_HISTORY_PRIVACY_REVIEWED: "yes", PLUSMEDIK_HISTORY_KEY: KEY, KAPSO_PHONE_NUMBER_ID: ACCOUNT };
  const resolve = (env: Record<string, string | undefined>) => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const history = resolveMessageHistory(env, (event, data) => { logs.push([event, data]); }, { contactKeyFor, store: fakeStore() });
    return { history, logs };
  };

  it("APAGADO por defecto: sin la bandera (o con cualquier otro valor) no hay historial y no se escribe nada en el registro", () => {
    for (const flag of [undefined, "", "off", "true", "1", "ON?"]) {
      const { history, logs } = resolve({ ...valid, PLUSMEDIK_HISTORY: flag });
      expect(history, String(flag)).toBeUndefined();
      expect(logs).toEqual([]);
    }
    expect(resolve({}).history).toBeUndefined();
  });

  it("con toda la configuración válida se enciende (la bandera no distingue mayúsculas)", () => {
    expect(resolve(valid).history).toBeDefined();
    expect(resolve({ ...valid, PLUSMEDIK_HISTORY: " ON " }).history).toBeDefined();
    expect(resolve({ ...valid, PLUSMEDIK_HISTORY_RETENTION_DAYS: "90" }).history).toBeDefined();
    expect(resolve({ ...valid, PLUSMEDIK_HISTORY_RETENTION_DAYS: "3650" }).history).toBeDefined();
    // sin retención configurada: no hay vencimiento (se conserva todo)
    expect(resolve({ ...valid, PLUSMEDIK_HISTORY_RETENTION_DAYS: "" }).history).toBeDefined();
  });

  it.each([
    ["PRIVACY_REVIEW_REQUIRED", { PLUSMEDIK_HISTORY_PRIVACY_REVIEWED: undefined }],
    ["PRIVACY_REVIEW_REQUIRED", { PLUSMEDIK_HISTORY_PRIVACY_REVIEWED: "no" }],
    ["MISSING_KEY", { PLUSMEDIK_HISTORY_KEY: undefined }],
    ["MISSING_KEY", { PLUSMEDIK_HISTORY_KEY: "demasiado-corta" }],
    ["KEY_NOT_DEDICATED", { PLUSMEDIK_MEMORY_KEY: KEY }],
    ["KEY_NOT_DEDICATED", { PLUSMEDIK_CONTACT_HMAC_KEY: KEY }],
    ["KEY_NOT_DEDICATED", { SUPABASE_SERVICE_ROLE_KEY: KEY }],
    ["KEY_NOT_DEDICATED", { PLUSMEDIK_OUTBOX_KEY: KEY }],
    ["KEY_NOT_DEDICATED", { WEBHOOK_SECRET: KEY }],
    ["KEY_NOT_DEDICATED", { PLUSMEDIK_WEB_API_TOKEN: KEY }],
    ["KEY_NOT_DEDICATED", { OPENAI_API_KEY: ` ${KEY} ` }],
    ["CONTACT_KEY_REQUIRED", { KAPSO_PHONE_NUMBER_ID: undefined }],
    ["CONTACT_KEY_REQUIRED", { KAPSO_PHONE_NUMBER_ID: "con espacios y <>" }],
    ["INVALID_RETENTION", { PLUSMEDIK_HISTORY_RETENTION_DAYS: "0" }],
    ["INVALID_RETENTION", { PLUSMEDIK_HISTORY_RETENTION_DAYS: "3651" }],
    ["INVALID_RETENTION", { PLUSMEDIK_HISTORY_RETENTION_DAYS: "treinta" }]
  ])("configuración incompleta o insegura (%s): queda APAGADO y solo se registra un código", (code, override) => {
    const { history, logs } = resolve({ ...valid, ...override });
    expect(history).toBeUndefined();
    expect(logs).toEqual([["message_history_config_invalid", { error: code }]]);
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });
});

// ───────────────────────────── exportación ─────────────────────────────

function exportRow(seq: number, over: Partial<ExportedRow> & { text?: string; key?: string } = {}): ExportedRow {
  const messageId = over.messageId ?? `wamid.E${seq}`;
  const direction = over.direction ?? "IN";
  const bodyCipher = over.text === undefined ? null : sealMessage(over.text, over.key ?? KEY, { accountId: ACCOUNT, contactKey: CONTACT, direction, messageId });
  return {
    seq, contactKey: CONTACT, messageId, direction, actor: direction === "IN" ? "PATIENT" : "AGENT", origin: "cloud_api", kind: "TEXT", messageType: "text", bodyCipher, keyId: bodyCipher ? keyIdOf(over.key ?? KEY) : null,
    mediaRef: null, state: direction === "IN" ? "RECEIVED" : "ACCEPTED", auditRunId: null, replyTo: null, occurredAt: "2026-01-01T00:00:00Z", deliveryAt: null, ...over
  } as ExportedRow;
}

describe("exportHistory", () => {
  it("descifra, recorre todas las páginas en orden y entrega el motivo en cada llamada", async () => {
    const pages: Record<string, { rows: ExportedRow[]; next?: number }> = {
      first: { rows: [exportRow(1, { text: "uno" }), exportRow(2, { text: "dos", direction: "OUT" })], next: 2 },
      second: { rows: [exportRow(3, { text: "tres" })] }
    };
    const exportPage = vi.fn(async (input: { afterSeq?: number }) => (input.afterSeq === undefined ? pages.first! : pages.second!));
    const store = fakeStore({ exportPage });
    const out: string[] = [];
    for await (const message of exportHistory({ store, accountId: ACCOUNT, keys: [KEY], reason: "auditoría de calidad", pageSize: 2 })) out.push(`${message.seq}:${message.text}`);
    expect(out).toEqual(["1:uno", "2:dos", "3:tres"]);
    expect(exportPage).toHaveBeenCalledTimes(2);
    expect(exportPage.mock.calls.map(([input]) => (input as { reason: string }).reason)).toEqual(["auditoría de calidad", "auditoría de calidad"]);
    expect(exportPage.mock.calls[1]![0]).toMatchObject({ afterSeq: 2, limit: 2 });
  });

  it("claves rotadas: cada fila se descifra con la clave que la cifró (por su huella); con otra clave queda ilegible, sin texto", async () => {
    const store = fakeStore({ exportPage: vi.fn(async () => ({ rows: [exportRow(1, { text: "con la actual" }), exportRow(2, { text: "con la anterior", key: OTHER_KEY }), exportRow(3, { text: "con una desconocida", key: "tercera-clave-desconocida-0123456789abcdef" }), exportRow(4)] })) });
    const all: Array<[string, string | undefined]> = [];
    for await (const m of exportHistory({ store, accountId: ACCOUNT, keys: [KEY, OTHER_KEY], reason: "auditoría de calidad" })) all.push([m.textStatus, m.text]);
    expect(all).toEqual([["OK", "con la actual"], ["OK", "con la anterior"], ["UNREADABLE", undefined], ["NONE", undefined]]);
  });

  it("no entrega teléfonos ni enlaces: solo la clave HMAC del contacto y la referencia del medio", async () => {
    const store = fakeStore({ exportPage: vi.fn(async () => ({ rows: [exportRow(1, { text: "hola", kind: "AUDIO", mediaRef: "media-a" })] })) });
    const rows = [];
    for await (const m of exportHistory({ store, accountId: ACCOUNT, keys: [KEY], reason: "auditoría de calidad" })) rows.push(m);
    expect(JSON.stringify(rows)).not.toMatch(/http|5917\d{7}/);
    expect(rows[0]).toMatchObject({ contactKey: CONTACT, mediaRef: "media-a" });
  });
});

describe("csvLine: seguro para abrir en una hoja de cálculo", () => {
  const message = (text: string) => ({ seq: 1, at: "2026-01-01T00:00:00Z", contactKey: CONTACT, messageId: "wamid.E1", direction: "IN", actor: "PATIENT", origin: null, kind: "TEXT", messageType: "text", mediaRef: null, state: "RECEIVED", deliveryAt: null, auditRunId: null, replyTo: null, textStatus: "OK", text }) as Parameters<typeof csvLine>[0];

  it("neutraliza fórmulas (= + - @), escapa comillas, comas y saltos de línea", () => {
    for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)"]) {
      const cells = csvLine(message(evil));
      expect(cells.endsWith(`'${evil.replaceAll('"', '""')}`) || cells.endsWith(`"'${evil.replaceAll('"', '""')}"`), evil).toBe(true);
    }
    expect(csvLine(message('dijo "hola", y\nse fue')).endsWith('"dijo ""hola"", y\nse fue"')).toBe(true);
    expect(csvLine(message("normal")).split(",").length).toBe(CSV_COLUMNS.length);
  });
});

// ───────────────────────────── límites del módulo ─────────────────────────────

describe("independencia y límites", () => {
  const src = (file: string) => readFileSync(join(__dirname, "..", "src", file), "utf8");

  it("el historial NO depende de la memoria conversacional ni del modelo, y no escribe en el registro por su cuenta", () => {
    const code = src("message-history.ts").replace(/\/\/[^\n]*/g, "");
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["./audit.js", "./human-control.js", "node:crypto", "zod"]);
    expect(code).not.toMatch(/console\.|process\.env/);
    expect(code).not.toMatch(/\/rest\/v1\/(?!rpc)|agent_messages|agent_conversations|supabase-js/i);
  });

  it("solo toca la base por funciones plusmedik_history_*", () => {
    const names = [...src("message-history.ts").matchAll(/call\("([a-z_]+)"/g)].map((match) => match[1]);
    expect(new Set(names)).toEqual(new Set(["plusmedik_history_record", "plusmedik_history_attach_text", "plusmedik_history_delivery", "plusmedik_history_export", "plusmedik_history_erase", "plusmedik_history_purge", "plusmedik_history_gaps"]));
  });

  it("los demás módulos del agente solo reciben el historial inyectado: no lo crean, no leen su configuración y NO leen nada de él", () => {
    const others = readdirSync(join(__dirname, "..", "src"), { recursive: true }).map(String).filter((file) => file.endsWith(".ts") && !file.endsWith("message-history.ts"));
    for (const file of others) {
      const code = src(file).replace(/\/\/[^\n]*/g, "");
      expect(code, file).not.toMatch(/resolveMessageHistory|createMessageHistory|createSupabaseHistoryStore|exportHistory|PLUSMEDIK_HISTORY/);
      expect(code, file).not.toMatch(/plusmedik_history_/);
    }
  });

  it("las únicas llamadas al historial desde el flujo son de escritura (observe, recordAgentReply, recordTranscript): ninguna decisión del agente depende de él", () => {
    const calls = new Set<string>();
    for (const file of ["guarded-turn.ts", "kapso-webhook.ts", "audio-turns.ts", "turns.ts", "text-handler.ts", "whatsapp-quote.ts"]) {
      for (const match of src(file).matchAll(/\bhistory\??\.([A-Za-z]+)\(/g)) calls.add(`${file}:${match[1]}`);
    }
    // text-handler usa su propia opción `history` (contexto de la memoria conversacional), que es otra cosa: no puede aparecer aquí como llamada al historial de auditoría.
    expect([...calls].filter((call) => !call.startsWith("text-handler.ts")).sort()).toEqual(["audio-turns.ts:recordTranscript", "guarded-turn.ts:recordAgentReply", "kapso-webhook.ts:observe"]);
  });

  it("el script de exportación no imprime mensajes: solo contadores", () => {
    const script = readFileSync(join(__dirname, "..", "scripts", "history-export.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(script).not.toMatch(/console\.\w+\([^;]*(message\.|\.text\b|lines)/);
    expect(script).toMatch(/mode: 0o600/);
  });
});
