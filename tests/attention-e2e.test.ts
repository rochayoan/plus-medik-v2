import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import { createReplyGate, createRepeatTracker, type AttentionConfig } from "../src/attention-filter.js";
import { normalizeStudyKey } from "../src/consensus.js";
import type { ConversationModel } from "../src/conversation-model.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Atención selectiva (G6.0) de extremo a extremo: webhook real + manejador de texto real + sesiones reales + PostgreSQL real con TODAS las migraciones. Kapso, el catálogo y el modelo son simulaciones;
// no se llama a ningún modelo. Estudios y precios son fixtures de PRUEBA.

const bin = findPostgresBin();
if (!bin) console.warn("[attention-e2e] PostgreSQL no disponible: se omiten los escenarios de atención selectiva contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_6633";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const CATALOG = (): CatalogStudy[] => [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(4, "TSH", ["tsh"], 80), study(7, "CREATININA SERICA", ["creatinina"], 20), study(8, "CREATININA EN ORINA", ["creatinina"], 22)];

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

describe.skipIf(!bin)("atención selectiva de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("attention_extremo");
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

  interface Options { attention?: boolean; settleMs?: number; conversation?: ConversationModel }
  function setup(options: Options = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const attention: AttentionConfig | undefined = options.attention === false ? undefined : { repeats: createRepeatTracker({ windowMs: 90_000 }), gate: createReplyGate(), settleMs: options.settleMs ?? 0 };
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: new Uint8Array(0) })),
      loadCatalog: vi.fn(async () => CATALOG()),
      analyze: vi.fn(),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400, attention,
        handlers: { text: createTextHandler({ log, attention: attention !== undefined, ...(options.conversation ? { conversation: options.conversation } : {}) }) },
        quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ...(attention ? { attention: { gate: attention.gate, settleMs: attention.settleMs } } : {}), ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] })
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, scheduled, quote, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    await send(w, textEvent(message, phone, body));
    return message;
  };
  const last = (w: World) => w.sends.at(-1)!.body;
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const runsOf = async (key: string): Promise<number> => Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${key}'`));

  it("saludos, gracias y emoji: NADA se envía, cada turno queda cerrado como «sin respuesta» y el texto no se guarda en ninguna parte", async () => {
    const w = setup();
    const p = patient();
    const messages = [await say(w, p.phone, "Hola"), await say(w, p.phone, "muchas gracias"), await say(w, p.phone, "👍")];
    expect(w.sends).toEqual([]);
    for (const message of messages) expect(await run(message)).toMatchObject({ processing_status: "IGNORED", send_state: "NOT_APPLICABLE", reply_state: "NOT_ATTEMPTED", error_code: "NO_REPLY" });
    expect(JSON.stringify(w.logs)).not.toMatch(/muchas gracias|Hola/);
    expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where to_json(plusmedik_audit_runs)::text like '%muchas gracias%'`)).toBe("0");
  });

  it("el mismo mensaje repetido: el segundo ni siquiera se reclama (no hay turno en la base) y no se responde otra vez", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "quiero cotizar mis estudios");
    const before = await runsOf(p.key);
    await say(w, p.phone, "Quiero cotizar mis estudios!");
    expect(await runsOf(p.key)).toBe(before);
    expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.send_recipe]);
  });

  it("flujo completo: lista → «agrega glucosa» → «eso nomás» → cotización con precios del catálogo → «gracias» sin respuesta → otra cotización nueva", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "hemograma");
    expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO.");
    await say(w, p.phone, "agrega glucosa");
    expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO, GLUCOSA EN AYUNAS.");
    await say(w, p.phone, "eso nomás");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(last(w)).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
    expect(last(w)).toContain("Total de los estudios cotizados: Bs 75,50");
    const quoted = w.sends.length;
    await say(w, p.phone, "gracias");
    await say(w, p.phone, "listo");
    expect(w.sends).toHaveLength(quoted);
    await say(w, p.phone, "cotiza tsh");
    expect(last(w)).toContain("TSH — Bs 80");
    expect(last(w)).not.toContain("HEMOGRAMA");
  });

  it("G6.1: el silencio no toca la solicitud abierta (sigue OPEN con todos sus ítems); solo «sí, esos estudios» la cierra", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "hemograma");
    await say(w, p.phone, "agrega glucosa");
    const before = w.sends.length;
    const state = async () => JSON.parse(await db.ok(`select json_build_object('status', s.status, 'items', (select count(*) from public.plusmedik_quote_items i where i.session_id = s.id)) from public.plusmedik_quote_sessions s where s.contact_key = '${p.key}' order by s.created_at desc limit 1`));
    const open = await state();
    expect(open).toMatchObject({ status: "OPEN", items: 2 });
    for (const body of ["Hola", "gracias", "ok gracias", "👍", "perfecto", "dale", "vale", "muchas gracias, qué amable"]) await say(w, p.phone, body);
    expect(w.sends).toHaveLength(before);
    expect(await state()).toEqual(open);
    await say(w, p.phone, "sí, esos estudios");
    expect(last(w)).toContain("Total de los estudios cotizados: Bs 75,50");
    expect(await state()).toMatchObject({ status: "QUOTED", items: 2 });
  });

  it("G6.1: tras el silencio, un saludo con solicitud se atiende; y la solicitud abierta se suma a ella", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "hemograma");
    await say(w, p.phone, "gracias");
    await say(w, p.phone, "Hola, cotízame glucosa");
    expect(last(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(last(w)).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
  });

  it("«¿cuánto sería todo?» y «el segundo» se entienden con la solicitud abierta", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "hemograma y creatinina");
    expect(last(w)).toMatch(/1\. CREATININA SERICA( — Bs [\d,]+)?\n2\. CREATININA EN ORINA/);
    await say(w, p.phone, "el segundo");
    expect(last(w)).toContain("Estudios anotados: HEMOGRAMA COMPLETO, CREATININA EN ORINA.");
    await say(w, p.phone, "¿cuánto sería todo?");
    expect(last(w)).toContain("Total de los estudios cotizados: Bs 67");
  });

  it("varios mensajes seguidos: los tres quedan en la solicitud y solo se confirma UNA vez con todo", async () => {
    const w = setup({ settleMs: 400 });
    const p = patient();
    // llegan casi a la vez (tres webhooks en paralelo), como cuando el paciente escribe de corrido
    await Promise.all([
      w.hook(signedPost(textEvent(id("a"), p.phone, "hemograma"), RECEIVED)),
      w.hook(signedPost(textEvent(id("b"), p.phone, "glucosa"), RECEIVED)),
      w.hook(signedPost(textEvent(id("c"), p.phone, "tsh"), RECEIVED))
    ]);
    await w.settle();
    expect(w.sends).toHaveLength(1);
    // el orden de la lista es el de llegada a la base (tres webhooks en paralelo), no el que se escribió; lo que importa es que estén los tres en UNA sola confirmación
    for (const name of ["HEMOGRAMA COMPLETO", "GLUCOSA EN AYUNAS", "TSH"]) expect(w.sends[0]!.body).toContain(name);
    await say(w, p.phone, "listo");
    expect(last(w)).toContain("Total de los estudios cotizados: Bs 155,50");
  });

  it("pausa humana y excepciones: el filtro no las altera (una pausa sigue callando; lo médico y lo humano siguen su camino)", async () => {
    const w = setup();
    const p = patient();
    await say(w, p.phone, "me duele el pecho, gracias");
    expect(last(w)).toBe(DRAFT_TEXTS.medical_unavailable);
    await say(w, p.phone, "gracias, quiero hablar con una persona");
    expect(last(w)).toBe(DRAFT_TEXTS.handoff_unavailable);
    const before = w.sends.length;
    await send(w, humanEvent(id("human"), p.phone), SENT);
    await say(w, p.phone, "cotiza hemograma");
    expect(w.sends).toHaveLength(before);
  });

  it("el modelo (simulado) recibe solo cantidades del estado real de la base, y una consulta desconocida lo consulta una sola vez", async () => {
    const reply = vi.fn(async (_input: { text: string; category: string; context?: unknown }) => ({ status: "REPLY" as const, body: "Con gusto, dime qué necesitas.", intent: "SMALL_TALK" as const }));
    const model = { categories: new Set(["GREETING", "OTHER"]), businessInfo: false, reply } as unknown as ConversationModel;
    const w = setup({ conversation: model });
    const p = patient();
    await say(w, p.phone, "hemograma y glucosa");
    await say(w, p.phone, "gracias");
    await say(w, p.phone, "no entiendo cómo funciona esto");
    expect(reply).toHaveBeenCalledTimes(1);
    const input = reply.mock.calls[0]![0];
    expect(input.context).toEqual({ openRequest: true, openStudies: 2, openDoubt: false, recentQuoteStudies: 0 });
    expect(JSON.stringify(input)).not.toMatch(/HEMOGRAMA|GLUCOSA|hemograma/);
    expect(last(w)).toBe("Con gusto, dime qué necesitas.");
  });

  it("CONTROL: con el filtro apagado todo se responde como antes", async () => {
    const w = setup({ attention: false });
    const p = patient();
    await say(w, p.phone, "hola");
    await say(w, p.phone, "gracias");
    expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.greeting, DRAFT_TEXTS.fallback]);
  });
});
