import { describe, expect, it, vi } from "vitest";
import { checkModelAvailability } from "../scripts/g7/lib/model-check.js";

// Comprobación de disponibilidad de un modelo en la cuenta: una lectura, sin datos, sin imprimir la clave ni el cuerpo.

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("disponibilidad de un modelo en la cuenta", () => {
  it("200 = disponible; la petición es un GET a /models/<id> con la clave solo en la cabecera y sin cuerpo", async () => {
    const fetchFn = reply(200, { id: "modelo-x", object: "model" });
    const result = await checkModelAvailability({ apiKey: "sk-secreta", model: "modelo-x", fetchFn });
    expect(result).toEqual({ model: "modelo-x", availability: "AVAILABLE", httpStatus: 200 });
    const [url, init] = (fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models/modelo-x");
    expect(init).toMatchObject({ method: "GET", headers: { authorization: "Bearer sk-secreta" } });
    expect(init.body).toBeUndefined();
  });

  it("distingue «no existe o sin acceso», clave rechazada, cuota/límite y error del servicio, sin copiar mensajes del proveedor", async () => {
    const check = (status: number, body: unknown) => checkModelAvailability({ apiKey: "sk-secreta", model: "modelo-x", fetchFn: reply(status, body) });
    expect(await check(404, { error: { message: "The model does not exist or you do not have access", code: "model_not_found" } })).toEqual({ model: "modelo-x", availability: "NOT_AVAILABLE", httpStatus: 404, errorCode: "model_not_found" });
    expect(await check(401, { error: { message: "Incorrect API key sk-secreta", code: "invalid_api_key" } })).toMatchObject({ availability: "AUTH", errorCode: "invalid_api_key" });
    expect(await check(403, {})).toMatchObject({ availability: "AUTH" });
    expect(await check(429, { error: { code: "insufficient_quota" } })).toMatchObject({ availability: "QUOTA_OR_LIMIT", errorCode: "insufficient_quota" });
    expect(await check(500, { error: { type: "server_error" } })).toMatchObject({ availability: "ERROR", errorCode: "server_error" });
    expect(JSON.stringify(await check(401, { error: { message: "Incorrect API key sk-secreta", code: "con espacios y texto libre" } }))).not.toMatch(/sk-secreta|espacios/);
  });

  it("sin conexión o con un nombre de modelo inválido no se llama a nadie con datos raros", async () => {
    expect(await checkModelAvailability({ apiKey: "k", model: "modelo-x", fetchFn: vi.fn(async () => { throw new Error("red caída sk-secreta"); }) as unknown as typeof fetch })).toEqual({ model: "modelo-x", availability: "NO_CONNECTION" });
    const never = vi.fn();
    expect(await checkModelAvailability({ apiKey: "k", model: "../otra-ruta?x=1", fetchFn: never as unknown as typeof fetch })).toMatchObject({ availability: "ERROR", errorCode: "invalid_model_name" });
    expect(never).not.toHaveBeenCalled();
  });
});
