import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { formatDoubtfulOptions, possibleStudiesFromAnalysis } from "../src/quote-options.js";
import type { CatalogStudy } from "../src/types.js";

// Estudios POSIBLES: lo dudoso se ofrece con precio y fuera del total, solo cuando la duda es de lectura o de identidad (nunca del documento ni de política).

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, priceBs: number, active = true): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs, active, category: null, sampleType: null }) as unknown as CatalogStudy;
const CATALOG = [study(1, "HEMOGRAMA COMPLETO", 45), study(2, "FOSFORO (P)", 50), study(3, "FOSFATURIA DE 24 HORAS", 90), study(4, "INACTIVO", 30, false), study(5, "SIN PRECIO", 0)];
const candidate = (n: number) => ({ id: uuid(n), code: null, name: CATALOG[n - 1]!.name, priceBs: CATALOG[n - 1]!.priceBs });

const analysisWith = (pending: Array<{ uncertainty: string[]; candidates?: number[]; kind?: string }>, extra: { recipeStops?: string[]; quoted?: number[] } = {}): AnalysisResult => ({
  internal: {
    recipeStops: extra.recipeStops ?? [],
    quoted: { lines: (extra.quoted ?? [1]).map((n) => ({ id: uuid(n) })), subtotalBs: 45 },
    pending: pending.map((item, index) => ({ key: `k${index}`, kind: item.kind ?? "STUDY", text: "algo", blockers: [], uncertainty: item.uncertainty, ...(item.candidates ? { candidates: item.candidates.map(candidate) } : {}) }))
  }
}) as unknown as AnalysisResult;

describe("posibles de una foto", () => {
  it("duda de LECTURA o de IDENTIDAD con candidatos: se ofrecen (activos y con precio; nunca lo ya cotizado)", () => {
    const possible = possibleStudiesFromAnalysis(analysisWith([{ uncertainty: ["IDENTITY"], candidates: [2, 3, 1] }, { uncertainty: ["READING"], candidates: [4, 5] }]), CATALOG);
    expect(possible.map((s) => s.name)).toEqual(["FOSFORO (P)", "FOSFATURIA DE 24 HORAS"]);
  });
  it("duda del DOCUMENTO o de POLÍTICA: nunca se ofrece", () => {
    expect(possibleStudiesFromAnalysis(analysisWith([{ uncertainty: ["DOCUMENT"], candidates: [2] }]), CATALOG)).toEqual([]);
    expect(possibleStudiesFromAnalysis(analysisWith([{ uncertainty: ["IDENTITY", "POLICY"], candidates: [2] }]), CATALOG)).toEqual([]);
  });
  it("si algo invalida TODA la lectura, o la línea tiene demasiados candidatos, no se ofrece nada", () => {
    expect(possibleStudiesFromAnalysis(analysisWith([{ uncertainty: ["IDENTITY"], candidates: [2] }], { recipeStops: ["not_a_request"] }), CATALOG)).toEqual([]);
    expect(possibleStudiesFromAnalysis(analysisWith([{ uncertainty: ["IDENTITY"], candidates: [1, 2, 3, 4, 5] }]), CATALOG)).toEqual([]);
  });
  it("las disputas y zonas que no se ven no son estudios posibles", () => {
    expect(possibleStudiesFromAnalysis(analysisWith([{ kind: "UNSEEN_REGION", uncertainty: ["READING"], candidates: [2] }]), CATALOG)).toEqual([]);
  });
});

describe("formato de los posibles", () => {
  it("numerados, con precio, y diciendo que NO están en el total", () => {
    const block = formatDoubtfulOptions([CATALOG[1]!, CATALOG[2]!], true)!;
    expect(block).toMatch(/Posiblemente también/);
    expect(block).toMatch(/no están sumados en el total/);
    expect(block).toMatch(/^1\. .*FOSFORO \(P\) — Bs 50$/m);
    expect(block).toMatch(/^2\. .*FOSFATURIA DE 24 HORAS — Bs 90$/m);
    expect(block).not.toMatch(/Total de/);
  });
  it("un nombre larguísimo se acorta; sin estudios válidos no hay bloque", () => {
    const long = study(9, `PANEL ${"PATOGENO ".repeat(30)}`, 1250);
    expect(formatDoubtfulOptions([long], false)!).toMatch(/… — Bs 1250/);
    expect(formatDoubtfulOptions([CATALOG[3]!, CATALOG[4]!], true)).toBeUndefined();
  });
});
