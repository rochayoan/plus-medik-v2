import { describe, expect, it } from "vitest";
import { assembleAnalysis } from "@core/analyze";
import { buildSimpleConsensus, type SimpleStudy } from "@core/consensus";
import type { SimpleReading } from "@core/ai";
import type { CatalogStudy } from "@core/types";
import { prefillFromAnalysis } from "@/lib/photo-prefill";

const visual = (literalText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({
  literalText,
  normalizedName: literalText,
  evidence: "explicit_text",
  confidence
});
const reading = (requested: SimpleStudy[]): SimpleReading => ({ requestedStudies: requested, uncertainStudies: [], notes: "" });
const study = (id: string, name: string, aliases: string[] = []): CatalogStudy => ({
  id, code: null, name, normalizedName: name.toLowerCase(), normalizedAliases: aliases, priceBs: 10, active: true
});

const catalog = [
  study("fsh", "FSH"),
  study("lh", "LH"),
  study("perfil-a", "Perfil A", ["perfil"]),
  study("perfil-b", "Perfil B", ["perfil"])
];
const noJudgement = { resolvedStudies: [], unresolvedDisputes: [] };
const PRINTED_OK = { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true };

const analyze = (a: SimpleStudy[], b: SimpleStudy[] = a, document: Parameters<typeof assembleAnalysis>[0]["document"] = PRINTED_OK) =>
  assembleAnalysis({ consensus: buildSimpleConsensus(reading(a), reading(b)), judgement: noJudgement, catalog, document });

describe("precarga desde el análisis de foto", () => {
  it("AUTO_SAFE: todas las líneas de la cotización entran como seguras, sin precios", () => {
    const prefill = prefillFromAnalysis(analyze([visual("FSH"), visual("LH")]));
    expect(prefill.decision).toBe("AUTO_SAFE");
    expect(prefill.warnings).toEqual([]);
    expect(prefill.items).toEqual([
      { kind: "sure", text: "FSH", studyId: "fsh" },
      { kind: "sure", text: "LH", studyId: "lh" }
    ]);
    expect(JSON.stringify(prefill)).not.toContain("price");
  });

  it("HUMAN_REVIEW: lo único y seguro entra, lo ambiguo pide elegir y lo inexistente se marca", () => {
    const prefill = prefillFromAnalysis(analyze([visual("FSH"), visual("Perfil"), visual("Prolactina")]));
    expect(prefill.decision).toBe("HUMAN_REVIEW");
    expect(prefill.items).toEqual([
      { kind: "sure", text: "FSH", studyId: "fsh" },
      { kind: "choose", text: "Perfil", candidateIds: ["perfil-a", "perfil-b"] },
      { kind: "not_found", text: "Prolactina" }
    ]);
  });

  it("un estudio leído con poca certeza nunca entra solo: pide confirmación", () => {
    // Solo un lector vio FSH y el juez lo confirmó, pero con certeza media.
    const result = assembleAnalysis({
      consensus: buildSimpleConsensus(reading([visual("FSH", "medium")]), reading([])),
      judgement: { resolvedStudies: [{ key: "fsh", verdict: "confirmed", study: visual("FSH", "medium"), reason: "se ve tenue" }], unresolvedDisputes: [] },
      catalog,
      document: PRINTED_OK
    });
    const prefill = prefillFromAnalysis(result);
    expect(prefill.items).toEqual([{ kind: "confirm", text: "FSH", studyIds: ["fsh"], hint: "Leído con poca certeza" }]);
    expect(prefill.warnings).toContain("Algunos estudios se leyeron con poca certeza: confírmalos.");
  });

  it("manuscrito: el aviso pide revisar contra la foto y la decisión queda en revisión", () => {
    const prefill = prefillFromAnalysis(analyze([visual("FSH")], [visual("FSH")], { documentType: "HANDWRITTEN_REQUEST", completeDocumentVisible: true }));
    expect(prefill.decision).toBe("HUMAN_REVIEW");
    expect(prefill.warnings[0]).toMatch(/manuscrita/);
    expect(prefill.items).toEqual([{ kind: "sure", text: "FSH", studyId: "fsh" }]);
  });

  it("documento cortado: avisa que puede faltar algo", () => {
    const prefill = prefillFromAnalysis(analyze([visual("LH")], [visual("LH")], { documentType: "TEXT_EXPLICIT_REQUEST", completeDocumentVisible: false }));
    expect(prefill.warnings).toContain("La foto parece cortada o tapada: verifica que estén todos los estudios.");
  });

  it("una disputa sin juez aparece como posible estudio a verificar", () => {
    const prefill = prefillFromAnalysis(analyze([visual("FSH"), visual("LH")], [visual("FSH")]));
    expect(prefill.items).toContainEqual({ kind: "sure", text: "FSH", studyId: "fsh" });
    expect(prefill.items.some((item) => item.kind === "not_found" && /verifícalo en la foto/.test(item.hint ?? ""))).toBe(true);
    expect(prefill.warnings).toContain("Hay estudios que solo una de las lecturas vio: confírmalos mirando la foto.");
  });

  it("sugerencia del modelo: requiere confirmación explícita", () => {
    const result = analyze([visual("Hormona luteinizante")]);
    const match = result.matches[0]!;
    match.status = "MODEL_SUGGESTED";
    match.study = { id: "lh", code: null, name: "LH", priceBs: 10 };
    const prefill = prefillFromAnalysis(result);
    expect(prefill.items).toEqual([{ kind: "confirm", text: "Hormona luteinizante", studyIds: ["lh"], hint: "Sugerencia: confirma que es el estudio pedido" }]);
  });

  it("compuesto semántico: confirma todos sus componentes juntos", () => {
    const result = analyze([visual("FSH/LH")]);
    const match = result.matches[0]!;
    match.status = "SEMANTIC_CANDIDATE";
    match.components = [
      { id: "fsh", code: null, name: "FSH", priceBs: 10, fragment: "FSH" },
      { id: "lh", code: null, name: "LH", priceBs: 10, fragment: "LH" }
    ];
    expect(prefillFromAnalysis(result).items).toEqual([{ kind: "confirm", text: "FSH/LH", studyIds: ["fsh", "lh"], hint: "El texto nombra varios estudios" }]);
  });
});
