import { describe, expect, it } from "vitest";
import type { CatalogStudy } from "@core/types";
import { priceCatalog } from "@/lib/catalog-server";
import { buildTariffTemplateCsv, matchTariffRows, parseTariffCsv } from "@/lib/tariff-csv";

const core: CatalogStudy[] = [
  { id: "b", code: "GLI01", name: "Glicemia", normalizedName: "glicemia", normalizedAliases: ["glucosa"], priceBs: 20, active: true, sampleType: "Suero" },
  { id: "a", code: "HEM01", name: "Hemograma completo", normalizedName: "hemograma completo", normalizedAliases: [], priceBs: 50, active: true },
  { id: "c", code: null, name: "Ácido úrico; suero", normalizedName: "acido urico suero", normalizedAliases: [], priceBs: 30, active: true },
  { id: "x", code: "OLD", name: "Inactivo", normalizedName: "inactivo", normalizedAliases: [], priceBs: 1, active: false }
];

describe("catálogo con tarifa", () => {
  it("usa el precio de la tarifa y cae al precio Paciente; excluye inactivos y ordena por nombre", () => {
    const payload = priceCatalog(core, new Map([["a", 40]]), "Convenio A");
    expect(payload.tariffName).toBe("Convenio A");
    expect(payload.studies.map((study) => [study.name, study.priceBs])).toEqual([
      ["Ácido úrico; suero", 30],
      ["Glicemia", 20],
      ["Hemograma completo", 40]
    ]);
    expect(payload.studies[1]).toMatchObject({ aliases: ["glucosa"], sampleType: "Suero" });
  });

  it("la versión (ETag) cambia solo si cambian precios, estudios o tarifa", () => {
    const base = priceCatalog(core, new Map([["a", 40]]), "Convenio A").version;
    expect(priceCatalog(core, new Map([["a", 40]]), "Convenio A").version).toBe(base);
    expect(priceCatalog(core, new Map([["a", 41]]), "Convenio A").version).not.toBe(base);
    expect(priceCatalog(core, new Map([["a", 40]]), "Convenio B").version).not.toBe(base);
  });
});

describe("plantilla de tarifa", () => {
  it("lo que se exporta se puede editar y volver a importar tal cual", () => {
    const csv = buildTariffTemplateCsv(core.filter((study) => study.active), new Map([["a", 40]]));
    expect(csv.startsWith("\uFEFFid;codigo;nombre;precio_paciente;precio\r\n")).toBe(true);
    // Simula la edición en Excel: precio para el ácido úrico (nombre con ";" entre comillas).
    const edited = csv.replace('"Ácido úrico; suero";30,00;', '"Ácido úrico; suero";30,00;27,50');
    const parsed = parseTariffCsv(edited);
    expect(parsed.errors).toEqual([]);
    expect(parsed.skipped).toBe(1);
    const match = matchTariffRows(parsed.rows, core.map((study) => ({ id: study.id, code: study.code, name: study.name, normalizedName: study.normalizedName })));
    expect(match.matched.map((row) => [row.labTestId, row.price, row.by])).toEqual([["c", 27.5, "id"], ["a", 40, "id"]]);
    expect(match.unmatched).toEqual([]);
  });
});
