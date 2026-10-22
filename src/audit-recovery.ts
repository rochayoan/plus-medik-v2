import { timingSafeEqual } from "node:crypto";
import { AuditWriteError, type AuditMaintenance } from "./audit.js";

// Recuperación periódica de procesamientos interrumpidos. Es INERTE hasta que alguien la programe (no hay cron configurado en este repositorio) y hasta que exista
// el secreto CRON_SECRET: sin él responde 503 y no toca la base. Con Vercel Cron, cada invocación llega como GET con "Authorization: Bearer <CRON_SECRET>".
//
// Qué hace: llama a plusmedik_audit_recover_stale, que cierra de forma segura lo interrumpido (SEND_OUTCOME_UNKNOWN / ABANDONED_BEFORE_SEND). NUNCA envía
// mensajes ni reintenta envíos inciertos, y no necesita teléfono ni imagen. Solo devuelve y registra contadores.

export interface RecoveryRequestDeps {
  repository: () => Pick<AuditMaintenance, "recoverStale">;
  secret: string | undefined;
  log(event: string, data: Record<string, unknown>): void;
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleRecoveryRequest(request: Request, deps: RecoveryRequestDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!deps.secret) return json(503, { ok: false, error: "not_configured" });
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!provided || !secretsMatch(provided, deps.secret)) return json(401, { ok: false, error: "unauthorized" });
  try {
    const summary = await deps.repository().recoverStale();
    deps.log("audit_recovery", { ...summary });
    return json(200, { ok: true, ...summary });
  } catch (error) {
    // Solo el código del fallo de escritura; nunca el texto del error.
    deps.log("audit_recovery_failed", error instanceof AuditWriteError ? { kind: error.kind } : {});
    return json(500, { ok: false, error: "recovery_failed" });
  }
}
