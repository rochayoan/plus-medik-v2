import type { CrmReviewPayload } from "./payload.js";

// Cliente del receptor del CRM: POST /api/internal/agent/review-case con Authorization Bearer. Traduce la respuesta a un código de resultado cerrado. NUNCA devuelve ni registra el cuerpo
// de la respuesta, el cuerpo enviado ni el token. No sigue redirecciones (reenviaría el token a otro destino). Solo HTTPS (salvo localhost, para desarrollo).

export type CrmResult = "CREATED" | "DUPLICATE" | "MESSAGE_NOT_INGESTED" | "CONFLICT_UNKNOWN" | "UNAUTHORIZED" | "UNAVAILABLE" | "INVALID" | "TOO_LARGE" | "IGNORED" | "SERVER_ERROR" | "TIMEOUT" | "NETWORK";

export interface CrmSendResult {
  result: CrmResult;
  httpStatus?: number;
  durationMs: number;
}

export interface CrmClient {
  send(payload: CrmReviewPayload): Promise<CrmSendResult>;
}

export class CrmConfigError extends Error {
  constructor(readonly code: "URL" | "TOKEN") {
    super(`crm_config_${code.toLowerCase()}`);
    this.name = "CrmConfigError";
  }
}

export interface CrmClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export const REVIEW_PATH = "/api/internal/agent/review-case";
export const MIN_TOKEN_LENGTH = 32;

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

// Traduce (estado HTTP, cuerpo ya leído) al código de resultado. Es una función pura y es el contrato del receptor:
//   200 {ok:true, created:true}              -> CREATED          200 {ok:true, created:false, duplicate:true} -> DUPLICATE
//   200 {ok:true, ignored:true}              -> IGNORED (no debería ocurrir: siempre se envía requiresReview=true)
//   409 {code:"message_not_ingested"}        -> MESSAGE_NOT_INGESTED (se reintenta: el CRM puede ingerir el mensaje después)
//   409 cualquier otra cosa                  -> CONFLICT_UNKNOWN (se reintenta, acotado)
//   400 -> INVALID (permanente)   413 -> TOO_LARGE (permanente)   401/403 -> UNAUTHORIZED (configuración)   404/405/429/503 -> UNAVAILABLE   5xx/3xx -> SERVER_ERROR
export function classifyResponse(status: number, body: unknown): CrmResult {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status === 200) {
    if (record.ok !== true) return "SERVER_ERROR";
    if (record.ignored === true) return "IGNORED";
    if (record.created === true) return "CREATED";
    if (record.created === false) return "DUPLICATE";
    return "SERVER_ERROR";
  }
  if (status === 409) return record.code === "message_not_ingested" ? "MESSAGE_NOT_INGESTED" : "CONFLICT_UNKNOWN";
  if (status === 400) return "INVALID";
  if (status === 413) return "TOO_LARGE";
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404 || status === 405 || status === 429 || status === 503) return "UNAVAILABLE";
  if (status >= 500 || (status >= 300 && status < 400)) return "SERVER_ERROR";
  return "INVALID";
}

export function createCrmReviewClient(options: CrmClientOptions): CrmClient {
  let url: URL;
  try {
    url = new URL(REVIEW_PATH, options.baseUrl);
  } catch {
    throw new CrmConfigError("URL");
  }
  if (!(url.protocol === "https:" || (url.protocol === "http:" && isLocal(url.hostname))) || url.username || url.password) throw new CrmConfigError("URL");
  if (typeof options.token !== "string" || options.token.length < MIN_TOKEN_LENGTH || /\s/.test(options.token)) throw new CrmConfigError("TOKEN");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? Date.now;

  return {
    async send(payload) {
      const started = now();
      const elapsed = () => Math.max(0, Math.min(600_000, now() - started));
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
          body: JSON.stringify(payload),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { result: timedOut ? "TIMEOUT" : "NETWORK", durationMs: elapsed() };
      }
      const body = await response.json().catch(() => null);
      return { result: classifyResponse(response.status, body), httpStatus: response.status, durationMs: elapsed() };
    }
  };
}
