import { describe, expect, it } from "vitest";
import { applyJudgeDecisions } from "../src/judge.js";
import type { SimpleDispute, SimpleStudy } from "../src/consensus.js";

const study: SimpleStudy = {
  literalText: "B2 Glicoproteina Ig M",
  normalizedName: "B2 Glicoproteina IgM",
  evidence: "explicit_text",
  confidence: "high"
};

const dispute = (key: string, requested?: SimpleStudy): SimpleDispute => ({
  key,
  reason: requested ? "requested_by_one_reader_only" : "uncertain_only",
  readerA: { requested, uncertain: [] },
  readerB: { uncertain: [] }
});

describe("applyJudgeDecisions", () => {
  it("confirma y rechaza usando el estudio que ya leyeron los lectores", () => {
    const result = applyJudgeDecisions(
      [dispute("a", study), dispute("b", study)],
      [
        { key: "a", verdict: "confirmed", reason: "se ve" },
        { key: "b", verdict: "rejected", reason: "es otro" }
      ]
    );
    expect(result.resolvedStudies.map((r) => [r.key, r.verdict, r.study])).toEqual([
      ["a", "confirmed", study],
      ["b", "rejected", study]
    ]);
    expect(result.unresolvedDisputes).toHaveLength(0);
  });

  it("deja unresolved lo que el juez no decide o no es claro", () => {
    const result = applyJudgeDecisions(
      [dispute("a", study), dispute("b", study)],
      [{ key: "a", verdict: "unresolved", reason: "borroso" }]
    );
    expect(result.resolvedStudies).toHaveLength(0);
    expect(result.unresolvedDisputes.map((u) => u.dispute.key)).toEqual(["a", "b"]);
  });

  it("no inventa estudios: ignora keys desconocidas y no confirma sin estudio solicitado", () => {
    const result = applyJudgeDecisions(
      [dispute("solo-incierto")],
      [
        { key: "solo-incierto", verdict: "confirmed", reason: "x" },
        { key: "inventado", verdict: "confirmed", reason: "y" }
      ]
    );
    expect(result.resolvedStudies).toHaveLength(0);
    expect(result.unresolvedDisputes).toHaveLength(1);
  });
});

describe("applyJudgeDecisions con verdict inválido", () => {
  it("manda a unresolvedDisputes si el verdict falta o es inválido, sin inferirlo del reason", () => {
    const result = applyJudgeDecisions(
      [dispute("a", study), dispute("b", study), dispute("c", study)],
      [
        { key: "a", reason: "se ve claramente, confirmado" },
        { key: "b", verdict: "maybe", reason: "confirmed" },
        { key: "c", verdict: "confirmed", reason: "se ve" }
      ]
    );
    expect(result.resolvedStudies.map((r) => r.key)).toEqual(["c"]);
    expect(result.unresolvedDisputes.map((u) => u.dispute.key)).toEqual(["a", "b"]);
    expect(result.resolvedStudies.every((r) => r.verdict === "confirmed" || r.verdict === "rejected")).toBe(true);
  });
});

describe("applyJudgeDecisions con transcripción parcial", () => {
  const full: SimpleStudy = { literalText: "NITROGENO UREICO/UREA/NUS", normalizedName: "Nitrógeno ureico / Urea / NUS", evidence: "check", confidence: "high" };
  const truncated: SimpleStudy = { literalText: "NITROGENO UREICO", normalizedName: "Nitrógeno ureico", evidence: "check", confidence: "high" };
  const partial: SimpleDispute = {
    key: "nitrogeno ureico urea nus",
    reason: "partial_transcription",
    readerA: { requested: full, uncertain: [] },
    readerB: { requested: truncated, uncertain: [] },
    preferred: full
  };

  it("confirma el estudio con el texto completo, aunque la lectura truncada sea la del primer lector", () => {
    const swapped: SimpleDispute = { ...partial, readerA: { requested: truncated, uncertain: [] }, readerB: { requested: full, uncertain: [] } };
    for (const d of [partial, swapped]) {
      const result = applyJudgeDecisions([d], [{ key: d.key, verdict: "confirmed", reason: "se ve la fila" }]);
      expect(result.resolvedStudies).toHaveLength(1);
      expect(result.resolvedStudies[0]!.study.literalText).toBe("NITROGENO UREICO/UREA/NUS");
    }
  });

  it("si el juez no lo resuelve, queda sin resolver (no se asume ninguna de las dos lecturas)", () => {
    const result = applyJudgeDecisions([partial], [{ key: partial.key, verdict: "unresolved", reason: "borroso" }]);
    expect(result.resolvedStudies).toHaveLength(0);
    expect(result.unresolvedDisputes).toHaveLength(1);
  });
});
