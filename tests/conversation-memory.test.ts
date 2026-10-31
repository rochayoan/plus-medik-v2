import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditClaim, AuditLease, AuditRepository } from "../src/audit.js";
import {
  createConversationMemory,
  createSupabaseMemoryStore,
  MEMORY_DEFAULTS,
  MemoryCipherError,
  openText,
  prepareHistory,
  resolveConversationMemory,
  sealText,
  storablePatientText,
  storableReplyText,
  type MemoryStore,
  type StoredMessage
} from "../src/conversation-memory.js";
import { createConversationModel, type ConversationClient } from "../src/conversation-model.js";
import { buildPromptSource } from "../src/conversation-openai.js";
import { contactKeyOf } from "../src/human-control.js";
import { looksAutomated } from "../src/reply-guard.js";
import { createTextHandler } from "../src/text-handler.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Memoria conversacional corta: todo con dobles (ninguna prueba llama a OpenAI, a Kapso ni a Supabase). La garantía contra la base real está en tests/conversation-memory-db.test.ts.

const SECRET = "s".repeat(40);
const HMAC = "h".repeat(40);
const LINE_1 = "1273000000793";
const LINE_2 = "1273000000999";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("cifrado en reposo", () => {
  it("cifra y descifra, el texto no queda en claro y el formato coincide con la restricción de la base", () => {
    const sealed = sealText("Buenas tardes, tengo una duda", SECRET, KEY_A, "IN", "wamid.1");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("Buenas");
    expect(openText(sealed, SECRET, KEY_A, "IN", "wamid.1")).toBe("Buenas tardes, tengo una duda");
    expect(sealText("x", SECRET, KEY_A, "IN", "wamid.1")).not.toBe(sealText("x", SECRET, KEY_A, "IN", "wamid.1"));
  });

  it("una fila no se puede pasar por la de otro contacto, otra dirección u otro mensaje, ni abrir con otra clave", () => {
    const sealed = sealText("hola", SECRET, KEY_A, "IN", "wamid.1");
    expect(() => openText(sealed, SECRET, KEY_B, "IN", "wamid.1")).toThrow(MemoryCipherError);
    expect(() => openText(sealed, SECRET, KEY_A, "OUT", "wamid.1")).toThrow(MemoryCipherError);
    expect(() => openText(sealed, SECRET, KEY_A, "IN", "wamid.2")).toThrow(MemoryCipherError);
    expect(() => openText(sealed, "t".repeat(40), KEY_A, "IN", "wamid.1")).toThrow(MemoryCipherError);
    expect(() => openText(`${sealed}x`, SECRET, KEY_A, "IN", "wamid.1")).toThrow(MemoryCipherError);
    expect(() => openText("texto en claro", SECRET, KEY_A, "IN", "wamid.1")).toThrow(MemoryCipherError);
  });

  it("exige una clave de al menos 32 caracteres", () => {
    expect(() => sealText("hola", "corta", KEY_A, "IN", "wamid.1")).toThrow(MemoryCipherError);
  });
});

describe("qué se guarda", () => {
  it("guarda conversación normal, saneada (sin enlaces, correos ni números largos)", () => {
    expect(storablePatientText("Buenas tardes, tengo una duda")).toBe("Buenas tardes, tengo una duda");
    const clean = storablePatientText("Escríbeme a ana@correo.com o al 59170000000, mira https://x.example/y")!;
    expect(clean).not.toMatch(/@|\d{4,}|https/);
  });

  it("NO guarda lo que parece de salud, un mensaje automático, un pedido de cotización con estudios ni un mensaje vacío", () => {
    for (const text of ["me duele mucho la cabeza", "tengo fiebre desde ayer", "mi doctor me recetó paracetamol", "estoy embarazada", "tengo diabetes"]) expect(storablePatientText(text), text).toBeUndefined();
    for (const text of ["cotízame hemograma y glucosa", "¿cuánto cuesta el perfil lipídico?", "te mando mi receta", "quiero un examen"]) expect(storablePatientText(text), text).toBeUndefined();
    expect(storablePatientText("Este es un mensaje automático, no responder", { isAutomated: looksAutomated })).toBeUndefined();
    expect(storablePatientText("   ")).toBeUndefined();
    expect(storablePatientText("")).toBeUndefined();
  });

  it("de la respuesta del agente tampoco guarda lo médico ni lo vacío", () => {
    expect(storableReplyText("Con gusto te ayudo. ¿Qué necesitas?")).toBe("Con gusto te ayudo. ¿Qué necesitas?");
    expect(storableReplyText("No puedo darte orientación médica por este chat.")).toBeUndefined();
    expect(storableReplyText("")).toBeUndefined();
  });
});

describe("prepareHistory: lo que recibe el modelo", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 31, 12, minutes)).toISOString();
  const row = (direction: "IN" | "OUT", text: string, minutes: number): StoredMessage => ({ direction, text, at: at(minutes) });

  it("entrega los últimos 5 en orden cronológico con su rol", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(index % 2 === 0 ? "IN" : "OUT", `mensaje ${index}`, index));
    const { entries } = prepareHistory(rows);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.text)).toEqual(["mensaje 3", "mensaje 4", "mensaje 5", "mensaje 6", "mensaje 7"]);
    expect(entries.map((entry) => entry.from)).toEqual(["ASSISTANT", "PATIENT", "ASSISTANT", "PATIENT", "ASSISTANT"]);
    expect(prepareHistory(rows, { limit: 2 }).entries).toHaveLength(2);
    expect(prepareHistory(rows, { limit: 99 }).entries).toHaveLength(MEMORY_DEFAULTS.limit);
  });

  it("vuelve a filtrar al leer: lo médico o automático que hubiera quedado guardado no sale", () => {
    const { entries, dropped } = prepareHistory([row("IN", "me duele la cabeza", 1), row("IN", "hola, una duda", 2), row("OUT", "Consulta a tu médico", 3)]);
    expect(entries.map((entry) => entry.text)).toEqual(["hola, una duda"]);
    expect(dropped).toBe(2);
  });

  it("acota el tamaño total descartando primero lo más antiguo", () => {
    const rows = Array.from({ length: 5 }, (_, index) => row("IN", `${index}-${"x".repeat(290)}`, index));
    const { entries } = prepareHistory(rows);
    expect(entries.length).toBeLessThan(5);
    expect(entries.at(-1)!.text.startsWith("4-")).toBe(true);
  });
});

describe("almacén de Supabase: solo las funciones plusmedik_memory_*", () => {
  function fakeRpc(responses: Record<string, Record<string, unknown>> = {}) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return responses[name] ?? {};
    };
    return { rpc, calls };
  }

  it("escribe el texto CIFRADO con la clave del contacto, nunca el teléfono ni el texto en claro", async () => {
    const { rpc, calls } = fakeRpc({ plusmedik_memory_record: { outcome: "recorded" } });
    const store = createSupabaseMemoryStore({ secret: SECRET, retentionDays: 3, rpc });
    expect(await store.record({ contactKey: KEY_A, direction: "IN", messageId: "wamid.1", text: "texto-privado-QWERTY", at: new Date("2026-10-31T12:00:00Z") })).toBe("RECORDED");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("plusmedik_memory_record");
    expect(calls[0]!.args).toMatchObject({ p_contact_key: KEY_A, p_direction: "IN", p_message_id: "wamid.1", p_occurred_at: "2026-10-31T12:00:00.000Z", p_retention_days: 3 });
    expect(JSON.stringify(calls[0]!.args)).not.toContain("texto-privado-QWERTY");
    expect(String(calls[0]!.args.p_body_cipher)).toMatch(/^v1\./);
  });

  it("repetir el mensaje responde DUPLICATE", async () => {
    const store = createSupabaseMemoryStore({ secret: SECRET, rpc: fakeRpc({ plusmedik_memory_record: { outcome: "duplicate" } }).rpc });
    expect(await store.record({ contactKey: KEY_A, direction: "OUT", messageId: "wamid.2", text: "hola", at: new Date() })).toBe("DUPLICATE");
  });

  it("lee con la clave del contacto, descifra y descarta lo que no se puede descifrar", async () => {
    const good = sealText("hola, una duda", SECRET, KEY_A, "IN", "wamid.1");
    const foreign = sealText("de otro contacto", SECRET, KEY_B, "IN", "wamid.9");
    const { rpc, calls } = fakeRpc({
      plusmedik_memory_recent: { messages: [{ d: "IN", m: "wamid.1", c: good, t: "2026-10-31T12:00:00Z" }, { d: "IN", m: "wamid.9", c: foreign, t: "2026-10-31T11:00:00Z" }, { d: "OUT", m: "wamid.3", c: "v1.a.b.c", t: "2026-10-31T10:00:00Z" }] }
    });
    const rows = await createSupabaseMemoryStore({ secret: SECRET, rpc }).recent({ contactKey: KEY_A, limit: 5, excludeMessageId: "wamid.now" });
    expect(rows).toEqual([{ direction: "IN", text: "hola, una duda", at: "2026-10-31T12:00:00Z" }]);
    expect(calls[0]).toEqual({ name: "plusmedik_memory_recent", args: { p_contact_key: KEY_A, p_limit: 5, p_exclude_message_id: "wamid.now" } });
  });

  it("una respuesta con formato inesperado falla (la memoria lo trata como «sin historial»)", async () => {
    const store = createSupabaseMemoryStore({ secret: SECRET, rpc: fakeRpc({ plusmedik_memory_recent: { messages: [{ d: "ZZ" }] } }).rpc });
    await expect(store.recent({ contactKey: KEY_A, limit: 5 })).rejects.toThrow();
  });
});

describe("createConversationMemory: nunca rompe un turno ni registra texto", () => {
  afterEach(() => vi.useRealTimers());

  it("las fallas del almacén se convierten en «sin historial» y el registro solo lleva códigos", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const store: MemoryStore = { record: async () => { throw new Error("fila con texto SECRETO-XYZ"); }, recent: async () => { throw new Error("fila con texto SECRETO-XYZ"); } };
    const memory = createConversationMemory({ store, log: (event, data) => logs.push([event, data]) });
    await expect(memory.rememberPatient({ contactKey: KEY_A, messageId: "wamid.1", text: "hola, una duda" })).resolves.toBeUndefined();
    await expect(memory.rememberReply({ contactKey: KEY_A, messageId: "wamid.2", text: "Claro" })).resolves.toBeUndefined();
    expect(await memory.history({ contactKey: KEY_A, currentMessageId: "wamid.3" })).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("SECRETO-XYZ");
    expect(logs.map(([, data]) => data.outcome)).toEqual(["FAILED", "FAILED", "FAILED"]);
  });

  it("un almacén que no responde no retrasa el turno más del tope", async () => {
    vi.useFakeTimers();
    const store: MemoryStore = { record: () => new Promise(() => undefined), recent: () => new Promise(() => undefined) };
    const memory = createConversationMemory({ store, log: () => undefined });
    let done = 0;
    void memory.rememberPatient({ contactKey: KEY_A, messageId: "wamid.1", text: "hola, una duda" }).then(() => done++);
    void memory.history({ contactKey: KEY_A, currentMessageId: "wamid.1" }).then(() => done++);
    await vi.advanceTimersByTimeAsync(MEMORY_DEFAULTS.timeoutMs + 10);
    expect(done).toBe(2);
  });

  it("lo que no se debe guardar ni siquiera llega al almacén", async () => {
    const record = vi.fn(async () => "RECORDED" as const);
    const memory = createConversationMemory({ store: { record, recent: async () => [] }, log: () => undefined });
    await memory.rememberPatient({ contactKey: KEY_A, messageId: "wamid.1", text: "me duele la cabeza" });
    await memory.rememberPatient({ contactKey: KEY_A, messageId: "wamid.2", text: "cotízame hemograma" });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("resolveConversationMemory: apagada salvo configuración completa", () => {
  const store: MemoryStore = { record: async () => "RECORDED", recent: async () => [] };
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (event: string, data: Record<string, unknown>) => logs.push([event, data]);
  const ON = { PLUSMEDIK_CONVERSATION_MEMORY: "on", PLUSMEDIK_MEMORY_KEY: SECRET };

  it("está apagada por defecto y con cualquier valor distinto de «on»", () => {
    for (const value of [undefined, "", "off", "true", "1"]) expect(resolveConversationMemory({ ...ON, PLUSMEDIK_CONVERSATION_MEMORY: value }, log, { conversationActive: true })).toBeUndefined();
  });

  it("falla cerrado con configuración incompleta, registrando solo un código (no pide listas de teléfonos)", () => {
    logs.length = 0;
    expect(resolveConversationMemory(ON, log, { conversationActive: false })).toBeUndefined();
    expect(resolveConversationMemory({ PLUSMEDIK_CONVERSATION_MEMORY: "on" }, log, { conversationActive: true })).toBeUndefined();
    expect(resolveConversationMemory({ ...ON, PLUSMEDIK_MEMORY_KEY: "corta" }, log, { conversationActive: true })).toBeUndefined();
    expect(resolveConversationMemory({ ...ON, PLUSMEDIK_MEMORY_RETENTION_DAYS: "31" }, log, { conversationActive: true })).toBeUndefined();
    expect(resolveConversationMemory({ ...ON, PLUSMEDIK_MEMORY_LIMIT: "6" }, log, { conversationActive: true })).toBeUndefined();
    expect(logs.map(([, data]) => data.error)).toEqual(["CONVERSATION_REQUIRED", "MISSING_KEY", "MISSING_KEY", "INVALID_RETENTION", "INVALID_LIMIT"]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("con todo válido queda activa, sin lista de teléfonos", () => {
    expect(resolveConversationMemory(ON, log, { conversationActive: true })).toBeDefined();
    expect(resolveConversationMemory({ ...ON, PLUSMEDIK_MEMORY_RETENTION_DAYS: "30", PLUSMEDIK_MEMORY_LIMIT: "3" }, log, { conversationActive: true, store })).toBeDefined();
  });
});

// ───────────────────────────── el flujo completo: turnos -> manejador -> modelo -> envío ─────────────────────────────

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const T0 = Math.floor(Date.parse("2026-10-31T12:00:00Z") / 1000);

// Almacén en memoria que imita la base: único por (contacto, dirección, mensaje), límite y orden.
function memoryStore() {
  const rows: Array<{ contactKey: string; direction: "IN" | "OUT"; messageId: string; text: string; at: Date }> = [];
  const store: MemoryStore = {
    async record(input) {
      if (rows.some((row) => row.contactKey === input.contactKey && row.direction === input.direction && row.messageId === input.messageId)) return "DUPLICATE";
      rows.push({ ...input });
      return "RECORDED";
    },
    async recent({ contactKey, limit, excludeMessageId }) {
      return rows
        .filter((row) => row.contactKey === contactKey && !(row.direction === "IN" && row.messageId === excludeMessageId))
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, limit)
        .map((row) => ({ direction: row.direction, text: row.text, at: row.at.toISOString() }));
    }
  };
  return { store, rows };
}

function fakeAudit(): AuditRepository {
  let n = 0;
  return {
    claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => "reserved"),
    confirmSend: vi.fn(async () => "proceed"),
    recordReply: vi.fn(async () => undefined)
  } as unknown as AuditRepository;
}

function agent(options: { store: MemoryStore | undefined; line?: string; sendFails?: boolean; providerId?: string | undefined; clock: { now: number }; modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> }) {
  const line = options.line ?? LINE_1;
  const client: ConversationClient = {
    complete: vi.fn(async (input) => {
      options.modelCalls.push(input);
      return { text: JSON.stringify({ intent: "SMALL_TALK", reply: "Claro, con gusto te ayudo con eso." }) };
    })
  };
  const conversation = createConversationModel({ client, prompt: buildPromptSource().prompt, promptId: "p", model: "gpt-4.1-mini", categories: ["GREETING", "OTHER"], log: () => undefined });
  const memory = options.store ? createConversationMemory({ store: options.store, log: () => undefined, isAutomated: looksAutomated, now: () => options.clock.now }) : undefined;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC, labPhoneNumberId: line, contactPhone: phone });
  const sent: Array<[string, string]> = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => { throw new Error("no se usa"); }),
    sendText: vi.fn(async (to: string, body: string) => {
      if (options.sendFails) throw new Error("kapso caído");
      sent.push([to, body]);
      return { providerMessageId: "providerId" in options ? options.providerId : "wamid.out" };
    }),
    log: () => undefined,
    audit: fakeAudit(),
    leaseRenewIntervalMs: 3_600_000,
    turns: {
      contactKeyFor,
      memory,
      handlers: {
        text: createTextHandler({
          conversation,
          history: memory ? async (turn) => { const contactKey = contactKeyFor(turn.from); return contactKey ? memory.history({ contactKey, currentMessageId: turn.messageId }) : []; } : undefined,
          log: () => undefined
        })
      }
    }
  };
  const say = async (from: string, messageId: string, text: string, secondsAfterStart: number) => {
    options.clock.now = (T0 + secondsAfterStart + 2) * 1000;
    const turn: IncomingTurn = { messageId, from, kind: "TEXT", text, timestamp: T0 + secondsAfterStart };
    return processTurns([turn], deps);
  };
  return { say, sent };
}

describe("flujo completo: guardar y recordar", () => {
  const PATIENT_A = "59170000001";
  const PATIENT_B = "59170000002";
  const FIRST = "Buenas tardes, tengo una duda sobre cómo funciona esto";
  const SECOND = "no entiendo bien la segunda parte";
  const withHistory = (message: string) => message.includes("Historial reciente de esta conversación");

  it("guarda el mensaje entrante y la respuesta confirmada, y el siguiente mensaje recibe el historial en orden cronológico", async () => {
    const { store, rows } = memoryStore();
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const { say, sent } = agent({ store, clock: { now: 0 }, modelCalls });

    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    expect(sent).toEqual([[PATIENT_A, "Claro, con gusto te ayudo con eso."]]);
    expect(rows.map((row) => `${row.direction}:${row.messageId}`)).toEqual(["IN:wamid.A1", "OUT:wamid.out"]);
    expect(withHistory(modelCalls[0]!.message)).toBe(false);

    await say(PATIENT_A, "wamid.A2", SECOND, 30);
    const message = modelCalls[1]!.message;
    expect(withHistory(message)).toBe(true);
    const order = [message.indexOf(`"""${FIRST}"""`), message.indexOf('"""Claro, con gusto te ayudo con eso."""'), message.indexOf("Mensaje del paciente")];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // El mensaje actual va solo en su sección: no se repite dentro del historial.
    expect(message.split(SECOND)).toHaveLength(2);
    expect(message).toContain("- Paciente:");
    expect(message).toContain("- Asistente (tú):");
  });

  it("mantiene separados a los pacientes: uno nunca ve los mensajes del otro", async () => {
    const { store } = memoryStore();
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const { say } = agent({ store, clock: { now: 0 }, modelCalls });
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    await say(PATIENT_B, "wamid.B1", SECOND, 20);
    expect(withHistory(modelCalls[1]!.message)).toBe(false);
    expect(modelCalls[1]!.message).not.toContain(FIRST);
  });

  it("mantiene separadas las líneas de WhatsApp: el mismo paciente en otra línea empieza sin historial", async () => {
    const { store } = memoryStore();
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const clock = { now: 0 };
    const lineOne = agent({ store, line: LINE_1, clock, modelCalls });
    const lineTwo = agent({ store, line: LINE_2, clock, modelCalls });
    await lineOne.say(PATIENT_A, "wamid.A1", FIRST, 0);
    await lineTwo.say(PATIENT_A, "wamid.A2", SECOND, 30);
    expect(withHistory(modelCalls[1]!.message)).toBe(false);
    await lineOne.say(PATIENT_A, "wamid.A3", "y la tercera parte tampoco", 60);
    expect(withHistory(modelCalls[2]!.message)).toBe(true);
    expect(modelCalls[2]!.message).not.toContain(SECOND);
  });

  it("un reintento del mismo mensaje no duplica nada", async () => {
    const { store, rows } = memoryStore();
    const { say } = agent({ store, clock: { now: 0 }, modelCalls: [] });
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.direction === "IN")).toHaveLength(1);
    expect(rows.filter((row) => row.direction === "OUT")).toHaveLength(1);
  });

  it("una respuesta cuyo envío falló NO se guarda como enviada (el mensaje del paciente sí)", async () => {
    const { store, rows } = memoryStore();
    const { say } = agent({ store, sendFails: true, clock: { now: 0 }, modelCalls: [] });
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    expect(rows.map((row) => row.direction)).toEqual(["IN"]);
  });

  it("si el proveedor no devuelve id, la respuesta se identifica por el mensaje al que contesta", async () => {
    const { store, rows } = memoryStore();
    const { say } = agent({ store, providerId: undefined, clock: { now: 0 }, modelCalls: [] });
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    expect(rows.find((row) => row.direction === "OUT")!.messageId).toBe("reply:wamid.A1");
  });

  it("lo médico no se guarda ni llega al modelo; un pedido de cotización con estudios tampoco se guarda", async () => {
    const { store, rows } = memoryStore();
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const { say } = agent({ store, clock: { now: 0 }, modelCalls });
    await say(PATIENT_A, "wamid.A1", "me duele mucho la cabeza y tengo fiebre", 0);
    await say(PATIENT_A, "wamid.A2", "cotízame hemograma y glucosa", 20);
    expect(modelCalls).toHaveLength(0);
    expect(rows.filter((row) => row.direction === "IN")).toHaveLength(0);
  });

  it("con la memoria apagada no se guarda ni se lee nada y el modelo solo ve el mensaje actual", async () => {
    const { store, rows } = memoryStore();
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const { say, sent } = agent({ store: undefined, clock: { now: 0 }, modelCalls });
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    await say(PATIENT_A, "wamid.A2", SECOND, 30);
    expect(rows).toHaveLength(0);
    expect(store).toBeDefined();
    expect(sent).toHaveLength(2);
    expect(modelCalls.every((call) => !withHistory(call.message))).toBe(true);
  });

  it("una memoria que falla no impide responder", async () => {
    const broken: MemoryStore = { record: async () => { throw new Error("db caída"); }, recent: async () => { throw new Error("db caída"); } };
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const { say, sent } = agent({ store: broken, clock: { now: 0 }, modelCalls });
    await say(PATIENT_A, "wamid.A1", FIRST, 0);
    expect(sent).toEqual([[PATIENT_A, "Claro, con gusto te ayudo con eso."]]);
    expect(withHistory(modelCalls[0]!.message)).toBe(false);
  });

  it("el historial no trae más de 5 mensajes", async () => {
    const { store } = memoryStore();
    const modelCalls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
    const { say } = agent({ store, clock: { now: 0 }, modelCalls });
    for (let i = 0; i < 5; i++) await say(PATIENT_A, `wamid.A${i}`, `no entiendo la parte número ${i}`, i * 30);
    await say(PATIENT_A, "wamid.last", "y la última parte tampoco", 200);
    const block = modelCalls.at(-1)!.message.split("Mensaje del paciente")[0]!;
    expect(block.match(/^- (Paciente|Asistente \(tú\)):/gm)).toHaveLength(5);
  });
});

describe("fronteras de src/conversation-memory.ts (análisis estático)", () => {
  const code = readFileSync(join(__dirname, "..", "src/conversation-memory.ts"), "utf8")
    .replaceAll("\r\n", "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("solo habla con la base por las funciones plusmedik_memory_*: sin acceso directo a tablas ni a agent_*", () => {
    const rpcs = [...code.matchAll(/"(plusmedik_[a-z_]+)"/g)].map((match) => match[1]);
    expect(rpcs.length).toBeGreaterThan(0);
    expect(new Set(rpcs)).toEqual(new Set(["plusmedik_memory_record", "plusmedik_memory_recent"]));
    expect(code).not.toMatch(/\/rest\/v1\/(?!rpc)|agent_messages|agent_conversations|(?<!Buffer)\.from\(|supabase-js/i);
  });

  it("no usa el teléfono del paciente, ni el proveedor del modelo, ni el entorno por su cuenta, ni listas de teléfonos", () => {
    expect(code).not.toMatch(/\bphone\b|contactPhone|from "openai"|new OpenAI|process\.env|_PHONES|ALLOWED_PHONES/);
  });

  it("el registro no incluye texto de mensajes", () => {
    const calls = [...code.matchAll(/(?:options\.)?log\("conversation_memory[a-z_]*", \{[^}]*\}\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[0]).not.toMatch(/\b(text|content|message)\b|\bentries\b(?!\.length)/);
  });
});
