// Receptor del CRM SIMULADO para pruebas: reproduce el comportamiento de CRM-PLUSMEDIK/src/app/api/internal/agent/review-case/route.ts + createAgentReviewCase (leído en solo lectura),
// incluidas sus respuestas: 503 apagado, 401 token, 200 ignorado, 400 inválido, 413 evidencia grande, 409 message_not_ingested, 200 creado / duplicado (por eventId y por mensaje original).
// No habla con ninguna red: se entrega como `fetchFn`. Todo dato es de PRUEBA.

export interface FakeCase {
  eventId: string;
  kapsoMessageId: string;
  contactPhone: string;
  phoneNumberId: string;
  recipeMediaId: string | null;
  failureReason: string;
  auditId: string | null;
  agentResult: unknown;
  detectedTests: unknown[];
}
export interface FakeCall {
  status: number;
  eventId?: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  bodyText: string;
}

const normalizePhone = (value: unknown): string => (typeof value === "string" ? value.replace(/\D/g, "") : "");
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

export class FakeCrm {
  enabled = true;
  readonly token: string;
  // Mensajes del paciente que el CRM ya ingirió (crm.messages): sin esto el receptor responde 409 message_not_ingested.
  ingested = new Map<string, { phone: string; phoneNumberId: string; mediaId: string | null }>();
  cases: FakeCase[] = [];
  calls: FakeCall[] = [];
  // Respuestas guionadas que se consumen antes de la lógica normal (p. ej. 503, 500, o lanzar un error de red).
  script: Array<{ status: number; body?: unknown } | "network" | "timeout"> = [];
  delayMs = 0;
  constructor(token = "crm-token-de-prueba-".padEnd(40, "x")) {
    this.token = token;
  }

  ingest(kapsoMessageId: string, phone: string, phoneNumberId: string, mediaId: string | null = null): void {
    this.ingested.set(kapsoMessageId, { phone: normalizePhone(phone), phoneNumberId, mediaId });
  }

  fetchFn: typeof fetch = (async (input: unknown, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })); }, { once: true });
      });
    }
    const scripted = this.script.shift();
    const bodyText = String(init?.body ?? "");
    const record = (status: number, eventId?: string) => this.calls.push({ status, eventId, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect, bodyText });
    if (scripted === "network") { record(0); throw new TypeError("fetch failed"); }
    if (scripted === "timeout") { record(0); throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }
    const reply = (status: number, body: unknown) => { record(status, safeEventId(bodyText)); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); };
    if (scripted) return reply(scripted.status, scripted.body ?? {});
    return this.handle(init, bodyText, reply);
  }) as typeof fetch;

  private handle(init: RequestInit | undefined, bodyText: string, reply: (status: number, body: unknown) => Response): Response {
    if (!this.enabled) return reply(503, { ok: false, available: false });
    const received = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (received.length !== this.token.length || received !== this.token) return reply(401, { ok: false, error: "Unauthorized" });
    let payload: Record<string, unknown> | null = null;
    try { payload = JSON.parse(bodyText) as Record<string, unknown>; } catch { payload = null; }
    if (payload?.requiresReview !== true) return reply(200, { ok: true, created: false, ignored: true });
    const eventId = text(payload.eventId, 120);
    const kapsoMessageId = text(payload.kapsoMessageId, 255);
    const contactPhone = normalizePhone(payload.contactPhone);
    const phoneNumberId = text(payload.phoneNumberId, 255);
    const failureReason = text(payload.failureReason, 1_000);
    const recipeMediaId = text(payload.recipeMediaId, 255) || null;
    const auditId = text(payload.auditId, 255) || null;
    const detectedTests = Array.isArray(payload.detectedTests) && payload.detectedTests.length <= 60 ? payload.detectedTests : null;
    const agentResult = payload.agentResult && typeof payload.agentResult === "object" ? payload.agentResult : null;
    const evidenceSize = JSON.stringify({ agentResult, detectedTests }).length;
    if (!eventId || !kapsoMessageId || contactPhone.length < 8 || !phoneNumberId || !failureReason || !detectedTests) return reply(400, { ok: false, error: "Invalid review event" });
    if (evidenceSize > 40_000) return reply(413, { ok: false, error: "Review evidence too large" });
    const message = this.ingested.get(kapsoMessageId);
    if (!message || message.phoneNumberId !== phoneNumberId || message.phone !== contactPhone || (recipeMediaId !== null && message.mediaId !== recipeMediaId)) return reply(409, { ok: false, code: "message_not_ingested" });
    if (this.cases.some((c) => c.eventId === eventId || c.kapsoMessageId === kapsoMessageId)) return reply(200, { ok: true, created: false, duplicate: true });
    this.cases.push({ eventId, kapsoMessageId, contactPhone, phoneNumberId, recipeMediaId, failureReason, auditId, agentResult, detectedTests });
    return reply(200, { ok: true, created: true, duplicate: false });
  }
}

function safeEventId(bodyText: string): string | undefined {
  try { return (JSON.parse(bodyText) as { eventId?: string }).eventId; } catch { return undefined; }
}
