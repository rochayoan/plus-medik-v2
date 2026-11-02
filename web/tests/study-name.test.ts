import { describe, expect, it } from "vitest";
import { splitStudyName } from "../lib/study-name";

describe("splitStudyName", () => {
  it("separa el título en mayúsculas del desglose", () => {
    const { title, detail } = splitStudyName("10 GENES DE RESISTENCIA A ANTIBIOTICOS Nueva Delhi metalo-b-lactamasa (NDM), Oxacilinasa-48 (OXA 48)");
    expect(title).toBe("10 GENES DE RESISTENCIA A ANTIBIOTICOS");
    expect(detail).toBe("Nueva Delhi metalo-b-lactamasa (NDM), Oxacilinasa-48 (OXA 48)");
  });
  it("deja intactos los nombres sin desglose", () => {
    expect(splitStudyName("ACIDO VALPROICO")).toEqual({ title: "ACIDO VALPROICO", detail: null });
    expect(splitStudyName("Hemograma completo")).toEqual({ title: "Hemograma completo", detail: null });
  });
  it("un resto corto es parte del nombre", () => {
    expect(splitStudyName("HEMOGRAMA completo")).toEqual({ title: "HEMOGRAMA completo", detail: null });
  });
});

import { brandForOrganization } from "../lib/org-brand";

describe("brandForOrganization", () => {
  const base = { name: "PlusMedik", address: "Av. Lab 1", phone: "111", footerNote: "Nota lab" };
  it("sin datos de contacto mantiene la marca de PlusMedik", () => {
    expect(brandForOrganization(base, { name: "Clínica X", address: null, phone: null, note: null })).toBe(base);
    expect(brandForOrganization(base, null)).toBe(base);
  });
  it("con datos encabeza con la organización", () => {
    expect(brandForOrganization(base, { name: "Clínica X", address: "Calle 5", phone: null, note: null })).toEqual({
      name: "Clínica X", address: "Calle 5", phone: undefined, footerNote: "Nota lab"
    });
  });
});
