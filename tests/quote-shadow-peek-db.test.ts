import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 20 (plusmedik_quote_shadow_peek): la lectura de SOLO LECTURA que usa el modo sombra del motor de lotes. Se prueba contra las 19 anteriores en un PostgreSQL REAL y efímero. NO se aplica a ningún
// Supabase remoto. Lo central: la base misma impide que escriba (función STABLE), no bloquea filas, no vence sesiones (a diferencia de la lectura de siempre) y exige el lease vigente.

const bin = findPostgresBin();
if (!bin) console.warn("[quote-shadow-peek-db] PostgreSQL no disponible: se omiten las pruebas de la migración 20 contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const PEEK = "20261108000000_plusmedik_quote_shadow_peek.sql";
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
type Json = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const resolved = (...ids: number[]): Json => ({ status: "RESOLVED", studyIds: ids.map(uuid), ambiguous: [], unresolved: 0, reasons: [] });
const FP = "a".repeat(64);

describe("migración 20 (plusmedik_quote_shadow_peek): forma estática", () => {
  const raw = readFileSync(join(dir, PEEK), "utf8").replaceAll("\r\n", "\n");
  const code = raw.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");

  it("es la vigésima de la cadena, posterior a la del buffering nativo (19) y anterior a las del historial de mensajes (21, 22 y 23)", () => {
    expect(MIGRATIONS.at(-1)).toBe("20261111000000_plusmedik_message_history_phone.sql");
    expect(MIGRATIONS.at(-2)).toBe("20261110000000_plusmedik_message_history_plaintext.sql");
    expect(MIGRATIONS.at(-3)).toBe("20261109000000_plusmedik_message_history.sql");
    expect(MIGRATIONS.at(-4)).toBe(PEEK);
    expect(MIGRATIONS.at(-5)).toBe("20261107000000_plusmedik_batch_fold.sql");
  });

  it("es ADITIVA: una sola función nueva y NADA que escriba, bloquee o borre; no toca el CRM ni el catálogo", () => {
    expect([...code.matchAll(/create or replace function public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_quote_shadow_peek"]);
    expect(code).not.toMatch(/\b(drop|delete|truncate|insert|update|create\s+table|create\s+(or\s+replace\s+)?(view|trigger)|alter|create\s+index|perform|lock)\b/i);
    expect(code).not.toMatch(/for\s+(update|share|no\s+key\s+update)/i);
    // ni la lectura que bloquea y vence sesiones, ni el bloqueo de lease
    expect(code).not.toMatch(/plusmedik_audit_lock_leased|plusmedik_quote_session_read|plusmedik_contact_turns/);
    expect(code).not.toMatch(/\bcrm\./i);
    expect(code).not.toMatch(/\blab_tests\b/i);
  });

  it("es STABLE (la propia base impide que escriba o tome bloqueos de fila), SECURITY DEFINER con search_path vacío, y solo service_role la ejecuta", () => {
    expect(code).toMatch(/language plpgsql\s+stable\s+security definer\s+set search_path = ''/);
    expect(code).toMatch(/revoke all on function public\.plusmedik_quote_shadow_peek\(uuid, text, bigint, integer\) from public, anon, authenticated;/);
    expect(code).toMatch(/grant execute on function public\.plusmedik_quote_shadow_peek\(uuid, text, bigint, integer\) to service_role;/);
    expect(code).not.toMatch(/to\s+(anon|authenticated|public)\b/i);
  });
});

describe.skipIf(!bin)("migración 20 (plusmedik_quote_shadow_peek) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("quote_shadow_peek");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const json = (value: unknown) => (value === null || value === undefined ? "null::jsonb" : `$q$${JSON.stringify(value)}$q$::jsonb`);
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  interface Turn { id: string; who: string; fence: number; contact: string }
  async function turn(contact: string, kind = "TEXT", who = 1): Promise<Turn> {
    const message = `wamid.peek-${++counter}-${Date.now()}`;
    const claimed = await call(`select public.plusmedik_turn_claim('${message}', null, '${owner(who)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', '${kind}');`);
    return { id: await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`), who: owner(who), fence: claimed.fence as number, contact };
  }
  const finish = (t: Turn) => db.ok(asService(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`));
  const begin = (t: Turn, kind: string, result: Json | null) => call(`select public.plusmedik_quote_item_begin('${t.id}'::uuid, '${t.who}', ${t.fence}, '${kind}', null::text, ${json(result)}, 1800, 20);`);
  const peekSql = (t: Turn, seconds = 86_400, who = t.who, fence = t.fence) => `select public.plusmedik_quote_shadow_peek('${t.id}'::uuid, '${who}', ${fence}, ${seconds});`;
  const peek = (t: Turn, seconds = 86_400) => call(peekSql(t, seconds));
  const readReal = (t: Turn) => call(`select public.plusmedik_quote_session_read('${t.id}'::uuid, '${t.who}', ${t.fence});`);
  const close = (t: Turn, sessionId: string, outcome: string, extra: { lines?: unknown; total?: number } = {}) =>
    call(`select public.plusmedik_quote_session_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '${sessionId}'::uuid, '${outcome}', ${json(extra.lines ?? null)}, ${extra.total ?? "null"}::numeric, null::text[], ${outcome === "QUOTED" ? `'${FP}'` : "null::text"});`);

  // Huella de TODAS las tablas que una lectura podría tocar.
  const fingerprint = (): Promise<string> =>
    db.ok(`select md5(string_agg(t, '|' order by t)) from (
      select 'run:' || x::text as t from public.plusmedik_audit_runs x
      union all select 'turn:' || x::text from public.plusmedik_turns x
      union all select 'contact:' || x::text from public.plusmedik_contact_turns x
      union all select 'session:' || x::text from public.plusmedik_quote_sessions x
      union all select 'item:' || x::text from public.plusmedik_quote_items x
      union all select 'result:' || x::text from public.plusmedik_quote_results x
    ) y`);

  it("es STABLE en la base real, SECURITY DEFINER, y service_role es el único que puede ejecutarla", async () => {
    expect(await db.ok(`select provolatile from pg_proc where proname = 'plusmedik_quote_shadow_peek'`)).toBe("s");
    expect(await db.ok(`select prosecdef from pg_proc where proname = 'plusmedik_quote_shadow_peek'`)).toBe("t");
    for (const role of ["anon", "authenticated"]) {
      const denied = await db.psql(`set role ${role}; ${peekSql({ id: uuid(1), who: owner(1), fence: 1, contact: "x" })}`);
      expect(denied.code, role).not.toBe(0);
      expect(denied.stderr).toMatch(/permission denied/i);
    }
  });

  it("PRIVILEGIOS EXACTOS: solo el dueño y service_role tienen EXECUTE; ni PUBLIC, ni anon, ni authenticated, ni ningún otro rol", async () => {
    const grantees = (await db.ok(`select string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ',' order by case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end)
      from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid = 'public.plusmedik_quote_shadow_peek(uuid,text,bigint,integer)'::regprocedure and a.privilege_type = 'EXECUTE'`)).split(",");
    const owner = await db.ok(`select pg_get_userbyid(proowner) from pg_proc where proname = 'plusmedik_quote_shadow_peek'`);
    expect(grantees.sort()).toEqual([...new Set([owner, "service_role"])].sort());
    expect(await db.ok(`select (proconfig = array['search_path=""'])::text from pg_proc where proname = 'plusmedik_quote_shadow_peek'`)).toBe("true");
  });

  it("la función no depende de nada fuera de PlusMedik: no nombra el esquema crm, lab_tests ni otros objetos de public", async () => {
    const def = await db.ok(`select pg_get_functiondef('public.plusmedik_quote_shadow_peek(uuid,text,bigint,integer)'::regprocedure)`);
    expect(def).not.toMatch(/\bcrm\.|\blab_tests\b/i);
    expect([...def.matchAll(/public\.([a-z_0-9]+)/g)].map((m) => m[1]).filter((name) => !name!.startsWith("plusmedik_"))).toEqual([]);
  });

  it("sin solicitud abierta: none (y sin cotización reciente)", async () => {
    const t = await turn(newContact());
    expect(await peek(t)).toEqual({ state: "none", recent: false });
  });

  it("con la solicitud abierta devuelve los ítems visibles para ese turno, con la misma forma que la lectura de siempre", async () => {
    const contact = newContact();
    const earlier = await turn(contact);
    const item = await begin(earlier, "TEXT", resolved(1, 2));
    await finish(earlier);
    const reader = await turn(contact);
    const seen = await peek(reader);
    expect(seen).toMatchObject({ state: "ready", recent: false });
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]).toMatchObject({ id: item.itemId, kind: "TEXT", status: "RESOLVED", studyIds: [uuid(1), uuid(2)] });
    // idéntico a lo que ve la lectura de siempre
    expect(seen.items).toEqual((await readReal(reader)).items);
  });

  it("un turno NO ve los ítems de turnos posteriores (igual que la lectura de siempre)", async () => {
    const contact = newContact();
    const early = await turn(contact);
    const late = await turn(contact);
    await begin(late, "TEXT", resolved(3));
    expect(await peek(early)).toEqual({ state: "none", recent: false });
    await finish(early);
    expect(await peek(late)).toMatchObject({ state: "ready" });
  });

  it("pending: hay turnos anteriores aún en proceso; replay: este turno ya cerró la solicitud; unavailable/lease_lost sin devolver datos", async () => {
    const contact = newContact();
    const photo = await turn(contact, "IMAGE");
    await begin(photo, "IMAGE", null); // foto en proceso
    const later = await turn(contact);
    expect(await peek(later)).toMatchObject({ state: "pending", pending: 1 });
    await finish(photo);
    await finish(later);

    const closer = await turn(contact);
    const read = await readReal(closer);
    await close(closer, read.sessionId, "CANCELLED");
    expect(await peek(closer)).toEqual({ state: "replay", recent: false });

    // fence u owner que no son los vigentes: sin datos
    const other = await turn(newContact());
    await begin(other, "TEXT", resolved(1));
    expect(await call(peekSql(other, 86_400, other.who, other.fence + 5))).toEqual({ state: "lease_lost", recent: false });
    expect(await call(peekSql(other, 86_400, owner(99)))).toEqual({ state: "lease_lost", recent: false });
    expect(await call(`select public.plusmedik_quote_shadow_peek('${uuid(404)}'::uuid, '${owner(1)}', 1, 86400);`)).toEqual({ state: "unavailable", recent: false });
  });

  it("valida las entradas (PT422)", async () => {
    const t = await turn(newContact());
    for (const sql of [peekSql(t, 10), peekSql(t, 604_801), peekSql(t, 86_400, "corto"), peekSql(t, 86_400, t.who, 0), `select public.plusmedik_quote_shadow_peek(null::uuid, '${t.who}', 1, 86400);`]) {
      const result = await db.psql(asService(sql));
      expect(result.code, sql).not.toBe(0);
      expect(result.stderr).toMatch(/PT422|invalid peek/);
    }
  });

  it("recent: solo un booleano; cierto con una cotización entregada dentro de la ventana y falso fuera de ella", async () => {
    const contact = newContact();
    const writer = await turn(contact);
    const item = await begin(writer, "TEXT", resolved(1));
    await finish(writer);
    const closer = await turn(contact);
    expect(await close(closer, item.sessionId, "QUOTED", { lines: [{ studyId: uuid(1), name: "ESTUDIO 1", priceBs: 10 }], total: 10 })).toMatchObject({ status: "closed" });
    const after = await turn(contact);
    const seen = await peek(after, 3600);
    expect(seen).toEqual({ state: "none", recent: true });
    expect(JSON.stringify(seen)).not.toContain(uuid(1));
    // otro contacto no ve la cotización de este
    expect(await peek(await turn(newContact()), 3600)).toEqual({ state: "none", recent: false });
  });

  it("NO ESCRIBE NADA: ninguna tabla cambia en ningún estado (huella idéntica antes y después)", async () => {
    const contact = newContact();
    const photo = await turn(contact, "IMAGE");
    await begin(photo, "IMAGE", null);
    const early = await turn(contact);
    const text = await turn(contact);
    await begin(text, "TEXT", resolved(1));
    const before = await fingerprint();
    await peek(early); // pending
    await peek(text); // ready o pending
    await call(peekSql(text, 86_400, text.who, text.fence + 1)); // lease_lost
    expect(await fingerprint()).toBe(before);
  });

  it("NO VENCE SESIONES: una solicitud vencida se ve como inexistente, pero su estado sigue OPEN; la lectura de siempre sí la marca EXPIRED", async () => {
    const contact = newContact();
    const writer = await turn(contact);
    const item = await begin(writer, "TEXT", resolved(1));
    await finish(writer);
    await db.ok(`update public.plusmedik_quote_sessions set expires_at = now() - interval '5 minutes' where id = '${item.sessionId}'`);
    const reader = await turn(contact);
    const before = await fingerprint();
    expect(await peek(reader)).toEqual({ state: "none", recent: false });
    expect(await fingerprint()).toBe(before);
    expect(await db.ok(`select status from public.plusmedik_quote_sessions where id = '${item.sessionId}'`)).toBe("OPEN");
    // contraste: la lectura de siempre escribe
    expect(await readReal(reader)).toMatchObject({ state: "none" });
    expect(await db.ok(`select status from public.plusmedik_quote_sessions where id = '${item.sessionId}'`)).toBe("EXPIRED");
  });

  it("NO BLOQUEA FILAS: con el bloqueo del contacto tomado por otra transacción, la lectura de solo lectura responde de inmediato", async () => {
    const contact = newContact();
    const writer = await turn(contact);
    await begin(writer, "TEXT", resolved(1));
    await finish(writer);
    const reader = await turn(contact);
    // otra conexión retiene el bloqueo de la fila del contacto unos segundos
    const holder = db.psql(`begin; select 1 from public.plusmedik_contact_turns where contact_key = '${contact}' for update; select pg_sleep(5); commit;`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const started = Date.now();
    expect(await peek(reader)).toMatchObject({ state: "ready" });
    expect(Date.now() - started).toBeLessThan(3000);
    await holder;
  });
});

// El script de verificación que se entrega para ejecutar a mano DESPUÉS de aplicar la migración 20: se prueba aquí tal cual contra una base con la migración y otra sin ella.
describe.skipIf(!bin)("verificación de la migración 20 (supabase/preflight/v2_migration_20_post_apply_read_only.sql)", () => {
  let server: EphemeralPostgres;
  let withPeek: PgDatabase;
  let withoutPeek: PgDatabase;
  const script = readFileSync(join(__dirname, "..", "supabase", "preflight", "v2_migration_20_post_apply_read_only.sql"), "utf8").replaceAll("\r\n", "\n");

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    withPeek = await server.createDatabase("verif_con_veinte");
    withoutPeek = await server.createDatabase("verif_sin_veinte");
    for (const database of [withPeek, withoutPeek]) await database.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) {
      await withPeek.applyFile(join(dir, file));
      if (file !== PEEK) await withoutPeek.applyFile(join(dir, file));
    }
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rows = async (database: PgDatabase) => (await database.ok(script)).split(/\r?\n/).map((line) => line.split("|"));

  it("es SOLO LECTURA: una sola sentencia SELECT, sin DDL, DML ni llamadas que escriban", () => {
    const code = script.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
    expect(code.match(/;/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|perform|set\s+role|do\s+\$)\b/i);
    expect(code.trim()).toMatch(/^with f as/i);
  });

  it("con la migración aplicada: las 15 comprobaciones y el veredicto salen OK", async () => {
    const result = await rows(withPeek);
    expect(result).toHaveLength(16);
    for (const row of result) expect(row[4], row.join(" | ")).toBe("OK");
    expect(result.at(-1)).toEqual(["99", "VEREDICTO", "todas OK", "15 de 15", "OK"]);
    expect(result[1]).toEqual(["2", "es STABLE (la base impide que escriba o bloquee filas)", "s", "s", "OK"]);
    expect(result[14]![3]).toBe("unavailable");
  });

  it("sin la migración aplicada: no falla con un error, marca FALLA (y no llama a la función inexistente)", async () => {
    const result = await rows(withoutPeek);
    expect(result).toHaveLength(16);
    expect(result[0]![4]).toBe("FALLA");
    expect(result.at(-1)![4]).toBe("FALLA");
    // los prerrequisitos (migraciones 19, 11/14 y las tablas) sí están
    for (const index of [11, 12, 13]) expect(result[index]![4], result[index]!.join(" | ")).toBe("OK");
  });

  it("la verificación no cambia nada: la huella de las tablas es idéntica antes y después de ejecutarla", async () => {
    const fingerprint = () => withPeek.ok(`select md5(string_agg(t, '|' order by t)) from (
      select 'run:' || x::text as t from public.plusmedik_audit_runs x union all select 'turn:' || x::text from public.plusmedik_turns x
      union all select 'session:' || x::text from public.plusmedik_quote_sessions x union all select 'item:' || x::text from public.plusmedik_quote_items x) y`);
    const before = await fingerprint();
    await rows(withPeek);
    expect(await fingerprint()).toBe(before);
    // y se puede ejecutar dentro de una transacción de solo lectura
    const readOnly = await withPeek.psql(`begin read only; ${script} rollback;`);
    expect(readOnly.code, readOnly.stderr).toBe(0);
  });
});
