import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El comportamiento de PRODUCCIÓN no cambia mientras no se definan las banderas nuevas. Se ejercita el módulo REAL de la función de Vercel (api/kapso/webhook.ts) con el
// entorno sin ninguna bandera, con Kapso simulado y sin red.

const SECRET = "whsec-simulado-solo-para-pruebas";
const FLAGS = ["PLUSMEDIK_TURNS", "PLUSMEDIK_TEXT_HANDLER", "PLUSMEDIK_KNOWLEDGE_ANSWERS", "PLUSMEDIK_REPLY_GUARD", "PLUSMEDIK_REPLY_GUARD_CONFIG", "PLUSMEDIK_QUOTE_SESSIONS", "PLUSMEDIK_STUDY_INFO", "PLUSMEDIK_ATTENTION_FILTER", "PLUSMEDIK_ATTENTION_REPEAT_SECONDS", "PLUSMEDIK_ATTENTION_SETTLE_MS", "PLUSMEDIK_AGENT_CONTROL", "PLUSMEDIK_AGENT_CONTROL_TOKEN", "PLUSMEDIK_AGENT_CONTROL_PHONES", "PLUSMEDIK_CRM_HANDOFF", "PLUSMEDIK_CRM_REVIEW_URL", "PLUSMEDIK_CRM_REVIEW_TOKEN", "PLUSMEDIK_OUTBOX_KEY", "PLUSMEDIK_HUMAN_CONTROL", "REQUIRE_AUDIT_GUARD", "PLUSMEDIK_CONTACT_HMAC_KEY", "ALLOWED_PHONES", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "KAPSO_API_KEY", "KAPSO_PHONE_NUMBER_ID"];
const saved: Record<string, string | undefined> = {};

const sendText = vi.fn(async () => ({ messages: [{ id: "wamid.out" }] }));
vi.mock("@kapso/whatsapp-cloud-api", () => ({ WhatsAppClient: class { messages = { sendText }; media = { download: vi.fn() }; rawFetch = vi.fn(); fetch = vi.fn(); } }));
const scheduled: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({ waitUntil: (task: Promise<unknown>) => { scheduled.push(task); } }));

const post = (payload: unknown, headers: Record<string, string> = { "x-webhook-event": "whatsapp.message.received" }) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const textEvent = { message: { id: "wamid.t1", from: "59170000000", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hola" }, kapso: { direction: "inbound", origin: "cloud_api" } }, phone_number_id: "123" };

async function loadHandler() {
  vi.resetModules();
  return (await import("../api/kapso/webhook.js")) as { POST(request: Request): Promise<Response>; GET(): Response };
}

describe("valores por defecto de producción", () => {
  beforeEach(() => {
    for (const name of FLAGS) { saved[name] = process.env[name]; delete process.env[name]; }
    process.env.WEBHOOK_SECRET = SECRET;
    sendText.mockClear();
    scheduled.length = 0;
  });
  afterEach(() => {
    for (const name of FLAGS) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  });

  it("las banderas nuevas están en blanco en .env.example (apagadas) y documentadas", () => {
    const example = readFileSync(join(__dirname, "..", ".env.example"), "utf8");
    for (const name of ["PLUSMEDIK_TURNS", "PLUSMEDIK_TEXT_HANDLER", "PLUSMEDIK_KNOWLEDGE_ANSWERS", "PLUSMEDIK_REPLY_GUARD", "PLUSMEDIK_REPLY_GUARD_CONFIG", "PLUSMEDIK_QUOTE_SESSIONS", "PLUSMEDIK_STUDY_INFO", "PLUSMEDIK_ATTENTION_FILTER", "PLUSMEDIK_ATTENTION_REPEAT_SECONDS", "PLUSMEDIK_ATTENTION_SETTLE_MS", "PLUSMEDIK_AGENT_CONTROL", "PLUSMEDIK_AGENT_CONTROL_TOKEN", "PLUSMEDIK_AGENT_CONTROL_PHONES"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=\\r?$`, "m"));
    }
    // y no hay ninguna variable que habilite la derivación a una persona: está bloqueada en código
    // G5.0: la derivación al CRM tiene UNA bandera, en blanco (apagada); el resto son credenciales vacías. Nada la enciende por defecto.
    expect([...example.matchAll(/^([A-Z_]*HANDOFF[A-Z_]*)=(.*)$/gm)].map((match) => [match[1], match[2]!.trim()])).toEqual([["PLUSMEDIK_CRM_HANDOFF", ""], ["PLUSMEDIK_AGENT_HANDOFF", ""]]);
    for (const name of ["PLUSMEDIK_CRM_REVIEW_URL", "PLUSMEDIK_CRM_REVIEW_TOKEN", "PLUSMEDIK_OUTBOX_KEY"]) expect(example, name).toMatch(new RegExp(`^${name}=\\r?$`, "m"));
  });

  it("sin banderas, un texto se ignora: 200 'ignored', nada programado, nada enviado (como antes de G2)", async () => {
    const { POST } = await loadHandler();
    const response = await POST(post(textEvent));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("solo PLUSMEDIK_TURNS (sin manejador de texto): el texto sigue ignorándose; solo las imágenes pasarían por la coordinación", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    const { POST } = await loadHandler();
    const response = await POST(post(textEvent));
    expect(await response.text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
  });

  it("solo PLUSMEDIK_TEXT_HANDLER (sin turnos): no tiene efecto, el texto se ignora", async () => {
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    const { POST } = await loadHandler();
    expect(await (await POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
  });

  it("solo el valor exacto 'on' enciende una bandera ('true', '1', 'yes', 'enabled' no)", async () => {
    for (const value of ["true", "1", "yes", "enabled", "onn", ""]) {
      process.env.PLUSMEDIK_TURNS = value;
      process.env.PLUSMEDIK_TEXT_HANDLER = value;
      const { POST } = await loadHandler();
      expect(await (await POST(post(textEvent))).text(), value).toBe("ignored");
    }
    expect(scheduled).toHaveLength(0);
  });

  it("con las dos banderas pero SIN Supabase ni clave de contacto, FALLA CERRADO: el texto se programa pero no se envía nada", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.KAPSO_API_KEY = "k";
    process.env.KAPSO_PHONE_NUMBER_ID = "123";
    const { POST } = await loadHandler();
    expect(await (await POST(post(textEvent))).text()).toBe("ok");
    await Promise.allSettled(scheduled);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G3.1A: PLUSMEDIK_KNOWLEDGE_ANSWERS sola, o sin el manejador de texto, no tiene efecto: el texto se ignora y no se toca la base", async () => {
    process.env.PLUSMEDIK_KNOWLEDGE_ANSWERS = "on";
    const alone = await loadHandler();
    expect(await (await alone.POST(post(textEvent))).text()).toBe("ignored");
    process.env.PLUSMEDIK_TURNS = "on";
    const withoutHandler = await loadHandler();
    expect(await (await withoutHandler.POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G3.1A: con las tres banderas pero SIN Supabase ni clave de contacto, FALLA CERRADO (no se envía nada) y cargar el módulo no exige configuración (el servicio es perezoso)", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.PLUSMEDIK_KNOWLEDGE_ANSWERS = "on";
    process.env.KAPSO_API_KEY = "k";
    process.env.KAPSO_PHONE_NUMBER_ID = "123";
    const { POST } = await loadHandler();
    expect(await (await POST(post(textEvent))).text()).toBe("ok");
    await Promise.allSettled(scheduled);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G3.2: PLUSMEDIK_REPLY_GUARD sola, o sin el manejador de texto, no tiene efecto: el texto se ignora y no se toca la base", async () => {
    process.env.PLUSMEDIK_REPLY_GUARD = "on";
    const alone = await loadHandler();
    expect(await (await alone.POST(post(textEvent))).text()).toBe("ignored");
    process.env.PLUSMEDIK_TURNS = "on";
    const withoutHandler = await loadHandler();
    expect(await (await withoutHandler.POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G3.2: con las banderas pero SIN Supabase ni clave de contacto, FALLA CERRADO (no se envía nada)", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.PLUSMEDIK_REPLY_GUARD = "on";
    process.env.KAPSO_API_KEY = "k";
    process.env.KAPSO_PHONE_NUMBER_ID = "123";
    const { POST } = await loadHandler();
    expect(await (await POST(post(textEvent))).text()).toBe("ok");
    await Promise.allSettled(scheduled);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G3.2: una configuración inválida de la guarda deja el texto SIN responder (no se usan valores iniciales a escondidas) y avisa con un código, sin texto", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.PLUSMEDIK_REPLY_GUARD = "on";
    process.env.PLUSMEDIK_REPLY_GUARD_CONFIG = '{"rules":[]}';
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const { POST } = await loadHandler();
      expect(await (await POST(post(textEvent))).text()).toBe("ignored");
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ app: "plusmedik", event: "reply_guard_config_invalid", error: "CONFIG_RULES" });
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G4.0: PLUSMEDIK_QUOTE_SESSIONS sola, o sin el manejador de texto, no tiene efecto: el texto se ignora y no se toca la base", async () => {
    process.env.PLUSMEDIK_QUOTE_SESSIONS = "on";
    const alone = await loadHandler();
    expect(await (await alone.POST(post(textEvent))).text()).toBe("ignored");
    process.env.PLUSMEDIK_TURNS = "on";
    const withoutHandler = await loadHandler();
    expect(await (await withoutHandler.POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G6.0: PLUSMEDIK_ATTENTION_FILTER sola, o sin el manejador de texto, no tiene efecto: el texto se ignora y no se toca la base", async () => {
    process.env.PLUSMEDIK_ATTENTION_FILTER = "on";
    const alone = await loadHandler();
    expect(await (await alone.POST(post(textEvent))).text()).toBe("ignored");
    process.env.PLUSMEDIK_TURNS = "on";
    const withoutHandler = await loadHandler();
    expect(await (await withoutHandler.POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G6.0: una configuración inválida del filtro lo deja APAGADO (se procesa todo como antes) y avisa con un código, sin texto", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.PLUSMEDIK_ATTENTION_FILTER = "on";
    process.env.PLUSMEDIK_ATTENTION_SETTLE_MS = "99999";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const { POST } = await loadHandler();
      expect(await (await POST(post(textEvent))).text()).toBe("ok");
      await Promise.allSettled(scheduled);
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ app: "plusmedik", event: "attention_filter_config_invalid", error: "INVALID_SETTLE_MS" });
    // sin clave de contacto ni Supabase no se envía nada (falla cerrado), pero el filtro no la apagó ni la cambió
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G4.0: con las banderas pero SIN Supabase ni clave de contacto, FALLA CERRADO (no se envía nada)", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.PLUSMEDIK_QUOTE_SESSIONS = "on";
    process.env.KAPSO_API_KEY = "k";
    process.env.KAPSO_PHONE_NUMBER_ID = "123";
    const { POST } = await loadHandler();
    expect(await (await POST(post(textEvent))).text()).toBe("ok");
    await Promise.allSettled(scheduled);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G4.1: PLUSMEDIK_STUDY_INFO sola, sin turnos, sin manejador de texto o sin respuestas con conocimiento, no tiene efecto: el texto se ignora", async () => {
    process.env.PLUSMEDIK_STUDY_INFO = "on";
    const alone = await loadHandler();
    expect(await (await alone.POST(post(textEvent))).text()).toBe("ignored");
    process.env.PLUSMEDIK_TURNS = "on";
    const withoutHandler = await loadHandler();
    expect(await (await withoutHandler.POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G4.1: con todas las banderas pero SIN Supabase ni clave de contacto, FALLA CERRADO (no se envía nada)", async () => {
    for (const name of ["PLUSMEDIK_TURNS", "PLUSMEDIK_TEXT_HANDLER", "PLUSMEDIK_KNOWLEDGE_ANSWERS", "PLUSMEDIK_STUDY_INFO"]) process.env[name] = "on";
    process.env.KAPSO_API_KEY = "k";
    process.env.KAPSO_PHONE_NUMBER_ID = "123";
    const { POST } = await loadHandler();
    expect(await (await POST(post(textEvent))).text()).toBe("ok");
    await Promise.allSettled(scheduled);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G5.0: PLUSMEDIK_CRM_HANDOFF sola, sin turnos o sin manejador de texto, no tiene efecto: el texto se ignora y no se llama a nadie", async () => {
    process.env.PLUSMEDIK_CRM_HANDOFF = "on";
    const alone = await loadHandler();
    expect(await (await alone.POST(post(textEvent))).text()).toBe("ignored");
    process.env.PLUSMEDIK_TURNS = "on";
    const withoutHandler = await loadHandler();
    expect(await (await withoutHandler.POST(post(textEvent))).text()).toBe("ignored");
    expect(scheduled).toHaveLength(0);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("G5.0: con la bandera pero CONFIGURACIÓN INCOMPLETA la derivación sigue BLOQUEADA y se registra solo el código del defecto (nunca valores)", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    process.env.PLUSMEDIK_CRM_HANDOFF = "on";
    process.env.PLUSMEDIK_CRM_REVIEW_TOKEN = "t".repeat(40);
    process.env.PLUSMEDIK_OUTBOX_KEY = "k".repeat(40);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await loadHandler();
    } finally {
      spy.mockRestore();
    }
    const logged = lines.map((line) => JSON.parse(line));
    expect(logged).toContainEqual({ app: "plusmedik", event: "crm_handoff_config_invalid", error: "MISSING_URL" });
    expect(lines.join("")).not.toMatch(/tttt|kkkk/);
    delete process.env.PLUSMEDIK_CRM_REVIEW_TOKEN;
    delete process.env.PLUSMEDIK_OUTBOX_KEY;
  });

  it("G5.0: la ruta de reintento está INERTE: sin configuración responde 503 y no toca nada", async () => {
    const drain = (await import("../api/outbox/drain.js")) as { GET(request: Request): Promise<Response> };
    const response = await drain.GET(new Request("https://example.test/api/outbox/drain", { headers: { authorization: "Bearer cualquiera" } }));
    expect(response.status).toBe(503);
  });

  it("Fase 1: las rutas del CRM (attention/status y attention/action) están APAGADAS sin configuración: 503 sin consultar la base ni enviar nada, con cualquier cabecera", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const route of ["status", "action"] as const) {
        vi.resetModules();
        const module = (route === "status" ? await import("../api/internal/crm/attention/status.js") : await import("../api/internal/crm/attention/action.js")) as { POST(request: Request): Promise<Response> };
        const response = await module.POST(new Request(`https://agente.example.test/api/internal/crm/attention/${route}`, { method: "POST", headers: { authorization: "Bearer cualquiera", "content-type": "application/json" }, body: "{}" }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ ok: false, available: false, error: "not_configured" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(sendText).not.toHaveBeenCalled();
  });

  it("Fase 1: PLUSMEDIK_AGENT_CONTROL=on sin token válido deja las rutas apagadas (503) y avisa con un CÓDIGO, nunca con el valor", async () => {
    process.env.PLUSMEDIK_AGENT_CONTROL = "on";
    process.env.PLUSMEDIK_AGENT_CONTROL_TOKEN = "demasiado-corto";
    process.env.KAPSO_PHONE_NUMBER_ID = "123";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      vi.resetModules();
      const module = (await import("../api/internal/crm/attention/action.js")) as { POST(request: Request): Promise<Response> };
      const response = await module.POST(new Request("https://agente.example.test/api/internal/crm/attention/action", { method: "POST", headers: { authorization: "Bearer demasiado-corto", "content-type": "application/json" }, body: "{}" }));
      expect(response.status).toBe(503);
    } finally {
      spy.mockRestore();
      delete process.env.PLUSMEDIK_AGENT_CONTROL;
      delete process.env.PLUSMEDIK_AGENT_CONTROL_TOKEN;
    }
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ app: "plusmedik", event: "crm_attention_config_invalid", error: "INVALID_TOKEN" });
    expect(lines.join("")).not.toContain("demasiado-corto");
  });

  it("Fase 1: configuradas pero con el control de atención humana APAGADO, las rutas no mutan: status available:false y action no confirma", async () => {
    process.env.PLUSMEDIK_AGENT_CONTROL = "on";
    process.env.PLUSMEDIK_AGENT_CONTROL_TOKEN = "token-de-prueba-solo-para-tests-0123456789";
    process.env.KAPSO_PHONE_NUMBER_ID = "123456789012345";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      vi.resetModules();
      const status = (await import("../api/internal/crm/attention/status.js")) as { POST(request: Request): Promise<Response> };
      const action = (await import("../api/internal/crm/attention/action.js")) as { POST(request: Request): Promise<Response> };
      const headers = { authorization: "Bearer token-de-prueba-solo-para-tests-0123456789", "content-type": "application/json" };
      const one = await status.POST(new Request("https://agente.example.test/api/internal/crm/attention/status", { method: "POST", headers, body: JSON.stringify({ contactPhone: "59170000000", phoneNumberId: "123456789012345" }) }));
      expect(await one.json()).toEqual({ ok: true, available: false, reason: "control_disabled" });
      const two = await action.POST(new Request("https://agente.example.test/api/internal/crm/attention/action", { method: "POST", headers, body: JSON.stringify({ operationId: "op-valido-0001", action: "pause", contactPhone: "59170000000", phoneNumberId: "123456789012345", reasonCode: "CRM_MANUAL_PAUSE", actor: "crm:system" }) }));
      expect(await two.json()).toEqual({ ok: true, available: false, confirmed: false, reason: "control_disabled" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      delete process.env.PLUSMEDIK_AGENT_CONTROL;
      delete process.env.PLUSMEDIK_AGENT_CONTROL_TOKEN;
    }
  });

  it("Fase 2.3: la lista de contactos autorizados, sola o mal formada, no enciende nada: sin PLUSMEDIK_AGENT_CONTROL=on las rutas siguen en 503 y una lista inválida avisa con un CÓDIGO, nunca con los números", async () => {
    const listed = "59170000123";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const request = (route: string) => new Request(`https://agente.example.test/api/internal/crm/attention/${route}`, { method: "POST", headers: { authorization: "Bearer token-de-prueba-solo-para-tests-0123456789", "content-type": "application/json" }, body: "{}" });
    try {
      // 1) solo la lista (la funcionalidad sigue apagada): 503 y ni se mira la petición
      process.env.PLUSMEDIK_AGENT_CONTROL_PHONES = listed;
      process.env.PLUSMEDIK_CONTACT_HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
      process.env.KAPSO_PHONE_NUMBER_ID = "123456789012345";
      vi.resetModules();
      const off = (await import("../api/internal/crm/attention/status.js")) as { POST(request: Request): Promise<Response> };
      expect((await off.POST(request("status"))).status).toBe(503);
      // 2) lista mal formada con la funcionalidad encendida: 503 y un código de aviso
      process.env.PLUSMEDIK_AGENT_CONTROL = "on";
      process.env.PLUSMEDIK_AGENT_CONTROL_TOKEN = "token-de-prueba-solo-para-tests-0123456789";
      process.env.PLUSMEDIK_AGENT_CONTROL_PHONES = `${listed},esto-no-es-un-numero`;
      vi.resetModules();
      const invalid = (await import("../api/internal/crm/attention/action.js")) as { POST(request: Request): Promise<Response> };
      expect((await invalid.POST(request("action"))).status).toBe(503);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      fetchSpy.mockRestore();
      for (const name of ["PLUSMEDIK_AGENT_CONTROL", "PLUSMEDIK_AGENT_CONTROL_TOKEN", "PLUSMEDIK_AGENT_CONTROL_PHONES"]) delete process.env[name];
    }
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({ app: "plusmedik", event: "crm_attention_config_invalid", error: "INVALID_SCOPE" });
    expect(lines.join("")).not.toContain(listed);
    expect(lines.join("")).not.toContain("esto-no-es-un-numero");
  });

  it("firma inválida: 401 en cualquier configuración", async () => {
    process.env.PLUSMEDIK_TURNS = "on";
    process.env.PLUSMEDIK_TEXT_HANDLER = "on";
    const { POST } = await loadHandler();
    const request = new Request("https://example.test/api/kapso/webhook", { method: "POST", body: JSON.stringify(textEvent), headers: { "x-webhook-signature": "0".repeat(64) } });
    expect((await POST(request)).status).toBe(401);
    expect(scheduled).toHaveLength(0);
  });

  it("las banderas del motor de recetas no cambiaron respecto de origin/main (semántico, AUTO, parcial y manuscrito ya validado)", () => {
    const source = readFileSync(join(__dirname, "..", "api", "kapso", "webhook.ts"), "utf8");
    expect(source).toContain('const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;');
  });
});
