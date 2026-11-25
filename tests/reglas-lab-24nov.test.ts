import { describe, expect, it } from "vitest";
import type { AgentModel, PlanOutput, RespondInput, Utterance } from "../src/agent/contracts.js";
import { parsePlan } from "../src/agent/openai.js";
import { runAgentTurn } from "../src/agent/pipeline.js";
import { createToolRegistry, quoteStudiesTool, studiesNamedIn, studyPreparationTool } from "../src/agent/tools.js";
import { verifyReply } from "../src/agent/verify.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { parsePreparation, parseTurnaround } from "../src/quote-turnaround.js";
import type { CatalogStudy } from "../src/types.js";

// Respuestas del laboratorio (Excel «Preguntas pendientes», 24-nov) y la preparación de la lista de estudios (lab_tests.notes). Nombres y precios tal como están en el catálogo real.

let n = 0;
const study = (name: string, priceBs: number, turnaround: string, preparation?: string, aliases: string[] = []): CatalogStudy =>
  ({ id: `s${++n}`, code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category: null, sampleType: null, turnaroundText: turnaround, preparationText: preparation ?? null }) as unknown as CatalogStudy;

const CATALOG = [
  study("ANTICUERPOS ANTI-TIROGLOBULINA a-TG (CLIA)", 160, "En el día"),
  study("ANTICUERPOS ANTI-TIROGLOBULINA a-TG (ECLIA)", 140, "En el día"),
  study("VITAMINA D 25 (OH) (ECLIA)", 200, "En el día"),
  study("VITAMINA D 25 (OH) (FIA Fluorescencia)", 160, "1 hora"),
  study("TESTOSTERONA TOTAL (ECLIA)", 120, "En el día"),
  study("TESTOSTERONA LIBRE", 140, "En el día"),
  study("T3 TOTAL (ECLIA)", 90, "En el día"),
  study("T3 LIBRE (ECLIA)", 150, "En el día"),
  study("T3 NEONATAL", 100, "En el día"),
  study("PSA TOTAL (ECLIA)", 90, "En el día"),
  study("PSA TOTAL (FIA Fluorescencia)", 120, "1 hora"),
  study("PSA LIBRE (ECLIA)", 90, "En el día"),
  study("LATEX FACTOR REUMATOIDE (CUALITATIVO)", 60, "2 horas"),
  study("LATEX FACTOR REUMATOIDE (SEMI CUANTITATIVO)", 60, "2 horas"),
  study("LATEX FACTOR REUMATOIDE (CUANTITATIVO) FIA Fluorescencia", 100, "2 horas"),
  study("DENGUE IgM ELISA", 185, "3 días"),
  study("DENGUE IgG ELISA", 185, "3 días"),
  study("DENGUE DUO ANTICUERPOS Y ANTIGENO", 130, "1 hora"),
  study("DENGUE TEST RAPIDO IgG E IgM", 70, "1 hora"),
  study("ANTI-DNA ss (Simple Cadena) IgG (Elisa)", 170, "En el día"),
  study("ANTI-DNA ds (Doble Cadena) IgG (Elisa)", 160, "En el día"),
  study("ANTI-DNA ds (Doble Cadena) IgG IFI", 320, "3 días"),
  study("IONOGRAMA 1 (sodio, potasio, cloro)", 180, "1 hora"),
  study("IONOGRAMA 2 (sodio, potasio, cloro, calcio ionico)", 220, "1 hora"),
  study("HAI CHAGAS", 60, "4 horas", undefined, ["hai chagas"]),
  study("CHAGAS IgG ELISA", 70, "En el día"),
  study("INMUNO CHAGAS IgM", 70, "3 días"),
  study("BETA HCG-CUANTITATIVA (FIA Fluorescencia)", 130, "1 hora", undefined, ["hcg", "beta hcg"]),
  study("HCG SUB UNIDAD BETA-CUALITATIVA (HCG)", 40, "30 minutos", undefined, ["hcg"]),
  study("TIEMPO DE PROTROMBINA + INR", 50, "2 horas"),
  study("TIEMPO PARCIAL DE TROMBOPLASTINA (APTT)", 60, "2 horas"),
  study("FIBRINOGENO", 90, "2 horas"),
  study("TIEMPO DE COAGULACION", 25, "2 horas"),
  study("TIEMPO DE SANGRIA", 25, "2 horas"),
  study("HEMOCULTIVO ADULTO - PEDIATRICO SIMPLE - CONVENCIONAL", 150, "3 a 5 días"),
  study("HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X 2- CONVENCIONAL", 300, "3 a 5 días"),
  study("HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL", 450, "3 a 5 días"),
  study("ADN (Paternidad 2 muestras- padre e hijo) - Sangre con EDTA, Hisopado Bucal", 2000, "7 días"),
  study("ADN (Paternidad 2 muestras- padre e hijo) - Cabellos y uñas", 2400, "7 días"),
  study("ADN (Paternidad 2 muestras- padre e hijo) EXPRESS - Sangre con EDTA, Hisopado Bucal", 3700, "1 día"),
  study("PROTEINA C REACTIVA (PCR CUALITATIVO)", 50, "2 horas"),
  study("PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO)", 60, "2 horas"),
  study("PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)", 110, "1 hora"),
  study("HEMOGRAMA COMPLETO AUTOMATIZADO", 45, "2 horas", "No requiere de condiciones especiales.", ["hemograma"]),
  study("GLUCOSA", 30, "2 horas", "Se requiere ayuno de 8 a 12 horas."),
  study("FERRITINA (CLIA)", 130, "En el día", "No requiere condiciones especiales, pero se sugiere 8 a 12 horas de ayuno para evitar la lipemia."),
  study("IONOGRAMA EN ORINA (Sodio, Cloro, Potasio)", 240, "2 horas", "Orina de 24 horas: descartar la primera orina de la mañana y juntar todas las siguientes."),
  study("SODIO EN ORINA OCASIONAL O 24 HORAS", 60, "En el día", "Mismas condiciones que Ionograma en orina"),
  study("TSH (ECLIA)", 90, "En el día", "No requiere condiciones especiales."),
  study("TSH NEONATAL", 100, "En el día")
];

type Result = { facts?: Array<{ text: string; refs: string[] }>; blocks?: string[] };
const tool = quoteStudiesTool({ loadCatalog: async () => CATALOG });
const quoted = async (text: string): Promise<string[]> => {
  const result = (await tool.run({ studies: [text] }, { now: new Date(), patientText: text } as never)) as Result;
  const refs = result.facts?.find((fact) => fact.text.startsWith("Estudios identificados"))?.refs ?? [];
  return refs.map((ref) => CATALOG.find((item) => `study:${item.id}` === ref)!.name);
};

describe("sin método ni versión: el MÁS BARATO (y si empatan en precio, el más rápido)", () => {
  it.each([
    ["anti tiroglobulina", ["ANTICUERPOS ANTI-TIROGLOBULINA a-TG (ECLIA)"]],
    ["vitamina d", ["VITAMINA D 25 (OH) (FIA Fluorescencia)"]],
    ["pcr", ["PROTEINA C REACTIVA (PCR CUALITATIVO)"]],
    ["proteina c reactiva", ["PROTEINA C REACTIVA (PCR CUALITATIVO)"]],
    ["hemocultivo", ["HEMOCULTIVO ADULTO - PEDIATRICO SIMPLE - CONVENCIONAL"]],
    ["prueba de paternidad", ["ADN (Paternidad 2 muestras- padre e hijo) - Sangre con EDTA, Hisopado Bucal"]]
  ])("«%s» → %j", async (text, expected) => {
    expect(await quoted(text)).toEqual(expected);
  });
  it("lo que el paciente dice manda: «pcr cuantitativo», «vitamina d eclia», «hemocultivo x3»", async () => {
    expect(await quoted("pcr cuantitativo")).toEqual(["PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)"]);
    expect(await quoted("vitamina d eclia")).toEqual(["VITAMINA D 25 (OH) (ECLIA)"]);
    expect(await quoted("hemocultivo seriado x3")).toEqual(["HEMOCULTIVO ADULTO - PEDIATRICO SERIADO X3- CONVENCIONAL"]);
  });
});

describe("prueba con IgG e IgM juntas: compite por precio con las dos por separado", () => {
  const twoClass = (combined: number) => quoteStudiesTool({ loadCatalog: async () => [study("RUBEOLA IgG (ELISA)", 100, "1 día"), study("RUBEOLA IgM (ELISA)", 100, "1 día"), study("RUBEOLA PRUEBA RAPIDA IgG E IgM", combined, "1 hora")] });
  const pick = async (combined: number) => {
    const result = (await twoClass(combined).run({ studies: ["rubeola"] }, { now: new Date(), patientText: "rubeola" } as never)) as Result;
    return result.blocks!.join("\n");
  };
  it("más barata que las dos juntas (150 < 200), aunque cueste más que cada una: la combinada", async () => {
    expect(await pick(150)).toMatch(/RUBEOLA PRUEBA RAPIDA IgG E IgM — Bs 150/);
  });
  it("más cara que las dos juntas: IgG + IgM", async () => {
    const blocks = await pick(250);
    expect(blocks).toMatch(/RUBEOLA IgG \(ELISA\) — Bs 100/);
    expect(blocks).toMatch(/RUBEOLA IgM \(ELISA\) — Bs 100/);
  });
});

describe("total o libre sin decir cuál: el TOTAL directo, sin ofrecer el libre", () => {
  it.each([["testosterona", "TESTOSTERONA TOTAL (ECLIA)"], ["t3", "T3 TOTAL (ECLIA)"], ["psa", "PSA TOTAL (ECLIA)"]])("«%s» → %s", async (text, expected) => {
    expect(await quoted(text)).toEqual([expected]);
    const blocks = ((await tool.run({ studies: [text] }, { now: new Date(), patientText: text } as never)) as Result).blocks!.join("\n");
    expect(blocks).not.toMatch(/LIBRE/);
  });
  it("si pide el libre, el libre", async () => {
    expect(await quoted("testosterona libre")).toEqual(["TESTOSTERONA LIBRE"]);
    expect(await quoted("psa libre")).toEqual(["PSA LIBRE (ECLIA)"]);
  });
});

describe("elecciones del laboratorio cuando el estudio se nombra a secas", () => {
  it.each([
    ["factor reumatoide", ["LATEX FACTOR REUMATOIDE (SEMI CUANTITATIVO)"]],
    ["fr", ["LATEX FACTOR REUMATOIDE (SEMI CUANTITATIVO)"]],
    ["dengue", ["DENGUE TEST RAPIDO IgG E IgM"]],
    ["ionograma", ["IONOGRAMA 1 (sodio, potasio, cloro)"]],
    ["electrolitos", ["IONOGRAMA 1 (sodio, potasio, cloro)"]],
    ["chagas", ["HAI CHAGAS"]],
    ["beta hcg", ["HCG SUB UNIDAD BETA-CUALITATIVA (HCG)"]],
    ["hcg", ["HCG SUB UNIDAD BETA-CUALITATIVA (HCG)"]],
    ["prueba de embarazo", ["HCG SUB UNIDAD BETA-CUALITATIVA (HCG)"]],
    ["coagulograma", ["TIEMPO DE PROTROMBINA + INR", "TIEMPO PARCIAL DE TROMBOPLASTINA (APTT)", "FIBRINOGENO"]],
    ["anti dna", ["ANTI-DNA ss (Simple Cadena) IgG (Elisa)", "ANTI-DNA ds (Doble Cadena) IgG (Elisa)"]]
  ])("«%s» → %j", async (text, expected) => {
    expect((await quoted(text)).sort()).toEqual([...expected].sort());
  });
  it("anti-DNA: el redactor dice que el médico confirma cuál", async () => {
    const result = (await tool.run({ studies: ["anti dna"] }, { now: new Date(), patientText: "anti dna" } as never)) as Result;
    expect(result.facts?.some((fact) => fact.text.includes("su médico confirma cuál"))).toBe(true);
  });
  it("lo que el paciente especifica manda sobre la elección del laboratorio", async () => {
    expect(await quoted("beta hcg cuantitativa")).toEqual(["BETA HCG-CUANTITATIVA (FIA Fluorescencia)"]);
    expect(await quoted("ionograma 2")).toEqual(["IONOGRAMA 2 (sodio, potasio, cloro, calcio ionico)"]);
  });
  it("«hgc» (errata) sugiere la HCG que elige el laboratorio, con su precio", async () => {
    const blocks = ((await tool.run({ studies: ["hgc"] }, { now: new Date(), patientText: "hgc" } as never)) as Result).blocks!.join("\n");
    expect(blocks).toContain("¿Con «hgc» quisiste decir *HCG SUB UNIDAD BETA-CUALITATIVA (HCG)*?");
    expect(blocks).toContain("Bs 40");
  });
});

describe("un alias que comparten varios estudios (cargados el 24-nov)", () => {
  const shared = quoteStudiesTool({ loadCatalog: async () => [
    study("ANTICUERPOS ANTI-TIROGLOBULINA a-TG (CLIA)", 160, "En el día", undefined, ["atg"]),
    study("ANTICUERPOS ANTI-TIROGLOBULINA a-TG (ECLIA)", 140, "En el día", undefined, ["atg"]),
    study("PANEL INTIMA PLUS 34 PATOGENOS – INFECCIONES DE TRANSMISION SEXUAL + HPV + VIH 4ta Generacion (Elisa)", 1250, "24 horas", undefined, ["panel its"]),
    study("PANEL qPCR 12 PATOGENOS DE ITS + HIV 4ta GENERACION ELISA", 700, "24 horas", undefined, ["panel its"]),
    study("PANEL qPCR 12 PATOGENOS DE INFECCIONES DE TRANSMISION SEXUAL", 600, "24 horas", undefined, ["panel its"])
  ] });
  const run = async (text: string) => (await shared.run({ studies: [text] }, { now: new Date(), patientText: text } as never)) as Result;
  it("«atg» (en la CLIA y la ECLIA) → la más barata", async () => {
    expect((await run("atg")).facts?.[0]?.text).toContain("ANTICUERPOS ANTI-TIROGLOBULINA a-TG (ECLIA)");
  });
  it("«panel its» (en los paneles de ITS) → se ofrecen todos con su precio, no el único que dice «ITS» en el nombre", async () => {
    const result = await run("panel its");
    expect(result.facts?.some((fact) => fact.text.startsWith("Estudios identificados"))).toBe(false);
    const blocks = result.blocks!.join("\n");
    for (const price of ["Bs 1250", "Bs 700", "Bs 600"]) expect(blocks).toContain(price);
  });
});

describe("preparación: el texto de la lista del laboratorio (lab_tests.notes)", () => {
  it("se lee de las notas junto al tiempo de entrega", () => {
    const notes = "Preparacion: Se requiere ayuno de 8 a 12 horas. | Tiempo de entrega: 2 horas";
    expect(parsePreparation(notes)).toBe("Se requiere ayuno de 8 a 12 horas.");
    expect(parseTurnaround(notes)).toBe("2 horas");
    expect(parsePreparation("Preparacion: No requiere de condiciones especiales.")).toBe("No requiere de condiciones especiales.");
    expect(parsePreparation("Tiempo de entrega: 2 horas")).toBeNull();
    expect(parsePreparation(null)).toBeNull();
  });
  it.each([
    ["Para un hemograma es necesario que vaya en ayunas?", ["HEMOGRAMA COMPLETO AUTOMATIZADO"]],
    ["para la ferritina tengo que ir sin comer?", ["FERRITINA (CLIA)"]],
    ["el tsh es en ayunas", ["TSH (ECLIA)"]],
    ["hola buenas tardes tengo que ir en ayunas?", []]
  ])("qué estudio nombra «%s»", (text, expected) => {
    expect(studiesNamedIn(text, CATALOG).map((item) => item.name)).toEqual(expected);
  });
  it("«Mismas condiciones que Ionograma en orina» trae también esa preparación", async () => {
    const result = (await studyPreparationTool({ loadCatalog: async () => CATALOG }).run({ text: "sodio en orina ocasional" }, {} as never)) as Result;
    expect(result.facts?.[0]?.text).toContain("«SODIO EN ORINA OCASIONAL O 24 HORAS»: Mismas condiciones que Ionograma en orina (IONOGRAMA EN ORINA (Sodio, Cloro, Potasio): Orina de 24 horas");
  });
  it("el plan del modelo puede pedirla", () => {
    expect(parsePlan(JSON.stringify({ toolCalls: [{ tool: "study_preparation", text: "glucosa", studies: null, guesses: null }], silent: false, handoff: null })).toolCalls[0]).toEqual({ tool: "study_preparation", input: { text: "glucosa" } });
  });

  const u = (text: string): Utterance => ({ topic: "OTHER_LAB", text } as Utterance);
  const tools = createToolRegistry([quoteStudiesTool({ loadCatalog: async () => CATALOG }), studyPreparationTool({ loadCatalog: async () => CATALOG })]);
  const model = (text: string, seen: RespondInput[], plan: Partial<PlanOutput> = {}): AgentModel => ({
    async plan() { return { toolCalls: [], ...plan, usage: { inputTokens: 1, outputTokens: 1 } }; },
    async respond(input) { seen.push(input); return { text, usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }; }
  });

  it("caso real: «¿para un hemograma es necesario ir en ayunas?» → la preparación del laboratorio, sin la nota de orientación general", async () => {
    const seen: RespondInput[] = [];
    const text = "Para el hemograma no necesitas ir en ayunas 😊 No requiere condiciones especiales.";
    const decision = await runAgentTurn({ model: model(text, seen), tools }, { utterances: [u("Para un hemograma es necesario que vaya en ayunas?")] });
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reply).toBe(text);
    expect(decision.guidance).toBeUndefined();
    expect(seen[0]!.facts.some((fact) => fact.text.includes("«HEMOGRAMA COMPLETO AUTOMATIZADO»: No requiere de condiciones especiales."))).toBe(true);
  });
  it("«¿es en ayunas?» después de una cotización: busca el estudio en los mensajes recientes y puede calcular la hora de la toma", async () => {
    const seen: RespondInput[] = [];
    const text = "Sí, la glucosa requiere ayuno de 8 a 12 horas. Si cenas a las 8 pm, puedes venir entre las 4 y las 8 am; más de 12 horas de ayuno puede alterar el resultado.";
    const decision = await runAgentTurn({ model: model(text, seen), tools }, { utterances: [u("y es en ayunas?")], recent: [{ from: "PATIENT", text: "cotizame glucosa" }, { from: "ASSISTANT", text: "🩺 *PlusMedik* · Tu cotización\n\n🧪 GLUCOSA — Bs 30" }] });
    expect(decision.status).toBe("VERIFIED");
    expect(seen[0]!.facts.some((fact) => fact.text.includes("«GLUCOSA»: Se requiere ayuno de 8 a 12 horas.") && fact.text.includes("más de 12 horas puede alterar el resultado"))).toBe(true);
  });
  it("las horas de la toma pasan el verificador solo con preparación; un teléfono o un precio no", () => {
    const text = "Si cenas a las 8 pm, puedes venir entre las 4 y las 8 am.";
    expect(verifyReply({ text, facts: [] }).map((v) => v.code)).toContain("UNGROUNDED_FIGURE");
    expect(verifyReply({ text, facts: [], guidanceFigures: true })).toEqual([]);
    expect(verifyReply({ text: "Ven a las 7 am, llama al 78555440", facts: [], guidanceFigures: true }).map((v) => v.code)).toContain("UNGROUNDED_FIGURE");
  });
});
