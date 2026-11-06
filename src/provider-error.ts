// Causa de un fallo de un proveedor externo (OpenAI y similares) o de una petición HTTP, descrita SOLO con códigos de una lista blanca para el registro de Vercel.
//
// Por qué existe: un HTTP 429 de OpenAI puede ser «te quedaste sin cuota / saldo / tope de gasto» (code `insufficient_quota`) o «vas demasiado rápido» (code `rate_limit_exceeded`); el SDK los
// entrega con el mismo `status`. Hasta ahora solo se registraba «RATE_LIMITED» y no se podía saber cuál de los dos era (incidente del 4-nov-2026: ~5 h sin modelo).
//
// Qué NUNCA sale de aquí: el mensaje del error, el cuerpo de la respuesta, la petición, claves, URLs ni ninguna cabecera que no esté en la lista de abajo. Cada valor se valida con un patrón
// estricto; un valor que no lo cumple se descarta (no se recorta ni se copia). Nada de lo que escribe el paciente puede llegar a estos campos.

export type ProviderCause = "QUOTA_OR_BILLING" | "RATE_LIMIT" | "RATE_LIMIT_OR_QUOTA_UNKNOWN" | "TIMEOUT" | "CONNECTION" | "AUTH" | "NOT_FOUND" | "BAD_REQUEST" | "SERVER" | "UNKNOWN";

export type ProviderErrorInfo = {
  cause: ProviderCause;
  httpStatus?: number;
  // `error.code` / `error.type` del proveedor (p. ej. insufficient_quota, rate_limit_exceeded): códigos cortos, nunca el mensaje.
  errorCode?: string;
  errorType?: string;
  // Nombre de la clase del error (APIConnectionTimeoutError, TimeoutError…).
  errorName?: string;
  // Segundos que pide esperar el proveedor.
  retryAfterS?: number;
  // Identificador de la petición en el proveedor (sirve para reclamar al soporte; no contiene datos del paciente).
  requestId?: string;
  // Límites vigentes devueltos por el proveedor (x-ratelimit-*): números o duraciones cortas como «6m0s».
  rl?: Partial<Record<"limitRequests" | "remainingRequests" | "resetRequests" | "limitTokens" | "remainingTokens" | "resetTokens", string>>;
};

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NAME = /^[A-Za-z][A-Za-z0-9]{2,47}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const LIMIT_VALUE = /^[0-9][0-9a-z.]{0,15}$/;
// Códigos/tipos que significan «cuenta sin crédito o con tope alcanzado», no «demasiado rápido».
const QUOTA = /quota|billing|credit|spend|budget|hard_limit|payment/i;
const RATE = /rate_limit|requests|tokens|too_many|throttl/i;

const clean = (value: unknown, pattern: RegExp): string | undefined => (typeof value === "string" && pattern.test(value) ? value : undefined);
const integer = (value: unknown, min: number, max: number): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,7}$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

type HeaderReader = (name: string) => string | undefined;

function headerReader(headers: unknown): HeaderReader {
  if (typeof headers !== "object" || headers === null) return () => undefined;
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") return (name) => { const value = (maybeGet as (key: string) => unknown).call(headers, name); return typeof value === "string" ? value : undefined; };
  const record = headers as Record<string, unknown>;
  const lower = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value] as const));
  return (name) => { const value = lower.get(name.toLowerCase()); return typeof value === "string" ? value : undefined; };
}

function causeOf(status: number | undefined, code: string | undefined, type: string | undefined, name: string | undefined, networkCode: string | undefined): ProviderCause {
  if (status === 429) {
    if ((code && QUOTA.test(code)) || (type && QUOTA.test(type))) return "QUOTA_OR_BILLING";
    if ((code && RATE.test(code)) || (type && RATE.test(type))) return "RATE_LIMIT";
    return "RATE_LIMIT_OR_QUOTA_UNKNOWN";
  }
  if (status === 401 || status === 403) return "AUTH";
  if (status === 404) return "NOT_FOUND";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status !== undefined && status >= 500) return "SERVER";
  if (status !== undefined && status >= 400) return "BAD_REQUEST";
  if ((name && /timeout|abort/i.test(name)) || networkCode === "ETIMEDOUT" || networkCode === "UND_ERR_CONNECT_TIMEOUT") return "TIMEOUT";
  if ((name && /connection/i.test(name)) || (networkCode && /^(ECONN|ENOTFOUND|EAI_AGAIN|EPIPE)/.test(networkCode))) return "CONNECTION";
  return "UNKNOWN";
}

function limitsOf(read: HeaderReader): ProviderErrorInfo["rl"] {
  const entries: Array<[keyof NonNullable<ProviderErrorInfo["rl"]>, string]> = [
    ["limitRequests", "x-ratelimit-limit-requests"], ["remainingRequests", "x-ratelimit-remaining-requests"], ["resetRequests", "x-ratelimit-reset-requests"],
    ["limitTokens", "x-ratelimit-limit-tokens"], ["remainingTokens", "x-ratelimit-remaining-tokens"], ["resetTokens", "x-ratelimit-reset-tokens"]
  ];
  const out: NonNullable<ProviderErrorInfo["rl"]> = {};
  for (const [key, header] of entries) { const value = clean(read(header), LIMIT_VALUE); if (value) out[key] = value; }
  return Object.keys(out).length > 0 ? out : undefined;
}

function retryAfterOf(read: HeaderReader): number | undefined {
  const seconds = integer(read("retry-after"), 0, 86_400);
  if (seconds !== undefined) return seconds;
  const ms = integer(read("retry-after-ms"), 0, 86_400_000);
  return ms === undefined ? undefined : Math.ceil(ms / 1000);
}

// Para un error lanzado por el SDK de OpenAI (APIError: status, code, type, headers, requestID) o cualquier otro error. Nunca lanza.
export function describeProviderError(error: unknown): ProviderErrorInfo {
  try {
    if (typeof error !== "object" || error === null) return { cause: "UNKNOWN" };
    const record = error as Record<string, unknown>;
    const httpStatus = integer(record.status, 100, 599);
    const errorCode = clean(record.code, CODE);
    const errorType = clean(record.type, CODE);
    // El SDK de OpenAI deja `name = "Error"` en sus errores de conexión y de tiempo agotado: el nombre útil (APIConnectionTimeoutError, APIConnectionError…) está en la clase.
    const className = clean((error as { constructor?: { name?: unknown } }).constructor?.name, NAME);
    const ownName = clean(record.name, NAME);
    const errorName = ownName && ownName !== "Error" ? ownName : className && className !== "Error" ? className : ownName;
    const read = headerReader(record.headers);
    const requestId = clean(record.requestID, REQUEST_ID) ?? clean(read("x-request-id"), REQUEST_ID);
    const retryAfterS = retryAfterOf(read);
    const rl = limitsOf(read);
    // El `code` de un error de red de Node (ECONNRESET…) es texto en mayúsculas: sirve para la causa, pero solo sale si es un código de red conocido.
    const networkCode = clean(record.code, /^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED)$/);
    return {
      cause: causeOf(httpStatus, errorCode, errorType, errorName, networkCode),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorType ? { errorType } : {}),
      ...(errorName ? { errorName } : {}),
      ...(retryAfterS !== undefined ? { retryAfterS } : {}),
      ...(requestId ? { requestId } : {}),
      ...(rl ? { rl } : {})
    };
  } catch {
    return { cause: "UNKNOWN" };
  }
}

// Para una respuesta HTTP que NO viene de un SDK (transcripción de audio por fetch): estado, cabeceras y, si se pasa, el cuerpo en texto. Del cuerpo solo se extrae `error.code`/`error.type`
// con el patrón estricto; el resto se descarta.
export function describeHttpFailure(input: { status: number; header?: (name: string) => string | null | undefined; bodyText?: string }): ProviderErrorInfo {
  try {
    const read: HeaderReader = (name) => { const value = input.header?.(name); return typeof value === "string" ? value : undefined; };
    let errorCode: string | undefined;
    let errorType: string | undefined;
    if (typeof input.bodyText === "string" && input.bodyText.length > 0) {
      try {
        const parsed = JSON.parse(input.bodyText.slice(0, 4096)) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
        errorCode = clean(parsed?.error?.code, CODE) ?? clean(parsed?.code, CODE);
        errorType = clean(parsed?.error?.type, CODE);
      } catch {
        // cuerpo que no es JSON completo: no se usa
      }
    }
    const httpStatus = integer(input.status, 100, 599);
    const requestId = clean(read("x-request-id"), REQUEST_ID);
    const retryAfterS = retryAfterOf(read);
    const rl = limitsOf(read);
    return {
      cause: causeOf(httpStatus, errorCode, errorType, undefined, undefined),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorType ? { errorType } : {}),
      ...(retryAfterS !== undefined ? { retryAfterS } : {}),
      ...(requestId ? { requestId } : {}),
      ...(rl ? { rl } : {})
    };
  } catch {
    return { cause: "UNKNOWN" };
  }
}

// Resumen de las llamadas a modelos que fallaron en el análisis de UNA foto (los eventos ya existen en memoria; esto es solo para el registro). Máximo 6.
export interface FailedCallLike { label: string; provider: string; model: string; outcome: string; errorKind?: string; failure?: ProviderErrorInfo }
export function summarizeAiFailures(events: readonly FailedCallLike[]): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.outcome === "FAILED")
    .slice(0, 6)
    .map((event) => ({
      stage: clean(event.label, /^[A-Za-z0-9_.:-]{1,48}$/) ?? "?",
      provider: clean(event.provider, /^[A-Za-z0-9_.-]{1,32}$/) ?? "?",
      model: clean(event.model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/) ?? "?",
      ...(event.errorKind ? { errorKind: clean(event.errorKind, /^[A-Z_]{1,24}$/) } : {}),
      ...(event.failure ? { ...event.failure } : {})
    }));
}
