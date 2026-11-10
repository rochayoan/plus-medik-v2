import { describe, expect, it, vi } from "vitest";
import { appendApprovedQuotePreparations, MAX_QUOTE_MESSAGE_CHARS } from "../src/quote-preparation.js";
import type { CatalogStudy } from "../src/types.js";
import type { KnowledgeService, StudyPreparationResult } from "../src/knowledge/service.js";
import type { KnowledgeRefRecord } from "../src/audit.js";

const quote = "🩺 PlusMedik\nGlucosa — Bs 25\n\n💰 Total: Bs 25\n\nRespóndenos por este chat para continuar. 😊";
const study = (id: string, name: string, active = true) => ({ id, name, active } as CatalogStudy);
const ref = (id: string) => ({
  kind: "STUDY_PREPARATION" as const, key: `study:${id}`, version: 1,
  approvedAt: "2026-10-01T00:00:00Z", approvedBy: "clinical-a",
  validUntil: "2027-01-01T00:00:00Z", contentHash: "a".repeat(64)
});
const approved = (id: string, name: string, instructions: string) => ({
  studyId: id, studyName: name,
  result: {
    status: "AVAILABLE" as const,
    data: { studyId: id, studyName: name, prepState: "HAS_PREPARATION" as const, instructions },
    provenance: [ref(id)], omitted: []
  }
});
const unavailable = (id: string) => ({
  studyId: id,
  result: { status: "UNAVAILABLE" as const, reason: "NO_APPROVED_VERSION" as const, kind: "STUDY_PREPARATION" as const }
});
const context = (data: StudyPreparationResult, catalog: CatalogStudy[], ids: string[]) => {
  const knowledge: Pick<KnowledgeService, "getStudyPreparation"> = {
    getStudyPreparation: vi.fn(async () => data)
  };
  const trace = vi.fn(async (_refs: readonly KnowledgeRefRecord[]) => true);
  return { quote, studyIds: ids, catalog, knowledge, trace };
};

describe("apéndice clínico de la cotización (fail-closed)", () => {
  it("mantiene la cotización cuando no hay versiones aprobadas", async () => {
    const args = context({ status: "UNAVAILABLE", items: [unavailable("a")] }, [study("a", "Glucosa")], ["a"]);
    expect(await appendApprovedQuotePreparations(args)).toBe(quote);
    expect(args.trace).not.toHaveBeenCalled();
  });

  it("añade solo la preparación aprobada, conservando el pie y sin tocar precios", async () => {
    const args = context({ status: "AVAILABLE", items: [approved("a", "Glucosa", "Ayuno indicado por el laboratorio.")] }, [study("a", "Glucosa")], ["a"]);
    const output = await appendApprovedQuotePreparations(args);
    expect(output).toContain("Glucosa — Bs 25");
    expect(output).toContain("Ayuno indicado por el laboratorio.");
    expect(output).toContain("🧪 *PREPARACIÓN Y AYUNO*");
    expect(output).toContain("▫️ *Glucosa*\n• Ayuno indicado por el laboratorio.");
    expect(output.endsWith("Respóndenos por este chat para continuar. 😊")).toBe(true);
    expect(args.trace).toHaveBeenCalledWith([{ kind: "STUDY_PREPARATION", key: "study:a", version: 1, contentHash: "a".repeat(64) }]);
  });

  it("agrupa solo instrucciones literalmente idénticas, con rastro de ambas versiones", async () => {
    const args = context(
      { status: "AVAILABLE", items: [approved("a", "Glucosa", "Instrucción igual."), approved("b", "Hemograma", "Instrucción igual.")] },
      [study("a", "Glucosa"), study("b", "Hemograma")], ["a", "b"]
    );
    const output = await appendApprovedQuotePreparations(args);
    expect(output).toContain("▫️ *Glucosa / Hemograma*\n• Instrucción igual.");
    expect(output.match(/Instrucción igual\./g)).toHaveLength(1);
    expect(args.trace.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("no combina automáticamente indicaciones distintas", async () => {
    const args = context(
      { status: "AVAILABLE", items: [approved("a", "Glucosa", "Ayuno según protocolo A."), approved("b", "Hemograma", "Protocolo B.")] },
      [study("a", "Glucosa"), study("b", "Hemograma")], ["a", "b"]
    );
    const output = await appendApprovedQuotePreparations(args);
    expect(output).toContain("Ayuno según protocolo A.");
    expect(output).toContain("Protocolo B.");
    expect(output).toContain("Para combinarlas, consulta al laboratorio.");
  });

  it("no presenta un borrador no aprobado como si no requiriera preparación", async () => {
    const args = context(
      { status: "PARTIAL", items: [approved("a", "Glucosa", "Condición aprobada."), unavailable("b")] },
      [study("a", "Glucosa"), study("b", "Otro estudio")], ["a", "b"]
    );
    const output = await appendApprovedQuotePreparations(args);
    expect(output).toContain("Condición aprobada.");
    expect(output).toContain("la preparación aún no está confirmada");
    expect(output).not.toContain("Otro estudio*");
  });

  it("solo afirma sin preparación cuando existe un registro clínico explícito aprobado", async () => {
    const item = {
      studyId: "a", studyName: "Hemograma",
      result: {
        status: "AVAILABLE" as const,
        data: { studyId: "a", studyName: "Hemograma", prepState: "NO_PREPARATION_REQUIRED" as const },
        provenance: [ref("a")], omitted: []
      }
    };
    const args = context({ status: "AVAILABLE", items: [item] }, [study("a", "Hemograma")], ["a"]);
    expect(await appendApprovedQuotePreparations(args)).toContain("no requiere preparación especial");
  });

  it("no añade ninguna indicación si falla el rastro, la base o se desactiva el estudio", async () => {
    const args = context({ status: "AVAILABLE", items: [approved("a", "Glucosa", "Condición.")] }, [study("a", "Glucosa")], ["a"]);
    args.trace.mockResolvedValue(false);
    expect(await appendApprovedQuotePreparations(args)).toBe(quote);
    args.knowledge.getStudyPreparation = vi.fn(async () => { throw new Error("DB_DOWN"); });
    expect(await appendApprovedQuotePreparations(args)).toBe(quote);
    const inactive = context({ status: "AVAILABLE", items: [approved("a", "Glucosa", "Condición.")] }, [study("a", "Glucosa", false)], ["a"]);
    expect(await appendApprovedQuotePreparations(inactive)).toBe(quote);
    expect(inactive.trace).not.toHaveBeenCalled();
  });

  it("nunca trunca instrucciones; exceder el límite omite el apéndice completo", async () => {
    const args = context({ status: "AVAILABLE", items: [approved("a", "Glucosa", "X".repeat(MAX_QUOTE_MESSAGE_CHARS))] }, [study("a", "Glucosa")], ["a"]);
    expect(await appendApprovedQuotePreparations(args)).toBe(quote);
    expect(args.trace).not.toHaveBeenCalled();
  });

  it("no adjunta preparaciones de una lista superior a cinco estudios", async () => {
    const catalog = Array.from({ length: 6 }, (_, i) => study(String(i), `Prueba ${i}`));
    const args = context({ status: "UNAVAILABLE", items: [] }, catalog, catalog.map((x) => x.id));
    expect(await appendApprovedQuotePreparations(args)).toBe(quote);
    expect(args.knowledge.getStudyPreparation).not.toHaveBeenCalled();
  });
});
