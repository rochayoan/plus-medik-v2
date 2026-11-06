// G7 · Sonda de límites de OpenAI — lógica pura (sin red por sí sola). Interpreta la respuesta de UNA petición mínima para distinguir cuota/facturación de límite de solicitudes.
// Nunca incluye datos de pacientes: la petición es «ping». Nunca devuelve la clave.

export type Diagnosis = "OK" | "CUOTA_O_FACTURACION" | "LIMITE_DE_SOLICITUDES_O_TOKENS" | "CLAVE_INVALIDA_O_SIN_PERMISO" | "MODELO_NO_DISPONIBLE" | "ERROR_DEL_PROVEEDOR" | "OTRO";

export interface ProbeInput { status: number; body: unknown; headers: Record<string, string | undefined>; ms: number }
export interface ProbeResult {
  diagnosis: Diagnosis;
  status: number;
  ms: number;
  errorType?: string;
  errorCode?: string;
  // Mensaje del proveedor, sin nada que se parezca a una clave.
  message?: string;
  limits: { requests?: string; tokens?: string; remainingRequests?: string; remainingTokens?: string; resetRequests?: string; resetTokens?: string; retryAfter?: string };
  requestId?: string;
  explanation: string;
}

const scrub = (text: string) => text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…").slice(0, 300);

export function interpretProbe(input: ProbeInput): ProbeResult {
  const error = typeof input.body === "object" && input.body !== null && "error" in input.body ? ((input.body as { error?: Record<string, unknown> }).error ?? {}) : {};
  const errorType = typeof error.type === "string" ? error.type : undefined;
  const errorCode = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? scrub(error.message) : undefined;
  const h = input.headers;
  const limits = {
    ...(h["x-ratelimit-limit-requests"] ? { requests: h["x-ratelimit-limit-requests"] } : {}),
    ...(h["x-ratelimit-limit-tokens"] ? { tokens: h["x-ratelimit-limit-tokens"] } : {}),
    ...(h["x-ratelimit-remaining-requests"] ? { remainingRequests: h["x-ratelimit-remaining-requests"] } : {}),
    ...(h["x-ratelimit-remaining-tokens"] ? { remainingTokens: h["x-ratelimit-remaining-tokens"] } : {}),
    ...(h["x-ratelimit-reset-requests"] ? { resetRequests: h["x-ratelimit-reset-requests"] } : {}),
    ...(h["x-ratelimit-reset-tokens"] ? { resetTokens: h["x-ratelimit-reset-tokens"] } : {}),
    ...(h["retry-after"] ? { retryAfter: h["retry-after"] } : {})
  };
  const base = { status: input.status, ms: input.ms, ...(errorType ? { errorType } : {}), ...(errorCode ? { errorCode } : {}), ...(message ? { message } : {}), limits, ...(h["x-request-id"] ? { requestId: h["x-request-id"] } : {}) };
  const haystack = `${errorType ?? ""} ${errorCode ?? ""} ${message ?? ""}`.toLowerCase();
  if (input.status >= 200 && input.status < 300) return { ...base, diagnosis: "OK", explanation: "La cuenta responde hoy. Los límites mostrados son los vigentes AHORA; no prueban lo que ocurrió el 4-nov." };
  if (input.status === 429) {
    if (/insufficient_quota|exceeded your current quota|billing|credit|budget|hard limit|usage limit/.test(haystack)) return { ...base, diagnosis: "CUOTA_O_FACTURACION", explanation: "429 por cuota/saldo/tope de gasto (no por velocidad). Separar claves NO lo arregla si el saldo o el tope son de la organización." };
    if (/rate_limit|rate limit|requests per min|tokens per min|rpm|tpm|too many requests/.test(haystack)) return { ...base, diagnosis: "LIMITE_DE_SOLICITUDES_O_TOKENS", explanation: "429 por velocidad (RPM/TPM) del modelo o del proyecto. Revisar los límites devueltos y el uso por minuto; separar proyectos puede ayudar si el límite es por proyecto." };
    return { ...base, diagnosis: "OTRO", explanation: "429 sin un código reconocible: conservar el x-request-id y consultarlo con el soporte del proveedor." };
  }
  if (input.status === 401 || input.status === 403) return { ...base, diagnosis: "CLAVE_INVALIDA_O_SIN_PERMISO", explanation: "La clave no es válida o no tiene permiso para este modelo/proyecto." };
  if (input.status === 404) return { ...base, diagnosis: "MODELO_NO_DISPONIBLE", explanation: "El modelo no existe o no está habilitado para esta cuenta." };
  if (input.status >= 500) return { ...base, diagnosis: "ERROR_DEL_PROVEEDOR", explanation: "Error del lado del proveedor; consultar su página de estado." };
  return { ...base, diagnosis: "OTRO", explanation: "Respuesta no prevista." };
}
