import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository, type AuditRepository } from "../src/audit.js";
import { handleRecoveryRequest } from "../src/audit-recovery.js";
import type { AnalysisResult } from "../src/analyze.js";
import { formatQuoteMessage, handleImageMessage, NO_QUOTE_MESSAGE, TECHNICAL_ISSUE_MESSAGE, type IncomingImage, type QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { crashPoint, forever, gate, withFaults } from "./support/faults.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Escenarios de interrupción de extremo a extremo: handleImageMessage REAL + repositorio REAL (src/audit.ts) + PostgreSQL REAL. Lo único simulado es la red hacia
// Supabase (un adaptador que traduce cada llamada RPC de PostgREST a la función SQL correspondiente) y Kapso (un contador de envíos). Una "caída" es una ejecución
// que deja de avanzar para siempre (promesa que nunca se resuelve), como una función de Vercel que se corta. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[audit-recovery-e2e] PostgreSQL no disponible: se omiten los escenarios de recuperación contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATIONS = ["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql", "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"].map((name) => join(__dirname, "..", "supabase", "migrations", name));
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const publicQuote = { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" as const };
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote }) as AnalysisResult;

describe.skipIf(!bin)("recuperación de procesamientos interrumpidos (extremo a extremo contra PostgreSQL real)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("recovery");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(file);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const repository = () => createSupabaseAuditRepository({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 20_000 });
  const newImage = (): IncomingImage => ({ messageId: `wamid.e2e-${++counter}-${Date.now()}`, from: "59170000000", mediaId: `media-${counter}` });

  function setup(overrides: Partial<QuoteDeps> = {}, audit: AuditRepository = repository()) {
    const sends: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const deps: QuoteDeps = {
      downloadImage: async () => ({ bytes: jpeg }),
      loadCatalog: async () => [],
      analyze: async () => okAnalysis(),
      sendText: async (_to, body) => { sends.push(body); return { providerMessageId: `wamid.out-${sends.length}` }; },
      log: (event, data) => logs.push([event, data]),
      audit,
      leaseRenewIntervalMs: 3_600_000, // el latido no interviene: así una ejecución "caída" no renueva su lease
      ...overrides
    };
    return { deps, sends, logs };
  }
  const row = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 hour' where kapso_message_id = '${message}';`);
  const recoverNow = () => repository().recoverStale({ reservedGraceSeconds: 0, abandonGraceSeconds: 0, limit: 500 });
  const events = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  const replyChecks = (message: string) => db.ok(`select count(*) from public.plusmedik_audit_checks c join public.plusmedik_audit_runs r on r.id = c.run_id where r.kapso_message_id = '${message}' and c.check_kind = 'REPLY'`);

  // Deja a una ejecución colgada para siempre en un punto del flujo y espera a que llegue allí (sin depender de pausas fijas).
  async function hang(image: IncomingImage, where: "download" | "analysis" | "after-reserve"): Promise<ReturnType<typeof setup>> {
    const point = crashPoint();
    const run =
      where === "download" ? setup({ downloadImage: async () => { await point.hook(); return { bytes: jpeg }; } })
      : where === "analysis" ? setup({ analyze: async () => { await point.hook(); return okAnalysis(); } })
      : setup({}, withFaults(repository(), { reserveSend: { after: point.hook } }));
    void handleImageMessage(image, run.deps);
    await point.reached;
    return run;
  }

  it("camino feliz: un mensaje, una respuesta, el texto de siempre, y la corrida queda enviada", async () => {
    const image = newImage();
    const { deps, sends, logs } = setup();
    await expect(handleImageMessage(image, deps)).resolves.toBe("quoted");
    expect(sends).toEqual([formatQuoteMessage(publicQuote)]);
    expect(await row(image.messageId)).toMatchObject({ processing_status: "COMPLETED", send_state: "ACCEPTED", reply_state: "ACCEPTED", kapso_outbound_message_id: "wamid.out-1", lease_attempts: 1, analysis_decision: "AUTO_SAFE" });
    expect(await phase(image.messageId)).toBe("SENT_ACCEPTED");
    expect(await replyChecks(image.messageId)).toBe("1");
    expect(events(logs, "audit_unavailable")).toEqual([]);
  });

  it("webhook duplicado concurrente: exactamente UN envío; el otro webhook se ignora sin tocar nada", async () => {
    const image = newImage();
    const a = setup({ analyze: async () => { await sleep(600); return okAnalysis(); } });
    const b = setup();
    const [ra, rb] = await Promise.all([handleImageMessage(image, a.deps), (async () => { await sleep(250); return handleImageMessage(image, b.deps); })()]);
    expect([ra, rb].sort()).toEqual(["ignored", "quoted"]);
    expect(a.sends.length + b.sends.length).toBe(1);
    expect(events(b.logs, "duplicate_ignored")).toEqual([{ processingStatus: "PROCESSING", reason: "BUSY" }]);
    expect(await row(image.messageId)).toMatchObject({ lease_attempts: 1, send_state: "ACCEPTED" });
  });

  describe("caída ANTES del análisis o DURANTE él (recuperable)", () => {
    it.each([
      ["antes del análisis (la descarga de la imagen nunca termina)", "download"],
      ["durante el análisis (el motor nunca termina)", "analysis"]
    ] as const)("%s: con el lease vigente el reenvío del webhook se ignora; vencido, lo reanuda UN solo envío", async (_name, where) => {
      const image = newImage();
      const crashed = await hang(image, where); // queda colgado para siempre
      expect(await phase(image.messageId)).toBe("RECOVERABLE");

      const early = setup();
      await expect(handleImageMessage(image, early.deps)).resolves.toBe("ignored");
      expect(early.sends).toEqual([]);

      await expire(image.messageId);
      const redelivery = setup();
      await expect(handleImageMessage(image, redelivery.deps)).resolves.toBe("quoted");
      expect(events(redelivery.logs, "lease_taken_over")).toEqual([{ fence: 2 }]);
      expect(crashed.sends.length + early.sends.length + redelivery.sends.length).toBe(1);
      expect(await row(image.messageId)).toMatchObject({ lease_attempts: 2, lease_fence: 2, send_state: "ACCEPTED", processing_status: "COMPLETED" });
    });

    it("sin reenvío del webhook, el recuperador la cierra sin responder (queda para atención) y un reenvío posterior ya no la reabre", async () => {
      const image = newImage();
      await hang(image, "analysis");
      await expire(image.messageId);
      expect(await recoverNow()).toMatchObject({ abandonedBeforeSend: expect.any(Number) });
      expect(await phase(image.messageId)).toBe("NEEDS_ATTENTION");
      expect(await row(image.messageId)).toMatchObject({ attention_reason: "ABANDONED_BEFORE_SEND", reply_state: "NOT_ATTEMPTED" });
      const late = setup();
      await expect(handleImageMessage(image, late.deps)).resolves.toBe("ignored");
      expect(late.sends).toEqual([]);
      expect(events(late.logs, "duplicate_ignored")).toEqual([{ processingStatus: "FAILED", reason: "FINISHED" }]);
    });
  });

  describe("caída DESPUÉS del análisis y ANTES de reservar el envío", () => {
    it("la corrida queda ANALIZADA sin envío; el reenvío con el lease vencido la reanuda y responde una sola vez", async () => {
      const image = newImage();
      const point = crashPoint();
      const crashed = setup({}, withFaults(repository(), { reserveSend: { before: point.hook } }));
      void handleImageMessage(image, crashed.deps);
      await point.reached;
      expect(await phase(image.messageId)).toBe("ANALYZED_UNSENT");
      expect(crashed.sends).toEqual([]);
      await expire(image.messageId);
      const redelivery = setup();
      await expect(handleImageMessage(image, redelivery.deps)).resolves.toBe("quoted");
      expect(crashed.sends.length + redelivery.sends.length).toBe(1);
      expect(await row(image.messageId)).toMatchObject({ lease_attempts: 2, send_state: "ACCEPTED" });
    });
  });

  describe("caída con el envío RESERVADO (resultado incierto: nunca se reenvía)", () => {
    it("después de reservar y antes de llamar a Kapso: nada se envió, pero tampoco se reenvía; el recuperador la marca DESCONOCIDA", async () => {
      const image = newImage();
      const point = crashPoint();
      const crashed = setup({}, withFaults(repository(), { reserveSend: { after: point.hook } }));
      void handleImageMessage(image, crashed.deps);
      await point.reached;
      expect(await phase(image.messageId)).toBe("SENDING");
      await expire(image.messageId);
      const redelivery = setup();
      await expect(handleImageMessage(image, redelivery.deps)).resolves.toBe("ignored");
      expect(events(redelivery.logs, "duplicate_ignored")).toEqual([{ processingStatus: "ANALYZED", reason: "IN_DOUBT" }]);
      await recoverNow();
      expect(await phase(image.messageId)).toBe("SEND_UNKNOWN");
      expect(await row(image.messageId)).toMatchObject({ send_state: "UNKNOWN", attention_reason: "SEND_OUTCOME_UNKNOWN", reply_state: "UNKNOWN" });
      const again = setup();
      await expect(handleImageMessage(image, again.deps)).resolves.toBe("ignored");
      expect(crashed.sends.length + redelivery.sends.length + again.sends.length).toBe(0);
    });

    it("durante la llamada a Kapso (se envió y la ejecución murió): UN envío en total; ni el reenvío ni el recuperador lo repiten", async () => {
      const image = newImage();
      const point = crashPoint();
      const crashed = setup({
        sendText: async (_to, body) => { crashedSends.push(body); await point.hook(); return {}; }
      });
      const crashedSends: string[] = [];
      void handleImageMessage(image, crashed.deps);
      await point.reached;
      expect(crashedSends).toHaveLength(1);
      await expire(image.messageId);
      const redelivery = setup();
      await expect(handleImageMessage(image, redelivery.deps)).resolves.toBe("ignored");
      await recoverNow();
      await recoverNow();
      const again = setup();
      await handleImageMessage(image, again.deps);
      expect(redelivery.sends.length + again.sends.length).toBe(0);
      expect(await row(image.messageId)).toMatchObject({ send_state: "UNKNOWN", attention_reason: "SEND_OUTCOME_UNKNOWN" });
      expect(await replyChecks(image.messageId)).toBe("1");
    });

    it("Kapso aceptó el mensaje pero NO se pudo guardar el resultado (Supabase caído): un solo envío y la corrida queda en resultado desconocido", async () => {
      const image = newImage();
      const run = setup({}, repository());
      network.downFor.add("plusmedik_audit_fenced_record_reply");
      try {
        await expect(handleImageMessage(image, run.deps)).resolves.toBe("quoted");
      } finally {
        network.downFor.delete("plusmedik_audit_fenced_record_reply");
      }
      expect(run.sends).toHaveLength(1);
      expect(events(run.logs, "audit_unavailable")).toEqual([{ stage: "reply", kind: "UNKNOWN_OUTCOME" }]);
      expect((await row(image.messageId)).send_state).toBe("RESERVED");
      await expire(image.messageId);
      const redelivery = setup();
      await expect(handleImageMessage(image, redelivery.deps)).resolves.toBe("ignored");
      await recoverNow();
      expect(await row(image.messageId)).toMatchObject({ send_state: "UNKNOWN", attention_reason: "SEND_OUTCOME_UNKNOWN" });
      expect(run.sends.length + redelivery.sends.length).toBe(1);
    });

    it("si Kapso falla con un error de transporte el envío no se repite y queda registrado como DESCONOCIDO", async () => {
      const image = newImage();
      const attempts: string[] = [];
      const run = setup({ sendText: async (_to, body) => { attempts.push(body); throw new Error("socket hang up"); } });
      await expect(handleImageMessage(image, run.deps)).resolves.toBe("quoted");
      expect(attempts).toHaveLength(1);
      expect(await row(image.messageId)).toMatchObject({ send_state: "UNKNOWN", reply_state: "UNKNOWN", attention_reason: "SEND_OUTCOME_UNKNOWN", processing_status: "COMPLETED" });
    });
  });

  describe("ejecutor antiguo", () => {
    it("pierde el lease durante el análisis, otro termina y responde: cuando el antiguo revive no escribe ni envía", async () => {
      const image = newImage();
      const hold = gate();
      const stale = setup({ analyze: async () => { await hold.hook(); return okAnalysis(); } });
      const staleDone = handleImageMessage(image, stale.deps);
      await hold.arrived;
      await expire(image.messageId);
      const fresh = setup();
      await expect(handleImageMessage(image, fresh.deps)).resolves.toBe("quoted");
      const before = await row(image.messageId);
      hold.open();
      await expect(staleDone).resolves.toBe("ignored");
      expect(stale.sends).toEqual([]);
      expect(fresh.sends).toHaveLength(1);
      expect(events(stale.logs, "reply_withheld")).toEqual([{ reason: "lease_lost" }]);
      expect(events(stale.logs, "audit_unavailable").map((entry) => entry.kind)).toContain("LEASE_LOST");
      const after = await row(image.messageId);
      expect(after).toMatchObject({ lease_fence: 2, send_state: "ACCEPTED", evidence_hash: before.evidence_hash, kapso_outbound_message_id: before.kapso_outbound_message_id });
    });

    it("el recuperador cierra la corrida mientras el antiguo sigue vivo con la reserva: la comprobación final lo detiene y nadie envía", async () => {
      const image = newImage();
      const hold = gate();
      const stale = setup({}, withFaults(repository(), { reserveSend: { after: hold.hook } }));
      const staleDone = handleImageMessage(image, stale.deps);
      await hold.arrived;
      await expire(image.messageId);
      await recoverNow();
      const fresh = setup();
      await expect(handleImageMessage(image, fresh.deps)).resolves.toBe("ignored");
      hold.open();
      await expect(staleDone).resolves.toBe("ignored");
      expect(stale.sends).toEqual([]);
      expect(fresh.sends).toEqual([]);
      expect(events(stale.logs, "reply_withheld")).toEqual([{ reason: "lost" }]);
      expect(await row(image.messageId)).toMatchObject({ send_state: "UNKNOWN", attention_reason: "SEND_OUTCOME_UNKNOWN" }); // conservador: la base no puede saber que nunca se llamó a Kapso
    });
  });

  describe("Supabase no disponible", () => {
    it("al reclamar: por defecto se responde igual (política heredada) y queda registrado; con requireAuditGuard NO se responde", async () => {
      network.down = true;
      try {
        const legacy = setup();
        await expect(handleImageMessage(newImage(), legacy.deps)).resolves.toBe("quoted");
        expect(legacy.sends).toHaveLength(1);
        expect(events(legacy.logs, "audit_unavailable")[0]).toEqual({ stage: "claim", kind: "UNKNOWN_OUTCOME" });
        const strict = setup({ requireAuditGuard: true });
        await expect(handleImageMessage(newImage(), strict.deps)).resolves.toBe("ignored");
        expect(strict.sends).toEqual([]);
        expect(events(strict.logs, "reply_withheld")).toEqual([{ reason: "audit_guard_unavailable" }]);
      } finally {
        network.down = false;
      }
    });

    it("al reservar el envío: NO se envía (no se puede demostrar exclusividad); al volver la base y vencer el lease, se responde una vez", async () => {
      const image = newImage();
      network.downFor.add("plusmedik_audit_reserve_send");
      const first = setup();
      try {
        await expect(handleImageMessage(image, first.deps)).resolves.toBe("ignored");
      } finally {
        network.downFor.delete("plusmedik_audit_reserve_send");
      }
      expect(first.sends).toEqual([]);
      expect(events(first.logs, "reply_withheld")).toEqual([{ reason: "unavailable" }]);
      expect(events(first.logs, "audit_unavailable")).toEqual([{ stage: "reserve", kind: "UNKNOWN_OUTCOME" }]);
      await expire(image.messageId);
      const second = setup();
      await expect(handleImageMessage(image, second.deps)).resolves.toBe("quoted");
      expect(first.sends.length + second.sends.length).toBe(1);
    });

    it("la evidencia no se pudo guardar: la respuesta sale igual y una sola vez (fail-open de la evidencia)", async () => {
      const image = newImage();
      network.downFor.add("plusmedik_audit_fenced_record_evidence");
      const run = setup();
      try {
        await expect(handleImageMessage(image, run.deps)).resolves.toBe("quoted");
      } finally {
        network.downFor.delete("plusmedik_audit_fenced_record_evidence");
      }
      expect(run.sends).toHaveLength(1);
      expect(await row(image.messageId)).toMatchObject({ send_state: "ACCEPTED", evidence_recorded_at: null }); // brecha de auditoría observable
    });
  });

  describe("mensajes al paciente y fallos del motor", () => {
    it("un fallo del motor responde el aviso técnico de siempre, una vez, y la corrida queda FAILED + enviada", async () => {
      const image = newImage();
      const run = setup({ analyze: async () => { throw new Error("IA caída"); } });
      await expect(handleImageMessage(image, run.deps)).resolves.toBe("technical_issue");
      expect(run.sends).toEqual([TECHNICAL_ISSUE_MESSAGE]);
      expect(await row(image.messageId)).toMatchObject({ processing_status: "FAILED", send_state: "ACCEPTED", error_code: "AI_PROCESSING_FAILED" });
    });

    it("sin cotización se pide una foto más clara (texto de siempre) y una imagen de tipo no soportado también; una demasiado grande no recibe respuesta", async () => {
      const noQuote = newImage();
      const a = setup({ analyze: async () => ({ ...okAnalysis(), publicQuote: undefined, outcome: "HUMAN_REVIEW" }) as AnalysisResult });
      await handleImageMessage(noQuote, a.deps);
      expect(a.sends).toEqual([NO_QUOTE_MESSAGE]);

      const wrongType = newImage();
      const b = setup({ downloadImage: async () => ({ bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) }) });
      await handleImageMessage(wrongType, b.deps);
      expect(b.sends).toEqual([NO_QUOTE_MESSAGE]);
      expect(await row(wrongType.messageId)).toMatchObject({ processing_status: "COMPLETED", error_code: "IMAGE_TYPE", send_state: "ACCEPTED" });

      const huge = newImage();
      const c = setup({ downloadImage: async () => ({ bytes: new Uint8Array(9 * 1024 * 1024) }) });
      await expect(handleImageMessage(huge, c.deps)).resolves.toBe("ignored");
      expect(c.sends).toEqual([]);
      expect(await row(huge.messageId)).toMatchObject({ processing_status: "IGNORED", send_state: "NOT_APPLICABLE", error_code: "IMAGE_SIZE" });
    });
  });

  describe("intervención humana (preparación)", () => {
    it("un bloqueo que llega durante el análisis cancela el envío pendiente: no se responde", async () => {
      const image = newImage();
      const hold = gate();
      const run = setup({ analyze: async () => { await hold.hook(); return okAnalysis(); } });
      const done = handleImageMessage(image, run.deps);
      await hold.arrived;
      expect(await repository().blockSend(image.messageId, "staff_replied")).toBe("blocked");
      hold.open();
      await expect(done).resolves.toBe("ignored");
      expect(run.sends).toEqual([]);
      expect(events(run.logs, "reply_withheld")).toEqual([{ reason: "blocked" }]);
      expect(await phase(image.messageId)).toBe("CLOSED_NO_SEND");
    });

    it("un bloqueo que llega con el envío ya reservado llega tarde: el mensaje autorizado sale una vez", async () => {
      const image = newImage();
      const hold = gate();
      const run = setup({}, withFaults(repository(), { reserveSend: { after: hold.hook } }));
      const done = handleImageMessage(image, run.deps);
      await hold.arrived;
      expect(await repository().blockSend(image.messageId, "staff_replied")).toBe("too_late");
      hold.open();
      await expect(done).resolves.toBe("quoted");
      expect(run.sends).toHaveLength(1);
    });
  });

  describe("recuperación periódica (endpoint inerte hasta configurarlo)", () => {
    it("sin CRON_SECRET responde 503 y no toca la base; con secreto incorrecto 401; con el correcto ejecuta y devuelve solo contadores", async () => {
      const image = newImage();
      await hang(image, "after-reserve");
      await expire(image.messageId);
      const calls = network.calls.length;
      const logs: Array<[string, Record<string, unknown>]> = [];
      const build = (secret: string | undefined, method = "GET", authorization?: string) =>
        handleRecoveryRequest(new Request("https://example.test/api/audit/recover", { method, headers: authorization ? { authorization } : {} }), { repository: () => repository(), secret, log: (event, data) => logs.push([event, data]) });
      expect((await build(undefined, "GET", "Bearer x")).status).toBe(503);
      expect((await build("s3cret-value", "GET")).status).toBe(401);
      expect((await build("s3cret-value", "GET", "Bearer wrong")).status).toBe(401);
      expect((await build("s3cret-value", "DELETE", "Bearer s3cret-value")).status).toBe(405);
      expect(network.calls.length).toBe(calls);
      const ok = await build("s3cret-value", "GET", "Bearer s3cret-value");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["abandonedBeforeSend", "ok", "sendOutcomeUnknown"]);
      expect(logs.map(([event]) => event)).toEqual(["audit_recovery"]);
    });

    it("si la base no responde, el endpoint contesta 500 sin detalles", async () => {
      network.down = true;
      try {
        const response = await handleRecoveryRequest(new Request("https://example.test/api/audit/recover", { headers: { authorization: "Bearer s3cret-value" } }), { repository: () => repository(), secret: "s3cret-value", log: () => undefined });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ ok: false, error: "recovery_failed" });
      } finally {
        network.down = false;
      }
    });
  });
});
