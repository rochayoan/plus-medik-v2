import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeImage, assembleAnalysis, type AnalyzeDeps, type DocumentGate } from "../src/analyze.js";
import { approvedPackage, packageItems, shadowMatch, verifyDecision, verifyPackageComposition, type FinalShadow, type RawDecision, type ShadowBatch, type ShadowContext, type ShadowRequest } from "../src/catalog-shadow.js";
import { buildSimpleConsensus } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { CatalogStudy } from "../src/types.js";
import { normalizeStudyKey } from "../src/consensus.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-pkg-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const study = (code: string, name: string, category: string, priceBs: number, aliases: string[] = [], active = true): CatalogStudy => ({
  id: `uuid-${code}`,
  code,
  name,
  normalizedName: normalizeStudyKey(name),
  normalizedAliases: aliases.map(normalizeStudyKey),
  priceBs,
  active,
  category
});

// Réplica del catálogo real alrededor de los electrolitos: paquetes con su alias aprobado, estudios sueltos y variantes de orina.
const ionograma1 = study("413", "IONOGRAMA 1 (sodio, potasio, cloro)", "QUIMICA SANGUINEA", 150, ["ELECTROLITOS EN SANGRE (NA, K Y CL)"]);
const ionograma2 = study("414", "IONOGRAMA 2 (sodio, potasio, cloro, calcio ionico)", "QUIMICA SANGUINEA", 200, ["Electrolitos en sangre (sodio, potasio, calcio ionico y cloro)"]);
const sodio = study("415", "SODIO", "QUIMICA SANGUINEA", 60);
const potasio = study("416", "POTASIO", "QUIMICA SANGUINEA", 60);
const cloro = study("417", "CLORO", "QUIMICA SANGUINEA", 60);
const calcioIonico = study("373", "CALCIO IONICO", "QUIMICA SANGUINEA", 80);
const sodioOrina = study("525", "SODIO EN ORINA OCACIONAL O 24 HORAS", "URIANALISIS", 80);
const potasioOrina = study("522", "POTASIO EN ORINA OCACIONAL O 24 HORAS", "URIANALISIS", 80);
const cloroOrina = study("508", "CLORO EN ORINA OCACIONAL O 24 HORAS", "URIANALISIS", 80);
const glucosa = study("397", "GLUCOSA", "QUIMICA SANGUINEA", 30);
const glucosaOrina = study("398", "GLUCOSA EN ORINA", "URIANALISIS", 30);
const ego = study("514", "EXAMEN GENERAL DE ORINA COMPLETA", "URIANALISIS", 35);
const perfilSinLista = study("600", "PERFIL BASICO", "QUIMICA SANGUINEA", 120, ["Panel basico"]);
const catalog = [ionograma1, ionograma2, sodio, potasio, cloro, calcioIonico, sodioOrina, potasioOrina, cloroOrina, glucosa, glucosaOrina, ego, perfilSinLista];

const composite = (studies: CatalogStudy[], fragments: string[]): RawDecision => ({
  index: 0, status: "COMPOSITE", studies, alternatives: [], fragments, reading: "", confidence: "high", reason: "lista explícita", notes: []
});
const PRINTED = "ELECTROLITOS EN SANGRE (NA, K Y CL)";

describe("paquete aprobado: el alias exacto manda y se verifica su composición", () => {
  it("el texto impreso es el alias de 413 IONOGRAMA 1; GPT lo descompone en Na, K, Cl -> se acepta el paquete único", () => {
    const out = verifyDecision(PRINTED, composite([sodio, potasio, cloro], ["NA", "K", "CL"]), catalog);
    expect(out).toMatchObject({ kind: "MATCH", studyId: ionograma1.id, support: "EXACT" });
    if (out.kind === "MATCH") expect(out.notes[0]).toContain("componentes verificados");
  });

  it("el orden de los componentes propuestos no importa", () => {
    expect(verifyDecision(PRINTED, composite([cloro, sodio, potasio], ["CL", "NA", "K"]), catalog)).toMatchObject({ kind: "MATCH", studyId: ionograma1.id });
  });

  it("otra forma impresa del paquete (con calcio iónico) es otro alias y otro paquete: 414, no 413", () => {
    const printed = "Electrolitos en sangre (sodio, potasio, calcio iónico y cloro)";
    const out = verifyDecision(printed, composite([sodio, potasio, calcioIonico, cloro], ["sodio", "potasio", "calcio iónico", "cloro"]), catalog);
    expect(out).toMatchObject({ kind: "MATCH", studyId: ionograma2.id });
  });

  it("negativo: faltan componentes, sobran, o hay uno distinto -> revisión humana, nunca el paquete", () => {
    const cases: Array<[CatalogStudy[], string[], RegExp]> = [
      [[sodio, potasio], ["NA", "K"], /lista 3 componentes/],
      [[sodio, potasio, cloro, calcioIonico], ["NA", "K", "CL", "Ca"], /lista 3 componentes/],
      [[sodio, potasio, calcioIonico], ["NA", "K", "Ca"], /"cloro" del paquete no está entre los propuestos/]
    ];
    for (const [studies, fragments, reason] of cases) {
      const out = verifyDecision(PRINTED, composite(studies, fragments), catalog);
      expect(out.kind).toBe("REJECTED");
      if (out.kind === "REJECTED") {
        expect(out.reason).toMatch(reason);
        expect(out.reason).toContain("alias aprobado");
        expect(out.studyIds).toContain(ionograma1.id);
      }
    }
  });

  it("negativo: un componente de otra muestra (sodio EN ORINA) no sirve para un paquete de sangre", () => {
    const out = verifyDecision(PRINTED, composite([sodioOrina, potasio, cloro], ["NA", "K", "CL"]), catalog);
    expect(out.kind).toBe("REJECTED");
    const urineSet = verifyDecision(PRINTED, composite([sodioOrina, potasioOrina, cloroOrina], ["NA", "K", "CL"]), catalog);
    expect(urineSet.kind).toBe("REJECTED");
  });

  it("negativo: el paquete de 3 no acepta la descomposición de 4 (y viceversa): cada texto impreso se verifica contra SU paquete", () => {
    const four = verifyDecision("Electrolitos en sangre (sodio, potasio, calcio iónico y cloro)", composite([sodio, potasio, cloro], ["sodio", "potasio", "cloro"]), catalog);
    expect(four.kind).toBe("REJECTED");
  });

  it("negativo: un alias de un estudio que no lista sus componentes no se puede verificar -> revisión", () => {
    const out = verifyDecision("Panel basico", composite([sodio, potasio], ["sodio", "potasio"]), catalog);
    expect(out.kind).toBe("REJECTED");
    if (out.kind === "REJECTED") expect(out.reason).toContain("no lista sus componentes");
  });

  it("negativo: un componente inactivo, o un paquete inactivo (se ignora y se evalúa como compuesto normal)", () => {
    const inactiveSodio = { ...sodio, active: false };
    expect(verifyPackageComposition(ionograma1, [inactiveSodio, potasio, cloro]).ok).toBe(false);
    const withoutPackage = catalog.map((s) => (s.id === ionograma1.id ? { ...s, active: false } : s));
    expect(approvedPackage(PRINTED, withoutPackage)).toBeUndefined();
  });

  it("helpers: approvedPackage exige alias único y activo; packageItems lee la lista entre paréntesis", () => {
    expect(approvedPackage(PRINTED, catalog)?.code).toBe("413");
    expect(approvedPackage("electrolitos en sangre na k y cl", catalog)?.code).toBe("413");
    expect(approvedPackage("Sodio", catalog)?.code).toBe("415");
    expect(approvedPackage("algo inexistente", catalog)).toBeUndefined();
    const duplicate = [...catalog, study("999", "OTRO", "QUIMICA SANGUINEA", 1, ["ELECTROLITOS EN SANGRE (NA, K Y CL)"])];
    expect(approvedPackage(PRINTED, duplicate)).toBeUndefined();
    expect(packageItems(ionograma1)).toEqual(["sodio", "potasio", "cloro"]);
    expect(packageItems(ionograma2)).toEqual(["sodio", "potasio", "cloro", "calcio ionico"]);
    expect(packageItems(sodio)).toEqual([]);
  });
});

describe("compuestos sin paquete aprobado: los componentes heredan la muestra declarada FUERA de los fragmentos", () => {
  it("'Sodio, potasio y cloro en sangre' resuelve cada componente a su estudio de sangre", () => {
    const out = verifyDecision("Sodio, potasio y cloro en sangre", composite([sodio, potasio, cloro], ["Sodio", "potasio", "cloro"]), catalog);
    expect(out.kind).toBe("COMPOSITE");
    if (out.kind === "COMPOSITE") expect(out.components.map((c) => c.studyId)).toEqual([sodio.id, potasio.id, cloro.id]);
  });

  it("negativo: sin 'en sangre' ni contexto declarado, los mismos fragmentos siguen ambiguos (no se asume la muestra)", () => {
    const out = verifyDecision("Sodio, potasio y cloro", composite([sodio, potasio, cloro], ["Sodio", "potasio", "cloro"]), catalog);
    expect(out.kind).toBe("AMBIGUOUS");
  });

  it("con contexto declarado del documento (muestra=sangre) también se resuelven; con contexto sin declaración, no", () => {
    const declared: ShadowContext = { lines: ["SOLICITUD DE EXAMEN DE SANGRE"], muestra: "sangre" };
    expect(verifyDecision("Sodio, potasio y cloro", composite([sodio, potasio, cloro], ["Sodio", "potasio", "cloro"]), catalog, declared).kind).toBe("COMPOSITE");
    expect(verifyDecision("Sodio, potasio y cloro", composite([sodio, potasio, cloro], ["Sodio", "potasio", "cloro"]), catalog, { lines: ["SERVICIO DE SANGRE SEGURA"] }).kind).toBe("AMBIGUOUS");
  });

  it("la muestra de OTRO fragmento no se traslada: en 'Glucosa y orina completa' la orina no convierte la glucosa en urinaria ni la rechaza", () => {
    const out = verifyDecision("Glucosa y orina completa", composite([glucosa, ego], ["Glucosa", "orina completa"]), catalog);
    expect(out.kind).toBe("AMBIGUOUS"); // glucosa de sangre u orina: el texto no lo dice
    if (out.kind === "AMBIGUOUS") expect(out.reason).toContain("variantes plausibles");
    expect(out.kind).not.toBe("REJECTED");
  });

  it("una muestra explícita en el fragmento prevalece sobre la compartida", () => {
    const out = verifyDecision("Sodio en sangre y potasio en orina", composite([sodio, potasioOrina], ["Sodio en sangre", "potasio en orina"]), catalog);
    expect(out.kind).toBe("COMPOSITE");
  });
});

describe("shadowMatch de extremo a extremo con el paquete aprobado", () => {
  it("las dos pasadas (catálogo en orden inverso) descomponen y ambas se resuelven al mismo paquete", async () => {
    const refByName = (promptText: string, name: string) => promptText.split("\n").find((line) => new RegExp(`^s\\d+\\|${name}\\|`).test(line))!.split("|")[0]!;
    const complete = vi.fn(async (request: ShadowRequest) => ({
      value: {
        decisions: [{
          index: 0, status: "COMPOSITE", refs: ["SODIO", "POTASIO", "CLORO"].map((name) => refByName(request.promptText, name)), alternatives: [],
          componentFragments: ["NA", "K", "CL"], reading: "sodio, potasio y cloro en sangre", qualifiersInText: ["EN SANGRE"], contextUsed: [], confidence: "high", reason: "lista explícita"
        }]
      }
    }));
    const batch = await shadowMatch({ queries: [{ literalText: PRINTED }], catalog, deps: { complete, model: "m", reasoning: "medium" } });
    expect(batch.results[0]!.agreement).toBe(true);
    expect(batch.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: ionograma1.id, support: "EXACT" });
  });
});

describe("cotización: una sola línea, la del paquete, con su precio del catálogo", () => {
  const FORM: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true };
  const reading = (...texts: string[]): SimpleReading => ({
    requestedStudies: texts.map((text) => ({ literalText: text, normalizedName: text, evidence: "x" as const, confidence: "high" as const })),
    uncertainStudies: [],
    notes: ""
  });
  const shadow = (literalText: string, outcome: FinalShadow["outcome"]): FinalShadow => ({ literalText, outcome, agreement: true, passes: [outcome, outcome], modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ["COMPOSITE", "COMPOSITE"] } });
  const batchOf = (...results: FinalShadow[]): ShadowBatch => ({ results, usage: [], calls: 2, cacheHits: 0, model: "gpt-6.1-sol", reasoning: "medium", catalogSize: catalog.length });
  const assemble = (outcome: FinalShadow["outcome"]) => {
    const both = reading(PRINTED);
    return assembleAnalysis({ consensus: buildSimpleConsensus(both, both), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, document: FORM, primary: { batch: batchOf(shadow(PRINTED, outcome)) }, semanticAuto: true });
  };

  it("exacto (alias) y semántico (paquete verificado) coinciden: AUTO con UNA línea de 150 Bs, no tres de 60", () => {
    const result = assemble({ kind: "MATCH", studyId: ionograma1.id, support: "EXACT", notes: [] });
    expect(result.matches[0]!.semanticPrimary?.contrast).toBe("CONFIRMS_EXACT");
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines.map((l) => [l.code, l.priceBs])).toEqual([["413", 150]]);
    expect(result.quote?.totalBs).toBe(150);
  });

  it("si la composición no coincidió (REJECTED), contradice al exacto y queda en revisión sin cotización", () => {
    const result = assemble({ kind: "REJECTED", studyIds: [ionograma1.id, sodio.id], reason: "composición distinta" });
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.reasons).toContain("semantic_rejected_by_verifier");
    expect(result.reasons).toContain("semantic_contradicts_exact");
    expect(result.quote).toBeUndefined();
  });

  it("analyzeImage con el flujo completo simulado: sin descomposición en tres cobros", async () => {
    const both = reading(PRINTED);
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => both),
      readOpenAI: vi.fn(async () => both),
      judge: vi.fn(async () => ({ resolvedStudies: [], unresolvedDisputes: [] })),
      readDocument: vi.fn(async () => ({ signal: { documentType: "MARK_DEPENDENT_FORM" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] } })),
      resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
      shadowMatch: vi.fn(async () => batchOf(shadow(PRINTED, { kind: "MATCH", studyId: ionograma1.id, support: "EXACT", notes: [] }))) as unknown as AnalyzeDeps["shadowMatch"]
    };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, semanticPrimary: true, semanticAuto: true }, deps);
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines).toHaveLength(1);
    expect(result.quote?.lines[0]).toMatchObject({ code: "413", priceBs: 150 });
  });
});
