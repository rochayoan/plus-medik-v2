import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimpleReading } from "../src/ai.js";
import { analyzeImage, type AnalyzeDeps } from "../src/analyze.js";
import { explicitStudyList, shadowMatch, verifyDecision, type RawDecision, type ShadowRequest } from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

// «FSH/LH»: una barra entre estudios DISTINTOS es una lista (dos estudios), no una duda entre sinónimos. Nombres reales del catálogo (26-nov).

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-list-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const study = (id: string, name: string, aliases: string[] = [], category = "HORMONAS", extra: Partial<CatalogStudy> = {}): CatalogStudy => ({
  id, code: id, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 90, active: true, category, ...extra
});
const fsh = study("fsh", "FSH (ECLIA)", ["fsh"]);
const lh = study("lh", "LH (ECLIA)", ["lh"]);
const prolactina = study("prl", "PROLACTINA (ECLIA)", ["prolactina prl", "prolactina"]);
const urea = study("urea", "UREA", [], "QUIMICA SANGUINEA", { priceBs: 30 });
const bun = study("bun", "BUN DE UREA", ["bun"], "QUIMICA SANGUINEA", { priceBs: 30 });
const got = study("got", "TRANSAMINASA GOT", [], "QUIMICA SANGUINEA");
const gpt = study("gpt", "TRANSAMINASA GPT", [], "QUIMICA SANGUINEA");
const ratio = study("ratio", "RELACION FSH/LH", ["fsh/lh"]);
const inactiveLh = study("lh-old", "LH ANTIGUA", ["lh vieja"], "HORMONAS", { active: false });
const catalog = [fsh, lh, prolactina, urea, bun, got, gpt, inactiveLh];

const raw = (status: RawDecision["status"], studies: CatalogStudy[], extra: Partial<RawDecision> = {}): RawDecision => ({
  index: 0, status, studies, alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [], contextUsed: [], ...extra
});
const idsOf = (out: ReturnType<typeof verifyDecision>) => (out.kind === "COMPOSITE" ? out.components.map((component) => component.studyId) : []);

describe("explicitStudyList: cuándo un texto con separadores es una lista de estudios distintos", () => {
  it("«FSH/LH», «FSH + LH», «FSH, LH y Prolactina»: cada trozo es un estudio", () => {
    expect(explicitStudyList("FSH/LH", catalog)?.map((entry) => entry.study.id)).toEqual(["fsh", "lh"]);
    expect(explicitStudyList("FSH + LH", catalog)?.map((entry) => entry.study.id)).toEqual(["fsh", "lh"]);
    expect(explicitStudyList("FSH, LH y Prolactina", catalog)?.map((entry) => entry.study.id)).toEqual(["fsh", "lh", "prl"]);
  });
  it("sinónimos del mismo examen («Urea/BUN») no son una lista", () => {
    expect(explicitStudyList("Urea/BUN", catalog)).toBeUndefined();
  });
  it("compartir palabras no bloquea: estudios distintos con nombre en común sí son una lista", () => {
    const hdl = study("hdl", "COLESTEROL HDL", [], "QUIMICA SANGUINEA");
    const ldl = study("ldl", "COLESTEROL LDL", [], "QUIMICA SANGUINEA");
    const t3Total = study("t3t", "T3 TOTAL (ECLIA)", ["t3 total"]);
    const t3Libre = study("t3l", "T3 LIBRE (ECLIA)", ["t3 libre"]);
    const withAliases = [...catalog.filter((s) => s !== got && s !== gpt), study("got", "TRANSAMINASA GOT", ["tgo"], "QUIMICA SANGUINEA"), study("gpt", "TRANSAMINASA GPT", ["tgp"], "QUIMICA SANGUINEA"), hdl, ldl, t3Total, t3Libre];
    expect(explicitStudyList("Colesterol HDL / Colesterol LDL", withAliases)?.map((entry) => entry.study.id)).toEqual(["hdl", "ldl"]);
    expect(explicitStudyList("TGO/TGP", withAliases)?.map((entry) => entry.study.id)).toEqual(["got", "gpt"]);
    expect(explicitStudyList("T3 total / T3 libre", withAliases)?.map((entry) => entry.study.id)).toEqual(["t3t", "t3l"]);
  });
  it("equivalencias del catálogo bloquean: un estudio que también responde al otro trozo («ANA/FAN»)", () => {
    const anaElisa = study("ana-e", "ANA (ANTICUERPOS ANTINUCLEARES) Elisa", ["ana"], "AUTOINMUNIDAD");
    const anaIfi = study("ana-i", "ANA / FAN HEP2 IFI", ["fan"], "AUTOINMUNIDAD");
    expect(explicitStudyList("ANA/FAN", [...catalog, anaElisa, anaIfi])).toBeUndefined();
  });
  it("equivalencias del catálogo bloquean: dos estudios con un alias aprobado en común", () => {
    const a = study("vit-a", "VITAMINA D3 FIA", ["vit d", "vitamina d fia"], "VITAMINAS");
    const b = study("vit-b", "COLECALCIFEROL ECLIA", ["vit d", "colecalciferol"], "VITAMINAS");
    expect(explicitStudyList("Vitamina D FIA / Colecalciferol", [...catalog, a, b])).toBeUndefined();
  });
  it("una versión con más palabras del mismo estudio no se separa («Glucosa / Glucosa postprandial»: lo decide el modelo)", () => {
    const glu = study("glu", "GLUCOSA", [], "QUIMICA SANGUINEA");
    const gluPp = study("glu-pp", "GLUCOSA POSTPANDRIAL", ["glucosa postprandial"], "QUIMICA SANGUINEA");
    expect(explicitStudyList("Glucosa / Glucosa postprandial", [...catalog, glu, gluPp])).toBeUndefined();
  });
  it("dos nombres del MISMO estudio («FSH/FSH (ECLIA)») no son una lista", () => {
    expect(explicitStudyList("FSH/FSH (ECLIA)", catalog)).toBeUndefined();
  });
  it("un trozo que no es exactamente un nombre o alias: no se interpreta («FSH/LH basal», «GOT/GPT»)", () => {
    expect(explicitStudyList("FSH/LH basal", catalog)).toBeUndefined();
    expect(explicitStudyList("GOT/GPT", catalog)).toBeUndefined();
    expect(explicitStudyList("Nitrogeno ureico/Urea/NUS", catalog)).toBeUndefined();
  });
  it("un texto sin separadores, o con un solo trozo, no es una lista", () => {
    expect(explicitStudyList("FSH", catalog)).toBeUndefined();
    expect(explicitStudyList("FSH /", catalog)).toBeUndefined();
  });
  it("si el texto completo es un estudio del catálogo («FSH/LH» como cociente), manda ese estudio", () => {
    expect(explicitStudyList("FSH/LH", [...catalog, ratio])).toBeUndefined();
  });
  it("un trozo con variantes hermanas que no distingue (sangre u orina) no se fija: sigue la duda", () => {
    const sodio = study("na", "SODIO", [], "QUIMICA SANGUINEA");
    const sodioOrina = study("na-o", "SODIO EN ORINA", [], "URIANALISIS");
    expect(explicitStudyList("Sodio/FSH", [...catalog, sodio, sodioOrina])).toBeUndefined();
  });
  it("un estudio inactivo no cuenta", () => {
    expect(explicitStudyList("FSH/LH vieja", catalog)).toBeUndefined();
  });
});

describe("verifyDecision ante «FSH/LH»", () => {
  it("el modelo duda entre FSH y LH (tomó la barra por «o») → los dos estudios", () => {
    const out = verifyDecision("FSH/LH", raw("AMBIGUOUS", [fsh, lh]), catalog);
    expect(out.kind).toBe("COMPOSITE");
    expect(idsOf(out)).toEqual(["fsh", "lh"]);
  });
  it("el modelo elige solo uno → los dos (no se pierde el otro estudio escrito)", () => {
    expect(idsOf(verifyDecision("FSH/LH", raw("MATCH", [fsh]), catalog))).toEqual(["fsh", "lh"]);
  });
  it("el modelo propone algo que no está en la lista → su decisión sigue el curso normal", () => {
    expect(verifyDecision("FSH/LH", raw("AMBIGUOUS", [fsh, prolactina]), catalog).kind).toBe("AMBIGUOUS");
  });
  it("NO_MATCH del modelo no se convierte en estudios", () => {
    expect(verifyDecision("FSH/LH", raw("NO_MATCH", []), catalog).kind).toBe("NO_MATCH");
  });
  it("«Urea/BUN» sigue en duda (mismo examen; lo decide la regla del laboratorio)", () => {
    expect(verifyDecision("Urea/BUN", raw("AMBIGUOUS", [urea, bun]), catalog).kind).toBe("AMBIGUOUS");
  });
});

describe("«FSH/LH» de punta a punta (lectores, catálogo y ensamblado simulados; sin red)", () => {
  const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
  const both: SimpleReading = { requestedStudies: [{ literalText: "FSH/LH", normalizedName: "FSH/LH", evidence: "explicit_text", confidence: "high", lineText: "FSH/LH" }], uncertainStudies: [], notes: "" };
  const refFor = (request: ShadowRequest, name: string) => request.promptText.split("\n").find((line) => /^s\d+\|/.test(line) && line.split("|")[1] === name)!.split("|")[0]!;
  it("se cotizan FSH y LH, cada uno con su precio del catálogo", async () => {
    const complete = vi.fn(async (request: ShadowRequest) => ({
      value: { decisions: request.items.map((item) => ({ index: item.index, status: "AMBIGUOUS", refs: [refFor(request, "FSH (ECLIA)"), refFor(request, "LH (ECLIA)")], alternatives: [], componentFragments: [], reading: "FSH o LH", qualifiersInText: [], contextUsed: [], confidence: "medium", reason: "barra" })) }
    }));
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => both),
      readOpenAI: vi.fn(async () => both),
      judge: vi.fn(async () => noJudgement),
      readDocument: vi.fn(async () => ({ signal: { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] } })) as AnalyzeDeps["readDocument"],
      resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
      shadowMatch: (args) => shadowMatch({ ...args, deps: { complete, model: "m", reasoning: "medium" } })
    };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true, partialAuto: false, handwrittenAuto: "off" }, deps);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.matches[0]!.semanticPrimary).toMatchObject({ kind: "COMPOSITE", contrast: "SEMANTIC_COMPOSITE", studyIds: ["fsh", "lh"] });
    expect(result.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines.map((line) => [line.id, line.priceBs])).toEqual([["fsh", 90], ["lh", 90]]);
  });
});
