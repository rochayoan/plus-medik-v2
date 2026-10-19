import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps, type DocumentGate } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number, aliases: string[] = []): CatalogStudy => ({
  id,
  code: null,
  name,
  normalizedName: name.toLowerCase(),
  normalizedAliases: aliases,
  priceBs,
  active: true
});

// BUN y Urea son estudios distintos del catálogo (372 y 423); "nitrogeno ureico" es un alias hipotético de BUN solo para probar el flujo clásico.
const catalog: CatalogStudy[] = [study("uuid-urea", "UREA", 30), study("uuid-bun", "BUN DE UREA", 30, ["nitrogeno ureico"]), study("uuid-fsh", "FSH", 40)];

const visual = (literalText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence });
const reading = (...texts: string[]): SimpleReading => ({ requestedStudies: texts.map((text) => visual(text)), uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const FORM_OK: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };

const match = (studyId: string, support: "EXACT" | "LEXICAL" | "SEMANTIC" = "EXACT"): Outcome => ({ kind: "MATCH", studyId, support, notes: [] });
const shadow = (literalText: string, outcome: Outcome): FinalShadow => ({
  literalText,
  outcome,
  agreement: true,
  passes: [outcome, outcome],
  modelNotes: { reading: "lectura", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] }
});
const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: 3 });
const ambiguousBunUrea = (literalText: string) => shadow(literalText, { kind: "AMBIGUOUS", studyIds: ["uuid-urea", "uuid-bun"], reason: "BUN o urea" });

type ShadowArgs = Parameters<AnalyzeDeps["shadowMatch"]>[0];
type JudgeArgs = Parameters<AnalyzeDeps["judge"]>[0];

const makeDeps = (a: SimpleReading, b: SimpleReading, judge: AnalyzeDeps["judge"], shadowMatch: AnalyzeDeps["shadowMatch"]): AnalyzeDeps => ({
  readGemini: vi.fn(async () => a),
  readOpenAI: vi.fn(async () => b),
  judge,
  readDocument: vi.fn(async () => ({
    signal: { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] }
  })),
  resolveSemantic: vi.fn(async () => {
    throw new Error("no debe llamarse");
  }),
  shadowMatch
});

const ambiguousShadow = () => vi.fn(async (args: ShadowArgs) => batchOf(...args.queries.map((q) => ambiguousBunUrea(q.literalText)))) as unknown as AnalyzeDeps["shadowMatch"];

describe("una selección visual, un estudio (analyzeImage)", () => {
  it("marcada4: UREA/NUS y UREANUS son la misma selección: un estudio, sin juez, y sigue en revisión por BUN vs Urea", async () => {
    const judge = vi.fn(async () => noJudgement);
    const shadowMatch = ambiguousShadow();
    const deps = makeDeps(reading("NITROGENO UREICO/UREA/NUS"), reading("NITROGENO UREICO/UREANUS"), judge, shadowMatch);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
    expect(judge).not.toHaveBeenCalled();
    expect(result.finalVisualStudies.map((s) => s.literalText)).toEqual(["NITROGENO UREICO/UREA/NUS"]);
    expect(vi.mocked(shadowMatch).mock.calls[0]![0].queries).toEqual([{ literalText: "NITROGENO UREICO/UREA/NUS" }]);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_ambiguous"]);
    expect(result.quote).toBeUndefined();
  });

  it("marcada1: la lectura truncada no produce BUN; el juez confirma la fila completa, que sigue ambigua", async () => {
    const judge = vi.fn(async (args: JudgeArgs) => ({
      resolvedStudies: args.disputes.map((d) => ({ key: d.key, verdict: "confirmed" as const, study: d.preferred ?? d.readerA.requested!, reason: "la fila está marcada" })),
      unresolvedDisputes: []
    }));
    const shadowMatch = ambiguousShadow();
    const deps = makeDeps(reading("NITROGENO UREICO/UREA/NUS", "FSH"), reading("NITROGENO UREICO", "FSH"), judge as unknown as AnalyzeDeps["judge"], shadowMatch);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]![0].disputes).toMatchObject([{ key: "nitrogeno ureico urea nus", reason: "partial_transcription" }]);
    // Una sola selección visual: solo el texto completo llega al resolvedor; el truncado ni se consulta.
    expect(result.finalVisualStudies.map((s) => s.literalText)).toEqual(["FSH", "NITROGENO UREICO/UREA/NUS"]);
    expect(vi.mocked(shadowMatch).mock.calls[0]![0].queries.map((q) => q.literalText)).toEqual(["FSH", "NITROGENO UREICO/UREA/NUS"]);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("semantic_ambiguous");
    expect(result.reasons).not.toContain("visual_partial_transcription");
  });

  it("si el juez rechaza o no resuelve la fila parcial, ninguna de las dos lecturas se cuela como estudio", async () => {
    const shadowMatch = vi.fn(async (args: ShadowArgs) => batchOf(...args.queries.map((q) => shadow(q.literalText, match("uuid-fsh"))))) as unknown as AnalyzeDeps["shadowMatch"];
    const rejected: SimpleJudgement = { resolvedStudies: [{ key: "nitrogeno ureico urea nus", verdict: "rejected", study: visual("NITROGENO UREICO/UREA/NUS"), reason: "casilla vacía" }], unresolvedDisputes: [] };
    const unresolved: SimpleJudgement = {
      resolvedStudies: [],
      unresolvedDisputes: [{ dispute: { key: "nitrogeno ureico urea nus", reason: "partial_transcription", readerA: { uncertain: [] }, readerB: { uncertain: [] } }, reason: "borroso" }]
    };
    for (const judgement of [rejected, unresolved]) {
      const deps = makeDeps(reading("NITROGENO UREICO/UREA/NUS", "FSH"), reading("NITROGENO UREICO", "FSH"), vi.fn(async () => judgement), shadowMatch);
      const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
      expect(result.finalVisualStudies.map((s) => s.literalText)).toEqual(["FSH"]);
      expect(result.matches.some((m) => /nitrogeno/i.test(m.matchedText))).toBe(false);
    }
    // Rechazada: la receta queda con solo FSH; sin resolver: HUMAN_REVIEW por disputa sin resolver.
    const deps = makeDeps(reading("NITROGENO UREICO/UREA/NUS", "FSH"), reading("NITROGENO UREICO", "FSH"), vi.fn(async () => unresolved), shadowMatch);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("visual_disputes_unresolved");
  });
});

describe("transcripciones parciales que sobreviven como estudios finales (defensa)", () => {
  const both = (...texts: string[]) => {
    const reader = reading(...texts);
    return buildSimpleConsensus(reader, reader);
  };

  it("flujo semántico: la versión truncada no produce coincidencia y la receta va a revisión", () => {
    const result = assembleAnalysis({
      consensus: both("NITROGENO UREICO", "NITROGENO UREICO/UREA/NUS", "FSH"),
      judgement: noJudgement,
      catalog,
      document: FORM_OK,
      primary: { batch: batchOf(shadow("NITROGENO UREICO", match("uuid-bun", "SEMANTIC")), ambiguousBunUrea("NITROGENO UREICO/UREA/NUS"), shadow("FSH", match("uuid-fsh"))) }
    });
    const truncated = result.matches.find((m) => m.matchedText === "NITROGENO UREICO")!;
    expect(truncated.partialTranscriptionOf).toBe("NITROGENO UREICO/UREA/NUS");
    expect(truncated.semanticPrimary).toMatchObject({ contrast: "NO_SEMANTIC_MATCH", studyIds: [] });
    expect(truncated.status).not.toBe("SEMANTIC_CANDIDATE");
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("visual_partial_transcription");
    expect(result.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
    expect(result.semanticPrimary?.autoCandidate.quote).toBeUndefined();
  });

  it("flujo clásico: un alias exacto sobre la versión truncada ya no produce AUTO", () => {
    const result = assembleAnalysis({ consensus: both("NITROGENO UREICO", "NITROGENO UREICO/UREA/NUS"), judgement: noJudgement, catalog, document: FORM_OK });
    expect(result.matches.find((m) => m.matchedText === "NITROGENO UREICO")!.status).toBe("MATCHED");
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("visual_partial_transcription");
    expect(result.quote).toBeUndefined();
  });

  it("sin versión completa en la receta, el texto corto se evalúa normalmente (no hay con qué contradecirlo)", () => {
    const result = assembleAnalysis({ consensus: both("NITROGENO UREICO", "FSH"), judgement: noJudgement, catalog, document: FORM_OK });
    expect(result.reasons).toEqual([]);
    expect(result.decision).toBe("AUTO_SAFE");
  });

  it("estudios distintos que comparten palabras no se marcan como parciales", () => {
    const result = assembleAnalysis({
      consensus: both("Hemoglobina glicosilada", "Hemoglobina y hematocrito", "Calcio serico", "Calcio ionico"),
      judgement: noJudgement,
      catalog,
      document: FORM_OK
    });
    expect(result.finalVisualStudies).toHaveLength(4);
    expect(result.reasons).not.toContain("visual_partial_transcription");
  });

  it("el mismo texto con otro espaciado no se cuenta dos veces aunque llegue por vías distintas (acordado + juez)", () => {
    const result = assembleAnalysis({
      consensus: both("NITROGENO UREICO/UREA/NUS"),
      judgement: { resolvedStudies: [{ key: "x", verdict: "confirmed", study: visual("NITROGENO UREICO/UREANUS"), reason: "se ve" }], unresolvedDisputes: [] },
      catalog,
      document: FORM_OK
    });
    expect(result.finalVisualStudies.map((s) => s.literalText)).toEqual(["NITROGENO UREICO/UREA/NUS"]);
  });
});
