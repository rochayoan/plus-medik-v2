import { createSupabaseKnowledgeStore, KnowledgeService } from "./knowledge/index.js";
import { loadActiveCatalog } from "./supabase-catalog.js";
import { handleWebQuote, resolveWebQuoteConfig, type WebRoute } from "./web-quote.js";

// Cableado de producción de las rutas /api/web/*.
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ app: "plusmedik", event, ...data }));

let knowledge: KnowledgeService | undefined;
const knowledgeReader = () => (knowledge ??= new KnowledgeService({
  store: createSupabaseKnowledgeStore({ requestTimeoutMs: 3000, retryDelayMs: 200 }),
  // Preparación clínica: verificar vigencia en cada lectura, sin reutilizar instantáneas ante fallos.
  revisionCheckMs: 0,
  maxStaleMs: 0
}));

export function createWebQuoteRoute(route: WebRoute) {
  return (request: Request): Promise<Response> => handleWebQuote(request, route, {
    config: resolveWebQuoteConfig(process.env),
    loadCatalog: () => loadActiveCatalog(),
    knowledge: knowledgeReader(),
    log
  });
}
