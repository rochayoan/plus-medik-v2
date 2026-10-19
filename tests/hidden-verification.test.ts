import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateIntegrity,
  fuseSignals,
  hardProblems,
  hiddenCheckPassed,
  hiddenInstructions,
  readDocumentSignal,
  type EdgeRequest,
  type HiddenCheck,
  type HiddenRequest,
  type RawSignal,
  type SignalRequest
} from "../src/document-signal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-hidden-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const FINGER_A = "Un dedo oculta el extremo izquierdo de la segunda línea del pedido, donde podría haber una marca inicial.";
const FINGER_B = "Un dedo tapa el margen izquierdo de una línea intermedia del pedido manuscrito e impide comprobar si hay una viñeta o trazos adicionales.";

// Lectura de un manuscrito con un dedo sobre el margen: el modelo duda de la zona y lo explica con el objeto (como en nueva-04).
const raw = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  documentType: "HANDWRITTEN_REQUEST",
  studyRegion: { left: 30, top: 355, right: 680, bottom: 590 },
  studyRegionComplete: false,
  rowsCutByImageEdge: [],
  rowsHiddenByObjects: [FINGER_A],
  erasedOrIllegible: false,
  irrelevantCrops: [],
  printedContext: [],
  reason: "recetario manuscrito",
  ...overrides
});

const check = (couldHide: HiddenCheck["items"][number]["couldHide"] = "ONLY_BULLET_MARGIN_OR_BLANK", extra: Partial<HiddenCheck> = {}, count = 1): HiddenCheck => ({
  items: Array.from({ length: count }, (_, index) => ({ index, couldHide, visibleNeighbor: "Urea" })),
  otherDoubts: false,
  reason: "solo se tapa la viñeta",
  ...extra
});

describe("hiddenCheckPassed: solo se acepta si TODO lo oculto es guion, margen o vacío", () => {
  it("positivo: todos los objetos son solo guion/margen, con texto contiguo y sin otras dudas", () => {
    expect(hiddenCheckPassed(check(), 1)).toEqual({ ok: true, notes: [] });
    expect(hiddenCheckPassed(check("ONLY_BULLET_MARGIN_OR_BLANK", {}, 3), 3).ok).toBe(true);
  });

  it("negativos: podría ocultar texto de un estudio o una marca de selección", () => {
    expect(hiddenCheckPassed(check("STUDY_TEXT"), 1)).toMatchObject({ ok: false, notes: [expect.stringContaining("texto de un estudio")] });
    expect(hiddenCheckPassed(check("MARK_OR_SELECTION"), 1)).toMatchObject({ ok: false, notes: [expect.stringContaining("marca de selección")] });
  });

  it("negativos: un solo objeto dudoso entre varios, objeto sin respuesta, sin texto contiguo, u otras dudas", () => {
    const mixed = check("ONLY_BULLET_MARGIN_OR_BLANK", {}, 2);
    mixed.items[1]!.couldHide = "STUDY_TEXT";
    expect(hiddenCheckPassed(mixed, 2).ok).toBe(false);
    expect(hiddenCheckPassed(check(), 2).notes.join(" ")).toContain("objeto 1: sin respuesta");
    const noNeighbor = check();
    noNeighbor.items[0]!.visibleNeighbor = "   ";
    expect(hiddenCheckPassed(noNeighbor, 1).notes.join(" ")).toContain("texto visible contiguo");
    expect(hiddenCheckPassed(check("ONLY_BULLET_MARGIN_OR_BLANK", { otherDoubts: true }), 1).notes.join(" ")).toContain("otras dudas");
  });

  it("las instrucciones enumeran los objetos, piden elegir STUDY_TEXT ante la duda y varían entre las dos lecturas", () => {
    const a = hiddenInstructions("A", [FINGER_A, FINGER_B]);
    const b = hiddenInstructions("B", [FINGER_A, FINGER_B]);
    expect(a).not.toEqual(b);
    for (const text of [a, b]) {
      expect(text).toContain(`0. ${FINGER_A}`);
      expect(text).toContain(`1. ${FINGER_B}`);
      expect(text).toContain("Ante la duda razonable sobre lo que hay debajo, elige STUDY_TEXT");
      expect(text).toContain("SOLO si lo único que podría haber debajo");
    }
  });
});

describe("integridad con ocultamientos verificados", () => {
  it("sin verificación, el objeto y la duda del modelo bloquean (comportamiento previo)", () => {
    expect(evaluateIntegrity(raw()).complete).toBe(false);
    expect(hardProblems(raw()).join(" ")).toContain("oculto por un objeto");
  });

  it("con verificación, el objeto deja de bloquear y la duda se perdona SOLO si él mismo la explicó con esos objetos", () => {
    expect(evaluateIntegrity(raw(), new Set(), true)).toEqual({ complete: true, problems: [] });
    // duda sin ninguna explicación: nada que verificar, sigue bloqueando
    expect(evaluateIntegrity(raw({ rowsHiddenByObjects: [] }), new Set(), true).complete).toBe(false);
  });

  it("la verificación de ocultamientos nunca perdona cortes por el borde, trazos ilegibles ni una caja inválida", () => {
    expect(evaluateIntegrity(raw({ rowsCutByImageEdge: ["Hepatitis B"] }), new Set(), true).complete).toBe(false);
    expect(evaluateIntegrity(raw({ erasedOrIllegible: true }), new Set(), true).complete).toBe(false);
    expect(evaluateIntegrity(raw({ studyRegion: { left: 900, top: 10, right: 100, bottom: 50 } }), new Set(), true).complete).toBe(false);
  });

  it("fuseSignals registra que los ocultamientos se verificaron", () => {
    const signal = fuseSignals(raw(), raw({ rowsHiddenByObjects: [FINGER_B] }), new Set(), true);
    expect(signal.completeDocumentVisible).toBe(true);
    expect(signal.integrity.hiddenVerified).toBe(true);
    expect(fuseSignals(raw(), raw()).integrity.hiddenVerified).toBe(false);
  });
});

describe("readDocumentSignal: verificación enfocada de ocultamientos", () => {
  const deps = (
    reads: (variant: "A" | "B") => RawSignal,
    verifyHidden?: (request: HiddenRequest) => Promise<{ value: unknown }>,
    verifyEdges?: (request: EdgeRequest) => Promise<{ value: unknown }>
  ) => ({
    complete: vi.fn(async (request: SignalRequest) => ({ value: reads(request.variant) })),
    ...(verifyHidden ? { verifyHidden: vi.fn(verifyHidden) } : {}),
    ...(verifyEdges ? { verifyEdges: vi.fn(verifyEdges) } : {}),
    model: "m",
    reasoning: "medium"
  });
  const run = (d: ReturnType<typeof deps>) => readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: d });
  const twoFingers = (variant: "A" | "B") => raw({ rowsHiddenByObjects: [variant === "A" ? FINGER_A : FINGER_B] });
  const passes = async () => ({ value: check("ONLY_BULLET_MARGIN_OR_BLANK", {}, 2) });

  it("positivo (nueva-04): dos lecturas dudan por un dedo, ambas verificaciones confirman que solo tapa el guion -> documento completo", async () => {
    const d = deps(twoFingers, passes);
    const result = await run(d);
    expect(result.signal.completeDocumentVisible).toBe(true);
    expect(result.signal.integrity).toMatchObject({ problems: [], hiddenVerified: true, hiddenNotes: [] });
    expect(d.verifyHidden).toHaveBeenCalledTimes(2);
    const [a, b] = vi.mocked(d.verifyHidden!).mock.calls.map((call) => call[0]);
    expect(a!.hidden).toEqual([FINGER_A, FINGER_B]);
    expect(a!.instructions).not.toEqual(b!.instructions);
    expect(result.raw).toHaveLength(2);
  });

  it("la misma descripción en las dos lecturas se pregunta una sola vez", async () => {
    const d = deps(() => raw(), async () => ({ value: check() }));
    await run(d);
    expect(vi.mocked(d.verifyHidden!).mock.calls[0]![0].hidden).toEqual([FINGER_A]);
  });

  it("negativo: si UNA de las dos verificaciones ve que podría tapar texto de un estudio, sigue bloqueado", async () => {
    const d = deps(twoFingers, async (request) => ({ value: check(request.variant === "A" ? "ONLY_BULLET_MARGIN_OR_BLANK" : "STUDY_TEXT", {}, 2) }));
    const result = await run(d);
    expect(result.signal.completeDocumentVisible).toBe(false);
    expect(result.signal.integrity.hiddenVerified).toBe(false);
    expect(result.signal.integrity.hiddenNotes?.join(" ")).toContain("verificación B");
    expect(result.signal.integrity.problems.join(" ")).toContain("oculto por un objeto");
  });

  it("negativo: marca de selección tapada (en un formulario con casillas), otras dudas o falta de texto contiguo bloquean", async () => {
    for (const value of [check("MARK_OR_SELECTION", {}, 2), check("ONLY_BULLET_MARGIN_OR_BLANK", { otherDoubts: true }, 2), check("ONLY_BULLET_MARGIN_OR_BLANK", {}, 1)]) {
      const result = await run(deps(twoFingers, async () => ({ value })));
      expect(result.signal.completeDocumentVisible).toBe(false);
    }
    const form = deps((variant) => raw({ documentType: "MARK_DEPENDENT_FORM", rowsHiddenByObjects: [variant === "A" ? FINGER_A : FINGER_B] }), async () => ({ value: check("MARK_OR_SELECTION", {}, 2) }));
    expect((await run(form)).signal.completeDocumentVisible).toBe(false);
  });

  it("falla cerrado si la verificación lanza, devuelve un formato inválido o no hay verificador", async () => {
    const error = await run(deps(twoFingers, async () => { throw new Error("HTTP 503"); }));
    expect(error.signal.completeDocumentVisible).toBe(false);
    expect(error.signal.integrity.hiddenNotes?.join(" ")).toContain("no disponible");
    expect((await run(deps(twoFingers, async () => ({ value: { items: "mal" } })))).signal.completeDocumentVisible).toBe(false);
    expect((await run(deps(twoFingers))).signal.completeDocumentVisible).toBe(false);
  });

  it("no se verifica (ni se perdona) cuando además hay cortes por el borde, trazos ilegibles, caja inválida o una duda sin explicar", async () => {
    const cases: Array<(variant: "A" | "B") => RawSignal> = [
      () => raw({ rowsCutByImageEdge: ["Hepatitis B Antígeno de Superf"] }),
      () => raw({ erasedOrIllegible: true }),
      () => raw({ studyRegion: { left: 900, top: 10, right: 100, bottom: 50 } }),
      (variant) => (variant === "A" ? raw() : raw({ rowsHiddenByObjects: [] })) // B duda sin explicar nada
    ];
    for (const reads of cases) {
      const d = deps(reads, passes);
      const result = await run(d);
      expect(d.verifyHidden).not.toHaveBeenCalled();
      expect(result.signal.completeDocumentVisible).toBe(false);
    }
  });

  it("no se verifica si los tipos difieren o no es una solicitud", async () => {
    const mixed = deps((variant) => raw({ documentType: variant === "A" ? "HANDWRITTEN_REQUEST" : "MARK_DEPENDENT_FORM" }), passes);
    expect((await run(mixed)).signal.documentType).toBe("UNKNOWN");
    expect(mixed.verifyHidden).not.toHaveBeenCalled();
    const notRequest = deps(() => raw({ documentType: "NOT_A_REQUEST" }), passes);
    await run(notRequest);
    expect(notRequest.verifyHidden).not.toHaveBeenCalled();
  });

  it("sin objetos ocultos no hay verificación adicional ni costo extra", async () => {
    const d = deps(() => raw({ studyRegionComplete: true, rowsHiddenByObjects: [] }), passes);
    const result = await run(d);
    expect(d.verifyHidden).not.toHaveBeenCalled();
    expect(result.signal.completeDocumentVisible).toBe(true);
    expect(d.complete).toHaveBeenCalledTimes(2);
  });

  it("verificados los ocultamientos, una zona junto al borde todavía pasa por la verificación de bordes (y si esta falla, bloquea)", async () => {
    const near = (variant: "A" | "B") => raw({ studyRegion: { left: 30, top: 0, right: 680, bottom: 590 }, rowsHiddenByObjects: [variant === "A" ? FINGER_A : FINGER_B] });
    const edgeOk = async () => ({ value: { checks: [{ edge: "top", elementsNearEdge: [{ text: "Urea", fullyVisible: true }], anythingContinuesBeyondEdge: false }], reason: "" } });
    const ok = deps(near, passes, edgeOk);
    expect((await run(ok)).signal.completeDocumentVisible).toBe(true);
    expect(ok.verifyEdges).toHaveBeenCalledTimes(2);
    const bad = deps(near, passes, async () => ({ value: { checks: [{ edge: "top", elementsNearEdge: [{ text: "Urea", fullyVisible: true }], anythingContinuesBeyondEdge: true }], reason: "" } }));
    const result = await run(bad);
    expect(result.signal.completeDocumentVisible).toBe(false);
    expect(result.signal.integrity.problems.join(" ")).toContain("borde superior");
  });
});
