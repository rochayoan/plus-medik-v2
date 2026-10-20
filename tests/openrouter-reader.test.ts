import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_DEFAULT_MAX_TOKENS, OPENROUTER_HARD_MAX_TOKENS, openRouterMaxTokens, readImageWithGeminiViaOpenRouter } from "../src/ai.js";

// Lector Gemini vía OpenRouter: el tope de salida incluye el razonamiento; un JSON truncado (finish_reason=length) no se reintenta con el mismo tope.
// Cliente simulado: ninguna llamada real.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-openrouter-"));
  process.env.AI_CACHE_DIR = dir;
  process.env.AI_CACHE = "off";
  delete process.env.OPENROUTER_GEMINI_MAX_TOKENS;
  delete process.env.OPENROUTER_GEMINI_REASONING;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.AI_CACHE_DIR;
  delete process.env.AI_CACHE;
  delete process.env.OPENROUTER_GEMINI_MAX_TOKENS;
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
  const create = vi.fn(async (_request: { max_tokens: number }) => {
    const next = replies.shift();
    if (!next) throw new Error("llamada inesperada");
    return next;
  });
  return { client: { chat: { completions: { create } } } as unknown as Pick<OpenAI, "chat">, create };
}
const read = (client: Pick<OpenAI, "chat">) => readImageWithGeminiViaOpenRouter("aW1n", "image/jpeg", "sk-no-real", false, client);
const caps = (create: ReturnType<typeof fakeClient>["create"]) => create.mock.calls.map((call) => call[0].max_tokens);

describe("tope de salida", () => {
  it("por defecto es 16384 (antes 6144 truncaba: el razonamiento consumía casi todo) y se configura con OPENROUTER_GEMINI_MAX_TOKENS", () => {
    expect(OPENROUTER_DEFAULT_MAX_TOKENS).toBe(16384);
    expect(openRouterMaxTokens({})).toBe(16384);
    expect(openRouterMaxTokens({ OPENROUTER_GEMINI_MAX_TOKENS: "20000" })).toBe(20000);
    for (const bad of ["abc", "100", "70000", "1.5", "-1"]) expect(() => openRouterMaxTokens({ OPENROUTER_GEMINI_MAX_TOKENS: bad })).toThrow(/OPENROUTER_GEMINI_MAX_TOKENS/);
  });
  it("una lectura normal es UNA llamada con el tope por defecto", async () => {
    const { client, create } = fakeClient(reply(valid, "stop"));
    const result = await read(client);
    expect(result.requestedStudies[0]?.literalText).toBe("Hemograma");
    expect(caps(create)).toEqual([16384]);
  });
});

describe("respuesta truncada (finish_reason=length)", () => {
  it("se reintenta UNA vez con el doble de tope (nunca con el mismo) y la lectura se recupera", async () => {
    const { client, create } = fakeClient(truncated(), reply(valid, "stop", 9000));
    const result = await read(client);
    expect(result.requestedStudies).toHaveLength(1);
    expect(caps(create)).toEqual([16384, 32768]);
  });
  it("si vuelve a truncarse falla de inmediato, sin un tercer intento, con un mensaje accionable", async () => {
    const { client, create } = fakeClient(truncated(16000), truncated(32000), reply(valid, "stop"));
    await expect(read(client)).rejects.toThrow(/TRUNCADA.*OPENROUTER_GEMINI_MAX_TOKENS/s);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("si el tope ya es el máximo permitido no hay reintento inútil: falla tras la primera llamada", async () => {
    for (const cap of ["32768", "65536"]) {
      process.env.OPENROUTER_GEMINI_MAX_TOKENS = cap;
      const { client, create } = fakeClient(truncated(Number(cap)), reply(valid, "stop"));
      await expect(read(client)).rejects.toThrow(/TRUNCADA/);
      expect(create).toHaveBeenCalledTimes(1);
    }
  });
  it("con un tope inicial menor el reintento sube al doble sin pasar del máximo", async () => {
    process.env.OPENROUTER_GEMINI_MAX_TOKENS = "20000";
    const { client, create } = fakeClient(truncated(), reply(valid, "stop"));
    await read(client);
    expect(caps(create)).toEqual([20000, 32768]);
    expect(OPENROUTER_HARD_MAX_TOKENS).toBe(32768);
  });
  it("el mensaje de error indica los tokens y el tope usados, y el final del contenido", async () => {
    const { client } = fakeClient(truncated(6130), truncated(6130));
    await expect(read(client)).rejects.toThrow(/finish_reason=length, completion_tokens=6130, max_tokens=32768/);
  });
});

describe("contenido inválido que NO es truncado", () => {
  it("se reintenta una vez con el mismo tope", async () => {
    const { client, create } = fakeClient(reply("{no es json", "stop"), reply(valid, "stop"));
    await read(client);
    expect(caps(create)).toEqual([16384, 16384]);
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
