import { createHash, timingSafeEqual } from "node:crypto";
import { AuditWriteError, createSupabaseRpc, type SupabaseRpcOptions } from "./audit.js";
import { contactKeyOf, createAttentionRepository, MIN_CONTACT_HMAC_KEY_LENGTH, type AttentionRepository, type AttentionState } from "./human-control.js";

// Control de atención desde el CRM (Fase 1 de la integración con CRM-PLUSMEDIK). Implementa, del lado del agente, el contrato CRM-PLUSMEDIK/docs/AGENT_ATTENTION_CONTROL_CONTRACT.md:
//   POST /api/internal/crm/attention/status   {contactPhone, phoneNumberId}                                                    -> estado REAL del agente (ACTIVE | HUMAN_PAUSED) y su revisión
//   POST /api/internal/crm/attention/action   {operationId, action: pause|resume, contactPhone, phoneNumberId, reasonCode, actor} -> pausa/reactivación manual idempotente
// APAGADO por defecto: sin PLUSMEDIK_AGENT_CONTROL=on y un token exclusivo válido, las rutas responden 503 sin tocar la base. Aunque esté encendido, si el control no está operativo (falta la clave
// HMAC de contactos, o no hay ni PLUSMEDIK_HUMAN_CONTROL ni una lista de contactos autorizados) NO se muta nada: status responde available:false y action no confirma. El agente es la única fuente de
// verdad del estado; nunca se inventa uno.
//
// Dos formas de operar el control, independientes de la pausa automática por mensajes humanos de WhatsApp Business (esa sigue siendo SOLO de PLUSMEDIK_HUMAN_CONTROL):
//   - Con PLUSMEDIK_HUMAN_CONTROL=on (como en la Fase 1): el control opera sobre todos los contactos.
//   - Acotado: con PLUSMEDIK_AGENT_CONTROL_PHONES (lista explícita) y SIN PLUSMEDIK_HUMAN_CONTROL: solo esos números pueden consultarse, pausarse y reactivarse; para ellos (y solo para ellos) el webhook
//     reclama cada mensaje con su clave de contacto y comprueba la pausa antes de enviar. Los demás contactos conservan EXACTAMENTE el flujo anterior (sin clave, sin pausa, sin exigir la auditoría).
//     Cualquier número fuera de la lista recibe 403 antes de tocar la base. Una lista mal formada deja las rutas en 503 (falla cerrado). PLUSMEDIK_AGENT_CONTROL_PHONES no sustituye a ALLOWED_PHONES.
//
//   PLUSMEDIK_AGENT_CONTROL=on           habilita las rutas
//   PLUSMEDIK_AGENT_CONTROL_TOKEN        token Bearer EXCLUSIVO CRM -> agente (≥ 32 caracteres; no es la service key, ni la clave HMAC, ni una credencial de Kapso). Es el mismo valor que el CRM
//                                        tiene en su variable del mismo nombre
//   KAPSO_PHONE_NUMBER_ID                número de WhatsApp del laboratorio: el phoneNumberId que envía el CRM debe coincidir
//   PLUSMEDIK_CONTACT_HMAC_KEY           la misma clave dedicada del control de atención (el contact_key se calcula AQUÍ; ni la clave ni el hash salen en ninguna respuesta)
//   PLUSMEDIK_HUMAN_CONTROL              (opcional) control sobre TODOS los contactos; activa además la pausa automática por mensajes humanos y el claim obligatorio
//   PLUSMEDIK_AGENT_CONTROL_PHONES       (opcional) lista explícita de números autorizados, separados por coma, solo dígitos con prefijo de país (máx. 10)
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
  // Se puede identificar a los contactos (clave HMAC válida) Y el control está habilitado: PLUSMEDIK_HUMAN_CONTROL o una lista explícita de contactos. Si no, no se muta nada.
  controlReady: boolean;
  hmacKey: string | undefined;
  // PLUSMEDIK_HUMAN_CONTROL activo: el webhook ya reclama TODOS los mensajes con la clave de contacto (no hace falta el modo acotado).
  humanControl: boolean;
  // Lista explícita de contactos autorizados (solo dígitos). undefined = sin lista: con PLUSMEDIK_HUMAN_CONTROL el control opera sobre todos los contactos.
  scope: ReadonlySet<string> | undefined;
}
export type CrmControlConfigError = "MISSING_TOKEN" | "INVALID_TOKEN" | "MISSING_PHONE_NUMBER_ID" | "INVALID_SCOPE";
export type CrmAttentionResolution = { enabled: false } | { enabled: true; config: CrmControlConfig } | { enabled: true; error: CrmControlConfigError };

export const MIN_TOKEN_LENGTH = 32;
export const MAX_SCOPED_PHONES = 10;

const SCOPED_PHONE = /^\+?[0-9]{8,15}$/;
const digitsOf = (value: string) => value.replace(/\D/g, "");

// PLUSMEDIK_AGENT_CONTROL_PHONES: "unset" (vacía o ausente) | lista válida | inválida. Cualquier entrada mal formada invalida TODA la lista (nunca se adivina a quién se autoriza).
export type ScopedPhones = { kind: "unset" } | { kind: "list"; phones: ReadonlySet<string> } | { kind: "invalid" };
export function parseScopedPhones(raw: string | undefined): ScopedPhones {
  if (raw === undefined || raw.trim() === "") return { kind: "unset" };
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.length > MAX_SCOPED_PHONES || entries.some((entry) => !SCOPED_PHONE.test(entry))) return { kind: "invalid" };
  return { kind: "list", phones: new Set(entries.map(digitsOf)) };
}

export function resolveCrmAttention(env: Record<string, string | undefined>): CrmAttentionResolution {
  if (env.PLUSMEDIK_AGENT_CONTROL?.trim().toLowerCase() !== "on") return { enabled: false };
  const token = env.PLUSMEDIK_AGENT_CONTROL_TOKEN;
  if (!token) return { enabled: true, error: "MISSING_TOKEN" };
  if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) return { enabled: true, error: "INVALID_TOKEN" };
  const labPhoneNumberId = env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!labPhoneNumberId) return { enabled: true, error: "MISSING_PHONE_NUMBER_ID" };
  const scoped = parseScopedPhones(env.PLUSMEDIK_AGENT_CONTROL_PHONES);
  if (scoped.kind === "invalid") return { enabled: true, error: "INVALID_SCOPE" };
  const hmacKey = env.PLUSMEDIK_CONTACT_HMAC_KEY;
  const humanControl = env.PLUSMEDIK_HUMAN_CONTROL?.trim().toLowerCase() === "on";
  const hmacReady = typeof hmacKey === "string" && hmacKey.length >= MIN_CONTACT_HMAC_KEY_LENGTH;
  return { enabled: true, config: { token, labPhoneNumberId, hmacKey, humanControl, scope: scoped.kind === "list" ? scoped.phones : undefined, controlReady: hmacReady && (humanControl || scoped.kind === "list") } };
}

// Modo acotado del webhook: contactos para los que el webhook debe reclamar el mensaje con su clave y comprobar la pausa aunque PLUSMEDIK_HUMAN_CONTROL esté apagado. Solo existe si el control del CRM está
// operativo, hay lista explícita y no hay control humano global (con él ya se cubre a todos). Para cualquier otra combinación devuelve undefined: el webhook no cambia en nada.
export function resolveScopedContactControl(env: Record<string, string | undefined>): { covers(phone: string): boolean } | undefined {
  const resolution = resolveCrmAttention(env);
  if (!resolution.enabled || !("config" in resolution)) return undefined;
  const { config } = resolution;
  if (!config.controlReady || config.humanControl || !config.scope) return undefined;
  const scope = config.scope;
  return { covers: (phone) => scope.has(digitsOf(phone)) };
}

// ───────────────────────────── manejador HTTP ─────────────────────────────

export interface CrmAttentionDeps {
  // undefined = funcionalidad apagada o mal configurada.
  config: CrmControlConfig | undefined;
  // Se pide al primer uso real (así una base sin configurar no rompe al cargar el módulo).
  repository(): CrmAttentionRepository;
  // Memoria estructurada en SOMBRA (PLUSMEDIK_LLM_CONVERSATION=on): anota que una persona reanudó al agente. Se carga solo si la bandera está encendida (apagada, esta ruta no importa nada nuevo). Mejor esfuerzo:
  // nunca cambia la respuesta al CRM ni el estado de atención.
  convState?: () => Promise<{ humanResume(input: { contactKey: string; operationId: string }): void; flush(timeoutMs?: number): Promise<void> } | undefined>;
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
  // Node.js fetch (undici) también envía Sec-Fetch-Mode: cors desde el servidor.
  // Origin o Sec-Fetch-Site identifican solicitudes de navegador; nunca usar Sec-Fetch-Mode por sí solo.
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return json(403, { ok: false, error: "browser_not_allowed" });

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

  // Contacto fuera de la lista explícita: se rechaza antes de calcular su clave y de tocar la base (no se revela ningún estado).
  if (config.scope && !config.scope.has(digitsOf(phone))) {
    deps.log("crm_attention", { route, outcome: "CONTACT_NOT_AUTHORIZED" });
    return json(403, { ok: false, ...(route === "action" ? { confirmed: false } : { available: false }), error: "contact_not_authorized" });
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
    // Reanudación manual confirmada: la memoria en sombra reabre lo que esperaba por la pausa. Acotado (el CRM aborta a los 5 s) y sin efecto sobre la respuesta.
    if (action === "resume" && deps.convState) {
      try {
        const recorder = await deps.convState();
        recorder?.humanResume({ contactKey, operationId });
        await recorder?.flush(1200);
      } catch {
        // la sombra nunca cambia lo que se le responde al CRM
      }
    }
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
  let recorder: Awaited<ReturnType<NonNullable<CrmAttentionDeps["convState"]>>> | undefined;
  const shadow = env.PLUSMEDIK_LLM_CONVERSATION?.trim().toLowerCase() === "on";
  const deps: CrmAttentionDeps = {
    config,
    ...(shadow ? { convState: async () => (recorder ??= (await import("./conversation-state-store.js")).resolveConversationState(env, log, {})) } : {}),
    // Plazos cortos: el CRM aborta a los 5 s y no reintenta; la RPC repite una vez con el mismo cuerpo (es idempotente por operationId).
    repository: () => (repository ??= createCrmAttentionRepository({ requestTimeoutMs: 2000, retryDelayMs: 200 })),
    log
  };
  return (request) => handleCrmAttention(request, route, deps);
}
