import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { AuditWriteError, createSupabaseAuditRepository, type AuditClaim, type AuditLease, type AuditRepository } from "../src/audit.js";
import { extractIncomingTurns, processTurns, type IncomingTurn, type TurnHandlers } from "../src/turns.js";
import { handleImageMessage, TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";

// Coordinación de turnos SIN base de datos (simulaciones del repositorio de auditoría). La garantía real (secuencia, un solo envío en vuelo, obsolescencia, pausa)
// se prueba contra PostgreSQL en tests/turns-db.test.ts y de extremo a extremo en tests/turns-e2e.test.ts.

const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };
const KEY = "a".repeat(64);
const SENTINEL = "TEXTO_CLINICO_SENTINELA_9137";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const turn = (overrides: Partial<IncomingTurn> & { messageId: string }): IncomingTurn => ({ from: "59170000000", kind: "TEXT", text: "hola", ...overrides });
const imageTurn = (messageId: string, from = "59170000000"): IncomingTurn => ({ messageId, from, kind: "IMAGE", mediaId: "media-1" });

function fakeAudit(overrides: Partial<Record<keyof AuditRepository, unknown>> = {}) {
  let n = 0;
  const repo = {
    claim: vi.fn(async (): Promise<AuditClaim> => ({ kind: "claimed", runId: `run-${++n}`, lease: LEASE, takeover: false })),
    renewLease: vi.fn(async () => true),
    recordIgnored: vi.fn(async () => undefined),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    reserveSend: vi.fn(async (): Promise<string> => "reserved"),
    confirmSend: vi.fn(async (): Promise<string> => "proceed"),
    recordReply: vi.fn(async () => undefined),
    ...overrides
  };
  return repo as unknown as AuditRepository & { [K in keyof typeof repo]: (typeof repo)[K] };
}

function setup(options: { audit?: ReturnType<typeof fakeAudit>; handlers?: TurnHandlers; turns?: Partial<NonNullable<QuoteDeps["turns"]>> | null; quote?: Partial<QuoteDeps> } = {}) {
  const audit = options.audit ?? fakeAudit();
  const sends: Array<[string, string]> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const sleeps: number[] = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => okAnalysis()),
    sendText: vi.fn(async (to: string, body: string) => { sends.push([to, body]); return { providerMessageId: "wamid.out" }; }),
    log: (event, data) => logs.push([event, data]),
    audit,
    leaseRenewIntervalMs: 3_600_000,
    ...(options.turns === null ? {} : { turns: { contactKeyFor: () => KEY, busyRetries: 3, busyDelayMs: 7, sleep: async (ms: number) => { sleeps.push(ms); }, handlers: options.handlers, ...options.turns } }),
    ...options.quote
  };
  const logged = (name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  return { deps, audit, sends, logs, logged, sleeps };
}

describe("extractIncomingTurns: qué mensajes son turnos", () => {
  const base = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ message: { id: "wamid.1", from: "59170000000", timestamp: "1000", kapso: { direction: "inbound" }, ...message }, ...extra });

  it("clasifica texto, imagen y el resto de tipos entrantes; el texto solo viaja en memoria", () => {
    expect(extractIncomingTurns(base({ type: "text", text: { body: "hola" } }))).toEqual([{ messageId: "wamid.1", from: "59170000000", kind: "TEXT", text: "hola", timestamp: 1000 }]);
    expect(extractIncomingTurns(base({ type: "image", image: { id: "m1", link: "https://x/y.jpg" } }))[0]).toMatchObject({ kind: "IMAGE", mediaId: "m1", mediaUrl: "https://x/y.jpg" });
    for (const type of ["audio", "document", "video", "sticker", "location", "contacts", "interactive", "button"]) {
      expect(extractIncomingTurns(base({ type })), type).toMatchObject([{ kind: "OTHER" }]);
    }
  });

  it("no son turnos: salientes, estados, reacciones, sin id o remitente, texto vacío o imagen sin medio", () => {
    expect(extractIncomingTurns(base({ type: "text", text: { body: "x" }, kapso: { direction: "outbound" } }))).toEqual([]);
    expect(extractIncomingTurns(base({ type: "reaction" }))).toEqual([]);
    expect(extractIncomingTurns(base({ type: "text", text: { body: "   " } }))).toEqual([]);
    expect(extractIncomingTurns(base({ type: "text" }))).toEqual([]);
    expect(extractIncomingTurns(base({ type: "image" }))).toEqual([]);
    expect(extractIncomingTurns(base({ id: "", type: "text", text: { body: "x" } }))).toEqual([]);
    expect(extractIncomingTurns(base({ from: "", type: "text", text: { body: "x" } }))).toEqual([]);
    expect(extractIncomingTurns({ nada: true })).toEqual([]);
  });

  it("un lote se devuelve ordenado por el instante del mensaje (estable si empatan); sin instante, al final en su orden", () => {
    const event = (id: string, timestamp?: string) => base({ id, type: "text", text: { body: id }, ...(timestamp ? { timestamp } : { timestamp: undefined }) });
    const payload = { batch: true, data: [event("c", "30"), event("a", "10"), event("none"), event("b1", "20"), event("b2", "20")] };
    expect(extractIncomingTurns(payload, "true").map((t) => t.messageId)).toEqual(["a", "b1", "b2", "c", "none"]);
  });
});

describe("modo turnos: imagen", () => {
  it("reclama como turno IMAGE, reserva con política NONE (una cotización nunca se descarta en silencio) y responde una vez", async () => {
    const t = setup();
    const result = await handleImageMessage({ messageId: "wamid.i1", from: "59170000000", mediaId: "m1" }, t.deps);
    expect(result).toBe("quoted");
    expect(t.audit.claim).toHaveBeenCalledWith({ messageId: "wamid.i1", mediaId: "m1" }, { contactKey: KEY, turnKind: "IMAGE" });
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "quoted", LEASE, { stale: "NONE" });
    expect(t.audit.confirmSend).toHaveBeenCalledTimes(1);
    expect(t.sends).toHaveLength(1);
  });

  it("sin modo turnos el comportamiento heredado no cambia: claim sin opciones y reserva de tres argumentos", async () => {
    const t = setup({ turns: null });
    await handleImageMessage({ messageId: "wamid.i1", from: "59170000000", mediaId: "m1" }, t.deps);
    expect(t.audit.claim).toHaveBeenCalledWith({ messageId: "wamid.i1", mediaId: "m1" });
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "quoted", LEASE);
    expect(t.sends).toHaveLength(1);
  });

  it("un aviso técnico de una imagen sí puede quedar obsoleto (NEWER_TURN); la cotización no", async () => {
    const t = setup({ quote: { analyze: vi.fn(async () => { throw new Error("falla del modelo"); }) } });
    expect(await handleImageMessage({ messageId: "wamid.i1", from: "59170000000", mediaId: "m1" }, t.deps)).toBe("technical_issue");
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "technical_issue", LEASE, { stale: "NEWER_TURN" });
    expect(t.sends[0]![1]).toBe(TECHNICAL_ISSUE_MESSAGE);
  });
});

describe("modo turnos: texto", () => {
  it("con manejador: reclama como TEXT, el manejador recibe el texto, se reserva 'conversation' (NEWER_TURN por defecto), se confirma, se envía y se registra", async () => {
    const handler = vi.fn(async (t: IncomingTurn) => ({ body: `eco:${t.text}` }));
    const t = setup({ handlers: { text: handler } });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1", text: "hola doctor" })], t.deps);
    expect(outcome).toEqual({ messageId: "wamid.t1", result: "conversation" });
    // G4.1: el manejador recibe además un contexto perezoso (la última cotización del contacto); solo se consulta si hace falta
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ messageId: "wamid.t1", text: "hola doctor" }), expect.objectContaining({ quotedStudyIds: expect.any(Function) }));
    expect(t.audit.claim).toHaveBeenCalledWith({ messageId: "wamid.t1", mediaId: undefined }, { contactKey: KEY, turnKind: "TEXT" });
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NEWER_TURN" });
    expect(t.sends).toEqual([["59170000000", "eco:hola doctor"]]);
    expect(t.audit.recordReply).toHaveBeenCalledWith("run-1", { state: "ACCEPTED", result: "conversation", processingStatus: "COMPLETED", providerMessageId: "wamid.out" }, LEASE);
    expect(t.deps.downloadImage).not.toHaveBeenCalled();
  });

  it("el manejador puede pedir que su respuesta nunca se descarte (stale: NONE)", async () => {
    const t = setup({ handlers: { text: async () => ({ body: "x", stale: "NONE" }) } });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "conversation", LEASE, { stale: "NONE" });
  });

  it("si el manejador no responde nada, el turno se cierra sin respuesta: no hay reserva ni envío", async () => {
    const t = setup({ handlers: { text: async () => undefined } });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(outcome!.result).toBe("ignored");
    expect(t.audit.recordIgnored).toHaveBeenCalledWith("run-1", "NO_REPLY", LEASE);
    expect(t.audit.reserveSend).not.toHaveBeenCalled();
    expect(t.sends).toEqual([]);
  });

  it("si el manejador falla: se registra el fallo (sin el texto del error) y se envía el aviso técnico, descartable por obsolescencia", async () => {
    const t = setup({ handlers: { text: async () => { throw new Error(`falla ${SENTINEL}`); } } });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(outcome!.result).toBe("technical_issue");
    expect(t.audit.recordFailure).toHaveBeenCalledWith("run-1", "UNEXPECTED_PROCESSING_FAILED", LEASE);
    expect(t.audit.reserveSend).toHaveBeenCalledWith("run-1", "technical_issue", LEASE, { stale: "NEWER_TURN" });
    expect(t.sends[0]![1]).toBe(TECHNICAL_ISSUE_MESSAGE);
    expect(JSON.stringify(t.logs)).not.toContain(SENTINEL);
  });

  it("sin manejador, un texto no se reclama ni se registra ni se responde (como hoy); un tipo 'OTHER' sin manejador tampoco", async () => {
    const t = setup({ handlers: {} });
    const outcomes = await processTurns([turn({ messageId: "wamid.t1" }), turn({ messageId: "wamid.o1", kind: "OTHER", text: undefined })], t.deps);
    expect(outcomes.map((o) => o.result)).toEqual(["skipped", "skipped"]);
    expect(t.audit.claim).not.toHaveBeenCalled();
    expect(t.sends).toEqual([]);
  });

  it("el contenido del mensaje no llega a ningún registro ni a la auditoría", async () => {
    const t = setup({ handlers: { text: async () => ({ body: "respuesta fija" }) } });
    await processTurns([turn({ messageId: "wamid.t1", text: `${SENTINEL} dolor` })], t.deps);
    const everything = JSON.stringify({ logs: t.logs, calls: Object.values(t.audit).flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls) });
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain("59170000000");
  });
});

describe("modo turnos: fallo cerrado y duplicados", () => {
  it("sin clave estable del contacto no se reclama ni se responde", async () => {
    const t = setup({ handlers: { text: async () => ({ body: "x" }) }, turns: { contactKeyFor: () => undefined } });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.audit.claim).not.toHaveBeenCalled();
    expect(t.logged("reply_withheld")).toEqual([{ reason: "contact_unidentified" }]);
    expect(t.sends).toEqual([]);
  });

  it("si el claim falla NO se responde (el modo turnos implica la auditoría obligatoria), aunque requireAuditGuard no esté definido", async () => {
    const t = setup({ audit: fakeAudit({ claim: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }), handlers: { text: async () => ({ body: "x" }) } });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.logged("audit_unavailable")).toEqual([{ stage: "claim", kind: "UNKNOWN_OUTCOME" }]);
    expect(t.logged("reply_withheld")).toEqual([{ reason: "audit_guard_unavailable" }]);
    expect(t.sends).toEqual([]);
  });

  it("contacto en pausa humana o mensaje duplicado: el manejador no se ejecuta y no se responde", async () => {
    const handler = vi.fn(async () => ({ body: "x" }));
    for (const claim of [{ kind: "duplicate", processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" }, { kind: "duplicate", processingStatus: "PROCESSING", reason: "BUSY" }] as Array<Extract<AuditClaim, { kind: "duplicate" }>>) {
      const t = setup({ audit: fakeAudit({ claim: vi.fn(async () => claim) }), handlers: { text: handler } });
      await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
      expect(t.sends).toEqual([]);
      expect(t.logged("duplicate_ignored")).toEqual([{ processingStatus: claim.processingStatus, reason: claim.reason }]);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("sin la auditoría configurada, el modo turnos no responde (no hay cómo demostrar exclusión)", async () => {
    const t = setup({ handlers: { text: async () => ({ body: "x" }) }, quote: { audit: undefined } });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.logged("reply_withheld")).toEqual([{ reason: "audit_guard_unavailable" }]);
    expect(t.sends).toEqual([]);
  });
});

describe("modo turnos: reserva, espera, obsolescencia y pausa", () => {
  const handlers: TurnHandlers = { text: async () => ({ body: "respuesta" }) };

  it("'busy' (otro envío del contacto en vuelo): espera con el retardo configurado y reintenta; al concederse la reserva envía una sola vez", async () => {
    const answers = ["busy", "busy", "reserved"];
    const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => answers.shift()!) }), handlers });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.audit.reserveSend).toHaveBeenCalledTimes(3);
    expect(t.sleeps).toEqual([7, 7]);
    expect(t.logged("turn_busy")).toHaveLength(2);
    expect(t.sends).toHaveLength(1);
  });

  it("'busy' que no se libera dentro del plazo: no se envía, queda registrado y el turno no se pierde en silencio", async () => {
    const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => "busy") }), handlers });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(outcome!.result).toBe("ignored");
    expect(t.audit.reserveSend).toHaveBeenCalledTimes(4); // 1 intento + 3 reintentos
    expect(t.logged("reply_withheld")).toEqual([{ reason: "busy_timeout" }]);
    expect(t.audit.confirmSend).not.toHaveBeenCalled();
    expect(t.sends).toEqual([]);
  });

  it("'superseded' (ya respondió un turno más nuevo): la respuesta vieja no se envía", async () => {
    const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => "superseded") }), handlers });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(outcome!.result).toBe("ignored");
    expect(t.logged("reply_withheld")).toEqual([{ reason: "superseded" }]);
    expect(t.audit.confirmSend).not.toHaveBeenCalled();
    expect(t.audit.recordReply).not.toHaveBeenCalled();
    expect(t.sends).toEqual([]);
  });

  it("pausa humana en la reserva o en la comprobación final: no se envía", async () => {
    for (const [reserve, confirm, reason] of [["blocked", "proceed", "blocked"], ["reserved", "blocked", "blocked"], ["lost", "proceed", "lost"], ["reserved", "lost", "lost"]] as const) {
      const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => reserve), confirmSend: vi.fn(async () => confirm) }), handlers });
      await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
      expect(t.sends, `${reserve}/${confirm}`).toEqual([]);
      expect(t.logged("reply_withheld")).toEqual([{ reason }]);
    }
  });

  it("si la base no responde al reservar, no se envía", async () => {
    const t = setup({ audit: fakeAudit({ reserveSend: vi.fn(async () => { throw new AuditWriteError("UNKNOWN_OUTCOME"); }) }), handlers });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.sends).toEqual([]);
    expect(t.logged("reply_withheld")).toEqual([{ reason: "unavailable" }]);
  });

  it("si el lease se pierde mientras se espera un envío en vuelo, no se envía", async () => {
    let calls = 0;
    const t = setup({ audit: fakeAudit({ renewLease: vi.fn(async () => false), reserveSend: vi.fn(async () => (++calls < 3 ? "busy" : "reserved")) }), handlers, quote: { leaseRenewIntervalMs: 1 }, turns: { busyDelayMs: 30, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) } });
    await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(t.sends).toEqual([]);
    expect(t.logged("reply_withheld")).toEqual([{ reason: "lease_lost" }]);
  });

  it("un resultado de envío incierto se registra como UNKNOWN y no se reintenta", async () => {
    const t = setup({ handlers, quote: { sendText: vi.fn(async () => { throw new Error("red caída"); }) } });
    const [outcome] = await processTurns([turn({ messageId: "wamid.t1" })], t.deps);
    expect(outcome!.result).toBe("conversation");
    expect(t.deps.sendText).toHaveBeenCalledTimes(1);
    expect(t.audit.recordReply).toHaveBeenCalledWith("run-1", { state: "UNKNOWN", result: "conversation", processingStatus: "COMPLETED" }, LEASE);
  });
});

describe("lotes de turnos: el orden de numeración es el del mensaje", () => {
  it("todos los claims se hacen UNO por UNO en el orden de los mensajes, antes de que empiece el trabajo pesado; luego el trabajo corre en paralelo", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const claim = vi.fn(async (image: { messageId: string }): Promise<AuditClaim> => {
      events.push(`claim:${image.messageId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { kind: "claimed", runId: `run-${image.messageId}`, lease: LEASE, takeover: false };
    });
    const t = setup({
      audit: fakeAudit({ claim }),
      handlers: { text: async (turn) => { events.push(`work:${turn.messageId}`); await gate; return { body: turn.messageId }; } }
    });
    // processTurns conserva el orden recibido (extractIncomingTurns ya lo entrega ordenado por el instante del mensaje)
    // contactos distintos: los mensajes de UN mismo contacto en un lote se atienden como una sola solicitud (ver tests/kapso-batch.test.ts)
    const batch = [turn({ messageId: "t1", from: "59171000001" }), turn({ messageId: "t2", from: "59171000002" }), turn({ messageId: "t3", from: "59171000003" })];
    const done = processTurns(batch, t.deps);
    await vi.waitFor(() => expect(events.filter((e) => e.startsWith("work:"))).toHaveLength(3), { timeout: 60_000, interval: 20 });
    expect(events.slice(0, 3)).toEqual(["claim:t1", "claim:t2", "claim:t3"]);
    expect(events.slice(3).sort()).toEqual(["work:t1", "work:t2", "work:t3"]);
    release();
    await done;
    expect(t.sends.map(([, body]) => body).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("processTurns respeta el orden recibido (extractIncomingTurns lo ordena por instante): claims secuenciales", async () => {
    const claims: string[] = [];
    const t = setup({
      audit: fakeAudit({ claim: vi.fn(async (image: { messageId: string }) => { claims.push(image.messageId); return { kind: "claimed", runId: `run-${image.messageId}`, lease: LEASE, takeover: false } as AuditClaim; }) }),
      handlers: { text: async () => ({ body: "x" }) }
    });
    await processTurns([turn({ messageId: "a" }), turn({ messageId: "b" }), imageTurn("c"), turn({ messageId: "d", from: "59171111111" })], t.deps);
    expect(claims).toEqual(["a", "b", "c", "d"]);
  });

  it("un fallo en un turno del lote no impide los demás", async () => {
    const t = setup({ handlers: { text: async (turn) => { if (turn.messageId === "bad") throw new Error("boom"); return { body: turn.messageId }; } } });
    const outcomes = await processTurns([turn({ messageId: "bad", from: "59171000001" }), turn({ messageId: "good", from: "59171000002" })], t.deps);
    expect(outcomes.map((o) => o.result)).toEqual(["technical_issue", "conversation"]);
  });
});

describe("repositorio Supabase: claim y reserva de turnos", () => {
  type Scripted = { status: number; body?: unknown };
  function rpc(replies: Record<string, Scripted>) {
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const name = String(input).split("/rest/v1/rpc/")[1]!;
      calls.push({ name, args: JSON.parse(String(init?.body)) });
      const reply = replies[name] ?? { status: 200, body: {} };
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    }) as typeof fetch;
    return { repository: createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn, retryDelayMs: 0 }), calls };
  }
  const image = { messageId: "wamid.1", mediaId: undefined };

  it("claim con turnKind usa plusmedik_turn_claim (con la clave de contacto) y devuelve el número de secuencia; sin turnKind usa la función de siempre", async () => {
    const turns = rpc({ plusmedik_turn_claim: { status: 200, body: { outcome: "claimed", run_id: "run-1", fence: 1, seq: 4 } } });
    expect(await turns.repository.claim(image, { contactKey: KEY, turnKind: "TEXT" })).toMatchObject({ kind: "claimed", runId: "run-1", seq: 4 });
    expect(turns.calls).toHaveLength(1);
    expect(turns.calls[0]!.name).toBe("plusmedik_turn_claim");
    expect(turns.calls[0]!.args).toMatchObject({ p_message_id: "wamid.1", p_contact_key: KEY, p_turn_kind: "TEXT" });

    const legacy = rpc({ plusmedik_audit_claim_run: { status: 200, body: { outcome: "claimed", run_id: "run-1", fence: 1 } } });
    const claimed = await legacy.repository.claim(image, { contactKey: KEY });
    expect(legacy.calls[0]!.name).toBe("plusmedik_audit_claim_run");
    expect(legacy.calls[0]!.args).not.toHaveProperty("p_turn_kind");
    expect(claimed).not.toHaveProperty("seq");
  });

  it("un turno sin clave de contacto se rechaza antes de llamar a la base", async () => {
    const { repository, calls } = rpc({});
    await expect(repository.claim(image, { turnKind: "TEXT" })).rejects.toMatchObject({ kind: "REJECTED" });
    expect(calls).toEqual([]);
  });

  it("'paused' del claim de turno sigue siendo un duplicado por pausa humana", async () => {
    const { repository } = rpc({ plusmedik_turn_claim: { status: 200, body: { outcome: "paused" } } });
    expect(await repository.claim(image, { contactKey: KEY, turnKind: "IMAGE" })).toEqual({ kind: "duplicate", processingStatus: "HUMAN_PAUSED", reason: "HUMAN_PAUSED" });
  });

  it("reserveSend con política usa plusmedik_turn_reserve_send y traduce busy/superseded; sin política usa la reserva de siempre", async () => {
    for (const status of ["reserved", "blocked", "busy", "superseded"] as const) {
      const { repository, calls } = rpc({ plusmedik_turn_reserve_send: { status: 200, body: { status } } });
      expect(await repository.reserveSend("run-1", "conversation", LEASE, { stale: "NEWER_TURN" })).toBe(status);
      expect(calls[0]!.args).toMatchObject({ p_run_id: "run-1", p_kind: "conversation", p_stale_policy: "NEWER_TURN", p_owner: LEASE.owner, p_fence: 1 });
    }
    const unknown = rpc({ plusmedik_turn_reserve_send: { status: 200, body: { status: "closed" } } });
    expect(await unknown.repository.reserveSend("run-1", "conversation", LEASE, { stale: "NONE" })).toBe("lost");
    const lostLease = rpc({ plusmedik_turn_reserve_send: { status: 410 } });
    expect(await lostLease.repository.reserveSend("run-1", "conversation", LEASE, { stale: "NONE" })).toBe("lost");
    const failing = rpc({ plusmedik_turn_reserve_send: { status: 500 } });
    await expect(failing.repository.reserveSend("run-1", "conversation", LEASE, { stale: "NONE" })).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });

    const legacy = rpc({ plusmedik_audit_reserve_send: { status: 200, body: { status: "reserved" } } });
    expect(await legacy.repository.reserveSend("run-1", "quoted", LEASE)).toBe("reserved");
    expect(legacy.calls[0]!.name).toBe("plusmedik_audit_reserve_send");
  });

  it("'NO_REPLY' cierra el turno como un cierre final (sin respuesta), igual que una imagen demasiado grande", async () => {
    const { repository, calls } = rpc({});
    await repository.recordIgnored("run-1", "NO_REPLY", LEASE);
    await repository.recordIgnored("run-1", "IMAGE_TYPE", LEASE);
    expect(calls.map((c) => c.args.p_close)).toEqual([{ status: "IGNORED", error_code: "NO_REPLY", final: true }, { status: "IGNORED", error_code: "IMAGE_TYPE", final: false }]);
  });
});
