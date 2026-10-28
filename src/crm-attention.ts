import { createHash, timingSafeEqual } from "node:crypto";
import { AuditWriteError, createSupabaseRpc, type SupabaseRpcOptions } from "./audit.js";
import { contactKeyOf, createAttentionRepository, MIN_CONTACT_HMAC_KEY_LENGTH, type AttentionRepository, type AttentionState } from "./human-control.js";

// Control de atención desde el CRM (Fase 1 de la integración con CRM-PLUSMEDIK). Implementa, del lado del agente, el contrato CRM-PLUSMEDIK/docs/AGENT_ATTENTION_CONTROL_CONTRACT.md:
//   POST /api/internal/crm/attention/status   {contactPhone, phoneNumberId}                                                    -> estado REAL del agente (ACTIVE | HUMAN_PAUSED) y su revisión
//   POST /api/internal/crm/attention/action   {operationId, action: pause|resume, contactPhone, phoneNumberId, reasonCode, actor} -> pausa/reactivación manual idempotente
// APAGADO por defecto: sin PLUSMEDIK_AGENT_CONTROL=on y un token exclusivo válido, las rutas responden 503 sin tocar la base. Aunque esté encendido, mientras PLUSMEDIK_HUMAN_CONTROL no esté
// activo (o falte la clave HMAC de contactos) NO se muta nada: status responde available:false y action no confirma. El agente es la única fuente de verdad del estado; nunca se inventa uno.
//
//   PLUSMEDIK_AGENT_CONTROL=on           habilita las rutas
//   PLUSMEDIK_AGENT_CONTROL_TOKEN        token Bearer EXCLUSIVO CRM -> agente (≥ 32 caracteres; no es la service key, ni la clave HMAC, ni una credencial de Kapso). Es el mismo valor que el CRM
//                                        tiene en su variable del mismo nombre
//   KAPSO_PHONE_NUMBER_ID                número de WhatsApp del laboratorio: el phoneNumberId que envía el CRM debe coincidir
//   PLUSMEDIK_HUMAN_CONTROL, PLUSMEDIK_CONTACT_HMAC_KEY   las mismas del control de atención (el contact_key se calcula AQUÍ; ni la clave ni el hash salen en ninguna respuesta)
// No se guarda ni se registra el teléfono, el contact_key ni el token: solo códigos.

export type CrmAttentionAction = "pause" | "resume";
export type CrmActionOutcome = "PAUSED" | "ALREADY_PAUSED" | "RESUMED" | "ALREADY_ACTIVE";

export interface CrmActionResult {
  outcome: CrmActionOutcome;
  state: AttentionState;
  revision: number;
  // true: el resultado ya estaba confirmado por una llamada anterior con el mismo operationId (no se agregó ningún evento).
  replayed: boolean;
}

export interface CrmAttentionRepository {
  status(contactKey: string): ReturnType<AttentionRepository["status"]>;
  act(input: { operationId: string; action: CrmAttentionAction; contactKey: string; reasonCode: string; actor: string }): Promise<CrmActionResult>;
}

const REASON_FOR: Record<CrmAttentionAction, string> = { pause: "CRM_MANUAL_PAUSE", resume: "CRM_MANUAL_RESUME" };
const OUTCOMES: Record<CrmAttentionAction, readonly CrmActionOutcome[]> = { pause: ["PAUSED", "ALREADY_PAUSED"], resume: ["RESUMED", "ALREADY_ACTIVE"] };
const STATE_FOR: Record<CrmAttentionAction, AttentionState> = { pause: "HUMAN_PAUSED", resume: "ACTIVE" };

export function createCrmAttentionRepository(options: SupabaseRpcOptions = {}): CrmAttentionRepository {
  const rpc = createSupabaseRpc(options);
  const attention = createAttentionRepository(options);
  return {
    status: (contactKey) => attention.status(contactKey),
    async act(input) {
      const result = await rpc("plusmedik_attention_crm_action", { p_operation_id: input.operationId, p_action: input.action, p_contact_key: input.contactKey, p_reason: input.reasonCode, p_actor: input.actor });
      const outcome = result.outcome as CrmActionOutcome;
      // Una respuesta inesperada NUNCA se interpreta como confirmada: se trata como fallo.
      if (!OUTCOMES[input.action].includes(outcome) || result.state !== STATE_FOR[input.action] || typeof result.revision !== "number" || !Number.isInteger(result.revision) || result.revision < 0 || typeof result.replayed !== "boolean") {
        throw new AuditWriteError("REJECTED");
      }
      return { outcome, state: STATE_FOR[input.action], revision: result.revision, replayed: result.replayed };
    }
  };
}

// ───────────────────────────── configuración ─────────────────────────────

export interface CrmControlConfig {
  token: string;
  labPhoneNumberId: string;
  // El control de atención humana está encendido Y se puede identificar a los contactos (clave HMAC válida). Si no, no se muta nada.
  controlReady: boolean;
  hmacKey: string | undefined;
}
export type CrmControlConfigError = "MISSING_TOKEN" | "INVALID_TOKEN" | "MISSING_PHONE_NUMBER_ID";
export type CrmAttentionResolution = { enabled: false } | { enabled: true; config: CrmControlConfig } | { enabled: true; error: CrmControlConfigError };

export const MIN_TOKEN_LENGTH = 32;

export function resolveCrmAttention(env: Record<string, string | undefined>): CrmAttentionResolution {
  if (env.PLUSMEDIK_AGENT_CONTROL?.trim().toLowerCase() !== "on") return { enabled: false };
  const token = env.PLUSMEDIK_AGENT_CONTROL_TOKEN;
  if (!token) return { enabled: true, error: "MISSING_TOKEN" };
  if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) return { enabled: true, error: "INVALID_TOKEN" };
  const labPhoneNumberId = env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!labPhoneNumberId) return { enabled: true, error: "MISSING_PHONE_NUMBER_ID" };
  const hmacKey = env.PLUSMEDIK_CONTACT_HMAC_KEY;
  const humanControl = env.PLUSMEDIK_HUMAN_CONTROL?.trim().toLowerCase() === "on";
  return { enabled: true, config: { token, labPhoneNumberId, hmacKey, controlReady: humanControl && typeof hmacKey === "string" && hmacKey.length >= MIN_CONTACT_HMAC_KEY_LENGTH } };
}

// ───────────────────────────── manejador HTTP ─────────────────────────────

export interface CrmAttentionDeps {
  // undefined = funcionalidad apagada o mal configurada.
  config: CrmControlConfig | undefined;
  // Se pide al primer uso real (así una base sin configurar no rompe al cargar el módulo).
  repository(): CrmAttentionRepository;
  log(event: string, data: Record<string, unknown>): void;
}

const MAX_BODY_BYTES = 2048;
const PHONE = /^\+?[0-9]{8,15}$/;
const OPERATION_ID = /^[A-Za-z0-9_.:-]{8,120}$/;
const ACTOR = /^crm:[A-Za-z0-9_-]{1,59}$/;
const STATUS_KEYS = ["contactPhone", "phoneNumberId"];
const ACTION_KEYS = ["action", "actor", "contactPhone", "operationId", "phoneNumberId", "reasonCode"];

const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
function tokenMatches(provided: string, expected: string): boolean {
  // Se comparan los hashes (misma longitud siempre): no se filtra la longitud del token ni hay comparación de cadenas variable.
  return timingSafeEqual(digest(provided), digest(expected));
}
const isLocalHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
const sameKeys = (value: Record<string, unknown>, expected: string[]) => {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

export async function handleCrmAttention(request: Request, route: "status" | "action", deps: CrmAttentionDeps): Promise<Response> {
  const { config } = deps;
  // Apagado o mal configurado: ni se mira la petición ni se toca la base.
  if (!config) return json(503, { ok: false, available: false, error: "not_configured" });
  if (request.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return json(400, { ok: false, error: "invalid_request" });
  }
  const proto = (request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim().toLowerCase();
  if (proto !== "https" && !isLocalHost(url.hostname)) return json(403, { ok: false, error: "https_required" });
  // Solo servidor a servidor: un navegador envía Origin / Sec-Fetch-*.
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site") || request.headers.has("sec-fetch-mode")) return json(403, { ok: false, error: "browser_not_allowed" });

  const header = request.headers.get("authorization") ?? "";
  const provided = /^Bearer (\S+)$/i.exec(header)?.[1];
  if (!provided || !tokenMatches(provided, config.token)) return json(401, { ok: false, error: "unauthorized" });

  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return json(415, { ok: false, error: "unsupported_media_type" });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return json(413, { ok: false, error: "payload_too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "invalid_request" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json(400, { ok: false, error: "invalid_request" });
  const input = body as Record<string, unknown>;

  // Forma exacta: el contrato no envía nada más (en particular, ningún texto de motivo) y aquí no se acepta.
  if (!sameKeys(input, route === "status" ? STATUS_KEYS : ACTION_KEYS)) return json(400, { ok: false, error: "invalid_request" });
  const phone = input.contactPhone;
  const phoneNumberId = input.phoneNumberId;
  if (typeof phone !== "string" || !PHONE.test(phone) || typeof phoneNumberId !== "string" || phoneNumberId.length < 1 || phoneNumberId.length > 64) return json(400, { ok: false, error: "invalid_request" });
  if (phoneNumberId !== config.labPhoneNumberId) return json(403, { ok: false, error: "phone_number_mismatch" });

  let action: CrmAttentionAction | undefined;
  let operationId = "";
  let actor = "";
  if (route === "action") {
    action = input.action === "pause" || input.action === "resume" ? input.action : undefined;
    operationId = typeof input.operationId === "string" ? input.operationId : "";
    actor = typeof input.actor === "string" ? input.actor : "";
    if (!action || !OPERATION_ID.test(operationId) || !ACTOR.test(actor) || input.reasonCode !== REASON_FOR[action]) return json(400, { ok: false, error: "invalid_request" });
  }

  // Control de atención no operativo: no se muta ni se inventa un estado.
  if (!config.controlReady) {
    deps.log("crm_attention", { route, outcome: "CONTROL_DISABLED" });
    return route === "status"
      ? json(200, { ok: true, available: false, reason: "control_disabled" })
      : json(200, { ok: true, available: false, confirmed: false, reason: "control_disabled" });
  }
  const contactKey = contactKeyOf({ hmacKey: config.hmacKey, labPhoneNumberId: config.labPhoneNumberId, contactPhone: phone });
  if (!contactKey) return json(400, { ok: false, error: "invalid_request" });

  try {
    const repository = deps.repository();
    if (route === "status") {
      const status = await repository.status(contactKey);
      deps.log("crm_attention", { route, state: status.state });
      return json(200, { ok: true, available: true, state: status.state, revision: status.revision });
    }
    const result = await repository.act({ operationId, action: action!, contactKey, reasonCode: REASON_FOR[action!], actor });
    deps.log("crm_attention", { route, action, outcome: result.outcome, replayed: result.replayed });
    return json(200, { ok: true, confirmed: true, state: result.state, revision: result.revision, outcome: result.outcome, replayed: result.replayed });
  } catch (error) {
    // Nunca el texto del error ni datos del contacto. Una confirmación incierta jamás devuelve confirmed:true.
    const kind = error instanceof AuditWriteError ? error.kind : "UNAVAILABLE";
    deps.log("crm_attention", { route, ...(action ? { action } : {}), error: kind });
    if (kind === "CONFLICT") return json(409, { ok: false, confirmed: false, error: "operation_conflict" });
    return route === "status" ? json(503, { ok: false, available: false, error: "unavailable" }) : json(503, { ok: false, confirmed: false, error: "unavailable" });
  }
}

// Cableado para las funciones de Vercel: lee el entorno una vez al cargar el módulo y arma el repositorio al primer uso.
export function createCrmAttentionRoute(route: "status" | "action", env: Record<string, string | undefined> = process.env): (request: Request) => Promise<Response> {
  const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ app: "plusmedik", event, ...data }));
  const resolution = resolveCrmAttention(env);
  if (resolution.enabled && "error" in resolution) log("crm_attention_config_invalid", { error: resolution.error });
  const config = resolution.enabled && "config" in resolution ? resolution.config : undefined;
  let repository: CrmAttentionRepository | undefined;
  const deps: CrmAttentionDeps = {
    config,
    // Plazos cortos: el CRM aborta a los 5 s y no reintenta; la RPC repite una vez con el mismo cuerpo (es idempotente por operationId).
    repository: () => (repository ??= createCrmAttentionRepository({ requestTimeoutMs: 2000, retryDelayMs: 200 })),
    log
  };
  return (request) => handleCrmAttention(request, route, deps);
}
