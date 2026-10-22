import { describe, expect, it, vi } from "vitest";
import { AuditWriteError, createSupabaseAuditRepository, type AuditClaim, type AuditLease, type AuditRepository } from "../src/audit.js";
import { handleRecoveryRequest } from "../src/audit-recovery.js";
import type { AnalysisResult } from "../src/analyze.js";
import { formatQuoteMessage, handleImageMessage, NO_QUOTE_MESSAGE, TECHNICAL_ISSUE_MESSAGE, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";

// Cliente de leases y reserva de envío sin base de datos (simulaciones). La garantía real (exclusión, fencing, estados) se prueba contra PostgreSQL en
// tests/audit-lease-db.test.ts y de extremo a extremo en tests/audit-recovery-e2e.test.ts.

const SERVER_SECRET = "SECRETO_DEL_SERVIDOR_777";
const image: IncomingImage = { messageId: "wamid.lease-1", from: "59170000000", mediaId: "media-1" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const LEASE: AuditLease = { owner: "owner-0000001", fence: 3 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reply = { status: number; body?: unknown } | "network";
function fakeRpc(replies: Record<string, Reply | Reply[]>) {
  const calls: Array<{ name: string; args: Record<string, any>; body: string }> = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const name = String(input).split("/rest/v1/rpc/")[1]!;
    const body = String(init?.body);
    calls.push({ name, args: JSON.parse(body), body });
    const scripted = replies[name];
    const reply = Array.isArray(scripted) ? (scripted.length > 1 ? scripted.shift()! : scripted[0]!) : scripted ?? { status: 200, body: {} };
    if (reply === "network") throw new TypeError(`fetch failed ${SERVER_SECRET}`);
    return new Response(JSON.stringify(reply.body ?? SERVER_SECRET), { status: reply.status });
  }) as typeof fetch;
  const repository = createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn, retryDelayMs: 0 });
  return { repository, calls };
}

describe("repositorio: claim, renovación y reserva", () => {
  it("el claim concede un lease con un propietario único por ejecución y la generación que devuelve la base", async () => {
    const { repository, calls } = fakeRpc({ plusmedik_audit_claim_run: { status: 200, body: { outcome: "claimed", run_id: "run-1", fence: 1 } } });
    const first = (await repository.claim(image)) as Extract<AuditClaim, { kind: "claimed" }>;
    const second = (await repository.claim(image)) as Extract<AuditClaim, { kind: "claimed" }>;
    expect(first).toMatchObject({ kind: "claimed", runId: "run-1", takeover: false, lease: { fence: 1 } });
    expect(first.lease.owner).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.lease.owner).not.toBe(first.lease.owner);
    expect(calls[0]!.args).toMatchObject({ p_message_id: image.messageId, p_media_id: image.mediaId, p_owner: first.lease.owner, p_lease_seconds: 120 });
  });

  it("reclamar un lease vencido se informa como takeover; el resto de resultados son duplicados que NO se procesan", async () => {
    const taken = fakeRpc({ plusmedik_audit_claim_run: { status: 200, body: { outcome: "taken_over", run_id: "run-1", fence: 4 } } });
    expect(await taken.repository.claim(image)).toMatchObject({ kind: "claimed", takeover: true, lease: { fence: 4 } });
    for (const [outcome, reason] of [["busy", "BUSY"], ["in_doubt", "IN_DOUBT"], ["finished", "FINISHED"], ["exhausted", "EXHAUSTED"]] as const) {
      const { repository } = fakeRpc({ plusmedik_audit_claim_run: { status: 200, body: { outcome, run_id: "run-1", status: "PROCESSING" } } });
      expect(await repository.claim(image)).toEqual({ kind: "duplicate", processingStatus: "PROCESSING", reason });
    }
    // una respuesta inesperada nunca se interpreta como "reclamado"
    const odd = fakeRpc({ plusmedik_audit_claim_run: { status: 200, body: { outcome: "claimed" } } });
    expect((await odd.repository.claim(image)).kind).toBe("duplicate");
  });

  it("si el claim no obtiene respuesta se repite idéntico (mismo propietario): la base reconoce al mismo dueño", async () => {
    const { repository, calls } = fakeRpc({ plusmedik_audit_claim_run: ["network", { status: 200, body: { outcome: "claimed", run_id: "run-1", fence: 1 } }] });
    expect(await repository.claim(image)).toMatchObject({ kind: "claimed" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("renovar: true si se renovó, false si el lease se perdió (410); un fallo de red NO es 'perdido'", async () => {
    expect(await fakeRpc({ plusmedik_audit_renew_lease: { status: 200, body: { status: "renewed" } } }).repository.renewLease("run-1", LEASE)).toBe(true);
    expect(await fakeRpc({ plusmedik_audit_renew_lease: { status: 410 } }).repository.renewLease("run-1", LEASE)).toBe(false);
    await expect(fakeRpc({ plusmedik_audit_renew_lease: "network" }).repository.renewLease("run-1", LEASE)).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });
  });

  it("reservar: solo 'reserved' autoriza; bloqueo, cierre o lease perdido no; los fallos lanzan para que quien llama NO envíe", async () => {
    const reserve = (reply: Reply) => fakeRpc({ plusmedik_audit_reserve_send: reply }).repository.reserveSend("run-1", "quoted", LEASE);
    expect(await reserve({ status: 200, body: { status: "reserved" } })).toBe("reserved");
    expect(await reserve({ status: 200, body: { status: "blocked" } })).toBe("blocked");
    expect(await reserve({ status: 200, body: { status: "closed" } })).toBe("lost");
    expect(await reserve({ status: 200, body: {} })).toBe("lost");
    expect(await reserve({ status: 410 })).toBe("lost");
    await expect(reserve({ status: 409 })).rejects.toMatchObject({ kind: "CONFLICT" });
    await expect(reserve({ status: 422 })).rejects.toMatchObject({ kind: "REJECTED" });
    await expect(reserve("network")).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });
    const unknown = (await reserve({ status: 500 }).catch((error) => error)) as AuditWriteError;
    expect(unknown.message).not.toContain(SERVER_SECRET);
  });

  it("un reintento tras un resultado desconocido de la reserva envía exactamente lo mismo (la base es idempotente para el mismo propietario)", async () => {
    const { repository, calls } = fakeRpc({ plusmedik_audit_reserve_send: ["network", { status: 200, body: { status: "reserved" } }] });
    expect(await repository.reserveSend("run-1", "quoted", LEASE)).toBe("reserved");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toBe(calls[0]!.body);
  });

  it("toda escritura de una corrida con lease presenta propietario y generación", async () => {
    const { repository, calls } = fakeRpc({});
    await repository.recordIgnored("run-1", "IMAGE_SIZE", LEASE);
    await repository.recordIgnored("run-1", "IMAGE_TYPE", LEASE);
    await repository.recordFailure("run-1", "AI_PROCESSING_FAILED", LEASE);
    await repository.recordEvidence("run-1", { aiCalls: [{ label: "x", provider: "p", model: "m", cacheHit: false, outcome: "OK" }] }, LEASE);
    await repository.reserveSend("run-1", "no_quote", LEASE);
    await repository.recordReply("run-1", { state: "ACCEPTED", result: "no_quote", processingStatus: "COMPLETED" }, LEASE);
    await repository.renewLease("run-1", LEASE);
    expect(calls.map((call) => call.name)).toEqual(["plusmedik_audit_fenced_close", "plusmedik_audit_fenced_close", "plusmedik_audit_fenced_close", "plusmedik_audit_fenced_record_evidence", "plusmedik_audit_reserve_send", "plusmedik_audit_fenced_record_reply", "plusmedik_audit_renew_lease"]);
    for (const call of calls) expect(call.args).toMatchObject({ p_run_id: "run-1", p_owner: LEASE.owner, p_fence: LEASE.fence });
    expect(calls.slice(0, 3).map((call) => call.args.p_close)).toEqual([
      { status: "IGNORED", error_code: "IMAGE_SIZE", final: true },
      { status: "IGNORED", error_code: "IMAGE_TYPE", final: false },
      { status: "FAILED", error_code: "AI_PROCESSING_FAILED", final: false }
    ]);
  });

  it("un lease perdido (410) en una escritura se informa como LEASE_LOST y no se reintenta", async () => {
    const { repository, calls } = fakeRpc({ plusmedik_audit_fenced_record_evidence: { status: 410 } });
    await expect(repository.recordEvidence("run-1", { aiCalls: [{ label: "x", provider: "p", model: "m", cacheHit: false, outcome: "OK" }] }, LEASE)).rejects.toMatchObject({ kind: "LEASE_LOST", httpStatus: 410 });
    expect(calls).toHaveLength(1);
  });

  it("recuperación y bloqueo: valores por defecto, conversión de contadores y estados desconocidos tratados como no soportados", async () => {
    const { repository, calls } = fakeRpc({
      plusmedik_audit_recover_stale: { status: 200, body: { send_outcome_unknown: 2, abandoned_before_send: 1 } },
      plusmedik_audit_block_send: [{ status: 200, body: { status: "blocked" } }, { status: 200, body: { status: "algo-raro" } }]
    });
    expect(await repository.recoverStale()).toEqual({ sendOutcomeUnknown: 2, abandonedBeforeSend: 1 });
    expect(calls[0]!.args).toEqual({ p_reserved_grace_seconds: 60, p_abandon_grace_seconds: 900, p_limit: 50 });
    expect(await repository.blockSend("wamid.x", "staff_replied")).toBe("blocked");
    expect(await repository.blockSend("wamid.x", "staff_replied")).toBe("unsupported");
  });
});

// ───────────────────────────── handleImageMessage ─────────────────────────────

const quote = { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" as const };
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: quote }) as AnalysisResult;

function audit(overrides: Partial<AuditRepository> = {}): AuditRepository {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1", lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async () => "reserved" as const), confirmSend: vi.fn(async () => "proceed" as const),
    recordReply: vi.fn(async () => undefined),
    ...overrides
  };
}

function flow(repo: AuditRepository | undefined, overrides: Partial<QuoteDeps> = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const sendText = vi.fn(async (_to: string, _body: string) => ({ providerMessageId: "wamid.out" }));
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => okAnalysis()),
    sendText,
    log: (event, data) => logs.push([event, data]),
    audit: repo,
    leaseRenewIntervalMs: 3_600_000,
    ...overrides
  };
  return { deps, logs, sendText };
}
const logged = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);

describe("el envío solo ocurre tras una reserva concedida", () => {
  it("orden: reserva -> Kapso -> resultado; la reserva lleva el tipo de mensaje y el lease de esta ejecución", async () => {
    const repo = audit();
    const { deps, sendText } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(image.from, formatQuoteMessage(quote));
    expect(vi.mocked(repo.reserveSend)).toHaveBeenCalledWith("run-1", "quoted", LEASE);
    expect(vi.mocked(repo.recordReply)).toHaveBeenCalledWith("run-1", { state: "ACCEPTED", result: "quoted", processingStatus: "COMPLETED", providerMessageId: "wamid.out" }, LEASE);
    expect(vi.mocked(repo.reserveSend).mock.invocationCallOrder[0]!).toBeLessThan(sendText.mock.invocationCallOrder[0]!);
    expect(sendText.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(repo.recordReply).mock.invocationCallOrder[0]!);
  });

  it.each([
    ["bloqueada por una intervención previa", async () => "blocked" as const, "blocked"],
    ["lease perdido o corrida cerrada", async () => "lost" as const, "lost"],
    ["la base no responde (resultado de la reserva desconocido)", async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }, "unavailable"],
    ["la reserva fue rechazada", async () => { throw new AuditWriteError("REJECTED", 422); }, "unavailable"]
  ])("NO se envía si la reserva %s", async (_name, reserve, reason) => {
    const repo = audit({ reserveSend: vi.fn(reserve) });
    const { deps, sendText, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(sendText).not.toHaveBeenCalled();
    expect(vi.mocked(repo.recordReply)).not.toHaveBeenCalled();
    expect(logged(logs, "reply_withheld")).toEqual([{ reason }]);
  });

  it("el aviso técnico por un fallo del motor y el aviso de imagen no soportada también se reservan, con su tipo", async () => {
    const failing = audit();
    const a = flow(failing, { analyze: vi.fn(async () => { throw new Error("IA caída"); }) });
    await expect(handleImageMessage(image, a.deps)).resolves.toBe("technical_issue");
    expect(a.sendText).toHaveBeenCalledWith(image.from, TECHNICAL_ISSUE_MESSAGE);
    expect(vi.mocked(failing.recordFailure)).toHaveBeenCalledWith("run-1", "AI_PROCESSING_FAILED", LEASE);
    expect(vi.mocked(failing.reserveSend)).toHaveBeenCalledWith("run-1", "technical_issue", LEASE);
    expect(vi.mocked(failing.recordReply)).toHaveBeenCalledWith("run-1", expect.objectContaining({ result: "technical_issue", processingStatus: "FAILED" }), LEASE);

    const wrongType = audit();
    const b = flow(wrongType, { downloadImage: vi.fn(async () => ({ bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) })) });
    await expect(handleImageMessage(image, b.deps)).resolves.toBe("no_quote");
    expect(b.sendText).toHaveBeenCalledWith(image.from, NO_QUOTE_MESSAGE);
    expect(vi.mocked(wrongType.recordIgnored)).toHaveBeenCalledWith("run-1", "IMAGE_TYPE", LEASE);
    expect(vi.mocked(wrongType.reserveSend)).toHaveBeenCalledWith("run-1", "no_quote", LEASE);
  });

  it("una imagen demasiado grande no recibe respuesta: no se reserva ni se envía", async () => {
    const repo = audit();
    const { deps, sendText } = flow(repo, { downloadImage: vi.fn(async () => ({ bytes: new Uint8Array(9 * 1024 * 1024) })) });
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(vi.mocked(repo.recordIgnored)).toHaveBeenCalledWith("run-1", "IMAGE_SIZE", LEASE);
    expect(vi.mocked(repo.reserveSend)).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("si Kapso falla con resultado incierto: un solo intento de envío, resultado UNKNOWN registrado, jamás un reintento", async () => {
    const repo = audit();
    const { deps } = flow(repo, { sendText: vi.fn(async () => { throw new Error("socket hang up"); }) });
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(deps.sendText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.recordReply)).toHaveBeenCalledWith("run-1", { state: "UNKNOWN", result: "quoted", processingStatus: "COMPLETED" }, LEASE);
  });

  it("si el resultado del envío no se puede guardar, el mensaje ya enviado no se repite", async () => {
    const repo = audit({ recordReply: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) });
    const { deps, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(deps.sendText).toHaveBeenCalledTimes(1);
    expect(logged(logs, "audit_unavailable")).toEqual([{ stage: "reply", kind: "UNKNOWN_OUTCOME" }]);
  });
});

describe("claim: duplicados, reclamación y política sin base", () => {
  it.each(["BUSY", "IN_DOUBT", "FINISHED", "EXHAUSTED"] as const)("un claim duplicado (%s) no descarga, analiza, reserva ni envía", async (reason) => {
    const repo = audit({ claim: vi.fn(async () => ({ kind: "duplicate" as const, processingStatus: "PROCESSING", reason })) });
    const { deps, sendText, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(deps.downloadImage).not.toHaveBeenCalled();
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(vi.mocked(repo.reserveSend)).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(logged(logs, "duplicate_ignored")).toEqual([{ processingStatus: "PROCESSING", reason }]);
  });

  it("reclamar un lease vencido se registra y el procesamiento continúa con el lease nuevo", async () => {
    const taken: AuditLease = { owner: "owner-0000009", fence: 5 };
    const repo = audit({ claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1", lease: taken, takeover: true })) });
    const { deps, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(logged(logs, "lease_taken_over")).toEqual([{ fence: 5 }]);
    expect(vi.mocked(repo.reserveSend)).toHaveBeenCalledWith("run-1", "quoted", taken);
  });

  it("sin claim (la base no responde): por defecto se responde igual y queda registrado; con requireAuditGuard no se responde", async () => {
    const repo = audit({ claim: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) });
    const legacy = flow(repo);
    await expect(handleImageMessage(image, legacy.deps)).resolves.toBe("quoted");
    expect(legacy.sendText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repo.reserveSend)).not.toHaveBeenCalled();
    expect(logged(legacy.logs, "audit_unavailable")).toEqual([{ stage: "claim", kind: "UNKNOWN_OUTCOME" }]);
    const strict = flow(repo, { requireAuditGuard: true });
    await expect(handleImageMessage(image, strict.deps)).resolves.toBe("ignored");
    expect(strict.sendText).not.toHaveBeenCalled();
    expect(logged(strict.logs, "reply_withheld")).toEqual([{ reason: "audit_guard_unavailable" }]);
  });

  it("sin repositorio de auditoría configurado el comportamiento es el de siempre (sin reserva)", async () => {
    const { deps, sendText } = flow(undefined);
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});

describe("latido del lease (solo disponibilidad; la seguridad no depende de él)", () => {
  it("renueva mientras se procesa y se detiene al terminar", async () => {
    const repo = audit();
    const { deps } = flow(repo, { leaseRenewIntervalMs: 15, analyze: vi.fn(async () => { await sleep(120); return okAnalysis(); }) });
    await handleImageMessage(image, deps);
    const renewals = vi.mocked(repo.renewLease).mock.calls.length;
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(repo.renewLease)).toHaveBeenCalledWith("run-1", LEASE);
    await sleep(80);
    expect(vi.mocked(repo.renewLease).mock.calls.length).toBe(renewals);
  });

  it("si la renovación informa que el lease se perdió, ni siquiera se pide la reserva y no se envía", async () => {
    const repo = audit({ renewLease: vi.fn(async () => false) });
    const { deps, sendText, logs } = flow(repo, { leaseRenewIntervalMs: 10, analyze: vi.fn(async () => { await sleep(120); return okAnalysis(); }) });
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(vi.mocked(repo.reserveSend)).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(logged(logs, "reply_withheld")).toEqual([{ reason: "lease_lost" }]);
  });

  it("un fallo de red al renovar NO se toma por lease perdido (la reserva decide)", async () => {
    const repo = audit({ renewLease: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) });
    const { deps, sendText } = flow(repo, { leaseRenewIntervalMs: 10, analyze: vi.fn(async () => { await sleep(60); return okAnalysis(); }) });
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("una escritura rechazada por lease perdido impide el envío aunque la reserva no se haya pedido", async () => {
    const repo = audit({ recordEvidence: vi.fn(async () => { throw new AuditWriteError("LEASE_LOST", 410); }) });
    const { deps, sendText, logs } = flow(repo);
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(sendText).not.toHaveBeenCalled();
    expect(vi.mocked(repo.reserveSend)).not.toHaveBeenCalled();
    expect(logged(logs, "audit_unavailable")).toEqual([{ stage: "evidence", kind: "LEASE_LOST" }]);
  });
});

describe("endpoint de recuperación (inerte hasta configurarlo)", () => {
  const request = (init: RequestInit = {}) => new Request("https://example.test/api/audit/recover", init);
  const deps = (secret: string | undefined, recoverStale = vi.fn(async () => ({ sendOutcomeUnknown: 1, abandonedBeforeSend: 2 }))) => ({ repository: () => ({ recoverStale }), secret, log: vi.fn() });

  it("sin secreto configurado: 503 y no toca la base", async () => {
    const d = deps(undefined);
    expect((await handleRecoveryRequest(request({ headers: { authorization: "Bearer anything" } }), d)).status).toBe(503);
    expect(d.repository().recoverStale).not.toHaveBeenCalled();
  });

  it.each([[undefined], ["Bearer wrong"], ["Bearer s3cret-value-longer"], ["s3cret-value"], ["Basic s3cret-value"]])("autorización %s: 401 y no toca la base", async (authorization) => {
    const recoverStale = vi.fn(async () => ({ sendOutcomeUnknown: 0, abandonedBeforeSend: 0 }));
    const response = await handleRecoveryRequest(request({ headers: authorization ? { authorization } : {} }), deps("s3cret-value", recoverStale));
    expect(response.status).toBe(401);
    expect(recoverStale).not.toHaveBeenCalled();
  });

  it("con el secreto correcto ejecuta la recuperación y devuelve solo contadores; otros métodos: 405", async () => {
    const d = deps("s3cret-value");
    const response = await handleRecoveryRequest(request({ headers: { authorization: "Bearer s3cret-value" } }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sendOutcomeUnknown: 1, abandonedBeforeSend: 2 });
    expect(d.log).toHaveBeenCalledWith("audit_recovery", { sendOutcomeUnknown: 1, abandonedBeforeSend: 2 });
    expect((await handleRecoveryRequest(request({ method: "PUT", headers: { authorization: "Bearer s3cret-value" } }), d)).status).toBe(405);
  });

  it("si la recuperación falla responde 500 sin el texto del error", async () => {
    const failing = vi.fn(async () => { throw new Error(`conexión rechazada ${SERVER_SECRET}`); });
    const d = deps("s3cret-value", failing as never);
    const response = await handleRecoveryRequest(request({ headers: { authorization: "Bearer s3cret-value" } }), d);
    expect(response.status).toBe(500);
    expect(JSON.stringify([await response.json(), d.log.mock.calls])).not.toContain(SERVER_SECRET);
  });
});
