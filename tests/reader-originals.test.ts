import { describe, expect, it } from "vitest";
import { readersDisagree, type FinalVisualStudy } from "../src/analyze.js";
import { analyze, evaluateMode, MODES, RECONSTRUCTION_CATALOG, row } from "./support/reconstruction-adversarial.js";

// Un estudio reconstruido (herencia de analito o paquete) se comprueba SIEMPRE contra lo que cada modelo leyó en la imagen, no contra el texto reconstruido.
// Si la correspondencia no puede verificarse, el estudio queda en revisión humana. Esto protege `readers_variant_mismatch` de la reconstrucción.

const L = "Anti-lambda IgM, IgG, IgA";
const study = (extra: Partial<FinalVisualStudy>): FinalVisualStudy => ({ literalText: "x", normalizedName: "x", evidence: "check", confidence: "high", source: "agreed", ...extra });

describe("regresión comprobada: lecturas distintas en una fila reconstruida", () => {
  it("A lee IgG, B lee IgA en la misma fila suelta (mismo normalizedName): no se cotiza la variante reconstruida, solo lo que ambos leyeron igual", () => {
    const { codes, result } = analyze([row("Anti-lambda IgM", "Anti-lambda IgM", L), row("IgG", "Anti-lambda", L)], [row("Anti-lambda IgM", "Anti-lambda IgM", L), row("IgA", "Anti-lambda", L)], RECONSTRUCTION_CATALOG);
    expect(codes).toEqual(["ANTI-LAMBDA IGM"]);
    const held = result.internal!.studies.find((s) => s.decision !== "AUTO")!;
    expect(held.blockers).toContain("readers_variant_mismatch");
    expect(result.finalVisualStudies.find((s) => s.inheritedFrom)?.literalText).toBe("anti lambda IgG");
  });
  it("sin reconstrucción el comportamiento anterior se conserva (control): los lectores difieren y se retiene", () => {
    const { codes, result } = analyze([row("Anti-lambda IgG", "Anti-lambda", L)], [row("Anti-lambda IgA", "Anti-lambda", L)], RECONSTRUCTION_CATALOG);
    expect(codes).toEqual([]);
    expect(result.internal!.studies[0]!.blockers).toContain("readers_variant_mismatch");
  });
  it("cuando los dos leen lo mismo en la fila suelta se cotiza (sin pérdida de cobertura), aunque su normalizedName sea solo el analito", () => {
    const rows = [row("Anti-lambda IgM", "Anti-lambda", L), row("IgG", "Anti-lambda", L), row("IgA", "Anti-lambda", L)];
    expect(analyze(rows, rows, RECONSTRUCTION_CATALOG).codes.sort()).toEqual(["ANTI-LAMBDA IGA", "ANTI-LAMBDA IGG", "ANTI-LAMBDA IGM"]);
  });
});

describe("readersDisagree: la correspondencia con las lecturas originales debe ser inequívoca", () => {
  it("estudio sin reconstruir: bloquea solo si los lectores difieren en una variante (comportamiento anterior)", () => {
    expect(readersDisagree(study({ readerPairs: [{ a: "Anti-lambda IgG", b: "Anti-lambda IgG" }] }))).toBe(false);
    expect(readersDisagree(study({ readerPairs: [{ a: "Anti-lambda IgG", b: "Anti-lambda IgA" }] }))).toBe(true);
    expect(readersDisagree(study({ readerPairs: [{ a: "Hemograma", b: "Hemograma completo" }] }))).toBe(false);
    expect(readersDisagree(study({}))).toBe(false);
    expect(readersDisagree(study({ source: "judge_confirmed", readerPairs: [{ a: "IgG", b: "IgM" }] }))).toBe(false);
  });
  it("estudio heredado: exige una pareja con el MISMO texto visible y las mismas variantes", () => {
    expect(readersDisagree(study({ inheritedFrom: "IgG", readerPairs: [{ a: "IgG", b: "IGG" }] }))).toBe(false);
    expect(readersDisagree(study({ inheritedFrom: "IgG", readerPairs: [{ a: "IgG", b: "IgA" }] }))).toBe(true);
    expect(readersDisagree(study({ inheritedFrom: "IgG", readerPairs: [{ a: "IgG", b: "IgG cuantitativo" }] }))).toBe(true);
  });
  it("estudio heredado sin las lecturas originales (o con más de una pareja): no puede verificarse, queda en revisión", () => {
    expect(readersDisagree(study({ inheritedFrom: "IgG" }))).toBe(true);
    expect(readersDisagree(study({ inheritedFrom: "IgG", readerPairs: [] }))).toBe(true);
    expect(readersDisagree(study({ inheritedFrom: "IgG", readerPairs: [{ a: "IgG", b: "IgG" }, { a: "IgM", b: "IgM" }] }))).toBe(true);
  });
  it("paquete reunido: cada fila reunida debe tener su pareja y coincidir", () => {
    const ok = [{ a: "Zetaina", b: "Zetaina" }, { a: "Kappaina", b: "Kappaina" }];
    expect(readersDisagree(study({ collapsedFrom: ["Zetaina", "Kappaina"], readerPairs: ok }))).toBe(false);
    expect(readersDisagree(study({ collapsedFrom: ["Zetaina", "Kappaina"], readerPairs: [ok[0]!] }))).toBe(true);
    expect(readersDisagree(study({ collapsedFrom: ["Zetaina", "Kappaina"] }))).toBe(true);
    expect(readersDisagree(study({ collapsedFrom: ["Zetaina", "Kappaina"], readerPairs: [ok[0]!, { a: "Kappaina en sangre", b: "Kappaina" }] }))).toBe(true);
  });
  it("heredado y reunido a la vez: se comprueban las lecturas de cada fila original", () => {
    expect(readersDisagree(study({ inheritedFrom: "IgG", collapsedFrom: ["a IgG", "b"], readerPairs: [{ a: "IgG", b: "IgG" }, { a: "b", b: "b" }] }))).toBe(false);
    expect(readersDisagree(study({ inheritedFrom: "IgG", collapsedFrom: ["a IgG", "b"], readerPairs: [{ a: "IgG", b: "IgM" }, { a: "b", b: "b" }] }))).toBe(true);
  });
});

describe("generador adversarial de lecturas originales (analitos inventados, semilla fija)", () => {
  const INSTANCES = 150;
  for (const [name, mode] of Object.entries(MODES)) {
    it(`${name}: ${mode.description}`, () => {
      const result = evaluateMode(name, INSTANCES);
      expect(result.notReadByBoth, "cotizó algo que los dos lectores no leyeron igual").toBe(0);
      expect(result.missed, "dejó de cotizar algo que los dos leyeron igual").toBe(0);
    });
  }
});

describe("la X de selección no cuenta como diferencia entre las lecturas originales", () => {
  it("dos lecturas que difieren solo en la marca X del texto de la fila son la misma lectura; una variante distinta o un nombre distinto siguen bloqueando", () => {
    expect(readersDisagree(study({ inheritedFrom: "IgM X", readerPairs: [{ a: "IgM X", b: "IgM" }] }))).toBe(false);
    expect(readersDisagree(study({ inheritedFrom: "IgM", readerPairs: [{ a: "IgM", b: "IgM (x)" }] }))).toBe(false);
    expect(readersDisagree(study({ inheritedFrom: "IgM X", readerPairs: [{ a: "IgM X", b: "IgA X" }] }))).toBe(true);
    expect(readersDisagree(study({ inheritedFrom: "IgM X", readerPairs: [{ a: "IgM X", b: "IgM cuantitativo" }] }))).toBe(true);
  });
  it("la X que es parte del nombre no se ignora: «Factor X» frente a «Factor» sigue siendo una diferencia", () => {
    expect(readersDisagree(study({ collapsedFrom: ["Factor X total"], readerPairs: [{ a: "Factor X total", b: "Factor total" }] }))).toBe(true);
    expect(readersDisagree(study({ collapsedFrom: ["Factor X total"], readerPairs: [{ a: "Factor X total", b: "Factor X total" }] }))).toBe(false);
  });
  it("de extremo a extremo: la marca X en un solo lector no bloquea; las variantes distintas con marca sí", () => {
    const line = "Anti-lambda IgG X, IgM X";
    const donor = row("Anti-lambda IgG", "Anti-lambda IgG", line);
    expect(analyze([donor, row("IgM X", "Anti-lambda", line)], [donor, row("IgM", "Anti-lambda", line)], RECONSTRUCTION_CATALOG).codes.sort()).toEqual(["ANTI-LAMBDA IGG", "ANTI-LAMBDA IGM"]);
    expect(analyze([donor, row("IgM X", "Anti-lambda", line)], [donor, row("IgA X", "Anti-lambda", line)], RECONSTRUCTION_CATALOG).codes).toEqual(["ANTI-LAMBDA IGG"]);
  });
});
