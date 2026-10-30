import { describe, expect, it, vi } from "vitest";
import type { CatalogStudy } from "../src/types.js";
import { handleWebQuote, resolveWebQuoteConfig, type WebQuoteDeps, type WebRoute } from "../src/web-quote.js";

const TOKEN = "token-web-de-prueba-solo-para-tests-0123456789";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const OTHER = "55555555-5555-4555-8555-555555555555";
const study = (id: string, name: string, priceBs: number, over: Partial<CatalogStudy> = {}): CatalogStudy => ({ id, code: null, name, normalizedName: name.toLowerCase(), normalizedAliases: [], priceBs, active: true, category: "Hematología", sampleType: "Sangre", ...over });
const CATALOG = [study(A, "Hemograma", 45), study(B, "Glicemia", 20.5), study(C, "Inactivo", 10, { active: false })];

function setup(over: Partial<WebQuoteDeps> = {}): WebQuoteDeps {
  return {
    config: { token: TOKEN },
    loadCatalog: async () => CATALOG,
    log: vi.fn(),
    ...over
  };
}
const call = (route: WebRoute, deps: WebQuoteDeps, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}) =>
  handleWebQuote(new Request(`https://agent.example/api/web/${route}`, {
    method: init.method ?? (route === "catalog" ? "GET" : "POST"),
    headers: { authorization: `Bearer ${TOKEN}`, ...(route === "quote" ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body
  }), route, deps);
const body = async (res: Response) => (await res.json()) as Record<string, any>;

describe("configuración", () => {
  it("apagada por defecto y exige token largo", () => {
    expect(resolveWebQuoteConfig({})).toBeUndefined();
    expect(resolveWebQuoteConfig({ PLUSMEDIK_WEB_API: "on", PLUSMEDIK_WEB_API_TOKEN: "corto" })).toBeUndefined();
    expect(resolveWebQuoteConfig({ PLUSMEDIK_WEB_API: "on", PLUSMEDIK_WEB_API_TOKEN: TOKEN })).toEqual({ token: TOKEN });
  });
  it("sin configuración responde 503 sin tocar nada", async () => {
    const deps = setup({ config: undefined, loadCatalog: vi.fn() });
    expect((await call("catalog", deps)).status).toBe(503);
    expect(deps.loadCatalog).not.toHaveBeenCalled();
  });
});

describe("autenticación", () => {
  it("rechaza token incorrecto, ausente, navegador y método erróneo", async () => {
    const deps = setup();
    expect((await call("catalog", deps, { headers: { authorization: "Bearer otro" } })).status).toBe(401);
    expect((await call("catalog", deps, { headers: { authorization: "" } })).status).toBe(401);
    expect((await call("catalog", deps, { headers: { origin: "https://web.example" } })).status).toBe(403);
    expect((await call("catalog", deps, { method: "POST" })).status).toBe(405);
  });
});

describe("catalog", () => {
  it("devuelve solo estudios activos con precio válido", async () => {
    const deps = setup({ loadCatalog: async () => [...CATALOG, study("44444444-4444-4444-8444-444444444444", "Roto", Number.NaN)] });
    const res = await body(await call("catalog", deps));
    expect(res.studies.map((s: { id: string }) => s.id)).toEqual([A, B]);
    expect(res.studies[0]).toEqual({ id: A, name: "Hemograma", category: "Hematología", sampleType: "Sangre", priceBs: 45 });
  });
});

describe("quote", () => {
  const post = (deps: WebQuoteDeps, payload: unknown) => call("quote", deps, { body: JSON.stringify(payload) });
  it("recalcula el total en el servidor y quita duplicados", async () => {
    const res = await body(await post(setup(), { studyIds: [A, B, A] }));
    expect(res).toMatchObject({ ok: true, totalBs: 65.5, totalLabel: "Total de los estudios cotizados" });
    expect(res.studies).toHaveLength(2);
  });
  it("estudio inactivo o desconocido bloquea la cotización", async () => {
    expect((await post(setup(), { studyIds: [A, C] })).status).toBe(409);
    expect((await post(setup(), { studyIds: [A, OTHER] })).status).toBe(409);
  });
  it("valida la forma y no acepta precios del cliente", async () => {
    expect((await post(setup(), { studyIds: [] })).status).toBe(400);
    expect((await post(setup(), { studyIds: ["x"] })).status).toBe(400);
    expect((await call("quote", setup(), { body: "{" })).status).toBe(400);
    const res = await body(await post(setup(), { studyIds: [A], priceBs: 1 }));
    expect(res.totalBs).toBe(45);
  });
  it("incluye solo preparación aprobada con procedencia", async () => {
    const knowledge = {
      getStudyPreparation: async () => ({
        status: "PARTIAL",
        items: [
          { studyId: A, studyName: "Hemograma", result: { status: "AVAILABLE", data: { studyId: A, studyName: "Hemograma", prepState: "FASTING_REQUIRED", fastingHours: 8 }, provenance: [{ kind: "STUDY_PREPARATION", key: `study:${A}`, version: 1, contentHash: "h" }] } },
          { studyId: B, studyName: "Glicemia", result: { status: "UNAVAILABLE", reason: "NO_APPROVED_RECORD", provenance: [] } }
        ]
      })
    } as unknown as WebQuoteDeps["knowledge"];
    const res = await body(await post(setup({ knowledge }), { studyIds: [A, B] }));
    expect(res.preparations).toEqual([expect.objectContaining({ studyId: A, fastingHours: 8 })]);
  });
});
