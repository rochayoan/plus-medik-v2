import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps } from "../src/analyze.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const visual = (literalText: string, normalizedName = literalText, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({
  literalText,
  normalizedName,
  evidence: "circle",
  confidence
});

const reading = (requested: SimpleStudy[], uncertain: string[] = []): SimpleReading => ({
  requestedStudies: requested,
  uncertainStudies: uncertain,
  notes: ""
});

const catalogStudy = (id: string, name: string, priceBs: number, extra: Partial<CatalogStudy> = {}): CatalogStudy => ({
  id,
  code: null,
  name,
  normalizedName: name.toLowerCase(),
  normalizedAliases: [],
  priceBs,
  active: true,
  ...extra
});

const catalog: CatalogStudy[] = [
  catalogStudy("uuid-fsh", "FSH", 40, { code: "11" }),
  catalogStudy("uuid-lh", "LH", 45, { code: null }),
  catalogStudy("uuid-tsh", "TSH (ECLIA)", 90, { code: "178", normalizedName: "tsh eclia", normalizedAliases: ["tsh", "hormona tiroestimulante"] }),
  catalogStudy("uuid-a", "Perfil A", 10, { normalizedName: "perfil a", normalizedAliases: ["perfil"] }),
  catalogStudy("uuid-b", "Perfil B", 20, { normalizedName: "perfil b", normalizedAliases: ["perfil"] })
];

const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };

function assemble(a: SimpleReading, b: SimpleReading, judgement: SimpleJudgement = noJudgement, studies = catalog) {
  return assembleAnalysis({ consensus: buildSimpleConsensus(a, b), judgement, catalog: studies });
}

describe("assembleAnalysis", () => {
  it("todo acordado y resuelto en catálogo -> AUTO_SAFE con cotización PACIENTE", () => {
    const both = reading([visual("FSH"), visual("LH")]);
    const result = assemble(both, both);
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.reasons).toEqual([]);
    expect(result.quote).toEqual({
      lines: [
        { id: "uuid-fsh", code: "11", name: "FSH", priceBs: 40 },
        { id: "uuid-lh", code: null, name: "LH", priceBs: 45 }
      ],
      totalBs: 85,
      tariff: "PACIENTE"
    });
  });

  it("incluye los confirmados por el juez y excluye los rechazados", () => {
    const a = reading([visual("FSH"), visual("LH")]);
    const b = reading([visual("FSH")]);
    const rejected = assemble(a, b, {
      resolvedStudies: [{ key: "lh", verdict: "rejected", study: visual("LH"), reason: "casilla vacía" }],
      unresolvedDisputes: []
    });
    expect(rejected.finalVisualStudies.map((s) => s.literalText)).toEqual(["FSH"]);
    expect(rejected.decision).toBe("AUTO_SAFE");
    expect(rejected.quote?.totalBs).toBe(40);

    const confirmed = assemble(a, b, {
      resolvedStudies: [{ key: "lh", verdict: "confirmed", study: visual("LH"), reason: "se ve" }],
      unresolvedDisputes: []
    });
    expect(confirmed.finalVisualStudies.map((s) => [s.literalText, s.source])).toEqual([
      ["FSH", "agreed"],
      ["LH", "judge_confirmed"]
    ]);
    expect(confirmed.quote?.totalBs).toBe(85);
  });

  it("cualquier disputa sin resolver -> HUMAN_REVIEW y sin cotización", () => {
    const a = reading([visual("FSH"), visual("LH")]);
    const b = reading([visual("FSH")]);
    const dispute = buildSimpleConsensus(a, b).disputes[0]!;
    const result = assemble(a, b, { resolvedStudies: [], unresolvedDisputes: [{ dispute, reason: "borroso" }] });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("visual_disputes_unresolved");
    expect(result.unresolvedDisputes).toEqual([{ key: "lh", reason: "borroso" }]);
    expect(result.quote).toBeUndefined();
  });

  it("una disputa que el juez no cubrió falla cerrado", () => {
    const result = assemble(reading([visual("FSH"), visual("LH")]), reading([visual("FSH")]));
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("visual_disputes_unresolved");
  });

  it("matching por literalText exacto; normalizedName solo es diagnóstico y no produce AUTO", () => {
    // literalText no está en el catálogo, pero normalizedName sí ("TSH ECLIA").
    const both = reading([visual("Hormona TSH ultrasensible", "TSH ECLIA")]);
    const result = assemble(both, both);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("catalog_unmatched");
    expect(result.quote).toBeUndefined();
    expect(result.unmatched).toEqual(["Hormona TSH ultrasensible"]);
    expect(result.matches[0]).toMatchObject({
      matchedText: "Hormona TSH ultrasensible",
      status: "UNMATCHED",
      diagnosticNormalizedName: { text: "TSH ECLIA", status: "MATCHED" }
    });
  });

  it("resuelve por alias exacto del literalText", () => {
    const both = reading([visual("TSH")]);
    const result = assemble(both, both);
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.matches[0]?.study?.id).toBe("uuid-tsh");
  });

  it("AMBIGUOUS -> HUMAN_REVIEW con candidatos", () => {
    const both = reading([visual("Perfil")]);
    const result = assemble(both, both);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("catalog_ambiguous");
    expect(result.ambiguous[0]?.candidates.map((c) => c.id).sort()).toEqual(["uuid-a", "uuid-b"]);
    expect(result.quote).toBeUndefined();
  });

  it("dos estudios visuales que resuelven al mismo UUID dan una sola línea y un solo cobro", () => {
    const both = reading([visual("TSH"), visual("Hormona tiroestimulante")]);
    const result = assemble(both, both);
    expect(result.matches).toHaveLength(2);
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines).toEqual([{ id: "uuid-tsh", code: "178", name: "TSH (ECLIA)", priceBs: 90 }]);
    expect(result.quote?.totalBs).toBe(90);
  });

  it("un estudio confirmado por el juez con confianza no alta fuerza HUMAN_REVIEW", () => {
    const a = reading([visual("LH", "LH", "medium")]);
    const b = reading([]);
    const result = assemble(a, b, {
      resolvedStudies: [{ key: "lh", verdict: "confirmed", study: visual("LH", "LH", "medium"), reason: "se ve" }],
      unresolvedDisputes: []
    });
    expect(result.reasons).toContain("non_high_certainty_study");
    expect(result.decision).toBe("HUMAN_REVIEW");
  });

  it("sin estudios finales -> HUMAN_REVIEW", () => {
    const result = assemble(reading([]), reading([]));
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("no_requested_studies");
  });

  it("un estudio inactivo en el catálogo no hace match", () => {
    const both = reading([visual("FSH")]);
    const result = assemble(both, both, noJudgement, [catalogStudy("uuid-fsh", "FSH", 40, { active: false })]);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("catalog_unmatched");
  });
});

describe("analyzeImage (flujo con dependencias falsas, sin red)", () => {
  const makeDeps = (a: SimpleReading, b: SimpleReading, judgement: SimpleJudgement = noJudgement) => {
    const judge = vi.fn(async () => judgement);
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => a),
      readOpenAI: vi.fn(async () => b),
      judge
    };
    return { deps, judge };
  };

  it("no llama al juez si no hay disputas", async () => {
    const both = reading([visual("FSH")]);
    const { deps, judge } = makeDeps(both, both);
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog }, deps);
    expect(judge).not.toHaveBeenCalled();
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.totalBs).toBe(40);
  });

  it("llama al juez con la misma imagen y las disputas cuando hay desacuerdo", async () => {
    const a = reading([visual("FSH"), visual("LH")]);
    const b = reading([visual("FSH")]);
    const { deps, judge } = makeDeps(a, b, {
      resolvedStudies: [{ key: "lh", verdict: "confirmed", study: visual("LH"), reason: "se ve" }],
      unresolvedDisputes: []
    });
    const result = await analyzeImage({ imageBase64: "img", mimeType: "image/png", catalog }, deps);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: "img", mimeType: "image/png", gemini: a, openai: b }));
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.totalBs).toBe(85);
  });
});
