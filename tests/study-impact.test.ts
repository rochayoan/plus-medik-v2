import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { integrityKinds, fuseSignals, type RawSignal } from "../src/document-signal.js";
import { impactCheckPassed, impactInstructions, verifyStudyImpact, worstImpact, type ImpactCheck, type ImpactRequest, type ImpactStatus } from "../src/study-impact.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-impact-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const studies = [{ key: "hemograma completo", text: "Hemograma completo" }, { key: "creatinina", text: "Creatinina" }];
const item = (index: number, overrides: Partial<ImpactCheck["items"][number]> = {}): ImpactCheck["items"][number] => ({ index, rowFullyVisible: true, selectionFullyVisible: true, affected: "NO", note: "", ...overrides });
const check = (items: ImpactCheck["items"], extra: Partial<ImpactCheck> = {}): ImpactCheck => ({ items, qualifiersMayBeHidden: false, reason: "", ...extra });
const PROBLEMS = ["lectura A: cortado por el borde: fila inferior"];

describe("impactCheckPassed: un estudio se confirma solo si su fila y su marca se ven enteras y nada lo afecta", () => {
  it("positivo", () => {
    expect([...impactCheckPassed(check([item(0), item(1)]), studies).passed]).toEqual(["hemograma completo", "creatinina"]);
  });

  it("negativos: texto cortado, marca cortada, afectado o posiblemente afectado, sin respuesta", () => {
    const result = impactCheckPassed(check([item(0, { rowFullyVisible: false }), item(1, { affected: "POSSIBLY" })]), studies);
    expect(result.passed.size).toBe(0);
    expect(result.notes.join(" | ")).toContain("su texto no se ve entero");
    expect(result.notes.join(" | ")).toContain("podría afectarlo");
    expect([...impactCheckPassed(check([item(0, { selectionFullyVisible: false }), item(1, { affected: "YES" })]), studies).passed]).toEqual([]);
    expect([...impactCheckPassed(check([item(0)]), studies).passed]).toEqual(["hemograma completo"]); // el 1 no tiene respuesta
  });

  it("el riesgo de calificadores ocultos se propaga", () => {
    expect(impactCheckPassed(check([item(0), item(1)], { qualifiersMayBeHidden: true }), studies).qualifierRisk).toBe(true);
  });

  it("las instrucciones listan problemas y estudios y varían entre las dos lecturas", () => {
    const a = impactInstructions("A", studies, PROBLEMS);
    const b = impactInstructions("B", studies, PROBLEMS);
    expect(a).not.toEqual(b);
    for (const text of [a, b]) {
      expect(text).toContain("- lectura A: cortado por el borde: fila inferior");
      expect(text).toContain("0. Hemograma completo");
      expect(text).toContain("1. Creatinina");
    }
  });

  describe("prompt: riesgo local sobre el estudio separado de la información general oculta", () => {
    const a = impactInstructions("A", studies, PROBLEMS);
    const b = impactInstructions("B", studies, PROBLEMS);
    const methodOf = (text: string) => text.split("\n").find((line) => line.startsWith("Método:"));

    it("define el riesgo local con un elemento CONCRETO que toca la fila, la marca o la continuación de ese estudio", () => {
      for (const text of [a, b]) {
        expect(text).toContain("Riesgo LOCAL sobre un estudio = un elemento CONCRETO");
        expect(text).toContain("la fila de ESE estudio, su casilla o marca de selección, o la continuación inmediata");
      }
    });

    it("exige evidencia nombrada para POSSIBLY y descarta la duda genérica sobre lo que haya fuera del encuadre", () => {
      for (const text of [a, b]) {
        expect(text).toContain("affected = POSSIBLY SOLO si puedes NOMBRAR el elemento concreto");
        expect(text).toContain("Una duda general NO es evidencia");
        expect(text).toContain("fuera del encuadre");
        expect(text).not.toContain("Ante la duda, POSSIBLY");
      }
    });

    it("no se supone lo que hay bajo un objeto: casilla o texto cubiertos se contestan como no visibles", () => {
      for (const text of [a, b]) {
        expect(text).toContain("Nunca supongas lo que hay debajo de un objeto");
        expect(text).toContain("Si la casilla o la marca de ESE estudio está cubierta o cortada, false");
      }
    });

    it("la información general oculta se responde aparte y no cambia affected", () => {
      for (const text of [a, b]) {
        expect(text).toContain("qualifiersMayBeHidden (una sola respuesta para todo el documento, no por estudio)");
        expect(text).toContain("qualifiersMayBeHidden NO cambia affected de ningún estudio");
        expect(text).toContain("Que falten filas o columnas de estudios fuera del encuadre no es, por sí solo, un título oculto");
      }
    });

    it("las dos lecturas comparten TODAS las definiciones y solo cambia el método (independencia sin sesgo de reglas)", () => {
      expect(methodOf(a)).not.toEqual(methodOf(b));
      expect(a.replace(methodOf(a)!, "")).toEqual(b.replace(methodOf(b)!, ""));
    });

    it("el prompt es el mismo para cualquier documento: solo cambian la lista de problemas y la de estudios", () => {
      const otherStudies = [{ key: "x", text: "Estudio inventado uno" }, { key: "y", text: "Estudio inventado dos" }, { key: "z", text: "Estudio inventado tres" }];
      const otherProblems = ["un sello tapa la esquina", "texto ilegible a la derecha"];
      const scrub = (text: string, list: Array<{ text: string }>, problems: string[]) => {
        const withoutProblems = problems.reduce((out, problem) => out.replace("- " + problem + "\n", ""), text);
        return list.reduce((out, study, index) => out.replace(index + ". " + study.text + "\n", ""), withoutProblems);
      };
      expect(scrub(impactInstructions("A", studies, PROBLEMS), studies, PROBLEMS)).toEqual(scrub(impactInstructions("A", otherStudies, otherProblems), otherStudies, otherProblems));
    });
  });
});

describe("verifyStudyImpact: dos lecturas independientes, fallo cerrado", () => {
  const run = (call: (request: ImpactRequest) => Promise<{ value: unknown }>) =>
    verifyStudyImpact({ imageBase64: "aW1n", mimeType: "image/jpeg", studies, problems: PROBLEMS }, { call, model: "m", reasoning: "medium" });

  it("un estudio solo queda confirmado si AMBAS lecturas lo confirman", async () => {
    const call = vi.fn(async (request: ImpactRequest) => ({ value: check([item(0), item(1, request.variant === "B" ? { affected: "POSSIBLY" } : {})]) }));
    const result = await run(call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]![0].instructions).not.toEqual(call.mock.calls[1]![0].instructions);
    expect(result.available).toBe(true);
    expect([...result.unaffected]).toEqual(["hemograma completo"]);
    expect(result.notes.join(" ")).toContain("lectura B");
  });

  it("basta que una lectura vea riesgo de calificadores ocultos", async () => {
    const result = await run(async (request) => ({ value: check([item(0), item(1)], { qualifiersMayBeHidden: request.variant === "A" }) }));
    expect(result.qualifierRisk).toBe(true);
    expect(result.unaffected.size).toBe(2);
  });

  it("si la verificación lanza o devuelve un formato inválido: no disponible, nada confirmado", async () => {
    const failing = await run(async () => { throw new Error("HTTP 503"); });
    expect(failing).toMatchObject({ available: false, qualifierRisk: true });
    expect(failing.unaffected.size).toBe(0);
    expect(failing.notes[0]).toContain("no disponible");
    expect((await run(async () => ({ value: { items: "mal" } }))).available).toBe(false);
  });

  it("sin estudios no hay nada que verificar ni se llama al modelo", async () => {
    const call = vi.fn(async () => ({ value: check([]) }));
    const result = await verifyStudyImpact({ imageBase64: "aW1n", mimeType: "image/jpeg", studies: [], problems: PROBLEMS }, { call, model: "m", reasoning: "medium" });
    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({ available: true, qualifierRisk: false });
  });
});

describe("veredicto por estudio (findings): la peor de las dos lecturas", () => {
  const run = (call: (request: ImpactRequest) => Promise<{ value: unknown }>) =>
    verifyStudyImpact({ imageBase64: "aW1n", mimeType: "image/jpeg", studies, problems: PROBLEMS }, { call, model: "m", reasoning: "medium" });

  it("cada motivo de duda tiene su estado", async () => {
    const statuses: Array<[Partial<ImpactCheck["items"][number]>, ImpactStatus]> = [
      [{}, "INDEPENDENT"],
      [{ affected: "YES" }, "AFFECTED"],
      [{ affected: "POSSIBLY" }, "POSSIBLY_AFFECTED"],
      [{ rowFullyVisible: false }, "NOT_FULLY_VISIBLE"],
      [{ selectionFullyVisible: false }, "NOT_FULLY_VISIBLE"]
    ];
    for (const [override, expected] of statuses) {
      const result = await run(async () => ({ value: check([item(0, override), item(1)]) }));
      expect(result.findings?.get("hemograma completo")).toBe(expected);
      expect(result.findings?.get("creatinina")).toBe("INDEPENDENT");
      expect(result.unaffected.has("hemograma completo")).toBe(expected === "INDEPENDENT");
    }
  });

  it("un estudio sin respuesta es NO_ANSWER", async () => {
    const result = await run(async () => ({ value: check([item(0)]) }));
    expect(result.findings?.get("creatinina")).toBe("NO_ANSWER");
  });

  it("si las lecturas difieren manda la más desfavorable", async () => {
    const result = await run(async (request) => ({ value: check([item(0, request.variant === "A" ? { affected: "POSSIBLY" } : { rowFullyVisible: false }), item(1, request.variant === "B" ? { affected: "YES" } : {})]) }));
    expect(result.findings?.get("hemograma completo")).toBe("NOT_FULLY_VISIBLE");
    expect(result.findings?.get("creatinina")).toBe("AFFECTED");
  });

  it("orden de severidad: AFFECTED > NOT_FULLY_VISIBLE > POSSIBLY_AFFECTED > NO_ANSWER > INDEPENDENT (simétrico)", () => {
    const order: ImpactStatus[] = ["AFFECTED", "NOT_FULLY_VISIBLE", "POSSIBLY_AFFECTED", "NO_ANSWER", "INDEPENDENT"];
    order.forEach((a, i) => order.forEach((b, j) => expect(worstImpact(a, b)).toBe(order[Math.min(i, j)])));
  });

  it("verificación no disponible: sin veredictos", async () => {
    const result = await run(async () => { throw new Error("HTTP 503"); });
    expect(result.available).toBe(false);
    expect(result.findings).toBeUndefined();
  });
});

describe("tipos de problema de integridad (integrity.kinds)", () => {
  const raw = (overrides: Partial<RawSignal> = {}): RawSignal => ({
    documentType: "MARK_DEPENDENT_FORM",
    studyRegion: { left: 100, top: 200, right: 900, bottom: 700 },
    studyRegionComplete: true,
    rowsCutByImageEdge: [],
    rowsHiddenByObjects: [],
    erasedOrIllegible: false,
    irrelevantCrops: [],
    printedContext: [],
    reason: "",
    ...overrides
  });

  it("documento íntegro: ninguno", () => {
    expect(integrityKinds(raw())).toEqual([]);
    expect(fuseSignals(raw(), raw()).integrity.kinds).toEqual([]);
  });

  it("cada problema recibe su tipo", () => {
    expect(integrityKinds(raw({ studyRegionComplete: false, rowsCutByImageEdge: ["fila"] }))).toEqual(["CUT_EDGE"]);
    expect(integrityKinds(raw({ studyRegionComplete: false, rowsHiddenByObjects: ["sello"] }))).toEqual(["HIDDEN"]);
    expect(integrityKinds(raw({ studyRegion: { left: 100, top: 0, right: 900, bottom: 700 } }))).toEqual(["EDGE_UNVERIFIED"]);
    expect(integrityKinds(raw({ studyRegionComplete: false, erasedOrIllegible: true }))).toEqual(["ERASED"]);
    expect(integrityKinds(raw({ studyRegion: { left: 900, top: 10, right: 100, bottom: 50 } }))).toEqual(["INVALID_BOX"]);
    expect(integrityKinds(raw({ studyRegionComplete: false }))).toEqual(["UNEXPLAINED_DOUBT"]);
  });

  it("lo ya verificado deja de contar, y la señal fusionada une los tipos de las dos lecturas", () => {
    expect(integrityKinds(raw({ studyRegionComplete: false, rowsHiddenByObjects: ["sello"] }), new Set(), true)).toEqual([]);
    expect(integrityKinds(raw({ studyRegion: { left: 100, top: 0, right: 900, bottom: 700 } }), new Set(["top"]))).toEqual([]);
    const fused = fuseSignals(raw({ studyRegionComplete: false, rowsCutByImageEdge: ["fila"] }), raw({ studyRegionComplete: false, erasedOrIllegible: true }));
    expect(fused.integrity.kinds).toEqual(["CUT_EDGE", "ERASED"]);
    expect(fused.completeDocumentVisible).toBe(false);
  });
});
