import { describe, expect, it, vi } from "vitest";
import type { SimpleReading } from "../src/ai.js";
import { analyzeImage, finalVisualStudiesOf, semanticQueriesOf, visualCandidatesOf, type AnalyzeDeps } from "../src/analyze.js";
import type { ShadowBatch, ShadowQuery } from "../src/catalog-shadow.js";
import { buildSimpleConsensus, normalizeStudyKey } from "../src/consensus.js";
import type { SimpleJudgement } from "../src/judge.js";
import type { CatalogStudy } from "../src/types.js";

// analyze.ts → catalog-shadow.ts: cada texto lleva su línea de la receta como contexto SOLO si es inequívoca. Sin llamadas a modelos.

const noJudgement: SimpleJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
type Row = { literalText: string; lineText?: string };
const reading = (...rows: Row[]): SimpleReading => ({
  requestedStudies: rows.map((row) => ({ literalText: row.literalText, normalizedName: row.literalText, evidence: "explicit_text" as const, confidence: "high" as const, ...(row.lineText ? { lineText: row.lineText } : {}) })),
  uncertainStudies: [],
  notes: ""
});
const queriesFor = (a: SimpleReading, b: SimpleReading = a): ShadowQuery[] => {
  const consensus = buildSimpleConsensus(a, b);
  return semanticQueriesOf(finalVisualStudiesOf(consensus, noJudgement, []), visualCandidatesOf(consensus, noJudgement));
};

describe("semanticQueriesOf: la línea viaja solo si es inequívoca", () => {
  it("las dos lecturas coinciden en la línea: va como contexto", () => {
    expect(queriesFor(reading({ literalText: "HAI", lineText: "TSH, HAI Chagas" }))).toEqual([{ literalText: "HAI", lineText: "TSH, HAI Chagas" }]);
  });
  it("las lecturas no coinciden en la línea: va sin línea (como antes)", () => {
    const a = reading({ literalText: "HAI", lineText: "HAI Chagas" });
    const b = reading({ literalText: "HAI", lineText: "HAI Toxo" });
    expect(queriesFor(a, b)).toEqual([{ literalText: "HAI" }]);
  });
  it("sin lineText (lecturas antiguas o simuladas): exactamente las consultas de siempre", () => {
    expect(queriesFor(reading({ literalText: "HAI" }), reading({ literalText: "HAI" }))).toEqual([{ literalText: "HAI" }]);
  });
  it("el mismo texto en dos líneas distintas: no se mezclan los contextos, va sin línea", () => {
    const consensus = buildSimpleConsensus(reading({ literalText: "HAI", lineText: "HAI Chagas" }), reading({ literalText: "HAI", lineText: "HAI Chagas" }));
    const finals = finalVisualStudiesOf(consensus, noJudgement, []);
    // Segunda aparición del mismo texto en otra línea (otra fila de la receta), que la lista final descarta como duplicado.
    const candidates = [...visualCandidatesOf(consensus, noJudgement), { ...finals[0]!, lineText: "HAI Toxo" }];
    expect(semanticQueriesOf(finals, candidates)).toEqual([{ literalText: "HAI" }]);
  });
  it("el mismo texto repetido en la MISMA línea: la línea sigue siendo inequívoca", () => {
    const consensus = buildSimpleConsensus(reading({ literalText: "HAI", lineText: "HAI Chagas" }), reading({ literalText: "HAI", lineText: "hai chagas" }));
    const finals = finalVisualStudiesOf(consensus, noJudgement, []);
    expect(semanticQueriesOf(finals, [...visualCandidatesOf(consensus, noJudgement), { ...finals[0]! }])).toEqual([{ literalText: "HAI", lineText: "HAI Chagas" }]);
  });
  it("una aparición sin línea fiable junto a otra con línea: va sin línea", () => {
    const consensus = buildSimpleConsensus(reading({ literalText: "HAI", lineText: "HAI Chagas" }), reading({ literalText: "HAI", lineText: "HAI Chagas" }));
    const finals = finalVisualStudiesOf(consensus, noJudgement, []);
    const { lineText: _drop, ...withoutLine } = finals[0]!;
    expect(semanticQueriesOf(finals, [...visualCandidatesOf(consensus, noJudgement), withoutLine])).toEqual([{ literalText: "HAI" }]);
  });
  it("cada texto lleva su propia línea; un texto que ES su línea no la repite (la filtra catalog-shadow)", () => {
    const both = reading({ literalText: "HAI", lineText: "HAI Chagas" }, { literalText: "TSH", lineText: "TSH" });
    expect(queriesFor(both)).toEqual([{ literalText: "HAI", lineText: "HAI Chagas" }, { literalText: "TSH", lineText: "TSH" }]);
  });
});

describe("analyzeImage entrega la línea al resolvedor del catálogo (flujo real, dependencias simuladas)", () => {
  const study = (id: string, name: string): CatalogStudy => ({ id, code: id, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs: 60, active: true, category: "INMUNOSEROLOGIA" });
  const catalog = [study("hai-chagas", "HAI CHAGAS"), study("hai-toxo", "HAI TOXO")];
  it("la consulta lleva lineText y el resultado se sigue buscando por el texto", async () => {
    const both = reading({ literalText: "HAI", lineText: "HAI Chagas" });
    const shadowMatch = vi.fn(async (args: { queries: ShadowQuery[] }): Promise<ShadowBatch> => ({
      results: args.queries.map((query) => ({
        literalText: query.literalText, lineText: query.lineText, agreement: true,
        outcome: { kind: "MATCH" as const, studyId: "hai-chagas", support: "LEXICAL" as const, notes: [] },
        passes: [{ kind: "NO_MATCH" as const, reason: "" }, { kind: "NO_MATCH" as const, reason: "" }],
        modelNotes: { reading: "", confidence: "high", reason: "", rawStatuses: ["MATCH", "MATCH"] }
      })),
      usage: [], calls: 0, cacheHits: 2, model: "m", reasoning: "medium", catalogSize: catalog.length
    }));
    const deps: AnalyzeDeps = {
      readGemini: vi.fn(async () => both),
      readOpenAI: vi.fn(async () => both),
      judge: vi.fn(async () => noJudgement),
      readDocument: vi.fn(async () => ({ signal: { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] } })) as AnalyzeDeps["readDocument"],
      resolveSemantic: vi.fn(async () => { throw new Error("no debe llamarse"); }),
      shadowMatch: shadowMatch as unknown as AnalyzeDeps["shadowMatch"]
    };
    const result = await analyzeImage({ imageBase64: "x", mimeType: "image/png", catalog, semanticPrimary: true, semanticAuto: true, partialAuto: false, handwrittenAuto: "off" }, deps);
    expect(shadowMatch).toHaveBeenCalledTimes(1);
    expect(shadowMatch.mock.calls[0]![0].queries).toEqual([{ literalText: "HAI", lineText: "HAI Chagas" }]);
    expect(result.matches[0]!.semanticPrimary).toMatchObject({ kind: "MATCH", studyIds: ["hai-chagas"] });
  });
});
