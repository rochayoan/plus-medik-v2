import { describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, partialAutoEnabled, type AnalyzeDeps, type DocumentGate, type SemanticPrimaryInput } from "../src/analyze.js";
import type { FinalShadow, Outcome, ShadowBatch } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import { PUBLIC_TOTAL_LABEL } from "../src/partial-auto.js";
import type { StudyImpactResult } from "../src/study-impact.js";
import type { SimpleReading } from "../src/ai.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number, category = "QUIMICA SANGUINEA", aliases: string[] = []): CatalogStudy => ({
  id,
  code: id.replace("uuid-", ""),
  name,
  normalizedName: normalizeStudyKey(name),
  normalizedAliases: aliases.map(normalizeStudyKey),
  priceBs,
  active: true,
  category
});

const catalog: CatalogStudy[] = [
  study("uuid-108", "HEMOGRAMA COMPLETO AUTOMATIZADO", 45, "HEMATOLOGIA", ["Hemograma completo"]),
  study("uuid-384", "CREATININA", 30),
  study("uuid-423", "UREA", 30),
  study("uuid-372", "BUN DE UREA", 30),
  study("uuid-413", "IONOGRAMA 1 (sodio, potasio, cloro)", 150, "QUIMICA SANGUINEA", ["ELECTROLITOS EN SANGRE (NA, K Y CL)"]),
  study("uuid-415", "SODIO", 60),
  study("uuid-525", "SODIO EN ORINA OCACIONAL O 24 HORAS", 80, "URIANALISIS"),
  study("uuid-288", "PARASITOLOGICO SERIADO", 40, "PARASITOLOGIA"),
  study("uuid-289", "PARASITOLOGICO SIMPLE", 35, "PARASITOLOGIA")
];

const row = (literalText: string, confidence: SimpleStudy["confidence"] = "high", normalizedName = literalText): SimpleStudy => ({ literalText, normalizedName, evidence: "check", confidence });
const reading = (...studies: SimpleStudy[]): SimpleReading => ({ requestedStudies: studies, uncertainStudies: [], notes: "" });
const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const doc = (overrides: Partial<DocumentGate> = {}): DocumentGate => ({ documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [], ...overrides });
// Documento con zonas que no se ven (recorte por el borde): no invalida la lectura, pero puede haber MÁS estudios.
const CUT = doc({ completeDocumentVisible: false, integrityProblems: ["lectura A: cortado por el borde: fila inferior"], integrityKinds: ["CUT_EDGE"] });
const impactOk = (...texts: string[]): StudyImpactResult => ({ available: true, unaffected: new Set(texts.map(normalizeStudyKey)), qualifierRisk: false, notes: [] });

function run(options: {
  a?: SimpleReading;
  b?: SimpleReading;
  judgement?: SimpleJudgement;
  document?: DocumentGate | undefined;
  primary?: SemanticPrimaryInput;
  partialAuto?: boolean;
  semanticAuto?: boolean;
  handwrittenAllowed?: boolean;
  impact?: StudyImpactResult;
  catalog?: CatalogStudy[];
}) {
  const a = options.a ?? reading();
  const b = options.b ?? a;
  return assembleAnalysis({
    consensus: buildSimpleConsensus(a, b),
    judgement: options.judgement ?? noJudgement,
    catalog: options.catalog ?? catalog,
    document: "document" in options ? options.document : doc(),
    primary: options.primary,
    semanticAuto: options.semanticAuto,
    handwrittenAllowed: options.handwrittenAllowed,
    partialAuto: options.partialAuto ?? true,
    impact: options.impact
  });
}

describe("partialAutoEnabled (bandera)", () => {
  it("apagada por defecto; solo el valor exacto 'on' la enciende", () => {
    expect(partialAutoEnabled({})).toBe(false);
    expect(partialAutoEnabled({ CATALOG_PARTIAL_AUTO: "true" })).toBe(false);
    expect(partialAutoEnabled({ CATALOG_PARTIAL_AUTO: " ON " })).toBe(true);
  });
});

describe("AUTO COMPLETO: se conserva el comportamiento actual", () => {
  const both = reading(row("Hemograma completo"), row("Creatinina"));

  it("toda la receta identificada: AUTO_COMPLETE, y los campos heredados quedan exactamente como siempre", () => {
    const result = run({ a: both });
    expect(result.outcome).toBe("AUTO_COMPLETE");
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.reasons).toEqual([]);
    expect(result.quote?.lines.map((l) => [l.id, l.priceBs])).toEqual([["uuid-108", 45], ["uuid-384", 30]]);
    expect(result.quote?.totalBs).toBe(75);
    expect(result.internal).toMatchObject({ outcome: "AUTO_COMPLETE", recipeComplete: true, reviewRequired: false, pending: [], recipeStops: [] });
    expect(result.publicQuote).toEqual({ studies: [{ name: "HEMOGRAMA COMPLETO AUTOMATIZADO", priceBs: 45 }, { name: "CREATININA", priceBs: 30 }], totalBs: 75, totalLabel: PUBLIC_TOTAL_LABEL, tariff: "PACIENTE" });
  });

  it("con la bandera apagada no aparece ningún campo nuevo y el resultado heredado es idéntico", () => {
    const off = run({ a: both, partialAuto: false });
    expect(off.outcome).toBeUndefined();
    expect(off.publicQuote).toBeUndefined();
    expect(off.internal).toBeUndefined();
    const on = run({ a: both, partialAuto: true });
    const { outcome, publicQuote, internal, ...legacy } = on;
    expect(JSON.parse(JSON.stringify(legacy))).toEqual(JSON.parse(JSON.stringify(off)));
  });
});

describe("AUTO PARCIAL: cada estudio seguro se cotiza aunque otros requieran revisión", () => {
  const mixed = reading(row("Hemograma completo"), row("Creatinina"), row("Examen inventado"));

  it("un estudio sin coincidencia queda pendiente; los demás se cotizan", () => {
    const result = run({ a: mixed });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    // contrato heredado: una parcial NO es un AUTO completo
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.quote).toBeUndefined();
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO", "CREATININA"]);
    expect(result.publicQuote?.totalBs).toBe(75);
    expect(result.internal).toMatchObject({ recipeComplete: false, reviewRequired: true });
    expect(result.internal?.quoted.subtotalBs).toBe(75);
    expect(result.internal?.pending).toEqual([{ key: "examen inventado", kind: "STUDY", text: "Examen inventado", blockers: ["catalog_unmatched"], candidates: undefined }]);
    expect(result.internal?.studies.map((s) => [s.text, s.decision])).toEqual([["Hemograma completo", "AUTO"], ["Creatinina", "AUTO"], ["Examen inventado", "HUMAN_REVIEW"]]);
  });

  it("LO QUE VE EL PACIENTE: solo estudios, precios y el importe de esos estudios; nada de estados, pendientes, motivos ni UUID", () => {
    const result = run({ a: mixed });
    expect(Object.keys(result.publicQuote!).sort()).toEqual(["studies", "tariff", "totalBs", "totalLabel"]);
    expect(result.publicQuote!.studies.every((s) => Object.keys(s).sort().join() === "name,priceBs")).toBe(true);
    const text = JSON.stringify(result.publicQuote);
    expect(text).not.toMatch(/HUMAN_REVIEW|AUTO|AUTO_|pending|pendiente|incomplet|revisi|review|reason|motivo|blocker|catalog_|uuid|Examen inventado/i);
    // el importe se presenta como el total de los estudios cotizados, no como el de toda la receta
    expect(result.publicQuote!.totalLabel).toBe("Total de los estudios cotizados");
    expect(text).not.toMatch(/receta completa|total de la receta|total final/i);
  });

  it("LO QUE QUEDA EN EL CRM: el pendiente con sus bloqueos, los UUID cotizados y la auditoría de cada línea", () => {
    const result = run({ a: mixed });
    expect(result.internal?.quoted.lines.map((l) => [l.id, l.code, l.priceBs, l.basis])).toEqual([["uuid-108", "108", 45, ["EXACT_CONFIRMED"]], ["uuid-384", "384", 30, ["EXACT_CONFIRMED"]]]);
    expect(result.internal?.pending.map((p) => p.text)).toEqual(["Examen inventado"]);
    expect(result.internal?.revision).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ningún estudio verificable: HUMAN_REVIEW, sin cotización pública ni importe", () => {
    const result = run({ a: reading(row("Examen inventado"), row("Otro raro")) });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.publicQuote).toBeUndefined();
    expect(result.internal?.quoted.lines).toEqual([]);
    expect(result.internal?.pending).toHaveLength(2);
    expect(result.internal?.reviewRequired).toBe(true);
  });

  it("una disputa sin resolver entre lectores es un pendiente interno; el resto se cotiza", () => {
    const a = reading(row("Hemograma completo"), row("Urea"));
    const b = reading(row("Hemograma completo"));
    const consensus = buildSimpleConsensus(a, b);
    const judgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [{ dispute: consensus.disputes[0]!, reason: "borroso" }] };
    const result = run({ a, b, judgement });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
    expect(result.internal?.pending.map((p) => [p.kind, p.text])).toEqual([["DISPUTE", "urea"]]);
  });

  it("un estudio confirmado por el juez pero con certeza no alta queda pendiente (no se cotiza)", () => {
    const a = reading(row("Hemograma completo"), row("Creatinina", "medium"));
    const b = reading(row("Hemograma completo"));
    const judgement: SimpleJudgement = { resolvedStudies: [{ key: "creatinina", verdict: "confirmed", study: row("Creatinina", "medium"), reason: "se ve" }], unresolvedDisputes: [] };
    const result = run({ a, b, judgement });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.internal?.studies.find((s) => s.text === "Creatinina")).toMatchObject({ decision: "HUMAN_REVIEW", blockers: ["non_high_certainty_study"] });
  });

  it("una transcripción truncada junto a la completa: la truncada queda pendiente y la completa sigue", () => {
    const result = run({ a: reading(row("Hemograma completo"), row("Hemograma completo extra"), row("Hemograma")) });
    expect(result.internal?.studies.find((s) => s.text === "Hemograma")?.blockers).toContain("visual_partial_transcription");
  });
});

describe("matching semántico por estudio (GPT)", () => {
  const match = (studyId: string, support: "EXACT" | "LEXICAL" | "SEMANTIC" = "SEMANTIC"): Outcome => ({ kind: "MATCH", studyId, support, notes: [] });
  const shadow = (literalText: string, outcome: Outcome, agreement = true): FinalShadow => ({ literalText, outcome, agreement, passes: [outcome, outcome], modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] } });
  const batch = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: catalog.length });
  const texts = reading(row("Hemograma completo"), row("Coproparasitologico seriado"), row("Nitrogeno ureico/urea/nus"));
  const primary = (bun: Outcome): SemanticPrimaryInput => ({
    batch: batch(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Coproparasitologico seriado", match("uuid-288")), shadow("Nitrogeno ureico/urea/nus", bun))
  });
  const ambiguousBun: Outcome = { kind: "AMBIGUOUS", studyIds: ["uuid-372", "uuid-423"], reason: "BUN o urea" };

  it("con el AUTO semántico: el MATCH verificado se cotiza y la ambigüedad BUN/Urea queda pendiente con sus candidatos", () => {
    const result = run({ a: texts, primary: primary(ambiguousBun), semanticAuto: true });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => [s.name, s.priceBs])).toEqual([["HEMOGRAMA COMPLETO AUTOMATIZADO", 45], ["PARASITOLOGICO SERIADO", 40]]);
    expect(result.publicQuote?.totalBs).toBe(85);
    const pending = result.internal?.pending[0];
    expect(pending).toMatchObject({ kind: "STUDY", text: "Nitrogeno ureico/urea/nus", blockers: ["semantic_ambiguous"] });
    expect(pending?.candidates?.map((c) => c.id).sort()).toEqual(["uuid-372", "uuid-423"]);
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/BUN|UREA|372|423/);
  });

  it("sin el AUTO semántico, los MATCH solo semánticos no se cotizan (solo lo confirmado por el exacto)", () => {
    const result = run({ a: texts, primary: primary(ambiguousBun), semanticAuto: false });
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
    expect(result.internal?.studies.find((s) => s.text === "Coproparasitologico seriado")?.blockers).toEqual(["semantic_auto_not_enabled"]);
  });

  it("si el resolvedor semántico cayó, ningún estudio se cotiza", () => {
    const result = run({ a: texts, primary: { error: "HTTP 503" }, semanticAuto: true });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.publicQuote).toBeUndefined();
  });

  it("dos textos que resuelven al mismo UUID producen una sola línea", () => {
    const two = reading(row("Hemograma completo"), row("Biometria hematica completa"));
    const result = run({ a: two, primary: { batch: batch(shadow("Hemograma completo", match("uuid-108", "EXACT")), shadow("Biometria hematica completa", match("uuid-108", "SEMANTIC"))) }, semanticAuto: true });
    expect(result.publicQuote?.studies).toHaveLength(1);
    expect(result.publicQuote?.totalBs).toBe(45);
    expect(result.internal?.quoted.lines[0]?.texts).toEqual(["Hemograma completo", "Biometria hematica completa"]);
  });

  it("las dos lecturas difieren en una variante (seriado vs simple) aunque el nombre normalizado coincida: pendiente, no se asume una", () => {
    const a = reading(row("Coproparasitologico seriado", "high", "Coproparasitologico"), row("Hemograma completo"));
    const b = reading(row("Coproparasitologico simple", "high", "Coproparasitologico"), row("Hemograma completo"));
    const result = run({ a, b, primary: { batch: batch(shadow("Coproparasitologico seriado", match("uuid-288")), shadow("Hemograma completo", match("uuid-108", "EXACT"))) }, semanticAuto: true });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.internal?.studies.find((s) => s.text === "Coproparasitologico seriado")?.blockers).toContain("readers_variant_mismatch");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
  });

  it("paquete y componente: el paquete se cotiza y el componente suelto queda pendiente (no se cobra dos veces)", () => {
    const both = reading(row("ELECTROLITOS EN SANGRE (NA, K Y CL)"), row("Sodio"));
    const result = run({ a: both });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => [s.name, s.priceBs])).toEqual([["IONOGRAMA 1 (sodio, potasio, cloro)", 150]]);
    expect(result.internal?.studies.find((s) => s.text === "Sodio")).toMatchObject({ decision: "HUMAN_REVIEW", blockers: ["package_component_overlap"] });
  });
});

describe("manuscritos: el bloqueo por ser manuscrito se elimina con CATALOG_HANDWRITTEN_AUTO=on", () => {
  const written = reading(row("Hemograma completo"), row("Creatinina"));
  const handwritten = doc({ documentType: "HANDWRITTEN_REQUEST" });

  it("apagado (por defecto): toda la receta va a revisión por handwritten_out_of_scope", () => {
    const result = run({ a: written, document: handwritten, handwrittenAllowed: false });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("handwritten_out_of_scope");
    expect(result.internal?.recipeStops).toEqual(["handwritten_out_of_scope"]);
    expect(result.publicQuote).toBeUndefined();
  });

  it("encendido: llega a AUTO bajo los mismos requisitos que un impreso (y el motivo ya no se genera)", () => {
    const result = run({ a: written, document: handwritten, handwrittenAllowed: true });
    expect(result.outcome).toBe("AUTO_COMPLETE");
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.reasons).toEqual([]);
    expect(result.publicQuote?.totalBs).toBe(75);
  });

  it("encendido, pero con los mismos filtros por estudio: un estudio sin coincidencia queda pendiente y los demás se cotizan", () => {
    const result = run({ a: reading(row("Hemograma completo"), row("Examen inventado")), document: handwritten, handwrittenAllowed: true });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies).toHaveLength(1);
  });

  it("encendido NO relaja nada más: un manuscrito con trazos borrados no cotiza nada mientras no se demuestre que cada estudio es independiente", () => {
    const result = run({ a: written, document: doc({ documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: false, integrityKinds: ["ERASED"], integrityProblems: ["trazos borrados"] }), handwrittenAllowed: true });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.publicQuote).toBeUndefined();
    expect(result.internal?.recipeStops).toEqual([]);
    expect(result.internal?.studies.every((s) => s.risk?.class === "UNKNOWN")).toBe(true);
  });
});

describe("motivos que invalidan TODA la lectura: no se cotiza nada automáticamente aunque haya estudios verificados", () => {
  const verified = reading(row("Hemograma completo"), row("Creatinina"));
  const cases: Array<[string, DocumentGate | undefined]> = [
    ["sin señal de documento", undefined],
    ["tipo de documento incierto", doc({ documentType: "UNKNOWN" })],
    ["no es una solicitud", doc({ documentType: "NOT_A_REQUEST" })],
    ["tipo incierto aunque el documento además esté cortado", doc({ documentType: "UNKNOWN", completeDocumentVisible: false, integrityKinds: ["CUT_EDGE"] })]
  ];
  for (const [name, document] of cases) {
    it(name, () => {
      const result = run({ a: verified, document, impact: impactOk("Hemograma completo", "Creatinina") });
      expect(result.outcome).toBe("HUMAN_REVIEW");
      expect(result.publicQuote).toBeUndefined();
      expect(result.internal?.quoted.lines).toEqual([]);
      expect(result.internal?.recipeStops.length).toBeGreaterThan(0);
    });
  }

  it("una receta sin estudios identificados", () => {
    const result = run({ a: reading() });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.internal?.recipeStops).toEqual(["no_requested_studies"]);
  });
});

describe("zonas de la receta que no se ven (cortes, objetos): solo se cotiza lo que se comprueba que no está afectado", () => {
  const verified = reading(row("Hemograma completo"), row("Creatinina"));

  it("sin verificación de impacto no se asume nada: ningún estudio se cotiza", () => {
    const result = run({ a: verified, document: CUT });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.publicQuote).toBeUndefined();
    expect(result.internal?.studies.every((s) => s.blockers.includes("document_impact_unverified"))).toBe(true);
    // lo que falta comprobar queda indicado para que la capa de arriba lo verifique
    expect(result.internal?.document.impactCheck).toEqual({ needed: true, candidates: [{ key: "hemograma completo", text: "Hemograma completo" }, { key: "creatinina", text: "Creatinina" }] });
  });

  it("verificación no disponible: ningún estudio se cotiza", () => {
    const result = run({ a: verified, document: CUT, impact: { available: false, unaffected: new Set(), qualifierRisk: true, notes: ["falló"] } });
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.internal?.document.impact?.available).toBe(false);
  });

  it("verificados como no afectados: AUTO_PARCIAL, nunca completo (siempre queda 'zona que no se ve' pendiente en el registro interno)", () => {
    const result = run({ a: verified, document: CUT, impact: impactOk("Hemograma completo", "Creatinina") });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.publicQuote?.totalBs).toBe(75);
    expect(result.internal?.pending.map((p) => p.kind)).toEqual(["UNSEEN_REGION"]);
    expect(result.internal?.pending[0]?.blockers).toEqual(["CUT_EDGE"]);
    expect(result.internal?.recipeComplete).toBe(false);
    // el paciente no recibe ninguna mención a lo que no se vio
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/UNSEEN|zona|borde|cort|oculto|CUT_EDGE/i);
  });

  it("un estudio que una zona oculta podría modificar queda pendiente aunque los demás se cotizan", () => {
    const result = run({ a: verified, document: CUT, impact: impactOk("Hemograma completo") });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
    expect(result.internal?.studies.find((s) => s.text === "Creatinina")?.blockers).toEqual(["document_may_alter_study"]);
  });

  it("si lo oculto podría traer un título que califique los estudios, los que tienen variantes sensibles a eso quedan pendientes", () => {
    const sensitive = reading(row("Hemograma completo"), row("Sodio"));
    const result = run({ a: sensitive, document: CUT, impact: { ...impactOk("Hemograma completo", "Sodio"), qualifierRisk: true } });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
    expect(result.internal?.studies.find((s) => s.text === "Sodio")?.blockers).toEqual(["document_context_unverified"]);
  });

  it("un estudio con otro bloqueo no se envía a verificar impacto", () => {
    const result = run({ a: reading(row("Hemograma completo"), row("Examen inventado")), document: CUT });
    expect(result.internal?.document.impactCheck.candidates.map((c) => c.text)).toEqual(["Hemograma completo"]);
  });

  it("un objeto oculto sin verificar también es zona que no se ve (y no invalida la lectura)", () => {
    const hidden = doc({ completeDocumentVisible: false, integrityKinds: ["HIDDEN"], integrityProblems: ["oculto por un objeto: sello"] });
    const result = run({ a: verified, document: hidden, impact: impactOk("Hemograma completo", "Creatinina") });
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.internal?.pending[0]).toMatchObject({ kind: "UNSEEN_REGION", blockers: ["HIDDEN"] });
  });
});

describe("analyzeImage: la verificación de impacto solo se pide cuando hace falta", () => {
  const texts = reading(row("Hemograma completo"), row("Creatinina"));
  const makeDeps = (document: DocumentGate, verifyImpact?: AnalyzeDeps["verifyImpact"]): AnalyzeDeps => ({
    readGemini: vi.fn(async () => texts),
    readOpenAI: vi.fn(async () => texts),
    judge: vi.fn(async () => noJudgement),
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

  it("zona cortada + verificación que confirma: AUTO_PARTIAL con los estudios que ambas lecturas confirmaron", async () => {
    const verifyImpact = vi.fn(async (args: Parameters<NonNullable<AnalyzeDeps["verifyImpact"]>>[0]) => ({
      available: true, unaffected: new Set(args.studies.filter((s) => s.text === "Hemograma completo").map((s) => s.key)), qualifierRisk: false, notes: []
    }));
    const result = await analyzeImage(base, makeDeps(CUT, verifyImpact));
    expect(verifyImpact).toHaveBeenCalledTimes(1);
    expect(verifyImpact.mock.calls[0]![0].studies.map((s) => s.text)).toEqual(["Hemograma completo", "Creatinina"]);
    expect(verifyImpact.mock.calls[0]![0].problems).toEqual(["lectura A: cortado por el borde: fila inferior"]);
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO"]);
  });

  it("falla cerrado: sin verificador o con un verificador que lanza, no se cotiza nada", async () => {
    expect((await analyzeImage(base, makeDeps(CUT))).outcome).toBe("HUMAN_REVIEW");
    const throwing = vi.fn(async () => { throw new Error("HTTP 503"); });
    const result = await analyzeImage(base, makeDeps(CUT, throwing));
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("HUMAN_REVIEW");
    expect(result.internal?.document.impact?.notes.join(" ")).toContain("no disponible");
  });

  it("no se llama cuando el documento está completo, cuando la lectura es inválida o con la bandera apagada", async () => {
    const verifyImpact = vi.fn(async () => ({ available: true, unaffected: new Set<string>(), qualifierRisk: false, notes: [] }));
    expect((await analyzeImage(base, makeDeps(doc(), verifyImpact))).outcome).toBe("AUTO_COMPLETE");
    await analyzeImage(base, makeDeps(doc({ documentType: "NOT_A_REQUEST", completeDocumentVisible: false, integrityKinds: ["CUT_EDGE"] }), verifyImpact));
    await analyzeImage({ ...base, partialAuto: false }, makeDeps(CUT, verifyImpact));
    expect(verifyImpact).not.toHaveBeenCalled();
  });

  it("manuscrito con la bandera encendida y documento íntegro: AUTO completo extremo a extremo", async () => {
    const result = await analyzeImage({ ...base, handwrittenAuto: "on" }, makeDeps(doc({ documentType: "HANDWRITTEN_REQUEST" })));
    expect(result.outcome).toBe("AUTO_COMPLETE");
    expect(result.publicQuote?.totalBs).toBe(75);
    const off = await analyzeImage({ ...base, handwrittenAuto: "off" }, makeDeps(doc({ documentType: "HANDWRITTEN_REQUEST" })));
    expect(off.outcome).toBe("HUMAN_REVIEW");
    expect(off.reasons).toContain("handwritten_out_of_scope");
  });
});
