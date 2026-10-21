import { describe, expect, it } from "vitest";
import { formatBs, formatDate, formatFolio } from "@/lib/format";
import { matchTariffRows, parsePrice, parseTariffCsv } from "@/lib/tariff-csv";
import { buildWhatsAppText } from "@/lib/whatsapp-text";

describe("formatos", () => {
  it("bolivianos con coma decimal y separador de miles", () => {
    expect(formatBs(1234.5)).toBe("Bs 1.234,50");
    expect(formatBs(20)).toBe("Bs 20,00");
  });
  it("folio y fechas de calendario sin corrimiento de zona horaria", () => {
    expect(formatFolio(123)).toBe("PM-000123");
    expect(formatDate("2026-11-18")).toBe("18/11/2026");
  });
});

describe("texto para WhatsApp", () => {
  const quote = {
    folio: 42,
    patientName: "Juan Pérez",
    createdAt: "2026-10-19",
    validUntil: "2026-11-18",
    totalBs: 70,
    items: [{ name: "Hemograma completo", priceBs: 50 }, { name: "Glicemia", priceBs: 20 }]
  };

  it("arma el mensaje con folio, paciente, ítems, total y validez", () => {
    expect(buildWhatsAppText(quote, { name: "PlusMedik" })).toBe([
      "*Cotización PlusMedik N° PM-000042*",
      "Paciente: Juan Pérez",
      "Fecha: 19/10/2026 · Válida hasta: 18/11/2026",
      "",
      "• Hemograma completo — Bs 50,00",
      "• Glicemia — Bs 20,00",
      "",
      "*Total: Bs 70,00*"
    ].join("\n"));
  });

  it("agrega contacto y nota solo si están configurados, y omite el paciente si no hay", () => {
    const text = buildWhatsAppText({ ...quote, patientName: null }, { name: "PlusMedik", address: "Calle 1", footerNote: "Ayuno de 8 horas." });
    expect(text).not.toContain("Paciente:");
    expect(text).toContain("📍 Calle 1");
    expect(text).not.toContain("📞");
    expect(text.endsWith("Ayuno de 8 horas.")).toBe(true);
  });
});

describe("importación de tarifas CSV", () => {
  it("interpreta precios en formato boliviano y anglosajón", () => {
    expect(parsePrice("1.234,50")).toBe(1234.5);
    expect(parsePrice("1,234.50")).toBe(1234.5);
    expect(parsePrice("45,5")).toBe(45.5);
    expect(parsePrice("Bs 80")).toBe(80);
    expect(parsePrice("abc")).toBeUndefined();
    expect(parsePrice("-5")).toBeUndefined();
  });

  it("CSV de Excel en español (punto y coma, BOM, comillas)", () => {
    const csv = "﻿Código;Nombre;Precio\r\nHEM01;\"Hemograma; completo\";45,50\r\nGLI01;Glicemia;18\r\n;;\r\nX;Precio roto;abc\r\nTSH;TSH;\r\n";
    const parsed = parseTariffCsv(csv);
    expect(parsed.rows).toEqual([
      { line: 2, code: "HEM01", name: "Hemograma; completo", price: 45.5 },
      { line: 3, code: "GLI01", name: "Glicemia", price: 18 }
    ]);
    expect(parsed.errors).toEqual([{ line: 4, message: 'Precio inválido: "abc"' }]);
    // La fila sin precio (plantilla exportada) se omite sin error.
    expect(parsed.skipped).toBe(1);
  });

  it("exige columna de precio y de identificación", () => {
    expect(parseTariffCsv("nombre,costo\nA,1").errors[0]?.message).toMatch(/precio/);
    expect(parseTariffCsv("precio\n1").errors[0]?.message).toMatch(/identificar/);
  });

  it("empareja por id, luego código único, luego nombre exacto; reporta lo que no coincide", () => {
    const catalog = [
      { id: "11111111-aaaa-4000-8000-000000000001", code: "HEM01", name: "Hemograma completo", normalizedName: "hemograma completo" },
      { id: "11111111-aaaa-4000-8000-000000000002", code: "DUP", name: "Glicemia", normalizedName: "glicemia" },
      { id: "11111111-aaaa-4000-8000-000000000003", code: "DUP", name: "TSH", normalizedName: "tsh" }
    ];
    const { rows } = parseTariffCsv([
      "id,codigo,nombre,precio",
      ",hem01,,40",
      ",DUP,,10",
      ",,GLICEMIA,15",
      "11111111-AAAA-4000-8000-000000000003,,,70",
      ",ZZZ,No existe,5",
      ",HEM01,,42"
    ].join("\n"));
    const result = matchTariffRows(rows, catalog);
    expect(result.matched).toEqual([
      { line: 4, labTestId: catalog[1]!.id, name: "Glicemia", price: 15, by: "name" },
      { line: 5, labTestId: catalog[2]!.id, name: "TSH", price: 70, by: "id" },
      { line: 7, labTestId: catalog[0]!.id, name: "Hemograma completo", price: 42, by: "code" }
    ]);
    expect(result.unmatched).toEqual([
      { line: 3, label: "DUP", reason: "Código repetido en el catálogo: usa el id" },
      { line: 6, label: "ZZZ", reason: "No existe en el catálogo activo" },
      { line: 2, label: "Hemograma completo", reason: "Reemplazada por la línea 7 (mismo estudio)" }
    ]);
  });
});
