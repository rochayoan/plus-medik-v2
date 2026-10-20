import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_ABSOLUTE_MAX_TOKENS, OPENROUTER_DEFAULT_MAX_TOKENS, openRouterMaxTokens, openRouterRetryMaxTokens, openRouterRetryReasoning, readImageWithGeminiViaOpenRouter } from "../src/ai.js";

// Lector Gemini vía OpenRouter: el tope de salida incluye el razonamiento; un JSON truncado (finish_reason=length) no se reintenta con el mismo tope.
// Cliente simulado: ninguna llamada real.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-openrouter-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
  delete process.env.OPENROUTER_GEMINI_MAX_TOKENS;
  delete process.env.OPENROUTER_GEMINI_RETRY_MAX_TOKENS;
  delete process.env.OPENROUTER_GEMINI_RETRY_REASONING;
  delete process.env.OPENROUTER_GEMINI_REASONING;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  delete process.env.OPENROUTER_GEMINI_REASONING;
  delete process.env.OPENROUTER_GEMINI_MAX_TOKENS;
  delete process.env.OPENROUTER_GEMINI_RETRY_MAX_TOKENS;
  delete process.env.OPENROUTER_GEMINI_RETRY_REASONING;
  await rm(dir, { recursive: true, force: true });
});

const valid = JSON.stringify({
  requestedStudies: [{ literalText: "Hemograma", normalizedName: "Hemograma", evidence: "check", confidence: "high", lineText: "Hemograma" }],
  uncertainStudies: [],
  notes: ""
});
const reply = (content: string, finish: string, completion = 100) => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 500, completion_tokens: completion, total_tokens: 500 + completion } });
const truncated = (tokens = 6130) => reply('{"requestedStudies":[{"literalText":"Hemo', "length", tokens);

function fakeClient(...replies: Array<ReturnType<typeof reply>>) {
  const create = vi.fn(async (_request: { max_tokens: number; reasoning: { effort: string } }) => {
    const next = replies.shift();
    if (!next) throw new Error("llamada inesperada");
    return next;
  });
  return { client: { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">, create };
}
const read = (client: Pick<OpenAI, "chat">) => readImageWithGeminiViaOpenRouter("aW1n", "image/jpeg", "sk-no-real", false, client);
const caps = (create: ReturnType<typeof fakeClient>["create"]) => create.mock.calls.map((call) => call[0].max_tokens);
const efforts = (create: ReturnType<typeof fakeClient>["create"]) => create.mock.calls.map((call) => call[0].reasoning.effort);

describe("tope de salida", () => {
  it("por defecto es 8192 (el JSON ocupa cientos de tokens; el resto es razonamiento) y se configura con OPENROUTER_GEMINI_MAX_TOKENS", () => {
    expect(OPENROUTER_DEFAULT_MAX_TOKENS).toBe(8192);
    expect(openRouterMaxTokens({})).toBe(8192);
    expect(openRouterMaxTokens({ OPENROUTER_GEMINI_MAX_TOKENS: "20000" })).toBe(20000);
    for (const bad of ["abc", "100", "70000", "1.5", "-1"]) expect(() => openRouterMaxTokens({ OPENROUTER_GEMINI_MAX_TOKENS: bad })).toThrow(/OPENROUTER_GEMINI_MAX_TOKENS/);
  });
  it("el tope del reintento es 1,5 veces el inicial (12288 por defecto), configurable y nunca sobre el máximo absoluto", () => {
    expect(openRouterRetryMaxTokens(8192, {})).toBe(12288);
    expect(openRouterRetryMaxTokens(4096, {})).toBe(6144);
    expect(openRouterRetryMaxTokens(60000, {})).toBe(OPENROUTER_ABSOLUTE_MAX_TOKENS);
    expect(openRouterRetryMaxTokens(8192, { OPENROUTER_GEMINI_RETRY_MAX_TOKENS: "16000" })).toBe(16000);
    for (const bad of ["abc", "10", "70000"]) expect(() => openRouterRetryMaxTokens(8192, { OPENROUTER_GEMINI_RETRY_MAX_TOKENS: bad })).toThrow(/OPENROUTER_GEMINI_RETRY_MAX_TOKENS/);
  });
  it("el razonamiento del reintento es low por defecto y se configura con OPENROUTER_GEMINI_RETRY_REASONING", () => {
    expect(openRouterRetryReasoning({})).toBe("low");
    expect(openRouterRetryReasoning({ OPENROUTER_GEMINI_RETRY_REASONING: "medium" })).toBe("medium");
    expect(() => openRouterRetryReasoning({ OPENROUTER_GEMINI_RETRY_REASONING: "max" })).toThrow(/OPENROUTER_GEMINI_RETRY_REASONING/);
  });
  it("una lectura normal es UNA llamada con el tope y el razonamiento configurados (medium por defecto)", async () => {
    const { client, create } = fakeClient(reply(valid, "stop"));
    const result = await read(client);
    expect(result.requestedStudies[0]?.literalText).toBe("Hemograma");
    expect(caps(create)).toEqual([8192]);
    expect(efforts(create)).toEqual(["medium"]);
  });
  it("un razonamiento primario configurado en low se respeta", async () => {
    process.env.OPENROUTER_GEMINI_REASONING = "low";
    const { client, create } = fakeClient(reply(valid, "stop"));
    await read(client);
    expect(efforts(create)).toEqual(["low"]);
  });
});

describe("respuesta truncada (finish_reason=length)", () => {
  it("se reintenta UNA vez con razonamiento low y 1,5 veces el tope (nunca igual) y la lectura se recupera", async () => {
    const { client, create } = fakeClient(truncated(8190), reply(valid, "stop", 3000));
    const result = await read(client);
    expect(result.requestedStudies).toHaveLength(1);
    expect(caps(create)).toEqual([8192, 12288]);
    expect(efforts(create)).toEqual(["medium", "low"]);
  });
  it("si vuelve a truncarse falla de inmediato, sin un tercer intento, con un mensaje accionable", async () => {
    const { client, create } = fakeClient(truncated(8190), truncated(12288), reply(valid, "stop"));
    await expect(read(client)).rejects.toThrow(/TRUNCADA.*OPENROUTER_GEMINI_MAX_TOKENS/s);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("si el tope del reintento no supera al actual no hay reintento inútil: falla tras la primera llamada", async () => {
    process.env.OPENROUTER_GEMINI_MAX_TOKENS = "65536";
    const a = fakeClient(truncated(65536), reply(valid, "stop"));
    await expect(read(a.client)).rejects.toThrow(/TRUNCADA/);
    expect(a.create).toHaveBeenCalledTimes(1);
    process.env.OPENROUTER_GEMINI_MAX_TOKENS = "8192";
    process.env.OPENROUTER_GEMINI_RETRY_MAX_TOKENS = "8192";
    const b = fakeClient(truncated(8192), reply(valid, "stop"));
    await expect(read(b.client)).rejects.toThrow(/TRUNCADA/);
    expect(b.create).toHaveBeenCalledTimes(1);
  });
  it("con topes configurados el reintento usa el tope y el razonamiento configurados", async () => {
    process.env.OPENROUTER_GEMINI_MAX_TOKENS = "6000";
    process.env.OPENROUTER_GEMINI_RETRY_MAX_TOKENS = "16000";
    process.env.OPENROUTER_GEMINI_RETRY_REASONING = "medium";
    const { client, create } = fakeClient(truncated(), reply(valid, "stop"));
    await read(client);
    expect(caps(create)).toEqual([6000, 16000]);
    expect(efforts(create)).toEqual(["medium", "medium"]);
  });
  it("el mensaje de error indica los tokens, el tope y el razonamiento usados, y el final del contenido", async () => {
    const { client } = fakeClient(truncated(6130), truncated(6130));
    await expect(read(client)).rejects.toThrow(/finish_reason=length, completion_tokens=6130, max_tokens=12288, reasoning=low/);
  });
  it("el peor caso (dos truncamientos) queda acotado a 8192 + 12288 tokens de salida, no 16384 + 32768", async () => {
    const { client, create } = fakeClient(truncated(8192), truncated(12288));
    await expect(read(client)).rejects.toThrow();
    expect(caps(create).reduce((a, b) => a + b, 0)).toBe(20480);
  });
});

describe("contenido inválido que NO es truncado", () => {
  it("se reintenta una vez con el mismo tope", async () => {
    const { client, create } = fakeClient(reply("{no es json", "stop"), reply(valid, "stop"));
    await read(client);
    expect(caps(create)).toEqual([8192, 8192]);
    expect(efforts(create)).toEqual(["medium", "medium"]);
  });
  it("si sigue inválido falla tras el reintento, sin más", async () => {
    const { client, create } = fakeClient(reply("{no es json", "stop"), reply('{"requestedStudies": 3}', "stop"), reply(valid, "stop"));
    await expect(read(client)).rejects.toThrow(/Respuesta inválida de OpenRouter tras 2 intentos/);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("una respuesta sin lineText es inválida para el contrato actual (obligatorio)", async () => {
    const withoutLine = JSON.stringify({ requestedStudies: [{ literalText: "a", normalizedName: "a", evidence: "check", confidence: "high" }], uncertainStudies: [], notes: "" });
    const { client, create } = fakeClient(reply(withoutLine, "stop"), reply(withoutLine, "stop"));
    await expect(read(client)).rejects.toThrow(/inválida/);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("caché", () => {
  it("el tope de salida no forma parte de la clave: cambiarlo no invalida lo guardado", async () => {
    process.env.AI_CACHE = "on";
    const first = fakeClient(reply(valid, "stop"));
    await read(first.client);
    process.env.OPENROUTER_GEMINI_MAX_TOKENS = "24000";
    const second = fakeClient(reply(valid, "stop"));
    await read(second.client);
    expect(first.create).toHaveBeenCalledTimes(1);
    expect(second.create).not.toHaveBeenCalled();
  });
});
