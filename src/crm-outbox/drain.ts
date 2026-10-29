import { timingSafeEqual } from "node:crypto";
import type { DrainSummary } from "./service.js";

// Ruta protegida que reintenta lo pendiente de la cola hacia el CRM (la programaría un cron; hoy NO hay cron en este repositorio). Es INERTE: sin PLUSMEDIK_CRM_HANDOFF=on y sin
// CRON_SECRET responde 503 y no toca la base ni el CRM. Mismo patrón que la recuperación de la auditoría (src/audit-recovery.ts). Solo devuelve y registra contadores.

export interface DrainRequestDeps {
  // false = la derivación al CRM no está encendida/configurada.
  enabled: boolean;
  secret: string | undefined;
  drain: () => Promise<DrainSummary>;
  log(event: string, data: Record<string, unknown>): void;
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleDrainRequest(request: Request, deps: DrainRequestDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!deps.enabled || !deps.secret) return json(503, { ok: false, error: "not_configured" });
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!provided || !secretsMatch(provided, deps.secret)) return json(401, { ok: false, error: "unauthorized" });
  try {
    const summary = await deps.drain();
    return json(200, { ok: true, ...summary });
  } catch {
    // Nunca el texto del error: podría traer datos del evento.
    deps.log("crm_outbox", { event: "drain_failed" });
    return json(500, { ok: false, error: "drain_failed" });
  }
}
