import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/agent/contracts.js";
import { quoteStudiesTool } from "../src/agent/tools.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { formatGroupedOptions } from "../src/quote-options.js";
import type { CatalogStudy } from "../src/types.js";

// Cuando el médico no especifica la versión, el agente elige como la Dra (73 cotizaciones reales del 4 al 20 de noviembre) y como decidió el dueño (20-nov):
// sangre por defecto, IgG + IgM juntas, ECLIA si hay una y si no la de menor tiempo de entrega; si empatan o difieren en otra cosa, pregunta. Nombres y tiempos como en el catálogo real.

let n = 0;
const study = (name: string, priceBs: number, turnaroundText: string, aliases: string[] = []): CatalogStudy =>
  ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null, turnaroundText }) as unknown as CatalogStudy;
// Panel real del catálogo: su lista menciona «VIH», «HIV 1,2» y «Herpes simple 1».
const PANEL_ITS = "PANEL INTIMA PLUS 32 PATOGENOS – INFECCIONES DE TRANSMISION SEXUAL + HPV + VIH 4ta Generacion (Elisa) ITS Patogenos: Virus del Herpes simple 1, Virus del Herpes simple 2, Streptococcus agalactiae, Gardnerella vaginalis, Chlamydia trachomatis, Neisseria gonorrhoeae, Treponema pallidum, Candida albicans HIV 1,2 AG-AC 4ta Generacion (Elisa) HPV 14 Genotipos de Alto Riesgo 16, 18, 31, 33, 35, 39, 45, 51, 52, 56, 58, 59, 66 y 68";
const CATALOG = [
  study("PROTEINA C REACTIVA (PCR CUALITATIVO)", 50, "2 horas"), study("PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO", 60, "2 horas"), study("PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)", 110, "1 hora"),
  study("TSH NEONATAL", 100, "En el día"), study("TSH (FIA Fluorescencia)", 100, "1 hora"), study("TSH (ECLIA)", 90, "En el día"),
  study("ANA (ANTICUERPOS ANTINUCLEARES) Elisa", 170, "En el día"), study("ANA / FAN HEP2 IFI", 200, "2 días"),
  study("CITOMEGALOVIRUS IgG", 130, "En el día"), study("CITOMEGALOVIRUS IgM", 130, "En el día"), study("DETECCION CUANTITATIVA (CARGA VIRAL) CITOMEGALOVIRUS (CMV)", 600, "2 días"),
  study("TOXO IgM (ELISA)", 90, "En el día"), study("INMUNO TOXO IgM", 70, "3 días"), study("TOXO IgG (ELISA)", 90, "En el día"), study("INMUNO TOXO IgG", 70, "3 días"), study("HAI TOXO", 60, "4 horas"), study("HAI CHAGAS", 60, "4 horas", ["HAI Chagas"]),
  study("CHAGAS IgG ELISA", 70, "En el día"), study(PANEL_ITS, 1250, "5 días"), study("WESTERN BLOT HIV", 370, "7 días"),
  study("HERPES ZOSTER IgG", 155, "3 días"), study("HERPES ZOSTER IgM", 155, "3 días"), study("HERPES tipo 2 IgG (Elisa)", 130, "En el día"), study("HERPES tipo 2 IgM (Elisa)", 130, "En el día"),
  study("T4 NEONATAL", 110, "En el día"), study("T4 LIBRE (ECLIA)", 90, "En el día"), study("T4 TOTAL (ECLIA)", 90, "En el día"),
  study("DENGUE IgM ELISA", 185, "3 días"), study("DENGUE IgG ELISA", 185, "3 días"), study("DENGUE DUO ANTICUERPOS Y ANTIGENO", 130, "1 hora"), study("DENGUE TEST RAPIDO IgG E IgM", 70, "1 hora"),
  study("DESHIDROGENASA LACTICA LDH", 80, "2 horas"), study("LDH (Lactato deshidrogenasa) de LIQUIDOS", 80, "2 horas"),
  study("TRANSAMINASA GOT", 40, "2 horas"), study("TRANSAMINASA GPT", 40, "2 horas"), study("COLESTEROL TOTAL", 35, "2 horas"), study("COLESTEROL HDL", 35, "2 horas"), study("COLESTEROL LDL", 30, "2 horas"),
  study("TRIGLICERIDOS", 45, "2 horas"), study("TIEMPO DE PROTROMBINA + INR", 50, "2 horas"), study("TIEMPO PARCIAL DE TROMBOPLASTINA (APTT)", 60, "2 horas"), study("TIEMPO DE COAGULACION", 25, "2 horas"),
  study("TIEMPO DE SANGRIA", 25, "2 horas"), study("HEPATITIS E", 300, "4 días"), study("HEPATITIS A (PRUEBA RAPIDA)", 90, "1 hora"), study("HEPATITIS C (PRUEBA RAPIDA)", 70, "1 hora"),
  study("HEMOGLOBINA", 30, "2 horas"), study("HEMOGLOBINA GLICOSILADA (Hb A1c) (FIA Fluorescencia)", 120, "1 hora"), study("CALCIO SERICO", 30, "2 horas"), study("SODIO", 40, "1 hora"),
  study("IONOGRAMA 2 (sodio, potasio, cloro, calcio ionico)", 220, "1 hora"), study("HIV 1,2 (PRUEBA RAPIDA)", 50, "1 hora", ["VIH", "HIV"]), study("HIV 1,2 AG-AC 4ta GENERACION (Elisa)", 150, "En el día"),
  study("CORTISOL 08:00 (CLIA)", 120, "En el día"), study("CORTISOL 16:00 (CLIA)", 120, "En el día"), study("TEST ADRENAL am y pm", 450, "3 días")
];
const ctx = {} as ToolContext;
const quote = quoteStudiesTool({ loadCatalog: async () => CATALOG });
type Result = { facts?: Array<{ text: string }>; blocks?: string[] };
const run = async (...studies: string[]) => (await quote.run({ studies }, ctx)) as Result;
const sureOf = (result: Result): string[] => {
  const fact = result.facts?.find((f) => f.text.startsWith("Estudios identificados con certeza"));
  return fact ? fact.text.replace(/^[^:]*:\s*/, "").split("; ").sort() : [];
};
const asks = (result: Result) => result.facts?.some((f) => f.text.startsWith("Estudios POSIBLES")) ?? false;

describe("método: ECLIA si hay una; si no, la de menor tiempo de entrega", () => {
  it.each([
    ["pcr", ["PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)"]],
    ["proteina c reactiva", ["PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)"]],
    ["tsh", ["TSH (ECLIA)"]],
    ["ana", ["ANA (ANTICUERPOS ANTINUCLEARES) Elisa"]]
  ])("«%s»", async (text, expected) => {
    expect(sureOf(await run(text))).toEqual(expected);
  });
});

describe("clase de anticuerpo: IgG + IgM juntas, del método más rápido", () => {
  it("«citomegalovirus» → IgG + IgM (no la carga viral)", async () => {
    expect(sureOf(await run("citomegalovirus"))).toEqual(["CITOMEGALOVIRUS IgG", "CITOMEGALOVIRUS IgM"]);
  });
  it("«toxoplasma» → IgG + IgM por ELISA (en el día), no INMUNO (3 días) ni H.A.I.", async () => {
    expect(sureOf(await run("toxoplasma"))).toEqual(["TOXO IgG (ELISA)", "TOXO IgM (ELISA)"]);
  });
});

describe("si no es la misma prueba o empatan, se pregunta (no se elige)", () => {
  it.each(["herpes", "t4", "dengue", "hepatitis"])("«%s»", async (text) => {
    const result = await run(text);
    expect(sureOf(result)).toEqual([]);
    expect(asks(result)).toBe(true);
  });
});

describe("muestra en sangre por defecto", () => {
  it("«ldh» → la de sangre, no la de líquidos", async () => {
    expect(sureOf(await run("ldh"))).toEqual(["DESHIDROGENASA LACTICA LDH"]);
  });
});

describe("nombres de perfil: como los cotiza la Dra", () => {
  it("«transaminasas» y «perfil lipídico» se cotizan con sus estudios", async () => {
    expect(sureOf(await run("transaminasas"))).toEqual(["TRANSAMINASA GOT", "TRANSAMINASA GPT"]);
    expect(sureOf(await run("perfil lipídico"))).toEqual(["COLESTEROL HDL", "COLESTEROL LDL", "COLESTEROL TOTAL", "TRIGLICERIDOS"]);
  });
  it("«coagulograma» (composición aún sin confirmar) se ofrece como opciones, no se cotiza solo", async () => {
    const result = await run("coagulograma");
    expect(sureOf(result)).toEqual([]);
    expect(result.blocks?.join("\n")).toMatch(/TIEMPO DE PROTROMBINA/);
  });
});

describe("errores reales que ya no pasan", () => {
  it("«hemoglobina glicosilad» (cortado) → la glicosilada, no la «HEMOGLOBINA»", async () => {
    expect(sureOf(await run("hemoglobina glicosilad"))).toEqual(["HEMOGLOBINA GLICOSILADA (Hb A1c) (FIA Fluorescencia)"]);
  });
  it("«calcio sodio» → calcio + sodio, no el IONOGRAMA 2", async () => {
    expect(sureOf(await run("calcio sodio"))).toEqual(["CALCIO SERICO", "SODIO"]);
  });
  it("«prueba rápida de vih» → la prueba rápida (Bs 50)", async () => {
    expect(sureOf(await run("prueba rápida de vih"))).toEqual(["HIV 1,2 (PRUEBA RAPIDA)"]);
  });
  it("con el nombre viejo del catálogo («H.I.V 1,2», sin alias) la prueba rápida igual aparece entre las opciones de «vih»", async () => {
    const OLD = CATALOG.map((item) => (item.name === "HIV 1,2 (PRUEBA RAPIDA)" ? ({ ...item, name: "H.I.V 1,2", normalizedName: normalizeStudyKey("H.I.V 1,2"), normalizedAliases: [] } as CatalogStudy) : item));
    const result = (await quoteStudiesTool({ loadCatalog: async () => OLD }).run({ studies: ["vih"] }, ctx)) as Result;
    expect(result.blocks?.join("\n")).toMatch(/H\.I\.V 1,2/);
  });
  it("«cortisol am» → el de las 08:00, no el test adrenal", async () => {
    expect(sureOf(await run("cortisol am"))).toEqual(["CORTISOL 08:00 (CLIA)"]);
  });
});

// Catálogo corregido el 20-nov: «HIV 1,2 (PRUEBA RAPIDA)» con alias «VIH» y «HIV» (la Dra cotiza esa cuando solo dicen VIH), «HAI CHAGAS», «HAI TOXO».
describe("VIH y siglas con puntos", () => {
  it.each(["vih", "hiv", "VIH", "vih 1 y 2", "hiv 1 y 2", "H.I.V.", "H.I.V. 1.2.( P. Rápida)", "prueba rapida hiv"])("«%s» → la prueba rápida de Bs 50", async (text) => {
    expect(sureOf(await run(text))).toEqual(["HIV 1,2 (PRUEBA RAPIDA)"]);
  });
  it("un panel nunca se elige solo: «vih 1 y 2» no es el PANEL INTIMA PLUS (Bs 1250) aunque su lista diga «VIH» y «Herpes simple 1»", async () => {
    for (const text of ["vih 1 y 2", "vih 1", "hiv 2", "vih elisa"]) expect(sureOf(await run(text)).some((name) => name.startsWith("PANEL"))).toBe(false);
  });
  it("las otras pruebas de VIH se cotizan cuando las nombran", async () => {
    expect(sureOf(await run("hiv 4ta generacion"))).toEqual(["HIV 1,2 AG-AC 4ta GENERACION (Elisa)"]);
    expect(sureOf(await run("western blot vih"))).toEqual(["WESTERN BLOT HIV"]);
  });
  it.each([["H.A.I. Chagas", "HAI CHAGAS"], ["H.A.I.Toxo", "HAI TOXO"], ["hai toxo", "HAI TOXO"]])("receta «%s» → %s", async (text, expected) => {
    expect(sureOf(await run(text))).toEqual([expected]);
  });
});

describe("las opciones van agrupadas por lo que pidió el paciente, sin el tope de 8", () => {
  it("cada pedido con su título y la numeración seguida", async () => {
    const block = (await run("herpes", "t4", "dengue")).blocks?.join("\n") ?? "";
    expect(block).toMatch(/\*Para «herpes»:\*\n1\. /);
    expect(block).toMatch(/\*Para «t4»:\*\n5\. /);
    expect(block).toMatch(/\n11\. /); // 4 + 3 + 4 = 11 opciones: antes se cortaba en 8
    expect(block).not.toMatch(/\n12\. /);
  });
  it("formatGroupedOptions numera seguido y respeta el máximo por pedido", () => {
    const many = Array.from({ length: 9 }, (_, i) => study(`ESTUDIO ${i}`, 10, "1 hora"));
    const text = formatGroupedOptions([{ label: "a", studies: many }, { label: "b", studies: many.slice(0, 2) }], true)!;
    expect(text).toMatch(/\*Para «a»:\*/);
    expect(text).toMatch(/\n6\. /);
    expect(text).not.toMatch(/\n9\. /);
    expect(text).toMatch(/\*Para «b»:\*\n7\. /);
  });
});

// Dueño e indicación del laboratorio (20-nov): el tiempo de entrega va junto al precio en cada estudio cotizado, y lo que el catálogo no tiene lo confirma la doctora (nunca «no lo tenemos»).
describe("tiempo de entrega junto al precio y estudios que confirma la doctora", () => {
  const blocksOf = async (...studies: string[]) => ((await run(...studies)).blocks ?? []).join("\n\n");
  it("cada estudio cotizado lleva su tiempo de entrega; el encabezado es «Tu cotización» (escribió los estudios, no mandó receta)", async () => {
    const text = await blocksOf("ldh", "sodio");
    expect(text).toMatch(/^🩺 \*PlusMedik\* · Tu cotización$/m);
    expect(text).toMatch(/DESHIDROGENASA LACTICA LDH — Bs 80 \(entrega: 2 horas\)$/m);
    expect(text).toMatch(/SODIO — Bs 40 \(entrega: 1 hora\)$/m);
  });
  it("sin tiempo de entrega en el catálogo: «te la confirma la doctora» (nunca se inventa)", async () => {
    const withGap = [...CATALOG, study("HOMOCISTEINA", 250, "")];
    const result = (await quoteStudiesTool({ loadCatalog: async () => withGap }).run({ studies: ["homocisteina"] }, ctx)) as Result;
    expect(result.blocks?.join("\n")).toMatch(/HOMOCISTEINA — Bs 250 \(entrega: te la confirma la doctora\)$/m);
  });
  it("5 estudios, 3 en el catálogo y 2 no: se cotizan los 3 y de los otros 2 se dice que los confirma la doctora", async () => {
    const result = await run("ldh", "sodio", "calcio", "ecografia de abdomen", "resonancia magnetica");
    expect(sureOf(result)).toEqual(["CALCIO SERICO", "DESHIDROGENASA LACTICA LDH", "SODIO"]);
    const text = result.blocks?.join("\n\n") ?? "";
    expect(text).toMatch(/Total de los estudios cotizados: Bs 150/);
    expect(text).toMatch(/👩‍⚕️ \*Estos estudios te los confirma la doctora:\*\n\n▫️ Ecografia de abdomen\n▫️ Resonancia magnetica\n\nTe escribirá por este chat con el precio y el tiempo de entrega\. 😊/);
    expect(text).not.toMatch(/no (lo |los )?tenemos|no (lo |los )?realizamos|otro laboratorio|no encontr/i);
    expect(result.facts?.some((f) => /confirma la doctora/.test(f.text) && /NO sabes si se realizan/.test(f.text))).toBe(true);
  });
  it("si nada coincide, solo el aviso de la doctora (sin precios ni total)", async () => {
    const text = await blocksOf("ecografia de abdomen");
    expect(text).toMatch(/Este estudio te lo confirma la doctora/);
    expect(text).not.toMatch(/Bs \d|Total/);
  });
  it("debajo de las opciones dudosas: «si no es ninguno de estos, te lo confirma la doctora»", async () => {
    expect(await blocksOf("herpes")).toMatch(/Si no es ninguno de estos, te lo confirma la doctora por este chat\./);
  });
});
