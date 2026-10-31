import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createStudyInterpreter, createToolbox, INTERPRETER_JSON_SCHEMA, INTERPRETER_PROMPT, INTERPRETER_TOOLS, validateInterpretation, type InterpreterClient, type InterpreterRun } from "../src/study-interpreter.js";
import { resolveStudyInterpreter } from "../src/study-interpreter-openai.js";
import { CATALOG, COLESTEROL, COLESTEROL_LDL, GLUCOSA, GLUCOSA_POST, HEMOGRAMA, TRIGLICERIDOS, uuid, VITAMINA_D_INACTIVA } from "./support/study-catalog.js";

// Intérprete de estudios: herramientas sobre el catálogo, validación del backend, circuito y configuración. Cliente SIMULADO: ninguna prueba llama a OpenAI.

type Item = { mention: string; outcome: "MATCH" | "AMBIGUOUS" | "NOT_FOUND"; confidence: "HIGH" | "LOW"; studyIds: string[] };
const output = (items: Item[], over: Partial<{ isQuoteRequest: boolean; wantsQuote: boolean }> = {}) => JSON.stringify({ isQuoteRequest: true, wantsQuote: false, items, ...over });
const match = (mention: string, id: string, confidence: "HIGH" | "LOW" = "HIGH"): Item => ({ mention, outcome: "MATCH", confidence, studyIds: [id] });
// `seen` con lo que el modelo "buscó".
const seenOf = (...ids: string[]) => new Map(CATALOG.filter((study) => ids.includes(study.id)).map((study) => [study.id, study]));

describe("herramientas sobre el catálogo", () => {
  it("search_studies devuelve candidatos con id, nombre y alias, SIN precios", () => {
    const box = createToolbox(CATALOG);
    const result = JSON.parse(box.run("search_studies", { query: "glucoza" }));
    expect(result.results[0]).toMatchObject({ id: GLUCOSA.id, name: "GLUCOSA" });
    expect(JSON.stringify(result)).not.toMatch(/price|precio|priceBs|\b\d{2,3}\.\d\b/i);
    expect(Object.keys(result.results[0]).sort()).toEqual(["aliases", "id", "name", "score"]);
    expect(box.seen.has(GLUCOSA.id)).toBe(true);
  });

  it("solo se acepta lo que el modelo obtuvo de las herramientas: lo no consultado no queda en `seen`", () => {
    const box = createToolbox(CATALOG);
    box.run("search_studies", { query: "hemograma" });
    expect(box.seen.has(HEMOGRAMA.id)).toBe(true);
    expect(box.seen.has(GLUCOSA.id)).toBe(false);
  });

  it("get_study devuelve nombre, código, categoría y alias; un id inexistente o inactivo es un error", () => {
    const box = createToolbox(CATALOG);
    const found = JSON.parse(box.run("get_study", { studyId: HEMOGRAMA.id }));
    expect(found).toMatchObject({ id: HEMOGRAMA.id, name: HEMOGRAMA.name, aliases: ["hemograma completo", "hemograma"] });
    expect(JSON.stringify(found)).not.toMatch(/price/i);
    expect(JSON.parse(box.run("get_study", { studyId: uuid(999) }))).toHaveProperty("error");
    expect(JSON.parse(box.run("get_study", { studyId: VITAMINA_D_INACTIVA.id }))).toHaveProperty("error");
    expect(box.seen.has(VITAMINA_D_INACTIVA.id)).toBe(false);
  });

  it("sin coincidencias lo dice; argumentos inválidos y herramientas desconocidas no rompen", () => {
    const box = createToolbox(CATALOG);
    expect(JSON.parse(box.run("search_studies", { query: "tomografia" }))).toMatchObject({ results: [] });
    expect(JSON.parse(box.run("search_studies", {}))).toHaveProperty("error");
    expect(JSON.parse(box.run("search_studies", undefined))).toHaveProperty("error");
    expect(JSON.parse(box.run("borrar_todo", {}))).toHaveProperty("error");
  });

  it("limita la cantidad de consultas por mensaje", () => {
    const box = createToolbox(CATALOG, 3);
    for (let i = 0; i < 3; i++) expect(JSON.parse(box.run("search_studies", { query: "glucosa" }))).toHaveProperty("results");
    expect(JSON.parse(box.run("search_studies", { query: "glucosa" }))).toHaveProperty("error");
  });

  it("las definiciones de herramientas son estrictas y el prompt no menciona precios que deba dar", () => {
    expect(INTERPRETER_TOOLS.map((tool) => tool.name)).toEqual(["search_studies", "get_study"]);
    for (const tool of INTERPRETER_TOOLS) expect(tool.parameters).toMatchObject({ additionalProperties: false });
    expect(INTERPRETER_PROMPT).toContain("No des precios");
    expect(JSON.stringify(INTERPRETER_JSON_SCHEMA)).not.toMatch(/price|precio/i);
  });
});

describe("validateInterpretation: el backend no se fía del modelo", () => {
  it("MATCH con un estudio que el modelo SÍ buscó y con seguridad alta se acepta (objeto del catálogo, no lo que diga el modelo)", () => {
    const result = validateInterpretation(JSON.parse(output([match("glucoza", GLUCOSA.id)])), CATALOG, seenOf(GLUCOSA.id));
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.study).toBe(CATALOG.find((study) => study.id === GLUCOSA.id));
    expect(result.matched[0]).toMatchObject({ mention: "glucoza", exact: false });
    expect(validateInterpretation(JSON.parse(output([match("hemograma", HEMOGRAMA.id)])), CATALOG, seenOf(HEMOGRAMA.id)).matched[0]!.exact).toBe(true);
  });

  it("un id que el modelo NO obtuvo de las herramientas se rechaza aunque exista en el catálogo", () => {
    const result = validateInterpretation(JSON.parse(output([match("glucosa", GLUCOSA.id)])), CATALOG, seenOf(HEMOGRAMA.id));
    expect(result.matched).toEqual([]);
    expect(result.unclear).toEqual(["glucosa"]);
  });

  it("un id inventado o inactivo se rechaza", () => {
    expect(validateInterpretation(JSON.parse(output([match("algo", uuid(777))])), CATALOG, seenOf()).unclear).toEqual(["algo"]);
    const inactive = new Map([[VITAMINA_D_INACTIVA.id, VITAMINA_D_INACTIVA]]);
    const result = validateInterpretation(JSON.parse(output([match("vitamina d", VITAMINA_D_INACTIVA.id)])), CATALOG, inactive);
    expect(result.matched).toEqual([]);
    expect(result.unclear).toEqual(["vitamina d"]);
  });

  it("poca seguridad o varios ids en un MATCH no se cotizan: se pide el nombre exacto", () => {
    expect(validateInterpretation(JSON.parse(output([match("glucosa", GLUCOSA.id, "LOW")])), CATALOG, seenOf(GLUCOSA.id)).unclear).toEqual(["glucosa"]);
    const two: Item = { mention: "glucosa", outcome: "MATCH", confidence: "HIGH", studyIds: [GLUCOSA.id, GLUCOSA_POST.id] };
    expect(validateInterpretation(JSON.parse(output([two])), CATALOG, seenOf(GLUCOSA.id, GLUCOSA_POST.id)).matched).toEqual([]);
  });

  it("AMBIGUOUS válido (2 a 6 estudios vistos) pasa a opciones; con ids no vistos se pide el nombre exacto", () => {
    const item: Item = { mention: "colesterol", outcome: "AMBIGUOUS", confidence: "HIGH", studyIds: [COLESTEROL.id, COLESTEROL_LDL.id] };
    const ok = validateInterpretation(JSON.parse(output([item])), CATALOG, seenOf(COLESTEROL.id, COLESTEROL_LDL.id));
    expect(ok.ambiguous).toHaveLength(1);
    expect(ok.ambiguous[0]!.candidates.map((candidate) => candidate.id)).toEqual([COLESTEROL.id, COLESTEROL_LDL.id]);
    expect(validateInterpretation(JSON.parse(output([item])), CATALOG, seenOf(COLESTEROL.id)).unclear).toEqual(["colesterol"]);
    expect(validateInterpretation(JSON.parse(output([{ ...item, studyIds: [COLESTEROL.id] }])), CATALOG, seenOf(COLESTEROL.id)).ambiguous).toEqual([]);
  });

  it("NOT_FOUND solo se acepta si el backend también comprueba que el catálogo no tiene nada parecido", () => {
    const missing: Item = { mention: "tomografía de tórax", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] };
    expect(validateInterpretation(JSON.parse(output([missing])), CATALOG, seenOf()).notFound).toEqual(["tomografía de tórax"]);
  });

  it("NOT_FOUND de algo que el catálogo SÍ tiene no se informa como inexistente: varias opciones → pregunta; una sola → nombre exacto", () => {
    const wrongMany = validateInterpretation(JSON.parse(output([{ mention: "glucosa", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] }])), CATALOG, seenOf());
    expect(wrongMany.notFound).toEqual([]);
    expect(wrongMany.ambiguous[0]!.candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([GLUCOSA.id, GLUCOSA_POST.id]));
    const wrongOne = validateInterpretation(JSON.parse(output([{ mention: "trigliseridos", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] }])), CATALOG, seenOf());
    expect(wrongOne.notFound).toEqual([]);
    expect(wrongOne.unclear).toEqual(["trigliseridos"]);
  });

  it("NOT_FOUND con ids, o sin nombre, no se toma como inexistente", () => {
    expect(validateInterpretation(JSON.parse(output([{ mention: "tomografia", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [GLUCOSA.id] }])), CATALOG, seenOf(GLUCOSA.id)).notFound).toEqual([]);
    expect(validateInterpretation(JSON.parse(output([{ mention: "  ", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] }])), CATALOG, seenOf()).notFound).toEqual([]);
  });

  it("un estudio repetido cuenta una vez, y una duda sobre algo ya identificado no se vuelve a preguntar", () => {
    const amb: Item = { mention: "colesterol", outcome: "AMBIGUOUS", confidence: "HIGH", studyIds: [COLESTEROL.id, COLESTEROL_LDL.id] };
    const result = validateInterpretation(JSON.parse(output([match("colesterol total", COLESTEROL.id), match("colesterol total", COLESTEROL.id), amb])), CATALOG, seenOf(COLESTEROL.id, COLESTEROL_LDL.id));
    expect(result.matched).toHaveLength(1);
    expect(result.ambiguous).toEqual([]);
  });

  it("la mención que se le repetirá al paciente se limpia (sin enlaces, correos ni símbolos)", () => {
    const result = validateInterpretation(JSON.parse(output([{ mention: "tomografía <script>alert(1)</script>", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] }, { mention: "visita http://malo.example/x", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] }])), CATALOG, seenOf());
    expect(result.notFound.join(" ")).not.toMatch(/[<>*_~`]/);
    expect(result.notFound.some((mention) => /http|malo/.test(mention))).toBe(false);
  });

  it("la salida debe cumplir el esquema estricto: un campo de precio o de más se rechaza", () => {
    const withPrice = JSON.stringify({ isQuoteRequest: true, wantsQuote: true, items: [{ ...match("glucosa", GLUCOSA.id), priceBs: 1 }] });
    expect(() => validateInterpretation(JSON.parse(withPrice), CATALOG, seenOf(GLUCOSA.id))).toThrow();
    expect(() => validateInterpretation({ isQuoteRequest: true }, CATALOG, seenOf())).toThrow();
    expect(() => validateInterpretation({ isQuoteRequest: true, wantsQuote: false, items: Array.from({ length: 21 }, () => match("x", GLUCOSA.id)) }, CATALOG, seenOf())).toThrow();
  });
});

// ───────────────────────────── el intérprete completo ─────────────────────────────

function scripted(handler: (run: InterpreterRun) => string | Promise<string>, over: { toolCalls?: number } = {}) {
  const runs: InterpreterRun[] = [];
  const client: InterpreterClient = {
    run: vi.fn(async (run) => {
      runs.push(run);
      const text = await handler(run);
      return { text, rounds: 2, toolCalls: over.toolCalls ?? 1, usage: { inputTokens: 10, outputTokens: 5 } };
    })
  };
  return { client, runs };
}
const make = (client: InterpreterClient, over: Partial<Parameters<typeof createStudyInterpreter>[0]> = {}) => {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const interpret = createStudyInterpreter({ client, model: "modelo-de-prueba", log: (event, data) => logs.push([event, data]), ...over });
  return { interpret, logs };
};
// Un modelo que busca cada mención con la herramienta y la clasifica según lo que encontró.
const searchingModel = (queries: string[], wantsQuote = false) => (run: InterpreterRun) => {
  const items: Item[] = queries.map((query) => {
    const found = JSON.parse(run.runTool("search_studies", { query })).results as Array<{ id: string; score: number }>;
    return found.length > 0 && found[0]!.score >= 0.7 ? match(query, found[0]!.id) : { mention: query, outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] };
  });
  return output(items, { wantsQuote });
};

describe("createStudyInterpreter", () => {
  it("interpreta con las herramientas: errores de ortografía y abreviaturas llegan como estudios del catálogo", async () => {
    const { client } = scripted(searchingModel(["glucoza", "bh"], true));
    const { interpret, logs } = make(client);
    const result = await interpret("cotízame glucoza y bh", CATALOG, { hasDoubt: true });
    expect(result!.matched.map((item) => item.study.id).sort()).toEqual([GLUCOSA.id, HEMOGRAMA.id].sort());
    expect(result!.wantsQuote).toBe(true);
    expect(logs.find(([event]) => event === "quote_interpreter")![1]).toMatchObject({ outcome: "OK", matched: 2, notFound: 0 });
  });

  it("informa lo que falta: el catálogo no tiene tomografía", async () => {
    const { interpret } = make(scripted(searchingModel(["hemograma", "tomografia"])).client);
    const result = await interpret("hemograma y tomografia", CATALOG, { hasDoubt: true });
    expect(result!.matched.map((item) => item.study.id)).toEqual([HEMOGRAMA.id]);
    expect(result!.notFound).toEqual(["tomografia"]);
  });

  it("un modelo que inventa un id (nunca lo buscó) no consigue que se cotice algo", async () => {
    const { interpret } = make(scripted(() => output([match("trigliceridos", TRIGLICERIDOS.id)])).client);
    const result = await interpret("cotiza trigliceridos", CATALOG, { hasDoubt: true });
    expect(result!.matched).toEqual([]);
    expect(result!.unclear).toEqual(["trigliceridos"]);
  });

  it("envía al proveedor solo el texto saneado y recortado, con las herramientas y el prompt", async () => {
    const { client, runs } = scripted(searchingModel(["glucosa"]));
    const { interpret } = make(client);
    await interpret(`cotiza glucosa, mi correo es ana@correo.com y mi cédula 7654321 ${"x".repeat(900)}`, CATALOG, { hasDoubt: true });
    const run = runs[0]!;
    expect(run.message).not.toMatch(/@|7654321|\d{4,}/);
    expect(run.message.length).toBeLessThan(900);
    expect(run.instructions).toBe(INTERPRETER_PROMPT);
    expect(run.tools).toBe(INTERPRETER_TOOLS);
    expect(run.schema).toBe(INTERPRETER_JSON_SCHEMA);
    expect(run.message).toContain('"""');
  });

  it("charla sin pedido de estudios NO consulta al modelo; lo médico tampoco, nunca", async () => {
    const { client } = scripted(searchingModel([]));
    const { interpret } = make(client);
    for (const text of ["hola buenas tardes", "gracias por todo", "quiero saber si abren hoy"]) expect(await interpret(text, CATALOG, { hasDoubt: false }), text).toBeUndefined();
    for (const text of ["tengo fiebre y quiero un hemograma", "mi doctor me pidió glucosa por la diabetes"]) expect(await interpret(text, CATALOG, { hasDoubt: true }), text).toBeUndefined();
    expect(client.run).not.toHaveBeenCalled();
  });

  it("un pedido natural sin el nombre exacto sí llega al modelo", async () => {
    const { client } = scripted(() => output([{ mention: "perfil lipidico", outcome: "NOT_FOUND", confidence: "HIGH", studyIds: [] }], { wantsQuote: true }));
    const { interpret } = make(client);
    const result = await interpret("mi mamá quiere hacerse el perfil lipidico", CATALOG, { hasDoubt: false });
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(result!.notFound).toEqual(["perfil lipidico"]);
  });

  it("cualquier falla devuelve undefined (el mensaje sigue por el resolvedor exacto) y no registra el texto", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const bad = [() => { throw new Error("fila con SECRETO-XYZ"); }, () => "no es json", () => output([], {}).replace('"items":[]', '"items":"x"'), () => JSON.stringify({ isQuoteRequest: true, wantsQuote: false, items: [], precio: 1 })];
    for (const handler of bad) {
      const interpret = createStudyInterpreter({ client: scripted(handler).client, model: "m", failureThreshold: 99, log: (event, data) => logs.push([event, data]) });
      expect(await interpret("cotiza glucosa", CATALOG, { hasDoubt: true })).toBeUndefined();
    }
    expect(logs.map(([, data]) => data.reason)).toEqual(["ERROR", "INVALID_OUTPUT", "INVALID_OUTPUT", "INVALID_OUTPUT"]);
    expect(JSON.stringify(logs)).not.toContain("SECRETO-XYZ");
  });

  it("abre el circuito tras fallas seguidas y se recupera pasado el enfriamiento", async () => {
    let now = 1_000;
    let healthy = false;
    const { client } = scripted((run) => { if (!healthy) throw new Error("caído"); return searchingModel(["glucosa"])(run); });
    const { interpret, logs } = make(client, { now: () => now, failureThreshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(await interpret("cotiza glucosa", CATALOG, { hasDoubt: true })).toBeUndefined();
    expect(client.run).toHaveBeenCalledTimes(3);
    expect(await interpret("cotiza glucosa", CATALOG, { hasDoubt: true })).toBeUndefined();
    expect(client.run).toHaveBeenCalledTimes(3);
    expect(logs.at(-1)![1]).toMatchObject({ reason: "CIRCUIT_OPEN" });
    now += 61_000;
    healthy = true;
    expect((await interpret("cotiza glucosa", CATALOG, { hasDoubt: true }))!.matched).toHaveLength(1);
  });

  it("el registro lleva solo códigos y contadores, nunca el mensaje ni las menciones", async () => {
    const { interpret, logs } = make(scripted(searchingModel(["texto-privado-QWERTY"])).client);
    await interpret("cotiza texto-privado-QWERTY por favor", CATALOG, { hasDoubt: true });
    expect(JSON.stringify(logs)).not.toContain("QWERTY");
  });
});

describe("resolveStudyInterpreter: apagado salvo configuración completa", () => {
  const { client } = scripted(() => output([]));
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (event: string, data: Record<string, unknown>) => logs.push([event, data]);
  const ON = { PLUSMEDIK_SMART_QUOTES: "on", OPENAI_QUOTE_MODEL: "gpt-4.1-mini", OPENAI_API_KEY: "sk-prueba" };

  it("apagado por defecto y con cualquier valor distinto de «on»", () => {
    for (const value of [undefined, "", "off", "true", "1"]) expect(resolveStudyInterpreter({ ...ON, PLUSMEDIK_SMART_QUOTES: value }, log, { textQuotesActive: true, client })).toBeUndefined();
  });

  it("falla cerrado, registrando solo un código (no hay modelo por defecto)", () => {
    logs.length = 0;
    expect(resolveStudyInterpreter(ON, log, { textQuotesActive: false, client })).toBeUndefined();
    expect(resolveStudyInterpreter({ ...ON, OPENAI_QUOTE_MODEL: undefined }, log, { textQuotesActive: true, client })).toBeUndefined();
    expect(resolveStudyInterpreter({ ...ON, OPENAI_QUOTE_MODEL: "modelo con espacios" }, log, { textQuotesActive: true, client })).toBeUndefined();
    expect(resolveStudyInterpreter({ ...ON, OPENAI_API_KEY: undefined }, log, { textQuotesActive: true })).toBeUndefined();
    expect(resolveStudyInterpreter({ ...ON, OPENAI_QUOTE_REASONING: "extremo" }, log, { textQuotesActive: true, client })).toBeUndefined();
    expect(resolveStudyInterpreter({ ...ON, PLUSMEDIK_SMART_QUOTES_TIMEOUT_MS: "500" }, log, { textQuotesActive: true, client })).toBeUndefined();
    expect(logs.map(([, data]) => data.error)).toEqual(["TEXT_QUOTES_REQUIRED", "MISSING_MODEL", "INVALID_MODEL", "MISSING_API_KEY", "INVALID_REASONING", "INVALID_TIMEOUT"]);
    expect(JSON.stringify(logs)).not.toContain("sk-prueba");
  });

  it("con todo válido queda activo", () => {
    expect(resolveStudyInterpreter(ON, log, { textQuotesActive: true, client })).toBeTypeOf("function");
    expect(resolveStudyInterpreter({ ...ON, OPENAI_QUOTE_REASONING: "low", PLUSMEDIK_SMART_QUOTES_TIMEOUT_MS: "20000" }, log, { textQuotesActive: true, client })).toBeTypeOf("function");
  });
});

describe("fronteras de los módulos del intérprete (análisis estático)", () => {
  const code = (file: string) => readFileSync(join(__dirname, "..", file), "utf8").replaceAll("\r\n", "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("solo el adaptador habla con OpenAI, respeta el modo offline y no guarda nada en el proveedor", () => {
    const adapter = code("src/study-interpreter-openai.ts");
    expect(adapter).toMatch(/assertModelCallsAllowed\("quote_interpreter", "openai"/);
    expect(adapter).toMatch(/store: false/);
    expect(adapter).toMatch(/maxRetries: 0/);
    for (const file of ["src/study-interpreter.ts", "src/catalog-search.ts"]) expect(code(file), file).not.toMatch(/from "openai"|new OpenAI|responses\.create|process\.env|\bfetch\s*\(/);
  });

  it("el intérprete y la búsqueda no leen ni escriben la base: trabajan sobre el catálogo que reciben", () => {
    for (const file of ["src/study-interpreter.ts", "src/catalog-search.ts"]) expect(code(file), file).not.toMatch(/supabase|\/rest\/v1|\.rpc\(|createSupabase|audit/i);
  });

  it("el registro no incluye texto del paciente ni menciones", () => {
    const calls = [...code("src/study-interpreter.ts").matchAll(/record\(\{[^}]*\}\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[0]).not.toMatch(/\b(text|message|mention|reply)\b\s*[,:}]/);
  });
});

describe("compactQuote y wantsQuoteNow (cotizaciones de texto)", () => {
  it("compactQuote no pierde ninguna línea con contenido", async () => {
    const { compactQuote } = await import("../src/quote-session.js");
    const original = ["🩺 *PlusMedik* · Cotización de tu receta", "", "🍬 GLUCOSA — Bs 30", "", "💰 *Total: Bs 30*", "", "Interpreté «x» como GLUCOSA.", "", "🧪 *PREPARACIÓN Y AYUNO*", "", "▫️ *GLUCOSA*", "• Ayuno: 8 horas.", "", "Respóndenos por este chat para continuar. 😊"].join("\n");
    const compact = compactQuote(original);
    const content = (text: string) => text.split("\n").filter((line) => line.trim() !== "").map((line) => line.replace("Cotización de tu receta", "Cotización"));
    expect(content(compact)).toEqual(content(original));
    expect(compact.length).toBeLessThan(original.length);
    expect(compactQuote(compact)).toBe(compact);
  });

  it("wantsQuoteNow: pedir cotiza; nombrar o agregar no", async () => {
    const { wantsQuoteNow } = await import("../src/quote-session.js");
    for (const text of ["Quiero colesterol y triglicéridos", "necesito un hemograma", "cotiza glucosa", "me gustaría hacerme el perfil", "¿cuánto cuesta la glucosa?"]) expect(wantsQuoteNow(text), text).toBe(true);
    for (const text of ["glucosa", "hemograma, glucosa", "y también TSH", "agrega glucosa", "quiero también glucosa", "hola"]) expect(wantsQuoteNow(text), text).toBe(false);
  });
});
