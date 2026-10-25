import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 6 (turnos conversacionales) contra un PostgreSQL REAL y efímero: secuencia por contacto, un solo envío en vuelo por contacto, respuestas obsoletas,
// pausa humana y fencing. La migración NO se aplica a ningún Supabase remoto. Se omite, con aviso, si no hay PostgreSQL instalado.

const bin = findPostgresBin();
if (!bin) console.warn("[turns-db] PostgreSQL no disponible: se omiten las pruebas de turnos contra la base real.");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const BASE = ["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql", "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"];
const TURNS = "20261025000000_plusmedik_turns.sql";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;
const readMigration = (name: string) => readFileSync(join(migrationsDir, name), "utf8").replaceAll("\r\n", "\n");

describe.skipIf(!bin)("turnos conversacionales contra PostgreSQL real (migración 6)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("turns");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of [...BASE, TURNS]) await db.applyFile(join(migrationsDir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const newMessage = () => `wamid.turn-${++counter}-${Date.now()}`;
  // Claves de contacto de prueba: 64 hex, una distinta por paciente.
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const claimSql = (message: string, who: string, contact: string | null, kind: string | null = "TEXT", seconds = 120) =>
    `select public.plusmedik_turn_claim('${message}', null, '${who}', ${seconds}, 2, 'abc1234', '{}'::jsonb, 3, ${contact === null ? "null" : `'${contact}'`}, ${kind === null ? "null" : `'${kind}'`});`;
  const claim = (message: string, who: string, contact: string, kind = "TEXT", seconds = 120) => call(claimSql(message, who, contact, kind, seconds));
  const idOf = (message: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const row = async (message: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const turnOf = async (message: string): Promise<Json | undefined> => {
    const out = await db.ok(`select coalesce((select to_json(t) from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id where r.kapso_message_id = '${message}')::text, '')`);
    return out ? JSON.parse(out) : undefined;
  };
  const lastSeq = (contact: string) => db.ok(`select coalesce((select last_seq from public.plusmedik_contact_turns where contact_key = '${contact}'), -1)`);
  const reserveSql = (runId: string, who: string, fence: number, kind = "conversation", stale: string | null = "NONE") =>
    `select public.plusmedik_turn_reserve_send('${runId}'::uuid, '${who}', ${fence}, '${kind}', 120, ${stale === null ? "null" : `'${stale}'`});`;
  const reserve = (runId: string, who: string, fence: number, kind = "conversation", stale: string | null = "NONE") => call(reserveSql(runId, who, fence, kind, stale));
  const confirmSql = (runId: string, who: string, fence: number) => `select public.plusmedik_audit_confirm_send('${runId}'::uuid, '${who}', ${fence});`;
  const replySql = (runId: string, who: string, fence: number, state = "ACCEPTED", result = "conversation") =>
    `select public.plusmedik_audit_fenced_record_reply('${runId}'::uuid, '${who}', ${fence}, '{"state":"${state}","result":"${result}","processing_status":"COMPLETED"}'::jsonb);`;
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  // "Viaje en el tiempo": el propietario de la base mueve el vencimiento presentando la prueba de fencing, como hacen las funciones.
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 second' where kapso_message_id = '${message}';`);
  const pause = (contact: string) => call(`select public.plusmedik_attention_register_human_message('human:${contact}:${++counter}', '${contact}', null, 'HUMAN_WHATSAPP_BUSINESS_APP', 'kapso_business_app');`);

  // Un turno ya reclamado, listo para reservar.
  async function turn(contact: string, who = 1, kind = "TEXT") {
    const message = newMessage();
    const claimed = await claim(message, owner(who), contact, kind);
    return { message, claimed, id: await idOf(message), who: owner(who), fence: claimed.fence as number };
  }
  // Un turno que ya envió su respuesta (reservado y aceptado).
  async function replied(contact: string) {
    const t = await turn(contact);
    expect((await reserve(t.id, t.who, t.fence)).status).toBe("reserved");
    await call(replySql(t.id, t.who, t.fence));
    return t;
  }

  describe("esquema, privilegios e inmutabilidad", () => {
    it("la migración se puede volver a aplicar sin error y sin tocar datos (create if not exists / create or replace)", async () => {
      const contact = newContact();
      const t = await turn(contact);
      await db.applyFile(join(migrationsDir, TURNS));
      expect(await turnOf(t.message)).toMatchObject({ seq: 1, turn_kind: "TEXT" });
    });

    it("las tablas nuevas tienen RLS; service_role solo lee y nadie más tiene acceso", async () => {
      for (const table of ["plusmedik_contact_turns", "plusmedik_turns"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', 'select')`)).toBe("t");
        for (const privilege of ["insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', '${privilege}')`)).toBe("f");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', 'select')`)).toBe("f");
      }
    });

    it("las funciones nuevas son SECURITY DEFINER con search_path vacío; solo service_role las ejecuta", async () => {
      for (const signature of ["plusmedik_turn_claim(text, text, text, integer, integer, text, jsonb, integer, text, text)", "plusmedik_turn_reserve_send(uuid, text, bigint, text, integer, text)"]) {
        expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`)).toBe("t");
        expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`)).toContain("search_path=");
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`)).toBe("t");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`)).toBe("f");
      }
    });

    it("el turno es inmutable (ni el propietario puede modificarlo, borrarlo ni vaciar las tablas) y la secuencia solo avanza de uno en uno", async () => {
      const t = await turn(newContact());
      expect(await db.fails(`update public.plusmedik_turns set seq = seq + 1 where run_id = '${t.id}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`update public.plusmedik_turns set turn_kind = 'IMAGE' where run_id = '${t.id}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_turns where run_id = '${t.id}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_turns`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_contact_turns`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_contact_turns`)).toMatch(/PT409|immutable|cannot truncate/);
      expect(await db.fails(`update public.plusmedik_contact_turns set last_seq = last_seq + 5`)).toMatch(/PT409|sequence/);
      expect(await db.fails(`update public.plusmedik_contact_turns set last_seq = last_seq - 1`)).toMatch(/PT409|sequence/);
      expect(await db.fails(asService(`update public.plusmedik_turns set seq = seq`))).toMatch(/permission denied/);
      expect(await db.fails(asService(`insert into public.plusmedik_turns (run_id, contact_key, seq, turn_kind) values (gen_random_uuid(), '${"0".repeat(64)}', 1, 'TEXT')`))).toMatch(/permission denied/);
    });
  });

  describe("claim de un turno: secuencia por contacto", () => {
    it("asigna 1, 2, 3 por contacto (independiente entre contactos) y registra el tipo; el texto del mensaje no existe en la base", async () => {
      const a = newContact();
      const b = newContact();
      const [a1, a2, a3, b1] = [newMessage(), newMessage(), newMessage(), newMessage()];
      expect(await claim(a1, owner(1), a, "TEXT")).toMatchObject({ outcome: "claimed", seq: 1, turn_kind: "TEXT", fence: 1 });
      expect(await claim(a2, owner(1), a, "IMAGE")).toMatchObject({ outcome: "claimed", seq: 2, turn_kind: "IMAGE" });
      expect(await claim(a3, owner(1), a, "OTHER")).toMatchObject({ outcome: "claimed", seq: 3, turn_kind: "OTHER" });
      expect(await claim(b1, owner(1), b, "TEXT")).toMatchObject({ outcome: "claimed", seq: 1 });
      expect(await lastSeq(a)).toBe("3");
      expect(await lastSeq(b)).toBe("1");
      expect(await row(a2)).toMatchObject({ contact_key: a, lease_owner: owner(1), processing_status: "PROCESSING" });
      const columns = await db.ok(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name in ('plusmedik_turns', 'plusmedik_contact_turns')`);
      expect(columns).not.toMatch(/text|body|content|message|phone/);
    });

    it("el reintento idéntico de la misma ejecución conserva su turno; un duplicado ('busy') no consume secuencia ni crea otro turno", async () => {
      const contact = newContact();
      const message = newMessage();
      expect(await claim(message, owner(1), contact)).toMatchObject({ outcome: "claimed", seq: 1 });
      expect(await claim(message, owner(1), contact)).toMatchObject({ outcome: "claimed", seq: 1 });
      expect((await claim(message, owner(2), contact)).outcome).toBe("busy");
      expect(await lastSeq(contact)).toBe("1");
      expect(await db.ok(`select count(*) from public.plusmedik_turns where contact_key = '${contact}'`)).toBe("1");
    });

    it("tras el vencimiento del lease otra ejecución lo reclama (generación 2) y el turno conserva su lugar en la secuencia", async () => {
      const contact = newContact();
      const first = newMessage();
      const second = newMessage();
      await claim(first, owner(1), contact);
      await claim(second, owner(1), contact);
      await expire(first);
      expect(await claim(first, owner(2), contact)).toMatchObject({ outcome: "taken_over", fence: 2, seq: 1 });
      expect(await turnOf(first)).toMatchObject({ seq: 1 });
      expect(await lastSeq(contact)).toBe("2");
    });

    it("un contacto en pausa humana no recibe turno: no hay corrida, no se consume secuencia", async () => {
      const contact = newContact();
      const before = await claim(newMessage(), owner(1), contact);
      expect(before.seq).toBe(1);
      expect((await pause(contact)).outcome).toBe("PAUSED");
      const message = newMessage();
      expect(await claim(message, owner(1), contact)).toEqual({ outcome: "paused" });
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${message}'`)).toBe("0");
      expect(await lastSeq(contact)).toBe("1");
    });

    it("argumentos inválidos se rechazan (PT422) sin eco de valores: sin clave de contacto, clave mal formada o tipo de turno desconocido", async () => {
      const message = newMessage();
      for (const sql of [claimSql(message, owner(1), null), claimSql(message, owner(1), "no-es-hex"), claimSql(message, owner(1), newContact(), "VIDEO"), claimSql(message, owner(1), newContact(), null)]) {
        const error = await db.fails(asService(sql));
        expect(error).toContain("PT422");
        expect(error).not.toContain("no-es-hex");
        expect(error).not.toContain("VIDEO");
      }
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${message}'`)).toBe("0");
    });

    it("ocho claims simultáneos del mismo contacto reciben ocho números distintos y consecutivos (sin huecos ni repetidos)", async () => {
      const contact = newContact();
      const messages = Array.from({ length: 8 }, () => newMessage());
      const results = await Promise.all(messages.map((message) => db.psql(asService(claimSql(message, owner(1), contact)))));
      const seqs = results.map((r) => first(r.stdout).seq as number).sort((x, y) => x - y);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await lastSeq(contact)).toBe("8");
    });

    it("se puede llamar como lo hace el cliente: solo argumentos con nombre y SIN p_max_attempts (igual que claim_run, el valor por defecto es 3)", async () => {
      const contact = newContact();
      const message = newMessage();
      const result = await call(`select public.plusmedik_turn_claim(p_message_id => '${message}', p_media_id => null, p_owner => '${owner(1)}', p_lease_seconds => 120, p_schema_version => 2, p_engine_version => null, p_flags => '{}'::jsonb, p_contact_key => '${contact}', p_turn_kind => 'IMAGE');`);
      expect(result).toMatchObject({ outcome: "claimed", seq: 1, turn_kind: "IMAGE" });
      expect(await db.ok(`select lease_attempts from public.plusmedik_audit_runs where kapso_message_id = '${message}'`)).toBe("1");
      // tres intentos y se agota igual que con la función de siempre
      await expire(message);
      expect((await call(`select public.plusmedik_turn_claim(p_message_id => '${message}', p_media_id => null, p_owner => '${owner(2)}', p_lease_seconds => 120, p_schema_version => 2, p_engine_version => null, p_flags => '{}'::jsonb, p_contact_key => '${contact}', p_turn_kind => 'IMAGE');`)).outcome).toBe("taken_over");
      await expire(message);
      expect((await call(`select public.plusmedik_turn_claim(p_message_id => '${message}', p_media_id => null, p_owner => '${owner(3)}', p_lease_seconds => 120, p_schema_version => 2, p_engine_version => null, p_flags => '{}'::jsonb, p_contact_key => '${contact}', p_turn_kind => 'IMAGE');`)).outcome).toBe("taken_over");
      await expire(message);
      expect((await call(`select public.plusmedik_turn_claim(p_message_id => '${message}', p_media_id => null, p_owner => '${owner(4)}', p_lease_seconds => 120, p_schema_version => 2, p_engine_version => null, p_flags => '{}'::jsonb, p_contact_key => '${contact}', p_turn_kind => 'IMAGE');`)).outcome).toBe("exhausted");
    });

    it("el camino anterior (claim_run directo, sin turnos) sigue funcionando y no crea turnos", async () => {
      const message = newMessage();
      const result = await call(`select public.plusmedik_audit_claim_run('${message}', 'media-1', '${owner(1)}', 120, 2, 'abc1234', '{}'::jsonb, 3);`);
      expect(result).toMatchObject({ outcome: "claimed", fence: 1 });
      expect(await turnOf(message)).toBeUndefined();
    });
  });

  describe("reserva de envío por turno: un solo envío en vuelo por contacto", () => {
    it("acepta el nuevo tipo 'conversation' (también en la reserva y el resultado heredados) y sigue rechazando tipos desconocidos", async () => {
      const t = await turn(newContact());
      expect(await reserve(t.id, t.who, t.fence)).toMatchObject({ status: "reserved" });
      expect(await row(t.message)).toMatchObject({ send_state: "RESERVED", send_kind: "conversation" });
      expect(await call(replySql(t.id, t.who, t.fence))).toMatchObject({ status: "recorded" });
      expect(await row(t.message)).toMatchObject({ send_state: "ACCEPTED", reply_kind: "conversation", reply_state: "ACCEPTED" });
      expect(await phase(t.message)).toBe("SENT_ACCEPTED");
      const other = await turn(newContact());
      expect(await db.fails(asService(reserveSql(other.id, other.who, other.fence, "bogus")))).toContain("PT422");
      expect(await db.fails(asService(reserveSql(other.id, other.who, other.fence, "conversation", "WHENEVER")))).toContain("PT422");
      // el camino heredado (sin turnos) acepta el mismo tipo
      const legacy = newMessage();
      await call(`select public.plusmedik_audit_claim_run('${legacy}', null, '${owner(1)}', 120, 2, 'abc1234', '{}'::jsonb, 3);`);
      const legacyId = await idOf(legacy);
      expect(await call(`select public.plusmedik_audit_reserve_send('${legacyId}'::uuid, '${owner(1)}', 1, 'conversation', 120);`)).toMatchObject({ status: "reserved" });
      expect(await db.fails(asService(`select public.plusmedik_audit_reserve_send('${legacyId}'::uuid, '${owner(1)}', 1, 'bogus', 120);`))).toContain("PT422");
    });

    it("mientras otro turno del MISMO contacto tiene su envío reservado y vigente, este recibe 'busy' y no cambia de estado; al aceptarse el envío ya reserva", async () => {
      const contact = newContact();
      const a = await turn(contact);
      const b = await turn(contact, 2);
      expect((await reserve(a.id, a.who, a.fence)).status).toBe("reserved");
      expect(await reserve(b.id, b.who, b.fence)).toEqual({ status: "busy" });
      expect(await row(b.message)).toMatchObject({ send_state: "NOT_RESERVED", processing_status: "PROCESSING" });
      await call(replySql(a.id, a.who, a.fence));
      expect((await reserve(b.id, b.who, b.fence)).status).toBe("reserved");
    });

    it("la reserva repetida del mismo turno es idempotente aunque otro turno esté en vuelo (un reintento tras un resultado desconocido)", async () => {
      const contact = newContact();
      const a = await turn(contact);
      expect((await reserve(a.id, a.who, a.fence)).status).toBe("reserved");
      expect((await reserve(a.id, a.who, a.fence)).status).toBe("reserved");
      expect(await db.fails(asService(reserveSql(a.id, a.who, a.fence, "quoted")))).toContain("PT409");
    });

    it("un envío en vuelo cuyo lease ya venció no bloquea al contacto (es un resultado dudoso que el recuperador marcará UNKNOWN)", async () => {
      const contact = newContact();
      const a = await turn(contact);
      const b = await turn(contact, 2);
      await reserve(a.id, a.who, a.fence);
      await expire(a.message);
      expect((await reserve(b.id, b.who, b.fence)).status).toBe("reserved");
      expect(await call(`select public.plusmedik_audit_recover_stale(0, 0, 50);`)).toMatchObject({ send_outcome_unknown: 1 });
      expect(await phase(a.message)).toBe("SEND_UNKNOWN");
    });

    it("contactos distintos no se bloquean entre sí", async () => {
      const a = await turn(newContact());
      const b = await turn(newContact());
      expect((await reserve(a.id, a.who, a.fence)).status).toBe("reserved");
      expect((await reserve(b.id, b.who, b.fence)).status).toBe("reserved");
    });

    it("dos reservas simultáneas del mismo contacto: exactamente una se concede y la otra recibe 'busy' (serializadas por el bloqueo del contacto)", async () => {
      const contact = newContact();
      const a = await turn(contact);
      const b = await turn(contact, 2);
      const slow = db.psql(`set role service_role; begin; ${reserveSql(a.id, a.who, a.fence)} select pg_sleep(1.5); commit;`);
      await sleep(500);
      const fast = db.psql(asService(reserveSql(b.id, b.who, b.fence)));
      const [x, y] = await Promise.all([slow, fast]);
      expect(first(x.stdout).status).toBe("reserved");
      expect(first(y.stdout).status).toBe("busy");
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}' and send_state = 'RESERVED'`)).toBe("1");
    });

    it("sin lease vigente (otra ejecución lo reclamó) no se reserva: PT410 y nada cambia", async () => {
      const t = await turn(newContact());
      await expire(t.message);
      await claim(t.message, owner(2), (await row(t.message)).contact_key);
      expect(await db.fails(asService(reserveSql(t.id, t.who, t.fence)))).toContain("PT410");
      expect(await db.fails(asService(reserveSql(t.id, owner(9), 2)))).toContain("PT410");
      expect(await row(t.message)).toMatchObject({ send_state: "NOT_RESERVED", lease_owner: owner(2), lease_fence: 2 });
    });
  });

  describe("respuestas obsoletas", () => {
    it("con NEWER_TURN, si un turno MÁS NUEVO del contacto ya tiene su respuesta reservada o enviada, la respuesta vieja se descarta (CANCELLED / SUPERSEDED) y no se envía", async () => {
      const contact = newContact();
      const old = await turn(contact);
      const fresh = await turn(contact, 2);
      expect((await reserve(fresh.id, fresh.who, fresh.fence)).status).toBe("reserved");
      await call(replySql(fresh.id, fresh.who, fresh.fence));
      expect(await reserve(old.id, old.who, old.fence, "conversation", "NEWER_TURN")).toEqual({ status: "superseded" });
      expect(await row(old.message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "SUPERSEDED", processing_status: "COMPLETED" });
      expect(await phase(old.message)).toBe("CLOSED_NO_SEND");
      // una vez descartada, no se reabre: reservar de nuevo responde 'closed'
      expect(await reserve(old.id, old.who, old.fence, "conversation", "NEWER_TURN")).toEqual({ status: "closed" });
      expect(await reserve(old.id, old.who, old.fence, "conversation", "NONE")).toEqual({ status: "closed" });
    });

    it("con NONE la respuesta vieja se envía igual (p. ej. una cotización nunca se descarta en silencio)", async () => {
      const contact = newContact();
      const old = await turn(contact, 1, "IMAGE");
      await replied(contact);
      expect((await reserve(old.id, old.who, old.fence, "quoted", "NONE")).status).toBe("reserved");
    });

    it("un turno más nuevo que todavía NO reservó (está analizando) o que se cerró sin respuesta NO vuelve obsoleta la respuesta vieja", async () => {
      const contact = newContact();
      const old = await turn(contact);
      const analysing = await turn(contact, 2);
      const closed = await turn(contact, 3);
      await call(`select public.plusmedik_audit_fenced_close('${closed.id}'::uuid, '${closed.who}', ${closed.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`);
      expect(await row(closed.message)).toMatchObject({ send_state: "NOT_APPLICABLE" });
      expect(await row(analysing.message)).toMatchObject({ send_state: "NOT_RESERVED" });
      expect((await reserve(old.id, old.who, old.fence, "conversation", "NEWER_TURN")).status).toBe("reserved");
    });

    it("un turno MÁS VIEJO nunca vuelve obsoleto a uno más nuevo, y otro contacto tampoco", async () => {
      const contact = newContact();
      const old = await turn(contact);
      const fresh = await turn(contact, 2);
      await reserve(old.id, old.who, old.fence);
      await call(replySql(old.id, old.who, old.fence));
      expect((await reserve(fresh.id, fresh.who, fresh.fence, "conversation", "NEWER_TURN")).status).toBe("reserved");
      const other = await turn(newContact());
      await replied(newContact());
      expect((await reserve(other.id, other.who, other.fence, "conversation", "NEWER_TURN")).status).toBe("reserved");
    });

    it("orden de decisión: un turno más nuevo EN VUELO hace esperar ('busy'); cuando termina, el viejo se descarta y no se envía fuera de orden", async () => {
      const contact = newContact();
      const old = await turn(contact);
      const fresh = await turn(contact, 2);
      await reserve(fresh.id, fresh.who, fresh.fence);
      expect((await reserve(old.id, old.who, old.fence, "conversation", "NEWER_TURN")).status).toBe("busy");
      await call(replySql(fresh.id, fresh.who, fresh.fence));
      expect((await reserve(old.id, old.who, old.fence, "conversation", "NEWER_TURN")).status).toBe("superseded");
    });
  });

  describe("pausa humana y comprobación final", () => {
    it("una pausa posterior al claim bloquea la reserva del turno (blocked, CANCELLED); la pausa decide antes que nada", async () => {
      const contact = newContact();
      const t = await turn(contact);
      expect((await pause(contact)).outcome).toBe("PAUSED");
      // el registro de la pausa ya bloqueó el procesamiento pendiente del contacto
      expect(await row(t.message)).toMatchObject({ send_blocked_at: expect.any(String), send_block_reason: "HUMAN_PAUSED" });
      expect(await reserve(t.id, t.who, t.fence)).toEqual({ status: "blocked" });
      expect(await row(t.message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
    });

    it("la pausa entre la reserva y el envío libera la reserva en la comprobación final (confirm_send) y el siguiente turno no queda bloqueado por ella", async () => {
      const contact = newContact();
      const t = await turn(contact);
      expect((await reserve(t.id, t.who, t.fence)).status).toBe("reserved");
      expect((await call(confirmSql(t.id, t.who, t.fence))).status).toBe("proceed");
      await pause(contact);
      expect((await call(confirmSql(t.id, t.who, t.fence))).status).toBe("blocked");
      expect(await row(t.message)).toMatchObject({ send_state: "CANCELLED" });
    });

    it("tras la reactivación el contacto vuelve a recibir turnos y la secuencia continúa", async () => {
      const contact = newContact();
      await claim(newMessage(), owner(1), contact);
      await pause(contact);
      expect(await claim(newMessage(), owner(1), contact)).toEqual({ outcome: "paused" });
      await call(`select public.plusmedik_attention_resume('${contact}', 'MANUAL_RESUME', 'ops_user');`);
      expect(await claim(newMessage(), owner(1), contact)).toMatchObject({ outcome: "claimed", seq: 2 });
    });
  });
});

// Sin base de datos: la migración 6 redefine dos funciones anteriores. Debe diferir de la versión que reemplaza SOLO en el nuevo tipo de envío.
describe("la migración 6 no cambia nada más de lo que redefine", () => {
  const body = (sql: string, name: string): string => {
    const start = sql.indexOf(`create or replace function public.${name}(`);
    expect(start, `${name} no está definida`).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf("end $$;", start);
    return sql.slice(start, end + "end $$;".length);
  };
  const widen = (text: string) => text.replaceAll("('quoted', 'no_quote', 'technical_issue', 'ignored')", "('quoted', 'no_quote', 'technical_issue', 'conversation', 'ignored')").replaceAll("('quoted', 'no_quote', 'technical_issue')", "('quoted', 'no_quote', 'technical_issue', 'conversation')");
  const turns = readMigration(TURNS);

  it("plusmedik_audit_reserve_send (versión de la migración 5) solo gana el tipo 'conversation'", () => {
    const before = body(readMigration("20261024000000_plusmedik_human_control.sql"), "plusmedik_audit_reserve_send");
    expect(body(turns, "plusmedik_audit_reserve_send")).toBe(widen(before));
  });

  it("plusmedik_audit_record_reply (versión de la migración 3) solo gana el tipo 'conversation'", () => {
    const before = body(readMigration("20261022000000_plusmedik_audit_transactional.sql"), "plusmedik_audit_record_reply");
    expect(body(turns, "plusmedik_audit_record_reply")).toBe(widen(before));
  });

  it("las cinco migraciones anteriores siguen byte a byte como en origin/main (G2.0 no las modificó)", () => {
    const sha = (name: string) => createHash("sha256").update(readMigration(name)).digest("hex");
    expect(Object.fromEntries(BASE.map((name) => [name, sha(name)]))).toEqual({
      "20261020000000_plusmedik_persistent_audit.sql": "1110edc1e1b3f6c4961b87bdb763ecea535ef5b1d6ba9086ff314a86b88ad61a",
      "20261021000000_plusmedik_audit_telemetry.sql": "08e555cf0c872ce2380cbd5046c2296a525c20b6caaddee6ae51ccdb53243256",
      "20261022000000_plusmedik_audit_transactional.sql": "1135f673e0a8e5de5ef03dae1acae55427c01ff99f4a5988f90595abe9244079",
      "20261023000000_plusmedik_audit_leases.sql": "1b6546c2a44142a00b771f303dccc43f5ea408cd912a340c3b3e406e63185ee7",
      "20261024000000_plusmedik_human_control.sql": "21430ed091a169945d1f5b9109484c11a34a5d7e9981d715dc2c83c36fc9658d"
    });
  });

  it("no modifica las migraciones anteriores ni toca el catálogo ni el esquema del CRM", () => {
    expect(turns).not.toMatch(/lab_tests|lab_test_aliases|\bcrm\./);
    expect(turns).not.toMatch(/drop\s+(table|function|trigger|column)/i);
    expect(turns).not.toMatch(/\bdelete\s+from\b/i);
    expect(turns).not.toMatch(/(?<!before )\btruncate\s+(table\s+)?public/i);
  });
});
