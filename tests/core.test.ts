import { describe, expect, it } from "vitest";
import { ExactAliasCatalogResolver } from "../src/catalog.js";
import { PlusMedikCore } from "../src/pipeline.js";
import type { DisputeJudge, VisionReader } from "../src/ai.js";
import type { JudgeDecision, VisionReading } from "../src/types.js";

class FakeReader implements VisionReader {
  constructor(public name: string, private reading: Omit<VisionReading, "reader">) {}
  async read(): Promise<VisionReading> { return { ...this.reading, reader: this.name }; }
}

class FakeJudge implements DisputeJudge {
  constructor(private result: JudgeDecision) {}
  async judge(): Promise<JudgeDecision> { return this.result; }
}

const hemograma = {
  text: "Hemograma completo",
  evidenceType: "X_MARK" as const,
  certainty: "HIGH" as const,
  evidenceSummary: "X visible junto a la fila"
};

const baseReading = {
  documentType: "MARK_DEPENDENT_FORM" as const,
  completeDocumentVisible: true,
  requested: [hemograma],
  uncertain: [],
  globalUncertainty: []
};

const catalog = new ExactAliasCatalogResolver([
  { code: "100", name: "Hemograma completo", aliases: ["Hemograma"], priceBs: 50, active: true },
  { code: "200", name: "TSH", aliases: [], priceBs: 70, active: true }
]);

describe("PlusMedikCore", () => {
  it("AUTO_SAFE when independent readers agree and catalog is unique", async () => {
    const core = new PlusMedikCore(
      new FakeReader("A", baseReading),
      new FakeReader("B", baseReading),
      new FakeJudge({ requested: [], rejectedKeys: [], unresolvedKeys: [] }),
      catalog
    );
    const result = await core.analyze("base64", "image/jpeg");
    expect(result.safety.decision).toBe("AUTO_SAFE");
    expect(result.quote?.totalBs).toBe(50);
  });

  it("uses judge only to resolve a disagreement", async () => {
    const b = { ...baseReading, requested: [] };
    const core = new PlusMedikCore(
      new FakeReader("A", baseReading),
      new FakeReader("B", b),
      new FakeJudge({ requested: [hemograma], rejectedKeys: [], unresolvedKeys: [] }),
      catalog
    );
    const result = await core.analyze("base64", "image/jpeg");
    expect(result.safety.decision).toBe("AUTO_SAFE");
  });

  it("fails closed when judge cannot resolve the dispute", async () => {
    const b = { ...baseReading, requested: [] };
    const core = new PlusMedikCore(
      new FakeReader("A", baseReading),
      new FakeReader("B", b),
      new FakeJudge({ requested: [], rejectedKeys: [], unresolvedKeys: ["hemograma completo"] }),
      catalog
    );
    const result = await core.analyze("base64", "image/jpeg");
    expect(result.safety.decision).toBe("HUMAN_REVIEW");
    expect(result.safety.reasons).toContain("visual_disputes_unresolved");
  });

  it("fails closed on unknown catalog item", async () => {
    const reading = {
      ...baseReading,
      requested: [{ ...hemograma, text: "Estudio inexistente" }]
    };
    const core = new PlusMedikCore(
      new FakeReader("A", reading),
      new FakeReader("B", reading),
      new FakeJudge({ requested: [], rejectedKeys: [], unresolvedKeys: [] }),
      catalog
    );
    const result = await core.analyze("base64", "image/jpeg");
    expect(result.safety.decision).toBe("HUMAN_REVIEW");
    expect(result.safety.reasons).toContain("catalog_unmatched");
  });
});
