import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { AudioPipeline } from "../src/audio/service.js";
import type { MediaFetcher } from "../src/audio/media.js";
import { createSupabaseAuditRepository } from "../src/audit.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createConversationModel, type ConversationClient } from "../src/conversation-model.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { buildOggOpus } from "./support/ogg-opus.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Silencio ante mensajes claramente ajenos al laboratorio de extremo a extremo: webhook REAL + manejador de texto REAL + modelo de conversación REAL (con un cliente SIMULADO: ninguna prueba llama a OpenAI) +
// sesiones de cotización REALES + canalización de audio REAL (transcriptor simulado) + PostgreSQL REAL con TODAS las migraciones. Sin cola, sin cron, sin tablas nuevas. Se omite, con aviso, sin PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[off-topic-silence-e2e] PostgreSQL no disponible: se omiten los escenarios de silencio contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const POLITE = "Con gusto te ayudo con tus estudios. ¿Qué necesitas?";
const OFF = "¿Quién ganó el partido de anoche?";
const OFF2 = "jaja qué buen chiste el de tu tío";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const CATALOG = (): CatalogStudy[] => [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(4, "TSH", ["tsh"], 80)];

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const audioEvent = (id: string, phone: string, tag: string) => ({
  message: { id, timestamp: nowSeconds(), type: "audio", from: phone, audio: { id: `media-${tag}`, voice: true, mime_type: "audio/ogg; codecs=opus" }, kapso: { ...inbound, has_media: true, media_url: `https://media.kapso.ai/${tag}.ogg` } },
  conversation: conversation(phone), phone_number_id: LAB
});
const batchOf = (...events: unknown[]) => ({ type: "whatsapp.message.received", batch: true, data: events });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const BATCH = { ...RECEIVED, "x-webhook-batch": "true" };
const oggBytes = (tag: string): Uint8Array<ArrayBuffer> => buildOggOpus({ comment: `TAG:${tag}:` });
const tagOf = (bytes: Uint8Array): string => /TAG:([^:]+):/.exec(Buffer.from(bytes).toString("latin1"))?.[1] ?? "?";

describe.skipIf(!bin)("silencio ante lo ajeno al laboratorio (extremo a extremo contra PostgreSQL real)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("off_topic_extremo");
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
    silence?: boolean;
    engine?: "on" | "shadow";
    // Lo que contesta el modelo simulado: por defecto OFF_TOPIC para lo que habla de partidos o chistes, SMALL_TALK para el resto.
    intentFor?: (message: string) => string | Error;
  }

  function setup(options: Options = {}) {
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const world = { spoken: {} as Record<string, string>, asked: [] as string[] };

    const client: ConversationClient = {
      complete: vi.fn(async ({ message }) => {
        world.asked.push(message);
        const decided = options.intentFor ? options.intentFor(message) : /partido|chiste/i.test(message) ? "OFF_TOPIC" : "SMALL_TALK";
        if (decided instanceof Error) throw decided;
        return { text: JSON.stringify({ intent: decided, reply: POLITE }), usage: { inputTokens: 5, outputTokens: 5 } };
      })
    };
    const model = createConversationModel({ client, prompt: "PROMPT_DE_PRUEBA", promptId: "abc123def456", model: "modelo-de-prueba", log, silenceOffTopic: options.silence !== false });

    const fetcher: MediaFetcher = {
      async rawFetch(url) { return new Response(oggBytes(/\/([^/]+)\.ogg/.exec(url)?.[1] ?? "?"), { status: 200 }); },
      async authedFetch() { throw new Error("no debería usarse la credencial de Kapso aquí"); },
      async sdkDownload() { throw new Error("medio no disponible"); }
    };
    const transcriber = vi.fn(async ({ bytes }: { bytes: Uint8Array }) => world.spoken[tagOf(bytes)] ?? "");
    const audio = new AudioPipeline({ transcriber, fetcher, log, sleep: async () => undefined });
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array(0) })),
      loadCatalog: vi.fn(async () => CATALOG()),
      analyze: vi.fn(async () => ({}) as AnalysisResult),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: { text: createTextHandler({ log, conversation: model }) },
        audio,
        ...(options.engine ? { batchEngine: { mode: options.engine } } : {}),
        quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ttlSeconds: 1800, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] })
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, world, client, transcriber, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;

  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    expect((await w.hook(signedPost(textEvent(message, phone, body), RECEIVED))).status).toBe(200);
    await w.settle();
    return message;
  };
  const deliver = async (w: World, ...events: unknown[]) => {
    expect((await w.hook(signedPost(batchOf(...events), BATCH))).status).toBe(200);
    await w.settle();
  };
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const sessionOf = async (key: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select json_build_object('status', s.status, 'items', (select count(*) from public.plusmedik_quote_items i where i.session_id = s.id)) from public.plusmedik_quote_sessions s where s.contact_key = '${key}' order by s.created_at desc limit 1`));
  const leftover = async (key: string): Promise<number> => Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${key}' and processing_status in ('PROCESSING','ANALYZED')`));
  const NO_REPLY = { processing_status: "IGNORED", send_state: "NOT_APPLICABLE", reply_state: "NOT_ATTEMPTED", error_code: "NO_REPLY" };

  it("mensaje ajeno y NADA pendiente: no se envía nada, el turno queda cerrado como «sin respuesta» y el texto no se guarda ni se registra", async () => {
    const w = setup();
    const p = patient();
    const message = await say(w, p.phone, OFF);
    expect(w.sends).toEqual([]);
    expect(w.client.complete).toHaveBeenCalledTimes(1);
    expect(await run(message)).toMatchObject(NO_REPLY);
    expect(w.logs).toContainEqual(["text_turn", expect.objectContaining({ category: "OTHER", model: "silent", handoff: "none" })]);
    expect(JSON.stringify(w.logs)).not.toMatch(/partido|anoche/);
    expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where to_json(plusmedik_audit_runs)::text like '%partido%'`)).toBe("0");
    expect(await leftover(p.key)).toBe(0);
  });

  it("dos mensajes ajenos seguidos: ambos en silencio; y luego una solicitud real se atiende normalmente (el silencio no deja huella en la conversación)", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, OFF);
    await say(w, p.phone, OFF2);
    expect(w.sends).toEqual([]);
    await say(w, p.phone, "hemograma");
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
  });

  it("SIN la bandera todo se responde como siempre: el mismo mensaje ajeno recibe la respuesta del modelo", async () => {
    const w = setup({ silence: false });
    const p = patient();
    await say(w, p.phone, OFF);
    expect(w.sends.map((s) => s.body)).toEqual([POLITE]);
  });

  it("con una solicitud ABIERTA el mensaje ajeno se responde (se respeta el contexto) y la solicitud sigue intacta", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "hemograma");
    const before = w.sends.length;
    await say(w, p.phone, OFF);
    expect(w.sends).toHaveLength(before + 1);
    expect(w.sends.at(-1)!.body).toBe(POLITE);
    expect(await sessionOf(p.key)).toMatchObject({ status: "OPEN", items: 1 });
    await say(w, p.phone, "sí, esos estudios");
    expect(w.sends.at(-1)!.body).toContain("Total de los estudios cotizados: Bs 45");
  });

  it("con una cotización RECIENTE el mensaje ajeno se responde", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "hemograma");
    await say(w, p.phone, "sí, esos estudios");
    expect(await sessionOf(p.key)).toMatchObject({ status: "QUOTED" });
    const before = w.sends.length;
    await say(w, p.phone, OFF);
    expect(w.sends).toHaveLength(before + 1);
    expect(w.sends.at(-1)!.body).toBe(POLITE);
  });

  it("AMBIGUO: si el modelo no está seguro (UNCLEAR) se responde; y un tema del laboratorio, que el modelo no marca como ajeno, también", async () => {
    const unsure = setup({ intentFor: () => "UNCLEAR" });
    const p = patient();
    await say(unsure, p.phone, OFF);
    expect(unsure.sends.map((s) => s.body)).toEqual([POLITE]);

    // sin listas de palabras en el sistema: la interpretación es del modelo
    const lab = setup({ intentFor: (message) => (/sucursal/i.test(message) ? "SMALL_TALK" : "OFF_TOPIC") });
    const q = patient();
    await say(lab, q.phone, "jaja viste el partido, por cierto ¿tienen sucursal en el centro?");
    expect(lab.sends.length).toBeGreaterThanOrEqual(1);
  });

  it("protección médica: un texto de salud nunca se silencia, aunque el modelo diga OFF_TOPIC", async () => {
    const w = setup({ intentFor: () => "OFF_TOPIC" });
    const p = patient();
    await say(w, p.phone, "jaja viste el partido? me duele la cabeza y tengo fiebre");
    expect(w.sends.length).toBeGreaterThanOrEqual(1);
  });

  it("falla del modelo: no se silencia nada, sale el texto fijo de siempre", async () => {
    const w = setup({ intentFor: () => new Error("boom") });
    const p = patient();
    await say(w, p.phone, OFF);
    expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.fallback]);
  });

  it("saludos, gracias y lo médico no cambian: el silencio solo aplica a lo ajeno", async () => {
    const w = setup({ intentFor: () => "OFF_TOPIC" });
    const p = patient();
    await say(w, p.phone, "me duele el pecho");
    expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.medical_unavailable);
    await say(w, p.phone, "quiero hablar con una persona");
    expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.handoff_unavailable);
  });

  describe("mensajes agrupados (lote de Kapso)", () => {
    it("un lote entero de mensajes ajenos: silencio total, todos los turnos cerrados", async () => {
      const w = setup();
      const p = patient();
      const ids = [id("a"), id("b")];
      await deliver(w, textEvent(ids[0]!, p.phone, OFF), textEvent(ids[1]!, p.phone, OFF2));
      expect(w.sends).toEqual([]);
      for (const message of ids) expect(await run(message)).toMatchObject(NO_REPLY);
      expect(await leftover(p.key)).toBe(0);
    });

    it("lote [ajeno, solicitud]: solo se responde la solicitud, una vez, sin mezclar lo ajeno", async () => {
      const w = setup();
      const p = patient();
      await deliver(w, textEvent(id("a"), p.phone, OFF), textEvent(id("b"), p.phone, "hemograma"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).not.toContain(POLITE);
      expect(await sessionOf(p.key)).toMatchObject({ status: "OPEN", items: 1 });
    });

    it("lote [solicitud, ajeno]: la solicitud anterior del mismo lote cuenta como pendiente, así que se responde y nada se pierde", async () => {
      const w = setup();
      const p = patient();
      await deliver(w, textEvent(id("a"), p.phone, "hemograma"), textEvent(id("b"), p.phone, OFF));
      expect(w.sends.length).toBeGreaterThanOrEqual(1);
      expect(w.sends.map((s) => s.body).join("\n")).toContain("HEMOGRAMA COMPLETO");
      expect(await sessionOf(p.key)).toMatchObject({ status: "OPEN", items: 1 });
      expect(await leftover(p.key)).toBe(0);
    });

    it("motor de decisión por lote ENCENDIDO: lo ajeno se delega al manejador y sigue en silencio; sale una sola respuesta con la solicitud", async () => {
      const w = setup({ engine: "on" });
      const p = patient();
      await deliver(w, textEvent(id("a"), p.phone, OFF), textEvent(id("b"), p.phone, "hemograma"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).not.toContain(POLITE);
      expect(await leftover(p.key)).toBe(0);
    });

    it("bandera APAGADA con el motor en «on» o en «shadow»: un lote de charla ajena se responde como siempre (una respuesta del manejador, ninguna decisión de silencio) y el modelo ve el prompt de antes", async () => {
      for (const engine of ["on", "shadow"] as const) {
        const w = setup({ silence: false, engine });
        const p = patient();
        await deliver(w, textEvent(id("a"), p.phone, OFF), textEvent(id("b"), p.phone, OFF2));
        expect(w.sends.map((s) => s.body), engine).toEqual([POLITE]);
        expect(w.logs.some(([event, data]) => event === "text_turn" && data.model === "silent"), engine).toBe(false);
        expect(await leftover(p.key), engine).toBe(0);
      }
    });

    it("motor ENCENDIDO y un lote solo con lo ajeno: silencio", async () => {
      const w = setup({ engine: "on" });
      const p = patient();
      await deliver(w, textEvent(id("a"), p.phone, OFF), textEvent(id("b"), p.phone, OFF2));
      expect(w.sends).toEqual([]);
      expect(await leftover(p.key)).toBe(0);
    });
  });

  describe("audios transcritos", () => {
    it("un audio cuya transcripción es ajena al laboratorio: silencio (se transcribe una vez y el turno queda cerrado)", async () => {
      const w = setup();
      const p = patient();
      w.world.spoken.A = OFF;
      const message = id("aud");
      await deliver(w, audioEvent(message, p.phone, "A"));
      expect(w.transcriber).toHaveBeenCalledTimes(1);
      expect(w.sends).toEqual([]);
      expect(await run(message)).toMatchObject(NO_REPLY);
      expect(JSON.stringify(w.logs)).not.toMatch(/partido|anoche/);
    });

    it("un audio con una solicitud del laboratorio se atiende normalmente", async () => {
      const w = setup();
      const p = patient();
      w.world.spoken.A = "quiero cotizar hemograma y glucosa";
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA COMPLETO");
      expect(w.sends[0]!.body).toContain("GLUCOSA EN AYUNAS");
    });

    it("lote [audio ajeno, texto con solicitud]: solo se responde la solicitud", async () => {
      const w = setup();
      const p = patient();
      w.world.spoken.A = OFF;
      await deliver(w, audioEvent(id("aud"), p.phone, "A"), textEvent(id("txt"), p.phone, "tsh"));
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("TSH");
      expect(w.sends[0]!.body).not.toContain(POLITE);
    });

    it("un audio ajeno con una solicitud ABIERTA se responde", async () => {
      const w = setup();
      const p = patient();
      await say(w, p.phone, "hemograma");
      const before = w.sends.length;
      w.world.spoken.A = OFF;
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toHaveLength(before + 1);
      expect(w.sends.at(-1)!.body).toBe(POLITE);
    });

    it("con el motor ENCENDIDO un audio ajeno también se silencia", async () => {
      const w = setup({ engine: "on" });
      const p = patient();
      w.world.spoken.A = OFF;
      await deliver(w, audioEvent(id("aud"), p.phone, "A"));
      expect(w.sends).toEqual([]);
      expect(await leftover(p.key)).toBe(0);
    });
  });

  it("no hay cola, tablas ni funciones nuevas: el silencio solo usa lo que ya existía", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, OFF);
    expect(w.sends).toEqual([]);
    expect(await db.ok(`select count(*) from information_schema.tables where table_name ~ '(silen|off_topic|ajeno)'`)).toBe("0");
  });
});
