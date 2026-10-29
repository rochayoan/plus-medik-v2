import { describe, expect, it, vi } from "vitest";
import { AuditWriteError } from "../src/audit.js";
import { createCrmAttentionRepository, handleCrmAttention, MIN_TOKEN_LENGTH, resolveCrmAttention, type CrmControlConfig, type CrmAttentionDeps, type CrmAttentionRepository } from "../src/crm-attention.js";
import { contactKeyOf } from "../src/human-control.js";

// Control de atención desde el CRM (Fase 1): contrato del endpoint con un repositorio SIMULADO. La garantía real contra PostgreSQL está en tests/crm-attention-db.test.ts y de extremo a
// extremo en tests/crm-attention-e2e.test.ts. Los valores son de PRUEBA (no hay credenciales ni teléfonos reales).

const TOKEN = "token-de-prueba-solo-para-tests-0123456789";
const OTHER_TOKEN = "otro-token-de-prueba-0123456789-abcdefgh";
const LAB = "123456789012345";
const HMAC = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const PHONE = "59170000000";
const OP = "5d1c3d54-8e0c-4a1f-9a8b-2f6f7d7a1e11";
const KEY = contactKeyOf({ hmacKey: HMAC, labPhoneNumberId: LAB, contactPhone: PHONE })!;

const config = (over: Partial<CrmControlConfig> = {}): CrmControlConfig => ({ token: TOKEN, labPhoneNumberId: LAB, hmacKey: HMAC, controlReady: true, humanControl: true, scope: undefined, ...over });

function fakeRepository(over: Partial<CrmAttentionRepository> = {}) {
  const repo = {
    status: vi.fn(async () => ({ state: "ACTIVE" as const, revision: 4, exists: true })),
    act: vi.fn(async (input: Parameters<CrmAttentionRepository["act"]>[0]) => ({ outcome: input.action === "pause" ? ("PAUSED" as const) : ("RESUMED" as const), state: input.action === "pause" ? ("HUMAN_PAUSED" as const) : ("ACTIVE" as const), revision: 5, replayed: false })),
    ...over
  };
  return repo as typeof repo & CrmAttentionRepository;
}

function setup(options: { config?: CrmControlConfig | undefined; repo?: CrmAttentionRepository; repositoryThrows?: boolean } = {}) {
  const repo = options.repo ?? fakeRepository();
  const logs: Array<[string, Record<string, unknown>]> = [];
  const deps: CrmAttentionDeps = {
    config: "config" in options ? options.config : config(),
    repository: () => {
      if (options.repositoryThrows) throw new Error("Supabase audit configuration is required");
      return repo;
    },
    log: (event, data) => logs.push([event, data])
  };
  return { repo: repo as ReturnType<typeof fakeRepository>, deps, logs };
}

const url = (route: string) => `https://agente.example.test/api/internal/crm/attention/${route}`;
const statusBody = { contactPhone: PHONE, phoneNumberId: LAB };
const actionBody = (over: Record<string, unknown> = {}) => ({ operationId: OP, action: "pause", contactPhone: PHONE, phoneNumberId: LAB, reasonCode: "CRM_MANUAL_PAUSE", actor: "crm:3f2a9c", ...over });
function request(route: "status" | "action", body: unknown, init: { token?: string | null; headers?: Record<string, string>; method?: string; url?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }), ...init.headers };
  return new Request(init.url ?? url(route), { method: init.method ?? "POST", headers, ...(init.method === "GET" ? {} : { body: init.raw ?? JSON.stringify(body) }) });
}
const read = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, any> });

// Lo que el CRM entiende de la respuesta (réplica de CRM-PLUSMEDIK/src/lib/agent-attention.ts): sin esto no da nada por confirmado.
const crmReadsStatus = (b: Record<string, any>) => b.ok === true && b.available === true && (b.state === "ACTIVE" || b.state === "HUMAN_PAUSED") && Number.isInteger(b.revision) && b.revision >= 0;
const crmReadsAction = (b: Record<string, any>) => b.ok === true && b.confirmed === true && (b.state === "ACTIVE" || b.state === "HUMAN_PAUSED") && Number.isInteger(b.revision) && b.revision >= 0;

describe("configuración: apagada por defecto", () => {
  const env = { PLUSMEDIK_AGENT_CONTROL: "on", PLUSMEDIK_AGENT_CONTROL_TOKEN: TOKEN, KAPSO_PHONE_NUMBER_ID: LAB, PLUSMEDIK_HUMAN_CONTROL: "on", PLUSMEDIK_CONTACT_HMAC_KEY: HMAC };
  it("sin la bandera exacta no hay nada, aunque haya token", () => {
    expect(resolveCrmAttention({})).toEqual({ enabled: false });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_AGENT_CONTROL: "true" })).toEqual({ enabled: false });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_AGENT_CONTROL: "" })).toEqual({ enabled: false });
    expect(resolveCrmAttention({ PLUSMEDIK_AGENT_CONTROL_TOKEN: TOKEN })).toEqual({ enabled: false });
  });
  it("con la bandera exige un token exclusivo válido y el número del laboratorio; un fallo deja un CÓDIGO, nunca el valor", () => {
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_AGENT_CONTROL_TOKEN: undefined })).toEqual({ enabled: true, error: "MISSING_TOKEN" });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_AGENT_CONTROL_TOKEN: "corto" })).toEqual({ enabled: true, error: "INVALID_TOKEN" });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_AGENT_CONTROL_TOKEN: `${"x".repeat(MIN_TOKEN_LENGTH)} y` })).toEqual({ enabled: true, error: "INVALID_TOKEN" });
    expect(resolveCrmAttention({ ...env, KAPSO_PHONE_NUMBER_ID: " " })).toEqual({ enabled: true, error: "MISSING_PHONE_NUMBER_ID" });
  });
  it("controlReady exige el control de atención humana encendido Y una clave HMAC válida; sin eso no se muta nada", () => {
    expect(resolveCrmAttention(env)).toMatchObject({ enabled: true, config: { controlReady: true, labPhoneNumberId: LAB } });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_HUMAN_CONTROL: undefined })).toMatchObject({ config: { controlReady: false } });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_HUMAN_CONTROL: "off" })).toMatchObject({ config: { controlReady: false } });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_CONTACT_HMAC_KEY: "corta" })).toMatchObject({ config: { controlReady: false } });
    expect(resolveCrmAttention({ ...env, PLUSMEDIK_CONTACT_HMAC_KEY: undefined })).toMatchObject({ config: { controlReady: false } });
  });
});

describe("apagado o mal configurado: ni se mira la petición ni se toca la base", () => {
  it.each(["status", "action"] as const)("%s responde 503 not_configured sin consultar el repositorio, con cualquier token", async (route) => {
    const w = setup({ config: undefined });
    for (const init of [{}, { token: null }, { token: "otro" }]) {
      const out = await read(await handleCrmAttention(request(route, route === "status" ? statusBody : actionBody(), init), route, w.deps));
      expect(out).toEqual({ status: 503, body: { ok: false, available: false, error: "not_configured" } });
    }
    expect(w.repo.status).not.toHaveBeenCalled();
    expect(w.repo.act).not.toHaveBeenCalled();
  });
});

describe("autenticación y límites de la llamada", () => {
  it.each(["status", "action"] as const)("%s: solo POST", async (route) => {
    const w = setup();
    const out = await handleCrmAttention(request(route, {}, { method: "GET" }), route, w.deps);
    expect(out.status).toBe(405);
    expect(out.headers.get("allow")).toBe("POST");
  });

  it.each([
    ["sin cabecera", { token: null }],
    ["token equivocado", { token: OTHER_TOKEN }],
    ["token de otra longitud", { token: "x" }],
    ["token vacío", { token: "" }],
    ["esquema distinto de Bearer", { token: null, headers: { authorization: `Basic ${TOKEN}` } }],
    ["token con espacio", { token: null, headers: { authorization: `Bearer ${TOKEN} extra` } }],
    ["token en el cuerpo (no en la cabecera)", { token: null }]
  ])("401 por %s, sin tocar la base", async (_name, init) => {
    const w = setup();
    const out = await read(await handleCrmAttention(request("action", { ...actionBody(), token: TOKEN }, init), "action", w.deps));
    expect(out).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(w.repo.act).not.toHaveBeenCalled();
    expect(w.repo.status).not.toHaveBeenCalled();
  });

  it("solo HTTPS (salvo localhost), según la URL o x-forwarded-proto", async () => {
    const w = setup();
    expect((await handleCrmAttention(request("status", statusBody, { url: "http://agente.example.test/api/internal/crm/attention/status" }), "status", w.deps)).status).toBe(403);
    expect((await handleCrmAttention(request("status", statusBody, { headers: { "x-forwarded-proto": "http" } }), "status", w.deps)).status).toBe(403);
    expect((await handleCrmAttention(request("status", statusBody, { url: "http://localhost:3000/api/internal/crm/attention/status" }), "status", w.deps)).status).toBe(200);
    expect((await handleCrmAttention(request("status", statusBody, { headers: { "x-forwarded-proto": "https" } }), "status", w.deps)).status).toBe(200);
  });

  it("no acepta llamadas de un navegador (Origin / Sec-Fetch-Site)", async () => {
    const w = setup();
    const browserHeaders: Array<Record<string, string>> = [{ origin: "https://crm.example.test" }, { "sec-fetch-site": "cross-site" }, { origin: "https://crm.example.test", "sec-fetch-mode": "cors" }];
    for (const headers of browserHeaders) {
      expect(await read(await handleCrmAttention(request("status", statusBody, { headers }), "status", w.deps))).toEqual({ status: 403, body: { ok: false, error: "browser_not_allowed" } });
    }
    expect(w.repo.status).not.toHaveBeenCalled();
  });

  it("permite fetch de Node.js con Sec-Fetch-Mode: cors, pero sigue exigiendo Bearer", async () => {
    const w = setup();
    const headers = { "sec-fetch-mode": "cors" };
    expect(await read(await handleCrmAttention(request("status", statusBody, { headers }), "status", w.deps))).toEqual({ status: 200, body: { ok: true, available: true, state: "ACTIVE", revision: 4 } });
    expect(w.repo.status).toHaveBeenCalledTimes(1);
    expect(await read(await handleCrmAttention(request("status", statusBody, { headers, token: OTHER_TOKEN }), "status", w.deps))).toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(w.repo.status).toHaveBeenCalledTimes(1);
  });

  it("cuerpo: JSON obligatorio, tamaño acotado, objeto, forma exacta", async () => {
    const w = setup();
    const post = async (route: "status" | "action", body: unknown, init = {}) => (await handleCrmAttention(request(route, body, init), route, w.deps)).status;
    expect(await post("status", statusBody, { headers: { "content-type": "text/plain" } })).toBe(415);
    expect(await post("status", null, { raw: "{no es json" })).toBe(400);
    expect(await post("status", [statusBody])).toBe(400);
    expect(await post("status", "texto")).toBe(400);
    expect(await post("status", { ...statusBody, nota: "x".repeat(5000) })).toBe(413);
    expect(await post("status", { ...statusBody, reason: "paciente molesto" })).toBe(400);
    expect(await post("status", { contactPhone: PHONE })).toBe(400);
    expect(await post("action", { ...actionBody(), reason: "texto libre del motivo" })).toBe(400);
    const { operationId: _omitted, ...withoutOperation } = actionBody();
    expect(await post("action", withoutOperation)).toBe(400);
    expect(w.repo.status).not.toHaveBeenCalled();
    expect(w.repo.act).not.toHaveBeenCalled();
  });
});

describe("validación de teléfono y phoneNumberId", () => {
  it.each([["corto", "12345"], ["con letras", "5917000abcd"], ["con espacios", "591 7000 0000"], ["demasiado largo", "5917000000012345678"], ["vacío", ""], ["no es texto", 59170000000], ["con guion", "591-70000000"]])("teléfono %s → 400", async (_name, phone) => {
    const w = setup();
    for (const route of ["status", "action"] as const) {
      const body = route === "status" ? { ...statusBody, contactPhone: phone } : actionBody({ contactPhone: phone });
      expect((await read(await handleCrmAttention(request(route, body), route, w.deps))).status).toBe(400);
    }
    expect(w.repo.status).not.toHaveBeenCalled();
    expect(w.repo.act).not.toHaveBeenCalled();
  });

  it("phoneNumberId de otro número del laboratorio → 403 sin tocar la base; sin texto o no textual → 400", async () => {
    const w = setup();
    for (const route of ["status", "action"] as const) {
      const body = (id: unknown) => (route === "status" ? { ...statusBody, phoneNumberId: id } : actionBody({ phoneNumberId: id }));
      expect(await read(await handleCrmAttention(request(route, body("999999999999999")), route, w.deps))).toEqual({ status: 403, body: { ok: false, error: "phone_number_mismatch" } });
      expect((await handleCrmAttention(request(route, body("")), route, w.deps)).status).toBe(400);
      expect((await handleCrmAttention(request(route, body(Number(LAB))), route, w.deps)).status).toBe(400);
    }
    expect(w.repo.status).not.toHaveBeenCalled();
    expect(w.repo.act).not.toHaveBeenCalled();
  });

  it("el contact_key se calcula AQUÍ con el HMAC; «+591…» y «591…» son el mismo contacto; otro teléfono es otro contacto", async () => {
    const w = setup();
    await handleCrmAttention(request("status", { ...statusBody, contactPhone: `+${PHONE}` }), "status", w.deps);
    await handleCrmAttention(request("status", statusBody), "status", w.deps);
    await handleCrmAttention(request("status", { ...statusBody, contactPhone: "59171111111" }), "status", w.deps);
    expect((w.repo.status as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0])).toEqual([KEY, KEY, contactKeyOf({ hmacKey: HMAC, labPhoneNumberId: LAB, contactPhone: "59171111111" })]);
    expect(KEY).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("validación de la acción", () => {
  it.each([
    ["acción desconocida", { action: "delete" }],
    ["acción en mayúsculas", { action: "PAUSE" }],
    ["motivo que no corresponde (pausar con el de reactivar)", { reasonCode: "CRM_MANUAL_RESUME" }],
    ["motivo libre", { reasonCode: "el paciente pidió esperar" }],
    ["sin motivo", { reasonCode: undefined }],
    ["actor sin el prefijo crm:", { actor: "juan" }],
    ["actor con correo", { actor: "crm:juan@gmail.com" }],
    ["actor vacío", { actor: "crm:" }],
    ["operationId corto", { operationId: "corto" }],
    ["operationId con espacios", { operationId: "op con espacios 123" }],
    ["operationId no textual", { operationId: 12345678 }]
  ])("%s → 400 y no se llama a la base", async (_name, over) => {
    const w = setup();
    expect((await read(await handleCrmAttention(request("action", actionBody(over)), "action", w.deps))).status).toBe(400);
    expect(w.repo.act).not.toHaveBeenCalled();
  });

  it("reactivar exige su propio motivo (CRM_MANUAL_RESUME)", async () => {
    const w = setup();
    expect((await handleCrmAttention(request("action", actionBody({ action: "resume" })), "action", w.deps)).status).toBe(400);
    expect((await handleCrmAttention(request("action", actionBody({ action: "resume", reasonCode: "CRM_MANUAL_RESUME" })), "action", w.deps)).status).toBe(200);
  });
});

describe("control de atención no operativo: no se muta ni se inventa un estado", () => {
  it("status responde available:false y action no confirma; la base no se toca", async () => {
    const w = setup({ config: config({ controlReady: false }) });
    const status = await read(await handleCrmAttention(request("status", statusBody), "status", w.deps));
    expect(status).toEqual({ status: 200, body: { ok: true, available: false, reason: "control_disabled" } });
    expect(crmReadsStatus(status.body)).toBe(false);
    const action = await read(await handleCrmAttention(request("action", actionBody()), "action", w.deps));
    expect(action).toEqual({ status: 200, body: { ok: true, available: false, confirmed: false, reason: "control_disabled" } });
    expect(crmReadsAction(action.body)).toBe(false);
    expect(w.repo.status).not.toHaveBeenCalled();
    expect(w.repo.act).not.toHaveBeenCalled();
  });
  it("aun así valida la forma antes: una petición mal formada sigue siendo 400", async () => {
    const w = setup({ config: config({ controlReady: false }) });
    expect((await handleCrmAttention(request("action", actionBody({ action: "x" })), "action", w.deps)).status).toBe(400);
  });
});

describe("estado real y acciones", () => {
  it("status refleja el estado y la revisión del agente, y el CRM lo entiende", async () => {
    const w = setup({ repo: fakeRepository({ status: vi.fn(async () => ({ state: "HUMAN_PAUSED" as const, revision: 7, exists: true })) }) });
    const out = await read(await handleCrmAttention(request("status", statusBody), "status", w.deps));
    expect(out).toEqual({ status: 200, body: { ok: true, available: true, state: "HUMAN_PAUSED", revision: 7 } });
    expect(crmReadsStatus(out.body)).toBe(true);
  });

  it("un contacto que nunca habló es ACTIVE con revisión 0 (no se inventa pausa)", async () => {
    const w = setup({ repo: fakeRepository({ status: vi.fn(async () => ({ state: "ACTIVE" as const, revision: 0, exists: false })) }) });
    const out = await read(await handleCrmAttention(request("status", statusBody), "status", w.deps));
    expect(out.body).toEqual({ ok: true, available: true, state: "ACTIVE", revision: 0 });
    expect(crmReadsStatus(out.body)).toBe(true);
  });

  it("pausar: pasa operación, acción, contacto HMAC, motivo codificado y actor al repositorio; confirma con el estado real", async () => {
    const w = setup();
    const out = await read(await handleCrmAttention(request("action", actionBody()), "action", w.deps));
    expect(w.repo.act).toHaveBeenCalledWith({ operationId: OP, action: "pause", contactKey: KEY, reasonCode: "CRM_MANUAL_PAUSE", actor: "crm:3f2a9c" });
    expect(out).toEqual({ status: 200, body: { ok: true, confirmed: true, state: "HUMAN_PAUSED", revision: 5, outcome: "PAUSED", replayed: false } });
    expect(crmReadsAction(out.body)).toBe(true);
  });

  it("reactivar y repetir una operación ya confirmada (replayed) devuelven confirmed:true con el resultado guardado", async () => {
    const repo = fakeRepository({ act: vi.fn(async () => ({ outcome: "ALREADY_ACTIVE" as const, state: "ACTIVE" as const, revision: 3, replayed: true })) });
    const w = setup({ repo });
    const out = await read(await handleCrmAttention(request("action", actionBody({ action: "resume", reasonCode: "CRM_MANUAL_RESUME", actor: "crm:system" })), "action", w.deps));
    expect(out.body).toEqual({ ok: true, confirmed: true, state: "ACTIVE", revision: 3, outcome: "ALREADY_ACTIVE", replayed: true });
    expect(crmReadsAction(out.body)).toBe(true);
  });

  it("la respuesta no es cacheable y nunca incluye el contact_key, el teléfono ni el token", async () => {
    const w = setup();
    const responses = [await handleCrmAttention(request("status", statusBody), "status", w.deps), await handleCrmAttention(request("action", actionBody()), "action", w.deps)];
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("fallos: una confirmación incierta NUNCA devuelve confirmed:true", () => {
  it.each([["resultado desconocido", new AuditWriteError("UNKNOWN_OUTCOME")], ["rechazo", new AuditWriteError("REJECTED", 422)], ["error cualquiera", new Error("conexión rechazada con el teléfono 59170000000")]])("action: %s → 503 sin confirmar", async (_name, error) => {
    const w = setup({ repo: fakeRepository({ act: vi.fn(async () => { throw error; }) }) });
    const out = await read(await handleCrmAttention(request("action", actionBody()), "action", w.deps));
    expect(out).toEqual({ status: 503, body: { ok: false, confirmed: false, error: "unavailable" } });
    expect(crmReadsAction(out.body)).toBe(false);
    // y el texto del error (que podría traer datos) no llega al registro
    expect(JSON.stringify(w.logs)).not.toContain("59170000000");
    expect(JSON.stringify(w.logs)).not.toContain("conexión");
  });

  it("action: un operationId reutilizado para otra operación → 409 sin confirmar", async () => {
    const w = setup({ repo: fakeRepository({ act: vi.fn(async () => { throw new AuditWriteError("CONFLICT", 409); }) }) });
    const out = await read(await handleCrmAttention(request("action", actionBody()), "action", w.deps));
    expect(out).toEqual({ status: 409, body: { ok: false, confirmed: false, error: "operation_conflict" } });
  });

  it("status: sin base o con error → 503 available:false (no se inventa un estado)", async () => {
    const w = setup({ repo: fakeRepository({ status: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }) });
    const out = await read(await handleCrmAttention(request("status", statusBody), "status", w.deps));
    expect(out).toEqual({ status: 503, body: { ok: false, available: false, error: "unavailable" } });
    expect(crmReadsStatus(out.body)).toBe(false);
  });

  it("si el repositorio no se puede crear (Supabase sin configurar) → 503, no una excepción sin controlar", async () => {
    const w = setup({ repositoryThrows: true });
    expect((await handleCrmAttention(request("status", statusBody), "status", w.deps)).status).toBe(503);
    expect((await handleCrmAttention(request("action", actionBody()), "action", w.deps)).status).toBe(503);
  });
});

describe("registro: solo códigos", () => {
  it("no se registra el token, el teléfono, el contact_key, el operationId, el actor ni el motivo", async () => {
    const w = setup();
    await handleCrmAttention(request("status", statusBody), "status", w.deps);
    await handleCrmAttention(request("action", actionBody()), "action", w.deps);
    await handleCrmAttention(request("action", actionBody(), { token: OTHER_TOKEN }), "action", w.deps);
    const text = JSON.stringify(w.logs);
    for (const secret of [TOKEN, OTHER_TOKEN, PHONE, KEY, OP, "crm:3f2a9c", "CRM_MANUAL_PAUSE", HMAC]) expect(text).not.toContain(secret);
    expect(w.logs).toContainEqual(["crm_attention", { route: "action", action: "pause", outcome: "PAUSED", replayed: false }]);
  });
});

describe("el repositorio traduce la RPC y NUNCA da por confirmado algo inesperado", () => {
  function repoWith(responder: (name: string, body: Record<string, unknown>) => { status: number; json?: unknown }) {
    const calls: Array<{ name: string; body: Record<string, any> }> = [];
    const fetchFn = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const name = String(input).split("/rpc/")[1]!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ name, body });
      const answer = responder(name, body);
      return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status, headers: { "content-type": "application/json" } });
    });
    const repository = createCrmAttentionRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: fetchFn as unknown as typeof fetch, retryDelayMs: 0, requestTimeoutMs: 2000 });
    return { repository, calls, fetchFn };
  }
  const input = { operationId: OP, action: "pause" as const, contactKey: KEY, reasonCode: "CRM_MANUAL_PAUSE", actor: "crm:system" };

  it("envía solo códigos y el contacto HMAC a plusmedik_attention_crm_action", async () => {
    const { repository, calls } = repoWith(() => ({ status: 200, json: { outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2, replayed: false } }));
    expect(await repository.act(input)).toEqual({ outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2, replayed: false });
    expect(calls).toEqual([{ name: "plusmedik_attention_crm_action", body: { p_operation_id: OP, p_action: "pause", p_contact_key: KEY, p_reason: "CRM_MANUAL_PAUSE", p_actor: "crm:system" } }]);
    expect(JSON.stringify(calls)).not.toContain(PHONE);
  });

  it.each([
    ["resultado de otra acción", { outcome: "RESUMED", state: "ACTIVE", revision: 2, replayed: false }],
    ["estado que no corresponde", { outcome: "PAUSED", state: "ACTIVE", revision: 2, replayed: false }],
    ["revisión negativa", { outcome: "PAUSED", state: "HUMAN_PAUSED", revision: -1, replayed: false }],
    ["revisión no entera", { outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 1.5, replayed: false }],
    ["sin bandera de repetición", { outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2 }],
    ["respuesta vacía", {}]
  ])("%s → se trata como fallo, no como confirmación", async (_name, json) => {
    const { repository } = repoWith(() => ({ status: 200, json }));
    await expect(repository.act(input)).rejects.toMatchObject({ kind: "REJECTED" });
  });

  it("reactivar acepta ALREADY_ACTIVE y RESUMED, y rechaza los resultados de pausar", async () => {
    const resume = { ...input, action: "resume" as const, reasonCode: "CRM_MANUAL_RESUME" };
    const ok = repoWith(() => ({ status: 200, json: { outcome: "ALREADY_ACTIVE", state: "ACTIVE", revision: 0, replayed: true } }));
    expect(await ok.repository.act(resume)).toMatchObject({ outcome: "ALREADY_ACTIVE", state: "ACTIVE", revision: 0, replayed: true });
    const bad = repoWith(() => ({ status: 200, json: { outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2, replayed: false } }));
    await expect(bad.repository.act(resume)).rejects.toMatchObject({ kind: "REJECTED" });
  });

  it("409 de la base (operationId reutilizado) → CONFLICT; 5xx repetido → UNKNOWN_OUTCOME tras UN reintento idéntico (idempotente)", async () => {
    expect(await repoWith(() => ({ status: 409 })).repository.act(input).catch((error) => error)).toMatchObject({ kind: "CONFLICT" });
    const down = repoWith(() => ({ status: 503 }));
    await expect(down.repository.act(input)).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });
    expect(down.calls).toHaveLength(2);
    expect(down.calls[0]).toEqual(down.calls[1]);
  });

  it("status usa la RPC existente de estado", async () => {
    const { repository, calls } = repoWith(() => ({ status: 200, json: { exists: true, state: "HUMAN_PAUSED", revision: 9 } }));
    expect(await repository.status(KEY)).toEqual({ state: "HUMAN_PAUSED", revision: 9, exists: true });
    expect(calls).toEqual([{ name: "plusmedik_attention_status", body: { p_contact_key: KEY } }]);
  });
});
