import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import type { AuditClaim, AuditRepository } from "../src/audit.js";
import { handleCrmAttention, MAX_SCOPED_PHONES, parseScopedPhones, resolveCrmAttention, resolveScopedContactControl, type CrmAttentionDeps, type CrmAttentionRepository, type CrmControlConfig } from "../src/crm-attention.js";
import { contactKeyOf } from "../src/human-control.js";
import { handleImageMessage, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";

// CONTROL ACOTADO (Fase 2.3): el control manual del CRM puede operar sobre una lista explícita de contactos SIN encender PLUSMEDIK_HUMAN_CONTROL. Aquí se prueba, sin base real, que (a) la
// configuración se resuelve como se documenta en cada combinación de banderas, (b) las rutas rechazan a cualquier contacto fuera de la lista antes de tocar la base, y (c) el flujo del webhook
// cambia SOLO para los contactos de la lista: los demás conservan el flujo anterior, incluso cuando Supabase falla.

const TOKEN = "token-de-prueba-solo-para-tests-0123456789";
const HMAC = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const OP = "5d1c3d54-8e0c-4a1f-9a8b-2f6f7d7a1e11";
const LISTED = "59170000001";
const OTHER = "59170000002";
const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  PLUSMEDIK_AGENT_CONTROL: "on", PLUSMEDIK_AGENT_CONTROL_TOKEN: TOKEN, KAPSO_PHONE_NUMBER_ID: LAB, PLUSMEDIK_CONTACT_HMAC_KEY: HMAC, PLUSMEDIK_AGENT_CONTROL_PHONES: LISTED, ...over
});
const keyOf = (phone: string) => contactKeyOf({ hmacKey: HMAC, labPhoneNumberId: LAB, contactPhone: phone });

describe("PLUSMEDIK_AGENT_CONTROL_PHONES: lista explícita", () => {
  it("ausente o en blanco = sin lista; una o varias entradas válidas = lista (con o sin +, con espacios)", () => {
    expect(parseScopedPhones(undefined)).toEqual({ kind: "unset" });
    expect(parseScopedPhones("")).toEqual({ kind: "unset" });
    expect(parseScopedPhones("   ")).toEqual({ kind: "unset" });
    expect(parseScopedPhones(LISTED)).toEqual({ kind: "list", phones: new Set([LISTED]) });
    expect(parseScopedPhones(` +${LISTED} , ${OTHER} `)).toEqual({ kind: "list", phones: new Set([LISTED, OTHER]) });
  });
  it("cualquier entrada mal formada invalida TODA la lista (nunca se adivina a quién se autoriza)", () => {
    for (const bad of ["abc", `${LISTED},`, `,${LISTED}`, `${LISTED},,${OTHER}`, `${LISTED} ${OTHER}`, "1234567", "1234567890123456", `${LISTED};${OTHER}`, "*", `${LISTED},59 170000002`, "+", "59170000001x"]) {
      expect(parseScopedPhones(bad), bad).toEqual({ kind: "invalid" });
    }
  });
  it(`tiene un tope de ${MAX_SCOPED_PHONES} números (es un control temporal de prueba, no una lista de clientes)`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, index) => `5917000${String(1000 + index)}`).join(",");
    expect(parseScopedPhones(many(MAX_SCOPED_PHONES)).kind).toBe("list");
    expect(parseScopedPhones(many(MAX_SCOPED_PHONES + 1))).toEqual({ kind: "invalid" });
  });
});

describe("resolveCrmAttention: cada combinación de banderas", () => {
  it("apagado por defecto: sin PLUSMEDIK_AGENT_CONTROL=on la lista no hace nada", () => {
    expect(resolveCrmAttention({ PLUSMEDIK_AGENT_CONTROL_PHONES: LISTED })).toEqual({ enabled: false });
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL: "off" }))).toEqual({ enabled: false });
    expect(resolveScopedContactControl({ PLUSMEDIK_AGENT_CONTROL_PHONES: LISTED, PLUSMEDIK_CONTACT_HMAC_KEY: HMAC, KAPSO_PHONE_NUMBER_ID: LAB })).toBeUndefined();
  });
  it("lista válida SIN control humano global: operativo y acotado", () => {
    const resolution = resolveCrmAttention(env());
    expect(resolution).toMatchObject({ enabled: true, config: { controlReady: true, humanControl: false, labPhoneNumberId: LAB } });
    expect((resolution as { config: CrmControlConfig }).config.scope).toEqual(new Set([LISTED]));
  });
  it("sin lista y sin control humano: NO opera (como en la Fase 1)", () => {
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: undefined }))).toMatchObject({ config: { controlReady: false, humanControl: false, scope: undefined } });
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: "" }))).toMatchObject({ config: { controlReady: false, scope: undefined } });
  });
  it("control humano global sin lista: opera sobre todos los contactos (comportamiento de la Fase 1)", () => {
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: undefined, PLUSMEDIK_HUMAN_CONTROL: "on" }))).toMatchObject({ config: { controlReady: true, humanControl: true, scope: undefined } });
  });
  it("control humano global CON lista: la lista solo restringe a quién puede operar el CRM", () => {
    const resolution = resolveCrmAttention(env({ PLUSMEDIK_HUMAN_CONTROL: "on" })) as { config: CrmControlConfig };
    expect(resolution.config).toMatchObject({ controlReady: true, humanControl: true });
    expect(resolution.config.scope).toEqual(new Set([LISTED]));
  });
  it("sin una clave HMAC válida no opera, con o sin lista", () => {
    expect(resolveCrmAttention(env({ PLUSMEDIK_CONTACT_HMAC_KEY: undefined }))).toMatchObject({ config: { controlReady: false } });
    expect(resolveCrmAttention(env({ PLUSMEDIK_CONTACT_HMAC_KEY: "corta" }))).toMatchObject({ config: { controlReady: false } });
    expect(resolveScopedContactControl(env({ PLUSMEDIK_CONTACT_HMAC_KEY: "corta" }))).toBeUndefined();
  });
  it("una lista mal formada deja la funcionalidad en 'mal configurada' (503), también con control humano", () => {
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: "no-es-un-numero" }))).toEqual({ enabled: true, error: "INVALID_SCOPE" });
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: `${LISTED},x`, PLUSMEDIK_HUMAN_CONTROL: "on" }))).toEqual({ enabled: true, error: "INVALID_SCOPE" });
    expect(resolveScopedContactControl(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: "no-es-un-numero" }))).toBeUndefined();
  });
  it("el token y el número del laboratorio siguen siendo obligatorios (los errores existentes tienen prioridad)", () => {
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_TOKEN: undefined }))).toEqual({ enabled: true, error: "MISSING_TOKEN" });
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_TOKEN: "corto" }))).toEqual({ enabled: true, error: "INVALID_TOKEN" });
    expect(resolveCrmAttention(env({ KAPSO_PHONE_NUMBER_ID: " " }))).toEqual({ enabled: true, error: "MISSING_PHONE_NUMBER_ID" });
  });
});

describe("resolveScopedContactControl: a quién cubre el webhook", () => {
  it("solo existe en el modo acotado: lista válida, control operativo y SIN control humano global", () => {
    expect(resolveScopedContactControl(env())).toBeDefined();
    expect(resolveScopedContactControl(env({ PLUSMEDIK_HUMAN_CONTROL: "on" }))).toBeUndefined(); // con control global ya se cubre a todos por la vía existente
    expect(resolveScopedContactControl(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: undefined }))).toBeUndefined();
    expect(resolveScopedContactControl({})).toBeUndefined();
  });
  it("cubre exactamente a los números de la lista, sea cual sea su formato de escritura, y a nadie más", () => {
    const scoped = resolveScopedContactControl(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: `+${LISTED}, ${OTHER}` }))!;
    for (const phone of [LISTED, `+${LISTED}`, `${LISTED.slice(0, 3)} ${LISTED.slice(3)}`, OTHER]) expect(scoped.covers(phone), phone).toBe(true);
    for (const phone of ["59170000003", "5917000000", "159170000001", "", "abc", LISTED.slice(1), `${LISTED}9`]) expect(scoped.covers(phone), phone).toBe(false);
  });
});

// ───────────────────────────── rutas HTTP ─────────────────────────────

function route(over: { config?: CrmControlConfig | undefined; repo?: Partial<CrmAttentionRepository> } = {}) {
  const repo = {
    status: vi.fn(async () => ({ state: "ACTIVE" as const, revision: 4, exists: true })),
    act: vi.fn(async (input: Parameters<CrmAttentionRepository["act"]>[0]) => ({ outcome: input.action === "pause" ? ("PAUSED" as const) : ("RESUMED" as const), state: input.action === "pause" ? ("HUMAN_PAUSED" as const) : ("ACTIVE" as const), revision: 5, replayed: false })),
    ...over.repo
  };
  const logs: Array<[string, Record<string, unknown>]> = [];
  const resolution = resolveCrmAttention(env());
  const config = "config" in over ? over.config : (resolution as { config: CrmControlConfig }).config;
  const repository = vi.fn(() => repo as CrmAttentionRepository);
  const deps: CrmAttentionDeps = { config, repository, log: (event, data) => { logs.push([event, data]); } };
  const call = async (which: "status" | "action", body: Record<string, unknown>, token: string | null = TOKEN) => {
    const response = await handleCrmAttention(new Request(`https://agente.example.test/api/internal/crm/attention/${which}`, { method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }), which, deps);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const status = (phone: string) => call("status", { contactPhone: phone, phoneNumberId: LAB });
  const act = (phone: string, action: "pause" | "resume" = "pause") => call("action", { operationId: OP, action, contactPhone: phone, phoneNumberId: LAB, reasonCode: action === "pause" ? "CRM_MANUAL_PAUSE" : "CRM_MANUAL_RESUME", actor: "crm:prueba" });
  return { repo, repository, logs, status, act, call };
}

describe("rutas del CRM en modo acotado", () => {
  it("un contacto de la lista se consulta, se pausa y se reactiva", async () => {
    const r = route();
    expect(await r.status(LISTED)).toEqual({ status: 200, body: { ok: true, available: true, state: "ACTIVE", revision: 4 } });
    expect(await r.act(LISTED, "pause")).toMatchObject({ status: 200, body: { ok: true, confirmed: true, state: "HUMAN_PAUSED" } });
    expect(await r.act(`+${LISTED}`, "resume")).toMatchObject({ status: 200, body: { confirmed: true, state: "ACTIVE" } });
    expect(r.repo.status).toHaveBeenCalledWith(keyOf(LISTED));
    expect(r.repo.act).toHaveBeenCalledTimes(2);
  });
  it("un contacto fuera de la lista recibe 403 y NO se toca la base: ni se crea el repositorio ni se calcula su clave", async () => {
    const r = route();
    expect(await r.status(OTHER)).toEqual({ status: 403, body: { ok: false, available: false, error: "contact_not_authorized" } });
    expect(await r.act(OTHER, "pause")).toEqual({ status: 403, body: { ok: false, confirmed: false, error: "contact_not_authorized" } });
    expect(r.repository).not.toHaveBeenCalled();
    expect(r.repo.status).not.toHaveBeenCalled();
    expect(r.repo.act).not.toHaveBeenCalled();
    expect(r.logs.filter(([event]) => event === "crm_attention").map(([, data]) => data.outcome)).toEqual(["CONTACT_NOT_AUTHORIZED", "CONTACT_NOT_AUTHORIZED"]);
    expect(JSON.stringify(r.logs)).not.toContain(OTHER);
  });
  it("la autorización por lista va DESPUÉS de la autenticación: sin token válido nadie sabe si un número está o no en la lista", async () => {
    const r = route();
    expect((await r.call("status", { contactPhone: OTHER, phoneNumberId: LAB }, "token-equivocado-0123456789-0123456789")).status).toBe(401);
    expect((await r.call("status", { contactPhone: LISTED, phoneNumberId: LAB }, "token-equivocado-0123456789-0123456789")).status).toBe(401);
    expect((await r.call("status", { contactPhone: OTHER, phoneNumberId: LAB }, null)).status).toBe(401);
    // y una petición mal formada o con otro phoneNumberId sigue siendo 400 / 403 phone_number_mismatch, igual que antes
    expect((await r.call("status", { contactPhone: "abc", phoneNumberId: LAB })).status).toBe(400);
    expect(await r.call("status", { contactPhone: LISTED, phoneNumberId: "999" })).toEqual({ status: 403, body: { ok: false, error: "phone_number_mismatch" } });
    expect(r.repository).not.toHaveBeenCalled();
  });
  it("sin lista (control humano global) el comportamiento es el de la Fase 1: todos los contactos operan", async () => {
    const r = route({ config: (resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: undefined, PLUSMEDIK_HUMAN_CONTROL: "on" })) as { config: CrmControlConfig }).config });
    expect((await r.status(OTHER)).status).toBe(200);
    expect((await r.act(OTHER)).body.confirmed).toBe(true);
  });
  it("con la lista pero sin clave HMAC válida: el contacto autorizado recibe 'control deshabilitado' sin mutar nada", async () => {
    const r = route({ config: (resolveCrmAttention(env({ PLUSMEDIK_CONTACT_HMAC_KEY: undefined })) as { config: CrmControlConfig }).config });
    expect(await r.status(LISTED)).toEqual({ status: 200, body: { ok: true, available: false, reason: "control_disabled" } });
    expect(await r.act(LISTED)).toEqual({ status: 200, body: { ok: true, available: false, confirmed: false, reason: "control_disabled" } });
    expect(r.repository).not.toHaveBeenCalled();
  });
  it("si Supabase falla, el contacto autorizado recibe 503 sin confirmar nada (y uno no autorizado ni llega a la base)", async () => {
    const down = async () => { throw new Error("fetch failed"); };
    const r = route({ repo: { status: vi.fn(down), act: vi.fn(down) } });
    expect(await r.status(LISTED)).toEqual({ status: 503, body: { ok: false, available: false, error: "unavailable" } });
    expect(await r.act(LISTED)).toEqual({ status: 503, body: { ok: false, confirmed: false, error: "unavailable" } });
    expect((await r.act(OTHER)).status).toBe(403);
    expect(r.repo.act).toHaveBeenCalledTimes(1);
  });
  it("lista mal formada o funcionalidad apagada: 503 sin mirar la petición", async () => {
    expect(resolveCrmAttention(env({ PLUSMEDIK_AGENT_CONTROL_PHONES: "x" }))).toEqual({ enabled: true, error: "INVALID_SCOPE" });
    const r = route({ config: undefined });
    expect(await r.status(LISTED)).toEqual({ status: 503, body: { ok: false, available: false, error: "not_configured" } });
    expect(r.repository).not.toHaveBeenCalled();
  });
});

// ───────────────────────────── flujo del webhook (fotos) ─────────────────────────────

const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const claimed = (): AuditClaim => ({ kind: "claimed", runId: "run-1", lease: { owner: "o", fence: 1 }, takeover: false });
let sequence = 0;
const image = (from: string): IncomingImage => ({ messageId: `wamid.${++sequence}`, from, mediaId: "m1" });

function world(over: { audit?: Partial<AuditRepository>; scoped?: boolean; humanControl?: boolean; turns?: boolean; requireAuditGuard?: boolean } = {}) {
  const sends: string[] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const audit = {
    claim: vi.fn(async () => claimed()),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => "reserved" as const),
    confirmSend: vi.fn(async () => "proceed" as const),
    recordReply: vi.fn(async () => undefined),
    ...over.audit
  } as unknown as AuditRepository & { claim: ReturnType<typeof vi.fn> };
  const contactKeyFor = (phone: string) => keyOf(phone);
  const scoped = resolveScopedContactControl(env());
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => okAnalysis()),
    sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }),
    log: (event, data) => { logs.push([event, data]); },
    audit, leaseRenewIntervalMs: 3_600_000,
    ...(over.requireAuditGuard ? { requireAuditGuard: true } : {}),
    ...(over.scoped === false ? {} : { scopedControl: { contactKeyFor, covers: scoped!.covers } }),
    ...(over.humanControl ? { humanControl: { contactKeyFor } } : {}),
    ...(over.turns ? { turns: { contactKeyFor } } : {})
  };
  return { deps, audit, sends, logs, run: (from: string) => handleImageMessage(image(from), deps) };
}

describe("webhook en modo acotado: solo cambia el flujo de los contactos de la lista", () => {
  it("contacto de la lista: el claim lleva su clave de contacto y se responde", async () => {
    const w = world();
    expect(await w.run(LISTED)).toBe("quoted");
    expect(w.audit.claim).toHaveBeenCalledTimes(1);
    expect(w.audit.claim.mock.calls[0]![1]).toEqual({ contactKey: keyOf(LISTED) });
    expect(w.sends).toHaveLength(1);
    expect(w.audit.reserveSend).toHaveBeenCalled();
    expect(w.audit.confirmSend).toHaveBeenCalled();
  });
  it("contacto fuera de la lista: el claim es EXACTAMENTE el de antes (un solo argumento, sin clave de contacto) y se responde", async () => {
    const w = world();
    expect(await w.run(OTHER)).toBe("quoted");
    expect(w.audit.claim.mock.calls[0]).toHaveLength(1);
    expect(JSON.stringify(w.audit.claim.mock.calls)).not.toContain(keyOf(OTHER)!);
    expect(w.sends).toHaveLength(1);
  });
  it("sin el modo acotado el contacto de la lista tampoco usa clave (todo es como antes)", async () => {
    const w = world({ scoped: false });
    await w.run(LISTED);
    expect(w.audit.claim.mock.calls[0]).toHaveLength(1);
    expect(w.sends).toHaveLength(1);
  });
  it("si el claim falla (Supabase caído): el contacto de la lista NO recibe respuesta (falla cerrado)", async () => {
    const w = world({ audit: { claim: vi.fn(async () => { throw new Error("fetch failed"); }) } });
    expect(await w.run(LISTED)).toBe("ignored");
    expect(w.sends).toHaveLength(0);
    expect(w.deps.analyze).not.toHaveBeenCalled();
    expect(w.logs.some(([event, data]) => event === "reply_withheld" && data.reason === "audit_guard_unavailable")).toBe(true);
  });
  it("si el claim falla (Supabase caído): el contacto fuera de la lista conserva la política anterior y se responde igual", async () => {
    const w = world({ audit: { claim: vi.fn(async () => { throw new Error("fetch failed"); }) } });
    expect(await w.run(OTHER)).toBe("quoted");
    expect(w.sends).toHaveLength(1);
    // sin auditoría no hay reserva ni comprobación: exactamente lo que ocurría antes de esta función
    expect(w.audit.reserveSend).not.toHaveBeenCalled();
    expect(w.logs.some(([event]) => event === "reply_withheld")).toBe(false);
  });
  it("la pausa se respeta SOLO para el contacto de la lista: el claim devuelve 'duplicado por pausa' y no se procesa; el otro contacto no se entera", async () => {
    const paused: AuditClaim = { kind: "duplicate", processingStatus: "IGNORED", reason: "HUMAN_PAUSED" } as AuditClaim;
    const claim = vi.fn(async (_image: unknown, options?: { contactKey?: string }) => (options?.contactKey === keyOf(LISTED) ? paused : claimed()));
    const w = world({ audit: { claim } });
    expect(await w.run(LISTED)).toBe("ignored");
    expect(await w.run(OTHER)).toBe("quoted");
    expect(w.sends).toHaveLength(1);
    expect(w.deps.analyze).toHaveBeenCalledTimes(1);
  });
  it("si la reserva falla o se deniega por pausa, el contacto de la lista no recibe respuesta", async () => {
    for (const reserve of [async () => "blocked" as const, async () => { throw new Error("fetch failed"); }]) {
      const w = world({ audit: { reserveSend: vi.fn(reserve) as AuditRepository["reserveSend"] } });
      expect(await w.run(LISTED)).toBe("ignored");
      expect(w.sends).toHaveLength(0);
    }
  });
  it("la comprobación final de la pausa también aplica solo a la lista: si ya se pausó, se libera y no se envía", async () => {
    const w = world({ audit: { confirmSend: vi.fn(async () => "blocked" as const) as AuditRepository["confirmSend"] } });
    expect(await w.run(LISTED)).toBe("ignored");
    expect(w.sends).toHaveLength(0);
    // (que un contacto SIN clave nunca quede pausado lo decide la base, porque su corrida no lleva contact_key: ver tests/crm-scope-e2e.test.ts)
  });
  it("no se reduce ninguna garantía existente: con el control humano global o con turnos el contacto no listado también usa clave (la ruta de siempre) y el modo acotado no interviene", async () => {
    const human = world({ humanControl: true });
    await human.run(OTHER);
    expect(human.audit.claim.mock.calls[0]![1]).toEqual({ contactKey: keyOf(OTHER) });
    const turns = world({ turns: true });
    await turns.run(OTHER);
    expect(turns.audit.claim.mock.calls[0]![1]).toMatchObject({ contactKey: keyOf(OTHER), turnKind: "IMAGE" });
    // y REQUIRE_AUDIT_GUARD sigue impidiendo responder sin claim para todos
    const guard = world({ requireAuditGuard: true, audit: { claim: vi.fn(async () => { throw new Error("fetch failed"); }) } });
    expect(await guard.run(OTHER)).toBe("ignored");
    expect(guard.sends).toHaveLength(0);
  });
  it("sin clave de contacto calculable el contacto de la lista no recibe respuesta (nunca se responde a un contacto que no se puede identificar)", async () => {
    const w = world();
    w.deps.scopedControl = { contactKeyFor: () => undefined, covers: () => true };
    expect(await handleImageMessage(image(LISTED), w.deps)).toBe("ignored");
    expect(w.sends).toHaveLength(0);
    expect(w.audit.claim).not.toHaveBeenCalled();
    expect(w.logs.some(([event, data]) => event === "reply_withheld" && data.reason === "contact_unidentified")).toBe(true);
  });
});
