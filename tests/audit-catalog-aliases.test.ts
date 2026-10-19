import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditCatalog, spreadSample, toCsv, type AuditAlias, type AuditTest } from "../scripts/audit-catalog-aliases.js";
import { normalizeStudyKey } from "../src/consensus.js";

let counter = 0;
const test = (name: string, extra: Partial<AuditTest> = {}): AuditTest => {
  counter += 1;
  return {
    id: `uuid-${counter}`,
    code: String(counter),
    name,
    normalized_name: normalizeStudyKey(name),
    category: "HORMONAS",
    sample_type: "Suero",
    active: true,
    ...extra
  };
};
const alias = (alias: string, lab_test_id: string): AuditAlias => ({
  id: `a-${alias}`,
  lab_test_id,
  alias,
  normalized_alias: normalizeStudyKey(alias)
});

const entriesOf = (result: ReturnType<typeof auditCatalog>, name: string) =>
  result.studies.find((study) => study.name === name)!.entries;

describe("auditCatalog", () => {
  it("quitar solo el método da SAFE cuando es único", () => {
    const fsh = test("FSH (ECLIA)");
    const entries = entriesOf(auditCatalog([fsh, test("Glucosa")], []), "FSH (ECLIA)");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ candidate: "FSH", normalizedCandidate: "fsh", generator: "method_stripped", status: "SAFE_ALIAS_CANDIDATE" });
  });

  it("el mismo estudio con distinto método es AMBIGUOUS en ambos (misma forma corta)", () => {
    const result = auditCatalog([test("TSH (ECLIA)"), test("TSH (FIA Fluorescencia)")], []);
    for (const name of ["TSH (ECLIA)", "TSH (FIA Fluorescencia)"]) {
      const [entry] = entriesOf(result, name);
      expect(entry).toMatchObject({ normalizedCandidate: "tsh", status: "AMBIGUOUS" });
      expect(entry!.collisions.map((c) => c.via)).toContain("same_candidate_from_other_study");
    }
  });

  it("una variante neonatal hace AMBIGUOUS la forma corta del estudio base", () => {
    const result = auditCatalog([test("TSH (ECLIA)"), test("TSH NEONATAL")], []);
    const [entry] = entriesOf(result, "TSH (ECLIA)");
    expect(entry).toMatchObject({ normalizedCandidate: "tsh", status: "AMBIGUOUS" });
    expect(entry!.collisions.map((c) => c.via)).toEqual(["variant_sibling"]);
  });

  it("libre/total no se mezclan: cada variante lleva su calificador y es SAFE", () => {
    const result = auditCatalog([test("T4 LIBRE (ECLIA)"), test("T4 TOTAL (ECLIA)")], []);
    expect(entriesOf(result, "T4 LIBRE (ECLIA)")[0]).toMatchObject({ normalizedCandidate: "t4 libre", status: "SAFE_ALIAS_CANDIDATE" });
    expect(entriesOf(result, "T4 TOTAL (ECLIA)")[0]).toMatchObject({ normalizedCandidate: "t4 total", status: "SAFE_ALIAS_CANDIDATE" });
  });

  it("IgG e IgM nunca se unifican", () => {
    const result = auditCatalog([test("TOXO IgG (ELISA)"), test("TOXO IgM (ELISA)")], []);
    expect(entriesOf(result, "TOXO IgG (ELISA)")[0]).toMatchObject({ normalizedCandidate: "toxo igg", status: "SAFE_ALIAS_CANDIDATE" });
    expect(entriesOf(result, "TOXO IgM (ELISA)")[0]).toMatchObject({ normalizedCandidate: "toxo igm", status: "SAFE_ALIAS_CANDIDATE" });
  });

  it("un calificador entre paréntesis (prueba rápida, cuantitativo) nunca se quita", () => {
    const result = auditCatalog([test("HIV (PRUEBA RAPIDA)"), test("HIV (CUANTITATIVO)")], []);
    expect(entriesOf(result, "HIV (PRUEBA RAPIDA)")[0]!.status).toBe("NO_ALIAS_NEEDED");
    expect(entriesOf(result, "HIV (CUANTITATIVO)")[0]!.status).toBe("NO_ALIAS_NEEDED");
  });

  it("la parte antes del paréntesis es un candidato verificable y la sigla se detecta", () => {
    const result = auditCatalog([test("Tiroxina Globular de Trasporte (TGB)")], []);
    const entries = entriesOf(result, "Tiroxina Globular de Trasporte (TGB)");
    expect(entries.map((e) => [e.normalizedCandidate, e.generator, e.status])).toEqual([
      ["tiroxina globular de trasporte", "head_before_parenthesis", "SAFE_ALIAS_CANDIDATE"],
      ["tgb", "acronym_in_parenthesis", "SAFE_ALIAS_CANDIDATE"]
    ]);
  });

  it("una sigla compartida por varios estudios es AMBIGUOUS", () => {
    const result = auditCatalog([test("Virus Citomegalovirus IgG (CMV)"), test("Virus Citomegalovirus IgM (CMV)")], []);
    const acronym = entriesOf(result, "Virus Citomegalovirus IgG (CMV)").find((e) => e.generator === "acronym_in_parenthesis")!;
    expect(acronym).toMatchObject({ normalizedCandidate: "cmv", status: "AMBIGUOUS" });
  });

  it("perfiles/paneles/listas de componentes requieren política", () => {
    const result = auditCatalog(
      [test("PERFIL FERROCINETICO (HIERRO, FERRITINA, TRANSFERRINA)"), test("IONOGRAMA EN ORINA (Sodio, Cloro, Potasio)")],
      []
    );
    for (const study of result.studies) {
      expect(study.composite).toBe(true);
      expect(study.entries.some((e) => e.status === "COMPOSITE_POLICY_REQUIRED")).toBe(true);
    }
  });

  it("los aliases existentes se reconocen como ALREADY_COVERED y no se vuelven a proponer", () => {
    const t4 = test("T4 LIBRE (ECLIA)");
    const result = auditCatalog([t4], [alias("T4 Libre", t4.id), alias("T4L", t4.id)]);
    const entries = entriesOf(result, "T4 LIBRE (ECLIA)");
    expect(entries.map((e) => [e.candidate, e.status])).toEqual([
      ["T4 Libre", "ALREADY_COVERED"],
      ["T4L", "ALREADY_COVERED"]
    ]);
    // "t4 libre" (derivado) ya existe como alias del mismo UUID: no aparece como candidato nuevo.
    expect(entries.filter((e) => e.status === "SAFE_ALIAS_CANDIDATE")).toHaveLength(0);
  });

  it("una forma corta que ya es alias de OTRO UUID es AMBIGUOUS", () => {
    const fsh = test("FSH (ECLIA)");
    const other = test("Otro estudio");
    const result = auditCatalog([fsh, other], [alias("FSH", other.id)]);
    const [entry] = entriesOf(result, "FSH (ECLIA)");
    expect(entry).toMatchObject({ status: "AMBIGUOUS" });
    expect(entry!.collisions[0]!.via).toBe("existing_alias");
  });

  it("una forma corta igual al normalized_name de otro estudio activo es AMBIGUOUS, pero no si ese está inactivo", () => {
    const active = auditCatalog([test("LH (ECLIA)"), test("LH")], []);
    expect(entriesOf(active, "LH (ECLIA)")[0]!.status).toBe("AMBIGUOUS");
    const inactive = auditCatalog([test("LH (ECLIA)"), test("LH", { active: false })], []);
    expect(entriesOf(inactive, "LH (ECLIA)")[0]!.status).toBe("SAFE_ALIAS_CANDIDATE");
    expect(inactive.summary.activeStudies).toBe(1);
    expect(inactive.summary.totalTests).toBe(2);
  });

  it("la muestra es un calificador: 'Magnesio' sérico es AMBIGUOUS si existe 'Magnesio en orina de 24 hrs'", () => {
    const result = auditCatalog([test("MAGNESIO (Mg)"), test("MAGNESIO en Orina de 24 Hrs.")], []);
    const head = entriesOf(result, "MAGNESIO (Mg)").find((e) => e.normalizedCandidate === "magnesio")!;
    expect(head.status).toBe("AMBIGUOUS");
    expect(head.collisions.map((c) => c.via)).toEqual(["variant_sibling"]);
  });

  it("un paréntesis de muestra (HECES) no se quita", () => {
    const result = auditCatalog([test("HELICOBACTER PYLORI (HECES)")], []);
    expect(entriesOf(result, "HELICOBACTER PYLORI (HECES)")[0]!.status).toBe("NO_ALIAS_NEEDED");
  });

  it("un nombre con muchos paréntesis (lista de componentes) es compuesto", () => {
    const result = auditCatalog([test("GENES DE RESISTENCIA A (NDM), B (OXA), C (KPC), D (IMP), E (mecA)")], []);
    expect(result.studies[0]!.composite).toBe(true);
    expect(result.studies[0]!.entries.every((e) => e.status !== "SAFE_ALIAS_CANDIDATE")).toBe(true);
  });

  it("method_stripped tiene confianza high y head/acronym review", () => {
    const result = auditCatalog([test("FSH (ECLIA)"), test("Tiroxina Globular de Trasporte (TGB)")], []);
    expect(entriesOf(result, "FSH (ECLIA)")[0]!.confidence).toBe("high");
    expect(entriesOf(result, "Tiroxina Globular de Trasporte (TGB)").map((e) => e.confidence)).toEqual(["review", "review"]);
  });

  it("un nombre sin forma corta derivable es NO_ALIAS_NEEDED", () => {
    const result = auditCatalog([test("Glucosa")], []);
    expect(entriesOf(result, "Glucosa")[0]).toMatchObject({ candidate: null, status: "NO_ALIAS_NEEDED" });
  });

  it("reporta aliases existentes con problemas (UUID inactivo o inexistente, doble destino)", () => {
    const inactive = test("Viejo", { active: false });
    const live = test("Vivo");
    const result = auditCatalog([inactive, live], [alias("X", inactive.id), alias("Y", "uuid-fantasma"), alias("Z", live.id), alias("z", inactive.id)]);
    const text = result.existingAliasIssues.join("\n");
    expect(text).toContain("inactivo");
    expect(text).toContain("inexistente");
    expect(text).toContain("más de un UUID");
  });

  it("los conteos del resumen suman las entradas y el rollup suma los estudios activos", () => {
    const t4 = test("T4 LIBRE (ECLIA)");
    const result = auditCatalog([t4, test("FSH (ECLIA)"), test("Glucosa"), test("TSH (ECLIA)"), test("TSH (FIA)")], [alias("T4L", t4.id)]);
    const entriesTotal = Object.values(result.summary.entriesByStatus).reduce((a, b) => a + b, 0);
    expect(entriesTotal).toBe(result.studies.reduce((sum, study) => sum + study.entries.length, 0));
    expect(Object.values(result.summary.studiesByRollup).reduce((a, b) => a + b, 0)).toBe(result.summary.activeStudies);
  });

  it("toCsv escapa comillas y spreadSample reparte la muestra", () => {
    const csv = toCsv(auditCatalog([test('Estudio "raro" (ECLIA)')], []));
    expect(csv).toContain('"Estudio ""raro"" (ECLIA)"');
    expect(spreadSample(Array.from({ length: 100 }, (_, i) => i), 5)).toEqual([0, 20, 40, 60, 80]);
    expect(spreadSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("el script no contiene operaciones de escritura (solo GET)", () => {
    const source = readFileSync(new URL("../scripts/audit-catalog-aliases.ts", import.meta.url), "utf8");
    expect(source).toContain('method: "GET"');
    expect(source).not.toMatch(/method:\s*"(POST|PATCH|PUT|DELETE)"/);
  });
});
