import { describe, expect, it } from "vitest";
import { evaluate, gate, preflight, runAll, runScenario, scriptedModel, summarize } from "../scripts/g7/lib/agent-eval.js";
import { AGENT_SCENARIOS, type AgentScenario } from "../scripts/g7/lib/agent-scenarios.js";

// Escenarios SINTÉTICOS del núcleo conversacional, sin red. Dos cosas: (1) el verificador NO bloquea respuestas correctas y naturales de un buen modelo; (2) SÍ bloquea las inventadas, con el código esperado.
// Cada escenario corre por el camino de producción (preparación del turno, herramientas reales sobre un catálogo y conocimiento ficticios, tubería y verificador).

describe("escenarios sintéticos: cobertura del corpus", () => {
  it("hay escenarios de saludo, cotización, ambigüedad, estudio desconocido, horario, ubicación sin dato, continuidad, salud, persona, silencio, inyección y pagos", () => {
    const ids = AGENT_SCENARIOS.map((scenario) => scenario.id);
    for (const id of ["saludo", "cotizar-por-nombre", "estudio-ambiguo", "estudio-desconocido", "horario", "ubicacion-sin-dato", "horario-y-cotizacion", "mensaje-partido", "continuidad", "ultima-cotizacion", "salud", "salud-con-precio", "pide-una-persona", "fuera-de-tema", "intento-de-inyeccion", "pago-ignorado"]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENT_SCENARIOS.every((scenario) => scenario.good.length > 0)).toBe(true);
  });
});

describe("el verificador acepta las respuestas CORRECTAS (sin falsos bloqueos)", () => {
  for (const scenario of AGENT_SCENARIOS) {
    scenario.good.forEach((reply, index) => {
      it(`${scenario.id} · respuesta correcta ${index + 1}`, async () => {
        const { decision, skipped } = await runScenario(scriptedModel(reply), scenario);
        // salud sin precio: la preparación NO llama al modelo (lo atiende el modo esencial); fuera de tema: silencio
        if (scenario.expect.skipped) { expect(evaluate(decision, scenario.expect, skipped)).toEqual([]); return; }
        expect(decision, `sin decisión (${skipped})`).toBeDefined();
        if (scenario.expect.silent) { expect(decision!.status).toBe("SILENT"); expect(decision!.reply).toBeUndefined(); return; }
        expect(decision!.violations, JSON.stringify(decision!.violations)).toEqual([]);
        expect(decision!.status).toBe("VERIFIED");
        expect(evaluate(decision, scenario.expect)).toEqual([]);
      });
    });
  }
});

describe("el verificador RECHAZA las respuestas inventadas, con el código esperado", () => {
  for (const scenario of AGENT_SCENARIOS) {
    (scenario.bad ?? []).forEach((reply, index) => {
      it(`${scenario.id} · respuesta mala ${index + 1} (${reply.reject})`, async () => {
        const { decision } = await runScenario(scriptedModel(reply), scenario);
        expect(decision?.status).toBe("REJECTED");
        expect(decision!.violations.map((violation) => violation.code)).toContain(reply.reject);
        expect(decision!.reply).toBeUndefined();
      });
    });
  }
});

describe("las herramientas del escenario usan el catálogo y el conocimiento ficticios", () => {
  const find = (id: string): AgentScenario => AGENT_SCENARIOS.find((scenario) => scenario.id === id)!;

  it("la cotización lleva los precios del catálogo (solo en el bloque del sistema) y el modelo no los ve", async () => {
    const scenario = find("cotizar-por-nombre");
    const seen: string[] = [];
    const base = scriptedModel(scenario.good[0]!);
    const { decision } = await runScenario({ plan: base.plan, respond: async (input) => { seen.push(JSON.stringify(input.facts)); return base.respond(input); } }, scenario);
    expect(decision?.reply).toMatch(/HEMOGRAMA COMPLETO[\s\S]*GLUCOSA EN AYUNAS[\s\S]*75[.,]5/);
    expect(seen.join("")).not.toMatch(/\b45\b|30[.,]5|75[.,]5|Bs/);
  });

  it("la continuidad viene del historial (mensajes recientes, sin ids ni pendientes) y la última cotización como hecho con nombres del catálogo", async () => {
    const seen: string[] = [];
    await runScenario({ plan: async (input) => { seen.push(JSON.stringify([input.recent, input.utterances])); return { toolCalls: [] }; }, respond: async () => ({ text: "Con gusto." }) }, find("continuidad"));
    expect(seen[0]).toContain("necesito cotizar creatinina");
    expect(seen[0]).toContain("CREATININA EN ORINA");
    expect(seen[0]).not.toMatch(/"id"|carried|U1|P1/);
    const last = await runScenario(scriptedModel(find("ultima-cotizacion").good[1]!), find("ultima-cotizacion"));
    expect(last.decision?.facts.map((fact) => fact.text)).toEqual(["Última cotización entregada en esta conversación: HEMOGRAMA COMPLETO; TSH"]);
  });

  it("la derivación humana está desactivada: pedir una persona y prometerla se rechaza", async () => {
    const scenario = find("pide-una-persona");
    const { decision } = await runScenario(scriptedModel(scenario.bad![0]!), scenario);
    expect(decision?.violations.map((v) => v.code)).toContain("UNREGISTERED_HANDOFF_PROMISE");
  });

  it("un mensaje de salud SIN precio no llega al modelo (lo atiende el modo esencial); con un pedido de precio sí llega, con su texto", async () => {
    let calls = 0;
    const counting = { plan: async () => { calls += 1; return { toolCalls: [] }; }, respond: async () => ({ text: "x" }) };
    const sick = await runScenario(counting, find("salud"));
    expect(sick).toMatchObject({ skipped: "MEDICAL" });
    expect(calls).toBe(0);
    let utterances = "";
    await runScenario({ plan: async (input) => { utterances = JSON.stringify(input.utterances); return { toolCalls: [] }; }, respond: async () => scriptedModel(find("salud-con-precio").good[0]!).respond({} as never) }, find("salud-con-precio"));
    expect(utterances).toMatch(/diabetes/);
  });
});

describe("el arnés de evaluación", () => {
  it("evalúa un modelo guionado perfecto: todo pasa; resume latencia, tokens y costo con los precios que se indiquen", async () => {
    const runs = [];
    for (const scenario of AGENT_SCENARIOS) runs.push(...await runAll(scriptedModel(scenario.good[0]!, { inputTokens: 100, outputTokens: 20 }), { scenarios: [scenario] }));
    const summary = summarize(runs, { inputPerMTok: 2, outputPerMTok: 10 });
    // salud sin precio y el agradecimiento (se calla sin modelo) no llaman al modelo (0 llamadas) y fuera de tema solo planifica (1 llamada): el resto, plan + redacción
    const calls = 2 * (AGENT_SCENARIOS.length - 3) + 1;
    expect(summary).toMatchObject({ scenarios: AGENT_SCENARIOS.length, passed: AGENT_SCENARIOS.length, rejected: 0, modelErrors: 0, skipped: 1, rejectedList: [], failedList: [] });
    expect(summary.usage).toMatchObject({ inputTokens: 100 * calls, outputTokens: 20 * calls, calls });
    expect(summary.costUsd).toBeCloseTo((100 * calls * 2 + 20 * calls * 10) / 1_000_000, 4);
    expect(summarize(runs).costUsd).toBeUndefined();
  });

  it("detecta lo que falla: un rechazo del verificador, una expectativa incumplida y un error del modelo", async () => {
    const quote = AGENT_SCENARIOS.find((s) => s.id === "cotizar-por-nombre")!;
    const rejected = await runAll(scriptedModel(quote.bad![1]!), { scenarios: [quote] });
    expect(summarize(rejected)).toMatchObject({ rejected: 1, passed: 0, rejectedList: [{ id: "cotizar-por-nombre", violations: expect.arrayContaining(["PRICE_OUTSIDE_QUOTE"]) }] });
    const hours = AGENT_SCENARIOS.find((s) => s.id === "horario")!;
    const wrongAct = await runAll(scriptedModel({ calls: hours.good[0]!.calls, text: "Atendemos de lunes a viernes." }), { scenarios: [hours] });
    expect(wrongAct[0]!.failures.join(" ")).toMatch(/el mensaje no cumple/);
    const failing = await runAll({ plan: async () => { throw Object.assign(new Error("x"), { status: 429, code: "insufficient_quota" }); }, respond: async () => { throw new Error("no"); } }, { scenarios: [hours] });
    expect(summarize(failing)).toMatchObject({ modelErrors: 1, passed: 0 });
    expect(failing[0]!.failures[0]).toMatch(/MODEL_ERROR causa QUOTA_OR_BILLING/);
  });
});

describe("verificación previa de la configuración del agente conversacional único", () => {
  const FULL = { PLUSMEDIK_LLM_CONVERSATION: "on", OPENAI_CONVERSATION_MODEL: "modelo-x", OPENAI_API_KEY: "sk-secreto-no-mostrar", PLUSMEDIK_TURNS: "on", PLUSMEDIK_TEXT_HANDLER: "on", PLUSMEDIK_KNOWLEDGE_ANSWERS: "on" };
  const levels = (env: Record<string, string | undefined>) => preflight(env).map((line) => `${line.level}:${line.item}`);
  const find = (lines: ReturnType<typeof preflight>, item: string) => lines.find((line) => line.item === item);

  it("completo: sin bloqueos; solo recuerda el interruptor de emergencia; razonamiento medio y tope de 6 cada 24 h por defecto; nunca muestra la clave", () => {
    const lines = preflight(FULL);
    expect(lines.filter((line) => line.level === "BLOCK")).toEqual([]);
    expect(lines.filter((line) => line.level === "WARN").map((line) => line.item)).toEqual(["memoria persistente (migración 24)", "interruptor de emergencia (migración 25)"]);
    expect(find(lines, "configuración del modelo")?.detail).toContain("razonamiento medium");
    expect(find(lines, "tope diario")?.detail).toContain("6 respuestas por contacto cada 24 h");
    expect(find(lines, "derivación humana del agente")).toMatchObject({ level: "OK", detail: expect.stringContaining("NO disponible") });
    expect(JSON.stringify(lines)).not.toContain("sk-secreto");
  });

  it("bloquea lo que impide el funcionamiento y avisa de lo recomendable; el modelo se elige SOLO con OPENAI_CONVERSATION_MODEL", () => {
    expect(levels({})).toEqual(expect.arrayContaining(["BLOCK:PLUSMEDIK_LLM_CONVERSATION", "BLOCK:configuración del modelo", "BLOCK:OPENAI_API_KEY", "BLOCK:PLUSMEDIK_TURNS", "BLOCK:PLUSMEDIK_TEXT_HANDLER", "WARN:PLUSMEDIK_KNOWLEDGE_ANSWERS"]));
    expect(levels({ ...FULL, OPENAI_CONVERSATION_MODEL: undefined })).toContain("BLOCK:configuración del modelo");
    expect(levels({ ...FULL, OPENAI_CONVERSATION_MODEL: undefined, OPENAI_AGENT_MODEL: "modelo-x" })).toContain("BLOCK:configuración del modelo");
    expect(levels({ ...FULL, OPENAI_CONVERSATION_REASONING: "ultra" })).toContain("BLOCK:configuración del modelo");
  });

  it("la memoria persistente es parte normal del agente (recuerda la migración 24, sin variable propia); el historial apagado avisa; el tope se puede apagar (avisa) y la derivación depende de la cola al CRM", () => {
    expect(levels(FULL)).toContain("WARN:memoria persistente (migración 24)");
    expect(levels({ ...FULL, PLUSMEDIK_CONV_STATE: "off" })).not.toContain("PLUSMEDIK_CONV_STATE");
    expect(levels({ ...FULL, PLUSMEDIK_HISTORY: "off" })).toContain("WARN:PLUSMEDIK_HISTORY");
    expect(levels({ ...FULL, PLUSMEDIK_DAILY_REPLY_CAP: "off" })).toContain("WARN:tope diario");
    expect(find(preflight({ ...FULL, PLUSMEDIK_DAILY_REPLY_CAP_MAX: "8" }), "tope diario")?.detail).toContain("8 respuestas");
    expect(find(preflight({ ...FULL, PLUSMEDIK_CRM_HANDOFF: "on" }), "derivación humana del agente")).toMatchObject({ level: "WARN" });
  });
});

describe("puerta de aprobación de un modelo real (antes de encender)", () => {
  it("un modelo perfecto la aprueba; los errores del proveedor, los rechazos frecuentes, las reparaciones frecuentes y la lentitud la niegan con el motivo", async () => {
    const perfect = [];
    for (const scenario of AGENT_SCENARIOS) perfect.push(...await runAll(scriptedModel(scenario.good[0]!), { scenarios: [scenario] }));
    expect(gate(summarize(perfect))).toEqual({ pass: true, reasons: [] });
    const base = summarize(perfect);
    expect(gate({ ...base, modelErrors: 2 }).reasons.join(" ")).toMatch(/error del proveedor/);
    expect(gate({ ...base, passed: 10 }).reasons.join(" ")).toMatch(/escenarios cumplen/);
    expect(gate({ ...base, firstPass: 5, repaired: 12 }).reasons.join(" ")).toMatch(/a la primera/);
    expect(gate({ ...base, latencyMs: { ...base.latencyMs, p95: 40_000 } }).reasons.join(" ")).toMatch(/p95/);
    expect(gate({ ...base, scenarios: 0, passed: 0, firstPass: 0 }).pass).toBe(false);
  });
});
