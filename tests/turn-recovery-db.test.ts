import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 7 (turno recuperable cuando la espera por un envío en vuelo se agota) contra un PostgreSQL REAL y efímero. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[turn-recovery-db] PostgreSQL no disponible: se omiten las pruebas de recuperación de turnos contra la base real.");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const FILES = ["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql", "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql", "20261025000000_plusmedik_turns.sql"];
const RECOVERY = "20261026000000_plusmedik_turn_recovery.sql";
type Json = Record<string, any>;
const read = (name: string) => readFileSync(join(migrationsDir, name), "utf8").replaceAll("\r\n", "\n");

describe.skipIf(!bin)("turno recuperable tras un 'busy' agotado (migración 7) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("turn_recovery");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of [...FILES, RECOVERY]) await db.applyFile(join(migrationsDir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const newMessage = () => `wamid.rec-${++counter}-${Date.now()}`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const claimSql = (message: string, who: string, contact: string, seconds = 120) =>
    `select public.plusmedik_turn_claim(p_message_id => '${message}', p_media_id => null, p_owner => '${who}', p_lease_seconds => ${seconds}, p_schema_version => 2, p_engine_version => null, p_flags => '{}'::jsonb, p_contact_key => '${contact}', p_turn_kind => 'TEXT');`;
  const row = async (message: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  const releaseSql = (runId: string, who: string, fence: number, reason = "BUSY_TIMEOUT") => `select public.plusmedik_turn_release('${runId}'::uuid, '${who}', ${fence}, '${reason}');`;
  const reserveSql = (runId: string, who: string, fence: number) => `select public.plusmedik_turn_reserve_send('${runId}'::uuid, '${who}', ${fence}, 'conversation', 120, 'NONE');`;
  const replySql = (runId: string, who: string, fence: number) => `select public.plusmedik_audit_fenced_record_reply('${runId}'::uuid, '${who}', ${fence}, '{"state":"ACCEPTED","result":"conversation","processing_status":"COMPLETED"}'::jsonb);`;
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 second' where kapso_message_id = '${message}';`);

  async function claimed(contact: string, who = 1) {
    const message = newMessage();
    const result = await call(claimSql(message, owner(who), contact));
    const id = await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
    return { message, id, who: owner(who), fence: result.fence as number };
  }

  it("liberar un turno sin envío reservado: vence su lease YA, queda marcado BUSY_TIMEOUT para atención y NO se cierra ni se envía nada", async () => {
    const t = await claimed(newContact());
    expect(await call(releaseSql(t.id, t.who, t.fence))).toEqual({ status: "released" });
    expect(await row(t.message)).toMatchObject({ send_state: "NOT_RESERVED", processing_status: "PROCESSING", attention_reason: "BUSY_TIMEOUT", lease_fence: t.fence });
    expect(new Date((await row(t.message)).lease_expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await phase(t.message)).toBe("NEEDS_ATTENTION");
  });

  it("es idempotente: liberar dos veces responde 'released' sin cambiar nada", async () => {
    const t = await claimed(newContact());
    await call(releaseSql(t.id, t.who, t.fence));
    const before = await row(t.message);
    expect(await call(releaseSql(t.id, t.who, t.fence))).toEqual({ status: "released" });
    expect((await row(t.message)).attention_at).toBe(before.attention_at);
  });

  it("RECUPERABLE: el reenvío del mismo mensaje reclama el turno (fence + 1, MISMO número de secuencia), reserva y envía UNA vez", async () => {
    const contact = newContact();
    const t = await claimed(contact);
    await call(releaseSql(t.id, t.who, t.fence));
    const retaken = await call(claimSql(t.message, owner(2), contact));
    expect(retaken).toMatchObject({ outcome: "taken_over", fence: t.fence + 1, seq: 1 });
    expect(await call(reserveSql(t.id, owner(2), t.fence + 1))).toEqual({ status: "reserved" });
    expect(await call(replySql(t.id, owner(2), t.fence + 1))).toMatchObject({ status: "recorded" });
    expect(await phase(t.message)).toBe("SENT_ACCEPTED");
    // un tercer reenvío ya no reabre nada
    expect((await call(claimSql(t.message, owner(3), contact))).outcome).toBe("finished");
  });

  it("la ejecución que liberó ya no puede enviar si otra reclamó el turno (fencing)", async () => {
    const contact = newContact();
    const t = await claimed(contact);
    await call(releaseSql(t.id, t.who, t.fence));
    await call(claimSql(t.message, owner(2), contact));
    expect(await db.fails(asService(reserveSql(t.id, t.who, t.fence)))).toContain("PT410");
    expect(await db.fails(asService(releaseSql(t.id, t.who, t.fence)))).toContain("PT410");
  });

  it("si nadie lo reclama, el recuperador lo cierra sin enviar nada (ABANDONED_BEFORE_SEND) y no queda ninguna respuesta pendiente", async () => {
    const t = await claimed(newContact());
    await call(releaseSql(t.id, t.who, t.fence));
    expect(await call(`select public.plusmedik_audit_recover_stale(0, 0, 50);`)).toMatchObject({ abandoned_before_send: expect.any(Number) });
    expect(await row(t.message)).toMatchObject({ send_state: "NOT_APPLICABLE", attention_reason: "ABANDONED_BEFORE_SEND", reply_state: "NOT_ATTEMPTED" });
    expect(await phase(t.message)).toBe("NEEDS_ATTENTION");
  });

  it("no se puede liberar un envío ya reservado, enviado o cancelado: responde 'closed' y no toca nada (jamás habilita un segundo envío)", async () => {
    const reserved = await claimed(newContact());
    await call(reserveSql(reserved.id, reserved.who, reserved.fence));
    expect(await call(releaseSql(reserved.id, reserved.who, reserved.fence))).toEqual({ status: "closed" });
    expect(await row(reserved.message)).toMatchObject({ send_state: "RESERVED", attention_reason: null });
    await call(replySql(reserved.id, reserved.who, reserved.fence));
    expect(await call(releaseSql(reserved.id, reserved.who, reserved.fence))).toEqual({ status: "closed" });
    expect(await row(reserved.message)).toMatchObject({ send_state: "ACCEPTED" });
    // un reenvío tras un envío aceptado no reabre
    expect((await call(claimSql(reserved.message, owner(5), (await row(reserved.message)).contact_key))).outcome).toBe("finished");
  });

  it("un turno liberado cuyo lease aún no venció para otro dueño no se puede liberar con un fence viejo; argumentos inválidos se rechazan sin eco", async () => {
    const t = await claimed(newContact());
    for (const sql of [releaseSql(t.id, t.who, t.fence, "OTRO_MOTIVO"), releaseSql(t.id, "x", t.fence), releaseSql(t.id, t.who, 0)]) {
      const error = await db.fails(asService(sql));
      expect(error).toMatch(/PT422/);
      expect(error).not.toContain("OTRO_MOTIVO");
    }
    expect(await db.fails(asService(`select public.plusmedik_turn_release('${t.id}'::uuid, '${t.who}', ${t.fence + 7}, 'BUSY_TIMEOUT');`))).toContain("PT410");
    expect(await db.fails(asService(`select public.plusmedik_turn_release('00000000-0000-0000-0000-000000000000'::uuid, '${t.who}', 1, 'BUSY_TIMEOUT');`))).toMatch(/PT404|PT410/);
  });

  it("agotados los intentos, el turno ya no se reclama más (no hay bucle de reintentos)", async () => {
    const contact = newContact();
    const t = await claimed(contact);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const current = await row(t.message);
      await call(releaseSql(t.id, current.lease_owner, current.lease_fence));
      expect((await call(claimSql(t.message, owner(attempt), contact))).outcome).toBe("taken_over");
    }
    const current = await row(t.message);
    await call(releaseSql(t.id, current.lease_owner, current.lease_fence));
    expect((await call(claimSql(t.message, owner(9), contact))).outcome).toBe("exhausted");
  });

  it("privilegios: SECURITY DEFINER con search_path vacío, solo service_role la ejecuta", async () => {
    const signature = "plusmedik_turn_release(uuid, text, bigint, text)";
    expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`)).toBe("t");
    expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`)).toContain("search_path=");
    expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`)).toBe("t");
    for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`)).toBe("f");
  });
});

describe("la migración 7 es aditiva y no cambia nada anterior", () => {
  const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
  const sql = read(RECOVERY).replace(/--.*$/gm, "");

  it("la migración 6 (G2.0) no se modificó", () => {
    expect(sha("20261025000000_plusmedik_turns.sql")).toBe("2db27531909ec6d2a3d394dba41aa705ae226f5b37bac9985a17de109e08af13");
  });

  it("solo agrega una función: sin tablas, sin borrar, sin SQL dinámico, sin catálogo ni esquema crm", () => {
    expect([...sql.matchAll(/create or replace function public\.(\w+)/gi)].map((match) => match[1])).toEqual(["plusmedik_turn_release"]);
    expect(sql).not.toMatch(/\bcreate\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+/i);
    expect(sql).not.toMatch(/\balter\s+table\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bexecute\s+(format|'|\()/i);
    expect(sql).not.toMatch(/lab_tests|lab_test_aliases|\bcrm\./);
    expect(sql).toMatch(/set search_path = ''/);
  });
});
