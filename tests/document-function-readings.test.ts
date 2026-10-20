import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, type AnalyzeDeps } from "../src/analyze.js";
import { FUNCTION_KINDS, type FunctionKind } from "../src/document-function.js";
import { documentInstructions, readDocumentSignal, type RawSignal, type SignalRequest } from "../src/document-signal.js";
import { normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { CatalogStudy } from "../src/types.js";

// documentFunction DENTRO de las lecturas existentes de la señal de documento: no depende de palabras clave. Todo con simulaciones locales y la red bloqueada.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-docfunction-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const NON_REQUEST: FunctionKind[] = ["SAMPLE_DERIVATION", "SAMPLE_LABEL", "OTHER_NON_REQUEST"];
const FORMATS = ["HANDWRITTEN_REQUEST", "MARK_DEPENDENT_FORM", "TEXT_EXPLICIT_REQUEST"] as const;

const raw = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  documentType: "HANDWRITTEN_REQUEST", studyRegion: { left: 100, top: 200, right: 800, bottom: 700 }, studyRegionComplete: true, rowsCutByImageEdge: [],
  rowsHiddenByObjects: [], erasedOrIllegible: false, irrelevantCrops: [], printedContext: [], reason: "documento con la prueba escrita",
  documentFunction: "MEDICAL_REQUEST", functionEvidence: ["firma y sello del médico que ordena estudios"], ...overrides
});
const deps = (reads: (variant: "A" | "B") => RawSignal, verifyAnswer?: (variant: "A" | "B") => FunctionKind) => ({
  complete: vi.fn(async (request: SignalRequest) => ({ value: reads(request.variant) })),
  verifyFunction: vi.fn(async (request: { variant: "A" | "B" }) => ({ value: { function: verifyAnswer?.(request.variant) ?? "MEDICAL_REQUEST", visibleEvidence: [], reason: "x" } })),
  model: "m",
  reasoning: "medium"
});
const run = (d: ReturnType<typeof deps>) => readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: d as never });
const both = (a: FunctionKind, b: FunctionKind, extra: Partial<RawSignal> = {}) => (variant: "A" | "B") => raw({ documentFunction: variant === "A" ? a : b, ...extra });

describe("prompt de la señal de documento", () => {
  const a = documentInstructions("A");
  const b = documentInstructions("B");
  it("pide documentFunction y functionEvidence con las definiciones por FUNCIÓN, no por formato", () => {
    for (const text of [a, b]) {
      expect(text).toContain("documentFunction: para QUÉ sirve el documento");
      expect(text).toContain("no por su formato");
      for (const kind of FUNCTION_KINDS) expect(text).toContain(`- ${kind}:`);
      expect(text).toContain("functionEvidence");
      expect(text).toContain("Una palabra suelta como 'derivación' no basta");
    }
  });
  it("las dos lecturas comparten las mismas definiciones (solo cambia el orden)", () => {
    const defs = (text: string) => text.split("\n").filter((line) => /^- (MEDICAL_REQUEST|SAMPLE_|OTHER_NON|UNCLEAR)/.test(line)).sort();
    expect(defs(a)).toEqual(defs(b));
    expect(a).not.toEqual(b);
  });
  it("el contrato anterior no lo trae (solo para repetir lecturas guardadas)", () => {
    expect(documentInstructions("A", { legacy: true })).not.toContain("documentFunction");
  });
  it("una respuesta del modelo SIN el campo se rechaza (obligatorio en el esquema actual)", async () => {
    const { documentFunction: _f, functionEvidence: _e, ...old } = raw();
    await expect(run(deps(() => old as RawSignal))).rejects.toThrow();
  });
});

describe("decisión por las dos lecturas (sin palabras clave ni llamadas extra)", () => {
  for (const format of FORMATS) {
    it(`ambas solicitud (${format}): sigue siendo ese tipo, sin comprobación adicional`, async () => {
      const d = deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", { documentType: format }));
      const result = await run(d);
      expect(result.signal.documentType).toBe(format);
      expect(result.signal.function).toMatchObject({ verdict: "REQUEST", source: "readings" });
      expect(d.verifyFunction).not.toHaveBeenCalled();
    });
    for (const a of NON_REQUEST) for (const b of NON_REQUEST) {
      it(`ambas dicen que no es solicitud (${a}/${b}, formato ${format}): NOT_A_REQUEST sin ninguna palabra clave`, async () => {
        const d = deps(both(a, b, { documentType: format }));
        const result = await run(d);
        expect(result.signal.documentType).toBe("NOT_A_REQUEST");
        expect(result.signal.function).toMatchObject({ verdict: "NON_QUOTABLE", kinds: [a, b], source: "readings" });
        expect(result.signal.function?.cues).toEqual([]);
        expect(d.verifyFunction).not.toHaveBeenCalled();
      });
    }
  }

  const discrepancies: Array<[FunctionKind, FunctionKind]> = [["MEDICAL_REQUEST", "SAMPLE_DERIVATION"], ["SAMPLE_LABEL", "MEDICAL_REQUEST"], ["MEDICAL_REQUEST", "OTHER_NON_REQUEST"], ["UNCLEAR", "MEDICAL_REQUEST"], ["UNCLEAR", "SAMPLE_DERIVATION"], ["UNCLEAR", "UNCLEAR"]];
  for (const [a, b] of discrepancies) {
    it(`discrepancia o duda (${a} / ${b}): UNKNOWN y se bloquea la cotización, sin arbitraje`, async () => {
      const d = deps(both(a, b));
      const result = await run(d);
      expect(result.signal.documentType).toBe("UNKNOWN");
      expect(result.signal.function?.verdict).toBe("UNCLEAR");
      expect(d.verifyFunction).not.toHaveBeenCalled();
    });
  }

  it("la evidencia de cada lectura queda en las notas del CRM", async () => {
    const result = await run(deps((variant) => raw({ documentFunction: "SAMPLE_DERIVATION", functionEvidence: [variant === "A" ? "jeringa con sangre" : "código de muestra"] })));
    expect(result.signal.function?.notes.join(" ")).toContain("jeringa con sangre");
    expect(result.signal.function?.notes.join(" ")).toContain("código de muestra");
  });

  it("un no-solicitud no gasta verificaciones visuales posteriores", async () => {
    const hidden = both("SAMPLE_DERIVATION", "SAMPLE_DERIVATION", { studyRegionComplete: false, rowsHiddenByObjects: ["un sello tapa el margen"] });
    const d = { ...deps(hidden), verifyHidden: vi.fn(async () => ({ value: { items: [{ index: 0, couldHide: "ONLY_BULLET_MARGIN_OR_BLANK", visibleNeighbor: "x" }], otherDoubts: false, reason: "" } })) };
    const result = await run(d as never);
    expect(d.verifyHidden).not.toHaveBeenCalled();
    expect(result.signal.documentType).toBe("NOT_A_REQUEST");
  });

  it("si los tipos de formato difieren la función no se evalúa (ya es UNKNOWN)", async () => {
    const result = await run(deps((variant) => raw({ documentType: variant === "A" ? "HANDWRITTEN_REQUEST" : "MARK_DEPENDENT_FORM", documentFunction: "SAMPLE_LABEL" })));
    expect(result.signal.documentType).toBe("UNKNOWN");
    expect(result.signal.function).toBeUndefined();
  });
});

describe("las dos lecturas dicen solicitud pero hay una frase explícita de derivación: se confirma con la comprobación enfocada", () => {
  const printed = (text: string) => ({ printedContext: [{ text, role: "TITLE" as const, appliesToAllStudies: true, declaresSpecimen: "NONE" as const, declaresCollection: "NONE" as const }] });

  it("la comprobación corrige a las lecturas (derivación) -> NOT_A_REQUEST", async () => {
    const d = deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", printed("DERIVACION DE MUESTRA")), () => "SAMPLE_DERIVATION");
    const result = await run(d);
    expect(d.verifyFunction).toHaveBeenCalledTimes(2);
    expect(result.signal.documentType).toBe("NOT_A_REQUEST");
    expect(result.signal.function?.source).toBe("verification");
    expect(result.signal.function?.notes.some((note) => note.startsWith("lectura A: MEDICAL_REQUEST"))).toBe(true);
  });
  it("la comprobación confirma -> solicitud (una solicitud válida que menciona un envío no se pierde)", async () => {
    const result = await run(deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", printed("Envío de muestra al laboratorio central")), () => "MEDICAL_REQUEST"));
    expect(result.signal.documentType).toBe("HANDWRITTEN_REQUEST");
    expect(result.signal.function?.verdict).toBe("REQUEST");
  });
  it("discrepancia o fallo de la comprobación -> UNKNOWN", async () => {
    expect((await run(deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", printed("DERIVACION DE MUESTRA")), (v) => (v === "A" ? "MEDICAL_REQUEST" : "SAMPLE_LABEL")))).signal.documentType).toBe("UNKNOWN");
    const failing = deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", printed("DERIVACION DE MUESTRA")));
    failing.verifyFunction.mockRejectedValue(new Error("HTTP 503"));
    const result = await run(failing);
    expect(result.signal.documentType).toBe("UNKNOWN");
    expect(result.signal.function?.verdict).toBe("UNAVAILABLE");
  });
  it("un objeto de muestra SOLO (sin frase) no fuerza una comprobación cuando ambas lecturas ya dicen solicitud", async () => {
    const d = deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", { irrelevantCrops: ["una jeringa tapa el encabezado"] }));
    await run(d);
    expect(d.verifyFunction).not.toHaveBeenCalled();
  });
  it("una palabra suelta ('derivación a laboratorio') no activa nada", async () => {
    const d = deps(both("MEDICAL_REQUEST", "MEDICAL_REQUEST", printed("Paciente derivado a laboratorio")));
    await run(d);
    expect(d.verifyFunction).not.toHaveBeenCalled();
  });
});

describe("extremo a extremo: la misma lista de estudios solo se cotiza si el documento es una solicitud", () => {
  const study = (code: string, name: string, priceBs: number): CatalogStudy => ({ id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs, active: true, category: "QUIMICA SANGUINEA" });
  const catalog = [study("1", "GLUCOSA", 20), study("2", "CREATININA", 30)];
  const row = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high" });
  const texts: SimpleReading = { requestedStudies: [row("Glucosa"), row("Creatinina")], uncertainStudies: [], notes: "" };
  const depsFor = (format: RawSignal["documentType"], a: FunctionKind, b: FunctionKind): AnalyzeDeps => ({
    readGemini: vi.fn(async () => texts),
    readOpenAI: vi.fn(async () => texts),
    judge: vi.fn(async () => ({ resolvedStudies: [], unresolvedDisputes: [] })),
    readDocument: (args) => readDocumentSignal({ ...args, deps: { complete: async (request: SignalRequest) => ({ value: raw({ documentType: format, documentFunction: request.variant === "A" ? a : b }) }), model: "m", reasoning: "medium" } as never }),
    resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
    shadowMatch: vi.fn(async () => { throw new Error("no debe llamarse"); }) as unknown as AnalyzeDeps["shadowMatch"]
  });
  const base = { imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: false, partialAuto: true, handwrittenAuto: "on" as const };

  for (const format of FORMATS) {
    it(`formato ${format}: solicitud -> AUTO completo; derivación, etiqueta u otro -> nada`, async () => {
      const ok = await analyzeImage(base, depsFor(format, "MEDICAL_REQUEST", "MEDICAL_REQUEST"));
      expect(ok.outcome).toBe("AUTO_COMPLETE");
      for (const kind of NON_REQUEST) {
        const result = await analyzeImage(base, depsFor(format, kind, kind));
        expect(result.outcome).toBe("HUMAN_REVIEW");
        expect(result.publicQuote).toBeUndefined();
        expect(result.internal?.recipeStops).toEqual(["not_a_request"]);
        expect(result.internal?.document.function).toMatchObject({ verdict: "NON_QUOTABLE", source: "readings" });
      }
    });
  }
  it("una lectura que ve solicitud y otra derivación bloquea toda la receta", async () => {
    const result = await analyzeImage(base, depsFor("HANDWRITTEN_REQUEST", "MEDICAL_REQUEST", "SAMPLE_DERIVATION"));
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.internal?.recipeStops).toEqual(["document_type_uncertain"]);
    expect(result.publicQuote).toBeUndefined();
  });
});
