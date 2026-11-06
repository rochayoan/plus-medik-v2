import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentModel, Fact, PlanInput, PlanOutput, RespondInput, ToolDef, Utterance } from "../src/agent/contracts.js";
import { AgentOutputError, resolveAgentMode, runAgentTurn } from "../src/agent/pipeline.js";
import { conversationStateTool, createToolRegistry, findStudiesTool, labInfoTool, quoteStudiesTool, runToolCalls, TOOL_LIMITS } from "../src/agent/tools.js";
import { verifyReply } from "../src/agent/verify.js";
import { createConversationReader, type ConversationStore } from "../src/conversation-state-store.js";
import { encodeEvent } from "../src/conversation-state.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { KnowledgeAnswer } from "../src/knowledge-answers.js";
import type { CatalogStudy } from "../src/types.js";

// Agente conversacional ÚNICO: verificador por procedencia, herramientas de solo lectura («sin datos» no es un fallo) y la tubería corta (plan → herramientas → texto libre → verificación), con un modelo SIMULADO.

const NOW = new Date("2026-11-05T15:00:00Z");
const CAPS = { handoff: false, quote: true };
const u = (text: string, topic = "OTHER_LAB"): Utterance => ({ topic, text });
const fact = (id: string, text: string, source: Fact["source"] = "LAB_INFO"): Fact => ({ id, source, text, refs: [] });
const HOURS = fact("lab_info:1", "Horario de la sucursal Central: lunes a viernes de 07:00 a 18:00. Teléfono 591 70000000.");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number, active = true): CatalogStudy =>
  ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active, category: null, sampleType: null }) as unknown as CatalogStudy;
const CATALOG = [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(3, "CREATININA SERICA", ["creatinina", "creatinina sanguinea"], 40), study(4, "CREATININA EN ORINA", ["creatinina", "creatinina urinaria"], 42), study(5, "TSH", ["tsh"], 80)];
const ctx = { now: NOW };

// ───────────────────────────── verificador: el texto ─────────────────────────────

describe("verifyReply: cada dato debe tener procedencia", () => {
  const check = (text: string, extra: Partial<Parameters<typeof verifyReply>[0]> = {}) => verifyReply({ text, facts: [HOURS], ...extra }).map((v) => v.code);

  it("acepta un texto natural que solo usa lo que dicen los datos de las herramientas (otras palabras, mismas cifras)", () => {
    expect(check("¡Claro! Atendemos de lunes a viernes, de 07:00 a 18:00. Si prefieres llamar, el número es 591 70000000.")).toEqual([]);
    expect(check("Buenos días, estamos abiertos de 7:00 a 18:00 de lunes a viernes.")).toEqual([]);
  });

  it("rechaza una cifra, hora, día, teléfono o enlace que no está en los datos", () => {
    expect(check("Entregamos tus resultados en 24 horas.")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Abrimos también los sábados hasta las 12:00.")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Llámanos al 591 71111111.")).toEqual(["UNGROUNDED_FIGURE"]);
    expect(check("Mira https://ejemplo.test/ubicacion")).toEqual(["UNGROUNDED_FIGURE"]);
  });

  it("una cifra que el propio paciente escribió no es un dato inventado", () => {
    expect(check("Anotado: 3 estudios.", { patientText: "quiero 3 estudios" })).toEqual([]);
    expect(check("Anotado: 4 estudios.", { patientText: "quiero 3 estudios" })).toEqual(["UNGROUNDED_FIGURE"]);
  });

  it("los nombres del catálogo con números («vitamina B12») se pueden nombrar si una herramienta los devolvió", () => {
    const named = fact("find_studies:1", "Estudio del catálogo: VITAMINA B12", "CATALOG");
    expect(verifyReply({ text: "Sí, tenemos VITAMINA B12.", facts: [named] })).toEqual([]);
  });

  it("ninguna cifra de dinero sale del redactor (símbolo, o número —en cifras o letras— junto a una moneda)", () => {
    expect(check("El hemograma cuesta Bs 45.")).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Son 45 bolivianos.")).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Cuesta cuarenta y cinco bolivianos.")).toContain("PRICE_OUTSIDE_QUOTE");
    expect(check("Sale $ ahora mismo")).toContain("PRICE_OUTSIDE_QUOTE");
  });

  it("«una persona» o «el equipo» a secas no es una promesa; prometer una acción solo se permite con una derivación registrada", () => {
    for (const text of ["Puedes venir acompañado de una persona de confianza.", "El equipo de toma de muestras atiende de 7:00 a 18:00."]) expect(check(text), text).not.toContain("UNREGISTERED_HANDOFF_PROMISE");
    for (const text of ["Una persona del laboratorio te contactará.", "Nuestro equipo te escribirá pronto.", "Voy a registrar tu caso.", "Ya derivé tu caso al equipo."]) expect(check(text), text).toContain("UNREGISTERED_HANDOFF_PROMISE");
    expect(check("Te paso con una persona de recepción.", { handoff: true })).toEqual([]);
    expect(check("No puedo pasarte con una persona por este medio.")).toEqual([]);
  });

  it("rechaza lo vacío o demasiado largo, y no castiga frases naturales con palabras corrientes", () => {
    expect(check("")).toEqual(["EMPTY_REPLY"]);
    expect(check("a ".repeat(600))).toContain("REPLY_TOO_LONG");
    for (const text of ["Con gusto, cuéntame qué estudios necesitas.", "Gracias por escribirnos, aquí estoy para ayudarte.", "Puedes enviarme una foto de tu receta o escribir los nombres de los estudios."]) expect(verifyReply({ text, facts: [] }), text).toEqual([]);
  });
});

// ───────────────────────────── herramientas ─────────────────────────────

describe("herramientas: solo lectura, acotadas, que nunca lanzan, y «sin datos» con su motivo", () => {
  const tool = (name: string, run: ToolDef["run"]): ToolDef => ({ name, description: name, readOnly: true, input: z.object({ q: z.string() }).strict(), run });

  it("el registro rechaza herramientas repetidas o que no sean de solo lectura", () => {
    expect(() => createToolRegistry([tool("a", async () => undefined), tool("a", async () => undefined)])).toThrow(/repetida/);
    expect(() => createToolRegistry([{ ...tool("w", async () => undefined), readOnly: false as unknown as true }])).toThrow(/solo lectura/);
  });

  it("ejecuta en orden, numera los hechos, junta los bloques del sistema, y traduce cada fallo a un código y una nota sin detener el turno", async () => {
    const registry = createToolRegistry([
      tool("ok", async () => ({ facts: [{ source: "LAB_INFO", text: "uno", refs: [] }, { source: "LAB_INFO", text: "dos", refs: [] }], blocks: ["BLOQUE"] })),
      tool("vacia", async () => undefined),
      tool("motivo", async () => ({ noData: "NO_TOPIC" })),
      tool("lenta", () => new Promise(() => undefined)),
      tool("rota", async () => { throw new Error("secreto"); })
    ]);
    const calls = [{ tool: "ok", input: { q: "x" } }, { tool: "vacia", input: { q: "x" } }, { tool: "motivo", input: { q: "x" } }, { tool: "lenta", input: { q: "x" } }, { tool: "rota", input: { q: "x" } }, { tool: "nada", input: {} }, { tool: "ok", input: { mal: 1 } }];
    const result = await runToolCalls(registry, calls, ctx, { timeoutMs: 20, maxCalls: 6 });
    expect(result.facts.map((f) => `${f.id}=${f.text}`)).toEqual(["ok:1=uno", "ok:2=dos"]);
    expect(result.blocks).toEqual(["BLOQUE"]);
    expect(result.runs.map((r) => `${r.tool}:${r.ok ? "ok" : `${r.error}${r.why ? `/${r.why}` : ""}`}`)).toEqual(["ok:ok", "vacia:NO_DATA", "motivo:NO_DATA/NO_TOPIC", "lenta:TIMEOUT", "rota:FAILED", "nada:UNKNOWN_TOOL", "ok:TOO_MANY_CALLS"]);
    // «sin datos» y los fallos pasan al modelo como notas (sin el mensaje del error); una herramienta inexistente no genera nota
    expect(result.notes).toEqual(["vacia: sin datos aprobados sobre eso", "motivo: sin datos aprobados sobre eso", "lenta: no respondió a tiempo", "rota: no se pudo consultar ahora", "ok: no se consultó (demasiadas consultas)"]);
    expect(JSON.stringify(result.notes)).not.toContain("secreto");
  });

  it("máximo de llamadas por turno y de hechos por llamada", async () => {
    const many = createToolRegistry([tool("t", async () => ({ facts: Array.from({ length: 10 }, (_, i) => ({ source: "LAB_INFO" as const, text: `h${i}`, refs: [] })) }))]);
    const result = await runToolCalls(many, Array.from({ length: 6 }, () => ({ tool: "t", input: { q: "x" } })), ctx);
    expect(result.runs.filter((r) => r.ok)).toHaveLength(TOOL_LIMITS.maxCalls);
    expect(result.facts.length).toBe(TOOL_LIMITS.maxCalls * TOOL_LIMITS.maxFactsPerCall);
  });

  describe("lab_info: ubicación, horarios y demás datos aprobados", () => {
    const answer = (body: string): KnowledgeAnswer => ({ body, refs: [{ kind: "SCHEDULE", key: "central", version: 2, contentHash: "abcdef0123456789abcdef" }], status: "ANSWERED", topics: [], unavailable: [] } as unknown as KnowledgeAnswer);

    it("devuelve el cuerpo aprobado con sus referencias", async () => {
      const found = await labInfoTool({ answer: async () => answer("Lunes a viernes de 07:00 a 18:00") }).run({ question: "a que hora abren" }, ctx);
      expect(found).toEqual({ facts: [{ source: "LAB_INFO", text: "Lunes a viernes de 07:00 a 18:00", refs: ["SCHEDULE:central@2:abcdef012345"] }] });
    });

    it("si la pregunta que armó el modelo no delata el tema, prueba con lo que el paciente escribió (una paráfrasis no deja la consulta en «sin datos»)", async () => {
      const asked: string[] = [];
      const tool = labInfoTool({ answer: async (text) => { asked.push(text); return /donde queda/.test(text) ? answer("Av. Central 123") : undefined; } });
      const found = await tool.run({ question: "información de contacto de la sucursal" }, { ...ctx, patientText: "oye donde queda el laboratorio" });
      expect(asked).toEqual(["información de contacto de la sucursal", "oye donde queda el laboratorio"]);
      expect(found).toMatchObject({ facts: [{ text: "Av. Central 123" }] });
    });

    it("sin dato: motivo NO_TOPIC (nada del conocimiento toca el tema) o NO_APPROVED_DATA (el tema existe pero no hay dato aprobado y vigente); nunca un texto de relleno", async () => {
      const none = labInfoTool({ answer: async () => undefined });
      expect(await none.run({ question: "cuanto cuesta el hemograma" }, ctx)).toEqual({ noData: "NO_TOPIC" });
      expect(await none.run({ question: "donde queda la sucursal" }, ctx)).toEqual({ noData: "NO_APPROVED_DATA" });
      expect(await labInfoTool({ answer: async () => ({ ...answer("x"), status: "CLARIFY" } as KnowledgeAnswer) }).run({ question: "a que hora abren" }, ctx)).toEqual({ noData: "NO_APPROVED_DATA" });
      expect(labInfoTool({ answer: async () => undefined }).input.safeParse({ question: "a" }).success).toBe(false);
    });
  });

  it("find_studies: coincidencias del catálogo SIN precios; sin coincidencias, «sin datos»", async () => {
    const find = findStudiesTool({ loadCatalog: async () => CATALOG });
    const found = await find.run({ query: "hemograma" }, ctx);
    expect(found).toMatchObject({ facts: [{ source: "CATALOG", text: "Estudio del catálogo: HEMOGRAMA COMPLETO", refs: [`study:${uuid(1)}`] }] });
    expect(JSON.stringify(found)).not.toMatch(/priceBs|\b45\b/);
    expect(await find.run({ query: "zzzz yyyy" }, ctx)).toEqual({ noData: "NO_MATCH" });
  });

  describe("quote_studies: la cotización sale del motor y del catálogo, nunca del modelo", () => {
    const quote = quoteStudiesTool({ loadCatalog: async () => CATALOG });
    const noPrices = (result: unknown) => expect(JSON.stringify((result as { facts: unknown }).facts)).not.toMatch(/\d+[.,]\d|\bBs\b|\b(45|30|75|40|42)\b/);

    it("todo identificado con certeza: hechos SIN precios y un bloque con los precios del catálogo", async () => {
      const result = (await quote.run({ studies: ["hemograma", "glucosa"] }, ctx)) as { facts: Array<{ text: string; source: string }>; blocks: string[] };
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]).toContain("HEMOGRAMA COMPLETO");
      expect(result.blocks[0]).toMatch(/75[.,]5/);
      noPrices(result);
      expect(result.facts[0]!.text).toContain("(2)");
      expect(result.facts.some((f) => /PARCIAL/.test(f.text))).toBe(false);
    });

    it("ambiguo (creatinina sérica o en orina): sin bloque; el hecho nombra las opciones, sin precios", async () => {
      const result = (await quote.run({ studies: ["creatinina"] }, ctx)) as { facts: Array<{ text: string }>; blocks?: string[] };
      expect(result.blocks ?? []).toEqual([]);
      expect(result.facts.map((f) => f.text).join(" ")).toMatch(/CREATININA SERICA.*CREATININA EN ORINA|CREATININA EN ORINA.*CREATININA SERICA/);
      noPrices(result);
    });

    it("un estudio seguro junto a uno desconocido o ambiguo se cotiza como PARCIAL (el bloque solo trae el seguro)", async () => {
      for (const other of ["perfil tiroideo completo", "creatinina"]) {
        const result = (await quote.run({ studies: ["hemograma", other] }, ctx)) as { facts: Array<{ text: string }>; blocks: string[] };
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]).toContain("HEMOGRAMA COMPLETO");
        expect(result.blocks[0]).not.toMatch(/CREATININA|PERFIL/);
        expect(result.facts.some((f) => /PARCIAL/.test(f.text))).toBe(true);
        noPrices(result);
      }
    });

    it("estudios que no están en el catálogo (o con errata) dan el hecho «no se pudo identificar», no «sin datos»: el agente puede preguntar", async () => {
      for (const studies of [["perfil tiroideo completo"], ["hemogrma"], ["ecografia abdominal", "resonancia"]]) {
        const result = (await quote.run({ studies }, ctx)) as { facts: Array<{ text: string }>; blocks?: string[] };
        expect(result.blocks ?? [], studies.join(",")).toEqual([]);
        expect(result.facts.some((f) => /No se pudo identificar con certeza \d+ estudio/.test(f.text))).toBe(true);
      }
    });

    it("un estudio inactivo o con precio inválido no se cotiza (el catálogo manda)", async () => {
      const inactive = quoteStudiesTool({ loadCatalog: async () => CATALOG.map((s) => (s.id === uuid(1) ? ({ ...s, active: false } as CatalogStudy) : s)) });
      expect(((await inactive.run({ studies: ["hemograma"] }, ctx)) as { blocks?: string[] }).blocks ?? []).toEqual([]);
      const broken = quoteStudiesTool({ loadCatalog: async () => CATALOG.map((s) => (s.id === uuid(1) ? ({ ...s, priceBs: 0 } as CatalogStudy) : s)) });
      expect(((await broken.run({ studies: ["hemograma"] }, ctx)) as { blocks?: string[] }).blocks ?? []).toEqual([]);
    });

    it("la entrada se valida (1 a 20 nombres, sin campos de más)", () => {
      expect(quote.input.safeParse({ studies: [] }).success).toBe(false);
      expect(quote.input.safeParse({ studies: Array(21).fill("hemograma") }).success).toBe(false);
      expect(quote.input.safeParse({ studies: ["hemograma"], precio: 1 }).success).toBe(false);
    });
  });

  it("conversation_state: la última cotización y la última receta por nombre del catálogo, sin precios ni texto; sin nada o sin base, «sin datos»", async () => {
    const rows = [
      encodeEvent({ id: "batch:w1", type: "PATIENT_BATCH", at: 1_000, items: [{ messageId: "w1", topic: "MEDIA_IMAGE", goal: "QUOTE" }] }),
      encodeEvent({ id: "quote:q1", type: "ARTIFACT", at: 3_000, artifact: { id: "Q:q1", kind: "QUOTE", studyIds: [uuid(1), uuid(5)], unrecognized: 0 } }),
      encodeEvent({ id: "recipe:r1", type: "ARTIFACT", at: 4_000, artifact: { id: "R:r1", kind: "RECIPE", studyIds: [uuid(2)], unrecognized: 2 } })
    ].map((row) => ({ key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }));
    const store: ConversationStore = { append: async () => ({ recorded: 0, duplicate: 0 }), read: async () => rows, contactsSince: async () => [] };
    const reader = createConversationReader({ store, now: () => 10_000 });
    const found = (await conversationStateTool({ reader, contactKey: "a".repeat(64), loadCatalog: async () => CATALOG }).run({}, ctx)) as { facts: Array<{ text: string }> };
    expect(found.facts.map((f) => f.text)).toEqual(["Última cotización entregada en esta conversación: HEMOGRAMA COMPLETO; TSH", "Última receta enviada por el paciente: GLUCOSA EN AYUNAS y 2 puntos sin reconocer"]);
    expect(JSON.stringify(found)).not.toMatch(/priceBs|Bs|Pendiente/);
    const down = createConversationReader({ store: { ...store, read: async () => { throw new Error("down"); } } });
    expect(await conversationStateTool({ reader: down, contactKey: "a".repeat(64) }).run({}, ctx)).toEqual({ noData: "NO_STATE" });
    const empty = createConversationReader({ store: { ...store, read: async () => [] } });
    expect(await conversationStateTool({ reader: empty, contactKey: "a".repeat(64) }).run({}, ctx)).toEqual({ noData: "NO_STATE" });
  });
});

// ───────────────────────────── tubería ─────────────────────────────

describe("runAgentTurn: tubería corta con un modelo simulado", () => {
  const knowledge = labInfoTool({ answer: async (q) => (/hora|abren/.test(q) ? ({ body: "Lunes a viernes de 07:00 a 18:00", refs: [], status: "ANSWERED", topics: [], unavailable: [] } as unknown as KnowledgeAnswer) : undefined) });
  const tools = createToolRegistry([knowledge, quoteStudiesTool({ loadCatalog: async () => CATALOG })]);
  interface Seen { plan?: PlanInput; respond: RespondInput[] }
  const model = (plan: Partial<PlanOutput> | Error, texts: Array<string | Error>, seen: Seen = { respond: [] }): AgentModel => ({
    async plan(input) { seen.plan = input; if (plan instanceof Error) throw plan; return { toolCalls: [], ...plan, usage: { inputTokens: 100, outputTokens: 20 } }; },
    async respond(input) { seen.respond.push(input); const next = texts[Math.min(seen.respond.length - 1, texts.length - 1)]!; if (next instanceof Error) throw next; return { text: next, usage: { inputTokens: 300, outputTokens: 80, reasoningTokens: 40 } }; }
  });
  const hours = { tool: "lab_info", input: { question: "a que hora abren" } };
  const quote = { tool: "quote_studies", input: { studies: ["hemograma"] } };

  it("camino feliz: consulta lo que necesita y el SISTEMA agrega la cotización con precios del catálogo", async () => {
    const seen: Seen = { respond: [] };
    const decision = await runAgentTurn({ model: model({ toolCalls: [hours, quote] }, ["Atendemos de lunes a viernes, de 07:00 a 18:00. Abajo tienes el detalle de tu cotización."], seen), tools }, { utterances: [u("a que hora abren y cotiza hemograma")], recent: [{ from: "PATIENT", text: "hola" }] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toContain("07:00 a 18:00");
    expect(decision.reply).toContain("HEMOGRAMA COMPLETO");
    expect(decision.reply).toMatch(/45/);
    expect(decision).toMatchObject({ quoted: true, usage: { calls: 2, inputTokens: 400, outputTokens: 100, reasoningTokens: 40 } });
    expect(decision.toolRuns.map((run) => `${run.tool}:${run.ok}`)).toEqual(["lab_info:true", "quote_studies:true"]);
    expect(seen.plan?.recent).toEqual([{ from: "PATIENT", text: "hola" }]);
    expect(seen.respond[0]!.hasQuoteBlock).toBe(true);
    // el modelo nunca ve un precio
    expect(JSON.stringify(seen.respond[0]!.facts)).not.toMatch(/\b45\b|Bs/);
  });

  it("sin herramientas (saludo, charla): responde con naturalidad, una sola llamada de redacción", async () => {
    const decision = await runAgentTurn({ model: model({}, ["¡Hola! ¿En qué te puedo ayudar?"]), tools }, { utterances: [u("hola", "SOCIAL")] });
    expect(decision).toMatchObject({ status: "VERIFIED", reply: "¡Hola! ¿En qué te puedo ayudar?", toolRuns: [], usage: { calls: 2 } });
    expect(decision.quoted).toBeUndefined();
  });

  it("«sin datos» NO es un fallo: el modelo recibe la nota y la respuesta honesta sale verificada", async () => {
    const seen: Seen = { respond: [] };
    const decision = await runAgentTurn({ model: model({ toolCalls: [{ tool: "lab_info", input: { question: "donde queda" } }] }, ["Ahora mismo no tengo la dirección confirmada. ¿Te ayudo con algo más?"], seen), tools }, { utterances: [u("donde queda el laboratorio")] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.toolRuns).toEqual([{ tool: "lab_info", ok: false, error: "NO_DATA", why: "NO_APPROVED_DATA", factIds: [] }]);
    expect(seen.respond[0]!.notes).toEqual(["lab_info: sin datos aprobados sobre eso"]);
  });

  it("una herramienta que falla o no existe tampoco tumba el turno", async () => {
    const decision = await runAgentTurn({ model: model({ toolCalls: [{ tool: "inventada", input: {} }, { tool: "quote_studies", input: { studies: [] } }] }, ["Con gusto, ¿qué estudios necesitas?"]), tools }, { utterances: [u("cotiza")] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.toolRuns.map((run) => run.error)).toEqual(["UNKNOWN_TOOL", "INVALID_INPUT"]);
  });

  it("un plan ilegible NO tumba el turno: se responde sin herramientas y el motivo queda en el registro", async () => {
    const decision = await runAgentTurn({ model: model({ fallback: "plan_not_json" }, ["Con gusto, cuéntame qué necesitas."]), tools }, { utterances: [u("hola")] });
    expect(decision).toMatchObject({ status: "VERIFIED", planFallback: "plan_not_json" });
  });

  it("un texto con una cifra inventada se repara UNA vez con los códigos; si insiste, REJECTED (responde el modo esencial)", async () => {
    const seen: Seen = { respond: [] };
    const fixed = await runAgentTurn({ model: model({ toolCalls: [hours] }, ["Abrimos hasta las 20:00.", "Atendemos de lunes a viernes de 07:00 a 18:00."], seen), tools }, { utterances: [u("a que hora abren")] });
    expect(fixed).toMatchObject({ status: "VERIFIED", repairs: 1, firstViolations: [{ code: "UNGROUNDED_FIGURE" }], usage: { calls: 3 } });
    expect(seen.respond[1]!.feedback).toEqual([{ code: "UNGROUNDED_FIGURE", detail: expect.any(String) }]);
    const stubborn = await runAgentTurn({ model: model({ toolCalls: [hours] }, ["Abrimos hasta las 20:00."]), tools }, { utterances: [u("a que hora abren")] });
    expect(stubborn).toMatchObject({ status: "REJECTED", violations: [{ code: "UNGROUNDED_FIGURE" }], repairs: 1 });
    expect(stubborn.reply).toBeUndefined();
  });

  it("los pagos se ignoran: si el modelo los menciona, esas oraciones se recortan y el resto sale; si solo hablaba de pagos, no queda nada y se rechaza", async () => {
    const some = await runAgentTurn({ model: model({ toolCalls: [hours] }, ["Abrimos lunes a viernes de 07:00 a 18:00. Y sí, puedes pagar con QR."]), tools }, { utterances: [u("horario y pago con qr")] });
    expect(some.reply).toBe("Abrimos lunes a viernes de 07:00 a 18:00.");
    const only = await runAgentTurn({ model: model({}, ["Sí, puedes pagar con QR."]), tools }, { utterances: [u("se puede pagar con qr")] });
    expect(only.status).toBe("REJECTED");
  });

  it("errores del modelo: del proveedor (con su causa en código) o una salida vacía/ilegible (con motivo, etapa y detalle); nunca el mensaje", async () => {
    const quota = Object.assign(new Error("secreto del proveedor"), { name: "RateLimitError", status: 429, code: "insufficient_quota" });
    const a = await runAgentTurn({ model: model(quota, ["x"]), tools }, { utterances: [u("hola")] });
    expect(a).toMatchObject({ status: "MODEL_ERROR", modelError: { cause: "QUOTA_OR_BILLING", httpStatus: 429 } });
    expect(JSON.stringify(a)).not.toContain("secreto");
    const b = await runAgentTurn({ model: model({}, [new AgentOutputError("empty_incomplete_max_output_tokens", undefined, "respond")]), tools }, { utterances: [u("hola")] });
    expect(b.modelError).toEqual({ cause: "INVALID_OUTPUT", stage: "respond", reason: "empty_incomplete_max_output_tokens" });
  });

  it("sin mensajes no hay nada que decidir", async () => {
    expect(await runAgentTurn({ model: model({}, ["x"]), tools }, { utterances: [] })).toMatchObject({ status: "VERIFIED", usage: { calls: 0 } });
  });

  describe("derivación a una persona", () => {
    const withCrm = { handoff: true, quote: true };
    it("solo si el plan la pide Y la capacidad existe: el caso se registra ANTES de entregar el mensaje, y solo entonces el texto puede decirlo", async () => {
      const handoff = vi.fn(async () => true);
      const seen: Seen = { respond: [] };
      const decision = await runAgentTurn({ model: model({ handoff: "HUMAN_REQUEST" }, ["Listo, una persona del laboratorio te atenderá."], seen), tools, handoff }, { utterances: [u("quiero hablar con una persona", "HUMAN_REQUEST")], capabilities: withCrm });
      expect(decision).toMatchObject({ status: "VERIFIED", handoffRequested: true, handoffRegistered: true });
      expect(handoff).toHaveBeenCalledWith("HUMAN_REQUEST");
      expect(seen.respond[0]!.handoff).toBe(true);
    });

    it("si no se registra (o el turno ya no puede producir efectos), no hay mensaje: HANDOFF_FAILED", async () => {
      const failing = await runAgentTurn({ model: model({ handoff: "HUMAN_REQUEST" }, ["Listo, una persona te atenderá."]), tools, handoff: async () => false }, { utterances: [u("persona", "HUMAN_REQUEST")], capabilities: withCrm });
      expect(failing).toMatchObject({ status: "HANDOFF_FAILED", handoffRequested: true });
      expect(failing.reply).toBeUndefined();
      const handoff = vi.fn(async () => true);
      const late = await runAgentTurn({ model: model({ handoff: "OUT_OF_SCOPE" }, ["Listo, una persona te atenderá."]), tools, handoff, cancelled: () => true }, { utterances: [u("persona")], capabilities: withCrm });
      expect(late.status).toBe("HANDOFF_FAILED");
      expect(handoff).not.toHaveBeenCalled();
    });

    it("sin la capacidad el plan se ignora: nada se registra y el texto no puede prometer a nadie", async () => {
      const handoff = vi.fn(async () => true);
      const seen: Seen = { respond: [] };
      const ok = await runAgentTurn({ model: model({ handoff: "HUMAN_REQUEST" }, ["Por este medio no puedo pasarte con una persona, pero te ayudo con lo demás."], seen), tools, handoff }, { utterances: [u("persona", "HUMAN_REQUEST")], capabilities: CAPS });
      expect(ok).toMatchObject({ status: "VERIFIED" });
      expect(handoff).not.toHaveBeenCalled();
      expect(seen.respond[0]!.handoff).toBe(false);
      const promise = await runAgentTurn({ model: model({ handoff: "HUMAN_REQUEST" }, ["Una persona del laboratorio te contactará."]), tools, handoff }, { utterances: [u("persona", "HUMAN_REQUEST")], capabilities: CAPS });
      expect(promise.status).toBe("REJECTED");
    });
  });

  describe("silencio ante lo claramente ajeno al laboratorio", () => {
    const other = u("mira el partido de anoche", "OTHER");
    const run = async (utterances: Utterance[], recent: Array<{ from: "PATIENT" | "ASSISTANT" | "STAFF"; text: string }>, silent = true) => {
      const seen: Seen = { respond: [] };
      const decision = await runAgentTurn({ model: model({ silent }, ["Hola, ¿en qué te ayudo?"], seen), tools }, { utterances, recent });
      return { decision, calls: seen.respond.length };
    };

    it("el modelo lo propone, las reglas no ven nada del laboratorio y no hay conversación previa → SILENT, sin redactar ni enviar", async () => {
      const { decision, calls } = await run([other], []);
      expect(decision).toMatchObject({ status: "SILENT", usage: { calls: 1 } });
      expect(decision.reply).toBeUndefined();
      expect(calls).toBe(0);
    });

    it("ante CUALQUIER duda se responde: el modelo no lo propone, las reglas ven algo del laboratorio, o ya se está conversando", async () => {
      expect((await run([other], [], false)).decision.status).toBe("VERIFIED");
      expect((await run([u("a que hora abren", "INFO_REQUEST")], [])).decision.status).toBe("VERIFIED");
      expect((await run([u("tengo turno con el dentista", "OTHER_LAB")], [])).decision.status).toBe("VERIFIED");
      expect((await run([other], [{ from: "ASSISTANT", text: "¿Eso es todo?" }])).decision.status).toBe("VERIFIED");
      expect((await run([other], [{ from: "PATIENT", text: "hola" }])).decision.status).toBe("VERIFIED");
      expect((await run([other, u("cotiza hemograma", "RECIPE_OR_QUOTE")], [])).decision.status).toBe("VERIFIED");
    });
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
