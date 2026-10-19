import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedAiCall, setRealCallGate } from "../src/cache.js";
import { AUTHORIZATION_ENV, createPaidCallGate, ESTIMATE_MARGIN, FALLBACK_ESTIMATE_USD, PaidCallBlockedError } from "../scripts/lib/paid-guard.js";
import { costOf, maxCostByLabel, spentSince, type Baseline, type UsageRow } from "../scripts/lib/spend-ledger.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-guard-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "on";
});
afterEach(async () => {
  setRealCallGate(undefined);
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  await rm(dir, { recursive: true, force: true });
});

const baseline: Baseline = { since: "2026-10-19T00:00:00.000Z", budgetUsd: 2, stopUsd: 1.5 };
// Una etapa que históricamente cuesta US$0.05 como máximo -> estimación 0.065.
const history: UsageRow[] = [{ timestamp: "2026-10-18T10:00:00.000Z", label: "stage", provider: "openai", cacheHit: false, usage: { inputTokens: 20_000, outputTokens: 1_000 } }];
const stageEstimate = 0.05 * ESTIMATE_MARGIN;
const info = { label: "stage", provider: "openai", model: "gpt-6.1-sol" };

const gate = (env: NodeJS.ProcessEnv, rows: UsageRow[] = history, base: Baseline | null = baseline) =>
  createPaidCallGate("prueba", { env, readRows: async () => rows, readBaseline: async () => base ?? undefined });

describe("libro de gastos", () => {
  it("costo: OpenAI por tokens (US$2/US$10 por Mtok), OpenRouter por costUsd registrado, cache = 0", () => {
    const row = (over: Partial<UsageRow>): UsageRow => ({ timestamp: "t", label: "x", provider: "openai", cacheHit: false, usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, ...over });
    expect(costOf(row({}))).toBeCloseTo(3, 6);
    expect(costOf(row({ provider: "openrouter", usage: { costUsd: 0.004, inputTokens: 5, outputTokens: 5 } }))).toBeCloseTo(0.004, 6);
    expect(costOf(row({ cacheHit: true }))).toBe(0);
    expect(costOf(row({ usage: undefined }))).toBe(0);
  });

  it("gasto desde el punto de partida y máximo histórico por etapa", () => {
    const rows: UsageRow[] = [
      ...history,
      { timestamp: "2026-10-19T01:00:00.000Z", label: "stage", provider: "openai", cacheHit: false, usage: { inputTokens: 10_000, outputTokens: 500 } },
      { timestamp: "2026-10-19T02:00:00.000Z", label: "stage", provider: "openai", cacheHit: true }
    ];
    expect(spentSince(rows, baseline.since)).toBeCloseTo(0.025, 6);
    expect(maxCostByLabel(rows).get("stage")).toBeCloseTo(0.05, 6);
  });
});

describe("guarda de llamadas reales", () => {
  it("sin autorización explícita bloquea toda llamada real, y el mensaje dice cómo autorizar", async () => {
    const error = await gate({})(info).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaidCallBlockedError);
    expect((error as Error).message).toContain(AUTHORIZATION_ENV);
    expect((error as Error).message).toContain("BLOQUEADA");
  });

  it("una autorización inválida (vacía, cero, negativa, no numérica) no cuenta", async () => {
    for (const value of ["", "0", "-1", "abc", "NaN"]) {
      await expect(gate({ [AUTHORIZATION_ENV]: value })(info)).rejects.toBeInstanceOf(PaidCallBlockedError);
    }
  });

  it("sin presupuesto fijado bloquea aunque haya autorización", async () => {
    await expect(gate({ [AUTHORIZATION_ENV]: "1" }, history, null)(info)).rejects.toThrow(/no hay presupuesto fijado/);
  });

  it("autorizado y dentro del presupuesto: permite llamadas hasta agotar lo autorizado y luego bloquea", async () => {
    const g = gate({ [AUTHORIZATION_ENV]: String(stageEstimate * 2 + 0.001) });
    await expect(g(info)).resolves.toBeUndefined();
    await expect(g(info)).resolves.toBeUndefined();
    await expect(g(info)).rejects.toThrow(/supera lo autorizado/);
  });

  it("una etapa sin historial usa una estimación prudente y no cabe en una autorización pequeña", async () => {
    const g = gate({ [AUTHORIZATION_ENV]: "0.05" });
    await expect(g({ ...info, label: "etapa-nueva" })).rejects.toThrow(/supera lo autorizado/);
    expect(FALLBACK_ESTIMATE_USD * ESTIMATE_MARGIN).toBeGreaterThan(0.05);
  });

  it("el tope de parada manda aunque la autorización sea grande", async () => {
    const spentRows: UsageRow[] = [...history, { timestamp: "2026-10-19T01:00:00.000Z", label: "stage", provider: "openai", cacheHit: false, usage: { inputTokens: 700_000, outputTokens: 10_000 } }];
    // gastado: 1.4 + 0.1 = 1.5 -> alcanzó el tope
    await expect(gate({ [AUTHORIZATION_ENV]: "10" }, spentRows)(info)).rejects.toThrow(/alcanzó el tope de parada/);
    // gastado 1.44: cabe el tope pero no la siguiente llamada estimada (0.065)
    const nearRows: UsageRow[] = [...history, { timestamp: "2026-10-19T01:00:00.000Z", label: "stage", provider: "openai", cacheHit: false, usage: { inputTokens: 700_000, outputTokens: 4_000 } }];
    await expect(gate({ [AUTHORIZATION_ENV]: "10" }, nearRows)(info)).rejects.toThrow(/superaría el tope de parada/);
  });

  it("llamadas en paralelo: la reserva es atómica y no se sobrepasa lo autorizado", async () => {
    const g = gate({ [AUTHORIZATION_ENV]: String(stageEstimate * 3 + 0.001) });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => g(info)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
  });
});

describe("integración con cachedAiCall", () => {
  const options = (call: () => Promise<{ value: string; usage?: { inputTokens: number; outputTokens: number } }>) => ({
    label: "stage",
    provider: "openai",
    model: "m",
    imageBase64: "aW1n",
    config: { prompt: "p" },
    parse: (raw: unknown) => String(raw),
    call
  });

  it("sin guarda instalada todo funciona como siempre", async () => {
    const call = vi.fn(async () => ({ value: "ok" }));
    expect(await cachedAiCall(options(call))).toBe("ok");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("guarda sin autorización: la llamada real NO se ejecuta y no queda registro de uso", async () => {
    setRealCallGate(gate({}));
    const call = vi.fn(async () => ({ value: "caro" }));
    await expect(cachedAiCall(options(call))).rejects.toBeInstanceOf(PaidCallBlockedError);
    expect(call).not.toHaveBeenCalled();
    await expect(readFile(join(dir, "usage.jsonl"), "utf8")).rejects.toThrow();
  });

  it("las respuestas en cache no activan la guarda (costo 0) aunque no haya autorización", async () => {
    const call = vi.fn(async () => ({ value: "ok", usage: { inputTokens: 10, outputTokens: 1 } }));
    setRealCallGate(gate({ [AUTHORIZATION_ENV]: "1" }));
    expect(await cachedAiCall(options(call))).toBe("ok");
    // misma petición, guarda que bloquearía todo: el cache responde sin tocarla
    const blocking = vi.fn(() => {
      throw new PaidCallBlockedError("no debe invocarse");
    });
    setRealCallGate(blocking);
    expect(await cachedAiCall(options(call))).toBe("ok");
    expect(blocking).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("con AI_CACHE=off cada llamada es real y pasa por la guarda", async () => {
    process.env.AI_CACHE = "off";
    const seen = vi.fn();
    setRealCallGate(seen);
    const call = vi.fn(async () => ({ value: "ok" }));
    await cachedAiCall(options(call));
    await cachedAiCall(options(call));
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledWith({ label: "stage", provider: "openai", model: "m" });
  });
});
