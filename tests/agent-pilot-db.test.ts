import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 25 (plusmedik_agent_pilot): el interruptor de desactivación inmediata del piloto y la lectura acotada de mensajes recientes. Contra PostgreSQL REAL y efímero; NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[agent-pilot-db] PostgreSQL no disponible: se omiten las pruebas de la migración 25 contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const FILE = "20261113000000_plusmedik_agent_pilot.sql";
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
type Json = Record<string, any>;

describe("migración 25 (plusmedik_agent_pilot): forma estática", () => {
  const raw = readFileSync(join(dir, FILE), "utf8").replaceAll("\r\n", "\n");
  const code = raw.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");

  it("es la última de la cadena, posterior a la de eventos de conversación", () => {
    expect(MIGRATIONS.at(-1)).toBe(FILE);
    expect(MIGRATIONS.at(-2)).toBe("20261112000000_plusmedik_conversation_events.sql");
  });

  it("es ADITIVA: no borra ni modifica nada existente y no toca el CRM ni el catálogo", () => {
    expect([...code.matchAll(/create table if not exists public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_agent_pilot_switch", "plusmedik_agent_pilot_log"]);
    expect([...code.matchAll(/create or replace function public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_agent_pilot_state", "plusmedik_agent_pilot_set", "plusmedik_history_recent"]);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|constraint|schema)\b|\btruncate\b|\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.plusmedik_message_history\b/i);
    expect(code).not.toMatch(/\bcrm\./i);
    expect(code).not.toMatch(/\blab_tests\b/i);
  });

  it("NACE APAGADO y el cambio solo lo puede hacer quien administra la base: set no se concede a ningún rol de la API", () => {
    // la migración no siembra datos (regla de las migraciones): sin fila, apagado
    expect(code).not.toMatch(/insert into public\.plusmedik_agent_pilot_switch[\s\S]*estado inicial/);
    expect(code).toMatch(/coalesce\(\(select s\.enabled from public\.plusmedik_agent_pilot_switch s where s\.id = 1\), false\)/);
    expect(code).toMatch(/revoke all on function public\.plusmedik_agent_pilot_set\(boolean, text\) from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant execute on function public\.plusmedik_agent_pilot_set/);
    expect(code).toMatch(/revoke all on table public\.plusmedik_agent_pilot_switch from public, anon, authenticated, service_role;/);
  });

  it("las dos lecturas son STABLE y SECURITY DEFINER con search_path vacío, solo para service_role", () => {
    expect(code).toMatch(/plusmedik_agent_pilot_state\(\)\s+returns jsonb\s+language sql\s+stable\s+security definer\s+set search_path = ''/);
    expect(code).toMatch(/plusmedik_history_recent\([^)]*\)\s+returns jsonb\s+language plpgsql\s+stable\s+security definer\s+set search_path = ''/);
    expect(code).toMatch(/grant execute on function public\.plusmedik_agent_pilot_state\(\) to service_role;/);
    expect(code).toMatch(/grant execute on function public\.plusmedik_history_recent\(text, integer, text\[\], timestamptz\) to service_role;/);
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });
});

describe.skipIf(!bin)("migración 25 (plusmedik_agent_pilot) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("agent_pilot");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const last = (out: string) => out.split("\n").filter(Boolean).at(-1)!;
  const call = async (sql: string): Promise<Json> => JSON.parse(last(await db.ok(asService(sql))));
  const state = () => call("select public.plusmedik_agent_pilot_state();");
  const newContact = () => (++counter).toString(16).padStart(64, "0");

  describe("interruptor", () => {
    it("nace APAGADO (sin fila: la migración no siembra nada) y se lee con service_role", async () => {
      expect(await db.ok(`select count(*) from public.plusmedik_agent_pilot_switch`)).toBe("0");
      expect((await state()).enabled).toBe(false);
    });

    it("el administrador lo enciende y lo apaga al instante, con rastro; un motivo inválido se rechaza", async () => {
      const on = JSON.parse(last(await db.ok(`select public.plusmedik_agent_pilot_set(true, 'inicio del piloto con un número de prueba');`)));
      expect(on.enabled).toBe(true);
      expect((await state()).enabled).toBe(true);
      await db.ok(`select public.plusmedik_agent_pilot_set(false, 'apagado de emergencia');`);
      expect((await state()).enabled).toBe(false);
      expect(await db.ok(`select string_agg(enabled::text || ':' || reason, ' | ' order by id) from public.plusmedik_agent_pilot_log`)).toBe("true:inicio del piloto con un número de prueba | false:apagado de emergencia");
      expect(await db.fails(`select public.plusmedik_agent_pilot_set(true, 'x');`)).toContain("PT422");
      expect(await db.fails(`select public.plusmedik_agent_pilot_set(null, 'motivo válido');`)).toContain("PT422");
      expect(await db.fails(`select public.plusmedik_agent_pilot_set(true, '${"a".repeat(201)}');`)).toContain("PT422");
    });

    it("ningún rol de la API puede cambiarlo, ni leer ni escribir las tablas; anon y authenticated tampoco lo leen", async () => {
      for (const role of ["service_role", "anon", "authenticated"]) {
        expect(await db.fails(`set role ${role}; select public.plusmedik_agent_pilot_set(true, 'intento no autorizado');`), role).toContain("permission denied");
        expect(await db.fails(`set role ${role}; select * from public.plusmedik_agent_pilot_switch;`), role).toContain("permission denied");
        expect(await db.fails(`set role ${role}; update public.plusmedik_agent_pilot_switch set enabled = true;`), role).toContain("permission denied");
        expect(await db.fails(`set role ${role}; select * from public.plusmedik_agent_pilot_log;`), role).toContain("permission denied");
      }
      for (const role of ["anon", "authenticated"]) expect(await db.fails(`set role ${role}; select public.plusmedik_agent_pilot_state();`), role).toContain("permission denied");
      expect((await state()).enabled).toBe(false);
    });

    it("reaplicar la migración (reintento tras un corte) NO cambia el estado: si estaba encendido, sigue encendido", async () => {
      await db.ok(`select public.plusmedik_agent_pilot_set(true, 'prueba de reaplicación');`);
      await db.ok(readFileSync(join(dir, FILE), "utf8"));
      expect((await state()).enabled).toBe(true);
      await db.ok(`select public.plusmedik_agent_pilot_set(false, 'restablecer');`);
      expect(await db.ok(`select count(*) from public.plusmedik_agent_pilot_switch`)).toBe("1");
    });

    it("la lectura es de solo lectura de verdad (STABLE, dentro de una transacción de solo lectura)", async () => {
      await db.ok(asService("begin read only; select public.plusmedik_agent_pilot_state(); rollback;"));
      expect(await db.ok(`select string_agg(distinct p.provolatile::text, ',') from pg_proc p where p.proname in ('plusmedik_agent_pilot_state', 'plusmedik_history_recent')`)).toBe("s");
    });
  });

  describe("mensajes recientes de un contacto", () => {
    const insert = (contact: string, id: string, direction: "IN" | "OUT", actor: string, kind: string, state: string, body: string | null, at: string, extra = "") =>
      db.ok(`insert into public.plusmedik_message_history (account_id, contact_key, provider_message_id, direction, actor, content_kind, delivery_state, body, occurred_at${extra ? ", expires_at" : ""}) values ('acc', '${contact}', '${id}', '${direction}', '${actor}', '${kind}', '${state}', ${body === null ? "null" : `$b$${body}$b$`}, '${at}'${extra ? `, ${extra}` : ""})`);
    const recent = (contact: string, limit = 7, exclude: string[] = [], since = "2000-01-01T00:00:00Z") =>
      call(`select public.plusmedik_history_recent('${contact}', ${limit}, ${exclude.length === 0 ? "null::text[]" : `array[${exclude.map((e) => `'${e}'`).join(",")}]::text[]`}, '${since}'::timestamptz);`);

    it("devuelve los últimos mensajes de TEXTO en orden cronológico, con quién habló, y solo los de ese contacto", async () => {
      const contact = newContact();
      const other = newContact();
      await insert(contact, "m1", "IN", "PATIENT", "TEXT", "RECEIVED", "hola buenas", "2026-11-05T10:00:00Z");
      await insert(contact, "m2", "OUT", "AGENT", "TEXT", "ACCEPTED", "Hola, ¿en qué te ayudo?", "2026-11-05T10:00:05Z");
      await insert(contact, "m3", "OUT", "HUMAN", "TEXT", "SENT", "Le atiende recepción", "2026-11-05T10:05:00Z");
      await insert(other, "x1", "IN", "PATIENT", "TEXT", "RECEIVED", "mensaje de otro paciente", "2026-11-05T10:01:00Z");
      const messages = (await recent(contact)).messages as Json[];
      expect(messages.map((m) => `${m.direction}/${m.actor}:${m.body}`)).toEqual(["IN/PATIENT:hola buenas", "OUT/AGENT:Hola, ¿en qué te ayudo?", "OUT/HUMAN:Le atiende recepción"]);
      expect(JSON.stringify(messages)).not.toContain("otro paciente");
    });

    it("deja afuera lo que no es texto legible: imágenes, audios, sin cuerpo, envíos inciertos o fallidos, vencidos y los ids excluidos", async () => {
      const contact = newContact();
      await insert(contact, "a1", "IN", "PATIENT", "IMAGE", "RECEIVED", "pie de foto", "2026-11-05T09:00:00Z");
      await insert(contact, "a2", "IN", "PATIENT", "TEXT", "RECEIVED", null, "2026-11-05T09:01:00Z");
      await insert(contact, "a3", "OUT", "AGENT", "TEXT", "UNCERTAIN", "no se sabe si salió", "2026-11-05T09:02:00Z");
      await insert(contact, "a4", "OUT", "AGENT", "TEXT", "FAILED", "falló", "2026-11-05T09:03:00Z");
      await insert(contact, "a5", "IN", "PATIENT", "TEXT", "RECEIVED", "vencido", "2026-11-05T09:04:00Z", "'2026-11-05T09:04:01Z'");
      await insert(contact, "a6", "IN", "PATIENT", "TEXT", "RECEIVED", "del lote actual", "2026-11-05T09:05:00Z");
      await insert(contact, "a7", "IN", "PATIENT", "TEXT", "RECEIVED", "se queda", "2026-11-05T09:06:00Z");
      const messages = (await recent(contact, 10, ["a6"])).messages as Json[];
      expect(messages.map((m) => m.body)).toEqual(["se queda"]);
    });

    it("respeta el límite (se queda con los MÁS recientes), la fecha mínima y recorta cada texto a 600 caracteres", async () => {
      const contact = newContact();
      for (let i = 1; i <= 5; i++) await insert(contact, `b${i}`, "IN", "PATIENT", "TEXT", "RECEIVED", i === 5 ? "z".repeat(900) : `mensaje ${i}`, `2026-11-05T11:0${i}:00Z`);
      const two = (await recent(contact, 2)).messages as Json[];
      expect(two.map((m) => m.body.length)).toEqual([9, 600]);
      expect(two[0]!.body).toBe("mensaje 4");
      const since = (await recent(contact, 10, [], "2026-11-05T11:03:30Z")).messages as Json[];
      expect(since.map((m) => m.body.length)).toEqual([9, 600]);
    });

    it("valida contacto, límite, fecha y la cantidad de ids excluidos", async () => {
      const contact = newContact();
      const reject = async (sql: string) => expect(await db.fails(asService(sql))).toContain("PT422");
      await reject(`select public.plusmedik_history_recent('no-es-hash', 5, null, now());`);
      await reject(`select public.plusmedik_history_recent('${contact}', 0, null, now());`);
      await reject(`select public.plusmedik_history_recent('${contact}', 21, null, now());`);
      await reject(`select public.plusmedik_history_recent('${contact}', 5, null, null);`);
      await reject(`select public.plusmedik_history_recent('${contact}', 5, array_fill('x'::text, array[51]), now());`);
      expect(((await recent(contact, 5)).messages as Json[])).toEqual([]);
    });

    it("anon y authenticated no pueden leerlo", async () => {
      const contact = newContact();
      for (const role of ["anon", "authenticated"]) expect(await db.fails(`set role ${role}; select public.plusmedik_history_recent('${contact}', 5, null, now());`), role).toContain("permission denied");
    });
  });
});
