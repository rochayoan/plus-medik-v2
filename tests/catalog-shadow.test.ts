import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  checkIdentity,
  identityTokens,
  parseDecisions,
  shadowMatch,
  simulateShadowPolicy,
  supportOf,
  verifyDecision,
  type RawDecision,
  type ShadowRequest
} from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-shadow-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
const study = (code: string, name: string, category = "QUIMICA SANGUINEA", extra: Partial<CatalogStudy> & { aliases?: string[] } = {}): CatalogStudy => {
  counter += 1;
  const { aliases = [], ...rest } = extra;
  return {
    id: `uuid-${code}-${counter}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey),
    priceBs: 100 + Number(code) / 10, active: true, category, ...rest
  };
};

const glucosa = study("397", "GLUCOSA");
const glucosaNeonatal = study("398", "GLUCOSA NEONATAL");
const tshEclia = study("178", "TSH (ECLIA)", "HORMONAS");
const tshFia = study("179", "TSH (FIA Fluorescencia)", "HORMONAS");
const tshNeonatal = study("180", "TSH NEONATAL", "HORMONAS");
const toxoIgG = study("238", "TOXO IgG (ELISA)", "INMUNOSEROLOGIA");
const toxoIgM = study("239", "TOXO IgM (ELISA)", "INMUNOSEROLOGIA");
const inmunoToxoIgG = study("231", "INMUNO TOXO IgG", "INMUNOSEROLOGIA");
const magnesio = study("408", "MAGNESIO (Mg)");
const magnesioOrina = study("518", "MAGNESIO en Orina de 24 Hrs.", "URIANALISIS");
const creatinina = study("384", "CREATININA");
const depuracion = study("512", "DEPURACION DE CREATININA / CLEARENCE DE CREATININA 24 HORAS", "URIANALISIS");
const got = study("418", "TRANSAMINASA GOT");
const gpt = study("419", "TRANSAMINASA GPT");
const colTotal = study("378", "COLESTEROL TOTAL");
const hdl = study("376", "COLESTEROL HDL");
const ldl = study("377", "COLESTEROL LDL");
const vldl = study("379", "COLESTEROL VLDL");
const trigliceridos = study("421", "TRIGLICERIDOS");
const hemograma = study("108", "HEMOGRAMA COMPLETO AUTOMATIZADO", "HEMATOLOGIA", { aliases: ["Hemograma Completo"] });
const pcrCual = study("474", "PROTEINA C REACTIVA (PCR CUALITATIVO)", "SEROLOGIA");
const pcrSemi = study("475", "PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO", "SEROLOGIA");
const pcrCuant = study("476", "PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)", "SEROLOGIA");
const acIgG = study("21", "ANTICARDIOLIPINA IgG", "AUTOINMUNIDAD");
const acIgM = study("22", "ANTICARDIOLIPINA IgM", "AUTOINMUNIDAD");
const acIgA = study("20", "ANTICARDIOLIPINA IgA", "AUTOINMUNIDAD");
const psaEclia = study("257", "PSA TOTAL (ECLIA)", "MARCADORES TUMORALES");
const psaFia = study("258", "PSA TOTAL (FIA Fluorescencia)", "MARCADORES TUMORALES");
const inactivo = study("999", "ESTUDIO INACTIVO", "HORMONAS", { active: false });
const FORM = { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: true };
const catalog: CatalogStudy[] = [glucosa, glucosaNeonatal, tshEclia, tshFia, tshNeonatal, toxoIgG, toxoIgM, inmunoToxoIgG, magnesio, magnesioOrina, creatinina, depuracion, got, gpt, colTotal, hdl, ldl, vldl, trigliceridos, hemograma, pcrCual, pcrSemi, pcrCuant, acIgG, acIgM, acIgA, psaEclia, psaFia, inactivo];

// ───────── modelo simulado: responde por texto; las refs se leen del prompt, así que sirve para ambas pasadas ─────────
const refByName = (request: ShadowRequest, name: string): string => {
  const line = request.promptText.split("\n").find((l) => /^s\d+\|/.test(l) && l.split("|")[1] === (name.length > 160 ? `${name.slice(0, 160)}…` : name));
  if (!line) throw new Error(`no hay ${name} en el prompt`);
  return line.split("|")[0]!;
};
type Answer = { status: "MATCH" | "AMBIGUOUS" | "NO_MATCH" | "COMPOSITE"; studies?: CatalogStudy[]; alternatives?: CatalogStudy[]; fragments?: string[]; confidence?: "high" | "medium" | "low" };
const model = (answers: Record<string, Answer | ((variant: number) => Answer)>) => {
  let call = 0;
  return vi.fn(async (request: ShadowRequest) => {
    call += 1;
    const decisions = request.items.map((item) => {
      const raw = answers[item.literalText];
      const answer = typeof raw === "function" ? raw(call) : raw ?? { status: "NO_MATCH" as const };
      return {
        index: item.index, status: answer.status,
        refs: (answer.studies ?? []).map((s) => refByName(request, s.name)),
        alternatives: (answer.alternatives ?? []).map((s) => refByName(request, s.name)),
        componentFragments: answer.fragments ?? [], reading: `lectura de ${item.literalText}`, qualifiersInText: [],
        confidence: answer.confidence ?? "high", reason: "razón"
      };
    });
    return { value: { decisions }, usage: { inputTokens: 1000, outputTokens: 50, reasoningTokens: 10 } };
  });
};
const run = (texts: string[], answers: Parameters<typeof model>[0], cat = catalog) => {
  const complete = model(answers);
  return { complete, promise: shadowMatch({ queries: texts.map((literalText) => ({ literalText })), catalog: cat, deps: { complete, model: "m", reasoning: "medium" } }) };
};

describe("todo estudio pasa por GPT, con el catálogo activo completo", () => {
  it("también los que el matcher exacto ya resolvería, en dos pasadas independientes", async () => {
    const { complete, promise } = run(["Hemograma Completo"], { "Hemograma Completo": { status: "MATCH", studies: [hemograma] } });
    const batch = await promise;
    expect(complete).toHaveBeenCalledTimes(2);
    expect(batch.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: hemograma.id, support: "EXACT" });
    expect(batch.results[0]!.agreement).toBe(true);
  });

  it("el prompt trae TODOS los estudios activos, excluye inactivos y no incluye precios", async () => {
    const { complete, promise } = run(["x"], {});
    await promise;
    const prompt = complete.mock.calls[0]![0].promptText;
    expect(prompt).toContain("CATÁLOGO (28 estudios activos)");
    for (const s of catalog.filter((c) => c.active)) expect(prompt).toContain(`|${s.name}|`);
    expect(prompt).not.toContain("ESTUDIO INACTIVO");
    expect(prompt).not.toMatch(/priceBs|price_bs|Bs\b|\b10[0-9]\.[0-9]\b/);
  });

  it("las dos pasadas usan órdenes y refs distintas", async () => {
    const { complete, promise } = run(["x"], {});
    await promise;
    const [a, b] = [complete.mock.calls[0]![0].promptText, complete.mock.calls[1]![0].promptText];
    expect(a).not.toEqual(b);
    expect(a.split("\n").find((l) => l.startsWith("s1|"))).not.toEqual(b.split("\n").find((l) => l.startsWith("s1|")));
  });
});

describe("la confianza del modelo no basta: verificación determinística", () => {
  it("una ref inventada se rechaza", () => {
    const refMap = new Map([["s1", glucosa]]);
    const [decision] = parseDecisions({
      queries: [{ literalText: "Glicemia" }], refMap,
      rawDecisions: [{ index: 0, status: "MATCH", refs: ["s999"], alternatives: [], componentFragments: [], reading: "", qualifiersInText: [], confidence: "high", reason: "" }]
    });
    expect(decision!.status).toBe("NO_MATCH");
    expect(decision!.notes.join()).toContain("ref inexistente");
  });

  it("MATCH con confianza alta pero isotipo contradictorio -> REJECTED", async () => {
    const { promise } = run(["TOXO IgM"], { "TOXO IgM": { status: "MATCH", studies: [toxoIgG], confidence: "high" } });
    const result = (await promise).results[0]!;
    expect(result.outcome.kind).toBe("REJECTED");
    expect((result.outcome as { reason: string }).reason).toContain("contradicción en isotipo");
  });

  it("MATCH a un estudio que no declara el calificador que el texto afirma -> REJECTED (neonatal sobre el general)", async () => {
    const { promise } = run(["Glucosa neonatal"], { "Glucosa neonatal": { status: "MATCH", studies: [glucosa] } });
    expect((await promise).results[0]!.outcome.kind).toBe("REJECTED");
    const ok = await run(["Glucosa neonatal"], { "Glucosa neonatal": { status: "MATCH", studies: [glucosaNeonatal] } }).promise;
    expect(ok.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: glucosaNeonatal.id });
  });

  it("la sigla corta entre paréntesis no oculta a las variantes hermanas ni el typo OCACIONAL del catálogo", () => {
    const sodio = study("415", "SODIO");
    const sodioOrina = study("525", "SODIO EN ORINA OCACIONAL O 24 HORAS", "URIANALISIS");
    expect(checkIdentity("Sodio", sodio, [sodio, sodioOrina]).plausibleSiblings.map((s) => s.code)).toEqual(["525"]);
    expect(checkIdentity("Magnesio", magnesio, catalog).plausibleSiblings.map((s) => s.code)).toEqual(["518"]);
    expect(checkIdentity("Sodio en orina de 24 horas", sodioOrina, [sodio, sodioOrina]).ok).toBe(true);
  });

  it("'TSH' con MATCH a ECLIA -> AMBIGUOUS (FIA y neonatal siguen siendo plausibles)", async () => {
    const { promise } = run(["TSH"], { TSH: { status: "MATCH", studies: [tshEclia], confidence: "high" } });
    const outcome = (await promise).results[0]!.outcome;
    expect(outcome.kind).toBe("AMBIGUOUS");
    expect((outcome as { studyIds: string[] }).studyIds).toEqual(expect.arrayContaining([tshEclia.id, tshFia.id]));
  });

  it("'TOXO IgG' -> MATCH al ELISA es AMBIGUOUS por la variante INMUNO; 'Elisa para Toxoplasmosis IgG' sí es MATCH", async () => {
    const a = await run(["TOXO IgG"], { "TOXO IgG": { status: "MATCH", studies: [toxoIgG] } }).promise;
    expect(a.results[0]!.outcome.kind).toBe("AMBIGUOUS");
    const b = await run(["Elisa para Toxoplasmosis IgG"], { "Elisa para Toxoplasmosis IgG": { status: "MATCH", studies: [toxoIgG] } }).promise;
    expect(b.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: toxoIgG.id });
  });

  it("'PSA Total' -> AMBIGUOUS entre ECLIA y FIA; 'Elisa para PSA Total' contradice el método -> REJECTED", async () => {
    const a = await run(["PSA Total"], { "PSA Total": { status: "MATCH", studies: [psaEclia] } }).promise;
    expect(a.results[0]!.outcome.kind).toBe("AMBIGUOUS");
    const b = await run(["Elisa para PSA Total"], { "Elisa para PSA Total": { status: "MATCH", studies: [psaEclia] } }).promise;
    expect(b.results[0]!.outcome.kind).toBe("REJECTED");
  });

  it("'Glicemia' -> GLUCOSA es MATCH (el estudio neonatal no es plausible sin esa población)", async () => {
    const { promise } = run(["Glicemia"], { Glicemia: { status: "MATCH", studies: [glucosa] } });
    const result = (await promise).results[0]!;
    expect(result.outcome).toMatchObject({ kind: "MATCH", studyId: glucosa.id, support: "SEMANTIC" });
  });

  it("'Magnesio' sin muestra -> AMBIGUOUS (sangre vs orina de 24 h)", async () => {
    const { promise } = run(["Magnesio"], { Magnesio: { status: "MATCH", studies: [magnesio] } });
    expect((await promise).results[0]!.outcome.kind).toBe("AMBIGUOUS");
  });

  it("'Creatinina serica' -> CREATININA es MATCH (muestra implícita por categoría); la depuración no compite", async () => {
    const { promise } = run(["Creatinina serica"], { "Creatinina serica": { status: "MATCH", studies: [creatinina] } });
    expect((await promise).results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: creatinina.id });
    expect(checkIdentity("Creatinina en orina", creatinina, catalog).ok).toBe(false);
  });

  it("'PCR cualitativa' -> MATCH solo al cualitativo; 'cuantitativa' no se confunde con 'semi cuantitativa'", async () => {
    const a = await run(["PROTEINA C REACTIVA - (PCR) cualitativa"], { "PROTEINA C REACTIVA - (PCR) cualitativa": { status: "MATCH", studies: [pcrCual] } }).promise;
    expect(a.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: pcrCual.id });
    const b = await run(["Proteina C Reactiva cuantitativa"], { "Proteina C Reactiva cuantitativa": { status: "MATCH", studies: [pcrCuant] } }).promise;
    expect(b.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: pcrCuant.id });
    const c = await run(["Proteina C Reactiva cuantitativa"], { "Proteina C Reactiva cuantitativa": { status: "MATCH", studies: [pcrSemi] } }).promise;
    expect(c.results[0]!.outcome.kind).toBe("REJECTED");
  });

  it("'Anticardiolipinas Ig M' -> MATCH a IgM (isotipo explícito) y contradice IgG", async () => {
    const ok = await run(["Anticardiolipinas Ig M"], { "Anticardiolipinas Ig M": { status: "MATCH", studies: [acIgM] } }).promise;
    expect(ok.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: acIgM.id });
    const bad = await run(["Anticardiolipinas Ig M"], { "Anticardiolipinas Ig M": { status: "MATCH", studies: [acIgG] } }).promise;
    expect(bad.results[0]!.outcome.kind).toBe("REJECTED");
  });

  it("alternativas plausibles listadas por el modelo -> AMBIGUOUS; alternativas que el texto contradice se ignoran", async () => {
    const plausible = await run(["Hemograma"], { Hemograma: { status: "MATCH", studies: [hemograma], alternatives: [pcrCual] } }).promise;
    expect(plausible.results[0]!.outcome.kind).toBe("AMBIGUOUS");
    const contradicted = await run(["Anticardiolipina IgM"], { "Anticardiolipina IgM": { status: "MATCH", studies: [acIgM], alternatives: [acIgG, acIgA] } }).promise;
    expect(contradicted.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: acIgM.id });
  });

  it("si las dos pasadas no coinciden -> AMBIGUOUS inestable y sin agreement", async () => {
    const { promise } = run(["Glicemia"], { Glicemia: (call) => ({ status: "MATCH", studies: [call % 2 === 1 ? glucosa : glucosaNeonatal] }) });
    const result = (await promise).results[0]!;
    expect(result.agreement).toBe(false);
    expect(result.outcome.kind).toBe("AMBIGUOUS");
  });
});

describe("estudios compuestos", () => {
  const texts = { got: "TRANSAMINASAS GOT/GPT", lipid: "PERFIL LIPIDICO (COL, HDL, LDL, VLDL, TRIGLICERIDOS)", thyroid: "Perfil Tiroideo", nus: "NITROGENO UREICO/UREA/NUS" };

  it("componentes explícitos con fragmentos reales del texto -> COMPOSITE verificado", async () => {
    const { promise } = run([texts.got, texts.lipid], {
      [texts.got]: { status: "COMPOSITE", studies: [got, gpt], fragments: ["GOT", "GPT"] },
      [texts.lipid]: { status: "COMPOSITE", studies: [colTotal, hdl, ldl, vldl, trigliceridos], fragments: ["COL", "HDL", "LDL", "VLDL", "TRIGLICERIDOS"] }
    });
    const [a, b] = (await promise).results;
    expect(a!.outcome.kind).toBe("COMPOSITE");
    expect(b!.outcome.kind).toBe("COMPOSITE");
    expect((b!.outcome as { components: unknown[] }).components).toHaveLength(5);
  });

  it("un perfil sin componentes listados no se resuelve: si el modelo inventa componentes, se rechaza", async () => {
    const { promise } = run([texts.thyroid], { [texts.thyroid]: { status: "COMPOSITE", studies: [tshEclia, got], fragments: ["TSH", "T4"] } });
    expect((await promise).results[0]!.outcome.kind).toBe("REJECTED");
    const { promise: p2 } = run([texts.thyroid], { [texts.thyroid]: { status: "NO_MATCH" } });
    expect((await p2).results[0]!.outcome.kind).toBe("NO_MATCH");
  });

  it("si un elemento de la lista queda sin componente -> REJECTED (no se asume completitud)", async () => {
    const { promise } = run([texts.nus], { [texts.nus]: { status: "COMPOSITE", studies: [got, gpt], fragments: ["NITROGENO UREICO", "UREA"] } });
    expect((await promise).results[0]!.outcome.kind).toBe("REJECTED");
  });

  it("COMPOSITE sin un fragmento por componente se degrada a NO_MATCH", () => {
    const refMap = new Map([["s1", got], ["s2", gpt]]);
    const [decision] = parseDecisions({
      queries: [{ literalText: texts.got }], refMap,
      rawDecisions: [{ index: 0, status: "COMPOSITE", refs: ["s1", "s2"], alternatives: [], componentFragments: ["GOT"], reading: "", qualifiersInText: [], confidence: "high", reason: "" }]
    });
    expect(decision!.status).toBe("NO_MATCH");
  });
});

describe("identidad y soporte", () => {
  it("normaliza isotipo con espacio, 24 horas y plurales", () => {
    expect(identityTokens("Anticardiolipinas Ig M")).toContain("igm");
    expect(identityTokens("Calcio en orina de 24 horas")).toContain("24h");
    expect(identityTokens("Proteina C Reactiva semi cuantitativa")).toContain("semicuantitativo");
  });

  it("clasifica el soporte: EXACT, LEXICAL (palabras del nombre) y SEMANTIC (sinónimo o abreviatura)", () => {
    expect(supportOf("Hemograma Completo", hemograma)).toBe("EXACT");
    expect(supportOf("Creatinina serica", creatinina)).toBe("LEXICAL");
    expect(supportOf("TGO", got)).toBe("SEMANTIC");
    expect(supportOf("Glicemia basal", glucosa)).toBe("SEMANTIC");
  });

  it("no se verifica un estudio inactivo", () => {
    const raw: RawDecision = { index: 0, status: "MATCH", studies: [inactivo], alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [] };
    expect(verifyDecision("Estudio inactivo", raw, catalog).kind).toBe("REJECTED");
  });

  it("buildPrompt recorta nombres larguísimos", () => {
    const panel = study("317", `PANEL SEPSIS ${"PATOGENO ".repeat(100)}`, "PCR BIOLOGIA MOLECULAR");
    const refOf = new Map([[panel.id, "s1"]]);
    const prompt = buildPrompt([panel], refOf, [{ index: 0, literalText: "x" }]);
    expect(prompt.split("\n").find((l) => l.startsWith("s1|"))!.length).toBeLessThan(260);
  });
});

describe("simulación de política (no es el safety real)", () => {
  const ok = async (texts: string[], answers: Parameters<typeof model>[0]) => (await run(texts, answers).promise).results;
  const high = (text: string) => ({ literalText: text, confidence: "high" as const });

  it("AUTO solo si TODOS los estudios son MATCH verificado; subtotal con precios del catálogo y sin duplicar UUID", async () => {
    const results = await ok(["Hemograma Completo", "Hemograma"], {
      "Hemograma Completo": { status: "MATCH", studies: [hemograma] },
      Hemograma: { status: "MATCH", studies: [hemograma] }
    });
    const sim = simulateShadowPolicy({ document: FORM, unresolvedVisualDisputes: 0, studies: [high("Hemograma Completo"), high("Hemograma")], results, catalog, allowExplicitComposites: false });
    expect(sim.decision).toBe("AUTO_SAFE");
    expect(sim.quote!.lines).toHaveLength(1);
    expect(sim.quote!.totalBs).toBe(hemograma.priceBs);
  });

  it("un solo AMBIGUOUS, NO_MATCH, REJECTED o inestable fuerza HUMAN_REVIEW, aunque el modelo declare confianza alta", async () => {
    const results = await ok(["Hemograma Completo", "TSH"], {
      "Hemograma Completo": { status: "MATCH", studies: [hemograma], confidence: "high" },
      TSH: { status: "MATCH", studies: [tshEclia], confidence: "high" }
    });
    const sim = simulateShadowPolicy({ document: FORM, unresolvedVisualDisputes: 0, studies: [high("Hemograma Completo"), high("TSH")], results, catalog, allowExplicitComposites: true });
    expect(sim.decision).toBe("HUMAN_REVIEW");
    expect(sim.reasons).toContain("shadow_ambiguous");
    expect(sim.quote).toBeUndefined();
    expect(sim.verifiedSubtotalBs).toBe(hemograma.priceBs);
    expect(sim.complete).toBe(false);
  });

  it("los compuestos explícitos solo participan si la política los permite", async () => {
    const answers = { "TRANSAMINASAS GOT/GPT": { status: "COMPOSITE" as const, studies: [got, gpt], fragments: ["GOT", "GPT"] } };
    const results = await ok(["TRANSAMINASAS GOT/GPT"], answers);
    const base = { unresolvedVisualDisputes: 0, studies: [high("TRANSAMINASAS GOT/GPT")], results, catalog };
    const strict = simulateShadowPolicy({ document: FORM, ...base, allowExplicitComposites: false });
    expect(strict.decision).toBe("HUMAN_REVIEW");
    expect(strict.reasons).toContain("shadow_composite_requires_policy");
    const permissive = simulateShadowPolicy({ document: FORM, ...base, allowExplicitComposites: true });
    expect(permissive.decision).toBe("AUTO_SAFE");
    expect(permissive.quote!.lines.map((l) => l.code).sort()).toEqual(["418", "419"]);
    expect(permissive.quote!.totalBs).toBeCloseTo(got.priceBs + gpt.priceBs);
  });

  it("disputas visuales sin resolver, estudios no 'high' o receta vacía mantienen HUMAN_REVIEW", async () => {
    const results = await ok(["Hemograma Completo"], { "Hemograma Completo": { status: "MATCH", studies: [hemograma] } });
    const base = { results, catalog, allowExplicitComposites: true };
    expect(simulateShadowPolicy({ document: FORM, ...base, unresolvedVisualDisputes: 1, studies: [high("Hemograma Completo")] }).reasons).toContain("visual_disputes_unresolved");
    expect(simulateShadowPolicy({ document: FORM, ...base, unresolvedVisualDisputes: 0, studies: [{ literalText: "Hemograma Completo", confidence: "medium" }] }).reasons).toContain("non_high_certainty_study");
    expect(simulateShadowPolicy({ document: FORM, unresolvedVisualDisputes: 0, studies: [], results: [], catalog, allowExplicitComposites: true }).reasons).toContain("no_requested_studies");
  });
});

describe("familias de estudios: el texto nombra solo una parte del estudio elegido", () => {
  const calcio = study("374", "CALCIO SERICO");
  const calcioIonico = study("373", "CALCIO IONICO");
  const calciuria = study("505", "CALCIURIA DE 24 HORAS - CALCIO EN ORINA 24 HORAS", "URIANALISIS");
  const cort8 = study("146", "CORTISOL 08:00 (CLIA)", "HORMONAS");
  const cort16 = study("147", "CORTISOL 16:00 (CLIA)", "HORMONAS");
  const cortOrina = study("511", "CORTISOL EN ORINA 24 HORAS", "URIANALISIS");
  const insBasal = study("159", "INSULINA BASAL (ECLIA)", "HORMONAS");
  const insPost = study("160", "INSULINA POST CARGA (2H) (ECLIA)", "HORMONAS");
  const curva = study("148", "CURVA DE INSULINA DE 5 MEDICIONES (ECLIA) INSULINA BASAL INSULINA (30 MIN)", "HORMONAS");
  const colHdl = study("376", "COLESTEROL HDL");
  const progesterona = study("164", "PROGESTERONA", "HORMONAS");
  const prog17 = study("163", "PROGESTERONA 17-OH", "HORMONAS");
  const hierro = study("402", "HIERRO SERICO");
  const perfilFerro = study("409", "PERFIL FERROCINETICO (HIERRO, FERRITINA, TRANSFERRINA, SATURACION DE TRANSFERRINA)");
  const saturacion = study("412", "SATURACION DE TRANSFERRINA (HIERRO, TRANSFERRINA)");
  const albumina = study("367", "ALBUMINA");
  const panelAlergia = study("4", "PANEL 4 MIXTO (IgE) 20 ALERGENOS ALIMENTICIOS: Leche, Albumina, Huevo, Maní, Soya, Trigo, Almendras, Avellana", "ALERGIAS");
  const familyCatalog = [calcio, calcioIonico, calciuria, cort8, cort16, cortOrina, insBasal, insPost, curva, colTotal, colHdl, progesterona, prog17, hierro, perfilFerro, saturacion, albumina, panelAlergia, glucosa, glucosaNeonatal, hemograma];
  const verify = (text: string, chosen: CatalogStudy) =>
    verifyDecision(text, { index: 0, status: "MATCH", studies: [chosen], alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [] }, familyCatalog);

  it.each([
    ["Calcio", calcio], ["Cortisol", cort8], ["Insulina", insBasal], ["Colesterol", colTotal]
  ])("'%s' elegido como una variante concreta -> AMBIGUOUS", (text, chosen) => {
    const outcome = verify(text, chosen);
    expect(outcome.kind).toBe("AMBIGUOUS");
    expect((outcome as { studyIds: string[] }).studyIds[0]).toBe(chosen.id);
    expect((outcome as { studyIds: string[] }).studyIds.length).toBeGreaterThan(1);
  });

  it("si el texto ya nombra el estudio completo no hay familia que desambiguar", () => {
    expect(verify("Glucosa", glucosa).kind).toBe("MATCH");
    expect(verify("Progesterona", progesterona).kind).toBe("MATCH");
    expect(verify("Colesterol HDL", colHdl).kind).toBe("MATCH");
    expect(verify("Albumina", albumina).kind).toBe("MATCH");
  });

  it("las equivalencias correctas no se degradan: sinónimos, abreviaturas y calificadores que sí distinguen", () => {
    expect(verify("Glicemia basal", glucosa).kind).toBe("MATCH");
    expect(verify("Hemog completo", hemograma).kind).toBe("MATCH");
    expect(verify("Calcio total", calcio).kind).toBe("MATCH");
    expect(verify("Calcio en suero", calcio).kind).toBe("MATCH");
    expect(verify("Calcio ionico", calcioIonico).kind).toBe("MATCH");
    expect(verify("Cortisol en orina", cortOrina).kind).toBe("MATCH");
    expect(verify("Insulina basal", insBasal).kind).toBe("MATCH");
  });

  it("'total' es redundante si el estudio no distingue libre/total, pero 'libre' exige respaldo", () => {
    expect(verify("Calcio total", calcio).kind).toBe("MATCH");
    const igg = study("429", "INMUNOGLOBULINA IgG");
    expect(verifyDecision("IgG Total", { index: 0, status: "MATCH", studies: [igg], alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [] }, [...familyCatalog, igg]).kind).toBe("MATCH");
    expect(verify("Calcio libre", calcio).kind).toBe("REJECTED");
  });

  it("un perfil o una lista de componentes entre paréntesis no cuenta como rival ('Hierro' sigue siendo el sérico)", () => {
    expect(verify("Hierro", hierro).kind).toBe("MATCH");
  });

  it("un panel largo que menciona el analito entre muchos otros no genera ambigüedad", () => {
    expect(familyCatalogRivals("Albumina serica")).toEqual([]);
  });

  function familyCatalogRivals(text: string) {
    return checkIdentity(text, albumina, familyCatalog).plausibleSiblings.map((s) => s.code);
  }

  it("el estudio neonatal no se vuelve rival de 'Glicemia' (población por defecto)", () => {
    expect(verify("Glicemia", glucosa).kind).toBe("MATCH");
  });
});

describe("señal de tipo de documento en la simulación", () => {
  const baseArgs = async () => {
    const results = (await run(["Hemograma Completo"], { "Hemograma Completo": { status: "MATCH", studies: [hemograma] } }).promise).results;
    return { unresolvedVisualDisputes: 0, studies: [{ literalText: "Hemograma Completo", confidence: "high" as const }], results, catalog, allowExplicitComposites: true };
  };

  it("formulario con marcas o solicitud impresa y documento completo -> permite AUTO", async () => {
    for (const documentType of ["MARK_DEPENDENT_FORM", "TEXT_EXPLICIT_REQUEST"] as const) {
      const sim = simulateShadowPolicy({ ...(await baseArgs()), document: { documentType, completeDocumentVisible: true } });
      expect(sim.decision).toBe("AUTO_SAFE");
    }
  });

  it("manuscrita, no es solicitud, tipo incierto o incompleta -> HUMAN_REVIEW aunque todo lo demás sea perfecto", async () => {
    const args = await baseArgs();
    const expectations: Array<[Parameters<typeof simulateShadowPolicy>[0]["document"], string]> = [
      [{ documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: true }, "handwritten_out_of_scope"],
      [{ documentType: "NOT_A_REQUEST", completeDocumentVisible: true }, "not_a_request"],
      [{ documentType: "UNKNOWN", completeDocumentVisible: true }, "document_type_uncertain"],
      [{ documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: false }, "document_not_complete"],
      [undefined, "document_type_uncertain"]
    ];
    for (const [document, reason] of expectations) {
      const sim = simulateShadowPolicy({ ...args, document });
      expect(sim.decision).toBe("HUMAN_REVIEW");
      expect(sim.reasons).toContain(reason);
      expect(sim.quote).toBeUndefined();
    }
  });
});

describe("cache", () => {
  it("la segunda ejecución idéntica no llama al modelo (CACHE HIT)", async () => {
    process.env.AI_CACHE = "on";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers = { Glicemia: { status: "MATCH" as const, studies: [glucosa] } };
    const first = run(["Glicemia"], answers);
    await first.promise;
    expect(first.complete).toHaveBeenCalledTimes(2);
    const second = run(["Glicemia"], answers);
    const batch = await second.promise;
    expect(second.complete).not.toHaveBeenCalled();
    expect(batch.cacheHits).toBe(2);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("CACHE HIT openai-catalog-shadow"));
    spy.mockRestore();
  });
});
