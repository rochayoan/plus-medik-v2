import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { TurnHandlers } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import { TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Buffering nativo de Kapso (lotes de 15 s: batch:true + data[]) de extremo a extremo: el webhook REAL + los turnos REALES + los repositorios REALES + PostgreSQL REAL con TODAS las
// migraciones (incluida la del tope diario). Solo se simulan Kapso (contador de envíos), el catálogo y el motor de recetas. Se omite, con aviso, si no hay PostgreSQL.
// Un lote del mismo contacto es UNA solicitud con UNA respuesta; conserva deduplicación, pausa humana, sesiones de cotización y el tope de 5 respuestas cada 24 h.

const bin = findPostgresBin();
if (!bin) console.warn("[kapso-batch-e2e] PostgreSQL no disponible: se omiten los escenarios del buffering de Kapso contra la base real.");
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
// Lo que Kapso entrega con el buffering: UN POST con batch:true y data[] (más la cabecera x-webhook-batch).
const batchOf = (...events: unknown[]) => ({ type: "whatsapp.message.received", batch: true, data: events });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const BATCH = { ...RECEIVED, "x-webhook-batch": "true" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const until = (condition: () => void) => vi.waitFor(condition, { timeout: 60_000, interval: 20 });

// Lo que el motor de recetas diría de cada foto (por etiqueta): completo o parcial.
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

describe.skipIf(!bin)("buffering nativo de Kapso (lotes batch:true + data[]) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("kapso_batch_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  interface Options { sessions?: boolean; handlers?: TurnHandlers; verdicts?: Record<string, Verdict>; dailyCap?: { max: number; windowSeconds: number }; gates?: Record<string, Promise<void>>; failTags?: string[]; interpreter?: NonNullable<Parameters<typeof resolveQuoteSessionsConfig>[0]>["interpreter"] }
  function setup(options: Options = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const world = { catalog: baseCatalog(), verdicts: { ...(options.verdicts ?? {}) } as Record<string, Verdict> };
    const analyzed: string[] = [];
    const sessions = options.sessions ?? false;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })),
      loadCatalog: vi.fn(async () => structuredClone(world.catalog)),
      analyze: vi.fn(async ({ imageBase64, catalog }) => {
        const tag = /TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "?";
        analyzed.push(tag);
        await options.gates?.[tag];
        if (options.failTags?.includes(tag)) throw new Error("fallo simulado del análisis");
        return analysisOf(world.verdicts[tag] ?? { kind: "COMPLETE", ids: [1] }, catalog);
      }),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: options.handlers ?? { text: createTextHandler({ log }) },
        ...(options.dailyCap ? { dailyCap: options.dailyCap } : {}),
        ...(sessions ? { quoteSessions: resolveQuoteSessionsConfig({ ...(options.interpreter ? { interpreter: options.interpreter } : {}), waitDelayMs: 25, waitRetries: 400, ttlSeconds: 1800, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, scheduled, world, analyzed, quote, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  // Un lote de Kapso: UN POST con todos los eventos.
  const deliver = async (w: World, ...events: unknown[]) => {
    expect((await w.hook(signedPost(batchOf(...events), BATCH))).status).toBe(200);
    await w.settle();
  };
  // Un solo mensaje, en su propia entrega (sin buffering).
  const deliverOne = async (w: World, event: unknown, headers: Record<string, string> = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const runsOf = async (key: string): Promise<Array<Record<string, any>>> =>
    JSON.parse(await db.ok(`select coalesce(json_agg(x order by x.seq), '[]') from (select t.seq, r.kapso_message_id, r.send_state, r.send_kind, r.reply_kind, r.processing_status, r.error_code, r.send_block_reason from public.plusmedik_audit_runs r join public.plusmedik_turns t on t.run_id = r.id where r.contact_key = '${key}') x`));
  const byMessage = (runs: Array<Record<string, any>>, message: string) => runs.find((run) => run.kapso_message_id === message)!;
  const sessionsOf = async (key: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(s order by s.created_at, s.id), '[]') from public.plusmedik_quote_sessions s where contact_key = '${key}'`));
  const itemCount = async (key: string): Promise<number> => Number(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${key}' and status <> 'DUPLICATE'`));
  const hasPrice = (body: string) => /Bs\s?\d/.test(body);
  const recorder = () => {
    const seen: string[] = [];
    let n = 0;
    const handlers: TurnHandlers = { text: async (turn) => { seen.push(turn.text!); return { body: `respuesta ${++n}` }; } };
    return { seen, handlers };
  };

  // ───────────────────────────── varios textos en un lote ─────────────────────────────

  it("VARIOS TEXTOS: un lote de tres textos es una sola solicitud: el manejador los recibe juntos y en orden, se envía UNA respuesta y las corridas de los otros dos quedan cerradas sin respuesta", async () => {
    const p = patient();
    const rec = recorder();
    const w = setup({ handlers: rec.handlers });
    const [m1, m2, m3] = [id("txt"), id("txt"), id("txt")];
    await deliver(w, textEvent(m1, p.phone, "hola"), textEvent(m2, p.phone, "quiero saber el horario"), textEvent(m3, p.phone, "y la dirección"));
    expect(rec.seen).toEqual(["hola\nquiero saber el horario\ny la dirección"]);
    expect(w.sends).toEqual([{ to: p.phone, body: "respuesta 1" }]);
    const runs = await runsOf(p.key);
    expect(runs.map((run) => run.seq)).toEqual([1, 2, 3]);
    expect(byMessage(runs, m3)).toMatchObject({ send_state: "ACCEPTED", send_kind: "conversation", reply_kind: "conversation", processing_status: "COMPLETED" });
    for (const message of [m1, m2]) expect(byMessage(runs, message)).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "IGNORED", error_code: "NO_REPLY" });
    expect(logsOf(w.logs, "turn_batch")).toEqual([{ phone: expect.any(String), messages: 3, claimed: 3, requests: 1, textsMerged: 2 }]);
    // el contenido de los mensajes nunca queda en el registro
    expect(JSON.stringify(w.logs)).not.toContain("horario");
  });

  it("un mensaje por entrega (sin buffering) sigue siendo una respuesta por mensaje, como siempre", async () => {
    const p = patient();
    const rec = recorder();
    const w = setup({ handlers: rec.handlers });
    await deliverOne(w, textEvent(id("txt"), p.phone, "uno"));
    await deliverOne(w, textEvent(id("txt"), p.phone, "dos"));
    expect(rec.seen).toEqual(["uno", "dos"]);
    expect(w.sends.map((s) => s.body)).toEqual(["respuesta 1", "respuesta 2"]);
    expect(logsOf(w.logs, "turn_batch")).toEqual([]);
  });

  it("dos contactos en el mismo POST no se mezclan: cada uno recibe su propia respuesta", async () => {
    const a = patient();
    const b = patient();
    const w = setup({ handlers: { text: async (turn) => ({ body: `eco: ${turn.text}` }) } });
    await deliver(w, textEvent(id("txt"), a.phone, "a1"), textEvent(id("txt"), b.phone, "b1"), textEvent(id("txt"), a.phone, "a2"));
    expect(w.sends.map((s) => [s.to, s.body]).sort()).toEqual([[a.phone, "eco: a1\na2"], [b.phone, "eco: b1"]].sort());
  });

  // ───────────────────────────── foto + gracias ─────────────────────────────

  it("FOTO + «gracias»: la cotización de la foto sale aunque el último mensaje no tenga respuesta (y en el orden contrario también)", async () => {
    const handlers: TurnHandlers = { text: async (turn) => (/gracias/i.test(turn.text!) ? undefined : { body: "otra cosa" }) };
    for (const order of ["photo-first", "thanks-first"] as const) {
      const p = patient();
      const w = setup({ handlers });
      const [photoId, thanksId] = [id("img"), id("txt")];
      const events = order === "photo-first" ? [imageEvent(photoId, p.phone, "A"), textEvent(thanksId, p.phone, "gracias")] : [textEvent(thanksId, p.phone, "gracias"), imageEvent(photoId, p.phone, "A")];
      await deliver(w, ...events);
      expect(w.sends, order).toHaveLength(1);
      expect(w.sends[0]!.body, order).toContain("HEMOGRAMA COMPLETO — Bs 45");
      const runs = await runsOf(p.key);
      // el envío lo hace la corrida del ÚLTIMO mensaje; la otra queda cerrada sin respuesta propia
      const [sender, silent] = order === "photo-first" ? [thanksId, photoId] : [photoId, thanksId];
      expect(byMessage(runs, sender), order).toMatchObject({ send_state: "ACCEPTED", send_kind: "quoted", reply_kind: "quoted" });
      // la foto (con análisis registrado) se da por atendida dentro del mensaje del lote; el «gracias» sin respuesta se cierra como siempre
      expect(byMessage(runs, silent), order).toMatchObject(order === "photo-first" ? { send_state: "NOT_APPLICABLE", processing_status: "COMPLETED", error_code: "BATCHED" } : { send_state: "NOT_APPLICABLE", processing_status: "IGNORED", error_code: "NO_REPLY" });
    }
  });

  it("«gracias» solo (sin foto) en un lote sigue sin responderse, y no deja ninguna corrida abierta", async () => {
    const p = patient();
    const w = setup({ handlers: { text: async () => undefined } });
    const [m1, m2] = [id("txt"), id("txt")];
    await deliver(w, textEvent(m1, p.phone, "gracias"), textEvent(m2, p.phone, "muchas gracias"));
    expect(w.sends).toEqual([]);
    for (const run of await runsOf(p.key)) expect(run, run.kapso_message_id).toMatchObject({ processing_status: "IGNORED", error_code: "NO_REPLY", send_state: "NOT_APPLICABLE" });
  });

  // ───────────────────────────── múltiples fotos ─────────────────────────────

  it("VARIAS FOTOS (cotización inmediata): cada foto se analiza una vez y las tres cotizaciones salen juntas en UN mensaje, con una sola corrida que envía", async () => {
    const p = patient();
    const w = setup({ verdicts: { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "COMPLETE", ids: [2] }, C: { kind: "COMPLETE", ids: [3, 4] } } });
    const messages = [id("img"), id("img"), id("img")];
    await deliver(w, imageEvent(messages[0]!, p.phone, "A"), imageEvent(messages[1]!, p.phone, "B"), imageEvent(messages[2]!, p.phone, "C"));
    expect(w.analyzed.sort()).toEqual(["A", "B", "C"]);
    expect(w.sends).toHaveLength(1);
    const body = w.sends[0]!.body;
    for (const expected of ["HEMOGRAMA COMPLETO — Bs 45", "GLUCOSA EN AYUNAS — Bs 30,50", "COLESTEROL TOTAL — Bs 25", "TSH — Bs 80"]) expect(body).toContain(expected);
    const runs = await runsOf(p.key);
    expect(runs.filter((run) => run.send_state === "ACCEPTED")).toHaveLength(1);
    expect(byMessage(runs, messages[2]!)).toMatchObject({ send_state: "ACCEPTED", send_kind: "quoted" });
  });

  it("VARIAS FOTOS (sesión de cotización) + «listo» en el MISMO lote: una sola cotización con todo, sin acuses intermedios y con los precios vigentes", async () => {
    const p = patient();
    const w = setup({ sessions: true, verdicts: { A: { kind: "COMPLETE", ids: [1, 2] }, B: { kind: "COMPLETE", ids: [2, 3] } } });
    const listo = id("txt");
    await deliver(w, imageEvent(id("img"), p.phone, "A"), imageEvent(id("img"), p.phone, "B"), textEvent(listo, p.phone, "listo"));
    expect(w.analyzed.sort()).toEqual(["A", "B"]);
    expect(w.sends).toHaveLength(1);
    const body = w.sends[0]!.body;
    for (const expected of ["HEMOGRAMA COMPLETO — Bs 45", "GLUCOSA EN AYUNAS — Bs 30,50", "COLESTEROL TOTAL — Bs 25", "Total de los estudios cotizados: Bs 100,50"]) expect(body).toContain(expected);
    expect(body.match(/GLUCOSA EN AYUNAS —/g)).toHaveLength(1);
    expect(body).not.toContain("Estudios identificados");
    const [session] = await sessionsOf(p.key);
    expect(session).toMatchObject({ status: "QUOTED" });
    expect(await itemCount(p.key)).toBe(2);
    expect(byMessage(await runsOf(p.key), listo)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
  });

  it("VARIAS FOTOS (sesión) SIN «listo»: un solo acuse, ningún precio, y la solicitud queda abierta con las dos fotos", async () => {
    const p = patient();
    const w = setup({ sessions: true, verdicts: { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "COMPLETE", ids: [2] } } });
    await deliver(w, imageEvent(id("img"), p.phone, "A"), imageEvent(id("img"), p.phone, "B"));
    expect(w.sends).toHaveLength(1);
    expect(hasPrice(w.sends[0]!.body)).toBe(false);
    expect(await itemCount(p.key)).toBe(2);
    await deliverOne(w, textEvent(id("txt"), p.phone, "listo"));
    expect(w.sends).toHaveLength(2);
    expect(w.sends[1]!.body).toContain("Total de los estudios cotizados: Bs 75,50");
  });

  it("una foto ilegible en el lote no se oculta: se avisa junto al resto y no se cotiza sobre ella", async () => {
    const p = patient();
    const w = setup({ sessions: true, verdicts: { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "NONE" } } });
    await deliver(w, imageEvent(id("img"), p.phone, "A"), imageEvent(id("img"), p.phone, "B"), textEvent(id("txt"), p.phone, "listo"));
    expect(w.sends).toHaveLength(1);
    // lo ilegible detiene la cotización (se pide reenviar) en vez de cotizar «a medias»
    expect(w.sends[0]!.body).toContain(QUOTE_TEXTS.resend);
    expect(hasPrice(w.sends[0]!.body)).toBe(false);
  });

  // ───────────────────────────── sesiones activas ─────────────────────────────

  it("SESIÓN ACTIVA: lo anotado en entregas anteriores se suma al lote («foto B» + «listo») y se cotiza todo junto", async () => {
    const p = patient();
    const w = setup({ sessions: true, verdicts: { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "COMPLETE", ids: [3] } } });
    await deliverOne(w, imageEvent(id("img"), p.phone, "A"));
    expect(w.sends).toHaveLength(1);
    await deliver(w, imageEvent(id("img"), p.phone, "B"), textEvent(id("txt"), p.phone, "listo"));
    expect(w.sends).toHaveLength(2);
    const body = w.sends[1]!.body;
    expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(body).toContain("COLESTEROL TOTAL — Bs 25");
    expect(body).toContain("Total de los estudios cotizados: Bs 70");
  });

  it("SESIÓN ACTIVA: varios textos de estudios y «listo» en un lote alimentan UNA solicitud y salen en una cotización", async () => {
    const p = patient();
    const w = setup({ sessions: true });
    await deliver(w, textEvent(id("txt"), p.phone, "glucosa"), textEvent(id("txt"), p.phone, "tsh"), textEvent(id("txt"), p.phone, "listo"));
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
    expect(w.sends[0]!.body).toContain("TSH — Bs 80");
    expect(w.sends[0]!.body).toContain("Total de los estudios cotizados: Bs 110,50");
  });

  it("SESIÓN ACTIVA: un texto médico en el mismo lote NO se traga los estudios que se escribieron al lado: quedan anotados y la urgencia se atiende", async () => {
    const p = patient();
    const w = setup({ sessions: true });
    await deliver(w, textEvent(id("txt"), p.phone, "glucosa"), textEvent(id("txt"), p.phone, "me duele mucho el pecho"));
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.body).toContain(DRAFT_TEXTS.medical_unavailable);
    expect(await itemCount(p.key)).toBe(1);
    await deliverOne(w, textEvent(id("txt"), p.phone, "listo"));
    expect(w.sends.at(-1)!.body).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
  });

  // ───────────────────────────── composición final del mensaje del lote ─────────────────────────────

  describe("composición final: lo más completo y actualizado, sin instrucciones genéricas ya resueltas", () => {
    const GENERIC = [DRAFT_TEXTS.send_recipe, DRAFT_TEXTS.greeting, DRAFT_TEXTS.fallback];
    const noGeneric = (body: string) => { for (const text of GENERIC) expect(body).not.toContain(text); };

    it("«Quiero cotizar» + «Hemograma completo» + «Y glucosa»: UNA burbuja con el resumen de estudios y SIN la respuesta genérica que pide los estudios", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), textEvent(id("txt"), p.phone, "Hemograma completo"), textEvent(id("txt"), p.phone, "Y glucosa"));
      expect(w.sends).toHaveLength(1);
      const body = w.sends[0]!.body;
      noGeneric(body);
      expect(body).toContain("HEMOGRAMA COMPLETO");
      expect(body).toContain("GLUCOSA EN AYUNAS");
      // el resumen de la solicitud aparece una sola vez, con TODOS los estudios, y conserva la pregunta que SÍ falta (¿eso es todo?)
      expect(body.match(/Estudios anotados/g)).toHaveLength(1);
      expect(body).toContain("Estudios anotados: HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.");
      expect(body).toContain("¿Eso es todo?");
      expect(hasPrice(body)).toBe(false);
      expect(await itemCount(p.key)).toBe(2);
    });

    it("lo genérico tampoco se cuela si llega DESPUÉS de los estudios, ni con un saludo delante", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "Hola"), textEvent(id("txt"), p.phone, "Hemograma completo"), textEvent(id("txt"), p.phone, "Y glucosa"));
      expect(w.sends).toHaveLength(1);
      noGeneric(w.sends[0]!.body);
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
    });

    it("si TODO lo que hay es genérico (saludo + «quiero cotizar»), sale solo la última, no las dos", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "Hola"), textEvent(id("txt"), p.phone, "Quiero cotizar"));
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.send_recipe }]);
    });

    it("un aviso MÉDICO se conserva (y la respuesta genérica se va): estudios anotados + urgencia en una burbuja", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), textEvent(id("txt"), p.phone, "Hemograma completo"), textEvent(id("txt"), p.phone, "me duele mucho el pecho"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(DRAFT_TEXTS.medical_unavailable);
      noGeneric(w.sends[0]!.body);
      expect(await itemCount(p.key)).toBe(1);
    });

    it("una solicitud de ATENCIÓN HUMANA se conserva junto al resumen y sin la respuesta genérica", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), textEvent(id("txt"), p.phone, "Hemograma completo"), textEvent(id("txt"), p.phone, "quiero hablar con una persona"));
      expect(w.sends).toHaveLength(1);
      const body = w.sends[0]!.body;
      expect(body).toContain(DRAFT_TEXTS.handoff_unavailable.split(".")[0]!);
      expect(body).toContain("HEMOGRAMA COMPLETO");
      expect(body).not.toContain(DRAFT_TEXTS.send_recipe);
      expect(body).not.toContain(DRAFT_TEXTS.greeting);
    });

    it("un ERROR (foto que falla) se conserva y la respuesta genérica se va", async () => {
      const p = patient();
      const w = setup({ sessions: true, failTags: ["X"] });
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), imageEvent(id("img"), p.phone, "X"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(TECHNICAL_ISSUE_MESSAGE);
      noGeneric(w.sends[0]!.body);
    });

    it("una COTIZACIÓN se conserva completa y sin respuesta genérica ni acuses intermedios", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), textEvent(id("txt"), p.phone, "Hemograma completo"), textEvent(id("txt"), p.phone, "Y glucosa"), textEvent(id("txt"), p.phone, "listo"));
      expect(w.sends).toHaveLength(1);
      const body = w.sends[0]!.body;
      noGeneric(body);
      expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(body).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
      expect(body).toContain("Total de los estudios cotizados: Bs 75,50");
      expect(body).not.toContain("Estudios anotados");
    });

    it("cotización de una foto + «Quiero cotizar»: la cotización sale y la respuesta genérica no", async () => {
      const p = patient();
      const w = setup({ verdicts: { A: { kind: "COMPLETE", ids: [1] } } });
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), imageEvent(id("img"), p.phone, "A"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO — Bs 45");
      noGeneric(w.sends[0]!.body);
    });

    it("un mensaje suelto «Quiero cotizar» (sin lote) sigue recibiendo la respuesta genérica de siempre", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliverOne(w, textEvent(id("txt"), p.phone, "Quiero cotizar"));
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.send_recipe }]);
    });
  });

  // ───────────────────────────── nombres de estudios partidos entre mensajes ─────────────────────────────

  describe("textos fragmentados: «quiero cotizar» + «hemograma» + «completo»", () => {
    // Como en producción con el intérprete encendido: un fragmento suelto como «completo» sale «sin resolver». Registra a qué textos se les preguntó.
    const unclearInterpreter = () => {
      const asked: string[] = [];
      const interpreter: NonNullable<Parameters<typeof resolveQuoteSessionsConfig>[0]>["interpreter"] = async (text) => {
        asked.push(text);
        return /^completo$/i.test(text.trim()) ? { isQuoteRequest: true, wantsQuote: false, matched: [], ambiguous: [], unclear: [text], notFound: [] } : undefined;
      };
      return { asked, interpreter };
    };
    const itemStatuses = async (key: string): Promise<string[]> => JSON.parse(await db.ok(`select coalesce(json_agg(status order by seq), '[]') from public.plusmedik_quote_items where contact_key = '${key}'`));

    it("EL CASO REAL: un solo estudio reconocido, ninguno «sin resolver», una sola burbuja y a «completo» nunca se le pregunta por separado", async () => {
      const p = patient();
      const { asked, interpreter } = unclearInterpreter();
      const w = setup({ sessions: true, interpreter });
      const [m1, m2, m3] = [id("txt"), id("txt"), id("txt")];
      await deliver(w, textEvent(m1, p.phone, "quiero cotizar"), textEvent(m2, p.phone, "hemograma"), textEvent(m3, p.phone, "completo"));
      expect(w.sends).toHaveLength(1);
      const body = w.sends[0]!.body;
      expect(body).toContain("Estudios anotados: HEMOGRAMA COMPLETO.");
      expect(body).toContain("¿Eso es todo?");
      expect(body).not.toContain(DRAFT_TEXTS.send_recipe);
      // nada «sin resolver»: la sesión tiene UN estudio, resuelto, y el intérprete nunca vio «completo» suelto
      expect(await itemStatuses(p.key)).toEqual(["RESOLVED"]);
      expect(asked).not.toContain("completo");
      expect(asked).not.toContain("Completo");
      // los fragmentos son un solo turno: el líder es el último mensaje y el anterior queda cerrado sin respuesta propia
      const runs = await runsOf(p.key);
      expect(byMessage(runs, m3)).toMatchObject({ send_state: "ACCEPTED" });
      expect(byMessage(runs, m2)).toMatchObject({ processing_status: "IGNORED", error_code: "NO_REPLY", send_state: "NOT_APPLICABLE" });
      expect(logsOf(w.logs, "turn_batch")).toEqual([{ phone: expect.any(String), messages: 3, claimed: 3, requests: 2, textsMerged: 0, fragmentsJoined: 1 }]);
    });

    it.each([
      ["glucosa", "en ayunas", "GLUCOSA EN AYUNAS"],
      ["creatinina", "en orina", "CREATININA EN ORINA"]
    ])("variante: «%s» + «%s» es UN estudio (y la unión aclara la ambigüedad de «creatinina», sin preguntar opciones)", async (first, second, expected) => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, first), textEvent(id("txt"), p.phone, second));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(`Estudios anotados: ${expected}.`);
      expect(w.sends[0]!.body).not.toContain("opciones");
      expect(await itemStatuses(p.key)).toEqual(["RESOLVED"]);
    });

    it("con «listo» en el mismo lote: UNA cotización del estudio reconstruido, una sola vez y con su precio vigente", async () => {
      const p = patient();
      const w = setup({ sessions: true, interpreter: unclearInterpreter().interpreter });
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo"), textEvent(id("txt"), p.phone, "listo"));
      expect(w.sends).toHaveLength(1);
      const body = w.sends[0]!.body;
      expect(body.match(/HEMOGRAMA COMPLETO —/g)).toHaveLength(1);
      expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(body).toContain("Total de los estudios cotizados: Bs 45");
      expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "QUOTED" });
    });

    it("«SÍ» sigue siendo un comando aparte: «hemograma» + «completo» + «sí» cotiza el estudio reconstruido", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo"), textEvent(id("txt"), p.phone, "sí"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(w.sends[0]!.body).not.toContain("Estudios anotados");
    });

    it("SESIÓN ACTIVA: lo anotado antes se conserva y se suma al estudio reconstruido en la cotización final", async () => {
      const p = patient();
      const w = setup({ sessions: true, interpreter: unclearInterpreter().interpreter });
      await deliverOne(w, textEvent(id("txt"), p.phone, "glucosa"));
      expect(w.sends).toHaveLength(1);
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo"), textEvent(id("txt"), p.phone, "listo"));
      expect(w.sends).toHaveLength(2);
      const body = w.sends[1]!.body;
      expect(body).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
      expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(body).toContain("Total de los estudios cotizados: Bs 75,50");
      expect(await itemStatuses(p.key)).toEqual(["RESOLVED", "RESOLVED"]);
    });

    it("FOTOGRAFÍAS: la foto conserva su análisis y su lugar; los fragmentos contiguos se reconstruyen y la cotización junta todo", async () => {
      const p = patient();
      const w = setup({ sessions: true, verdicts: { A: { kind: "COMPLETE", ids: [3] } }, interpreter: unclearInterpreter().interpreter });
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo"), imageEvent(id("img"), p.phone, "A"), textEvent(id("txt"), p.phone, "listo"));
      expect(w.analyzed).toEqual(["A"]);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(w.sends[0]!.body).toContain("COLESTEROL TOTAL — Bs 25");
      expect(w.sends[0]!.body).toContain("Total de los estudios cotizados: Bs 70");
    });

    it("NO se unen intenciones distintas: una foto entre «hemograma» y «completo» los separa, y a «completo» se le trata como antes", async () => {
      const p = patient();
      const { asked, interpreter } = unclearInterpreter();
      const w = setup({ sessions: true, interpreter });
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), imageEvent(id("img"), p.phone, "A"), textEvent(id("txt"), p.phone, "completo"));
      expect(asked).toContain("completo");
      expect(logsOf(w.logs, "turn_batch")[0]).not.toHaveProperty("fragmentsJoined");
    });

    it("NO se unen intenciones distintas: «quiero cotizar» + «completo», «glucosa» + «gracias» y un texto médico en medio", async () => {
      const cases: Array<[string[], string]> = [
        [["quiero cotizar", "completo"], "completo"],
        [["glucosa", "gracias"], "gracias"],
        [["hemograma", "me duele mucho el pecho", "completo"], "completo"]
      ];
      for (const [texts, asksAbout] of cases) {
        const p = patient();
        const { asked, interpreter } = unclearInterpreter();
        const w = setup({ sessions: true, interpreter });
        await deliver(w, ...texts.map((body) => textEvent(id("txt"), p.phone, body)));
        expect(logsOf(w.logs, "turn_batch")[0], texts.join(" + ")).not.toHaveProperty("fragmentsJoined");
        if (asksAbout === "completo") expect(asked, texts.join(" + ")).toContain("completo");
      }
      // y lo médico sigue atendiéndose
      const p = patient();
      const w = setup({ sessions: true });
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "me duele mucho el pecho"), textEvent(id("txt"), p.phone, "completo"));
      expect(w.sends[0]!.body).toContain(DRAFT_TEXTS.medical_unavailable);
    });

    it("DEDUPLICACIÓN: el mismo lote reentregado no responde, no anota ni reinterpreta nada", async () => {
      const p = patient();
      const { asked, interpreter } = unclearInterpreter();
      const w = setup({ sessions: true, interpreter });
      const events = [textEvent(id("txt"), p.phone, "quiero cotizar"), textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo")];
      await deliver(w, ...events);
      const state = { sends: w.sends.length, asked: asked.length, runs: (await runsOf(p.key)).length, items: await itemCount(p.key) };
      expect(state).toMatchObject({ sends: 1, runs: 3, items: 1 });
      await deliver(w, ...events);
      await deliver(w, ...events);
      expect({ sends: w.sends.length, asked: asked.length, runs: (await runsOf(p.key)).length, items: await itemCount(p.key) }).toEqual(state);
    });

    it("LÍMITE DIARIO: un lote fragmentado cuenta UNA respuesta; a la sexta ya no se responde", async () => {
      const p = patient();
      const w = setup({ sessions: true, dailyCap: { max: 5, windowSeconds: 86_400 } });
      for (let i = 0; i < 5; i++) await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "completo"));
      expect(w.sends).toHaveLength(5);
      const blocked = [id("txt"), id("txt")];
      await deliver(w, textEvent(blocked[0]!, p.phone, "hemograma"), textEvent(blocked[1]!, p.phone, "completo"));
      expect(w.sends).toHaveLength(5);
      expect(byMessage(await runsOf(p.key), blocked[1]!)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "DAILY_CAP" });
    });

    it("un mensaje suelto «completo» (sin lote) se trata como siempre: no se reconstruye nada entre entregas distintas", async () => {
      const p = patient();
      const { asked, interpreter } = unclearInterpreter();
      const w = setup({ sessions: true, interpreter });
      await deliverOne(w, textEvent(id("txt"), p.phone, "hemograma"));
      await deliverOne(w, textEvent(id("txt"), p.phone, "completo"));
      expect(asked).toContain("completo");
    });
  });

  // ───────────────────────────── mensajes duplicados ─────────────────────────────

  it("DUPLICADOS: el mismo lote reentregado no responde ni analiza dos veces", async () => {
    const p = patient();
    const rec = recorder();
    const w = setup({ handlers: rec.handlers });
    const events = [textEvent(id("txt"), p.phone, "hola"), textEvent(id("txt"), p.phone, "quiero cotizar"), imageEvent(id("img"), p.phone, "A")];
    await deliver(w, ...events);
    const firstSends = w.sends.length;
    const firstAnalyses = w.analyzed.length;
    const firstRuns = (await runsOf(p.key)).length;
    expect(firstSends).toBe(1);
    await deliver(w, ...events);
    await deliver(w, ...events);
    expect(w.sends).toHaveLength(firstSends);
    expect(w.analyzed).toHaveLength(firstAnalyses);
    expect(rec.seen).toHaveLength(1);
    expect((await runsOf(p.key)).length).toBe(firstRuns);
    expect(logsOf(w.logs, "duplicate_ignored").length).toBeGreaterThanOrEqual(3);
  });

  it("DUPLICADOS: el mismo lote entregado VARIAS VECES A LA VEZ responde UNA sola vez y atiende cada mensaje una sola vez", async () => {
    // Repetido varias veces con pacientes distintos: la carrera depende de los tiempos de la base, así que una sola vez no demuestra nada.
    for (let round = 0; round < 4; round++) {
      const p = patient();
      const rec = recorder();
      const w = setup({ handlers: rec.handlers });
      const payload = batchOf(textEvent(id("txt"), p.phone, "uno"), textEvent(id("txt"), p.phone, "dos"), textEvent(id("txt"), p.phone, "tres"), imageEvent(id("img"), p.phone, "A"));
      await Promise.all([1, 2, 3].map(() => w.hook(signedPost(payload, BATCH))));
      await w.settle();
      expect(rec.seen.join("\n").split("\n").sort(), `ronda ${round}`).toEqual(["dos", "tres", "uno"]);
      expect(w.analyzed, `ronda ${round}`).toEqual(["A"]);
      expect(w.sends, `ronda ${round}`).toHaveLength(1);
      const runs = await runsOf(p.key);
      expect(runs, `ronda ${round}`).toHaveLength(4);
      expect(runs.filter((run) => run.send_state === "ACCEPTED"), `ronda ${round}`).toHaveLength(1);
      // ninguna corrida quedó abierta
      for (const run of runs) expect(["COMPLETED", "IGNORED"], `${run.kapso_message_id}`).toContain(run.processing_status);
    }
  });

  it("DUPLICADOS: un lote que mezcla un mensaje ya atendido con uno nuevo solo procesa el nuevo", async () => {
    const p = patient();
    const rec = recorder();
    const w = setup({ handlers: rec.handlers });
    const old = textEvent(id("txt"), p.phone, "viejo");
    await deliverOne(w, old);
    await deliver(w, old, textEvent(id("txt"), p.phone, "nuevo"));
    expect(rec.seen).toEqual(["viejo", "nuevo"]);
    expect(w.sends.map((s) => s.body)).toEqual(["respuesta 1", "respuesta 2"]);
  });

  // ───────────────────────────── pausa humana ─────────────────────────────

  it("PAUSA HUMANA: con el contacto pausado, un lote entero no se procesa ni se responde", async () => {
    const p = patient();
    const rec = recorder();
    const w = setup({ handlers: rec.handlers });
    await deliverOne(w, humanEvent(id("hum"), p.phone), SENT);
    await deliver(w, textEvent(id("txt"), p.phone, "hola"), textEvent(id("txt"), p.phone, "¿alguien?"), imageEvent(id("img"), p.phone, "A"));
    expect(w.sends).toEqual([]);
    expect(rec.seen).toEqual([]);
    expect(w.analyzed).toEqual([]);
    expect(await runsOf(p.key)).toEqual([]);
  });

  it("PAUSA HUMANA: si una persona escribe MIENTRAS se procesa el lote, no se envía nada (la reserva se deniega) y nada queda abierto", async () => {
    const p = patient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = false;
    const w = setup({ handlers: { text: async () => { started = true; await gate; return { body: "no debería enviarse" }; } } });
    const [photo, message] = [id("img"), id("txt")];
    expect((await w.hook(signedPost(batchOf(imageEvent(photo, p.phone, "A"), textEvent(message, p.phone, "hola")), BATCH))).status).toBe(200);
    await until(() => expect(started).toBe(true));
    expect((await w.hook(signedPost(humanEvent(id("hum"), p.phone), SENT))).status).toBe(200);
    release();
    await w.settle();
    expect(w.sends).toEqual([]);
    const runs = await runsOf(p.key);
    expect(runs).toHaveLength(2);
    expect(runs.filter((run) => run.send_state === "ACCEPTED" || run.send_state === "RESERVED")).toEqual([]);
    expect(logsOf(w.logs, "reply_withheld").length).toBeGreaterThanOrEqual(1);
  });

  // ───────────────────────────── migración 19: plusmedik_turn_fold ─────────────────────────────

  describe("plusmedik_turn_fold (da por atendido un mensaje del lote sin enviar)", () => {
    const audit = () => createSupabaseAuditRepository(rpcOptions());
    async function claimed(contactKey: string) {
      const message = id("fold");
      const claim = await audit().claim({ messageId: message }, { contactKey, turnKind: "IMAGE" });
      if (claim.kind !== "claimed") throw new Error("no se pudo reclamar");
      return { message, runId: claim.runId, lease: claim.lease };
    }
    const row = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));

    it("una corrida en proceso queda COMPLETED sin envío, no cuenta para el tope y es idempotente; un reenvío del mismo mensaje ya no la reclama", async () => {
      const p = patient();
      const turn = await claimed(p.key);
      await audit().foldTurn!(turn.runId, turn.lease);
      await audit().foldTurn!(turn.runId, turn.lease);
      expect(await row(turn.message)).toMatchObject({ processing_status: "COMPLETED", send_state: "NOT_APPLICABLE", error_code: "BATCHED", reply_state: "NOT_ATTEMPTED" });
      expect(Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_state in ('RESERVED','ACCEPTED','UNKNOWN')`))).toBe(0);
      const again = await audit().claim({ messageId: turn.message }, { contactKey: p.key, turnKind: "IMAGE" });
      expect(again.kind).toBe("duplicate");
    });

    it("con un envío ya reservado NO toca nada: nunca cancela ni habilita un envío", async () => {
      const p = patient();
      const turn = await claimed(p.key);
      expect(await audit().reserveSend(turn.runId, "conversation", turn.lease, { stale: "NONE" })).toBe("reserved");
      await audit().foldTurn!(turn.runId, turn.lease);
      expect(await row(turn.message)).toMatchObject({ processing_status: "PROCESSING", send_state: "RESERVED" });
    });

    it("con un fence o un dueño que ya no son los vigentes se rechaza (LEASE_LOST)", async () => {
      const p = patient();
      const turn = await claimed(p.key);
      await expect(audit().foldTurn!(turn.runId, { owner: turn.lease.owner, fence: turn.lease.fence + 5 })).rejects.toMatchObject({ kind: "LEASE_LOST" });
      await expect(audit().foldTurn!(turn.runId, { owner: "owner-ajeno-0001", fence: turn.lease.fence })).rejects.toMatchObject({ kind: "LEASE_LOST" });
      expect(await row(turn.message)).toMatchObject({ processing_status: "PROCESSING", send_state: "NOT_RESERVED" });
    });

    it("conserva un fallo ya registrado (error_code) y no lo pisa", async () => {
      const p = patient();
      const turn = await claimed(p.key);
      await audit().recordFailure(turn.runId, "AI_PROCESSING_FAILED", turn.lease);
      await audit().foldTurn!(turn.runId, turn.lease);
      expect(await row(turn.message)).toMatchObject({ processing_status: "FAILED", send_state: "NOT_APPLICABLE", error_code: "AI_PROCESSING_FAILED" });
    });
  });

  // ───────────────────────────── tope de 5 respuestas cada 24 h ─────────────────────────────

  it("TOPE DE 5/24 h: un lote cuenta UNA respuesta (aunque traiga 8 mensajes) y la sexta respuesta del agente al contacto no se envía", async () => {
    const p = patient();
    const other = patient();
    const rec = recorder();
    const w = setup({ handlers: rec.handlers, dailyCap: { max: 5, windowSeconds: 86_400 } });
    // 1 lote de 8 textos = 1 respuesta
    await deliver(w, ...Array.from({ length: 8 }, (_, i) => textEvent(id("txt"), p.phone, `mensaje ${i + 1}`)));
    expect(w.sends).toHaveLength(1);
    // 4 mensajes sueltos más = 5 respuestas en total
    for (let i = 0; i < 4; i++) await deliverOne(w, textEvent(id("txt"), p.phone, `suelto ${i + 1}`));
    expect(w.sends).toHaveLength(5);
    // un lote más: el tope se cumple, NO se envía nada del lote
    const blocked = [id("txt"), id("txt"), id("txt")];
    await deliver(w, ...blocked.map((message, i) => textEvent(message, p.phone, `de más ${i + 1}`)));
    expect(w.sends).toHaveLength(5);
    const runs = await runsOf(p.key);
    expect(byMessage(runs, blocked[2]!)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "DAILY_CAP" });
    // el tope es por contacto: otro paciente sigue recibiendo su respuesta
    await deliver(w, textEvent(id("txt"), other.phone, "hola"), textEvent(id("txt"), other.phone, "buenas"));
    expect(w.sends).toHaveLength(6);
    expect(w.sends[5]!.to).toBe(other.phone);
    expect(runs.filter((run) => ["ACCEPTED", "RESERVED", "UNKNOWN"].includes(run.send_state))).toHaveLength(5);
  });

  it("TOPE DE 5/24 h: un lote de varias fotos con «gracias» consume una sola respuesta del tope", async () => {
    const p = patient();
    const w = setup({ handlers: { text: async () => undefined }, dailyCap: { max: 5, windowSeconds: 86_400 } });
    await deliver(w, imageEvent(id("img"), p.phone, "A"), imageEvent(id("img"), p.phone, "B"), imageEvent(id("img"), p.phone, "C"), textEvent(id("txt"), p.phone, "gracias"));
    expect(w.sends).toHaveLength(1);
    const reserved = Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_state in ('RESERVED','ACCEPTED','UNKNOWN')`));
    expect(reserved).toBe(1);
  });
});
