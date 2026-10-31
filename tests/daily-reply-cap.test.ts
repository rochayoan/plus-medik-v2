import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, type AuditClaim, type AuditLease, type AuditRepository } from "../src/audit.js";
import { DAILY_REPLY_CAP_DEFAULTS, resolveDailyReplyCap } from "../src/daily-reply-cap.js";
import { createTextHandler } from "../src/text-handler.js";
import { processTurns, type IncomingTurn } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// Tope de respuestas por contacto: configuración, cableado hasta la RPC y comportamiento del turno. Todo con dobles. La garantía real (conteo, ventana, simultaneidad) está en
// tests/daily-reply-cap-db.test.ts contra PostgreSQL.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const log = () => undefined;

describe("resolveDailyReplyCap", () => {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const record = (event: string, data: Record<string, unknown>) => logs.push([event, data]);

  it("está apagado por defecto y con cualquier valor distinto de «on»", () => {
    for (const value of [undefined, "", "off", "true", "1", "5"]) expect(resolveDailyReplyCap({ PLUSMEDIK_DAILY_REPLY_CAP: value }, record, { turnsActive: true })).toBeUndefined();
  });

  it("con «on» son 5 respuestas cada 24 horas", () => {
    expect(resolveDailyReplyCap({ PLUSMEDIK_DAILY_REPLY_CAP: "on" }, record, { turnsActive: true })).toEqual({ max: 5, windowSeconds: 86_400 });
    expect(DAILY_REPLY_CAP_DEFAULTS).toEqual({ max: 5, windowSeconds: 86_400 });
  });

  it("acepta máximo y horas propios", () => {
    expect(resolveDailyReplyCap({ PLUSMEDIK_DAILY_REPLY_CAP: "on", PLUSMEDIK_DAILY_REPLY_CAP_MAX: "10", PLUSMEDIK_DAILY_REPLY_CAP_HOURS: "12" }, record, { turnsActive: true })).toEqual({ max: 10, windowSeconds: 43_200 });
  });

  it("falla cerrado (apagado) con configuración inválida y registra solo un código", () => {
    logs.length = 0;
    const on = { PLUSMEDIK_DAILY_REPLY_CAP: "on" };
    expect(resolveDailyReplyCap(on, record, { turnsActive: false })).toBeUndefined();
    expect(resolveDailyReplyCap({ ...on, PLUSMEDIK_DAILY_REPLY_CAP_MAX: "0" }, record, { turnsActive: true })).toBeUndefined();
    expect(resolveDailyReplyCap({ ...on, PLUSMEDIK_DAILY_REPLY_CAP_MAX: "cinco" }, record, { turnsActive: true })).toBeUndefined();
    expect(resolveDailyReplyCap({ ...on, PLUSMEDIK_DAILY_REPLY_CAP_HOURS: "169" }, record, { turnsActive: true })).toBeUndefined();
    expect(logs.map(([, data]) => data.error)).toEqual(["TURNS_REQUIRED", "INVALID_MAX", "INVALID_MAX", "INVALID_HOURS"]);
  });
});

describe("el repositorio llama a la reserva con tope", () => {
  function repository(status = "reserved") {
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      calls.push({ name: String(input).split("/rpc/")[1]!, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ status }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { repo: createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn, retryDelayMs: 0 }), calls };
  }

  it("con tope usa plusmedik_turn_reserve_send_capped, con la guarda de bucles si la hay", async () => {
    const { repo, calls } = repository();
    expect(await repo.reserveSend("run-1", "quoted", LEASE, { stale: "NONE", cap: { max: 5, windowSeconds: 86_400 } })).toBe("reserved");
    expect(calls[0]!.name).toBe("plusmedik_turn_reserve_send_capped");
    expect(calls[0]!.body).toMatchObject({ p_kind: "quoted", p_stale_policy: "NONE", p_guard: null, p_cap: { max: 5, windowSeconds: 86_400 } });
    await repo.reserveSend("run-2", "conversation", LEASE, { stale: "NEWER_TURN", guard: { config: { rules: [] } as never, signature: "GREETING" }, cap: { max: 5, windowSeconds: 86_400 } });
    expect(calls[1]!.body.p_guard).toMatchObject({ signature: "GREETING" });
  });

  it("el estado «limited» llega como «limited» (no se envía)", async () => {
    const { repo } = repository("limited");
    expect(await repo.reserveSend("run-1", "conversation", LEASE, { stale: "NONE", cap: { max: 5, windowSeconds: 86_400 } })).toBe("limited");
  });

  it("sin tope las llamadas son las de siempre", async () => {
    const { repo, calls } = repository();
    await repo.reserveSend("run-1", "conversation", LEASE, { stale: "NONE" });
    await repo.reserveSend("run-2", "conversation", LEASE);
    expect(calls.map((call) => call.name)).toEqual(["plusmedik_turn_reserve_send", "plusmedik_audit_reserve_send"]);
  });
});

describe("el turno respeta el tope", () => {
  function setup(options: { reservation?: string; cap?: { max: number; windowSeconds: number } | null } = {}) {
    let n = 0;
    const audit = {
      claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })),
      renewLease: vi.fn(async () => true), recordIgnored: vi.fn(async () => undefined), recordEvidence: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined),
      reserveSend: vi.fn(async (): Promise<string> => options.reservation ?? "reserved"), confirmSend: vi.fn(async (): Promise<string> => "proceed"), recordReply: vi.fn(async () => undefined)
    };
    const sends: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const deps: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array() })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => { throw new Error("no se usa"); }),
      sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: "wamid.out" }; }),
      log: (event, data) => logs.push([event, data]),
      audit: audit as unknown as AuditRepository,
      leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor: () => KEY, busyRetries: 1, busyDelayMs: 1, sleep: async () => undefined, handlers: { text: createTextHandler({ log }) }, ...(options.cap === null ? {} : { dailyCap: options.cap ?? { max: 5, windowSeconds: 86_400 } }) }
    };
    const turn = (id: string): IncomingTurn => ({ messageId: id, from: "59170000000", kind: "TEXT", text: "no entiendo bien esto" });
    return { deps, audit, sends, logs, turn };
  }

  it("pasa el tope a la reserva de cada respuesta y envía mientras la base lo permite", async () => {
    const w = setup();
    await processTurns([w.turn("t1")], w.deps);
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, expect.objectContaining({ stale: "NEWER_TURN", cap: { max: 5, windowSeconds: 86_400 } }));
    expect(w.sends).toHaveLength(1);
  });

  it("al alcanzar el tope (la base responde «limited») no se envía nada y queda registrado", async () => {
    const w = setup({ reservation: "limited" });
    const reports = await processTurns([w.turn("t1")], w.deps);
    expect(w.sends).toEqual([]);
    expect(reports[0]!.result).toBe("ignored");
    expect(w.audit.confirmSend).not.toHaveBeenCalled();
    expect(w.logs.some(([event, data]) => event === "reply_withheld" && data.reason === "limited")).toBe(true);
  });

  it("sin tope configurado la reserva es la de siempre (sin la opción cap)", async () => {
    const w = setup({ cap: null });
    await processTurns([w.turn("t1")], w.deps);
    expect(w.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
  });

  it("también se aplica a las respuestas de fotografías (cotizaciones)", async () => {
    const w = setup({ reservation: "limited" });
    w.deps.analyze = vi.fn(async () => ({ decision: "AUTO_SAFE", outcome: "AUTO_COMPLETE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], publicQuote: { studies: [{ name: "X", priceBs: 1 }], totalBs: 1, totalLabel: "Total" } }) as never);
    w.deps.downloadImage = vi.fn(async () => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]) }));
    await processTurns([{ messageId: "img1", from: "59170000000", kind: "IMAGE", mediaId: "m" }], w.deps);
    expect(w.audit.reserveSend).toHaveBeenCalledWith(expect.anything(), expect.anything(), LEASE, expect.objectContaining({ cap: { max: 5, windowSeconds: 86_400 } }));
    expect(w.sends).toEqual([]);
  });
});

describe("fronteras (análisis estático)", () => {
  const code = (file: string) => readFileSync(join(__dirname, "..", file), "utf8").replaceAll("\r\n", "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("el módulo de configuración es puro: sin red, base de datos, entorno propio ni teléfonos", () => {
    expect(code("src/daily-reply-cap.ts")).not.toMatch(/\bfetch\s*\(|process\.env|supabase|\.rpc|phone|from "openai"/i);
  });

  it("la migración solo agrega una función: no crea tablas ni toca las existentes y no menciona el CRM ni a las recepcionistas", () => {
    const sql = code("supabase/migrations/20261106000000_plusmedik_daily_reply_cap.sql");
    expect(sql).not.toMatch(/create table|alter table|drop |delete from|insert into|truncate/i);
    expect([...sql.matchAll(/create or replace function public\.([a-z_]+)/gi)].map((m) => m[1])).toEqual(["plusmedik_turn_reserve_send_capped"]);
  });

  it("el webhook lee el tope solo de la bandera y lo entrega a los turnos (no a la ruta anterior de fotos)", () => {
    const webhook = code("api/kapso/webhook.ts");
    expect(webhook).toMatch(/const dailyReplyCap = resolveDailyReplyCap\(process\.env, logLine, \{ turnsActive: turnsEnabled \}\);/);
    expect(webhook).toMatch(/dailyCap: dailyReplyCap/);
  });
});
