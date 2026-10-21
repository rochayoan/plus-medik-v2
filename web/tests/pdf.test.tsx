import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { QuotePdf } from "@/lib/pdf/quote-pdf";
import type { QuoteDetail } from "@/lib/quotes";

const quote: QuoteDetail = {
  id: "q1",
  folio: 123,
  patientName: "María José Ñuflo",
  tariffName: "Convenio Caja",
  totalBs: 1234.5,
  source: "photo",
  validUntil: "2026-11-18",
  createdAt: "2026-10-19T14:00:00Z",
  organizationName: "Clínica Santa Cruz",
  createdByName: "Dra. Ana Rojas",
  items: Array.from({ length: 40 }, (_, index) => ({
    labTestId: `t${index}`,
    code: index % 2 ? `C${index}` : null,
    name: `Estudio número ${index + 1} — ácido úrico`,
    sampleType: "Suero",
    priceBs: 30.86
  }))
};

describe("PDF de cotización", () => {
  it("genera un PDF válido con muchos ítems (varias páginas), tildes y marca sin logo", async () => {
    const pdf = await renderToBuffer(<QuotePdf quote={quote} brand={{ name: "PlusMedik", address: "Av. Siempre Viva 123", phone: "+591 700 00000" }} />);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(3000);
    // 40 ítems no caben en una carta: debe paginar.
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
