import { describe, expect, it, vi } from "vitest";
import { analyzeImage, type AnalyzeDeps } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import type { DocumentContext, DocumentSignal } from "../src/document-signal.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number): CatalogStudy => ({ id, code: id.replace("uuid-", ""), name, normalizedName: name.toLowerCase(), normalizedAliases: [], priceBs, active: true });
const catalog = [study("uuid-415", "SODIO", 60), study("uuid-525", "SODIO EN ORINA OCACIONAL O 24 HORAS", 80), study("uuid-416", "POTASIO", 60)];

const reading = (...texts: string[]): SimpleReading => ({
  requestedStudies: texts.map((text) => ({ literalText: text, normalizedName: text, evidence: "check" as const, confidence: "high" as const })),
  uncertainStudies: [],
  notes: ""
});
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const match = (studyId: string): Outcome => ({ kind: "MATCH", studyId, support: "SEMANTIC", notes: [] });
const shadow = (literalText: string, outcome: Outcome): FinalShadow => ({ literalText, outcome, agreement: true, passes: [outcome, outcome], modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] } });
const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: 3 });

const signal = (overrides: Partial<DocumentSignal> = {}): DocumentSignal => ({
  documentType: "MARK_DEPENDENT_FORM",
  completeDocumentVisible: true,
  agreement: true,
  integrity: { problems: [], irrelevantCrops: [], verifiedEdges: [], edgeNotes: [] },
  reasons: ["", ""],
  ...overrides
});
const bloodContext: DocumentContext = { lines: ["SOLICITUD DE EXAMEN DE SANGRE"], muestra: "sangre", conflicts: [], unagreedLines: [] };

const makeDeps = (documentSignal: DocumentSignal, shadowMatch: AnalyzeDeps["shadowMatch"]): AnalyzeDeps => {
  const both = reading("Sodio", "Potasio");
  return {
    readGemini: vi.fn(async () => both),
    readOpenAI: vi.fn(async () => both),
    judge: vi.fn(async () => noJudgement),
    readDocument: vi.fn(async () => ({ signal: documentSignal })),
    resolveSemantic: vi.fn(async () => {
      throw new Error("no debe llamarse");
    }),
    shadowMatch
  };
};
type ShadowArgs = Parameters<AnalyzeDeps["shadowMatch"]>[0];
const resolves = () => vi.fn(async (_args: ShadowArgs) => batchOf(shadow("Sodio", match("uuid-415")), shadow("Potasio", match("uuid-416"))));

describe("el contexto del documento llega al resolvedor semántico", () => {
  it("analyzeImage entrega el contexto de la señal y, resuelto con evidencia verificable, la receta llega a AUTO_SAFE con precios del catálogo", async () => {
    const shadowMatch = resolves();
    const deps = makeDeps(signal({ context: bloodContext, integrity: { problems: [], irrelevantCrops: [], verifiedEdges: ["superior"], edgeNotes: [] } }), shadowMatch as unknown as AnalyzeDeps["shadowMatch"]);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true }, deps);
    expect(shadowMatch.mock.calls[0]![0].context).toEqual(bloodContext);
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines.map((l) => [l.id, l.priceBs])).toEqual([["uuid-415", 60], ["uuid-416", 60]]);
    expect(result.quote?.totalBs).toBe(120);
    // la compuerta expone lo que se verificó, para auditoría
    expect(result.document).toMatchObject({ completeDocumentVisible: true, verifiedEdges: ["superior"], context: { muestra: "sangre", lines: ["SOLICITUD DE EXAMEN DE SANGRE"] } });
  });

  it("sin contexto en la señal no se envía ninguno (las variantes siguen ambiguas)", async () => {
    const shadowMatch = vi.fn(async (_args: ShadowArgs) =>
      batchOf(
        shadow("Sodio", { kind: "AMBIGUOUS", studyIds: ["uuid-415", "uuid-525"], reason: "muestra no indicada" }),
        shadow("Potasio", match("uuid-416"))
      )
    );
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true }, makeDeps(signal(), shadowMatch as unknown as AnalyzeDeps["shadowMatch"]));
    expect(shadowMatch.mock.calls[0]![0].context).toBeUndefined();
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_ambiguous"]);
  });

  it("un contexto con conflicto entrega las líneas pero ninguna declaración, y la ambigüedad se mantiene", async () => {
    const conflicting: DocumentContext = { lines: ["SOLICITUD DE EXAMEN DE SANGRE", "MUESTRA: ORINA"], conflicts: ["muestras declaradas contradictorias: sangre, orina"], unagreedLines: [] };
    const shadowMatch = vi.fn(async (_args: ShadowArgs) => batchOf(shadow("Sodio", { kind: "AMBIGUOUS", studyIds: ["uuid-415", "uuid-525"], reason: "contexto contradictorio" }), shadow("Potasio", match("uuid-416"))));
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true }, makeDeps(signal({ context: conflicting }), shadowMatch as unknown as AnalyzeDeps["shadowMatch"]));
    expect(shadowMatch.mock.calls[0]![0].context?.muestra).toBeUndefined();
    expect(result.document?.context?.conflicts).toHaveLength(1);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("semantic_ambiguous");
  });

  it("un borde que no pudo verificarse mantiene HUMAN_REVIEW aunque todo lo demás se resuelva", async () => {
    const blocked = signal({
      completeDocumentVisible: false,
      context: bloodContext,
      integrity: { problems: ["lectura A: la zona de estudios toca el borde superior de la imagen"], irrelevantCrops: [], verifiedEdges: [], edgeNotes: ["verificación B: superior: algo continúa más allá del borde"] }
    });
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true }, makeDeps(blocked, resolves() as unknown as AnalyzeDeps["shadowMatch"]));
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["document_not_complete"]);
    expect(result.quote).toBeUndefined();
    expect(result.document?.edgeNotes?.[0]).toContain("algo continúa");
  });

  it("el contexto no cambia nada cuando las banderas semánticas están apagadas (flujo clásico)", async () => {
    const shadowMatch = vi.fn();
    const both = reading("SODIO");
    const deps = { ...makeDeps(signal({ context: bloodContext }), shadowMatch as unknown as AnalyzeDeps["shadowMatch"]), readGemini: vi.fn(async () => both), readOpenAI: vi.fn(async () => both) };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: false }, deps);
    expect(shadowMatch).not.toHaveBeenCalled();
    expect(result.semanticPrimary).toBeUndefined();
  });
});
