import { describe, expect, it } from "vitest";
import { appendQuoteTurnaround, parseTurnaround } from "../src/quote-turnaround.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, turnaroundText: string | null, active = true): CatalogStudy => ({ id, code: null, name, normalizedName: name.toLowerCase(), normalizedAliases: [], priceBs: 10, active, turnaroundText });
const FOOTER = "\n\nRespóndenos por este chat para continuar. 😊";

describe("tiempo de entrega en la cotización", () => {
  it("lee el plazo de lab_tests.notes y acentúa día/días sin cambiar nada más", () => {
    expect(parseTurnaround("Preparacion: Se recomienda ayuno de 8 a 12 horas | Tiempo de entrega: 3 dias")).toBe("3 días");
    expect(parseTurnaround("Tiempo de entrega: En el dia")).toBe("En el día");
    expect(parseTurnaround("Preparacion: nada | Tiempo de entrega: 5 - 10 dias")).toBe("5 - 10 días");
    expect(parseTurnaround("Tiempo de entrega: 30 minutos.")).toBe("30 minutos");
  });
  it("sin dato (o ilegible) no inventa nada", () => {
    expect(parseTurnaround(null)).toBeNull();
    expect(parseTurnaround("Preparacion: ayuno")).toBeNull();
    expect(parseTurnaround(`Tiempo de entrega: ${"x".repeat(80)}`)).toBeNull();
  });
  it("agrupa por plazo, va antes del pie y solo incluye los estudios cotizados y activos", () => {
    const catalog = [study("1", "HEMOGRAMA", "2 horas"), study("2", "UREA", "2 horas"), study("3", "CULTIVO", "3 días"), study("4", "OTRO", "1 hora"), study("5", "INACTIVO", "9 días", false)];
    const out = appendQuoteTurnaround(`Cotización${FOOTER}`, ["1", "2", "3", "5"], catalog);
    expect(out).toContain("⏱️ *TIEMPO DE ENTREGA*");
    expect(out).toContain("▫️ *HEMOGRAMA / UREA*: 2 horas");
    expect(out).toContain("▫️ *CULTIVO*: 3 días");
    expect(out).not.toContain("OTRO");
    expect(out).not.toContain("INACTIVO");
    expect(out.endsWith(FOOTER)).toBe(true);
  });
  it("un estudio sin dato no se menciona; sin ningún dato la cotización queda igual", () => {
    const catalog = [study("1", "HEMOGRAMA", null)];
    expect(appendQuoteTurnaround("Cotización", ["1"], catalog)).toBe("Cotización");
  });
  it("nunca parte la cotización: si no cabe, sale como estaba", () => {
    const long = "x".repeat(3790);
    expect(appendQuoteTurnaround(long, ["1"], [study("1", "HEMOGRAMA", "2 horas")])).toBe(long);
  });
});
