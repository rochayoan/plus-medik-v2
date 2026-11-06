// G7 · ¿Está el modelo disponible en LA CUENTA de OpenAI? Una lectura (GET /v1/models/<id>): no envía ningún dato, no genera gasto y solo dice si la cuenta puede usar ese modelo.
//   200 → disponible · 404 (model_not_found) → no existe o la cuenta no tiene acceso · 401/403 → clave rechazada · 429 → cuota/límite · otro → error del servicio.
// Nunca imprime la clave ni el cuerpo de la respuesta: solo el estado y, si lo hay, el código corto del error.

export type ModelAvailability = "AVAILABLE" | "NOT_AVAILABLE" | "AUTH" | "QUOTA_OR_LIMIT" | "ERROR" | "NO_CONNECTION";

export interface ModelCheck { model: string; availability: ModelAvailability; httpStatus?: number; errorCode?: string }

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

export async function checkModelAvailability(options: { apiKey: string; model: string; fetchFn?: typeof fetch; baseUrl?: string }): Promise<ModelCheck> {
  const { apiKey, model } = options;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) return { model, availability: "ERROR", errorCode: "invalid_model_name" };
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${options.baseUrl ?? "https://api.openai.com/v1"}/models/${encodeURIComponent(model)}`, { method: "GET", headers: { authorization: `Bearer ${apiKey}` } });
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: unknown; type?: unknown } };
    const raw = body.error?.code ?? body.error?.type;
    const errorCode = typeof raw === "string" && SAFE_CODE.test(raw) ? raw : undefined;
    const status = response.status;
    const availability: ModelAvailability = status >= 200 && status < 300 ? "AVAILABLE" : status === 404 ? "NOT_AVAILABLE" : status === 401 || status === 403 ? "AUTH" : status === 429 ? "QUOTA_OR_LIMIT" : "ERROR";
    return { model, availability, httpStatus: status, ...(errorCode ? { errorCode } : {}) };
  } catch {
    return { model, availability: "NO_CONNECTION" };
  }
}
