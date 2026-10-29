import { createCrmAttentionRoute } from "../../../../src/crm-attention.js";

// POST /api/internal/crm/attention/action: pausa o reactivación manual de la IA pedida por el servidor del CRM (idempotente por operationId). APAGADA por defecto: responde 503 sin tocar nada.
const handler = createCrmAttentionRoute("action");

export const POST = handler;
export const GET = handler;
