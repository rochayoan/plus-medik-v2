import { describe, expect, it } from "vitest";
import { assembleAnalysis, type DocumentGate } from "../src/analyze.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { InternalRecord } from "../src/partial-auto.js";
import { completeQuote } from "../src/quote-completion.js";
import type { CatalogStudy } from "../src/types.js";

const study = (id: string, name: string, priceBs: number, category = "QUIMICA SANGUINEA", aliases: string[] = [], active = true): CatalogStudy => ({
  id, code: id.replace("uuid-", ""), name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active, category
});
const catalog = [
  study("uuid-108", "HEMOGRAMA COMPLETO AUTOMATIZADO", 45, "HEMATOLOGIA", ["Hemograma completo"]),
  study("uuid-372", "BUN DE UREA", 30),
  study("uuid-423", "UREA", 30),
  study("uuid-413", "IONOGRAMA 1 (sodio, potasio, cloro)", 150, "QUIMICA SANGUINEA", ["ELECTROLITOS EN SANGRE (NA, K Y CL)"]),
  study("uuid-415", "SODIO", 60),
  study("uuid-999", "ESTUDIO RETIRADO", 10, "QUIMICA SANGUINEA", [], false)
];
const row = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high" });
const reading = (...texts: string[]) => ({ requestedStudies: texts.map(row), uncertainStudies: [], notes: "" });
const CUT: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: false, agreement: true, integrityProblems: ["cortado"], integrityKinds: ["CUT_EDGE"] };

// Receta con un estudio cotizado, uno pendiente (BUN o Urea, sin alias) y la zona que no se ve.
function partial(texts = ["Hemograma completo", "Nitrogeno ureico/urea/nus"], document: DocumentGate = CUT): InternalRecord {
  const a = reading(...texts);
  const result = assembleAnalysis({
    consensus: buildSimpleConsensus(a, a),
    judgement: { resolvedStudies: [], unresolvedDisputes: [] },
    catalog,
    document,
    partialAuto: true,
    impact: { available: true, unaffected: new Set(texts.map(normalizeStudyKey)), qualifierRisk: false, notes: [] }
  });
  return result.internal!;
}
const opts = (record: InternalRecord) => ({ revision: record.revision, catalog, now: () => new Date("2026-10-20T10:00:00.000Z") });

describe("completar una cotización parcial con revisión humana", () => {
  it("parte de AUTO_PARTIAL con un pendiente de estudio y la zona que no se ve", () => {
    const record = partial();
    expect(record.outcome).toBe("AUTO_PARTIAL");
    expect(record.pending.map((p) => p.key)).toEqual(["nitrogeno ureico urea nus", "UNSEEN_REGION"]);
    expect(record.quoted.lines.map((l) => l.id)).toEqual(["uuid-108"]);
  });

  it("asignar el estudio pendiente conserva lo ya validado, suma la línea con el precio del catálogo y deja constancia del revisor", () => {
    const record = partial();
    const result = completeQuote(record, [{ pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-372"], reviewer: "ana" }], opts(record));
    expect(result.rejected).toEqual([]);
    expect(result.applied).toEqual(["nitrogeno ureico urea nus"]);
    expect(result.record.quoted.lines.map((l) => [l.id, l.priceBs, l.basis])).toEqual([["uuid-108", 45, ["EXACT_CONFIRMED"]], ["uuid-372", 30, ["HUMAN"]]]);
    expect(result.record.quoted.subtotalBs).toBe(75);
    expect(result.record.history).toEqual([{ at: "2026-10-20T10:00:00.000Z", reviewer: "ana", action: "ASSIGN", pendingKey: "nitrogeno ureico urea nus", detail: "uuid-372" }]);
    // todavía falta confirmar la zona que no se ve: la receta no está completa
    expect(result.record.recipeComplete).toBe(false);
    expect(result.record.revision).not.toBe(record.revision);
    expect(result.publicQuote?.studies.map((s) => s.name)).toEqual(["HEMOGRAMA COMPLETO AUTOMATIZADO", "BUN DE UREA"]);
    expect(result.publicQuote?.totalBs).toBe(75);
  });

  it("al resolver todo (incluida la zona que no se ve) la receta queda completa", () => {
    const record = partial();
    const result = completeQuote(record, [
      { pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-372"], reviewer: "ana" },
      { pendingKey: "UNSEEN_REGION", action: "CONFIRM_NO_MORE_STUDIES", reviewer: "ana" }
    ], opts(record));
    expect(result.record).toMatchObject({ recipeComplete: true, reviewRequired: false, pending: [] });
    expect(result.record.history.map((h) => h.action)).toEqual(["ASSIGN", "CONFIRM_NO_MORE_STUDIES"]);
  });

  it("NO_REQUESTED descarta el pendiente sin agregar ninguna línea", () => {
    const record = partial();
    const result = completeQuote(record, [{ pendingKey: "nitrogeno ureico urea nus", action: "NOT_REQUESTED", reviewer: "ana" }], opts(record));
    expect(result.record.quoted.lines.map((l) => l.id)).toEqual(["uuid-108"]);
    expect(result.record.pending.map((p) => p.key)).toEqual(["UNSEEN_REGION"]);
  });

  it("un UUID ya cotizado no se agrega ni se cobra otra vez", () => {
    const record = partial();
    const result = completeQuote(record, [{ pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-108", "uuid-108"], reviewer: "ana" }], opts(record));
    expect(result.record.quoted.lines).toHaveLength(1);
    expect(result.record.quoted.subtotalBs).toBe(45);
    expect(result.record.quoted.lines[0]?.texts).toEqual(["Hemograma completo", "Nitrogeno ureico/urea/nus"]);
    expect(result.record.pending.map((p) => p.key)).toEqual(["UNSEEN_REGION"]);
  });

  it("un paquete y uno de sus componentes no se cobran juntos (en ningún sentido)", () => {
    const withPackage = partial(["ELECTROLITOS EN SANGRE (NA, K Y CL)", "Sodio inventado"]);
    expect(withPackage.quoted.lines.map((l) => l.id)).toEqual(["uuid-413"]);
    const addComponent = completeQuote(withPackage, [{ pendingKey: "sodio inventado", action: "ASSIGN", studyIds: ["uuid-415"], reviewer: "ana" }], opts(withPackage));
    expect(addComponent.rejected[0]?.reason).toContain("solapamiento");
    expect(addComponent.record.quoted.lines.map((l) => l.id)).toEqual(["uuid-413"]);
    expect(addComponent.record.pending.map((p) => p.key)).toContain("sodio inventado");

    const withComponent = partial(["Hemograma completo", "Paquete raro"]);
    const addPackage = completeQuote(
      { ...withComponent, quoted: { ...withComponent.quoted, lines: [{ id: "uuid-415", code: "415", name: "SODIO", priceBs: 60, basis: ["EXACT_CONFIRMED"], texts: ["Sodio"] }] } },
      [{ pendingKey: "paquete raro", action: "ASSIGN", studyIds: ["uuid-413"], reviewer: "ana" }],
      opts(withComponent)
    );
    expect(addPackage.rejected[0]?.reason).toContain("solapamiento");
  });

  it("rechaza estudios inexistentes, inactivos o vacíos, y mezclar acciones con el tipo de pendiente", () => {
    const record = partial();
    const key = "nitrogeno ureico urea nus";
    const attempts: Array<[Parameters<typeof completeQuote>[1][number], RegExp]> = [
      [{ pendingKey: key, action: "ASSIGN", studyIds: ["uuid-inexistente"], reviewer: "ana" }, /no existe, no está activo/],
      [{ pendingKey: key, action: "ASSIGN", studyIds: ["uuid-999"], reviewer: "ana" }, /no existe, no está activo/],
      [{ pendingKey: key, action: "ASSIGN", studyIds: [], reviewer: "ana" }, /ningún estudio/],
      [{ pendingKey: "UNSEEN_REGION", action: "ASSIGN", studyIds: ["uuid-372"], reviewer: "ana" }, /solo se resuelve confirmando/],
      [{ pendingKey: "no-existe", action: "NOT_REQUESTED", reviewer: "ana" }, /no existe un pendiente/]
    ];
    for (const [resolution, reason] of attempts) {
      const result = completeQuote(record, [resolution], opts(record));
      expect(result.applied).toEqual([]);
      expect(result.rejected[0]?.reason).toMatch(reason);
      expect(result.record.quoted.lines).toHaveLength(1);
    }
    const wrongKind = completeQuote(record, [{ pendingKey: key, action: "CONFIRM_NO_MORE_STUDIES", reviewer: "ana" } as unknown as Parameters<typeof completeQuote>[1][number]], opts(record));
    expect(wrongKind.rejected[0]?.reason).toContain("zona de la receta que no se ve");
  });

  it("una resolución sobre una revisión desactualizada se rechaza por completo", () => {
    const record = partial();
    const result = completeQuote(record, [{ pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-372"], reviewer: "ana" }], { ...opts(record), revision: "otra-revision" });
    expect(result.applied).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("desactualizada");
    expect(result.record).toBe(record);
  });

  it("un pendiente resuelto no se puede resolver dos veces, y el registro original no se muta", () => {
    const record = partial();
    const snapshot = JSON.stringify(record);
    const first = completeQuote(record, [{ pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-372"], reviewer: "ana" }], opts(record));
    expect(JSON.stringify(record)).toBe(snapshot);
    const second = completeQuote(first.record, [{ pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-423"], reviewer: "luis" }], opts(first.record));
    expect(second.rejected[0]?.reason).toContain("ya se resolvió");
    expect(second.record.quoted.lines.map((l) => l.id)).toEqual(["uuid-108", "uuid-372"]);
  });

  it("una receta cuya lectura quedó invalidada (motivos de toda la receta) no se completa por estudio", () => {
    const stopped = partial(["Hemograma completo"], { ...CUT, documentType: "NOT_A_REQUEST" });
    expect(stopped.recipeStops).toEqual(["not_a_request"]);
    const result = completeQuote(stopped, [{ pendingKey: "UNSEEN_REGION", action: "CONFIRM_NO_MORE_STUDIES", reviewer: "ana" }], opts(stopped));
    expect(result.applied).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("revisión completa");
  });

  it("la cotización que se le envía al paciente tras completar sigue sin estados, pendientes ni UUID", () => {
    const record = partial();
    const result = completeQuote(record, [{ pendingKey: "nitrogeno ureico urea nus", action: "ASSIGN", studyIds: ["uuid-372"], reviewer: "ana" }], opts(record));
    expect(JSON.stringify(result.publicQuote)).not.toMatch(/HUMAN|pending|pendiente|ana|uuid|basis|review/i);
    expect(result.publicQuote?.totalLabel).toBe("Total de los estudios cotizados");
  });
});
