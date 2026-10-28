import { resolveCrmOutbox } from "../../src/crm-outbox/config.js";
import { handleDrainRequest } from "../../src/crm-outbox/drain.js";

// GET|POST /api/outbox/drain: reintenta la cola de salida hacia el CRM (ver src/crm-outbox). Está INACTIVA: no hay cron programado y, sin PLUSMEDIK_CRM_HANDOFF=on completamente configurado
// y sin CRON_SECRET, responde 503 sin tocar nada. Para activarla, ver docs/g5.
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ app: "plusmedik", event, ...data }));
const outbox = resolveCrmOutbox(process.env, log);

export async function GET(request: Request): Promise<Response> {
  return handleDrainRequest(request, {
    enabled: outbox !== undefined,
    secret: process.env.CRON_SECRET,
    // Lote chico: la función tiene el plazo por defecto de la plataforma.
    drain: () => outbox!.drain({ limit: 10, concurrency: 5 }),
    log
  });
}

export const POST = GET;
