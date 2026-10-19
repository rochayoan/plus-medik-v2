import { describe, expect, it } from "vitest";
import { buildSimpleConsensus, isTruncationOf } from "../src/consensus.js";
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

describe("buildSimpleConsensus: una selección visual, un estudio", () => {
  const row = (literalText: string, normalizedName = literalText, confidence: "high" | "medium" | "low" = "high") => ({
    literalText,
    normalizedName,
    evidence: "check" as const,
    confidence
  });

  it("la misma fila transcrita con distinto espaciado ('UREA/NUS' vs 'UREANUS') es un solo estudio acordado", () => {
    const result = buildSimpleConsensus(
      reading([row("NITROGENO UREICO/UREA/NUS", "Nitrógeno ureico / Urea / NUS")]),
      reading([row("NITROGENO UREICO/UREANUS", "Nitrógeno ureico")])
    );
    expect(result.agreedStudies.map((s) => s.literalText)).toEqual(["NITROGENO UREICO/UREA/NUS"]);
    expect(result.hasDisputes).toBe(false);
  });

  it("una lectura truncada y la completa son UNA disputa 'partial_transcription' con el texto completo como estudio", () => {
    const result = buildSimpleConsensus(
      reading([row("NITROGENO UREICO/UREA/NUS")]),
      reading([row("NITROGENO UREICO")])
    );
    expect(result.agreedStudies).toHaveLength(0);
    expect(result.disputes).toHaveLength(1);
    expect(result.disputes[0]).toMatchObject({ key: "nitrogeno ureico urea nus", reason: "partial_transcription" });
    expect(result.disputes[0]!.preferred?.literalText).toBe("NITROGENO UREICO/UREA/NUS");
    expect(result.disputes[0]!.readerA.requested?.literalText).toBe("NITROGENO UREICO/UREA/NUS");
    expect(result.disputes[0]!.readerB.requested?.literalText).toBe("NITROGENO UREICO");
  });

  it("también cuando la lectura truncada es la del primer lector", () => {
    const result = buildSimpleConsensus(reading([row("NITROGENO UREICO")]), reading([row("NITROGENO UREICO/UREA/NUS")]));
    expect(result.disputes).toHaveLength(1);
    expect(result.disputes[0]!.preferred?.literalText).toBe("NITROGENO UREICO/UREA/NUS");
    expect(result.disputes[0]!.key).toBe("nitrogeno ureico urea nus");
  });

  it("aunque ambos lean con alta certeza, la transcripción parcial nunca se acuerda sin juez", () => {
    const result = buildSimpleConsensus(reading([row("Hemoglobina glicosilada (HbA1c)")]), reading([row("Hemoglobina glicosilada")]));
    expect(result.agreedStudies).toHaveLength(0);
    expect(result.disputes.map((d) => d.reason)).toEqual(["partial_transcription"]);
  });

  it("estudios realmente distintos no se fusionan", () => {
    for (const [a, b] of [
      ["Calcio sérico", "Calcio iónico"],
      ["Hemoglobina glicosilada", "Hemoglobina y hematocrito"],
      ["Glicemia basal", "Glicemia postprandial"],
      ["Toxoplasmosis IgG", "Toxoplasmosis IgM"]
    ]) {
      const result = buildSimpleConsensus(reading([row(a!)]), reading([row(b!)]));
      expect(result.disputes.map((d) => d.reason)).toEqual(["requested_by_one_reader_only", "requested_by_one_reader_only"]);
      expect(result.disputes.every((d) => d.preferred === undefined)).toBe(true);
    }
  });

  it("si la lectura corta podría pertenecer a varias filas, no se adivina cuál", () => {
    const result = buildSimpleConsensus(
      reading([row("Hemoglobina")]),
      reading([row("Hemoglobina glicosilada"), row("Hemoglobina y hematocrito")])
    );
    expect(result.disputes.map((d) => d.reason)).toEqual(["requested_by_one_reader_only", "requested_by_one_reader_only", "requested_by_one_reader_only"]);
  });

  it("un texto que es solo la variante ('Ig G') no se toma como truncamiento", () => {
    expect(isTruncationOf("igg", "igg anticardiolipina")).toBe(false);
    expect(isTruncationOf("nitrogeno ureico", "nitrogeno ureico urea nus")).toBe(true);
    expect(isTruncationOf("nitrogeno ureico urea nus", "nitrogeno ureico")).toBe(false);
    expect(isTruncationOf("nitrogeno ureico", "nitrogeno ureico")).toBe(false);
    expect(isTruncationOf("ureico", "nitrogeno ureico")).toBe(false);
  });

  it("singular y plural de la misma fila (BILIRRUBINAS / BILIRRUBINA) son un solo estudio", () => {
    const result = buildSimpleConsensus(
      reading([row("BILIRRUBINAS TOTALES Y FRACCIONES")]),
      reading([row("BILIRRUBINA TOTALES Y FRACCIONES")])
    );
    expect(result.agreedStudies.map((s) => s.literalText)).toEqual(["BILIRRUBINAS TOTALES Y FRACCIONES"]);
    expect(result.hasDisputes).toBe(false);
  });

  it("la tolerancia de plural y espaciado no fusiona variantes clínicas", () => {
    for (const [a, b] of [
      ["Anticardiolipinas IgG", "Anticardiolipinas IgM"],
      ["T3 libre", "T4 libre"],
      ["Proteinas totales", "Proteina C reactiva"],
      ["Hormona LH", "Hormona FSH"]
    ]) {
      const result = buildSimpleConsensus(reading([row(a!)]), reading([row(b!)]));
      expect(result.agreedStudies).toHaveLength(0);
      expect(result.disputes).toHaveLength(2);
    }
  });

  it("el resto de la receta se empareja igual y los estudios acordados no cambian", () => {
    const result = buildSimpleConsensus(
      reading([row("CREATININA SERICA"), row("NITROGENO UREICO/UREA/NUS"), row("TRANSAMINASAS GOT/GPT")]),
      reading([row("CREATININA SERICA"), row("NITROGENO UREICO"), row("TRANSAMINASAS GOT/GPT")])
    );
    expect(result.agreedStudies.map((s) => s.literalText)).toEqual(["CREATININA SERICA", "TRANSAMINASAS GOT/GPT"]);
    expect(result.disputes.map((d) => d.reason)).toEqual(["partial_transcription"]);
  });
});
