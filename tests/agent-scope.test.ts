import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El alcance REAL del agente según el entorno, leído del módulo de producción (api/kapso/webhook.ts): quién usa la ruta de turnos, si las fotos instantáneas y el tope funcionan con la puerta del
// piloto apagada, y la advertencia cuando el tope no cubriría a todos. Kapso simulado, sin red.

vi.mock("@kapso/whatsapp-cloud-api", () => ({ WhatsAppClient: class { messages = { sendText: vi.fn() }; media = { download: vi.fn() }; rawFetch = vi.fn(); fetch = vi.fn(); } }));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));

const NAMES = ["PLUSMEDIK_TURNS", "PLUSMEDIK_TEXT_HANDLER", "PLUSMEDIK_QUOTE_SESSIONS", "PLUSMEDIK_INSTANT_PHOTO_QUOTES", "PLUSMEDIK_DAILY_REPLY_CAP", "PLUSMEDIK_DAILY_REPLY_CAP_MAX", "PLUSMEDIK_DAILY_REPLY_CAP_HOURS", "PLUSMEDIK_TEXT_PILOT_GUARD", "PLUSMEDIK_TEXT_PILOT_EXTRA_PHONES", "PLUSMEDIK_AGENT_CONTROL_PHONES", "ALLOWED_PHONES", "PLUSMEDIK_HUMAN_CONTROL", "PLUSMEDIK_REPLY_GUARD", "PLUSMEDIK_KNOWLEDGE_ANSWERS", "PLUSMEDIK_LLM_CONVERSATION", "PLUSMEDIK_CONVERSATION_MEMORY", "PLUSMEDIK_SMART_QUOTES"];
const saved: Record<string, string | undefined> = {};
const BASE = { PLUSMEDIK_TURNS: "on", PLUSMEDIK_TEXT_HANDLER: "on", PLUSMEDIK_QUOTE_SESSIONS: "on", PLUSMEDIK_INSTANT_PHOTO_QUOTES: "on", PLUSMEDIK_DAILY_REPLY_CAP: "on" };

async function scope(env: Record<string, string>) {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, env);
  const lines: Array<Record<string, any>> = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    try { lines.push(JSON.parse(String(line))); } catch { /* otras líneas */ }
  });
  vi.resetModules();
  await import("../api/kapso/webhook.js");
  spy.mockRestore();
  return { scope: lines.find((line) => line.event === "agent_scope"), events: lines.map((line) => line.event as string), lines };
}

describe("alcance del agente según el entorno", () => {
  beforeEach(() => { for (const name of NAMES) saved[name] = process.env[name]; });
  afterEach(() => { for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

  it("abierto a todos (sin puerta del piloto ni ALLOWED_PHONES): turnos para todos, fotos instantáneas y tope activos, sin advertencias", async () => {
    const { scope: s, events } = await scope(BASE);
    expect(s).toMatchObject({ turns: true, textHandler: true, pilotGate: false, allContactsOnTurns: true, allowedPhonesRestricted: false, dailyCap: true, instantPhotoQuotes: true });
    expect(events).not.toContain("daily_cap_partial_scope");
    expect(events).not.toContain("daily_reply_cap_config_invalid");
  });

  it("piloto (puerta encendida y válida): solo el piloto usa los turnos y se advierte que el tope no cubre a los demás", async () => {
    const { scope: s, events } = await scope({ ...BASE, PLUSMEDIK_TEXT_PILOT_GUARD: "on", PLUSMEDIK_AGENT_CONTROL_PHONES: "59172654203", ALLOWED_PHONES: "59172654203" });
    expect(s).toMatchObject({ turns: true, pilotGate: true, allContactsOnTurns: false, allowedPhonesRestricted: true, dailyCap: true, instantPhotoQuotes: true });
    expect(events).toContain("daily_cap_partial_scope");
  });

  it("piloto sin tope: sin advertencia", async () => {
    const { scope: s, events } = await scope({ ...BASE, PLUSMEDIK_DAILY_REPLY_CAP: "", PLUSMEDIK_TEXT_PILOT_GUARD: "on", PLUSMEDIK_AGENT_CONTROL_PHONES: "59172654203" });
    expect(s).toMatchObject({ pilotGate: true, dailyCap: false });
    expect(events).not.toContain("daily_cap_partial_scope");
  });

  it("las fotos instantáneas son opt-in: sin su bandera, abierto a todos no se activan", async () => {
    const { scope: s } = await scope({ ...BASE, PLUSMEDIK_INSTANT_PHOTO_QUOTES: "" });
    expect(s).toMatchObject({ allContactsOnTurns: true, instantPhotoQuotes: false });
  });

  it("sin turnos no hay tope ni alcance de turnos, y se registra el motivo", async () => {
    const { scope: s, events, lines } = await scope({ ...BASE, PLUSMEDIK_TURNS: "" });
    expect(s).toMatchObject({ turns: false, allContactsOnTurns: false, dailyCap: false });
    expect(lines.find((line) => line.event === "daily_reply_cap_config_invalid")).toMatchObject({ error: "TURNS_REQUIRED" });
    expect(events).not.toContain("daily_cap_partial_scope");
  });

  it("puerta del piloto mal configurada: falla cerrado (los turnos se apagan para todos)", async () => {
    const { scope: s } = await scope({ ...BASE, PLUSMEDIK_TEXT_PILOT_GUARD: "on" });
    expect(s).toMatchObject({ turns: false, pilotGate: true, allContactsOnTurns: false, dailyCap: false });
  });

  it("el control humano global se refleja en el registro", async () => {
    expect((await scope({ ...BASE, PLUSMEDIK_HUMAN_CONTROL: "on" })).scope).toMatchObject({ humanControl: true });
    expect((await scope(BASE)).scope).toMatchObject({ humanControl: false });
  });

  it("el registro de alcance no incluye números de teléfono ni valores de variables", async () => {
    const { lines } = await scope({ ...BASE, PLUSMEDIK_TEXT_PILOT_GUARD: "on", PLUSMEDIK_AGENT_CONTROL_PHONES: "59172654203", ALLOWED_PHONES: "59172654203" });
    expect(JSON.stringify(lines)).not.toMatch(/5917265|\d{9,}/);
  });
});
