import { z } from "zod";
import type { CatalogStudy } from "./types.js";

// Repositorio de catálogo en SOLO LECTURA (PostgREST). Solo emite GET; nunca escribe en Supabase.

const labTestRow = z.object({
  id: z.string().min(1),
  code: z.string().nullable(),
  name: z.string(),
  normalized_name: z.string(),
  price_bs: z.number().finite(),
  active: z.boolean(),
  category: z.string().nullable().optional(),
  sample_type: z.string().nullable().optional()
});

const aliasRow = z.object({
  lab_test_id: z.string().min(1),
  normalized_alias: z.string()
});

const PAGE_SIZE = 1000;

export interface SupabaseCatalogOptions {
  baseUrl?: string;
  serviceKey?: string;
  fetchFn?: typeof fetch;
}

async function fetchAllRows(
  options: Required<SupabaseCatalogOptions>,
  path: string
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const response = await options.fetchFn(`${options.baseUrl}/rest/v1/${path}`, {
      method: "GET",
      headers: {
        apikey: options.serviceKey,
        Authorization: `Bearer ${options.serviceKey}`,
        Range: `${from}-${from + PAGE_SIZE - 1}`,
        "Range-Unit": "items"
      }
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`GET ${path.split("?")[0]} -> HTTP ${response.status}: ${body}`);
    }
    const page = (await response.json()) as unknown[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

// Carga solo lab_tests con active=true y los aliases que apuntan a uno de esos estudios activos.
export async function loadActiveCatalog(options: SupabaseCatalogOptions = {}): Promise<CatalogStudy[]> {
  const baseUrl = (options.baseUrl ?? process.env.SUPABASE_URL)?.replace(/\/+$/, "");
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridos (define en .env)");
  }
  const resolved = { baseUrl, serviceKey, fetchFn: options.fetchFn ?? fetch };

  const [testRows, aliasRows] = await Promise.all([
    fetchAllRows(resolved, "lab_tests?select=id,code,name,normalized_name,price_bs,active,category,sample_type&active=eq.true&order=id.asc"),
    fetchAllRows(resolved, "lab_test_aliases?select=lab_test_id,normalized_alias&order=id.asc")
  ]);

  const studies = new Map<string, CatalogStudy>();
  for (const raw of testRows) {
    const row = labTestRow.parse(raw);
    if (!row.active) continue; // defensa: nunca cargar inactivos aunque el filtro falle
    studies.set(row.id, {
      id: row.id,
      code: row.code === null || row.code.trim() === "" ? null : row.code,
      name: row.name,
      normalizedName: row.normalized_name,
      normalizedAliases: [],
      priceBs: row.price_bs,
      active: true,
      category: row.category ?? null,
      sampleType: row.sample_type ?? null
    });
  }

  for (const raw of aliasRows) {
    const row = aliasRow.parse(raw);
    // Un alias solo es válido si apunta a un lab_test activo.
    const study = studies.get(row.lab_test_id);
    if (study && row.normalized_alias !== "") study.normalizedAliases.push(row.normalized_alias);
  }

  return [...studies.values()];
}
