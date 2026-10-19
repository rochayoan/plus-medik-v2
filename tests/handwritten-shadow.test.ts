import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, handwrittenAutoMode, type AnalyzeDeps, type DocumentGate, type SemanticPrimaryInput } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, type SimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number, aliases: string[] = []): CatalogStudy => ({
  id,
  code: id.replace("uuid-", ""),
  name,
  normalizedName: name.toLowerCase(),
  normalizedAliases: aliases,
  priceBs,
  active: true
});

const catalog = [
  study("uuid-108", "HEMOGRAMA COMPLETO AUTOMATIZADO", 45, ["hemograma completo"]),
  study("uuid-288", "PARASITOLOGICO SERIADO", 40),
  study("uuid-289", "PARASITOLOGICO SIMPLE", 35),
  study("uuid-423", "UREA", 30, ["urea"]),
  study("uuid-384", "CREATININA", 30, ["creatinina"]),
  study("uuid-372", "BUN DE UREA", 30)
];

const row = (literalText: string, normalizedName = literalText, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName, evidence: "explicit_text", confidence });
const reading = (...studies: SimpleStudy[]): SimpleReading => ({ requestedStudies: studies, uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };

const HANDWRITTEN_OK: DocumentGate = { documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: true, agreement: true, integrityProblems: [], irrelevantCrops: ["margen recortado"] };
const match = (studyId: string, support: "EXACT" | "LEXICAL" | "SEMANTIC" = "SEMANTIC"): Outcome => ({ kind: "MATCH", studyId, support, notes: [] });
const shadow = (literalText: string, outcome: Outcome, agreement = true): FinalShadow => ({ literalText, outcome, agreement, passes: [outcome, outcome], modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] } });
const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: catalog.length });

// nueva-05: "Hemograma completo" + "Coproparasitológico seriado", escritas a mano, dos lectores idénticos.
const nueva05 = () => {
  const both = reading(row("Hemograma completo"), row("Coproparasitologico seriado"));
  return { consensus: buildSimpleConsensus(both, both), primary: { batch: batchOf(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Coproparasitologico seriado", match("uuid-288", "SEMANTIC"))) } satisfies SemanticPrimaryInput };
};

function assemble(options: {
  consensus: SimpleConsensus;
  judgement?: SimpleJudgement;
  document?: DocumentGate | undefined;
  primary?: SemanticPrimaryInput | undefined;
  shadow?: boolean;
  semanticAuto?: boolean;
  catalog?: CatalogStudy[];
}) {
  return assembleAnalysis({
    consensus: options.consensus,
    judgement: options.judgement ?? noJudgement,
    catalog: options.catalog ?? catalog,
    document: "document" in options ? options.document : HANDWRITTEN_OK,
    primary: "primary" in options ? options.primary : undefined,
    semanticAuto: options.semanticAuto,
    handwrittenShadow: options.shadow ?? true
  });
}

describe("handwrittenAutoMode (bandera nueva)", () => {
  it("apagada por defecto; solo el valor exacto 'shadow' evalúa en sombra; 'on' y demás NO autorizan nada", () => {
    expect(handwrittenAutoMode({})).toBe("off");
    expect(handwrittenAutoMode({ CATALOG_HANDWRITTEN_AUTO: "on" })).toBe("off");
    expect(handwrittenAutoMode({ CATALOG_HANDWRITTEN_AUTO: "true" })).toBe("off");
    expect(handwrittenAutoMode({ CATALOG_HANDWRITTEN_AUTO: " Shadow " })).toBe("shadow");
  });
});

describe("modo sombra: manuscrito legible y verificado", () => {
  it("positivo (nueva-05): se simula AUTO con la cotización del catálogo, pero la decisión de producción NO cambia", () => {
    const { consensus, primary } = nueva05();
    const result = assemble({ consensus, primary });
    expect(result.handwrittenShadow).toMatchObject({ eligible: true, blockers: [], simulatedDecision: "AUTO_SAFE" });
    expect(result.handwrittenShadow?.quote?.lines.map((l) => [l.id, l.priceBs])).toEqual([["uuid-108", 45], ["uuid-288", 40]]);
    expect(result.handwrittenShadow?.quote?.totalBs).toBe(85);
    // producción: sigue bloqueado por ser manuscrito (y, sin la bandera del AUTO semántico, también por eso) y sin cotización real
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["handwritten_out_of_scope", "semantic_auto_not_enabled"]);
    expect(result.quote).toBeUndefined();
  });

  it("ni siquiera con CATALOG_SEMANTIC_AUTO encendido el manuscrito pasa a AUTO real", () => {
    const { consensus, primary } = nueva05();
    const result = assemble({ consensus, primary, semanticAuto: true });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("handwritten_out_of_scope");
    expect(result.quote).toBeUndefined();
    expect(result.handwrittenShadow?.simulatedDecision).toBe("AUTO_SAFE");
  });

  it("positivo (nueva-04): con el documento verificado completo (ocultamientos verificados) también es elegible", () => {
    const both = reading(row("Hemograma"), row("Urea"), row("Creatinina"));
    const primary = { batch: batchOf(shadow("Hemograma", match("uuid-108", "LEXICAL")), shadow("Urea", match("uuid-423", "EXACT")), shadow("Creatinina", match("uuid-384", "EXACT"))) };
    const result = assemble({ consensus: buildSimpleConsensus(both, both), primary, document: { ...HANDWRITTEN_OK, hiddenVerified: true, hiddenNotes: [] } });
    expect(result.handwrittenShadow?.simulatedDecision).toBe("AUTO_SAFE");
    expect(result.handwrittenShadow?.quote?.totalBs).toBe(105);
  });

  it("apagado (por defecto) o con un documento que no es manuscrito: no hay resultado de sombra", () => {
    const { consensus, primary } = nueva05();
    expect(assemble({ consensus, primary, shadow: false }).handwrittenShadow).toBeUndefined();
    const form: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };
    expect(assemble({ consensus, primary, document: form }).handwrittenShadow).toBeUndefined();
  });
});

describe("modo sombra: ante cualquier duda, HUMAN_REVIEW simulado", () => {
  const blocked = (result: ReturnType<typeof assemble>, fragment: string) => {
    expect(result.handwrittenShadow?.eligible).toBe(false);
    expect(result.handwrittenShadow?.simulatedDecision).toBe("HUMAN_REVIEW");
    expect(result.handwrittenShadow?.quote).toBeUndefined();
    expect(result.handwrittenShadow?.blockers.join(" | ")).toContain(fragment);
    expect(result.quote).toBeUndefined();
  };

  it("documento incompleto, con problemas de integridad o con lecturas de tipo distinto", () => {
    const { consensus, primary } = nueva05();
    blocked(assemble({ consensus, primary, document: { ...HANDWRITTEN_OK, completeDocumentVisible: false, integrityProblems: ["lectura A: oculto por un objeto: dedo"] } }), "documento no se verificó completo");
    blocked(assemble({ consensus, primary, document: { ...HANDWRITTEN_OK, integrityProblems: ["borde"] } }), "documento no se verificó completo");
    blocked(assemble({ consensus, primary, document: { ...HANDWRITTEN_OK, agreement: false } }), "no coinciden en el tipo");
  });

  it("un estudio confirmado por el juez no cuenta como concordancia directa de dos lecturas", () => {
    const a = reading(row("Hemograma completo"), row("Urea"));
    const b = reading(row("Hemograma completo"));
    const consensus = buildSimpleConsensus(a, b);
    const judgement: SimpleJudgement = { resolvedStudies: [{ key: "urea", verdict: "confirmed", study: row("Urea"), reason: "se ve" }], unresolvedDisputes: [] };
    const primary = { batch: batchOf(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Urea", match("uuid-423", "EXACT"))) };
    const result = assemble({ consensus, judgement, primary });
    blocked(result, "hubo disputas entre lectores");
    expect(result.handwrittenShadow?.blockers.join(" | ")).toContain("no fue acordado directamente");
  });

  it("certeza no alta en uno de los lectores (se convierte en disputa y no entra al acuerdo)", () => {
    const a = reading(row("Hemograma completo"), row("Urea"));
    const b = reading(row("Hemograma completo"), row("Urea", "Urea", "medium"));
    blocked(assemble({ consensus: buildSimpleConsensus(a, b), primary: { batch: batchOf(shadow("Hemograma completo", match("uuid-108", "EXACT"))) } }), "disputas");
  });

  it("variantes distintas entre las dos lecturas (seriado vs simple) aunque el nombre normalizado coincida", () => {
    const a = reading(row("Coproparasitologico seriado", "Coproparasitologico"));
    const b = reading(row("Coproparasitologico simple", "Coproparasitologico"));
    const consensus = buildSimpleConsensus(a, b);
    expect(consensus.agreedStudies).toHaveLength(1); // el consenso las emparejó por nombre normalizado
    const result = assemble({ consensus, primary: { batch: batchOf(shadow("Coproparasitologico seriado", match("uuid-288"))) } });
    blocked(result, "difieren en una variante");
  });

  it("matching no verificado: ambiguo, sin coincidencia, pasadas en desacuerdo, rechazado o composición sin política", () => {
    const { consensus } = nueva05();
    const cases: Outcome[] = [
      { kind: "AMBIGUOUS", studyIds: ["uuid-288", "uuid-289"], reason: "seriado o simple" },
      { kind: "NO_MATCH", reason: "ausente" },
      { kind: "REJECTED", studyIds: ["uuid-288"], reason: "variante" }
    ];
    for (const outcome of cases) {
      const primary = { batch: batchOf(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Coproparasitologico seriado", outcome)) };
      blocked(assemble({ consensus, primary }), "motivo de revisión pendiente: semantic_");
    }
    const disagree = { batch: batchOf(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Coproparasitologico seriado", match("uuid-288"), false)) };
    blocked(assemble({ consensus, primary: disagree }), "semantic_passes_disagree");
  });

  it("un solo estudio sin verificar impide toda la receta: nunca hay cotización parcial", () => {
    const { consensus } = nueva05();
    const primary = { batch: batchOf(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Coproparasitologico seriado", { kind: "NO_MATCH", reason: "x" })) };
    blocked(assemble({ consensus, primary }), "semantic_no_match");
  });

  it("sin integración semántica, con el resolvedor caído o con un resultado ausente", () => {
    const { consensus, primary } = nueva05();
    blocked(assemble({ consensus, primary: undefined }), "requiere la integración semántica principal");
    blocked(assemble({ consensus, primary: { error: "HTTP 503" } }), "no estuvo disponible");
    blocked(assemble({ consensus, primary: { batch: batchOf(primary.batch.results[0]!) } }), "semantic_unavailable");
  });

  it("lectura parcial entre los estudios finales, precio inválido o sin las dos lecturas del consenso", () => {
    const both = reading(row("Nitrogeno ureico"), row("Nitrogeno ureico/urea/nus"));
    const partial = { batch: batchOf(shadow("Nitrogeno ureico", match("uuid-372")), shadow("Nitrogeno ureico/urea/nus", { kind: "AMBIGUOUS", studyIds: ["uuid-372", "uuid-423"], reason: "bun o urea" })) };
    blocked(assemble({ consensus: buildSimpleConsensus(both, both), primary: partial }), "visual_partial_transcription");

    const { consensus, primary } = nueva05();
    blocked(assemble({ consensus, primary, catalog: catalog.map((s) => (s.id === "uuid-288" ? { ...s, priceBs: Number.NaN } : s)) }), "catalog_price_invalid");
    blocked(assemble({ consensus: { ...consensus, agreedPairs: undefined }, primary }), "no constan las dos lecturas");
  });

  it("sin estudios", () => {
    const empty = reading();
    blocked(assemble({ consensus: buildSimpleConsensus(empty, empty), primary: { batch: batchOf() } }), "no hay estudios");
  });
});

describe("analyzeImage con la bandera del AUTO manuscrito", () => {
  const both = reading(row("Hemograma completo"), row("Coproparasitologico seriado"));
  const makeDeps = (): AnalyzeDeps => ({
    readGemini: vi.fn(async () => both),
    readOpenAI: vi.fn(async () => both),
    judge: vi.fn(async () => noJudgement),
    readDocument: vi.fn(async () => ({
      signal: { documentType: "HANDWRITTEN_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] }
    })),
    resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
    shadowMatch: vi.fn(async () => nueva05().primary.batch) as unknown as AnalyzeDeps["shadowMatch"]
  });
  const base = { imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true, semanticAuto: true };

  it("con 'shadow' evalúa y reporta, y la decisión real sigue siendo HUMAN_REVIEW", async () => {
    const result = await analyzeImage({ ...base, handwrittenAuto: "shadow" }, makeDeps());
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["handwritten_out_of_scope"]);
    expect(result.handwrittenShadow).toMatchObject({ eligible: true, simulatedDecision: "AUTO_SAFE" });
    expect(result.handwrittenShadow?.quote?.totalBs).toBe(85);
    expect(result.quote).toBeUndefined();
  });

  it("apagada (por defecto) no hay evaluación; sin la integración semántica principal tampoco", async () => {
    expect((await analyzeImage({ ...base, handwrittenAuto: "off" }, makeDeps())).handwrittenShadow).toBeUndefined();
    expect((await analyzeImage(base, makeDeps())).handwrittenShadow).toBeUndefined();
    const classicDeps = { ...makeDeps(), readGemini: vi.fn(async () => reading(row("Hemograma completo"))), readOpenAI: vi.fn(async () => reading(row("Hemograma completo"))) };
    const classic = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: false, handwrittenAuto: "shadow" }, classicDeps);
    expect(classic.handwrittenShadow).toBeUndefined();
    expect(classic.decision).toBe("HUMAN_REVIEW");
  });
});
