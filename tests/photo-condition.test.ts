import { describe, expect, it, vi } from "vitest";
import type { SimpleReading } from "../src/ai.js";
import { analyzeImage, type AnalyzeDeps } from "../src/analyze.js";
import { documentInstructions, evaluateIntegrity, fuseSignals, integrityKinds, type RawSignal } from "../src/document-signal.js";
import type { SimpleJudgement } from "../src/judge.js";
import { fusePhotoCondition, photoConditionHints, type PhotoCondition, type RawPhotoCondition } from "../src/photo-quality.js";

// Opción 2 de la mejora 6: la señal del documento (dos pasadas que ya miran la foto) informa orientación, legibilidad, desenfoque y luz. Sin llamadas nuevas,
// sin tocar la imagen. Sin red.

const good: RawPhotoCondition = { orientation: "UPRIGHT", legibility: "GOOD", blurry: false, lighting: "GOOD", notes: "" };
const raw = (photo?: Partial<RawPhotoCondition>): RawSignal => ({
  documentType: "TEXT_EXPLICIT_REQUEST", studyRegion: { left: 100, top: 100, right: 900, bottom: 900 }, studyRegionComplete: true,
  rowsCutByImageEdge: [], rowsHiddenByObjects: [], erasedOrIllegible: false, irrelevantCrops: [], printedContext: [],
  documentFunction: "MEDICAL_REQUEST", functionEvidence: [], reason: "",
  ...(photo ? { photoCondition: { ...good, ...photo } } : {})
} as RawSignal);

describe("fusePhotoCondition: lo peor de las dos pasadas", () => {
  it("las dos ven la foto bien → clara", () => {
    expect(fusePhotoCondition(good, good)).toMatchObject({ orientation: "UPRIGHT", legibility: "GOOD", blurry: false, lighting: [], clear: true });
  });
  it("legibilidad: la peor; desenfoque: cualquiera; luz: lo que informe cualquiera", () => {
    const fused = fusePhotoCondition({ ...good, legibility: "REDUCED", lighting: "GLARE", notes: "reflejo arriba" }, { ...good, blurry: true, lighting: "DIM" });
    expect(fused).toMatchObject({ legibility: "REDUCED", blurry: true, clear: false, notes: ["reflejo arriba"] });
    expect(fused?.lighting.sort()).toEqual(["DIM", "GLARE"]);
  });
  it("orientación: si no coinciden, no está clara", () => {
    expect(fusePhotoCondition({ ...good, orientation: "ROTATED_90" }, good)).toMatchObject({ orientation: "UNCLEAR", clear: false });
    expect(fusePhotoCondition({ ...good, orientation: "ROTATED_90" }, { ...good, orientation: "ROTATED_90" })?.orientation).toBe("ROTATED_90");
  });
  it("si alguna pasada no la trae (lecturas anteriores), queda sin evaluar", () => {
    expect(fusePhotoCondition(good, undefined)).toBeUndefined();
  });
});

describe("integridad: una foto que no deja leer la zona de estudios va a revisión", () => {
  it("legibilidad POOR en una pasada → problema, tipo ERASED y documento incompleto", () => {
    const poor = raw({ legibility: "POOR", notes: "la mitad inferior está borrosa" });
    expect(evaluateIntegrity(poor)).toMatchObject({ complete: false });
    expect(evaluateIntegrity(poor).problems.join(" ")).toContain("la mitad inferior está borrosa");
    expect(integrityKinds(poor)).toContain("ERASED");
    expect(fuseSignals(raw(good), poor).completeDocumentVisible).toBe(false);
  });
  it("REDUCED, desenfoque leve o mala luz no bloquean por sí solos (solo avisan)", () => {
    const so = raw({ legibility: "REDUCED", blurry: true, lighting: "UNEVEN" });
    expect(evaluateIntegrity(so).complete).toBe(true);
    expect(fuseSignals(so, so)).toMatchObject({ completeDocumentVisible: true, photo: { clear: false } });
  });
  it("sin photoCondition (lectura anterior) nada cambia y la foto queda sin evaluar", () => {
    const signal = fuseSignals(raw(), raw());
    expect(signal.completeDocumentVisible).toBe(true);
    expect(signal.photo).toBeUndefined();
  });
});

describe("contrato", () => {
  it("el prompt vigente pide la condición de la foto; el legacy no (sigue igual)", () => {
    expect(documentInstructions("A")).toContain("photoCondition");
    expect(documentInstructions("B")).toContain("photoCondition");
    expect(documentInstructions("A", { legacy: true })).not.toContain("photoCondition");
  });
});

describe("avisos para el juez", () => {
  const condition = (patch: Partial<PhotoCondition>): PhotoCondition => ({ orientation: "UPRIGHT", legibility: "GOOD", blurry: false, lighting: [], clear: false, notes: [], ...patch });
  it("foto clara o sin evaluar → sin avisos", () => {
    expect(photoConditionHints(undefined)).toEqual([]);
    expect(photoConditionHints(condition({ clear: true }))).toEqual([]);
  });
  it("girada, borrosa o con mala luz → avisos generales que no autorizan confirmar lo dudoso", () => {
    const hints = photoConditionHints(condition({ orientation: "ROTATED_270", blurry: true, lighting: ["GLARE"] }));
    expect(hints).toHaveLength(3);
    expect(hints.join(" ")).toContain("270°");
    expect(hints.join(" ")).toContain("no la completes ni la confirmes");
  });
});

describe("analyzeImage: sin llamadas nuevas", () => {
  const study = { literalText: "Prolactina", normalizedName: "Prolactina", evidence: "explicit_text" as const, lineText: "Prolactina" };
  const run = async (photo?: PhotoCondition) => {
    const judge = vi.fn(async (): Promise<SimpleJudgement> => ({ resolvedStudies: [], unresolvedDisputes: [] }));
    const readDocument = vi.fn(async () => ({ signal: { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string], ...(photo ? { photo } : {}) } }));
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async (): Promise<SimpleReading> => ({ requestedStudies: [{ ...study, confidence: "high" }], uncertainStudies: [], notes: "" })),
      readOpenAI: vi.fn(async (): Promise<SimpleReading> => ({ requestedStudies: [{ ...study, confidence: "medium" }], uncertainStudies: [], notes: "" })),
      judge,
      readDocument: readDocument as AnalyzeDeps["readDocument"],
      resolveSemantic: vi.fn(async () => ({ items: [], model: "m", reasoning: "r", calledModel: false, cacheHit: true, usage: [], candidatesSentToModel: 0 })) as unknown as AnalyzeDeps["resolveSemantic"],
      shadowMatch: vi.fn()
    };
    const catalog = [{ id: "prl", code: "prl", name: "PROLACTINA", normalizedName: "prolactina", normalizedAliases: [], priceBs: 90, active: true, category: "HORMONAS" }];
    const result = await analyzeImage({ imageBase64: "eA==", mimeType: "image/jpeg", catalog, semanticPrimary: false, partialAuto: false, handwrittenAuto: "off" }, deps);
    return { result, judge, readDocument };
  };
  const clear: PhotoCondition = { orientation: "UPRIGHT", legibility: "GOOD", blurry: false, lighting: [], clear: true, notes: [] };
  it("foto clara: la duda de pura certeza se acuerda sin juez (como en la mejora 5)", async () => {
    const { judge, result, readDocument } = await run(clear);
    expect(readDocument).toHaveBeenCalledTimes(1);
    expect(judge).not.toHaveBeenCalled();
    expect(result.document?.photo).toEqual(clear);
  });
  it("foto borrosa o sin evaluar: la misma duda la mira el juez, con los avisos de la foto", async () => {
    const blurry = await run({ ...clear, blurry: true, clear: false });
    expect(blurry.judge).toHaveBeenCalledTimes(1);
    expect((blurry.judge.mock.calls[0] as unknown as [{ hints?: string[] }])[0].hints?.join(" ")).toContain("borrosas");
    const unknown = await run(undefined);
    expect(unknown.judge).toHaveBeenCalledTimes(1);
  });
});
