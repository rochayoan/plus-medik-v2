import https from "node:https";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAiCall, setRealCallGate } from "../src/cache.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import { enforceOffline, isNetworkBlocked, isOfflineStrict, offlineAttempts, OfflineViolation, releaseOfflineForTests } from "../src/offline.js";

// Ninguna de estas pruebas hace una llamada real: el modo offline es lo que se prueba, y todo lo "externo" es un simulacro local o una función bloqueada.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-offline-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "on";
});
afterEach(async () => {
  setRealCallGate(undefined);
  delete process.env.PLUSMEDIK_OFFLINE;
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  releaseOfflineForTests();
  enforceOffline({ strict: false }); // el arranque de la suite deja la red bloqueada
  await rm(dir, { recursive: true, force: true });
});

const baseCall = (call: () => Promise<{ value: string }>) => ({
  label: "etapa-prueba", provider: "openai", model: "m", imageBase64: "aW1n", config: { p: 1 }, parse: (raw: unknown) => String(raw), call
});

describe("capa de red: ningún acceso externo real sale de la suite", () => {
  it("la suite arranca con la red bloqueada (fetch, http y https)", async () => {
    releaseOfflineForTests();
    enforceOffline({ strict: false });
    expect(isNetworkBlocked()).toBe(true);
    await expect(fetch("https://api.openai.com/v1/responses")).rejects.toBeInstanceOf(OfflineViolation);
    expect(() => https.request("https://example.com")).toThrow(OfflineViolation);
    expect(() => https.get("https://example.com")).toThrow(OfflineViolation);
    expect(() => http.request("http://example.com")).toThrow(OfflineViolation);
    expect(() => http.get("http://example.com")).toThrow(OfflineViolation);
    expect(offlineAttempts().length).toBeGreaterThanOrEqual(5);
    expect(offlineAttempts()[0]).toContain("api.openai.com");
  });

  it("un cliente de OpenAI real (SDK) no logra salir: la petición falla antes de tocar la red", async () => {
    const client = new OpenAI({ apiKey: "sk-no-es-una-clave-real", maxRetries: 0 });
    await expect(client.responses.create({ model: "x", input: "hola" })).rejects.toThrow();
    expect(offlineAttempts().some((attempt) => attempt.includes("openai.com"))).toBe(true);
  });

  it("el cargador de catálogo de Supabase con su fetch por defecto tampoco sale", async () => {
    await expect(loadActiveCatalog({ baseUrl: "https://ejemplo.supabase.co", serviceKey: "no-es-una-clave" })).rejects.toBeInstanceOf(OfflineViolation);
    expect(offlineAttempts().some((attempt) => attempt.includes("ejemplo.supabase.co"))).toBe(true);
  });

  it("una simulación local con un fetch inyectado sigue funcionando (no es red real)", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    await expect(loadActiveCatalog({ baseUrl: "https://ejemplo.supabase.co", serviceKey: "k", fetchFn: fake as unknown as typeof fetch })).resolves.toEqual([]);
    expect(fake).toHaveBeenCalled();
  });

  it("enforceOffline es idempotente: no apila bloqueos ni pierde los originales", () => {
    const first = globalThis.fetch;
    enforceOffline({ strict: false });
    enforceOffline({ strict: false });
    expect(globalThis.fetch).toBe(first);
    releaseOfflineForTests();
    expect(globalThis.fetch).not.toBe(first);
    expect(isNetworkBlocked()).toBe(false);
  });
});

describe("capa estricta: ninguna llamada a modelos aunque la guarda de gasto sea permisiva", () => {
  it("sin modo offline una llamada con un simulacro local funciona (control)", async () => {
    const call = vi.fn(async () => ({ value: "ok" }));
    await expect(cachedAiCall(baseCall(call))).resolves.toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("PLUSMEDIK_OFFLINE=1 bloquea la llamada y la guarda permisiva ni se consulta (el caso del incidente)", async () => {
    const permissiveGate = vi.fn(async () => undefined);
    setRealCallGate(permissiveGate);
    process.env.PLUSMEDIK_OFFLINE = "1";
    const call = vi.fn(async () => ({ value: "no debe llamarse" }));
    await expect(cachedAiCall(baseCall(call))).rejects.toBeInstanceOf(OfflineViolation);
    expect(call).not.toHaveBeenCalled();
    expect(permissiveGate).not.toHaveBeenCalled();
  });

  it("enforceOffline({ strict }) bloquea igual y es PEGAJOSO: borrar la variable no lo desactiva", async () => {
    setRealCallGate(async () => undefined);
    enforceOffline({ strict: true });
    delete process.env.PLUSMEDIK_OFFLINE;
    expect(isOfflineStrict()).toBe(true);
    const call = vi.fn(async () => ({ value: "x" }));
    await expect(cachedAiCall(baseCall(call))).rejects.toBeInstanceOf(OfflineViolation);
    setRealCallGate(undefined);
    await expect(cachedAiCall(baseCall(call))).rejects.toBeInstanceOf(OfflineViolation);
    expect(call).not.toHaveBeenCalled();
  });

  for (const value of ["1", "true", "TRUE", "on", "yes", " 1 "]) {
    it(`PLUSMEDIK_OFFLINE=${JSON.stringify(value)} activa el modo estricto`, () => {
      process.env.PLUSMEDIK_OFFLINE = value;
      expect(isOfflineStrict()).toBe(true);
    });
  }
  for (const value of ["0", "false", "off", "", "no"]) {
    it(`PLUSMEDIK_OFFLINE=${JSON.stringify(value)} no lo activa`, () => {
      process.env.PLUSMEDIK_OFFLINE = value;
      expect(isOfflineStrict()).toBe(false);
    });
  }

  it("las respuestas ya cacheadas se siguen sirviendo en modo offline (cuestan 0)", async () => {
    const populate = vi.fn(async () => ({ value: "cacheado" }));
    await cachedAiCall(baseCall(populate));
    enforceOffline({ strict: true });
    const call = vi.fn(async () => ({ value: "otro" }));
    await expect(cachedAiCall(baseCall(call))).resolves.toBe("cacheado");
    expect(call).not.toHaveBeenCalled();
    // una consulta distinta (no cacheada) sí se bloquea
    await expect(cachedAiCall({ ...baseCall(call), config: { p: 2 } })).rejects.toBeInstanceOf(OfflineViolation);
  });

  it("un script que simula una etapa pero olvida inyectar el verificador no puede gastar: la etapa por defecto queda bloqueada", async () => {
    enforceOffline({ strict: true });
    setRealCallGate(async ({ label }) => { if (label !== "openai-document-function") throw new Error("otra etapa"); });
    const realStage = vi.fn(async () => ({ value: "respuesta real de pago" }));
    await expect(cachedAiCall({ ...baseCall(realStage), label: "openai-document-function" })).rejects.toBeInstanceOf(OfflineViolation);
    expect(realStage).not.toHaveBeenCalled();
  });
});

describe("releaseOfflineForTests solo existe dentro de vitest", () => {
  it("falla si no hay VITEST (un script no puede desactivar la protección)", () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => releaseOfflineForTests()).toThrow(/solo se puede usar dentro de vitest/);
    } finally {
      process.env.VITEST = saved;
    }
  });
});
