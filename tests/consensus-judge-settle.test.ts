import { describe, expect, it, vi } from "vitest";
import type { SimpleReading } from "../src/ai.js";
import { analyzeImage, settleCertaintyDisputes, type AnalyzeDeps } from "../src/analyze.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import { applyJudgeDecisions, type SimpleJudgement } from "../src/judge.js";

// Mejora 5: menos dudas cuando los dos lectores coinciden de verdad, y una sola disputa (que el juez decide entre las DOS lecturas) cuando ven la misma
// fila escrita distinto. Nada se inventa: todo sale de lo que leyó algún lector. Sin red.

type Row = Partial<SimpleStudy> & { literalText: string };
const s = (row: Row): SimpleStudy => ({ normalizedName: row.literalText, evidence: "explicit_text", confidence: "high", ...row });
const reading = (rows: Row[], uncertain: string[] = []): SimpleReading => ({ requestedStudies: rows.map(s), uncertainStudies: uncertain, notes: "" });
const settle = (a: SimpleReading, b: SimpleReading) => settleCertaintyDisputes(buildSimpleConsensus(a, b));

describe("settleCertaintyDisputes: mismo texto, misma línea, solo dudaba la certeza", () => {
  it("alta/media con el mismo texto y la misma línea → acordado sin juez, con certeza alta y registro", () => {
    const out = settle(reading([{ literalText: "Prolactina", lineText: "Prolactina" }]), reading([{ literalText: "PROLACTINA", lineText: "prolactina", confidence: "medium" }]));
    expect(out.disputes).toEqual([]);
    expect(out.hasDisputes).toBe(false);
    expect(out.agreedStudies.map((study) => [study.literalText, study.confidence])).toEqual([["Prolactina", "high"]]);
    expect(out.settled?.[0]?.note).toContain("misma línea");
    // La lectura original de B (media) se conserva para los controles que exigen certeza alta en ambos.
    expect(out.agreedPairs?.[0]?.b.confidence).toBe("medium");
  });
  it("sin línea fiable (falta en una lectura o no coincide) → sigue al juez", () => {
    expect(settle(reading([{ literalText: "Prolactina" }]), reading([{ literalText: "Prolactina", confidence: "medium" }])).disputes).toHaveLength(1);
    expect(settle(reading([{ literalText: "Prolactina", lineText: "Prolactina" }]), reading([{ literalText: "Prolactina", lineText: "Prolactina, TSH", confidence: "medium" }])).disputes).toHaveLength(1);
  });
  it("una variante decisiva en el texto (clase de anticuerpo, libre/total) → sigue al juez", () => {
    expect(settle(reading([{ literalText: "Rubeola IgM", lineText: "Rubeola IgM" }]), reading([{ literalText: "Rubeola IgM", lineText: "Rubeola IgM", confidence: "medium" }])).disputes).toHaveLength(1);
    expect(settle(reading([{ literalText: "T4 libre", lineText: "T4 libre" }]), reading([{ literalText: "T4 libre", lineText: "T4 libre", confidence: "medium" }])).disputes).toHaveLength(1);
  });
  it("certeza baja en cualquiera, o ninguna alta → sigue al juez", () => {
    expect(settle(reading([{ literalText: "Prolactina", lineText: "Prolactina" }]), reading([{ literalText: "Prolactina", lineText: "Prolactina", confidence: "low" }])).disputes).toHaveLength(1);
    expect(settle(reading([{ literalText: "Prolactina", lineText: "Prolactina", confidence: "medium" }]), reading([{ literalText: "Prolactina", lineText: "Prolactina", confidence: "medium" }])).disputes).toHaveLength(1);
  });
  it("una incertidumbre relacionada en algún lector → sigue al juez", () => {
    const out = settle(reading([{ literalText: "Prolactina", lineText: "Prolactina" }], ["Prolactina o progesterona"]), reading([{ literalText: "Prolactina", lineText: "Prolactina", confidence: "medium" }]));
    expect(out.disputes.length).toBeGreaterThan(0);
    expect(out.settled).toBeUndefined();
  });
  it("si no hay nada que acordar, el consenso no cambia", () => {
    const base = buildSimpleConsensus(reading([{ literalText: "TSH", lineText: "TSH" }]), reading([{ literalText: "TSH", lineText: "TSH" }]));
    expect(settleCertaintyDisputes(base)).toBe(base);
  });
});

describe("misma fila, distinta transcripción: una sola disputa", () => {
  it("la misma línea de un solo elemento leída distinto → una disputa same_row (no dos sueltas)", () => {
    const c = buildSimpleConsensus(reading([{ literalText: "IgM", lineText: "Toxoplasma: IgM" }]), reading([{ literalText: "Toxoplasma IgM", lineText: "Toxoplasma: IgM" }]));
    expect(c.disputes.map((d) => d.reason)).toEqual(["same_row_different_text"]);
    expect(c.disputes[0]!.readerA.requested?.literalText).toBe("IgM");
    expect(c.disputes[0]!.readerB.requested?.literalText).toBe("Toxoplasma IgM");
  });
  it("una línea con lista no se empareja así: dos textos distintos pueden ser dos estudios", () => {
    const c = buildSimpleConsensus(reading([{ literalText: "TSH", lineText: "TSH, Prolactina" }]), reading([{ literalText: "Prolactina", lineText: "TSH, Prolactina" }]));
    expect(c.disputes.map((d) => d.reason).sort()).toEqual(["requested_by_one_reader_only", "requested_by_one_reader_only"]);
  });
  it("líneas distintas, o varias lecturas sueltas en la misma línea: tampoco", () => {
    expect(buildSimpleConsensus(reading([{ literalText: "IgM", lineText: "Toxoplasma: IgM" }]), reading([{ literalText: "Rubeola IgM", lineText: "Rubeola: IgM" }])).disputes.every((d) => d.reason !== "same_row_different_text")).toBe(true);
  });
});

describe("el juez elige una de las dos lecturas de la fila (nunca escribe otra)", () => {
  const c = buildSimpleConsensus(reading([{ literalText: "IgM", lineText: "Toxoplasma: IgM" }]), reading([{ literalText: "Toxoplasma IgM", lineText: "Toxoplasma: IgM" }]));
  const key = c.disputes[0]!.key;
  it("confirmed + reader → se confirma ESA lectura", () => {
    const j = applyJudgeDecisions(c.disputes, [{ key, verdict: "confirmed", reason: "se ve el encabezado", reader: "readerB" }]);
    expect(j.resolvedStudies.map((r) => [r.verdict, r.study.literalText])).toEqual([["confirmed", "Toxoplasma IgM"]]);
  });
  it("confirmed sin indicar cuál → sin resolver", () => {
    const j = applyJudgeDecisions(c.disputes, [{ key, verdict: "confirmed", reason: "x" }]);
    expect(j.resolvedStudies).toEqual([]);
    expect(j.unresolvedDisputes).toHaveLength(1);
  });
  it("rejected → nada se cotiza; unresolved → sin resolver", () => {
    expect(applyJudgeDecisions(c.disputes, [{ key, verdict: "rejected", reason: "x", reader: "none" }]).resolvedStudies[0]!.verdict).toBe("rejected");
    expect(applyJudgeDecisions(c.disputes, [{ key, verdict: "unresolved", reason: "x", reader: "none" }]).unresolvedDisputes).toHaveLength(1);
  });
  it("decisiones guardadas antes de existir «reader» siguen valiendo en las disputas de siempre", () => {
    const old = buildSimpleConsensus(reading([{ literalText: "TSH" }]), reading([]));
    const j = applyJudgeDecisions(old.disputes, [{ key: old.disputes[0]!.key, verdict: "confirmed", reason: "se ve" }]);
    expect(j.resolvedStudies.map((r) => r.study.literalText)).toEqual(["TSH"]);
  });
});

describe("analyzeImage: el juez no se llama si la única duda era de certeza con el mismo texto y la misma línea", () => {
  it("sin juez, estudio acordado con certeza alta y registro de auditoría", async () => {
    const judge = vi.fn(async (): Promise<SimpleJudgement> => ({ resolvedStudies: [], unresolvedDisputes: [] }));
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => reading([{ literalText: "Prolactina", lineText: "Prolactina" }])),
      readOpenAI: vi.fn(async () => reading([{ literalText: "Prolactina", lineText: "Prolactina", confidence: "medium" }])),
      judge,
      readDocument: vi.fn(async () => ({ signal: { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] } })) as AnalyzeDeps["readDocument"],
      resolveSemantic: vi.fn(async () => ({ items: [], model: "m", reasoning: "r", calledModel: false, cacheHit: true, usage: [], candidatesSentToModel: 0 })) as unknown as AnalyzeDeps["resolveSemantic"],
      shadowMatch: vi.fn()
    };
    const catalog = [{ id: "prl", code: "prl", name: "PROLACTINA", normalizedName: "prolactina", normalizedAliases: [], priceBs: 90, active: true, category: "HORMONAS" }];
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: false, partialAuto: false, handwrittenAuto: "off" }, deps);
    expect(judge).not.toHaveBeenCalled();
    expect(result.finalVisualStudies.map((study) => [study.literalText, study.confidence])).toEqual([["Prolactina", "high"]]);
    expect(result.certaintySettled).toHaveLength(1);
    expect(result.decision).toBe("AUTO_SAFE");
  });
});
