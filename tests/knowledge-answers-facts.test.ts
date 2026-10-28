import { describe, expect, it, vi } from "vitest";
import { ANSWER_TEXTS, answerFromKnowledge, assertSafeAnswerTexts, detectTopics, sampleLines, turnaroundLines, type KnowledgeAnswer } from "../src/knowledge-answers.js";
import { KnowledgeService } from "../src/knowledge/index.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { StudyFactsService, type StudyFactsStore } from "../src/study-facts/index.js";
import type { CatalogStudy } from "../src/types.js";
import { iso, MemoryStore, policy, preparation, T0 } from "./support/knowledge-fixtures.js";

// Respuestas con los datos aprobados POR ESTUDIO (G4.1), sin base de datos: plazo de entrega en horas o días, tipo de muestra y requisitos; estudio por nombre o por la última cotización;
// qué pasa cuando falta el dato, es ambiguo o está incompleto. La regla central: NADA se inventa. Fixtures de PRUEBA.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[] = [], active = true): CatalogStudy => ({ id: id(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 77, active });
const CATALOG = [
  study(1, "GLUCOSA DE PRUEBA", ["glucosa"]), study(2, "HEMOGRAMA DE PRUEBA", ["hemograma"]), study(3, "TSH DE PRUEBA", ["tsh"]), study(4, "COLESTEROL DE PRUEBA", ["colesterol"]),
  study(5, "UREA DE PRUEBA", ["urea"]), study(6, "ACIDO URICO DE PRUEBA", ["urico"]), study(7, "GAMMA UNO DE PRUEBA", ["gamma"]), study(8, "GAMMA DOS DE PRUEBA", ["gamma"]),
  study(9, "ESTUDIO INACTIVO DE PRUEBA", ["inactivo"], false)
];

const fact = (kind: "SAMPLE" | "TURNAROUND", n: number, payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  kind, labTestId: id(n), classification: kind === "SAMPLE" ? "CLINICAL" : "ADMINISTRATIVE", version: 1, versionId: `f-${kind}-${n}`, payload: { labTestId: id(n), ...payload },
  validFrom: iso(-30), validUntil: iso(60), approvedAt: iso(-30), approvedBy: "crm:approver-prueba", contentHash: "b".repeat(64), ...over
});
const hours = (n: number, max: number, extra: Record<string, unknown> = {}) => fact("TURNAROUND", n, { unit: "HOURS", max, countedFrom: "SAMPLE_COLLECTION", ...extra });
const daysFact = (n: number, max: number, dayType: "BUSINESS" | "CALENDAR", extra: Record<string, unknown> = {}) => fact("TURNAROUND", n, { unit: "DAYS", dayType, max, countedFrom: "SAMPLE_COLLECTION", ...extra });
const sample = (n: number, sampleType: string, requirements?: string[]) =>
  fact("SAMPLE", n, requirements ? { sampleType, requirementsState: "HAS_REQUIREMENTS", requirements } : { sampleType, requirementsState: "NO_SPECIAL_REQUIREMENTS" });

class FactsStore implements StudyFactsStore {
  calls = 0;
  constructor(public items: unknown[], public down = false) {}
  async revision() { if (this.down) throw new Error("caída"); return 1; }
  async snapshot() { this.calls++; if (this.down) throw new Error("caída"); return { revision: 1, items: structuredClone(this.items) }; }
}

function make(options: { facts?: unknown[]; knowledge?: unknown[]; context?: string[] | "throws"; catalog?: CatalogStudy[] | "throws"; factsDown?: boolean; withFacts?: boolean } = {}) {
  const knowledgeStore = new MemoryStore({ revision: 1, items: options.knowledge ?? [] });
  const service = new KnowledgeService({ store: knowledgeStore, now: () => T0, revisionCheckMs: 15_000 });
  const factsStore = new FactsStore(options.facts ?? [], options.factsDown);
  const studyFacts = new StudyFactsService({ store: factsStore, now: () => T0, revisionCheckMs: 15_000 });
  const loadCatalog = vi.fn(async () => { if (options.catalog === "throws") throw new Error("catálogo caído"); return options.catalog ?? CATALOG; });
  const contextStudyIds = vi.fn(async () => { if (options.context === "throws") throw new Error("sin contexto"); return options.context ?? []; });
  const ask = (text: string, withContext = true) =>
    answerFromKnowledge(text, { service, loadCatalog, now: () => T0, ...(options.withFacts === false ? {} : { studyFacts }), ...(withContext ? { contextStudyIds } : {}) });
  return { ask, loadCatalog, contextStudyIds, factsStore };
}

// Todo número de la respuesta sale de un dato aprobado que la respalda.
const numbersIn = (text: string) => text.match(/\d+/g) ?? [];
function factCheck(answer: KnowledgeAnswer, facts: unknown[]) {
  const used = new Set(answer.refs.map((ref) => `${ref.kind}|${ref.key}`));
  const allowed = new Set((facts as Array<{ kind: string; labTestId: string; payload: unknown }>).filter((f) => used.has(`${f.kind}|${f.labTestId}`)).flatMap((f) => numbersIn(JSON.stringify({ ...(f.payload as object), labTestId: undefined }))));
  const stray = numbersIn(answer.body).filter((number) => !allowed.has(number));
  expect(stray, `números sin respaldo: ${stray.join(",")}\n${answer.body}`).toEqual([]);
}

describe("detectTopics: los temas nuevos solo existen si se piden (la base de G3.1A no cambia)", () => {
  const kinds = (text: string, withFacts: boolean) => detectTopics(text, withFacts).map((topic) => (topic.kind === "POLICY" ? `POLICY:${topic.topic}` : topic.kind));
  it.each([
    ["¿cuánto demora el hemograma?", ["TURNAROUND"]], ["en cuánto tiempo entregan los resultados de la glucosa", ["POLICY:RESULTS_DELIVERY", "TURNAROUND"]], ["para cuándo estaría", ["TURNAROUND"]],
    ["cuál es el tiempo de entrega", ["TURNAROUND"]], ["¿cuándo puedo recoger?", ["TURNAROUND"]], ["cuánto tardan los análisis", ["TURNAROUND"]], ["¿qué muestra necesito para la glucosa?", ["SAMPLE"]],
    ["qué tipo de muestra es", ["SAMPLE"]], ["¿hay requisitos especiales?", ["SAMPLE"]], ["qué debo llevar", ["SAMPLE"]], ["necesito un frasco", ["SAMPLE"]], ["¿cuánto demora y qué muestra es?", ["TURNAROUND", "SAMPLE"]]
  ])("«%s» → %j", (text, expected) => {
    expect(kinds(text, true)).toEqual(expected);
  });
  it("sin el parámetro, el resultado es EXACTAMENTE el de G3.1A (ningún tema nuevo)", () => {
    for (const text of ["¿cuánto demora el hemograma?", "qué muestra necesito", "cuándo entregan los resultados", "hay requisitos"]) {
      expect(kinds(text, false).filter((kind) => kind === "TURNAROUND" || kind === "SAMPLE"), text).toEqual([]);
    }
    expect(kinds("cuándo entregan los resultados", false)).toEqual(["POLICY:RESULTS_DELIVERY"]);
  });
  it("lo que no es de estos temas no los activa", () => {
    for (const text of ["hola", "cuál es su horario de toma de muestras", "¿dónde están?", "precio del hemograma", "me tardé en llegar ayer"]) {
      expect(kinds(text, true).filter((kind) => kind === "TURNAROUND" || kind === "SAMPLE"), text).toEqual([]);
    }
  });
});

describe("plazo de entrega por estudio", () => {
  it("horas: responde con el dato aprobado, su procedencia y desde cuándo se cuenta; los números salen del registro", async () => {
    const facts = [hours(2, 24)];
    const { ask } = make({ facts });
    const answer = (await ask("¿cuánto demora el hemograma?"))!;
    expect(answer.body).toBe(["*HEMOGRAMA DE PRUEBA*", "Tiempo de entrega: hasta 24 horas (contado desde la toma de la muestra)"].join("\n"));
    expect(answer.refs).toEqual([{ kind: "TURNAROUND", key: id(2), version: 1, contentHash: "b".repeat(64) }]);
    expect(answer.status).toBe("ANSWERED");
    expect(answer.topics).toEqual(["TURNAROUND"]);
    factCheck(answer, facts);
  });

  it("días hábiles en un rango y días calendario, cada estudio en SU unidad; nunca se convierten entre sí", async () => {
    const facts = [daysFact(1, 3, "BUSINESS", { min: 2 }), hours(2, 48), daysFact(3, 5, "CALENDAR", { countedFrom: "SAMPLE_RECEIPT" })];
    const { ask } = make({ facts });
    const answer = (await ask("cuánto tardan la glucosa, el hemograma y la tsh"))!;
    expect(answer.body).toContain("*GLUCOSA DE PRUEBA*\nTiempo de entrega: entre 2 y 3 días hábiles (contado desde la toma de la muestra)");
    expect(answer.body).toContain("*HEMOGRAMA DE PRUEBA*\nTiempo de entrega: hasta 48 horas (contado desde la toma de la muestra)");
    expect(answer.body).toContain("*TSH DE PRUEBA*\nTiempo de entrega: hasta 5 días calendario (contado desde la recepción de la muestra en el laboratorio)");
    expect(answer.body).not.toMatch(/\b2 días\b.*48/s);
    factCheck(answer, facts);
  });

  it("concuerda singular y plural; la nota aprobada se transmite tal cual", () => {
    const texts = ANSWER_TEXTS;
    const view = (over: Record<string, unknown>) => ({ studyId: id(1), studyName: "X", unit: "HOURS", max: 1, countedFrom: "SAMPLE_COLLECTION", ...over }) as never;
    expect(turnaroundLines(view({}), texts)[0]).toBe("Tiempo de entrega: hasta 1 hora (contado desde la toma de la muestra)");
    expect(turnaroundLines(view({ unit: "DAYS", dayType: "BUSINESS" }), texts)[0]).toContain("hasta 1 día hábil");
    expect(turnaroundLines(view({ unit: "DAYS", dayType: "CALENDAR", max: 2 }), texts)[0]).toContain("hasta 2 días calendario");
    expect(turnaroundLines(view({ max: 3, min: 2, note: "Sin contar domingos" }), texts)).toEqual(["Tiempo de entrega: entre 2 y 3 horas (contado desde la toma de la muestra)", "Sin contar domingos"]);
  });

  it("sin dato aprobado para ese estudio: lo dice claramente, SIN inventar un plazo y sin rastro que registrar", async () => {
    const { ask } = make({ facts: [hours(2, 24)] });
    const answer = (await ask("¿en cuánto tiempo entregan la glucosa?"))!;
    expect(answer.body).toBe("No tengo el tiempo de entrega de GLUCOSA DE PRUEBA disponible por ahora.");
    expect(answer.refs).toEqual([]);
    expect(answer.status).toBe("CLARIFY");
    expect(numbersIn(answer.body)).toEqual([]);
  });

  it("varios estudios con datos incompletos: da los que tiene y dice cuáles faltan", async () => {
    const { ask } = make({ facts: [hours(2, 24)] });
    const answer = (await ask("cuánto demoran el hemograma y la glucosa"))!;
    expect(answer.body).toContain("Tiempo de entrega: hasta 24 horas");
    expect(answer.body).toContain("No tengo el tiempo de entrega de GLUCOSA DE PRUEBA disponible por ahora.");
    expect(answer.refs.map((ref) => ref.key)).toEqual([id(2)]);
  });

  it("dato vencido, no vigente todavía o de un estudio retirado: se trata como no disponible", async () => {
    const { ask } = make({ facts: [hours(1, 24, {}), { ...hours(2, 24), validUntil: iso(-1) }, { ...hours(3, 24), validFrom: iso(2) }, hours(9, 24)] });
    expect((await ask("cuánto demora el hemograma"))!.body).toContain("No tengo el tiempo de entrega de HEMOGRAMA");
    expect((await ask("cuánto demora la tsh"))!.body).toContain("No tengo el tiempo de entrega de TSH");
    // un estudio inactivo en el catálogo no se identifica (no existe para el paciente)
    const inactive = await ask("cuánto demora el inactivo");
    expect(inactive!.body).toBe(ANSWER_TEXTS.askStudyInfo);
  });

  it("estudio ambiguo (un alias de dos estudios): no se responde por él y se indica", async () => {
    const { ask } = make({ facts: [hours(7, 24), hours(8, 48)] });
    const answer = (await ask("cuánto demora gamma"))!;
    expect(answer.body).toBe(ANSWER_TEXTS.studyAmbiguous);
    expect(answer.refs).toEqual([]);
    const mixed = (await make({ facts: [hours(2, 24)] }).ask("cuánto demoran el hemograma y gamma"))!;
    expect(mixed.body).toContain("hasta 24 horas");
    expect(mixed.body).toContain(ANSWER_TEXTS.studyAmbiguous);
  });

  it("sin nombrar el estudio ni cotización reciente: pide el nombre; no adivina", async () => {
    const { ask } = make({ facts: [hours(2, 24)] });
    expect((await ask("¿para cuándo estaría?"))!.body).toBe(ANSWER_TEXTS.askStudyInfo);
    expect((await ask("¿para cuándo estaría?", false))!.body).toBe(ANSWER_TEXTS.askStudyInfo);
  });

  it("la pregunta GENERAL de entrega de resultados sigue siendo la política de G3 (con o sin datos por estudio)", async () => {
    const knowledge = [policy({ key: "policy:entrega", payload: { topic: "RESULTS_DELIVERY", title: "ENTREGA DE PRUEBA", body: "TEXTO GENERAL DE PRUEBA" } })];
    const { ask } = make({ facts: [hours(2, 24)], knowledge });
    const answer = (await ask("¿cuándo entregan los resultados?"))!;
    expect(answer.body).toBe("*ENTREGA DE PRUEBA*\nTEXTO GENERAL DE PRUEBA");
    expect(answer.refs.map((ref) => ref.kind)).toEqual(["POLICY"]);
  });

  it("preguntando por un estudio concreto NO se mezcla la política general (podría contradecir al dato del estudio)", async () => {
    const knowledge = [policy({ key: "policy:entrega", payload: { topic: "RESULTS_DELIVERY", title: "ENTREGA DE PRUEBA", body: "TEXTO GENERAL DE PRUEBA" } })];
    const { ask } = make({ facts: [hours(2, 24)], knowledge });
    const answer = (await ask("¿cuándo entregan los resultados del hemograma?"))!;
    expect(answer.body).toContain("hasta 24 horas");
    expect(answer.body).not.toContain("TEXTO GENERAL DE PRUEBA");
    expect(answer.refs.map((ref) => ref.kind)).toEqual(["TURNAROUND"]);
    const missing = (await ask("¿cuándo entregan los resultados de la glucosa?"))!;
    expect(missing.body).toBe("No tengo el tiempo de entrega de GLUCOSA DE PRUEBA disponible por ahora.");
  });
});

describe("tipo de muestra y requisitos especiales", () => {
  it("responde el tipo de muestra y los requisitos aprobados, o que no tiene requisitos especiales si el laboratorio lo declaró", async () => {
    const facts = [sample(1, "Sangre venosa", ["Traer el frasco estéril", "Evitar ejercicio intenso"]), sample(2, "Sangre capilar")];
    const { ask } = make({ facts });
    const answer = (await ask("¿qué muestra necesito para la glucosa y el hemograma?"))!;
    expect(answer.body).toBe([
      "*GLUCOSA DE PRUEBA*", "Tipo de muestra: Sangre venosa", "Requisitos:", "- Traer el frasco estéril", "- Evitar ejercicio intenso", "",
      "*HEMOGRAMA DE PRUEBA*", "Tipo de muestra: Sangre capilar", "Requisitos: el laboratorio indica que no tiene requisitos especiales."
    ].join("\n"));
    expect(answer.refs.map((ref) => [ref.kind, ref.key])).toEqual([["SAMPLE", id(1)], ["SAMPLE", id(2)]]);
    factCheck(answer, facts);
  });

  it("sin dato aprobado: NUNCA «sin requisitos»; se dice que no está disponible", async () => {
    const { ask } = make({ facts: [] });
    const answer = (await ask("¿hay requisitos para la tsh?"))!;
    expect(answer.body).toBe("No tengo el tipo de muestra ni los requisitos de TSH DE PRUEBA disponibles por ahora.");
    expect(answer.body).not.toMatch(/no tiene requisitos/);
    expect(answer.refs).toEqual([]);
  });

  it("sampleLines: formato estable", () => {
    expect(sampleLines({ studyId: id(1), studyName: "X", sampleType: "Orina", requirementsState: "HAS_REQUIREMENTS", requirements: ["A"] } as never, ANSWER_TEXTS)).toEqual(["Tipo de muestra: Orina", "Requisitos:", "- A"]);
  });
});

describe("estudios de la última cotización (vínculo con G4.0)", () => {
  it("«¿y cuándo estarán?» responde por los estudios cotizados, aclarando de cuáles habla, sin que el paciente los nombre", async () => {
    const facts = [hours(1, 24), daysFact(2, 2, "BUSINESS")];
    const { ask, contextStudyIds } = make({ facts, context: [id(1), id(2)] });
    const answer = (await ask("¿y para cuándo estarían?"))!;
    expect(answer.body.split("\n")[0]).toBe(ANSWER_TEXTS.contextIntro);
    expect(answer.body).toContain("*GLUCOSA DE PRUEBA*\nTiempo de entrega: hasta 24 horas");
    expect(answer.body).toContain("*HEMOGRAMA DE PRUEBA*\nTiempo de entrega: hasta 2 días hábiles");
    expect(contextStudyIds).toHaveBeenCalledTimes(1);
    factCheck(answer, facts);
  });

  it("un estudio nombrado en el mensaje manda sobre la cotización (el contexto ni se consulta)", async () => {
    const { ask, contextStudyIds } = make({ facts: [hours(1, 24), hours(2, 48)], context: [id(1)] });
    const answer = (await ask("¿cuánto demora el hemograma?"))!;
    expect(answer.body).toContain("*HEMOGRAMA DE PRUEBA*");
    expect(answer.body).not.toContain(ANSWER_TEXTS.contextIntro);
    expect(contextStudyIds).not.toHaveBeenCalled();
  });

  it("un nombre ambiguo NO cae al contexto: se pide aclarar", async () => {
    const { ask, contextStudyIds } = make({ facts: [hours(1, 24)], context: [id(1)] });
    expect((await ask("¿cuánto demora gamma?"))!.body).toBe(ANSWER_TEXTS.studyAmbiguous);
    expect(contextStudyIds).not.toHaveBeenCalled();
  });

  it("sin cotización reciente, con un contexto que falla o con un estudio ya retirado: se pide el estudio (no se inventa)", async () => {
    expect((await make({ facts: [hours(1, 24)], context: [] }).ask("¿cuánto demora?"))!.body).toBe(ANSWER_TEXTS.askStudyInfo);
    expect((await make({ facts: [hours(1, 24)], context: "throws" }).ask("¿cuánto demora?"))!.body).toBe(ANSWER_TEXTS.askStudyInfo);
    expect((await make({ facts: [hours(1, 24)], context: [id(99)] }).ask("¿cuánto demora?"))!.body).toBe(ANSWER_TEXTS.askStudyInfo);
  });

  it("una cotización con más de 5 estudios no se responde de golpe: se pide cuál", async () => {
    const { ask } = make({ facts: [hours(1, 24)], context: [id(1), id(2), id(3), id(4), id(5), id(6)] });
    expect((await ask("¿para cuándo estarían?"))!.body).toBe(ANSWER_TEXTS.askStudyInfo);
  });

  it("la preparación (G3) también puede preguntarse sobre la cotización", async () => {
    const knowledge = [preparation(id(1), { prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" })];
    const { ask } = make({ facts: [], knowledge, context: [id(1)] });
    const answer = (await ask("¿necesito ayuno?"))!;
    expect(answer.body).toContain("Ayuno: 8 horas");
    expect(answer.refs.map((ref) => ref.kind)).toEqual(["STUDY_PREPARATION"]);
    // sin contexto sigue pidiendo el estudio, como en G3.1A
    expect((await make({ knowledge }).ask("¿necesito ayuno?", false))!.body).toBe(ANSWER_TEXTS.askStudy);
  });
});

describe("falla cerrado e integración con los demás temas", () => {
  it("sin el servicio de datos por estudio (apagado) el comportamiento es el de G3.1A: nada de plazos ni muestras", async () => {
    const { ask } = make({ facts: [hours(2, 24)], withFacts: false });
    expect(await ask("¿cuánto demora el hemograma?")).toBeUndefined();
    expect(await ask("¿qué muestra necesito para la glucosa?")).toBeUndefined();
  });

  it("catálogo caído o sin base de datos por estudio: no disponible con la razón, sin inventar", async () => {
    const noCatalog = await make({ facts: [hours(2, 24)], catalog: "throws" }).ask("¿cuánto demora el hemograma?");
    expect(noCatalog).toBeUndefined();
    const down = (await make({ facts: [hours(2, 24)], factsDown: true }).ask("¿cuánto demora el hemograma?"))!;
    expect(down.body).toBe("No tengo el tiempo de entrega de HEMOGRAMA DE PRUEBA disponible por ahora.");
    expect(down.refs).toEqual([]);
  });

  it("combina con otros temas: horario + plazo en un mismo mensaje; los rastros incluyen ambos orígenes", async () => {
    const facts = [hours(2, 24)];
    const knowledge = [preparation(id(2), { prepState: "NO_PREPARATION_REQUIRED" })];
    const { ask } = make({ facts, knowledge });
    const answer = (await ask("para el hemograma ¿necesito ayuno y cuánto demora?"))!;
    expect(answer.body).toContain("no requiere preparación");
    expect(answer.body).toContain("hasta 24 horas");
    expect(answer.refs.map((ref) => ref.kind).sort()).toEqual(["STUDY_PREPARATION", "TURNAROUND"]);
  });

  it("las plantillas nuevas cumplen las mismas reglas: sin cifras ni promesas", () => {
    expect(() => assertSafeAnswerTexts(ANSWER_TEXTS)).not.toThrow();
    expect(() => assertSafeAnswerTexts({ ...ANSWER_TEXTS, turnaroundLabel: "Tiempo 24 h" })).toThrow();
    expect(() => assertSafeAnswerTexts({ ...ANSWER_TEXTS, askStudyInfo: "Es gratis" })).toThrow();
  });

  it("jamás aparece un precio en estas respuestas (el catálogo de prueba tiene precio 77)", async () => {
    const { ask } = make({ facts: [hours(2, 24), sample(2, "Sangre")] });
    for (const text of ["cuánto demora el hemograma", "qué muestra necesito para el hemograma"]) {
      const answer = (await ask(text))!;
      expect(answer.body).not.toMatch(/77|Bs/);
    }
  });
});
