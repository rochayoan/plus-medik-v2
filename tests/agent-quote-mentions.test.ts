import { describe, expect, it } from "vitest";
import { quoteStudiesTool } from "../src/agent/tools.js";
import type { ToolContext } from "../src/agent/contracts.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

// Pedidos de cotización REALES (4–12 nov) y sus variantes, contra un catálogo con los nombres del catálogo real (incluidas las trampas: Coombs DIRECTO, vitamina C, Clamidia PNEUMONIAE, el PERFIL
// andropausia, los paneles). Lo seguro se cotiza; lo dudoso va como opción; nunca se cotiza algo que el paciente no pidió.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, priceBs: number): CatalogStudy =>
  ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs, active: true, category: null, sampleType: null }) as unknown as CatalogStudy;
const CATALOG = [
  study(1, "HEMOGRAMA COMPLETO AUTOMATIZADO", 45), study(2, "TESTOSTERONA TOTAL (ECLIA)", 120), study(3, "TESTOSTERONA LIBRE", 140), study(4, "PERFIL ANDROPAUSIA (Testosterona Total, Testosterona Libre y SHBG)", 330),
  study(5, "ESTRADIOL (ECLIA)", 90), study(6, "PSA TOTAL (ECLIA)", 90), study(7, "PSA TOTAL (FIA Fluorescencia)", 120), study(8, "PSA LIBRE (ECLIA)", 90), study(9, "CLAMIDIA IgG", 140), study(10, "CLAMIDIA IgM", 140),
  study(11, "Clamidia pneumoniae IgG - IgM", 350), study(12, "ZINC", 220), study(13, "BILIRRUBINA TOTAL Y FRACCIONES", 60), study(14, "COOMBS DIRECTO", 70), study(15, "HEPATITIS A (PRUEBA RAPIDA)", 90),
  study(16, "HEPATITIS C (PRUEBA RAPIDA)", 90), study(17, "VITAMINA C", 150), study(18, "TOXO IgG (ELISA)", 120), study(19, "TOXO IgM (ELISA)", 120), study(20, "HERPES tipo 1 y 2 IgG (Elisa)", 180),
  study(21, "HERPES tipo 1 y 2 IgM (Elisa)", 180), study(22, "GLUCOSA", 30), study(23, "TSH (ECLIA)", 90), study(24, "T4 LIBRE (ECLIA)", 90), study(25, "COLESTEROL TOTAL", 30), study(26, "COLESTEROL HDL", 35),
  study(27, "COLESTEROL LDL", 35), study(28, "PANEL MULTIDROGAS (5 DROGAS) COCAINA, BARBITURICOS, BENZODIACEPINA, KETAMINA, MARIHUANA", 300), study(29, "RUBEOLA IgG", 110), study(30, "RUBEOLA IgM", 110),
  study(31, "VITAMINA D 25 (OH) (ECLIA)", 180), study(32, "VITAMINA B12 (ECLIA)", 150)
];
const ctx = {} as ToolContext;
const quote = quoteStudiesTool({ loadCatalog: async () => CATALOG });
type Result = { facts?: Array<{ text: string; source: string }>; blocks?: string[] };
const sureOf = (result: Result): string[] => {
  const fact = result.facts?.find((f) => f.text.startsWith("Estudios identificados con certeza"));
  return fact ? fact.text.replace(/^[^:]*:\s*/, "").split("; ") : [];
};
const everything = (result: Result): string => JSON.stringify(result);
const run = async (...studies: string[]): Promise<Result> => (await quote.run({ studies }, ctx)) as Result;

describe("los pedidos reales que antes fallaban", () => {
  it("«Testosterona Total y Libre» + «Y estradiol»: los tres, y NO el perfil andropausia", async () => {
    const result = await run("Testosterona Total y Libre", "Y estradiol");
    expect(sureOf(result).sort()).toEqual(["ESTRADIOL (ECLIA)", "TESTOSTERONA LIBRE", "TESTOSTERONA TOTAL (ECLIA)"]);
    expect(everything(result)).not.toMatch(/ANDROPAUSIA/);
  });
  it("la lista de 6 líneas: hemograma, PSA total, PSA libre, testosterona, clamidia IgG e IgM (no la pneumoniae)", async () => {
    const result = await run("Hemograma completo\nPsa antigueno prostático específico total\nPsa antigueno prostático libre \nTestosterona \nClamidia igg-igm");
    expect(sureOf(result)).toEqual(expect.arrayContaining(["HEMOGRAMA COMPLETO AUTOMATIZADO", "PSA TOTAL (ECLIA)", "PSA LIBRE (ECLIA)", "CLAMIDIA IgG", "CLAMIDIA IgM"]));
    expect(sureOf(result)).not.toContain("Clamidia pneumoniae IgG - IgM");
  });
  it("«Labo de nivel de zinc»: el zinc", async () => {
    expect(sureOf(await run("Labo de nivel de zinc"))).toEqual(["ZINC"]);
  });
  it("«zinc sérico o plasmático»: un solo zinc", async () => {
    expect(sureOf(await run("zinc serico o plasmatico"))).toEqual(["ZINC"]);
  });
});

describe("variantes que nunca deben cotizar otra cosa", () => {
  it("«bilirrubina total y directa» no es Coombs DIRECTO", async () => {
    const result = await run("bilirrubina total y directa");
    expect(sureOf(result)).toEqual(["BILIRRUBINA TOTAL Y FRACCIONES"]);
    expect(everything(result)).not.toMatch(/COOMBS/);
  });
  it("«hepatitis a, b y c» no es vitamina C", async () => {
    const result = await run("hepatitis a, b y c");
    expect(sureOf(result)).toEqual(expect.arrayContaining(["HEPATITIS A (PRUEBA RAPIDA)", "HEPATITIS C (PRUEBA RAPIDA)"]));
    expect(everything(result)).not.toMatch(/VITAMINA C/);
  });
  it("«toxoplasma igg e igm» y «rubeola igg/igm»: las dos de cada uno", async () => {
    expect(sureOf(await run("toxoplasma igg e igm")).sort()).toEqual(["TOXO IgG (ELISA)", "TOXO IgM (ELISA)"]);
    expect(sureOf(await run("rubeola igg/igm")).sort()).toEqual(["RUBEOLA IgG", "RUBEOLA IgM"]);
  });
  it("«herpes 1 y 2 igg» es UN estudio del catálogo (no se corta)", async () => {
    expect(sureOf(await run("herpes 1 y 2 igg"))).toEqual(["HERPES tipo 1 y 2 IgG (Elisa)"]);
  });
  it("«PSA total»: la total por el método preferido, no la libre", async () => {
    expect(sureOf(await run("PSA total"))).toEqual(["PSA TOTAL (ECLIA)"]);
  });
  it("«colesterol total, hdl y ldl» y «vitamina d y b12»", async () => {
    expect(sureOf(await run("colesterol total, hdl y ldl")).sort()).toEqual(["COLESTEROL HDL", "COLESTEROL LDL", "COLESTEROL TOTAL"]);
    expect(sureOf(await run("vitamina d y b12")).sort()).toEqual(["VITAMINA B12 (ECLIA)", "VITAMINA D 25 (OH) (ECLIA)"]);
  });
  it("«hemograma glucosa» y «tsh t4 libre» separados solo por espacios", async () => {
    expect(sureOf(await run("hemograma glucosa")).sort()).toEqual(["GLUCOSA", "HEMOGRAMA COMPLETO AUTOMATIZADO"]);
  });
  it("un panel que no está en el catálogo no se cambia por otro panel cualquiera", async () => {
    const result = await run("Panel pcr 13 patogenos");
    expect(sureOf(result)).toEqual([]);
    expect(everything(result)).not.toMatch(/MULTIDROGAS/);
  });
  it("el modelo separó por su cuenta («hepatitis b», «c»): la «c» hereda «hepatitis» y la cotización NO falla", async () => {
    const result = await run("hepatitis b", "c", "bilirrubina total y directa");
    expect(sureOf(result)).toEqual(expect.arrayContaining(["HEPATITIS C (PRUEBA RAPIDA)", "BILIRRUBINA TOTAL Y FRACCIONES"]));
    expect(everything(result)).not.toMatch(/VITAMINA C|COOMBS/);
  });
  it("una lista entera en un solo texto largo (más de 120 caracteres) también se cotiza", async () => {
    const result = await run("hemograma completo, testosterona total y libre, estradiol, psa total y libre, clamidia igg e igm, zinc, toxoplasma igg e igm, rubeola igg e igm");
    expect(sureOf(result).length).toBeGreaterThanOrEqual(12);
  });
  it("un nombre del catálogo con comas y «y» (elegido de una lista) llega entero", async () => {
    expect(sureOf(await run("PANEL MULTIDROGAS (5 DROGAS) COCAINA, BARBITURICOS, BENZODIACEPINA, KETAMINA, MARIHUANA"))).toEqual(["PANEL MULTIDROGAS (5 DROGAS) COCAINA, BARBITURICOS, BENZODIACEPINA, KETAMINA, MARIHUANA"]);
    expect(sureOf(await run("PERFIL ANDROPAUSIA (Testosterona Total, Testosterona Libre y SHBG)", "ZINC"))).toEqual(["PERFIL ANDROPAUSIA (Testosterona Total, Testosterona Libre y SHBG)", "ZINC"]);
  });
  it("la charla alrededor no aparece como «no encontrado»", async () => {
    const result = await run("Buenas tardes, quisiera saber si realizan el\nLabo de nivel de zinc y el\nCosto porfa");
    expect(sureOf(result)).toEqual(["ZINC"]);
    expect(everything(result)).not.toMatch(/No se encontró/);
  });
});

describe("una lista separada solo por espacios se corta SOLO si cada palabra nombra un estudio (20-nov)", () => {
  const catalog = [...CATALOG, study(40, "COPROCULTIVO", 90), study(41, "PARASITOLOGICO SERIADO", 60), study(42, "PARASITOLOGICO SIMPLE", 30)];
  const quoteWith = quoteStudiesTool({ loadCatalog: async () => catalog });
  const runWith = async (...studies: string[]): Promise<Result> => (await quoteWith.run({ studies }, ctx)) as Result;
  it("«copro seriado» NUNCA se cotiza como coprocultivo", async () => {
    const result = await runWith("copro seriado");
    expect(sureOf(result)).not.toContain("COPROCULTIVO");
  });
});
