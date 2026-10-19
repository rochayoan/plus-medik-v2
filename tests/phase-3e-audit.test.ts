import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps, type DocumentGate, type SemanticPrimaryInput } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import { readDocumentSignal, type HiddenCheck, type RawSignal, type SignalRequest } from "../src/document-signal.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-3e-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const study = (id: string, name: string, priceBs: number, aliases: string[] = []): CatalogStudy => ({ id, code: id.replace("uuid-", ""), name, normalizedName: name.toLowerCase(), normalizedAliases: aliases, priceBs, active: true });
const catalog = [study("uuid-108", "HEMOGRAMA COMPLETO AUTOMATIZADO", 45, ["hemograma completo"]), study("uuid-384", "CREATININA", 30, ["creatinina"])];
const row = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high" });
const reading = (...texts: string[]): SimpleReading => ({ requestedStudies: texts.map(row), uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };

const FINGER = "Un dedo cubre el margen izquierdo de la fila de la segunda casilla.";
const read = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  documentType: "MARK_DEPENDENT_FORM",
  studyRegion: { left: 100, top: 300, right: 900, bottom: 700 },
  studyRegionComplete: false,
  rowsCutByImageEdge: [],
  rowsHiddenByObjects: [FINGER],
  erasedOrIllegible: false,
  irrelevantCrops: [],
  printedContext: [],
  reason: "formulario",
  ...overrides
});
const verdict = (couldHide: HiddenCheck["items"][number]["couldHide"], extra: Partial<HiddenCheck> = {}): HiddenCheck => ({
  items: [{ index: 0, couldHide, visibleNeighbor: "Hemograma completo" }],
  otherDoubts: false,
  reason: "",
  ...extra
});

// FLUJO CLÁSICO: todas las banderas apagadas, matcher exacto/alias, y la señal de documento REAL (primera pasada + verificación) con modelos simulados.
function classicRun(options: { first: Partial<RawSignal>; verify?: () => Promise<{ value: unknown }> | { value: unknown } | undefined }) {
  const both = reading("Hemograma completo");
  const verifyHidden = options.verify ? vi.fn(async () => options.verify!() as { value: unknown }) : undefined;
  const complete = vi.fn(async (_request: SignalRequest) => ({ value: read(options.first) }));
  const deps: AnalyzeDeps = {
    readGemini: vi.fn(async () => both),
    readOpenAI: vi.fn(async () => both),
    judge: vi.fn(async () => noJudgement),
    readDocument: (args) => readDocumentSignal({ ...args, deps: { complete, ...(verifyHidden ? { verifyHidden } : {}), model: "m", reasoning: "medium" } }),
    resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse: el exacto lo resuelve todo"); }),
    shadowMatch: vi.fn(async () => { throw new Error("con las banderas apagadas no se llama al resolvedor principal"); })
  };
  return { deps, verifyHidden, run: () => analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: false, semanticAuto: false, handwrittenAuto: "off" }, deps) };
}

describe("flujo clásico (banderas apagadas): la verificación de ocultamientos no permite AUTO ante información médica oculta o incompleta", () => {
  it("el dedo solo tapa margen/guion y las dos lecturas lo confirman: es el único caso en que se levanta el bloqueo (y el precio sale del catálogo)", async () => {
    const { run, verifyHidden } = classicRun({ first: {}, verify: () => ({ value: verdict("ONLY_BULLET_MARGIN_OR_BLANK") }) });
    const result = await run();
    expect(verifyHidden).toHaveBeenCalledTimes(2);
    expect(result.document).toMatchObject({ completeDocumentVisible: true, hiddenVerified: true });
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines.map((l) => [l.id, l.priceBs])).toEqual([["uuid-108", 45]]);
  });

  it("podría ocultar texto de un estudio o una marca de selección: HUMAN_REVIEW, sin cotización", async () => {
    for (const couldHide of ["STUDY_TEXT", "MARK_OR_SELECTION"] as const) {
      const result = await classicRun({ first: {}, verify: () => ({ value: verdict(couldHide) }) }).run();
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.reasons).toEqual(["document_not_complete"]);
      expect(result.quote).toBeUndefined();
      expect(result.document?.hiddenVerified).toBe(false);
    }
  });

  it("basta que UNA de las dos lecturas de verificación dude, o que haya otras dudas sobre la zona", async () => {
    let call = 0;
    const oneDoubts = await classicRun({ first: {}, verify: () => ({ value: verdict(++call % 2 === 1 ? "ONLY_BULLET_MARGIN_OR_BLANK" : "STUDY_TEXT") }) }).run();
    expect(oneDoubts.decision).toBe("HUMAN_REVIEW");
    const doubts = await classicRun({ first: {}, verify: () => ({ value: verdict("ONLY_BULLET_MARGIN_OR_BLANK", { otherDoubts: true }) }) }).run();
    expect(doubts.decision).toBe("HUMAN_REVIEW");
  });

  it("si la verificación falla, devuelve un formato inválido o no existe, falla cerrado", async () => {
    const throwing = await classicRun({ first: {}, verify: () => { throw new Error("HTTP 503"); } }).run();
    expect(throwing.decision).toBe("HUMAN_REVIEW");
    expect(throwing.document?.hiddenNotes?.join(" ")).toContain("no disponible");
    expect((await classicRun({ first: {}, verify: () => ({ value: { items: "mal" } }) }).run()).decision).toBe("HUMAN_REVIEW");
    expect((await classicRun({ first: {} }).run()).decision).toBe("HUMAN_REVIEW");
  });

  it("filas cortadas por el borde, trazos borrados o caja inválida: ni siquiera se consulta la verificación y nunca hay AUTO", async () => {
    for (const first of [
      { rowsCutByImageEdge: ["Hepatitis B Antígeno de Superf"] },
      { erasedOrIllegible: true },
      { studyRegion: { left: 900, top: 10, right: 100, bottom: 50 } }
    ] satisfies Array<Partial<RawSignal>>) {
      const { run, verifyHidden } = classicRun({ first, verify: () => ({ value: verdict("ONLY_BULLET_MARGIN_OR_BLANK") }) });
      const result = await run();
      expect(verifyHidden).not.toHaveBeenCalled();
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.quote).toBeUndefined();
    }
  });

  it("una duda del modelo SIN objeto que la explique (completa=false y nada oculto listado) no se perdona", async () => {
    const { run, verifyHidden } = classicRun({ first: { rowsHiddenByObjects: [] }, verify: () => ({ value: verdict("ONLY_BULLET_MARGIN_OR_BLANK") }) });
    const result = await run();
    expect(verifyHidden).not.toHaveBeenCalled();
    expect(result.decision).toBe("HUMAN_REVIEW");
  });

  it("un pedido manuscrito sigue en HUMAN_REVIEW aunque todo lo oculto se verifique como irrelevante (el AUTO manuscrito no existe en producción)", async () => {
    const { run, verifyHidden } = classicRun({ first: { documentType: "HANDWRITTEN_REQUEST" }, verify: () => ({ value: verdict("ONLY_BULLET_MARGIN_OR_BLANK") }) });
    const result = await run();
    expect(verifyHidden).toHaveBeenCalledTimes(2);
    expect(result.document?.completeDocumentVisible).toBe(true);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["handwritten_out_of_scope"]);
    expect(result.quote).toBeUndefined();
    expect(result.handwrittenShadow).toBeUndefined();
  });
});

describe("el AUTO manuscrito sigue exclusivamente en modo sombra: la sombra no altera la decisión, los motivos ni la cotización", () => {
  const HANDWRITTEN: DocumentGate = { documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: true, agreement: true, integrityProblems: [] };
  const match = (studyId: string, support: "EXACT" | "SEMANTIC" = "EXACT"): Outcome => ({ kind: "MATCH", studyId, support, notes: [] });
  const shadow = (literalText: string, outcome: Outcome): FinalShadow => ({ literalText, outcome, agreement: true, passes: [outcome, outcome], modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] } });
  const batch = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: catalog.length });

  const scenarios: Array<{ name: string; document: DocumentGate; primary?: SemanticPrimaryInput }> = [
    { name: "manuscrito legible y verificado", document: HANDWRITTEN, primary: { batch: batch(shadow("Hemograma completo", match("uuid-108")), shadow("Creatinina", match("uuid-384"))) } },
    { name: "manuscrito con documento incompleto", document: { ...HANDWRITTEN, completeDocumentVisible: false, integrityProblems: ["dedo"] }, primary: { batch: batch(shadow("Hemograma completo", match("uuid-108")), shadow("Creatinina", match("uuid-384"))) } },
    { name: "manuscrito con un estudio ambiguo", document: HANDWRITTEN, primary: { batch: batch(shadow("Hemograma completo", match("uuid-108")), shadow("Creatinina", { kind: "AMBIGUOUS", studyIds: ["uuid-384", "uuid-108"], reason: "x" })) } },
    { name: "manuscrito sin integración semántica", document: HANDWRITTEN },
    { name: "manuscrito con el resolvedor caído", document: HANDWRITTEN, primary: { error: "HTTP 503" } },
    { name: "formulario con marcas (no manuscrito)", document: { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true }, primary: { batch: batch(shadow("Hemograma completo", match("uuid-108")), shadow("Creatinina", match("uuid-384"))) } }
  ];

  for (const scenario of scenarios) {
    it(`invariancia: ${scenario.name}`, () => {
      const both = reading("Hemograma completo", "Creatinina");
      const run = (handwrittenShadow: boolean, semanticAuto: boolean) =>
        assembleAnalysis({ consensus: buildSimpleConsensus(both, both), judgement: noJudgement, catalog, document: scenario.document, primary: scenario.primary, semanticAuto, handwrittenShadow });
      for (const semanticAuto of [false, true]) {
        const off = run(false, semanticAuto);
        const on = run(true, semanticAuto);
        const { handwrittenShadow, ...rest } = on;
        expect(JSON.parse(JSON.stringify(rest))).toEqual(JSON.parse(JSON.stringify(off)));
        expect(off.handwrittenShadow).toBeUndefined();
        if (scenario.document.documentType === "HANDWRITTEN_REQUEST") {
          // el manuscrito nunca es AUTO real, con o sin sombra, con o sin AUTO semántico
          expect(on.decision).toBe("HUMAN_REVIEW");
          expect(on.reasons).toContain("handwritten_out_of_scope");
          expect(on.quote).toBeUndefined();
        } else {
          expect(handwrittenShadow).toBeUndefined();
        }
      }
    });
  }
});
