import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AudioPipeline } from "../src/audio/service.js";
import { AudioFailure } from "../src/audio/types.js";
import { AUDIO_TEXTS } from "../src/audio-turns.js";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { TurnHandlers } from "../src/turns.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import type { MediaFetcher } from "../src/audio/media.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { buildOggOpus } from "./support/ogg-opus.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Audios (Fase 5) de extremo a extremo: el webhook REAL + los turnos REALES + los repositorios REALES + PostgreSQL REAL con TODAS las migraciones. Un audio se transcribe con código dentro del mismo
// procesamiento del turno y sigue el flujo como un mensaje más (sin cola, sin cron, sin tablas nuevas). Solo se simulan Kapso (envíos y descarga del medio), OpenAI (la transcripción), el catálogo y el motor de
// recetas. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[audio-e2e] PostgreSQL no disponible: se omiten los escenarios de audios contra la base real.");
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
  study(4, "TSH", ["tsh"], 80)
];

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: nowSeconds(), type: "image", from: phone, image: { id: tag }, kapso: { ...inbound, has_media: true, media_url: `https://example.test/${tag}.jpg` } }, conversation: conversation(phone), phone_number_id: LAB });
// Lo que Kapso entrega para una nota de voz: el enlace propio en kapso.media_url (los de audio.link/audio.url son de Meta y NO se usan) y el id del audio.
const audioEvent = (id: string, phone: string, tag: string, over: { url?: string | null; mediaId?: string | null; kapso?: Record<string, unknown> } = {}) => ({
  message: {
    id, timestamp: nowSeconds(), type: "audio", from: phone,
    audio: { ...(over.mediaId === null ? {} : { id: over.mediaId ?? `media-${tag}` }), voice: true, mime_type: "audio/ogg; codecs=opus", link: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${tag}`, url: `https://mmg.whatsapp.net/${tag}` },
    kapso: { ...inbound, has_media: true, ...(over.url === null ? {} : { media_url: over.url ?? `https://media.kapso.ai/${tag}.ogg` }), ...(over.kapso ?? {}) }
  },
  conversation: conversation(phone), phone_number_id: LAB
});
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const batchOf = (...events: unknown[]) => ({ type: "whatsapp.message.received", batch: true, data: events });
const signedPost = (payload: unknown, headers: Record<string, string> = {}, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", secret).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const BATCH = { ...RECEIVED, "x-webhook-batch": "true" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

// Bytes de un audio simulado: una nota de voz OGG que lleva su etiqueta (así el transcriptor falso sabe de cuál se trata).
const oggBytes = (tag: string): Uint8Array<ArrayBuffer> => buildOggOpus({ comment: `TAG:${tag}:` });
const tagOf = (bytes: Uint8Array): string => /TAG:([^:]+):/.exec(Buffer.from(bytes).toString("latin1"))?.[1] ?? "?";

function analysisOf(ids: number[], catalog: CatalogStudy[]): AnalysisResult {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const lines = ids.map((n) => ({ id: uuid(n), code: null, name: byId.get(uuid(n))?.name ?? "?", priceBs: byId.get(uuid(n))?.priceBs ?? 0, basis: ["EXACT"], texts: [] }));
  return {
    decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE",
    publicQuote: { studies: lines.map((l) => ({ name: l.name, priceBs: l.priceBs })), totalBs: lines.reduce((sum, l) => sum + l.priceBs, 0), totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
    internal: { outcome: "AUTO_COMPLETE", recipeComplete: true, reviewRequired: false, quoted: { lines, subtotalBs: 0 }, studies: [], pending: [], recipeStops: [], document: { type: "TEXT_EXPLICIT_REQUEST", zones: [] }, advisories: [] }
  } as unknown as AnalysisResult;
}

type Spoken = string | AudioFailure | Error | (() => Promise<string>);

describe.skipIf(!bin)("audios (transcripción dentro del flujo del mensaje) de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("audios_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
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
    audio?: boolean;
    sessions?: boolean;
    engine?: "on" | "shadow";
    handlers?: TurnHandlers;
    dailyCap?: { max: number; windowSeconds: number };
    maxPerBatch?: number;
    attempts?: number;
    allowedPhones?: string;
  }

  function setup(options: Options = {}) {
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const world = {
      catalog: baseCatalog(),
      // lo que dice cada nota de voz (por etiqueta)
      spoken: {} as Record<string, Spoken>,
      // lo que sirve el medio de cada etiqueta (por defecto un OGG válido)
      media: {} as Record<string, { status?: number; bytes?: Uint8Array<ArrayBuffer> }>,
      // lo que devuelve el SDK por id de medio
      sdk: {} as Record<string, Uint8Array<ArrayBuffer>>,
      photos: {} as Record<string, number[]>,
      gate: undefined as Promise<void> | undefined,
      transcribed: [] as string[],
      downloaded: [] as string[],
      sdkCalls: [] as string[]
    };
    const fetcher: MediaFetcher = {
      async rawFetch(url) {
        const tag = /\/([^/]+)\.ogg/.exec(url)?.[1] ?? "?";
        world.downloaded.push(tag);
        const planned = world.media[tag];
        if (planned?.status && planned.status !== 200) return new Response("no", { status: planned.status });
        return new Response(planned?.bytes ?? oggBytes(tag), { status: 200 });
      },
      async authedFetch() {
        throw new Error("no debería usarse la credencial de Kapso aquí");
      },
      async sdkDownload(mediaId) {
        world.sdkCalls.push(mediaId);
        const bytes = world.sdk[mediaId];
        if (!bytes) throw new Error("medio no disponible");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
    };
    const transcriber = vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
      const tag = tagOf(bytes);
      world.transcribed.push(tag);
      if (world.gate) await world.gate;
      const said = world.spoken[tag];
      if (said === undefined) throw new AudioFailure("UNINTELLIGIBLE");
      if (typeof said === "function") return said();
      if (said instanceof Error) throw said;
      return said;
    });
    const audio = new AudioPipeline({
      transcriber, fetcher, log,
      sleep: async () => undefined, ...(options.maxPerBatch ? { maxPerBatch: options.maxPerBatch } : {}), ...(options.attempts ? { attempts: options.attempts } : {})
    });
    const sessions = options.sessions ?? true;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })),
      loadCatalog: vi.fn(async () => structuredClone(world.catalog)),
      analyze: vi.fn(async ({ imageBase64, catalog }) => {
        const tag = /TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "?";
        return analysisOf(world.photos[tag] ?? [3], catalog);
      }),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: options.handlers ?? { text: createTextHandler({ log }) },
        ...(options.dailyCap ? { dailyCap: options.dailyCap } : {}),
        ...(options.engine ? { batchEngine: { mode: options.engine } } : {}),
        ...(options.audio === false ? {} : { audio }),
        ...(sessions ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ttlSeconds: 1800, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: options.allowedPhones, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, network, world, transcriber, audio, quote, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;

  const logsOf = (w: World, name: string) => w.logs.filter(([event]) => event === name).map(([, data]) => data);
  const deliver = async (w: World, ...events: unknown[]) => {
    expect((await w.hook(signedPost(batchOf(...events), BATCH))).status).toBe(200);
    await w.settle();
  };
  const deliverOne = async (w: World, event: unknown, headers: Record<string, string> = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const runsOf = async (key: string): Promise<Array<Record<string, any>>> =>
    JSON.parse(await db.ok(`select coalesce(json_agg(x order by x.seq), '[]') from (select t.seq, t.turn_kind, r.kapso_message_id, r.send_state, r.send_kind, r.processing_status, r.error_code, r.send_block_reason from public.plusmedik_audit_runs r join public.plusmedik_turns t on t.run_id = r.id where r.contact_key = '${key}') x`));
  const sessionsOf = async (key: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(s order by s.created_at, s.id), '[]') from public.plusmedik_quote_sessions s where contact_key = '${key}'`));
  const itemStatuses = async (key: string): Promise<string[]> => JSON.parse(await db.ok(`select coalesce(json_agg(status order by seq), '[]') from public.plusmedik_quote_items where contact_key = '${key}'`));
  const openRuns = async (key: string): Promise<number> => Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${key}' and processing_status in ('PROCESSING','ANALYZED')`));
  // Un precio de COTIZACIÓN: el que muestran las opciones numeradas («1. TSH — Bs 90») sirve para elegir y no es una cotización.
  const hasPrice = (body: string) => /Bs\s?\d/.test(body.replace(/^\d+\. .+ — Bs \d+(?:,\d+)?$/gm, ""));
  const callsTo = (w: World, name: string) => w.network.calls.filter((call) => call === name).length;
  const until = (condition: () => void) => vi.waitFor(condition, { timeout: 30_000, interval: 20 });

  // ───────────────────────────── firma y apagado por defecto ─────────────────────────────

  describe("firma y apagado por defecto", () => {
    it("FIRMA: se verifica sobre el cuerpo ORIGINAL antes de procesar nada; con firma inválida o cuerpo alterado se responde 401 y no se descarga, transcribe ni responde nada", async () => {
      const p = patient();
      const w = setup();
      const event = audioEvent(id("aud"), p.phone, "A");
      w.world.spoken.A = "quiero cotizar hemograma";
      expect((await w.hook(signedPost(batchOf(event), BATCH, "otro-secreto"))).status).toBe(401);
      // firma correcta de OTRO cuerpo (el cuerpo fue alterado en tránsito)
      const original = JSON.stringify(batchOf(event));
      const forged = new Request("https://example.test/api/kapso/webhook", { method: "POST", body: original.replace("hemograma", "x").replace("wamid", "wamiD"), headers: { ...BATCH, "x-webhook-signature": createHmac("sha256", SECRET).update(original).digest("hex") } });
      expect((await w.hook(forged)).status).toBe(401);
      expect((await w.hook(new Request("https://example.test/api/kapso/webhook", { method: "POST", body: original, headers: BATCH }))).status).toBe(401);
      await w.settle();
      expect(w.sends).toEqual([]);
      expect(w.world.downloaded).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
      expect(await runsOf(p.key)).toEqual([]);
    });

    it("APAGADO (sin audio en la configuración): un audio se ignora como hasta ahora — no se descarga, no se transcribe, no se responde ni se reclama", async () => {
      const p = patient();
      const w = setup({ audio: false });
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(w.world.downloaded).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
      expect(await runsOf(p.key)).toEqual([]);
      // y un lote con texto + audio responde SOLO al texto, igual que antes
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), audioEvent(id("aud"), p.phone, "B"));
      expect(w.sends.length).toBeLessThanOrEqual(1);
      expect(w.transcriber).not.toHaveBeenCalled();
    });

    it("solo audios ENTRANTES: el audio saliente (del propio bot) no se descarga ni se procesa", async () => {
      const p = patient();
      const w = setup();
      const outbound = audioEvent(id("aud"), p.phone, "A", { kapso: { direction: "outbound", status: "sent", origin: "cloud_api" } });
      await deliver(w, outbound);
      expect(w.sends).toEqual([]);
      expect(w.world.downloaded).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
    });

    it("el webhook responde 200 de inmediato (igual que con un texto o una foto) y el agente NO responde mientras el audio no esté transcrito: con la transcripción retenida no hay respuesta, y al completarse sale UNA", async () => {
      const p = patient();
      const w = setup();
      let release!: () => void;
      w.world.gate = new Promise<void>((resolve) => (release = resolve));
      w.world.spoken.A = "quiero cotizar hemograma y glucosa";
      const response = await w.hook(signedPost(batchOf(audioEvent(id("aud"), p.phone, "A")), BATCH));
      expect(response.status).toBe(200);
      await until(() => expect(w.transcriber).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(w.sends).toEqual([]);
      release();
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
      expect(hasPrice(w.sends[0]!.body)).toBe(true);
    });

    it("NO usa cola ni tablas nuevas: ni una sola llamada a funciones plusmedik_audio_* y ninguna tabla de audios en la base", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = "quiero cotizar hemograma";
      await deliver(w, textEvent(id("txt"), p.phone, "hola"), audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toHaveLength(1);
      expect(w.network.calls.filter((name) => /audio/.test(name))).toEqual([]);
      expect(await db.ok(`select count(*) from information_schema.tables where table_name like '%audio%'`)).toBe("0");
    });

    it("un envío sin audios no descarga ni transcribe nada (el mensaje de texto de siempre no cambia)", async () => {
      const p = patient();
      const w = setup();
      await deliver(w, textEvent(id("txt"), p.phone, "hemograma"), textEvent(id("txt"), p.phone, "glucosa"));
      expect(w.world.downloaded).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────── transcripción dentro del lote ─────────────────────────────

  describe("integración con textos y fotografías del mismo lote (orden y una sola respuesta)", () => {
    it("UN AUDIO: la transcripción entra como un texto más del paciente — cotización con estudios y precios de Supabase; el turno se reclama como texto", async () => {
      const p = patient();
      const w = setup();
      w.world.catalog = baseCatalog().map((s) => (s.id === uuid(1) ? { ...s, priceBs: 99 } : s));
      w.world.spoken.A = "Quiero cotizar hemograma y glucosa";
      const messageId = id("aud");
      await deliver(w, audioEvent(messageId, p.phone, "A"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).toMatch(/99/);
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
      const runs = await runsOf(p.key);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kapso_message_id: messageId, turn_kind: "TEXT", send_state: "ACCEPTED", send_kind: "quoted" });
      expect(w.world.downloaded).toEqual(["A"]);
    });

    it("LOTE MIXTO (texto + audio + foto): el pedido se entiende en el orden en que se escribió y sale UNA sola cotización con todo — con el motor de lotes encendido", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      w.world.spoken.A = "hemograma y glucosa";
      w.world.photos.P = [3];
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), audioEvent(id("aud"), p.phone, "A"), imageEvent(id("img"), p.phone, "P"));
      expect(w.sends).toHaveLength(1);
      for (const name of ["HEMOGRAMA COMPLETO", "GLUCOSA EN AYUNAS", "COLESTEROL TOTAL"]) expect(w.sends[0]!.body).toContain(name);
      expect(hasPrice(w.sends[0]!.body)).toBe(true);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
      const runs = await runsOf(p.key);
      expect(runs).toHaveLength(3);
      expect(runs.filter((run) => run.send_state === "ACCEPTED")).toHaveLength(1);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("LOTE MIXTO con la ruta de siempre (motor apagado): UNA sola respuesta y la transcripción queda en la solicitud junto con el texto y la foto, en su orden; nada queda abierto", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = "hemograma y glucosa";
      w.world.photos.P = [3];
      await deliver(w, textEvent(id("txt"), p.phone, "Quiero cotizar"), audioEvent(id("aud"), p.phone, "A"), imageEvent(id("img"), p.phone, "P"));
      expect(w.sends).toHaveLength(1);
      // lo que dijo el audio quedó anotado en la solicitud (la ruta de siempre resume lo anotado por la foto; con el motor encendido sale la cotización completa)
      const noted = JSON.parse(await db.ok(`select coalesce(json_agg(distinct s), '[]') from public.plusmedik_quote_items i, unnest(i.study_ids) s where i.contact_key = '${p.key}'`)) as string[];
      expect(noted.sort()).toEqual([uuid(1), uuid(2), uuid(3)]);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["OPEN"]);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("EL ORDEN SE RESPETA: «listo» DESPUÉS del audio cierra y cotiza lo que dijo; «listo» ANTES del audio no cierra lo que se dijo después", async () => {
      const after = patient();
      const wAfter = setup({ engine: "on" });
      wAfter.world.spoken.A = "hemograma";
      await deliver(wAfter, audioEvent(id("aud"), after.phone, "A"), textEvent(id("txt"), after.phone, "listo"));
      expect(wAfter.sends).toHaveLength(1);
      expect(wAfter.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(hasPrice(wAfter.sends[0]!.body)).toBe(true);
      expect((await sessionsOf(after.key)).map((s) => s.status)).toEqual(["QUOTED"]);

      const before = patient();
      const wBefore = setup({ engine: "on" });
      wBefore.world.spoken.A = "hemograma";
      await deliver(wBefore, textEvent(id("txt"), before.phone, "listo"), audioEvent(id("aud"), before.phone, "A"));
      expect(wBefore.sends).toHaveLength(1);
      expect(hasPrice(wBefore.sends[0]!.body)).toBe(false);
      expect(wBefore.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect((await sessionsOf(before.key)).map((s) => s.status)).toEqual(["OPEN"]);
    });

    it("el manejador de texto recibe UNA sola vez el texto y la transcripción JUNTOS, en orden, y solo DESPUÉS de transcribir (no responde antes de completar los audios)", async () => {
      const p = patient();
      const seen: string[] = [];
      const w = setup({ sessions: false, handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "respuesta única" }; } } });
      let release!: () => void;
      w.world.gate = new Promise<void>((resolve) => (release = resolve));
      w.world.spoken.A = "necesito saber el horario";
      const response = await w.hook(signedPost(batchOf(textEvent(id("txt"), p.phone, "Hola buenas"), audioEvent(id("aud"), p.phone, "A")), BATCH));
      expect(response.status).toBe(200);
      await until(() => expect(w.transcriber).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(seen).toEqual([]);
      expect(w.sends).toEqual([]);
      release();
      await w.settle();
      expect(seen).toEqual(["Hola buenas\nnecesito saber el horario"]);
      expect(w.sends).toEqual([{ to: p.phone, body: "respuesta única" }]);
    });

    it("varios audios del mismo lote se transcriben, cada uno una vez, y se integran en el orden en que llegaron", async () => {
      const p = patient();
      const seen: string[] = [];
      const w = setup({ sessions: false, handlers: { text: async (turn) => { seen.push(turn.text!); return { body: "ok" }; } } });
      w.world.spoken.A = "primero esto";
      w.world.spoken.B = "después aquello";
      await deliver(w, audioEvent(id("aud"), p.phone, "A"), textEvent(id("txt"), p.phone, "en medio"), audioEvent(id("aud"), p.phone, "B"));
      expect(seen).toEqual(["primero esto\nen medio\ndespués aquello"]);
      expect(w.sends).toHaveLength(1);
      expect([...w.world.transcribed].sort()).toEqual(["A", "B"]);
    });

    it("una transcripción médica va por el camino de seguridad de siempre (el aviso lo da el manejador, no hay cotización)", async () => {
      const p = patient();
      const w = setup({ handlers: { text: async (turn) => (/pecho/i.test(turn.text!) ? { body: "AVISO_MEDICO_FIJO" } : undefined) } });
      w.world.spoken.A = "me duele el pecho y tengo fiebre";
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([{ to: p.phone, body: "AVISO_MEDICO_FIJO" }]);
      expect((await sessionsOf(p.key)).map((s) => s.status)).not.toContain("QUOTED");
    });

    it("con el MODO SOMBRA del motor de lotes la respuesta es la misma que sin él: los audios se transcriben igual, una vez, y solo se agrega la línea de comparación", async () => {
      const build = (p: { phone: string }) => [textEvent(id("txt"), p.phone, "hola"), audioEvent(id("aud"), p.phone, "A")];
      const off = patient();
      const wOff = setup();
      wOff.world.spoken.A = "quiero cotizar hemograma";
      await deliver(wOff, ...build(off));
      const on = patient();
      const wShadow = setup({ engine: "shadow" });
      wShadow.world.spoken.A = "quiero cotizar hemograma";
      await deliver(wShadow, ...build(on));
      expect(wShadow.sends.map((sent) => sent.body)).toEqual(wOff.sends.map((sent) => sent.body));
      expect(wShadow.world.transcribed).toEqual(["A"]);
      expect(logsOf(wShadow, "batch_shadow")).toHaveLength(1);
      expect(logsOf(wOff, "batch_shadow")).toEqual([]);
    });

    it("una transcripción ambigua NO se adivina: se pregunta por la duda como con un texto escrito", async () => {
      const p = patient();
      const w = setup();
      w.world.catalog = [...baseCatalog(), study(7, "CREATININA SERICA", ["creatinina"], 20), study(8, "CREATININA EN ORINA", ["creatinina"], 22)];
      w.world.spoken.A = "quiero cotizar creatinina";
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toHaveLength(1);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(w.sends[0]!.body).toContain("CREATININA SERICA");
      expect(w.sends[0]!.body).toContain("CREATININA EN ORINA");
    });
  });

  // ───────────────────────────── deduplicación ─────────────────────────────

  describe("entregas duplicadas", () => {
    it("el mismo lote mixto entregado DOS VECES (reintento de Kapso) responde una vez, transcribe una vez y analiza la foto una vez", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      w.world.spoken.A = "hemograma";
      const events = [textEvent(id("txt"), p.phone, "quiero cotizar"), audioEvent(id("aud"), p.phone, "A"), imageEvent(id("img"), p.phone, "P")];
      await deliver(w, ...events);
      await deliver(w, ...events);
      expect(w.sends).toHaveLength(1);
      expect(w.world.transcribed).toEqual(["A"]);
      expect(w.world.downloaded).toEqual(["A"]);
      expect(vi.mocked(w.quote.analyze)).toHaveBeenCalledTimes(1);
      expect((await sessionsOf(p.key)).map((s) => s.status)).toEqual(["QUOTED"]);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("dos entregas SIMULTÁNEAS del mismo audio: una sola respuesta y una sola transcripción", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = "quiero cotizar hemograma";
      const event = audioEvent(id("aud"), p.phone, "A");
      const [a, b] = await Promise.all([w.hook(signedPost(batchOf(event), BATCH)), w.hook(signedPost(batchOf(event), BATCH))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(w.world.transcribed).toEqual(["A"]);
      expect(await runsOf(p.key)).toHaveLength(1);
    });

    it("el mismo audio reenviado como evento suelto después de procesarse no responde otra vez", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = "quiero cotizar hemograma";
      const event = audioEvent(id("aud"), p.phone, "A");
      await deliverOne(w, event);
      await deliverOne(w, event);
      expect(w.sends).toHaveLength(1);
      expect(w.world.transcribed).toEqual(["A"]);
    });
  });

  // ───────────────────────────── atención humana, tope diario y privacidad ─────────────────────────────

  describe("atención humana, límite diario y privacidad", () => {
    it("PAUSA HUMANA: con el contacto pausado no se transcribe, no se responde y no se reclama nada", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = "quiero cotizar hemograma";
      await deliverOne(w, humanEvent(id("hum"), p.phone), SENT);
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
      expect(w.world.downloaded).toEqual([]);
      expect(await runsOf(p.key)).toEqual([]);
    });

    it("PAUSA HUMANA a mitad del procesamiento: no se envía nada", async () => {
      const p = patient();
      const w = setup();
      let release!: () => void;
      w.world.gate = new Promise<void>((resolve) => (release = resolve));
      w.world.spoken.A = "quiero cotizar hemograma";
      expect((await w.hook(signedPost(batchOf(audioEvent(id("aud"), p.phone, "A")), BATCH))).status).toBe(200);
      await until(() => expect(w.transcriber).toHaveBeenCalledTimes(1));
      expect((await w.hook(signedPost(humanEvent(id("hum"), p.phone), SENT))).status).toBe(200);
      release();
      await w.settle();
      expect(w.sends).toEqual([]);
      expect((await runsOf(p.key)).filter((run) => run.send_state === "ACCEPTED" || run.send_state === "RESERVED")).toEqual([]);
    });

    it("LÍMITE DIARIO: cada respuesta a un audio cuenta como una respuesta del agente; a la tercera con tope de 2 ya no se responde", async () => {
      const p = patient();
      const w = setup({ dailyCap: { max: 2, windowSeconds: 86_400 } });
      for (const tag of ["A", "B", "C"]) w.world.spoken[tag] = "quiero cotizar hemograma";
      const ids = [id("aud"), id("aud"), id("aud")];
      for (const [index, tag] of ["A", "B", "C"].entries()) await deliverOne(w, audioEvent(ids[index]!, p.phone, tag));
      expect(w.sends).toHaveLength(2);
      const blocked = (await runsOf(p.key)).find((run) => run.kapso_message_id === ids[2]);
      expect(blocked).toMatchObject({ send_state: "CANCELLED", send_block_reason: "DAILY_CAP" });
    });

    it("PRIVACIDAD: ni el registro ni la auditoría guardan la transcripción, el enlace del medio ni el teléfono en claro", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = "quiero cotizar hemograma y SECRETO_CLINICO_5521";
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      const serialized = JSON.stringify(w.logs);
      for (const forbidden of ["SECRETO_CLINICO_5521", "media.kapso.ai", "lookaside", p.phone, "quiero cotizar"]) expect(serialized, forbidden).not.toContain(forbidden);
      const leaked = await db.ok(`select count(*) from public.plusmedik_audit_runs r join public.plusmedik_turns t on t.run_id = r.id where r.contact_key = '${p.key}' and r::text like '%SECRETO_CLINICO_5521%'`);
      expect(leaked).toBe("0");
    });
  });

  // ───────────────────────────── fallas parciales y archivos inválidos ─────────────────────────────

  describe("fallas, reintentos y archivos inválidos: nunca se inventa información", () => {
    it("archivo que NO es audio (el enlace devolvió una página): NO se envía aviso (solo), nada se cotiza, y la solicitud queda marcada para que «listo» no cotice como si el audio no existiera", async () => {
      const p = patient();
      const w = setup();
      w.world.media.A = { bytes: new TextEncoder().encode(`<html><body>expired</body></html>`.padEnd(400, " ")) };
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
      expect(await itemStatuses(p.key)).toEqual(["UNREADABLE"]);
      // el paciente escribe y pide cerrar: no se cotiza a ciegas
      await deliverOne(w, textEvent(id("txt"), p.phone, "hemograma"));
      await deliverOne(w, textEvent(id("txt"), p.phone, "listo"));
      expect(w.sends.at(-1)!.body).toBe(QUOTE_TEXTS.resend);
      expect(w.sends.some((sent) => hasPrice(sent.body))).toBe(false);
    });

    it("formato que el transcriptor no admite (AMR) y aquí no se convierte: sin aviso, sin llamar a OpenAI", async () => {
      const p = patient();
      const w = setup();
      w.world.media.A = { bytes: new Uint8Array(400).fill(0).map((_, i) => "#!AMR\n".charCodeAt(i) || 0) };
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(w.transcriber).not.toHaveBeenCalled();
    });

    it("audio sin palabras reconocibles: sin aviso (solo); nada se cotiza", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = new AudioFailure("UNINTELLIGIBLE");
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(w.transcriber).toHaveBeenCalledTimes(1);
    });

    it("audio demasiado grande o transcripción que no cabe entera: sin aviso (solo); jamás se usa un trozo", async () => {
      const p = patient();
      const w = setup();
      w.world.media.A = { bytes: new Uint8Array(11 * 1024 * 1024) };
      w.world.spoken.B = new AudioFailure("TOO_LONG");
      await deliverOne(w, audioEvent(id("aud"), p.phone, "A"));
      await deliverOne(w, audioEvent(id("aud"), p.phone, "B"));
      expect(w.sends).toEqual([]);
      expect(w.world.transcribed).toEqual(["B"]);
    });

    it("ENLACE VENCIDO: se baja por el id del audio con el SDK oficial y se transcribe; sin id, aviso", async () => {
      const p = patient();
      const w = setup();
      w.world.media.A = { status: 410 };
      w.world.sdk["media-A"] = oggBytes("A");
      w.world.spoken.A = "quiero cotizar glucosa";
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.world.sdkCalls).toEqual(["media-A"]);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");

      const q = patient();
      const w2 = setup();
      w2.world.media.B = { status: 410 };
      await deliver(w2, audioEvent(id("aud"), q.phone, "B", { mediaId: null }));
      expect(w2.world.sdkCalls).toEqual([]);
      expect(w2.sends).toEqual([]);
    });

    it("NUNCA se descarga de una URL de Meta: sin enlace de Kapso se usa el id con el SDK; sin ninguno de los dos, aviso", async () => {
      const p = patient();
      const w = setup();
      w.world.sdk["media-A"] = oggBytes("A");
      w.world.spoken.A = "quiero cotizar hemograma";
      await deliver(w, audioEvent(id("aud"), p.phone, "A", { url: null }));
      expect(w.world.downloaded).toEqual([]);
      expect(w.world.sdkCalls).toEqual(["media-A"]);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");

      const q = patient();
      const w2 = setup();
      await deliver(w2, audioEvent(id("aud"), q.phone, "B", { url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=B", mediaId: null }));
      expect(w2.world.downloaded).toEqual([]);
      expect(w2.sends).toEqual([]);
    });

    it("OpenAI falla dos veces y a la tercera responde: se reintenta dentro del mismo procesamiento y sale UNA respuesta normal", async () => {
      const p = patient();
      const w = setup();
      let calls = 0;
      w.world.spoken.A = async () => {
        if (++calls < 3) throw new AudioFailure("UNAVAILABLE", true);
        return "quiero cotizar hemograma";
      };
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(calls).toBe(3);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
    });

    it("OpenAI no responde nunca: sin aviso al paciente (solo), ningún intento posterior y nada cotizado", async () => {
      const p = patient();
      const w = setup();
      w.world.spoken.A = new AudioFailure("UNAVAILABLE", true);
      const messageId = id("aud");
      await deliver(w, audioEvent(messageId, p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(w.transcriber).toHaveBeenCalledTimes(3);
      // el reintento de Kapso de la misma entrega no vuelve a transcribir
      await deliver(w, audioEvent(messageId, p.phone, "A"));
      expect(w.sends).toHaveLength(0);
      expect(w.transcriber).toHaveBeenCalledTimes(3);
    });

    it("FALLA PARCIAL: un audio se escucha y otro no — no se cotiza a medias; se avisa del que falló y lo escuchado queda anotado", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      w.world.spoken.A = "quiero cotizar hemograma";
      w.world.media.B = { bytes: new TextEncoder().encode("no es audio".padEnd(400, " ")) };
      await deliver(w, audioEvent(id("aud"), p.phone, "A"), audioEvent(id("aud"), p.phone, "B"));
      expect(w.sends).toHaveLength(1);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(w.sends[0]!.body).toContain(AUDIO_TEXTS.invalid);
      expect((await sessionsOf(p.key)).map((s) => s.status)).not.toContain("QUOTED");
      expect(await itemStatuses(p.key)).toEqual(expect.arrayContaining(["RESOLVED", "UNREADABLE"]));
      expect(await openRuns(p.key)).toBe(0);
    });

    it("falla de un audio dentro de un lote con texto y foto: el texto y la foto se atienden, el audio fallido se avisa y la respuesta es UNA", async () => {
      const p = patient();
      const w = setup({ engine: "on" });
      w.world.spoken.A = new AudioFailure("UNINTELLIGIBLE");
      w.world.photos.P = [3];
      await deliver(w, textEvent(id("txt"), p.phone, "quiero cotizar hemograma"), audioEvent(id("aud"), p.phone, "A"), imageEvent(id("img"), p.phone, "P"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain(AUDIO_TEXTS.unintelligible);
      expect(hasPrice(w.sends[0]!.body)).toBe(false);
      expect(await openRuns(p.key)).toBe(0);
    });

    it("más audios de los que se atienden por lote: los primeros se transcriben y el exceso recibe un aviso (sin transcribir)", async () => {
      const p = patient();
      const w = setup({ maxPerBatch: 2, sessions: false, handlers: { text: async (turn) => ({ body: `texto: ${turn.text}` }) } });
      for (const tag of ["A", "B", "C"]) w.world.spoken[tag] = `audio ${tag}`;
      await deliver(w, audioEvent(id("aud"), p.phone, "A"), audioEvent(id("aud"), p.phone, "B"), audioEvent(id("aud"), p.phone, "C"));
      expect(w.world.transcribed.sort()).toEqual(["A", "B"]);
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("audio A\naudio B");
      expect(w.sends[0]!.body).toContain(AUDIO_TEXTS.too_many);
    });
  });
});
