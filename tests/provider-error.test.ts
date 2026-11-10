import { describe, expect, it } from "vitest";
import { describeHttpFailure, describeProviderError, summarizeAiFailures } from "../src/provider-error.js";

// Los errores de prueba imitan la forma del SDK de OpenAI (status, code, type, headers, requestID) e incluyen a propósito texto sensible en `message` y `error`: NADA de eso puede salir.
const SECRETS = ["sk-live-SECRETO-1234567890", "paciente Juan Pérez 71234567", "hemograma para mi esposa"];
function apiError(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const error = new Error(`429 You exceeded your current quota ${SECRETS.join(" | ")}`) as Error & Record<string, unknown>;
  error.name = "RateLimitError";
  Object.assign(error, { status: 429, code: "insufficient_quota", type: "insufficient_quota", requestID: "req_8f3a2c1d9e7b", error: { message: SECRETS[1], code: "insufficient_quota" }, headers: new Headers(headers) }, overrides);
  return error;
}

describe("describeProviderError · causa de un fallo del proveedor, solo con códigos", () => {
  it("distingue CUOTA / FACTURACIÓN (insufficient_quota llega como HTTP 429)", () => {
    expect(describeProviderError(apiError())).toMatchObject({ cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota", errorType: "insufficient_quota", requestId: "req_8f3a2c1d9e7b" });
    expect(describeProviderError(apiError({ code: "billing_hard_limit_reached", type: "invalid_request_error" })).cause).toBe("QUOTA_OR_BILLING");
  });

  it("distingue LÍMITE DE SOLICITUDES/TOKENS y trae retry-after y los límites restantes", () => {
    const info = describeProviderError(apiError({ code: "rate_limit_exceeded", type: "requests" }, { "retry-after": "20", "x-ratelimit-limit-requests": "500", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "6m0s", "x-ratelimit-limit-tokens": "200000", "x-ratelimit-remaining-tokens": "199000", "x-ratelimit-reset-tokens": "1s" }));
    expect(info).toMatchObject({ cause: "RATE_LIMIT", retryAfterS: 20, rl: { limitRequests: "500", remainingRequests: "0", resetRequests: "6m0s", limitTokens: "200000", remainingTokens: "199000", resetTokens: "1s" } });
  });

  it("un 429 sin código reconocible se marca como desconocido (no se adivina)", () => {
    expect(describeProviderError(apiError({ code: null, type: undefined })).cause).toBe("RATE_LIMIT_OR_QUOTA_UNKNOWN");
  });

  it("clasifica autenticación, modelo ausente, petición inválida, servidor, tiempo y red", () => {
    expect(describeProviderError(apiError({ status: 401, code: "invalid_api_key", type: "invalid_request_error" })).cause).toBe("AUTH");
    expect(describeProviderError(apiError({ status: 404, code: "model_not_found" })).cause).toBe("NOT_FOUND");
    expect(describeProviderError(apiError({ status: 400, code: "invalid_value" })).cause).toBe("BAD_REQUEST");
    expect(describeProviderError(apiError({ status: 503, code: undefined })).cause).toBe("SERVER");
    expect(describeProviderError(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" })).cause).toBe("TIMEOUT");
    expect(describeProviderError(Object.assign(new Error("x"), { name: "AbortError" })).cause).toBe("TIMEOUT");
    expect(describeProviderError(Object.assign(new Error("x"), { name: "APIConnectionError", code: "ECONNRESET" })).cause).toBe("CONNECTION");
    expect(describeProviderError(new Error("interpreter timeout")).cause).toBe("UNKNOWN");
  });

  it("acepta cabeceras como objeto plano (sin Headers) y no se confunde con mayúsculas", () => {
    expect(describeProviderError(apiError({ headers: { "Retry-After": "7", "X-Request-Id": "req_abcdef12" } }, {})).retryAfterS).toBe(7);
  });

  it("NUNCA expone el mensaje, el cuerpo, claves ni datos del paciente", () => {
    const info = describeProviderError(apiError({}, { "retry-after": "3", authorization: "Bearer sk-live-SECRETO-1234567890", "set-cookie": "sesion=abc", "openai-organization": "org-privada" }));
    const dump = JSON.stringify(info);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/Bearer|sesion|org-privada|quota,|exceeded/i);
    expect(Object.keys(info).sort()).toEqual(["cause", "errorCode", "errorName", "errorType", "httpStatus", "requestId", "retryAfterS"].sort());
  });

  it("descarta valores que no cumplen el patrón estricto en lugar de copiarlos o recortarlos", () => {
    const info = describeProviderError(apiError({ code: "insufficient quota; paciente Juan", type: "x".repeat(200), requestID: "req con espacios" }, { "x-ratelimit-limit-requests": "500 solicitudes del paciente", "retry-after": "mañana" }));
    expect(info.errorCode).toBeUndefined();
    expect(info.errorType).toBeUndefined();
    expect(info.requestId).toBeUndefined();
    expect(info.rl).toBeUndefined();
    expect(info.retryAfterS).toBeUndefined();
  });

  it("nunca lanza, ni con valores raros", () => {
    for (const weird of [undefined, null, 42, "texto", Symbol("s"), { get status() { throw new Error("boom"); } }, Object.create(null)]) expect(() => describeProviderError(weird)).not.toThrow();
    expect(describeProviderError(undefined)).toEqual({ cause: "UNKNOWN" });
  });
});

describe("describeHttpFailure · peticiones HTTP sin SDK (audio)", () => {
  it("extrae solo error.code/type con patrón estricto y las cabeceras permitidas", () => {
    const body = JSON.stringify({ error: { message: `no puedo transcribir ${SECRETS[1]}`, type: "insufficient_quota", code: "insufficient_quota" } });
    const info = describeHttpFailure({ status: 429, header: (name) => ({ "retry-after": "12", "x-request-id": "req_audio12345" } as Record<string, string>)[name] ?? null, bodyText: body });
    expect(info).toMatchObject({ cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota", retryAfterS: 12, requestId: "req_audio12345" });
    expect(JSON.stringify(info)).not.toContain("Juan");
  });

  it("un cuerpo que no es JSON o está truncado no rompe nada ni se copia", () => {
    expect(describeHttpFailure({ status: 500, bodyText: "<html>error con datos del paciente 71234567" })).toEqual({ cause: "SERVER", httpStatus: 500 });
    // JSON truncado (más de 4 KB): no se interpreta, así que no hay código y la causa queda como desconocida
    expect(describeHttpFailure({ status: 429, bodyText: '{"error":{"code":"rate_limit_exceeded","message":"' + "x".repeat(6000) })).toEqual({ cause: "RATE_LIMIT_OR_QUOTA_UNKNOWN", httpStatus: 429 });
  });
});

describe("summarizeAiFailures", () => {
  it("resume solo las llamadas fallidas con proveedor, modelo, etapa y causa; máximo 6", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ label: `reader_${i}`, provider: "openai", model: "gpt-x", outcome: i % 2 === 0 ? "FAILED" : "OK", errorKind: "RATE_LIMITED", failure: describeProviderError(apiError()) }));
    const summary = summarizeAiFailures(events);
    expect(summary).toHaveLength(5);
    expect(summary[0]).toMatchObject({ stage: "reader_0", provider: "openai", model: "gpt-x", errorKind: "RATE_LIMITED", cause: "QUOTA_OR_BILLING", httpStatus: 429 });
    expect(JSON.stringify(summary)).not.toContain("SECRETO");
  });
});

describe("errores del SDK que dejan name = «Error» (la causa está en la clase)", () => {
  it("un tiempo agotado y un fallo de conexión del SDK de OpenAI se distinguen por el nombre de la clase, no por el mensaje", () => {
    class APIConnectionTimeoutError extends Error {}
    class APIConnectionError extends Error {}
    expect(describeProviderError(new APIConnectionTimeoutError("Request timed out. detalle-secreto"))).toMatchObject({ cause: "TIMEOUT", errorName: "APIConnectionTimeoutError" });
    expect(describeProviderError(new APIConnectionError("Connection error."))).toMatchObject({ cause: "CONNECTION", errorName: "APIConnectionError" });
    expect(JSON.stringify(describeProviderError(new APIConnectionTimeoutError("detalle-secreto")))).not.toContain("detalle-secreto");
    expect(describeProviderError(new Error("algo"))).toEqual({ cause: "UNKNOWN", errorName: "Error" });
  });
});
