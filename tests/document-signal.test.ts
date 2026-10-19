import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentInstructions,
  evaluateIntegrity,
  fuseSignals,
  readDocumentSignal,
  type RawSignal,
  type SignalRequest
} from "../src/document-signal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-doc-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

// Lectura íntegra por defecto: zona de estudios dentro de la imagen, sin filas cortadas ni ocultas.
const raw = (documentType: string, overrides: Partial<RawSignal> = {}): RawSignal => ({
  documentType: documentType as RawSignal["documentType"],
  studyRegion: { left: 80, top: 200, right: 900, bottom: 800 },
  studyRegionComplete: true,
  rowsCutByImageEdge: [],
  rowsHiddenByObjects: [],
  erasedOrIllegible: false,
  irrelevantCrops: [],
  printedContext: [],
  documentFunction: "MEDICAL_REQUEST",
  functionEvidence: ["firma y sello del médico que ordena estudios"],
  reason: `es ${documentType}`,
  ...overrides
});

describe("evaluateIntegrity (la decisión es del código, no del modelo)", () => {
  it("zona completa y dentro de la imagen -> completa", () => {
    expect(evaluateIntegrity(raw("MARK_DEPENDENT_FORM"))).toEqual({ complete: true, problems: [] });
  });

  it("los recortes irrelevantes se registran pero no bloquean", () => {
    const signal = raw("MARK_DEPENDENT_FORM", { irrelevantCrops: ["firma cortada", "encabezado recortado"] });
    expect(evaluateIntegrity(signal).complete).toBe(true);
    expect(fuseSignals(signal, signal).integrity.irrelevantCrops).toEqual(["firma cortada", "encabezado recortado"]);
  });

  it("una fila cortada por el borde, oculta por un objeto o ilegible bloquea", () => {
    expect(evaluateIntegrity(raw("MARK_DEPENDENT_FORM", { rowsCutByImageEdge: ["Hepatitis B Antígeno de Superfic"] }))).toMatchObject({
      complete: false,
      problems: [expect.stringContaining("Hepatitis B")]
    });
    expect(evaluateIntegrity(raw("MARK_DEPENDENT_FORM", { rowsHiddenByObjects: ["fila tapada por sello"] })).complete).toBe(false);
    expect(evaluateIntegrity(raw("HANDWRITTEN_REQUEST", { erasedOrIllegible: true })).complete).toBe(false);
  });

  it("si el modelo no confirma la zona completa, falla cerrado aunque no enumere nada", () => {
    expect(evaluateIntegrity(raw("MARK_DEPENDENT_FORM", { studyRegionComplete: false })).complete).toBe(false);
  });

  it("una caja de estudios que toca el borde (margen 1.5 %) bloquea, aunque el modelo diga completa", () => {
    const touching = [
      { left: 5, top: 200, right: 900, bottom: 800 },
      { left: 80, top: 5, right: 900, bottom: 800 },
      { left: 80, top: 200, right: 990, bottom: 800 },
      { left: 80, top: 200, right: 900, bottom: 995 }
    ];
    for (const studyRegion of touching) {
      const result = evaluateIntegrity(raw("MARK_DEPENDENT_FORM", { studyRegion }));
      expect(result.complete).toBe(false);
      expect(result.problems.join(" ")).toContain("toca el borde");
    }
  });

  it("una caja inválida (invertida o fuera de 0..1000) bloquea", () => {
    expect(evaluateIntegrity(raw("MARK_DEPENDENT_FORM", { studyRegion: { left: 500, top: 200, right: 100, bottom: 800 } })).complete).toBe(false);
    expect(evaluateIntegrity(raw("MARK_DEPENDENT_FORM", { studyRegion: { left: 0, top: 200, right: 1200, bottom: 800 } })).complete).toBe(false);
  });
});

describe("fuseSignals (misma semántica que fuseIndependentReadings)", () => {
  it("tipos iguales -> ese tipo; distintos -> UNKNOWN", () => {
    expect(fuseSignals(raw("MARK_DEPENDENT_FORM"), raw("MARK_DEPENDENT_FORM"))).toMatchObject({ documentType: "MARK_DEPENDENT_FORM", agreement: true });
    expect(fuseSignals(raw("MARK_DEPENDENT_FORM"), raw("HANDWRITTEN_REQUEST"))).toMatchObject({ documentType: "UNKNOWN", agreement: false });
  });

  it("el documento solo es completo si ambas lecturas lo ven completo, y los problemas indican la lectura", () => {
    const fused = fuseSignals(raw("TEXT_EXPLICIT_REQUEST"), raw("TEXT_EXPLICIT_REQUEST", { rowsCutByImageEdge: ["Glicemia"] }));
    expect(fused.completeDocumentVisible).toBe(false);
    expect(fused.integrity.problems).toEqual(["lectura B: cortado por el borde: Glicemia"]);
  });

  it("la zona fusionada es la unión de ambas cajas; si una es inválida no se informa", () => {
    const a = raw("MARK_DEPENDENT_FORM", { studyRegion: { left: 100, top: 200, right: 800, bottom: 700 } });
    const b = raw("MARK_DEPENDENT_FORM", { studyRegion: { left: 80, top: 250, right: 900, bottom: 600 } });
    expect(fuseSignals(a, b).integrity.studyRegion).toEqual({ left: 80, top: 200, right: 900, bottom: 700 });
    const invalid = raw("MARK_DEPENDENT_FORM", { studyRegion: { left: 900, top: 0, right: 10, bottom: 0 } });
    expect(fuseSignals(a, invalid).integrity.studyRegion).toBeUndefined();
  });
});

describe("readDocumentSignal", () => {
  it("hace dos lecturas independientes con instrucciones distintas y las fusiona", async () => {
    const complete = vi.fn(async (_request: SignalRequest) => ({ value: raw("HANDWRITTEN_REQUEST"), usage: { inputTokens: 1500, outputTokens: 40 } }));
    const result = await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: { complete, model: "m", reasoning: "medium" } });
    expect(complete).toHaveBeenCalledTimes(2);
    const [a, b] = complete.mock.calls.map((call) => call[0]);
    expect(a!.instructions).not.toEqual(b!.instructions);
    expect(result.signal).toMatchObject({ documentType: "HANDWRITTEN_REQUEST", agreement: true, completeDocumentVisible: true });
    expect(result.usage).toHaveLength(2);
  });

  it("si las dos lecturas discrepan el tipo queda UNKNOWN (nunca AUTO)", async () => {
    const complete = vi.fn(async (request: SignalRequest) => ({ value: raw(request.variant === "A" ? "MARK_DEPENDENT_FORM" : "HANDWRITTEN_REQUEST") }));
    const result = await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: { complete, model: "m", reasoning: "medium" } });
    expect(result.signal).toMatchObject({ documentType: "UNKNOWN", agreement: false });
  });

  it("si solo una lectura ve la zona cortada, el documento queda incompleto", async () => {
    const complete = vi.fn(async (request: SignalRequest) => ({
      value: raw("MARK_DEPENDENT_FORM", request.variant === "B" ? { rowsCutByImageEdge: ["Perfil Hepático"] } : {})
    }));
    const result = await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: { complete, model: "m", reasoning: "medium" } });
    expect(result.signal.completeDocumentVisible).toBe(false);
  });

  it("rechaza una respuesta con un tipo fuera del enum existente", async () => {
    const complete = vi.fn(async () => ({ value: raw("PRESCRIPCION_RARA") }));
    await expect(readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: { complete, model: "m", reasoning: "medium" } })).rejects.toThrow();
  });

  it("rechaza una respuesta del contrato anterior (sin zona ni listas de integridad)", async () => {
    const complete = vi.fn(async () => ({ value: { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, reason: "x" } }));
    await expect(readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: { complete, model: "m", reasoning: "medium" } })).rejects.toThrow();
  });

  it("usa cache: la segunda lectura idéntica no llama al modelo", async () => {
    process.env.AI_CACHE = "on";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const complete = vi.fn(async () => ({ value: raw("MARK_DEPENDENT_FORM") }));
    const deps = { complete, model: "m", reasoning: "medium" };
    await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps });
    const second = await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(second.cacheHits).toBe(2);
    spy.mockRestore();
  });

  it("las instrucciones conservan la política de manuscritos y separan zona relevante de recortes irrelevantes", () => {
    for (const variant of ["A", "B"] as const) {
      const text = documentInstructions(variant);
      expect(text).toContain("HANDWRITTEN_REQUEST significa que el pedido clínico depende de texto manuscrito");
      expect(text).toContain("ZONA RELEVANTE");
      expect(text).toContain("Un recorte irrelevante NO lo vuelve false");
      expect(text).toContain("Ante la duda sobre la zona relevante, responde false");
    }
  });
});
