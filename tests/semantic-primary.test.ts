import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, semanticPrimaryEnabled, type AnalyzeDeps, type DocumentGate, type SemanticPrimaryInput } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number, aliases: string[] = [], active = true): CatalogStudy => ({
  id,
  code: null,
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
  study("uuid-urea", "UREA", 30, ["nitrogeno ureico urea nus"]),
  study("uuid-bun", "BUN DE UREA", 30),
  study("uuid-old", "ESTUDIO VIEJO", 99, [], false),
  study("uuid-got", "TRANSAMINASA GOT", 40, ["tgo"]),
  study("uuid-gpt", "TRANSAMINASA GPT", 40)
];

const visual = (literalText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "circle", confidence });
const reading = (...texts: string[]): SimpleReading => ({ requestedStudies: texts.map((text) => visual(text)), uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const FORM_OK: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };

const match = (studyId: string, support: "EXACT" | "LEXICAL" | "SEMANTIC" = "EXACT"): Outcome => ({ kind: "MATCH", studyId, support, notes: [] });
const shadow = (literalText: string, outcome: Outcome, agreement = true): FinalShadow => ({
  literalText,
  outcome,
  agreement,
  passes: [outcome, outcome],
  modelNotes: { reading: "lectura", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] }
});
const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: 5 });

function assemble(texts: string[], primary: SemanticPrimaryInput | undefined, document: DocumentGate | null = FORM_OK) {
  const both = reading(...texts);
  return assembleAnalysis({ consensus: buildSimpleConsensus(both, both), judgement: noJudgement, catalog, document: document ?? undefined, primary });
}

describe("semanticPrimaryEnabled (bandera)", () => {
  it("apagada por defecto; solo 'on' la enciende", () => {
    expect(semanticPrimaryEnabled({})).toBe(false);
    expect(semanticPrimaryEnabled({ CATALOG_SEMANTIC_PRIMARY: "off" })).toBe(false);
    expect(semanticPrimaryEnabled({ CATALOG_SEMANTIC_PRIMARY: "true" })).toBe(false);
    expect(semanticPrimaryEnabled({ CATALOG_SEMANTIC_PRIMARY: " ON " })).toBe(true);
  });
});

describe("assembleAnalysis con la integración semántica principal", () => {
  it("exacto y semántico apuntan al mismo UUID -> AUTO_SAFE (producción), cotizado desde el catálogo", () => {
    const result = assemble(["FSH", "LH"], { batch: batchOf(shadow("FSH", match("uuid-fsh")), shadow("LH", match("uuid-lh"))) });
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.reasons).toEqual([]);
    expect(result.quote?.totalBs).toBe(85);
    expect(result.matches.map((m) => m.semanticPrimary?.contrast)).toEqual(["CONFIRMS_EXACT", "CONFIRMS_EXACT"]);
    expect(result.semanticPrimary?.autoCandidate).toMatchObject({ decision: "AUTO_SAFE", quote: { totalBs: 85 } });
  });

  it("MATCH semántico que el exacto no resolvió: candidato a AUTO registrado, pero HUMAN_REVIEW y sin cotización", () => {
    const result = assemble(["FSH", "CREATININA SERICA"], {
      batch: batchOf(shadow("FSH", match("uuid-fsh")), shadow("CREATININA SERICA", match("uuid-cre", "SEMANTIC")))
    });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_auto_not_enabled"]);
    expect(result.quote).toBeUndefined();
    const candidate = result.matches[1]!;
    expect(candidate.status).toBe("SEMANTIC_CANDIDATE");
    expect(candidate.study).toMatchObject({ id: "uuid-cre", priceBs: 30 });
    expect(candidate.semanticPrimary).toMatchObject({ contrast: "SEMANTIC_ONLY", support: "SEMANTIC" });
    // Lo que pasaría con AUTO semántico habilitado: precio siempre del catálogo.
    expect(result.semanticPrimary?.autoCandidate).toMatchObject({ decision: "AUTO_SAFE", reasons: [], quote: { totalBs: 70 } });
    expect(result.semanticPrimary?.autoCandidate.quote?.lines.map((l) => l.id)).toEqual(["uuid-fsh", "uuid-cre"]);
  });

  it("el exacto resuelve un UUID distinto al de GPT -> contradicción, revisión humana también como candidato", () => {
    const result = assemble(["FSH"], { batch: batchOf(shadow("FSH", match("uuid-lh"))) });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_contradicts_exact"]);
    expect(result.matches[0]!.semanticPrimary?.contrast).toBe("CONTRADICTS_EXACT");
    expect(result.semanticPrimary?.autoCandidate).toMatchObject({ decision: "HUMAN_REVIEW", reasons: ["semantic_contradicts_exact"] });
    expect(result.semanticPrimary?.autoCandidate.quote).toBeUndefined();
  });

  it("el exacto resolvió pero GPT dice NO_MATCH o REJECTED -> contradicción", () => {
    for (const outcome of [{ kind: "NO_MATCH", reason: "x" } as Outcome, { kind: "REJECTED", studyIds: ["uuid-fsh"], reason: "identidad" } as Outcome]) {
      const result = assemble(["FSH"], { batch: batchOf(shadow("FSH", outcome)) });
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.reasons).toContain("semantic_contradicts_exact");
    }
  });

  it("GPT AMBIGUOUS que incluye el estudio exacto no es contradicción, pero sigue en revisión", () => {
    const result = assemble(["FSH"], { batch: batchOf(shadow("FSH", { kind: "AMBIGUOUS", studyIds: ["uuid-fsh", "uuid-lh"], reason: "variantes" })) });
    expect(result.reasons).toEqual(["semantic_ambiguous"]);
    expect(result.decision).toBe("HUMAN_REVIEW");
  });

  it("el exacto es ambiguo y GPT elige uno: no se autoriza (contradice la ambigüedad del exacto)", () => {
    const both = reading("UREA / BUN");
    const dupCatalog = [study("uuid-urea", "UREA", 30, ["urea bun"]), study("uuid-bun", "BUN", 30, ["urea bun"])];
    const result = assembleAnalysis({
      consensus: buildSimpleConsensus(both, both),
      judgement: noJudgement,
      catalog: dupCatalog,
      document: FORM_OK,
      primary: { batch: batchOf(shadow("UREA / BUN", match("uuid-urea"))) }
    });
    expect(result.matches[0]!.status).toBe("AMBIGUOUS");
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_contradicts_exact"]);
  });

  it("ambiguo, sin coincidencia, compuesto, rechazado por el verificador o pasadas en desacuerdo -> cada uno con su motivo y revisión", () => {
    const cases: Array<[Outcome, boolean, string]> = [
      [{ kind: "AMBIGUOUS", studyIds: ["uuid-urea", "uuid-bun"], reason: "sinónimos" }, true, "semantic_ambiguous"],
      [{ kind: "NO_MATCH", reason: "ausente" }, true, "semantic_no_match"],
      [{ kind: "COMPOSITE", components: [{ studyId: "uuid-urea", fragment: "urea", support: "EXACT" }, { studyId: "uuid-cre", fragment: "creatinina", support: "EXACT" }], reason: "lista" }, true, "semantic_composite_requires_policy"],
      [{ kind: "REJECTED", studyIds: ["uuid-urea"], reason: "variante" }, true, "semantic_rejected_by_verifier"],
      [match("uuid-urea"), false, "semantic_passes_disagree"]
    ];
    for (const [outcome, agreement, reason] of cases) {
      const result = assemble(["Examen raro"], { batch: batchOf(shadow("Examen raro", outcome, agreement)) });
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.reasons).toContain(reason);
      expect(result.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
      expect(result.quote).toBeUndefined();
    }
  });

  it("un UUID inexistente o inactivo elegido por GPT se rechaza (nunca se confía en el modelo)", () => {
    for (const id of ["uuid-fantasma", "uuid-old"]) {
      const result = assemble(["Estudio nuevo"], { batch: batchOf(shadow("Estudio nuevo", match(id))) });
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.reasons).toEqual(["semantic_rejected_by_verifier"]);
    }
  });

  it("dos textos que resuelven al mismo UUID producen una sola línea y un solo cobro", () => {
    const result = assemble(["CREATININA SERICA", "Creatinina en suero"], {
      batch: batchOf(shadow("CREATININA SERICA", match("uuid-cre", "SEMANTIC")), shadow("Creatinina en suero", match("uuid-cre", "SEMANTIC")))
    });
    expect(result.semanticPrimary?.autoCandidate.quote).toMatchObject({ totalBs: 30 });
    expect(result.semanticPrimary?.autoCandidate.quote?.lines).toHaveLength(1);

    const exact = assemble(["FSH", "fsh"], { batch: batchOf(shadow("FSH", match("uuid-fsh")), shadow("fsh", match("uuid-fsh"))) });
    expect(exact.decision).toBe("AUTO_SAFE");
    expect(exact.quote?.lines).toHaveLength(1);
    expect(exact.quote?.totalBs).toBe(40);
  });

  it("la compuerta de documento y la certeza siguen mandando, también para el candidato", () => {
    const primary = { batch: batchOf(shadow("FSH", match("uuid-fsh"))) };
    const handwritten = assemble(["FSH"], primary, { documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: true });
    expect(handwritten.decision).toBe("HUMAN_REVIEW");
    expect(handwritten.reasons).toEqual(["handwritten_out_of_scope"]);
    expect(handwritten.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
    const noDocument = assemble(["FSH"], primary, null);
    expect(noDocument.reasons).toEqual(["document_type_uncertain"]);
  });

  it("si GPT, el catálogo o la verificación fallan (error), nada es AUTO ni siquiera lo que el exacto resolvió", () => {
    const result = assemble(["FSH", "LH"], { error: "HTTP 500" });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("semantic_unavailable");
    expect(result.quote).toBeUndefined();
    expect(result.semanticPrimary).toMatchObject({ error: "HTTP 500", autoCandidate: { decision: "HUMAN_REVIEW" } });
    expect(result.matches.every((m) => m.semanticPrimary?.contrast === "UNAVAILABLE")).toBe(true);
  });

  it("un estudio sin resultado semántico (respuesta incompleta) no puede ser AUTO", () => {
    const result = assemble(["FSH", "LH"], { batch: batchOf(shadow("FSH", match("uuid-fsh"))) });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_unavailable"]);
  });

  it("sin la bandera (primary indefinido) el resultado es el del flujo clásico y no trae semanticPrimary", () => {
    const result = assemble(["FSH", "CREATININA SERICA"], undefined);
    expect(result.semanticPrimary).toBeUndefined();
    expect(result.reasons).toEqual(["catalog_unmatched"]);
  });
});

describe("analyzeImage con la integración semántica principal", () => {
  const both = reading("FSH", "CREATININA SERICA");
  const makeDeps = (shadowMatch: AnalyzeDeps["shadowMatch"]) => {
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => both),
      readOpenAI: vi.fn(async () => both),
      judge: vi.fn(async () => noJudgement),
      readDocument: vi.fn(async () => ({
        signal: { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] }
      })),
      resolveSemantic: vi.fn(async () => {
        throw new Error("la capa 2E no debe llamarse con la integración principal");
      }),
      shadowMatch
    };
    return deps;
  };

  it("todos los estudios finales pasan por el resolvedor semántico en una sola llamada y se omite la capa 2E", async () => {
    const shadowMatch = vi.fn(async (_args: Parameters<AnalyzeDeps["shadowMatch"]>[0]) => batchOf(shadow("FSH", match("uuid-fsh")), shadow("CREATININA SERICA", match("uuid-cre", "SEMANTIC"))));
    const deps = makeDeps(shadowMatch as unknown as AnalyzeDeps["shadowMatch"]);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
    expect(shadowMatch).toHaveBeenCalledTimes(1);
    expect(shadowMatch.mock.calls[0]![0]).toMatchObject({ queries: [{ literalText: "FSH" }, { literalText: "CREATININA SERICA" }] });
    expect(deps.resolveSemantic).not.toHaveBeenCalled();
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_auto_not_enabled"]);
    expect(result.semanticPrimary?.autoCandidate.quote?.totalBs).toBe(70);
  });

  it("textos repetidos se consultan una vez", async () => {
    const dup = reading("FSH", "FSH");
    const shadowMatch = vi.fn(async (_args: Parameters<AnalyzeDeps["shadowMatch"]>[0]) => batchOf(shadow("FSH", match("uuid-fsh"))));
    const deps = { ...makeDeps(shadowMatch as unknown as AnalyzeDeps["shadowMatch"]), readGemini: vi.fn(async () => dup), readOpenAI: vi.fn(async () => dup) };
    await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
    expect(shadowMatch.mock.calls[0]![0].queries).toHaveLength(1);
  });

  it("si el resolvedor semántico lanza, el resultado es HUMAN_REVIEW con semantic_unavailable y el error (no se propaga)", async () => {
    const deps = makeDeps((async () => {
      throw new Error("OpenAI 503");
    }) as AnalyzeDeps["shadowMatch"]);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true }, deps);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("semantic_unavailable");
    expect(result.semanticPrimary?.error).toBe("OpenAI 503");
  });

  it("catálogo activo vacío: no se llama al modelo y queda en revisión", async () => {
    const shadowMatch = vi.fn();
    const deps = makeDeps(shadowMatch as unknown as AnalyzeDeps["shadowMatch"]);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog: [study("uuid-old", "VIEJO", 1, [], false)], semanticPrimary: true }, deps);
    expect(shadowMatch).not.toHaveBeenCalled();
    expect(result.reasons).toContain("semantic_unavailable");
    expect(result.semanticPrimary?.error).toMatch(/vacío/);
  });

  it("sin la bandera (por defecto) no se llama al resolvedor principal", async () => {
    const shadowMatch = vi.fn();
    const only = reading("FSH");
    const deps = { ...makeDeps(shadowMatch as unknown as AnalyzeDeps["shadowMatch"]), readGemini: vi.fn(async () => only), readOpenAI: vi.fn(async () => only) };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(shadowMatch).not.toHaveBeenCalled();
    expect(result.semanticPrimary).toBeUndefined();
    expect(result.decision).toBe("AUTO_SAFE");
  });
});

describe("compuestos explícitos (Transaminasas GOT/GPT)", () => {
  const composite = (parts: Array<[string, string]>): Outcome => ({
    kind: "COMPOSITE",
    components: parts.map(([studyId, fragment]) => ({ studyId, fragment, support: "SEMANTIC" as const })),
    reason: "lista explícita"
  });
  const gotGpt = composite([["uuid-got", "GOT"], ["uuid-gpt", "GPT"]]);

  it("GOT/GPT se descompone en dos líneas independientes con UUID y precio del catálogo (candidato, sin facturar)", () => {
    const result = assemble(["TRANSAMINASAS GOT/GPT"], { batch: batchOf(shadow("TRANSAMINASAS GOT/GPT", gotGpt)) });
    const only = result.matches[0]!;
    expect(only.status).toBe("SEMANTIC_CANDIDATE");
    expect(only.semanticPrimary?.contrast).toBe("SEMANTIC_COMPOSITE");
    expect(only.components).toEqual([
      { id: "uuid-got", code: null, name: "TRANSAMINASA GOT", priceBs: 40, fragment: "GOT" },
      { id: "uuid-gpt", code: null, name: "TRANSAMINASA GPT", priceBs: 40, fragment: "GPT" }
    ]);
    // Producción no cambia: sigue en revisión y sin cotización.
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toEqual(["semantic_auto_not_enabled"]);
    expect(result.quote).toBeUndefined();
    // Candidato: dos líneas y el subtotal es la suma de ambos precios.
    const quote = result.semanticPrimary?.autoCandidate.quote;
    expect(result.semanticPrimary?.autoCandidate.decision).toBe("AUTO_SAFE");
    expect(quote?.lines.map((l) => l.id)).toEqual(["uuid-got", "uuid-gpt"]);
    expect(quote?.totalBs).toBe(80);
  });

  it("no duplica el cobro si un componente ya aparece individualmente en la receta", () => {
    // "TGO" lo resuelve el exacto (alias) a uuid-got; el compuesto vuelve a nombrarlo.
    const result = assemble(["TGO", "TRANSAMINASAS GOT/GPT", "FSH"], {
      batch: batchOf(shadow("TGO", match("uuid-got")), shadow("TRANSAMINASAS GOT/GPT", gotGpt), shadow("FSH", match("uuid-fsh")))
    });
    const quote = result.semanticPrimary?.autoCandidate.quote;
    expect(quote?.lines.map((l) => l.id)).toEqual(["uuid-got", "uuid-gpt", "uuid-fsh"]);
    expect(quote?.totalBs).toBe(120);
  });

  it("el mismo compuesto escrito dos veces tampoco duplica", () => {
    const result = assemble(["TRANSAMINASAS GOT/GPT", "TGO/TGP"], {
      batch: batchOf(shadow("TRANSAMINASAS GOT/GPT", gotGpt), shadow("TGO/TGP", composite([["uuid-got", "TGO"], ["uuid-gpt", "TGP"]])))
    });
    expect(result.semanticPrimary?.autoCandidate.quote).toMatchObject({ totalBs: 80 });
    expect(result.semanticPrimary?.autoCandidate.quote?.lines).toHaveLength(2);
  });

  it("perfiles y paneles genéricos nunca se descomponen, aunque el texto liste componentes", () => {
    for (const text of ["PERFIL LIPIDICO (COL, HDL, LDL)", "Panel hepático GOT/GPT", "Perfil tiroideo"]) {
      const result = assemble([text], { batch: batchOf(shadow(text, composite([["uuid-got", "GOT"], ["uuid-gpt", "GPT"]]))) });
      expect(result.reasons).toEqual(["semantic_composite_requires_policy"]);
      expect(result.matches[0]!.components).toBeUndefined();
      expect(result.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
    }
  });

  it("más de 4 componentes exige política", () => {
    const parts: Array<[string, string]> = [["uuid-fsh", "a"], ["uuid-lh", "b"], ["uuid-cre", "c"], ["uuid-urea", "d"], ["uuid-bun", "e"]];
    const result = assemble(["a/b/c/d/e"], { batch: batchOf(shadow("a/b/c/d/e", composite(parts))) });
    expect(result.reasons).toEqual(["semantic_composite_requires_policy"]);
  });

  it("un componente inexistente o inactivo, o repetido, deja el compuesto en revisión", () => {
    for (const parts of [
      [["uuid-got", "GOT"], ["uuid-fantasma", "GPT"]],
      [["uuid-got", "GOT"], ["uuid-old", "GPT"]],
      [["uuid-got", "GOT"], ["uuid-got", "GPT"]]
    ] as Array<Array<[string, string]>>) {
      const result = assemble(["GOT/GPT"], { batch: batchOf(shadow("GOT/GPT", composite(parts))) });
      expect(result.reasons).toEqual(["semantic_rejected_by_verifier"]);
      expect(result.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
    }
  });

  it("falta un componente (el verificador rechaza o GPT no encuentra el segundo): revisión humana", () => {
    for (const outcome of [
      { kind: "REJECTED", studyIds: ["uuid-got"], reason: "elementos de la lista sin componente: GPT" } as Outcome,
      { kind: "NO_MATCH", reason: "GPT no está en el catálogo" } as Outcome
    ]) {
      const result = assemble(["TRANSAMINASAS GOT/GPT"], { batch: batchOf(shadow("TRANSAMINASAS GOT/GPT", outcome)) });
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
      expect(result.semanticPrimary?.autoCandidate.quote).toBeUndefined();
    }
  });

  it("ambigüedad o pasadas en desacuerdo en un compuesto: revisión humana", () => {
    const ambiguous = assemble(["GOT/GPT"], { batch: batchOf(shadow("GOT/GPT", { kind: "AMBIGUOUS", studyIds: ["uuid-got", "uuid-gpt", "uuid-bun"], reason: "x" })) });
    expect(ambiguous.reasons).toEqual(["semantic_ambiguous"]);
    const disagree = assemble(["GOT/GPT"], { batch: batchOf(shadow("GOT/GPT", gotGpt, false)) });
    expect(disagree.reasons).toEqual(["semantic_passes_disagree"]);
    expect(disagree.semanticPrimary?.autoCandidate.decision).toBe("HUMAN_REVIEW");
  });

  it("si el exacto/alias ya resolvió el texto completo a un estudio, el compuesto contradice (cobraría solo una parte)", () => {
    const withAlias = [...catalog.filter((s) => s.id !== "uuid-got"), study("uuid-got", "TRANSAMINASA GOT", 40, ["transaminasas got gpt"]), study("uuid-gpt", "TRANSAMINASA GPT", 40)];
    const both = reading("TRANSAMINASAS GOT/GPT");
    const result = assembleAnalysis({
      consensus: buildSimpleConsensus(both, both),
      judgement: noJudgement,
      catalog: withAlias,
      document: FORM_OK,
      primary: { batch: batchOf(shadow("TRANSAMINASAS GOT/GPT", gotGpt)) }
    });
    expect(result.matches[0]!.status).not.toBe("SEMANTIC_CANDIDATE");
    expect(result.reasons).toEqual(["semantic_contradicts_exact"]);
    expect(result.decision).toBe("HUMAN_REVIEW");
  });

  it("la compuerta de documento sigue mandando sobre el candidato compuesto", () => {
    const result = assemble(["TRANSAMINASAS GOT/GPT"], { batch: batchOf(shadow("TRANSAMINASAS GOT/GPT", gotGpt)) }, { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: false });
    expect(result.semanticPrimary?.autoCandidate).toMatchObject({ decision: "HUMAN_REVIEW", reasons: ["document_not_complete"] });
  });
});
