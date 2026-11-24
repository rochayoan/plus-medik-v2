import { describe, expect, it } from "vitest";
import { assembleAnalysis, type DocumentGate } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import { possibleStudiesFromAnalysis } from "../src/quote-options.js";
import { decideFromReading } from "../src/study-choice.js";
import type { CatalogStudy } from "../src/types.js";

// Fotos de recetas (24-nov): las reglas del laboratorio que decide la cotización por texto (la más barata sin método, TOTAL por defecto, IgG + IgM, elecciones fijas y grupos)
// deciden también cuando el estudio se LEYÓ con certeza en la receta y el catálogo tiene varias versiones. Lo demás (lectura dudosa, pasadas que no coinciden, estudios distintos) sigue en duda.

const study = (id: string, name: string, priceBs: number, turnaroundText: string | null = "En el día"): CatalogStudy => ({
  id,
  code: null,
  name,
  normalizedName: name.toLowerCase(),
  normalizedAliases: [],
  priceBs,
  active: true,
  turnaroundText
});

const catalog: CatalogStudy[] = [
  study("tsh-eclia", "TSH (ECLIA)", 90),
  study("tsh-fia", "TSH (FIA Fluorescencia)", 70),
  study("t4-total", "T4 TOTAL (ECLIA)", 60),
  study("t4-libre", "T4 LIBRE (ECLIA)", 70),
  study("toxo-igg", "TOXOPLASMA IgG (Elisa)", 80),
  study("toxo-igm", "TOXOPLASMA IgM (Elisa)", 85),
  study("chagas-hai", "HAI CHAGAS", 60),
  study("chagas-elisa", "CHAGAS IgG (Elisa)", 90),
  study("tp", "TIEMPO DE PROTROMBINA + INR", 50),
  study("aptt", "TIEMPO PARCIAL DE TROMBOPLASTINA (APTT)", 50),
  study("fib", "FIBRINOGENO", 60),
  study("hbsag", "HEPATITIS B ANTIGENO DE SUPERFICIE (HBsAg)", 100),
  study("hbcore", "HEPATITIS B ANTICORE TOTAL", 120),
  study("pcr-cuali", "PROTEINA C REACTIVA (PCR CUALITATIVO)", 40),
  study("pcr-cuanti", "PROTEINA C REACTIVA (PCR CUANTITATIVO)", 70),
  study("hcg-cuali", "HCG SUB UNIDAD BETA-CUALITATIVA (HCG)", 50),
  study("hcg-cuanti", "HCG SUB UNIDAD BETA-CUANTITATIVA (ECLIA)", 120),
  study("lipasa", "LIPASA", 80),
  study("urico", "ACIDO URICO", 30),
  study("urico-orina", "ACIDO URICO EN ORINA 24 HORAS URICOSURIA", 45)
];

const visual = (literalText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "circle", confidence });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const PRINTED: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };

const ambiguous = (...studyIds: string[]): Outcome => ({ kind: "AMBIGUOUS", studyIds, reason: "el texto no especifica la variante" });
const noMatch: Outcome = { kind: "NO_MATCH", reason: "no hay un estudio con ese nombre" };
const shadow = (literalText: string, outcome: Outcome, agreement = true): FinalShadow => ({
  literalText,
  outcome,
  agreement,
  passes: [outcome, outcome],
  modelNotes: { reading: "lectura", confidence: "high", reason: "", rawStatuses: ([outcome.kind, outcome.kind] as unknown as FinalShadow["modelNotes"]["rawStatuses"]) }
});
const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: catalog.length });

// Las banderas de producción (api/kapso/webhook.ts): semántico principal + AUTO semántico + AUTO parcial.
function recipe(studies: SimpleStudy[], results: FinalShadow[], document: DocumentGate = PRINTED) {
  const reading: SimpleReading = { requestedStudies: studies, uncertainStudies: [], notes: "" };
  return assembleAnalysis({
    consensus: buildSimpleConsensus(reading, reading),
    judgement: noJudgement,
    catalog,
    document,
    primary: { batch: batchOf(...results) },
    semanticAuto: true,
    partialAuto: true,
    handwrittenAllowed: true
  });
}
const quotedIds = (result: ReturnType<typeof recipe>) => (result.internal?.quoted?.lines ?? []).map((line) => line.id).sort();

describe("reglas del laboratorio en las fotos de recetas", () => {
  it("«TSH» sin método (dos versiones): se cotiza la más barata, como en el texto", () => {
    const result = recipe([visual("TSH")], [shadow("TSH", ambiguous("tsh-eclia", "tsh-fia"))]);
    expect(result.matches[0]!.semanticPrimary).toMatchObject({ contrast: "LAB_RULE", studyIds: ["tsh-fia"] });
    expect(quotedIds(result)).toEqual(["tsh-fia"]);
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["TSH (FIA Fluorescencia)"]);
    expect(result.internal?.quoted?.lines[0]).toMatchObject({ basis: ["LAB_RULE"] });
  });

  it("«T4» sin decir total ni libre: el TOTAL directo", () => {
    const result = recipe([visual("T4")], [shadow("T4", ambiguous("t4-total", "t4-libre"))]);
    expect(quotedIds(result)).toEqual(["t4-total"]);
  });

  it("«T4 libre» escrito en la receta: el LIBRE", () => {
    const result = recipe([visual("T4 LIBRE")], [shadow("T4 LIBRE", ambiguous("t4-total", "t4-libre"))]);
    expect(quotedIds(result)).toEqual(["t4-libre"]);
  });

  it("«Toxoplasma» sin clase: IgG + IgM", () => {
    const result = recipe([visual("TOXOPLASMA")], [shadow("TOXOPLASMA", ambiguous("toxo-igg", "toxo-igm"))]);
    expect(quotedIds(result)).toEqual(["toxo-igg", "toxo-igm"]);
  });

  it("«PCR» sin cuantificación: la más barata (cualitativa)", () => {
    const result = recipe([visual("PROTEINA C REACTIVA")], [shadow("PROTEINA C REACTIVA", ambiguous("pcr-cuali", "pcr-cuanti"))]);
    expect(quotedIds(result)).toEqual(["pcr-cuali"]);
  });

  it("«Chagas»: la elección fija del laboratorio (HAI)", () => {
    const result = recipe([visual("CHAGAS")], [shadow("CHAGAS", ambiguous("chagas-hai", "chagas-elisa"))]);
    expect(quotedIds(result)).toEqual(["chagas-hai"]);
  });

  it("«Coagulograma» (no hay un estudio con ese nombre): TP + INR, APTT y fibrinógeno", () => {
    const result = recipe([visual("COAGULOGRAMA")], [shadow("COAGULOGRAMA", noMatch)]);
    expect(quotedIds(result)).toEqual(["aptt", "fib", "tp"]);
    expect(result.publicQuote?.totalBs).toBe(160);
  });

  it("«Ácido úrico» entre sangre y orina de 24 horas: el de SANGRE (muestra por defecto); si la receta dice orina, no se elige", () => {
    const blood = recipe([visual("ACIDO URICO")], [shadow("ACIDO URICO", ambiguous("urico", "urico-orina"))]);
    expect(quotedIds(blood)).toEqual(["urico"]);
    const urine = recipe([visual("ACIDO URICO EN ORINA")], [shadow("ACIDO URICO EN ORINA", ambiguous("urico", "urico-orina"))]);
    expect(urine.matches[0]!.semanticPrimary?.contrast).not.toBe("LAB_RULE");
    // El documento declara la muestra (orina): manda sobre la regla, aunque la línea solo diga «ácido úrico».
    const declared = recipe([visual("ACIDO URICO")], [shadow("ACIDO URICO", ambiguous("urico", "urico-orina"))], { ...PRINTED, context: { lines: ["MUESTRA: ORINA DE 24 HORAS"], muestra: "orina", conflicts: [] } });
    expect(quotedIds(declared)).toEqual([]);
  });

  it("varias líneas: cada una con su regla, todo en una cotización", () => {
    const result = recipe(
      [visual("TSH"), visual("T4"), visual("CHAGAS")],
      [shadow("TSH", ambiguous("tsh-eclia", "tsh-fia")), shadow("T4", ambiguous("t4-total", "t4-libre")), shadow("CHAGAS", ambiguous("chagas-hai", "chagas-elisa"))]
    );
    expect(quotedIds(result)).toEqual(["chagas-hai", "t4-total", "tsh-fia"]);
    expect(result.publicQuote?.totalBs).toBe(190);
  });
});

describe("lo que la regla NO decide (sigue en duda con opciones, como antes)", () => {
  it("estudios DISTINTOS (hepatitis B antígeno vs. anticore): no elige", () => {
    const result = recipe([visual("HEPATITIS B")], [shadow("HEPATITIS B", ambiguous("hbsag", "hbcore"))]);
    expect(result.matches[0]!.semanticPrimary?.contrast).toBe("NO_SEMANTIC_MATCH");
    expect(quotedIds(result)).toEqual([]);
    expect(result.internal?.pending.map((item) => item.candidates?.map((c) => c.id).sort())).toEqual([["hbcore", "hbsag"]]);
  });

  it("el modelo duda entre versiones Y otro estudio (TSH ECLIA/FIA y T4): no elige", () => {
    const result = recipe([visual("TSH")], [shadow("TSH", ambiguous("tsh-eclia", "tsh-fia", "t4-total"))]);
    expect(result.matches[0]!.semanticPrimary?.contrast).toBe("NO_SEMANTIC_MATCH");
    expect(quotedIds(result)).toEqual([]);
  });

  it("las dos pasadas del modelo no coinciden: no elige", () => {
    const result = recipe([visual("TSH")], [shadow("TSH", ambiguous("tsh-eclia", "tsh-fia"), false)]);
    expect(result.matches[0]!.semanticPrimary?.contrast).not.toBe("LAB_RULE");
    expect(quotedIds(result)).toEqual([]);
  });

  it("lectura dudosa de la receta: no se cotiza nada, queda pendiente (la regla no salta los bloqueos de lectura)", () => {
    const result = recipe([visual("TSH", "medium")], [shadow("TSH", ambiguous("tsh-eclia", "tsh-fia"))]);
    expect(quotedIds(result)).toEqual([]);
    expect(result.internal?.pending.length).toBeGreaterThan(0);
  });

  it("un nombre que no es grupo ni tiene versiones: sigue sin estudio", () => {
    const result = recipe([visual("ESTUDIO RARO")], [shadow("ESTUDIO RARO", noMatch)]);
    expect(quotedIds(result)).toEqual([]);
  });
});

describe("erratas en la receta: se OFRECEN como opción, nunca se cobran", () => {
  it("«HGC» (sin estudio con ese nombre): la HCG cualitativa del laboratorio como opción", () => {
    const result = recipe([visual("HGC")], [shadow("HGC", noMatch)]);
    expect(quotedIds(result)).toEqual([]);
    expect(result.matches[0]!.semanticPrimary).toMatchObject({ contrast: "NO_SEMANTIC_MATCH", studyIds: ["hcg-cuali"] });
    expect(possibleStudiesFromAnalysis(result, catalog).map((s) => s.id)).toEqual(["hcg-cuali"]);
  });

  it("«LIPSAA»: LIPASA como opción", () => {
    const result = recipe([visual("LIPSAA")], [shadow("LIPSAA", noMatch)]);
    expect(quotedIds(result)).toEqual([]);
    expect(possibleStudiesFromAnalysis(result, catalog).map((s) => s.id)).toEqual(["lipasa"]);
  });
});

describe("decideFromReading (la misma decisión que el texto)", () => {
  it("solo versiones del estudio que el modelo vio plausible", () => {
    expect(decideFromReading("TSH", ["tsh-eclia", "tsh-fia"], catalog)).toMatchObject({ rule: "VERSION", studies: [{ id: "tsh-fia" }] });
    expect(decideFromReading("HEPATITIS B", ["hbsag", "hbcore"], catalog)).toBeUndefined();
    expect(decideFromReading("TSH", ["tsh-eclia"], catalog)).toBeUndefined();
  });

  it("grupos: con todos sus estudios en el catálogo; si falta uno, no", () => {
    expect(decideFromReading("Coagulograma", [], catalog)).toMatchObject({ rule: "LAB_GROUP" });
    expect(decideFromReading("Coagulograma", [], catalog.filter((s) => s.id !== "fib"))).toBeUndefined();
  });
});
