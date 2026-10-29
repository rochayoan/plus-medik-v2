import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { createSupabaseAuditRepository } from "../src/audit.js";
import { createCrmAttentionRepository, handleCrmAttention, resolveCrmAttention, resolveScopedContactControl, type CrmControlConfig } from "../src/crm-attention.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { createTextHandler } from "../src/text-handler.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Fase 2.3 de extremo a extremo: CONTROL ACOTADO del CRM contra PostgreSQL real con las 15 migraciones. Rutas REALES de atención + webhook REAL de Kapso (flujo de fotos de producción, SIN turnos y SIN control
// humano global) + repositorios REALES. Se comprueba que pausar a UN contacto autorizado no altera en nada la atención de los demás pacientes, que la pausa automática por mensajes humanos sigue siendo
// independiente, que un fallo de Supabase solo detiene al contacto de la lista y que encender/apagar las banderas se comporta como se documenta. Solo se simulan Kapso, el catálogo y el motor de recetas.

const bin = findPostgresBin();
if (!bin) console.warn("[crm-scope-e2e] PostgreSQL no disponible: se omiten los escenarios del control acotado contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const TOKEN = "token-de-prueba-solo-para-tests-0123456789";
const LAB = "123456789012345";
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const now = () => String(Math.floor(Date.now() / 1000));
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: now(), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "image", from: phone, image: { id: "media-1" }, kapso: { ...inbound, has_media: true, media_url: "https://example.test/img.jpg" } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: now(), type: "text", to: phone, text: { body: "texto de la persona" }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);

describe.skipIf(!bin)("control acotado del CRM, de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("crm_control_acotado");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => `5917${String(++counter).padStart(7, "0")}`;

  // Entorno de Vercel simulado: las MISMAS funciones de producción resuelven la configuración de las rutas y del webhook.
  const envFor = (over: Record<string, string | undefined>): Record<string, string | undefined> => ({
    PLUSMEDIK_AGENT_CONTROL: "on", PLUSMEDIK_AGENT_CONTROL_TOKEN: TOKEN, KAPSO_PHONE_NUMBER_ID: LAB, PLUSMEDIK_CONTACT_HMAC_KEY: HMAC_KEY, ...over
  });

  function setup(env: Record<string, string | undefined>, options: { turns?: boolean } = {}) {
    const humanControlOn = env.PLUSMEDIK_HUMAN_CONTROL === "on";
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const scoped = humanControlOn ? undefined : resolveScopedContactControl(env);
    // Igual que api/kapso/webhook.ts: flujo de fotos de siempre (sin turnos); control humano global solo si PLUSMEDIK_HUMAN_CONTROL=on.
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })),
      loadCatalog: vi.fn(async () => []),
      analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      requireAuditGuard: humanControlOn,
      humanControl: humanControlOn ? { contactKeyFor } : undefined,
      scopedControl: scoped ? { contactKeyFor, covers: scoped.covers } : undefined,
      // Igual que api/kapso/webhook.ts con PLUSMEDIK_TURNS=on y PLUSMEDIK_TEXT_HANDLER=on: TODOS los mensajes pasan por la coordinación de turnos, que reclama cada uno con la clave del contacto.
      ...(options.turns ? { requireAuditGuard: true, turns: { contactKeyFor, busyDelayMs: 20, busyRetries: 100, handlers: { text: createTextHandler({ log }) } } } : {})
    };
    const webhook: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: humanControlOn ? { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) } : undefined, log };
    const resolution = resolveCrmAttention(env);
    const config: CrmControlConfig | undefined = resolution.enabled && "config" in resolution ? resolution.config : undefined;
    const crm = { config, repository: () => createCrmAttentionRepository(rpcOptions()), log };
    const endpoint = async (route: "status" | "action", body: Record<string, unknown>) => {
      const response = await handleCrmAttention(
        new Request(`https://agente.example.test/api/internal/crm/attention/${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }),
        route, crm
      );
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    return { sends, logs, scheduled, quote, hook: (request: Request) => handleKapsoWebhook(request, webhook), settle: () => Promise.all(scheduled), endpoint };
  }
  type World = ReturnType<typeof setup>;
  const send = async (w: World, event: unknown, headers = RECEIVED) => {
    expect((await w.hook(signedPost(event, headers))).status).toBe(200);
    await w.settle();
  };
  const photo = async (w: World, phone: string) => {
    const message = id("img");
    await send(w, imageEvent(message, phone));
    return message;
  };
  const repliesTo = (w: World, phone: string) => w.sends.filter((sent) => sent.to === phone).length;
  const statusOf = (w: World, phone: string) => w.endpoint("status", { contactPhone: phone, phoneNumberId: LAB });
  const actionOf = (w: World, phone: string, action: "pause" | "resume", operationId: string) =>
    w.endpoint("action", { operationId, action, contactPhone: phone, phoneNumberId: LAB, reasonCode: action === "pause" ? "CRM_MANUAL_PAUSE" : "CRM_MANUAL_RESUME", actor: "crm:prueba" });
  const op = () => `op-${String(++counter).padStart(6, "0")}-${Date.now()}`;
  const runOf = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const stateRows = (phone: string) => db.ok(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${contactKeyFor(phone)}'`);
  const eventRows = (phone: string) => db.ok(`select count(*) from public.plusmedik_attention_events where contact_key = '${contactKeyFor(phone)}'`);

  it("pausar al contacto autorizado NO altera a los demás: ellos siguen recibiendo su cotización, antes, durante y después", async () => {
    const listed = patient();
    const others = [patient(), patient(), patient()];
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));

    await photo(w, listed);
    for (const other of others) await photo(w, other);
    expect(w.sends).toHaveLength(4);

    expect(await actionOf(w, listed, "pause", op())).toMatchObject({ status: 200, body: { ok: true, confirmed: true, state: "HUMAN_PAUSED", outcome: "PAUSED", replayed: false } });
    expect(await statusOf(w, listed)).toMatchObject({ status: 200, body: { available: true, state: "HUMAN_PAUSED" } });

    // el autorizado calla...
    const silent = await photo(w, listed);
    expect(repliesTo(w, listed)).toBe(1);
    expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${silent}' and send_state <> 'NOT_RESERVED'`)).toBe("0");
    // ...y los demás siguen igual que antes
    for (const other of others) await photo(w, other);
    for (const other of others) expect(repliesTo(w, other)).toBe(2);

    expect(await actionOf(w, listed, "resume", op())).toMatchObject({ status: 200, body: { confirmed: true, state: "ACTIVE", outcome: "RESUMED" } });
    await photo(w, listed);
    expect(repliesTo(w, listed)).toBe(2);
    for (const other of others) await photo(w, other);
    for (const other of others) expect(repliesTo(w, other)).toBe(3);
  });

  it("los contactos fuera de la lista no usan clave de contacto, ni quedan con estado ni eventos de atención: la base no sabe nada de ellos", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    const otherMessage = await photo(w, other);
    const listedMessage = await photo(w, listed);

    expect((await runOf(otherMessage)).contact_key ?? null).toBeNull();
    expect((await runOf(listedMessage)).contact_key).toBe(contactKeyFor(listed));
    expect(await stateRows(other)).toBe("0");
    expect(await eventRows(other)).toBe("0");
    expect(repliesTo(w, other)).toBe(1);
    expect(repliesTo(w, listed)).toBe(1);
  });

  it("el CRM no puede pausar a un contacto fuera de la lista (403) ni consultarlo: no se escribe nada y el paciente sigue siendo atendido", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    network.calls.length = 0;
    expect(await actionOf(w, other, "pause", op())).toEqual({ status: 403, body: { ok: false, confirmed: false, error: "contact_not_authorized" } });
    expect(await statusOf(w, other)).toEqual({ status: 403, body: { ok: false, available: false, error: "contact_not_authorized" } });
    expect(network.calls).toEqual([]); // ni una sola llamada a Supabase
    expect(await stateRows(other)).toBe("0");
    expect(await eventRows(other)).toBe("0");
    await photo(w, other);
    expect(repliesTo(w, other)).toBe(1);
  });

  it("la pausa automática por mensajes humanos es INDEPENDIENTE: en modo acotado un mensaje de la persona no pausa a nadie (ni al autorizado)", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    await send(w, humanEvent(id("hum"), listed), SENT);
    await send(w, humanEvent(id("hum"), other), SENT);
    expect(w.logs.filter(([event, data]) => event === "human_event_ignored" && data.reason === "control_disabled")).toHaveLength(2);
    expect(await eventRows(listed)).toBe("0");
    expect(await eventRows(other)).toBe("0");
    await photo(w, listed);
    await photo(w, other);
    expect(repliesTo(w, listed)).toBe(1);
    expect(repliesTo(w, other)).toBe(1);
    // la pausa manual del CRM sí sigue funcionando para el autorizado
    expect((await actionOf(w, listed, "pause", op())).body.confirmed).toBe(true);
    await send(w, humanEvent(id("hum"), listed), SENT); // y un mensaje humano posterior no cambia nada
    await photo(w, listed);
    expect(repliesTo(w, listed)).toBe(1);
  });

  it("con PLUSMEDIK_HUMAN_CONTROL=on la pausa automática vuelve a ser global (la bandera conserva su significado) y la lista solo acota al CRM", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_HUMAN_CONTROL: "on", PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    await send(w, humanEvent(id("hum"), other), SENT);
    expect(await eventRows(other)).not.toBe("0");
    await photo(w, other);
    expect(repliesTo(w, other)).toBe(0); // pausado por la persona (comportamiento de siempre del control humano)
    // el CRM, en cambio, solo puede operar sobre la lista
    expect((await actionOf(w, other, "resume", op())).status).toBe(403);
    expect((await actionOf(w, listed, "pause", op())).body.confirmed).toBe(true);
  });

  it("un fallo de Supabase solo detiene al contacto autorizado; los demás pacientes se atienden como siempre", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    network.down = true;
    try {
      await photo(w, listed);
      await photo(w, other);
      expect(repliesTo(w, listed)).toBe(0);
      expect(w.logs.some(([event, data]) => event === "reply_withheld" && data.reason === "audit_guard_unavailable")).toBe(true);
      expect(repliesTo(w, other)).toBe(1); // política anterior: el webhook ya confirmó la recepción y no hay guarda obligatoria
      // el CRM no recibe ninguna confirmación incierta
      expect(await actionOf(w, listed, "pause", op())).toEqual({ status: 503, body: { ok: false, confirmed: false, error: "unavailable" } });
      expect(await statusOf(w, listed)).toEqual({ status: 503, body: { ok: false, available: false, error: "unavailable" } });
      expect((await actionOf(w, other, "pause", op())).status).toBe(403);
    } finally {
      network.down = false;
    }
    // restablecido: el autorizado vuelve a recibir respuesta
    await photo(w, listed);
    expect(repliesTo(w, listed)).toBe(1);
  });

  it("si solo falla la reserva del envío, nadie con corrida protegida recibe respuesta: el autorizado (nuevo) y el resto (fallo cerrado histórico, sin cambios)", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    network.downFor.add("plusmedik_audit_reserve_send");
    try {
      await photo(w, listed);
      await photo(w, other);
      expect(repliesTo(w, listed)).toBe(0);
      expect(repliesTo(w, other)).toBe(0); // el otro contacto también tiene corrida con lease: su reserva falla igual que antes de esta función (fallo cerrado histórico)
    } finally {
      network.downFor.clear();
    }
  });

  it("idempotencia, reuso de operationId y conflicto se conservan en el modo acotado", async () => {
    const listed = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    const operation = op();
    const first = await actionOf(w, listed, "pause", operation);
    const again = await actionOf(w, listed, "pause", operation);
    expect(first.body).toMatchObject({ confirmed: true, replayed: false });
    expect(again.body).toMatchObject({ confirmed: true, replayed: true, revision: first.body.revision });
    expect(await eventRows(listed)).toBe("1");
    expect(await actionOf(w, listed, "resume", operation)).toMatchObject({ status: 409, body: { confirmed: false, error: "operation_conflict" } });
    expect(await statusOf(w, listed)).toMatchObject({ body: { state: "HUMAN_PAUSED" } });
    expect((await actionOf(w, listed, "pause", op())).body).toMatchObject({ outcome: "ALREADY_PAUSED" });
    expect((await actionOf(w, listed, "resume", op())).body).toMatchObject({ outcome: "RESUMED", state: "ACTIVE" });
    expect((await actionOf(w, listed, "resume", op())).body).toMatchObject({ outcome: "ALREADY_ACTIVE" });
  });

  it("activación y desactivación de banderas: sin lista nada opera ni cambia; con lista opera; al retirarla la pausa guardada deja de respetarse (por eso se reactiva antes) y al restituirla vuelve", async () => {
    const listed = patient();
    const other = patient();

    // 1) rutas encendidas pero SIN lista y sin control humano: no se muta nada y el webhook es el de siempre
    const closed = setup(envFor({}));
    expect(await statusOf(closed, listed)).toEqual({ status: 200, body: { ok: true, available: false, reason: "control_disabled" } });
    expect((await actionOf(closed, listed, "pause", op())).body).toMatchObject({ confirmed: false, available: false });
    await photo(closed, listed);
    await photo(closed, other);
    expect(closed.sends).toHaveLength(2);
    expect(await stateRows(listed)).toBe("0");
    expect(await eventRows(listed)).toBe("0");

    // 2) con lista: opera
    const open = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    expect((await actionOf(open, listed, "pause", op())).body.confirmed).toBe(true);
    await photo(open, listed);
    expect(repliesTo(open, listed)).toBe(0);

    // 3) se retira la lista (bandera apagada): las rutas vuelven a no operar y el webhook ya no consulta la pausa -> el contacto vuelve a recibir respuesta
    const removed = setup(envFor({}));
    expect(await statusOf(removed, listed)).toMatchObject({ body: { available: false } });
    await photo(removed, listed);
    expect(repliesTo(removed, listed)).toBe(1);

    // 4) se restituye la lista: el estado guardado sigue siendo HUMAN_PAUSED y el contacto vuelve a callar hasta reactivarlo
    const restored = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }));
    expect(await statusOf(restored, listed)).toMatchObject({ body: { available: true, state: "HUMAN_PAUSED" } });
    await photo(restored, listed);
    expect(repliesTo(restored, listed)).toBe(0);
    expect((await actionOf(restored, listed, "resume", op())).body).toMatchObject({ confirmed: true, state: "ACTIVE" });
    await photo(restored, listed);
    expect(repliesTo(restored, listed)).toBe(1);
  });

  it("PLUSMEDIK_TURNS=on + lista (sin control humano global): COMBINACIÓN SOPORTADA y SIN bypass de la pausa — el autorizado pausado calla (texto y fotos) y los demás siguen respondiendo", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }), { turns: true });
    const say = async (phone: string, body: string) => { const message = id("txt"); await send(w, textEvent(message, phone, body)); return message; };

    await say(listed, "quiero cotizar mis estudios");
    await say(other, "quiero cotizar mis estudios");
    expect(repliesTo(w, listed)).toBe(1);
    expect(repliesTo(w, other)).toBe(1);

    expect(await actionOf(w, listed, "pause", op())).toMatchObject({ status: 200, body: { confirmed: true, state: "HUMAN_PAUSED" } });
    const silent = await say(listed, "quiero cotizar mis estudios por favor");
    await photo(w, listed);
    expect(repliesTo(w, listed)).toBe(1); // ni texto ni foto después de la pausa
    expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${silent}' and send_state <> 'NOT_RESERVED'`)).toBe("0");
    await say(other, "quiero cotizar mis estudios por favor");
    expect(repliesTo(w, other)).toBe(2);

    // el CRM sigue sin poder tocar a un contacto fuera de la lista, aunque en modo turnos su mensaje también lleve clave de contacto
    expect((await actionOf(w, other, "pause", op())).status).toBe(403);

    expect((await actionOf(w, listed, "resume", op())).body).toMatchObject({ confirmed: true, state: "ACTIVE" });
    await say(listed, "quiero cotizar mis estudios otra vez");
    expect(repliesTo(w, listed)).toBe(2);
  });

  it("PLUSMEDIK_TURNS=on + lista: con Supabase caído NADIE recibe respuesta (política propia de los turnos, falla cerrado para todos) y el CRM no confirma nada", async () => {
    const listed = patient();
    const other = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: listed }), { turns: true });
    network.down = true;
    try {
      await send(w, textEvent(id("txt"), listed, "quiero cotizar mis estudios"));
      await send(w, textEvent(id("txt"), other, "quiero cotizar mis estudios"));
      expect(w.sends).toHaveLength(0);
      expect(await actionOf(w, listed, "pause", op())).toEqual({ status: 503, body: { ok: false, confirmed: false, error: "unavailable" } });
    } finally {
      network.down = false;
    }
  });

  it("una lista mal formada apaga las rutas (503) y el webhook queda como siempre para todos", async () => {
    const listed = patient();
    const w = setup(envFor({ PLUSMEDIK_AGENT_CONTROL_PHONES: `${listed},no-es-un-numero` }));
    expect(await statusOf(w, listed)).toEqual({ status: 503, body: { ok: false, available: false, error: "not_configured" } });
    await photo(w, listed);
    expect(repliesTo(w, listed)).toBe(1);
    expect(await stateRows(listed)).toBe("0");
  });
});
