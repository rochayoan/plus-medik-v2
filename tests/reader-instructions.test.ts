import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { legacyReadingSchema, simpleReaderInstructionsFor, simpleReadingSchema } from "../src/ai.js";
import { lineSegmentFor } from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

// Instrucciones de los lectores (mejora 4): reglas GENERALES de transcripción, mismo contrato de salida, prompt anterior intacto. Sin red.

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const current = simpleReaderInstructionsFor(false);

describe("contrato y compatibilidad", () => {
  it("el prompt anterior (legacy) queda byte a byte igual: las lecturas guardadas se repiten sin gasto", () => {
    expect(sha(simpleReaderInstructionsFor(true))).toBe("b61aa3708296bc0e4a7d3fda4ce8e37c2932643d1130310849ef857b3f1f4fa1");
  });
  it("el esquema de salida no cambia (mismos campos para Gemini y GPT)", () => {
    expect(sha(JSON.stringify(z.toJSONSchema(simpleReadingSchema)))).toBe("abbe4e2bda6f272e9b41a989ce4c9da9f3f3c6ed98cca057ec33cb7cefeced8e");
    expect(sha(JSON.stringify(z.toJSONSchema(legacyReadingSchema)))).toBe("2437dd91c7cdfb706fdbf941b32ee199b9addd7cbe182d6dc7d1171f1e6d85e7");
  });
  it("las protecciones de siempre siguen en el prompt vigente", () => {
    for (const rule of ["sin corregir ni completar", "No completes pares ni grupos clínicos", "No uses el diagnóstico", "no la adivines", "uncertainStudies", "lineText"]) {
      expect(current).toContain(rule);
    }
  });
});

describe("reglas nuevas: generales, sin estudios concretos", () => {
  it("cubren abreviaturas, calificadores, listas, tablas y letra a mano", () => {
    for (const topic of ["No desarrolles abreviaturas", "Conserva TODO lo que distingue", "Varios estudios en una misma línea", "No repartas", "Tablas, columnas y encabezados", "Letra a mano", "\"?\""]) {
      expect(current).toContain(topic);
    }
  });
  it("las reglas nuevas no nombran estudios del catálogo (no son recetas para ejemplos)", () => {
    const added = current.slice(current.indexOf("Cómo transcribir:"), current.indexOf("Reglas estrictas:"));
    expect(added.length).toBeGreaterThan(0);
    for (const study of ["toxo", "hepatitis", "fsh", "chagas", "hai", "glucosa", "insulina", "tsh", "urea", "hbsag", "anticore", "igm", "igg"]) {
      expect(normalizeStudyKey(added).split(" ")).not.toContain(study);
    }
  });
});

describe("la lineText de una tabla («Encabezado: celda») sirve a la mejora 1", () => {
  const study = (id: string, name: string): CatalogStudy => ({ id, code: id, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs: 85, active: true, category: "INMUNOSEROLOGIA" });
  const toxoIgM = study("toxo-m", "TOXOPLASMA IgM (Elisa)");
  const cmvIgM = study("cmv-m", "CITOMEGALOVIRUS IgM (Elisa)");
  it("una celda «IgM» bajo el encabezado «Toxoplasma» se precisa con la línea; sin encabezado, no", () => {
    expect(lineSegmentFor("IgM", "Toxoplasma: IgM", toxoIgM, [toxoIgM, cmvIgM])).toBe("Toxoplasma: IgM");
    expect(lineSegmentFor("IgM", "IgM", toxoIgM, [toxoIgM, cmvIgM])).toBeUndefined();
  });
});
