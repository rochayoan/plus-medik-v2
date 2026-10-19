import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps } from "../src/analyze.js";
import { derivationCues, functionInstructions, fuseFunction, type FunctionCheck, type FunctionKind, type FunctionRequest } from "../src/document-function.js";
import { readDocumentSignal, type EdgeRequest, type HiddenRequest, type RawSignal, type SignalRequest } from "../src/document-signal.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { CatalogStudy } from "../src/types.js";

// La FUNCIÓN del documento (¿pide estudios a un paciente?) es independiente de su formato visual. Pruebas con documentos, frases y estudios variados;
// ninguna depende de un archivo, un nombre de paciente ni de una receta concreta.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-function-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const check = (kind: FunctionKind, reason = "x"): FunctionCheck => ({ function: kind, visibleEvidence: [], reason });

describe("derivationCues: solo frases que unen envío/derivación con una muestra", () => {
  const positives = [
    "DERIVACION DE MUESTRA", "Derivación de muestras", "Muestra derivada", "muestras ya tomadas", "Muestra enviada al laboratorio de referencia",
    "Envío de muestra", "remisión de la muestra", "Etiqueta de muestra", "Rótulo del tubo", "Tarjeta de muestra", "Ficha de muestra", "Recepción de muestras",
    "Identificación de la muestra", "Código de muestra", "TRASLADO DE MUESTRAS", "derivacion de muestra hosp. catolico"
  ];
  const negatives = [
    "Derivación a laboratorio", "Paciente derivado de Medicina Interna", "Tipo de muestra", "Toma de muestra: 7:00", "Solicitud de exámenes de laboratorio",
    "Servicio de banco de sangre", "Hemograma completo", "Muestra: orina de 24 horas", "Envío de resultados por correo", "Referencia y contrarreferencia",
    "Dr. Fulano - Médico internista", "Sangre segura", "", "   "
  ];

  for (const text of positives) it(`señal: «${text}»`, () => expect(derivationCues([text])).toEqual([text.trim()]));
  for (const text of negatives) it(`NO es señal por sí sola: «${text}»`, () => expect(derivationCues([text])).toEqual([]));

  it("sin repetir y con cualquier orden de entrada", () => {
    expect(derivationCues(["Código de muestra", "hola", "Código de muestra"])).toEqual(["Código de muestra"]);
  });
});

describe("fuseFunction: fallo cerrado ante discrepancia", () => {
  const verdictOf = (a: FunctionKind, b: FunctionKind) => fuseFunction(check(a), check(b)).verdict;

  it("solo dos MEDICAL_REQUEST es solicitud", () => {
    expect(verdictOf("MEDICAL_REQUEST", "MEDICAL_REQUEST")).toBe("REQUEST");
  });
  it("dos lecturas que dicen que no es solicitud (aunque con distinta clase) es no cotizable", () => {
    for (const [a, b] of [["SAMPLE_DERIVATION", "SAMPLE_DERIVATION"], ["SAMPLE_DERIVATION", "SAMPLE_LABEL"], ["OTHER_NON_REQUEST", "SAMPLE_LABEL"]] as const) expect(verdictOf(a, b)).toBe("NON_QUOTABLE");
  });
  it("cualquier discrepancia o duda es UNCLEAR (nunca se cotiza)", () => {
    for (const [a, b] of [["MEDICAL_REQUEST", "SAMPLE_DERIVATION"], ["SAMPLE_DERIVATION", "MEDICAL_REQUEST"], ["UNCLEAR", "MEDICAL_REQUEST"], ["UNCLEAR", "SAMPLE_LABEL"], ["UNCLEAR", "UNCLEAR"]] as const) expect(verdictOf(a, b)).toBe("UNCLEAR");
  });
});

describe("functionInstructions: mismas definiciones en las dos lecturas, distinto método", () => {
  const a = functionInstructions("A", ["DERIVACION DE MUESTRA"]);
  const b = functionInstructions("B", ["DERIVACION DE MUESTRA"]);
  const methodOf = (text: string) => text.split("\n").find((line) => line.startsWith("Método:"))!;

  it("incluye las frases vistas y distingue función de formato y de una palabra suelta", () => {
    for (const text of [a, b]) {
      expect(text).toContain("- DERIVACION DE MUESTRA");
      expect(text).toContain("Clasifica por la FUNCIÓN del documento, no por su formato");
      expect(text).toContain("Una palabra suelta como 'derivación' no basta");
      expect(text).toContain("Ante la duda razonable, UNCLEAR");
      expect(text).toContain("'derivado a laboratorio', con los estudios por realizar, es MEDICAL_REQUEST");
    }
  });
  it("solo cambia el método y el orden de las definiciones", () => {
    expect(a).not.toEqual(b);
    expect(methodOf(a)).not.toEqual(methodOf(b));
    const defs = (text: string) => text.split("\n").filter((line) => /^- (MEDICAL_REQUEST|SAMPLE_|OTHER_|UNCLEAR)/.test(line)).sort();
    expect(defs(a)).toEqual(defs(b));
  });
});

describe("readDocumentSignal: la función decide el tipo efectivo del documento", () => {
  const raw = (overrides: Partial<RawSignal> = {}): RawSignal => ({
    documentType: "HANDWRITTEN_REQUEST",
    studyRegion: { left: 100, top: 200, right: 800, bottom: 700 },
    studyRegionComplete: true,
    rowsCutByImageEdge: [],
    rowsHiddenByObjects: [],
    erasedOrIllegible: false,
    irrelevantCrops: [],
    printedContext: [],
    reason: "documento con la prueba escrita a mano",
    ...overrides
  });
  const ctx = (text: string) => ({ text, role: "TITLE" as const, appliesToAllStudies: true, declaresSpecimen: "NONE" as const, declaresCollection: "NONE" as const });
  const deps = (
    reads: (variant: "A" | "B") => RawSignal,
    verifyFunction?: (request: FunctionRequest) => Promise<{ value: unknown }>,
    verifyHidden?: (request: HiddenRequest) => Promise<{ value: unknown }>,
    verifyEdges?: (request: EdgeRequest) => Promise<{ value: unknown }>
  ) => ({
    complete: vi.fn(async (request: SignalRequest) => ({ value: reads(request.variant) })),
    ...(verifyFunction ? { verifyFunction: vi.fn(verifyFunction) } : {}),
    ...(verifyHidden ? { verifyHidden: vi.fn(verifyHidden) } : {}),
    ...(verifyEdges ? { verifyEdges: vi.fn(verifyEdges) } : {}),
    model: "m",
    reasoning: "medium"
  });
  const run = (d: ReturnType<typeof deps>) => readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: d });
  // La frase de derivación la ve SOLO UNA de las dos lecturas (como en el caso real que originó esta corrección).
  const oneReadSeesIt = (type: RawSignal["documentType"] = "HANDWRITTEN_REQUEST", text = "DERIVACION DE MUESTRA") => (variant: "A" | "B") => raw({ documentType: type, printedContext: variant === "B" ? [ctx(text)] : [] });
  const answers = (kind: FunctionKind) => async () => ({ value: check(kind) });

  it("sin frases de derivación no hay comprobación ni costo extra", async () => {
    const d = deps(() => raw(), answers("SAMPLE_DERIVATION"));
    const result = await run(d);
    expect(d.verifyFunction).not.toHaveBeenCalled();
    expect(result.signal.documentType).toBe("HANDWRITTEN_REQUEST");
    expect(result.signal.function).toBeUndefined();
  });

  for (const type of ["HANDWRITTEN_REQUEST", "MARK_DEPENDENT_FORM", "TEXT_EXPLICIT_REQUEST"] as const) {
    it(`derivación confirmada por las dos lecturas (formato ${type}): NOT_A_REQUEST, sea cual sea el formato`, async () => {
      const d = deps(oneReadSeesIt(type), answers("SAMPLE_DERIVATION"));
      const result = await run(d);
      expect(d.verifyFunction).toHaveBeenCalledTimes(2);
      expect(result.signal.documentType).toBe("NOT_A_REQUEST");
      expect(result.signal.function).toMatchObject({ verdict: "NON_QUOTABLE", kinds: ["SAMPLE_DERIVATION", "SAMPLE_DERIVATION"] });
      expect(result.signal.function?.cues).toEqual(["DERIVACION DE MUESTRA"]);
    });
  }

  it("las dos lecturas del verificador son distintas (A y B)", async () => {
    const d = deps(oneReadSeesIt(), answers("SAMPLE_LABEL"));
    await run(d);
    const [x, y] = vi.mocked(d.verifyFunction!).mock.calls.map((call) => call[0]);
    expect(x!.variant).toBe("A");
    expect(y!.variant).toBe("B");
    expect(x!.instructions).not.toEqual(y!.instructions);
  });

  it("una solicitud válida que menciona una derivación o un envío NO se rechaza: el verificador la confirma", async () => {
    for (const text of ["Envío de muestra al laboratorio central", "Derivación de muestra: ver reverso", "Etiqueta de muestra pegada aquí"]) {
      const result = await run(deps(oneReadSeesIt("MARK_DEPENDENT_FORM", text), answers("MEDICAL_REQUEST")));
      expect(result.signal.documentType).toBe("MARK_DEPENDENT_FORM");
      expect(result.signal.function?.verdict).toBe("REQUEST");
    }
  });

  it("una solicitud con la palabra «derivación» pero sin frase de muestra ni verificación no se toca", async () => {
    const d = deps(oneReadSeesIt("HANDWRITTEN_REQUEST", "Paciente derivado de Cirugía, solicitar estudios"), answers("SAMPLE_DERIVATION"));
    const result = await run(d);
    expect(d.verifyFunction).not.toHaveBeenCalled();
    expect(result.signal.documentType).toBe("HANDWRITTEN_REQUEST");
  });

  it("la frase puede venir del texto impreso, de la descripción de las lecturas o de los recortes irrelevantes", async () => {
    for (const source of ["reason", "irrelevantCrops"] as const) {
      const reads = (variant: "A" | "B") => (variant === "A" ? raw(source === "reason" ? { reason: "tarjeta de derivación de muestra con jeringa" } : { irrelevantCrops: ["rótulo del tubo de muestra"] }) : raw());
      const result = await run(deps(reads, answers("SAMPLE_DERIVATION")));
      expect(result.signal.documentType).toBe("NOT_A_REQUEST");
    }
  });

  it("discrepancia entre las dos lecturas, duda o formato inválido: UNKNOWN (nunca se cotiza)", async () => {
    const mixed = deps(oneReadSeesIt(), async (request) => ({ value: check(request.variant === "A" ? "MEDICAL_REQUEST" : "SAMPLE_DERIVATION") }));
    expect((await run(mixed)).signal.documentType).toBe("UNKNOWN");
    expect((await run(deps(oneReadSeesIt(), answers("UNCLEAR")))).signal.documentType).toBe("UNKNOWN");
    expect((await run(deps(oneReadSeesIt(), async () => ({ value: { function: "ALGO" } })))).signal.documentType).toBe("UNKNOWN");
  });

  it("si el verificador falla o no existe: UNKNOWN con el motivo", async () => {
    const failing = await run(deps(oneReadSeesIt(), async () => { throw new Error("HTTP 503"); }));
    expect(failing.signal.documentType).toBe("UNKNOWN");
    expect(failing.signal.function?.verdict).toBe("UNAVAILABLE");
    expect(failing.signal.function?.notes.join(" ")).toContain("no disponible");
  });

  it("sin verificador explícito (undefined): falla cerrado", async () => {
    const d = { ...deps(oneReadSeesIt()), verifyFunction: undefined };
    const result = await run(d as never);
    expect(result.signal.documentType).toBe("UNKNOWN");
    expect(result.signal.function?.notes.join(" ")).toContain("no hay verificador");
  });

  it("un documento que ya no es una solicitud por su tipo no se comprueba (ni gasta)", async () => {
    const d = deps(() => raw({ documentType: "NOT_A_REQUEST", printedContext: [ctx("DERIVACION DE MUESTRA")] }), answers("SAMPLE_DERIVATION"));
    await run(d);
    expect(d.verifyFunction).not.toHaveBeenCalled();
    const different = deps((variant) => raw({ documentType: variant === "A" ? "HANDWRITTEN_REQUEST" : "MARK_DEPENDENT_FORM", printedContext: [ctx("DERIVACION DE MUESTRA")] }), answers("SAMPLE_DERIVATION"));
    const result = await run(different);
    expect(different.verifyFunction).not.toHaveBeenCalled();
    expect(result.signal.documentType).toBe("UNKNOWN");
  });

  it("lo que no es cotizable no gasta verificaciones visuales posteriores (ocultamientos, bordes)", async () => {
    const hiddenRead = (variant: "A" | "B") => raw({ studyRegionComplete: false, rowsHiddenByObjects: ["una jeringa tapa el margen"], printedContext: variant === "B" ? [ctx("DERIVACION DE MUESTRA")] : [] });
    const passes = async () => ({ value: { items: [{ index: 0, couldHide: "ONLY_BULLET_MARGIN_OR_BLANK", visibleNeighbor: "x" }], otherDoubts: false, reason: "" } });
    const d = deps(hiddenRead, answers("SAMPLE_DERIVATION"), passes);
    const result = await run(d);
    expect(d.verifyHidden).not.toHaveBeenCalled();
    expect(result.signal.documentType).toBe("NOT_A_REQUEST");
  });

  it("una solicitud confirmada sí conserva las verificaciones visuales posteriores", async () => {
    const hiddenRead = (variant: "A" | "B") => raw({ studyRegionComplete: false, rowsHiddenByObjects: ["una jeringa tapa el margen"], printedContext: variant === "B" ? [ctx("DERIVACION DE MUESTRA")] : [] });
    const passes = async () => ({ value: { items: [{ index: 0, couldHide: "ONLY_BULLET_MARGIN_OR_BLANK", visibleNeighbor: "x" }], otherDoubts: false, reason: "" } });
    const d = deps(hiddenRead, answers("MEDICAL_REQUEST"), passes);
    const result = await run(d);
    expect(d.verifyHidden).toHaveBeenCalledTimes(2);
    expect(result.signal.documentType).toBe("HANDWRITTEN_REQUEST");
  });
});

describe("de la función del documento a la cotización (extremo a extremo)", () => {
  const study = (code: string, name: string, priceBs: number): CatalogStudy => ({ id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs, active: true, category: "QUIMICA SANGUINEA" });
  const catalog = [study("1", "GLUCOSA", 20), study("2", "CREATININA", 30)];
  const row = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high" });
  const texts: SimpleReading = { requestedStudies: [row("Glucosa"), row("Creatinina")], uncertainStudies: [], notes: "" };
  const raw = (variant: "A" | "B"): RawSignal => ({
    documentType: "HANDWRITTEN_REQUEST", studyRegion: { left: 100, top: 200, right: 800, bottom: 700 }, studyRegionComplete: true, rowsCutByImageEdge: [], rowsHiddenByObjects: [],
    erasedOrIllegible: false, irrelevantCrops: [], reason: "x",
    printedContext: variant === "B" ? [{ text: "DERIVACION DE MUESTRA", role: "TITLE", appliesToAllStudies: true, declaresSpecimen: "NONE", declaresCollection: "NONE" }] : []
  });
  const depsFor = (kind: FunctionKind): AnalyzeDeps => ({
    readGemini: vi.fn(async () => texts),
    readOpenAI: vi.fn(async () => texts),
    judge: vi.fn(async () => ({ resolvedStudies: [], unresolvedDisputes: [] })),
    readDocument: (args) =>
      readDocumentSignal({
        ...args,
        deps: { complete: async (request) => ({ value: raw(request.variant) }), verifyFunction: async () => ({ value: check(kind) }), model: "m", reasoning: "medium" }
      }),
    resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
    shadowMatch: vi.fn(async () => { throw new Error("no debe llamarse"); }) as unknown as AnalyzeDeps["shadowMatch"]
  });
  const base = { imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: false, partialAuto: true, handwrittenAuto: "on" as const };

  it("par adversario: los MISMOS estudios se cotizan si el documento es una solicitud y NO si es una derivación de muestra", async () => {
    const request = await analyzeImage(base, depsFor("MEDICAL_REQUEST"));
    expect(request.outcome).toBe("AUTO_COMPLETE");
    expect(request.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA", "CREATININA"]);

    for (const kind of ["SAMPLE_DERIVATION", "SAMPLE_LABEL", "OTHER_NON_REQUEST"] as const) {
      const result = await analyzeImage(base, depsFor(kind));
      expect(result.outcome).toBe("HUMAN_REVIEW");
      expect(result.decision).toBe("HUMAN_REVIEW");
      expect(result.publicQuote).toBeUndefined();
      expect(result.quote).toBeUndefined();
      expect(result.internal?.quoted.lines).toEqual([]);
      expect(result.internal?.recipeStops).toEqual(["not_a_request"]);
      expect(result.internal?.document.function).toMatchObject({ verdict: "NON_QUOTABLE", cues: ["DERIVACION DE MUESTRA"] });
    }
  });

  it("si no se puede comprobar la función, la receta se detiene por tipo incierto y el CRM guarda el porqué", async () => {
    const result = await analyzeImage(base, depsFor("UNCLEAR"));
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.internal?.recipeStops).toEqual(["document_type_uncertain"]);
    expect(result.internal?.document.function?.verdict).toBe("UNCLEAR");
  });

  it("assembleAnalysis no cotiza estudios de un documento NOT_A_REQUEST aunque cada uno esté perfectamente identificado", () => {
    const consensus = buildSimpleConsensus(texts, texts);
    const result = assembleAnalysis({ consensus, judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, document: { documentType: "NOT_A_REQUEST", completeDocumentVisible: true, agreement: true }, partialAuto: true });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.publicQuote).toBeUndefined();
  });

  it("la salida pública jamás menciona la función ni la derivación", async () => {
    const result = await analyzeImage(base, depsFor("MEDICAL_REQUEST"));
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/deriv|funci|muestra|NOT_A_REQUEST|cue/i);
  });
});

describe("señales por OBJETOS de muestra descritos en las lecturas existentes (sin palabras clave de derivación)", () => {
  const positives = [
    "Una jeringa oculta parte del encabezado y de los campos administrativos", "La jeringa tapa el margen izquierdo", "un tubo de ensayo sobre la hoja",
    "tubo con sangre delante del formulario", "Tubos de muestra a la izquierda", "un frasco de orina junto al papel", "recipiente con muestra de heces",
    "vial con suero", "ampolla sobre el formulario", "tubo Eppendorf", "criotubo rotulado"
  ];
  const negatives = [
    "CA 19.9 [páncreas y tubo gástrico]", "tubo digestivo", "Endoscopia del tubo digestivo alto", "un dedo oculta el margen", "sello rojo sobre las filas",
    "frasco de vidrio decorativo", "hoja superpuesta que oculta el título", "otra hoja de fondo", "anotación manuscrita junto a Otros"
  ];
  for (const text of positives) it(`señal por objeto: «${text}»`, () => expect(derivationCues([text])).toEqual([text]));
  for (const text of negatives) it(`NO es señal: «${text}»`, () => expect(derivationCues([text])).toEqual([]));

  const raw = (overrides: Partial<RawSignal> = {}): RawSignal => ({
    documentType: "HANDWRITTEN_REQUEST", studyRegion: { left: 100, top: 200, right: 800, bottom: 700 }, studyRegionComplete: true, rowsCutByImageEdge: [],
    rowsHiddenByObjects: [], erasedOrIllegible: false, irrelevantCrops: [], printedContext: [], reason: "pedido manuscrito", ...overrides
  });
  const deps = (reads: (variant: "A" | "B") => RawSignal, kind: FunctionKind) => ({
    complete: vi.fn(async (request: SignalRequest) => ({ value: reads(request.variant) })),
    verifyFunction: vi.fn(async () => ({ value: check(kind) })),
    model: "m",
    reasoning: "medium"
  });
  const run = (d: ReturnType<typeof deps>) => readDocumentSignal({ imageBase64: "aW1n", mimeType: "image/jpeg", deps: d });

  it("un objeto descrito SOLO como recorte irrelevante en UNA lectura activa la comprobación; sin impresos de derivación", async () => {
    const d = deps((variant) => raw(variant === "A" ? { irrelevantCrops: ["Una jeringa oculta parte del encabezado, sin tapar los estudios"] } : {}), "SAMPLE_DERIVATION");
    const result = await run(d);
    expect(d.verifyFunction).toHaveBeenCalledTimes(2);
    expect(result.signal.documentType).toBe("NOT_A_REQUEST");
    expect(result.signal.function?.cues[0]).toContain("jeringa");
  });

  it("un objeto en las filas ocultas también cuenta, y una solicitud real con un tubo al lado se confirma sin perder estudios", async () => {
    const hidden = (variant: "A" | "B") => raw({ studyRegionComplete: false, rowsHiddenByObjects: variant === "B" ? ["Un tubo de ensayo tapa el borde izquierdo"] : [] });
    const confirmed = await run(deps(hidden, "MEDICAL_REQUEST"));
    expect(confirmed.signal.documentType).toBe("HANDWRITTEN_REQUEST");
    expect(confirmed.signal.function?.verdict).toBe("REQUEST");
  });

  it("sin objetos ni frases no hay comprobación (costo cero)", async () => {
    const d = deps(() => raw({ irrelevantCrops: ["un sello en el margen"], reason: "solicitud manuscrita completa" }), "SAMPLE_DERIVATION");
    await run(d);
    expect(d.verifyFunction).not.toHaveBeenCalled();
  });
});
