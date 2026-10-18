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
