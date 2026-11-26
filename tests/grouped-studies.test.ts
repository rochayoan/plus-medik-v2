import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimpleReading } from "../src/ai.js";
import { analyzeImage, type AnalyzeDeps, type FinalVisualStudy } from "../src/analyze.js";
import { shadowMatch, type ShadowRequest } from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { SimpleJudgement } from "../src/judge.js";
import { splitGroupedStudies } from "../src/line-groups.js";
import type { CatalogStudy } from "../src/types.js";

// «Glucosa e insulina postprandial»: cada estudio por separado, con su indicación donde está escrita, y sin asignar una indicación dudosa.
// Nombres reales del catálogo (26-nov), incluida la errata «POSTPANDRIAL».

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-group-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const study = (id: string, name: string, category = "QUIMICA SANGUINEA", aliases: string[] = [], priceBs = 30): CatalogStudy => ({
  id, code: id, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true, category
});
const glucosa = study("glu", "GLUCOSA");
const glucosaPp = study("glu-pp", "GLUCOSA POSTPANDRIAL");
const glucosaCarga = study("glu-2h", "GLUCOSA POSTCARGA (2H)", "QUIMICA SANGUINEA", [], 40);
const insulinaBasal = study("ins-basal", "INSULINA BASAL (ECLIA)", "HORMONAS", [], 100);
const insulinaPp = study("ins-pp", "INSULINA POST PANDRIAL (ECLIA)", "HORMONAS", [], 100);
const tsh = study("tsh", "TSH (ECLIA)", "HORMONAS", ["tsh"], 90);
const proteinas = study("prot", "PROTEINAS TOTALES Y FRACCIONADAS");
const bilirrubinas = study("bili", "BILIRRUBINA TOTAL Y DIRECTA");
const urocultivo = study("uro", "UROCULTIVO Y ANTIBIOGRAMA", "MICROBIOLOGIA", ["urocultivo y atb"], 120);
const herpes = study("herpes", "HERPES tipo 1 y 2 IgG (Elisa)", "INMUNOSEROLOGIA", [], 120);
const toxoIgG = study("toxo-g", "TOXOPLASMA IgG (Elisa)", "INMUNOSEROLOGIA", [], 85);
const toxoIgM = study("toxo-m", "TOXOPLASMA IgM (Elisa)", "INMUNOSEROLOGIA", [], 85);
const sodio = study("na", "SODIO");
const sodioOrina = study("na-o", "SODIO EN ORINA", "URIANALISIS");
const potasio = study("k", "POTASIO");
const potasioOrina = study("k-o", "POTASIO EN ORINA", "URIANALISIS");
const catalog = [glucosa, glucosaPp, glucosaCarga, insulinaBasal, insulinaPp, tsh, proteinas, bilirrubinas, urocultivo, herpes, toxoIgG, toxoIgM, sodio, sodioOrina, potasio, potasioOrina];

const visual = (literalText: string, lineText?: string): FinalVisualStudy => ({
  literalText, normalizedName: literalText, evidence: "explicit_text", confidence: "high", source: "agreed", ...(lineText ? { lineText } : {}),
  readerPairs: [{ a: literalText, b: literalText }]
});
const split = (text: string, lineText?: string) => splitGroupedStudies([visual(text, lineText)], catalog);

describe("splitGroupedStudies: cuándo se separa un texto con varios estudios", () => {
  it("«Glucosa e insulina postprandial» → dos estudios con el texto exacto; la glucosa queda pendiente (no se sabe si es postprandial)", () => {
    const rows = split("Glucosa e insulina postprandial");
    expect(rows.map((row) => row.literalText)).toEqual(["Glucosa", "insulina postprandial"]);
    expect(rows.every((row) => row.splitFrom === "Glucosa e insulina postprandial" && row.lineText === "Glucosa e insulina postprandial")).toBe(true);
    expect(rows[0]!.lineProblem).toContain("postprandial");
    expect(rows[1]!.lineProblem).toBeUndefined();
  });
  it("la errata y las formas de escribir la indicación son la misma («post prandial», «postpandrial»)", () => {
    expect(split("Glucosa y insulina post prandial").map((row) => row.literalText)).toEqual(["Glucosa", "insulina post prandial"]);
    expect(split("Glucosa y insulina postpandrial")[0]!.lineProblem).toBeDefined();
  });
  it("si cada parte lleva su propia indicación no hay nada dudoso: no se separa (el compuesto del catálogo lo resuelve, como antes)", () => {
    expect(split("Glucosa post carga e insulina postprandial")).toHaveLength(1);
  });
  it("una parte con una indicación que el catálogo no tiene («Glucosa basal»): ante la duda, no se separa", () => {
    expect(split("Glucosa basal e insulina postprandial")).toHaveLength(1);
  });
  it("una parte sin versión con esa indicación no queda dudosa ni se separa («TSH e insulina postprandial»)", () => {
    expect(split("TSH e insulina postprandial")).toHaveLength(1);
  });
  it("sin lista fija: una indicación nueva del catálogo se reconoce sola («Cortisol y ACTH matutino»)", () => {
    const extra = [study("cort", "CORTISOL", "HORMONAS"), study("cort-am", "CORTISOL MATUTINO", "HORMONAS"), study("acth", "ACTH", "HORMONAS"), study("acth-am", "ACTH MATUTINO", "HORMONAS")];
    const rows = splitGroupedStudies([visual("Cortisol y ACTH matutino")], [...catalog, ...extra]);
    expect(rows.map((row) => row.literalText)).toEqual(["Cortisol", "ACTH matutino"]);
    expect(rows[0]!.lineProblem).toContain("matutino");
  });
  it("la errata del catálogo se reconoce por parecido, no por una regla escrita para ella", () => {
    const typoCatalog = [study("x", "CREATININA"), study("x-pp", "CREATININA NOCTRUNA"), study("y", "UREA"), study("y-pp", "UREA NOCTURNA")];
    const rows = splitGroupedStudies([visual("Creatinina y urea nocturna")], typoCatalog);
    expect(rows.map((row) => row.literalText)).toEqual(["Creatinina", "urea nocturna"]);
    expect(rows[0]!.lineProblem).toContain("nocturna");
  });
  it("componentes entre paréntesis de un perfil no cuentan como versión («Sodio y potasio» con IONOGRAMA (SODIO, POTASIO, CLORO))", () => {
    const withPanel = [...catalog, study("iono", "IONOGRAMA 1 (SODIO, POTASIO, CLORO)")];
    expect(splitGroupedStudies([visual("Sodio y potasio")], withPanel)).toHaveLength(1);
  });
  it("una muestra al final tampoco se extiende: «Sodio y potasio en orina» deja el sodio pendiente", () => {
    const rows = split("Sodio y potasio en orina");
    expect(rows.map((row) => row.literalText)).toEqual(["Sodio", "potasio en orina"]);
    expect(rows[0]!.lineProblem).toContain("orina");
  });
  it("sin indicación al final no se separa: el compuesto del catálogo ya lo resuelve («Glucosa e insulina»)", () => {
    expect(split("Glucosa e insulina")).toHaveLength(1);
    expect(split("Glucosa basal e insulina basal")).toHaveLength(1);
  });
  it("nombres de UN solo estudio no se separan", () => {
    expect(split("Proteinas totales y fraccionadas")).toHaveLength(1);
    expect(split("Bilirrubina total y directa")).toHaveLength(1);
    expect(split("Urocultivo y ATB")).toHaveLength(1);
    expect(split("Herpes 1 y 2 IgG")).toHaveLength(1);
  });
  it("variantes sueltas no son estudios («Toxoplasma IgG e IgM»: lo resuelven las reglas de siempre)", () => {
    expect(split("Toxoplasma IgG e IgM")).toHaveLength(1);
  });
  it("una parte que no nombra nada del catálogo: no se separa", () => {
    expect(split("Glucosa y cosa rara postprandial")).toHaveLength(1);
  });
});

describe("«Glucosa e insulina postprandial» de punta a punta (AUTO parcial; modelos simulados, sin red)", () => {
  const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
  const text = "Glucosa e insulina postprandial";
  const both: SimpleReading = { requestedStudies: [{ literalText: text, normalizedName: text, evidence: "explicit_text", confidence: "high", lineText: text }], uncertainStudies: [], notes: "" };
  const refFor = (request: ShadowRequest, name: string) => request.promptText.split("\n").find((line) => /^s\d+\|/.test(line) && line.split("|")[1] === name)!.split("|")[0]!;
  it("se cotiza la insulina postprandial y la glucosa queda pendiente aunque el modelo eligiera GLUCOSA", async () => {
    const seen: string[] = [];
    const complete = vi.fn(async (request: ShadowRequest) => ({
      value: {
        decisions: request.items.map((item) => {
          seen.push(item.literalText);
          const name = item.literalText === "Glucosa" ? "GLUCOSA" : "INSULINA POST PANDRIAL (ECLIA)";
          return { index: item.index, status: "MATCH", refs: [refFor(request, name)], alternatives: [], componentFragments: [], reading: "", qualifiersInText: [], contextUsed: [], confidence: "high", reason: "" };
        })
      }
    }));
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => both),
      readOpenAI: vi.fn(async () => both),
      judge: vi.fn(async () => noJudgement),
      readDocument: vi.fn(async () => ({ signal: { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] } })) as AnalyzeDeps["readDocument"],
      resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
      shadowMatch: (args) => shadowMatch({ ...args, deps: { complete, model: "m", reasoning: "medium" } })
    };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "off" }, deps);
    expect(new Set(seen)).toEqual(new Set(["Glucosa", "insulina postprandial"]));
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect(result.outcome).toBe("AUTO_PARTIAL");
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["INSULINA POST PANDRIAL (ECLIA)"]);
    const glucose = result.internal?.studies.find((s) => s.text === "Glucosa");
    expect(glucose).toMatchObject({ decision: "HUMAN_REVIEW" });
    expect(glucose?.blockers).toContain("package_line_unreconstructable");
  });
});
