import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Act, AgentModel, HandoffReason, IntentReading, RespondInput } from "../src/agent/contracts.js";
import { createAgentPilot, createPilotSwitch, createRecentProvider, PILOT_LIMITS, type PilotSwitch } from "../src/agent/pilot.js";
import { AGENT_SCENARIOS } from "../scripts/g7/lib/agent-scenarios.js";
import { CONTACT_KEY, FIXTURE_CATALOG, fixtureAnswer, NOW, PHONE } from "../scripts/g7/lib/agent-scenarios.js";
import type { ObservedTurn } from "../src/conversation-state-store.js";

// Piloto del nuevo agente: la lista de números, el interruptor que falla cerrado, la decisión (y su respaldo al agente de siempre ante CUALQUIER problema), la derivación real y la configuración.

const turn = (id: string, text: string): ObservedTurn => ({ messageId: id, kind: "TEXT", text });
const quoteScenario = AGENT_SCENARIOS.find((scenario) => scenario.id === "cotizar-por-nombre")!;

interface ModelScript { calls?: Array<{ tool: string; input: unknown }>; intents?: IntentReading[]; acts?: (input: RespondInput) => Act[]; text?: string; failPlan?: Error; hang?: boolean }
function fakeModel(script: ModelScript = {}): AgentModel & { plans: number; responds: RespondInput[] } {
  const model = {
    plans: 0,
    responds: [] as RespondInput[],
    async plan() {
      model.plans += 1;
      if (script.hang) return new Promise<never>(() => undefined);
      if (script.failPlan) throw script.failPlan;
      return { toolCalls: script.calls ?? [], ...(script.intents ? { intents: script.intents } : {}) };
    },
    async respond(input: RespondInput) {
      model.responds.push(input);
      return { acts: script.acts ? script.acts(input) : [{ kind: "ACK" as const, utterances: input.utterances.map((u) => u.id) }], text: script.text ?? "¡Hola! ¿En qué te puedo ayudar?" };
    }
  };
  return model;
}
const switchOf = (value: boolean | (() => Promise<boolean>)): PilotSwitch & { reads: number } => {
  const s = { reads: 0, async enabled() { s.reads += 1; return typeof value === "function" ? value() : value; } };
  return s;
};

function make(overrides: Partial<Parameters<typeof createAgentPilot>[0]> = {}, script: ModelScript = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const model = fakeModel(script);
  const pilotSwitch = switchOf(true);
  const pilot = createAgentPilot({
    model, modelName: "modelo-x", phones: new Set([PHONE]), switch: pilotSwitch,
    context: { loadCatalog: async () => FIXTURE_CATALOG, answer: fixtureAnswer, contactKeyFor: (phone) => (phone.replace(/\D/g, "") === PHONE ? CONTACT_KEY : undefined), now: () => NOW },
    log: (event, data) => { logs.push([event, data]); }, now: () => NOW, ...overrides
  });
  return { pilot, model, logs, pilotSwitch: (overrides.switch as ReturnType<typeof switchOf> | undefined) ?? pilotSwitch };
}
const pilotLogs = (logs: Array<[string, Record<string, unknown>]>) => logs.filter(([event]) => event === "agent_pilot").map(([, data]) => data);

describe("la lista de números", () => {
  it("solo los teléfonos de la lista (por sus dígitos) son del piloto; cualquier otro ni consulta el interruptor ni el modelo", async () => {
    const { pilot, model, pilotSwitch, logs } = make();
    expect(pilot.isPilot(PHONE)).toBe(true);
    expect(pilot.isPilot(`+${PHONE}`)).toBe(true);
    expect(pilot.isPilot("59170000002")).toBe(false);
    expect(pilot.isPilot("9170000001")).toBe(false);
    expect(pilot.isPilot(`${PHONE}9`)).toBe(false);
    expect(await pilot.produce({ from: "59170000002", turns: [turn("w1", "hola")] })).toBeUndefined();
    expect(model.plans).toBe(0);
    expect(pilotSwitch.reads).toBe(0);
    expect(logs).toEqual([]);
  });
});

describe("el interruptor falla cerrado y apaga de inmediato", () => {
  it("apagado: responde la ruta de siempre y no se toca el modelo", async () => {
    const { pilot, model, logs } = make({ switch: switchOf(false) });
    expect(await pilot.produce({ from: PHONE, turns: [turn("w1", "hola")] })).toBeUndefined();
    expect(model.plans).toBe(0);
    expect(pilotLogs(logs)).toEqual([{ status: "FALLBACK", reason: "SWITCH_OFF" }]);
  });

  it("ilegible (la base falla): se trata como apagado", async () => {
    const rpc = vi.fn(async () => { throw Object.assign(new Error("caído"), { kind: "UNAVAILABLE" }); });
    const logs: Array<[string, Record<string, unknown>]> = [];
    const pilotSwitch = createPilotSwitch({ rpc, log: (event, data) => { logs.push([event, data]); } });
    expect(await pilotSwitch.enabled()).toBe(false);
    expect(logs[0]![1]).toMatchObject({ enabled: false, unreadable: true });
    expect(JSON.stringify(logs)).not.toContain("caído");
  });

  it("se lee con un vencimiento corto: dentro de él no se vuelve a consultar y al vencer un «apagado» de la base se aplica; un error NO reutiliza un «encendido» viejo", async () => {
    let clock = 1_000;
    let answer: boolean | Error = true;
    const rpc = vi.fn(async () => { if (answer instanceof Error) throw answer; return { enabled: answer }; });
    const pilotSwitch = createPilotSwitch({ rpc, ttlMs: 5000, now: () => clock, log: () => undefined });
    expect(await pilotSwitch.enabled()).toBe(true);
    clock += 4000; answer = false;
    expect(await pilotSwitch.enabled()).toBe(true); // aún dentro del vencimiento
    expect(rpc).toHaveBeenCalledTimes(1);
    clock += 1500;
    expect(await pilotSwitch.enabled()).toBe(false); // el apagado de la base se aplica en cuanto vence
    clock += 6000; answer = true;
    expect(await pilotSwitch.enabled()).toBe(true);
    clock += 6000; answer = new Error("caído");
    expect(await pilotSwitch.enabled()).toBe(false);
    expect(await pilotSwitch.enabled()).toBe(false);
  });

  it("varias lecturas simultáneas comparten una sola consulta; solo el valor `true` exacto enciende", async () => {
    const rpc = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { enabled: true }; });
    const pilotSwitch = createPilotSwitch({ rpc, log: () => undefined });
    expect(await Promise.all([pilotSwitch.enabled(), pilotSwitch.enabled(), pilotSwitch.enabled()])).toEqual([true, true, true]);
    expect(rpc).toHaveBeenCalledTimes(1);
    for (const value of ["true", 1, null, undefined, "yes"]) expect(await createPilotSwitch({ rpc: async () => ({ enabled: value }), log: () => undefined }).enabled(), String(value)).toBe(false);
    expect(PILOT_LIMITS.switchTtlMs).toBeLessThanOrEqual(5000);
  });
});

describe("la decisión", () => {
  it("entrega la respuesta verificada con su resultado, firma, calidad y tope propio; los registros llevan solo códigos", async () => {
    const { pilot, logs } = make({ dailyCap: { max: 40, windowSeconds: 86_400 } }, { text: "¡Hola! Cuéntame qué necesitas y te ayudo." });
    const reply = await pilot.produce({ from: PHONE, turns: [turn("wamid.A", "hola, soy Maria Perez 71234567")] });
    expect(reply).toMatchObject({ body: "¡Hola! Cuéntame qué necesitas y te ayudo.", result: "conversation", processingStatus: "COMPLETED", stale: "NEWER_TURN", signature: "agent:ACK", quality: "ANSWER", cap: { max: 40, windowSeconds: 86_400 }, quotedStudyIds: [] });
    expect(pilotLogs(logs)[0]).toMatchObject({ status: "VERIFIED", model: "modelo-x", acts: { ACK: 1 } });
    expect(JSON.stringify(logs)).not.toMatch(/Maria|Perez|71234567|wamid|Cuéntame|59170000001/);
  });

  it("una cotización sale como «quoted» con los precios del catálogo agregados por el sistema y los ids de estudios para la memoria", async () => {
    const { pilot, model } = make({}, { calls: [{ tool: "quote_studies", input: { studies: ["hemograma", "glucosa"] } }], acts: () => [{ kind: "QUOTE", utterances: ["U1"] }], text: "¡Claro! Abajo tienes el detalle de tu cotización." });
    const reply = await pilot.produce({ from: PHONE, turns: [turn("w1", "cuanto cuesta un hemograma y una glucosa?")] });
    expect(reply).toMatchObject({ result: "quoted", quality: "QUOTE", signature: "agent:QUOTE" });
    expect(reply!.body).toMatch(/HEMOGRAMA COMPLETO[\s\S]*GLUCOSA EN AYUNAS[\s\S]*75[.,]5/);
    expect(reply!.quotedStudyIds.sort()).toEqual(["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
    expect(JSON.stringify(model.responds)).not.toMatch(/\b45\b|Bs/);
    expect(quoteScenario.expect.quoteBlock).toBe(true);
  });

  it("una cotización PARCIAL (un estudio dudoso junto a uno seguro) se envía con los precios del seguro y deja lo dudoso pendiente a la vista", async () => {
    const { pilot } = make({}, { calls: [{ tool: "quote_studies", input: { studies: ["hemograma", "creatinina"] } }], acts: () => [{ kind: "QUOTE", utterances: ["U1"] }, { kind: "CLARIFY", utterances: ["U1"], code: "WHICH_STUDY" }], text: "Te dejo abajo el hemograma; para la creatinina, ¿la quieres sérica o en orina?" });
    const reply = await pilot.produce({ from: PHONE, turns: [turn("w1", "cuanto cuesta un hemograma y una creatinina?")] });
    expect(reply).toMatchObject({ result: "quoted", quality: "UNRESOLVED" });
    expect(reply!.body).toMatch(/HEMOGRAMA COMPLETO[\s\S]*45/);
    expect(reply!.body).toMatch(/sérica o en orina/);
    expect(reply!.quotedStudyIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("lo aplazado queda visible para la memoria: DEFER = sin resolver; DEFER de salud o de «quiero una persona» = sin derivación", async () => {
    const defer = (reason: "NO_DATA" | "NOT_SUPPORTED"): ModelScript["acts"] => (input) => [{ kind: "DEFER", utterances: input.utterances.map((u) => u.id), reason }];
    const unresolved = make({}, { acts: defer("NO_DATA"), text: "No tengo ese dato confirmado por ahora." });
    expect((await unresolved.pilot.produce({ from: PHONE, turns: [turn("w1", "tienen servicio de ambulancia?")] }))?.quality).toBe("UNRESOLVED");
    const medical = make({}, { intents: [{ utterance: "U1", intent: "MEDICAL" }], acts: defer("NOT_SUPPORTED"), text: "Eso conviene consultarlo con tu médico." });
    expect((await medical.pilot.produce({ from: PHONE, turns: [turn("w1", "quiero saber si es normal este valor de mi análisis")] }))?.quality).toBe("BLOCKED");
    const human = make({}, { intents: [{ utterance: "U1", intent: "HUMAN" }], acts: defer("NOT_SUPPORTED"), text: "Por este medio no puedo pasarte con una persona por ahora." });
    expect((await human.pilot.produce({ from: PHONE, turns: [turn("w1", "quiero hablar con una persona")] }))?.quality).toBe("BLOCKED");
  });

  it("la intención la decide el MODELO: si entendió que es de salud aunque las reglas no lo vieran, solo puede derivar o aplazar", async () => {
    const answerFromFacts = make({}, { calls: [{ tool: "lab_info", input: { question: "a que hora abren" } }], intents: [{ utterance: "U1", intent: "MEDICAL" }], acts: () => [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }], text: "Abrimos de 07:00 a 18:00." });
    expect(await answerFromFacts.pilot.produce({ from: PHONE, turns: [turn("w1", "a que hora abren, es para mi examen del azúcar")] })).toBeUndefined();
    expect(pilotLogs(answerFromFacts.logs)[0]).toMatchObject({ status: "REJECTED", violations: expect.arrayContaining(["MEDICAL_NOT_HANDED_OFF"]), intents: ["MEDICAL"] });
  });
});

describe("ante cualquier problema responde la ruta de siempre (undefined)", () => {
  it("modelo caído, verificación fallida (cifra inventada) y precio escrito por el modelo", async () => {
    const quota = Object.assign(new Error("x"), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
    const failed = make({}, { failPlan: quota });
    expect(await failed.pilot.produce({ from: PHONE, turns: [turn("w1", "hola")] })).toBeUndefined();
    expect(pilotLogs(failed.logs)[0]).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "QUOTA_OR_BILLING" } });
    const invented = make({}, { text: "Te respondemos en 24 horas sin falta." });
    expect(await invented.pilot.produce({ from: PHONE, turns: [turn("w1", "hola")] })).toBeUndefined();
    expect(pilotLogs(invented.logs)[0]).toMatchObject({ status: "REJECTED", violations: ["UNGROUNDED_FIGURE"], repairs: 1 });
    const price = make({}, { text: "El hemograma cuesta Bs 45." });
    expect(await price.pilot.produce({ from: PHONE, turns: [turn("w1", "cuanto cuesta un hemograma")] })).toBeUndefined();
  });

  it("un lote sin texto o con una persona al mando no se decide (sin llamar al modelo)", async () => {
    const media = make();
    expect(await media.pilot.produce({ from: PHONE, turns: [{ messageId: "i1", kind: "IMAGE" }] })).toBeUndefined();
    expect(media.model.plans).toBe(0);
    expect(pilotLogs(media.logs)[0]).toMatchObject({ status: "FALLBACK", reason: "NO_TEXT" });
  });

  it("el plazo vence: responde la ruta de siempre, el trabajo tardío ya no puede derivar a nadie", async () => {
    const handoff = vi.fn(async () => true);
    const hung = make({ deadlineMs: 40, handoffEnabled: true }, { hang: true });
    expect(await hung.pilot.produce({ from: PHONE, turns: [turn("w1", "hola")], handoff })).toBeUndefined();
    expect(pilotLogs(hung.logs).at(-1)).toMatchObject({ status: "FALLBACK", reason: "DEADLINE" });
    // un modelo lento que termina DESPUÉS del plazo con un acto HANDOFF: no se registra ningún caso tardío
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slowModel: AgentModel = { async plan() { await gate; return { toolCalls: [] }; }, async respond(input) { return { acts: [{ kind: "HANDOFF", utterances: input.utterances.map((u) => u.id), reason: "HUMAN_REQUEST" }], text: "Te paso con una persona del laboratorio." }; } };
    const slow = make({ model: slowModel, deadlineMs: 30, handoffEnabled: true });
    expect(await slow.pilot.produce({ from: PHONE, turns: [turn("w1", "quiero hablar con una persona")], handoff })).toBeUndefined();
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handoff).not.toHaveBeenCalled();
  });
});

describe("la derivación humana al CRM", () => {
  const humanAct: ModelScript["acts"] = (input) => [{ kind: "HANDOFF", utterances: input.utterances.map((u) => u.id), reason: "HUMAN_REQUEST" }];
  const script: ModelScript = { acts: humanAct, text: "Claro, te paso con una persona del laboratorio." };
  const turns = [turn("w1", "quiero hablar con una persona")];

  it("sin ejecutor (no hay cola al CRM) o sin habilitar, HANDOFF no existe: el plan se rechaza y responde la ruta de siempre", async () => {
    const none = make({ handoffEnabled: true }, script);
    expect(await none.pilot.produce({ from: PHONE, turns })).toBeUndefined();
    expect(pilotLogs(none.logs)[0]).toMatchObject({ status: "REJECTED", violations: ["HANDOFF_UNAVAILABLE"] });
    const disabled = make({ handoffEnabled: false }, script);
    const handoff = vi.fn(async () => true);
    expect(await disabled.pilot.produce({ from: PHONE, turns, handoff })).toBeUndefined();
    expect(handoff).not.toHaveBeenCalled();
    expect(disabled.model.responds.at(0)!.capabilities.handoff).toBe(false);
  });

  it("con la derivación habilitada y un ejecutor: el caso se registra UNA vez ANTES de entregar el mensaje, y el mensaje puede decir que una persona atenderá", async () => {
    const order: string[] = [];
    const handoff = vi.fn(async (reason: HandoffReason) => { order.push(`registrar:${reason}`); return true; });
    const { pilot, logs, model } = make({ handoffEnabled: true }, script);
    const reply = await pilot.produce({ from: PHONE, turns, handoff });
    order.push("entregar");
    expect(order).toEqual(["registrar:HUMAN_REQUEST", "entregar"]);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(reply).toMatchObject({ body: "Claro, te paso con una persona del laboratorio.", signature: "agent:HANDOFF" });
    expect(pilotLogs(logs)[0]).toMatchObject({ status: "VERIFIED", handoff: "REGISTERED", acts: { HANDOFF: 1 } });
    expect(model.responds[0]!.capabilities.handoff).toBe(true);
  });

  it("si el CRM no registra el caso (o falla), NO se promete nada: responde la ruta de siempre", async () => {
    for (const executor of [async () => false, async () => { throw new Error("CRM caído"); }]) {
      const { pilot, logs } = make({ handoffEnabled: true }, script);
      expect(await pilot.produce({ from: PHONE, turns, handoff: executor })).toBeUndefined();
      expect(pilotLogs(logs)[0]).toMatchObject({ status: "HANDOFF_FAILED" });
      expect(JSON.stringify(logs)).not.toContain("CRM caído");
    }
  });
});

describe("mensajes recientes del historial", () => {
  const rows = [
    { direction: "IN", actor: "PATIENT", body: "hola, cuanto cuesta un hemograma?" },
    { direction: "OUT", actor: "AGENT", body: "Aquí tienes la cotización." },
    { direction: "OUT", actor: "HUMAN", body: "Le atiende recepción." },
    { direction: "OUT", actor: "OTHER_APP", body: "mensaje de otra aplicación" },
    { direction: "IN", actor: "PATIENT", body: "me duele el pecho y tengo fiebre" },
    { direction: "IN", actor: "PATIENT", body: "mi médico me pidió vitamina B12" },
    { direction: "IN", actor: "PATIENT", body: "   " },
    "basura", null
  ];

  it("traduce quién habló, conserva el texto tal cual, ignora lo ilegible y pide solo lo necesario a la base", async () => {
    const rpc = vi.fn(async () => ({ messages: rows }));
    const recent = createRecentProvider({ rpc, now: () => NOW });
    const entries = await recent({ from: PHONE, messageId: "w9", contactKey: CONTACT_KEY, excludeIds: ["w8", "w9"] });
    expect(entries).toEqual([
      { from: "PATIENT", text: "hola, cuanto cuesta un hemograma?" },
      { from: "ASSISTANT", text: "Aquí tienes la cotización." },
      { from: "STAFF", text: "Le atiende recepción." },
      { from: "PATIENT", text: "me duele el pecho y tengo fiebre" },
      { from: "PATIENT", text: "mi médico me pidió vitamina B12" }
    ]);
    expect(rpc).toHaveBeenCalledWith("plusmedik_history_recent", { p_contact_key: CONTACT_KEY, p_limit: PILOT_LIMITS.recentLimit, p_exclude: ["w8", "w9"], p_since: new Date(NOW - PILOT_LIMITS.recentWindowMs).toISOString() });
  });

  it("una respuesta de forma inesperada es vacía; un fallo de la base se propaga a quien llama (que sigue sin historial)", async () => {
    expect(await createRecentProvider({ rpc: async () => ({ messages: "nada" }) })({ from: PHONE, messageId: "w", contactKey: CONTACT_KEY, excludeIds: [] })).toEqual([]);
    await expect(createRecentProvider({ rpc: async () => { throw new Error("down"); } })({ from: PHONE, messageId: "w", contactKey: CONTACT_KEY, excludeIds: [] })).rejects.toThrow();
  });
});

describe("alcance global: todos los contactos elegibles, exclusiones y corta-circuito", () => {
  const keyOf = (phone: string): string => createHash("sha256").update(`clave-de-prueba:${phone.replace(/\D/g, "")}`).digest("hex");
  const live = (options: { exclude?: string[]; clock?: { now: number }; script?: ModelScript; keyFor?: (phone: string) => string | undefined } = {}) => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const model = fakeModel(options.script ?? {});
    const pilotSwitch = switchOf(true);
    const clock = options.clock ?? { now: NOW };
    const keyFor = options.keyFor ?? keyOf;
    const pilot = createAgentPilot({
      model, modelName: "modelo-x", switch: pilotSwitch,
      everyone: { exclude: new Set(options.exclude ?? []), contactKeyFor: keyFor },
      context: { loadCatalog: async () => FIXTURE_CATALOG, answer: fixtureAnswer, contactKeyFor: keyFor, now: () => clock.now },
      log: (event, data) => { logs.push([event, data]); }, now: () => clock.now
    });
    return { pilot, model, logs, pilotSwitch };
  };
  const phones = Array.from({ length: 400 }, (_, i) => `5917${String(1000000 + i)}`);

  it("TODOS los contactos que se puedan identificar son elegibles (sin porcentajes ni listas); sin la clave del contacto NO entra nadie, ni se consulta el interruptor ni el modelo", async () => {
    const { pilot } = live();
    expect(phones.every((phone) => pilot.isPilot(phone))).toBe(true);
    expect(pilot.mode).toBe("live");
    const unidentified = live({ keyFor: () => undefined });
    expect(phones.some((phone) => unidentified.pilot.isPilot(phone))).toBe(false);
    expect(await unidentified.pilot.produce({ from: phones[0]!, turns: [turn("w1", "hola")] })).toBeUndefined();
    expect(unidentified.model.plans).toBe(0);
    expect(unidentified.pilotSwitch.reads).toBe(0);
  });

  it("los números excluidos siguen SIEMPRE con el agente de siempre; los demás no se ven afectados", async () => {
    const { pilot, model, pilotSwitch } = live({ exclude: ["59170000009"] });
    expect(pilot.isPilot("+59170000009")).toBe(false);
    expect(await pilot.produce({ from: "59170000009", turns: [turn("w1", "hola")] })).toBeUndefined();
    expect(model.plans).toBe(0);
    expect(pilotSwitch.reads).toBe(0);
    expect(pilot.isPilot("59170000010")).toBe(true);
  });

  it("un contacto elegible con el interruptor encendido recibe la decisión del agente nuevo", async () => {
    const { pilot, model } = live({ script: { text: "¡Hola! Con gusto te ayudo, cuéntame qué necesitas." } });
    const reply = await pilot.produce({ from: "59170000010", turns: [turn("w1", "hola")] });
    expect(reply).toMatchObject({ body: "¡Hola! Con gusto te ayudo, cuéntame qué necesitas.", result: "conversation", quality: "ANSWER" });
    expect(model.plans).toBe(1);
  });

  it("CORTA-CIRCUITO: tras 3 fallos seguidos del modelo deja de esperarlo un minuto (todos responden por la ruta de siempre al instante) y luego reintenta", async () => {
    const clock = { now: NOW };
    const quota = Object.assign(new Error("x"), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
    const { pilot, model, logs } = live({ clock, script: { failPlan: quota } });
    const from = "59170000001";
    for (let i = 0; i < 3; i++) expect(await pilot.produce({ from, turns: [turn(`w${i}`, "hola")] })).toBeUndefined();
    expect(model.plans).toBe(3);
    expect(logs.filter(([event]) => event === "agent_pilot_breaker")).toHaveLength(1);
    // abierto: sin llamar al modelo
    expect(await pilot.produce({ from, turns: [turn("w4", "hola")] })).toBeUndefined();
    expect(model.plans).toBe(3);
    expect(pilotLogs(logs).at(-1)).toMatchObject({ status: "FALLBACK", reason: "BREAKER_OPEN" });
    clock.now += PILOT_LIMITS.breakerOpenMs + 1;
    await pilot.produce({ from, turns: [turn("w5", "hola")] });
    expect(model.plans).toBe(4);
  });

  it("el corta-circuito cuenta SOLO fallos del proveedor: un éxito lo reinicia y un rechazo del verificador no lo abre", async () => {
    const quota = Object.assign(new Error("x"), { status: 429, code: "insufficient_quota" });
    let fail = true;
    const flaky: AgentModel = { async plan() { if (fail) throw quota; return { toolCalls: [] }; }, async respond(input) { return { acts: [{ kind: "ACK", utterances: input.utterances.map((u) => u.id) }], text: "¡Hola! ¿En qué te ayudo?" }; } };
    const logs: Array<[string, Record<string, unknown>]> = [];
    const pilot = createAgentPilot({ model: flaky, modelName: "m", switch: switchOf(true), everyone: { exclude: new Set(), contactKeyFor: keyOf }, context: { loadCatalog: async () => FIXTURE_CATALOG, contactKeyFor: keyOf, now: () => NOW }, log: (event, data) => { logs.push([event, data]); }, now: () => NOW });
    const from = "59170000001";
    await pilot.produce({ from, turns: [turn("a", "hola")] });
    await pilot.produce({ from, turns: [turn("b", "hola")] });
    fail = false;
    expect((await pilot.produce({ from, turns: [turn("c", "hola")] }))?.body).toBe("¡Hola! ¿En qué te ayudo?");
    fail = true;
    await pilot.produce({ from, turns: [turn("d", "hola")] });
    await pilot.produce({ from, turns: [turn("e", "hola")] });
    expect(logs.filter(([event]) => event === "agent_pilot_breaker")).toEqual([]);
    // rechazos del verificador (el modelo FUNCIONÓ): nunca abren el corta-circuito
    const rejecting = live({ script: { text: "Te respondemos en 24 horas sin falta." } });
    for (let i = 0; i < 6; i++) await rejecting.pilot.produce({ from, turns: [turn(`r${i}`, "hola")] });
    expect(rejecting.logs.filter(([event]) => event === "agent_pilot_breaker")).toEqual([]);
    expect(rejecting.model.plans).toBe(6);
  });
});
