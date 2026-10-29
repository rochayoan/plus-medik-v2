import { createCrmAttentionRoute } from "../../../../src/crm-attention.js";

// POST /api/internal/crm/attention/status: estado real de atención de un contacto para el CRM (ver src/crm-attention.ts y el contrato del CRM). APAGADA por defecto: responde 503 sin tocar nada.
const handler = createCrmAttentionRoute("status");

export const POST = handler;
export const GET = handler;
