import { describe, expect, it, vi } from "vitest";
import type { AuditLease } from "../src/audit.js";
import { classifyResponse, createCrmReviewClient, CrmConfigError, REVIEW_PATH, type CrmClient, type CrmResult } from "../src/crm-outbox/client.js";
import { resolveCrmOutbox } from "../src/crm-outbox/config.js";
import { handleDrainRequest } from "../src/crm-outbox/drain.js";
import { createCrmHandoffSink, HandoffNotRegisteredError } from "../src/crm-outbox/handoff-sink.js";
import {
  buildPayload, canonicalJson, CipherError, decryptPayload, encryptPayload, eventIdOf, evidenceOf, LIMITS, payloadHash, PayloadError, REASON_DESCRIPTIONS, CRM_REASONS, type CaseInput
} from "../src/crm-outbox/payload.js";
import type { ClaimedEvent, EnqueueInput, EnqueueResult, OutboxRepository, RecordOutcome, ReviewTargets } from "../src/crm-outbox/repository.js";
import { CrmOutbox } from "../src/crm-outbox/service.js";
import type { TurnContext } from "../src/guarded-turn.js";
import type { CatalogStudy } from "../src/types.js";
import { FakeCrm } from "./support/fake-crm.js";

// Cola de salida hacia el CRM SIN base de datos ni red real: carga útil y límites del receptor, cifrado en reposo, cliente HTTP (todas las respuestas del contrato), orquestación del servicio
// con un repositorio simulado, sumidero de derivación, ruta de reintento y configuración. La garantía atómica contra PostgreSQL: tests/crm-outbox-db.test.ts; de extremo a extremo:
// tests/crm-outbox-e2e.test.ts.

const KEY = "clave-de-cifrado-de-prueba-0123456789-abcdef";
const RUN = "00000000-0000-4000-8000-000000000001";
const RUN2 = "00000000-0000-4000-8000-000000000002";
const PHONE_ID = "123456789012345";
const PHONE = "+591 7000-0001";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_3344";
const LEASE: AuditLease = { owner: "owner-0000001", fence: 1 };

const input = (over: Partial<CaseInput> = {}): CaseInput => ({ kapsoMessageId: "wamid.m1", contactPhone: PHONE, kind: "CONVERSATION", reasons: ["HUMAN_REQUEST"], ...over });

describe("carga útil: el contrato del receptor del CRM", () => {
  it("arma el evento con el eventId estable, la corrida como auditId, el teléfono normalizado y solo códigos como motivo", () => {
    const payload = buildPayload(input({ mediaId: "media-9", reasons: ["AMBIGUOUS_STUDY", "UNRESOLVED_TEXT"], kind: "REVIEW_CASE", sessionId: "s1", itemStatus: "AMBIGUOUS", counts: { studies: 1 } }), RUN, PHONE_ID);
    expect(payload).toMatchObject({
      eventId: `plusmedik-review:${RUN}`, requiresReview: true, kapsoMessageId: "wamid.m1", contactPhone: "59170000001", phoneNumberId: PHONE_ID, recipeMediaId: "media-9", auditId: RUN, detectedTests: []
    });
    expect(payload.failureReason).toBe(`AMBIGUOUS_STUDY: ${REASON_DESCRIPTIONS.AMBIGUOUS_STUDY}; UNRESOLVED_TEXT: ${REASON_DESCRIPTIONS.UNRESOLVED_TEXT}`);
    expect(payload.agentResult).toEqual({ source: "plusmedik-v2", schema: 1, kind: "REVIEW_CASE", reasonCodes: ["AMBIGUOUS_STUDY", "UNRESOLVED_TEXT"], sessionId: "s1", itemStatus: "AMBIGUOUS", counts: { studies: 1 } });
  });

  it("respeta los límites del receptor: eventId ≤ 120, failureReason ≤ 1000, ≤ 60 estudios y agentResult + detectedTests ≤ 40.000 caracteres (nunca se pierde el motivo)", () => {
    expect(eventIdOf(RUN).length).toBeLessThanOrEqual(LIMITS.eventId);
    const many = Array.from({ length: 200 }, (_, i) => ({ catalogTestId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `ESTUDIO ${i} ` + "X".repeat(150) }));
    const payload = buildPayload(input({ detectedTests: many, reasons: [...CRM_REASONS].slice(0, 4) }), RUN, PHONE_ID);
    expect(payload.detectedTests.length).toBeLessThanOrEqual(LIMITS.detectedTests);
    expect(JSON.stringify({ agentResult: payload.agentResult, detectedTests: payload.detectedTests }).length).toBeLessThanOrEqual(LIMITS.evidence);
    expect(payload.failureReason.length).toBeLessThanOrEqual(LIMITS.failureReason);
    expect(payload.failureReason).toContain("HUMAN_REQUEST");
    // con los topes propios (60 estudios de 200 caracteres como máximo) la evidencia máxima es ~14.000 caracteres: nunca llega al límite del receptor, y la poda queda como defensa
    const heavy = buildPayload(input({ detectedTests: Array.from({ length: 60 }, (_, i) => ({ name: "Z".repeat(200) + i })) }), RUN, PHONE_ID);
    expect(heavy.detectedTests).toHaveLength(60);
    expect(heavy.agentResult.detectedTestsTruncated).toBeUndefined();
    expect(JSON.stringify({ agentResult: heavy.agentResult, detectedTests: heavy.detectedTests }).length).toBeLessThan(LIMITS.evidence / 2);
  });

  it.each([
    ["teléfono corto", { contactPhone: "1234" }, "INVALID_PHONE"], ["teléfono sin dígitos", { contactPhone: "sin teléfono" }, "INVALID_PHONE"], ["mensaje vacío", { kapsoMessageId: "" }, "INVALID_MESSAGE"],
    ["mensaje larguísimo", { kapsoMessageId: "m".repeat(256) }, "INVALID_MESSAGE"], ["sin motivos", { reasons: [] }, "INVALID_REASONS"], ["motivo desconocido", { reasons: ["QUIERO_PRECIOS" as never] }, "INVALID_REASONS"],
    ["demasiados motivos", { reasons: [...CRM_REASONS].slice(0, 5) }, "INVALID_REASONS"]
  ])("rechaza %s sin armar nada", (_name, over, code) => {
    expect(() => buildPayload(input(over as Partial<CaseInput>), RUN, PHONE_ID)).toThrowError(expect.objectContaining({ code }));
    expect(() => buildPayload(input(), "no-es-uuid", PHONE_ID)).toThrow(PayloadError);
    expect(() => buildPayload(input(), RUN, "")).toThrow(PayloadError);
  });

  it("los nombres de estudio solo salen del catálogo (limpios) y los ids que no son UUID no viajan como catalogTestId", () => {
    const payload = buildPayload(input({ detectedTests: [{ catalogTestId: "hemograma", name: "HEMO\u0000GRAMA" }, { catalogTestId: "00000000-0000-4000-8000-000000000009", name: "TSH", ambiguousGroup: 2 }] }), RUN, PHONE_ID);
    expect(payload.detectedTests).toEqual([{ name: "HEMO GRAMA" }, { catalogTestId: "00000000-0000-4000-8000-000000000009", name: "TSH", ambiguousGroup: 2 }]);
  });

  it("la evidencia permanente son códigos y contadores: sin teléfono, sin ids de mensaje, sin nombres de estudios", () => {
    const i = input({ detectedTests: [{ name: "ESTUDIO SECRETO" }], sessionId: "s1", counts: { studies: 1 } });
    const evidence = evidenceOf(i, buildPayload(i, RUN, PHONE_ID));
    expect(evidence).toEqual({ schema: 1, reasonCodes: ["HUMAN_REQUEST"], kind: "CONVERSATION", studies: 1, sessionId: "s1", counts: { studies: 1 } });
    expect(JSON.stringify(evidence)).not.toMatch(/59170|wamid|SECRETO/);
  });

  it("JSON canónico y hash: el mismo cuerpo da siempre los mismos bytes y el mismo hash (los reintentos envían exactamente lo mismo), sin importar el orden de las claves", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    const a = buildPayload(input(), RUN, PHONE_ID);
    const b = { ...Object.fromEntries(Object.entries(a).reverse()) } as typeof a;
    expect(payloadHash(a)).toBe(payloadHash(b));
    expect(payloadHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash(buildPayload(input({ reasons: ["MEDICAL_QUERY"] }), RUN, PHONE_ID))).not.toBe(payloadHash(a));
  });
});

describe("cifrado en reposo del cuerpo (AES-256-GCM)", () => {
  const payload = buildPayload(input(), RUN, PHONE_ID);

  it("va y vuelve; el texto cifrado no contiene el teléfono ni nada legible; cada cifrado usa un IV distinto", () => {
    const cipher = encryptPayload(payload, KEY);
    expect(cipher).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cipher).not.toContain("59170000001");
    expect(Buffer.from(cipher.split(".")[3]!, "base64url").toString("utf8")).not.toContain("59170000001");
    expect(decryptPayload(cipher, payload.eventId, KEY)).toEqual(payload);
    expect(encryptPayload(payload, KEY)).not.toBe(cipher);
  });

  it("está LIGADO al evento (no se puede pasar el cuerpo de uno por el de otro), a la clave y a su integridad", () => {
    const cipher = encryptPayload(payload, KEY);
    expect(() => decryptPayload(cipher, eventIdOf(RUN2), KEY)).toThrow(CipherError);
    expect(() => decryptPayload(cipher, payload.eventId, KEY + "x")).toThrow(CipherError);
    const parts = cipher.split(".");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("otra cosa").toString("base64url")].join(".");
    expect(() => decryptPayload(tampered, payload.eventId, KEY)).toThrow(CipherError);
    for (const bad of ["", "v2.a.b.c", "v1.a.b", "basura", cipher.slice(0, -4)]) expect(() => decryptPayload(bad, payload.eventId, KEY), bad).toThrow(CipherError);
  });

  it("exige una clave de al menos 32 caracteres (si no, no cifra: no hay cuerpo sin cifrar)", () => {
    expect(() => encryptPayload(payload, "corta")).toThrow(CipherError);
    expect(() => decryptPayload("v1.a.b.c", payload.eventId, "corta")).toThrow(CipherError);
  });
});

describe("cliente del CRM: todas las respuestas del contrato", () => {
  it.each<[number, unknown, CrmResult]>([
    [200, { ok: true, created: true, duplicate: false }, "CREATED"], [200, { ok: true, created: false, duplicate: true }, "DUPLICATE"], [200, { ok: true, created: false, ignored: true }, "IGNORED"],
    [200, { ok: false }, "SERVER_ERROR"], [200, "texto", "SERVER_ERROR"], [200, null, "SERVER_ERROR"], [200, { ok: true }, "SERVER_ERROR"],
    [409, { ok: false, code: "message_not_ingested" }, "MESSAGE_NOT_INGESTED"], [409, { ok: false, code: "otra" }, "CONFLICT_UNKNOWN"], [409, null, "CONFLICT_UNKNOWN"],
    [400, { ok: false }, "INVALID"], [413, {}, "TOO_LARGE"], [401, {}, "UNAUTHORIZED"], [403, {}, "UNAUTHORIZED"], [503, { ok: false, available: false }, "UNAVAILABLE"], [429, {}, "UNAVAILABLE"],
    [404, {}, "UNAVAILABLE"], [405, {}, "UNAVAILABLE"], [500, {}, "SERVER_ERROR"], [502, {}, "SERVER_ERROR"], [302, {}, "SERVER_ERROR"], [418, {}, "INVALID"]
  ])("HTTP %s %j → %s", (status, body, expected) => {
    expect(classifyResponse(status, body)).toBe(expected);
  });

  const payload = buildPayload(input(), RUN, PHONE_ID);
  const make = (crm: FakeCrm, over: Partial<Parameters<typeof createCrmReviewClient>[0]> = {}) => createCrmReviewClient({ baseUrl: "https://crm.example.test", token: crm.token, fetchFn: crm.fetchFn, ...over });

  it("envía POST a la ruta del contrato con el token como Bearer, JSON, sin seguir redirecciones; creado → duplicado en el reintento", async () => {
    const crm = new FakeCrm();
    crm.ingest("wamid.m1", PHONE, PHONE_ID);
    const fetchSpy = vi.fn(crm.fetchFn);
    const client = make(crm, { fetchFn: fetchSpy as never });
    expect((await client.send(payload)).result).toBe("CREATED");
    expect((await client.send(payload)).result).toBe("DUPLICATE");
    const [url, init] = fetchSpy.mock.calls[0]! as [URL, RequestInit];
    expect(url.toString()).toBe(`https://crm.example.test${REVIEW_PATH}`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${crm.token}`);
    expect(JSON.parse(String(init.body))).toEqual(payload);
    expect(crm.cases).toHaveLength(1);
  });

  it("cada respuesta del receptor real se traduce: mensaje aún no ingerido (409), apagado (503), token malo (401), cuerpo inválido (400), evidencia grande (413)", async () => {
    const crm = new FakeCrm();
    const client = make(crm);
    expect((await client.send(payload)).result).toBe("MESSAGE_NOT_INGESTED");
    crm.ingest("wamid.m1", "59199999999", PHONE_ID);
    expect((await client.send(payload)).result).toBe("MESSAGE_NOT_INGESTED"); // otro teléfono
    crm.ingest("wamid.m1", PHONE, "otro-numero");
    expect((await client.send(payload)).result).toBe("MESSAGE_NOT_INGESTED"); // otro número de WhatsApp
    crm.ingest("wamid.m1", PHONE, PHONE_ID, "otra-media");
    expect((await client.send({ ...payload, recipeMediaId: "media-9" })).result).toBe("MESSAGE_NOT_INGESTED"); // el adjunto no coincide
    crm.enabled = false;
    expect(await client.send(payload)).toMatchObject({ result: "UNAVAILABLE", httpStatus: 503 });
    crm.enabled = true;
    expect(await make(crm, { token: "otro-token-".padEnd(40, "z") }).send(payload)).toMatchObject({ result: "UNAUTHORIZED", httpStatus: 401 });
    expect((await client.send({ ...payload, failureReason: "" })).result).toBe("INVALID");
    expect((await client.send({ ...payload, agentResult: { x: "y".repeat(50_000) } })).result).toBe("TOO_LARGE");
  });

  it("un tiempo de espera agotado y un fallo de red son resultados distintos y reintentables; ninguno trae cuerpo", async () => {
    const crm = new FakeCrm();
    crm.delayMs = 200;
    expect(await make(crm, { timeoutMs: 20 }).send(payload)).toMatchObject({ result: "TIMEOUT" });
    crm.delayMs = 0;
    crm.script.push("network");
    expect((await make(crm).send(payload)).result).toBe("NETWORK");
  });

  it("una redirección NO se sigue (reenviaría el token a otro destino): se informa como error del servidor", async () => {
    const crm = new FakeCrm();
    crm.script.push({ status: 302, body: {} });
    const result = await make(crm).send(payload);
    expect(result).toMatchObject({ result: "SERVER_ERROR", httpStatus: 302 });
    expect(crm.calls).toHaveLength(1);
  });

  it("solo HTTPS (o localhost en desarrollo), sin usuario/contraseña en la URL, y un token de al menos 32 caracteres sin espacios", () => {
    const crm = new FakeCrm();
    for (const baseUrl of ["http://crm.example.test", "ftp://crm.example.test", "no es una url", "https://user:pass@crm.example.test", ""]) expect(() => make(crm, { baseUrl }), baseUrl).toThrowError(expect.objectContaining({ code: "URL" }));
    for (const token of ["", "corto", "t".repeat(31), "con espacio ".padEnd(40, "x")]) expect(() => make(crm, { token }), token).toThrowError(expect.objectContaining({ code: "TOKEN" }));
    expect(() => make(crm, { baseUrl: "http://localhost:3000" })).not.toThrow();
    expect(() => make(crm, { baseUrl: "http://127.0.0.1:3000" })).not.toThrow();
    expect(() => make(crm)).not.toThrow();
    expect(CrmConfigError).toBeDefined();
  });

  it("el resultado nunca incluye el cuerpo enviado, el token ni el texto de la respuesta del CRM", async () => {
    const crm = new FakeCrm();
    crm.script.push({ status: 500, body: { error: `detalle interno ${SENTINEL}` } });
    const result = await make(crm).send({ ...payload, failureReason: `x ${SENTINEL}` });
    expect(JSON.stringify(result)).not.toMatch(new RegExp(`${SENTINEL}|${crm.token}|59170000001`));
    expect(Object.keys(result).sort()).toEqual(["durationMs", "httpStatus", "result"]);
  });
});

// ───────────────────────────── servicio con un repositorio simulado ─────────────────────────────
class MemoryRepo implements OutboxRepository {
  enqueued: Array<{ runId: string; input: EnqueueInput }> = [];
  enqueueResult: EnqueueResult = { status: "created", outboxId: "ob-1", eventId: eventIdOf(RUN), state: "PENDING" };
  claims: ClaimedEvent[][] = [];
  claimCalls: Array<{ owner: string; options: Record<string, unknown> }> = [];
  records: Array<{ outboxId: string; owner: string; fence: number; result: CrmResult; httpStatus?: number }> = [];
  recordOutcomes: Array<RecordOutcome | "throw"> = [];
  targets: ReviewTargets | undefined;
  failEnqueue = false;
  failClaim = false;
  async enqueue(runId: string, _lease: AuditLease, enqueueInput: EnqueueInput) {
    if (this.failEnqueue) throw new Error("base caída");
    this.enqueued.push({ runId, input: enqueueInput });
    return this.enqueueResult;
  }
  async claim(owner: string, options: Record<string, unknown>) {
    if (this.failClaim) throw new Error("base caída");
    this.claimCalls.push({ owner, options });
    return this.claims.shift() ?? [];
  }
  async record(outboxId: string, owner: string, fence: number, outcome: { result: CrmResult; httpStatus?: number }) {
    this.records.push({ outboxId, owner, fence, ...outcome });
    const next = this.recordOutcomes.shift() ?? ({ status: "retry", afterSeconds: 30 } as RecordOutcome);
    if (next === "throw") throw new Error("base caída");
    return next;
  }
  async status() { return []; }
  async stats() { return { counts: {}, deadByReason: {} }; }
  async list() { return []; }
  async requeue() { return "requeued" as const; }
  async purge() { return 0; }
  async reviewTargets() { return this.targets; }
}

class ScriptedClient implements CrmClient {
  sent: unknown[] = [];
  results: CrmResult[] = [];
  async send(payload: unknown) {
    this.sent.push(payload);
    return { result: this.results.shift() ?? "CREATED", httpStatus: 200, durationMs: 5 };
  }
}

function setup(over: { repo?: MemoryRepo; client?: CrmClient; immediateAttempts?: number } = {}) {
  const repo = over.repo ?? new MemoryRepo();
  const client = over.client ?? new ScriptedClient();
  const logs: Array<[string, Record<string, unknown>]> = [];
  const sleeps: number[] = [];
  const outbox = new CrmOutbox({
    repository: repo, client, encryptionKey: KEY, phoneNumberId: PHONE_ID, log: (event, data) => { logs.push([event, data]); }, sleep: async (ms) => { sleeps.push(ms); },
    immediateAttempts: over.immediateAttempts ?? 2, immediateDelayMs: 7, ownerId: (() => { let n = 0; return () => `outbox-owner-${++n}`; })()
  });
  const persisted: string[] = [];
  let persistOk = true;
  const ctx = {
    guarded: true,
    async persist(stage: string, action: (audit: never, runId: string, lease: AuditLease) => Promise<void>) {
      persisted.push(stage);
      if (!persistOk) return false;
      try { await action({} as never, RUN, LEASE); return true; } catch { return false; }
    }
  } as unknown as TurnContext;
  const claimable = (cipher: string, fence = 1, attempt = 1): ClaimedEvent => ({ outboxId: "ob-1", eventId: eventIdOf(RUN), cipher, attempt, fence });
  return { repo, client, outbox, ctx, logs, sleeps, persisted, setPersist: (ok: boolean) => { persistOk = ok; }, claimable };
}
const cipherFor = (over: Partial<CaseInput> = {}) => encryptPayload(buildPayload(input(over), RUN, PHONE_ID), KEY);

describe("CrmOutbox.submit: guarda, intenta en línea y SOLO confirma lo registrado por el CRM", () => {
  it("el CRM lo crea en el primer intento → REGISTERED; guardó el cuerpo CIFRADO, el hash y la evidencia ANTES de enviar, con el id de la corrida de origen", async () => {
    const s = setup();
    s.repo.claims.push([s.claimable(cipherFor())]);
    s.repo.recordOutcomes.push({ status: "sent", delivery: "CREATED" });
    const [outcome] = await s.outbox.submit(s.ctx, [input()]);
    expect(outcome).toEqual({ state: "REGISTERED", eventId: eventIdOf(RUN), delivery: "CREATED" });
    const stored = s.repo.enqueued[0]!;
    expect(stored.runId).toBe(RUN);
    expect(stored.input).toMatchObject({ originRunId: RUN, kind: "CONVERSATION", kapsoMessageId: "wamid.m1", reasons: ["HUMAN_REQUEST"], ttlSeconds: 604_800, maxAttempts: 8 });
    expect(stored.input.cipher).toMatch(/^v1\./);
    expect(stored.input.cipher).not.toContain("59170000001");
    expect(stored.input.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.input.evidence)).not.toMatch(/59170|wamid/);
    expect(s.repo.claimCalls[0]!.options).toMatchObject({ limit: 1, outboxId: "ob-1", force: true });
    expect((s.client as ScriptedClient).sent).toHaveLength(1);
    expect(s.repo.records[0]).toMatchObject({ outboxId: "ob-1", owner: "outbox-owner-1", fence: 1, result: "CREATED" });
  });

  it("el cuerpo enviado es EXACTAMENTE el que se guardó (descifrado), con el mismo eventId: los reintentos no cambian nada", async () => {
    const s = setup();
    s.repo.claims.push([s.claimable(cipherFor())]);
    await s.outbox.submit(s.ctx, [input()]);
    const stored = s.repo.enqueued[0]!.input;
    const sent = (s.client as ScriptedClient).sent[0] as ReturnType<typeof buildPayload>;
    expect(sent).toEqual(decryptPayload(stored.cipher, eventIdOf(RUN), KEY));
    expect(payloadHash(sent)).toBe(stored.hash);
  });

  it("ya registrado antes (turno repetido): REGISTERED sin ninguna llamada al CRM; muerto: DEAD sin enviar", async () => {
    const sent = setup();
    sent.repo.enqueueResult = { status: "exists", outboxId: "ob-1", eventId: eventIdOf(RUN), state: "SENT", delivery: "DUPLICATE" };
    expect(await sent.outbox.submit(sent.ctx, [input()])).toEqual([{ state: "REGISTERED", eventId: eventIdOf(RUN), delivery: "DUPLICATE" }]);
    expect(sent.repo.claimCalls).toEqual([]);
    expect((sent.client as ScriptedClient).sent).toEqual([]);
    const dead = setup();
    dead.repo.enqueueResult = { status: "exists", outboxId: "ob-1", eventId: eventIdOf(RUN), state: "DEAD" };
    expect(await dead.outbox.submit(dead.ctx, [input()])).toEqual([{ state: "DEAD", eventId: eventIdOf(RUN) }]);
    expect(dead.repo.claimCalls).toEqual([]);
  });

  it("409 message_not_ingested: reintenta una vez más en línea tras una pausa corta y, si el CRM ya lo tiene, queda REGISTERED", async () => {
    const s = setup();
    (s.client as ScriptedClient).results.push("MESSAGE_NOT_INGESTED", "CREATED");
    s.repo.claims.push([s.claimable(cipherFor(), 1, 1)], [s.claimable(cipherFor(), 2, 2)]);
    s.repo.recordOutcomes.push({ status: "retry", afterSeconds: 30 }, { status: "sent", delivery: "CREATED" });
    const [outcome] = await s.outbox.submit(s.ctx, [input()]);
    expect(outcome!.state).toBe("REGISTERED");
    expect(s.sleeps).toEqual([7]);
    expect(s.repo.records.map((r) => r.result)).toEqual(["MESSAGE_NOT_INGESTED", "CREATED"]);
  });

  it.each<CrmResult>(["MESSAGE_NOT_INGESTED", "UNAVAILABLE", "TIMEOUT", "NETWORK", "SERVER_ERROR"])("%s dos veces seguidas → PENDING (queda en la cola; NO se confirma nada al paciente)", async (result) => {
    const s = setup();
    (s.client as ScriptedClient).results.push(result, result);
    s.repo.claims.push([s.claimable(cipherFor(), 1, 1)], [s.claimable(cipherFor(), 2, 2)]);
    s.repo.recordOutcomes.push({ status: "retry", afterSeconds: 30 }, { status: "retry", afterSeconds: 120 });
    expect(await s.outbox.submit(s.ctx, [input()])).toEqual([{ state: "PENDING", eventId: eventIdOf(RUN) }]);
    expect(s.sleeps).toEqual([7]);
  });

  it.each<[CrmResult, string]>([["UNAUTHORIZED", "retry"], ["CONFLICT_UNKNOWN", "retry"]])("%s no se reintenta en línea (no mejora en segundos) y queda PENDING", async (result) => {
    const s = setup();
    (s.client as ScriptedClient).results.push(result);
    s.repo.claims.push([s.claimable(cipherFor())]);
    s.repo.recordOutcomes.push({ status: "retry", afterSeconds: 1800 });
    expect((await s.outbox.submit(s.ctx, [input()]))[0]!.state).toBe("PENDING");
    expect(s.sleeps).toEqual([]);
    expect((s.client as ScriptedClient).sent).toHaveLength(1);
  });

  it("un rechazo permanente (400/413) → DEAD sin reintentar en línea", async () => {
    const s = setup();
    (s.client as ScriptedClient).results.push("INVALID");
    s.repo.claims.push([s.claimable(cipherFor())]);
    s.repo.recordOutcomes.push({ status: "dead", reason: "REJECTED_INVALID" });
    expect(await s.outbox.submit(s.ctx, [input()])).toEqual([{ state: "DEAD", eventId: eventIdOf(RUN) }]);
    expect((s.client as ScriptedClient).sent).toHaveLength(1);
  });

  it("otro proceso ya lo tiene en vuelo (el reclamo no devuelve nada): PENDING, sin enviar desde aquí", async () => {
    const s = setup();
    expect(await s.outbox.submit(s.ctx, [input()])).toEqual([{ state: "PENDING", eventId: eventIdOf(RUN) }]);
    expect((s.client as ScriptedClient).sent).toEqual([]);
  });

  it("si no se puede registrar el resultado tras enviar, NO se da por entregado (PENDING): el arrendamiento vence y se reintenta, y el CRM deduplica", async () => {
    const s = setup({ immediateAttempts: 1 });
    s.repo.claims.push([s.claimable(cipherFor())]);
    s.repo.recordOutcomes.push("throw");
    expect(await s.outbox.submit(s.ctx, [input()])).toEqual([{ state: "PENDING", eventId: eventIdOf(RUN) }]);
    expect(s.logs.some(([, data]) => data.event === "record_failed")).toBe(true);
  });

  it("si el reclamo falla (base caída) → PENDING; si el arrendamiento se perdió → PENDING (lo resolvió quien lo tomó)", async () => {
    const down = setup();
    down.repo.failClaim = true;
    expect((await down.outbox.submit(down.ctx, [input()]))[0]!.state).toBe("PENDING");
    const lost = setup({ immediateAttempts: 1 });
    lost.repo.claims.push([lost.claimable(cipherFor())]);
    lost.repo.recordOutcomes.push({ status: "lost" });
    expect((await lost.outbox.submit(lost.ctx, [input()]))[0]!.state).toBe("PENDING");
  });

  it("FALLA CERRADO al guardar: base caída o sin lease → FAILED (no hay evento, no se envía nada, no se confirma); datos inválidos → FAILED con el código y sin tocar la base", async () => {
    const down = setup();
    down.repo.failEnqueue = true;
    expect(await down.outbox.submit(down.ctx, [input()])).toEqual([{ state: "FAILED", code: "ENQUEUE_FAILED" }]);
    const noLease = setup();
    noLease.setPersist(false);
    expect(await noLease.outbox.submit(noLease.ctx, [input()])).toEqual([{ state: "FAILED", code: "ENQUEUE_FAILED" }]);
    const bad = setup();
    expect(await bad.outbox.submit(bad.ctx, [input({ contactPhone: "123" })])).toEqual([{ state: "FAILED", code: "INVALID_PHONE" }]);
    expect(bad.repo.enqueued).toEqual([]);
    for (const s of [down, noLease, bad]) expect((s.client as ScriptedClient).sent).toEqual([]);
  });

  it("un cuerpo guardado que no se puede descifrar se descarta como rechazo permanente (INVALID) sin mostrarlo", async () => {
    const s = setup();
    s.repo.claims.push([s.claimable("v1.AAAA.BBBB.CCCC")]);
    s.repo.recordOutcomes.push({ status: "dead", reason: "REJECTED_INVALID" });
    expect((await s.outbox.submit(s.ctx, [input()]))[0]!.state).toBe("DEAD");
    expect(s.repo.records[0]).toMatchObject({ result: "INVALID" });
    expect((s.client as ScriptedClient).sent).toEqual([]);
  });

  it("los registros llevan códigos, motivos y contadores; nunca el teléfono, el token, el cuerpo ni texto del paciente", async () => {
    const s = setup();
    s.repo.claims.push([s.claimable(cipherFor())]);
    await s.outbox.submit(s.ctx, [input({ detectedTests: [{ name: `ESTUDIO ${SENTINEL}` }] })]);
    const text = JSON.stringify(s.logs);
    expect(text).not.toMatch(/59170000001|wamid|Bearer|v1\./);
    expect(text).toContain("enqueued");
  });
});

describe("CrmOutbox.drain: reintentos en segundo plano", () => {
  it("reclama lo vencido, lo envía con la misma carga y registra cada resultado; cuenta enviados, reintentos, muertos y perdidos", async () => {
    const s = setup();
    const cipher = cipherFor();
    s.repo.claims.push([s.claimable(cipher, 1, 2), { ...s.claimable(cipher, 1, 3), outboxId: "ob-2" }, { ...s.claimable(cipher, 1, 4), outboxId: "ob-3" }, { ...s.claimable(cipher, 1, 5), outboxId: "ob-4" }]);
    (s.client as ScriptedClient).results.push("CREATED", "MESSAGE_NOT_INGESTED", "INVALID", "CREATED");
    s.repo.recordOutcomes.push({ status: "sent", delivery: "CREATED" }, { status: "retry", afterSeconds: 600 }, { status: "dead", reason: "REJECTED_INVALID" }, { status: "lost" });
    expect(await s.outbox.drain({ limit: 10, concurrency: 1 })).toEqual({ claimed: 4, sent: 1, retry: 1, dead: 1, lost: 1, failed: 0 });
    expect(s.repo.claimCalls[0]!.options).toMatchObject({ limit: 10 });
    expect(s.repo.claimCalls[0]!.options.outboxId).toBeUndefined();
    expect(s.repo.records.map((r) => r.outboxId)).toEqual(["ob-1", "ob-2", "ob-3", "ob-4"]);
  });

  it("sin nada vencido no hace nada; un fallo en un evento no impide los demás", async () => {
    const empty = setup();
    expect(await empty.outbox.drain()).toEqual({ claimed: 0, sent: 0, retry: 0, dead: 0, lost: 0, failed: 0 });
    const s = setup();
    s.repo.claims.push([s.claimable(cipherFor()), { ...s.claimable(cipherFor()), outboxId: "ob-2" }]);
    const client = s.client as ScriptedClient;
    const original = client.send.bind(client);
    let calls = 0;
    client.send = async (payload: unknown) => { if (++calls === 1) throw new Error("fallo inesperado"); return original(payload); };
    s.repo.recordOutcomes.push({ status: "sent", delivery: "CREATED" });
    const summary = await s.outbox.drain({ concurrency: 1 });
    expect(summary).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
  });

  it("la ruta protegida: 503 sin configuración o sin secreto, 405, 401 con otro secreto, 200 con contadores, 500 sin filtrar detalles", async () => {
    const drain = vi.fn(async () => ({ claimed: 1, sent: 1, retry: 0, dead: 0, lost: 0, failed: 0 }));
    const log = vi.fn();
    const request = (secret?: string, method = "GET") => new Request("https://example.test/api/outbox/drain", { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    const deps = { enabled: true, secret: "s".repeat(32), drain, log };
    expect((await handleDrainRequest(request("s".repeat(32)), { ...deps, enabled: false })).status).toBe(503);
    expect((await handleDrainRequest(request("s".repeat(32)), { ...deps, secret: undefined })).status).toBe(503);
    expect((await handleDrainRequest(request("s".repeat(32), "DELETE"), deps)).status).toBe(405);
    expect((await handleDrainRequest(request(), deps)).status).toBe(401);
    expect((await handleDrainRequest(request("x".repeat(32)), deps)).status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
    const ok = await handleDrainRequest(request("s".repeat(32)), deps);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, sent: 1 });
    drain.mockRejectedValueOnce(new Error(`detalle ${SENTINEL}`));
    const failed = await handleDrainRequest(request("s".repeat(32), "POST"), deps);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json()) + JSON.stringify(log.mock.calls)).not.toContain(SENTINEL);
  });
});

describe("CrmOutbox.submitSessionReview: un caso por mensaje dudoso", () => {
  const catalog = [{ id: "00000000-0000-4000-8000-0000000000a1", name: "HEMOGRAMA DE PRUEBA" }, { id: "00000000-0000-4000-8000-0000000000a2", name: "CREATININA SERICA" }, { id: "00000000-0000-4000-8000-0000000000a3", name: "CREATININA EN ORINA" }] as unknown as CatalogStudy[];
  const targets = (over: Partial<ReviewTargets> = {}): ReviewTargets => ({
    found: true, sessionReasons: ["AMBIGUOUS_STUDY"], closing: { runId: RUN2, kapsoMessageId: "wamid.cierre" },
    items: [
      { runId: RUN, kapsoMessageId: "wamid.texto", mediaId: null, kind: "TEXT", status: "AMBIGUOUS", studyIds: [catalog[0]!.id], ambiguous: [[catalog[1]!.id, catalog[2]!.id]], unresolved: 0, reasons: ["AMBIGUOUS_STUDY"] },
      { runId: "00000000-0000-4000-8000-000000000003", kapsoMessageId: "wamid.foto", mediaId: "media-7", kind: "IMAGE", status: "UNCERTAIN", studyIds: [], ambiguous: [], unresolved: 0, reasons: ["ENGINE_PARTIAL"] }
    ], ...over
  });

  it("deriva cada mensaje dudoso anclado a SU corrida, mensaje y adjunto, con los candidatos del catálogo (nombres del catálogo, nunca del paciente) y el grupo de ambigüedad", async () => {
    const s = setup();
    s.repo.targets = targets();
    const outcomes = await s.outbox.submitSessionReview(s.ctx, { sessionId: "session-1", contactPhone: PHONE, catalog });
    expect(outcomes.map((o) => o.state)).toEqual(["PENDING", "PENDING"]);
    expect(s.repo.enqueued.map((e) => [e.input.originRunId, e.input.kapsoMessageId, e.input.sessionId])).toEqual([[RUN, "wamid.texto", "session-1"], ["00000000-0000-4000-8000-000000000003", "wamid.foto", "session-1"]]);
    const text = decryptPayload(s.repo.enqueued[0]!.input.cipher, eventIdOf(RUN), KEY);
    expect(text.recipeMediaId).toBeNull();
    expect(text.detectedTests).toEqual([
      { catalogTestId: catalog[0]!.id, name: "HEMOGRAMA DE PRUEBA" }, { catalogTestId: catalog[1]!.id, name: "CREATININA SERICA", ambiguousGroup: 1 }, { catalogTestId: catalog[2]!.id, name: "CREATININA EN ORINA", ambiguousGroup: 1 }
    ]);
    expect(text.failureReason).toContain("AMBIGUOUS_STUDY");
    const image = decryptPayload(s.repo.enqueued[1]!.input.cipher, eventIdOf("00000000-0000-4000-8000-000000000003"), KEY);
    expect(image.recipeMediaId).toBe("media-7");
    expect(image.agentResult).toMatchObject({ itemStatus: "UNCERTAIN", sessionId: "session-1" });
  });

  it("un motivo de TODA la solicitud (estudio retirado, precio inválido) se ancla al mensaje que la cerró", async () => {
    const s = setup();
    s.repo.targets = targets({ sessionReasons: ["STUDY_UNAVAILABLE", "PRICE_INVALID"], items: [] });
    await s.outbox.submitSessionReview(s.ctx, { sessionId: "session-1", contactPhone: PHONE, catalog });
    expect(s.repo.enqueued).toHaveLength(1);
    expect(s.repo.enqueued[0]!.input).toMatchObject({ originRunId: RUN2, kapsoMessageId: "wamid.cierre", reasons: ["STUDY_UNAVAILABLE", "PRICE_INVALID"] });
  });

  it("sin casos derivables, sin sesión en revisión o con la base caída: lista vacía (no se confirma nada)", async () => {
    const none = setup();
    none.repo.targets = targets({ sessionReasons: [], items: [] });
    expect(await none.outbox.submitSessionReview(none.ctx, { sessionId: "s", contactPhone: PHONE, catalog })).toEqual([]);
    const missing = setup();
    expect(await missing.outbox.submitSessionReview(missing.ctx, { sessionId: "s", contactPhone: PHONE, catalog })).toEqual([]);
    const off = setup();
    off.setPersist(false);
    expect(await off.outbox.submitSessionReview(off.ctx, { sessionId: "s", contactPhone: PHONE, catalog })).toEqual([]);
    expect(none.repo.enqueued).toEqual([]);
  });
});

describe("sumidero de derivación para el manejador de texto", () => {
  const request = { eventId: "handoff:1", kapsoMessageId: "wamid.1", contactPhone: PHONE, reason: "HUMAN_REQUEST" as const };
  it("es OPERATIVO y solo resuelve si el CRM ya registró el caso; traduce el motivo", async () => {
    const sink = createCrmHandoffSink();
    expect(sink.operational).toBe(true);
    const seen: string[] = [];
    const context = { quotedStudyIds: async () => [], registerCase: async (reason: string) => { seen.push(reason); return "REGISTERED" as const; } };
    expect(await sink.record(request, context as never)).toBe("RECORDED");
    await sink.record({ ...request, reason: "MEDICAL" }, context as never);
    await sink.record({ ...request, reason: "INFO_REQUEST" }, context as never);
    expect(seen).toEqual(["HUMAN_REQUEST", "MEDICAL_QUERY", "NO_APPROVED_ANSWER"]);
  });
  it.each(["PENDING", "DEAD", "FAILED"] as const)("si el caso quedó %s lanza (el manejador responde «no disponible» y no promete una persona)", async (state) => {
    const sink = createCrmHandoffSink();
    await expect(sink.record(request, { quotedStudyIds: async () => [], registerCase: async () => state } as never)).rejects.toBeInstanceOf(HandoffNotRegisteredError);
  });
  it("sin contexto de turno o sin cola configurada no hay forma de registrar: lanza (falla cerrado)", async () => {
    const sink = createCrmHandoffSink();
    await expect(sink.record(request)).rejects.toBeInstanceOf(HandoffNotRegisteredError);
    await expect(sink.record(request, { quotedStudyIds: async () => [] } as never)).rejects.toBeInstanceOf(HandoffNotRegisteredError);
  });
});

describe("configuración: apagada por defecto y completa o nada", () => {
  const good = { PLUSMEDIK_CRM_HANDOFF: "on", PLUSMEDIK_CRM_REVIEW_URL: "https://crm.example.test", PLUSMEDIK_CRM_REVIEW_TOKEN: "t".repeat(40), PLUSMEDIK_OUTBOX_KEY: "k".repeat(40), KAPSO_PHONE_NUMBER_ID: PHONE_ID };
  it("sin la bandera (o con otro valor) no existe: la derivación sigue bloqueada y no se registra nada", () => {
    const log = vi.fn();
    for (const value of [undefined, "", "off", "true", "1", "onn"]) expect(resolveCrmOutbox({ ...good, PLUSMEDIK_CRM_HANDOFF: value }, log)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
  it("con la bandera y toda la configuración se arma; 'ON' con espacios también", () => {
    expect(resolveCrmOutbox(good, vi.fn())).toBeInstanceOf(CrmOutbox);
    expect(resolveCrmOutbox({ ...good, PLUSMEDIK_CRM_HANDOFF: " ON " }, vi.fn())).toBeInstanceOf(CrmOutbox);
  });
  it.each([
    ["sin URL", { PLUSMEDIK_CRM_REVIEW_URL: undefined }, "MISSING_URL"], ["URL no HTTPS", { PLUSMEDIK_CRM_REVIEW_URL: "http://crm.example.test" }, "INVALID_URL"], ["sin token", { PLUSMEDIK_CRM_REVIEW_TOKEN: undefined }, "MISSING_TOKEN"],
    ["token corto", { PLUSMEDIK_CRM_REVIEW_TOKEN: "corto" }, "INVALID_TOKEN"], ["sin clave de cifrado", { PLUSMEDIK_OUTBOX_KEY: undefined }, "MISSING_KEY"], ["clave corta", { PLUSMEDIK_OUTBOX_KEY: "corta" }, "INVALID_KEY"],
    ["sin phone_number_id", { KAPSO_PHONE_NUMBER_ID: undefined }, "MISSING_PHONE_NUMBER_ID"]
  ])("%s → no se enciende (la derivación sigue bloqueada) y se registra SOLO el código", (_name, over, code) => {
    const log = vi.fn();
    expect(resolveCrmOutbox({ ...good, ...over }, log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith("crm_handoff_config_invalid", { error: code });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ttttt|kkkkk|crm\.example/);
  });
});
