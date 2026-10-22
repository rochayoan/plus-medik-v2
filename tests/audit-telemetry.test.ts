import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_SCHEMA_VERSION,
  catalogFingerprint,
  computeConfigHash,
  createSupabaseAuditRepository,
  processingFailureCode,
  sanitizeFlags,
  type AuditRepository
} from "../src/audit.js";
import { analyzeImage, type AnalyzeDeps } from "../src/analyze.js";
import { readImageWithGeminiViaOpenRouter } from "../src/ai.js";
import type { SimpleReading } from "../src/ai.js";
import { cachedAiCall, classifyAiError, recordAiUsage, withAiCallObserver, type AiCallEvent, type AiUsage } from "../src/cache.js";
import { OfflineViolation } from "../src/offline.js";
import { handleImageMessage, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";
import type { AnalysisResult } from "../src/analyze.js";
import type { CatalogStudy } from "../src/types.js";

let dir: string;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "plusmedik-telemetry-"));
  vi.stubEnv("AI_CACHE_DIR", dir);
  vi.stubEnv("AI_CACHE", "off");
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  stderr.mockRestore();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (raw: unknown) => raw as { answer: string };
const PARAMS = { model: "m", reasoning: { effort: "high" }, schema: { type: "object" } };

function call(label: string, options: { delay?: number; fail?: unknown; usage?: AiUsage; config?: unknown; model?: string } = {}) {
  return cachedAiCall({
    label,
    provider: "test",
    model: options.model ?? "test-model",
    imageBase64: `image-${label}`,
    config: options.config ?? { prompt: "PROMPT_SENTINELA_PACIENTE", mimeType: "image/jpeg", params: PARAMS },
    parse,
    call: async () => {
      if (options.delay) await sleep(options.delay);
      if (options.fail) throw options.fail;
      return { value: { answer: label }, usage: options.usage };
    }
  });
}

async function observed<T>(operation: () => Promise<T>): Promise<{ events: AiCallEvent[]; result: T }> {
  const events: AiCallEvent[] = [];
  const result = await withAiCallObserver((event) => events.push(event), operation);
  return { events, result };
}

describe("telemetría por llamada: aislamiento entre procesamientos concurrentes", () => {
  it("dos procesamientos en paralelo no mezclan eventos ni comparten numeración", async () => {
    const a = observed(async () => { await Promise.all([call("a1", { delay: 30 }), call("a2", { delay: 5 })]); });
    const b = observed(async () => { await sleep(2); await Promise.all([call("b1", { delay: 10 }), call("b2"), call("b3", { delay: 20 })]); });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.events.map((event) => event.label).sort()).toEqual(["a1", "a2"]);
    expect(rb.events.map((event) => event.label).sort()).toEqual(["b1", "b2", "b3"]);
    expect(ra.events.map((event) => event.callSeq).sort()).toEqual([1, 2]);
    expect(rb.events.map((event) => event.callSeq).sort()).toEqual([1, 2, 3]);
    expect(ra.events.map((event) => event.completionSeq).sort()).toEqual([1, 2]);
    expect(rb.events.map((event) => event.completionSeq).sort()).toEqual([1, 2, 3]);
  });

  it("sin observador no se mide ni se emite nada y la llamada devuelve lo mismo", async () => {
    await expect(call("solo")).resolves.toEqual({ answer: "solo" });
  });
});

describe("telemetría por llamada: orden de inicio, de finalización y latencia", () => {
  it("el orden de inicio es el de invocación aunque terminen en otro orden; nunca se supone que coinciden", async () => {
    const { events } = await observed(() => Promise.all([call("lenta", { delay: 60 }), call("rapida", { delay: 5 }), call("media", { delay: 30 })]));
    const bySeq = (label: string) => events.find((event) => event.label === label)!;
    expect([bySeq("lenta").callSeq, bySeq("rapida").callSeq, bySeq("media").callSeq]).toEqual([1, 2, 3]);
    expect([bySeq("rapida").completionSeq, bySeq("media").completionSeq, bySeq("lenta").completionSeq]).toEqual([1, 2, 3]);
    // el orden de registro de los eventos es el de finalización, distinto del de inicio
    expect(events.map((event) => event.label)).toEqual(["rapida", "media", "lenta"]);
    expect(events.map((event) => event.callSeq)).not.toEqual([...events.map((event) => event.callSeq)].sort());
  });

  it("mide inicio y duración con el reloj del proceso", async () => {
    const before = Date.now();
    const { events } = await observed(() => call("medida", { delay: 40 }));
    const [event] = events;
    expect(event!.durationMs).toBeGreaterThanOrEqual(35);
    expect(event!.durationMs).toBeLessThan(2000);
    expect(Number.isInteger(event!.durationMs)).toBe(true);
    const startedAt = Date.parse(event!.startedAt!);
    expect(startedAt).toBeGreaterThanOrEqual(before - 1);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
    expect(event!.attempt).toBe(1);
  });

  it("registra proveedor, modelo, etapa, esfuerzo de razonamiento configurado y hash de parámetros (no del prompt)", async () => {
    const { events } = await observed(() => call("etapa-x", { model: "modelo-x" }));
    expect(events[0]).toMatchObject({ label: "etapa-x", provider: "test", model: "modelo-x", outcome: "OK", cacheHit: false, reasoningEffort: "high" });
    expect(events[0]!.paramsHash).toBe(createHash("sha256").update(JSON.stringify(PARAMS)).digest("hex"));
    const other = await observed(() => call("etapa-x", { config: { prompt: "OTRO PROMPT CON OTROS TEXTOS", params: PARAMS } }));
    expect(other.events[0]!.paramsHash).toBe(events[0]!.paramsHash);
  });

  it("sin esfuerzo de razonamiento en la configuración queda desconocido (no se inventa)", async () => {
    const { events } = await observed(() => call("sin-razonamiento", { config: { prompt: "p", params: { model: "m" } } }));
    expect(events[0]!.reasoningEffort).toBeUndefined();
    const nothing = await observed(() => call("sin-params", { config: { prompt: "p" } }));
    expect(nothing.events[0]!.paramsHash).toBeUndefined();
  });
});

describe("telemetría por llamada: éxito, fallo, caché y reintentos", () => {
  it("una llamada fallida emite FAILED con clase tipada, sin uso, y relanza el MISMO error", async () => {
    const error = Object.assign(new Error("secret=sk-SECRETO-123 telefono=59170000000"), { status: 429 });
    const { events, result } = await observed(() => call("falla", { fail: error }).then(() => "no", (caught) => caught));
    expect(result).toBe(error);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "FAILED", cacheHit: false, errorKind: "RATE_LIMITED", attempt: 1 });
    expect(events[0]!.usage).toBeUndefined();
    expect(events[0]!.value).toBeUndefined();
    expect(JSON.stringify(events[0])).not.toContain("SECRETO");
  });

  it("un cache hit se emite como CACHE_HIT, numerado en orden, sin llamada externa", async () => {
    vi.stubEnv("AI_CACHE", "on");
    let externalCalls = 0;
    const run = () => cachedAiCall({
      label: "cacheable", provider: "test", model: "m", imageBase64: "img", config: { prompt: "p", params: PARAMS }, parse,
      call: async () => { externalCalls++; return { value: { answer: "x" }, usage: { inputTokens: 11, outputTokens: 4 } }; }
    });
    const first = await observed(run);
    const second = await observed(async () => { await call("otra"); return run(); });
    expect(externalCalls).toBe(1);
    expect(first.events[0]).toMatchObject({ outcome: "OK", cacheHit: false, callSeq: 1 });
    const hit = second.events.find((event) => event.label === "cacheable")!;
    expect(hit).toMatchObject({ outcome: "CACHE_HIT", cacheHit: true, attempt: 1, callSeq: 2 });
    expect(hit.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.result).toEqual({ answer: "x" });
  });

  it("los intentos inválidos que el motor notifica son intentos de la MISMA llamada, con su propio esfuerzo", async () => {
    const { events } = await observed(() => cachedAiCall({
      label: "reintenta", provider: "test", model: "m", imageBase64: "img", config: { prompt: "p", params: PARAMS }, parse,
      call: async () => {
        await sleep(10);
        await recordAiUsage({ label: "reintenta", provider: "test", model: "m", usage: { inputTokens: 5, costUsd: 0.001 }, invalid: true, reasoningEffort: "medium" });
        await sleep(10);
        return { value: { answer: "ok" }, usage: { inputTokens: 6, costUsd: 0.002 }, reasoningEffort: "low" };
      }
    }));
    expect(events.map((event) => [event.callSeq, event.attempt, event.outcome, event.reasoningEffort])).toEqual([[1, 1, "INVALID", "medium"], [1, 2, "OK", "low"]]);
    expect(events.map((event) => event.completionSeq)).toEqual([1, 2]);
    expect(events[0]!.usage).toEqual({ inputTokens: 5, costUsd: 0.001 });
    expect(events[1]!.usage).toEqual({ inputTokens: 6, costUsd: 0.002 });
    // el segundo intento se mide desde que terminó el primero
    expect(Date.parse(events[1]!.startedAt!)).toBeGreaterThanOrEqual(Date.parse(events[0]!.startedAt!));
  });

  it("si tras respuestas inválidas la llamada se agota, el fallo queda como SCHEMA_INVALID en el intento siguiente", async () => {
    const { events } = await observed(() => cachedAiCall({
      label: "agota", provider: "test", model: "m", imageBase64: "img", config: { prompt: "p", params: PARAMS }, parse,
      call: async () => {
        await recordAiUsage({ label: "agota", provider: "test", model: "m", invalid: true });
        throw new Error("Respuesta inválida con texto libre del proveedor");
      }
    }).catch(() => undefined));
    expect(events.map((event) => [event.attempt, event.outcome, event.errorKind])).toEqual([[1, "INVALID", undefined], [2, "FAILED", "SCHEMA_INVALID"]]);
  });

  it("recordAiUsage fuera de una llamada lógica es un evento propio, sin tiempos inventados", async () => {
    const { events } = await observed(async () => { await call("antes"); await recordAiUsage({ label: "suelto", provider: "test", model: "m", usage: { inputTokens: 1 } }); });
    const loose = events.find((event) => event.label === "suelto")!;
    expect(loose).toMatchObject({ callSeq: 2, attempt: 1, outcome: "OK" });
    expect(loose.startedAt).toBeUndefined();
    expect(loose.durationMs).toBeUndefined();
  });

  it("un observador que lanza nunca interrumpe la llamada", async () => {
    const value = await withAiCallObserver(() => { throw new Error("observador roto"); }, () => call("resiste"));
    expect(value).toEqual({ answer: "resiste" });
  });
});

describe("clasificación tipada de errores (sin leer el mensaje)", () => {
  const typed = (props: Record<string, unknown>, name = "Error") => Object.assign(new Error("429 timeout ECONNRESET catalog media"), { name }, props);
  it.each([
    [typed({ status: 429 }), "RATE_LIMITED"],
    [typed({ status: 408 }), "TIMEOUT"],
    [typed({ status: 504 }), "TIMEOUT"],
    [typed({ status: 503 }), "HTTP_SERVER"],
    [typed({ status: 401 }), "HTTP_CLIENT"],
    [typed({}, "AbortError"), "TIMEOUT"],
    [typed({}, "APIConnectionTimeoutError"), "TIMEOUT"],
    [typed({ code: "ECONNRESET" }), "NETWORK"],
    [typed({ code: "ETIMEDOUT" }), "TIMEOUT"],
    [typed({}, "APIConnectionError"), "NETWORK"],
    [typed({}, "ZodError"), "SCHEMA_INVALID"],
    [new SyntaxError("Unexpected token"), "SCHEMA_INVALID"],
    [new OfflineViolation("fetch x"), "BLOCKED"],
    [typed({}, "PaidCallBlockedError"), "BLOCKED"]
  ])("%#", (error, expected) => expect(classifyAiError(error)).toBe(expected));

  it("el texto del mensaje nunca decide: un Error plano con palabras de red o de límite es UNKNOWN", () => {
    expect(classifyAiError(new Error("429 rate limit timeout ECONNRESET 503 network"))).toBe("UNKNOWN");
    expect(classifyAiError("429")).toBe("UNKNOWN");
    expect(classifyAiError(undefined)).toBe("UNKNOWN");
    expect(classifyAiError(null)).toBe("UNKNOWN");
  });

  it("una llamada bloqueada por el modo offline también deja un evento FAILED/BLOCKED", async () => {
    const error = new OfflineViolation("llamada x");
    const { events } = await observed(() => call("bloqueada", { fail: error }).catch(() => undefined));
    expect(events[0]).toMatchObject({ outcome: "FAILED", errorKind: "BLOCKED" });
  });
});

// ───────────────────────────── lo que llega a Supabase ─────────────────────────────

type Captured = { method: string; path: string; body: any };
function repositoryWith(options: Partial<Parameters<typeof createSupabaseAuditRepository>[0]> = {}) {
  const requests: Captured[] = [];
  const repository = createSupabaseAuditRepository({
    baseUrl: "https://example.supabase.co",
    serviceKey: "test-service-key-SECRETA",
    fetchFn: async (input, init) => {
      const path = String(input).replace("https://example.supabase.co/rest/v1/", "");
      requests.push({ method: String(init?.method ?? "GET"), path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.includes("on_conflict")) return new Response(JSON.stringify([{ id: "run-1" }]), { status: 201 });
      return new Response("", { status: 201 });
    },
    ...options
  });
  return { repository, requests };
}
const rowsOf = (requests: Captured[]) => requests.filter((request) => request.path === "plusmedik_audit_model_calls").flatMap((request) => request.body as Array<Record<string, unknown>>);
const image: IncomingImage = { messageId: "wamid.telemetry-1", from: "59170000000", mediaId: "media-1" };

describe("persistencia de la telemetría", () => {
  it("guarda orden, tiempos, intento, esfuerzo, hash de parámetros y clase de error; sin inventar lo que no se midió", async () => {
    const failing = Object.assign(new Error("secret=sk-SECRETO-123"), { status: 500 });
    const { events } = await observed(async () => {
      await Promise.all([call("ok", { delay: 15, usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, costUsd: 0.0123 } }), call("falla", { fail: failing }).catch(() => undefined), call("sin-uso")]);
    });
    const { repository, requests } = repositoryWith();
    await repository.recordAiCalls("run-1", events);
    const rows = rowsOf(requests);
    expect(rows).toHaveLength(3);
    const byStage = (stage: string) => rows.find((row) => row.stage === stage)!;
    expect(byStage("ok")).toMatchObject({ call_seq: 1, attempt: 1, outcome: "OK", input_tokens: 10, output_tokens: 4, reasoning_tokens: 2, cost_usd: 0.0123, cost_status: "PROVIDER_REPORTED", reasoning_effort: "high", error_kind: null });
    expect(byStage("ok").duration_ms).toBeGreaterThanOrEqual(10);
    expect(byStage("falla")).toMatchObject({ call_seq: 2, outcome: "FAILED", error_kind: "HTTP_SERVER", input_tokens: null, cost_usd: null, cost_status: "UNAVAILABLE" });
    expect(byStage("sin-uso")).toMatchObject({ call_seq: 3, input_tokens: null, output_tokens: null, reasoning_tokens: null, cost_usd: null, cost_status: "UNAVAILABLE" });
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(String(row.params_hash)))).toBe(true);
  });

  it("solo informa costo si el proveedor lo reportó: tokens sin costo no generan costo", async () => {
    const { events } = await observed(async () => { await call("tokens", { usage: { inputTokens: 3, outputTokens: 1 } }); });
    const { repository, requests } = repositoryWith();
    await repository.recordAiCalls("run-1", events);
    expect(rowsOf(requests)[0]).toMatchObject({ cost_usd: null, cost_status: "TOKENS_ONLY", input_tokens: 3 });
  });

  it("un cache hit no consume tokens ni costo en este procesamiento: el uso guardado no se persiste", async () => {
    const { repository, requests } = repositoryWith();
    await repository.recordAiCalls("run-1", [{ label: "x", provider: "p", model: "m", cacheHit: true, outcome: "CACHE_HIT", usage: { inputTokens: 999, outputTokens: 99, costUsd: 5 }, callSeq: 1, attempt: 1 }]);
    expect(rowsOf(requests)[0]).toMatchObject({ cache_hit: true, input_tokens: null, output_tokens: null, reasoning_tokens: null, cost_usd: null, cost_status: "NO_PROVIDER_CALL" });
  });

  it("no persiste secretos, prompts, mensajes de error ni texto clínico", async () => {
    const failing = Object.assign(new Error("secret=sk-SECRETO-123 paciente=JUAN PEREZ"), { status: 500 });
    const { events } = await observed(async () => {
      await call("uno", { usage: { inputTokens: 1 } });
      await call("dos", { fail: failing }).catch(() => undefined);
    });
    const { repository, requests } = repositoryWith({ runtime: { engineVersion: "A1B2C3D4E5F6", flags: { semanticPrimary: true, apiKey: "sk-live-abc", note: "texto libre con espacios", authToken: "x" } } });
    await repository.claim(image);
    await repository.recordAiCalls("run-1", events);
    const dump = JSON.stringify(requests);
    for (const forbidden of ["PROMPT_SENTINELA_PACIENTE", "SECRETO", "JUAN PEREZ", "test-service-key-SECRETA", "59170000000", "sk-live-abc", "texto libre", "authToken"]) expect(dump).not.toContain(forbidden);
  });

  it("registros previos: eventos sin telemetría producen las mismas claves, con NULL", async () => {
    const legacy: AiCallEvent = { label: "legado", provider: "p", model: "m", cacheHit: false, outcome: "OK", usage: { inputTokens: 2 } };
    const { events } = await observed(async () => { await call("nuevo", { usage: { inputTokens: 2 } }); });
    const { repository, requests } = repositoryWith();
    await repository.recordAiCalls("run-1", [legacy, ...events]);
    const [oldRow, newRow] = rowsOf(requests);
    expect(Object.keys(oldRow!).sort()).toEqual(Object.keys(newRow!).sort());
    expect(oldRow).toMatchObject({ call_seq: null, completion_seq: null, attempt: null, started_at: null, duration_ms: null, reasoning_effort: null, params_hash: null, error_kind: null });
  });

  it("valores fuera de rango o con formato inesperado se descartan (NULL) en vez de llegar a la base", async () => {
    const odd = { label: "raro", provider: "p", model: "m", cacheHit: false, outcome: "OK", callSeq: 0, completionSeq: -3, attempt: 1.5, durationMs: -1, startedAt: "no es fecha", reasoningEffort: "alto; drop table", paramsHash: "xyz", errorKind: "texto libre" } as unknown as AiCallEvent;
    const { repository, requests } = repositoryWith();
    await repository.recordAiCalls("run-1", [odd]);
    expect(rowsOf(requests)[0]).toMatchObject({ call_seq: null, completion_seq: null, attempt: null, duration_ms: null, started_at: null, reasoning_effort: null, params_hash: null, error_kind: null });
  });
});

describe("versionado de configuración", () => {
  it("el claim registra versión del contrato, versión del motor y banderas funcionales", async () => {
    const { repository, requests } = repositoryWith({ runtime: { engineVersion: "A1B2C3D4E5F6A7B8", flags: { semanticPrimary: true, handwrittenAuto: "on", partialAuto: true } } });
    await repository.claim(image);
    expect(requests[0]!.body).toMatchObject({ audit_schema_version: AUDIT_SCHEMA_VERSION, engine_version: "a1b2c3d4e5f6a7b8", flags: { handwrittenAuto: "on", partialAuto: true, semanticPrimary: true } });
  });

  it("sin versión de motor disponible queda desconocida (NULL), no inventada; VERCEL_GIT_COMMIT_SHA se usa si es válida", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const none = repositoryWith();
    await none.repository.claim(image);
    expect(none.requests[0]!.body).toMatchObject({ engine_version: null, flags: {} });
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "b4fec3484bd0feb3e3a564a1c22cf7ee125ed3ae");
    const fromEnv = repositoryWith();
    await fromEnv.repository.claim(image);
    expect(fromEnv.requests[0]!.body.engine_version).toBe("b4fec3484bd0feb3e3a564a1c22cf7ee125ed3ae");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "no-es-un-sha; select *");
    const invalid = repositoryWith();
    await invalid.repository.claim(image);
    expect(invalid.requests[0]!.body.engine_version).toBeNull();
  });

  it("sanitizeFlags descarta secretos, textos libres y valores no simples", () => {
    expect(sanitizeFlags({ b: true, a: "on", n: 2, apiKey: "sk-1", SECRET_X: "x", longText: "x".repeat(40), spaced: "a b", obj: { x: 1 }, nan: Number.NaN, "1bad": true })).toEqual({ a: "on", b: true, n: 2 });
  });

  it("el hash de configuración es estable, no depende del orden de las llamadas y cambia con modelo, parámetros, banderas o motor", () => {
    const event = (label: string, model: string, paramsHash?: string): AiCallEvent => ({ label, provider: "p", model, cacheHit: false, outcome: "OK", paramsHash });
    const h = "a".repeat(64);
    const base = { engineVersion: "abc1234", flags: { semanticPrimary: true }, events: [event("lector", "m1", h), event("juez", "m2", h)] };
    const hash = computeConfigHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeConfigHash({ ...base, events: [...base.events].reverse() })).toBe(hash);
    expect(computeConfigHash({ ...base, events: [...base.events, event("lector", "m1", h)] })).toBe(hash);
    expect(computeConfigHash({ ...base, events: [event("lector", "m1", h), event("juez", "m3", h)] })).not.toBe(hash);
    expect(computeConfigHash({ ...base, events: [event("lector", "m1", "b".repeat(64)), event("juez", "m2", h)] })).not.toBe(hash);
    expect(computeConfigHash({ ...base, flags: { semanticPrimary: false } })).not.toBe(hash);
    expect(computeConfigHash({ ...base, engineVersion: "def5678" })).not.toBe(hash);
    expect(computeConfigHash({ ...base, engineVersion: undefined })).not.toBe(hash);
  });

  it("recordAiCalls guarda el hash de configuración del procesamiento y no lo toca si no hubo llamadas", async () => {
    const { events } = await observed(async () => { await call("uno"); });
    const { repository, requests } = repositoryWith({ runtime: { engineVersion: "abc1234", flags: { semanticPrimary: true } } });
    await repository.recordAiCalls("run-1", events);
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toEqual({ config_hash: computeConfigHash({ engineVersion: "abc1234", flags: { semanticPrimary: true }, events }) });
    const empty = repositoryWith();
    await empty.repository.recordAiCalls("run-1", []);
    expect(empty.requests).toHaveLength(0);
  });

  const study = (id: string, priceBs: number, extra: Partial<CatalogStudy> = {}): CatalogStudy => ({ id, code: id, name: `ESTUDIO ${id}`, normalizedName: `estudio ${id}`, normalizedAliases: ["b", "a"], priceBs, active: true, ...extra });

  it("la huella del catálogo no depende del orden y cambia con precios, aliases o estado; se calcula sin llamadas", () => {
    const catalog = [study("2", 20), study("1", 10)];
    const { hash, size } = catalogFingerprint(catalog);
    expect(size).toBe(2);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogFingerprint([...catalog].reverse()).hash).toBe(hash);
    expect(catalogFingerprint([study("2", 20, { normalizedAliases: ["a", "b"] }), study("1", 10)]).hash).toBe(hash);
    expect(catalogFingerprint([study("2", 21), study("1", 10)]).hash).not.toBe(hash);
    expect(catalogFingerprint([study("2", 20, { normalizedAliases: ["a", "c"] }), study("1", 10)]).hash).not.toBe(hash);
    expect(catalogFingerprint([study("2", 20, { active: false }), study("1", 10)]).hash).not.toBe(hash);
    expect(catalog.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("recordAnalysis guarda la huella del catálogo; sin contexto queda NULL", async () => {
    const analysis = { decision: "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [] } as AnalysisResult;
    const fingerprint = catalogFingerprint([study("1", 10)]);
    const withCatalog = repositoryWith();
    await withCatalog.repository.recordAnalysis("run-1", analysis, { catalog: fingerprint });
    expect(withCatalog.requests.find((request) => request.method === "PATCH")!.body).toMatchObject({ catalog_hash: fingerprint.hash, catalog_size: 1 });
    const without = repositoryWith();
    await without.repository.recordAnalysis("run-1", analysis);
    expect(without.requests.find((request) => request.method === "PATCH")!.body).toMatchObject({ catalog_hash: null, catalog_size: null });
  });
});

// ───────────────────────────── flujo de WhatsApp ─────────────────────────────

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
function auditSpy(): AuditRepository {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1" })),
    recordIgnored: vi.fn(async () => undefined),
    recordAnalysis: vi.fn(async () => undefined),
    recordAiCalls: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    recordReply: vi.fn(async () => undefined)
  };
}
function quoteDeps(overrides: Partial<QuoteDeps>, audit = auditSpy()) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => [{ id: "1", code: "1", name: "X", normalizedName: "x", normalizedAliases: [], priceBs: 10, active: true }]),
    analyze: vi.fn(async () => ({ decision: "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [] }) as AnalysisResult),
    sendText: vi.fn(async () => ({ providerMessageId: "wamid.out" })),
    log: (event, data) => logs.push([event, data]),
    audit,
    ...overrides
  };
  return { deps, audit, logs };
}

describe("clasificación de fallos del procesamiento: por etapa, no por texto", () => {
  const misleading = "catalog supabase media download image openai gemini model response reasoning";
  it("cada etapa produce su código aunque el mensaje mencione palabras de otra", async () => {
    const download = quoteDeps({ downloadImage: vi.fn(async () => { throw new Error("catalog openai gemini"); }) });
    await handleImageMessage(image, download.deps);
    expect(download.audit.recordFailure).toHaveBeenCalledWith("run-1", "MEDIA_DOWNLOAD_FAILED");

    const catalog = quoteDeps({ loadCatalog: vi.fn(async () => { throw new Error("media download image openai"); }) });
    await handleImageMessage(image, catalog.deps);
    expect(catalog.audit.recordFailure).toHaveBeenCalledWith("run-1", "CATALOG_LOAD_FAILED");

    const analysis = quoteDeps({ analyze: vi.fn(async () => { throw new Error("catalog supabase media download image"); }) });
    await handleImageMessage(image, analysis.deps);
    expect(analysis.audit.recordFailure).toHaveBeenCalledWith("run-1", "AI_PROCESSING_FAILED");
  });

  it("un fallo posterior al análisis es inesperado y nunca se persiste ni se registra el mensaje del error", async () => {
    const after = quoteDeps({});
    after.deps.analyze = vi.fn(async () => ({ get outcome(): never { throw new Error(`${misleading} secret=sk-SECRETO`); } }) as unknown as AnalysisResult);
    await expect(handleImageMessage(image, after.deps)).resolves.toBe("technical_issue");
    expect(after.audit.recordFailure).toHaveBeenCalledWith("run-1", "UNEXPECTED_PROCESSING_FAILED");
    expect(JSON.stringify([vi.mocked(after.audit.recordFailure).mock.calls, after.logs])).not.toContain("SECRETO");
    expect(JSON.stringify(after.logs)).not.toContain("secret=");
  });

  it("processingFailureCode es total sobre las etapas", () => {
    expect(["MEDIA_DOWNLOAD", "CATALOG_LOAD", "AI_ANALYSIS", "OTHER"].map((phase) => processingFailureCode(phase as never))).toEqual(["MEDIA_DOWNLOAD_FAILED", "CATALOG_LOAD_FAILED", "AI_PROCESSING_FAILED", "UNEXPECTED_PROCESSING_FAILED"]);
  });

  it("el análisis recibe la huella del catálogo cargado (sin llamadas adicionales)", async () => {
    const run = quoteDeps({});
    const loaded = await run.deps.loadCatalog();
    await handleImageMessage(image, run.deps);
    expect(vi.mocked(run.audit.recordAnalysis).mock.calls[0]![2]).toEqual({ catalog: catalogFingerprint(loaded) });
    expect(run.deps.loadCatalog).toHaveBeenCalledTimes(2); // la de esta prueba y la del flujo
  });
});

// ───────────────────────────── el motor no cambia ─────────────────────────────

const reading = (...texts: string[]): SimpleReading => ({
  requestedStudies: texts.map((text) => ({ literalText: text, normalizedName: text, evidence: "check" as const, confidence: "high" as const })),
  uncertainStudies: [],
  notes: ""
});
const catalog: CatalogStudy[] = [
  { id: "uuid-1", code: "1", name: "SODIO", normalizedName: "sodio", normalizedAliases: [], priceBs: 60, active: true },
  { id: "uuid-2", code: "2", name: "POTASIO", normalizedName: "potasio", normalizedAliases: [], priceBs: 60, active: true }
];

function engineDeps(): AnalyzeDeps {
  const throughCache = (label: string) => async () => cachedAiCall({
    label, provider: "test", model: "m", imageBase64: "img", config: { prompt: "p", params: PARAMS }, parse: (raw) => raw as SimpleReading,
    call: async () => { await sleep(3); return { value: reading("Sodio", "Potasio"), usage: { inputTokens: 5 } }; }
  });
  return {
    readGemini: throughCache("lector-a"),
    readOpenAI: throughCache("lector-b"),
    judge: async () => ({ resolvedStudies: [], unresolvedDisputes: [] }),
    readDocument: async () => ({ signal: { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [], verifiedEdges: [], edgeNotes: [] }, reasons: ["", ""] } }),
    resolveSemantic: async () => { throw new Error("no debe llamarse"); },
    shadowMatch: async () => { throw new Error("no debe llamarse"); }
  } as unknown as AnalyzeDeps;
}

describe("la telemetría no cambia al motor", () => {
  it("analyzeImage devuelve exactamente lo mismo con y sin observador (las llamadas pasan por cachedAiCall)", async () => {
    const plain = await analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, partialAuto: true }, engineDeps());
    const { events, result } = await observed(() => analyzeImage({ imageBase64: "x", mimeType: "image/jpeg", catalog, partialAuto: true }, engineDeps()));
    expect(events.map((event) => event.label).sort()).toEqual(["lector-a", "lector-b"]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(plain));
  });

  it("cachedAiCall devuelve el mismo valor y escribe la misma entrada de caché con y sin observador", async () => {
    vi.stubEnv("AI_CACHE", "on");
    const sample = (suffix: string) => cachedAiCall({
      label: "igual", provider: "test", model: "m", imageBase64: `img-${suffix}`, config: { prompt: "p", params: PARAMS }, parse,
      call: async () => ({ value: { answer: "x" }, usage: { inputTokens: 9, costUsd: 0.5 } })
    });
    const plain = await sample("a");
    const { result } = await observed(() => sample("b"));
    expect(result).toEqual(plain);
    const entries = await Promise.all((await readdir(join(dir, "ai"))).map(async (file) => JSON.parse(await readFile(join(dir, "ai", file), "utf8"))));
    expect(entries).toHaveLength(2);
    const strip = ({ key: _key, createdAt: _createdAt, ...rest }: Record<string, unknown>) => rest;
    expect(strip(entries[0])).toEqual(strip(entries[1]));
    expect(Object.keys(entries[0]).sort()).toEqual(["cacheVersion", "createdAt", "key", "label", "model", "provider", "usage", "value"]);
  });

  it("usage.jsonl conserva su formato (la telemetría no agrega campos)", async () => {
    await observed(async () => { await recordAiUsage({ label: "l", provider: "p", model: "m", usage: { inputTokens: 1 }, invalid: true, reasoningEffort: "low" }); });
    const line = JSON.parse((await readFile(join(dir, "usage.jsonl"), "utf8")).trim());
    expect(Object.keys(line).sort()).toEqual(["cacheHit", "cacheMode", "invalid", "label", "model", "provider", "timestamp", "usage"]);
  });
});

// ───────────────────────────── migración SQL ─────────────────────────────

const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const stripComments = (sql: string) => sql.replace(/--.*$/gm, "");

describe("migración aditiva de telemetría", () => {
  it("la migración original de la Fase 6 no se modificó", async () => {
    const original = normalize(await readFile(join(migrationsDir, "20261020000000_plusmedik_persistent_audit.sql"), "utf8"));
    expect(createHash("sha256").update(original).digest("hex")).toBe("1110edc1e1b3f6c4961b87bdb763ecea535ef5b1d6ba9086ff314a86b88ad61a");
  });

  it("solo agrega columnas, restricciones e índices: no borra, no actualiza y no crea tablas", async () => {
    const sql = stripComments(normalize(await readFile(join(migrationsDir, "20261021000000_plusmedik_audit_telemetry.sql"), "utf8")));
    expect(sql).not.toMatch(/\b(drop|delete|truncate|update|insert|rename|grant|revoke|create\s+table|create\s+or\s+replace)\b/i);
    expect(sql).not.toMatch(/add column[^,;]*\b(not null|default)\b/i);
    for (const alter of sql.match(/alter table [^\n]+/gi) ?? []) expect(alter).toMatch(/alter table public\.plusmedik_audit_(runs|model_calls)\b(?! (drop|rename))/i);
  });

  it("las columnas nuevas coinciden con lo que el repositorio escribe (sin deriva)", async () => {
    const sql = normalize(await readFile(join(migrationsDir, "20261021000000_plusmedik_audit_telemetry.sql"), "utf8"));
    const original = normalize(await readFile(join(migrationsDir, "20261020000000_plusmedik_persistent_audit.sql"), "utf8"));
    const added = (table: string) => {
      const block = sql.match(new RegExp(`alter table public\\.${table}\\n([\\s\\S]*?);`))![1]!;
      return [...block.matchAll(/add column if not exists (\w+)/g)].map((match) => match[1]!);
    };
    const original_ = (table: string) => {
      const block = original.match(new RegExp(`create table if not exists public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`))![1]!;
      return [...block.matchAll(/^\s{2}(\w+) /gm)].map((match) => match[1]!).filter((name) => name !== "unique");
    };
    const { events } = await observed(async () => { await call("uno", { usage: { inputTokens: 1 } }); });
    const { repository, requests } = repositoryWith({ runtime: { engineVersion: "abc1234", flags: { semanticPrimary: true } } });
    await repository.claim(image);
    await repository.recordAnalysis("run-1", { decision: "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [] } as AnalysisResult, { catalog: catalogFingerprint(catalog) });
    await repository.recordAiCalls("run-1", events);

    const runColumns = new Set([...original_("plusmedik_audit_runs"), ...added("plusmedik_audit_runs")]);
    const callColumns = new Set([...original_("plusmedik_audit_model_calls"), ...added("plusmedik_audit_model_calls")]);
    for (const request of requests) {
      const rows = (Array.isArray(request.body) ? request.body : [request.body]) as Array<Record<string, unknown>>;
      const allowed = request.path.startsWith("plusmedik_audit_runs") ? runColumns : request.path === "plusmedik_audit_model_calls" ? callColumns : undefined;
      if (allowed) for (const row of rows) for (const key of Object.keys(row)) expect(allowed.has(key), `${request.path}.${key}`).toBe(true);
    }
    // cada columna nueva la escribe el repositorio
    const written = (path: string) => new Set(requests.filter((request) => request.path.startsWith(path)).flatMap((request) => (Array.isArray(request.body) ? request.body : [request.body]).flatMap((row: object) => Object.keys(row))));
    for (const column of added("plusmedik_audit_runs")) expect(written("plusmedik_audit_runs").has(column), column).toBe(true);
    for (const column of added("plusmedik_audit_model_calls")) expect(written("plusmedik_audit_model_calls").has(column), column).toBe(true);
  });
});

describe("lector OpenRouter real (cliente simulado): reintento por truncamiento", () => {
  const body = JSON.stringify({ requestedStudies: [{ literalText: "Hemograma", normalizedName: "Hemograma", evidence: "check", confidence: "high", lineText: "Hemograma" }], uncertainStudies: [], notes: "" });
  const reply = (content: string, finish: string, cost: number) => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 500, completion_tokens: 100, total_tokens: 600, cost } });

  it("el intento truncado queda INVALID con el esfuerzo con que se hizo y el reintento OK con el esfuerzo reducido; el costo es el que reportó el proveedor", async () => {
    vi.stubEnv("OPENROUTER_GEMINI_REASONING", "medium");
    vi.stubEnv("OPENROUTER_GEMINI_RETRY_REASONING", "low");
    const replies = [reply('{"requestedStudies":[{"literalText":"Hemo', "length", 0.004), reply(body, "stop", 0.002)];
    const create = vi.fn(async () => replies.shift()!);
    const client = { chat: { completions: { create } } } as unknown as Parameters<typeof readImageWithGeminiViaOpenRouter>[4];
    const { events, result } = await observed(() => readImageWithGeminiViaOpenRouter("aW1n", "image/jpeg", "sk-no-real", false, client));
    expect(result.requestedStudies).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.map((event) => [event.label, event.callSeq, event.attempt, event.outcome, event.reasoningEffort])).toEqual([
      ["gemini-openrouter", 1, 1, "INVALID", "medium"],
      ["gemini-openrouter", 1, 2, "OK", "low"]
    ]);
    expect(events.map((event) => event.usage?.costUsd)).toEqual([0.004, 0.002]);
    expect(events.every((event) => /^[0-9a-f]{64}$/.test(event.paramsHash ?? ""))).toBe(true);
  });
});
