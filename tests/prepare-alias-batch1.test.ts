import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalToCsv, evaluateBatch1, type LiveTest } from "../scripts/prepare-alias-batch1.js";
import { auditCatalog, type AuditAlias } from "../scripts/audit-catalog-aliases.js";
import { normalizeStudyKey } from "../src/consensus.js";

let counter = 0;
const live = (name: string, extra: Partial<LiveTest> = {}): LiveTest => {
  counter += 1;
  return {
    id: `uuid-${counter}`,
    code: String(counter),
    name,
    normalized_name: normalizeStudyKey(name),
    category: "HORMONAS",
    sample_type: "Suero 500 ul",
    price_bs: 90,
    active: true,
    ...extra
  };
};
const alias = (text: string, lab_test_id: string): AuditAlias => ({ id: `a-${text}`, lab_test_id, alias: text, normalized_alias: normalizeStudyKey(text) });

// El reporte sale de auditCatalog sobre el catálogo "de la auditoría"; los datos en vivo pueden traer cambios posteriores
// (estudios o aliases nuevos), que es justo lo que el batch debe volver a comprobar aunque la auditoría diera "high".
function run(
  tests: LiveTest[],
  aliases: AuditAlias[] = [],
  later: { mutate?: (tests: LiveTest[]) => LiveTest[]; extraTests?: LiveTest[]; extraAliases?: AuditAlias[] } = {}
) {
  const report = auditCatalog(tests, aliases);
  const liveTests = [...(later.mutate ? later.mutate(tests) : tests), ...(later.extraTests ?? [])];
  return evaluateBatch1({ report, liveTests, liveAliases: [...aliases, ...(later.extraAliases ?? [])] });
}
const byName = (rows: ReturnType<typeof run>, name: string) => rows.find((row) => row.officialName === name)!;

describe("evaluateBatch1", () => {
  it("APPROVE cuando solo se quita un método estricto y no hay variantes ni colisiones", () => {
    const rows = run([live("FSH (ECLIA)", { price_bs: 90 }), live("Glucosa")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      decision: "APPROVE",
      proposedAlias: "FSH",
      normalizedAlias: "fsh",
      removed: "(ECLIA)",
      priceBs: 90,
      category: "HORMONAS",
      sampleType: "Suero 500 ul",
      reasons: []
    });
  });

  it("solo evalúa SAFE + high (ignora head/acronym y los ambiguos)", () => {
    const rows = run([live("Tiroxina Globular (TGB)"), live("TSH (ECLIA)"), live("TSH (FIA Fluorescencia)")]);
    expect(rows).toHaveLength(0);
  });

  it("REVIEW_REQUIRED si existe una variante neonatal del mismo estudio", () => {
    const rows = run([live("T3 LIBRE (ECLIA)")], [], { extraTests: [live("T3 LIBRE NEONATAL")] });
    expect(byName(rows, "T3 LIBRE (ECLIA)").decision).toBe("REVIEW_REQUIRED");
    expect(byName(rows, "T3 LIBRE (ECLIA)").reasons.join()).toContain("variante");
  });

  it("REVIEW_REQUIRED si existe una variante activa con otro método", () => {
    const rows = run([live("CA 125 (ECLIA)")], [], { extraTests: [live("CA 125 (IFI)")] });
    const row = byName(rows, "CA 125 (ECLIA)");
    expect(row.decision).toBe("REVIEW_REQUIRED");
    expect(row.reasons.join()).toContain("otra variante con la misma forma sin método");
  });

  it("REVIEW_REQUIRED si el método no está en la lista estricta (p. ej. IFI, PCR)", () => {
    const rows = run([live("ANA (IFI)"), live("Algo")]);
    const row = byName(rows, "ANA (IFI)");
    expect(row.decision).toBe("REVIEW_REQUIRED");
    expect(row.reasons.join()).toContain("lista estricta");
  });

  it("REVIEW_REQUIRED si el alias coincide con el normalized_name o alias de otro UUID (incluso inactivo)", () => {
    const rowsName = run([live("LH (ECLIA)")], [], { extraTests: [live("LH", { active: false })] });
    expect(byName(rowsName, "LH (ECLIA)").decision).toBe("REVIEW_REQUIRED");
    expect(byName(rowsName, "LH (ECLIA)").reasons.join()).toContain("normalized_name de otro UUID (inactivo)");

    const other = live("Otro");
    const prolactin = live("PROLACTINA (ECLIA)");
    const rowsAlias = run([prolactin, other], [], { extraAliases: [alias("Prolactina", other.id)] });
    expect(byName(rowsAlias, "PROLACTINA (ECLIA)").reasons.join()).toContain("alias de otro UUID");
  });

  it("REVIEW_REQUIRED si el alias es prefijo del nombre de otro estudio activo (p. ej. variante por población)", () => {
    const rows = run([live("BETA HCG-CUANTITATIVA (FIA Fluorescencia)"), live("BETA HCG-CUANTITATIVA - VARON (FIA Fluorescencia)")]);
    const row = byName(rows, "BETA HCG-CUANTITATIVA (FIA Fluorescencia)");
    expect(row.decision).toBe("REVIEW_REQUIRED");
    expect(row.reasons.join()).toContain("prefijo del nombre de otro estudio activo");
    expect(row.relatedActive.map((r) => r.name)).toEqual(["BETA HCG-CUANTITATIVA - VARON (FIA Fluorescencia)"]);
    // La variante más larga sí es APPROVE: su alias no es prefijo de nadie.
    expect(byName(rows, "BETA HCG-CUANTITATIVA - VARON (FIA Fluorescencia)").decision).toBe("APPROVE");
  });

  it("que el nombre de OTRO estudio sea raíz más corta del alias se lista pero no bloquea", () => {
    const rows = run([live("HEMOGLOBINA GLICOSILADA (FIA Fluorescencia)"), live("HEMOGLOBINA")]);
    const row = byName(rows, "HEMOGLOBINA GLICOSILADA (FIA Fluorescencia)");
    expect(row.decision).toBe("APPROVE");
    expect(row.relatedActive.map((r) => [r.name, r.relation])).toEqual([["HEMOGLOBINA", "su nombre es raíz del alias"]]);
  });

  it("REVIEW_REQUIRED si los datos en vivo cambiaron o el estudio dejó de estar activo", () => {
    const tests = [live("FSH (ECLIA)"), live("Glucosa")];
    const renamed = run(tests, [], { mutate: (list) => list.map((t) => (t.name === "FSH (ECLIA)" ? { ...t, name: "FSH (ECLIA) v2", normalized_name: "fsh eclia v2" } : t)) });
    expect(renamed[0]!.reasons.join()).toContain("nombre cambió");

    const inactive = run(tests, [], { mutate: (list) => list.map((t) => (t.name === "FSH (ECLIA)" ? { ...t, active: false } : t)) });
    expect(inactive[0]!.reasons.join()).toContain("ya no está activo");
  });

  it("no quita isotipo ni calificadores: 'TOXO IgM (ELISA)' -> 'TOXO IgM'; IgG e IgM quedan separados", () => {
    const rows = run([live("TOXO IgM (ELISA)"), live("TOXO IgG (ELISA)")]);
    expect(rows.map((r) => [r.proposedAlias, r.decision])).toEqual([
      ["TOXO IgM", "APPROVE"],
      ["TOXO IgG", "APPROVE"]
    ]);
  });

  it("REVIEW_REQUIRED si el alias ya existe (mismo UUID) desde la auditoría", () => {
    const t = live("FSH (ECLIA)");
    const rows = run([t], [], { extraAliases: [alias("FSH", t.id)] });
    expect(rows[0]!.decision).toBe("REVIEW_REQUIRED");
    expect(rows[0]!.reasons.join()).toContain("mismo UUID");
  });

  it("incluye aliases actuales del mismo UUID y el precio en vivo", () => {
    const t4 = live("T4 LIBRE (ECLIA)", { price_bs: 120 });
    const rows = run([t4], [alias("T4L", t4.id)]);
    expect(rows[0]!.currentAliases).toEqual(["T4L"]);
    expect(rows[0]!.priceBs).toBe(120);
  });

  it("el CSV escapa comillas y el script no escribe (solo GET)", () => {
    const rows = run([live('Estudio "raro" (ECLIA)')]);
    expect(approvalToCsv(rows)).toContain('"Estudio ""raro"" (ECLIA)"');
    const source = readFileSync(new URL("../scripts/prepare-alias-batch1.ts", import.meta.url), "utf8");
    expect(source).toContain('method: "GET"');
    expect(source).not.toMatch(/method:\s*"(POST|PATCH|PUT|DELETE)"/);
  });
});
