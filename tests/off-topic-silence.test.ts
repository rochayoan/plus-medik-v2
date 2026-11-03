import { describe, expect, it, vi } from "vitest";
import {
  createConversationModel, looksMedical, MODEL_INTENTS, nothingPending,
  type ConversationClient, type ConversationContext, type ConversationModel, type ConversationOutcome
} from "../src/conversation-model.js";
import { buildPromptSource, resolveConversationModel } from "../src/conversation-openai.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { IncomingTurn, TurnHandlerContext } from "../src/turns.js";

// Silencio ante mensajes CLARAMENTE ajenos al laboratorio (PLUSMEDIK_LLM_SILENCE_OFF_TOPIC, apagado por defecto). Todo con un cliente SIMULADO: ninguna prueba llama a OpenAI.
// Lo que se fija: el modelo solo PROPONE el silencio; el sistema lo confirma solo si (1) la categoría es OTHER, (2) sabe con certeza que no hay nada pendiente con el contacto y (3) el texto no
// menciona nada del laboratorio. Cualquier otra cosa (pendientes, contexto desconocido, falla del modelo, bandera apagada) se responde como siempre.

const SENTINEL = "ZETA9QX";
const POLITE = "¡Hola! Estoy aquí para ayudarte con tus estudios. ¿Qué necesitas?";

type Step = Record<string, unknown> | string | Error;
function fakeClient(...steps: Step[]) {
  const calls: Array<Parameters<ConversationClient["complete"]>[0]> = [];
  const queue = [...steps];
  const client: ConversationClient = {
    complete: vi.fn(async (input) => {
      calls.push(input);
      const step = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (step instanceof Error) throw step;
      return { text: typeof step === "string" ? step : JSON.stringify(step), usage: { inputTokens: 11, outputTokens: 7 } };
    })
  };
  return { client, calls };
}
const answer = (intent: string, reply = POLITE) => ({ intent, reply });
function modelWith(client: ConversationClient, overrides: Partial<Parameters<typeof createConversationModel>[0]> = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const model = createConversationModel({ client, prompt: "PROMPT_DE_PRUEBA", promptId: "abc123def456", model: "modelo-de-prueba", log: (event, data) => logs.push([event, data]), ...overrides });
  return { model, logs };
}
const CLEAR: ConversationContext = { openRequest: false, openStudies: 0, openDoubt: false, recentQuoteStudies: 0 };
const OFF = "¿Quién ganó el partido de anoche?";

describe("nothingPending: el sistema debe saber CON CERTEZA que no hay nada pendiente", () => {
  it("solo un contexto conocido y vacío cuenta como «nada pendiente»", () => {
    expect(nothingPending(CLEAR)).toBe(true);
    // sin contexto (no se pudo calcular, o hay mensajes anteriores aún en proceso) NO se sabe
    expect(nothingPending(undefined)).toBe(false);
    expect(nothingPending({ ...CLEAR, openRequest: true })).toBe(false);
    expect(nothingPending({ ...CLEAR, openRequest: true, openStudies: 2 })).toBe(false);
    expect(nothingPending({ ...CLEAR, openDoubt: true })).toBe(false);
    expect(nothingPending({ ...CLEAR, openStudies: 1 })).toBe(false);
    expect(nothingPending({ ...CLEAR, recentQuoteStudies: 3 })).toBe(false);
  });
});

describe("createConversationModel con silenceOffTopic", () => {
  it("OFF_TOPIC + bandera + categoría OTHER + nada pendiente => SILENT: una sola consulta, sin texto en el registro", async () => {
    const { client, calls } = fakeClient(answer("OFF_TOPIC"));
    const { model, logs } = modelWith(client, { silenceOffTopic: true });
    expect(model.silencesOffTopic).toBe(true);
    expect(await model.reply({ text: `${OFF} ${SENTINEL}`, category: "OTHER", context: CLEAR })).toEqual({ status: "SILENT" });
    expect(calls).toHaveLength(1);
    expect(logs).toEqual([["llm_conversation", expect.objectContaining({ outcome: "SILENT", intent: "OFF_TOPIC", category: "OTHER", model: "modelo-de-prueba", prompt: "abc123def456" })]]);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain("partido");
    expect(JSON.stringify(logs)).not.toContain("Estoy aquí");
  });

  it("SIN la bandera (por defecto) OFF_TOPIC se atiende como cualquier conversación: nunca calla", async () => {
    const { client } = fakeClient(answer("OFF_TOPIC"));
    const { model } = modelWith(client);
    expect(model.silencesOffTopic).toBe(false);
    expect(await model.reply({ text: OFF, category: "OTHER", context: CLEAR })).toEqual({ status: "REPLY", body: POLITE, intent: "OFF_TOPIC" });
  });

  it("con CUALQUIER cosa pendiente se responde: solicitud abierta, duda por aclarar o cotización reciente", async () => {
    const pending: ConversationContext[] = [
      { ...CLEAR, openRequest: true, openStudies: 2 },
      { ...CLEAR, openRequest: true, openStudies: 0, openDoubt: true },
      { ...CLEAR, recentQuoteStudies: 2 },
      { openRequest: true, openStudies: 1, openDoubt: true, recentQuoteStudies: 1 }
    ];
    for (const context of pending) {
      const { client } = fakeClient(answer("OFF_TOPIC"));
      const { model } = modelWith(client, { silenceOffTopic: true });
      expect(await model.reply({ text: OFF, category: "OTHER", context }), JSON.stringify(context)).toEqual({ status: "REPLY", body: POLITE, intent: "OFF_TOPIC" });
    }
  });

  it("si no se pudo conocer el estado de la conversación (sin contexto) se responde: ante la duda no se calla", async () => {
    const { client } = fakeClient(answer("OFF_TOPIC"));
    const { model } = modelWith(client, { silenceOffTopic: true });
    expect(await model.reply({ text: OFF, category: "OTHER" })).toEqual({ status: "REPLY", body: POLITE, intent: "OFF_TOPIC" });
  });

  it("solo se calla en la categoría OTHER: un saludo o un pedido de cotización nunca se silencian", async () => {
    for (const category of ["GREETING", "RECIPE_OR_QUOTE"] as const) {
      const { client } = fakeClient(answer("OFF_TOPIC"));
      const { model } = modelWith(client, { silenceOffTopic: true, categories: ["GREETING", "OTHER", "RECIPE_OR_QUOTE"] });
      expect(await model.reply({ text: OFF, category, context: CLEAR }), category).toMatchObject({ status: "REPLY" });
    }
  });

  it("quien interpreta si es del laboratorio es el modelo: sin listas de palabras, lo que clasifica como del laboratorio (o ambiguo) se responde y solo su OFF_TOPIC se silencia", async () => {
    // el sistema no mira temas: con el mismo texto, el resultado sigue SOLO a la intención del modelo
    for (const [text, intent, silent] of [
      ["¿mis resultados ya salieron? y viste el partido", "UNCLEAR", false],
      ["necesito sacar una cita", "SMALL_TALK", false],
      ["jaja y los análisis para cuándo", "HOW_IT_WORKS", false],
      ["viste el partido de anoche", "OFF_TOPIC", true]
    ] as const) {
      const { client } = fakeClient(answer(intent));
      const { model } = modelWith(client, { silenceOffTopic: true });
      const outcome = await model.reply({ text, category: "OTHER", context: CLEAR });
      expect(outcome.status, text).toBe(silent ? "SILENT" : "REPLY");
    }
  });

  it("protección médica: si el texto parece de salud, aunque el modelo diga OFF_TOPIC se responde (nunca se silencia)", async () => {
    for (const text of ["me duele mucho la cabeza y tengo fiebre", "tengo diabetes, ¿qué hago?"]) {
      expect(looksMedical(text), text).toBe(true);
      const { client } = fakeClient(answer("OFF_TOPIC"));
      const { model } = modelWith(client, { silenceOffTopic: true });
      expect(await model.reply({ text, category: "OTHER", context: CLEAR }), text).toMatchObject({ status: "REPLY" });
    }
  });

  it("las demás intenciones nunca callan, aunque no haya nada pendiente: UNCLEAR, SMALL_TALK, QUOTE_REQUEST...", async () => {
    for (const intent of ["UNCLEAR", "SMALL_TALK", "QUOTE_REQUEST", "HOW_IT_WORKS", "THANKS", "GREETING"]) {
      const { client } = fakeClient(answer(intent));
      const { model } = modelWith(client, { silenceOffTopic: true });
      expect(await model.reply({ text: OFF, category: "OTHER", context: CLEAR }), intent).toMatchObject({ status: "REPLY", intent });
    }
  });

  it("lo médico, pedir a una persona y la información se reencaminan como siempre (OFF_TOPIC no los toca)", async () => {
    for (const [intent, category] of [["MEDICAL", "MEDICAL"], ["HUMAN_REQUEST", "HUMAN_REQUEST"], ["INFO_REQUEST", "INFO_REQUEST"]] as const) {
      const { client } = fakeClient(answer(intent, ""));
      const { model } = modelWith(client, { silenceOffTopic: true });
      expect(await model.reply({ text: OFF, category: "OTHER", context: CLEAR }), intent).toEqual({ status: "REROUTE", category });
    }
  });

  it("cualquier falla del modelo (error, tiempo, salida inválida, filtro) NO calla: vuelve al texto fijo", async () => {
    const failures: Step[] = [new Error("boom"), Object.assign(new Error("slow"), { name: "TimeoutError" }), "no es json", { intent: "OFF_TOPIC", reply: "Cuesta 45 bolivianos" }];
    for (const step of failures) {
      const { client } = fakeClient(step);
      const { model } = modelWith(client, { silenceOffTopic: true });
      const outcome = await model.reply({ text: OFF, category: "OTHER", context: CLEAR });
      // el filtro de salida solo se aplica si NO se calla: una respuesta rechazada con OFF_TOPIC confirmado aún se silencia; las fallas del proveedor nunca
      expect(outcome.status === "FALLBACK" || outcome.status === "SILENT", JSON.stringify(step)).toBe(true);
      if (step instanceof Error || step === "no es json") expect(outcome).toMatchObject({ status: "FALLBACK" });
    }
  });

  it("sin la categoría OTHER habilitada la bandera no hace nada", async () => {
    const { client } = fakeClient(answer("OFF_TOPIC"));
    const { model } = modelWith(client, { silenceOffTopic: true, categories: ["GREETING"] });
    expect(model.silencesOffTopic).toBe(false);
  });

  it("OFF_TOPIC es una intención del esquema", () => {
    expect(MODEL_INTENTS).toContain("OFF_TOPIC");
  });
});

describe("el prompt real define OFF_TOPIC de forma estricta", () => {
  const prompt = buildPromptSource().prompt;
  it("nombra OFF_TOPIC, lo restringe a lo CLARAMENTE ajeno y manda a UNCLEAR o SMALL_TALK ante la menor duda o una conversación empezada", () => {
    expect(prompt).toMatch(/- OFF_TOPIC: tú decides si el mensaje tiene relación con el laboratorio o es una conversación personal o ajena/);
    expect(prompt).toMatch(/leyendo el mensaje y el "Estado de la conversación"/);
    expect(prompt).toMatch(/estudios, análisis, exámenes, recetas u órdenes, precios, cotizaciones, resultados, citas, horarios, sucursales, pagos, servicios/);
    expect(prompt).toMatch(/solo lo CLARAMENTE ajeno/);
    expect(prompt).toMatch(/si el mensaje es ambiguo|Si el mensaje es ambiguo/);
    expect(prompt).toMatch(/continúa algo ya empezado, NO uses OFF_TOPIC: elige UNCLEAR o SMALL_TALK/);
    // el prompt sigue con UN marcador de datos y sin importes ni enlaces
    expect(prompt.split("{{DATOS}}")).toHaveLength(2);
    expect(prompt).not.toMatch(/https?:\/\/|@|\+?\d[\d ]{6,}\d|\b(bs|bob|usd)\b|\$/i);
  });
});

describe("resolveConversationModel: la bandera PLUSMEDIK_LLM_SILENCE_OFF_TOPIC", () => {
  const complete = { PLUSMEDIK_LLM_CONVERSATION: "on", OPENAI_CONVERSATION_MODEL: "modelo-de-prueba", OPENAI_API_KEY: "clave-de-prueba" };
  const resolve = (env: Record<string, string | undefined>) => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const model = resolveConversationModel(env, (event, data) => { if (event !== "llm_conversation_source") logs.push([event, data]); }, { responseGuardActive: true });
    return { model, logs };
  };

  it("APAGADA por defecto: sin la variable (o con cualquier otro valor) el modelo no silencia nada y no se registra ningún aviso", () => {
    for (const value of [undefined, "", "off", "true", "1", "yes", "shadow"]) {
      const { model, logs } = resolve({ ...complete, PLUSMEDIK_LLM_SILENCE_OFF_TOPIC: value });
      expect(model!.silencesOffTopic, String(value)).toBe(false);
      expect(logs, String(value)).toEqual([]);
    }
  });

  it("«on» (sin importar mayúsculas ni espacios) la enciende y queda en la huella del prompt", () => {
    for (const value of ["on", " ON ", "On"]) expect(resolve({ ...complete, PLUSMEDIK_LLM_SILENCE_OFF_TOPIC: value }).model!.silencesOffTopic, value).toBe(true);
  });

  it("con la bandera APAGADA el modelo recibe el prompt de antes (sin la descripción de OFF_TOPIC); encendida, sí la recibe", async () => {
    const seen: string[] = [];
    const client: ConversationClient = { complete: vi.fn(async (input) => { seen.push(input.instructions); return { text: JSON.stringify({ intent: "SMALL_TALK", reply: POLITE }), usage: { inputTokens: 1, outputTokens: 1 } }; }) };
    for (const value of [undefined, "off", "on"]) {
      const model = resolveConversationModel({ ...complete, ...(value ? { PLUSMEDIK_LLM_SILENCE_OFF_TOPIC: value } : {}) }, () => undefined, { responseGuardActive: true, client });
      await model!.reply({ text: "hola, ¿cómo estás?", category: "OTHER", context: CLEAR });
    }
    expect(seen).toHaveLength(3);
    expect(seen[0]).not.toContain("OFF_TOPIC");
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toContain("- OFF_TOPIC:");
    // salvo esa línea, el prompt es idéntico
    expect(seen[2]!.replace(/^- OFF_TOPIC:.*\r?\n/m, "")).toBe(seen[0]);
  });

  it("sin la conversación con modelo la bandera sola no crea nada", () => {
    const { model, logs } = resolve({ PLUSMEDIK_LLM_SILENCE_OFF_TOPIC: "on" });
    expect(model).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("con las categorías sin OTHER no se activa y registra solo un código (la conversación sigue)", () => {
    const { model, logs } = resolve({ ...complete, PLUSMEDIK_LLM_SILENCE_OFF_TOPIC: "on", PLUSMEDIK_LLM_CATEGORIES: "GREETING" });
    expect(model).toBeDefined();
    expect(model!.silencesOffTopic).toBe(false);
    expect(logs).toEqual([["llm_conversation_config_invalid", { error: "SILENCE_NEEDS_OTHER" }]]);
  });
});

describe("manejador de texto: el silencio no responde nada", () => {
  const turn = (text: string): IncomingTurn => ({ messageId: "wamid.off1", from: "59170000000", kind: "TEXT", text });
  const stub = (outcome: ConversationOutcome | Error, silences = true) => {
    const reply = vi.fn(async (_input: Parameters<ConversationModel["reply"]>[0]) => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const model: ConversationModel = { categories: new Set(["GREETING", "OTHER"]), businessInfo: false, silencesOffTopic: silences, reply };
    return { model, reply };
  };
  const contextWith = (memory: TurnHandlerContext["memory"]): TurnHandlerContext => ({ quotedStudyIds: async () => [], ...(memory ? { memory } : {}) });
  function setup(conversation: ConversationModel, extra: { attention?: boolean } = {}) {
    const logs: Array<[string, Record<string, unknown>]> = [];
    return { logs, handler: createTextHandler({ conversation, ...(extra.attention ? { attention: true } : {}), log: (event, data) => logs.push([event, data]) }) };
  }

  it("cuando el modelo confirma el silencio el manejador devuelve undefined (el turno queda cerrado sin respuesta) y solo registra códigos", async () => {
    const { model, reply } = stub({ status: "SILENT" });
    const { handler, logs } = setup(model);
    const memory = vi.fn(async () => CLEAR);
    expect(await handler(turn(`${OFF} ${SENTINEL}`), contextWith(memory))).toBeUndefined();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(["text_turn", { category: "OTHER", handoff: "none", model: "silent" }]);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain("partido");
  });

  it("pide el estado de la conversación ESPERANDO a los mensajes anteriores del lote (wait) y se lo da al modelo", async () => {
    const { model, reply } = stub({ status: "SILENT" });
    const { handler } = setup(model);
    const memory = vi.fn(async (_options?: { wait?: boolean }) => CLEAR);
    await handler(turn(OFF), contextWith(memory));
    expect(memory).toHaveBeenCalledWith({ wait: true });
    expect(reply).toHaveBeenCalledWith({ text: OFF, category: "OTHER", context: CLEAR });
  });

  it("sin el silencio encendido el estado NO se pide (salvo la atención selectiva, como siempre)", async () => {
    const { model } = stub({ status: "REPLY", body: "Hola", intent: "SMALL_TALK" }, false);
    const memory = vi.fn(async () => CLEAR);
    await setup(model).handler(turn(OFF), contextWith(memory));
    expect(memory).not.toHaveBeenCalled();
    const attended = vi.fn(async (_options?: { wait?: boolean }) => CLEAR);
    await setup(model, { attention: true }).handler(turn(OFF), contextWith(attended));
    expect(attended).toHaveBeenCalledWith({ wait: false });
  });

  it("si el estado no se pudo calcular el modelo recibe solo el mensaje y NO calla", async () => {
    const { model, reply } = stub({ status: "REPLY", body: POLITE, intent: "OFF_TOPIC" });
    const { handler } = setup(model);
    expect(await handler(turn(OFF), contextWith(async () => undefined))).toMatchObject({ body: POLITE });
    expect(await handler(turn(OFF), contextWith(undefined))).toMatchObject({ body: POLITE });
    expect(await handler(turn(OFF), contextWith(async () => { throw new Error("base caída"); }))).toMatchObject({ body: POLITE });
    expect(reply.mock.calls.every(([input]) => input.context === undefined)).toBe(true);
  });

  it("un fallo del modelo responde con el texto fijo de siempre (no se calla)", async () => {
    const { model } = stub(new Error("boom"));
    const { handler } = setup(model);
    expect(await handler(turn(OFF), contextWith(async () => CLEAR))).toMatchObject({ body: DRAFT_TEXTS.fallback });
  });

  it("lo médico, pedir a una persona, la información y lo que lleva palabras de laboratorio NUNCA llegan al modelo, así que jamás se silencian", async () => {
    const { model, reply } = stub({ status: "SILENT" });
    const { handler } = setup(model);
    for (const text of ["me duele la cabeza", "quiero hablar con una persona", "¿cuál es el horario?"]) {
      const result = await handler(turn(text), contextWith(async () => CLEAR));
      expect(result, text).toBeDefined();
    }
    expect(reply).not.toHaveBeenCalled();
    // un pedido de cotización sí puede consultar al modelo, pero con su propia categoría (nunca OTHER) y sin estado pedido con espera: no es candidato al silencio
    const memory = vi.fn(async (_options?: { wait?: boolean }) => CLEAR);
    await handler(turn("quiero cotizar un estudio"), contextWith(memory));
    expect(reply.mock.calls.every(([input]) => input.category !== "OTHER")).toBe(true);
    expect(memory).not.toHaveBeenCalled();
  });

  it("un saludo no se silencia por esta vía (SILENT solo existe para OTHER y el modelo no lo da para saludos)", async () => {
    const { model, reply } = stub({ status: "REPLY", body: "¡Hola! ¿En qué te ayudo?", intent: "GREETING" });
    const { handler } = setup(model);
    expect(await handler(turn("hola"), contextWith(async () => CLEAR))).toMatchObject({ body: "¡Hola! ¿En qué te ayudo?" });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ category: "GREETING" }));
  });
});
