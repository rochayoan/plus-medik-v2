import { describe, expect, it, vi } from "vitest";
import { ExactAliasCatalogResolver, uniqueMatchedStudies } from "../src/catalog.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import { PlusMedikCore } from "../src/pipeline.js";
import type { DisputeJudge, VisionReader } from "../src/ai.js";
import type { CatalogStudy, StudyObservation, VisionReading } from "../src/types.js";

const study = (overrides: Partial<CatalogStudy> & Pick<CatalogStudy, "id" | "name">): CatalogStudy => ({
  code: null,
  normalizedName: overrides.name.toLowerCase(),
  normalizedAliases: [],
  priceBs: 100,
  active: true,
  ...overrides
});

const observation = (text: string): StudyObservation => ({
  text,
  evidenceType: "X_MARK",
  certainty: "HIGH",
  evidenceSummary: "x"
});

const tshEclia = study({ id: "uuid-tsh", code: "17", name: "TSH ECLIA", normalizedName: "tsh eclia", normalizedAliases: ["hormona tiroestimulante"], priceBs: 120 });
const hemograma = study({ id: "uuid-hemo", code: null, name: "Hemograma completo", normalizedName: "hemograma completo", priceBs: 50 });

describe("ExactAliasCatalogResolver", () => {
  it("hace match exacto por normalized_name (normalizando el texto observado)", () => {
    const resolver = new ExactAliasCatalogResolver([tshEclia, hemograma]);
    const result = resolver.resolve(observation("  TSH  Eclia "));
    expect(result.status).toBe("MATCHED");
    if (result.status === "MATCHED") expect(result.study.id).toBe("uuid-tsh");
  });

  it("hace match exacto por normalized_alias", () => {
    const resolver = new ExactAliasCatalogResolver([tshEclia, hemograma]);
    const result = resolver.resolve(observation("Hormona Tiroestimulante"));
    expect(result.status).toBe("MATCHED");
    if (result.status === "MATCHED") expect(result.study.id).toBe("uuid-tsh");
  });

  it("un estudio inactivo no hace match, ni por nombre ni por alias", () => {
    const inactive = { ...tshEclia, active: false };
    const resolver = new ExactAliasCatalogResolver([inactive]);
    expect(resolver.resolve(observation("TSH ECLIA")).status).toBe("UNMATCHED");
    expect(resolver.resolve(observation("Hormona tiroestimulante")).status).toBe("UNMATCHED");
  });

  it("un estudio desconocido es UNMATCHED", () => {
    const resolver = new ExactAliasCatalogResolver([tshEclia]);
    expect(resolver.resolve(observation("Estudio inexistente")).status).toBe("UNMATCHED");
  });

  it("no hace fuzzy: un nombre parcial no coincide", () => {
    const resolver = new ExactAliasCatalogResolver([tshEclia]);
    expect(resolver.resolve(observation("TSH")).status).toBe("UNMATCHED");
  });

  it("texto vacío no coincide con nada", () => {
    const resolver = new ExactAliasCatalogResolver([study({ id: "x", name: "", normalizedName: "", normalizedAliases: [""] })]);
    expect(resolver.resolve(observation("  ")).status).toBe("UNMATCHED");
  });

  it("el mismo alias apuntando a 2 UUID es AMBIGUOUS", () => {
    const a = study({ id: "uuid-a", name: "Estudio A", normalizedAliases: ["perfil"] });
    const b = study({ id: "uuid-b", name: "Estudio B", normalizedAliases: ["perfil"] });
    const result = new ExactAliasCatalogResolver([a, b]).resolve(observation("Perfil"));
    expect(result.status).toBe("AMBIGUOUS");
    if (result.status === "AMBIGUOUS") expect(result.candidates.map((c) => c.id).sort()).toEqual(["uuid-a", "uuid-b"]);
  });

  it("un alias que coincide con el nombre del mismo UUID cuenta como un solo candidato", () => {
    const same = study({ id: "uuid-a", name: "Glucosa", normalizedName: "glucosa", normalizedAliases: ["glucosa"] });
    expect(new ExactAliasCatalogResolver([same]).resolve(observation("Glucosa")).status).toBe("MATCHED");
  });

  it("code no es identidad: dos estudios con code null y distinto UUID son distintos", () => {
    const a = study({ id: "uuid-a", name: "Uno", code: null });
    const b = study({ id: "uuid-b", name: "Dos", code: null });
    const resolver = new ExactAliasCatalogResolver([a, b]);
    const ra = resolver.resolve(observation("Uno"));
    const rb = resolver.resolve(observation("Dos"));
    expect(uniqueMatchedStudies([ra, rb]).map((s) => s.id)).toEqual(["uuid-a", "uuid-b"]);
  });
});

class FakeReader implements VisionReader {
  constructor(public name: string, private requested: StudyObservation[]) {}
  async read(): Promise<VisionReading> {
    return {
      reader: this.name,
      documentType: "TEXT_EXPLICIT_REQUEST",
      completeDocumentVisible: true,
      requested: this.requested,
      uncertain: [],
      globalUncertainty: []
    };
  }
}

const noJudge: DisputeJudge = {
  async judge() {
    return { requested: [], rejectedKeys: [], unresolvedKeys: [] };
  }
};

async function analyze(studies: CatalogStudy[], requested: StudyObservation[]) {
  const core = new PlusMedikCore(
    new FakeReader("A", requested),
    new FakeReader("B", requested),
    noJudge,
    new ExactAliasCatalogResolver(studies)
  );
  return core.analyze("base64", "image/jpeg");
}

describe("PlusMedikCore con catálogo por UUID", () => {
  it("dos observaciones que resuelven al mismo UUID dan una sola línea y un solo cobro", async () => {
    const result = await analyze([tshEclia, hemograma], [observation("TSH ECLIA"), observation("Hormona tiroestimulante")]);
    expect(result.catalog).toHaveLength(2);
    expect(result.safety.decision).toBe("AUTO_SAFE");
    expect(result.quote?.lines).toEqual([{ id: "uuid-tsh", code: "17", name: "TSH ECLIA", priceBs: 120 }]);
    expect(result.quote?.totalBs).toBe(120);
  });

  it("estudios distintos suman cada precio y code null se conserva en la línea", async () => {
    const result = await analyze([tshEclia, hemograma], [observation("TSH ECLIA"), observation("Hemograma completo")]);
    expect(result.quote?.lines.map((l) => l.id)).toEqual(["uuid-tsh", "uuid-hemo"]);
    expect(result.quote?.lines[1]?.code).toBeNull();
    expect(result.quote?.totalBs).toBe(170);
  });

  it("UNMATCHED mantiene HUMAN_REVIEW y no cotiza", async () => {
    const result = await analyze([tshEclia], [observation("TSH")]);
    expect(result.safety.decision).toBe("HUMAN_REVIEW");
    expect(result.safety.reasons).toContain("catalog_unmatched");
    expect(result.quote).toBeUndefined();
  });

  it("AMBIGUOUS mantiene HUMAN_REVIEW y no cotiza", async () => {
    const a = study({ id: "uuid-a", name: "Estudio A", normalizedAliases: ["perfil"] });
    const b = study({ id: "uuid-b", name: "Estudio B", normalizedAliases: ["perfil"] });
    const result = await analyze([a, b], [observation("Perfil")]);
    expect(result.safety.decision).toBe("HUMAN_REVIEW");
    expect(result.safety.reasons).toContain("catalog_ambiguous");
    expect(result.quote).toBeUndefined();
  });
});

describe("loadActiveCatalog (solo lectura, sin red)", () => {
  const testsPayload = [
    { id: "uuid-1", code: "1", name: "TSH ECLIA", normalized_name: "tsh eclia", price_bs: 120, active: true },
    { id: "uuid-2", code: "", name: "Sin code", normalized_name: "sin code", price_bs: 10, active: true },
    { id: "uuid-3", code: null, name: "Inactivo", normalized_name: "inactivo", price_bs: 5, active: false }
  ];
  const aliasesPayload = [
    { lab_test_id: "uuid-1", normalized_alias: "hormona tiroestimulante" },
    { lab_test_id: "uuid-3", normalized_alias: "alias de inactivo" },
    { lab_test_id: "uuid-desconocido", normalized_alias: "huerfano" }
  ];

  function fakeFetch() {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const body = path.includes("lab_test_aliases") ? aliasesPayload : testsPayload;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }

  it("solo emite GET, filtra active=eq.true y arma el catálogo por UUID", async () => {
    const fetchFn = fakeFetch();
    const studies = await loadActiveCatalog({ baseUrl: "https://example.test/", serviceKey: "secret", fetchFn });

    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, init]) => init.method === "GET")).toBe(true);
    expect(calls.some(([url]) => url.includes("lab_tests") && url.includes("active=eq.true"))).toBe(true);

    expect(studies.map((s) => s.id)).toEqual(["uuid-1", "uuid-2"]); // inactivo excluido
    expect(studies[0]).toMatchObject({ code: "1", normalizedName: "tsh eclia", normalizedAliases: ["hormona tiroestimulante"], priceBs: 120, active: true });
    expect(studies[1]?.code).toBeNull(); // code vacío -> null
    expect(studies.flatMap((s) => s.normalizedAliases)).not.toContain("alias de inactivo");
    expect(studies.flatMap((s) => s.normalizedAliases)).not.toContain("huerfano");
  });

  it("falla si faltan credenciales y no filtra la clave en los errores HTTP", async () => {
    await expect(loadActiveCatalog({ baseUrl: "", serviceKey: "" })).rejects.toThrow("SUPABASE_URL");
    const failing = vi.fn(async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const error = await loadActiveCatalog({ baseUrl: "https://example.test", serviceKey: "super-secret", fetchFn: failing }).catch((e: Error) => e);
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).not.toContain("super-secret");
  });
});
