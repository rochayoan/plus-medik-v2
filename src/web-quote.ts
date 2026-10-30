import { createHash, timingSafeEqual } from "node:crypto";
import type { KnowledgeService } from "./knowledge/service.js";
import type { CatalogStudy } from "./types.js";

// API para el cotizador web de los médicos (proyecto y base de datos aparte). Solo servidor a servidor:
//   GET  /api/web/catalog        catálogo activo (id, nombre, categoría, muestra, precio)
//   POST /api/web/quote          {studyIds: string[]} -> total recalculado AQUÍ con lab_tests.price_bs + preparación aprobada
// APAGADA por defecto: sin PLUSMEDIK_WEB_API=on y PLUSMEDIK_WEB_API_TOKEN (≥ 32 caracteres, exclusivo de esta integración) responde 503 sin tocar nada.
// Los usuarios, contraseñas y el límite de fotos por usuario viven en el proyecto web; aquí solo se autentica al servidor que llama.

export const MIN_WEB_TOKEN_LENGTH = 32;
export const MAX_WEB_QUOTE_STUDIES = 40;
const MAX_JSON_BYTES = 8 * 1024;

export interface WebQuoteConfig {
  token: string;
}

export function resolveWebQuoteConfig(env: NodeJS.ProcessEnv = process.env): WebQuoteConfig | undefined {
  if (env.PLUSMEDIK_WEB_API?.trim().toLowerCase() !== "on") return undefined;
  const token = env.PLUSMEDIK_WEB_API_TOKEN?.trim() ?? "";
  return token.length >= MIN_WEB_TOKEN_LENGTH ? { token } : undefined;
}

export type WebRoute = "catalog" | "quote";

export interface WebQuoteDeps {
  config: WebQuoteConfig | undefined;
  loadCatalog(): Promise<CatalogStudy[]>;
  knowledge?: Pick<KnowledgeService, "getStudyPreparation">;
  log(event: string, data: Record<string, unknown>): void;
}

const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
const tokenMatches = (provided: string, expected: string) => timingSafeEqual(digest(provided), digest(expected));
const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOTAL_LABEL = "Total de los estudios cotizados";

const publicStudy = (study: CatalogStudy) => ({
  id: study.id,
  name: study.name,
  category: study.category ?? null,
  sampleType: study.sampleType ?? null,
  priceBs: study.priceBs
});

// El precio entra al total solo si es finito y no negativo: un precio inválido bloquea la cotización (falla cerrado).
const validPrice = (study: CatalogStudy) => Number.isFinite(study.priceBs) && study.priceBs >= 0;
const roundBs = (value: number) => Math.round(value * 100) / 100;

async function preparationsFor(ids: readonly string[], catalog: readonly CatalogStudy[], deps: WebQuoteDeps) {
  if (!deps.knowledge || ids.length === 0) return [];
  try {
    const checked = await deps.knowledge.getStudyPreparation(ids, catalog);
    const out: Array<{ studyId: string; studyName: string; prepState?: string; fastingHours?: number; collectionWindow?: string; instructions?: string }> = [];
    for (const item of checked.items) {
      // Solo datos APROBADOS y vigentes con procedencia; lo demás no se describe (nunca se dice «sin preparación» por falta de dato).
      if (item.result.status !== "AVAILABLE" || item.result.provenance.length === 0) continue;
      const prep = item.result.data;
      out.push({
        studyId: item.studyId,
        studyName: item.studyName ?? "",
        prepState: prep.prepState,
        fastingHours: prep.fastingHours,
        collectionWindow: prep.collectionWindow,
        instructions: prep.instructions
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function quoteStudies(ids: readonly string[], catalog: readonly CatalogStudy[], deps: WebQuoteDeps) {
  const unique = [...new Set(ids)];
  const studies = unique.map((id) => catalog.find((item) => item.id === id && item.active));
  if (studies.some((item) => item === undefined || !validPrice(item))) return undefined;
  const found = studies as CatalogStudy[];
  return {
    studies: found.map(publicStudy),
    totalBs: roundBs(found.reduce((sum, item) => sum + item.priceBs, 0)),
    totalLabel: TOTAL_LABEL,
    preparations: await preparationsFor(unique, catalog, deps)
  };
}

export async function handleWebQuote(request: Request, route: WebRoute, deps: WebQuoteDeps): Promise<Response> {
  const { config } = deps;
  if (!config) return json(503, { ok: false, error: "not_configured" });
  const expected = route === "catalog" ? "GET" : "POST";
  if (request.method !== expected) return json(405, { ok: false, error: "method_not_allowed" }, { allow: expected });

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { ok: false, error: "invalid_request" });
  }
  const proto = (request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim().toLowerCase();
  if (proto !== "https" && !isLocalHost(url.hostname)) return json(403, { ok: false, error: "https_required" });
  // Solo servidor a servidor: una petición de navegador nunca debe llevar el token.
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return json(403, { ok: false, error: "browser_not_allowed" });
  const provided = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!provided || !tokenMatches(provided, config.token)) return json(401, { ok: false, error: "unauthorized" });

  try {
    if (route === "catalog") {
      const catalog = (await deps.loadCatalog()).filter((item) => item.active && validPrice(item));
      return json(200, { ok: true, studies: catalog.map(publicStudy) });
    }

    {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return json(415, { ok: false, error: "unsupported_media_type" });
      const raw = await request.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) return json(413, { ok: false, error: "payload_too_large" });
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { ok: false, error: "invalid_request" });
      }
      const ids = (body as { studyIds?: unknown } | null)?.studyIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_WEB_QUOTE_STUDIES || !ids.every((id) => typeof id === "string" && UUID.test(id))) {
        return json(400, { ok: false, error: "invalid_request" });
      }
      const quote = await quoteStudies(ids as string[], await deps.loadCatalog(), deps);
      // Un estudio retirado o con precio inválido bloquea toda la cotización: la web debe refrescar el catálogo.
      if (!quote) return json(409, { ok: false, error: "study_unavailable" });
      return json(200, { ok: true, ...quote });
    }
  } catch (error) {
    // Solo al registro del servidor (nunca a la respuesta). Los mensajes de los repositorios no incluyen claves; se acotan por si acaso.
    deps.log("web_quote_failed", { route, error: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.slice(0, 300) : undefined });
    return json(500, { ok: false, error: "internal_error" });
  }
}
