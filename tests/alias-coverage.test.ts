import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aliasesCsv, buildCoverage, checkTexts, checksCsv, findCompetitors, studiesCsv, validateCurated, verifySafeSet, type AliasState } from "../scripts/alias-coverage.js";
import type { AuditAlias } from "../scripts/audit-catalog-aliases.js";
import { CURATED, type CuratedGroup } from "../scripts/data/curated-aliases.js";
import type { LiveTest } from "../scripts/prepare-alias-batch1.js";
import { normalizeStudyKey } from "../src/consensus.js";

let counter = 0;
const test = (code: string, name: string, extra: Partial<LiveTest> = {}): LiveTest => {
  counter += 1;
  return {
    id: `uuid-${code}-${counter}`,
    code,
    name,
    normalized_name: normalizeStudyKey(name),
    category: "TEST",
    sample_type: "Suero",
    price_bs: 100 + counter,
    active: true,
    ...extra
  };
};
const alias = (text: string, lab_test_id: string): AuditAlias => ({ id: `a-${text}`, lab_test_id, alias: text, normalized_alias: normalizeStudyKey(text) });

const S = (code: string, hint: string, aliases: string[]): CuratedGroup => ({ status: "SEGURO", targets: [{ code, hint }], aliases });
const R = (code: string, hint: string, aliases: string[], note = "revisar"): CuratedGroup => ({ status: "REQUIERE_REVISION", targets: [{ code, hint }], aliases, note });
const A = (targets: Array<[string, string]>, aliases: string[], note = "varios"): CuratedGroup => ({
  status: "AMBIGUO",
  targets: targets.map(([code, hint]) => ({ code, hint })),
  aliases,
  note
});

const find = (result: ReturnType<typeof buildCoverage>, aliasText: string, code?: string) =>
  result.aliases.filter((a) => a.normalized === normalizeStudyKey(aliasText) && (code === undefined || a.code === code));
const stateOf = (result: ReturnType<typeof buildCoverage>, aliasText: string, code?: string): AliasState | undefined => find(result, aliasText, code)[0]?.state;

describe("validateCurated", () => {
  it("el diccionario real es consistente (destinos, notas, sin repetidos)", () => {
    expect(validateCurated(CURATED)).toEqual([]);
  });

  it("SEGURO exige 1 destino, AMBIGUO 2 o más, y lo no seguro exige nota", () => {
    const errors = validateCurated([
      { status: "SEGURO", targets: [{ code: "1", hint: "a" }, { code: "2", hint: "b" }], aliases: ["x"] },
      { status: "AMBIGUO", targets: [{ code: "1", hint: "a" }], aliases: ["y"], note: "n" },
      { status: "REQUIERE_REVISION", targets: [{ code: "1", hint: "a" }], aliases: ["z"] },
      { status: "SEGURO", targets: [{ code: "1", hint: "a" }], aliases: ["w", "W"] }
    ]);
    expect(errors.join("\n")).toContain("exactamente 1 destino");
    expect(errors.join("\n")).toContain("2 o más destinos");
    expect(errors.join("\n")).toContain("exige una nota");
    expect(errors.join("\n")).toContain("alias repetido");
  });
});

describe("buildCoverage: reglas de conflicto", () => {
  it("un sinónimo seguro único queda SEGURO", () => {
    const gluc = test("1", "GLUCOSA");
    const result = buildCoverage({ tests: [gluc], aliases: [], curated: [S("1", "glucosa", ["Glicemia", "Glucemia en Ayunas"])] });
    expect(stateOf(result, "Glicemia")).toBe("SEGURO");
    expect(result.studies[0]!.state).toBe("SEGURO");
  });

  it("el mismo alias para dos UUID es AMBIGUO en ambos y se reporta como conflicto compartido", () => {
    const a = test("1", "CORTISOL 08:00 (CLIA)");
    const b = test("2", "CORTISOL 16:00 (CLIA)");
    const result = buildCoverage({ tests: [a, b], aliases: [], curated: [S("1", "cortisol 08", ["Cortisol"]), S("2", "cortisol 16", ["Cortisol"])] });
    expect(find(result, "Cortisol").map((x) => x.state)).toEqual(["AMBIGUO", "AMBIGUO"]);
    expect(result.stats.conflictsByType.alias_compartido_entre_estudios).toBe(2);
  });

  it("un alias que coincide con el nombre oficial de OTRO estudio es AMBIGUO (aunque ese esté activo)", () => {
    const a = test("1", "LH (ECLIA)");
    const b = test("2", "LH");
    const result = buildCoverage({ tests: [a, b], aliases: [], curated: [S("1", "lh", ["LH"])] });
    expect(stateOf(result, "LH", "1")).toBe("AMBIGUO");
    expect(find(result, "LH")[0]!.conflicts).toContain("nombre_oficial_de_otro_estudio");
  });

  it("un alias que ya existe para OTRO estudio es AMBIGUO", () => {
    const a = test("1", "UREA");
    const b = test("2", "BUN DE UREA");
    const result = buildCoverage({ tests: [a, b], aliases: [alias("Nitrogeno Ureico", b.id)], curated: [S("1", "urea", ["Nitrogeno Ureico"])] });
    expect(stateOf(result, "Nitrogeno Ureico", "1")).toBe("AMBIGUO");
  });

  it("un alias que ya existe para el MISMO estudio, o que repite el nombre oficial, se descarta", () => {
    const t4 = test("1", "T4 LIBRE (ECLIA)");
    const result = buildCoverage({ tests: [t4], aliases: [alias("T4L", t4.id)], curated: [S("1", "t4 libre", ["T4L", "T4 Libre Eclia"])] });
    expect(find(result, "T4L")).toHaveLength(0);
    expect(find(result, "T4 Libre Eclia")).toHaveLength(0);
    expect(result.stats.alreadyExistingDropped).toBe(1);
    expect(result.stats.redundantDropped).toBe(1);
  });

  it("variante competidora: 'TOXO IgG' pasa a AMBIGUO si existe 'INMUNO TOXO IgG' (el batch 1 lo habría aprobado)", () => {
    const elisa = test("238", "TOXO IgG (ELISA)");
    const inmuno = test("231", "INMUNO TOXO IgG");
    const result = buildCoverage({ tests: [elisa, inmuno], aliases: [], curated: [] });
    const row = find(result, "TOXO IgG", "238")[0]!;
    expect(row.state).toBe("AMBIGUO");
    expect(row.conflicts).toContain("variante_competidora");
    expect(row.competitors.map((c) => c.code)).toContain("231");
    expect(row.downgradedFrom).toBe("SEGURO");
    expect(result.stats.batch1Downgraded).toBeGreaterThan(0);
  });

  it("variante competidora: 'TSH' con ECLIA, FIA y neonatal; 'Magnesio' con la variante en orina", () => {
    const tests = [test("178", "TSH (ECLIA)"), test("179", "TSH (FIA Fluorescencia)"), test("180", "TSH NEONATAL"), test("408", "MAGNESIO (Mg)"), test("518", "MAGNESIO en Orina de 24 Hrs.")];
    const result = buildCoverage({ tests, aliases: [], curated: [S("178", "tsh eclia", ["TSH"]), S("408", "magnesio", ["Magnesio"])] });
    expect(stateOf(result, "TSH")).toBe("AMBIGUO");
    expect(find(result, "TSH")[0]!.competitors.map((c) => c.code).sort()).toEqual(["179", "180"]);
    expect(stateOf(result, "Magnesio")).toBe("AMBIGUO");
  });

  it("no hay competidor si lo que sobra no es método/calificador (T4 libre vs T4 total son distintos)", () => {
    const tests = [test("172", "T4 LIBRE (ECLIA)"), test("174", "T4 TOTAL (ECLIA)")];
    const active = tests;
    expect(findCompetitors("t4 libre", tests[0]!, active)).toEqual([]);
    const result = buildCoverage({ tests, aliases: [], curated: [S("172", "t4 libre", ["Tiroxina Libre"]), S("174", "t4 total", ["Tiroxina Total"])] });
    expect(stateOf(result, "Tiroxina Libre")).toBe("SEGURO");
    expect(stateOf(result, "Tiroxina Total")).toBe("SEGURO");
  });

  it("'cuantitativo' no compite con 'semi cuantitativo' (son calificadores distintos)", () => {
    const tests = [test("476", "PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)"), test("475", "PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO"), test("474", "PROTEINA C REACTIVA (PCR CUALITATIVO)")];
    const result = buildCoverage({ tests, aliases: [], curated: [] });
    expect(stateOf(result, "PROTEINA C REACTIVA (PCR CUANTITATIVO)", "476")).toBe("SEGURO");
    expect(findCompetitors("proteina c reactiva pcr", tests[0]!, tests).map((c) => c.code).sort()).toEqual(["474", "475"]);
  });

  it("cuenta aliases distintos aparte de las filas alias→estudio", () => {
    const a = test("1", "CORTISOL 08:00 (CLIA)");
    const b = test("2", "CORTISOL 16:00 (CLIA)");
    const result = buildCoverage({ tests: [a, b], aliases: [], curated: [A([["1", "cortisol 08"], ["2", "cortisol 16"]], ["Cortisol"])] });
    expect(find(result, "Cortisol")).toHaveLength(2);
    expect(result.stats.distinctByState.AMBIGUO).toBeGreaterThanOrEqual(1);
    expect(result.stats.distinctAliases).toBeLessThan(result.stats.proposedTotal);
  });

  it("los grupos AMBIGUO y REQUIERE_REVISION nunca terminan como SEGURO", () => {
    const tests = [test("1", "ANCA C PR3 ELISA"), test("2", "ANCA C PR3 IFI"), test("3", "HEMOGLOBINA")];
    const result = buildCoverage({
      tests,
      aliases: [],
      curated: [A([["1", "anca c"], ["2", "anca c"]], ["ANCA C"]), R("3", "hemoglobina", ["Hb"], "otras hemoglobinas")]
    });
    expect(find(result, "ANCA C").map((x) => x.state)).toEqual(["AMBIGUO", "AMBIGUO"]);
    expect(stateOf(result, "Hb")).toBe("REQUIERE_REVISION");
  });

  it("una curación SEGURO promueve un candidato derivado (head/sigla), pero no uno ambiguo de la auditoría", () => {
    const vit = test("528", "VITAMINA B2 (Rivoflavina)");
    const promoted = buildCoverage({ tests: [vit], aliases: [], curated: [S("528", "vitamina b2", ["VITAMINA B2"])] });
    expect(stateOf(promoted, "VITAMINA B2")).toBe("SEGURO");
    const notPromoted = buildCoverage({ tests: [vit], aliases: [], curated: [] });
    expect(stateOf(notPromoted, "VITAMINA B2")).toBe("REQUIERE_REVISION");
  });

  it("hint que no coincide o code inexistente -> error de curación y no se propone nada", () => {
    const t = test("1", "GLUCOSA");
    const result = buildCoverage({ tests: [t], aliases: [], curated: [S("1", "otra cosa", ["Glicemia"]), S("99", "x", ["Y"])] });
    expect(result.curationErrors.join("\n")).toContain('no contiene "otra cosa"');
    expect(result.curationErrors.join("\n")).toContain("code 99");
    expect(find(result, "Glicemia")).toHaveLength(0);
  });

  it("un estudio inactivo no recibe aliases ni cuenta para conflictos", () => {
    const active = test("1", "FERRITINA (CLIA)");
    const inactive = test("2", "FERRITINA (FIA Fluorescencia)", { active: false });
    const result = buildCoverage({ tests: [active, inactive], aliases: [] });
    expect(result.stats.activeStudies).toBe(1);
    expect(stateOf(result, "FERRITINA", "1")).toBe("SEGURO");
  });

  it("estudios sin propuesta quedan como SIN_ALIAS_NUEVO y el resumen suma todos los activos", () => {
    const result = buildCoverage({ tests: [test("1", "GLUCOSA"), test("2", "ALBUMINA")], aliases: [], curated: [S("1", "glucosa", ["Glicemia"])] });
    expect(result.studies.map((s) => s.state)).toEqual(["SEGURO", "SIN_ALIAS_NUEVO"]);
    const s = result.stats;
    expect(s.studiesWithSafeNew + s.studiesWithOnlyUnsafe + s.studiesWithNothingNew).toBe(s.activeStudies);
  });
});

describe("checkTexts", () => {
  const tests = [test("397", "GLUCOSA"), test("418", "TRANSAMINASA GOT"), test("419", "TRANSAMINASA GPT"), test("178", "TSH (ECLIA)"), test("179", "TSH (FIA Fluorescencia)")];
  const curated = [S("397", "glucosa", ["Glicemia Basal"]), R("178", "tsh eclia", ["TSH"], "3 variantes")];

  it("hoy UNMATCHED; con aliases SEGUROS MATCHED; lo no seguro solo se informa", () => {
    const coverage = buildCoverage({ tests, aliases: [], curated });
    const rows = checkTexts({ tests, aliases: [], coverage, texts: [{ text: "GLICEMIA BASAL", origin: "receta x" }, { text: "TSH", origin: "receta x" }] });
    expect(rows[0]).toMatchObject({ today: "UNMATCHED" });
    expect(rows[0]!.withSafeAliases).toMatch(/^MATCHED 397 GLUCOSA/);
    expect(rows[1]!.withSafeAliases).toBe("UNMATCHED");
    expect(rows[1]!.unsafeProposals.join()).toContain("AMBIGUO");
  });

  it("marca los textos compuestos con sus componentes (no se resuelven con un alias)", () => {
    const coverage = buildCoverage({ tests, aliases: [], curated: [] });
    const rows = checkTexts({ tests, aliases: [], coverage, texts: [{ text: "TRANSAMINASAS GOT/GPT", origin: "formulario" }] });
    expect(rows[0]!.withSafeAliases).toBe("UNMATCHED");
    expect(rows[0]!.composite).toContain("418 TRANSAMINASA GOT");
    expect(rows[0]!.composite).toContain("419 TRANSAMINASA GPT");
  });

  it("deduplica textos repetidos entre recetas y acumula el origen", () => {
    const coverage = buildCoverage({ tests, aliases: [], curated });
    const rows = checkTexts({ tests, aliases: [], coverage, texts: [{ text: "Glicemia Basal", origin: "receta a" }, { text: "GLICEMIA BASAL", origin: "receta b" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("receta a + receta b");
  });
});

describe("verifySafeSet", () => {
  it("el conjunto SEGURO resuelve cada alias a su propio estudio", () => {
    const tests = [test("397", "GLUCOSA"), test("398", "GLUCOSA NEONATAL"), test("418", "TRANSAMINASA GOT")];
    const coverage = buildCoverage({ tests, aliases: [], curated: [S("397", "glucosa", ["Glicemia"]), S("418", "transaminasa got", ["GOT", "AST"])] });
    expect(verifySafeSet({ tests, aliases: [], coverage })).toEqual([]);
  });

  it("detecta un SEGURO que, junto con los demás, no resolvería a su estudio", () => {
    const tests = [test("1", "GLUCOSA"), test("2", "UREA")];
    const coverage = buildCoverage({ tests, aliases: [], curated: [S("1", "glucosa", ["Glicemia"])] });
    // Se fuerza una colisión: el alias también existe ya como alias de otro estudio.
    const clash = [alias("Glicemia", tests[1]!.id)];
    expect(verifySafeSet({ tests, aliases: clash, coverage }).join()).toContain("Glicemia");
  });
});

describe("CSV y seguridad del script", () => {
  it("los CSV traen los encabezados pedidos y escapan comillas", () => {
    const t = test("1", 'GLUCOSA "especial"');
    const coverage = buildCoverage({ tests: [t], aliases: [], curated: [S("1", "glucosa", ["Glicemia"])] });
    const studies = studiesCsv(coverage);
    expect(studies).toContain("codigo,uuid,nombre_oficial");
    expect(studies).toContain("aliases_existentes");
    expect(studies).toContain("aliases_nuevos_propuestos");
    expect(studies).toContain("justificacion");
    expect(studies).toContain('"GLUCOSA ""especial"""');
    expect(studies).toContain("Glicemia [SEGURO]");
    expect(aliasesCsv(coverage)).toContain("alias_propuesto");
    expect(checksCsv([])).toContain("compuesto_requiere_politica");
  });

  it("el estado REQUIERE_REVISION se escribe con acento en los CSV", () => {
    const t = test("1", "HEMOGLOBINA");
    const coverage = buildCoverage({ tests: [t], aliases: [], curated: [R("1", "hemoglobina", ["Hb"])] });
    expect(aliasesCsv(coverage)).toContain("REQUIERE_REVISIÓN");
  });

  it("el script y los datos solo usan GET y no hay escrituras a Supabase", () => {
    for (const file of ["../scripts/alias-coverage.ts", "../scripts/data/curated-aliases.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/method:\s*"(POST|PATCH|PUT|DELETE)"/);
    }
    expect(readFileSync(new URL("../scripts/alias-coverage.ts", import.meta.url), "utf8")).toContain('method: "GET"');
  });
});
