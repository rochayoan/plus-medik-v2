import "server-only";
import { createHash } from "node:crypto";
import { loadActiveCatalog } from "@core/supabase-catalog";
import type { CatalogStudy } from "@core/types";
import type { CatalogPayload, ClientStudy } from "./catalog-types";
import { publicEnv } from "./env";
import { adminClient } from "./supabase/admin";

// Cache en memoria por instancia. Con 50 usuarios simultáneos, una sola carga del catálogo atiende a todos:
// las peticiones concurrentes comparten la misma promesa en vuelo (sin estampida contra Supabase).
const TTL_MS = Number(process.env.CATALOG_CACHE_TTL_MS ?? 5 * 60_000);

interface Entry<T> {
  at: number;
  promise: Promise<T>;
}

function cached<T>(store: Map<string, Entry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const entry = store.get(key);
  if (entry && Date.now() - entry.at < TTL_MS) return entry.promise;
  const promise = load();
  store.set(key, { at: Date.now(), promise });
  // Un fallo no queda cacheado: la próxima petición reintenta.
  promise.catch(() => {
    if (store.get(key)?.promise === promise) store.delete(key);
  });
  return promise;
}

const coreStore = new Map<string, Entry<CatalogStudy[]>>();
const priceStore = new Map<string, Entry<Map<string, number>>>();
const payloadStore = new Map<string, Entry<CatalogPayload>>();

// Catálogo activo completo (con alias) tal como lo usa el core: solo lectura, service role.
export function getCoreCatalog(): Promise<CatalogStudy[]> {
  return cached(coreStore, "core", () => {
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
    return loadActiveCatalog({ baseUrl: publicEnv.supabaseUrl, serviceKey });
  });
}

async function loadTariffPrices(tariffId: string): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await adminClient()
      .from("tariff_prices")
      .select("lab_test_id, price_bs")
      .eq("tariff_id", tariffId)
      .order("lab_test_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`tariff_prices: ${error.message}`);
    for (const row of data as Array<{ lab_test_id: string; price_bs: number | string }>) prices.set(row.lab_test_id, Number(row.price_bs));
    if (data.length < PAGE) return prices;
  }
}

// Precio efectivo = precio de la tarifa si existe; si no, precio Paciente (lab_tests.price_bs). Misma regla que create_quote.
export function priceCatalog(core: CatalogStudy[], prices: Map<string, number>, tariffName: string): CatalogPayload {
  const studies: ClientStudy[] = core
    .filter((study) => study.active)
    .map((study) => ({
      id: study.id,
      code: study.code,
      name: study.name,
      normalizedName: study.normalizedName,
      aliases: study.normalizedAliases,
      category: study.category ?? null,
      sampleType: study.sampleType ?? null,
      priceBs: prices.get(study.id) ?? study.priceBs
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const version = createHash("sha256").update(JSON.stringify({ tariffName, studies })).digest("hex").slice(0, 20);
  return { version, tariffName, studies };
}

export function getCatalogPayload(tariffId: string | null, tariffName: string): Promise<CatalogPayload> {
  return cached(payloadStore, `${tariffId ?? "paciente"}:${tariffName}`, async () => {
    const [core, prices] = await Promise.all([
      getCoreCatalog(),
      tariffId ? cached(priceStore, tariffId, () => loadTariffPrices(tariffId)) : Promise.resolve(new Map<string, number>())
    ]);
    return priceCatalog(core, prices, tariffName);
  });
}

// Tras importar una tarifa: esta instancia la ve al instante; las demás, al vencer el TTL.
export function invalidateCatalogCache(): void {
  coreStore.clear();
  priceStore.clear();
  payloadStore.clear();
}
