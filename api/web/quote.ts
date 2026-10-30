import { createWebQuoteRoute } from "../../src/web-quote-runtime.js";

// POST /api/web/quote: API servidor a servidor para el cotizador web de los médicos (ver src/web-quote.ts). APAGADA por defecto: responde 503.
export const POST = createWebQuoteRoute("quote");
