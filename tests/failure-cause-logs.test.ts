import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPipeline } from "../src/audio/service.js";
import { createOpenAiTranscriber } from "../src/audio/transcribe.js";
import { AudioFailure } from "../src/audio/types.js";
import { AuditWriteError, auditErrorFields, createSupabaseAuditRepository, createSupabaseRpc } from "../src/audit.js";
import { cachedAiCall, withAiCallObserver, type AiCallEvent } from "../src/cache.js";
import { createConversationModel } from "../src/conversation-model.js";
import { beginTurn } from "../src/guarded-turn.js";
import { createStudyInterpreter, type InterpreterClient } from "../src/study-interpreter.js";
import { handleImageMessage, type QuoteDeps } from "../src/whatsapp-quote.js";
import { buildOggOpus } from "./support/ogg-opus.js";

// Causa EXACTA de los fallos en los registros (G7): cuota vs. tasa en OpenAI, estado HTTP y código del servidor en los rechazos de auditoría.
// Regla de oro que se prueba en todos los casos: en el registro entran SOLO códigos de lista blanca; jamás mensajes de error, cuerpos de respuesta, claves, cabeceras de autorización ni texto del paciente.

const SECRET_KEY = "sk-live-SECRETO-1234567890";
const PATIENT_TEXT = "mi hija Valentina tiene diabetes y necesita hemograma, mi cel 71234567";
const LEAKS = [SECRET_KEY, "Valentina", "diabetes", "71234567", "Bearer", "hemograma para"];
const noLeaks = (value: unknown) => { const dump = JSON.stringify(value); for (const leak of LEAKS) expect(dump, `fuga: ${leak}`).not.toContain(leak); };

// Error con la forma del SDK de OpenAI, cuyo mensaje y cuerpo traen datos sensibles a propósito.
function openAiError(status: number, code: string | null, type: string | undefined, headers: Record<string, string> = {}) {
  const error = new Error(`${status} ${PATIENT_TEXT} Authorization: Bearer ${SECRET_KEY}`) as Error & Record<string, unknown>;
  error.name = status === 429 ? "RateLimitError" : "APIError";
  Object.assign(error, { status, code, type, requestID: "req_causa_exacta_01", error: { message: PATIENT_TEXT }, headers: new Headers(headers) });
  return error;
}

describe("conversación con modelo · causa del fallo en el registro", () => {
  const make = (error: unknown) => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const model = createConversationModel({ client: { complete: async () => { throw error; } }, prompt: "Instrucciones {{DATOS}}", promptId: "p", model: "modelo-de-prueba", log: (event, data) => logs.push([event, data]) });
    return { model, logs };
  };

  it("un 429 por CUOTA se registra como QUOTA_OR_BILLING (no como simple límite de tasa), con estado, código y request id", async () => {
    const { model, logs } = make(openAiError(429, "insufficient_quota", "insufficient_quota", { "x-request-id": "req_ignorado" }));
    expect(await model.reply({ text: PATIENT_TEXT, category: "OTHER" })).toEqual({ status: "FALLBACK", reason: "RATE_LIMITED" });
    const [event, data] = logs[0]!;
    expect(event).toBe("llm_conversation");
    expect(data).toMatchObject({ outcome: "FALLBACK", reason: "RATE_LIMITED", cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota", errorType: "insufficient_quota", requestId: "req_causa_exacta_01" });
    noLeaks(logs);
  });

  it("un 429 por VELOCIDAD se registra como RATE_LIMIT con retry-after y los límites restantes", async () => {
    const { model, logs } = make(openAiError(429, "rate_limit_exceeded", "requests", { "retry-after": "20", "x-ratelimit-limit-requests": "3", "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "20s", authorization: `Bearer ${SECRET_KEY}` }));
    await model.reply({ text: "hola", category: "GREETING" });
    expect(logs[0]![1]).toMatchObject({ cause: "RATE_LIMIT", retryAfterS: 20, rl: { limitRequests: "3", remainingRequests: "0", resetRequests: "20s" } });
    noLeaks(logs);
  });

  it("un tiempo agotado y un error de servidor conservan su causa", async () => {
    const timeout = make(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" }));
    await timeout.model.reply({ text: "hola", category: "GREETING" });
    expect(timeout.logs[0]![1]).toMatchObject({ reason: "TIMEOUT", cause: "TIMEOUT" });
    const server = make(openAiError(503, null, undefined));
    await server.model.reply({ text: "hola", category: "GREETING" });
    expect(server.logs[0]![1]).toMatchObject({ reason: "ERROR", cause: "SERVER", httpStatus: 503 });
  });

  it("el comportamiento no cambió: sigue devolviendo FALLBACK y el circuito se abre igual tras 3 fallos", async () => {
    const { model, logs } = make(openAiError(429, "insufficient_quota", "insufficient_quota"));
    for (let i = 0; i < 3; i++) await model.reply({ text: "hola", category: "GREETING" });
    expect(await model.reply({ text: "hola", category: "GREETING" })).toEqual({ status: "FALLBACK", reason: "CIRCUIT_OPEN" });
    expect(logs.map(([, data]) => data.reason)).toEqual(["RATE_LIMITED", "RATE_LIMITED", "RATE_LIMITED", "CIRCUIT_OPEN"]);
  });
});

describe("intérprete de estudios · causa del fallo", () => {
  it("registra la causa del error del proveedor sin el mensaje", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const client: InterpreterClient = { run: async () => { throw openAiError(429, "insufficient_quota", "insufficient_quota"); } };
    const interpret = createStudyInterpreter({ client, model: "modelo-de-prueba", log: (event, data) => logs.push([event, data]) });
    const catalog = [{ id: "00000000-0000-4000-8000-000000000001", code: null, name: "HEMOGRAMA COMPLETO", normalizedName: "hemograma completo", normalizedAliases: ["hemograma"], priceBs: 45, active: true }];
    expect(await interpret("quiero cotizar hemograma completo", catalog, { hasDoubt: false })).toBeUndefined();
    expect(logs.at(-1)).toEqual(["quote_interpreter", expect.objectContaining({ outcome: "FALLBACK", reason: "ERROR", cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota" })]);
    noLeaks(logs);
  });
});

describe("rechazos HTTP de la auditoría · estado y código del servidor", () => {
  const rpcWith = (response: Response | (() => Response)) => createSupabaseRpc({ baseUrl: "https://example.supabase.co", serviceKey: "k-secreta", retryDelayMs: 0, fetchFn: (async () => (typeof response === "function" ? response() : response.clone())) as typeof fetch });
  const body = { code: "PT422", message: `plusmedik_audit: invalid claim ${PATIENT_TEXT}`, details: "Key (kapso_message_id)=(wamid.SECRETO) ...", hint: "revise la fila de Valentina" };

  it("un 400 con código PT422 deja status, serverCode y request id; el mensaje, los detalles y la pista NO salen", async () => {
    const rpc = rpcWith(new Response(JSON.stringify(body), { status: 400, headers: { "sb-request-id": "0190f7a2-3c4b-7d11-9a2e" } }));
    const error = await rpc("plusmedik_turn_claim", {}).catch((e: unknown) => e) as AuditWriteError;
    expect(error).toBeInstanceOf(AuditWriteError);
    expect(error.kind).toBe("REJECTED");
    expect(auditErrorFields(error)).toEqual({ kind: "REJECTED", httpStatus: 400, serverCode: "PT422", requestId: "0190f7a2-3c4b-7d11-9a2e" });
    noLeaks([auditErrorFields(error), error.message]);
    expect(JSON.stringify(auditErrorFields(error))).not.toContain("wamid");
  });

  it("distingue «función no encontrada» (404 PGRST202) de una validación (PT422) y de un permiso (401)", async () => {
    for (const [status, code] of [[404, "PGRST202"], [401, "PGRST301"], [400, "22P02"], [422, "PT422"]] as const) {
      const error = await rpcWith(new Response(JSON.stringify({ code, message: "m" }), { status }))("f", {}).catch((e: unknown) => e) as AuditWriteError;
      expect(auditErrorFields(error)).toMatchObject({ kind: "REJECTED", httpStatus: status, serverCode: code });
    }
  });

  it("un código que no cumple el patrón, un cuerpo que no es JSON o está vacío se descartan sin romper nada", async () => {
    for (const bad of [JSON.stringify({ code: "codigo con espacios y datos del paciente" }), "<html>502 Bad Gateway paciente 71234567</html>", "", JSON.stringify({ code: 42 }), "x".repeat(10_000)]) {
      const error = await rpcWith(new Response(bad, { status: 400 }))("f", {}).catch((e: unknown) => e) as AuditWriteError;
      expect(auditErrorFields(error)).toEqual({ kind: "REJECTED", httpStatus: 400 });
    }
  });

  it("tolera una respuesta mínima sin cuerpo ni cabeceras (dobles de prueba)", async () => {
    const rpc = createSupabaseRpc({ baseUrl: "https://example.supabase.co", serviceKey: "k", retryDelayMs: 0, fetchFn: (async () => ({ ok: false, status: 400 })) as unknown as typeof fetch });
    const error = await rpc("f", {}).catch((e: unknown) => e) as AuditWriteError;
    expect(auditErrorFields(error)).toEqual({ kind: "REJECTED", httpStatus: 400 });
  });

  it("el comportamiento NO cambió: 410 = lease perdido, 409 = conflicto, 5xx/red = resultado desconocido tras un reintento, 429/408 se reintentan", async () => {
    expect(((await rpcWith(new Response("{}", { status: 410 }))("f", {}).catch((e: unknown) => e)) as AuditWriteError).kind).toBe("LEASE_LOST");
    expect(((await rpcWith(new Response(JSON.stringify({ code: "PT409" }), { status: 409 }))("f", {}).catch((e: unknown) => e)) as AuditWriteError)).toMatchObject({ kind: "CONFLICT", httpStatus: 409, detail: { serverCode: "PT409" } });
    let calls = 0;
    const flaky = createSupabaseRpc({ baseUrl: "https://example.supabase.co", serviceKey: "k", retryDelayMs: 0, fetchFn: (async () => { calls++; return new Response("{}", { status: 503 }); }) as typeof fetch });
    const unknown = await flaky("f", {}).catch((e: unknown) => e) as AuditWriteError;
    expect(unknown).toMatchObject({ kind: "UNKNOWN_OUTCOME" });
    expect(auditErrorFields(unknown)).toEqual({ kind: "UNKNOWN_OUTCOME" });
    expect(calls).toBe(2);
  });

  it("beginTurn registra audit_unavailable con kind, httpStatus, serverCode y requestId (y nada más) cuando el claim es rechazado", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const deps = {
      audit: { claim: async () => { throw new AuditWriteError("REJECTED", 400, { serverCode: "PT422", requestId: "0190f7a2-3c4b-7d11-9a2e" }); } },
      turns: { contactKeyFor: () => "a".repeat(64) },
      log: (event: string, data: Record<string, unknown>) => logs.push([event, data])
    } as unknown as QuoteDeps;
    const begun = await beginTurn({ messageId: "wamid.x", from: "59170000000", kind: "TEXT", who: "591****0000" }, deps);
    expect(begun).toEqual({ ended: "ignored" });
    expect(logs[0]).toEqual(["audit_unavailable", { stage: "claim", kind: "REJECTED", httpStatus: 400, serverCode: "PT422", requestId: "0190f7a2-3c4b-7d11-9a2e" }]);
    expect(logs[1]).toEqual(["reply_withheld", { reason: "audit_guard_unavailable" }]);
  });
});

describe("fotos · qué llamada a qué modelo falló y por qué", () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { stderr = vi.spyOn(console, "error").mockImplementation(() => {}); vi.stubEnv("AI_CACHE", "off"); });
  afterEach(() => { stderr.mockRestore(); vi.unstubAllEnvs(); });

  it("el evento de la llamada fallida lleva `failure` (solo en memoria) con la causa", async () => {
    const events: AiCallEvent[] = [];
    await withAiCallObserver((event) => events.push(event), () =>
      cachedAiCall({ label: "reader_a", provider: "openai", model: "modelo-lector", imageBase64: "AAAA", config: { p: 1 }, parse: (raw) => raw, call: async () => { throw openAiError(429, "insufficient_quota", "insufficient_quota"); } }).catch(() => undefined));
    expect(events[0]).toMatchObject({ outcome: "FAILED", errorKind: "RATE_LIMITED", failure: { cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota" } });
  });

  it("la causa NO se guarda en la auditoría (la evidencia elige sus campos) aunque exista en el evento", async () => {
    const events: AiCallEvent[] = [];
    await withAiCallObserver((event) => events.push(event), () =>
      cachedAiCall({ label: "reader_a", provider: "openai", model: "modelo-lector", imageBase64: "AAAA", config: { p: 1 }, parse: (raw) => raw, call: async () => { throw openAiError(429, "insufficient_quota", "insufficient_quota"); } }).catch(() => undefined));
    const requests: Array<{ path: string; body: any }> = [];
    const repository = createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", retryDelayMs: 0, fetchFn: (async (input: unknown, init?: RequestInit) => { requests.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined }); return new Response("{}", { status: 200 }); }) as typeof fetch });
    await repository.recordEvidence("run-1", { aiCalls: events }, { owner: "owner-0000001", fence: 1 });
    const sent = JSON.stringify(requests);
    expect(sent).toContain("RATE_LIMITED");
    expect(sent).not.toContain("insufficient_quota");
    expect(sent).not.toContain("QUOTA_OR_BILLING");
    expect(sent).not.toContain("req_causa_exacta_01");
  });

  it("processing_failed trae aiFailures (etapa, proveedor, modelo, causa) y ningún dato del paciente cuando el análisis falla", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const deps = {
      downloadImage: async () => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]) }),
      loadCatalog: async () => [],
      analyze: async () => {
        await cachedAiCall({ label: "reader_a", provider: "openai", model: "modelo-lector", imageBase64: "AAAA", config: { p: 1 }, parse: (raw) => raw, call: async () => { throw openAiError(429, "insufficient_quota", "insufficient_quota"); } });
        throw new Error("nunca llega");
      },
      sendText: async () => ({ providerMessageId: "wamid.out" }),
      log: (event: string, data: Record<string, unknown>) => logs.push([event, data])
    } as unknown as QuoteDeps;
    await handleImageMessage({ messageId: "wamid.foto-1", from: "59170000000", mediaId: "m1" }, deps);
    const failed = logs.find(([event]) => event === "processing_failed");
    expect(failed).toBeDefined();
    expect(failed![1]).toMatchObject({ errorCode: "AI_PROCESSING_FAILED", aiFailures: [{ stage: "reader_a", provider: "openai", model: "modelo-lector", errorKind: "RATE_LIMITED", cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota" }] });
    noLeaks(logs);
  });
});

describe("audio · causa del fallo de la transcripción", () => {
  const OGG = () => buildOggOpus();
  const failing = (response: () => Response) => createOpenAiTranscriber({ apiKey: SECRET_KEY, model: "modelo-audio", timeoutMs: 1000, fetchFn: (async () => response()) as typeof fetch });

  it("un 429 por cuota deja la causa en AudioFailure, sin el cuerpo del proveedor", async () => {
    const transcribe = failing(() => new Response(JSON.stringify({ error: { message: `eco: ${PATIENT_TEXT}`, type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429, headers: { "retry-after": "30", "x-request-id": "req_audio_0001" } }));
    const error = await transcribe({ bytes: OGG(), format: "ogg" }).catch((e: unknown) => e) as AudioFailure;
    expect(error).toBeInstanceOf(AudioFailure);
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true, cause: { cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota", retryAfterS: 30, requestId: "req_audio_0001" } });
    noLeaks(error.cause);
  });

  it("el pipeline registra la causa en audio_job (retry y failed) y no cambia el código que ve el paciente", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const transcriber = failing(() => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: PATIENT_TEXT } }), { status: 429 }));
    const pipeline = new AudioPipeline({
      transcriber, log: (event, data) => logs.push([event, data]), sleep: async () => undefined, attempts: 2,
      fetcher: { rawFetch: async () => new Response(OGG(), { status: 200 }), authedFetch: async () => new Response(OGG(), { status: 200 }), sdkDownload: async () => OGG().buffer }
    });
    expect(await pipeline.resolve({ messageId: "wamid.a", from: "59170000000", mediaUrl: "https://media.kapso.ai/a.ogg" })).toEqual({ ok: false, code: "UNAVAILABLE" });
    const jobs = logs.filter(([event]) => event === "audio_job").map(([, data]) => data);
    expect(jobs[0]).toMatchObject({ event: "retry", code: "UNAVAILABLE", attempt: 1, cause: "QUOTA_OR_BILLING", httpStatus: 429, errorCode: "insufficient_quota" });
    expect(jobs.at(-1)).toMatchObject({ event: "failed", code: "UNAVAILABLE", cause: "QUOTA_OR_BILLING" });
    noLeaks(logs);
  });

  it("un error de red o de tiempo conserva su causa", async () => {
    const transcribe = createOpenAiTranscriber({ apiKey: SECRET_KEY, model: "modelo-audio", timeoutMs: 1000, fetchFn: (async () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }); }) as typeof fetch });
    const error = await transcribe({ bytes: OGG(), format: "ogg" }).catch((e: unknown) => e) as AudioFailure;
    expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true, cause: { cause: "TIMEOUT", errorName: "TimeoutError" } });
  });
});
