import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, safeModelReading, type AuditRepository } from "../src/audit.js";
import { cachedAiCall, withAiCallObserver, type AiCallEvent } from "../src/cache.js";
import { handleImageMessage, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";
import type { AnalysisResult } from "../src/analyze.js";

const LEASE = { owner: "owner-0000001", fence: 1 };

const image: IncomingImage = { messageId: "wamid.audit-1", from: "59170000000", mediaId: "media-1" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);

const analysis = (): AnalysisResult => ({
  decision: "AUTO_SAFE",
  reasons: [],
  finalVisualStudies: [],
  disputes: [],
  judgeResolved: [],
  unresolvedDisputes: [],
  matches: [],
  unmatched: [],
  ambiguous: [],
  modelSuggested: [],
  outcome: "AUTO_COMPLETE",
  publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
  internal: {
    outcome: "AUTO_COMPLETE",
    recipeComplete: true,
    reviewRequired: false,
    quoted: { lines: [{ id: "test-1", code: "108", name: "HEMOGRAMA", priceBs: 45, basis: ["EXACT_CONFIRMED"], texts: ["PACIENTE_SENTINELA"] }], subtotalBs: 45 },
    studies: [{ key: "hemograma", text: "PACIENTE_SENTINELA", decision: "AUTO", blockers: [], uncertainty: [], lineIds: ["test-1"] }],
    pending: [],
    recipeStops: [],
    document: { type: "TEXT_EXPLICIT_REQUEST", complete: true, issueKinds: [], problems: ["RAZON_PRIVADA"], unseenRegion: false, zones: [], impactCheck: { needed: false, candidates: [] } },
    advisories: ["TEXTO_PRIVADO"],
    revision: "revision",
    history: []
  }
});

function audit(overrides: Partial<AuditRepository> = {}): AuditRepository {
  return {
    claim: vi.fn(async () => ({ kind: "claimed" as const, runId: "run-1", lease: LEASE, takeover: false })),
    recordIgnored: vi.fn(async () => undefined),
    renewLease: vi.fn(async () => true),
    reserveSend: vi.fn(async () => "reserved" as const), confirmSend: vi.fn(async () => "proceed" as const),
    recordEvidence: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    recordReply: vi.fn(async () => undefined),
    ...overrides
  };
}

function deps(auditRepository?: AuditRepository): QuoteDeps {
  return {
    downloadImage: vi.fn(async () => ({ bytes: jpeg })),
    loadCatalog: vi.fn(async () => []),
    analyze: vi.fn(async () => analysis()),
    sendText: vi.fn(async () => ({ providerMessageId: "wamid.outbound" })),
    log: vi.fn(),
    audit: auditRepository
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("auditoría persistente del webhook", () => {
  it("reclama el WAMID antes de descargar y conserva aceptación de Kapso, no entrega", async () => {
    const repo = audit();
    const d = deps(repo);
    await expect(handleImageMessage(image, d)).resolves.toBe("quoted");
    expect(vi.mocked(repo.claim)).toHaveBeenCalledWith({ messageId: image.messageId, mediaId: image.mediaId });
    expect(vi.mocked(d.downloadImage)).toHaveBeenCalledOnce();
    expect(vi.mocked(repo.recordReply)).toHaveBeenCalledWith("run-1", { state: "ACCEPTED", result: "quoted", processingStatus: "COMPLETED", providerMessageId: "wamid.outbound" }, LEASE);
  });

  it("un WAMID duplicado no descarga, analiza ni responde", async () => {
    const repo = audit({ claim: vi.fn(async () => ({ kind: "duplicate" as const, processingStatus: "PROCESSING" })) });
    const d = deps(repo);
    await expect(handleImageMessage(image, d)).resolves.toBe("ignored");
    expect(d.downloadImage).not.toHaveBeenCalled();
    expect(d.analyze).not.toHaveBeenCalled();
    expect(d.sendText).not.toHaveBeenCalled();
  });

  it("el claim único soporta dos ejecuciones concurrentes sin segundo envío", async () => {
    let claims = 0;
    const repo = audit({ claim: vi.fn(async () => ++claims === 1 ? { kind: "claimed" as const, runId: "run-1", lease: LEASE, takeover: false } : { kind: "duplicate" as const, processingStatus: "PROCESSING" }) });
    const d = deps(repo);
    await Promise.all([handleImageMessage(image, d), handleImageMessage(image, d)]);
    expect(d.sendText).toHaveBeenCalledTimes(1);
    expect(d.analyze).toHaveBeenCalledTimes(1);
  });

  it("si Supabase no puede reclamar, falla abierto y solo emite advertencia mínima", async () => {
    const repo = audit({ claim: vi.fn(async () => { throw new Error("token=secret telefono=59170000000"); }) });
    const d = deps(repo);
    await expect(handleImageMessage(image, d)).resolves.toBe("quoted");
    expect(d.sendText).toHaveBeenCalledOnce();
    expect(d.log).toHaveBeenCalledWith("audit_unavailable", { stage: "claim" });
    expect(JSON.stringify(vi.mocked(d.log).mock.calls)).not.toContain("token=secret");
  });

  it("un error de envío queda UNKNOWN y nunca programa reintento", async () => {
    const repo = audit();
    const d = deps(repo);
    d.sendText = vi.fn(async () => { throw new Error("timeout"); });
    await expect(handleImageMessage(image, d)).resolves.toBe("quoted");
    expect(vi.mocked(repo.recordReply)).toHaveBeenCalledWith("run-1", { state: "UNKNOWN", result: "quoted", processingStatus: "COMPLETED" }, LEASE);
    expect(d.sendText).toHaveBeenCalledTimes(1);
  });

  it("conserva FAILED si el motor falla aunque Kapso acepte el mensaje técnico", async () => {
    const repo = audit();
    const d = deps(repo);
    d.analyze = vi.fn(async () => { throw new Error("OpenAI unavailable secret=not-logged"); });
    await expect(handleImageMessage(image, d)).resolves.toBe("technical_issue");
    expect(vi.mocked(repo.recordFailure)).toHaveBeenCalledWith("run-1", "AI_PROCESSING_FAILED", LEASE);
    expect(vi.mocked(repo.recordReply)).toHaveBeenCalledWith("run-1", expect.objectContaining({ state: "ACCEPTED", result: "technical_issue", processingStatus: "FAILED" }), LEASE);
    expect(JSON.stringify(vi.mocked(d.log).mock.calls)).not.toContain("secret=not-logged");
  });

  it("conserva la telemetría disponible aunque el análisis falle", async () => {
    const repo = audit();
    const d = deps(repo);
    vi.stubEnv("AI_CACHE", "off");
    d.analyze = async () => {
      await cachedAiCall({
        label: "openai-reader",
        provider: "openai",
        model: "test-model",
        imageBase64: "image",
        config: { test: true },
        parse: (raw) => raw as { ok: true },
        call: async () => ({ value: { ok: true as const }, usage: { inputTokens: 7 } })
      });
      throw new Error("OpenAI unavailable");
    };
    await expect(handleImageMessage(image, d)).resolves.toBe("technical_issue");
    expect(vi.mocked(repo.recordEvidence)).toHaveBeenCalledWith("run-1", { aiCalls: [expect.objectContaining({ label: "openai-reader", outcome: "OK", usage: { inputTokens: 7 } })] }, LEASE);
    expect(vi.mocked(repo.recordFailure)).toHaveBeenCalledWith("run-1", "AI_PROCESSING_FAILED", LEASE);
  });
});

describe("serialización segura de auditoría", () => {
  it("reduce lecturas de modelo sin texto libre, prompts ni razonamientos", () => {
    const reading = safeModelReading("gemini-openrouter", {
      requestedStudies: [{ literalText: "PACIENTE_SENTINELA", evidence: "check", confidence: "high", lineText: "LINEA_PRIVADA" }],
      uncertainStudies: [{ literalText: "OTRO" }],
      notes: "RAZON_PRIVADA"
    });
    const dump = JSON.stringify(reading);
    expect(dump).not.toMatch(/PACIENTE|LINEA|RAZON|OTRO/);
    expect(reading).toMatchObject({ kind: "READER", requestedCount: 1, uncertainCount: 1, evidence: ["check"], confidence: ["high"] });
  });

  it("persiste solo códigos/precios y costos reportados, nunca texto clínico o razones libres", async () => {
    const requests: string[] = [];
    const repository = createSupabaseAuditRepository({
      baseUrl: "https://example.supabase.co",
      serviceKey: "test-service-key",
      fetchFn: async (input, init) => {
        requests.push(`${String(input)}\n${String(init?.body ?? "")}`);
        if (String(input).includes("plusmedik_audit_claim_run")) return new Response(JSON.stringify({ outcome: "claimed", run_id: "run-1", fence: 1 }), { status: 200 });
        return new Response("{}", { status: 200 });
      }
    });
    const claim = await repository.claim(image);
    if (claim.kind !== "claimed") throw new Error("expected claim");
    await repository.recordEvidence(claim.runId, { analysis: analysis(), aiCalls: [{ label: "gemini-openrouter", provider: "openrouter", model: "m", cacheHit: false, outcome: "OK", usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.004 }, value: { requestedStudies: [{ literalText: "PACIENTE_SENTINELA", evidence: "check", confidence: "high" }], uncertainStudies: [] } }] }, LEASE);
    const dump = requests.join("\n");
    for (const forbidden of ["59170000000", "PACIENTE_SENTINELA", "RAZON_PRIVADA", "TEXTO_PRIVADO", "test-service-key"]) expect(dump).not.toContain(forbidden);
    expect(dump).toContain("108");
    expect(dump).toContain("0.004");
    expect(dump).toContain("PROVIDER_REPORTED");
  });
});

describe("observador de uso de IA", () => {
  it("observa tokens del proveedor sin cambiar el valor del motor", async () => {
    vi.stubEnv("AI_CACHE", "off");
    const events: AiCallEvent[] = [];
    const value = await withAiCallObserver((event) => events.push(event), () => cachedAiCall({
      label: "openai-reader",
      provider: "openai",
      model: "test-model",
      imageBase64: "image",
      config: { test: true },
      parse: (raw) => raw as { ok: true },
      call: async () => ({ value: { ok: true as const }, usage: { inputTokens: 7, outputTokens: 3 } })
    }));
    expect(value).toEqual({ ok: true });
    expect(events).toEqual([expect.objectContaining({ outcome: "OK", usage: { inputTokens: 7, outputTokens: 3 } })]);
  });
});
