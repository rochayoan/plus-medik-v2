import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAiCall } from "../src/cache.js";

// 11-nov: dos fotos seguidas fallaron con HTTP 429 (demasiado rápido) y el paciente quedó sin cotización. Un límite temporal se reintenta con tope; un límite por cuota o saldo no.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-retry-"));
  vi.stubEnv("AI_CACHE_DIR", dir);
  vi.stubEnv("AI_CACHE", "off");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const parse = (raw: unknown) => raw as { ok: boolean };
const rateLimit = (code = "rate_limit_exceeded") => Object.assign(new Error("429"), { status: 429, code, type: code });
function run(failures: unknown[], sleeps: number[]) {
  let calls = 0;
  const promise = cachedAiCall({
    label: "openai-reader", provider: "test", model: "m", imageBase64: `img-${Math.random()}`, config: { prompt: "p" }, parse,
    retrySleep: async (ms) => { sleeps.push(ms); },
    call: async () => {
      const failure = failures[calls++];
      if (failure) throw failure;
      return { value: { ok: true } };
    }
  });
  return { promise, calls: () => calls };
}

describe("reintento ante un límite de uso temporal (429)", () => {
  it("reintenta y devuelve el resultado si el segundo intento pasa", async () => {
    const sleeps: number[] = [];
    const r = run([rateLimit()], sleeps);
    await expect(r.promise).resolves.toEqual({ ok: true });
    expect(r.calls()).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });
  it("tiene tope: tras dos reintentos falla igual (el aviso técnico de siempre)", async () => {
    const sleeps: number[] = [];
    const r = run([rateLimit(), rateLimit(), rateLimit(), rateLimit()], sleeps);
    await expect(r.promise).rejects.toMatchObject({ status: 429 });
    expect(r.calls()).toBe(3);
    expect(sleeps).toHaveLength(2);
  });
  it("un límite por cuota o saldo no se reintenta (esperar no lo arregla)", async () => {
    const sleeps: number[] = [];
    const r = run([rateLimit("insufficient_quota")], sleeps);
    await expect(r.promise).rejects.toMatchObject({ status: 429 });
    expect(r.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });
  it("otros errores no se reintentan; AI_RATE_LIMIT_RETRIES=0 lo apaga", async () => {
    const sleeps: number[] = [];
    const server = run([Object.assign(new Error("x"), { status: 503 })], sleeps);
    await expect(server.promise).rejects.toMatchObject({ status: 503 });
    expect(server.calls()).toBe(1);
    vi.stubEnv("AI_RATE_LIMIT_RETRIES", "0");
    const off = run([rateLimit()], sleeps);
    await expect(off.promise).rejects.toMatchObject({ status: 429 });
    expect(off.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
