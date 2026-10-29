import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { AuditWriteError, createSupabaseAuditRepository, type AuditClaim, type AuditLease, type AuditRepository } from "../src/audit.js";
import { extractIncomingTurns, processTurns, type IncomingTurn, type TurnHandlers } from "../src/turns.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";

// G2.1 sin base de datos: identificación de mensajes entrantes de texto y política de 'busy' agotado. La garantía real contra PostgreSQL está en
// tests/turn-recovery-db.test.ts y tests/text-conversation-e2e.test.ts.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;
const turn = (overrides: Partial<IncomingTurn> & { messageId: string }): IncomingTurn => ({ from: "59170000000", kind: "TEXT", text: "hola", ...overrides });

function fakeAudit(overrides: Record<string, unknown> = {}) {
  const repo = {
    claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: "run-1", lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async (): Promise<string> => "reserved"),
    confirmSend: vi.fn(async (): Promise<string> => "proceed"),
    recordReply: vi.fn(async () => undefined),
    releaseTurn: vi.fn(async () => undefined),
    ...overrides
  };
  return repo as unknown as AuditRepository & { [K in keyof typeof repo]: (typeof repo)[K] };
}

function setup(options: { audit: ReturnType<typeof fakeAudit>; handlers: TurnHandlers }) {
  const sends: Array<[string, string]> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => okAnalysis()),
    sendText: vi.fn(async (to: string, body: string) => { sends.push([to, body]); return { providerMessageId: "wamid.out" }; }),
    log: (event, data) => logs.push([event, data]),
    audit: options.audit,
    leaseRenewIntervalMs: 3_600_000,
    turns: { contactKeyFor: () => KEY, busyRetries: 2, busyDelayMs: 1, sleep: async () => undefined, handlers: options.handlers }
  };
  return { deps, sends, audit: options.audit, logged: (name: string) => logs.filter(([event]) => event === name).map(([, data]) => data) };
}

describe("extractIncomingTurns: qué mensajes de texto son realmente entrantes y actuales", () => {
  const NOW = 1_800_000_000;
  const msg = (message: Record<string, unknown>) => ({ message: { id: "wamid.1", from: "59170000000", timestamp: String(NOW - 5), kapso: { direction: "inbound", origin: "cloud_api" }, ...message } });
  const text = (extra: Record<string, unknown> = {}) => msg({ type: "text", text: { body: "hola" }, ...extra });
  const options = { nowSeconds: NOW, maxAgeSeconds: 600 };

  it("un texto reciente de un evento 'received' es un turno (también sin cabecera de evento)", () => {
    expect(extractIncomingTurns(text(), null, { ...options, eventName: "whatsapp.message.received" })).toMatchObject([{ kind: "TEXT", text: "hola" }]);
    expect(extractIncomingTurns(text(), null, options)).toHaveLength(1);
  });

  it("eventos que no son 'received' (enviado, entregado, leído, fallido, de conversación) no generan turnos de texto ni de otros tipos", () => {
    for (const eventName of ["whatsapp.message.sent", "whatsapp.message.delivered", "whatsapp.message.read", "whatsapp.message.failed", "whatsapp.conversation.created"]) {
      expect(extractIncomingTurns(text(), null, { ...options, eventName }), eventName).toEqual([]);
      expect(extractIncomingTurns(msg({ type: "audio" }), null, { ...options, eventName }), eventName).toEqual([]);
    }
  });

  it("un mensaje importado del historial (history_sync) nunca es un turno de texto ni de otro tipo", () => {
    expect(extractIncomingTurns(text({ kapso: { direction: "inbound", origin: "history_sync" } }), null, options)).toEqual([]);
    expect(extractIncomingTurns(msg({ type: "audio", kapso: { direction: "inbound", origin: "history_sync" } }), null, options)).toEqual([]);
  });

  it("un texto viejo, del futuro lejano o sin instante conocido no se contesta", () => {
    expect(extractIncomingTurns(text({ timestamp: String(NOW - 601) }), null, options)).toEqual([]);
    expect(extractIncomingTurns(text({ timestamp: String(NOW - 600) }), null, options)).toHaveLength(1);
    expect(extractIncomingTurns(text({ timestamp: String(NOW + 3600) }), null, options)).toEqual([]);
    expect(extractIncomingTurns(text({ timestamp: undefined }), null, options)).toEqual([]);
    expect(extractIncomingTurns(text({ timestamp: "no-es-un-numero" }), null, options)).toEqual([]);
  });

  it("las IMÁGENES no cambian: ni el historial, ni el evento, ni la antigüedad las filtran", () => {
    const image = (extra: Record<string, unknown>) => msg({ type: "image", image: { id: "m1" }, ...extra });
    const stale = { timestamp: String(NOW - 99_999) };
    expect(extractIncomingTurns(image({ ...stale, kapso: { direction: "inbound", origin: "history_sync" } }), null, { ...options, eventName: "whatsapp.message.sent" })).toMatchObject([{ kind: "IMAGE" }]);
    expect(extractIncomingTurns(image({ timestamp: undefined }), null, options)).toMatchObject([{ kind: "IMAGE" }]);
  });

  it("sin opciones el extractor se comporta como en G2.0 (el filtro es opt-in)", () => {
    expect(extractIncomingTurns(msg({ type: "text", text: { body: "hola" }, timestamp: "1000" }))).toHaveLength(1);
  });

  it("un lote se filtra mensaje por mensaje", () => {
    const batch = { batch: true, data: [text({ id: "fresh" }), text({ id: "old", timestamp: String(NOW - 5000) }), text({ id: "hist", kapso: { direction: "inbound", origin: "history_sync" } })] };
    expect(extractIncomingTurns(batch, "true", { ...options, eventName: "whatsapp.message.received" }).map((t) => t.messageId)).toEqual(["fresh"]);
  });
});

describe("modo turnos: 'busy' agotado deja el turno RECUPERABLE y sin envíos", () => {
  const handlers: TurnHandlers = { text: async () => ({ body: "respuesta" }) };

  it("se libera el turno (BUSY_TIMEOUT) con su propio lease; no se confirma, no se envía y no se registra respuesta", async () => {
    const releaseTurn = vi.fn(async () => undefined);
    const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => "busy"), releaseTurn }), handlers });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(outcome!.result).toBe("ignored");
    expect(releaseTurn).toHaveBeenCalledTimes(1);
    expect(releaseTurn).toHaveBeenCalledWith("run-1", "BUSY_TIMEOUT", LEASE);
    expect(t.audit.reserveSend).toHaveBeenCalledTimes(3);
    expect(t.audit.confirmSend).not.toHaveBeenCalled();
    expect(t.audit.recordReply).not.toHaveBeenCalled();
    expect(t.sends).toEqual([]);
    expect(t.logged("reply_withheld")).toEqual([{ reason: "busy_timeout" }]);
  });

  it("si liberar falla, o el repositorio no lo implementa, igual NO se envía y se registra solo el código", async () => {
    const failing = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => "busy"), releaseTurn: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }), handlers });
    await processTurns([turn({ messageId: "wamid.t1" })], failing.deps);
    expect(failing.sends).toEqual([]);
    expect(failing.logged("audit_unavailable")).toEqual([{ stage: "release", kind: "UNKNOWN_OUTCOME" }]);
    const absent = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => "busy"), releaseTurn: undefined }), handlers });
    await processTurns([turn({ messageId: "wamid.t1" })], absent.deps);
    expect(absent.sends).toEqual([]);
  });

  it("solo el 'busy' agotado libera: superseded, blocked, lost o una base caída NO liberan el turno", async () => {
    for (const reservation of ["superseded", "blocked", "lost"]) {
      const releaseTurn = vi.fn(async () => undefined);
      const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => reservation), releaseTurn }), handlers });
      await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
      expect(releaseTurn, reservation).not.toHaveBeenCalled();
    }
    const releaseTurn = vi.fn(async () => undefined);
    const down = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }), releaseTurn }), handlers });
    await processTurns([turn({ messageId: "wamid.t1" })], down.deps);
    expect(releaseTurn).not.toHaveBeenCalled();
  });

  it("una imagen con cotización también queda recuperable (no se pierde en silencio) y no envía nada", async () => {
    const releaseTurn = vi.fn(async () => undefined);
    const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => "busy"), releaseTurn }), handlers });
    await processTurns([{ messageId: "wamid.i1", from: "59170000000", kind: "IMAGE", mediaId: "m1" }], t.deps);
    expect(releaseTurn).toHaveBeenCalledWith("run-1", "BUSY_TIMEOUT", LEASE);
    expect(t.sends).toEqual([]);
  });

  it("repositorio Supabase: releaseTurn llama a plusmedik_turn_release con el lease; un lease perdido es un error de escritura", async () => {
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const make = (status: number) => createSupabaseAuditRepository({
      baseUrl: "https://example.supabase.co", serviceKey: "k", retryDelayMs: 0,
      fetchFn: (async (input: unknown, init?: RequestInit) => { calls.push({ name: String(input).split("/rest/v1/rpc/")[1]!, args: JSON.parse(String(init?.body)) }); return new Response("{}", { status }); }) as typeof fetch
    });
    await make(200).releaseTurn!("run-1", "BUSY_TIMEOUT", LEASE);
    expect(calls).toEqual([{ name: "plusmedik_turn_release", args: { p_run_id: "run-1", p_owner: LEASE.owner, p_fence: 1, p_reason: "BUSY_TIMEOUT" } }]);
    await expect(make(410).releaseTurn!("run-1", "BUSY_TIMEOUT", LEASE)).rejects.toMatchObject({ kind: "LEASE_LOST" });
  });
});
