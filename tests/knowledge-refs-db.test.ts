import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Trazabilidad de las respuestas basadas en conocimiento (migración 9) contra un PostgreSQL REAL y efímero. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[knowledge-refs-db] PostgreSQL no disponible: se omiten las pruebas de trazabilidad de conocimiento contra la base real.");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const REFS = "20261028000000_plusmedik_knowledge_refs.sql";
const read = (name: string) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;
const HASH = "a".repeat(64);
const HASH_2 = "b".repeat(64);
const ref = (key = "policy:prueba", version = 1, kind = "POLICY", contentHash = HASH) => ({ kind, key, version, contentHash });

describe.skipIf(!bin)("trazabilidad de conocimiento contra PostgreSQL real (migración 9)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("knowledge_refs");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const newMessage = () => `wamid.ref-${++counter}-${Date.now()}`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const claimSql = (message: string, who: string, contact: string) =>
    `select public.plusmedik_turn_claim(p_message_id => '${message}', p_media_id => null, p_owner => '${who}', p_lease_seconds => 120, p_schema_version => 2, p_engine_version => null, p_flags => '{}'::jsonb, p_contact_key => '${contact}', p_turn_kind => 'TEXT');`;
  const recordSql = (runId: string, who: string, fence: number, refs: unknown) => `select public.plusmedik_turn_record_knowledge('${runId}'::uuid, '${who}', ${fence}, $j$${JSON.stringify(refs)}$j$::jsonb);`;
  const reserveSql = (runId: string, who: string, fence: number) => `select public.plusmedik_turn_reserve_send('${runId}'::uuid, '${who}', ${fence}, 'conversation', 120, 'NONE');`;
  const replySql = (runId: string, who: string, fence: number) => `select public.plusmedik_audit_fenced_record_reply('${runId}'::uuid, '${who}', ${fence}, '{"state":"ACCEPTED","result":"conversation","processing_status":"COMPLETED"}'::jsonb);`;
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 second' where kapso_message_id = '${message}';`);
  const count = async (runId: string) => Number(await db.ok(`select count(*) from public.plusmedik_turn_knowledge_refs where run_id = '${runId}'`));

  async function turn(contact = newContact(), who = 1) {
    const message = newMessage();
    const claimed = await call(claimSql(message, owner(who), contact));
    return { message, contact, id: await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`), who: owner(who), fence: claimed.fence as number };
  }

  it("registra las referencias ANTES de reservar, con la generación del lease; no guarda texto, teléfonos ni contenido", async () => {
    const t = await turn();
    expect(await call(recordSql(t.id, t.who, t.fence, [ref("policy:prueba", 3), ref("study:11111111-1111-4111-8111-111111111111", 2, "STUDY_PREPARATION", HASH_2)]))).toEqual({ status: "recorded", count: 2 });
    expect(await count(t.id)).toBe(2);
    expect(JSON.parse(await db.ok(`select to_json(f) from public.plusmedik_turn_knowledge_refs f where run_id = '${t.id}' and kind = 'POLICY'`))).toMatchObject({ lease_fence: t.fence, key: "policy:prueba", version: 3, content_hash: HASH });
    const columns = await db.ok(`select string_agg(column_name, ',') from information_schema.columns where table_schema = 'public' and table_name = 'plusmedik_turn_knowledge_refs'`);
    expect(columns).not.toMatch(/text|body|message|phone|content\b|payload|answer|reply/i);
  });

  it("es idempotente: repetir el mismo registro (reintento tras un resultado desconocido) no duplica", async () => {
    const t = await turn();
    await call(recordSql(t.id, t.who, t.fence, [ref()]));
    expect(await call(recordSql(t.id, t.who, t.fence, [ref(), ref("faq:otra", 1, "FAQ")]))).toEqual({ status: "recorded", count: 1 });
    expect(await count(t.id)).toBe(2);
  });

  it("rechaza referencias inválidas sin eco de valores: vacías, demasiadas, claves extra, tipo desconocido, hash malo, versión 0 o no numérica", async () => {
    const t = await turn();
    const bad: unknown[] = [[], Array.from({ length: 21 }, (_, i) => ref(`faq:k${i}`, 1, "FAQ")), {}, "no-es-un-arreglo", [{ ...ref(), extra: 1 }], [{ kind: "POLICY", key: "policy:x", version: 1 }], [ref("policy:x", 1, "OTRO")], [ref("policy:x", 1, "POLICY", "zz")], [ref("policy:x", 0)], [ref("MAYUSCULAS")], [{ ...ref(), version: "1" }], [{ ...ref(), key: 5 }]];
    for (const refs of bad) {
      const error = await db.fails(asService(recordSql(t.id, t.who, t.fence, refs)));
      expect(error, JSON.stringify(refs).slice(0, 60)).toContain("PT422");
      expect(error).not.toContain("MAYUSCULAS");
    }
    expect(await count(t.id)).toBe(0);
  });

  it("NO se puede registrar después de reservar el envío (ni de enviarlo): responde 'closed' y no inserta; así todo envío tiene su rastro registrado primero", async () => {
    const t = await turn();
    expect(await call(reserveSql(t.id, t.who, t.fence))).toEqual({ status: "reserved" });
    expect(await call(recordSql(t.id, t.who, t.fence, [ref()]))).toEqual({ status: "closed" });
    await call(replySql(t.id, t.who, t.fence));
    expect(await call(recordSql(t.id, t.who, t.fence, [ref()]))).toEqual({ status: "closed" });
    expect(await count(t.id)).toBe(0);
  });

  it("fencing: una ejecución antigua que perdió el lease no puede dejar rastro (PT410); una corrida que no es un turno se rechaza (PT404)", async () => {
    const contact = newContact();
    const t = await turn(contact);
    await expire(t.message);
    const retaken = await call(claimSql(t.message, owner(2), contact));
    expect(retaken.outcome).toBe("taken_over");
    expect(await db.fails(asService(recordSql(t.id, t.who, t.fence, [ref()])))).toContain("PT410");
    expect(await count(t.id)).toBe(0);
    expect(await call(recordSql(t.id, owner(2), retaken.fence, [ref()]))).toEqual({ status: "recorded", count: 1 });
    // corrida creada por el camino heredado (sin turno)
    const legacy = newMessage();
    await call(`select public.plusmedik_audit_claim_run('${legacy}', null, '${owner(3)}', 120, 2, null, '{}'::jsonb, 3);`);
    const legacyId = await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${legacy}'`);
    expect(await db.fails(asService(recordSql(legacyId, owner(3), 1, [ref()])))).toContain("PT404");
  });

  it("cada intento deja sus propias referencias: si la primera ejecución registró la versión 1 y murió, la que reclama registra la versión 2 y la respuesta enviada es la de la última generación", async () => {
    const contact = newContact();
    const t = await turn(contact);
    await call(recordSql(t.id, t.who, t.fence, [ref("policy:uso", 1)]));
    await expire(t.message);
    const retaken = await call(claimSql(t.message, owner(2), contact));
    await call(recordSql(t.id, owner(2), retaken.fence, [ref("policy:uso", 2)]));
    expect(await count(t.id)).toBe(2);
    await call(reserveSql(t.id, owner(2), retaken.fence));
    const usage = (await call(`select public.plusmedik_kb_usage('POLICY', 'policy:uso', null, 100);`)).uses as Json[];
    expect(usage.filter((u) => u.runId === t.id).map((u) => u.version)).toEqual([2]); // solo la generación que reservó
    expect(((await call(`select public.plusmedik_kb_usage('POLICY', 'policy:uso', 1, 100);`)).uses as Json[]).some((u) => u.runId === t.id)).toBe(false);
  });

  it("las filas son inmutables (ni el propietario las modifica ni borra) y solo service_role las lee", async () => {
    const t = await turn();
    await call(recordSql(t.id, t.who, t.fence, [ref()]));
    expect(await db.fails(`update public.plusmedik_turn_knowledge_refs set version = 9 where run_id = '${t.id}'`)).toMatch(/not allowed/);
    expect(await db.fails(`delete from public.plusmedik_turn_knowledge_refs where run_id = '${t.id}'`)).toMatch(/not allowed/);
    expect(await db.fails(`truncate public.plusmedik_turn_knowledge_refs`)).toMatch(/not allowed|cannot truncate/);
    expect(await db.fails(asService(`insert into public.plusmedik_turn_knowledge_refs (run_id, lease_fence, kind, key, version, content_hash) values ('${t.id}', 1, 'FAQ', 'faq:x', 1, '${HASH}')`))).toContain("permission denied");
    expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.plusmedik_turn_knowledge_refs'::regclass`)).toBe("t");
    for (const role of ["anon", "authenticated", "unprivileged"]) {
      expect(await db.ok(`select has_table_privilege('${role}', 'public.plusmedik_turn_knowledge_refs', 'select')`)).toBe("f");
      for (const fn of ["plusmedik_turn_record_knowledge(uuid, text, bigint, jsonb)", "plusmedik_kb_usage(text, text, integer, integer)"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${fn}'::regprocedure, 'execute')`)).toBe("f");
    }
  });

  it("USO: lista los turnos cuyo envío llegó a reservarse con esa versión (seudónimos y estado), filtra por versión y valida argumentos; lo no enviado no cuenta", async () => {
    const key = `policy:impacto-${++counter}`;
    const sent = await turn();
    const notSent = await turn();
    const cancelled = await turn();
    for (const t of [sent, notSent, cancelled]) await call(recordSql(t.id, t.who, t.fence, [ref(key, 4)]));
    await call(reserveSql(sent.id, sent.who, sent.fence));
    await call(replySql(sent.id, sent.who, sent.fence));
    await call(`select public.plusmedik_attention_register_human_message('human:${cancelled.contact}', '${cancelled.contact}', null, 'HUMAN_WHATSAPP_BUSINESS_APP', 'kapso_business_app');`);
    await db.fails(asService(reserveSql(cancelled.id, cancelled.who, cancelled.fence))).catch(() => undefined);
    await call(reserveSql(cancelled.id, cancelled.who, cancelled.fence)).catch(() => undefined);
    const uses = (await call(`select public.plusmedik_kb_usage('POLICY', '${key}', 4, 100);`)).uses as Json[];
    expect(uses.map((u) => [u.runId, u.contactKey, u.sendState, u.replyState])).toEqual([[sent.id, sent.contact, "ACCEPTED", "ACCEPTED"]]);
    expect(((await call(`select public.plusmedik_kb_usage('POLICY', '${key}', 5, 100);`)).uses as Json[])).toEqual([]);
    for (const args of ["'OTRO', 'policy:x'", "'POLICY', 'MAYUS'", "'POLICY', 'policy:x', 0", "'POLICY', 'policy:x', 1, 0", "'POLICY', 'policy:x', 1, 1001"]) {
      expect(await db.fails(asService(`select public.plusmedik_kb_usage(${args});`)), args).toContain("PT422");
    }
  });

  it("concurrencia: registrar y reservar a la vez se serializan; si la reserva gana, el registro responde 'closed'; si el registro gana, queda registrado y la reserva procede", async () => {
    const a = await turn();
    const reserving = db.psql(`set role service_role; begin; ${reserveSql(a.id, a.who, a.fence)} select pg_sleep(1.5); commit;`);
    await sleep(500);
    const recording = db.psql(asService(recordSql(a.id, a.who, a.fence, [ref()])));
    const [r, c] = await Promise.all([reserving, recording]);
    expect(first(r.stdout).status).toBe("reserved");
    expect(first(c.stdout)).toEqual({ status: "closed" });
    expect(await count(a.id)).toBe(0);

    const b = await turn();
    const recordFirst = db.psql(`set role service_role; begin; ${recordSql(b.id, b.who, b.fence, [ref()])} select pg_sleep(1.5); commit;`);
    await sleep(500);
    const reserveAfter = db.psql(asService(reserveSql(b.id, b.who, b.fence)));
    const [r2, s2] = await Promise.all([recordFirst, reserveAfter]);
    expect(first(r2.stdout)).toEqual({ status: "recorded", count: 1 });
    expect(first(s2.stdout).status).toBe("reserved");
    expect(await count(b.id)).toBe(1);
  });
});

describe("la migración 9 es aditiva y no cambia nada anterior", () => {
  const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
  const code = read(REFS).replace(/--.*$/gm, "");

  it("es la novena (la 10 es la guarda de respuestas, G3.2; la 11, las sesiones de cotización, G4.0) y las ocho anteriores no se modificaron (hashes fijados)", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
    expect(files[8]).toBe(REFS);
    expect(files).toHaveLength(23);
    expect(Object.fromEntries(files.slice(0, 8).map((name) => [name, sha(name)]))).toEqual({
      "20261020000000_plusmedik_persistent_audit.sql": "1110edc1e1b3f6c4961b87bdb763ecea535ef5b1d6ba9086ff314a86b88ad61a",
      "20261021000000_plusmedik_audit_telemetry.sql": "08e555cf0c872ce2380cbd5046c2296a525c20b6caaddee6ae51ccdb53243256",
      "20261022000000_plusmedik_audit_transactional.sql": "1135f673e0a8e5de5ef03dae1acae55427c01ff99f4a5988f90595abe9244079",
      "20261023000000_plusmedik_audit_leases.sql": "1b6546c2a44142a00b771f303dccc43f5ea408cd912a340c3b3e406e63185ee7",
      "20261024000000_plusmedik_human_control.sql": "21430ed091a169945d1f5b9109484c11a34a5d7e9981d715dc2c83c36fc9658d",
      "20261025000000_plusmedik_turns.sql": "2db27531909ec6d2a3d394dba41aa705ae226f5b37bac9985a17de109e08af13",
      "20261026000000_plusmedik_turn_recovery.sql": "034f4ee6769c5537490aa881e96ba39221a9009ca4aedd6967c1aaa04ee02318",
      "20261027000000_plusmedik_knowledge.sql": "3552b34dec191045f3113c879163bcdc87ce120a2589d162710f3f1fbb19c296"
    });
  });

  it("solo agrega una tabla y dos funciones: sin borrar, sin datos, sin SQL dinámico, sin tocar catálogo ni esquema del CRM; funciones definer con search_path fijo y revocadas a PUBLIC", () => {
    expect([...code.matchAll(/create table if not exists public\.(\w+)/gi)].map((match) => match[1])).toEqual(["plusmedik_turn_knowledge_refs"]);
    expect([...code.matchAll(/create or replace function public\.(\w+)/gi)].map((match) => match[1])).toEqual(["plusmedik_turn_record_knowledge", "plusmedik_kb_usage"]);
    expect(code).not.toMatch(/\bdrop\s+|\bdelete\s+from\b|\btruncate\s+(table\s+)?public|\bexecute\s+(format|'|\()/i);
    expect(code).not.toMatch(/\balter\s+table\s+(?!public\.plusmedik_turn_knowledge_refs)/i);
    expect(code).not.toMatch(/lab_tests|lab_test_aliases|\bcrm\./);
    for (const definition of code.split(/create or replace function/i).slice(1)) expect(definition).toMatch(/security definer[\s\S]*set search_path = ''/);
    expect(code).toMatch(/revoke all on function public\.plusmedik_turn_record_knowledge\(/);
    expect(code).toMatch(/revoke all on function public\.plusmedik_kb_usage\(/);
  });
});
