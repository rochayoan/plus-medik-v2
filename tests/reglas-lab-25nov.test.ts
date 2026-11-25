import { describe, expect, it } from "vitest";
import { quoteStudiesTool } from "../src/agent/tools.js";
import { assembleAnalysis, type DocumentGate } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import { formatDoubtfulOptions, possibleStudiesFromAnalysis } from "../src/quote-options.js";
import { decideFromReading } from "../src/study-choice.js";
import type { CatalogStudy } from "../src/types.js";

// Respuestas del dueño del 25-nov, con la regla principal «sin especificar = la más barata». Nombres y precios tal como están en el catálogo real. Valen igual para el texto y para la foto
// de la receta (study-choice.ts):
//   · anticore sin clase → TOTAL; vitamina D → 25 (OH) FIA; colesterol → total; micológico → directo; panel respiratorio → 20 patógenos; galactomanano → antígeno ELISA;
//   · el MISMO examen con otro nombre (urea = BUN; ANA, giardia, anti-CCP): el más barato; la carga viral solo si se nombra; la línea que ES un nombre del catálogo → ese;
//   · cultivo de secreción, microalbuminuria y biopsia: se le pide el dato al paciente (zona, 24 h u ocasional, tamaño de la muestra).

let n = 0;
const study = (name: string, priceBs: number, aliases: string[] = []): CatalogStudy =>
  ({ id: `s${++n}`, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null, turnaroundText: "En el día", preparationText: null }) as unknown as CatalogStudy;

const CATALOG = [
  study("HEPATITIS B ANTICORE TOTAL", 150),
  study("HEPATITIS B ANTICORE IgG", 200, ["anti hbc igg"]),
  study("HEPATITIS B ANTICORE IgM", 200),
  study("HEPATITIS B ANTIGENO DE SUP. (ECLIA)", 140),
  study("VITAMINA D 25 (OH) (ECLIA)", 200),
  study("VITAMINA D 25 (OH) (FIA Fluorescencia)", 160),
  study("VITAMINA D 1,25 Dihidroxi Calcifidol", 350),
  study("VITAMINA D3 (Colecalciferol)", 350),
  study("COLESTEROL TOTAL", 35),
  study("COLESTEROL HDL", 35),
  study("COLESTEROL LDL", 30),
  study("MICOLÓGICO DIRECTO - MICROSCOPIA KOH 10 %", 50),
  study("CULTIVO MICOLOGICO - CONVENCIONAL", 90),
  study("PANEL RESPIRATORIO MIXTO qPCR (20 PATOGENOS) VIRUS: Sincitial A/B, Influenza B, Influenza A, SARS-CoV-2, Adenovirus humano, Rinovirus Humano, Coronavirus humano 229E/OC43, Coronavirus humano NL63/HKU1, Parainfluenza Humana 1/2, Parainfluenza humana 3/4, Bocavirus, Metapneumovirus, Enterovirus. BACTERIAS: Streptococcus pyogenes, Haemophilus influenzae, Bordetella pertussis, Streptococcus neumoniae, Mycoplasma pneumoniae, Legionella pneumophila.", 800, ["panel respiratorio"]),
  study("PANEL RESPIRATORIO MIXTO qPCR (30 PATOGENOS) VIRUS: Influenza A, Influenza B", 1200, ["panel respiratorio"]),
  study("GALACTOMANANO Antigeno (ASPERGILOSIS) CUANTITATIVO (Elisa)", 400),
  study("GALACTOMANANO antigeno (ASPERGILOSIS) Inmunocromatografia", 430),
  study("GALACTOMANANO IgG", 600),
  study("UREA", 30),
  study("BUN DE UREA", 30),
  study("ANA (ANTICUERPOS ANTINUCLEARES) Elisa", 170),
  study("ANA / FAN HEP2 IFI", 200),
  study("CITOMEGALOVIRUS IgG", 130),
  study("CITOMEGALOVIRUS IgM", 130),
  study("DETECCION CUANTITATIVA (CARGA VIRAL) CITOMEGALOVIRUS (CMV)", 600),
  study("GLUCOSA", 30),
  study("GLUCOSA POSTPANDRIAL", 30),
  study("GLUCOSA POSTCARGA (2H)", 40),
  study("AMONIO", 200),
  study("AMONIACO", 270),
  study("SODIO", 60),
  study("SODIO EN ORINA OCACIONAL O 24 HORAS", 80),
  ...["FARINGEA", "NASAL", "URETRAL", "VAGINAL"].map((zone) => study(`CULTIVO DE SECRECION ${zone} - CONVENCIONAL`, 90)),
  ...["BRONQUIAL", "OCULAR"].map((zone) => study(`CULTIVO DE SECRECIÓN ${zone} - CONVENCIONAL`, 90)),
  study("MICROALBUMINURIA 24 HORAS (FIA Inmunofluorescencia)", 150),
  study("MICROALBUMINURIA OCASIONAL (FIA Inmunofluorescencia)", 150),
  study("BIOPSIAS PEQUEÑAS (ENDOSCOPICAS O PUNCION)", 500),
  study("MUESTRA PEQUEÑA (1 FRASCO 100 ML)", 500),
  study("MUESTRA MEDIANA (1 FRASCO 500 ML)", 550),
  study("MUESTRA GRANDE (1 FRASCO 1000 ML)", 650),
  study("MUESTRA FRASCO (1 LITRO A 5 LITROS)", 700),
  study("MUESTRA FRASCO (MAYOR A 5 LITROS)", 950)
];
const byName = (name: string) => CATALOG.find((item) => item.name === name)!;
const idsOf = (...names: string[]) => names.map((name) => byName(name).id);

type Result = { facts?: Array<{ text: string; refs: string[] }>; blocks?: string[] };
const tool = quoteStudiesTool({ loadCatalog: async () => CATALOG });
const quote = async (text: string) => (await tool.run({ studies: [text] }, { now: new Date(), patientText: text } as never)) as Result;
const quoted = async (text: string) => {
  const refs = (await quote(text)).facts?.find((fact) => fact.text.startsWith("Estudios identificados"))?.refs ?? [];
  return refs.map((ref) => CATALOG.find((item) => `study:${item.id}` === ref)!.name).sort();
};

describe("texto: respuestas del dueño (25-nov)", () => {
  it.each([
    ["hepatitis b anticore", ["HEPATITIS B ANTICORE TOTAL"]],
    ["anticore", ["HEPATITIS B ANTICORE TOTAL"]],
    // Antes salía solo la IgG (por el alias «anti hbc igg»).
    ["anti hbc", ["HEPATITIS B ANTICORE TOTAL"]],
    ["anticore igm", ["HEPATITIS B ANTICORE IgM"]],
    ["vitamina d", ["VITAMINA D 25 (OH) (FIA Fluorescencia)"]],
    ["colesterol", ["COLESTEROL TOTAL"]],
    ["micologico", ["MICOLÓGICO DIRECTO - MICROSCOPIA KOH 10 %"]],
    ["cultivo micologico", ["CULTIVO MICOLOGICO - CONVENCIONAL"]],
    ["panel respiratorio", [byName("PANEL RESPIRATORIO MIXTO qPCR (20 PATOGENOS) VIRUS: Sincitial A/B, Influenza B, Influenza A, SARS-CoV-2, Adenovirus humano, Rinovirus Humano, Coronavirus humano 229E/OC43, Coronavirus humano NL63/HKU1, Parainfluenza Humana 1/2, Parainfluenza humana 3/4, Bocavirus, Metapneumovirus, Enterovirus. BACTERIAS: Streptococcus pyogenes, Haemophilus influenzae, Bordetella pertussis, Streptococcus neumoniae, Mycoplasma pneumoniae, Legionella pneumophila.").name]],
    // Antes salía el IgG de Bs 600.
    ["galactomanano", ["GALACTOMANANO Antigeno (ASPERGILOSIS) CUANTITATIVO (Elisa)"]],
    ["citomegalovirus", ["CITOMEGALOVIRUS IgG", "CITOMEGALOVIRUS IgM"]]
  ])("«%s» → %j", async (text, expected) => {
    expect(await quoted(text)).toEqual(expected);
  });

  it("cultivo de secreción sin zona: las 6 opciones con su precio y se le pide la zona (todas cuestan Bs 90); no se cotiza ninguna", async () => {
    const result = await quote("cultivo de secrecion");
    expect(result.facts?.some((fact) => fact.text.startsWith("Estudios identificados"))).toBe(false);
    const blocks = result.blocks!.join("\n");
    expect(blocks.match(/CULTIVO DE SECRECI/g)).toHaveLength(6);
    expect(result.facts?.some((fact) => fact.text.includes("de qué zona es la muestra") && fact.text.includes("Todas cuestan Bs 90"))).toBe(true);
  });

  it("microalbuminuria sin decir cuál: las dos opciones y se le pide que indique (las dos cuestan Bs 150)", async () => {
    const result = await quote("microalbuminuria");
    expect(result.blocks!.join("\n").match(/MICROALBUMINURIA/g)).toHaveLength(2);
    expect(result.facts?.some((fact) => fact.text.includes("24 horas u ocasional") && fact.text.includes("las dos cuestan Bs 150"))).toBe(true);
  });

  it("biopsia: NO se listan los tamaños; desde Bs 500 según la muestra, se le pide el dato y la doctora confirma el precio", async () => {
    const result = await quote("biopsia");
    expect((result.blocks ?? []).join("\n")).not.toMatch(/MUESTRA|BIOPSIAS/);
    const ask = result.facts?.find((fact) => fact.text.includes("biopsia"))?.text ?? "";
    expect(ask).toContain("desde Bs 500");
    expect(ask).toContain("la doctora te confirma el precio");
  });

  it("lo que se pidió con nombre completo no se toca: «cultivo de secreción vaginal», «microalbuminuria 24 horas»", async () => {
    expect(await quoted("cultivo de secrecion vaginal")).toEqual(["CULTIVO DE SECRECION VAGINAL - CONVENCIONAL"]);
    expect(await quoted("microalbuminuria 24 horas")).toEqual(["MICROALBUMINURIA 24 HORAS (FIA Inmunofluorescencia)"]);
  });
});

describe("foto de receta: la misma decisión sobre la duda del modelo", () => {
  it("el MISMO examen con otro nombre: urea/BUN → UREA; ANA → la ELISA (más barata) salvo que diga IFI/HEp-2", () => {
    expect(decideFromReading("NITROGENO UREICO/UREA/NUS", idsOf("BUN DE UREA", "UREA"), CATALOG)).toMatchObject({ rule: "SAME_EXAM", studies: [{ name: "UREA" }] });
    expect(decideFromReading("ANA", idsOf("ANA / FAN HEP2 IFI", "ANA (ANTICUERPOS ANTINUCLEARES) Elisa"), CATALOG)?.studies.map((s) => s.name)).toEqual(["ANA (ANTICUERPOS ANTINUCLEARES) Elisa"]);
    expect(decideFromReading("ANA HEP2", idsOf("ANA / FAN HEP2 IFI", "ANA (ANTICUERPOS ANTINUCLEARES) Elisa"), CATALOG)?.studies.map((s) => s.name)).toEqual(["ANA / FAN HEP2 IFI"]);
  });

  it("la carga viral solo si la receta la nombra: «CMV» → IgG + IgM; «CMV carga viral» no elige", () => {
    const options = idsOf("CITOMEGALOVIRUS IgG", "CITOMEGALOVIRUS IgM", "DETECCION CUANTITATIVA (CARGA VIRAL) CITOMEGALOVIRUS (CMV)");
    expect(decideFromReading("CITOMEGALOVIRUS", options, CATALOG)?.studies.map((s) => s.name).sort()).toEqual(["CITOMEGALOVIRUS IgG", "CITOMEGALOVIRUS IgM"]);
    // Si el modelo solo ofreció la IgG y la carga viral, igual se cotizan las dos clases (sus hermanas del catálogo).
    expect(decideFromReading("CITOMEGALOVIRUS", idsOf("CITOMEGALOVIRUS IgG", "DETECCION CUANTITATIVA (CARGA VIRAL) CITOMEGALOVIRUS (CMV)"), CATALOG)?.studies.map((s) => s.name).sort()).toEqual(["CITOMEGALOVIRUS IgG", "CITOMEGALOVIRUS IgM"]);
    expect(decideFromReading("CMV CARGA VIRAL", options, CATALOG)).toBeUndefined();
  });

  it("la línea ES el nombre de una opción: «GLUCOSA» → GLUCOSA; «AMONIO» → AMONIO (el amoniaco es otro estudio)", () => {
    expect(decideFromReading("GLUCOSA", idsOf("GLUCOSA", "GLUCOSA POSTPANDRIAL", "GLUCOSA POSTCARGA (2H)"), CATALOG)).toMatchObject({ rule: "EXACT_NAME", studies: [{ name: "GLUCOSA" }] });
    expect(decideFromReading("Amonio", idsOf("AMONIO", "AMONIACO"), CATALOG)?.studies.map((s) => s.name)).toEqual(["AMONIO"]);
  });

  it("…salvo que el documento declare otra muestra: «SODIO» con «MUESTRA: ORINA» no elige el de sangre", () => {
    expect(decideFromReading("SODIO", idsOf("SODIO", "SODIO EN ORINA OCACIONAL O 24 HORAS"), CATALOG, { bloodDefault: false })).toBeUndefined();
  });

  it("estudios distintos siguen en duda (lo especifica el médico): hepatitis B anticore o antígeno de superficie", () => {
    expect(decideFromReading("HEPATITIS B", idsOf("HEPATITIS B ANTICORE TOTAL", "HEPATITIS B ANTIGENO DE SUP. (ECLIA)"), CATALOG)).toBeUndefined();
    expect(decideFromReading("HEPATITIS B ANTICORE", idsOf("HEPATITIS B ANTICORE IgG", "HEPATITIS B ANTICORE IgM", "HEPATITIS B ANTICORE TOTAL"), CATALOG)?.studies.map((s) => s.name)).toEqual(["HEPATITIS B ANTICORE TOTAL"]);
  });
});

describe("foto de receta: se le pide el dato al paciente", () => {
  const PRINTED: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };
  const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
  const visual = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "circle", confidence: "high" });
  const shadow = (literalText: string, outcome: Outcome): FinalShadow => ({ literalText, outcome, agreement: true, passes: [outcome, outcome], modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ([outcome.kind, outcome.kind] as unknown as FinalShadow["modelNotes"]["rawStatuses"]) } });
  const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: CATALOG.length });
  const recipe = (lines: Array<[string, Outcome]>) => {
    const reading: SimpleReading = { requestedStudies: lines.map(([text]) => visual(text)), uncertainStudies: [], notes: "" };
    return assembleAnalysis({ consensus: buildSimpleConsensus(reading, reading), judgement: noJudgement, catalog: CATALOG, document: PRINTED, primary: { batch: batchOf(...lines.map(([text, outcome]) => shadow(text, outcome))) }, semanticAuto: true, partialAuto: true, handwrittenAllowed: true });
  };
  const ambiguous = (...names: string[]): Outcome => ({ kind: "AMBIGUOUS", studyIds: idsOf(...names), reason: "no dice cuál" });

  it("«CULTIVO DE SECRECION» (el modelo dudó entre 4 zonas): se cotiza lo demás y debajo van las 6 zonas con su precio y la pregunta", () => {
    const result = recipe([["GLUCOSA", { kind: "MATCH", studyId: byName("GLUCOSA").id, support: "EXACT", notes: [] }], ["CULTIVO DE SECRECION", ambiguous(...["FARINGEA", "NASAL", "URETRAL", "VAGINAL"].map((zone) => `CULTIVO DE SECRECION ${zone} - CONVENCIONAL`))]]);
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
    const possible = possibleStudiesFromAnalysis(result, CATALOG);
    expect(possible).toHaveLength(6);
    const message = formatDoubtfulOptions(possible, true, CATALOG)!;
    expect(message.match(/CULTIVO DE SECRECI/g)).toHaveLength(6);
    expect(message).toContain("de qué zona es la muestra");
    expect(message).toContain("Todas cuestan Bs 90");
  });

  it("«MICROALBUMINURIA»: las dos opciones y la pregunta (las dos cuestan Bs 150)", () => {
    const result = recipe([["MICROALBUMINURIA", ambiguous("MICROALBUMINURIA 24 HORAS (FIA Inmunofluorescencia)", "MICROALBUMINURIA OCASIONAL (FIA Inmunofluorescencia)")]]);
    const message = formatDoubtfulOptions(possibleStudiesFromAnalysis(result, CATALOG), false, CATALOG)!;
    expect(message.match(/MICROALBUMINURIA \d|MICROALBUMINURIA OCASIONAL/g)).toHaveLength(2);
    expect(message).toContain("las dos cuestan Bs 150");
  });

  it("«BIOPSIA»: sin lista de tamaños; desde Bs 500, se le pide el dato y la doctora confirma el precio", () => {
    const result = recipe([["BIOPSIA", { kind: "NO_MATCH", reason: "no dice el tamaño" }]]);
    const message = formatDoubtfulOptions(possibleStudiesFromAnalysis(result, CATALOG), false, CATALOG)!;
    expect(message).not.toMatch(/MUESTRA|BIOPSIAS PEQUE/);
    expect(message).toContain("desde Bs 500");
    expect(message).toContain("la doctora te confirma el precio");
  });
});

describe("herpes y hepatitis B (dueño, 25-nov)", () => {
  const extra = [
    study("HERPES tipo 1 y 2 IgG (Elisa)", 150),
    study("HERPES tipo 1 y 2 IgM (Elisa)", 150),
    study("HERPES tipo 2 IgG (Elisa)", 130),
    study("HERPES ZOSTER IgG", 155),
    study("HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)", 70),
    study("HEPATITIS B ANTICUERPO DE SUP. PRUEBA RAPIDA", 60),
    study("HEPATITIS B ANTICUERPO DE SUP. (ELISA)", 200)
  ];
  const all = [...CATALOG, ...extra];
  const tool2 = quoteStudiesTool({ loadCatalog: async () => all });
  const names = async (text: string) => {
    const refs = ((await tool2.run({ studies: [text] }, { now: new Date(), patientText: text } as never)) as Result).facts?.find((fact) => fact.text.startsWith("Estudios identificados"))?.refs ?? [];
    return refs.map((ref) => all.find((item) => `study:${item.id}` === ref)!.name).sort();
  };
  it.each([
    ["herpes", ["HERPES tipo 1 y 2 IgG (Elisa)", "HERPES tipo 1 y 2 IgM (Elisa)"]],
    ["herpes igg", ["HERPES tipo 1 y 2 IgG (Elisa)"]],
    ["herpes tipo 2 igg", ["HERPES tipo 2 IgG (Elisa)"]],
    ["herpes zoster igg", ["HERPES ZOSTER IgG"]],
    ["antigeno de superficie", ["HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)"]],
    ["hbsag", ["HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)"]],
    ["hbsag eclia", ["HEPATITIS B ANTIGENO DE SUP. (ECLIA)"]],
    ["anti hbs", ["HEPATITIS B ANTICUERPO DE SUP. PRUEBA RAPIDA"]]
  ])("«%s» → %j", async (text, expected) => {
    expect(await names(text)).toEqual(expected);
  });

  it("foto: «HERPES IgG» con zóster, tipo 2 y tipo 1 y 2 entre las opciones → tipo 1 y 2", () => {
    const options = ["HERPES ZOSTER IgG", "HERPES tipo 2 IgG (Elisa)", "HERPES tipo 1 y 2 IgG (Elisa)"].map((name) => all.find((item) => item.name === name)!.id);
    expect(decideFromReading("HERPES IgG", options, all)?.studies.map((s) => s.name)).toEqual(["HERPES tipo 1 y 2 IgG (Elisa)"]);
  });
});
