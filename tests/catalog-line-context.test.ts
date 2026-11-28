import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, lineBlock, lineContextFor, lineSegmentFor, shadowMatch, verifyDecision, type RawDecision, type ShadowRequest } from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

// La línea de la receta como CONTEXTO del resolvedor de catálogo: precisa una abreviatura o un nombre incompleto («HAI» en «HAI Chagas»), nunca
// agrega estudios, y el verificador determinístico solo la acepta si la línea lo precisa sin ambigüedad. Sin línea, todo es como antes.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-line-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const study = (id: string, name: string, category = "INMUNOSEROLOGIA", aliases: string[] = []): CatalogStudy => ({
  id, code: id, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs: 60, active: true, category
});

const haiChagas = study("hai-chagas", "HAI CHAGAS");
const haiToxo = study("hai-toxo", "HAI TOXO");
const tsh = study("tsh", "TSH (ECLIA)", "HORMONAS");
const toxoIgM = study("toxo-igm", "TOXOPLASMA IgM (Elisa)");
const toxoIgG = study("toxo-igg", "TOXOPLASMA IgG (Elisa)");
const cmvIgM = study("cmv-igm", "CITOMEGALOVIRUS IgM (Elisa)");
const rubeolaIgM = study("rubeola-igm", "RUBEOLA IgM (Elisa)");
const hbsag = study("hbsag", "HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)", "INMUNOSEROLOGIA", ["hepatitis b antigeno de superficie", "hbsag"]);
const anticore = study("anticore", "HEPATITIS B ANTICORE TOTAL", "INMUNOSEROLOGIA", ["anticore"]);
const catalog = [haiChagas, haiToxo, tsh, toxoIgM, toxoIgG, cmvIgM, rubeolaIgM, hbsag, anticore];

const raw = (status: RawDecision["status"], studies: CatalogStudy[], extra: Partial<RawDecision> = {}): RawDecision => ({
  index: 0, status, studies, alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [], contextUsed: [], ...extra
});

describe("lineContextFor: solo se envía una línea que dice algo más que el texto", () => {
  it("sin línea, vacía o igual al texto (ignorando mayúsculas y puntuación): nada", () => {
    expect(lineContextFor("HAI", undefined)).toBeUndefined();
    expect(lineContextFor("HAI", "   ")).toBeUndefined();
    expect(lineContextFor("HAI Chagas", "hai, chagas.")).toBeUndefined();
  });
  it("una línea distinta se conserva tal cual (recortada)", () => {
    expect(lineContextFor("HAI", "  HAI Chagas ")).toBe("HAI Chagas");
  });
});

describe("prompt: sin líneas es exactamente el de siempre", () => {
  const refOf = new Map(catalog.map((s, i) => [s.id, `s${i + 1}`]));
  it("sin lineText no hay bloque de línea ni campo lineText", () => {
    const prompt = buildPrompt(catalog, refOf, [{ index: 0, literalText: "HAI" }]);
    expect(prompt).not.toContain("LÍNEA DE LA RECETA");
    expect(prompt).not.toContain("lineText");
    expect(lineBlock([{ index: 0, literalText: "HAI" }])).toBe("");
  });
  it("con lineText, el bloque de reglas y la línea viajan junto al texto", () => {
    const prompt = buildPrompt(catalog, refOf, [{ index: 0, literalText: "HAI", lineText: "HAI Chagas" }]);
    expect(prompt).toContain("LÍNEA DE LA RECETA");
    expect(prompt).toContain(JSON.stringify([{ index: 0, literalText: "HAI", lineText: "HAI Chagas" }]));
  });
});

describe("lineSegmentFor: la línea precisa el texto solo sin ambigüedad", () => {
  it("«HAI» en «HAI Chagas» → «HAI Chagas»", () => {
    expect(lineSegmentFor("HAI", "HAI Chagas", haiChagas, catalog)).toBe("HAI Chagas");
  });
  it("otros estudios de la línea que no completan el texto no estorban", () => {
    expect(lineSegmentFor("HAI", "TSH, HAI Chagas", haiChagas, catalog)).toBe("HAI Chagas");
  });
  it("dos trozos con el texto («HAI Chagas, HAI Toxo»): no decide", () => {
    expect(lineSegmentFor("HAI", "HAI Chagas, HAI Toxo", haiChagas, catalog)).toBeUndefined();
  });
  it("otro trozo completa el texto hacia otro estudio («HAI: Chagas y Toxo»): no decide", () => {
    expect(lineSegmentFor("HAI", "HAI: Chagas y Toxo", haiChagas, catalog)).toBeUndefined();
  });
  it("el estudio elegido no cubre lo que dice la línea: no decide", () => {
    expect(lineSegmentFor("HAI", "HAI Chagas", haiToxo, catalog)).toBeUndefined();
    expect(lineSegmentFor("HAI", "HAI Chagas urgente", haiChagas, catalog)).toBeUndefined();
  });
  it("la línea no agrega nada al texto: no hay evidencia", () => {
    expect(lineSegmentFor("HAI Chagas", "HAI Chagas", haiChagas, catalog)).toBeUndefined();
    expect(lineSegmentFor("Toxoplasma IgM", "Toxoplasma IgM, TSH", toxoIgM, catalog)).toBeUndefined();
  });
});

describe("verifyDecision con la línea", () => {
  it("«HAI» suelto sigue en duda sin línea (comportamiento actual)", () => {
    const out = verifyDecision("HAI", raw("MATCH", [haiChagas]), catalog);
    expect(out.kind).toBe("AMBIGUOUS");
  });
  it("«HAI» con la línea «HAI Chagas» → HAI CHAGAS, con la nota de la línea", () => {
    const out = verifyDecision("HAI", raw("MATCH", [haiChagas]), catalog, undefined, "HAI Chagas");
    expect(out).toMatchObject({ kind: "MATCH", studyId: "hai-chagas" });
    expect(out.kind === "MATCH" && out.notes.some((note) => note.includes("HAI Chagas"))).toBe(true);
  });
  it("una alternativa del modelo que la línea descarta no lo vuelve dudoso", () => {
    const out = verifyDecision("HAI", raw("MATCH", [haiChagas], { alternatives: [haiToxo] }), catalog, undefined, "HAI Chagas");
    expect(out).toMatchObject({ kind: "MATCH", studyId: "hai-chagas" });
  });
  it("el modelo elige contra la línea («HAI Chagas» → HAI TOXO): no se acepta", () => {
    const out = verifyDecision("HAI", raw("MATCH", [haiToxo]), catalog, undefined, "HAI Chagas");
    expect(out.kind).not.toBe("MATCH");
  });
  it("«HAI: Chagas y Toxo» sigue en duda", () => {
    expect(verifyDecision("HAI", raw("MATCH", [haiChagas]), catalog, undefined, "HAI: Chagas y Toxo").kind).toBe("AMBIGUOUS");
  });
  it("«IgM» suelto: duda sin línea; con «Toxoplasma IgM» en la misma línea → TOXOPLASMA IgM", () => {
    expect(verifyDecision("IgM", raw("MATCH", [toxoIgM]), catalog).kind).toBe("AMBIGUOUS");
    expect(verifyDecision("IgM", raw("MATCH", [toxoIgM]), catalog, undefined, "Toxoplasma IgM")).toMatchObject({ kind: "MATCH", studyId: "toxo-igm" });
  });
  it("la línea nunca cambia la variante que el texto afirma («IgM» no pasa a IgG)", () => {
    expect(verifyDecision("IgM", raw("MATCH", [toxoIgG]), catalog, undefined, "Toxoplasma IgG").kind).not.toBe("MATCH");
  });
  it("«Hepatitis B» con el marcador en la línea → ese marcador; con dos marcadores, duda", () => {
    expect(verifyDecision("Hepatitis B", raw("MATCH", [hbsag]), catalog, undefined, "Hepatitis B antígeno de superficie")).toMatchObject({ kind: "MATCH", studyId: "hbsag" });
    expect(verifyDecision("Hepatitis B", raw("MATCH", [hbsag]), catalog, undefined, "Hepatitis B: antígeno de superficie y anticore").kind).toBe("AMBIGUOUS");
  });
  it("un compuesto con fragmentos que solo están en la línea se rechaza (la línea no agrega estudios)", () => {
    const out = verifyDecision("HAI", raw("COMPOSITE", [haiChagas, haiToxo], { fragments: ["HAI Chagas", "Toxo"] }), catalog, undefined, "HAI Chagas y Toxo");
    expect(out.kind).toBe("REJECTED");
  });
  it("AMBIGUOUS y NO_MATCH del modelo no cambian con la línea", () => {
    expect(verifyDecision("HAI", raw("AMBIGUOUS", [haiChagas, haiToxo]), catalog, undefined, "HAI Chagas").kind).toBe("AMBIGUOUS");
    expect(verifyDecision("HAI", raw("NO_MATCH", []), catalog, undefined, "HAI Chagas").kind).toBe("NO_MATCH");
  });
});

describe("shadowMatch: la línea llega al prompt de las dos pasadas y queda registrada", () => {
  const refFor = (request: ShadowRequest, name: string): string => request.promptText.split("\n").find((line) => /^s\d+\|/.test(line) && line.split("|")[1] === name)!.split("|")[0]!;
  it("con línea: MATCH en las dos pasadas; sin línea: el ítem va como siempre", async () => {
    const seen: ShadowRequest[] = [];
    const complete = vi.fn(async (request: ShadowRequest) => {
      seen.push(request);
      return {
        value: {
          decisions: request.items.map((item) => ({
            index: item.index, status: "MATCH", refs: [refFor(request, item.literalText === "HAI" ? "HAI CHAGAS" : "TSH (ECLIA)")], alternatives: [], componentFragments: [],
            reading: "", qualifiersInText: [], contextUsed: [], confidence: "high", reason: ""
          }))
        }
      };
    });
    const batch = await shadowMatch({ queries: [{ literalText: "HAI", lineText: "TSH, HAI Chagas" }, { literalText: "TSH", lineText: "TSH" }], catalog, deps: { complete, model: "m", reasoning: "medium" } });
    expect(complete).toHaveBeenCalledTimes(2);
    for (const request of seen) {
      expect(request.items.find((item) => item.literalText === "HAI")?.lineText).toBe("TSH, HAI Chagas");
      expect(request.items.find((item) => item.literalText === "TSH")).not.toHaveProperty("lineText");
    }
    expect(batch.results[0]).toMatchObject({ literalText: "HAI", lineText: "TSH, HAI Chagas", agreement: true, outcome: { kind: "MATCH", studyId: "hai-chagas" } });
    expect(batch.results[1]).not.toHaveProperty("lineText");
  });
});
