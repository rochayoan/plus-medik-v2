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
import { DEFAULT_REPLY_GUARD, type ReplyGuardConfig } from "../src/reply-guard.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import { TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Sesiones de cotización de extremo a extremo: webhook real + manejador de texto real + repositorios reales + PostgreSQL real con las ONCE migraciones. Kapso, el catálogo y el
// motor de recetas (sus lecturas) son simulaciones; no se llama a ningún modelo. Todos los estudios y precios son fixtures de PRUEBA.

const bin = findPostgresBin();
if (!bin) console.warn("[quote-session-e2e] PostgreSQL no disponible: se omiten los escenarios de sesiones de cotización contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_8120";
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
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", from: phone, image: { id: tag }, kapso: { ...inbound, has_media: true } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

// Lo que el motor de recetas diría de cada foto (por etiqueta): completo, parcial o sin cotización.
type Verdict = { kind: "COMPLETE"; ids: number[] } | { kind: "PARTIAL"; ids: number[] } | { kind: "NONE" };
function analysisOf(verdict: Verdict, catalog: CatalogStudy[]): AnalysisResult {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const lines = verdict.kind === "NONE" ? [] : verdict.ids.map((n) => ({ id: uuid(n), code: null, name: byId.get(uuid(n))?.name ?? "?", priceBs: byId.get(uuid(n))?.priceBs ?? 0, basis: ["EXACT"], texts: [] }));
  const outcome = verdict.kind === "COMPLETE" ? "AUTO_COMPLETE" : verdict.kind === "PARTIAL" ? "AUTO_PARTIAL" : "HUMAN_REVIEW";
  return {
    decision: verdict.kind === "COMPLETE" ? "AUTO_SAFE" : "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome,
    publicQuote: verdict.kind === "NONE" ? undefined : { studies: lines.map((l) => ({ name: l.name, priceBs: l.priceBs })), totalBs: lines.reduce((sum, l) => sum + l.priceBs, 0), totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
    internal: { outcome, recipeComplete: verdict.kind === "COMPLETE", reviewRequired: verdict.kind !== "COMPLETE", quoted: { lines, subtotalBs: 0 }, studies: [], pending: [], recipeStops: [], document: { type: "TEXT_EXPLICIT_REQUEST", zones: [] }, advisories: [], history: [] }
  } as unknown as AnalysisResult;
}

describe.skipIf(!bin)("sesiones de cotización de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("quote_session_extremo");
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

  interface Options { sessions?: boolean; replyGuard?: ReplyGuardConfig; verdicts?: Record<string, Verdict>; ttlSeconds?: number }
  function setup(options: Options = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const world = { catalog: baseCatalog(), verdicts: { ...(options.verdicts ?? {}) } as Record<string, Verdict>, gates: {} as Record<string, Promise<void>> };
    const analyzed: string[] = [];
    const sessions = options.sessions ?? true;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })),
      loadCatalog: vi.fn(async () => structuredClone(world.catalog)),
      analyze: vi.fn(async ({ imageBase64, catalog }) => {
        const tag = /TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "?";
        analyzed.push(tag);
        await world.gates[tag];
        return analysisOf(world.verdicts[tag] ?? { kind: "COMPLETE", ids: [1] }, catalog);
      }),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: { text: createTextHandler({ log, loopProtection: options.replyGuard !== undefined }) },
        ...(options.replyGuard ? { replyGuard: options.replyGuard } : {}),
        ...(sessions ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ttlSeconds: options.ttlSeconds ?? 1800, loopProtection: options.replyGuard !== undefined, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, scheduled, world, analyzed, quote, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  const send = async (w: World, event: unknown, headers = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    await send(w, textEvent(message, phone, body));
    return message;
  };
  const photo = async (w: World, phone: string, tag: string, message = id("img")) => {
    await send(w, imageEvent(message, phone, tag));
    return message;
  };
  const last = (w: World) => w.sends.at(-1)!.body;
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const sessionsOf = async (key: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(s order by s.created_at, s.id), '[]') from public.plusmedik_quote_sessions s where contact_key = '${key}'`));
  // Un precio de COTIZACIÓN: el que muestran las opciones numeradas («1. TSH — Bs 90») sirve para elegir y no es una cotización.
  const hasPrice = (body: string) => /Bs\s?\d/.test(body.replace(/^\d+\. .+ — Bs \d+(?:,\d+)?$/gm, ""));

  it("APAGADAS (sin sesiones): una foto se cotiza al instante, como siempre, y no se toca ninguna tabla de sesiones", async () => {
    const p = patient();
    const w = setup({ sessions: false });
    await photo(w, p.phone, "A");
    expect(w.sends).toHaveLength(1);
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(await sessionsOf(p.key)).toEqual([]);
    expect(w.quote.audit).toBeDefined();
  });

  it("varias fotos y texto se juntan y se cotizan UNA vez, con «listo», sin repetidos y con los precios vigentes; antes de «listo» nadie recibe un precio", async () => {
    const p = patient();
    const w = setup({ verdicts: { A: { kind: "COMPLETE", ids: [1, 2] }, B: { kind: "COMPLETE", ids: [2, 3] } } });
    await photo(w, p.phone, "A");
    await photo(w, p.phone, "B");
    await say(w, p.phone, "y también TSH y hemograma");
    expect(w.sends.length).toBeGreaterThanOrEqual(1);
    for (const sent of w.sends) expect(hasPrice(sent.body)).toBe(false);
    const before = w.sends.length;
    const listo = await say(w, p.phone, "listo");
    expect(w.sends).toHaveLength(before + 1);
    const body = last(w);
    for (const expected of ["HEMOGRAMA COMPLETO — Bs 45", "GLUCOSA EN AYUNAS — Bs 30,50", "COLESTEROL TOTAL — Bs 25", "TSH — Bs 80", "Total de los estudios cotizados: Bs 180,50"]) expect(body).toContain(expected);
    expect(body.match(/HEMOGRAMA COMPLETO —/g)).toHaveLength(1);
    expect(body).toContain(QUOTE_TEXTS.repeated_note);
    expect(await run(listo)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
    const [session] = await sessionsOf(p.key);
    expect(session).toMatchObject({ status: "QUOTED", closed_by_run: (await run(listo)).id });
    const result = JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_results r where session_id = '${session!.id}'`));
    expect(result).toMatchObject({ total_bs: 180.5 });
    expect(result.lines.map((l: Record<string, string>) => l.name).sort()).toEqual(["COLESTEROL TOTAL", "GLUCOSA EN AYUNAS", "HEMOGRAMA COMPLETO", "TSH"]);
    expect(w.analyzed.sort()).toEqual(["A", "B"]);
  });

  it("una sola foto NO se cotiza sola: se confirma lo identificado y se espera «listo»", async () => {
    const p = patient();
    const w = setup();
    await photo(w, p.phone, "A");
    expect(w.sends).toHaveLength(1);
    expect(last(w)).toContain("Estudios identificados: HEMOGRAMA COMPLETO");
    expect(last(w)).toContain("LISTO");
    expect(hasPrice(last(w))).toBe(false);
    await say(w, p.phone, "eso es todo");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
  });

  it("la MISMA foto reenviada no se analiza dos veces ni se cobra dos veces", async () => {
    const p = patient();
    const w = setup();
    await photo(w, p.phone, "A");
    await photo(w, p.phone, "A");
    expect(w.analyzed).toEqual(["A"]);
    expect(last(w)).toContain(QUOTE_TEXTS.duplicate_image);
    await say(w, p.phone, "listo");
    expect(last(w).match(/HEMOGRAMA COMPLETO —/g)).toHaveLength(1);
  });

  it("estudios AMBIGUOS o que no existen en el catálogo: no se cotiza nada, no se inventa, y el caso queda en la cola de revisión (sin prometer una persona)", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "hemograma y creatinina");
    expect(last(w)).toContain(QUOTE_TEXTS.option_intro_others);
    expect(last(w)).toMatch(/1\. CREATININA SERICA/);
    await say(w, p.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.review);
    expect(hasPrice(last(w))).toBe(false);
    expect(last(w)).not.toMatch(/persona|equipo|asesor/i);
    const [session] = await sessionsOf(p.key);
    expect(session).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["AMBIGUOUS_STUDY"] });
    const review = JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_reviews r where session_id = '${session!.id}'`));
    expect(review).toMatchObject({ status: "PENDING", reasons: ["AMBIGUOUS_STUDY"], contact_key: p.key });
    expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${session!.id}'`)).toBe("0");

    const q = patient();
    // Lo que el catálogo no tiene ya no bloquea: se cotiza lo identificado y se dice cuál falta (nunca se inventa).
    await say(w, q.phone, "quiero cotizar hemograma y examen de la vista");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(last(w)).toContain("No encontré en nuestro catálogo: «examen de la vista»");
    expect((await sessionsOf(q.key))[0]).toMatchObject({ status: "QUOTED" });
  });

  it("un resultado PARCIAL del motor en una foto vuelve incierta toda la solicitud: no se cotiza lo seguro a medias", async () => {
    const p = patient();
    const w = setup({ verdicts: { P: { kind: "PARTIAL", ids: [1] } } });
    await photo(w, p.phone, "P");
    await say(w, p.phone, "glucosa");
    await say(w, p.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.review);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["ENGINE_PARTIAL"] });
  });

  it("una foto que el motor no puede cotizar se trata como ilegible: «listo» pide reenviarla, conserva lo demás y tras reenviar se cotiza completo", async () => {
    const p = patient();
    const w = setup({ verdicts: { BAD: { kind: "NONE" }, GOOD: { kind: "COMPLETE", ids: [3] } } });
    await photo(w, p.phone, "BAD");
    expect(last(w)).toBe(QUOTE_TEXTS.unreadable_image);
    await say(w, p.phone, "hemograma");
    await say(w, p.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.resend);
    expect(hasPrice(last(w))).toBe(false);
    await photo(w, p.phone, "GOOD");
    await say(w, p.phone, "listo");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(last(w)).toContain("COLESTEROL TOTAL — Bs 25");
    const sessions = await sessionsOf(p.key);
    expect(sessions.map((s) => s.status)).toEqual(["NEEDS_RESEND", "QUOTED"]);
  });

  it("el precio es el de LAB_TESTS al cerrar, no el de cuando se anotó el estudio; un estudio retirado en el medio manda a revisión", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "hemograma");
    w.world.catalog = w.world.catalog.map((s) => (s.id === uuid(1) ? { ...s, priceBs: 52 } : s));
    await say(w, p.phone, "listo");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 52");
    expect(last(w)).toContain("Bs 52");

    const q = patient();
    await say(w, q.phone, "tsh");
    w.world.catalog = w.world.catalog.filter((s) => s.id !== uuid(4));
    await say(w, q.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.review);
    expect((await sessionsOf(q.key))[0]).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["STUDY_UNAVAILABLE"] });

    const r = patient();
    await say(w, r.phone, "glucosa");
    w.world.catalog = w.world.catalog.map((s) => (s.id === uuid(2) ? { ...s, priceBs: 0 } : s));
    await say(w, r.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.review);
    expect((await sessionsOf(r.key))[0]).toMatchObject({ reasons: ["PRICE_INVALID"] });
  });

  it("«listo» escrito justo después de una foto que todavía se analiza ESPERA a esa foto y la incluye (no cotiza a medias)", async () => {
    const p = patient();
    const w = setup({ verdicts: { SLOW: { kind: "COMPLETE", ids: [4] } } });
    let release!: () => void;
    w.world.gates.SLOW = new Promise<void>((resolve) => (release = resolve));
    const slow = w.hook(signedPost(imageEvent(id("img"), p.phone, "SLOW"), RECEIVED));
    await vi.waitFor(() => expect(w.analyzed).toContain("SLOW"), { timeout: 20_000 });
    const typed = w.hook(signedPost(textEvent(id("txt"), p.phone, "hemograma"), RECEIVED));
    await typed;
    // el orden lo da la numeración de turnos: «listo» solo incluye lo que llegó ANTES, así que se espera a que el texto ya esté anotado y a que «listo» ya esté reclamado
    await vi.waitFor(async () => expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}' and kind = 'TEXT'`)).toBe("1"), { timeout: 60_000, interval: 25 });
    const listoId = id("txt");
    const listo = w.hook(signedPost(textEvent(listoId, p.phone, "listo"), RECEIVED));
    await vi.waitFor(async () => expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${listoId}'`)).toBe("1"), { timeout: 60_000, interval: 25 });
    await sleepMs(300);
    expect(w.sends.filter((s) => hasPrice(s.body))).toHaveLength(0);
    release();
    await slow;
    await listo;
    await w.settle();
    const quoted = w.sends.filter((s) => hasPrice(s.body));
    expect(quoted).toHaveLength(1);
    expect(quoted[0]!.body).toContain("TSH — Bs 80");
    expect(quoted[0]!.body).toContain("HEMOGRAMA COMPLETO — Bs 45");
  });

  it("idempotencia: el mismo «listo» entregado varias veces genera UNA cotización; la misma foto entregada varias veces, un solo ítem", async () => {
    const p = patient();
    const w = setup();
    const img = id("img");
    for (let i = 0; i < 3; i++) await send(w, imageEvent(img, p.phone, "A"));
    expect(w.analyzed).toEqual(["A"]);
    const listoId = id("txt");
    for (let i = 0; i < 3; i++) await send(w, textEvent(listoId, p.phone, "listo"));
    expect(w.sends.filter((s) => hasPrice(s.body))).toHaveLength(1);
    expect(await db.ok(`select count(*) from public.plusmedik_quote_items i join public.plusmedik_quote_sessions s on s.id = i.session_id where s.contact_key = '${p.key}'`)).toBe("1");
  });

  it("cancelar borra la solicitud sin cotizar; después «listo» no tiene nada que cotizar", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "hemograma y glucosa");
    await say(w, p.phone, "cancelar");
    expect(last(w)).toBe(QUOTE_TEXTS.cancelled);
    await say(w, p.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.empty);
    await say(w, p.phone, "cancelar");
    expect(last(w)).toBe(QUOTE_TEXTS.nothing_to_cancel);
    expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["CANCELLED"]);
  });

  it("una solicitud vencida NUNCA se cotiza por el paso del tiempo: «listo» tras el vencimiento no encuentra nada", async () => {
    const p = patient();
    const w = setup({ ttlSeconds: 60 });
    await say(w, p.phone, "hemograma");
    await db.ok(`set session_replication_role = replica; update public.plusmedik_quote_sessions set expires_at = now() - interval '1 second' where contact_key = '${p.key}';`);
    const before = w.sends.length;
    await say(w, p.phone, "listo");
    expect(w.sends).toHaveLength(before + 1);
    expect(last(w)).toBe(QUOTE_TEXTS.empty);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "EXPIRED" });
  });

  it("mensajes médicos o de información en medio de la solicitud los atiende el manejador de siempre y la sesión sigue intacta", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "hemograma");
    await say(w, p.phone, "tengo mucho dolor de cabeza");
    expect(last(w)).toBe(DRAFT_TEXTS.medical_unavailable);
    await say(w, p.phone, "¿a qué hora abren?");
    expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
    await say(w, p.phone, "hola");
    expect(last(w)).toBe(DRAFT_TEXTS.greeting);
    await say(w, p.phone, "listo");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
  });

  it("«listo» sin nada anotado, o escrito dentro de otra frase, no cotiza ni cierra nada", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "listo");
    expect(last(w)).toBe(QUOTE_TEXTS.empty);
    await say(w, p.phone, "hemograma");
    await say(w, p.phone, "aún no estoy listo");
    expect(hasPrice(last(w))).toBe(false);
    expect((await sessionsOf(p.key)).filter((s) => s.status === "OPEN")).toHaveLength(1);
  });

  it("pausa humana: un contacto pausado no recibe confirmaciones ni cotización, y no se agrega nada a su sesión", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "hemograma");
    const before = w.sends.length;
    await send(w, humanEvent(id("human"), p.phone), SENT);
    await say(w, p.phone, "glucosa");
    await say(w, p.phone, "listo");
    await photo(w, p.phone, "A");
    expect(w.sends).toHaveLength(before);
    expect(w.analyzed).toEqual([]);
    expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`)).toBe("1");
  });

  describe("G5.9 · cotización por texto: lista clara, acumulación, aclaraciones y continuar la conversación", () => {
    const resultOf = async (sessionId: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_results r where session_id = '${sessionId}'`));
    const itemStatuses = async (key: string): Promise<string[]> => JSON.parse(await db.ok(`select coalesce(json_agg(i.status order by i.seq), '[]') from public.plusmedik_quote_items i where contact_key = '${key}'`));

    it("una lista CLARA con pedido de cotizar se cotiza al instante, sin «listo»: una sola respuesta, la sesión queda cotizada y el resultado guardado", async () => {
      const p = patient();
      const w = setup();
      const message = await say(w, p.phone, "Hola, quiero cotizar hemograma, glucosa y tsh");
      expect(w.sends).toHaveLength(1);
      for (const expected of ["HEMOGRAMA COMPLETO — Bs 45", "GLUCOSA EN AYUNAS — Bs 30,50", "TSH — Bs 80", "Total de los estudios cotizados: Bs 155,50"]) expect(last(w)).toContain(expected);
      expect(last(w)).not.toContain("LISTO");
      expect(await run(message)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
      const [session] = await sessionsOf(p.key);
      expect(session).toMatchObject({ status: "QUOTED", closed_by_run: (await run(message)).id });
      expect(await resultOf(session!.id)).toMatchObject({ total_bs: 155.5 });
    });

    it("reconoce abreviaturas y sinónimos, pero solo contra lab_tests: «BH» y «glicemia» sí; lo que el catálogo no tiene, no se cotiza ni se inventa", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "cotiza BH y glucemia");
      expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(last(w)).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
      const q = patient();
      await say(w, q.phone, "cotiza hemograma y VSG");
      expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(last(w)).toContain("No encontré en nuestro catálogo: «VSG»");
      expect(last(w)).not.toContain("ERITROSEDIMENTACION");
      expect((await sessionsOf(q.key))[0]).toMatchObject({ status: "QUOTED" });
    });

    it("una lista sin pedido de cotizar se acumula y se pregunta si eso es todo; «sí» cotiza, y un «sí» posterior ya no tiene solicitud que cerrar", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "hemograma y glucosa");
      expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.");
      expect(last(w)).toContain(QUOTE_TEXTS.confirm_done);
      expect(hasPrice(last(w))).toBe(false);
      await say(w, p.phone, "sí");
      expect(last(w)).toContain("Total de los estudios cotizados: Bs 75,50");
      const sent = w.sends.length;
      await say(w, p.phone, "sí");
      expect(w.sends).toHaveLength(sent + 1);
      expect(last(w)).toBe(DRAFT_TEXTS.fallback);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
    });

    it("estudios en varios mensajes se acumulan (también con fotos) y «¿cuánto es en total?» los cotiza juntos, una sola vez", async () => {
      const p = patient();
      const w = setup({ verdicts: { A: { kind: "COMPLETE", ids: [3] } } });
      await say(w, p.phone, "hemograma");
      await say(w, p.phone, "y también glucosa");
      expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.");
      await photo(w, p.phone, "A");
      await say(w, p.phone, "¿cuánto es en total?");
      expect(w.sends.filter((s) => hasPrice(s.body))).toHaveLength(1);
      for (const expected of ["HEMOGRAMA COMPLETO — Bs 45", "GLUCOSA EN AYUNAS — Bs 30,50", "COLESTEROL TOTAL — Bs 25", "Total de los estudios cotizados: Bs 100,50"]) expect(last(w)).toContain(expected);
      expect(w.analyzed).toEqual(["A"]);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
    });

    it("el pedido de cotizar escrito junto a una foto cotiza la foto y el texto juntos; si la foto aún se analiza, espera", async () => {
      const p = patient();
      const w = setup({ verdicts: { A: { kind: "COMPLETE", ids: [1, 2] } } });
      await photo(w, p.phone, "A");
      await say(w, p.phone, "cotiza también la tsh");
      expect(last(w)).toContain("Total de los estudios cotizados: Bs 155,50");
      expect(w.analyzed).toEqual(["A"]);
    });

    it("un nombre ambiguo se PREGUNTA con las opciones del catálogo; el número elegido lo aclara y se cotiza solo esa opción", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "quiero cotizar hemograma y creatinina");
      expect(hasPrice(last(w))).toBe(false);
      expect(last(w)).not.toContain("Estudios anotados");
      expect(last(w)).toMatch(/1\. CREATININA SERICA( — Bs [\d,]+)?\n2\. CREATININA EN ORINA/);
      await say(w, p.phone, "2");
      expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO, CREATININA EN ORINA.");
      expect(last(w)).toContain(QUOTE_TEXTS.confirm_done);
      await say(w, p.phone, "sí");
      expect(last(w)).toContain("CREATININA EN ORINA — Bs 22");
      expect(last(w)).not.toContain("CREATININA SERICA");
      const [session] = await sessionsOf(p.key);
      expect(session).toMatchObject({ status: "QUOTED" });
      expect((await resultOf(session!.id)).lines.map((l: Record<string, string>) => l.name).sort()).toEqual(["CREATININA EN ORINA", "HEMOGRAMA COMPLETO"]);
      expect(await itemStatuses(p.key)).toEqual(["AMBIGUOUS", "RESOLVED"]);
    });

    it("también se aclara escribiendo el nombre exacto; una opción que no existe o una respuesta sin duda abierta no inventan nada", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "hemograma, creatinina");
      await say(w, p.phone, "7");
      expect(last(w)).toBe(QUOTE_TEXTS.choose_invalid);
      await say(w, p.phone, "creatinina serica");
      expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO, CREATININA SERICA.");
      await say(w, p.phone, "cotiza");
      expect(last(w)).toContain("CREATININA SERICA — Bs 20");
      expect(last(w)).not.toContain("CREATININA EN ORINA");
      await say(w, p.phone, "2");
      expect(last(w)).toBe(DRAFT_TEXTS.fallback);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
    });

    it("con una duda sin aclarar, «sí» o pedir el precio vuelven a preguntar (no cotizan ni derivan); «listo» sí deja la solicitud en revisión", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "hemograma y creatinina");
      await say(w, p.phone, "sí");
      expect(last(w)).toMatch(/1\. CREATININA SERICA( — Bs [\d,]+)?\n2\. CREATININA EN ORINA/);
      await say(w, p.phone, "¿cuánto cuesta todo?");
      expect(hasPrice(last(w))).toBe(false);
      expect(last(w)).toContain(QUOTE_TEXTS.ask_option_outro);
      expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
      await say(w, p.phone, "listo");
      expect(last(w)).toBe(QUOTE_TEXTS.review);
      expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["AMBIGUOUS_STUDY"] });
    });

    it("lo que el catálogo no tiene se dice y se cotiza el resto; nunca se promete una persona", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "cotiza hemograma y examen de la vista");
      expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
      expect(last(w)).toContain("No encontré en nuestro catálogo: «examen de la vista»");
      expect(last(w)).not.toMatch(/persona|equipo|asesor/i);
      expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "QUOTED" });
    });

    it("después de cotizar la conversación sigue: preguntas, saludos y un estudio nuevo abren otra solicitud que no arrastra la anterior", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "cotiza hemograma");
      expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
      await say(w, p.phone, "gracias");
      expect(hasPrice(last(w))).toBe(false);
      await say(w, p.phone, "¿a qué hora abren?");
      expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
      await say(w, p.phone, "y también tsh");
      expect(last(w)).toContain("Estudios anotados: TSH.");
      expect(last(w)).not.toContain("HEMOGRAMA");
      await say(w, p.phone, "sí");
      expect(last(w)).toContain("TSH — Bs 80");
      expect(last(w)).toContain("Total de los estudios cotizados: Bs 80");
      expect(last(w)).not.toContain("HEMOGRAMA");
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED", "QUOTED"]);
    });

    it("una pregunta general que nombra un estudio no abre ninguna solicitud: la atiende el manejador; preparación, plazos y personas siguen su camino", async () => {
      const p = patient();
      const w = setup();
      for (const text of ["¿qué es el hemograma?", "¿para qué sirve la glucosa?", "¿necesito ayuno para el hemograma?", "¿cuánto demora el resultado de la glucosa?", "quiero hablar con una persona"]) {
        const before = w.sends.length;
        await say(w, p.phone, text);
        // Cuánto tarda un resultado (sin hablar de uno propio) es información para hacerse el estudio: se atiende como el resto (decisión del dueño, 11-nov).
        expect(w.sends).toHaveLength(before + 1);
        expect(hasPrice(last(w))).toBe(false);
      }
      expect(await sessionsOf(p.key)).toEqual([]);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`)).toBe("0");
    });

    it("idempotencia: el mismo mensaje que pide cotizar entregado varias veces genera UNA cotización y un solo ítem", async () => {
      const p = patient();
      const w = setup();
      const messageId = id("txt");
      for (let i = 0; i < 3; i++) await send(w, textEvent(messageId, p.phone, "cotiza hemograma y glucosa"));
      expect(w.sends.filter((s) => hasPrice(s.body))).toHaveLength(1);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`)).toBe("1");
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
    });

    it("el precio es el de lab_tests en el instante de cotizar, y un estudio retirado entre tanto manda a revisión sin precio", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "hemograma");
      w.world.catalog = w.world.catalog.map((s) => (s.id === uuid(1) ? { ...s, priceBs: 52 } : s));
      await say(w, p.phone, "sí");
      expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 52");
      const q = patient();
      await say(w, q.phone, "tsh");
      w.world.catalog = w.world.catalog.filter((s) => s.id !== uuid(4));
      await say(w, q.phone, "sí");
      expect(last(w)).toBe(QUOTE_TEXTS.review);
      expect((await sessionsOf(q.key))[0]).toMatchObject({ status: "NEEDS_REVIEW", reasons: ["STUDY_UNAVAILABLE"] });
    });

    it("con la guarda antibucles activa, las preguntas y confirmaciones salen (firmas válidas) y las respuestas repetidas se limitan sin romper la cotización", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
      await say(w, p.phone, "hemograma y creatinina");
      expect(last(w)).toContain(QUOTE_TEXTS.ask_option_outro);
      await say(w, p.phone, "1");
      expect(last(w)).toContain(QUOTE_TEXTS.confirm_done);
      await say(w, p.phone, "sí");
      expect(last(w)).toContain("CREATININA SERICA — Bs 20");
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_blocked_at is not null`)).toBe("0");
    });

    it("pausa humana: un contacto pausado no recibe preguntas ni cotización por texto", async () => {
      const p = patient();
      const w = setup();
      await send(w, humanEvent(id("human"), p.phone), SENT);
      const before = w.sends.length;
      await say(w, p.phone, "cotiza hemograma");
      await say(w, p.phone, "sí");
      expect(w.sends).toHaveLength(before);
      expect(await sessionsOf(p.key)).toEqual([]);
    });

    it("privacidad: lo que el paciente escribe en estos mensajes no llega ni a los registros ni a las tablas", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, `cotiza hemograma y creatinina ${SENTINEL}`);
      await say(w, p.phone, "1");
      await say(w, p.phone, "sí");
      const tables = await db.ok(`select (select coalesce(json_agg(s), '[]') from public.plusmedik_quote_sessions s)::text || (select coalesce(json_agg(i), '[]') from public.plusmedik_quote_items i)::text || (select coalesce(json_agg(r), '[]') from public.plusmedik_quote_results r)::text`);
      for (const text of [JSON.stringify(w.logs), tables, JSON.stringify(w.sends.map((s) => s.body))]) {
        expect(text).not.toContain(SENTINEL);
        expect(text).not.toContain(p.phone);
      }
    });
  });

  describe("protección antibucles", () => {
    it("autorrespuestas y ecos de nuestros mensajes no entran a la sesión, ni la cierran, ni reciben respuesta", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
      await say(w, p.phone, "hemograma");
      const before = w.sends.length;
      await say(w, p.phone, "Respuesta automática: gracias por escribirnos. Por favor no responda a este mensaje.");
      await say(w, p.phone, last(w));
      await say(w, p.phone, QUOTE_TEXTS.more_hint);
      expect(w.sends).toHaveLength(before);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`)).toBe("1");
      expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
    });

    it("las confirmaciones cuentan para el tope y se silencian al llegar a él, pero lo anotado SÍ queda y la cotización (nunca limitada) sale completa", async () => {
      const p = patient();
      const cap: ReplyGuardConfig = { rules: [{ windowSeconds: 600, max: 2 }], burst: { windowSeconds: 60, max: 1000 }, repeat: { windowSeconds: 900, max: 1000 }, cooldownSeconds: 600 };
      const w = setup({ replyGuard: cap });
      for (const text of ["hemograma", "glucosa", "colesterol", "tsh"]) await say(w, p.phone, text);
      expect(w.sends).toHaveLength(2);
      await say(w, p.phone, "listo");
      expect(w.sends).toHaveLength(3);
      for (const expected of ["HEMOGRAMA COMPLETO", "GLUCOSA EN AYUNAS", "COLESTEROL TOTAL", "TSH"]) expect(last(w)).toContain(expected);
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_block_reason = 'RATE_LIMITED'`)).toBe("2");
    });

    it("varias fotos seguidas no disparan la detección de repetición: cada confirmación lleva su propia firma", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD, verdicts: { A: { kind: "COMPLETE", ids: [1] }, B: { kind: "COMPLETE", ids: [2] }, C: { kind: "COMPLETE", ids: [3] }, D: { kind: "COMPLETE", ids: [4] } } });
      for (const tag of ["A", "B", "C", "D"]) await photo(w, p.phone, tag);
      expect(w.sends).toHaveLength(4);
      expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_events where contact_key = '${p.key}'`)).toBe("0");
    });
  });

  describe("falla cerrado", () => {
    it("sin la migración 11 (funciones ausentes) o con la base caída, una foto o un estudio escrito NO se anotan como si nada: aviso técnico, nunca una cotización", async () => {
      const p = patient();
      const w = setup();
      network.downFor.add("plusmedik_quote_item_begin");
      try {
        await photo(w, p.phone, "A");
        expect(last(w)).toBe(TECHNICAL_ISSUE_MESSAGE);
        await say(w, p.phone, "hemograma");
        expect(last(w)).toBe(TECHNICAL_ISSUE_MESSAGE);
      } finally {
        network.downFor.delete("plusmedik_quote_item_begin");
      }
      expect(w.sends.every((s) => !hasPrice(s.body))).toBe(true);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`)).toBe("0");
      expect((await run((await db.ok(`select kapso_message_id from public.plusmedik_audit_runs where contact_key = '${p.key}' order by created_at limit 1`)))).processing_status).toBe("FAILED");
    });

    it("si cerrar falla (base caída al cotizar) no se cotiza: aviso técnico, y al reintentar «listo» la sesión sigue abierta y se cotiza", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "hemograma");
      network.downFor.add("plusmedik_quote_session_close");
      try {
        await say(w, p.phone, "listo");
      } finally {
        network.downFor.delete("plusmedik_quote_session_close");
      }
      expect(last(w)).toBe(TECHNICAL_ISSUE_MESSAGE);
      expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
      await say(w, p.phone, "listo");
      expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    });

    it("si falla el análisis de una foto, queda pendiente de revisión sin declararla ilegible: «listo» no cotiza sin ella", async () => {
      const p = patient();
      const w = setup();
      w.quote.analyze = vi.fn(async () => { throw new Error(`modelo caído ${SENTINEL}`); });
      await photo(w, p.phone, "A");
      expect(last(w)).toBe(TECHNICAL_ISSUE_MESSAGE);
      await say(w, p.phone, "hemograma");
      await say(w, p.phone, "listo");
      expect(last(w)).toBe(QUOTE_TEXTS.review);
    });
  });

  it("privacidad: ni los registros ni las tablas de sesiones contienen texto del paciente ni teléfonos", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, `hemograma y ${SENTINEL}`);
    await say(w, p.phone, `quiero cotizar ${SENTINEL}`);
    await photo(w, p.phone, "A");
    await say(w, p.phone, "listo");
    const tables = await db.ok(`select (select coalesce(json_agg(s), '[]') from public.plusmedik_quote_sessions s)::text || (select coalesce(json_agg(i), '[]') from public.plusmedik_quote_items i)::text || (select coalesce(json_agg(r), '[]') from public.plusmedik_quote_results r)::text || (select coalesce(json_agg(v), '[]') from public.plusmedik_quote_reviews v)::text`);
    for (const text of [JSON.stringify(w.logs), tables, JSON.stringify(w.sends.map((s) => s.body))]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(p.phone);
    }
    expect(logsOf(w.logs, "quote_session").length).toBeGreaterThan(0);
  });
});

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
