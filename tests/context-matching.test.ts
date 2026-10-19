import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPrompt, checkIdentity, contextBlock, parseDecisions, shadowMatch, verifyDecision, type RawDecision, type ShadowContext, type ShadowRequest } from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { CatalogStudy } from "../src/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-ctx-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
});
afterEach(async () => {
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
const study = (code: string, name: string, category = "QUIMICA SANGUINEA"): CatalogStudy => {
  counter += 1;
  return { id: `uuid-${code}-${counter}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs: 100 + Number(code) / 10, active: true, category };
};

// Variantes por muestra y por recolección, como en el catálogo real.
const sodio = study("415", "SODIO");
const sodioOrina = study("525", "SODIO EN ORINA OCACIONAL O 24 HORAS", "URIANALISIS");
const proteinas24 = study("530", "PROTEINAS EN ORINA DE 24 HORAS", "URIANALISIS");
const proteinasOcasional = study("531", "PROTEINAS EN ORINA OCASIONAL", "URIANALISIS");
const glucosa = study("397", "GLUCOSA");
const glucosaOrina = study("398", "GLUCOSA EN ORINA", "URIANALISIS");
const copro = study("601", "COPROPARASITOLOGICO SIMPLE", "PARASITOLOGIA");
const calcio = study("374", "CALCIO SERICO");
const calcioIonico = study("373", "CALCIO IONICO");
const calciuria = study("505", "CALCIURIA", "URIANALISIS");
const catalog = [sodio, sodioOrina, proteinas24, proteinasOcasional, glucosa, glucosaOrina, copro, calcio, calcioIonico, calciuria];

const blood: ShadowContext = { lines: ["SOLICITUD DE EXAMEN DE SANGRE"], muestra: "sangre" };
const urine24: ShadowContext = { lines: ["MUESTRA: ORINA DE 24 HORAS"], muestra: "orina", tiempo: "24h" };
const noDeclaration: ShadowContext = { lines: ["SOLICITUD DE EXÁMENES DE LABORATORIO Y SERVICIO DE SANGRE SEGURA"] };

const raw = (chosen: CatalogStudy[], status: RawDecision["status"] = "MATCH", extra: Partial<RawDecision> = {}): RawDecision => ({
  index: 0, status, studies: chosen, alternatives: [], fragments: [], reading: "", confidence: "high", reason: "", notes: [], ...extra
});

describe("el contexto desambigua variantes solo con declaración verificada", () => {
  it("sin contexto, 'Sodio' sigue ambiguo entre suero y orina (comportamiento previo)", () => {
    const out = verifyDecision("Sodio", raw([sodio]), catalog);
    expect(out.kind).toBe("AMBIGUOUS");
  });

  it("con muestra=sangre declarada, 'Sodio' se resuelve al estudio de sangre", () => {
    const out = verifyDecision("Sodio", raw([sodio]), catalog, blood);
    expect(out).toMatchObject({ kind: "MATCH", studyId: sodio.id });
  });

  it("también cuando GPT lista la variante de orina como alternativa: el contexto la descarta", () => {
    const out = verifyDecision("Sodio", raw([sodio], "MATCH", { alternatives: [sodioOrina] }), catalog, blood);
    expect(out.kind).toBe("MATCH");
  });

  it("muestra=orina y recolección 24 h elige la variante de orina de 24 horas entre las de orina", () => {
    const out = verifyDecision("Proteinas", raw([proteinas24]), catalog, urine24);
    expect(out).toMatchObject({ kind: "MATCH", studyId: proteinas24.id });
    // sin declaración de recolección, las dos variantes de orina siguen siendo plausibles
    const noTime = verifyDecision("Proteinas", raw([proteinas24]), catalog, { lines: ["Muestra de orina"], muestra: "orina" });
    expect(noTime.kind).toBe("AMBIGUOUS");
  });

  it("un contexto sin declaración verificada (título que solo menciona 'sangre' en el nombre de un servicio) no desambigua nada", () => {
    expect(verifyDecision("Sodio", raw([sodio]), catalog, noDeclaration).kind).toBe("AMBIGUOUS");
    expect(verifyDecision("Sodio", raw([sodio]), catalog, { lines: [] }).kind).toBe("AMBIGUOUS");
  });
});

describe("lo que el texto afirma prevalece; contextos contradictorios no se usan", () => {
  it("el texto del estudio con otra muestra prevalece sobre el contexto", () => {
    // formulario "de sangre" pero la fila dice orina: el contexto no se aplica y se respeta el texto
    const out = verifyDecision("Glucosa en orina", raw([glucosaOrina]), catalog, blood);
    expect(out).toMatchObject({ kind: "MATCH", studyId: glucosaOrina.id });
  });

  it("GPT elige una variante que contradice el contexto cuando existe una compatible: se rechaza", () => {
    const out = verifyDecision("Sodio", raw([sodioOrina]), catalog, blood);
    expect(out.kind).toBe("REJECTED");
    if (out.kind === "REJECTED") expect(out.reason).toMatch(/contexto del documento/);
  });

  it("contexto de orina y GPT elige la variante de sangre: se rechaza", () => {
    const out = verifyDecision("Glucosa", raw([glucosa]), catalog, { lines: ["Muestras de orina"], muestra: "orina" });
    expect(out.kind).toBe("REJECTED");
  });

  it("si el contexto no tiene una variante compatible, no se fuerza (coproparasitológico en un formulario de sangre)", () => {
    const out = verifyDecision("Coproparasitologico simple", raw([copro]), catalog, blood);
    expect(out).toMatchObject({ kind: "MATCH", studyId: copro.id });
  });

  it("el contexto no se usa para completar un estudio ambiguo por otra razón (familia 'Calcio')", () => {
    // sangre descarta CALCIURIA (orina) pero CALCIO SERICO e IONICO siguen siendo igualmente plausibles
    const out = verifyDecision("Calcio", raw([calcio]), catalog, blood);
    expect(out.kind).toBe("AMBIGUOUS");
    if (out.kind === "AMBIGUOUS") {
      expect(out.studyIds).toContain(calcioIonico.id);
      expect(out.studyIds).not.toContain(calciuria.id);
    }
  });

  it("checkIdentity: el contexto nunca agrega calificadores al estudio elegido ni genera problemas sin variante compatible", () => {
    expect(checkIdentity("Sodio", sodio, catalog, blood).problems).toEqual([]);
    expect(checkIdentity("Coproparasitologico simple", copro, catalog, urine24).ok).toBe(true);
  });
});

describe("el resolvedor recibe y registra el contexto", () => {
  it("contextBlock: vacío sin contexto; con contexto lista las líneas, las declaraciones y las reglas de uso", () => {
    expect(contextBlock(undefined)).toBe("");
    expect(contextBlock({ lines: [] })).toBe("");
    const block = contextBlock(blood);
    expect(block).toContain("SOLICITUD DE EXAMEN DE SANGRE");
    expect(block).toContain("DECLARACIONES VERIFICADAS DEL CONTEXTO: muestra=sangre");
    expect(block).toContain("Lo que el propio texto del estudio afirma prevalece sobre el contexto");
    expect(block).toContain("No asumas que todos los estudios comparten la muestra del título");
    expect(contextBlock(noDeclaration)).toContain("DECLARACIONES VERIFICADAS DEL CONTEXTO: ninguna");
  });

  it("buildPrompt solo cambia cuando hay contexto (los prompts sin contexto quedan idénticos)", () => {
    const refOf = new Map(catalog.map((s, i) => [s.id, `s${i + 1}`]));
    const items = [{ index: 0, literalText: "Sodio" }];
    expect(buildPrompt(catalog, refOf, items)).toBe(buildPrompt(catalog, refOf, items, { lines: [] }));
    expect(buildPrompt(catalog, refOf, items, blood)).toContain("CONTEXTO IMPRESO DEL DOCUMENTO");
    expect(buildPrompt(catalog, refOf, items)).not.toContain("CONTEXTO IMPRESO");
  });

  it("parseDecisions conserva solo las citas de contexto que existen en el documento", () => {
    const refMap = new Map([["s1", sodio]]);
    const parsed = parseDecisions({
      queries: [{ literalText: "Sodio" }],
      refMap,
      context: blood,
      rawDecisions: [{ index: 0, status: "MATCH", refs: ["s1"], alternatives: [], componentFragments: [], reading: "", qualifiersInText: [], contextUsed: ["solicitud de examen de sangre", "texto inventado"], confidence: "high", reason: "" }]
    });
    expect(parsed[0]!.contextUsed).toEqual(["solicitud de examen de sangre"]);
    expect(parsed[0]!.notes.join(" ")).toContain("cita de contexto inexistente");
    // sin el campo (respuestas antiguas en cache) sigue siendo una decisión válida
    const legacy = parseDecisions({ queries: [{ literalText: "Sodio" }], refMap, rawDecisions: [{ index: 0, status: "MATCH", refs: ["s1"], alternatives: [], componentFragments: [], reading: "", qualifiersInText: [], confidence: "high", reason: "" }] });
    expect(legacy[0]!.status).toBe("MATCH");
    expect(legacy[0]!.contextUsed).toEqual([]);
  });

  it("shadowMatch envía el contexto a ambas pasadas y lo aplica en la verificación", async () => {
    const prompts: string[] = [];
    const complete = vi.fn(async (request: ShadowRequest) => {
      prompts.push(request.promptText);
      // GPT elige SODIO (la primera ref con ese nombre en el orden recibido)
      const ref = request.promptText.split("\n").find((line) => /^s\d+\|SODIO\|/.test(line))!.split("|")[0]!;
      return { value: { decisions: [{ index: 0, status: "MATCH", refs: [ref], alternatives: [], componentFragments: [], reading: "sodio en sangre", qualifiersInText: [], contextUsed: ["SOLICITUD DE EXAMEN DE SANGRE"], confidence: "high", reason: "" }] } };
    });
    const withContext = await shadowMatch({ queries: [{ literalText: "Sodio" }], catalog, context: blood, deps: { complete, model: "m", reasoning: "medium" } });
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.includes("SOLICITUD DE EXAMEN DE SANGRE") && prompt.includes("muestra=sangre"))).toBe(true);
    expect(withContext.results[0]!.outcome).toMatchObject({ kind: "MATCH", studyId: sodio.id });
    expect(withContext.results[0]!.agreement).toBe(true);
    expect(withContext.results[0]!.modelNotes.contextUsed).toEqual(["SOLICITUD DE EXAMEN DE SANGRE"]);

    const without = await shadowMatch({ queries: [{ literalText: "Sodio" }], catalog, deps: { complete, model: "m", reasoning: "medium" } });
    expect(without.results[0]!.outcome.kind).toBe("AMBIGUOUS");
  });
});
