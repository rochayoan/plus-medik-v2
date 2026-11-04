import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AudioPipeline } from "../src/audio/service.js";
import type { MediaFetcher } from "../src/audio/media.js";
import { createReplyGate, createRepeatTracker, type AttentionConfig } from "../src/attention-filter.js";
import { createSupabaseAuditRepository, createSupabaseRpc } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { createMessageHistory, createSupabaseHistoryStore, exportHistory, keyIdOf, type ExportedMessage } from "../src/message-history.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { buildOggOpus } from "./support/ogg-opus.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Historial de mensajes para auditoría (migración 21) de extremo a extremo: webhook REAL + turnos REALES + manejador de texto REAL + repositorios REALES + PostgreSQL REAL con TODAS las migraciones.
// Solo se simulan Kapso (envíos y medios), OpenAI (la transcripción), el catálogo y el motor de recetas. Se omite, con aviso, sin PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[message-history-e2e] PostgreSQL no disponible: se omiten los escenarios del historial contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const HISTORY_KEY = "clave-de-historial-solo-para-pruebas-0123456789";
const OTHER_KEY = "otra-clave-de-historial-solo-para-pruebas-9876";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_7741";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const CATALOG = (): CatalogStudy[] => [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(4, "TSH", ["tsh"], 80)];
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA COMPLETO", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: { ...inbound } }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: nowSeconds(), type: "image", from: phone, image: { id: tag, caption: "mi receta" }, kapso: { ...inbound, has_media: true, media_url: `https://example.test/${tag}.jpg` } }, conversation: conversation(phone), phone_number_id: LAB });
const audioEvent = (id: string, phone: string, tag: string) => ({
  message: { id, timestamp: nowSeconds(), type: "audio", from: phone, audio: { id: `media-${tag}`, voice: true, link: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${tag}`, url: `https://mmg.whatsapp.net/${tag}` }, kapso: { ...inbound, has_media: true, media_url: `https://media.kapso.ai/${tag}.ogg` } },
  conversation: conversation(phone), phone_number_id: LAB
});
const humanEvent = (id: string, phone: string, body = SENTINEL) => ({ message: { id, timestamp: nowSeconds(), type: "text", to: phone, text: { body }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const statusEvent = (id: string, phone: string, status: string) => ({ message: { id, timestamp: nowSeconds(), kapso: { direction: "outbound", status, origin: "cloud_api" } }, conversation: conversation(phone), phone_number_id: LAB });
const batchOf = (...events: unknown[]) => ({ type: "whatsapp.message.received", batch: true, data: events });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const BATCH = { ...RECEIVED, "x-webhook-batch": "true" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const statusHeader = (status: string) => ({ "x-webhook-event": `whatsapp.message.${status}` });

interface HistoryRowView { seq: number; direction: string; actor: string; kind: string; type: string | null; id: string; state: string; media: string | null; reply_to: string | null; run: string | null; has_text: boolean; key_id: string | null }

describe.skipIf(!bin)("historial de mensajes de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("message_history");
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
  const oggBytes = (tag: string) => buildOggOpus({ comment: `TAG:${tag}:` });

  interface Options {
    history?: boolean;
    sessions?: boolean;
    attention?: boolean;
    audio?: boolean;
    dailyCap?: { max: number; windowSeconds: number };
    sendText?: (to: string, body: string) => Promise<void | { providerMessageId?: string }>;
    allowedPhones?: string;
    retentionDays?: number;
    transcript?: string;
  }
  function setup(options: Options = {}) {
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const store = createSupabaseHistoryStore({ rpc: createSupabaseRpc(rpcOptions()), ...(options.retentionDays ? { retentionDays: options.retentionDays } : {}) });
    const history = options.history === false ? undefined : createMessageHistory({ store, secret: HISTORY_KEY, accountId: LAB, contactKeyFor, log });
    const attention: AttentionConfig | undefined = options.attention === false ? undefined : { repeats: createRepeatTracker({ windowMs: 90_000 }), gate: createReplyGate(), settleMs: 0 };
    const fetcher: MediaFetcher = {
      rawFetch: async (url) => new Response(oggBytes(/\/([^/]+)\.ogg/.exec(url)?.[1] ?? "?"), { status: 200 }),
      authedFetch: async () => { throw new Error("no debería usarse la credencial de Kapso aquí"); },
      sdkDownload: async () => { throw new Error("medio no disponible"); }
    };
    const audio = options.audio ? new AudioPipeline({ transcriber: vi.fn(async () => options.transcript ?? "quiero cotizar hemograma"), fetcher, log, sleep: async () => undefined }) : undefined;
    const sessions = options.sessions !== false;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => CATALOG()),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(options.sendText ?? (async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}-${++counter}` }; })),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      ...(history ? { history } : {}),
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400, ...(attention ? { attention } : {}), ...(options.dailyCap ? { dailyCap: options.dailyCap } : {}), ...(audio ? { audio } : {}),
        handlers: { text: createTextHandler({ log, attention: attention !== undefined }) },
        ...(sessions ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ...(attention ? { attention: { gate: attention.gate, settleMs: attention.settleMs } } : {}), ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: options.allowedPhones, quote, schedule: (task) => { scheduled.push(task); }, ...(history ? { history } : {}), humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, network, store, history, quote, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers: Record<string, string> = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    await send(w, textEvent(message, phone, body));
    return message;
  };
  const rowsOf = async (key: string): Promise<HistoryRowView[]> =>
    JSON.parse(await db.ok(`select coalesce(json_agg(x order by x.seq), '[]') from (select seq, direction, actor, content_kind as kind, message_type as type, provider_message_id as id, delivery_state as state, media_ref as media, reply_to_message_id as reply_to, audit_run_id as run, (body_cipher is not null) as has_text, key_id from public.plusmedik_message_history where contact_key = '${key}') x`));
  const runOf = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const readAll = async (w: World, key?: string, keys: string[] = [HISTORY_KEY]): Promise<ExportedMessage[]> => {
    const out: ExportedMessage[] = [];
    for await (const message of exportHistory({ store: w.store, accountId: LAB, keys, reason: "revisión de la prueba automática", ...(key ? { contactKey: key } : {}) })) out.push(message);
    return out;
  };
  const asService = (sql: string) => `set role service_role; ${sql}`;
  const lines = (messages: ExportedMessage[]) => messages.map((m) => `${m.direction}/${m.actor}: ${m.text ?? "(sin texto)"}`);

  // ───────────────────────────── conversación completa ─────────────────────────────

  describe("conversación del paciente con el agente", () => {
    it("texto entrante + respuesta aceptada: dos filas en orden, cifradas, la respuesta con la corrida de auditoría y el mensaje al que responde; el texto se recupera exacto al exportar", async () => {
      const p = patient();
      const w = setup();
      const message = await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.medical_unavailable }]);
      const run = await runOf(message);
      const rows = await rowsOf(p.key);
      expect(rows.map((r) => [r.direction, r.actor, r.kind, r.state, r.has_text])).toEqual([["IN", "PATIENT", "TEXT", "RECEIVED", true], ["OUT", "AGENT", "TEXT", "ACCEPTED", true]]);
      expect(rows[0]).toMatchObject({ id: message, key_id: keyIdOf(HISTORY_KEY) });
      expect(rows[1]).toMatchObject({ reply_to: message, run: run.id });
      expect(lines(await readAll(w, p.key))).toEqual([`IN/PATIENT: me duele el pecho ${SENTINEL}`, `OUT/AGENT: ${DRAFT_TEXTS.medical_unavailable}`]);
    });

    it("PRIVACIDAD: ni el texto, ni el teléfono, ni la clave están en claro en ninguna tabla; el registro de Vercel solo lleva contadores y códigos", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      const dump = await db.ok(`select string_agg(to_json(h)::text, ' ') from public.plusmedik_message_history h where contact_key = '${p.key}'`);
      for (const secret of [SENTINEL, "me duele", p.phone, HISTORY_KEY, HMAC_KEY, DRAFT_TEXTS.medical_unavailable]) {
        expect(dump).not.toContain(secret);
        expect(JSON.stringify(w.logs)).not.toContain(secret);
      }
      expect(JSON.stringify(w.logs.filter(([event]) => event.startsWith("message_history")))).not.toMatch(/wamid|5917/);
      expect(lines(await readAll(w, p.key))).toEqual([`IN/PATIENT: me duele el pecho ${SENTINEL}`, `OUT/AGENT: ${DRAFT_TEXTS.medical_unavailable}`]);
      const columns = (await db.ok(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'plusmedik_message_history' order by ordinal_position`)).split(/\r?\n/);
      expect(columns).toEqual(["id", "seq", "provider", "account_id", "contact_key", "provider_message_id", "direction", "actor", "origin", "content_kind", "message_type", "body_cipher", "key_id", "media_ref", "delivery_state", "audit_run_id", "reply_to_message_id", "occurred_at", "delivery_at", "created_at", "expires_at"]);
    });

    it("por defecto TODO se conserva para siempre: ni los mensajes del paciente ni las respuestas del agente tienen fecha de vencimiento", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(await db.ok(`select count(*) filter (where expires_at is null) || '/' || count(*) from public.plusmedik_message_history where contact_key = '${p.key}'`)).toBe("2/2");
    });

    it("el mismo webhook entregado dos veces (reintento de Kapso): una fila de cada y una sola respuesta", async () => {
      const p = patient();
      const w = setup();
      const event = textEvent(id("txt"), p.phone, "quiero cotizar mis estudios");
      await send(w, event);
      await send(w, event);
      await send(w, batchOf(event), BATCH);
      expect(w.sends).toHaveLength(1);
      expect((await rowsOf(p.key)).map((r) => r.direction)).toEqual(["IN", "OUT"]);
    });

    it("estados de entrega: ACCEPTED → SENT → DELIVERED → READ; un evento tardío, repetido o fuera de orden no retrocede nada; un mensaje desconocido no crea nada", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "quiero cotizar mis estudios");
      const outId = (await rowsOf(p.key)).find((r) => r.direction === "OUT")!.id;
      const state = async () => (await rowsOf(p.key)).find((r) => r.direction === "OUT")!.state;
      expect(await state()).toBe("ACCEPTED");
      await send(w, statusEvent(outId, p.phone, "sent"), SENT);
      expect(await state()).toBe("SENT");
      await send(w, statusEvent(outId, p.phone, "delivered"), statusHeader("delivered"));
      expect(await state()).toBe("DELIVERED");
      await send(w, statusEvent(outId, p.phone, "read"), statusHeader("read"));
      expect(await state()).toBe("READ");
      await send(w, statusEvent(outId, p.phone, "sent"), SENT);
      await send(w, statusEvent(outId, p.phone, "delivered"), statusHeader("delivered"));
      await send(w, statusEvent(outId, p.phone, "failed"), statusHeader("failed"));
      expect(await state()).toBe("READ");
      const before = Number(await db.ok(`select count(*) from public.plusmedik_message_history`));
      await send(w, statusEvent("wamid.NO-EXISTE", p.phone, "delivered"), statusHeader("delivered"));
      expect(Number(await db.ok(`select count(*) from public.plusmedik_message_history`))).toBe(before);
      expect(await db.ok(`select delivery_at is not null from public.plusmedik_message_history where provider_message_id = '${outId}'`)).toBe("t");
    });

    it("un fallo reportado por Kapso tras el envío marca FAILED (la respuesta se aceptó pero no llegó)", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "quiero cotizar mis estudios");
      const outId = (await rowsOf(p.key)).find((r) => r.direction === "OUT")!.id;
      await send(w, statusEvent(outId, p.phone, "sent"), SENT);
      await send(w, statusEvent(outId, p.phone, "failed"), statusHeader("failed"));
      expect((await rowsOf(p.key)).find((r) => r.direction === "OUT")!.state).toBe("FAILED");
    });

    it("mensajes consecutivos y agrupados (BATCHED): cada mensaje del lote se guarda en orden y la UNA respuesta del lote se guarda una sola vez", async () => {
      const p = patient();
      const w = setup();
      const ids = [id("a"), id("b"), id("c")];
      await send(w, batchOf(textEvent(ids[0]!, p.phone, "hemograma"), textEvent(ids[1]!, p.phone, "glucosa"), textEvent(ids[2]!, p.phone, "tsh")), BATCH);
      expect(w.sends).toHaveLength(1);
      const rows = await rowsOf(p.key);
      expect(rows.filter((r) => r.direction === "IN").map((r) => r.id).sort()).toEqual([...ids].sort());
      expect(rows.filter((r) => r.direction === "OUT")).toHaveLength(1);
      expect(rows.filter((r) => r.direction === "OUT")[0]!.reply_to).toBeTruthy();
      const texts = lines(await readAll(w, p.key));
      expect(texts.filter((line) => line.startsWith("IN/")).sort()).toEqual(["IN/PATIENT: glucosa", "IN/PATIENT: hemograma", "IN/PATIENT: tsh"]);
    });

    it("NO_REPLY: un agradecimiento que el agente no responde se guarda igual como mensaje del paciente, sin fila de respuesta", async () => {
      const p = patient();
      const w = setup();
      const message = await say(w, p.phone, "muchas gracias");
      expect(w.sends).toEqual([]);
      expect(await runOf(message)).toMatchObject({ processing_status: "IGNORED", error_code: "NO_REPLY" });
      expect((await rowsOf(p.key)).map((r) => [r.direction, r.state])).toEqual([["IN", "RECEIVED"]]);
    });

    it("HUMAN_PAUSED: la recepción escribe (se guarda como HUMANO, con su texto), el agente se pausa, y los mensajes siguientes del paciente se guardan SIN respuesta del agente", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, "quiero cotizar mis estudios");
      await send(w, humanEvent(id("human"), p.phone, `Hola, le atendemos ${SENTINEL}`), SENT);
      const before = w.sends.length;
      await say(w, p.phone, "cotiza hemograma por favor");
      expect(w.sends).toHaveLength(before);
      expect(w.logs.some(([event, data]) => event === "duplicate_ignored" && data.processingStatus === "HUMAN_PAUSED")).toBe(true);
      const rows = await rowsOf(p.key);
      expect(rows.map((r) => `${r.direction}/${r.actor}`)).toEqual(["IN/PATIENT", "OUT/AGENT", "OUT/HUMAN", "IN/PATIENT"]);
      expect(lines(await readAll(w, p.key))).toContain(`OUT/HUMAN: Hola, le atendemos ${SENTINEL}`);
      // La recepción nunca se confunde con el agente.
      expect(rows.filter((r) => r.actor === "AGENT")).toHaveLength(1);
    });

    it("DAILY_CAP: la respuesta cancelada por el tope NO se guarda (nunca se envió); el mensaje del paciente sí", async () => {
      const p = patient();
      const w = setup({ dailyCap: { max: 1, windowSeconds: 86_400 } });
      await say(w, p.phone, "quiero cotizar mis estudios");
      const message = await say(w, p.phone, "a qué hora abren");
      expect(w.sends).toHaveLength(1);
      expect(await runOf(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "DAILY_CAP" });
      expect((await rowsOf(p.key)).map((r) => `${r.direction}/${r.actor}`)).toEqual(["IN/PATIENT", "OUT/AGENT", "IN/PATIENT"]);
    });

    it("audio transcrito: se guarda el audio (tipo y referencia del medio, jamás el enlace) con su transcripción cifrada, y la respuesta del agente", async () => {
      const p = patient();
      const w = setup({ audio: true, transcript: `quiero un hemograma ${SENTINEL}` });
      const message = id("aud");
      await send(w, batchOf(audioEvent(message, p.phone, "A")), BATCH);
      expect(w.sends.length).toBeGreaterThanOrEqual(1);
      const rows = await rowsOf(p.key);
      expect(rows[0]).toMatchObject({ direction: "IN", kind: "AUDIO", type: "audio", media: "media-A", has_text: true, id: message });
      expect(lines(await readAll(w, p.key))[0]).toBe(`IN/PATIENT: quiero un hemograma ${SENTINEL}`);
      expect(await db.ok(`select string_agg(to_json(h)::text, ' ') from public.plusmedik_message_history h where contact_key = '${p.key}'`)).not.toMatch(/http|kapso\.ai|fbsbx|whatsapp\.net/);
      expect(rows.filter((r) => r.direction === "OUT").length).toBeGreaterThanOrEqual(1);
    });

    it("audio sin transcripción disponible: queda el registro del audio sin texto (y no se inventa nada)", async () => {
      const p = patient();
      const w = setup({ audio: false });
      const message = id("aud");
      await send(w, audioEvent(message, p.phone, "B"));
      const rows = await rowsOf(p.key);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "AUDIO", media: "media-B", has_text: false });
      const exported = await readAll(w, p.key);
      expect(exported[0]).toMatchObject({ textStatus: "NONE" });
      expect(w.sends).toEqual([]);
    });

    it("imagen: se guarda el tipo, la referencia del medio y el pie (cifrado), jamás el enlace; y la cotización enviada como respuesta del agente", async () => {
      const p = patient();
      const w = setup({ sessions: false, attention: false });
      const message = id("img");
      await send(w, imageEvent(message, p.phone, "IMG1"));
      expect(w.sends).toHaveLength(1);
      const rows = await rowsOf(p.key);
      expect(rows[0]).toMatchObject({ direction: "IN", kind: "IMAGE", type: "image", media: "IMG1", has_text: true });
      expect(rows[1]).toMatchObject({ direction: "OUT", actor: "AGENT", reply_to: message });
      const read = await readAll(w, p.key);
      expect(read[0]!.text).toBe("mi receta");
      expect(read[1]!.text).toContain("HEMOGRAMA COMPLETO");
      expect(await db.ok(`select string_agg(to_json(h)::text, ' ') from public.plusmedik_message_history h where contact_key = '${p.key}'`)).not.toMatch(/example\.test|\.jpg|http/);
    });

    it("envío incierto (Kapso falló sin saberse si salió): queda como UNCERTAIN con un id propio; sin id del proveedor, la respuesta aceptada queda ACCEPTED", async () => {
      const a = patient();
      const failing = setup({ sendText: async () => { throw new Error(`falla ${SENTINEL}`); } });
      const message = await say(failing, a.phone, "quiero cotizar mis estudios");
      expect((await rowsOf(a.key)).filter((r) => r.direction === "OUT")).toMatchObject([{ state: "UNCERTAIN", id: `uncertain:${message}`, reply_to: message }]);
      expect(JSON.stringify(failing.logs)).not.toContain(SENTINEL);
      const b = patient();
      const noId = setup({ sendText: async () => undefined });
      const second = await say(noId, b.phone, "quiero cotizar mis estudios");
      expect((await rowsOf(b.key)).filter((r) => r.direction === "OUT")).toMatchObject([{ state: "ACCEPTED", id: `reply:${second}` }]);
    });

    it("alcance: un contacto fuera de ALLOWED_PHONES no se guarda ni se atiende", async () => {
      const inside = patient();
      const outside = patient();
      const w = setup({ allowedPhones: inside.phone });
      await say(w, outside.phone, "quiero cotizar mis estudios");
      await say(w, inside.phone, "quiero cotizar mis estudios");
      expect(await rowsOf(outside.key)).toEqual([]);
      expect((await rowsOf(inside.key)).map((r) => r.direction)).toEqual(["IN", "OUT"]);
    });

    it("lo reimportado del historial de WhatsApp (history_sync) y los mensajes de otra línea no se guardan", async () => {
      const p = patient();
      const w = setup();
      const sync = textEvent(id("sync"), p.phone, "mensaje viejo importado");
      sync.message.kapso.origin = "history_sync";
      await send(w, sync);
      const otherLine = { ...textEvent(id("otra"), p.phone, "otra línea"), phone_number_id: "OTRA_LINEA", conversation: { ...conversation(p.phone), phone_number_id: "OTRA_LINEA" } };
      await send(w, otherLine);
      // Ningún mensaje ENTRANTE se guarda (ni el importado ni el de otra línea). Lo que el agente responda sí queda, porque el envío lo hace el agente desde su línea (comportamiento previo, sin cambios).
      expect((await rowsOf(p.key)).filter((r) => r.direction === "IN")).toEqual([]);
      expect(await db.ok(`select count(*) from public.plusmedik_message_history where provider_message_id like 'wamid.sync-%' or provider_message_id like 'wamid.otra-%'`)).toBe("0");
    });
  });

  // ───────────────────────────── fallos y apagado ─────────────────────────────

  describe("fallos del historial y apagado por defecto", () => {
    it("si Supabase falla al escribir el historial: el agente responde IGUAL, queda un código en el registro, y la conciliación (gaps) lista exactamente lo que faltó", async () => {
      const p = patient();
      const w = setup();
      w.network.downFor.add("plusmedik_history_record");
      const message = await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.medical_unavailable }]);
      expect(await runOf(message)).toMatchObject({ processing_status: "COMPLETED", send_state: "ACCEPTED" });
      expect(await rowsOf(p.key)).toEqual([]);
      expect(w.logs.filter(([event]) => event === "message_history_write_failed").map(([, data]) => data.op).sort()).toEqual(["OBSERVE", "OUT"]);
      expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
      const outId = (await runOf(message)).kapso_outbound_message_id as string;
      const gaps = await w.store.gaps({ since: new Date(Date.now() - 3_600_000), limit: 1000 });
      expect(gaps.inbound).toContain(message);
      expect(gaps.outbound).toContain(outId);
      // Al recuperarse la base, lo siguiente se guarda; y lo que ya está registrado deja de aparecer como faltante.
      w.network.downFor.clear();
      const next = await say(w, p.phone, "a qué hora abren");
      const after = await w.store.gaps({ since: new Date(Date.now() - 3_600_000), limit: 1000 });
      expect(after.inbound).not.toContain(next);
      expect(after.inbound).toContain(message);
    });

    it("APAGADO por defecto: sin la dependencia no hay ni una llamada al historial, ninguna fila, y el agente responde igual", async () => {
      const p = patient();
      const w = setup({ history: false });
      await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      await send(w, humanEvent(id("human"), p.phone), SENT);
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.medical_unavailable }]);
      expect(w.network.calls.filter((name) => name.startsWith("plusmedik_history"))).toEqual([]);
      expect(await rowsOf(p.key)).toEqual([]);
      expect(w.logs.some(([event]) => event.startsWith("message_history"))).toBe(false);
    });

    it("el historial NO cambia lo que el agente responde: la misma conversación con y sin historial envía exactamente los mismos textos", async () => {
      const script = ["quiero cotizar mis estudios", "a qué hora abren", "me duele el pecho", "hemograma", "glucosa", "listo"];
      const run = async (history: boolean) => {
        const w = setup({ history });
        const p = patient();
        for (const body of script) await say(w, p.phone, body);
        return w.sends.map((s) => s.body);
      };
      expect(await run(true)).toEqual(await run(false));
    });
  });

  // ───────────────────────────── aislamiento y exportación ─────────────────────────────

  describe("aislamiento y exportación autorizada", () => {
    it("cada contacto ve solo lo suyo; y una fila cifrada pasada a otro contacto NO se puede leer (el contacto va como dato autenticado)", async () => {
      const a = patient();
      const b = patient();
      const w = setup();
      await say(w, a.phone, `me duele el pecho A-${SENTINEL}`);
      await say(w, b.phone, "a qué hora abren");
      expect(lines(await readAll(w, a.key)).join("|")).not.toContain(DRAFT_TEXTS.handoff_unavailable);
      expect((await readAll(w, a.key)).every((m) => m.contactKey === a.key)).toBe(true);
      expect((await readAll(w, b.key)).every((m) => m.contactKey === b.key)).toBe(true);
      const all = await readAll(w);
      expect(new Set(all.map((m) => m.contactKey))).toEqual(new Set([...all.map((m) => m.contactKey)]));
      // Manipulación: se copia el cifrado de A sobre la fila de B.
      const aCipher = await db.ok(`select body_cipher from public.plusmedik_message_history where contact_key = '${a.key}' and direction = 'IN'`);
      await db.ok(`update public.plusmedik_message_history set body_cipher = '${aCipher}' where contact_key = '${b.key}' and direction = 'IN'`);
      expect((await readAll(w, b.key)).find((m) => m.direction === "IN")).toMatchObject({ textStatus: "UNREADABLE" });
      expect((await readAll(w, b.key)).find((m) => m.direction === "IN")!.text).toBeUndefined();
    });

    it("la clave equivocada no descifra (UNREADABLE) y una clave rotada sigue leyendo lo anterior por su huella", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      expect((await readAll(w, p.key, [OTHER_KEY])).map((m) => m.textStatus)).toEqual(["UNREADABLE", "UNREADABLE"]);
      expect((await readAll(w, p.key, [OTHER_KEY, HISTORY_KEY])).map((m) => m.textStatus)).toEqual(["OK", "OK"]);
    });

    it("exportar exige un motivo, y cada exportación deja un rastro SIN contenido (qué contacto, cuántas filas, por qué)", async () => {
      const p = patient();
      const w = setup();
      await say(w, p.phone, `me duele el pecho ${SENTINEL}`);
      await expect(w.store.exportPage({ reason: "corto", contactKey: p.key })).rejects.toBeTruthy();
      expect(await db.fails(asService(`select public.plusmedik_history_export('   ', null, null, null, null, 10)`))).toMatch(/PT422/);
      const before = Number(await db.ok(`select count(*) from public.plusmedik_message_history_access`));
      await readAll(w, p.key);
      const access = JSON.parse(await db.ok(`select coalesce(json_agg(a order by a.at desc), '[]') from public.plusmedik_message_history_access a`)) as Array<Record<string, any>>;
      expect(access.length).toBe(before + 1);
      expect(access[0]).toMatchObject({ operation: "EXPORT", reason: "revisión de la prueba automática", contact_key: p.key, row_count: 2 });
      expect(JSON.stringify(access)).not.toContain(SENTINEL);
    });

    it("la exportación pagina en orden cronológico sin repetir ni saltar filas, y filtra por ventana de tiempo", async () => {
      const p = patient();
      const w = setup();
      for (const body of ["quiero cotizar mis estudios", "a qué hora abren", "quiero hablar con una persona"]) await say(w, p.phone, body);
      const paged: number[] = [];
      for await (const message of exportHistory({ store: w.store, accountId: LAB, keys: [HISTORY_KEY], reason: "paginación de la prueba", contactKey: p.key, pageSize: 2 })) paged.push(message.seq);
      expect(paged).toHaveLength(6);
      expect([...paged].sort((x, y) => x - y)).toEqual(paged);
      expect(new Set(paged).size).toBe(6);
      const future = new Date(Date.now() + 3_600_000);
      expect(await readAllWindow(w, p.key, future, undefined)).toEqual([]);
      expect((await readAllWindow(w, p.key, new Date(Date.now() - 3_600_000), future)).length).toBe(6);
    });

    async function readAllWindow(w: World, key: string, from: Date, to: Date | undefined): Promise<ExportedMessage[]> {
      const out: ExportedMessage[] = [];
      for await (const message of exportHistory({ store: w.store, accountId: LAB, keys: [HISTORY_KEY], reason: "ventana de la prueba", contactKey: key, from, ...(to ? { to } : {}) })) out.push(message);
      return out;
    }

    it("supresión: borra solo lo de ese contacto, exige un motivo y deja rastro", async () => {
      const a = patient();
      const b = patient();
      const w = setup();
      await say(w, a.phone, "quiero cotizar mis estudios");
      await say(w, b.phone, "quiero cotizar mis estudios");
      await expect(w.store.erase({ contactKey: a.key, reason: "corto" })).rejects.toBeTruthy();
      expect(await w.store.erase({ contactKey: a.key, reason: "solicitud de supresión del paciente" })).toBe(2);
      expect(await rowsOf(a.key)).toEqual([]);
      expect(await rowsOf(b.key)).toHaveLength(2);
      expect(await db.ok(`select operation || ':' || row_count from public.plusmedik_message_history_access where contact_key = '${a.key}' order by at desc limit 1`)).toBe("ERASE:2");
    });
  });

  // ───────────────────────────── funciones de la base ─────────────────────────────

  describe("migración 21 (funciones de la base)", () => {
    const CIPHER = "v1.aaaa.bbbb.cccc";
    const record = (o: { contact: string; messageId: string; direction?: string; actor?: string; kind?: string; cipher?: string | null; state?: string; days?: number | null; at?: string; account?: string; keyId?: string | null }) => {
      const direction = o.direction ?? "IN";
      const cipher = o.cipher === undefined ? CIPHER : o.cipher;
      const keyId = o.keyId === undefined ? (cipher ? "abcd1234" : null) : o.keyId;
      return `select public.plusmedik_history_record('${o.account ?? LAB}', '${o.contact}', '${o.messageId}', '${direction}', '${o.actor ?? (direction === "IN" ? "PATIENT" : "AGENT")}', null, '${o.kind ?? "TEXT"}', 'text', ${cipher ? `'${cipher}'` : "null"}, ${keyId ? `'${keyId}'` : "null"}, null, '${o.state ?? (direction === "IN" ? "RECEIVED" : "ACCEPTED")}', null, null, ${o.at ? `'${o.at}'::timestamptz` : "now()"}, ${o.days === undefined ? 30 : o.days === null ? "null" : o.days})::text`;
    };
    const key = () => String(++counter).padStart(64, "0");
    const call = async (sql: string) => JSON.parse(await db.ok(asService(sql))) as Record<string, any>;

    it("RLS activo; nadie (ni service_role) toca las tablas directamente; solo service_role ejecuta las funciones (SECURITY DEFINER con search_path vacío)", async () => {
      for (const table of ["plusmedik_message_history", "plusmedik_message_history_access"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        for (const role of ["anon", "authenticated", "service_role", "unprivileged"]) {
          for (const privilege of ["select", "insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', '${privilege}')`), `${role} ${table} ${privilege}`).toBe("f");
        }
        expect(await db.fails(asService(`select * from public.${table}`))).toMatch(/permission denied/);
      }
      const signatures = [
        "plusmedik_history_record(text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer)", "plusmedik_history_attach_text(text, text, text, text, text)",
        "plusmedik_history_delivery(text, text, text, timestamptz)", "plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer)", "plusmedik_history_erase(text, text)",
        "plusmedik_history_purge(integer)", "plusmedik_history_gaps(timestamptz, integer)"
      ];
      for (const signature of signatures) {
        expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toBe("t");
        expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toContain("search_path=");
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`), signature).toBe("t");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`), `${role} ${signature}`).toBe("f");
      }
    });

    it("rechaza lo inválido con PT422: clave de contacto, dirección/actor incoherentes, estado incoherente, cifrado sin huella, formato, retención fuera de rango", async () => {
      const c = key();
      for (const [label, sql] of [
        ["contacto corto", record({ contact: "abc", messageId: "wamid.v1" })],
        ["dirección", record({ contact: c, messageId: "wamid.v2", direction: "SIDEWAYS" })],
        ["paciente saliente", record({ contact: c, messageId: "wamid.v3", direction: "OUT", actor: "PATIENT" })],
        ["agente entrante", record({ contact: c, messageId: "wamid.v4", direction: "IN", actor: "AGENT" })],
        ["estado entrante inválido", record({ contact: c, messageId: "wamid.v5", direction: "IN", state: "ACCEPTED" })],
        ["cifrado sin huella", record({ contact: c, messageId: "wamid.v6", keyId: null })],
        ["huella sin cifrado", record({ contact: c, messageId: "wamid.v7", cipher: null, keyId: "abcd1234" })],
        ["cifrado con texto en claro", record({ contact: c, messageId: "wamid.v8", cipher: "hola en claro" })],
        ["id con espacios", record({ contact: c, messageId: "wamid con espacios" })],
        ["retención 0", record({ contact: c, messageId: "wamid.v9", days: 0 })],
        ["retención 3651", record({ contact: c, messageId: "wamid.v10", days: 3651 })]
      ] as const) expect(await db.fails(asService(sql)), label).toMatch(/PT422|violates check|invalid/);
      expect(Number(await db.ok(`select count(*) from public.plusmedik_message_history where contact_key = '${c}'`))).toBe(0);
    });

    it("idempotente por (proveedor, línea, mensaje): repetir no cambia nada; la misma identificación en otra línea sí es otro mensaje", async () => {
      const c = key();
      expect((await call(record({ contact: c, messageId: "wamid.dup" }))).outcome).toBe("recorded");
      expect((await call(record({ contact: c, messageId: "wamid.dup", cipher: "v1.zzzz.yyyy.xxxx" }))).outcome).toBe("duplicate");
      expect(await db.ok(`select body_cipher from public.plusmedik_message_history where contact_key = '${c}'`)).toBe(CIPHER);
      expect((await call(record({ contact: c, messageId: "wamid.dup", account: "999" }))).outcome).toBe("recorded");
    });

    it("estado de entrega: solo avanza; un mensaje entrante o inexistente no se toca", async () => {
      const c = key();
      await call(record({ contact: c, messageId: "wamid.d-out", direction: "OUT" }));
      await call(record({ contact: c, messageId: "wamid.d-in" }));
      const delivery = (messageId: string, state: string) => call(`select public.plusmedik_history_delivery('${LAB}', '${messageId}', '${state}', now())::text`);
      expect((await delivery("wamid.d-out", "DELIVERED")).outcome).toBe("updated");
      expect((await delivery("wamid.d-out", "SENT")).outcome).toBe("noop");
      expect((await delivery("wamid.d-out", "FAILED")).outcome).toBe("noop");
      expect((await delivery("wamid.d-out", "READ")).outcome).toBe("updated");
      expect((await delivery("wamid.d-in", "READ")).outcome).toBe("missing");
      expect((await delivery("wamid.nada", "READ")).outcome).toBe("missing");
      expect(await db.ok(`select delivery_state from public.plusmedik_message_history where provider_message_id = 'wamid.d-out'`)).toBe("READ");
      expect(await db.fails(asService(`select public.plusmedik_history_delivery('${LAB}', 'wamid.d-out', 'RECEIVED', now())`))).toMatch(/PT422/);
    });

    it("la transcripción solo se agrega a un AUDIO entrante que aún no tiene texto, y nunca reemplaza", async () => {
      const c = key();
      await call(record({ contact: c, messageId: "wamid.t-audio", kind: "AUDIO", cipher: null }));
      await call(record({ contact: c, messageId: "wamid.t-text" }));
      const attach = (messageId: string, cipher: string) => call(`select public.plusmedik_history_attach_text('${LAB}', '${c}', '${messageId}', '${cipher}', 'abcd1234')::text`);
      expect((await attach("wamid.t-audio", "v1.uno.dos.tres")).outcome).toBe("updated");
      expect((await attach("wamid.t-audio", "v1.otro.otro.otro")).outcome).toBe("noop");
      expect((await attach("wamid.t-text", "v1.uno.dos.tres")).outcome).toBe("noop");
      expect((await attach("wamid.nada", "v1.uno.dos.tres")).outcome).toBe("missing");
      expect(await db.ok(`select body_cipher from public.plusmedik_message_history where provider_message_id = 'wamid.t-audio'`)).toBe("v1.uno.dos.tres");
      // De otro contacto no se puede escribir.
      expect((await call(`select public.plusmedik_history_attach_text('${LAB}', '${key()}', 'wamid.t-audio', 'v1.x.y.z', 'abcd1234')::text`)).outcome).toBe("missing");
      expect(await db.ok(`select body_cipher from public.plusmedik_message_history where provider_message_id = 'wamid.t-audio'`)).toBe("v1.uno.dos.tres");
    });

    it("retención: lo vencido no se exporta, se purga al escribir (acotado) y con la purga explícita", async () => {
      const c = key();
      await call(record({ contact: c, messageId: "wamid.r-old", days: 1 }));
      await call(record({ contact: c, messageId: "wamid.r-new", days: 30 }));
      await db.ok(`update public.plusmedik_message_history set expires_at = clock_timestamp() - interval '1 minute', occurred_at = clock_timestamp() - interval '2 days' where provider_message_id = 'wamid.r-old'`);
      const page = await call(`select public.plusmedik_history_export('revisión de retención', '${c}', null, null, null, 100)::text`);
      expect(page.rows.map((row: { message_id: string }) => row.message_id)).toEqual(["wamid.r-new"]);
      expect(Number(await db.ok(`select count(*) from public.plusmedik_message_history where provider_message_id = 'wamid.r-old'`))).toBe(1);
      await call(record({ contact: c, messageId: "wamid.r-trigger" }));
      expect(Number(await db.ok(`select count(*) from public.plusmedik_message_history where provider_message_id = 'wamid.r-old'`))).toBe(0);
      await call(record({ contact: c, messageId: "wamid.r-old2", days: 1 }));
      await db.ok(`update public.plusmedik_message_history set expires_at = clock_timestamp() - interval '1 minute', occurred_at = clock_timestamp() - interval '2 days' where provider_message_id = 'wamid.r-old2'`);
      expect((await call(`select public.plusmedik_history_purge(100)::text`)).deleted).toBeGreaterThanOrEqual(1);
      expect(Number(await db.ok(`select count(*) from public.plusmedik_message_history where provider_message_id = 'wamid.r-old2'`))).toBe(0);
    });

    it("SIN VENCIMIENTO por defecto: lo que se guarda sin retención nunca vence, ni se purga ni se deja de exportar aunque pasen los años", async () => {
      const c = key();
      await call(record({ contact: c, messageId: "wamid.forever", days: null }));
      expect(await db.ok(`select expires_at is null from public.plusmedik_message_history where provider_message_id = 'wamid.forever'`)).toBe("t");
      await db.ok(`update public.plusmedik_message_history set occurred_at = clock_timestamp() - interval '10 years', created_at = clock_timestamp() - interval '10 years' where provider_message_id = 'wamid.forever'`);
      await call(record({ contact: c, messageId: "wamid.forever-trigger", days: null }));
      expect((await call(`select public.plusmedik_history_purge(10000)::text`)).deleted).toBeGreaterThanOrEqual(0);
      expect(Number(await db.ok(`select count(*) from public.plusmedik_message_history where provider_message_id = 'wamid.forever'`))).toBe(1);
      const page = await call(`select public.plusmedik_history_export('revisión sin vencimiento', '${c}', null, null, null, 100)::text`);
      expect(page.rows.map((row: { message_id: string }) => row.message_id)).toContain("wamid.forever");
    });

    it("la fecha del mensaje no puede estar en el futuro (se acota a ahora), y la retención configurada se aplica", async () => {
      const c = key();
      await call(record({ contact: c, messageId: "wamid.f1", at: "2999-01-01T00:00:00Z", days: 7 }));
      expect(await db.ok(`select occurred_at <= clock_timestamp() from public.plusmedik_message_history where provider_message_id = 'wamid.f1'`)).toBe("t");
      expect(await db.ok(`select expires_at - created_at between interval '6 days 23 hours' and interval '7 days 1 hour' from public.plusmedik_message_history where provider_message_id = 'wamid.f1'`)).toBe("t");
    });

    it("conciliación: solo lista lo que la auditoría procesó o respondió y falta en el historial; sin contenido", async () => {
      const gaps = await call(`select public.plusmedik_history_gaps(now() - interval '1 day', 1000)::text`);
      expect(Object.keys(gaps).sort()).toEqual(["inbound_missing", "outbound_missing"]);
      expect(JSON.stringify(gaps)).not.toContain(SENTINEL);
    });
  });
});
