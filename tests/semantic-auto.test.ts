import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, semanticAutoEnabled, type AnalyzeDeps, type DocumentGate, type SemanticPrimaryInput } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number, aliases: string[] = [], active = true): CatalogStudy => ({
  id,
  code: id.replace("uuid-", "").toUpperCase(),
  name,
  normalizedName: name.toLowerCase(),
  normalizedAliases: aliases,
  priceBs,
  active
});

const catalog: CatalogStudy[] = [
  study("uuid-fsh", "FSH", 40),
  study("uuid-lh", "LH", 45),
  study("uuid-cre", "CREATININA", 30),
  study("uuid-got", "TRANSAMINASA GOT", 40),
  study("uuid-gpt", "TRANSAMINASA GPT", 40),
  study("uuid-urea", "UREA", 30),
  study("uuid-bun", "BUN DE UREA", 30),
  study("uuid-old", "ESTUDIO VIEJO", 99, [], false)
];

const visual = (literalText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence });
const reading = (...texts: string[]): SimpleReading => ({ requestedStudies: texts.map((text) => visual(text)), uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const FORM_OK: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };

const match = (studyId: string, support: "EXACT" | "LEXICAL" | "SEMANTIC" = "SEMANTIC"): Outcome => ({ kind: "MATCH", studyId, support, notes: [] });
const composite = (parts: Array<[string, string]>): Outcome => ({
  kind: "COMPOSITE",
  components: parts.map(([studyId, fragment]) => ({ studyId, fragment, support: "SEMANTIC" as const })),
  reason: "lista explícita"
});
const shadow = (literalText: string, outcome: Outcome, agreement = true): FinalShadow => ({
  literalText,
  outcome,
  agreement,
  passes: [outcome, outcome],
  modelNotes: { reading: "lectura", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] }
});
const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: 7 });
const gotGpt = composite([["uuid-got", "GOT"], ["uuid-gpt", "GPT"]]);

function assemble(texts: string[], primary: SemanticPrimaryInput | undefined, options: { auto?: boolean; document?: DocumentGate | null; catalog?: CatalogStudy[]; reader?: SimpleReading } = {}) {
  const both = options.reader ?? reading(...texts);
  return assembleAnalysis({
    consensus: buildSimpleConsensus(both, both),
    judgement: noJudgement,
    catalog: options.catalog ?? catalog,
    document: options.document === null ? undefined : (options.document ?? FORM_OK),
    primary,
    semanticAuto: options.auto
  });
}

describe("semanticAutoEnabled (bandera)", () => {
  it("apagada por defecto; solo 'on' la enciende", () => {
    expect(semanticAutoEnabled({})).toBe(false);
    expect(semanticAutoEnabled({ CATALOG_SEMANTIC_AUTO: "true" })).toBe(false);
    expect(semanticAutoEnabled({ CATALOG_SEMANTIC_AUTO: " ON " })).toBe(true);
  });
});

describe("AUTO semántico habilitado: lo que sí puede cotizar", () => {
  const primary = { batch: batchOf(shadow("FSH", match("uuid-fsh", "EXACT")), shadow("CREATININA SERICA", match("uuid-cre", "LEXICAL")), shadow("TRANSAMINASAS GOT/GPT", gotGpt)) };

  it("MATCH semántico + exacto confirmado + compuesto explícito -> AUTO_SAFE con una línea por UUID y precios del catálogo", () => {
    const result = assemble(["FSH", "CREATININA SERICA", "TRANSAMINASAS GOT/GPT"], primary, { auto: true });
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.reasons).toEqual([]);
    expect(result.quote?.lines.map((l) => [l.id, l.priceBs])).toEqual([["uuid-fsh", 40], ["uuid-cre", 30], ["uuid-got", 40], ["uuid-gpt", 40]]);
    expect(result.quote?.totalBs).toBe(150);
    expect(result.quote?.tariff).toBe("PACIENTE");
    expect(result.semanticPrimary?.autoEnabled).toBe(true);
    expect(result.semanticPrimary?.autoCandidate.quote?.totalBs).toBe(150);
  });

  it("la auditoría de la cotización dice qué texto y qué base originó cada línea", () => {
    const result = assemble(["FSH", "CREATININA SERICA", "TRANSAMINASAS GOT/GPT"], primary, { auto: true });
    expect(result.quote?.audit).toEqual([
      { id: "uuid-fsh", basis: ["EXACT_CONFIRMED"], texts: ["FSH"] },
      { id: "uuid-cre", basis: ["SEMANTIC"], texts: ["CREATININA SERICA"] },
      { id: "uuid-got", basis: ["COMPOSITE_COMPONENT"], texts: ["TRANSAMINASAS GOT/GPT"] },
      { id: "uuid-gpt", basis: ["COMPOSITE_COMPONENT"], texts: ["TRANSAMINASAS GOT/GPT"] }
    ]);
  });

  it("sin la bandera nueva, los mismos resultados siguen en revisión y sin cotización", () => {
    const result = assemble(["FSH", "CREATININA SERICA", "TRANSAMINASAS GOT/GPT"], primary, { auto: false });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_auto_not_enabled"]);
    expect(result.quote).toBeUndefined();
    expect(result.semanticPrimary?.autoEnabled).toBe(false);
    // El candidato es idéntico a lo que se cotizaría con la bandera.
    expect(result.semanticPrimary?.autoCandidate.quote?.totalBs).toBe(150);
  });

  it("un compuesto y un estudio individual del mismo UUID cuentan una sola vez", () => {
    const withTgo = { batch: batchOf(shadow("TGO", match("uuid-got")), shadow("TRANSAMINASAS GOT/GPT", gotGpt)) };
    const result = assemble(["TGO", "TRANSAMINASAS GOT/GPT"], withTgo, { auto: true });
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines.map((l) => l.id)).toEqual(["uuid-got", "uuid-gpt"]);
    expect(result.quote?.totalBs).toBe(80);
    expect(result.quote?.audit?.[0]).toEqual({ id: "uuid-got", basis: ["SEMANTIC", "COMPOSITE_COMPONENT"], texts: ["TGO", "TRANSAMINASAS GOT/GPT"] });
  });

  it("sin integración semántica principal la bandera de AUTO no hace nada", () => {
    const result = assemble(["CREATININA SERICA"], undefined, { auto: true });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["catalog_unmatched"]);
    expect(result.semanticPrimary).toBeUndefined();
  });
});

describe("AUTO semántico habilitado: lo que sigue bloqueado", () => {
  const ok = (text: string, outcome: Outcome, agreement = true) => ({ batch: batchOf(shadow(text, outcome, agreement)) });
  const blocked = (result: ReturnType<typeof assemble>, reason: string) => {
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain(reason);
    expect(result.quote).toBeUndefined();
  };

  it("ambigüedad clínica (BUN vs Urea), sin coincidencia, rechazo del verificador y pasadas en desacuerdo", () => {
    blocked(assemble(["NITROGENO UREICO/UREA/NUS"], ok("NITROGENO UREICO/UREA/NUS", { kind: "AMBIGUOUS", studyIds: ["uuid-bun", "uuid-urea"], reason: "BUN o urea" }), { auto: true }), "semantic_ambiguous");
    blocked(assemble(["AMILASA PANCREATICA"], ok("AMILASA PANCREATICA", { kind: "NO_MATCH", reason: "ausente" }), { auto: true }), "semantic_no_match");
    blocked(assemble(["Examen X"], ok("Examen X", { kind: "REJECTED", studyIds: ["uuid-fsh"], reason: "variante" }), { auto: true }), "semantic_rejected_by_verifier");
    blocked(assemble(["CREATININA SERICA"], ok("CREATININA SERICA", match("uuid-cre"), false), { auto: true }), "semantic_passes_disagree");
  });

  it("perfiles genéricos y compuestos con demasiados componentes", () => {
    blocked(assemble(["PERFIL TIROIDEO"], ok("PERFIL TIROIDEO", composite([["uuid-got", "a"], ["uuid-gpt", "b"]])), { auto: true }), "semantic_composite_requires_policy");
    const five = composite([["uuid-fsh", "a"], ["uuid-lh", "b"], ["uuid-cre", "c"], ["uuid-urea", "d"], ["uuid-bun", "e"]]);
    blocked(assemble(["a/b/c/d/e"], ok("a/b/c/d/e", five), { auto: true }), "semantic_composite_requires_policy");
  });

  it("una contradicción con el matcher exacto sigue en revisión", () => {
    const withAlias = [...catalog.filter((s) => s.id !== "uuid-fsh"), study("uuid-fsh", "FSH", 40, ["hormona foliculo estimulante"])];
    blocked(assemble(["hormona foliculo estimulante"], ok("hormona foliculo estimulante", match("uuid-lh")), { auto: true, catalog: withAlias }), "semantic_contradicts_exact");
  });

  it("UUID inexistente o inactivo", () => {
    blocked(assemble(["Estudio nuevo"], ok("Estudio nuevo", match("uuid-fantasma")), { auto: true }), "semantic_rejected_by_verifier");
    blocked(assemble(["Estudio nuevo"], ok("Estudio nuevo", match("uuid-old")), { auto: true }), "semantic_rejected_by_verifier");
  });

  it("precio inválido en el catálogo: no se cotiza", () => {
    for (const priceBs of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const broken = catalog.map((s) => (s.id === "uuid-cre" ? { ...s, priceBs } : s));
      blocked(assemble(["CREATININA SERICA"], ok("CREATININA SERICA", match("uuid-cre")), { auto: true, catalog: broken }), "catalog_price_invalid");
    }
  });

  it("manuscritos, documento incompleto, sin señal de documento y certeza no alta", () => {
    const primary = ok("CREATININA SERICA", match("uuid-cre"));
    blocked(assemble(["CREATININA SERICA"], primary, { auto: true, document: { documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: true } }), "handwritten_out_of_scope");
    blocked(assemble(["CREATININA SERICA"], primary, { auto: true, document: { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: false } }), "document_not_complete");
    blocked(assemble(["CREATININA SERICA"], primary, { auto: true, document: { documentType: "UNKNOWN", completeDocumentVisible: true } }), "document_type_uncertain");
    blocked(assemble(["CREATININA SERICA"], primary, { auto: true, document: null }), "document_type_uncertain");
    // Un estudio confirmado por el juez pero con certeza no alta nunca llega a AUTO.
    const empty = reading();
    const lowCertainty = assembleAnalysis({
      consensus: buildSimpleConsensus(empty, empty),
      judgement: { resolvedStudies: [{ key: "creatinina serica", verdict: "confirmed", study: visual("CREATININA SERICA", "medium"), reason: "se ve" }], unresolvedDisputes: [] },
      catalog,
      document: FORM_OK,
      primary,
      semanticAuto: true
    });
    blocked(lowCertainty, "non_high_certainty_study");
  });

  it("GPT, el catálogo o la verificación no disponibles: nunca AUTO, ni lo que el exacto resolvió", () => {
    blocked(assemble(["FSH"], { error: "HTTP 500" }, { auto: true }), "semantic_unavailable");
    blocked(assemble(["FSH", "LH"], { batch: batchOf(shadow("FSH", match("uuid-fsh"))) }, { auto: true }), "semantic_unavailable");
  });

  it("una sola lectura parcial entre los estudios finales fuerza revisión aunque todo lo demás sea verificable", () => {
    const primary = { batch: batchOf(shadow("NITROGENO UREICO", match("uuid-bun")), shadow("CREATININA SERICA", match("uuid-cre")), shadow("NITROGENO UREICO/UREA/NUS", { kind: "AMBIGUOUS", studyIds: ["uuid-bun", "uuid-urea"], reason: "x" })) };
    blocked(assemble(["NITROGENO UREICO", "CREATININA SERICA", "NITROGENO UREICO/UREA/NUS"], primary, { auto: true }), "visual_partial_transcription");
  });

  it("un solo estudio bloqueado impide el AUTO de toda la receta, aunque los demás sean verificables", () => {
    const primary = { batch: batchOf(shadow("FSH", match("uuid-fsh", "EXACT")), shadow("CREATININA SERICA", match("uuid-cre")), shadow("AMILASA PANCREATICA", { kind: "NO_MATCH", reason: "ausente" })) };
    const result = assemble(["FSH", "CREATININA SERICA", "AMILASA PANCREATICA"], primary, { auto: true });
    blocked(result, "semantic_no_match");
    // El candidato tampoco: no hay cotización parcial.
    expect(result.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
    expect(result.semanticPrimary?.autoCandidate.quote).toBeUndefined();
  });
});

describe("analyzeImage con AUTO semántico", () => {
  const both = reading("FSH", "CREATININA SERICA");
  const makeDeps = (shadowMatch: AnalyzeDeps["shadowMatch"]): AnalyzeDeps => ({
    readGemini: vi.fn(async () => both),
    readOpenAI: vi.fn(async () => both),
    judge: vi.fn(async () => noJudgement),
    readDocument: vi.fn(async () => ({
      signal: { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] }
    })),
    resolveSemantic: vi.fn(async () => {
      throw new Error("no debe llamarse");
    }),
    shadowMatch
  });
  const matcher = () =>
    vi.fn(async () => batchOf(shadow("FSH", match("uuid-fsh", "EXACT")), shadow("CREATININA SERICA", match("uuid-cre", "LEXICAL")))) as unknown as AnalyzeDeps["shadowMatch"];

  it("con ambas banderas la receta completa y verificada es AUTO_SAFE", async () => {
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true, semanticAuto: true }, makeDeps(matcher()));
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.totalBs).toBe(70);
  });

  it("solo la bandera principal: sigue en revisión (candidato)", async () => {
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true, semanticAuto: false }, makeDeps(matcher()));
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_auto_not_enabled"]);
  });

  it("solo la bandera de AUTO, sin la principal: no se llama al resolvedor semántico y nada es AUTO por vía semántica", async () => {
    const shadowMatch = vi.fn();
    const onlyExact = reading("FSH");
    const deps = { ...makeDeps(shadowMatch as unknown as AnalyzeDeps["shadowMatch"]), readGemini: vi.fn(async () => onlyExact), readOpenAI: vi.fn(async () => onlyExact) };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: false, semanticAuto: true }, deps);
    expect(shadowMatch).not.toHaveBeenCalled();
    expect(result.semanticPrimary).toBeUndefined();
  });

  it("si el resolvedor semántico falla, no hay AUTO aunque la bandera esté encendida", async () => {
    const failing = (async () => {
      throw new Error("OpenAI 503");
    }) as AnalyzeDeps["shadowMatch"];
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true, semanticAuto: true }, makeDeps(failing));
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("semantic_unavailable");
    expect(result.quote).toBeUndefined();
  });
});
