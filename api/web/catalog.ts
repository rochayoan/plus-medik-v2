import { createWebQuoteRoute } from "../../src/web-quote-runtime.js";

// GET /api/web/catalog: API servidor a servidor para el cotizador web de los médicos (ver src/web-quote.ts). APAGADA por defecto: responde 503.
export const GET = createWebQuoteRoute("catalog");
