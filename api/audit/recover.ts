import { createSupabaseAuditRepository } from "../../src/audit.js";
import { handleRecoveryRequest } from "../../src/audit-recovery.js";

// GET|POST /api/audit/recover: recuperación periódica de procesamientos interrumpidos (ver src/audit-recovery.ts). Está INACTIVA: no hay cron programado y,
// sin CRON_SECRET, responde 503. Para activarla, ver "Recuperación automática" en el README.
export async function GET(request: Request): Promise<Response> {
  return handleRecoveryRequest(request, {
    repository: () => createSupabaseAuditRepository(),
    secret: process.env.CRON_SECRET,
    log: (event, data) => console.log(JSON.stringify({ app: "plusmedik", event, ...data }))
  });
}

export const POST = GET;
