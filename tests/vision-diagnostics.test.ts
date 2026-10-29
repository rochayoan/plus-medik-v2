import { describe, expect, it } from "vitest";
import type { AiCallEvent } from "../src/cache.js";
import { buildVisionDiagnostic, visionDiagnosticKeyFor } from "../src/vision-diagnostics.js";

const KEY = "test-only-vision-hmac-" + "X".repeat(40);
const PHONE = "59171234567";
const ENV = {
  PLUSMEDIK_VISION_DIAGNOSTICS: "on",
  PLUSMEDIK_VISION_DIAGNOSTICS_KEY: KEY,
  PLUSMEDIK_VISION_DIAGNOSTICS_PHONES: PHONE
} as NodeJS.ProcessEnv;

const reader = (label: string, requestedStudies: unknown[], uncertainStudies: unknown[] = []): AiCallEvent => ({
  label, provider: "provider", model: "test-model", cacheHit: false, outcome: "OK",
  value: { requestedStudies, uncertainStudies, notes: "PACIENTE_SECRETO_NOTAS" }
});
const a = {
  literalText: "PACIENTE_SECRETO_ANTILAMBDA_IGM",
  normalizedName: "NOMBRE_PRIVADO",
  lineText: "LINEA_PRIVADA_IgM_IgG",
  confidence: "high", evidence: "explicit_text"
};
const b = {
  literalText: "PACIENTE_SECRETO_ANTILAMBDA_IGG",
  normalizedName: "NOMBRE_PRIVADO",
  lineText: "LINEA_PRIVADA_IgM_IgG",
  confidence: "medium", evidence: "check"
};

describe("diagnóstico de visión restringido al piloto", () => {
  it("apagado por defecto, falla cerrado si falta la clave o la lista, y rechaza contactos ajenos", () => {
    expect(visionDiagnosticKeyFor({}, PHONE)).toBeUndefined();
    expect(visionDiagnosticKeyFor({ ...ENV, PLUSMEDIK_VISION_DIAGNOSTICS: "off" }, PHONE)).toBeUndefined();
    expect(visionDiagnosticKeyFor({ ...ENV, PLUSMEDIK_VISION_DIAGNOSTICS_KEY: "short" }, PHONE)).toBeUndefined();
    expect(visionDiagnosticKeyFor({ ...ENV, PLUSMEDIK_VISION_DIAGNOSTICS_PHONES: "5917,otro" }, PHONE)).toBeUndefined();
    expect(visionDiagnosticKeyFor({ ...ENV, PLUSMEDIK_VISION_DIAGNOSTICS_PHONES: "" }, PHONE)).toBeUndefined();
    expect(visionDiagnosticKeyFor(ENV, "59179999999")).toBeUndefined();
    expect(visionDiagnosticKeyFor(ENV, "+" + PHONE)).toBe(KEY);
    expect(visionDiagnosticKeyFor(ENV, PHONE)).toBe(KEY);
  });

  it("identifica bytes idénticos con HMAC y detecta diferencias sin imágenes ni texto libre en el log", () => {
    const image = Uint8Array.from([0xff, 0xd8, 0xff, 0, 1, 2, 3]);
    const events = [reader("openai-reader", [a, b], ["INCERTIDUMBRE_PRIVADA"]), reader("gemini-openrouter", [b, a])];
    const first = buildVisionDiagnostic(image, "image/jpeg", events, KEY);
    const identical = buildVisionDiagnostic(Uint8Array.from(image), "image/jpeg", events, KEY);
    const different = buildVisionDiagnostic(Uint8Array.from([0xff, 0xd8, 0xff, 0, 1, 2, 4]), "image/jpeg", events, KEY);
    expect(first.image).toBe(identical.image);
    expect(first.image).not.toBe(different.image);
    expect(first.readers).toHaveLength(2);
    expect(first.readers[0]?.requestedCount).toBe(2);
    expect(first.readers[0]?.uncertainCount).toBe(1);
    expect(first.readers[0]?.rows[0]?.literal).toMatch(/^[a-f0-9]{32}$/);
    const dump = JSON.stringify(first);
    for (const secret of ["PACIENTE_SECRETO", "LINEA_PRIVADA", "NOMBRE_PRIVADO", "INCERTIDUMBRE_PRIVADA", "NOTAS", KEY, PHONE]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("un cambio de certeza altera la lectura, no la huella de la imagen; el orden de filas no importa", () => {
    const image = Uint8Array.from([10, 20, 30]);
    const baseline = buildVisionDiagnostic(image, "image/png", [reader("openai-reader", [a, b])], KEY);
    const reordered = buildVisionDiagnostic(image, "image/png", [reader("openai-reader", [b, a])], KEY);
    const uncertain = buildVisionDiagnostic(image, "image/png", [reader("openai-reader", [{ ...a, confidence: "medium" }, b])], KEY);
    expect(baseline.readers[0]?.reading).toBe(reordered.readers[0]?.reading);
    expect(baseline.readers[0]?.reading).not.toBe(uncertain.readers[0]?.reading);
    expect(baseline.image).toBe(uncertain.image);
  });

  it("rechaza valores fuera de esquema, no vuelca etapas ajenas, y limita listas largas", () => {
    const long = Array.from({ length: 45 }, (_, i) => ({ ...a, literalText: "SECRETO_" + i }));
    const diagnostic = buildVisionDiagnostic(new Uint8Array([1, 2]), "image/png", [
      reader("openai-reader", long), reader("random-stage", [{ literalText: "NO_PUBLICAR" }]),
      { ...reader("gemini-aistudio", [a]), outcome: "FAILED" }
    ], KEY);
    expect(diagnostic.readers).toHaveLength(1);
    expect(diagnostic.readers[0]?.truncated).toBe(true);
    expect(diagnostic.readers[0]?.requestedCount).toBe(45);
    expect(diagnostic.readers[0]?.rows).toHaveLength(40);
    expect(JSON.stringify(diagnostic)).not.toContain("NO_PUBLICAR");
  });
});
