import { describe, expect, it } from "vitest";
import { evaluateStructure, STRUCTURES } from "./support/inheritance-adversarial.js";

// Regresiones OBLIGATORIAS de la herencia de analito. Generador con semilla fija (analitos inventados, verdad conocida por construcción).
// Regla de oro: ninguna asociación incorrecta entre analitos y variantes, y jamás se cotiza una variante rechazada, tachada, negada o condicional.

const INSTANCES = 200;

describe("herencia de analito: adversarial", () => {
  for (const [name, structure] of Object.entries(STRUCTURES)) {
    it(`${name}: ${structure.description}`, () => {
      const result = evaluateStructure(name, INSTANCES);
      expect(result.wrong, result.examples.join("\n")).toBe(0);
      expect(result.wrongNegated).toBe(0);
      if (structure.mustQuoteAll) {
        expect(result.missed).toBe(0);
        expect(result.correct).toBeGreaterThan(INSTANCES);
      }
      if (structure.mustHoldAll) {
        expect(result.correct).toBe(0);
        expect(result.allHeld).toBe(INSTANCES);
      }
    });
  }

  it("el generador no es trivial: las estructuras de regresión existen y hay lectura con una fila donante que sí se cotiza completa", () => {
    for (const required of ["S4_donor_of_other_analyte", "S4b_donor_with_variant_of_other_analyte", "S10_marks_donor", "S10c_symbol_marks_donor", "S10d_symbol_marks_two_analytes", "S14_x_marks_donor", "S15_factor_x_with_marks", "S16_x_marks_two_analytes", "S17_x_marks_no_donor", "S10b_marks_bare", "S11_negation_donor", "S11b_negation_bare"]) expect(STRUCTURES).toHaveProperty(required);
    const positive = evaluateStructure("S2_donor_single_analyte", 50);
    expect(positive.correct).toBeGreaterThan(50);
    expect(positive.wrong + positive.missed).toBe(0);
  });
});
