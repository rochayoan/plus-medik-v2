import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditWriteError, buildEvidencePayload, createSupabaseAuditRepository, type AuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import type { AiCallEvent } from "../src/cache.js";
import { handleImageMessage, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";

const LEASE = { owner: "owner-0000001", fence: 1 };

// Cliente de la escritura transaccional: reintentos idénticos, resultado desconocido, rechazos, fail-open y "nunca reenviar WhatsApp".
// El servidor es una simulación (ninguna red). El comportamiento de la base (transacción, idempotencia por hash, bloqueo por corrida) se prueba
// contra PostgreSQL real en tests/audit-db.test.ts.

const SERVER_SECRET = "SECRETO_DEL_SERVIDOR_12345";
const image: IncomingImage = { messageId: "wamid.tx-1", from: "59170000000", mediaId: "media-1" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);

type Behavior = "ok" | "timeout-after-commit" | "timeout-before-commit" | "network" | "http500" | "http502" | "http422" | "http409";

function fakeSupabase(script: Behavior[] = []) {
  const committed = new Map<string, string>();
  const calls: Array<{ path: string; body: string; hadSignal: boolean }> = [];
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace("https://example.supabase.co/rest/v1/", "");
    const body = String(init?.body ?? "");
    calls.push({ path, body, hadSignal: init?.signal instanceof AbortSignal });
    if (!path.startsWith("rpc/")) return new Response("", { status: 204 });
    // claim, reserva y renovación responden bien sin consumir el guion: el guion describe solo las escrituras de evidencia y de resultado de envío.
    if (path === "rpc/plusmedik_audit_claim_run") return new Response(JSON.stringify({ outcome: "claimed", run_id: "run-1", fence: 1 }), { status: 200 });
    if (path === "rpc/plusmedik_audit_reserve_send") return new Response(JSON.stringify({ status: "reserved" }), { status: 200 });
    if (path === "rpc/plusmedik_audit_renew_lease") return new Response(JSON.stringify({ status: "renewed" }), { status: 200 });
    if (path === "rpc/plusmedik_audit_confirm_send") return new Response(JSON.stringify({ status: "proceed" }), { status: 200 });
    const behavior = script.shift() ?? "ok";
    const key = `${path}:${(JSON.parse(body) as { p_run_id: string }).p_run_id}`;
    const commit = (): "recorded" | "already_recorded" | "conflict" => {
      const previous = committed.get(key);
      if (previous === undefined) { committed.set(key, body); return "recorded"; }
      return previous === body ? "already_recorded" : "conflict";
    };
    switch (behavior) {
      case "ok": {
        const result = commit();
        return result === "conflict" ? new Response(SERVER_SECRET, { status: 409 }) : new Response(JSON.stringify({ status: result }), { status: 200 });
      }
      case "timeout-after-commit": commit(); throw timeout();
      case "timeout-before-commit": throw timeout();
      case "network": throw new TypeError(`fetch failed ${SERVER_SECRET}`);
      case "http500": return new Response(SERVER_SECRET, { status: 500 });
      case "http502": return new Response(SERVER_SECRET, { status: 502 });
      case "http422": return new Response(SERVER_SECRET, { status: 422 });
      case "http409": return new Response(SERVER_SECRET, { status: 409 });
    }
  }) as typeof fetch;
  // Solo las escrituras de evidencia y de resultado de envío (las que el guion controla).
  return { fetchFn, calls, committed, rpcCalls: () => calls.filter((call) => /^rpc\/plusmedik_audit_fenced_record_(evidence|reply)$/.test(call.path)) };
}

const repositoryOver = (server: ReturnType<typeof fakeSupabase>, extra: Record<string, unknown> = {}) =>
  createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "test-service-key-SECRETA", fetchFn: server.fetchFn, retryDelayMs: 0, ...extra });

const events: AiCallEvent[] = [
  { label: "openai-reader", provider: "openai", model: "gpt-6.1-sol", cacheHit: false, outcome: "OK", usage: { inputTokens: 10, outputTokens: 4 }, callSeq: 1, completionSeq: 1, attempt: 1, startedAt: "2026-10-21T20:00:00.000Z", durationMs: 250, reasoningEffort: "high", paramsHash: "a".repeat(64) }
];
const evidence = { aiCalls: events };

describe("escritura transaccional: reintentos idénticos y resultado desconocido", () => {
  it("la primera petición se confirma: no hay reintento", async () => {
    const server = fakeSupabase();
    await repositoryOver(server).recordEvidence("run-1", evidence, LEASE);
    expect(server.rpcCalls()).toHaveLength(1);
    expect(server.rpcCalls()[0]!.hadSignal).toBe(true); // toda petición lleva un plazo
  });

  it("timeout DESPUÉS de confirmar en la base: el reintento idéntico recibe 'already_recorded' y no se duplica nada", async () => {
    const server = fakeSupabase(["timeout-after-commit", "ok"]);
    await expect(repositoryOver(server).recordEvidence("run-1", evidence, LEASE)).resolves.toBeUndefined();
    const [first, second] = server.rpcCalls();
    expect(second!.body).toBe(first!.body); // exactamente los mismos bytes
    expect(server.committed.size).toBe(1);
  });

  it("timeout ANTES de confirmar: el reintento idéntico lo confirma", async () => {
    const server = fakeSupabase(["timeout-before-commit", "ok"]);
    await repositoryOver(server).recordEvidence("run-1", evidence, LEASE);
    expect(server.rpcCalls()).toHaveLength(2);
    expect(server.committed.size).toBe(1);
  });

  it.each<[Behavior]>([["http500"], ["http502"], ["network"]])("%s en el primer intento se reintenta una vez", async (behavior) => {
    const server = fakeSupabase([behavior, "ok"]);
    await repositoryOver(server).recordEvidence("run-1", evidence, LEASE);
    expect(server.rpcCalls()).toHaveLength(2);
  });

  it("si ninguno de los dos intentos responde, el resultado queda DESCONOCIDO: exactamente 2 peticiones, sin más reintentos", async () => {
    const server = fakeSupabase(["timeout-after-commit", "timeout-before-commit", "ok", "ok"]);
    const error = await repositoryOver(server).recordEvidence("run-1", evidence, LEASE).catch((caught) => caught);
    expect(error).toBeInstanceOf(AuditWriteError);
    expect(error).toMatchObject({ kind: "UNKNOWN_OUTCOME" });
    expect(server.rpcCalls()).toHaveLength(2);
  });

  it("fallo de conexión en ambos intentos: UNKNOWN_OUTCOME, sin filtrar el texto del error de red", async () => {
    const server = fakeSupabase(["network", "network"]);
    const error = (await repositoryOver(server).recordEvidence("run-1", evidence, LEASE).catch((caught) => caught)) as AuditWriteError;
    expect(error.kind).toBe("UNKNOWN_OUTCOME");
    expect(error.message).toBe("audit_write_unknown_outcome");
    expect(JSON.stringify([error.message, error.stack?.split("\n")[0], (error as { cause?: unknown }).cause])).not.toContain(SERVER_SECRET);
  });

  it("un rechazo del servidor (4xx) no se reintenta y no propaga su cuerpo", async () => {
    const server = fakeSupabase(["http422", "ok"]);
    const error = (await repositoryOver(server).recordEvidence("run-1", evidence, LEASE).catch((caught) => caught)) as AuditWriteError;
    expect(error).toMatchObject({ kind: "REJECTED", httpStatus: 422 });
    expect(error.message).not.toContain(SERVER_SECRET);
    expect(server.rpcCalls()).toHaveLength(1);
  });

  it("un conflicto (contenido distinto ya confirmado) no se reintenta ni se sobrescribe", async () => {
    const server = fakeSupabase(["http409", "ok"]);
    const error = (await repositoryOver(server).recordEvidence("run-1", evidence, LEASE).catch((caught) => caught)) as AuditWriteError;
    expect(error).toMatchObject({ kind: "CONFLICT", httpStatus: 409 });
    expect(error.message).not.toContain(SERVER_SECRET);
    expect(server.rpcCalls()).toHaveLength(1);
    // y contra el servidor simulado con estado: otro contenido para la misma corrida da conflicto real
    const stateful = fakeSupabase();
    await repositoryOver(stateful).recordEvidence("run-9", evidence, LEASE);
    const other = { aiCalls: [{ ...events[0]!, durationMs: 999 }] };
    await expect(repositoryOver(stateful).recordEvidence("run-9", other, LEASE)).rejects.toMatchObject({ kind: "CONFLICT" });
  });

  it("un plazo vencido de verdad (la petición nunca responde) corta cada intento y termina en UNKNOWN_OUTCOME", async () => {
    let calls = 0;
    const hanging = ((_input: unknown, init?: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)));
    }) as unknown as typeof fetch;
    const repository = createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: hanging, requestTimeoutMs: 25, retryDelayMs: 0 });
    const started = Date.now();
    await expect(repository.recordEvidence("run-1", evidence, LEASE)).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("el envío se registra con la misma política (una transacción, reintento idéntico, resultado desconocido)", async () => {
    const server = fakeSupabase(["timeout-after-commit", "ok"]);
    await repositoryOver(server).recordReply("run-1", { state: "ACCEPTED", result: "quoted", processingStatus: "COMPLETED", providerMessageId: "wamid.out" }, LEASE);
    const [first, second] = server.rpcCalls();
    expect(first!.path).toBe("rpc/plusmedik_audit_fenced_record_reply");
    expect(second!.body).toBe(first!.body);
    expect(JSON.parse(first!.body)).toEqual({ p_run_id: "run-1", p_owner: LEASE.owner, p_fence: LEASE.fence, p_reply: { state: "ACCEPTED", result: "quoted", processing_status: "COMPLETED", provider_message_id: "wamid.out" } });
    const unknown = fakeSupabase(["network", "network"]);
    await expect(repositoryOver(unknown).recordReply("run-1", { state: "UNKNOWN", result: "no_quote", processingStatus: "COMPLETED" }, LEASE)).rejects.toMatchObject({ kind: "UNKNOWN_OUTCOME" });
    expect(JSON.parse(unknown.rpcCalls()[0]!.body).p_reply).not.toHaveProperty("provider_message_id");
  });

  it("sin análisis ni llamadas de IA no hay nada que registrar: no se llama a la base", async () => {
    const server = fakeSupabase();
    await repositoryOver(server).recordEvidence("run-1", { aiCalls: [] }, LEASE);
    expect(server.calls).toHaveLength(0);
  });
});

describe("contenido de la escritura transaccional", () => {
  const analysis = {
    decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [{ status: "MATCHED" }], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE",
    internal: {
      outcome: "AUTO_COMPLETE", recipeComplete: true, reviewRequired: false,
      quoted: { lines: [{ id: "lab-1", code: "108", name: "NOMBRE", priceBs: 45, basis: ["EXACT_CONFIRMED"], texts: ["TEXTO_CLINICO_SENTINELA"] }], subtotalBs: 45 },
      studies: [{ key: "k", text: "TEXTO_CLINICO_SENTINELA", decision: "AUTO", blockers: [], uncertainty: [], lineIds: ["lab-1"] }], pending: [], recipeStops: [],
      document: { type: "TEXT_EXPLICIT_REQUEST", complete: true, issueKinds: [], problems: ["PROBLEMA_LIBRE_SENTINELA"], unseenRegion: false, zones: [], impactCheck: { needed: false, candidates: [] } },
      advisories: ["AVISO_LIBRE_SENTINELA"], revision: "r", history: []
    }
  } as unknown as AnalysisResult;

  it("los hijos no llevan run_id (lo fija la función), solo columnas permitidas y nada de texto clínico", () => {
    const payload = buildEvidencePayload({ analysis, aiCalls: events }, { engineVersion: "abc1234", flags: {} }) as Record<string, any>;
    expect(JSON.stringify(payload)).not.toContain("run_id");
    expect(JSON.stringify(payload)).not.toMatch(/SENTINELA/);
    expect(Object.keys(payload).sort()).toEqual(["checks", "contract", "model_calls", "run", "studies"]);
    expect(Object.keys(payload.model_calls[0]).sort()).toEqual(["attempt", "cache_hit", "call_seq", "completion_seq", "cost_status", "cost_usd", "duration_ms", "error_kind", "input_tokens", "model", "outcome", "output_tokens", "params_hash", "provider", "reasoning_effort", "reasoning_tokens", "safe_reading", "stage", "started_at"]);
    expect(Object.keys(payload.studies[0]).sort()).toEqual(["blockers", "candidate_codes", "catalog_match_status", "decision", "quoted_lines", "risk_class", "study_index"]);
    expect(payload.checks.map((check: { check_kind: string }) => check.check_kind)).toEqual(["DOCUMENT", "JUDGE", "CATALOG"]); // REPLY va por su propia función
  });

  it("sin análisis (falló) solo viajan las llamadas de IA ocurridas y el hash de configuración; no se inventa un resumen", () => {
    const payload = buildEvidencePayload({ aiCalls: events }, { engineVersion: null, flags: {} }) as Record<string, any>;
    expect(Object.keys(payload.run)).toEqual(["config_hash"]);
    expect(payload.studies).toEqual([]);
    expect(payload.checks).toEqual([]);
    expect(payload.model_calls).toHaveLength(1);
    expect(buildEvidencePayload({ aiCalls: [] }, { engineVersion: null, flags: {} })).toBeUndefined();
  });

  it("es determinista: construir dos veces con los mismos datos da el mismo contenido (base del reintento idéntico)", () => {
    const a = JSON.stringify(buildEvidencePayload({ analysis, aiCalls: events }, { engineVersion: "abc1234", flags: { semanticPrimary: true } }));
    const b = JSON.stringify(buildEvidencePayload({ analysis, aiCalls: events }, { engineVersion: "abc1234", flags: { semanticPrimary: true } }));
    expect(a).toBe(b);
  });
});

describe("fail-open y envío a WhatsApp", () => {
  function flow(server: ReturnType<typeof fakeSupabase>, overrides: Partial<QuoteDeps> = {}) {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const sendText = vi.fn(async () => ({ providerMessageId: "wamid.out" }));
    const deps: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult),
      sendText,
      log: (event, data) => logs.push([event, data]),
      audit: repositoryOver(server),
      ...overrides
    };
    return { deps, logs, sendText };
  }

  it("si Supabase no responde en ninguna escritura, el paciente recibe EXACTAMENTE un mensaje y el log solo lleva códigos", async () => {
    const server = fakeSupabase(["network", "network", "http500", "http502"]);
    const { deps, logs, sendText } = flow(server);
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(sendText).toHaveBeenCalledTimes(1);
    const unavailable = logs.filter(([event]) => event === "audit_unavailable").map(([, data]) => data);
    expect(unavailable).toEqual([{ stage: "evidence", kind: "UNKNOWN_OUTCOME" }, { stage: "reply", kind: "UNKNOWN_OUTCOME" }]);
    expect(JSON.stringify(logs)).not.toContain(SERVER_SECRET);
    expect(server.rpcCalls()).toHaveLength(4);
  });

  it("un timeout con resultado desconocido nunca repite el envío a WhatsApp", async () => {
    const server = fakeSupabase(["timeout-after-commit", "ok", "timeout-after-commit", "ok"]);
    const { deps, sendText } = flow(server);
    await handleImageMessage(image, deps);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(server.committed.size).toBe(2); // evidencia y envío, cada una confirmada una sola vez
  });

  it("si el envío falla con resultado incierto no se repite: se registra UNKNOWN y el procesamiento termina", async () => {
    const server = fakeSupabase();
    const { deps, sendText } = flow(server, { sendText: vi.fn(async () => { throw new Error("timeout"); }) });
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(deps.sendText).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(JSON.parse(server.rpcCalls().at(-1)!.body).p_reply).toMatchObject({ state: "UNKNOWN" });
  });

  const spyAudit = (): AuditRepository => ({ claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1", lease: LEASE, takeover: false })), recordIgnored: vi.fn(), renewLease: vi.fn(async () => true), reserveSend: vi.fn(async () => "reserved" as const), confirmSend: vi.fn(async () => "proceed" as const), recordEvidence: vi.fn(async () => undefined), recordFailure: vi.fn(async () => undefined), recordReply: vi.fn(async () => undefined) });

  it("si el análisis falla, solo se registran las llamadas de IA que ocurrieron (sin resumen inventado) y una sola vez", async () => {
    const audit = spyAudit();
    const { deps } = flow(fakeSupabase(), { audit, analyze: vi.fn(async () => { throw new Error("IA caída"); }) });
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(vi.mocked(audit.recordEvidence)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit.recordEvidence).mock.calls[0]![1]).not.toHaveProperty("analysis");
    expect(vi.mocked(audit.recordFailure)).toHaveBeenCalledWith("run-1", "AI_PROCESSING_FAILED", LEASE);
  });

  it("si la evidencia del análisis ya se intentó y algo falla después, no se vuelve a enviar (sería un contenido distinto)", async () => {
    const audit = spyAudit();
    const ok = { decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [] } as AnalysisResult;
    const { deps } = flow(fakeSupabase(), {
      audit,
      analyze: vi.fn(async () => ok),
      // el mensaje al paciente se arma después de persistir: forzamos el fallo ahí
      sendText: vi.fn(async () => ({ providerMessageId: "x" }))
    });
    Object.defineProperty(ok, "publicQuote", { get() { throw new Error("fallo al armar la respuesta"); } });
    await expect(handleImageMessage(image, deps)).resolves.toBe("ignored");
    expect(vi.mocked(audit.recordEvidence)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit.recordEvidence).mock.calls[0]![1]).toHaveProperty("analysis");
    expect(vi.mocked(audit.recordFailure)).toHaveBeenCalledWith("run-1", "UNEXPECTED_PROCESSING_FAILED", LEASE);
  });
});

describe("migraciones: orden y aditividad", () => {
  const dir = join(__dirname, "..", "supabase", "migrations");
  const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

  it("las migraciones anteriores (Fase 6, telemetría y transaccional) no se modificaron", async () => {
    expect(sha(await readFile(join(dir, "20261020000000_plusmedik_persistent_audit.sql"), "utf8"))).toBe("1110edc1e1b3f6c4961b87bdb763ecea535ef5b1d6ba9086ff314a86b88ad61a");
    expect(sha(await readFile(join(dir, "20261021000000_plusmedik_audit_telemetry.sql"), "utf8"))).toBe("08e555cf0c872ce2380cbd5046c2296a525c20b6caaddee6ae51ccdb53243256");
    expect(sha(await readFile(join(dir, "20261022000000_plusmedik_audit_transactional.sql"), "utf8"))).toBe("1135f673e0a8e5de5ef03dae1acae55427c01ff99f4a5988f90595abe9244079");
    expect(sha(await readFile(join(dir, "20261023000000_plusmedik_audit_leases.sql"), "utf8"))).toBe("1b6546c2a44142a00b771f303dccc43f5ea408cd912a340c3b3e406e63185ee7");
  });

  it("la migración de leases no crea tablas ni borra objetos, sin SQL dinámico, y cada función SECURITY DEFINER fija su search_path", async () => {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.slice(3, 5)).toEqual(["20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"]);
    const sql = (await readFile(join(dir, "20261023000000_plusmedik_audit_leases.sql"), "utf8")).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bcreate\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+/i);
    expect(sql).not.toMatch(/\bexecute\s+(format|'|\()/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    for (const definition of sql.split(/create or replace function/i).slice(1)) if (/security definer/i.test(definition)) expect(definition).toMatch(/set search_path = ''/);
    // ninguna función nueva queda ejecutable por PUBLIC: todas se revocan explícitamente
    for (const name of ["claim_run", "renew_lease", "fenced_record_evidence", "fenced_close", "reserve_send", "fenced_record_reply", "recover_stale", "block_send", "prove", "lock_leased"]) expect(sql).toMatch(new RegExp(`revoke all on function public\\.plusmedik_audit_${name}\\(`));
  });

  it("la migración transaccional es posterior a ambas, no crea tablas ni borra objetos", async () => {
    const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.slice(0, 3)).toEqual(["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql"]);
    const sql = (await readFile(join(dir, "20261022000000_plusmedik_audit_transactional.sql"), "utf8")).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bcreate\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+/i);
    expect(sql).not.toMatch(/\bexecute\s+(format|'|\()/i); // sin SQL dinámico
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    // cada función SECURITY DEFINER fija su search_path
    for (const definition of sql.split(/create or replace function/i).slice(1)) if (/security definer/i.test(definition)) expect(definition).toMatch(/set search_path = ''/);
  });
});
