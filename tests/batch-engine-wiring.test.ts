import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { BATCH_TEXTS } from "../src/batch-compose.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { QUOTE_TEXTS, type StudyInterpreter } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { TurnHandlers } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql, type Network } from "./support/postgrest-over-psql.js";

// Conexión del motor global de lotes (Fase 3) de extremo a extremo: el webhook REAL + los turnos REALES + los repositorios REALES + PostgreSQL REAL con TODAS las migraciones. Solo se simulan Kapso, el catálogo y el motor
// de recetas. Se prueba lo que importa de la conexión: APAGADO por defecto (la ruta de siempre intacta), MODO SOMBRA (mismas respuestas y mismas escrituras, solo una línea de comparación con códigos), MOTOR ENCENDIDO
// (una decisión por lote, cotización directa) y el RESPALDO a la ruta de siempre.

const bin = findPostgresBin();
if (!bin) console.warn("[batch-engine-wiring] PostgreSQL no disponible: se omiten los escenarios de la conexión del motor de lotes contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_3377";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const baseCatalog = (): CatalogStudy[] => [
  study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45),
  study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5),
  study(3, "COLESTEROL TOTAL", ["colesterol"], 25),
  study(4, "TSH", ["tsh"], 80),
  study(7, "CREATININA SERICA", ["creatinina"], 20),
  study(8, "CREATININA EN ORINA", ["creatinina"], 22)
];

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: nowSeconds(), type: "image", from: phone, image: { id: tag }, kapso: { ...inbound, has_media: true, media_url: `https://example.test/${tag}.jpg` } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const batchOf = (...events: unknown[]) => ({ type: "whatsapp.message.received", batch: true, data: events });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const BATCH = { "x-webhook-event": "whatsapp.message.received", "x-webhook-batch": "true" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

type Verdict = { kind: "COMPLETE"; ids: number[] } | { kind: "NONE" };
function analysisOf(verdict: Verdict, catalog: CatalogStudy[]): AnalysisResult {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const lines = verdict.kind === "NONE" ? [] : verdict.ids.map((n) => ({ id: uuid(n), code: null, name: byId.get(uuid(n))?.name ?? "?", priceBs: byId.get(uuid(n))?.priceBs ?? 0, basis: ["EXACT"], texts: [] }));
  const outcome = verdict.kind === "COMPLETE" ? "AUTO_COMPLETE" : "HUMAN_REVIEW";
  return {
    decision: verdict.kind === "COMPLETE" ? "AUTO_SAFE" : "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome,
    publicQuote: verdict.kind === "NONE" ? undefined : { studies: lines.map((l) => ({ name: l.name, priceBs: l.priceBs })), totalBs: lines.reduce((sum, l) => sum + l.priceBs, 0), totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
    internal: { outcome, recipeComplete: verdict.kind === "COMPLETE", reviewRequired: verdict.kind !== "COMPLETE", quoted: { lines, subtotalBs: 0 }, studies: [], pending: [], recipeStops: [], document: { type: "TEXT_EXPLICIT_REQUEST", zones: [] }, advisories: [] }
  } as unknown as AnalysisResult;
}

// Lecturas de la base que la ruta de siempre hace y pueden variar (esperas y reintentos). El modo sombra NO puede agregar ninguna llamada a la base salvo la lectura de SOLO LECTURA (STABLE) de la migración 20.
const READS = new Set(["plusmedik_quote_session_read", "plusmedik_quote_last_studies"]);
const PEEK = "plusmedik_quote_shadow_peek";

describe.skipIf(!bin)("motor global de lotes conectado a los turnos (apagado, sombra y encendido) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  // La misma base pero SIN la migración 20 (se despliega el código antes de aplicar el SQL).
  let dbMain: PgDatabase;
  let dbWithout20: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("batch_engine_conexion");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
    dbMain = db;
    dbWithout20 = await server.createDatabase("batch_engine_sin_migracion_veinte");
    await dbWithout20.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS.filter((name) => !name.includes("quote_shadow_peek"))) await dbWithout20.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  interface Options {
    sessions?: boolean;
    engine?: "shadow" | "on";
    handlers?: TurnHandlers;
    verdicts?: Record<string, Verdict>;
    dailyCap?: { max: number; windowSeconds: number };
    // Números de llamada a loadCatalog (desde 1) que fallan, para provocar un fallo del motor ANTES de tocar nada.
    failCatalogCalls?: number[];
    // Etiquetas de fotos cuyo análisis falla.
    failTags?: string[];
    // Intérprete de estudios (OpenAI) configurado.
    interpreter?: StudyInterpreter;
    // Un repositorio de auditoría SIN la lectura de solo lectura (migración 20 sin aplicar).
    noPeek?: boolean;
  }
  function setup(options: Options = {}) {
    const network: Network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const world = { catalog: baseCatalog(), catalogCalls: 0 };
    const analyzed: string[] = [];
    const sessions = options.sessions ?? true;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })),
      loadCatalog: vi.fn(async () => {
        world.catalogCalls++;
        if (options.failCatalogCalls?.includes(world.catalogCalls)) throw new Error("catálogo caído (simulado)");
        return structuredClone(world.catalog);
      }),
      analyze: vi.fn(async ({ imageBase64, catalog }) => {
        const tag = /TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "?";
        analyzed.push(tag);
        if (options.failTags?.includes(tag)) throw new Error("fallo simulado del análisis");
        return analysisOf(options.verdicts?.[tag] ?? { kind: "COMPLETE", ids: [1] }, catalog);
      }),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: options.noPeek ? { ...createSupabaseAuditRepository(rpcOptions()), quoteShadowPeek: undefined } : createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: options.handlers ?? { text: createTextHandler({ log }) },
        ...(options.dailyCap ? { dailyCap: options.dailyCap } : {}),
        ...(options.engine ? { batchEngine: { mode: options.engine } } : {}),
        ...(sessions ? { quoteSessions: resolveQuoteSessionsConfig({ ...(options.interpreter ? { interpreter: options.interpreter } : {}), waitDelayMs: 25, waitRetries: 400, ttlSeconds: 1800, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, network, world, analyzed, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const logsOf = (w: World, name: string) => w.logs.filter(([event]) => event === name).map(([, data]) => data);
  const deliver = async (w: World, ...events: unknown[]) => {
    expect((await w.hook(signedPost(batchOf(...events), BATCH))).status).toBe(200);
    await w.settle();
  };
  const runsOf = async (key: string): Promise<Array<Record<string, any>>> =>
    JSON.parse(await db.ok(`select coalesce(json_agg(x order by x.seq), '[]') from (select t.seq, r.kapso_message_id, r.send_state, r.send_kind, r.reply_kind, r.processing_status, r.error_code, r.send_block_reason from public.plusmedik_audit_runs r join public.plusmedik_turns t on t.run_id = r.id where r.contact_key = '${key}') x`));
  const sessionsOf = async (key: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(s order by s.created_at, s.id), '[]') from public.plusmedik_quote_sessions s where contact_key = '${key}'`));
  const itemStatuses = async (key: string): Promise<string[]> => JSON.parse(await db.ok(`select coalesce(json_agg(status order by seq), '[]') from public.plusmedik_quote_items where contact_key = '${key}'`));
  const hasPrice = (body: string) => /Bs\s?\d/.test(body);
  // Ninguna corrida del contacto queda «en proceso» (todas terminaron: con envío, sin respuesta o dadas por atendidas).
  const openRuns = async (key: string): Promise<number> => Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${key}' and processing_status in ('PROCESSING','ANALYZED')`));
  const countsOf = (w: World): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const name of w.network.calls) counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  };

  // Un mismo lote en el modo indicado, para un paciente nuevo.
  type Build = (p: ReturnType<typeof patient>) => unknown[];
  async function runBatch(build: Build, options: Options = {}) {
    const p = patient();
    const w = setup(options);
    await deliver(w, ...build(p));
    return { p, w, runs: await runsOf(p.key), sessions: await sessionsOf(p.key), items: await itemStatuses(p.key) };
  }

  const text = (body: string) => (p: { phone: string }) => textEvent(id("txt"), p.phone, body);
  const photo = (tag: string) => (p: { phone: string }) => imageEvent(id("img"), p.phone, tag);
  const batch = (...parts: Array<(p: { phone: string }) => unknown>): Build => (p) => parts.map((part) => part(p));

  // ───────────────────────────── apagado por defecto ─────────────────────────────

  describe("APAGADO (por defecto)", () => {
    it("sin la configuración, un lote sigue la ruta de siempre (resume lo anotado y pregunta «¿eso es todo?», sin cotizar) y no deja ni una línea del motor nuevo", async () => {
      const { p, w, runs, sessions } = await runBatch(batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa")));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("Estudios anotados: HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.");
      expect(w.sends[0]!.body).toContain("¿Eso es todo?");
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(sessions.map((s) => s.status)).toEqual(["OPEN"]);
      expect(runs).toHaveLength(3);
      for (const event of ["batch_shadow", "batch_plan", "batch_engine_fallback", "batch_engine_fallback_used"]) expect(logsOf(w, event), event).toEqual([]);
      for (const [, data] of logsOf(w, "turn_batch").map((entry) => ["turn_batch", entry] as const)) expect(data).not.toHaveProperty("engine");
      expect(p.phone).toBeTruthy();
    });

    it("con el motor configurado pero SIN sesiones de cotización no se activa: la ruta de siempre responde igual", async () => {
      const seen: string[] = [];
      const { w } = await runBatch(batch(text("hola"), text("quiero saber el horario")), { sessions: false, engine: "on", handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "respuesta" }; } } });
      expect(seen).toEqual(["hola\nquiero saber el horario"]);
      expect(w.sends).toHaveLength(1);
      for (const event of ["batch_shadow", "batch_plan"]) expect(logsOf(w, event)).toEqual([]);
    });

    it("un mensaje suelto (no es un lote) nunca pasa por el motor, aunque esté encendido", async () => {
      for (const engine of ["shadow", "on"] as const) {
        const p = patient();
        const w = setup({ engine });
        expect((await w.hook(signedPost(textEvent(id("txt"), p.phone, "hemograma"), { "x-webhook-event": "whatsapp.message.received" }))).status).toBe(200);
        await w.settle();
        expect(w.sends).toHaveLength(1);
        for (const event of ["batch_shadow", "batch_plan"]) expect(logsOf(w, event), `${engine}:${event}`).toEqual([]);
      }
    });
  });

  // ───────────────────────────── modo sombra ─────────────────────────────

  describe("MODO SOMBRA: mismas respuestas, mismas escrituras, una línea de comparación", () => {
    const SCENARIOS: Array<{ name: string; build: Build; shadowLogs: number }> = [
      { name: "quiero cotizar + hemograma completo + y glucosa", build: batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa")), shadowLogs: 1 },
      { name: "estudio ambiguo (dos creatininas)", build: batch(text("quiero cotizar"), text("creatinina")), shadowLogs: 1 },
      { name: "aviso médico + estudio", build: batch(text("me duele el pecho"), text("hemograma")), shadowLogs: 1 },
      { name: "saludo + gracias", build: batch(text("hola"), text("gracias")), shadowLogs: 1 },
      { name: "foto + «listo»", build: batch(photo("A"), text("listo")), shadowLogs: 1 },
      { name: "foto + gracias", build: batch(photo("A"), text("gracias")), shadowLogs: 1 },
      { name: "pidió no cotizar", build: batch(text("No quiero cotizar."), text("hemograma")), shadowLogs: 1 },
      { name: "cancelar sin nada abierto", build: batch(text("cancelar"), text("hola")), shadowLogs: 1 },
      { name: "solo fotos (sin texto el motor no interviene)", build: batch(photo("A"), photo("B")), shadowLogs: 0 }
    ];

    for (const scenario of SCENARIOS) {
      it(`${scenario.name}: la respuesta y las escrituras son las mismas que sin el modo sombra`, async () => {
        const off = await runBatch(scenario.build);
        const shadow = await runBatch(scenario.build, { engine: "shadow" });
        // 1. Mismas respuestas.
        expect(shadow.w.sends.map((s) => s.body)).toEqual(off.w.sends.map((s) => s.body));
        // 2. Mismo estado en la base: corridas, sesiones e ítems.
        expect(shadow.runs.map(({ kapso_message_id: _ignored, ...run }) => run)).toEqual(off.runs.map(({ kapso_message_id: _ignored, ...run }) => run));
        expect(shadow.sessions.map((s) => s.status)).toEqual(off.sessions.map((s) => s.status));
        expect(shadow.items).toEqual(off.items);
        // 3. ESTRICTAMENTE de solo lectura: la ÚNICA llamada nueva a la base es la lectura STABLE de la migración 20. Ninguna otra aparece ni cambia (tampoco la lectura que escribe, ni la consulta
        //    de la última cotización); las únicas llamadas que pueden variar son las lecturas de espera de la propia ruta de siempre, que el modo sombra no toca.
        const [offCounts, shadowCounts] = [countsOf(off.w), countsOf(shadow.w)];
        for (const name of new Set([...Object.keys(offCounts), ...Object.keys(shadowCounts)])) {
          if (name === PEEK) continue;
          if (READS.has(name)) expect(shadowCounts[name] ?? 0, name).toBe(offCounts[name] ?? 0);
          else expect(shadowCounts[name] ?? 0, name).toBe(offCounts[name] ?? 0);
        }
        expect(offCounts[PEEK] ?? 0).toBe(0);
        if (scenario.shadowLogs > 0) expect(shadowCounts[PEEK] ?? 0).toBe(1);
        else expect(shadowCounts[PEEK] ?? 0).toBe(0);
        // 4. Una línea de comparación por lote (y ninguna del motor nuevo ejecutando).
        expect(logsOf(shadow.w, "batch_shadow")).toHaveLength(scenario.shadowLogs);
        // ...y de verdad comparó (no se saltó por una lectura pendiente o fallida)
        for (const line of logsOf(shadow.w, "batch_shadow")) expect(line, scenario.name).not.toHaveProperty("skipped");
        for (const event of ["batch_plan", "batch_engine_fallback", "batch_engine_fallback_used"]) expect(logsOf(shadow.w, event), event).toEqual([]);
        // 5. Sin modelo: el modo sombra no llama a nadie.
        expect(logsOf(off.w, "batch_shadow")).toEqual([]);
      });
    }

    it("compara bien: cuando la ruta de siempre y el motor nuevo hacen lo mismo coincide; cuando difieren lo dice con códigos y hacia dónde", async () => {
      const same = await runBatch(batch(text("hemograma completo"), text("listo")), { engine: "shadow" });
      expect(logsOf(same.w, "batch_shadow")).toEqual([expect.objectContaining({ agree: true, direction: "SAME", current: "QUOTE", shadow: "QUOTE", core: "QUOTE", intent: "CONFIRM", confirmedBy: "FINALIZE", messages: 2, photos: 0, studies: 1, sessionOpen: false })]);
      // la mejora buscada: con intención clara de cotizar y estudios resueltos, el motor nuevo cotiza directo y la ruta de siempre solo resume
      const direct = await runBatch(batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa")), { engine: "shadow" });
      expect(logsOf(direct.w, "batch_shadow")).toEqual([expect.objectContaining({ agree: false, direction: "SHADOW_QUOTES_MORE", current: "SESSION_REPLY", shadow: "QUOTE", core: "QUOTE", intent: "QUOTE", messages: 3, studies: 2 })]);
      const declined = await runBatch(batch(text("No quiero cotizar."), text("hemograma")), { engine: "shadow" });
      const [report] = logsOf(declined.w, "batch_shadow");
      expect(report).toMatchObject({ shadow: "DECLINED", core: "DECLINED", intent: "DECLINE", negated: 1 });
    });

    it("el registro del modo sombra solo lleva códigos: nada del texto del paciente, de los estudios, de precios ni el teléfono completo", async () => {
      const { p, w } = await runBatch(batch(text("Quiero cotizar HEMOGRAMA"), text("y glucosa SECRETO_77")), { engine: "shadow" });
      const lines = JSON.stringify(logsOf(w, "batch_shadow"));
      for (const forbidden of ["HEMOGRAMA", "hemograma", "glucosa", "SECRETO", "45", p.phone, uuid(1)]) expect(lines, forbidden).not.toContain(forbidden);
      expect(JSON.stringify(w.logs)).not.toContain("SECRETO_77");
    });

    it("la solicitud abierta antes del lote se tiene en cuenta: «listo» solo, con estudios ya anotados, el motor nuevo cotizaría igual que la ruta de siempre", async () => {
      const p = patient();
      const w = setup({ engine: "shadow" });
      // un mensaje suelto anota el estudio (no es un lote: no interviene el motor)
      expect((await w.hook(signedPost(textEvent(id("txt"), p.phone, "hemograma"), { "x-webhook-event": "whatsapp.message.received" }))).status).toBe(200);
      await w.settle();
      await deliver(w, textEvent(id("txt"), p.phone, "listo"), textEvent(id("txt"), p.phone, "gracias"));
      expect(logsOf(w, "batch_shadow")).toEqual([expect.objectContaining({ sessionOpen: true, shadow: "QUOTE", current: "QUOTE", agree: true })]);
    });

    it("si la lectura de solo lectura falla, el modo sombra se salta (un código) y la respuesta es la de siempre", async () => {
      const build = batch(text("hemograma"), text("listo"));
      const off = await runBatch(build);
      const w = setup({ engine: "shadow" });
      const p = patient();
      w.network.downFor.add(PEEK);
      await deliver(w, ...build(p));
      expect(w.sends.map((s) => s.body)).toEqual(off.w.sends.map((s) => s.body));
      expect(logsOf(w, "batch_shadow")).toEqual([expect.objectContaining({ skipped: "UNAVAILABLE" })]);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("sin la migración 20 aplicada (no existe la función) el modo sombra NUNCA recurre a la lectura que escribe: se salta y todo sigue igual", async () => {
      const build = batch(text("hemograma"), text("listo"));
      const off = await runBatch(build);
      const { w } = await runBatch(build, { engine: "shadow", noPeek: true });
      expect(w.sends.map((s) => s.body)).toEqual(off.w.sends.map((s) => s.body));
      expect(logsOf(w, "batch_shadow")).toEqual([expect.objectContaining({ skipped: "UNAVAILABLE" })]);
      expect(countsOf(w)).toEqual(countsOf(off.w));
      expect(countsOf(w)[PEEK] ?? 0).toBe(0);
    });

    it("un lote cuya comparación depende del modelo (estudio que el catálogo no identifica) con OpenAI configurado se marca NO CONCLUYENTE; sin OpenAI configurado es una comparación válida", async () => {
      const interpreter = async () => undefined;
      for (const configured of [true, false]) {
        const p = patient();
        const w = setup({ engine: "shadow", ...(configured ? { interpreter } : {}) });
        await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "xhq"));
        const [report] = logsOf(w, "batch_shadow");
        if (configured) expect(report).toMatchObject({ agree: null, direction: "INCONCLUSIVE", limits: ["MODEL_NEEDED"] });
        else expect(report).toMatchObject({ limits: [] });
        expect(typeof (report as { agree: unknown }).agree).toBe(configured ? "object" : "boolean");
      }
    });
  });

  // ───────────────────────────── motor encendido ─────────────────────────────

  describe("MOTOR ENCENDIDO: una decisión por lote", () => {
    it("«Quiero cotizar» + «Hemograma completo» + «Y glucosa»: UNA cotización directa, con precios del catálogo, una sola solicitud cerrada y las otras corridas sin respuesta", async () => {
      const { w, runs, sessions } = await runBatch(batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa")), { engine: "on" });
      expect(w.sends).toHaveLength(1);
      const body = w.sends[0]!.body;
      expect(body).toContain("HEMOGRAMA COMPLETO");
      expect(body).toContain("GLUCOSA EN AYUNAS");
      expect(hasPrice(body)).toBe(true);
      expect(sessions.map((s) => s.status)).toEqual(["QUOTED"]);
      expect(runs).toHaveLength(3);
      expect(runs.filter((run) => run.send_state === "ACCEPTED")).toHaveLength(1);
      expect(runs[2]).toMatchObject({ send_state: "ACCEPTED", send_kind: "quoted" });
      for (const run of runs.slice(0, 2)) expect(run).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "IGNORED", error_code: "NO_REPLY" });
      expect(logsOf(w, "batch_plan")).toEqual([expect.objectContaining({ core: "QUOTE", intent: "QUOTE", messages: 3, studies: 2 })]);
      expect(logsOf(w, "turn_batch")).toEqual([expect.objectContaining({ engine: "on", messages: 3 })]);
      expect(logsOf(w, "batch_shadow")).toEqual([]);
    });

    it("el precio sale del catálogo al cotizar: si cambia entre los mensajes y el cierre, manda el vigente", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      w.world.catalog = baseCatalog().map((s) => (s.id === uuid(1) ? { ...s, priceBs: 99 } : s));
      await deliver(w, textEvent(id("txt"), p.phone, "quiero cotizar"), textEvent(id("txt"), p.phone, "hemograma completo"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toMatch(/99/);
      expect(w.sends[0]!.body).not.toMatch(/\b45\b/);
    });

    it("pidió NO cotizar: se respeta, no se cotiza y no se insiste", async () => {
      const { w, sessions } = await runBatch(batch(text("No quiero cotizar."), text("hemograma completo")), { engine: "on" });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(BATCH_TEXTS.declined);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(sessions.map((s) => s.status)).not.toContain("QUOTED");
    });

    it("NEGATIVAS Y RECTIFICACIONES entre mensajes: gana lo último que dijo el paciente", async () => {
      // «glucosa no» retira la glucosa pedida antes: se cotiza solo el hemograma
      const retracted = await runBatch(batch(text("hemograma y glucosa"), text("glucosa no"), text("cotizar")), { engine: "on" });
      expect(retracted.w.sends).toHaveLength(1);
      expect(retracted.w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(retracted.w.sends[0]!.body).not.toContain("GLUCOSA");
      expect(retracted.sessions.map((s) => s.status)).toEqual(["QUOTED"]);
      // «no quiero hemograma» + «quiero glucosa»: la rectificación por una nueva petición cotiza la glucosa
      const rectified = await runBatch(batch(text("no quiero hemograma"), text("quiero glucosa")), { engine: "on" });
      expect(rectified.w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
      expect(rectified.w.sends[0]!.body).not.toContain("HEMOGRAMA");
      // una petición POSTERIOR a «no quiero cotizar» se anota, pero sigue sin cotizarse
      const later = await runBatch(batch(text("no quiero cotizar"), text("hemograma completo")), { engine: "on" });
      expect(later.w.sends[0]!.body).toContain(BATCH_TEXTS.declined);
      expect(later.w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(hasPrice(later.w.sends[0]!.body)).toBe(false);
      expect(later.sessions.map((s) => s.status)).toEqual(["OPEN"]);
      // cambió de idea: lo último manda
      const changed = await runBatch(batch(text("no quiero cotizar"), text("cotizar hemograma")), { engine: "on" });
      expect(changed.w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(hasPrice(changed.w.sends[0]!.body)).toBe(true);
    });

    it("una negación DUDOSA nunca cotiza por inferencia ni descarta nada en silencio: se resume lo anotado y se pregunta", async () => {
      for (const messages of [["no quiero", "cotizar hemograma"], ["cotizar hemograma", "no, glucosa"]]) {
        const { w, sessions, p } = await runBatch(batch(...messages.map((m) => text(m))), { engine: "on" });
        expect(w.sends, messages.join(" | ")).toHaveLength(1);
        expect(hasPrice(w.sends[0]!.body), messages.join(" | ")).toBe(false);
        expect(w.sends[0]!.body).toContain("Estudios anotados");
        expect(sessions.map((s) => s.status)).toEqual(["OPEN"]);
        expect(logsOf(w, "batch_plan")[0]).toMatchObject({ core: "SUMMARY" });
        expect(await openRuns(p.key)).toBe(0);
      }
    });

    it("estudio ambiguo: no se cotiza y se pregunta solo por esa duda", async () => {
      const { w, sessions } = await runBatch(batch(text("quiero cotizar"), text("creatinina")), { engine: "on" });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("CREATININA SERICA");
      expect(w.sends[0]!.body).toContain("CREATININA EN ORINA");
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(sessions.map((s) => s.status)).toEqual(["OPEN"]);
    });

    it("aviso médico + estudios: el aviso lo da el manejador de siempre y la cotización sale en el MISMO mensaje", async () => {
      const handlers: TurnHandlers = { text: async (turn) => (/pecho/i.test(turn.text!) ? { body: "AVISO_MEDICO_FIJO" } : undefined) };
      const { w } = await runBatch(batch(text("me duele el pecho"), text("quiero cotizar hemograma")), { engine: "on", handlers });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("AVISO_MEDICO_FIJO");
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(hasPrice(w.sends[0]!.body)).toBe(true);
    });

    it("lo que el manejador de siempre contesta (saludo, información) lo sigue contestando él, no un texto fijo del motor", async () => {
      const seen: string[] = [];
      const handlers: TurnHandlers = { text: async (turn) => { seen.push(turn.text!); return { body: "RESPUESTA_DEL_MANEJADOR" }; } };
      const { w } = await runBatch(batch(text("hola"), text("buenas tardes")), { engine: "on", handlers });
      expect(w.sends.map((s) => s.body)).toEqual(["RESPUESTA_DEL_MANEJADOR"]);
      expect(seen).toEqual(["hola\nbuenas tardes"]);
    });

    it("foto + «listo»: la foto se analiza como siempre y la cotización sale en un solo mensaje", async () => {
      const { w, sessions, runs } = await runBatch(batch(photo("A"), text("listo")), { engine: "on" });
      expect(w.analyzed).toEqual(["A"]);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(sessions.map((s) => s.status)).toEqual(["QUOTED"]);
      expect(runs.filter((run) => run.send_state === "ACCEPTED")).toHaveLength(1);
    });

    it("LOTE MIXTO, la foto es el ÚLTIMO mensaje: el motor lo atiende igual (el último texto anota, la foto cierra): una cotización con el texto y la foto, y todas las corridas terminadas", async () => {
      const { w, sessions, runs, items, p } = await runBatch(batch(text("quiero cotizar"), text("y glucosa"), photo("A")), { engine: "on" });
      expect(logsOf(w, "batch_engine_skipped")).toEqual([]);
      expect(logsOf(w, "batch_plan")).toEqual([expect.objectContaining({ core: "QUOTE", messages: 2, studies: 2 })]);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
      expect(hasPrice(w.sends[0]!.body)).toBe(true);
      expect(sessions.map((s) => s.status)).toEqual(["QUOTED"]);
      // ORDEN: el texto se anota ANTES que la foto (por el orden de llegada) y la foto conserva su ítem propio
      expect(items).toEqual(["RESOLVED", "RESOLVED"]);
      // EVIDENCIA: la foto se analizó una vez y su corrida es la que envía; los textos quedan cerrados, uno sin respuesta y el que anotó dado por atendido
      expect(w.analyzed).toEqual(["A"]);
      expect(runs.map((run) => run.seq)).toEqual([1, 2, 3]);
      expect(runs[0]).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "IGNORED", error_code: "NO_REPLY" });
      expect(runs[1]).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "COMPLETED", error_code: "BATCHED" });
      expect(runs[2]).toMatchObject({ send_state: "ACCEPTED", send_kind: "quoted" });
      expect(w.network.calls.filter((name) => name === "plusmedik_audit_fenced_record_evidence")).toHaveLength(1);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("LOTE MIXTO en cualquier orden y con varias fotos: siempre UNA cotización con todo, ninguna corrida abierta y cada foto analizada una vez", async () => {
      const orders: Array<[string, Build, number]> = [
        ["foto, texto, foto", batch(photo("A"), text("quiero cotizar glucosa"), photo("B")), 3],
        ["texto, foto, texto, foto", batch(text("quiero"), photo("A"), text("cotizar glucosa"), photo("B")), 4],
        ["foto, foto, texto", batch(photo("A"), photo("B"), text("cotizar glucosa")), 3],
        ["texto, foto, foto", batch(text("cotizar glucosa"), photo("A"), photo("B")), 3]
      ];
      for (const [name, build, messages] of orders) {
        const { w, sessions, runs, p } = await runBatch(build, { engine: "on", verdicts: { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "COMPLETE", ids: [3] } } });
        expect(w.sends, name).toHaveLength(1);
        for (const study of ["HEMOGRAMA COMPLETO", "COLESTEROL TOTAL", "GLUCOSA EN AYUNAS"]) expect(w.sends[0]!.body, `${name} :: ${study}`).toContain(study);
        expect(sessions.map((s) => s.status), name).toEqual(["QUOTED"]);
        expect([...w.analyzed].sort(), name).toEqual(["A", "B"]);
        expect(runs, name).toHaveLength(messages);
        expect(runs.filter((run) => run.send_state === "ACCEPTED"), name).toHaveLength(1);
        expect(await openRuns(p.key), name).toBe(0);
        expect(logsOf(w, "batch_engine_skipped"), name).toEqual([]);
      }
    });

    it("INVARIANTE: las 6 permutaciones de un texto y dos fotos dan el MISMO resultado (una cotización con todo), sin importar cuál es el último mensaje", async () => {
      const parts = { T: text("cotizar glucosa"), A: photo("A"), B: photo("B") } as const;
      const permutations = [["T", "A", "B"], ["T", "B", "A"], ["A", "T", "B"], ["A", "B", "T"], ["B", "T", "A"], ["B", "A", "T"]] as const;
      const verdicts: Record<string, Verdict> = { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "COMPLETE", ids: [3] } };
      const quotes = new Set<string>();
      for (const order of permutations) {
        const { w, sessions, runs, p } = await runBatch(batch(...order.map((key) => parts[key])), { engine: "on", verdicts });
        expect(w.sends, order.join("")).toHaveLength(1);
        expect(sessions.map((s) => s.status), order.join("")).toEqual(["QUOTED"]);
        expect(runs.filter((run) => run.send_state === "ACCEPTED"), order.join("")).toHaveLength(1);
        expect(await openRuns(p.key), order.join("")).toBe(0);
        // las líneas salen en el orden en que llegaron los estudios (se conserva el orden); lo que NO puede cambiar es QUÉ se cotiza ni cuánto suma
        const lines = w.sends[0]!.body.split("\n").filter((line) => /Bs\s?\d/.test(line));
        expect(lines.length, order.join("")).toBe(4);
        quotes.add([...lines].sort().join("|"));
      }
      expect(quotes.size).toBe(1);
    });

    it("LOTE MIXTO con una duda: texto ambiguo + foto al final NO cotiza y pregunta por la ambigüedad; el texto y la foto quedan anotados", async () => {
      const { w, sessions, items, p } = await runBatch(batch(text("quiero cotizar"), text("creatinina"), photo("A")), { engine: "on" });
      expect(w.sends).toHaveLength(1);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(w.sends[0]!.body).toContain("CREATININA SERICA");
      expect(w.sends[0]!.body).toContain("CREATININA EN ORINA");
      expect(sessions.map((s) => s.status)).toEqual(["OPEN"]);
      expect(items.length).toBe(2);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("LOTE MIXTO con una foto ilegible al final: no se cotiza a medias, se pide reenviarla y el texto queda anotado", async () => {
      const { w, sessions, items, p } = await runBatch(batch(text("quiero cotizar hemograma"), photo("Z")), { engine: "on", verdicts: { Z: { kind: "NONE" } } });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(QUOTE_TEXTS.resend);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(sessions.map((s) => s.status)).toEqual(["OPEN"]);
      expect(items).toEqual(["RESOLVED", "UNREADABLE"]);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("LOTE MIXTO cuya foto falla al analizarse: se avisa del problema técnico de la foto y no se cotiza sin ella", async () => {
      const { w, sessions, p } = await runBatch(batch(text("quiero cotizar hemograma"), photo("F")), { engine: "on", failTags: ["F"] });
      expect(w.sends).toHaveLength(1);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(sessions.map((s) => s.status)).not.toContain("QUOTED");
      expect(await openRuns(p.key)).toBe(0);
    });

    it("la equivalencia con la ruta de siempre en un lote mixto de «listo»: mismo resultado cotizado, pero el motor lo cierra en UN turno", async () => {
      const build = batch(text("hemograma"), photo("A"), text("listo"));
      const reference = await runBatch(build, { verdicts: { A: { kind: "COMPLETE", ids: [2] } } });
      const on = await runBatch(build, { engine: "on", verdicts: { A: { kind: "COMPLETE", ids: [2] } } });
      for (const study of ["HEMOGRAMA COMPLETO", "GLUCOSA EN AYUNAS"]) {
        expect(reference.w.sends[0]!.body).toContain(study);
        expect(on.w.sends[0]!.body).toContain(study);
      }
      expect(on.w.sends).toHaveLength(1);
      expect(on.sessions.map((s) => s.status)).toEqual(reference.sessions.map((s) => s.status));
    });

    it("CANCELACIÓN + fotos: de la posición de cada foto respecto a la cancelación depende cuáles sobreviven, y eso no se puede reconstruir con seguridad: el lote sigue COMPLETO por la ruta de siempre", async () => {
      const build = batch(text("cancelar"), photo("A"), text("quiero cotizar glucosa"));
      const reference = await runBatch(build);
      const { w, sessions, runs } = await runBatch(build, { engine: "on" });
      expect(logsOf(w, "batch_engine_skipped")).toEqual([{ reason: "CANCEL_WITH_PHOTOS", messages: 3 }]);
      expect(logsOf(w, "batch_plan")).toEqual([]);
      expect(w.sends.map((s) => s.body)).toEqual(reference.w.sends.map((s) => s.body));
      expect(sessions.map((s) => s.status)).toEqual(reference.sessions.map((s) => s.status));
      expect(runs).toHaveLength(3);
    });

    it("CANCELACIÓN sin fotos sigue siendo del motor nuevo", async () => {
      const { w } = await runBatch(batch(text("cancelar"), text("hola")), { engine: "on" });
      expect(logsOf(w, "batch_engine_skipped")).toEqual([]);
      expect(logsOf(w, "batch_plan")).toHaveLength(1);
    });

    it("foto en medio, texto al final: el motor atiende el lote y el nombre de un estudio no se reconstruye a través de la foto", async () => {
      const { w, sessions } = await runBatch(batch(text("quiero cotizar"), photo("A"), text("y glucosa")), { engine: "on" });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
      expect(sessions.map((s) => s.status)).toEqual(["QUOTED"]);
    });

    it("foto ilegible + texto: se avisa de la foto y no se cotiza a medias", async () => {
      const { w, sessions } = await runBatch(batch(photo("Z"), text("quiero cotizar hemograma")), { engine: "on", verdicts: { Z: { kind: "NONE" } } });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(QUOTE_TEXTS.resend);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(sessions.map((s) => s.status)).not.toContain("QUOTED");
    });

    it("foto + «gracias»: no se queda sin respuesta; resume lo anotado", async () => {
      const { w, sessions } = await runBatch(batch(photo("A"), text("gracias")), { engine: "on" });
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(sessions.map((s) => s.status)).toEqual(["OPEN"]);
    });
  });

  // ───────────────────────────── seguridad que no cambia ─────────────────────────────

  describe("MOTOR ENCENDIDO conserva la deduplicación, la pausa humana, el tope diario y la privacidad", () => {
    it("DUPLICADOS: el mismo lote reentregado no responde ni anota dos veces", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      const events = [textEvent(id("txt"), p.phone, "quiero cotizar"), textEvent(id("txt"), p.phone, "hemograma completo")];
      await deliver(w, ...events);
      await deliver(w, ...events);
      expect(w.sends).toHaveLength(1);
      expect((await itemStatuses(p.key)).length).toBe(1);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
    });

    it("PAUSA HUMANA: con el contacto pausado el lote no se procesa ni se responde", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      expect((await w.hook(signedPost(humanEvent(id("hum"), p.phone), SENT))).status).toBe(200);
      await w.settle();
      await deliver(w, textEvent(id("txt"), p.phone, "quiero cotizar"), textEvent(id("txt"), p.phone, "hemograma completo"));
      expect(w.sends).toEqual([]);
      expect(await runsOf(p.key)).toEqual([]);
      expect(await sessionsOf(p.key)).toEqual([]);
    });

    it("LÍMITE DIARIO: un lote cuenta UNA respuesta; a la sexta ya no se responde", async () => {
      const p = patient();
      const w = setup({ engine: "on", dailyCap: { max: 5, windowSeconds: 86_400 } });
      for (let i = 0; i < 5; i++) await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo"));
      expect(w.sends).toHaveLength(5);
      const blocked = [id("txt"), id("txt")];
      await deliver(w, textEvent(blocked[0]!, p.phone, "hemograma"), textEvent(blocked[1]!, p.phone, "completo"));
      expect(w.sends).toHaveLength(5);
      const last = (await runsOf(p.key)).find((run) => run.kapso_message_id === blocked[1]);
      expect(last).toMatchObject({ send_state: "CANCELLED", send_block_reason: "DAILY_CAP" });
    });

    it("PRIVACIDAD: el contenido de los mensajes nunca queda en el registro", async () => {
      const { w } = await runBatch(batch(text("quiero cotizar hemograma"), text("tengo dolor SECRETO_CLINICO_5521")), { engine: "on" });
      expect(JSON.stringify(w.logs)).not.toContain("SECRETO_CLINICO_5521");
      expect(JSON.stringify(w.logs)).not.toMatch(/hemograma/i);
    });
  });

  // ───────────────────────────── código desplegado SIN la migración 20 ─────────────────────────────

  describe("SIN la migración 20 aplicada: desplegar el código antes del SQL no altera la ruta actual", () => {
    beforeEach(() => { db = dbWithout20; });
    afterEach(() => { db = dbMain; });
    const onDatabase = async <T>(database: PgDatabase, work: () => Promise<T>): Promise<T> => {
      const previous = db;
      db = database;
      try {
        return await work();
      } finally {
        db = previous;
      }
    };
    const BUILDS: Array<[string, Build]> = [
      ["quiero cotizar + hemograma + glucosa", batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa"))],
      ["hemograma + listo", batch(text("hemograma"), text("listo"))],
      ["foto + listo", batch(photo("A"), text("listo"))],
      ["aviso médico + estudio", batch(text("me duele el pecho"), text("hemograma"))],
      ["pidió no cotizar", batch(text("No quiero cotizar."), text("hemograma"))],
      ["solo fotos", batch(photo("A"), photo("B"))]
    ];

    it("APAGADO (por defecto): la misma respuesta, las mismas corridas, sesiones e ítems y las mismas llamadas a la base que con la migración, y NINGUNA llamada a la función nueva", async () => {
      for (const [name, build] of BUILDS) {
        const without = await runBatch(build);
        const reference = await onDatabase(dbMain, () => runBatch(build));
        expect(without.w.sends.map((s) => s.body), name).toEqual(reference.w.sends.map((s) => s.body));
        expect(without.runs.map(({ kapso_message_id: _ignored, ...run }) => run), name).toEqual(reference.runs.map(({ kapso_message_id: _ignored, ...run }) => run));
        expect(without.sessions.map((s) => s.status), name).toEqual(reference.sessions.map((s) => s.status));
        expect(without.items, name).toEqual(reference.items);
        const counts = countsOf(without.w);
        expect(counts[PEEK] ?? 0, name).toBe(0);
        for (const logged of ["batch_shadow", "batch_plan", "batch_engine_fallback", "batch_engine_skipped"]) expect(logsOf(without.w, logged), `${name}:${logged}`).toEqual([]);
        expect(await openRuns(without.p.key), name).toBe(0);
      }
    });

    it("un mensaje suelto (sin lote) tampoco cambia", async () => {
      const p = patient();
      const w = setup();
      expect((await w.hook(signedPost(textEvent(id("txt"), p.phone, "hemograma"), { "x-webhook-event": "whatsapp.message.received" }))).status).toBe(200);
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(countsOf(w)[PEEK] ?? 0).toBe(0);
    });

    it("MODO SOMBRA sin la función: se salta (UNAVAILABLE), hace uno o dos intentos de lectura que fallan sin efectos, y la respuesta y las demás llamadas son las de siempre", async () => {
      for (const [name, build] of BUILDS) {
        const off = await runBatch(build);
        const shadow = await runBatch(build, { engine: "shadow" });
        expect(shadow.w.sends.map((s) => s.body), name).toEqual(off.w.sends.map((s) => s.body));
        expect(shadow.runs.map(({ kapso_message_id: _ignored, ...run }) => run), name).toEqual(off.runs.map(({ kapso_message_id: _ignored, ...run }) => run));
        expect(shadow.items, name).toEqual(off.items);
        const [offCounts, shadowCounts] = [countsOf(off.w), countsOf(shadow.w)];
        for (const key of new Set([...Object.keys(offCounts), ...Object.keys(shadowCounts)])) if (key !== PEEK) expect(shadowCounts[key] ?? 0, `${name}:${key}`).toBe(offCounts[key] ?? 0);
        const logged = logsOf(shadow.w, "batch_shadow");
        if (name === "solo fotos") {
          expect(logged).toEqual([]);
        } else {
          expect(logged, name).toEqual([expect.objectContaining({ skipped: "UNAVAILABLE" })]);
          // un intento (el cliente de la base reintenta una vez un error del servidor): una lectura que falla, sin efectos
          expect(shadowCounts[PEEK], name).toBeGreaterThanOrEqual(1);
          expect(shadowCounts[PEEK], name).toBeLessThanOrEqual(2);
        }
        expect(await openRuns(shadow.p.key), name).toBe(0);
      }
    });

    it("MOTOR ENCENDIDO no necesita la migración 20: atiende el lote igual que con ella y no llama a la función", async () => {
      const build = batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa"));
      const without = await runBatch(build, { engine: "on" });
      const reference = await onDatabase(dbMain, () => runBatch(build, { engine: "on" }));
      expect(without.w.sends.map((s) => s.body)).toEqual(reference.w.sends.map((s) => s.body));
      expect(without.sessions.map((s) => s.status)).toEqual(["QUOTED"]);
      expect(countsOf(without.w)[PEEK] ?? 0).toBe(0);
      expect(await openRuns(without.p.key)).toBe(0);
    });
  });

  // ───────────────────────────── respaldo ─────────────────────────────

  describe("RESPALDO a la ruta de siempre", () => {
    it("si el motor no puede ni decidir el lote (catálogo caído en su primera lectura), la ruta de siempre atiende el lote COMPLETO: misma respuesta, mismas escrituras", async () => {
      const reference = await runBatch(batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa")));
      const { w, sessions, runs } = await runBatch(batch(text("Quiero cotizar"), text("Hemograma completo"), text("Y glucosa")), { engine: "on", failCatalogCalls: [2] });
      expect(logsOf(w, "batch_engine_fallback")).toEqual([{ stage: "PROBE" }]);
      expect(logsOf(w, "batch_engine_fallback_used")).toHaveLength(1);
      expect(logsOf(w, "batch_plan")).toEqual([]);
      expect(w.sends.map((s) => s.body)).toEqual(reference.w.sends.map((s) => s.body));
      expect(sessions.map((s) => s.status)).toEqual(reference.sessions.map((s) => s.status));
      expect(runs.filter((run) => run.send_state === "ACCEPTED")).toHaveLength(1);
      // el respaldo no duplicó nada: las mismas escrituras que la ruta de siempre
      const [offCounts, backupCounts] = [countsOf(reference.w), countsOf(w)];
      for (const name of Object.keys(offCounts)) if (!READS.has(name)) expect(backupCounts[name] ?? 0, name).toBe(offCounts[name]);
    });

    it("si falla DESPUÉS de haber anotado (el cierre de la solicitud), NO vuelve a la ruta de siempre: no duplica lo anotado y responde con el aviso técnico", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      w.network.downFor.add("plusmedik_quote_session_close");
      await deliver(w, textEvent(id("txt"), p.phone, "quiero cotizar"), textEvent(id("txt"), p.phone, "hemograma completo"));
      expect(logsOf(w, "batch_engine_fallback_used")).toEqual([]);
      expect(logsOf(w, "batch_engine_fallback")).toEqual([]);
      expect(w.network.calls.filter((name) => name === "plusmedik_quote_item_begin")).toHaveLength(1);
      expect(w.sends).toHaveLength(1);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect((await itemStatuses(p.key)).length).toBe(1);
    });
  });
});
