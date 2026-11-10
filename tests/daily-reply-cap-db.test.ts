import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 18 (tope de respuestas del agente por contacto en ventana móvil) contra un PostgreSQL REAL y efímero. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[daily-reply-cap-db] PostgreSQL no disponible: se omiten las pruebas del tope diario contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
type Json = Record<string, any>;
const CAP = { max: 5, windowSeconds: 86_400 };

describe.skipIf(!bin)("tope diario de respuestas contra PostgreSQL real (migración 18)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("daily_reply_cap");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const jsonSql = (value: unknown) => (value === null ? "null::jsonb" : `$g$${JSON.stringify(value)}$g$::jsonb`);

  interface Turn { message: string; id: string; who: string; fence: number }
  async function turn(contact: string, who = 1, kind = "TEXT"): Promise<Turn> {
    const message = `wamid.cap-${++counter}-${Date.now()}`;
    const claimed = await call(`select public.plusmedik_turn_claim('${message}', null, '${owner(who)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', '${kind}');`);
    const id = await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
    return { message, id, who: owner(who), fence: claimed.fence as number };
  }
  const reserveSql = (t: Turn, cap: unknown, kind = "conversation") =>
    `select public.plusmedik_turn_reserve_send_capped('${t.id}'::uuid, '${t.who}', ${t.fence}, '${kind}', 120, 'NONE', null::jsonb, ${jsonSql(cap)});`;
  const reserve = (t: Turn, cap: unknown = CAP, kind = "conversation") => call(reserveSql(t, cap, kind));
  const recordSql = (t: Turn, state = "ACCEPTED", result = "conversation") =>
    `select public.plusmedik_audit_fenced_record_reply('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"state":"${state}","result":"${result}","processing_status":"COMPLETED"}'::jsonb);`;
  // Un turno que reserva y cuyo envío termina (ACCEPTED o UNKNOWN).
  async function sent(contact: string, options: { kind?: string; turnKind?: string; state?: string; cap?: unknown } = {}): Promise<Turn> {
    const t = await turn(contact, 1, options.turnKind ?? "TEXT");
    const kind = options.kind ?? "conversation";
    const reserved = await reserve(t, "cap" in options ? options.cap : CAP, kind);
    expect(reserved.status, JSON.stringify(reserved)).toBe("reserved");
    await call(recordSql(t, options.state ?? "ACCEPTED", kind));
    return t;
  }
  const counted = async (contact: string) => Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}' and send_state in ('RESERVED','ACCEPTED','UNKNOWN')`));
  const runState = async (t: Turn): Promise<Json> => JSON.parse(await db.ok(`select json_build_object('send_state', send_state, 'reason', send_block_reason) from public.plusmedik_audit_runs where id = '${t.id}'`));
  const rewind = (contact: string, seconds: number) =>
    db.ok(`set session_replication_role = replica; update public.plusmedik_audit_runs set send_reserved_at = send_reserved_at - interval '${seconds} seconds' where contact_key = '${contact}' and send_reserved_at is not null;`);

  it("permite 5 respuestas y a la 6ª no responde: la corrida queda cancelada con DAILY_CAP", async () => {
    const contact = newContact();
    for (let i = 0; i < 5; i++) await sent(contact);
    const sixth = await turn(contact);
    expect(await reserve(sixth)).toEqual({ status: "limited", reason: "DAILY_CAP" });
    expect(await runState(sixth)).toEqual({ send_state: "CANCELLED", reason: "DAILY_CAP" });
    expect(await counted(contact)).toBe(5);
    // Y sigue sin responder mientras no pase la ventana.
    expect((await reserve(await turn(contact))).status).toBe("limited");
    expect(await counted(contact)).toBe(5);
  });

  it("cuenta TODO lo que envía el agente: texto, cotizaciones, cotizaciones por fotografía y avisos técnicos", async () => {
    const contact = newContact();
    await sent(contact, { kind: "conversation" });
    await sent(contact, { kind: "quoted" });
    await sent(contact, { kind: "quoted", turnKind: "IMAGE" });
    await sent(contact, { kind: "no_quote", turnKind: "IMAGE" });
    await sent(contact, { kind: "technical_issue" });
    expect(await counted(contact)).toBe(5);
    const photo = await turn(contact, 1, "IMAGE");
    expect((await reserve(photo, CAP, "quoted")).status).toBe("limited");
  });

  it("un envío incierto (UNKNOWN) cuenta; lo cancelado o nunca reservado, no", async () => {
    const contact = newContact();
    await sent(contact, { state: "UNKNOWN" });
    expect(await counted(contact)).toBe(1);
    await turn(contact);
    await turn(contact);
    const limited = await turn(contact);
    await reserve(limited, { max: 1, windowSeconds: 86_400 });
    expect(await counted(contact)).toBe(1);
    // Ni los turnos sin responder ni el rechazado ocupan cupo: con tope 2 todavía cabe una.
    expect((await reserve(await turn(contact), { max: 2, windowSeconds: 86_400 })).status).toBe("reserved");
  });

  it("un reintento de la MISMA corrida no consume otro cupo (idempotente), tampoco dos reservas simultáneas", async () => {
    const contact = newContact();
    const t = await turn(contact);
    expect((await reserve(t)).status).toBe("reserved");
    expect((await reserve(t)).status).toBe("reserved");
    expect(await counted(contact)).toBe(1);
    const u = await turn(contact);
    await call(recordSql(t));
    const results = await Promise.all([reserve(u), reserve(u)]);
    expect(results.every((result) => result.status === "reserved")).toBe(true);
    expect(await counted(contact)).toBe(2);
  });

  it("mensajes simultáneos del mismo contacto nunca superan el tope", async () => {
    const contact = newContact();
    for (let i = 0; i < 4; i++) await sent(contact);
    const pending = await Promise.all([turn(contact, 2), turn(contact, 3), turn(contact, 4), turn(contact, 5)]);
    const results = await Promise.all(pending.map((t) => reserve(t)));
    expect(results.filter((result) => result.status === "reserved")).toHaveLength(1);
    expect(await counted(contact)).toBe(5);
    for (const result of results.filter((entry) => entry.status !== "reserved")) expect(["limited", "busy"]).toContain(result.status);
  });

  it("la ventana es móvil: al salir las respuestas antiguas el agente vuelve a responder", async () => {
    const contact = newContact();
    for (let i = 0; i < 5; i++) await sent(contact);
    expect((await reserve(await turn(contact))).status).toBe("limited");
    await rewind(contact, 25 * 3600);
    expect((await reserve(await turn(contact))).status).toBe("reserved");
    expect(await counted(contact)).toBe(6);
  });

  it("solo las respuestas dentro de la ventana cuentan (4 recientes + 3 antiguas: caben 5, no 7)", async () => {
    const contact = newContact();
    for (let i = 0; i < 3; i++) await sent(contact);
    await rewind(contact, 30 * 3600);
    for (let i = 0; i < 4; i++) await sent(contact);
    expect((await reserve(await turn(contact))).status).toBe("reserved");
    expect((await reserve(await turn(contact))).status).toBe("limited");
    expect(Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}' and send_state in ('RESERVED','ACCEPTED','UNKNOWN') and send_reserved_at > now() - interval '24 hours'`))).toBe(5);
  });

  it("cada contacto tiene su propio tope", async () => {
    const full = newContact();
    const other = newContact();
    for (let i = 0; i < 5; i++) await sent(full);
    expect((await reserve(await turn(full))).status).toBe("limited");
    expect((await reserve(await turn(other))).status).toBe("reserved");
  });

  it("sin tope (p_cap nulo) se comporta como la reserva de siempre", async () => {
    const contact = newContact();
    for (let i = 0; i < 7; i++) await sent(contact, { cap: null });
    expect(await counted(contact)).toBe(7);
  });

  it("el tope es configurable (max y ventana) y rechaza valores inválidos con PT422", async () => {
    const contact = newContact();
    await sent(contact, { cap: { max: 2, windowSeconds: 3600 } });
    await sent(contact, { cap: { max: 2, windowSeconds: 3600 } });
    expect((await reserve(await turn(contact), { max: 2, windowSeconds: 3600 })).status).toBe("limited");
    const t = await turn(newContact());
    for (const bad of [{ max: 0, windowSeconds: 3600 }, { max: 5, windowSeconds: 10 }, { max: 5 }, { max: "x", windowSeconds: 3600 }, { max: 5, windowSeconds: 9_999_999 }, [], "texto"]) {
      expect(await db.fails(asService(reserveSql(t, bad))), JSON.stringify(bad)).toMatch(/PT422/);
    }
    expect((await runState(t)).send_state).toBe("NOT_RESERVED");
  });

  it("no se salta el fencing: un propietario sin el lease vigente no puede reservar ni consumir cupo", async () => {
    const contact = newContact();
    const t = await turn(contact);
    const stranger = { ...t, who: owner(9) };
    expect(await db.fails(asService(reserveSql(stranger, CAP)))).toMatch(/PT410|lease/i);
    expect(await counted(contact)).toBe(0);
  });

  it("los mensajes humanos no son corridas del agente: no ocupan cupo", async () => {
    const contact = newContact();
    for (let i = 0; i < 5; i++) await sent(contact);
    // El agente está en el tope; lo que escriba una recepcionista no es una corrida y no cambia el contador.
    const before = await counted(contact);
    await call(`select public.plusmedik_attention_register_human_message('human:${contact}:cap', '${contact}', null, 'HUMAN_WHATSAPP_BUSINESS_APP', 'kapso_business_app');`);
    expect(await counted(contact)).toBe(before);
  });

  it("la función es SECURITY DEFINER con search_path vacío y solo service_role la ejecuta", async () => {
    const signature = "plusmedik_turn_reserve_send_capped(uuid, text, bigint, text, integer, text, jsonb, jsonb)";
    expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`)).toBe("t");
    expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`)).toContain("search_path=");
    expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`)).toBe("t");
    for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`), role).toBe("f");
  });

  it("reaplicar la migración no falla ni borra datos", async () => {
    const contact = newContact();
    await sent(contact);
    await db.applyFile(join(dir, "20261106000000_plusmedik_daily_reply_cap.sql"));
    expect(await counted(contact)).toBe(1);
  });
});
