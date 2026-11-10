import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 17 (memoria conversacional corta) contra un PostgreSQL REAL y efímero: separación por contacto/línea, idempotencia, orden, límite, retención, validaciones y privilegios.
// NO se aplica a ningún Supabase remoto. Se omite, con aviso, si no hay PostgreSQL instalado.

const bin = findPostgresBin();
if (!bin) console.warn("[conversation-memory-db] PostgreSQL no disponible: se omiten las pruebas de la memoria conversacional contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const key = (n: number) => String(n).padStart(64, "0");
const CIPHER = "v1.aaaa.bbbb.cccc";
const lit = (value: string | null) => (value === null ? "null" : `'${value}'`);

describe.skipIf(!bin)("memoria conversacional contra PostgreSQL real (migración 17)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("conversation_memory");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  async function record(contact: string, direction: "IN" | "OUT", messageId: string, options: { cipher?: string; at?: string | null; days?: number | null } = {}) {
    const at = options.at === undefined ? "now() - interval '1 minute'" : options.at === null ? "null" : `'${options.at}'::timestamptz`;
    const sql = `select public.plusmedik_memory_record('${contact}', '${direction}', '${messageId}', '${options.cipher ?? CIPHER}', ${at}, ${options.days === undefined ? 7 : options.days === null ? "null" : options.days})::text`;
    return JSON.parse(await db.ok(asService(sql))) as { outcome: string };
  }
  async function recent(contact: string, limit = 5, exclude: string | null = null) {
    const out = await db.ok(asService(`select public.plusmedik_memory_recent('${contact}', ${limit}, ${lit(exclude)})::text`));
    return (JSON.parse(out).messages as Array<{ d: string; m: string; c: string; t: string }>).map((row) => `${row.d}:${row.m}`);
  }
  const rowCount = async (contact: string) => Number(await db.ok(`select count(*) from public.plusmedik_conversation_messages where contact_key = '${contact}'`));

  it("guarda y devuelve del más nuevo al más antiguo, sin el mensaje entrante que se está atendiendo", async () => {
    const c = key(++counter);
    await record(c, "IN", "wamid.a1", { at: "2026-01-01T10:00:00Z" });
    await record(c, "OUT", "wamid.b1", { at: "2026-01-01T10:00:05Z" });
    await record(c, "IN", "wamid.a2", { at: "2026-01-01T10:01:00Z" });
    expect(await recent(c)).toEqual(["IN:wamid.a2", "OUT:wamid.b1", "IN:wamid.a1"]);
    expect(await recent(c, 5, "wamid.a2")).toEqual(["OUT:wamid.b1", "IN:wamid.a1"]);
    // Excluir un id de entrada no esconde una respuesta con ese mismo id.
    await record(c, "OUT", "wamid.a2", { at: "2026-01-01T10:02:00Z" });
    expect(await recent(c, 5, "wamid.a2")).toEqual(["OUT:wamid.a2", "OUT:wamid.b1", "IN:wamid.a1"]);
  });

  it("es idempotente: repetir el mismo mensaje no crea otra fila (duplicate) y no cambia nada", async () => {
    const c = key(++counter);
    expect((await record(c, "IN", "wamid.dup")).outcome).toBe("recorded");
    expect((await record(c, "IN", "wamid.dup", { cipher: "v1.zzzz.yyyy.xxxx" })).outcome).toBe("duplicate");
    expect(await rowCount(c)).toBe(1);
    expect(await db.ok(`select body_cipher from public.plusmedik_conversation_messages where contact_key = '${c}'`)).toBe(CIPHER);
    // La misma identificación en dirección distinta sí es otro mensaje.
    expect((await record(c, "OUT", "wamid.dup")).outcome).toBe("recorded");
  });

  it("SEPARA contactos y líneas: la clave de otro contacto (otro paciente u otra línea) nunca ve estos mensajes", async () => {
    const patientA = key(++counter);
    const patientB = key(++counter);
    const sameAOtherLine = key(++counter);
    await record(patientA, "IN", "wamid.mine");
    await record(patientB, "IN", "wamid.theirs");
    await record(sameAOtherLine, "IN", "wamid.other-line");
    expect(await recent(patientA)).toEqual(["IN:wamid.mine"]);
    expect(await recent(patientB)).toEqual(["IN:wamid.theirs"]);
    expect(await recent(sameAOtherLine)).toEqual(["IN:wamid.other-line"]);
    // El mismo id de mensaje en otro contacto es independiente.
    expect((await record(patientB, "IN", "wamid.mine")).outcome).toBe("recorded");
    expect(await recent(patientA)).toEqual(["IN:wamid.mine"]);
  });

  it("devuelve como máximo el límite pedido (tope 10) y conserva solo los 40 más recientes por contacto", async () => {
    const c = key(++counter);
    for (let i = 0; i < 45; i++) await record(c, "IN", `wamid.m${i}`, { at: new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString() });
    expect(await rowCount(c)).toBe(40);
    expect((await recent(c, 5)).length).toBe(5);
    expect((await recent(c, 5))[0]).toBe("IN:wamid.m44");
    expect((await recent(c, 99)).length).toBe(10);
    expect((await recent(c, 0)).length).toBe(1);
    expect(await db.ok(`select count(*) from public.plusmedik_conversation_messages where contact_key = '${c}' and provider_message_id in ('wamid.m0','wamid.m4')`)).toBe("0");
  });

  it("los mensajes vencidos no se devuelven y una escritura posterior los purga; un instante futuro se acota a ahora", async () => {
    const c = key(++counter);
    await record(c, "IN", "wamid.old");
    await db.ok(`update public.plusmedik_conversation_messages set occurred_at = now() - interval '9 days', expires_at = now() - interval '1 day' where contact_key = '${c}'`);
    expect(await recent(c)).toEqual([]);
    expect(await rowCount(c)).toBe(1);
    const other = key(++counter);
    await record(other, "IN", "wamid.trigger-purge");
    expect(await rowCount(c)).toBe(0);
    await record(c, "IN", "wamid.future", { at: "2099-01-01T00:00:00Z" });
    expect(await db.ok(`select occurred_at <= now() from public.plusmedik_conversation_messages where contact_key = '${c}'`)).toBe("t");
  });

  it("la retención por defecto es de 7 días y se acota a 1-30", async () => {
    const c = key(++counter);
    await record(c, "IN", "wamid.r7", { days: null });
    expect(await db.ok(`select round(extract(epoch from expires_at - created_at) / 86400) from public.plusmedik_conversation_messages where contact_key = '${c}'`)).toBe("7");
    expect(await db.fails(asService(`select public.plusmedik_memory_record('${c}', 'IN', 'wamid.r0', '${CIPHER}', now(), 0)`))).toMatch(/PT422/);
    expect(await db.fails(asService(`select public.plusmedik_memory_record('${c}', 'IN', 'wamid.r31', '${CIPHER}', now(), 31)`))).toMatch(/PT422/);
  });

  it("rechaza entradas inválidas (clave que no es un HMAC, dirección, id, cuerpo que no es un texto cifrado) con PT422", async () => {
    const c = key(++counter);
    const attempt = (args: string) => db.fails(asService(`select public.plusmedik_memory_record(${args}, now(), 7)`));
    expect(await attempt(`'59172654203', 'IN', 'wamid.x', '${CIPHER}'`)).toMatch(/PT422/);
    expect(await attempt(`'${c}', 'XX', 'wamid.x', '${CIPHER}'`)).toMatch(/PT422/);
    expect(await attempt(`'${c}', 'IN', 'id con espacios', '${CIPHER}'`)).toMatch(/PT422/);
    expect(await attempt(`'${c}', 'IN', 'wamid.x', 'hola, esto es texto en claro'`)).toMatch(/PT422/);
    expect(await attempt(`'${c}', 'IN', 'wamid.x', 'v1.${"a".repeat(4000)}.b.c'`)).toMatch(/PT422/);
    expect(await db.fails(asService(`select public.plusmedik_memory_recent('no-es-una-clave', 5, null)`))).toMatch(/PT422/);
    expect(await rowCount(c)).toBe(0);
  });

  it("forget borra todo lo de UN contacto y nada de los demás", async () => {
    const a = key(++counter);
    const b = key(++counter);
    await record(a, "IN", "wamid.1");
    await record(a, "OUT", "wamid.2");
    await record(b, "IN", "wamid.3");
    expect(JSON.parse(await db.ok(asService(`select public.plusmedik_memory_forget('${a}')::text`))).deleted).toBe(2);
    expect(await rowCount(a)).toBe(0);
    expect(await rowCount(b)).toBe(1);
  });

  it("RLS activo; nadie (ni service_role) toca la tabla directamente; solo service_role ejecuta las funciones, que son SECURITY DEFINER con search_path vacío", async () => {
    expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.plusmedik_conversation_messages'::regclass`)).toBe("t");
    for (const role of ["anon", "authenticated", "service_role", "unprivileged"]) {
      for (const privilege of ["select", "insert", "update", "delete", "truncate"]) {
        expect(await db.ok(`select has_table_privilege('${role}', 'public.plusmedik_conversation_messages', '${privilege}')`), `${role} ${privilege}`).toBe("f");
      }
    }
    expect(await db.fails(asService(`select * from public.plusmedik_conversation_messages`))).toMatch(/permission denied/);
    for (const signature of ["plusmedik_memory_record(text, text, text, text, timestamptz, integer)", "plusmedik_memory_recent(text, integer, text)", "plusmedik_memory_forget(text)"]) {
      expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toBe("t");
      expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toContain("search_path=");
      expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`), signature).toBe("t");
      for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`), `${role} ${signature}`).toBe("f");
    }
  });

  it("la tabla no tiene ninguna columna con teléfono ni texto en claro", async () => {
    const columns = (await db.ok(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'plusmedik_conversation_messages' order by ordinal_position`)).split(/\r?\n/);
    expect(columns).toEqual(["id", "contact_key", "direction", "provider_message_id", "body_cipher", "occurred_at", "created_at", "expires_at"]);
  });

  it("reaplicar la migración no falla ni borra datos", async () => {
    const c = key(++counter);
    await record(c, "IN", "wamid.keep");
    await db.applyFile(join(dir, "20261105000000_plusmedik_conversation_memory.sql"));
    expect(await recent(c)).toEqual(["IN:wamid.keep"]);
  });
});
