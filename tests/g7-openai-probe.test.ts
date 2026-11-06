import { describe, expect, it } from "vitest";
import { interpretProbe } from "../scripts/g7/lib/openai-probe.js";

describe("g7 · sonda de límites de OpenAI (interpretación pura; sin red)", () => {
  const ok = (status: number, body: unknown, headers: Record<string, string> = {}) => interpretProbe({ status, body, headers, ms: 120 });

  it("distingue cuota/facturación (insufficient_quota llega como HTTP 429)", () => {
    const result = ok(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } });
    expect(result.diagnosis).toBe("CUOTA_O_FACTURACION");
    expect(result.explanation).toMatch(/Separar claves NO/);
  });

  it("distingue el límite de solicitudes/tokens y devuelve los límites vigentes", () => {
    const result = ok(429, { error: { type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached for gpt-4.1-mini: Limit 3, Used 3, Requested 1." } }, { "x-ratelimit-limit-requests": "3", "x-ratelimit-remaining-requests": "0", "retry-after": "20", "x-request-id": "req_abc" });
    expect(result.diagnosis).toBe("LIMITE_DE_SOLICITUDES_O_TOKENS");
    expect(result.limits).toMatchObject({ requests: "3", remainingRequests: "0", retryAfter: "20" });
    expect(result.requestId).toBe("req_abc");
  });

  it("reconoce éxito, clave inválida, modelo ausente y errores del proveedor", () => {
    expect(ok(200, { id: "x" }, { "x-ratelimit-limit-tokens": "200000" }).limits.tokens).toBe("200000");
    expect(ok(200, {}).diagnosis).toBe("OK");
    expect(ok(401, { error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-abcdefghijklmnop" } }).diagnosis).toBe("CLAVE_INVALIDA_O_SIN_PERMISO");
    expect(ok(404, { error: { code: "model_not_found" } }).diagnosis).toBe("MODELO_NO_DISPONIBLE");
    expect(ok(503, {}).diagnosis).toBe("ERROR_DEL_PROVEEDOR");
    expect(ok(429, {}).diagnosis).toBe("OTRO");
  });

  it("nunca devuelve algo que parezca una clave", () => {
    const result = ok(401, { error: { message: "Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz123456" } });
    expect(JSON.stringify(result)).not.toMatch(/sk-abcdefghijkl/);
  });
});
