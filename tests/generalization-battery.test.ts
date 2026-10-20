import { describe, expect, it } from "vitest";
import { normalizeStudyKey } from "../src/consensus.js";
import { BATTERY, runCase } from "./support/generalization-battery.js";

// Batería SINTÉTICA de generalización (analitos inventados, lecturas dadas): ejercita el motor determinista, no la visión de los modelos reales.
// Regla de oro: cero cotizaciones incorrectas; lo claro se cotiza; lo dudoso se retiene.

const results = BATTERY.map((testCase) => ({ testCase, ...runCase(testCase) }));

describe("batería sintética de generalización", () => {
  for (const { testCase, result, quoted } of results) {
    it(`${testCase.id} (${testCase.kind}): ${testCase.principle}`, () => {
      expect(quoted).toEqual([...testCase.expectQuoted].sort());
      // Lo que debe retenerse nunca figura entre los estudios aprobados (AUTO).
      const approved = new Set((result.internal?.studies ?? []).filter((s) => s.decision === "AUTO").map((s) => s.key));
      for (const text of testCase.mustHold ?? []) expect(approved.has(normalizeStudyKey(text))).toBe(false);
    });
  }

  it("la batería es variada: positivos, negativos y estudios de documento con zonas que no se ven", () => {
    const ids = BATTERY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BATTERY.filter((c) => c.kind === "positive").length).toBeGreaterThanOrEqual(20);
    expect(BATTERY.filter((c) => c.kind === "negative").length).toBeGreaterThanOrEqual(15);
    expect(BATTERY.filter((c) => c.document).length).toBeGreaterThanOrEqual(6);
  });

  it("métricas agregadas: ninguna cotización incorrecta ni estudio seguro bloqueado en la batería", () => {
    let wrong = 0;
    let blocked = 0;
    for (const { testCase, quoted } of results) {
      wrong += quoted.filter((code) => !testCase.expectQuoted.includes(code)).length;
      blocked += testCase.expectQuoted.filter((code) => !quoted.includes(code)).length;
    }
    expect({ wrong, blocked }).toEqual({ wrong: 0, blocked: 0 });
  });
});
