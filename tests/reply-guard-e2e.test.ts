import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { DEFAULT_REPLY_GUARD, type ReplyGuardConfig } from "../src/reply-guard.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Protección contra bucles de extremo a extremo: webhook real + manejador de texto real + repositorios reales + PostgreSQL real con las DIEZ migraciones. Kapso, los bots y el
// motor de recetas son simulaciones. Nada de esto toca un servicio real.

const bin = findPostgresBin();
if (!bin) console.warn("[reply-guard-e2e] PostgreSQL no disponible: se omiten los escenarios de la guarda de respuestas contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_6044";
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", from: phone, image: { id: "media-1" }, kapso: { ...inbound, has_media: true, media_url: "https://example.test/img.jpg" } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

// Solo el tope (sin ráfaga ni repetición efectivas) y variantes.
const CAP = (max: number, over: Partial<ReplyGuardConfig> = {}): ReplyGuardConfig => ({ rules: [{ windowSeconds: 600, max }], burst: { windowSeconds: 60, max: 1000 }, repeat: { windowSeconds: 900, max: 1000 }, cooldownSeconds: 600, ...over });

describe.skipIf(!bin)("guarda de respuestas de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("reply_guard_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 20_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  function setup(options: { replyGuard?: ReplyGuardConfig | null; loopProtection?: boolean } = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const replyGuard = options.replyGuard === null ? undefined : (options.replyGuard ?? CAP(3));
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })), loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor, handlers: { text: createTextHandler({ log, loopProtection: options.loopProtection ?? replyGuard !== undefined }) }, busyDelayMs: 20, busyRetries: 400, ...(replyGuard ? { replyGuard } : {}) }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, scheduled, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
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
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const guardEvents = async (contact: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(e order by e.created_at, e.id), '[]') from public.plusmedik_reply_guard_events e where contact_key = '${contact}'`));
  const rewind = (contact: string, seconds: number) =>
    db.ok(`set session_replication_role = replica;
      update public.plusmedik_audit_runs set send_reserved_at = send_reserved_at - interval '${seconds} seconds' where contact_key = '${contact}' and send_reserved_at is not null;
      update public.plusmedik_turns set created_at = created_at - interval '${seconds} seconds' where contact_key = '${contact}';
      update public.plusmedik_reply_guard_marks set created_at = created_at - interval '${seconds} seconds' where contact_key = '${contact}';
      update public.plusmedik_reply_guard_events set created_at = created_at - interval '${seconds} seconds' where contact_key = '${contact}';
      update public.plusmedik_reply_guard_state set suppressed_until = suppressed_until - interval '${seconds} seconds', updated_at = updated_at - interval '${seconds} seconds',
        counted_since = counted_since - interval '${seconds} seconds' where contact_key = '${contact}';
      -- Simulación del tiempo también para el ledger agregado por migración 16.
      update public.plusmedik_guard_rate_ledger set state =
        jsonb_set(state, '{slots}', coalesce((
          select jsonb_agg(jsonb_set(e.value, '{t}', to_jsonb((e.value ->> 't')::numeric - ${seconds})) order by e.ord)
          from jsonb_array_elements(state -> 'slots') with ordinality as e(value, ord)
        ), '[]'::jsonb))
      where contact_key = '${contact}';`);
  const reset = async (contact: string) => JSON.parse((await db.ok(`set role service_role; select public.plusmedik_reply_guard_reset('${contact}', 'operator:laura');`)).split("\n")[0]!);
  const sendStates = async (contact: string): Promise<string[]> => (await db.ok(`select coalesce(string_agg(coalesce(send_block_reason, send_state), ',' order by created_at), '') from public.plusmedik_audit_runs where contact_key = '${contact}'`)).split(",").filter(Boolean);

  it("APAGADA (sin guarda): un contacto que escribe sin parar recibe una respuesta a cada mensaje, como en G2.1 (la guarda es opt-in)", async () => {
    const p = patient();
    const w = setup({ replyGuard: null });
    for (let i = 0; i < 7; i++) await say(w, p.phone, "hola");
    expect(w.sends).toHaveLength(7);
    expect(await guardEvents(p.key)).toEqual([]);
    expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_marks where contact_key = '${p.key}'`)).toBe("0");
  });

  it("tope por contacto: tras 3 respuestas en la ventana no se responde más; las cerradas quedan auditadas con su motivo y la bitácora registra el tope una vez", async () => {
    const p = patient();
    const w = setup({ replyGuard: CAP(3) });
    const messages: string[] = [];
    for (const body of ["hola", "quiero cotizar mi receta", "¿a qué hora abren?", "hola de nuevo", "otra pregunta cualquiera", `y otra más ${SENTINEL}`]) messages.push(await say(w, p.phone, body));
    expect(w.sends).toHaveLength(3);
    expect(await sendStates(p.key)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "RATE_LIMITED", "RATE_LIMITED", "RATE_LIMITED"]);
    expect(await run(messages[3]!)).toMatchObject({ send_state: "CANCELLED", processing_status: "COMPLETED", reply_state: "NOT_ATTEMPTED" });
    expect(logsOf(w.logs, "reply_withheld")).toEqual([{ reason: "limited" }, { reason: "limited" }, { reason: "limited" }]);
    const events = await guardEvents(p.key);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "RATE_LIMITED", detail: { count: 3, max: 3, windowSeconds: 600 } });
  });

  it("recuperación sin intervención: al pasar la ventana el paciente vuelve a recibir respuestas (nunca queda bloqueado para siempre)", async () => {
    const p = patient();
    const w = setup({ replyGuard: CAP(2) });
    for (const body of ["hola", "quiero cotizar", "otra"]) await say(w, p.phone, body);
    expect(w.sends).toHaveLength(2);
    await rewind(p.key, 601);
    await say(w, p.phone, "ya pasó un buen rato, ¿me ayudan con una cotización?");
    expect(w.sends).toHaveLength(3);
  });

  it("recuperación por un operador: el reset levanta una supresión por bucle de inmediato y deja el registro; los datos anteriores se conservan", async () => {
    const p = patient();
    const w = setup({ replyGuard: CAP(100, { repeat: { windowSeconds: 900, max: 2 } }) });
    for (let i = 0; i < 5; i++) await say(w, p.phone, "hola");
    expect(w.sends).toHaveLength(2);
    expect(await reset(p.key)).toEqual({ status: "reset", hadSuppression: true });
    await say(w, p.phone, "hola, ahora sí necesito algo");
    expect(w.sends).toHaveLength(3);
    const kinds = (await guardEvents(p.key)).map((event) => event.kind);
    expect(kinds).toEqual(["REPEAT_SUSPECTED", "RECOVERED"]);
    expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}'`)).toBe("6");
  });

  describe("bucles con otros bots", () => {
    it("un bot que repite siempre lo mismo ('Hola'): el intercambio se corta tras el tope de repetición y no hay más de 3 mensajes nuestros", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
      for (let i = 0; i < 25; i++) await say(w, p.phone, "Hola");
      expect(w.sends).toHaveLength(DEFAULT_REPLY_GUARD.repeat.max);
      const states = await sendStates(p.key);
      expect(states.slice(0, 3)).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED"]);
      expect(states[3]).toBe("REPEAT_SUSPECTED");
      expect(new Set(states.slice(4))).toEqual(new Set(["SUPPRESSED"]));
      expect((await guardEvents(p.key)).map((event) => event.kind)).toEqual(["REPEAT_SUSPECTED"]);
    });

    it("una ráfaga de mensajes distintos en segundos se detecta como bucle aunque nunca repita la respuesta", async () => {
      const p = patient();
      const w = setup({ replyGuard: CAP(1000, { burst: { windowSeconds: 60, max: 5 } }) });
      const bodies = ["hola", "quiero cotizar", "¿a qué hora abren?", "tengo dolor", "quiero una persona", "asdf", "otra más", "y otra", "última"];
      for (const body of bodies) await say(w, p.phone, body);
      expect(w.sends.length).toBeLessThan(5);
      expect((await guardEvents(p.key)).map((event) => event.kind)).toEqual(["LOOP_SUSPECTED"]);
      expect(await guardEvents(p.key)).toMatchObject([{ detail: { signal: "BURST", max: 5 } }]);
    });

    it("autorrespuestas de otros negocios y 'no responder': no se les contesta NUNCA, y el turno queda cerrado y auditado sin respuesta", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
      const messages: string[] = [];
      for (const body of ["Respuesta automática: gracias por escribirnos, en breve le atendemos", "Please do not reply to this message. Dolor de pecho: llame a emergencias", "Gracias por comunicarte con nosotros. En este momento no estamos disponibles, te responderemos lo antes posible."]) messages.push(await say(w, p.phone, body));
      expect(w.sends).toEqual([]);
      for (const message of messages) expect(await run(message)).toMatchObject({ processing_status: "IGNORED", send_state: "NOT_APPLICABLE", reply_state: "NOT_ATTEMPTED", error_code: "NO_REPLY" });
      expect(logsOf(w.logs, "text_turn").every((data) => data.category === "AUTOMATED")).toBe(true);
      expect(await guardEvents(p.key)).toEqual([]);
    });

    it("el eco de nuestros propios textos (un bot que nos devuelve lo que decimos) corta el bucle en la primera vuelta", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
      await say(w, p.phone, "hola");
      expect(w.sends).toHaveLength(1);
      let echo = w.sends[0]!.body;
      for (let i = 0; i < 10; i++) {
        const before = w.sends.length;
        await say(w, p.phone, echo);
        expect(w.sends).toHaveLength(before);
      }
      expect(w.sends).toHaveLength(1);
    });

    it("sin la guarda, el mismo eco SÍ se responde (la detección es parte de la protección y está apagada por defecto)", async () => {
      const p = patient();
      const w = setup({ replyGuard: null });
      await say(w, p.phone, DRAFT_TEXTS.greeting);
      await say(w, p.phone, "Respuesta automática: no responder");
      expect(w.sends).toHaveLength(2);
    });
  });

  describe("pacientes legítimos", () => {
    it("una conversación normal (varias preguntas distintas a ritmo humano) se responde completa", async () => {
      const p = patient();
      const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
      for (const body of ["Hola", "quiero cotizar unos estudios", "¿a qué hora abren?", "gracias", "tengo una duda más"]) await say(w, p.phone, body);
      expect(w.sends).toHaveLength(5);
      expect(await guardEvents(p.key)).toEqual([]);
    });

    it("limitado o suprimido el texto, la RECETA se cotiza igual: una imagen nunca se limita", async () => {
      const p = patient();
      const w = setup({ replyGuard: CAP(100, { repeat: { windowSeconds: 900, max: 2 } }) });
      for (let i = 0; i < 4; i++) await say(w, p.phone, "hola");
      expect(w.sends).toHaveLength(2);
      expect((await guardEvents(p.key)).map((event) => event.kind)).toEqual(["REPEAT_SUSPECTED"]);
      const image = id("img");
      await send(w, imageEvent(image, p.phone));
      expect(w.sends).toHaveLength(3);
      expect(w.sends[2]!.body).toContain("HEMOGRAMA");
      expect(await run(image)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
    });

    it("un tope bajo solo afecta al contacto que lo alcanza", async () => {
      const a = patient();
      const b = patient();
      const w = setup({ replyGuard: CAP(2) });
      for (let i = 0; i < 4; i++) await say(w, a.phone, `pregunta número ${i}`);
      await say(w, b.phone, "hola");
      expect(w.sends.filter((s) => s.to === a.phone)).toHaveLength(2);
      expect(w.sends.filter((s) => s.to === b.phone)).toHaveLength(1);
    });
  });

  describe("pausa humana, idempotencia y concurrencia", () => {
    it("un contacto en pausa humana no recibe nada y la guarda no registra nada (la pausa va primero)", async () => {
      const p = patient();
      const w = setup({ replyGuard: CAP(1) });
      await say(w, p.phone, "hola");
      expect(w.sends).toHaveLength(1);
      await send(w, humanEvent(id("human"), p.phone), SENT);
      await say(w, p.phone, "¿hay alguien?");
      expect(w.sends).toHaveLength(1);
      expect(await guardEvents(p.key)).toEqual([]);
      expect(await db.ok(`select state from public.plusmedik_attention_contacts where contact_key = '${p.key}'`)).toBe("HUMAN_PAUSED");
    });

    it("el mismo mensaje entregado varias veces genera UNA respuesta, una marca y ningún bloqueo", async () => {
      const p = patient();
      const w = setup({ replyGuard: CAP(2) });
      const message = id("dup");
      for (let i = 0; i < 4; i++) await send(w, textEvent(message, p.phone, "hola"));
      expect(w.sends).toHaveLength(1);
      expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_marks where contact_key = '${p.key}'`)).toBe("1");
      expect(await guardEvents(p.key)).toEqual([]);
      await say(w, p.phone, "quiero cotizar");
      expect(w.sends).toHaveLength(2);
    });

    it("concurrencia: 10 mensajes simultáneos del mismo contacto nunca producen más respuestas que el tope", async () => {
      const p = patient();
      const w = setup({ replyGuard: CAP(3) });
      await Promise.all(Array.from({ length: 10 }, (_, i) => w.hook(signedPost(textEvent(id(`par${i}`), p.phone, `consulta ${i}`), RECEIVED))));
      await w.settle();
      expect(w.sends.length).toBeGreaterThanOrEqual(1);
      expect(w.sends.length).toBeLessThanOrEqual(3);
      expect(Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_state in ('RESERVED','ACCEPTED','UNKNOWN') and send_kind = 'conversation'`))).toBeLessThanOrEqual(3);
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_state = 'RESERVED'`)).toBe("0");
    });

    it("falla cerrado: si la función con guarda no está (migración 10 sin aplicar) o la base cae, NO se responde y no queda nada reservado", async () => {
      const p = patient();
      const w = setup({ replyGuard: CAP(3) });
      network.downFor.add("plusmedik_turn_reserve_send_guarded");
      try {
        await say(w, p.phone, "hola");
      } finally {
        network.downFor.delete("plusmedik_turn_reserve_send_guarded");
      }
      expect(w.sends).toEqual([]);
      expect(logsOf(w.logs, "audit_unavailable").some((data) => data.stage === "reserve")).toBe(true);
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${p.key}' and send_state <> 'NOT_RESERVED'`)).toBe("0");
    });
  });

  it("privacidad: ni los registros ni la base de la guarda contienen texto del paciente ni teléfonos", async () => {
    const p = patient();
    const w = setup({ replyGuard: CAP(1) });
    await say(w, p.phone, `hola ${SENTINEL}`);
    await say(w, p.phone, `Respuesta automática ${SENTINEL}`);
    await say(w, p.phone, `una más ${SENTINEL}`);
    const tables = await db.ok(`select (select coalesce(json_agg(m), '[]') from public.plusmedik_reply_guard_marks m)::text || (select coalesce(json_agg(e), '[]') from public.plusmedik_reply_guard_events e)::text || (select coalesce(json_agg(s), '[]') from public.plusmedik_reply_guard_state s)::text`);
    for (const text of [JSON.stringify(w.logs), tables]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(p.phone);
    }
  });
});
