import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReplyGate, createRepeatTracker, type AttentionConfig } from "../src/attention-filter.js";
import { createSupabaseAuditRepository, createSupabaseRpc } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { createConversationReader, createSupabaseConversationStore, resolveConversationState, type ConversationRecorder } from "../src/conversation-state-store.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { createMessageHistory, createSupabaseHistoryStore } from "../src/message-history.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Memoria estructurada en SOMBRA (Fase 1 del plan G7, migración 24) de extremo a extremo: webhook REAL + turnos REALES + manejador de texto REAL + repositorios REALES + PostgreSQL REAL con TODAS las
// migraciones. Solo se simulan Kapso (envíos), OpenAI, el catálogo y el motor de recetas. Lo central: encendida u apagada, el agente responde EXACTAMENTE igual; la sombra solo anota.

const bin = findPostgresBin();
if (!bin) console.warn("[conversation-state-e2e] PostgreSQL no disponible: se omiten los escenarios de la memoria en sombra contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_7741";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const CATALOG = (): CatalogStudy[] => [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(4, "TSH", ["tsh"], 80)];
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
// Misma forma que usa la prueba del historial: una receta que se cotiza sola.
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", quote: { lines: [{ id: uuid(1), code: null, name: "HEMOGRAMA COMPLETO", priceBs: 45 }], totalBs: 45, tariff: "PACIENTE" }, publicQuote: { studies: [{ name: "HEMOGRAMA COMPLETO", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: { ...inbound } }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: nowSeconds(), type: "image", from: phone, image: { id: tag, caption: "mi receta" }, kapso: { ...inbound, has_media: true, media_url: `https://example.test/${tag}.jpg` } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string, body = "Hola, le atiende recepción") => ({ message: { id, timestamp: nowSeconds(), type: "text", to: phone, text: { body }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

describe.skipIf(!bin)("memoria estructurada en sombra de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("conversation_shadow");
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

  interface Options { shadow?: boolean; sessions?: boolean; attention?: boolean; sendText?: (to: string, body: string) => Promise<void | { providerMessageId?: string }> }
  function setup(options: Options = {}) {
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const history = createMessageHistory({ store: createSupabaseHistoryStore({ rpc: createSupabaseRpc(rpcOptions()) }), accountId: LAB, contactKeyFor, log });
    const store = createSupabaseConversationStore({ rpc: createSupabaseRpc(rpcOptions()) });
    // La misma ruta que usa producción: la bandera decide si hay grabador.
    const convState: ConversationRecorder | undefined = resolveConversationState({ ...(options.shadow ? { PLUSMEDIK_LLM_CONVERSATION: "on" } : {}) }, log, { contactKeyFor, store });
    const attention: AttentionConfig | undefined = options.attention === false ? undefined : { repeats: createRepeatTracker({ windowMs: 90_000 }), gate: createReplyGate(), settleMs: 0 };
    const sessions = options.sessions !== false;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => CATALOG()),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(options.sendText ?? (async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}-${++counter}` }; })),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000, history,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400, ...(attention ? { attention } : {}), ...(convState ? { convState } : {}),
        handlers: { text: createTextHandler({ log, attention: attention !== undefined }) },
        ...(sessions ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ...(attention ? { attention: { gate: attention.gate, settleMs: attention.settleMs } } : {}), ownTexts: Object.values(DRAFT_TEXTS) }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, history, ...(convState ? { convState } : {}), humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, network, store, convState, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers: Record<string, string> = RECEIVED) => {
    const response = await w.hook(signedPost(event, headers));
    expect(response.status).toBe(200);
    await w.settle();
  };
  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    await send(w, textEvent(message, phone, body));
    return message;
  };
  const events = async (key: string): Promise<Array<{ event_key: string; kind: string; payload: Record<string, any> }>> =>
    JSON.parse(await db.ok(`select coalesce(json_agg(x order by x.occurred_at, x.seq), '[]') from (select event_key, kind, payload, seq, occurred_at from public.plusmedik_conv_events where contact_key = '${key}') x`));
  const stateOf = (w: World, key: string) => createConversationReader({ store: w.store }).stateOf(key);
  const runStatuses = async (phone: string) => (await db.ok(`select coalesce(string_agg(processing_status || ':' || coalesce(error_code, '-'), ',' order by created_at), '') from public.plusmedik_audit_runs where contact_key = '${contactKeyFor(phone)}'`));

  // ───────────────────────────── la sombra no cambia nada ─────────────────────────────

  describe("encendida o apagada, el agente hace lo mismo", () => {
    const SCRIPT = ["hola", "quiero cotizar mis estudios", "me duele el pecho", "a que hora abren", "gracias"];

    async function run(shadow: boolean) {
      const p = patient();
      const w = setup({ shadow });
      for (const body of SCRIPT) await say(w, p.phone, body);
      await send(w, imageEvent(id("img"), p.phone, "IMG1"));
      await send(w, humanEvent(id("human"), p.phone), SENT);
      await say(w, p.phone, "cotiza hemograma por favor");
      const history = (await db.ok(`select coalesce(string_agg(direction || '/' || actor || '/' || content_kind || '/' || delivery_state, ',' order by seq), '') from public.plusmedik_message_history where contact_key = '${p.key}'`));
      return { p, w, sends: w.sends.map((s) => s.body), statuses: await runStatuses(p.phone), history };
    }

    it("mismos envíos, mismas corridas de auditoría y mismo historial; sin llamadas ni registros nuevos salvo los plusmedik_conv_* y conv_state", async () => {
      const off = await run(false);
      const on = await run(true);
      expect(on.sends).toEqual(off.sends);
      expect(on.sends.length).toBeGreaterThanOrEqual(4);
      expect(on.statuses).toBe(off.statuses);
      expect(on.history).toBe(off.history);
      // llamadas a la base: las mismas, más las de la memoria
      const rpcs = (w: World) => w.network.calls.filter((name) => !name.startsWith("plusmedik_conv_"));
      const sorted = (list: string[]) => [...list].sort();
      expect(sorted(rpcs(on.w))).toEqual(sorted(rpcs(off.w)));
      expect(off.w.network.calls.some((name) => name.startsWith("plusmedik_conv_"))).toBe(false);
      expect(on.w.network.calls.filter((name) => name === "plusmedik_conv_append").length).toBeGreaterThan(0);
      // registros: apagada no agrega ninguno; encendida solo agrega conv_state*, conv_state_scope no existe aquí (lo registra api/kapso/webhook)
      const names = (w: World) => new Set(w.logs.map(([event]) => event));
      expect([...names(off.w)].filter((name) => name.startsWith("conv_state"))).toEqual([]);
      expect([...names(on.w)].filter((name) => !name.startsWith("conv_state"))).toEqual(expect.arrayContaining([...names(off.w)]));
      expect([...names(on.w)].filter((name) => !name.startsWith("conv_state") && !names(off.w).has(name))).toEqual([]);
      // apagada no deja ni una fila
      expect(await events(off.p.key)).toEqual([]);
      expect((await events(on.p.key)).length).toBeGreaterThan(5);
    });
  });

  // ───────────────────────────── qué anota ─────────────────────────────

  describe("qué anota la sombra", () => {
    it("una petición contestada con el texto fijo queda pendiente (con motivo); la cotización posterior de la receta la cierra", async () => {
      const p = patient();
      const w = setup({ shadow: true, sessions: false, attention: false });
      const first = await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.send_recipe]);
      let state = (await stateOf(w, p.key))!;
      expect(state.questions.map((q) => `${q.messageId === first}:${q.status}:${q.reason}`)).toEqual(["true:CARRIED:FIXED_REPLY_ONLY"]);
      expect(state.goals.map((g) => `${g.kind}:${g.status}`)).toEqual(["QUOTE:ACTIVE"]);

      const photo = id("img");
      await send(w, imageEvent(photo, p.phone, "IMG1"));
      expect(w.sends).toHaveLength(2);
      expect(w.sends[1]!.body).toContain("HEMOGRAMA COMPLETO");
      const stored = await events(p.key);
      expect(stored.map((e) => e.kind)).toEqual(["PATIENT_BATCH", "AGENT_REPLY", "PATIENT_BATCH", "ARTIFACT", "ARTIFACT", "AGENT_REPLY"]);
      const artifacts = stored.filter((e) => e.kind === "ARTIFACT").map((e) => e.payload.a);
      expect(artifacts.map((a) => a.k)).toEqual(["RECIPE", "QUOTE"]);
      expect(artifacts.every((a) => a.s.length === 1 && a.s[0] === uuid(1))).toBe(true);
      state = (await stateOf(w, p.key))!;
      expect(state.artifacts.map((a) => a.kind)).toEqual(["RECIPE", "QUOTE"]);
      expect(state.questions.map((q) => q.status)).toEqual(["ANSWERED", "ANSWERED"]);
      expect(state.goals.map((g) => g.status)).toEqual(["FULFILLED"]);
    });

    it("el mismo webhook entregado varias veces no duplica eventos (un lote, una respuesta) ni respuestas", async () => {
      const p = patient();
      const w = setup({ shadow: true });
      const event = textEvent(id("txt"), p.phone, "quiero cotizar mis estudios");
      await send(w, event);
      await send(w, event);
      await send(w, event);
      expect(w.sends).toHaveLength(1);
      expect((await events(p.key)).map((e) => e.kind)).toEqual(["PATIENT_BATCH", "AGENT_REPLY"]);
    });

    it("pausa humana: el mensaje de la recepción se anota, y lo que el paciente escribe después queda pospuesto como HUMAN_PAUSED sin respuesta del agente", async () => {
      const p = patient();
      const w = setup({ shadow: true });
      await say(w, p.phone, "quiero cotizar mis estudios");
      await send(w, humanEvent(id("human"), p.phone, `Hola, le atendemos ${SENTINEL}`), SENT);
      const before = w.sends.length;
      const later = await say(w, p.phone, "cotiza hemograma por favor");
      expect(w.sends).toHaveLength(before);
      const kinds = (await events(p.key)).map((e) => e.kind);
      expect(kinds).toEqual(["PATIENT_BATCH", "AGENT_REPLY", "HUMAN_MESSAGE", "PATIENT_BATCH"]);
      const state = (await stateOf(w, p.key))!;
      expect(state.holder).toBe("HUMAN");
      // la persona respondió antes: lo anterior queda atendido por la recepción; lo posterior espera, sin que el agente conteste
      expect(state.questions.map((q) => `${q.status}:${q.closedBy ?? q.reason}`)).toEqual(["ANSWERED:STAFF", "CARRIED:HUMAN_PAUSED"]);
      expect(state.questions[1]!.messageId).toBe(later);
      expect(JSON.stringify(await events(p.key))).not.toContain(SENTINEL);
    });

    it("un envío que Kapso no aceptó (incierto) NO cuenta como respuesta: la pregunta sigue abierta", async () => {
      const p = patient();
      const w = setup({ shadow: true, sendText: async () => { throw new Error(`falla ${SENTINEL}`); } });
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect((await events(p.key)).map((e) => e.kind)).toEqual(["PATIENT_BATCH"]);
      expect((await stateOf(w, p.key))!.questions.map((q) => q.status)).toEqual(["OPEN"]);
      expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
    });

    it("PRIVACIDAD: lo guardado son ids y códigos; ni el texto del paciente, ni el de las respuestas, ni el teléfono, ni precios, ni las claves aparecen en la tabla ni en los registros", async () => {
      const p = patient();
      const w = setup({ shadow: true, sessions: false, attention: false });
      await say(w, p.phone, `quiero cotizar mis estudios ${SENTINEL}`);
      await send(w, imageEvent(id("img"), p.phone, "IMG1"));
      const dump = await db.ok(`select string_agg(to_json(e)::text, ' ') from public.plusmedik_conv_events e where contact_key = '${p.key}'`);
      for (const secret of [SENTINEL, "quiero cotizar", "mi receta", p.phone, HMAC_KEY, DRAFT_TEXTS.send_recipe, "HEMOGRAMA", "Bs", "priceBs", "totalBs"]) {
        expect(dump, secret).not.toContain(secret);
        expect(JSON.stringify(w.logs.filter(([event]) => event.startsWith("conv_state"))), secret).not.toContain(secret);
      }
      const columns = (await db.ok(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'plusmedik_conv_events' order by ordinal_position`)).split(/\r?\n/);
      expect(columns).toEqual(["id", "seq", "contact_key", "event_key", "kind", "payload", "occurred_at", "created_at", "expires_at"]);
      // cada evento vence (retención por defecto de 30 días)
      expect(await db.ok(`select count(*) filter (where expires_at is null) from public.plusmedik_conv_events where contact_key = '${p.key}'`)).toBe("0");
    });
  });

  // ───────────────────────────── si la memoria falla, el agente sigue ─────────────────────────────

  describe("si la memoria falla, el agente responde igual", () => {
    it("sin la función de la base (migración 24 sin aplicar) o con la red caída: mismas respuestas, estado 200, y solo un código en el registro", async () => {
      const p = patient();
      const r = patient();
      const reference = setup({ shadow: false });
      await say(reference, r.phone, "quiero cotizar mis estudios");
      const broken = setup({ shadow: true });
      broken.network.downFor.add("plusmedik_conv_append");
      const message = await say(broken, p.phone, "quiero cotizar mis estudios");
      expect(broken.sends.map((s) => s.body)).toEqual(reference.sends.map((s) => s.body));
      expect(await runStatuses(p.phone)).toBe(await runStatuses(r.phone));
      const failures = broken.logs.filter(([event]) => event === "conv_state_write_failed");
      expect(failures.length).toBeGreaterThan(0);
      expect(JSON.stringify(failures)).not.toMatch(/quiero cotizar|wamid/);
      expect(JSON.stringify(failures)).not.toContain(message);
      expect(await events(p.key)).toEqual([]);
    });

    it("una base que rechaza la escritura (HTTP 422) tampoco cambia la respuesta y deja el estado HTTP y el código", async () => {
      const p = patient();
      const w = setup({ shadow: true });
      // un id con caracteres no permitidos jamás llega a la base: se descarta antes; aquí se fuerza el rechazo de la base con un contacto inválido
      const store = createSupabaseConversationStore({ rpc: createSupabaseRpc({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, w.network), retryDelayMs: 0 }) });
      await expect(store.append("no-es-un-hash", [{ event_key: "k", kind: "DROP", payload: {}, occurred_at: new Date().toISOString() }])).rejects.toMatchObject({ httpStatus: 422 });
      await say(w, p.phone, "quiero cotizar mis estudios");
      expect(w.sends).toHaveLength(1);
    });
  });
});
