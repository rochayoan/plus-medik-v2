import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentInstructions,
  edgeCheckPassed,
  edgeInstructions,
  evaluateIntegrity,
  fuseContext,
  fuseSignals,
  readDocumentSignal,
  touchedEdges,
  type ContextLine,
  type EdgeCheck,
  type EdgeRequest,
  type RawSignal,
  type SignalRequest
} from "../src/document-signal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-integrity-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const line = (text: string, extra: Partial<ContextLine> = {}): ContextLine => ({
  text, role: "TITLE", appliesToAllStudies: true, declaresSpecimen: "NONE", declaresCollection: "NONE", ...extra
});
const bloodTitle = line("SOLICITUD DE EXAMEN DE SANGRE", { declaresSpecimen: "BLOOD" });

const raw = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  documentType: "MARK_DEPENDENT_FORM",
  studyRegion: { left: 80, top: 200, right: 900, bottom: 800 },
  studyRegionComplete: true,
  rowsCutByImageEdge: [],
  rowsHiddenByObjects: [],
  erasedOrIllegible: false,
  irrelevantCrops: [],
  printedContext: [],
  reason: "formulario",
  ...overrides
});
const nearTop = { left: 80, top: 0, right: 900, bottom: 800 };

describe("contexto impreso: solo lo que ambas lecturas coinciden en declarar", () => {
  it("una declaración de muestra respaldada por el texto de la línea y vista por ambas lecturas se aplica", () => {
    const context = fuseContext([bloodTitle], [bloodTitle]);
    expect(context).toMatchObject({ lines: ["SOLICITUD DE EXAMEN DE SANGRE"], muestra: "sangre", conflicts: [], unagreedLines: [] });
  });

  it("el nombre de un servicio que contiene 'sangre' no es una declaración de muestra", () => {
    const service = line("SERVICIO DE BANCO DE SANGRE", { declaresSpecimen: "NONE" });
    const context = fuseContext([service], [service]);
    expect(context.lines).toEqual(["SERVICIO DE BANCO DE SANGRE"]);
    expect(context.muestra).toBeUndefined();
  });

  it("si una lectura declara BLOOD y la otra NONE, no hay declaración", () => {
    expect(fuseContext([bloodTitle], [line(bloodTitle.text)]).muestra).toBeUndefined();
  });

  it("la declaración exige que la línea contenga de verdad la palabra (un modelo no puede inventar una muestra)", () => {
    const fake = line("SOLICITUD DE EXAMENES", { declaresSpecimen: "BLOOD" });
    expect(fuseContext([fake], [fake]).muestra).toBeUndefined();
  });

  it("una línea que califica solo una sección no declara nada para todos los estudios", () => {
    const section = line("EXAMENES DE ORINA", { role: "SECTION", appliesToAllStudies: false, declaresSpecimen: "URINE" });
    expect(fuseContext([section], [section]).muestra).toBeUndefined();
    // basta con que una de las dos lecturas la considere de sección
    expect(fuseContext([line("EXAMENES DE ORINA", { declaresSpecimen: "URINE" })], [section]).muestra).toBeUndefined();
  });

  it("contextos contradictorios (sangre y orina para todos los estudios) no desambiguan y se reportan", () => {
    const urine = line("MUESTRA: ORINA", { role: "INSTRUCTION", declaresSpecimen: "URINE" });
    const context = fuseContext([bloodTitle, urine], [bloodTitle, urine]);
    expect(context.muestra).toBeUndefined();
    expect(context.conflicts[0]).toMatch(/contradictorias/);
    expect(context.lines).toHaveLength(2);
  });

  it("recolección: 'orina de 24 horas' declara muestra y recolección; contradicciones se reportan", () => {
    const h24 = line("MUESTRA: ORINA DE 24 HORAS", { role: "INSTRUCTION", declaresSpecimen: "URINE", declaresCollection: "H24" });
    expect(fuseContext([h24], [h24])).toMatchObject({ muestra: "orina", tiempo: "24h" });
    const occasional = line("ORINA OCASIONAL", { role: "INSTRUCTION", declaresSpecimen: "URINE", declaresCollection: "OCCASIONAL" });
    const mixed = fuseContext([h24, occasional], [h24, occasional]);
    expect(mixed.tiempo).toBeUndefined();
    expect(mixed.conflicts.join(" ")).toContain("recolecciones");
  });

  it("las líneas que solo vio una lectura no se entregan y se registran aparte", () => {
    const context = fuseContext([bloodTitle, line("Texto dudoso")], [bloodTitle]);
    expect(context.lines).toEqual(["SOLICITUD DE EXAMEN DE SANGRE"]);
    expect(context.unagreedLines).toEqual(["Texto dudoso"]);
  });

  it("fuseSignals incluye el contexto fusionado y las instrucciones piden excluir datos personales", () => {
    const signal = fuseSignals(raw({ printedContext: [bloodTitle] }), raw({ printedContext: [bloodTitle] }));
    expect(signal.context?.muestra).toBe("sangre");
    for (const variant of ["A", "B"] as const) {
      const text = documentInstructions(variant);
      expect(text).toContain("NO incluyas nombres de estudios, datos del");
      expect(text).toContain('"Servicio de banco de sangre", "Sangre segura"');
    }
  });
});

describe("proximidad al borde frente a cortes reales", () => {
  it("touchedEdges detecta los bordes dentro del margen y no marca cajas inválidas", () => {
    expect(touchedEdges({ left: 80, top: 0, right: 990, bottom: 800 })).toEqual(["top", "right"]);
    expect(touchedEdges({ left: 80, top: 200, right: 900, bottom: 800 })).toEqual([]);
    expect(touchedEdges({ left: 500, top: 0, right: 100, bottom: 800 })).toEqual([]);
  });

  it("un borde verificado deja de contar como problema; los demás siguen contando", () => {
    const signal = raw({ studyRegion: { left: 5, top: 0, right: 900, bottom: 800 } });
    expect(evaluateIntegrity(signal).problems.join(" ")).toContain("izquierdo");
    const partial = evaluateIntegrity(signal, new Set(["top"]));
    expect(partial.complete).toBe(false);
    expect(partial.problems.join(" ")).toContain("izquierdo");
    expect(partial.problems.join(" ")).not.toContain("superior");
    expect(evaluateIntegrity(signal, new Set(["top", "left"])).complete).toBe(true);
  });

  it("edgeCheckPassed: exige nombrar lo que hay junto al borde, todo entero y nada que continúe", () => {
    const ok: EdgeCheck = { checks: [{ edge: "top", elementsNearEdge: [{ text: "Potasio", fullyVisible: true }], anythingContinuesBeyondEdge: false }], reason: "" };
    expect(edgeCheckPassed(ok, ["top"]).ok).toBe(true);
    const cases: Array<[EdgeCheck, string]> = [
      [{ ...ok, checks: [{ ...ok.checks[0]!, anythingContinuesBeyondEdge: true }] }, "continúa"],
      [{ ...ok, checks: [{ ...ok.checks[0]!, elementsNearEdge: [] }] }, "no se identificó"],
      [{ ...ok, checks: [{ ...ok.checks[0]!, elementsNearEdge: [{ text: "  ", fullyVisible: true }] }] }, "no se identificó"],
      [{ ...ok, checks: [{ ...ok.checks[0]!, elementsNearEdge: [{ text: "Hepatitis B Antígeno de Superf", fullyVisible: false }] }] }, "no se ve entero"],
      [{ ...ok, checks: [] }, "sin verificación"]
    ];
    for (const [value, note] of cases) {
      const result = edgeCheckPassed(value, ["top"]);
      expect(result.ok).toBe(false);
      expect(result.notes.join(" ")).toContain(note);
    }
    // con dos bordes, ambos deben pasar
    expect(edgeCheckPassed(ok, ["top", "right"]).ok).toBe(false);
  });

  it("las instrucciones de verificación distinguen contenido de líneas divisorias y exigen duda razonable => true", () => {
    for (const variant of ["A", "B"] as const) {
      const text = edgeInstructions(variant, ["top", "right"]);
      expect(text).toContain("Las líneas divisorias");
      expect(text).toContain("NO cuentan por sí solas");
      expect(text).toContain("duda razonable");
    }
  });
});

describe("readDocumentSignal: verificación enfocada de bordes", () => {
  const edgeOk = (edge: string): EdgeCheck => ({ checks: [{ edge: edge as "top", elementsNearEdge: [{ text: "Potasio", fullyVisible: true }], anythingContinuesBeyondEdge: false }], reason: "" });
  const deps = (signalOverrides: Partial<RawSignal>, verify?: (request: EdgeRequest) => Promise<{ value: unknown }>) => ({
    complete: vi.fn(async (_request: SignalRequest) => ({ value: raw(signalOverrides) })),
    ...(verify ? { verifyEdges: vi.fn(verify) } : {}),
    model: "m",
    reasoning: "medium"
  });
  const run = (d: ReturnType<typeof deps>) => readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/png", deps: d });

  it("zona junto al borde y ambas verificaciones pasan: documento completo, con el borde registrado como verificado", async () => {
    const d = deps({ studyRegion: nearTop }, async () => ({ value: edgeOk("top") }));
    const result = await run(d);
    expect(result.signal.completeDocumentVisible).toBe(true);
    expect(result.signal.integrity).toMatchObject({ problems: [], verifiedEdges: ["superior"], edgeNotes: [] });
    expect(d.verifyEdges).toHaveBeenCalledTimes(2);
    const [a, b] = vi.mocked(d.verifyEdges!).mock.calls.map((call) => call[0]);
    expect(a!.instructions).not.toEqual(b!.instructions);
    expect(a!.edges).toEqual(["top"]);
  });

  it("si una de las dos verificaciones ve algo que continúa fuera, el borde sigue bloqueando", async () => {
    const d = deps({ studyRegion: nearTop }, async (request) => ({
      value: request.variant === "A" ? edgeOk("top") : { checks: [{ edge: "top", elementsNearEdge: [{ text: "Potasio", fullyVisible: true }], anythingContinuesBeyondEdge: true }], reason: "" }
    }));
    const result = await run(d);
    expect(result.signal.completeDocumentVisible).toBe(false);
    expect(result.signal.integrity.problems.join(" ")).toContain("borde superior");
    expect(result.signal.integrity.edgeNotes?.join(" ")).toContain("verificación B");
    expect(result.signal.integrity.verifiedEdges).toEqual([]);
  });

  it("si la verificación falla o no está disponible, falla cerrado (no propaga la excepción)", async () => {
    const result = await run(deps({ studyRegion: nearTop }, async () => { throw new Error("HTTP 503"); }));
    expect(result.signal.completeDocumentVisible).toBe(false);
    expect(result.signal.integrity.edgeNotes?.join(" ")).toContain("no disponible");
    const invalid = await run(deps({ studyRegion: nearTop }, async () => ({ value: { checks: "mal" } })));
    expect(invalid.signal.completeDocumentVisible).toBe(false);
  });

  it("un documento REALMENTE cortado (filas cortadas, ocultas o ilegibles) nunca se verifica ni se relaja", async () => {
    for (const overrides of [
      { studyRegion: nearTop, rowsCutByImageEdge: ["Hepatitis B Antígeno de Superf"] },
      { studyRegion: nearTop, rowsHiddenByObjects: ["fila tapada por el sello"] },
      { studyRegion: nearTop, erasedOrIllegible: true },
      { studyRegion: nearTop, studyRegionComplete: false }
    ]) {
      const d = deps(overrides, async () => ({ value: edgeOk("top") }));
      const result = await run(d);
      expect(d.verifyEdges).not.toHaveBeenCalled();
      expect(result.signal.completeDocumentVisible).toBe(false);
    }
  });

  it("una caja inválida es un problema duro: no se verifica", async () => {
    const d = deps({ studyRegion: { left: 900, top: 0, right: 10, bottom: 800 } }, async () => ({ value: edgeOk("top") }));
    const result = await run(d);
    expect(d.verifyEdges).not.toHaveBeenCalled();
    expect(result.signal.completeDocumentVisible).toBe(false);
  });

  it("sin proximidad a ningún borde no se hace verificación adicional (sin costo extra)", async () => {
    const d = deps({}, async () => ({ value: edgeOk("top") }));
    const result = await run(d);
    expect(d.verifyEdges).not.toHaveBeenCalled();
    expect(result.signal.completeDocumentVisible).toBe(true);
    expect(d.complete).toHaveBeenCalledTimes(2);
  });

  it("un manuscrito junto al borde también se verifica (el AUTO manuscrito se evalúa en modo sombra), pero su tipo sigue siendo manuscrito", async () => {
    const handwritten = deps({ documentType: "HANDWRITTEN_REQUEST", studyRegion: nearTop }, async () => ({ value: edgeOk("top") }));
    const result = await run(handwritten);
    expect(handwritten.verifyEdges).toHaveBeenCalledTimes(2);
    expect(result.signal.documentType).toBe("HANDWRITTEN_REQUEST");
    expect(result.signal.completeDocumentVisible).toBe(true);
  });

  it("tipos distintos entre lecturas, o documentos que no son solicitudes, no se verifican", async () => {
    const mixed = {
      complete: vi.fn(async (request: SignalRequest) => ({ value: raw({ documentType: request.variant === "A" ? "MARK_DEPENDENT_FORM" : "HANDWRITTEN_REQUEST", studyRegion: nearTop }) })),
      verifyEdges: vi.fn(async (_request: EdgeRequest) => ({ value: edgeOk("top") })),
      model: "m",
      reasoning: "medium"
    };
    const result = await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/png", deps: mixed });
    expect(mixed.verifyEdges).not.toHaveBeenCalled();
    expect(result.signal.documentType).toBe("UNKNOWN");
    expect(result.signal.completeDocumentVisible).toBe(false);
    const notRequest = deps({ documentType: "NOT_A_REQUEST", studyRegion: nearTop }, async () => ({ value: edgeOk("top") }));
    await run(notRequest);
    expect(notRequest.verifyEdges).not.toHaveBeenCalled();
  });

  it("la verificación se pide con los bordes de cualquiera de las dos lecturas", async () => {
    const complete = vi.fn(async (request: SignalRequest) => ({ value: raw({ studyRegion: request.variant === "A" ? nearTop : { left: 80, top: 200, right: 995, bottom: 800 } }) }));
    const verifyEdges = vi.fn(async (_request: EdgeRequest) => ({ value: { checks: ["top", "right"].map((edge) => ({ edge, elementsNearEdge: [{ text: "x", fullyVisible: true }], anythingContinuesBeyondEdge: false })), reason: "" } }));
    const result = await readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/png", deps: { complete, verifyEdges, model: "m", reasoning: "medium" } });
    expect(vi.mocked(verifyEdges).mock.calls[0]![0].edges.sort()).toEqual(["right", "top"]);
    expect(result.signal.completeDocumentVisible).toBe(true);
  });
});
