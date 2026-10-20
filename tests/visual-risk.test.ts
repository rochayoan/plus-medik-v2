import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps, type DocumentGate } from "../src/analyze.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { ImpactStatus, StudyImpactResult } from "../src/study-impact.js";
import { classifyStudyRisk, zonesOf, type ZoneKind } from "../src/visual-risk.js";
import type { SimpleReading } from "../src/ai.js";
import type { CatalogStudy } from "../src/types.js";

// Pruebas del riesgo visual por estudio. Todas se escriben contra CATEGORÍAS de problema (tipo de zona × veredicto de la verificación), con
// catálogos y estudios distintos entre sí: nada depende de una receta, un archivo o un texto concreto.

// Los verificadores pasan por la cache local de IA: en pruebas se desactiva y apunta a un directorio temporal (nunca a .cache real).
let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "plusmedik-risk-"));
  process.env.AI_CACHE_DIR = cacheDir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(cacheDir, { recursive: true, force: true });
});

const study = (id: string, name: string, priceBs: number, category = "QUIMICA SANGUINEA", aliases: string[] = []): CatalogStudy => ({
  id, code: id.replace("uuid-", ""), name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category
});
const catalog: CatalogStudy[] = [
  study("uuid-1", "GLUCOSA", 20),
  study("uuid-2", "HEMOGRAMA COMPLETO AUTOMATIZADO", 45, "HEMATOLOGIA", ["Hemograma completo"]),
  study("uuid-3", "FACTOR VIII (ANTIHEMOFILICO A)", 350, "HEMATOLOGIA", ["Dosaje de Factor VIII"]),
  study("uuid-4", "TIEMPO DE COAGULACION", 25, "HEMATOLOGIA"),
  study("uuid-5", "SODIO", 60),
  study("uuid-6", "SODIO EN ORINA OCACIONAL O 24 HORAS", 80, "URIANALISIS"),
  study("uuid-7", "ACIDO URICO", 30),
  study("uuid-8", "ACIDO URICO EN ORINA 24 HORAS", 70, "URIANALISIS"),
  study("uuid-9", "IONOGRAMA 1 (sodio, potasio, cloro)", 150, "QUIMICA SANGUINEA", ["ELECTROLITOS EN SANGRE (NA, K Y CL)"]),
  study("uuid-10", "POTASIO", 60)
];

const row = (literalText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence });
const reading = (...studies: SimpleStudy[]): SimpleReading => ({ requestedStudies: studies, uncertainStudies: [], notes: "" });
const doc = (overrides: Partial<DocumentGate> = {}): DocumentGate => ({ documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [], ...overrides });
const withZone = (kinds: string[], overrides: Partial<DocumentGate> = {}) => doc({ completeDocumentVisible: false, integrityProblems: kinds.map((kind) => `problema ${kind}`), integrityKinds: kinds, ...overrides });

// Veredicto por estudio (texto leído -> estado); lo no nombrado queda INDEPENDENT.
function impact(verdicts: Record<string, ImpactStatus> = {}, options: { qualifierRisk?: boolean; texts: string[] }): StudyImpactResult {
  const findings = new Map(options.texts.map((text) => [normalizeStudyKey(text), verdicts[text] ?? "INDEPENDENT"] as const));
  return {
    available: true,
    unaffected: new Set([...findings].filter(([, status]) => status === "INDEPENDENT").map(([key]) => key)),
    findings,
    qualifierRisk: options.qualifierRisk ?? false,
    notes: []
  };
}

function run(texts: string[], document: DocumentGate | undefined, impactResult?: StudyImpactResult, extra: { handwrittenAllowed?: boolean } = {}) {
  const a = reading(...texts.map((text) => row(text)));
  return assembleAnalysis({ consensus: buildSimpleConsensus(a, a), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, document, partialAuto: true, impact: impactResult, ...extra });
}

const ALL_KINDS: ZoneKind[] = ["CUT_EDGE", "HIDDEN", "EDGE_UNVERIFIED", "ERASED", "INVALID_BOX", "UNEXPLAINED_DOUBT", "UNTYPED"];
const LOCATED_KINDS = ["CUT_EDGE", "HIDDEN", "EDGE_UNVERIFIED"];
const FORBIDDEN = /HUMAN_REVIEW|\bAUTO\b|AUTO_|pending|pendiente|incomplet|revisi[oó]n|review|reason|motivo|blocker|document_|uuid|UNSEEN|CUT_EDGE|HIDDEN|ERASED|zona|borde|oculto|borrad/i;

describe("zonesOf: tipos de problema del documento -> zonas desconocidas", () => {
  it("un documento completo no tiene zonas", () => {
    expect(zonesOf({ kinds: ["CUT_EDGE"], incomplete: false })).toEqual([]);
  });

  it("cada tipo conocido es una zona; solo cortes, objetos y cercanía al borde están localizados", () => {
    for (const kind of ALL_KINDS.filter((k) => k !== "UNTYPED")) {
      expect(zonesOf({ kinds: [kind], incomplete: true })).toEqual([{ kind, located: LOCATED_KINDS.includes(kind) }]);
    }
  });

  it("un documento incompleto sin tipo (o con un tipo desconocido) es una zona UNTYPED, nunca 'sin problema'", () => {
    expect(zonesOf({ kinds: [], incomplete: true })).toEqual([{ kind: "UNTYPED", located: false }]);
    expect(zonesOf({ kinds: ["ALGO_NUEVO"], incomplete: true })).toEqual([{ kind: "UNTYPED", located: false }]);
  });

  it("varias zonas se conservan sin repetirse", () => {
    expect(zonesOf({ kinds: ["CUT_EDGE", "ERASED", "CUT_EDGE"], incomplete: true }).map((z) => z.kind)).toEqual(["CUT_EDGE", "ERASED"]);
  });
});

describe("classifyStudyRisk: solo se cotiza lo que se demuestra independiente", () => {
  const zonesFor = (kind: ZoneKind) => zonesOf({ kinds: [kind], incomplete: true });
  const available = (status: ImpactStatus, qualifierRisk = false): StudyImpactResult => ({ available: true, unaffected: status === "INDEPENDENT" ? new Set(["x"]) : new Set(), findings: new Map([["x", status]]), qualifierRisk, notes: [] });

  it("sin zonas desconocidas el estudio está CLARO, con cualquier verificación (o ninguna)", () => {
    for (const impactResult of [undefined, available("AFFECTED"), { ...available("INDEPENDENT"), available: false }]) {
      expect(classifyStudyRisk([], { key: "x", contextSensitive: true, impact: impactResult })).toEqual({ class: "CLEAR" });
    }
  });

  for (const kind of ALL_KINDS) {
    describe(`zona ${kind}`, () => {
      const zones = zonesFor(kind);
      it("sin verificación o con verificación no disponible: DESCONOCIDO y pendiente (nunca se supone lo oculto)", () => {
        for (const impactResult of [undefined, { ...available("INDEPENDENT"), available: false }]) {
          expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: impactResult })).toMatchObject({ class: "UNKNOWN", blocker: "document_impact_unverified" });
        }
      });

      it("veredictos: afectado, posiblemente afectado y no visible entero quedan AFECTADOS; sin respuesta queda DESCONOCIDO", () => {
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: available("AFFECTED") })).toMatchObject({ class: "AFFECTED", blocker: "document_may_alter_study" });
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: available("POSSIBLY_AFFECTED") })).toMatchObject({ class: "AFFECTED", blocker: "document_may_alter_study" });
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: available("NOT_FULLY_VISIBLE") })).toMatchObject({ class: "AFFECTED", blocker: "document_study_not_fully_visible" });
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: available("NO_ANSWER") })).toMatchObject({ class: "UNKNOWN", blocker: "document_impact_unverified" });
      });

      it("independiente sin riesgo de título oculto: INDEPENDIENTE", () => {
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: available("INDEPENDENT") })).toEqual({ class: "INDEPENDENT" });
      });

      it("un título oculto solo importa a los estudios con variantes sensibles; en zonas no localizadas nunca se descarta", () => {
        const located = LOCATED_KINDS.includes(kind);
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: true, impact: available("INDEPENDENT", true) })).toMatchObject({ class: "UNKNOWN", blocker: "document_context_unverified" });
        expect(classifyStudyRisk(zones, { key: "x", contextSensitive: false, impact: available("INDEPENDENT", true) })).toEqual({ class: "INDEPENDENT" });
        const sensitiveNoRisk = classifyStudyRisk(zones, { key: "x", contextSensitive: true, impact: available("INDEPENDENT", false) });
        expect(sensitiveNoRisk.class).toBe(located ? "INDEPENDENT" : "UNKNOWN");
      });
    });
  }

  it("compatibilidad: sin veredicto por estudio, quien no está confirmado se considera afectado", () => {
    const legacy: StudyImpactResult = { available: true, unaffected: new Set(["a"]), qualifierRisk: false, notes: [] };
    const zones = zonesFor("CUT_EDGE");
    expect(classifyStudyRisk(zones, { key: "a", contextSensitive: false, impact: legacy }).class).toBe("INDEPENDENT");
    expect(classifyStudyRisk(zones, { key: "b", contextSensitive: false, impact: legacy })).toMatchObject({ class: "AFFECTED", blocker: "document_may_alter_study" });
  });
});

describe("ninguna zona detiene la receta entera: cotización parcial de lo independiente", () => {
  const texts = ["Glucosa", "Hemograma completo", "Dosaje de Factor VIII", "Tiempo de coagulacion"];

  for (const kind of ALL_KINDS) {
    describe(`zona ${kind}`, () => {
      const document = kind === "UNTYPED" ? withZone([]) : withZone([kind]);

      it("sin verificación: nada se cotiza, pero no hay parada global; el CRM conserva cada estudio con su riesgo y la zona", () => {
        const result = run(texts, document);
        expect(result.outcome).toBe("HUMAN_REVIEW");
        expect(result.publicQuote).toBeUndefined();
        expect(result.internal?.recipeStops).toEqual([]);
        expect(result.internal?.studies.map((s) => s.risk?.class)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
        expect(result.internal?.document.zones.map((z) => z.kind)).toEqual([kind]);
        expect(result.internal?.document.impactCheck).toMatchObject({ needed: true });
        expect(result.internal?.document.impactCheck.candidates).toHaveLength(4);
      });

      it("con verificación mixta: solo se cotizan los independientes; afectados, casillas cubiertas y dudosos quedan en el CRM", () => {
        const verdicts = { "Hemograma completo": "AFFECTED", "Dosaje de Factor VIII": "NOT_FULLY_VISIBLE", "Tiempo de coagulacion": "POSSIBLY_AFFECTED" } as const;
        const result = run(texts, document, impact(verdicts, { texts }));
        expect(result.outcome).toBe("AUTO_PARTIAL");
        expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
        expect(result.internal?.quoted.lines.map((l) => l.id)).toEqual(["uuid-1"]);
        const byText = Object.fromEntries((result.internal?.studies ?? []).map((s) => [s.text, s]));
        expect(byText["Glucosa"]).toMatchObject({ decision: "AUTO", risk: { class: "INDEPENDENT" } });
        expect(byText["Hemograma completo"]).toMatchObject({ decision: "HUMAN_REVIEW", blockers: ["document_may_alter_study"], risk: { class: "AFFECTED" } });
        expect(byText["Dosaje de Factor VIII"]).toMatchObject({ decision: "HUMAN_REVIEW", blockers: ["document_study_not_fully_visible"] });
        expect(byText["Tiempo de coagulacion"]).toMatchObject({ decision: "HUMAN_REVIEW", blockers: ["document_may_alter_study"] });
        expect(result.internal?.pending.map((p) => p.kind)).toEqual(["STUDY", "STUDY", "STUDY", "UNSEEN_REGION"]);
        // el paciente no recibe nada de lo anterior
        expect(JSON.stringify(result.publicQuote)).not.toMatch(FORBIDDEN);
      });

      it("aunque todos sean independientes la receta NUNCA es AUTO completo: la zona desconocida queda pendiente en el CRM", () => {
        const result = run(texts, document, impact({}, { texts }));
        expect(result.outcome).toBe("AUTO_PARTIAL");
        expect(result.decision).toBe("HUMAN_REVIEW");
        expect(result.quote).toBeUndefined();
        expect(result.internal).toMatchObject({ recipeComplete: false, reviewRequired: true });
        expect(result.internal?.pending.map((p) => p.kind)).toEqual(["UNSEEN_REGION"]);
        expect(result.publicQuote?.totalBs).toBe(20 + 45 + 350 + 25);
      });

      it("si todo está afectado o la verificación falla no se cotiza nada", () => {
        const allAffected = Object.fromEntries(texts.map((text) => [text, "AFFECTED"])) as Record<string, ImpactStatus>;
        expect(run(texts, document, impact(allAffected, { texts })).outcome).toBe("HUMAN_REVIEW");
        expect(run(texts, document, { available: false, unaffected: new Set(), qualifierRisk: true, notes: ["falló"] }).outcome).toBe("HUMAN_REVIEW");
      });
    });
  }

  it("un estudio con OTRO bloqueo (sin coincidencia en el catálogo) no se manda a verificar ni se cotiza aunque no lo afecte ninguna zona", () => {
    const list = ["Glucosa", "Estudio que no existe"];
    const result = run(list, withZone(["CUT_EDGE"]));
    expect(result.internal?.document.impactCheck.candidates.map((c) => c.text)).toEqual(["Glucosa"]);
    const verified = run(list, withZone(["CUT_EDGE"]), impact({}, { texts: ["Glucosa"] }));
    expect(verified.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
    expect(verified.internal?.studies.find((s) => s.text === "Estudio que no existe")?.risk).toBeUndefined();
  });
});

describe("calificadores ocultos (título, instrucción de muestra o de 24 h)", () => {
  const texts = ["Sodio", "Acido urico", "Glucosa"];

  it("zona localizada y sin riesgo de título oculto: se cotizan todos los independientes", () => {
    const result = run(texts, withZone(["HIDDEN"]), impact({}, { texts, qualifierRisk: false }));
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["SODIO", "ACIDO URICO", "GLUCOSA"]);
  });

  it("con riesgo de título oculto: quedan pendientes los estudios con variantes de muestra/tiempo; el que no las tiene se cotiza", () => {
    const result = run(texts, withZone(["HIDDEN"]), impact({}, { texts, qualifierRisk: true }));
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
    expect(result.internal?.studies.filter((s) => s.decision === "HUMAN_REVIEW").map((s) => [s.text, s.blockers])).toEqual([
      ["Sodio", ["document_context_unverified"]],
      ["Acido urico", ["document_context_unverified"]]
    ]);
  });

  it("zona no localizada (trazos borrados): aunque la verificación diga que no hay riesgo, un título borrado no se descarta", () => {
    const result = run(texts, withZone(["ERASED"]), impact({}, { texts, qualifierRisk: false }));
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
    expect(result.internal?.studies.find((s) => s.text === "Sodio")?.blockers).toEqual(["document_context_unverified"]);
  });
});

describe("las demás validaciones por estudio siguen aplicando a los independientes", () => {
  it("un paquete y su componente no se cobran juntos aunque ambos sean independientes", () => {
    const texts = ["Electrolitos en sangre (NA, K y CL)", "Potasio"];
    const result = run(texts, withZone(["CUT_EDGE"]), impact({}, { texts }));
    expect(result.internal?.quoted.lines.map((l) => l.id)).toEqual(["uuid-9"]);
    expect(result.internal?.studies.find((s) => s.text === "Potasio")?.blockers).toContain("package_component_overlap");
  });

  it("estudios repetidos aportan una sola línea", () => {
    const texts = ["Glucosa", "GLUCOSA"];
    const result = run(texts, withZone(["HIDDEN"]), impact({}, { texts: ["Glucosa"] }));
    expect(result.internal?.quoted.lines).toHaveLength(1);
  });
});

describe("los motivos de la receta entera se conservan (y solo esos)", () => {
  const texts = ["Glucosa", "Hemograma completo"];
  const ok = impact({}, { texts });

  it("tipo de documento incierto, no es una solicitud y sin estudios detienen todo aunque haya verificación", () => {
    for (const [document, stop] of [
      [withZone(["CUT_EDGE"], { documentType: "UNKNOWN" }), "document_type_uncertain"],
      [withZone(["CUT_EDGE"], { documentType: "NOT_A_REQUEST" }), "not_a_request"],
      [undefined, "document_type_uncertain"]
    ] as const) {
      const result = run(texts, document, ok);
      expect(result.outcome).toBe("HUMAN_REVIEW");
      expect(result.internal?.recipeStops).toContain(stop);
      expect(result.internal?.quoted.lines).toEqual([]);
    }
    expect(run([], withZone(["CUT_EDGE"]), ok).internal?.recipeStops).toEqual(["no_requested_studies"]);
  });

  it("un manuscrito sin permiso sigue detenido; con permiso y trazos ilegibles solo cotiza lo independiente", () => {
    const hand = withZone(["ERASED"], { documentType: "HANDWRITTEN_REQUEST" });
    expect(run(texts, hand, ok).internal?.recipeStops).toEqual(["handwritten_out_of_scope"]);
    const allowed = run(texts, hand, impact({ "Hemograma completo": "POSSIBLY_AFFECTED" }, { texts }), { handwrittenAllowed: true });
    expect(allowed.outcome).toBe("AUTO_PARTIAL");
    expect(allowed.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
  });

  it("el contrato heredado no cambia: con zonas, decision y quote siguen significando 'receta completa'", () => {
    const result = run(texts, withZone(["ERASED"]), ok);
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("document_not_complete");
    expect(result.quote).toBeUndefined();
  });
});

describe("analyzeImage con zonas no tipificadas o ilegibles", () => {
  const texts = reading(row("Glucosa"), row("Hemograma completo"));
  const makeDeps = (document: DocumentGate, verifyImpact?: AnalyzeDeps["verifyImpact"]): AnalyzeDeps => ({
    readGemini: vi.fn(async () => texts),
    readOpenAI: vi.fn(async () => texts),
    judge: vi.fn(async () => ({ resolvedStudies: [], unresolvedDisputes: [] })),
    readDocument: vi.fn(async () => ({
      signal: {
        documentType: document.documentType,
        completeDocumentVisible: document.completeDocumentVisible,
        agreement: true,
        integrity: { problems: document.integrityProblems ?? [], irrelevantCrops: [], kinds: (document.integrityKinds ?? []) as never },
        reasons: ["", ""] as [string, string]
      }
    })),
    resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
    shadowMatch: vi.fn(async () => { throw new Error("no debe llamarse"); }) as unknown as AnalyzeDeps["shadowMatch"],
    ...(verifyImpact ? { verifyImpact } : {})
  });
  const base = { imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: false, partialAuto: true };

  it("trazos ilegibles: se verifica el impacto por estudio y se cotiza solo lo independiente", async () => {
    const verifyImpact = vi.fn(async (args: Parameters<NonNullable<AnalyzeDeps["verifyImpact"]>>[0]) => impact({ "Hemograma completo": "AFFECTED" }, { texts: args.studies.map((s) => s.text) }));
    const result = await analyzeImage(base, makeDeps(withZone(["ERASED"]), verifyImpact));
    expect(verifyImpact).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
  });

  it("un problema sin tipo ni descripción también se verifica, con un texto de contexto para el verificador", async () => {
    const verifyImpact = vi.fn(async (args: Parameters<NonNullable<AnalyzeDeps["verifyImpact"]>>[0]) => impact({}, { texts: args.studies.map((s) => s.text) }));
    const untyped = doc({ completeDocumentVisible: false, integrityProblems: [], integrityKinds: [] });
    const result = await analyzeImage(base, makeDeps(untyped, verifyImpact));
    expect(verifyImpact.mock.calls[0]![0].problems).toHaveLength(1);
    expect(verifyImpact.mock.calls[0]![0].problems[0]).toContain("no está tipificado");
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.internal?.document.zones).toEqual([{ kind: "UNTYPED", located: false }]);
  });

  it("falla cerrado: verificador que lanza => ningún estudio, sin parada global", async () => {
    const throwing = vi.fn(async () => { throw new Error("HTTP 503"); });
    const result = await analyzeImage(base, makeDeps(withZone(["ERASED"]), throwing));
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.internal?.recipeStops).toEqual([]);
    expect(result.internal?.studies.every((s) => s.risk?.class === "UNKNOWN")).toBe(true);
  });
});

describe("de las respuestas del verificador a la cotización (regresión de falsos bloqueos y de seguridad)", () => {
  const texts = ["Glucosa", "Hemograma completo", "Dosaje de Factor VIII"];
  const item = (index: number, overrides: Partial<{ rowFullyVisible: boolean; selectionFullyVisible: boolean; affected: "NO" | "POSSIBLY" | "YES"; note: string }> = {}) => ({
    index, rowFullyVisible: true, selectionFullyVisible: true, affected: "NO" as const, note: "lejos de la zona problemática", ...overrides
  });
  const verify = (read: (variant: "A" | "B") => { items: ReturnType<typeof item>[]; qualifiersMayBeHidden?: boolean }) =>
    import("../src/study-impact.js").then(({ verifyStudyImpact }) =>
      verifyStudyImpact(
        { imageBase64: "aW1n", mimeType: "image/jpeg", studies: texts.map((text) => ({ key: normalizeStudyKey(text), text })), problems: ["un sello tapa el final de otras filas"] },
        { call: async (request) => ({ value: { qualifiersMayBeHidden: false, reason: "", ...read(request.variant) } }), model: "m", reasoning: "medium" }
      )
    );
  const cut = withZone(["HIDDEN"]);

  it("dos lecturas que ven los estudios lejos de la zona: se cotizan todos (sin el bloqueo por duda genérica)", async () => {
    const result = run(texts, cut, await verify(() => ({ items: texts.map((_t, i) => item(i)) })));
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies).toHaveLength(3);
    expect(result.internal?.pending.map((p) => p.kind)).toEqual(["UNSEEN_REGION"]);
  });

  it("discrepancia real: si una lectura nombra un elemento concreto que toca un estudio, ese estudio queda pendiente y los demás se cotizan", async () => {
    const result = run(texts, cut, await verify((variant) => ({
      items: texts.map((_t, i) => (i === 1 && variant === "B" ? item(i, { affected: "POSSIBLY", note: "el sello cubre el final de su línea" }) : item(i)))
    })));
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA", "FACTOR VIII (ANTIHEMOFILICO A)"]);
    expect(result.internal?.studies.find((s) => s.text === "Hemograma completo")).toMatchObject({ decision: "HUMAN_REVIEW", blockers: ["document_may_alter_study"] });
  });

  it("casilla o texto cubiertos en CUALQUIERA de las lecturas: el estudio queda pendiente como no visible entero", async () => {
    for (const hidden of [{ selectionFullyVisible: false }, { rowFullyVisible: false }]) {
      const result = run(texts, cut, await verify((variant) => ({ items: texts.map((_t, i) => (i === 0 && variant === "A" ? item(i, hidden) : item(i))) })));
      expect(result.internal?.studies.find((s) => s.text === "Glucosa")?.blockers).toEqual(["document_study_not_fully_visible"]);
      expect(result.publicQuote?.studies).toHaveLength(2);
    }
  });

  it("una instrucción general oculta no bloquea a los estudios sin variantes, pero mantiene pendientes los que dependen de ella", async () => {
    const list = ["Glucosa", "Sodio", "Acido urico"];
    const result = run(list, withZone(["CUT_EDGE"]), await import("../src/study-impact.js").then(({ verifyStudyImpact }) =>
      verifyStudyImpact(
        { imageBase64: "aW1n", mimeType: "image/jpeg", studies: list.map((text) => ({ key: normalizeStudyKey(text), text })), problems: ["un doblez cubre el título"] },
        { call: async (request) => ({ value: { items: list.map((_t, i) => item(i)), qualifiersMayBeHidden: request.variant === "A", reason: "" } }), model: "m", reasoning: "medium" }
      )
    ));
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["GLUCOSA"]);
    expect(result.internal?.studies.filter((s) => s.blockers.includes("document_context_unverified")).map((s) => s.text)).toEqual(["Sodio", "Acido urico"]);
  });

  it("lo que ve el paciente no cambia: sin estados, zonas, bloqueos ni UUID, y el CRM conserva todo", async () => {
    const result = run(texts, cut, await verify((variant) => ({ items: texts.map((_t, i) => (i === 2 ? item(i, { affected: variant === "A" ? "NO" : "YES", note: "cubierto" }) : item(i))) })));
    expect(JSON.stringify(result.publicQuote)).not.toMatch(FORBIDDEN);
    expect(Object.keys(result.publicQuote ?? {}).sort()).toEqual(["studies", "tariff", "totalBs", "totalLabel"]);
    expect(result.internal?.document.zones).toEqual([{ kind: "HIDDEN", located: true }]);
    expect(result.internal?.pending.map((p) => p.kind)).toEqual(["STUDY", "UNSEEN_REGION"]);
  });
});
