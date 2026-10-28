import { describe, expect, it, vi } from "vitest";
import { normalizeStudyKey } from "../src/consensus.js";
import { samplePayload, StudyFactsService, turnaroundPayload, type StudyFactsStore } from "../src/study-facts/index.js";
import type { CatalogStudy } from "../src/types.js";

// Datos aprobados por estudio SIN base de datos: contrato del contenido (zod, el espejo del validador SQL), servicio de lectura con caché por revisión, caducidad y falla cerrado.
// Los datos son fixtures de PRUEBA. Contra PostgreSQL real: tests/study-facts-db.test.ts.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = new Date("2026-11-02T12:00:00.000Z");
const iso = (days: number) => new Date(T0.getTime() + days * 86_400_000).toISOString();
const study = (n: number, name: string, active = true): CatalogStudy => ({ id: id(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs: 10, active });
const CATALOG = [study(1, "ESTUDIO UNO"), study(2, "ESTUDIO DOS"), study(3, "ESTUDIO INACTIVO", false)];

const item = (kind: "SAMPLE" | "TURNAROUND", n: number, payload: unknown, over: Record<string, unknown> = {}) => ({
  kind, labTestId: id(n), classification: kind === "SAMPLE" ? "CLINICAL" : "ADMINISTRATIVE", version: 1, versionId: `fact-${kind}-${n}`, payload, validFrom: iso(-1), validUntil: iso(30),
  approvedAt: iso(-1), approvedBy: "crm:approver-1", contentHash: "a".repeat(64), ...over
});
const turn = (n: number, over: Record<string, unknown> = {}) => ({ labTestId: id(n), unit: "HOURS", max: 24, countedFrom: "SAMPLE_COLLECTION", ...over });
const smp = (n: number, over: Record<string, unknown> = {}) => ({ labTestId: id(n), sampleType: "Sangre venosa", requirementsState: "NO_SPECIAL_REQUIREMENTS", ...over });

class MemoryFactsStore implements StudyFactsStore {
  calls = { revision: 0, snapshot: 0 };
  down = false;
  constructor(public state: { revision: number; items: unknown[] }) {}
  async revision() { this.calls.revision++; if (this.down) throw new Error("caída"); return this.state.revision; }
  async snapshot() { this.calls.snapshot++; if (this.down) throw new Error("caída"); return structuredClone(this.state); }
}
const make = (items: unknown[], options: { now?: () => Date } = {}) => {
  const store = new MemoryFactsStore({ revision: 1, items });
  let now = T0;
  const clock = options.now ?? (() => now);
  const service = new StudyFactsService({ store, now: clock, revisionCheckMs: 15_000, maxStaleMs: 300_000 });
  return { store, service, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
};

describe("contenido: contrato de lista blanca (espejo del validador SQL)", () => {
  it.each([
    ["horas", turn(1)], ["rango de horas", turn(1, { min: 12, max: 24 })], ["días hábiles", turn(1, { unit: "DAYS", dayType: "BUSINESS", max: 3 })], ["rango de días calendario", turn(1, { unit: "DAYS", dayType: "CALENDAR", min: 2, max: 5 })],
    ["desde la recepción con nota", turn(1, { countedFrom: "SAMPLE_RECEIPT", note: "Sin contar domingos" })]
  ])("plazo válido: %s", (_name, payload) => {
    expect(turnaroundPayload.safeParse(payload).success).toBe(true);
  });

  it.each([
    ["sin máximo", { labTestId: id(1), unit: "HOURS", countedFrom: "SAMPLE_COLLECTION" }], ["horas con tipo de día", turn(1, { dayType: "BUSINESS" })], ["días sin tipo de día", turn(1, { unit: "DAYS", max: 3 })],
    ["más de 60 días", turn(1, { unit: "DAYS", dayType: "BUSINESS", max: 61 })], ["más de 720 horas", turn(1, { max: 721 })], ["cero", turn(1, { max: 0 })], ["fraccionario", turn(1, { max: 2.5 })],
    ["mínimo >= máximo", turn(1, { min: 24 })], ["unidad desconocida", turn(1, { unit: "SEMANAS" })], ["sin 'desde cuándo'", (({ countedFrom: _c, ...rest }) => rest)(turn(1))],
    ["nota con importe", turn(1, { note: "Urgente: Bs 50" })], ["clave extra", turn(1, { precio: 10 })], ["id que no es UUID", turn(1, { labTestId: "hemograma" })]
  ])("plazo inválido: %s", (_name, payload) => {
    expect(turnaroundPayload.safeParse(payload).success).toBe(false);
  });

  it("muestra: «sin requisitos» es explícito y exclusivo; con requisitos debe decir cuáles; sin importes", () => {
    expect(samplePayload.safeParse(smp(1)).success).toBe(true);
    expect(samplePayload.safeParse(smp(1, { requirementsState: "HAS_REQUIREMENTS", requirements: ["Traer frasco estéril"] })).success).toBe(true);
    expect(samplePayload.safeParse(smp(1, { requirementsState: "HAS_REQUIREMENTS" })).success).toBe(false);
    expect(samplePayload.safeParse(smp(1, { requirements: ["Ayuno"] })).success).toBe(false);
    expect(samplePayload.safeParse(smp(1, { requirementsState: "HAS_REQUIREMENTS", requirements: [] })).success).toBe(false);
    expect(samplePayload.safeParse(smp(1, { requirementsState: "HAS_REQUIREMENTS", requirements: ["Pagar Bs 20"] })).success).toBe(false);
    expect(samplePayload.safeParse(smp(1, { sampleType: "" })).success).toBe(false);
    expect(samplePayload.safeParse(smp(1, { sampleType: "x".repeat(81) })).success).toBe(false);
    expect(samplePayload.safeParse(smp(1, { precio: 1 })).success).toBe(false);
  });
});

describe("StudyFactsService: solo lo aprobado y vigente", () => {
  it("entrega el plazo en la UNIDAD aprobada para cada estudio, con su procedencia; no convierte horas en días", async () => {
    const { service } = make([item("TURNAROUND", 1, turn(1)), item("TURNAROUND", 2, turn(2, { unit: "DAYS", dayType: "BUSINESS", min: 2, max: 3 }))]);
    const result = await service.getTurnaround([id(1), id(2)], CATALOG);
    expect(result.status).toBe("AVAILABLE");
    const [one, two] = result.items;
    expect(one!.result).toMatchObject({ status: "AVAILABLE", data: { studyId: id(1), studyName: "ESTUDIO UNO", unit: "HOURS", max: 24 }, provenance: { kind: "TURNAROUND", labTestId: id(1), version: 1, approvedBy: "crm:approver-1" } });
    expect(two!.result).toMatchObject({ status: "AVAILABLE", data: { unit: "DAYS", dayType: "BUSINESS", min: 2, max: 3 } });
    expect(JSON.stringify(result)).not.toContain("labTestId\":\"" + id(1) + "\",\"unit");
  });

  it("devuelve el tipo de muestra y los requisitos; «sin requisitos» solo si fue aprobado", async () => {
    const { service } = make([item("SAMPLE", 1, smp(1)), item("SAMPLE", 2, smp(2, { requirementsState: "HAS_REQUIREMENTS", requirements: ["Traer frasco estéril"] }))]);
    const result = await service.getSample([id(1), id(2)], CATALOG);
    expect(result.items[0]!.result).toMatchObject({ status: "AVAILABLE", data: { sampleType: "Sangre venosa", requirementsState: "NO_SPECIAL_REQUIREMENTS" } });
    expect(result.items[1]!.result).toMatchObject({ status: "AVAILABLE", data: { requirements: ["Traer frasco estéril"] } });
  });

  it("sin registro aprobado NO es «sin requisitos» ni un plazo supuesto: es no disponible; los dos tipos son independientes", async () => {
    const { service } = make([item("TURNAROUND", 1, turn(1))]);
    expect((await service.getSample([id(1)], CATALOG)).items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "SAMPLE" });
    expect((await service.getTurnaround([id(2)], CATALOG)).items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION", kind: "TURNAROUND" });
    expect((await service.getTurnaround([id(2)], CATALOG)).status).toBe("UNAVAILABLE");
  });

  it("varios estudios: PARTIAL si solo algunos tienen dato; cada uno se informa por separado y sin repetidos", async () => {
    const { service } = make([item("TURNAROUND", 1, turn(1))]);
    const result = await service.getTurnaround([id(1), id(2), id(1)], CATALOG);
    expect(result.status).toBe("PARTIAL");
    expect(result.items.map((entry) => [entry.studyId, entry.result.status])).toEqual([[id(1), "AVAILABLE"], [id(2), "UNAVAILABLE"]]);
  });

  it("caducidad evaluada AL USAR el dato (aunque la copia local sea más vieja) y vigencia futura", async () => {
    const { service, advance } = make([item("TURNAROUND", 1, turn(1), { validUntil: iso(1) }), item("TURNAROUND", 2, turn(2), { validFrom: iso(5) })]);
    expect((await service.getTurnaround([id(1)], CATALOG)).status).toBe("AVAILABLE");
    expect((await service.getTurnaround([id(2)], CATALOG)).items[0]!.result).toMatchObject({ reason: "NOT_YET_VALID" });
    advance(2 * 86_400_000);
    expect((await service.getTurnaround([id(1)], CATALOG)).items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "EXPIRED" });
  });

  it("estudio desconocido, inactivo o sin catálogo: no disponible con su razón (nunca se entrega)", async () => {
    const { service } = make([item("TURNAROUND", 1, turn(1)), item("TURNAROUND", 3, turn(3))]);
    expect((await service.getTurnaround([id(99)], CATALOG)).items[0]!.result).toMatchObject({ reason: "UNKNOWN_STUDY" });
    expect((await service.getTurnaround([id(3)], CATALOG)).items[0]!.result).toMatchObject({ reason: "INACTIVE_STUDY" });
    expect((await service.getTurnaround([id(1)], undefined)).items[0]!.result).toMatchObject({ reason: "CATALOG_UNAVAILABLE" });
    expect((await service.getTurnaround([id(1)], [])).items[0]!.result).toMatchObject({ reason: "CATALOG_UNAVAILABLE" });
  });

  it("contenido inválido o de otro estudio NO se usa (y se cuenta como rechazado)", async () => {
    const { service } = make([
      item("TURNAROUND", 1, turn(1, { max: 0 })), item("TURNAROUND", 2, turn(1)), item("SAMPLE", 1, { labTestId: id(1) }), { basura: true }
    ]);
    expect((await service.getTurnaround([id(1)], CATALOG)).items[0]!.result).toMatchObject({ reason: "INVALID_CONTENT" });
    expect((await service.getTurnaround([id(2)], CATALOG)).items[0]!.result).toMatchObject({ reason: "INVALID_CONTENT" });
    expect((await service.getSample([id(1)], CATALOG)).items[0]!.result).toMatchObject({ reason: "INVALID_CONTENT" });
    expect(service.rejectedCount).toBe(4);
  });

  it("jamás entrega precios: del catálogo solo se mira id, nombre y estado", async () => {
    const { service } = make([item("TURNAROUND", 1, turn(1))]);
    const result = await service.getTurnaround([id(1)], CATALOG);
    expect(JSON.stringify(result)).not.toMatch(/price|precio|priceBs/i);
  });
});

describe("StudyFactsService: caché, revisión y falla cerrado", () => {
  it("dentro de la ventana no consulta la base; al vencer compara la revisión (barata) y solo recarga si cambió", async () => {
    const { store, service, advance } = make([item("TURNAROUND", 1, turn(1))]);
    await service.getTurnaround([id(1)], CATALOG);
    await service.getTurnaround([id(1)], CATALOG);
    expect(store.calls).toEqual({ revision: 0, snapshot: 1 });
    advance(16_000);
    await service.getTurnaround([id(1)], CATALOG);
    expect(store.calls).toEqual({ revision: 1, snapshot: 1 });
    store.state = { revision: 2, items: [item("TURNAROUND", 1, turn(1, { max: 48 }), { version: 2 })] };
    advance(16_000);
    const result = await service.getTurnaround([id(1)], CATALOG);
    expect(store.calls.snapshot).toBe(2);
    expect(result.items[0]!.result).toMatchObject({ data: { max: 48 }, provenance: { version: 2 } });
  });

  it("un dato retirado deja de entregarse en cuanto cambia la revisión; invalidate() fuerza la recarga", async () => {
    const { store, service } = make([item("TURNAROUND", 1, turn(1))]);
    await service.getTurnaround([id(1)], CATALOG);
    store.state = { revision: 2, items: [] };
    expect((await service.getTurnaround([id(1)], CATALOG)).status).toBe("AVAILABLE"); // aún dentro de la ventana de 15 s
    service.invalidate();
    expect((await service.getTurnaround([id(1)], CATALOG)).items[0]!.result).toMatchObject({ reason: "NO_APPROVED_VERSION" });
  });

  it("si la base cae se sigue con la copia hasta el plazo máximo y luego TODO es no disponible (STORE_UNAVAILABLE)", async () => {
    const { store, service, advance } = make([item("TURNAROUND", 1, turn(1))]);
    await service.getTurnaround([id(1)], CATALOG);
    store.down = true;
    advance(20_000);
    expect((await service.getTurnaround([id(1)], CATALOG)).status).toBe("AVAILABLE");
    advance(400_000);
    expect((await service.getTurnaround([id(1)], CATALOG)).items[0]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "STORE_UNAVAILABLE" });
  });

  it("sin copia inicial y con la base caída: no disponible (nada inventado)", async () => {
    const { store, service } = make([item("TURNAROUND", 1, turn(1))]);
    store.down = true;
    expect((await service.getSample([id(1)], CATALOG)).items[0]!.result).toMatchObject({ reason: "STORE_UNAVAILABLE" });
  });

  it("una recarga más vieja nunca pisa una copia más nueva, y varias consultas simultáneas hacen una sola recarga", async () => {
    const store = new MemoryFactsStore({ revision: 5, items: [item("TURNAROUND", 1, turn(1))] });
    const spy = vi.spyOn(store, "snapshot");
    const service = new StudyFactsService({ store, now: () => T0, revisionCheckMs: 15_000 });
    await Promise.all([service.getTurnaround([id(1)], CATALOG), service.getTurnaround([id(1)], CATALOG), service.getSample([id(1)], CATALOG)]);
    expect(spy).toHaveBeenCalledTimes(1);
    store.state = { revision: 3, items: [] };
    service.invalidate();
    expect((await service.getTurnaround([id(1)], CATALOG)).status).toBe("AVAILABLE");
  });
});
