import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_VERSION,
  cachedAiCall,
  recordAiUsage,
  setUsageSink,
  usageFromChatCompletions,
  usageFromGemini,
  usageFromResponses
} from "../src/cache.js";

let dir: string;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-cache-"));
  process.env.AI_CACHE_DIR = dir;
  delete process.env.AI_CACHE;
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  setUsageSink(undefined);
  stderr.mockRestore();
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const parse = (raw: unknown) => {
  if (typeof raw !== "object" || raw === null || !("answer" in raw)) throw new Error("inválido");
  return raw as { answer: string };
};

function run(
  call: () => Promise<{ value: { answer: string }; usage?: Record<string, number> }>,
  overrides: { config?: unknown; model?: string; imageBase64?: string } = {}
) {
  return cachedAiCall({
    label: "test-reader",
    provider: "test",
    model: overrides.model ?? "model-a",
    imageBase64: overrides.imageBase64 ?? "aW1hZ2Vu",
    config: overrides.config ?? { prompt: "p" },
    parse,
    call
  });
}

async function usageLines(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(dir, "usage.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

const okCall = (answer = "uno", usage = { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, costUsd: 0.01 }) =>
  vi.fn(async () => ({ value: { answer }, usage }));

describe("cachedAiCall", () => {
  it("la segunda llamada idéntica es CACHE HIT y no vuelve a llamar al proveedor", async () => {
    const call = okCall();
    expect(await run(call)).toEqual({ answer: "uno" });
    expect(await run(call)).toEqual({ answer: "uno" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("CACHE HIT"));

    const lines = await usageLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ cacheHit: false, usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, costUsd: 0.01 } });
    expect(lines[1]).toMatchObject({ cacheHit: true, savedUsage: { costUsd: 0.01 } });
    expect(lines[1]).not.toHaveProperty("usage");
  });

  it("cambia la clave si cambia imagen, modelo o configuración", async () => {
    const call = okCall();
    await run(call);
    await run(call, { imageBase64: "b3RyYQ==" });
    await run(call, { model: "model-b" });
    await run(call, { config: { prompt: "otro" } });
    expect(call).toHaveBeenCalledTimes(4);
    expect(await readdir(join(dir, "ai"))).toHaveLength(4);
  });

  it("incluye cacheVersion en la clave y en la entrada; otra versión es miss", async () => {
    const call = okCall();
    await run(call);
    const [file] = await readdir(join(dir, "ai"));
    const path = join(dir, "ai", file!);
    const entry = JSON.parse(await readFile(path, "utf8"));
    expect(entry.cacheVersion).toBe(CACHE_VERSION);
    expect(CACHE_VERSION).toBe(1);

    await writeFile(path, JSON.stringify({ ...entry, cacheVersion: 2 }));
    await run(call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("una entrada corrupta o que no valida el schema se trata como miss", async () => {
    const call = okCall();
    await run(call);
    const [file] = await readdir(join(dir, "ai"));
    const path = join(dir, "ai", file!);
    const entry = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...entry, value: { otraCosa: true } }));
    await run(call);
    expect(call).toHaveBeenCalledTimes(2);

    await writeFile(path, "{no es json");
    await run(call);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("AI_CACHE=off no lee ni escribe cache, pero registra usage de las llamadas reales", async () => {
    process.env.AI_CACHE = "off";
    const call = okCall();
    await run(call);
    await run(call);
    expect(call).toHaveBeenCalledTimes(2);
    await expect(readdir(join(dir, "ai"))).rejects.toThrow();
    const lines = await usageLines();
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.cacheHit === false && line.cacheMode === "off")).toBe(true);
  });

  it("AI_CACHE=off no lee un cache que ya existía", async () => {
    await run(okCall("viejo"));
    process.env.AI_CACHE = "off";
    const call = okCall("nuevo");
    expect(await run(call)).toEqual({ answer: "nuevo" });
    expect(call).toHaveBeenCalledTimes(1);
    delete process.env.AI_CACHE;
    expect(await run(okCall("otro"))).toEqual({ answer: "viejo" }); // off no sobrescribió
  });

  it("AI_CACHE=refresh ignora el cache existente y lo sobrescribe con la respuesta válida", async () => {
    await run(okCall("viejo"));
    process.env.AI_CACHE = "refresh";
    const call = okCall("nuevo");
    expect(await run(call)).toEqual({ answer: "nuevo" });
    expect(call).toHaveBeenCalledTimes(1);

    delete process.env.AI_CACHE;
    const unused = okCall("no se usa");
    expect(await run(unused)).toEqual({ answer: "nuevo" });
    expect(unused).not.toHaveBeenCalled();
  });

  it("AI_CACHE=refresh no sobrescribe si la nueva respuesta falla o es inválida", async () => {
    await run(okCall("viejo"));
    process.env.AI_CACHE = "refresh";
    const failing = vi.fn(async () => {
      throw new Error("respuesta inválida");
    });
    await expect(run(failing)).rejects.toThrow("respuesta inválida");

    delete process.env.AI_CACHE;
    const unused = okCall("no se usa");
    expect(await run(unused)).toEqual({ answer: "viejo" });
    expect(unused).not.toHaveBeenCalled();
  });

  it("no cachea cuando la llamada lanza", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(run(failing)).rejects.toThrow("boom");
    await expect(readdir(join(dir, "ai"))).rejects.toThrow();
  });

  it("rechaza valores desconocidos de AI_CACHE", async () => {
    process.env.AI_CACHE = "quizas";
    await expect(run(okCall())).rejects.toThrow("AI_CACHE inválido");
  });

  it("registra el usage de respuestas inválidas reintentadas", async () => {
    await recordAiUsage({ label: "gemini-openrouter", provider: "openrouter", model: "m", usage: { inputTokens: 1 }, invalid: true });
    expect((await usageLines())[0]).toMatchObject({ invalid: true, cacheHit: false, usage: { inputTokens: 1 } });
  });
});

describe("setUsageSink", () => {
  it("con un sink instalado, el usage va al sink y no a usage.jsonl", async () => {
    const lines: Array<Record<string, unknown>> = [];
    setUsageSink((line) => { lines.push(line); });
    process.env.AI_CACHE = "off";
    await run(okCall());
    expect(lines).toEqual([expect.objectContaining({ label: "test-reader", cacheHit: false, usage: expect.objectContaining({ costUsd: 0.01 }) })]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("un sink que falla no interrumpe la llamada al modelo", async () => {
    setUsageSink(() => { throw new Error("db caída"); });
    process.env.AI_CACHE = "off";
    expect(await run(okCall())).toEqual({ answer: "uno" });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("db caída"));
  });
});

describe("normalizadores de usage", () => {
  it("OpenAI Responses", () => {
    expect(usageFromResponses({ input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } }))
      .toEqual({ inputTokens: 100, outputTokens: 50, reasoningTokens: 30 });
  });

  it("OpenRouter chat completions con costo", () => {
    expect(usageFromChatCompletions({
      prompt_tokens: 1108,
      completion_tokens: 1717,
      cost: 0.00727,
      completion_tokens_details: { reasoning_tokens: 1227 }
    })).toEqual({ inputTokens: 1108, outputTokens: 1717, reasoningTokens: 1227, costUsd: 0.00727 });
  });

  it("Google AI Studio", () => {
    expect(usageFromGemini({ promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 }))
      .toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
  });

  it("omite campos que el proveedor no devuelve", () => {
    expect(usageFromResponses({ input_tokens: 7 })).toEqual({ inputTokens: 7 });
    expect(usageFromResponses(undefined)).toBeUndefined();
  });
});
