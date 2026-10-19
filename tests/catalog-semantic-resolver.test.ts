import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CANDIDATES,
  MAX_NAME_CHARS,
  applySemanticDecisions,
  preselectCandidates,
  resolveCatalogSemantically,
  type SemanticModelRequest
} from "../src/catalog-semantic-resolver.js";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps } from "../src/analyze.js";
import { buildSimpleConsensus } from "../src/consensus.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-semantic-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off"; // los tests de cache lo cambian explícitamente
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
const study = (name: string, extra: Partial<CatalogStudy> & { aliases?: string[] } = {}): CatalogStudy => {
  counter += 1;
  const { aliases = [], ...rest } = extra;
  return {
    id: `uuid-${counter}-${normalizeStudyKey(name).replace(/ /g, "-").slice(0, 24)}`,
    code: String(counter),
    name,
    normalizedName: normalizeStudyKey(name),
    normalizedAliases: aliases.map(normalizeStudyKey),
    priceBs: 123.45,
    active: true,
    category: "HORMONAS",
    sampleType: "Suero 500 ul",
    ...rest
  };
};

const prolactina = study("PROLACTINA (ECLIA)");
const hemograma = study("HEMOGRAMA COMPLETO AUTOMATIZADO", { aliases: ["Hemograma Completo"], category: "HEMATOLOGIA" });
const tshEclia = study("TSH (ECLIA)");
const tshFia = study("TSH (FIA Fluorescencia)");
const tshNeonatal = study("TSH NEONATAL");
const tshTrab = study("ANTICUERPOS ANTI-RECEPTOR DE TSH (TRAB) ANTI r-TSH");
const toxoIgG = study("TOXO IgG (ELISA)", { aliases: ["Toxoplasmosis IgG Elisa"] });
const toxoIgM = study("TOXO IgM (ELISA)", { aliases: ["Toxoplasmosis IgM Elisa"] });
const t4Libre = study("T4 LIBRE (ECLIA)", { aliases: ["T4L", "T4 Libre"] });
const t4Total = study("T4 TOTAL (ECLIA)");
const t4Neonatal = study("T4 NEONATAL");
const fsh = study("FSH (ECLIA)", { aliases: ["FSH"] });
const cortisol8 = study("CORTISOL 08:00 (CLIA)");
const cortisol16 = study("CORTISOL 16:00 (CLIA)");
const cortisolOrina = study("CORTISOL EN ORINA 24 HORAS", { sampleType: "Orina 24 horas 20 ml" });
const magnesio = study("MAGNESIO (Mg)", { category: "QUIMICA SANGUINEA" });
const magnesioOrina = study("MAGNESIO en Orina de 24 Hrs.", { sampleType: "Orina 24 horas" });
const fillers = ["GLUCOSA", "UREA", "CREATININA", "COLESTEROL TOTAL", "TRIGLICERIDOS", "ACIDO URICO", "BILIRRUBINA TOTAL", "ALBUMINA"].map((n) => study(n, { category: "QUIMICA SANGUINEA" }));

const catalog: CatalogStudy[] = [
  prolactina, hemograma, tshEclia, tshFia, tshNeonatal, tshTrab, toxoIgG, toxoIgM, t4Libre, t4Total, t4Neonatal,
  fsh, cortisol8, cortisol16, cortisolOrina, magnesio, magnesioOrina, ...fillers
];

const refOf = (request: SemanticModelRequest, target: CatalogStudy) => request.catalog.find((entry) => entry.name === target.name)!.ref;

type Decision = { index: number; status: "MATCH" | "AMBIGUOUS" | "NO_MATCH"; refs: string[]; confidence: "high" | "medium" | "low"; reason: string };
const modelReturning = (decide: (request: SemanticModelRequest) => Decision[]) =>
  vi.fn(async (request: SemanticModelRequest) => ({
    value: { decisions: decide(request) },
    usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 20 }
  }));

describe("preselección determinista", () => {
  const names = (query: { literalText: string; normalizedName?: string }) => preselectCandidates(query, catalog).studies.map((s) => s.name);

  it("un error de tipeo no pierde el candidato (Prolactnia -> PROLACTINA)", () => {
    expect(names({ literalText: "Prolactnia" })).toContain("PROLACTINA (ECLIA)");
  });

  it("una abreviatura cortada no pierde el candidato (Hemog completo)", () => {
    expect(names({ literalText: "Hemog completo" })).toContain("HEMOGRAMA COMPLETO AUTOMATIZADO");
  });

  it("TSH incluye TODAS las variantes (ECLIA, FIA, neonatal)", () => {
    const result = names({ literalText: "TSH" });
    expect(result).toEqual(expect.arrayContaining(["TSH (ECLIA)", "TSH (FIA Fluorescencia)", "TSH NEONATAL"]));
  });

  it("TOXO incluye IgG e IgM", () => {
    expect(names({ literalText: "TOXO" })).toEqual(expect.arrayContaining(["TOXO IgG (ELISA)", "TOXO IgM (ELISA)"]));
  });

  it("sin ninguna señal léxica envía el catálogo completo en vez de perder candidatos", () => {
    const selection = preselectCandidates({ literalText: "zzzqqq" }, catalog);
    expect(selection.fullCatalog).toBe(true);
    expect(selection.studies).toHaveLength(catalog.length);
  });

  it("texto vacío no selecciona nada", () => {
    expect(preselectCandidates({ literalText: "  ", normalizedName: "" }, catalog)).toMatchObject({ studies: [], fullCatalog: false });
  });

  it("limita a MAX_CANDIDATES y lo marca como truncado", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 30 }, (_, i) => study(`PANEL VIRUS ${i}`));
    const selection = preselectCandidates({ literalText: "panel virus" }, many);
    expect(selection.studies).toHaveLength(MAX_CANDIDATES);
    expect(selection.truncated).toBe(true);
  });
});

describe("resolveCatalogSemantically", () => {
  it("1. 'Prolactnia' -> el modelo puede sugerir PROLACTINA (ECLIA)", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, prolactina)], confidence: "high", reason: "Error de tipeo de Prolactina" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "Prolactnia", normalizedName: "Prolactina" }], catalog }, { complete });
    expect(result.items[0]!.resolution).toEqual({ status: "MATCH", studyId: prolactina.id, confidence: "high", reason: "Error de tipeo de Prolactina" });
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 50, reasoningTokens: 20 });
  });

  it("2. 'Hemog completo' -> el modelo puede sugerir HEMOGRAMA COMPLETO AUTOMATIZADO", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, hemograma)], confidence: "medium", reason: "Abreviatura de hemograma" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "Hemog completo" }], catalog }, { complete });
    expect(result.items[0]!.resolution).toMatchObject({ status: "MATCH", studyId: hemograma.id });
  });

  it("3. 'TSH' -> AMBIGUOUS por ECLIA/FIA/Neonatal", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "AMBIGUOUS", refs: [tshEclia, tshFia, tshNeonatal].map((s) => refOf(request, s)), confidence: "low", reason: "Hay 3 variantes" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "TSH" }], catalog }, { complete });
    const resolution = result.items[0]!.resolution;
    expect(resolution.status).toBe("AMBIGUOUS");
    if (resolution.status === "AMBIGUOUS") expect(resolution.candidateStudyIds.sort()).toEqual([tshEclia.id, tshFia.id, tshNeonatal.id].sort());
  });

  it("3b. si el modelo elige TSH (ECLIA) 'por defecto', la guarda lo degrada a AMBIGUOUS", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, tshEclia)], confidence: "high", reason: "El más común" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "TSH" }], catalog }, { complete });
    const resolution = result.items[0]!.resolution;
    expect(resolution.status).toBe("AMBIGUOUS");
    if (resolution.status === "AMBIGUOUS") expect(resolution.candidateStudyIds).toEqual(expect.arrayContaining([tshEclia.id, tshFia.id, tshNeonatal.id]));
    expect(result.items[0]!.note).toContain("degradado");
  });

  it("4. 'TOXO' -> no elige arbitrariamente IgG o IgM", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, toxoIgG)], confidence: "high", reason: "Toxo IgG es lo habitual" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "TOXO" }], catalog }, { complete });
    const resolution = result.items[0]!.resolution;
    expect(resolution.status).toBe("AMBIGUOUS");
    if (resolution.status === "AMBIGUOUS") expect(resolution.candidateStudyIds.sort()).toEqual([toxoIgG.id, toxoIgM.id].sort());
  });

  it("si el texto SÍ trae el calificador (TOXO IgM) un MATCH al estudio correcto se conserva", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, toxoIgM)], confidence: "high", reason: "IgM explícito" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "TOXO IgM" }], catalog }, { complete });
    expect(result.items[0]!.resolution).toMatchObject({ status: "MATCH", studyId: toxoIgM.id });
  });

  it("7. un identificador inventado por el modelo se rechaza", async () => {
    const complete = modelReturning(() => [
      { index: 0, status: "MATCH", refs: ["00000000-0000-0000-0000-000000000000"], confidence: "high", reason: "inventado" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "Prolactnia" }], catalog }, { complete });
    expect(result.items[0]!.resolution.status).toBe("NO_MATCH");
    expect(result.items[0]!.note).toContain("rechazad");
  });

  it("7b. una ref que existe en el catálogo pero NO entre los candidatos de ese texto también se rechaza", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, fsh)], confidence: "high", reason: "otro estudio" },
      { index: 1, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }
    ]);
    const result = await resolveCatalogSemantically(
      { queries: [{ literalText: "Prolactnia" }, { literalText: "FSH hormona foliculo estimulante" }], catalog },
      { complete }
    );
    expect(result.items[0]!.resolution.status).toBe("NO_MATCH");
  });

  it("8. varios candidatos clínicamente plausibles -> AMBIGUOUS", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "AMBIGUOUS", refs: [cortisol8, cortisol16, cortisolOrina].map((s) => refOf(request, s)), confidence: "low", reason: "Hay cortisol sérico a distintas horas y en orina" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "Cortisol" }], catalog }, { complete });
    const resolution = result.items[0]!.resolution;
    expect(resolution.status).toBe("AMBIGUOUS");
    if (resolution.status === "AMBIGUOUS") expect(resolution.candidateStudyIds).toHaveLength(3);
  });

  it("AMBIGUOUS con menos de 2 candidatos válidos o NO_MATCH quedan como NO_MATCH/NO_MATCH", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "AMBIGUOUS", refs: [refOf(request, prolactina), "c999"], confidence: "low", reason: "dudoso" }
    ]);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "Prolactnia" }], catalog }, { complete });
    expect(result.items[0]!.resolution.status).toBe("NO_MATCH");
  });

  it("una respuesta sin decisión para un texto queda NO_MATCH (fail closed)", async () => {
    const complete = modelReturning(() => []);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "Prolactnia" }], catalog }, { complete });
    expect(result.items[0]!.resolution.status).toBe("NO_MATCH");
  });

  it("10. varios UNMATCHED se resuelven en UNA sola llamada", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, prolactina)], confidence: "high", reason: "tipeo" },
      { index: 1, status: "MATCH", refs: [refOf(request, hemograma)], confidence: "medium", reason: "abreviatura" },
      { index: 2, status: "AMBIGUOUS", refs: [tshEclia, tshFia].map((s) => refOf(request, s)), confidence: "low", reason: "variantes" }
    ]);
    const result = await resolveCatalogSemantically(
      { queries: [{ literalText: "Prolactnia" }, { literalText: "Hemog completo" }, { literalText: "TSH" }], catalog },
      { complete }
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0].items).toHaveLength(3);
    expect(result.items.map((item) => item.resolution.status)).toEqual(["MATCH", "MATCH", "AMBIGUOUS"]);
  });

  it("no envía precios al modelo y manda sampleType solo cuando el texto menciona muestra", async () => {
    const complete = modelReturning(() => [{ index: 0, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }]);
    await resolveCatalogSemantically({ queries: [{ literalText: "Prolactnia" }], catalog }, { complete });
    const plain = complete.mock.calls[0]![0];
    expect(plain.promptText).not.toMatch(/123\.45|priceBs|price_bs/i);
    expect(plain.catalog.every((entry) => entry.sampleType === undefined)).toBe(true);

    const withSample = modelReturning(() => [{ index: 0, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }]);
    await resolveCatalogSemantically({ queries: [{ literalText: "Magnesio en orina" }], catalog }, { complete: withSample });
    expect(withSample.mock.calls[0]![0].catalog.some((entry) => entry.sampleType !== undefined)).toBe(true);
  });

  it("recorta nombres larguísimos (paneles) en el prompt, sin perder la identidad del estudio", async () => {
    const panel = study(`PANEL SEPSIS ${"PATOGENO ".repeat(120)}`);
    const complete = modelReturning(() => [{ index: 0, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }]);
    await resolveCatalogSemantically({ queries: [{ literalText: "Panel sepsis" }], catalog: [...catalog, panel] }, { complete });
    const sent = complete.mock.calls[0]![0].catalog.find((entry) => entry.name.startsWith("PANEL SEPSIS"))!;
    expect(sent.name.length).toBeLessThanOrEqual(MAX_NAME_CHARS + 1);
    expect(sent.name.endsWith("…")).toBe(true);
  });

  it("pide al modelo no mencionar refs internos en el reason", async () => {
    const complete = modelReturning(() => [{ index: 0, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }]);
    await resolveCatalogSemantically({ queries: [{ literalText: "Prolactnia" }], catalog }, { complete });
    expect(complete.mock.calls[0]![0].promptText).toContain("NO menciones los refs");
  });

  it("incluye los aliases aprobados de cada candidato y el normalizedName del lector solo como contexto", async () => {
    const complete = modelReturning(() => [{ index: 0, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }]);
    await resolveCatalogSemantically({ queries: [{ literalText: "Hemog completo", normalizedName: "Hemograma" }], catalog }, { complete });
    const request = complete.mock.calls[0]![0];
    expect(request.catalog.find((entry) => entry.name === hemograma.name)!.aliases).toEqual(["hemograma completo"]);
    expect(request.items[0]).toMatchObject({ literalText: "Hemog completo", readerNormalizedName: "Hemograma" });
  });

  it("texto vacío no llama al modelo", async () => {
    const complete = modelReturning(() => []);
    const result = await resolveCatalogSemantically({ queries: [{ literalText: "   " }], catalog }, { complete });
    expect(complete).not.toHaveBeenCalled();
    expect(result.items[0]!.resolution.status).toBe("NO_MATCH");
    expect(result.calledModel).toBe(false);
  });

  it("usa el cache (CACHE HIT) y registra usage; cambiar el reasoning invalida la clave", async () => {
    process.env.AI_CACHE = "on";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const decide = (request: SemanticModelRequest): Decision[] => [
      { index: 0, status: "MATCH", refs: [refOf(request, prolactina)], confidence: "high", reason: "tipeo" }
    ];
    const complete = modelReturning(decide);
    const args = { queries: [{ literalText: "Prolactnia" }], catalog };
    const first = await resolveCatalogSemantically(args, { complete, reasoning: "medium" });
    const second = await resolveCatalogSemantically(args, { complete, reasoning: "medium" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.items[0]!.resolution).toEqual(first.items[0]!.resolution);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("CACHE HIT openai-catalog"));

    await resolveCatalogSemantically(args, { complete, reasoning: "high" });
    expect(complete).toHaveBeenCalledTimes(2);

    const usage = (await readFile(join(dir, "usage.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(usage.filter((line) => line.label === "openai-catalog")).toHaveLength(3);
    expect(usage[0].usage).toEqual({ inputTokens: 1000, outputTokens: 50, reasoningTokens: 20 });
    spy.mockRestore();
  });
});

describe("applySemanticDecisions (pura)", () => {
  it("rechaza refs fuera de los candidatos del propio texto aunque existan en el mapa global", () => {
    const info = { sent: 1, studyIds: [prolactina.id], truncated: false, fullCatalog: false };
    const results = applySemanticDecisions({
      items: [{ index: 0, query: { literalText: "Prolactnia" }, candidates: [prolactina], info }],
      refMap: new Map([["c1", prolactina], ["c2", fsh]]),
      rawDecisions: [{ index: 0, status: "MATCH", refs: ["c2"], confidence: "high", reason: "x" }]
    });
    expect(results[0]!.resolution.status).toBe("NO_MATCH");
  });

  it("ignora decisiones mal formadas", () => {
    const info = { sent: 1, studyIds: [prolactina.id], truncated: false, fullCatalog: false };
    const results = applySemanticDecisions({
      items: [{ index: 0, query: { literalText: "Prolactnia" }, candidates: [prolactina], info }],
      refMap: new Map([["c1", prolactina]]),
      rawDecisions: [{ index: 0, status: "MATCH", refs: ["c1"] }, "basura", null]
    });
    expect(results[0]!.resolution.status).toBe("NO_MATCH");
  });
});

// ---------------------------------------------------------------------------------------------
// Integración con analyze.ts
// ---------------------------------------------------------------------------------------------

const visual = (literalText: string, normalizedName = literalText) => ({ literalText, normalizedName, evidence: "circle" as const, confidence: "high" as const });
const reading = (...texts: string[]): SimpleReading => ({ requestedStudies: texts.map((t) => visual(t)), uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };

function depsWith(readerA: SimpleReading, complete: ReturnType<typeof modelReturning>) {
  const resolveSemantic = vi.fn((args: Parameters<AnalyzeDeps["resolveSemantic"]>[0]) => resolveCatalogSemantically(args, { complete }));
  const deps: AnalyzeDeps = {
    readGemini: vi.fn(async () => readerA),
    readOpenAI: vi.fn(async () => readerA),
    judge: vi.fn(async () => noJudgement),
    readDocument: vi.fn(async () => ({
      signal: { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] }
    })),
    resolveSemantic: resolveSemantic as unknown as AnalyzeDeps["resolveSemantic"],
    shadowMatch: vi.fn(async () => {
      throw new Error("la integración semántica principal está apagada en estos tests");
    })
  };
  return { deps, resolveSemantic };
}

describe("analyze.ts con resolvedor semántico", () => {
  it("5. 'T4 Libre' ya resuelve por alias -> NO se llama a GPT", async () => {
    const complete = modelReturning(() => []);
    const { deps, resolveSemantic } = depsWith(reading("T4 Libre"), complete);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(resolveSemantic).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.matches[0]).toMatchObject({ status: "MATCHED", study: { id: t4Libre.id } });
  });

  it("6. 'FSH' ya resuelve por alias -> NO se llama a GPT", async () => {
    const complete = modelReturning(() => []);
    const { deps, resolveSemantic } = depsWith(reading("FSH"), complete);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(resolveSemantic).not.toHaveBeenCalled();
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines.map((l) => l.id)).toEqual([fsh.id]);
  });

  it("9. un MATCH del modelo (high, medium o low) es MODEL_SUGGESTED y SIEMPRE HUMAN_REVIEW, sin cotización", async () => {
    for (const confidence of ["high", "medium", "low"] as const) {
      const complete = modelReturning((request) => [{ index: 0, status: "MATCH", refs: [refOf(request, prolactina)], confidence, reason: "tipeo" }]);
      const { deps } = depsWith(reading("Prolactnia"), complete);
      const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
      expect(result.matches[0]).toMatchObject({ status: "MODEL_SUGGESTED", study: { id: prolactina.id, priceBs: 123.45 } });
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.reasons).toContain("catalog_model_suggested");
      expect(result.quote).toBeUndefined();
      expect(result.modelSuggested).toEqual([expect.objectContaining({ literalText: "Prolactnia", confidence })]);
      expect(result.unmatched).toEqual([]);
    }
  });

  it("una receta con exactos + una sugerencia del modelo no cotiza nada (HUMAN_REVIEW)", async () => {
    const complete = modelReturning((request) => [{ index: 0, status: "MATCH", refs: [refOf(request, prolactina)], confidence: "high", reason: "tipeo" }]);
    const { deps } = depsWith(reading("FSH", "Prolactnia"), complete);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(result.matches.map((m) => m.status)).toEqual(["MATCHED", "MODEL_SUGGESTED"]);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.quote).toBeUndefined();
    // La llamada solo recibió el texto no resuelto.
    expect(complete.mock.calls[0]![0].items.map((i) => i.literalText)).toEqual(["Prolactnia"]);
  });

  it("AMBIGUOUS del modelo -> HUMAN_REVIEW con candidatos visibles y sin MODEL_SUGGESTED", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "AMBIGUOUS", refs: [tshEclia, tshFia, tshNeonatal].map((s) => refOf(request, s)), confidence: "low", reason: "variantes" }
    ]);
    const { deps } = depsWith(reading("TSH"), complete);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.matches[0]!.status).toBe("UNMATCHED");
    expect(result.matches[0]!.semanticResolution!.status).toBe("AMBIGUOUS");
    expect(result.matches[0]!.candidates!.map((c) => c.id).sort()).toEqual([tshEclia.id, tshFia.id, tshNeonatal.id].sort());
    expect(result.reasons).toContain("catalog_unmatched");
    expect(result.reasons).not.toContain("catalog_model_suggested");
    expect(result.modelSuggested).toEqual([]);
  });

  it("NO_MATCH del modelo -> HUMAN_REVIEW", async () => {
    const complete = modelReturning(() => [{ index: 0, status: "NO_MATCH", refs: [], confidence: "low", reason: "sin evidencia" }]);
    const { deps } = depsWith(reading("Estudio raro"), complete);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.matches[0]!.semanticResolution).toMatchObject({ status: "NO_MATCH", reason: "sin evidencia" });
  });

  it("10. una receta con varios UNMATCHED hace una sola llamada", async () => {
    const complete = modelReturning((request) => [
      { index: 0, status: "MATCH", refs: [refOf(request, prolactina)], confidence: "high", reason: "tipeo" },
      { index: 1, status: "MATCH", refs: [refOf(request, hemograma)], confidence: "high", reason: "abreviatura" },
      { index: 2, status: "NO_MATCH", refs: [], confidence: "low", reason: "-" }
    ]);
    const { deps, resolveSemantic } = depsWith(reading("Prolactnia", "Hemog completo", "Algo raro"), complete);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(resolveSemantic).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.modelSuggested).toHaveLength(2);
    expect(result.semantic).toMatchObject({ calledModel: true, cacheHit: false, usage: { inputTokens: 1000 } });
  });

  it("assembleAnalysis sin resolución semántica conserva el comportamiento anterior (UNMATCHED)", () => {
    const both = reading("Prolactnia");
    const result = assembleAnalysis({ consensus: buildSimpleConsensus(both, both), judgement: noJudgement, catalog });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.unmatched).toEqual(["Prolactnia"]);
    expect(result.semantic).toBeUndefined();
  });
});
