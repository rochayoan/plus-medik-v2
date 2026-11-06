import { describe, expect, it, vi } from "vitest";
import { decodeRow, emptyState, encodeEvent, pending, reduce, replayEvents, stateFromRows, type ConversationEvent } from "../src/conversation-state.js";
import {
  createConversationReader, createConversationRecorder, createSupabaseConversationStore, patientItemsOf, replyQualityOf, resolveConversationState, type ConversationStore, type ObservedTurn
} from "../src/conversation-state-store.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { DRAFT_TEXTS } from "../src/text-handler.js";
import { AuditWriteError } from "../src/audit.js";

// Memoria estructurada en SOMBRA (Fase 1 del plan G7): codificación a la tabla de eventos, reglas de clasificación, el grabador (nunca lanza, nunca guarda texto, acotado) y la configuración.

const CODE = /^[A-Za-z0-9_.=:+/-]{1,128}$/;
const KEY = "a".repeat(64);
const text = (id: string, body: string): ObservedTurn => ({ messageId: id, kind: "TEXT", text: body });

// Toda cadena de un payload debe ser un identificador/código (lo mismo que impone la base): una frase o un teléfono con espacios fallaría aquí antes de llegar a ella.
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => [key, ...stringsOf(inner)]);
  return [];
}

function memoryStore(): ConversationStore & { rows: Array<{ contactKey: string; row: ReturnType<typeof encodeEvent> }>; appended: number } {
  const rows: Array<{ contactKey: string; row: ReturnType<typeof encodeEvent> }> = [];
  const store = {
    rows,
    appended: 0,
    async append(contactKey: string, batch: readonly ReturnType<typeof encodeEvent>[]) {
      store.appended += 1;
      let recorded = 0;
      let duplicate = 0;
      for (const row of batch) {
        if (rows.some((entry) => entry.contactKey === contactKey && entry.row.event_key === row.event_key)) duplicate += 1;
        else { rows.push({ contactKey, row }); recorded += 1; }
      }
      return { recorded, duplicate };
    },
    async read(contactKey: string) {
      return rows.filter((entry) => entry.contactKey === contactKey).map(({ row }) => ({ key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }));
    },
    async contactsSince() {
      return [...new Set(rows.map((entry) => entry.contactKey))].map((contactKey) => ({ contactKey, lastAt: "" }));
    }
  };
  return store;
}

describe("codificación de eventos hacia la tabla (migración 24)", () => {
  const events: ConversationEvent[] = [
    { id: "batch:w1", type: "PATIENT_BATCH", at: 1_000, items: [{ messageId: "w1", topic: "RECIPE_OR_QUOTE", goal: "QUOTE" }, { messageId: "w2", topic: "MEDIA_IMAGE", goal: "QUOTE" }], paused: true },
    { id: "reply:w9", type: "AGENT_REPLY", at: 2_000, quality: "GENERIC" },
    { id: "reply:w10", type: "AGENT_REPLY", at: 2_500, quality: "ANSWER", closes: ["w1", "w0"], upto: 1_900 },
    { id: "human:e1", type: "HUMAN_MESSAGE", at: 3_000 },
    { id: "resume:op1", type: "HUMAN_RESUME", at: 4_000 },
    { id: "recipe:w3", type: "ARTIFACT", at: 5_000, artifact: { id: "R:w3", kind: "RECIPE", studyIds: ["00000000-0000-4000-8000-000000000001"], unrecognized: 2 } },
    { id: "drop:1", type: "DROP", at: 6_000, questionId: "Q1", reason: "DUPLICATE" }
  ];

  it("ida y vuelta sin pérdida y en la forma que la base acepta (solo ids y códigos)", () => {
    for (const event of events) {
      const row = encodeEvent(event);
      expect(row.event_key).toBe(event.id);
      for (const value of stringsOf(row.payload)) expect(value, `${event.type}: ${value}`).toMatch(CODE);
      const back = decodeRow({ key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at });
      expect(back).toEqual(event);
    }
  });

  it("una fila ilegible (clase desconocida, payload inesperado, fecha rota, clave con espacios) se ignora y no rompe el estado", () => {
    const good = encodeEvent(events[0]!);
    const rows = [
      { key: good.event_key, kind: good.kind, payload: good.payload, at: good.occurred_at },
      { key: "x", kind: "FUTURE_KIND", payload: {}, at: "2026-11-01T00:00:00Z" },
      { key: "y", kind: "AGENT_REPLY", payload: { q: "NEW_QUALITY" }, at: "2026-11-01T00:00:00Z" },
      { key: "z", kind: "PATIENT_BATCH", payload: { items: [{ m: "a b", t: "x", g: "QUOTE" }] }, at: "2026-11-01T00:00:00Z" },
      { key: "w", kind: "HUMAN_MESSAGE", payload: {}, at: "no es fecha" },
      null,
      "texto"
    ];
    const state = stateFromRows(rows);
    expect(state.applied).toEqual(["batch:w1"]);
    expect(state.questions).toHaveLength(2);
  });

  it("el estado no depende del orden de llegada: se reconstruye por instante", () => {
    const rows = events.map((event) => { const row = encodeEvent(event); return { key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }; });
    const forward = stateFromRows(rows);
    const reversed = stateFromRows([...rows].reverse());
    expect(reversed).toEqual(forward);
    expect(forward).toEqual(replayEvents(events));
  });
});

describe("patientItemsOf: peticiones de un lote, sin texto", () => {
  it("un saludo o un agradecimiento solos no son una petición", () => {
    expect(patientItemsOf([text("w1", "hola")])).toEqual([]);
    expect(patientItemsOf([text("w1", "gracias"), text("w2", "ok listo")])).toEqual([]);
  });

  it("clasifica por categoría y objetivo (cotizar, información, persona, síntoma)", () => {
    expect(patientItemsOf([text("w1", "necesito cotizar estos examenes")])).toEqual([{ messageId: "w1", topic: "RECIPE_OR_QUOTE", goal: "QUOTE" }]);
    expect(patientItemsOf([text("w1", "a que hora abren")])).toEqual([{ messageId: "w1", topic: "INFO_REQUEST", goal: "LAB_INFO" }]);
    expect(patientItemsOf([text("w1", "quiero hablar con una persona")])).toEqual([{ messageId: "w1", topic: "HUMAN_REQUEST", goal: "HUMAN_ATTENTION" }]);
    expect(patientItemsOf([text("w1", "me duele mucho el pecho")])).toEqual([{ messageId: "w1", topic: "MEDICAL", goal: "HUMAN_ATTENTION" }]);
  });

  it("una foto, un audio o un documento son una petición cada uno; los textos del lote cuentan una vez", () => {
    const items = patientItemsOf([
      { messageId: "i1", kind: "IMAGE" }, { messageId: "a1", kind: "AUDIO" }, { messageId: "d1", kind: "OTHER" },
      text("t1", "hola"), text("t2", "cuanto cuesta un hemograma")
    ]);
    expect(items).toEqual([
      { messageId: "i1", topic: "MEDIA_IMAGE", goal: "QUOTE" },
      { messageId: "a1", topic: "MEDIA_AUDIO", goal: "MEDIA" },
      { messageId: "d1", topic: "MEDIA_OTHER", goal: "MEDIA" },
      { messageId: "t1", topic: "RECIPE_OR_QUOTE", goal: "QUOTE" }
    ]);
  });

  it("el resultado nunca contiene el texto del paciente", () => {
    const secret = "mi cedula es 12345678 y me llamo Maria Perez cuanto cuesta un hemograma";
    const serialized = JSON.stringify(patientItemsOf([text("w1", secret)]));
    expect(serialized).not.toMatch(/12345678|Maria|Perez|cedula/i);
  });
});

describe("replyQualityOf: ¿la respuesta atendió lo pedido?", () => {
  it("una cotización es QUOTE; un fallo técnico es TECHNICAL", () => {
    expect(replyQualityOf({ body: "Total: …", result: "quoted" })).toBe("QUOTE");
    expect(replyQualityOf({ body: DRAFT_TEXTS.fallback, result: "technical_issue" })).toBe("TECHNICAL");
  });

  it("los textos fijos genéricos no cierran la pregunta (GENERIC) y los de «no puedo derivar» tampoco (BLOCKED)", () => {
    expect(replyQualityOf({ body: DRAFT_TEXTS.fallback, result: "replied" })).toBe("GENERIC");
    expect(replyQualityOf({ body: DRAFT_TEXTS.greeting, result: "replied" })).toBe("GENERIC");
    expect(replyQualityOf({ body: DRAFT_TEXTS.send_recipe, result: "replied" })).toBe("GENERIC");
    expect(replyQualityOf({ body: DRAFT_TEXTS.handoff_unavailable, result: "replied" })).toBe("BLOCKED");
    expect(replyQualityOf({ body: DRAFT_TEXTS.medical_unavailable, result: "replied" })).toBe("BLOCKED");
    expect(replyQualityOf({ body: `${DRAFT_TEXTS.greeting}\n\n${DRAFT_TEXTS.handoff_unavailable}`, result: "replied" })).toBe("BLOCKED");
  });

  it("un mensaje de varias partes cuenta como respuesta si alguna parte es contenido real", () => {
    expect(replyQualityOf({ body: `${DRAFT_TEXTS.greeting}\n\nAbrimos de lunes a viernes.`, result: "replied" })).toBe("ANSWER");
    expect(replyQualityOf({ body: "Abrimos de lunes a viernes.", result: "replied" })).toBe("ANSWER");
  });

  it("sin cotización, solo cancelar/nada que cancelar resuelve; cualquier otra cosa queda sin resolver", () => {
    expect(replyQualityOf({ body: QUOTE_TEXTS.cancelled, result: "no_quote" })).toBe("ANSWER");
    expect(replyQualityOf({ body: QUOTE_TEXTS.nothing_to_cancel, result: "no_quote" })).toBe("ANSWER");
    expect(replyQualityOf({ body: "No pude leer bien la receta, ¿puedes enviar otra foto?", result: "no_quote" })).toBe("UNRESOLVED");
  });

  it("una respuesta marcada como genérica por el productor y de una sola parte cuenta como GENERIC", () => {
    expect(replyQualityOf({ body: "Cuéntame en qué te ayudo.", result: "replied", generic: true })).toBe("GENERIC");
    expect(replyQualityOf({ body: "Cuéntame en qué te ayudo.", result: "replied" })).toBe("ANSWER");
  });
});

describe("del lote a lo pendiente: el reductor con las reglas de calidad", () => {
  const event = (id: string, at: number, quality: Parameters<typeof replyQualityOf>[0]): ConversationEvent => ({ id, type: "AGENT_REPLY", at, quality: replyQualityOf(quality) });
  const batch = (at: number, ...items: Array<[string, string, "QUOTE" | "LAB_INFO" | "HUMAN_ATTENTION"]>): ConversationEvent => ({ id: `batch:${items[0]![0]}`, type: "PATIENT_BATCH", at, items: items.map(([messageId, topic, goal]) => ({ messageId, topic, goal })) });

  it("una receta contestada con el texto fijo sigue pendiente; la cotización posterior la cierra", () => {
    let state = reduce(emptyState(), batch(1_000, ["w1", "MEDIA_IMAGE", "QUOTE"]));
    state = reduce(state, event("reply:r1", 2_000, { body: DRAFT_TEXTS.send_recipe, result: "replied" }));
    expect(pending(state, 3_000).map((q) => `${q.topic}:${q.status}:${q.reason}`)).toEqual(["MEDIA_IMAGE:CARRIED:FIXED_REPLY_ONLY"]);
    state = reduce(state, { id: "reply:r2", type: "AGENT_REPLY", at: 4_000, quality: replyQualityOf({ body: "Total: …", result: "quoted" }) });
    expect(pending(state, 5_000)).toEqual([]);
  });

  it("mientras una persona tiene la palabra el mensaje queda pospuesto y al reanudar se reabre", () => {
    let state = reduce(emptyState(), { id: "human:e1", type: "HUMAN_MESSAGE", at: 500 });
    state = reduce(state, batch(1_000, ["w1", "INFO_REQUEST", "LAB_INFO"]));
    expect(pending(state, 2_000).map((q) => q.reason)).toEqual(["HUMAN_PAUSED"]);
    state = reduce(state, { id: "resume:o1", type: "HUMAN_RESUME", at: 3_000 });
    expect(pending(state, 4_000).map((q) => q.status)).toEqual(["OPEN"]);
  });
});

describe("el grabador en sombra", () => {
  const make = (overrides: Partial<Parameters<typeof createConversationRecorder>[0]> = {}) => {
    const store = memoryStore();
    const log = vi.fn();
    const recorder = createConversationRecorder({ store, contactKeyFor: (phone) => (phone === "59170000001" ? KEY : undefined), log, now: () => 1_700_000_000_000, ...overrides });
    return { store, log, recorder };
  };

  it("escribe lote, respuesta, mensaje humano, reanudación y artefactos como hechos mínimos, con ids y sin texto", async () => {
    const { store, recorder } = make();
    recorder.patientBatch({ from: "59170000001", turns: [text("wamid.A", "necesito cotizar mi receta, soy Maria Perez, tel 59170000001"), { messageId: "wamid.B", kind: "IMAGE", timestamp: 1_700_000_100 }] });
    recorder.agentReply({ from: "59170000001", messageId: "wamid.R", replyTo: "wamid.A", reply: { body: "Hola Maria, el total es Bs 123", result: "quoted" } });
    recorder.humanMessage({ contactKey: KEY, eventKey: "evt1", at: "2026-11-01T10:00:00Z" });
    recorder.humanResume({ contactKey: KEY, operationId: "op-1" });
    recorder.artifact({ from: "59170000001", key: "wamid.B", kind: "RECIPE", studyIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"], unrecognized: 3 });
    recorder.artifact({ from: "59170000001", key: "wamid.B", kind: "QUOTE", studyIds: ["00000000-0000-4000-8000-000000000001"] });
    await recorder.flush();
    expect(store.rows.map((entry) => entry.row.event_key).sort()).toEqual(["batch:wamid.A", "human:evt1", "quote:wamid.B", "recipe:wamid.B", "reply:wamid.R", "resume:op-1"]);
    expect(store.rows.every((entry) => entry.contactKey === KEY)).toBe(true);
    for (const { row } of store.rows) for (const value of stringsOf(row.payload)) expect(value).toMatch(CODE);
    const serialized = JSON.stringify(store.rows);
    expect(serialized).not.toMatch(/Maria|Perez|123|59170000001|cotizar|receta/);
    const recipe = store.rows.find((entry) => entry.row.event_key === "recipe:wamid.B")!.row.payload as { a: { s: string[]; u: number } };
    expect(recipe.a.s).toEqual(["00000000-0000-4000-8000-000000000001"]); // sin repetidos
    expect(recipe.a.u).toBe(3);
    // el lote se fecha con el instante de OBSERVACIÓN (reloj propio en milisegundos), no con la marca en segundos de Kapso
    expect(store.rows.find((entry) => entry.row.event_key === "batch:wamid.A")!.row.occurred_at).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("el orden de los hechos del mismo proceso se conserva aunque el reloj no avance (receta y cotización en el mismo milisegundo)", async () => {
    const { store, recorder } = make();
    recorder.artifact({ from: "59170000001", key: "wamid.B", kind: "RECIPE", studyIds: [] });
    recorder.artifact({ from: "59170000001", key: "wamid.B", kind: "QUOTE", studyIds: [] });
    recorder.agentReply({ from: "59170000001", messageId: "wamid.R", replyTo: "wamid.B", reply: { body: "x", result: "quoted" } });
    await recorder.flush();
    const times = ["recipe:wamid.B", "quote:wamid.B", "reply:wamid.R"].map((key) => Date.parse(store.rows.find((entry) => entry.row.event_key === key)!.row.occurred_at));
    expect(times[0]!).toBeLessThan(times[1]!);
    expect(times[1]!).toBeLessThan(times[2]!);
  });

  it("una respuesta declara hasta qué lote contestó: lo que llegó MIENTRAS se respondía (aunque sea en el mismo segundo) no se da por atendido", async () => {
    const { store, recorder } = make();
    recorder.patientBatch({ from: "59170000001", turns: [text("wamid.A", "cuanto cuesta un hemograma"), ] });
    recorder.patientBatch({ from: "59170000001", turns: [{ messageId: "wamid.B", kind: "TEXT", text: "a que hora abren", timestamp: 1_700_000_000 }] });
    recorder.agentReply({ from: "59170000001", messageId: "wamid.R", replyTo: "wamid.A", reply: { body: "Aquí tienes.", result: "quoted" } });
    await recorder.flush();
    const rows = store.rows.map(({ row }) => ({ key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }));
    const state = stateFromRows(rows);
    expect(state.questions.map((q) => `${q.messageId}:${q.status}`)).toEqual(["wamid.A:ANSWERED", "wamid.B:OPEN"]);
    const reply = rows.find((row) => row.key === "reply:wamid.R")!;
    expect(typeof (reply.payload as { u?: number }).u).toBe("number");
  });

  it("repetir el mismo hecho no lo duplica (reintento de Kapso) y lo registra como DUPLICATE", async () => {
    const { store, recorder, log } = make();
    for (let i = 0; i < 3; i++) recorder.patientBatch({ from: "59170000001", turns: [text("wamid.A", "cuanto cuesta un hemograma")] });
    await recorder.flush();
    expect(store.rows).toHaveLength(1);
    expect(log.mock.calls.filter(([name, data]) => name === "conv_state" && data.outcome === "DUPLICATE")).toHaveLength(2);
  });

  it("un contacto desconocido, un id inseguro o un lote sin peticiones no escriben nada", async () => {
    const { store, recorder } = make();
    recorder.patientBatch({ from: "59179999999", turns: [text("wamid.A", "cuanto cuesta un hemograma")] });
    recorder.patientBatch({ from: "59170000001", turns: [text("wamid con espacios", "cuanto cuesta un hemograma")] });
    recorder.patientBatch({ from: "59170000001", turns: [text("wamid.B", "hola"), text("wamid.C", "gracias")] });
    recorder.humanMessage({ contactKey: "no-es-hash", eventKey: "con espacios" });
    recorder.artifact({ from: "59170000001", key: "con espacios", kind: "QUOTE", studyIds: [] });
    await recorder.flush();
    expect(store.appended).toBe(0);
  });

  it("un fallo de la base nunca se propaga ni se pierde en silencio: queda un código, sin texto, y flush no lanza", async () => {
    const failing: ConversationStore = {
      append: async () => { throw new AuditWriteError("REJECTED", 410, { serverCode: "PT422", requestId: "req-1" }); },
      read: async () => [], contactsSince: async () => []
    };
    const { recorder, log } = make({ store: failing });
    expect(() => recorder.patientBatch({ from: "59170000001", turns: [text("wamid.A", "cuanto cuesta un hemograma")] })).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    const failed = log.mock.calls.filter(([name]) => name === "conv_state_write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]![1]).toMatchObject({ eventType: "PATIENT_BATCH", kind: "REJECTED", httpStatus: 410, serverCode: "PT422" });
    expect(JSON.stringify(failed)).not.toMatch(/hemograma/);
  });

  it("un error inesperado (no del servidor) tampoco se propaga", async () => {
    const throwing: ConversationStore = { append: () => { throw new TypeError("boom con texto del paciente"); }, read: async () => [], contactsSince: async () => [] };
    const { recorder, log } = make({ store: throwing });
    expect(() => recorder.agentReply({ from: "59170000001", messageId: "w", replyTo: "w0", reply: { body: "x", result: "replied" } })).not.toThrow();
    await recorder.flush();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/boom|paciente/);
  });

  it("flush está acotado: con una base que no responde vuelve al vencer el plazo y sin lanzar", async () => {
    const hanging: ConversationStore = { append: () => new Promise(() => undefined), read: async () => [], contactsSince: async () => [] };
    const { recorder } = make({ store: hanging });
    recorder.patientBatch({ from: "59170000001", turns: [text("wamid.A", "cuanto cuesta un hemograma")] });
    const started = Date.now();
    await recorder.flush(50);
    expect(Date.now() - started).toBeLessThan(1000);
    // sin nada pendiente vuelve de inmediato
    const idle = make().recorder;
    await expect(idle.flush(10_000)).resolves.toBeUndefined();
  });

  it("la retención configurada llega a la base", async () => {
    const append = vi.fn(async (_key: string, _rows: readonly unknown[], _days?: number) => ({ recorded: 1, duplicate: 0 }));
    const { recorder } = make({ store: { append, read: async () => [], contactsSince: async () => [] }, retentionDays: 7 });
    recorder.humanResume({ contactKey: KEY, operationId: "op" });
    await recorder.flush();
    expect(append).toHaveBeenCalledWith(KEY, [expect.objectContaining({ event_key: "resume:op", kind: "HUMAN_RESUME" })], 7);
  });
});

describe("el almacén (funciones de la base)", () => {
  it("llama solo a las funciones plusmedik_conv_* con argumentos con nombre y devuelve formas conocidas", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const rpc = async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      if (name === "plusmedik_conv_append") return { recorded: 2, duplicate: 1 };
      if (name === "plusmedik_conv_events_read") return { events: [{ key: "k" }] };
      return { contacts: [{ contact_key: KEY, last_at: "2026-11-01T00:00:00Z" }, { contact_key: 5 }, "x", null] };
    };
    const store = createSupabaseConversationStore({ rpc });
    const row = encodeEvent({ id: "human:e", type: "HUMAN_MESSAGE", at: 1_000 });
    expect(await store.append(KEY, [row], 9)).toEqual({ recorded: 2, duplicate: 1 });
    expect(await store.read(KEY, new Date("2026-11-01T00:00:00Z"), 10)).toEqual([{ key: "k" }]);
    expect(await store.contactsSince(new Date("2026-11-01T00:00:00Z"), 5)).toEqual([{ contactKey: KEY, lastAt: "2026-11-01T00:00:00Z" }]);
    expect(calls.map(([name]) => name)).toEqual(["plusmedik_conv_append", "plusmedik_conv_events_read", "plusmedik_conv_contacts_since"]);
    expect(calls[0]![1]).toEqual({ p_contact_key: KEY, p_events: [row], p_retention_days: 9 });
    expect(calls[1]![1]).toEqual({ p_contact_key: KEY, p_since: "2026-11-01T00:00:00.000Z", p_limit: 10 });
  });

  it("una respuesta de forma inesperada se trata como vacía, no como error", async () => {
    const store = createSupabaseConversationStore({ rpc: async () => ({ events: "nada", contacts: 7 }) });
    expect(await store.read(KEY, new Date())).toEqual([]);
    expect(await store.contactsSince(new Date())).toEqual([]);
  });
});

describe("el lector: estado y pendientes de un contacto", () => {
  it("reconstruye el estado y lista los contactos con preguntas pendientes (solo ids y códigos)", async () => {
    const store = memoryStore();
    const other = "b".repeat(64);
    const put = async (contactKey: string, event: ConversationEvent) => { await store.append(contactKey, [encodeEvent(event)]); };
    await put(KEY, { id: "batch:w1", type: "PATIENT_BATCH", at: 1_000, items: [{ messageId: "w1", topic: "MEDIA_IMAGE", goal: "QUOTE" }] });
    await put(other, { id: "batch:w2", type: "PATIENT_BATCH", at: 1_000, items: [{ messageId: "w2", topic: "INFO_REQUEST", goal: "LAB_INFO" }] });
    await put(other, { id: "reply:r", type: "AGENT_REPLY", at: 2_000, quality: "ANSWER" });
    const reader = createConversationReader({ store, now: () => 10_000 });
    expect((await reader.stateOf(KEY))!.questions).toHaveLength(1);
    const found = await reader.pendingContacts();
    expect(found).toEqual([{ contactKey: KEY, questions: [expect.objectContaining({ messageId: "w1", topic: "MEDIA_IMAGE", status: "OPEN" })] }]);
    expect(JSON.stringify(found)).not.toMatch(/"text"|"body"/);
  });

  it("ante un fallo de la base responde «no se sabe» (undefined), nunca «no hay nada»", async () => {
    const broken: ConversationStore = { append: async () => ({ recorded: 0, duplicate: 0 }), read: async () => { throw new Error("down"); }, contactsSince: async () => { throw new Error("down"); } };
    const reader = createConversationReader({ store: broken });
    expect(await reader.stateOf(KEY)).toBeUndefined();
    expect(await reader.pendingContacts()).toBeUndefined();
  });
});

describe("configuración: PLUSMEDIK_CONV_STATE", () => {
  const store = memoryStore();
  const resolve = (env: Record<string, string | undefined>) => {
    const log = vi.fn();
    return { recorder: resolveConversationState(env, log, { store, contactKeyFor: () => KEY }), log };
  };

  it("ausente, vacío u «off» = apagado y sin registro nuevo", () => {
    for (const value of [undefined, "", "  ", "off", "OFF"]) {
      const { recorder, log } = resolve({ PLUSMEDIK_CONV_STATE: value });
      expect(recorder, String(value)).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
    }
  });

  it("«shadow» (con mayúsculas o espacios) lo enciende; cualquier otro valor lo deja apagado con un código (una errata no lo enciende)", () => {
    expect(resolve({ PLUSMEDIK_CONV_STATE: " Shadow " }).recorder?.mode).toBe("shadow");
    for (const value of ["on", "true", "1", "shadw", "active"]) {
      const { recorder, log } = resolve({ PLUSMEDIK_CONV_STATE: value });
      expect(recorder, value).toBeUndefined();
      expect(log).toHaveBeenCalledWith("conv_state_config_invalid", { error: "INVALID_VALUE" });
    }
  });

  it("la retención válida (1–365) se usa; una inválida se ignora y rige la de siempre", async () => {
    for (const [value, expected] of [["7", 7], ["365", 365], ["0", undefined], ["366", undefined], ["abc", undefined], ["", undefined], ["2.5", undefined]] as const) {
      const append = vi.fn(async (_key: string, _rows: readonly unknown[], _days?: number) => ({ recorded: 1, duplicate: 0 }));
      const log = vi.fn();
      const recorder = resolveConversationState({ PLUSMEDIK_CONV_STATE: "shadow", PLUSMEDIK_CONV_STATE_RETENTION_DAYS: value }, log, { store: { append, read: async () => [], contactsSince: async () => [] }, contactKeyFor: () => KEY })!;
      recorder.humanResume({ contactKey: KEY, operationId: "op" });
      await recorder.flush();
      expect(append.mock.calls[0]![2], value).toBe(expected);
    }
  });
});
