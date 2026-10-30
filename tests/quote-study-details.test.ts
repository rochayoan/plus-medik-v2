import { describe, expect, it, vi } from "vitest";
import { appendApprovedQuoteStudyDetails } from "../src/quote-study-details.js";
import type { FactRefRecord } from "../src/audit.js";
import type { StudyFactsQueries } from "../src/study-facts/service.js";
import type { CatalogStudy } from "../src/types.js";

const quote = "🩺 PlusMedik\nGlucosa — Bs 25\n\n💰 Total: Bs 25\n\nRespóndenos por este chat para continuar. 😊";
const study = (id: string, name = "Glucosa", active = true): CatalogStudy => ({ id, name, active } as CatalogStudy);
const proof = (kind: "SAMPLE" | "TURNAROUND", id = "a") => ({
  kind, labTestId: id, version: 2, approvedAt: "2026-10-25", approvedBy: "laboratorio",
  validUntil: "2027-01-01", contentHash: "b".repeat(64)
});
const sample = (id = "a") => ({
  studyId: id, studyName: "Glucosa",
  result: {
    status: "AVAILABLE" as const,
    data: { studyId: id, studyName: "Glucosa", sampleType: "Sangre venosa", requirementsState: "HAS_REQUIREMENTS" as const, requirements: ["Seguir las indicaciones del laboratorio"] },
    provenance: proof("SAMPLE", id)
  }
});
const turnaround = (id = "a") => ({
  studyId: id, studyName: "Glucosa",
  result: {
    status: "AVAILABLE" as const,
    data: { studyId: id, studyName: "Glucosa", unit: "HOURS" as const, max: 24, countedFrom: "SAMPLE_COLLECTION" as const },
    provenance: proof("TURNAROUND", id)
  }
});
const unavailable = (id: string, kind: "SAMPLE" | "TURNAROUND") => ({
  studyId: id, studyName: "Glucosa",
  result: { status: "UNAVAILABLE" as const, reason: "NO_APPROVED_VERSION" as const, kind, labTestId: id }
});
const setup = (data: {
  samples?: unknown[]; turnarounds?: unknown[]; studyIds?: string[];
  catalog?: CatalogStudy[]; sourceQuote?: string;
} = {}) => {
  const ids = data.studyIds ?? ["a"];
  const catalog = data.catalog ?? [study("a")];
  const facts = {
    getSample: vi.fn(async () => ({ status: "PARTIAL", items: data.samples ?? [sample()] })),
    getTurnaround: vi.fn(async () => ({ status: "PARTIAL", items: data.turnarounds ?? [turnaround()] }))
  } as unknown as StudyFactsQueries;
  const trace = vi.fn(async (_refs: readonly FactRefRecord[]) => true);
  return { quote: data.sourceQuote ?? quote, studyIds: ids, catalog, facts, trace };
};

describe("detalle aprobado de la cotización: muestra, requisitos y entrega", () => {
  it("adjunta los dos datos aprobados, mantiene la cotización y el pie, sin alterar el total", async () => {
    const input = setup();
    const body = await appendApprovedQuoteStudyDetails(input);
    expect(body).toContain("Glucosa — Bs 25");
    expect(body).toContain("💰 Total: Bs 25");
    expect(body).toContain("📋 *MUESTRAS, REQUISITOS Y ENTREGA*");
    expect(body).toContain("▫️ *Glucosa*\n• Tipo de muestra:");
    expect(body).toContain("Tipo de muestra: Sangre venosa");
    expect(body).toContain("Seguir las indicaciones del laboratorio");
    expect(body).toContain("Tiempo de entrega: hasta 24 horas");
    expect(body).toContain("contado desde la toma de la muestra");
    expect(body.endsWith("Respóndenos por este chat para continuar. 😊")).toBe(true);
    expect(input.trace).toHaveBeenCalledWith([
      { kind: "SAMPLE", labTestId: "a", version: 2, contentHash: "b".repeat(64) },
      { kind: "TURNAROUND", labTestId: "a", version: 2, contentHash: "b".repeat(64) }
    ]);
  });

  it("sin datos aprobados no agrega ningún requisito ni plazo supuesto", async () => {
    const input = setup({ samples: [unavailable("a", "SAMPLE")], turnarounds: [unavailable("a", "TURNAROUND")] });
    expect(await appendApprovedQuoteStudyDetails(input)).toBe(quote);
    expect(input.trace).not.toHaveBeenCalled();
  });

  it("admite datos parciales: muestra aprobada sin plazo no inventa el plazo", async () => {
    const input = setup({ turnarounds: [unavailable("a", "TURNAROUND")] });
    const body = await appendApprovedQuoteStudyDetails(input);
    expect(body).toContain("Tipo de muestra: Sangre venosa");
    expect(body).not.toContain("Tiempo de entrega");
    expect(input.trace).toHaveBeenCalledWith([{ kind: "SAMPLE", labTestId: "a", version: 2, contentHash: "b".repeat(64) }]);
  });

  it("nunca supone que no hay requisitos especiales cuando no existe registro", async () => {
    const input = setup({ samples: [unavailable("a", "SAMPLE")] });
    const body = await appendApprovedQuoteStudyDetails(input);
    expect(body).toContain("Tiempo de entrega");
    expect(body).not.toContain("no tiene requisitos especiales");
  });

  it("respeta unidades y días hábiles aprobados sin convertir horas a días", async () => {
    const input = setup({ turnarounds: [{
      studyId: "a", result: {
        status: "AVAILABLE", provenance: proof("TURNAROUND"),
        data: { studyId: "a", studyName: "Glucosa", unit: "DAYS", max: 3, min: 2, dayType: "BUSINESS", countedFrom: "SAMPLE_RECEIPT" }
      }
    }] });
    const body = await appendApprovedQuoteStudyDetails(input);
    expect(body).toContain("entre 2 y 3 días hábiles");
    expect(body).toContain("desde la recepción de la muestra");
  });

  it("bloquea estudios inactivos, ajenos a la cotización o más de cinco", async () => {
    const inactive = setup({ catalog: [study("a", "Glucosa", false)] });
    expect(await appendApprovedQuoteStudyDetails(inactive)).toBe(quote);
    expect(inactive.trace).not.toHaveBeenCalled();
    const longIds = Array.from({ length: 6 }, (_, i) => String(i));
    const large = setup({ studyIds: longIds, catalog: longIds.map((id) => study(id)) });
    expect(await appendApprovedQuoteStudyDetails(large)).toBe(quote);
    expect(large.trace).not.toHaveBeenCalled();
  });

  it("no publica datos sin traza verificada, ni con referencias incorrectas", async () => {
    const missingTrace = setup();
    missingTrace.trace.mockResolvedValue(false);
    expect(await appendApprovedQuoteStudyDetails(missingTrace)).toBe(quote);
    const wrong = setup({ samples: [{ ...sample(), result: { ...sample().result, provenance: proof("SAMPLE", "otro-id") } }] });
    expect(await appendApprovedQuoteStudyDetails(wrong)).toBe(quote);
    expect(wrong.trace).not.toHaveBeenCalled();
  });

  it("no publica apéndices si las fuentes fallan o si el mensaje excede el límite de WhatsApp", async () => {
    const failed = setup();
    failed.facts.getSample = vi.fn(async () => { throw new Error("database_down"); });
    expect(await appendApprovedQuoteStudyDetails(failed)).toBe(quote);
    const oversized = setup({ sourceQuote: quote + "X".repeat(3800) });
    expect(await appendApprovedQuoteStudyDetails(oversized)).toBe(oversized.quote);
    expect(oversized.trace).not.toHaveBeenCalled();
  });
});
