import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Act, AgentModel, Fact, PlanInput, RespondInput, ToolDef, Utterance } from "../src/agent/contracts.js";
import { AgentOutputError, resolveAgentMode, runAgentTurn } from "../src/agent/pipeline.js";
import { conversationStateTool, createToolRegistry, findStudiesTool, labInfoTool, quoteStudiesTool, runToolCalls, TOOL_LIMITS } from "../src/agent/tools.js";
import { validateActs, verifyReply } from "../src/agent/verify.js";
import { createConversationReader, type ConversationStore } from "../src/conversation-state-store.js";
import { encodeEvent } from "../src/conversation-state.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { KnowledgeAnswer } from "../src/knowledge-answers.js";
import type { CatalogStudy } from "../src/types.js";

// Núcleo conversacional (Fase 2 del plan G7): contratos, herramientas de solo lectura, verificador por procedencia y tubería fija, con un modelo SIMULADO.

const NOW = new Date("2026-11-05T15:00:00Z");
const CAPS = { handoff: false, quote: true };
const u = (id: string, topic: string, goal: Utterance["goal"] = "OTHER", text?: string): Utterance => ({ id, topic, goal, ...(text ? { text } : {}) });
const fact = (id: string, text: string, source: Fact["source"] = "LAB_INFO"): Fact => ({ id, source, text, refs: [] });
const HOURS = fact("lab_info:1", "Horario de la sucursal Central: lunes a viernes de 07:00 a 18:00. Teléfono 591 70000000.");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number, active = true): CatalogStudy =>
  ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active, category: null, sampleType: null }) as unknown as CatalogStudy;
const CATALOG = [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(3, "CREATININA SERICA", ["creatinina", "creatinina sanguinea"], 40), study(4, "CREATININA EN ORINA", ["creatinina", "creatinina urinaria"], 42), study(5, "TSH", ["tsh"], 80)];
const ctx = { now: NOW };

// ───────────────────────────── verificador: los actos ─────────────────────────────

describe("validateActs: cobertura y reglas de los actos", () => {
  const utterances = [u("U1", "INFO_REQUEST", "LAB_INFO"), u("U2", "RECIPE_OR_QUOTE", "QUOTE")];
  const context = { capabilities: CAPS, hasQuoteBlock: true };

  it("cada petición necesita al menos un acto (un acto puede cubrir varias): nada queda sin destino", () => {
    const some: Act[] = [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }];
    expect(validateActs(some, utterances, [HOURS], context)).toEqual([{ code: "UNCOVERED_UTTERANCE", detail: "U2" }]);
    expect(validateActs([...some, { kind: "QUOTE", utterances: ["U2"] }], utterances, [HOURS], context)).toEqual([]);
    expect(validateActs([{ kind: "ACK", utterances: ["U1", "U2"] }], utterances, [], context)).toEqual([]);
    expect(validateActs([], utterances, [], context)).toEqual([{ code: "NO_ACTS" }]);
  });

  it("una respuesta debe citar hechos que existen; un acto sobre una petición desconocida o sin peticiones se rechaza", () => {
    const acts: Act[] = [{ kind: "ANSWER", utterances: ["U1"], factIds: [] }, { kind: "ANSWER", utterances: ["U2"], factIds: ["x:9"] }, { kind: "ACK", utterances: ["U9"] }, { kind: "ACK", utterances: [] }];
    expect(validateActs(acts, utterances, [HOURS], context).map((v) => v.code).sort()).toEqual(["ANSWER_WITHOUT_FACTS", "UNCOVERED_UTTERANCE", "UNKNOWN_FACT", "UNKNOWN_UTTERANCE"]);
  });

  it("un tema médico solo se deriva o se aplaza, nunca se responde ni se aclara", () => {
    const medical = [u("U1", "MEDICAL", "HUMAN_ATTENTION")];
    const withHandoff = { capabilities: { handoff: true, quote: true }, hasQuoteBlock: false };
    for (const act of [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }, { kind: "CLARIFY", utterances: ["U1"], code: "SPECIFY_REQUEST" }, { kind: "ACK", utterances: ["U1"] }] as Act[]) {
      expect(validateActs([act], medical, [HOURS], withHandoff).map((v) => v.code), act.kind).toContain("MEDICAL_NOT_HANDED_OFF");
    }
    expect(validateActs([{ kind: "HANDOFF", utterances: ["U1"], reason: "MEDICAL" }], medical, [], withHandoff)).toEqual([]);
    expect(validateActs([{ kind: "DEFER", utterances: ["U1"], reason: "NOT_SUPPORTED" }], medical, [], context)).toEqual([]);
  });

  it("un mensaje de salud que además pide precio de estudios sí se cotiza (la cotización la arma el sistema y no interpreta nada)", () => {
    const medical = [u("U1", "MEDICAL", "HUMAN_ATTENTION")];
    expect(validateActs([{ kind: "QUOTE", utterances: ["U1"] }], medical, [], context)).toEqual([]);
  });

  it("manda lo que el MODELO leyó: la etiqueta de las reglas no bloquea una petición que el modelo entendió que no es de salud, y sin lectura rige la etiqueta", () => {
    const labelled = [u("U1", "MEDICAL", "HUMAN_ATTENTION")];
    const answer: Act[] = [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }];
    expect(validateActs(answer, labelled, [HOURS], { ...context, read: new Map([["U1", "INFO"]]) })).toEqual([]);
    expect(validateActs(answer, labelled, [HOURS], { ...context, read: new Map([["U1", "MEDICAL"]]) }).map((v) => v.code)).toContain("MEDICAL_NOT_HANDED_OFF");
    expect(validateActs(answer, labelled, [HOURS], { ...context, read: new Map() }).map((v) => v.code)).toContain("MEDICAL_NOT_HANDED_OFF");
    // al revés: la etiqueta no dice salud pero el modelo sí
    expect(validateActs(answer, [u("U1", "INFO_REQUEST", "LAB_INFO")], [HOURS], { ...context, read: new Map([["U1", "MEDICAL"]]) }).map((v) => v.code)).toContain("MEDICAL_NOT_HANDED_OFF");
  });

  it("HANDOFF solo existe si la capacidad existe hoy; QUOTE exige la capacidad y una cotización calculada por el sistema", () => {
    const one = [u("U1", "HUMAN_REQUEST", "HUMAN_ATTENTION")];
    expect(validateActs([{ kind: "HANDOFF", utterances: ["U1"], reason: "HUMAN_REQUEST" }], one, [], context)).toEqual([{ code: "HANDOFF_UNAVAILABLE", detail: "U1" }]);
    expect(validateActs([{ kind: "QUOTE", utterances: ["U1"] }], one, [], { capabilities: CAPS, hasQuoteBlock: false })).toEqual([{ code: "QUOTE_WITHOUT_BLOCK" }]);
    expect(validateActs([{ kind: "QUOTE", utterances: ["U1"] }], one, [], { capabilities: { handoff: false, quote: false }, hasQuoteBlock: true })).toEqual([{ code: "QUOTE_UNAVAILABLE" }]);
  });
});

// ───────────────────────────── verificador: el texto ─────────────────────────────

describe("verifyReply: cada dato debe tener procedencia", () => {
  const answer: Act[] = [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }];
  const check = (text: string, extra: Partial<Parameters<typeof verifyReply>[0]> = {}) => verifyReply({ text, acts: answer, facts: [HOURS], ...extra }).map((v) => v.code);

  it("acepta un texto natural que solo usa lo que dicen los hechos citados (otras palabras, mismas cifras)", () => {
    expect(check("¡Claro! Atendemos de lunes a viernes, de 07:00 a 18:00. Si prefieres llamar, el número es 591 70000000.")).toEqual([]);
    expect(check("Buenos días, estamos abiertos de 7:00 a 18:00 de lunes a viernes.")).toEqual([]);
  });

  it("rechaza una cifra, hora, día, teléfono o enlace que no está en los hechos (lo que el filtro por palabras dejaba pasar)", () => {
    expect(check("Entregamos tus resultados en 24 horas.")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Abrimos también los sábados hasta las 12:00.")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Llámanos al 591 71111111.")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Mira https://ejemplo.test/ubicacion")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Estamos en la calle 21 de calacoto.")).toEqual(["UNGROUNDED_FIGURE"]);
  });

  it("una cifra que el propio paciente escribió no es un dato inventado", () => {
    expect(check("Anotado: 3 estudios.", { patientText: "quiero 3 estudios" })).toEqual([]);
    expect(check("Anotado: 4 estudios.", { patientText: "quiero 3 estudios" })).toEqual(["UNGROUNDED_FIGURE"]);
  });

  it("solo valen los hechos CITADOS por un acto, salvo los nombres del catálogo (sin precios)", () => {
    const other = fact("lab_info:2", "Cupo diario de hasta 500 pacientes.");
    expect(verifyReply({ text: "Atendemos hasta 500 pacientes.", acts: answer, facts: [HOURS, other] }).map((v) => v.code)).toEqual(["UNGROUNDED_FIGURE"]);
    const named = fact("find_studies:1", "Estudio del catálogo: VITAMINA B12", "CATALOG");
    expect(verifyReply({ text: "Sí, tenemos VITAMINA B12.", acts: [{ kind: "CLARIFY", utterances: ["U1"], code: "WHICH_STUDY" }], facts: [named] })).toEqual([]);
  });

  it("ninguna cifra de dinero sale del redactor", () => {
    expect(check("El hemograma cuesta Bs 45.")).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Son 45 bolivianos.")).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Son Bs. 45.", { patientText: "45" })).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Cuesta cuarenta y cinco bolivianos.")).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Sale $ ahora mismo")).toContain("PRICE_OUTSIDE_QUOTE");
  });

  it("«una persona» o «el equipo» a secas no es una promesa de atención; sí lo es lo que promete una acción", () => {
    for (const text of ["Puedes venir acompañado de una persona de confianza.", "El equipo de toma de muestras atiende de 7:00 a 18:00."]) expect(check(text), text).not.toContain("UNREGISTERED_HANDOFF_PROMISE");
    for (const text of ["Una persona del laboratorio te contactará.", "Nuestro equipo te escribirá pronto.", "Voy a registrar tu caso."]) expect(check(text), text).toContain("UNREGISTERED_HANDOFF_PROMISE");
  });

  it("prometer que una persona atenderá solo se permite si los actos pidieron una derivación registrada", () => {
    expect(check("Tranquilo, una persona de recepción te escribirá.")).toEqual(["UNREGISTERED_HANDOFF_PROMISE"]);
    expect(check("Ya derivé tu caso al equipo.")).toEqual(["UNREGISTERED_HANDOFF_PROMISE"]);
    expect(verifyReply({ text: "Te paso con una persona de recepción.", acts: [{ kind: "HANDOFF", utterances: ["U1"], reason: "HUMAN_REQUEST" }], facts: [] })).toEqual([]);
  });

  it("rechaza lo vacío o demasiado largo, y no castiga frases naturales con palabras corrientes", () => {
    expect(check("")).toEqual(["EMPTY_REPLY"]);
    expect(check("a ".repeat(600))).toContain("REPLY_TOO_LONG");
    for (const text of ["Con gusto, cuéntame qué estudios necesitas.", "Gracias por escribirnos, aquí estoy para ayudarte.", "Puedes enviarme una foto de tu receta o escribir los nombres de los estudios."]) {
      expect(verifyReply({ text, acts: [{ kind: "ACK", utterances: ["U1"] }], facts: [] }), text).toEqual([]);
    }
  });
});

// ───────────────────────────── herramientas ─────────────────────────────

describe("herramientas: solo lectura, acotadas y que nunca lanzan", () => {
  const tool = (name: string, run: ToolDef["run"]): ToolDef => ({ name, description: name, readOnly: true, input: z.object({ q: z.string() }).strict(), run });

  it("el registro rechaza herramientas repetidas o que no sean de solo lectura", () => {
    expect(() => createToolRegistry([tool("a", async () => undefined), tool("a", async () => undefined)])).toThrow(/repetida/);
    expect(() => createToolRegistry([{ ...tool("w", async () => undefined), readOnly: false as unknown as true }])).toThrow(/solo lectura/);
  });

  it("ejecuta en orden, numera los hechos, junta los bloques del sistema y traduce cada fallo a un código sin detener el turno", async () => {
    const registry = createToolRegistry([
      tool("ok", async () => ({ facts: [{ source: "LAB_INFO", text: "dato", refs: ["r1"] }], blocks: ["BLOQUE"] })),
      tool("empty", async () => undefined),
      tool("boom", async () => { throw new Error("detalle interno con texto"); }),
      tool("slow", () => new Promise(() => undefined))
    ]);
    const { runs, facts, blocks } = await runToolCalls(registry, [
      { tool: "ok", input: { q: "x" } }, { tool: "empty", input: { q: "x" } }, { tool: "boom", input: { q: "x" } }, { tool: "slow", input: { q: "x" } },
      { tool: "nope", input: {} }, { tool: "ok", input: { q: 5 } }
    ], ctx, { maxCalls: 6, timeoutMs: 30 });
    expect(runs.map((run) => `${run.tool}:${run.ok ? "ok" : run.error}`)).toEqual(["ok:ok", "empty:NO_DATA", "boom:FAILED", "slow:TIMEOUT", "nope:UNKNOWN_TOOL", "ok:INVALID_INPUT"]);
    expect(facts).toEqual([{ id: "ok:1", source: "LAB_INFO", text: "dato", refs: ["r1"] }]);
    expect(blocks).toEqual(["BLOQUE"]);
    expect(JSON.stringify(runs)).not.toContain("detalle interno");
  });

  it("tope de llamadas por turno", async () => {
    const run = vi.fn(async () => ({ facts: [{ source: "LAB_INFO" as const, text: "d", refs: [] }] }));
    const registry = createToolRegistry([tool("ok", run)]);
    const { runs } = await runToolCalls(registry, Array.from({ length: TOOL_LIMITS.maxCalls + 3 }, () => ({ tool: "ok", input: { q: "x" } })), ctx);
    expect(run).toHaveBeenCalledTimes(TOOL_LIMITS.maxCalls);
    expect(runs.filter((r) => r.error === "TOO_MANY_CALLS")).toHaveLength(3);
  });

  it("lab_info: devuelve el texto aprobado con su procedencia; sin dato o solo una aclaración no es un hecho", async () => {
    const answer = (value: Partial<KnowledgeAnswer> | undefined) => labInfoTool({ answer: async () => (value ? ({ body: "Lunes a viernes 07:00 a 18:00", refs: [{ kind: "SCHEDULE", key: "central", version: 3, contentHash: "abcdef0123456789abcdef" }], status: "ANSWERED", topics: [], unavailable: [], ...value } as KnowledgeAnswer) : undefined) });
    const okTool = answer({});
    expect(await okTool.run({ question: "a que hora abren" }, ctx)).toEqual({ facts: [{ source: "LAB_INFO", text: "Lunes a viernes 07:00 a 18:00", refs: ["SCHEDULE:central@3:abcdef012345"] }] });
    expect(await answer(undefined).run({ question: "a que hora abren" }, ctx)).toBeUndefined();
    expect(await answer({ status: "CLARIFY" }).run({ question: "preparación" }, ctx)).toBeUndefined();
    expect(okTool.input.safeParse({ question: "x" }).success).toBe(false);
    expect(okTool.input.safeParse({ question: "ok bien", extra: 1 }).success).toBe(false);
  });

  it("find_studies: nombres del catálogo, sin precios", async () => {
    const found = await findStudiesTool({ loadCatalog: async () => CATALOG }).run({ query: "hemograma" }, ctx);
    expect(found?.facts[0]).toEqual({ source: "CATALOG", text: "Estudio del catálogo: HEMOGRAMA COMPLETO", refs: [`study:${uuid(1)}`] });
    expect(JSON.stringify(found)).not.toMatch(/45|priceBs|Bs/);
    expect(await findStudiesTool({ loadCatalog: async () => CATALOG }).run({ query: "zzzzqqqq" }, ctx)).toBeUndefined();
  });

  describe("quote_studies: la cotización sale del motor y del catálogo, nunca del modelo", () => {
    const quote = quoteStudiesTool({ loadCatalog: async () => CATALOG });

    it("todo identificado con certeza: hechos SIN precios y un bloque con los precios del catálogo", async () => {
      const result = await quote.run({ studies: ["hemograma", "glucosa"] }, ctx);
      expect(result?.blocks).toHaveLength(1);
      const block = result!.blocks![0]!;
      expect(block).toContain("HEMOGRAMA COMPLETO");
      expect(block).toContain("45");
      expect(block).toMatch(/30[.,]5/);
      expect(block).toMatch(/75[.,]5/);
      for (const f of result!.facts) expect(f.text, f.text).not.toMatch(/\d+[.,]\d|\bBs\b|\b(45|30|75)\b/);
      expect(result!.facts[0]!.text).toContain("(2)");
      expect(result!.facts.map((f) => f.source)).toEqual(["QUOTE_ENGINE", "QUOTE_ENGINE"]);
    });

    it("ambiguo (creatinina sérica o en orina): sin bloque; el hecho nombra las opciones, sin precios", async () => {
      const result = await quote.run({ studies: ["creatinina"] }, ctx);
      expect(result?.blocks ?? []).toEqual([]);
      expect(result!.facts.map((f) => f.text).join(" ")).toMatch(/CREATININA SERICA/);
      expect(result!.facts.map((f) => f.text).join(" ")).toMatch(/CREATININA EN ORINA/);
      expect(JSON.stringify(result)).not.toMatch(/\b40\b|\b42\b/);
    });

    it("una parte no identificada: se cotiza lo seguro como PARCIAL (precios solo en el bloque) y se avisa cuántos faltan", async () => {
      const result = await quote.run({ studies: ["hemograma", "xyzqwerty inexistente"] }, ctx);
      expect(result?.blocks).toHaveLength(1);
      expect(result!.blocks![0]).toContain("HEMOGRAMA COMPLETO");
      expect(result!.blocks![0]).not.toContain("XYZQWERTY");
      expect(result!.facts.some((f) => /No se pudo identificar/.test(f.text))).toBe(true);
      expect(result!.facts.some((f) => /PARCIAL/.test(f.text))).toBe(true);
      for (const f of result!.facts) expect(f.text, f.text).not.toMatch(/\d+[.,]\d|\bBs\b|\b45\b/);
    });

    it("un estudio ambiguo junto a uno seguro: se cotiza el seguro como PARCIAL y los hechos nombran las opciones del dudoso", async () => {
      const result = await quote.run({ studies: ["hemograma", "creatinina"] }, ctx);
      expect(result?.blocks).toHaveLength(1);
      expect(result!.blocks![0]).toContain("HEMOGRAMA COMPLETO");
      expect(result!.blocks![0]).not.toContain("CREATININA");
      const facts = result!.facts.map((f) => f.text).join(" ");
      expect(facts).toMatch(/PARCIAL/);
      expect(facts).toMatch(/CREATININA SERICA/);
      expect(facts).toMatch(/CREATININA EN ORINA/);
      expect(JSON.stringify(result!.facts)).not.toMatch(/\b40\b|\b42\b/);
    });

    it("todo seguro NO se marca como parcial", async () => {
      const result = await quote.run({ studies: ["hemograma", "glucosa"] }, ctx);
      expect(result!.facts.some((f) => /PARCIAL/.test(f.text))).toBe(false);
    });

    it("un estudio inactivo en el catálogo no se cotiza (el catálogo manda)", async () => {
      const inactive = quoteStudiesTool({ loadCatalog: async () => CATALOG.map((s) => (s.id === uuid(1) ? ({ ...s, active: false } as CatalogStudy) : s)) });
      const result = await inactive.run({ studies: ["hemograma"] }, ctx);
      expect(result?.blocks ?? []).toEqual([]);
    });

    it("un precio inválido en el catálogo no genera un bloque", async () => {
      const broken = quoteStudiesTool({ loadCatalog: async () => CATALOG.map((s) => (s.id === uuid(1) ? ({ ...s, priceBs: 0 } as CatalogStudy) : s)) });
      expect((await broken.run({ studies: ["hemograma"] }, ctx))?.blocks ?? []).toEqual([]);
    });

    it("lo que no es un pedido de estudios no es un hecho; la entrada se valida", async () => {
      expect(await quote.run({ studies: ["gracias por todo"] }, ctx)).toBeUndefined();
      expect(quote.input.safeParse({ studies: [] }).success).toBe(false);
      expect(quote.input.safeParse({ studies: Array(21).fill("hemograma") }).success).toBe(false);
      expect(quote.input.safeParse({ studies: ["hemograma"], precio: 1 }).success).toBe(false);
    });
  });

  it("conversation_state: pendientes y última cotización por nombre del catálogo, sin precios ni texto; sin nada o sin base no es un hecho", async () => {
    const rows = [
      encodeEvent({ id: "batch:w1", type: "PATIENT_BATCH", at: 1_000, items: [{ messageId: "w1", topic: "MEDIA_IMAGE", goal: "QUOTE" }] }),
      encodeEvent({ id: "reply:r", type: "AGENT_REPLY", at: 2_000, quality: "GENERIC" }),
      encodeEvent({ id: "quote:q1", type: "ARTIFACT", at: 3_000, artifact: { id: "Q:q1", kind: "QUOTE", studyIds: [uuid(1), uuid(5)], unrecognized: 0 } })
    ].map((row) => ({ key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }));
    const store: ConversationStore = { append: async () => ({ recorded: 0, duplicate: 0 }), read: async () => rows, contactsSince: async () => [] };
    const reader = createConversationReader({ store, now: () => 10_000 });
    const found = await conversationStateTool({ reader, contactKey: "a".repeat(64), loadCatalog: async () => CATALOG }).run({}, ctx);
    expect(found?.facts.map((f) => f.text)).toEqual(["Pendiente: MEDIA_IMAGE (FIXED_REPLY_ONLY)", "Última cotización entregada en esta conversación: HEMOGRAMA COMPLETO; TSH"]);
    expect(JSON.stringify(found)).not.toMatch(/priceBs|Bs/);
    const down = createConversationReader({ store: { ...store, read: async () => { throw new Error("down"); } } });
    expect(await conversationStateTool({ reader: down, contactKey: "a".repeat(64) }).run({}, ctx)).toBeUndefined();
    const empty = createConversationReader({ store: { ...store, read: async () => [] } });
    expect(await conversationStateTool({ reader: empty, contactKey: "a".repeat(64) }).run({}, ctx)).toBeUndefined();
  });
});

// ───────────────────────────── tubería ─────────────────────────────

describe("runAgentTurn: tubería fija con un modelo simulado", () => {
  const knowledge = labInfoTool({ answer: async () => ({ body: "Lunes a viernes de 07:00 a 18:00", refs: [], status: "ANSWERED", topics: [], unavailable: [] } as unknown as KnowledgeAnswer) });
  const tools = createToolRegistry([knowledge, quoteStudiesTool({ loadCatalog: async () => CATALOG })]);
  interface Seen { plan?: PlanInput; respond?: RespondInput }
  const model = (planCalls: Array<{ tool: string; input: unknown }> | Error, response: { acts: Act[]; text: string } | Error, seen: Seen = {}): AgentModel => ({
    async plan(input) { seen.plan = input; if (planCalls instanceof Error) throw planCalls; return { toolCalls: planCalls, usage: { inputTokens: 100, outputTokens: 20 } }; },
    async respond(input) { seen.respond = input; if (response instanceof Error) throw response; return { ...response, usage: { inputTokens: 300, outputTokens: 80, reasoningTokens: 40 } }; }
  });
  const utterances = [u("U1", "INFO_REQUEST", "LAB_INFO", "a que hora abren"), u("U2", "RECIPE_OR_QUOTE", "QUOTE", "cotiza hemograma")];
  const calls = [{ tool: "lab_info", input: { question: "a que hora abren" } }, { tool: "quote_studies", input: { studies: ["hemograma"] } }];
  const acts: Act[] = [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }, { kind: "QUOTE", utterances: ["U2"] }];

  it("camino feliz: plan → herramientas → actos y texto → verificada; el SISTEMA agrega la cotización con precios del catálogo", async () => {
    const seen: Seen = {};
    const decision = await runAgentTurn({ model: model(calls, { acts, text: "Atendemos de lunes a viernes, de 07:00 a 18:00. Abajo tienes el detalle de tu cotización." }, seen), tools }, { utterances, recent: [{ from: "PATIENT", text: "hola" }], capabilities: CAPS, now: NOW });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toContain("07:00 a 18:00");
    expect(decision.reply).toContain("HEMOGRAMA COMPLETO");
    expect(decision.reply).toMatch(/45/);
    expect(decision.toolRuns.map((run) => `${run.tool}:${run.ok}`)).toEqual(["lab_info:true", "quote_studies:true"]);
    expect(seen.plan?.tools.map((t) => t.name)).toEqual(["lab_info", "quote_studies"]);
    expect(seen.plan?.recent).toEqual([{ from: "PATIENT", text: "hola" }]);
    expect(seen.respond?.hasQuoteBlock).toBe(true);
    // el modelo ve los hechos de la cotización pero NINGÚN precio
    expect(JSON.stringify(seen.respond?.facts)).not.toMatch(/45|Bs/);
    expect(decision.usage).toEqual({ inputTokens: 400, outputTokens: 100, reasoningTokens: 40, calls: 2 });
  });

  it("la cotización solo se agrega si un acto QUOTE la pidió", async () => {
    const decision = await runAgentTurn({ model: model(calls, { acts: [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }, { kind: "DEFER", utterances: ["U2"], reason: "NO_DATA" }], text: "Atendemos de 07:00 a 18:00 de lunes a viernes." }), tools }, { utterances, capabilities: CAPS });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).not.toMatch(/HEMOGRAMA|45/);
  });

  it("un precio escrito por el redactor, aunque coincida con el catálogo, se rechaza", async () => {
    const decision = await runAgentTurn({ model: model(calls, { acts, text: "El hemograma cuesta 45 bolivianos y atendemos de 07:00 a 18:00." }), tools }, { utterances, capabilities: CAPS });
    expect(decision).toMatchObject({ status: "REJECTED" });
    expect(decision.violations.map((v) => v.code)).toContain("PRICE_OUTSIDE_QUOTE");
    expect(decision.reply).toBeUndefined();
  });

  it("un dato inventado en la redacción se rechaza y no hay texto", async () => {
    const decision = await runAgentTurn({ model: model(calls, { acts, text: "Atendemos de 07:00 a 18:00 y respondemos en 24 horas. Abajo tu cotización." }), tools }, { utterances, capabilities: CAPS });
    expect(decision).toMatchObject({ status: "REJECTED", violations: [{ code: "UNGROUNDED_FIGURE" }] });
  });

  it("actos inválidos se rechazan ANTES de verificar el texto: sin cobertura, hecho inexistente, QUOTE sin cotización calculada, HANDOFF sin capacidad", async () => {
    const reply = (a: Act[], c = calls) => runAgentTurn({ model: model(c, { acts: a, text: "Claro." }), tools }, { utterances, capabilities: CAPS });
    expect((await reply([{ kind: "ACK", utterances: ["U1"] }])).violations).toEqual([{ code: "UNCOVERED_UTTERANCE", detail: "U2" }]);
    expect((await reply([{ kind: "ANSWER", utterances: ["U1", "U2"], factIds: ["lab_info:9"] }])).violations).toEqual([{ code: "UNKNOWN_FACT", detail: "lab_info:9" }]);
    expect((await reply([{ kind: "QUOTE", utterances: ["U1", "U2"] }], [])).violations).toEqual([{ code: "QUOTE_WITHOUT_BLOCK" }]);
    expect((await reply([{ kind: "HANDOFF", utterances: ["U1", "U2"], reason: "OUT_OF_SCOPE" }])).violations.map((v) => v.code)).toEqual(["HANDOFF_UNAVAILABLE"]);
  });

  it("una herramienta que falla deja el rastro y el plan que dependía de ella se rechaza (no se inventa el dato)", async () => {
    const failing = createToolRegistry([{ ...knowledge, run: async () => { throw new Error("db caída"); } }]);
    const decision = await runAgentTurn({ model: model([calls[0]!], { acts: [{ kind: "ANSWER", utterances: ["U1", "U2"], factIds: ["lab_info:1"] }], text: "Atendemos de 07:00 a 18:00." }), tools: failing }, { utterances, capabilities: CAPS });
    expect(decision.toolRuns).toEqual([{ tool: "lab_info", ok: false, error: "FAILED", factIds: [] }]);
    expect(decision.violations.map((v) => v.code)).toContain("UNKNOWN_FACT");
  });

  it("un fallo del modelo (plan o redacción) devuelve MODEL_ERROR con una causa codificada, sin lanzar y sin texto", async () => {
    const quota = Object.assign(new Error("You exceeded your current quota, secret-detail"), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
    const first = await runAgentTurn({ model: model(quota, { acts, text: "x" }), tools }, { utterances });
    expect(first).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "QUOTA_OR_BILLING", httpStatus: 429 } });
    expect(JSON.stringify(first)).not.toContain("secret-detail");
    const late = await runAgentTurn({ model: model(calls, new AgentOutputError("respond_shape")), tools }, { utterances, capabilities: CAPS });
    expect(late).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "INVALID_OUTPUT" }, toolRuns: [{ ok: true }, { ok: true }] });
    expect(late.reply).toBeUndefined();
  });

  it("sin peticiones no hay nada que decidir y no se llama al modelo", async () => {
    const plan = vi.fn();
    const decision = await runAgentTurn({ model: { plan, respond: vi.fn() }, tools }, { utterances: [] });
    expect(decision.status).toBe("VERIFIED");
    expect(plan).not.toHaveBeenCalled();
  });

  it("sin derivación registrada ni siquiera un texto puede prometer una persona", async () => {
    const decision = await runAgentTurn({ model: model([], { acts: [{ kind: "DEFER", utterances: ["U1", "U2"], reason: "NOT_SUPPORTED" }], text: "No puedo con eso, pero una persona te contactará pronto." }), tools }, { utterances, capabilities: CAPS });
    expect(decision.violations.map((v) => v.code)).toContain("UNREGISTERED_HANDOFF_PROMISE");
  });
});

describe("PLUSMEDIK_LLM_CONVERSATION (un solo agente)", () => {
  it("solo «on» enciende el agente conversacional; ausente, vacío o cualquier otro valor lo deja apagado (una errata nunca lo enciende)", () => {
    for (const value of ["on", " ON ", "On"]) expect(resolveAgentMode({ PLUSMEDIK_LLM_CONVERSATION: value })).toBe("live");
    for (const value of [undefined, "", " ", "off", "true", "1", "live", "shadow", "pilot"]) expect(resolveAgentMode({ PLUSMEDIK_LLM_CONVERSATION: value })).toBe("off");
    // las variables del agente antiguo ya no encienden nada
    expect(resolveAgentMode({ PLUSMEDIK_AGENT: "live" })).toBe("off");
  });
});

describe("silencio ante lo claramente ajeno al laboratorio (dentro del núcleo)", () => {
  const tools = createToolRegistry([]);
  const off = [{ utterance: "U1", intent: "OFF_TOPIC" as const }];
  const make = () => {
    const seen = { responds: 0 };
    const model: AgentModel = {
      async plan() { return { toolCalls: [], intents: off }; },
      async respond() { seen.responds += 1; return { acts: [{ kind: "ACK", utterances: ["U1"] }], text: "Hola" }; }
    };
    return { model, seen };
  };
  const other = u("U1", "OTHER", "OTHER", "mira el partido de anoche");

  it("el modelo lo lee OFF_TOPIC, las reglas no ven nada del laboratorio, no hay pendientes ni conversación en curso → SILENT, sin segunda llamada ni mensaje", async () => {
    const { model, seen } = make();
    const decision = await runAgentTurn({ model, tools }, { utterances: [other], recent: [{ from: "PATIENT", text: "hola" }] });
    expect(decision.status).toBe("SILENT");
    expect(decision.reply).toBeUndefined();
    expect(decision.usage?.calls).toBe(1);
    expect(seen.responds).toBe(0);
  });

  it("ante CUALQUIER duda se responde como siempre: el modelo no lo lee OFF_TOPIC, las reglas ven algo, hay un pendiente o ya se está conversando con el laboratorio", async () => {
    const respond = async (utterances: Utterance[], recent: Array<{ from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string }>, intents: Array<{ utterance: string; intent: "OFF_TOPIC" | "OTHER" }> = off) => {
      const model: AgentModel = { async plan() { return { toolCalls: [], intents }; }, async respond() { return { acts: [{ kind: "ACK", utterances: utterances.map((x) => x.id) }], text: "Hola, ¿en qué te ayudo?" }; } };
      return (await runAgentTurn({ model, tools }, { utterances, recent })).status;
    };
    expect(await respond([other], [], [{ utterance: "U1", intent: "OTHER" }])).toBe("VERIFIED");
    expect(await respond([other], [], [])).toBe("VERIFIED");
    expect(await respond([u("U1", "INFO_REQUEST", "LAB_INFO", "a que hora abren")], [])).toBe("VERIFIED");
    expect(await respond([u("U1", "OTHER_LAB", "OTHER", "tengo turno con el dentista")], [])).toBe("VERIFIED");
    expect(await respond([other, { ...u("P1", "OTHER", "OTHER"), carried: true }], [], [...off, { utterance: "P1", intent: "OFF_TOPIC" }])).toBe("VERIFIED");
    expect(await respond([other], [{ from: "ASSISTANT", text: "¿Eso es todo?" }])).toBe("VERIFIED");
    expect(await respond([other], [{ from: "STAFF", text: "Ya te atiendo" }])).toBe("VERIFIED");
  });

  it("todas las peticiones del turno deben ser ajenas: si una es del laboratorio, se responde", async () => {
    const model: AgentModel = { async plan() { return { toolCalls: [], intents: [{ utterance: "U1", intent: "OFF_TOPIC" }, { utterance: "U2", intent: "QUOTE" }] }; }, async respond() { return { acts: [{ kind: "ACK", utterances: ["U1", "U2"] }], text: "Hola" }; } };
    const decision = await runAgentTurn({ model, tools }, { utterances: [other, u("U2", "RECIPE_OR_QUOTE", "QUOTE", "cotiza hemograma")], recent: [] });
    expect(decision.status).toBe("VERIFIED");
  });
});

describe("reparación acotada: un segundo intento con los códigos de lo rechazado", () => {
  const knowledge = labInfoTool({ answer: async () => ({ body: "Lunes a viernes de 07:00 a 18:00", refs: [], status: "ANSWERED", topics: [], unavailable: [] } as unknown as KnowledgeAnswer) });
  const tools = createToolRegistry([knowledge]);
  const utterances = [u("U1", "INFO_REQUEST", "LAB_INFO", "a que hora abren")];
  const calls = [{ tool: "lab_info", input: { question: "a que hora abren" } }];
  const answer: Act[] = [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }];
  const sequence = (responses: Array<{ acts: Act[]; text: string } | Error>, seen: RespondInput[] = []): AgentModel => {
    let index = 0;
    return {
      async plan() { return { toolCalls: calls }; },
      async respond(input) { seen.push(input); const next = responses[Math.min(index++, responses.length - 1)]!; if (next instanceof Error) throw next; return { ...next, usage: { inputTokens: 10, outputTokens: 5 } }; }
    };
  };

  it("el primer intento inventa una cifra: el segundo recibe SOLO el código y, si corrige, queda verificada con el rastro de la reparación", async () => {
    const seen: RespondInput[] = [];
    const decision = await runAgentTurn({ model: sequence([{ acts: answer, text: "Abrimos de 07:00 a 18:00 y entregamos en 24 horas." }, { acts: answer, text: "Abrimos de lunes a viernes de 07:00 a 18:00." }], seen), tools }, { utterances, capabilities: CAPS });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toBe("Abrimos de lunes a viernes de 07:00 a 18:00.");
    expect(decision).toMatchObject({ repairs: 1, firstViolations: [{ code: "UNGROUNDED_FIGURE" }] });
    expect(seen[0]!.feedback).toBeUndefined();
    expect(seen[1]!.feedback).toEqual([{ code: "UNGROUNDED_FIGURE", detail: "n" }]);
    expect(JSON.stringify(seen[1]!.feedback)).not.toMatch(/24|horas|Abrimos/);
    expect(decision.usage?.calls).toBe(3);
  });

  it("si el segundo intento también falla, se rechaza con los códigos del último, sin un tercer intento", async () => {
    const seen: RespondInput[] = [];
    const decision = await runAgentTurn({ model: sequence([{ acts: answer, text: "Entregamos en 24 horas." }], seen), tools }, { utterances, capabilities: CAPS });
    expect(seen).toHaveLength(2);
    expect(decision).toMatchObject({ status: "REJECTED", repairs: 1, violations: [{ code: "UNGROUNDED_FIGURE" }] });
    expect(decision.reply).toBeUndefined();
  });

  it("un error de actos también se repara (cobertura), y un fallo del modelo en el segundo intento es MODEL_ERROR", async () => {
    const two = [u("U1", "INFO_REQUEST", "LAB_INFO", "a que hora abren"), u("U2", "SOCIAL", "OTHER", "gracias")];
    const fixed = await runAgentTurn({ model: sequence([{ acts: answer, text: "Abrimos de 07:00 a 18:00." }, { acts: [{ kind: "ANSWER", utterances: ["U1"], factIds: ["lab_info:1"] }, { kind: "ACK", utterances: ["U2"] }], text: "Abrimos de 07:00 a 18:00. ¡Con gusto!" }]), tools }, { utterances: two, capabilities: CAPS });
    expect(fixed).toMatchObject({ status: "VERIFIED", repairs: 1, firstViolations: [{ code: "UNCOVERED_UTTERANCE", detail: "U2" }] });
    const broken = await runAgentTurn({ model: sequence([{ acts: answer, text: "Entregamos en 24 horas." }, Object.assign(new Error("x"), { status: 429 })]), tools }, { utterances, capabilities: CAPS });
    expect(broken).toMatchObject({ status: "MODEL_ERROR", repairs: 1, modelError: { httpStatus: 429 } });
  });

  it("lo que pasa a la primera no gasta un segundo intento", async () => {
    const seen: RespondInput[] = [];
    const decision = await runAgentTurn({ model: sequence([{ acts: answer, text: "Abrimos de 07:00 a 18:00." }], seen), tools }, { utterances, capabilities: CAPS });
    expect(seen).toHaveLength(1);
    expect(decision.repairs).toBeUndefined();
  });
});
