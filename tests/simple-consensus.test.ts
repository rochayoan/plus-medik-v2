import { describe, expect, it } from "vitest";
import { buildSimpleConsensus } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";

const study = (normalizedName: string, confidence: "high" | "medium" | "low" = "high") => ({
  literalText: normalizedName,
  normalizedName,
  evidence: "x" as const,
  confidence
});

const reading = (requested: SimpleReading["requestedStudies"], uncertain: string[] = []): SimpleReading => ({
  requestedStudies: requested,
  uncertainStudies: uncertain,
  notes: ""
});

describe("buildSimpleConsensus", () => {
  it("manda a agreedStudies el mismo estudio con alta certeza en ambos", () => {
    const result = buildSimpleConsensus(reading([study("TSH")]), reading([study("tsh")]));
    expect(result.agreedStudies).toHaveLength(1);
    expect(result.hasDisputes).toBe(false);
  });

  it("es disputa si uno cierra el estudio y el otro lo marca incierto", () => {
    const result = buildSimpleConsensus(reading([study("Toxoplasma IgG")]), reading([], ["IgG"]));
    expect(result.agreedStudies).toHaveLength(0);
    expect(result.disputes[0]?.reason).toBe("requested_with_uncertainty_in_other");
    expect(result.hasDisputes).toBe(true);
  });

  it("una incertidumbre sobre la variante de la misma determinación mueve el estudio a disputas", () => {
    const result = buildSimpleConsensus(
      reading([study("B2 Glicoproteína IgM")]),
      reading([study("B2 Glicoproteína IgM")], ["B2 Glicoproteína IgG"])
    );
    expect(result.agreedStudies).toHaveLength(0);
    expect(result.disputes).toHaveLength(1);
    expect(result.disputes[0]?.readerB.uncertain).toEqual(["B2 Glicoproteína IgG"]);
  });

  it("IgG e IgM no se consideran relacionados", () => {
    const result = buildSimpleConsensus(reading([study("Toxoplasma IgG")]), reading([study("Toxoplasma IgM")]));
    expect(result.disputes.map((d) => d.reason)).toEqual([
      "requested_by_one_reader_only",
      "requested_by_one_reader_only"
    ]);
  });

  it("es disputa si el estudio no tiene alta certeza en ambos", () => {
    const result = buildSimpleConsensus(reading([study("TSH")]), reading([study("TSH", "medium")]));
    expect(result.disputes[0]?.reason).toBe("not_high_confidence_in_both");
  });

  it("no descarta incertidumbres sin estudio relacionado", () => {
    const result = buildSimpleConsensus(reading([], ["T3 o T4"]), reading([]));
    expect(result.disputes[0]?.reason).toBe("uncertain_only");
  });
});

describe("buildSimpleConsensus matching por texto visible", () => {
  const withLiteral = (literalText: string, normalizedName: string) => ({
    literalText,
    normalizedName,
    evidence: "x" as const,
    confidence: "high" as const
  });

  it("no genera disputa falsa si literalText coincide aunque normalizedName difiera", () => {
    const result = buildSimpleConsensus(
      reading([withLiteral("Anticardiolipina IgM", "Anticuerpos anticardiolipina IgM")]),
      reading([withLiteral("anticardiolipina  IgM", "Anticardiolipina IgM")])
    );
    expect(result.agreedStudies).toHaveLength(1);
    expect(result.hasDisputes).toBe(false);
  });

  it("tolera repetición del isotipo al final y 'Ig M'", () => {
    const result = buildSimpleConsensus(
      reading([withLiteral("Anticardiolipina Ig M IgM", "Anticardiolipina IgM")]),
      reading([withLiteral("Anticardiolipina IgM", "Anticardiolipina IgM")])
    );
    expect(result.agreedStudies).toHaveLength(1);
  });

  it("IgG e IgM visibles distintos siguen siendo disputa", () => {
    const result = buildSimpleConsensus(
      reading([withLiteral("Anticardiolipina IgG", "Anticardiolipina IgG")]),
      reading([withLiteral("Anticardiolipina IgM", "Anticardiolipina IgM")])
    );
    expect(result.agreedStudies).toHaveLength(0);
    expect(result.disputes).toHaveLength(2);
  });
});

describe("buildSimpleConsensus con texto visible parcial", () => {
  it("'Ig G' solo en un lector no se relaciona con incertidumbres de otro estudio", () => {
    const result = buildSimpleConsensus(
      reading(
        [{ literalText: "Anticardiolipina Ig G", normalizedName: "Anticardiolipina IgG", evidence: "explicit_text", confidence: "high" }],
        ["B2 Glicoproteina (ambiguo entre IgM e IgG)"]
      ),
      reading([{ literalText: "Ig G", normalizedName: "Anticardiolipina IgG", evidence: "explicit_text", confidence: "high" }])
    );
    expect(result.agreedStudies).toHaveLength(1);
  });

  it("B2 y B₂ son el mismo texto visible", () => {
    const study = (literalText: string) => ({ literalText, normalizedName: literalText, evidence: "explicit_text" as const, confidence: "high" as const });
    const result = buildSimpleConsensus(reading([study("B2 Glicoproteina Ig M")]), reading([study("B₂ Glicoproteina Ig M")]));
    expect(result.agreedStudies).toHaveLength(1);
  });
});
