import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps, type DocumentGate, type FinalVisualStudy } from "../src/analyze.js";
import type { SimpleReading } from "../src/ai.js";
import { buildSimpleConsensus, normalizeStudyKey } from "../src/consensus.js";
import { impactStudyOf } from "../src/partial-auto.js";
import { impactInstructions, type ImpactStudy } from "../src/study-impact.js";
import { RECONSTRUCTION_CATALOG, row } from "./support/reconstruction-adversarial.js";
import { ADVERSARIAL_CATALOG, STRUCTURES } from "./support/inheritance-adversarial.js";

// El verificador de impacto trabaja sobre la IMAGEN: recibe lo que está ESCRITO en la fila (texto literal de los lectores) y la línea original de los estudios
// reconstruidos. El texto reconstruido nunca se le presenta como si estuviera en la imagen ni puede ser evidencia independiente de ella.

const CUT = { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: false, agreement: true, integrityProblems: ["cortado por el borde: fila inferior"], integrityKinds: ["CUT_EDGE"] };
const L = "Anti-lambda IgM, IgG";
const study = (extra: Partial<FinalVisualStudy>): FinalVisualStudy => ({ literalText: "x", normalizedName: "x", evidence: "check", confidence: "high", source: "agreed", ...extra });

describe("impactStudyOf: lo que se le muestra al verificador", () => {
  it("un estudio sin reconstruir se presenta exactamente como antes: clave y texto, sin línea", () => {
    expect(impactStudyOf(study({ literalText: "Hemograma completo" }))).toEqual({ key: normalizeStudyKey("Hemograma completo"), text: "Hemograma completo" });
    expect("line" in impactStudyOf(study({ literalText: "Hemograma completo" }))).toBe(false);
  });
  it("un estudio que heredó el analito se presenta con su texto LITERAL y la línea; la clave sigue siendo la del estudio final", () => {
    const heard = study({ literalText: "anti lambda IgG", inheritedFrom: "IgG", lineText: L, readerPairs: [{ a: "IgG", b: "IgG" }] });
    expect(impactStudyOf(heard)).toEqual({ key: normalizeStudyKey("anti lambda IgG"), text: "IgG", line: L });
  });
  it("un paquete reunido se presenta con las filas tal como las leyó el primer lector y la línea", () => {
    const pkg = study({ literalText: "ZETAINA + KAPPAINA", collapsedFrom: ["Zetaina", "Kappaina en sangre"], lineText: "ZETAINA + KAPPAINA", readerPairs: [{ a: "Zetaina", b: "Zetaina" }, { a: "Kappaina en sangre", b: "Kappaina en sangre" }] });
    expect(impactStudyOf(pkg)).toEqual({ key: normalizeStudyKey("ZETAINA + KAPPAINA"), text: "Zetaina | Kappaina en sangre", line: "ZETAINA + KAPPAINA" });
  });
  it("un estudio heredado y reunido a la vez usa las lecturas originales, no el texto heredado", () => {
    const both = study({ literalText: "PAQUETE", collapsedFrom: ["gamaina IgG", "b"], inheritedFrom: "IgG", lineText: "Gamaina IgG, b", readerPairs: [{ a: "IgG", b: "IgG" }, { a: "b", b: "b" }] });
    expect(impactStudyOf(both).text).toBe("IgG | b");
  });
});

describe("impactInstructions: el prompt solo cambia para estudios reconstruidos", () => {
  const plain: ImpactStudy[] = [{ key: "a", text: "Hemograma completo" }, { key: "b", text: "Creatinina" }];
  it("sin línea el texto del prompt es el de siempre (la caché de lo ya verificado sigue valiendo)", () => {
    const text = impactInstructions("A", plain, ["borde cortado"]);
    expect(text).toContain("0. Hemograma completo\n1. Creatinina\nMira la imagen");
    expect(text).not.toContain("escrito en la línea");
    expect(text).not.toContain("Cuando se indica la línea");
  });
  it("con línea, el estudio se identifica por lo escrito y su línea, con la instrucción de no completar ni inferir", () => {
    const text = impactInstructions("B", [{ key: "a", text: "IgG", line: L }, ...plain], ["borde cortado"]);
    expect(text).toContain(`0. IgG (escrito en la línea «${L}»)`);
    expect(text).toContain("no completes, no infieras ni agregues el nombre del estudio");
    expect(text).toContain("1. Hemograma completo\n2. Creatinina");
  });
});

describe("de extremo a extremo con analyzeImage", () => {
  const reading = (rows: ReturnType<typeof row>[]): SimpleReading => ({ requestedStudies: rows, uncertainStudies: [], notes: "" });
  const rows = [row("Anti-lambda IgM", "Anti-lambda IgM", L), row("IgG", "IgG", L)];
  const deps = (verifyImpact: AnalyzeDeps["verifyImpact"]): AnalyzeDeps => ({
    readGemini: vi.fn(async () => reading(rows)),
    readOpenAI: vi.fn(async () => reading(rows)),
    judge: vi.fn(async () => ({ resolvedStudies: [], unresolvedDisputes: [] })),
    readDocument: vi.fn(async () => ({ signal: { documentType: CUT.documentType, completeDocumentVisible: false, agreement: true, integrity: { problems: CUT.integrityProblems, irrelevantCrops: [], kinds: CUT.integrityKinds as never }, reasons: ["", ""] as [string, string] } })),
    resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
    shadowMatch: vi.fn(async () => { throw new Error("no debe llamarse"); }) as unknown as AnalyzeDeps["shadowMatch"],
    verifyImpact
  });
  const base = { imageBase64: "x", mimeType: "image/jpeg", catalog: RECONSTRUCTION_CATALOG, semanticPrimary: false, partialAuto: true };

  it("el verificador recibe el texto literal «IgG» y su línea, y el veredicto por clave se aplica al estudio reconstruido", async () => {
    const verifyImpact = vi.fn(async (args: Parameters<NonNullable<AnalyzeDeps["verifyImpact"]>>[0]) => ({ available: true, unaffected: new Set(args.studies.map((s) => s.key)), qualifierRisk: false, notes: [] }));
    const result = await analyzeImage(base, deps(verifyImpact));
    expect(verifyImpact.mock.calls[0]![0].studies).toEqual([
      { key: normalizeStudyKey("Anti-lambda IgM"), text: "Anti-lambda IgM" },
      { key: normalizeStudyKey("anti lambda IgG"), text: "IgG", line: L }
    ]);
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["ANTI-LAMBDA IGM", "ANTI-LAMBDA IGG"]);
  });
  it("si el verificador solo confirma la fila no reconstruida, la reconstruida queda en revisión (fail-closed por clave)", async () => {
    const verifyImpact = vi.fn(async (args: Parameters<NonNullable<AnalyzeDeps["verifyImpact"]>>[0]) => ({ available: true, unaffected: new Set(args.studies.filter((s) => s.text === "Anti-lambda IgM").map((s) => s.key)), qualifierRisk: false, notes: [] }));
    const result = await analyzeImage(base, deps(verifyImpact));
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["ANTI-LAMBDA IGM"]);
    expect(result.internal?.studies.find((s) => s.text === "anti lambda IgG")?.decision).toBe("HUMAN_REVIEW");
  });
});

describe("propiedad adversarial: el verificador nunca ve texto que ningún lector escribió", () => {
  it("en instancias generadas (analitos inventados, con fila donante), todo texto presentado es una lectura original de los lectores", () => {
    const unseen: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: false, agreement: true, integrityProblems: ["borde cortado"], integrityKinds: ["CUT_EDGE"] };
    let checked = 0;
    let reconstructed = 0;
    for (const name of ["S2_donor_single_analyte", "S13_shared_words_donor", "S4b_donor_with_variant_of_other_analyte"]) {
      for (let i = 0; i < 60; i++) {
        const instance = STRUCTURES[name]!.make();
        const original = new Set(instance.rows.map((r) => r.literalText));
        const reading = { requestedStudies: instance.rows, uncertainStudies: [], notes: "" };
        const analysis = assembleAnalysis({ consensus: buildSimpleConsensus(reading, reading), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog: ADVERSARIAL_CATALOG, document: unseen, partialAuto: true });
        reconstructed += analysis.finalVisualStudies.filter((s) => s.inheritedFrom !== undefined).length;
        for (const candidate of analysis.internal?.document.impactCheck.candidates ?? []) {
          checked++;
          expect(candidate.text.split(" | ").every((part) => original.has(part)), candidate.text + " no es una lectura original").toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(reconstructed).toBeGreaterThan(20);
  });
});
