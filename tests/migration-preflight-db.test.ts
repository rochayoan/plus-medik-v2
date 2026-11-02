import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildManifest, expectedFiles, MIGRATIONS_DIR, POST_FILE, PRE_FILE, PREFLIGHT_DIR, readMigrations } from "../scripts/migration-manifest.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Las verificaciones de SOLO LECTURA (antes y después de aplicar a mano las 19 migraciones) contra un PostgreSQL REAL y efímero: detectan lo pendiente, lo ya aplicado, lo parcial, los huecos de
// orden, las colisiones con el catálogo y con el esquema crm, y cualquier permiso de más. NO se conectan a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[migration-preflight-db] PostgreSQL no disponible: se omiten las pruebas de la verificación contra la base real.");
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

const manifest = buildManifest();
const files = readMigrations();
const pre = readFileSync(join(PREFLIGHT_DIR, PRE_FILE), "utf8").replaceAll("\r\n", "\n");
const post = readFileSync(join(PREFLIGHT_DIR, POST_FILE), "utf8").replaceAll("\r\n", "\n");

interface Row { ord: number; section: string; item: string; status: string; detail: string }
const parse = (out: string): Row[] => out.replaceAll("\r", "").split("\n").filter(Boolean).map((line) => {
  const [ord, section, item, status, ...detail] = line.split("|");
  return { ord: Number(ord), section: section!, item: item!, status: status!, detail: detail.join("|") };
});
const verdict = (rows: Row[]) => rows[0]!;
const blocks = (rows: Row[]) => rows.filter((row) => row.status === "BLOCK");
const migrationRows = (rows: Row[]) => rows.filter((row) => row.section === "MIGRACION" && /^\d\d /.test(row.item));
const snapshot = (rows: Row[]) => rows.filter((row) => row.section === "INSTANTANEA").map((row) => `${row.item}=${row.detail}`).sort();

describe("verificaciones de las migraciones: contenido estático", () => {
  it("el manifiesto cubre las 19 migraciones en orden y cada una crea algo propio", () => {
    expect(manifest.migrations).toHaveLength(19);
    expect(manifest.migrations.map((m) => m.version)).toEqual(files.map((f) => f.file.split("_")[0]));
    expect([...manifest.migrations.map((m) => m.version)]).toEqual([...manifest.migrations.map((m) => m.version)].sort());
    for (const m of manifest.migrations) expect(manifest.entries.some((e) => e.mig === m.index), m.file).toBe(true);
    expect(manifest.entries.filter((e) => e.kind === "table").length).toBe(27);
    expect(manifest.serviceFunctions.length).toBeGreaterThan(50);
    // las funciones que el orden redefine son exactamente las que el diseño conoce
    expect(manifest.redefined.filter((r) => r.kind === "function").map((r) => `${r.name}:${r.migrations.join(">")}`)).toEqual([
      "plusmedik_audit_claim_run:4>5", "plusmedik_audit_record_reply:3>6", "plusmedik_audit_reserve_send:4>5>6", "plusmedik_audit_runs_guard:3>4>5", "plusmedik_quote_session_close:11>14", "plusmedik_quote_session_read:11>14", "plusmedik_turn_reserve_send_guarded:10>16"
    ]);
  });

  it("los archivos generados coinciden con las migraciones actuales (si no, regenerar con: npx tsx scripts/migration-manifest.ts)", () => {
    const expected = expectedFiles(manifest);
    expect(pre).toBe(expected[PRE_FILE]);
    expect(post).toBe(expected[POST_FILE]);
  });

  it("son UNA sola sentencia SELECT: sin DDL, DML, GRANT, llamadas ni transacciones", () => {
    for (const [name, text] of [[PRE_FILE, pre], [POST_FILE, post]] as const) {
      const code = text.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n").replace(/'(?:[^']|'')*'/g, "''");
      expect(code.trim().startsWith("with"), name).toBe(true);
      expect(code.trim().endsWith(";"), name).toBe(true);
      expect(code.trim().slice(0, -1), name).not.toContain(";");
      expect(code, name).not.toMatch(/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate|call|copy|vacuum|begin|commit|rollback|set|reset|perform|execute|lock)\b/i);
      expect(code, name).not.toMatch(/\bdo\s*\$/i);
      expect(text, name).not.toMatch(/service_role_key|password|secret|bearer|eyJ/i);
    }
  });

  it("nombran el proyecto esperado y piden verificarlo antes de ejecutar", () => {
    for (const text of [pre, post]) expect(text).toContain("cvokrtrdzxfchntwwslz");
  });

  it("el procedimiento documentado (docs/g5/20) nombra cada archivo con el inicio de su sha256 actual y el proyecto esperado (si una migración cambia, el documento debe revisarse)", () => {
    const doc = readFileSync(join(__dirname, "..", "docs", "g5", "20-g51-aplicacion-de-migraciones.md"), "utf8").replaceAll("\r\n", "\n");
    for (const m of manifest.migrations) expect(doc, m.file).toContain(`\`${m.file}\` | ${m.lines} |`);
    for (const m of manifest.migrations) expect(doc, m.file).toContain(m.sha256.slice(0, 12));
    expect(doc).toContain("cvokrtrdzxfchntwwslz");
  });

  it("incluyen el sha256 de cada migración", () => {
    for (const m of manifest.migrations) {
      expect(pre).toContain(m.sha256);
      expect(post).toContain(m.sha256);
    }
  });
});

describe.skipIf(!bin)("verificaciones contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let counter = 0;

  const STUBS = `
    create table public.lab_tests (id uuid primary key default gen_random_uuid(), code text, name text, normalized_name text, price_bs numeric, active boolean not null default true, category text, sample_type text);
    create table public.lab_test_aliases (lab_test_id uuid, normalized_alias text);
    alter table public.lab_tests enable row level security;
    insert into public.lab_tests (code, name, normalized_name, price_bs, category) values ('HEM', 'Hematología completa', 'hematologia completa', 10, 'hematologia');
    create schema crm;
    create table crm.messages (id int primary key);
    create table crm.review_cases (id int primary key);
    create function crm.ping() returns int language sql as 'select 1';
  `;
  async function newDb(prefix = "preflight"): Promise<PgDatabase> {
    const db = await server.createDatabase(`${prefix}_${++counter}`.replaceAll(/\d/g, (digit) => String.fromCharCode(97 + Number(digit))));
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    await db.ok(STUBS);
    return db;
  }
  // Ejecuta una plantilla (con %SIG%) sobre cada firma de la función, sin conocerla de antemano.
  const fn = (name: string, template: string) => `do $b$ declare r record; begin for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '${name}' loop execute replace('${template}', '%SIG%', r.sig::text); end loop; end $b$;`;
  const apply = async (db: PgDatabase, count: number) => { for (const file of files.slice(0, count)) await db.applyFile(join(MIGRATIONS_DIR, file.file)); };
  const run = async (db: PgDatabase, sql: string) => parse(await db.ok(sql));
  // También se ejecuta dentro de una transacción de solo lectura: no debe escribir nada.
  const readOnly = (sql: string) => `begin read only;\n${sql}\nrollback;`;
  const runReadOnly = async (db: PgDatabase, sql: string) => parse((await db.ok(readOnly(sql))).split("\n").filter((line) => /^\d+\|/.test(line)).join("\n"));

  beforeAll(async () => { server = await startEphemeralPostgres(bin!); });
  afterAll(async () => { await server?.stop(); });

  it("base sin migraciones: veredicto OK, las 19 pendientes, sin bloqueos; y se puede ejecutar en una transacción de solo lectura", async () => {
    const db = await newDb();
    const rows = await runReadOnly(db, pre);
    expect(blocks(rows)).toEqual([]);
    expect(verdict(rows)).toMatchObject({ section: "VEREDICTO", status: "OK" });
    const states = migrationRows(rows);
    expect(states).toHaveLength(19);
    for (const row of states) expect(row, row.item).toMatchObject({ status: "OK", detail: expect.stringContaining("pendiente") });
    expect(rows.find((row) => row.item === "lab_tests.id (uuid)")).toMatchObject({ status: "OK" });
    expect(rows.find((row) => row.item === "version_20261025000000_duplicada")).toMatchObject({ status: "INFO" });
  });

  it("la verificación posterior sobre una base sin migraciones solo informa: nada aplicado, sin bloqueos", async () => {
    const db = await newDb();
    const rows = await run(db, post);
    expect(blocks(rows)).toEqual([]);
    for (const row of migrationRows(rows)) expect(row.status).toBe("INFO");
  });

  it("aplicar las 19 migraciones en orden: la previa lo reconoce como YA APLICADO, la posterior da OK, y el catálogo y el esquema crm no cambian", async () => {
    const db = await newDb();
    const before = await runReadOnly(db, post);
    await apply(db, 19);
    const afterPre = await runReadOnly(db, pre);
    for (const row of migrationRows(afterPre)) expect(row, row.item).toMatchObject({ status: "INFO", detail: expect.stringContaining("YA APLICADA") });
    expect(blocks(afterPre)).toEqual([]);
    const afterPost = await runReadOnly(db, post);
    expect(blocks(afterPost)).toEqual([]);
    expect(verdict(afterPost)).toMatchObject({ status: "OK" });
    for (const row of migrationRows(afterPost)) expect(row, row.item).toMatchObject({ status: "OK", detail: expect.stringContaining("completa") });
    expect(afterPost.find((row) => row.item === "tablas_sin_rls")).toMatchObject({ status: "OK" });
    expect(afterPost.find((row) => row.item === "ejecutables_por_anon_authenticated_o_public")).toMatchObject({ status: "OK" });
    expect(afterPost.find((row) => row.item === "cola_al_crm_no_expone_carga_ni_arrendamiento")).toMatchObject({ status: "OK" });
    expect(snapshot(afterPost)).toEqual(snapshot(before));
    expect(snapshot(afterPost).length).toBe(8);
    // todas las tablas nuevas están vacías: las migraciones no siembran datos
    expect(afterPost.find((row) => row.item === "filas_en_tablas_de_v2")!.detail.split(", ").every((pair) => pair.endsWith("=0"))).toBe(true);
  });

  it("aplicar de a una: tras cada migración, lo aplicado está completo y lo siguiente figura como pendiente en orden", async () => {
    const db = await newDb();
    for (let n = 1; n <= 19; n++) {
      await db.applyFile(join(MIGRATIONS_DIR, files[n - 1]!.file));
      const rows = await run(db, post);
      expect(blocks(rows), `tras la ${n}`).toEqual([]);
      const states = migrationRows(rows);
      states.forEach((row, index) => expect(row.status, `tras la ${n}: ${row.item}`).toBe(index < n ? "OK" : "INFO"));
      const preRows = await run(db, pre);
      expect(blocks(preRows), `previa tras la ${n}`).toEqual([]);
    }
  });

  it("volver a ejecutar las 19 migraciones (reintento tras un corte) no falla ni cambia el estado", async () => {
    const db = await newDb();
    await apply(db, 19);
    const first = await run(db, post);
    await apply(db, 19);
    const second = await run(db, post);
    expect(blocks(second)).toEqual([]);
    expect(second.map((row) => `${row.item}|${row.status}`)).toEqual(first.map((row) => `${row.item}|${row.status}`));
  });

  it("una migración PARCIAL (falta un objeto) y un HUECO de orden son BLOQUEOS, y se nombra lo que falta", async () => {
    const partial = await newDb();
    await apply(partial, 16);
    await partial.ok(fn("plusmedik_kb_revision", "drop function %SIG%"));
    for (const script of [pre, post]) {
      const rows = await run(partial, script);
      expect(verdict(rows).status).toBe("BLOCK");
      expect(migrationRows(rows).filter((row) => row.status === "BLOCK" && row.detail.includes("PARCIAL")).length).toBeGreaterThanOrEqual(1);
    }
    const gap = await newDb();
    await apply(gap, 16);
    await gap.ok(fn("plusmedik_turn_release", "drop function %SIG%"));
    const rows = await run(gap, pre);
    expect(verdict(rows).status).toBe("BLOCK");
    expect(migrationRows(rows).find((row) => row.item.startsWith("07 "))).toMatchObject({ status: "BLOCK" });
    expect((await run(gap, post)).find((row) => row.item === "orden")).toMatchObject({ status: "BLOCK" });
  });

  it("falta el catálogo o tiene otro tipo de id: BLOQUEO; falta una columna que lee V2 o un privilegio de service_role: aviso", async () => {
    const noCatalog = await newDb();
    await noCatalog.ok("drop table public.lab_test_aliases; drop table public.lab_tests;");
    const rows = await run(noCatalog, pre);
    expect(rows.find((row) => row.item === "lab_tests")).toMatchObject({ status: "BLOCK" });
    expect(verdict(rows).status).toBe("BLOCK");
    expect(rows.find((row) => row.section === "INSTANTANEA" && row.item === "lab_tests.filas")!.detail).toBe("tabla ausente");

    const wrongType = await newDb();
    await wrongType.ok("alter table public.lab_tests drop constraint lab_tests_pkey; alter table public.lab_tests alter column id drop default; alter table public.lab_tests alter column id type text using id::text;");
    expect((await run(wrongType, pre)).find((row) => row.item === "lab_tests.id (uuid)")).toMatchObject({ status: "BLOCK" });

    const narrow = await newDb();
    await narrow.ok("revoke all on table public.lab_tests from service_role; grant select (id, code, name, price_bs, active, category, sample_type) on public.lab_tests to service_role; alter table public.lab_tests drop column normalized_name;");
    const narrowRows = await run(narrow, pre);
    expect(narrowRows.find((row) => row.item === "lab_tests.normalized_name")).toMatchObject({ status: "WARN" });
    expect(blocks(narrowRows)).toEqual([]);
    expect(verdict(narrowRows).status).toBe("WARN");

    const noPrivilege = await newDb();
    await noPrivilege.ok("revoke all on table public.lab_tests from service_role; grant select (id, code, name, price_bs, active, category, sample_type) on public.lab_tests to service_role;");
    expect((await run(noPrivilege, pre)).find((row) => row.item === "service_role puede leer lab_tests.normalized_name")).toMatchObject({ status: "WARN" });
  });

  it("colisiones: una relación de otro tipo, una restricción con el mismo nombre en otra tabla y un objeto de V2 dentro del esquema crm son BLOQUEOS", async () => {
    const view = await newDb();
    await view.ok("create view public.plusmedik_audit_runs as select 1 as x;");
    expect((await run(view, pre)).find((row) => row.item === "relacion_de_otro_tipo")).toMatchObject({ status: "BLOCK" });

    const constraint = await newDb();
    await constraint.ok("create table public.ajena (n int, constraint plusmedik_audit_runs_telemetry_check check (n > 0));");
    expect((await run(constraint, pre)).find((row) => row.item === "restriccion_o_indice_en_otra_tabla")).toMatchObject({ status: "BLOCK" });

    const index = await newDb();
    await index.ok("create table public.ajena2 (n int); create index plusmedik_audit_runs_status_idx on public.ajena2 (n);");
    expect((await run(index, pre)).find((row) => row.item === "restriccion_o_indice_en_otra_tabla")).toMatchObject({ status: "BLOCK" });

    const inCrm = await newDb();
    await inCrm.ok("create function crm.plusmedik_intruso() returns int language sql as 'select 1';");
    expect((await run(inCrm, pre)).find((row) => row.item === "objetos_plusmedik_en_crm")).toMatchObject({ status: "BLOCK" });
    expect((await run(inCrm, post)).find((row) => row.item === "objetos_de_v2_en_el_esquema_crm")).toMatchObject({ status: "BLOCK" });

    const unknown = await newDb();
    await unknown.ok("create table public.plusmedik_otra_cosa (n int);");
    expect((await run(unknown, pre)).find((row) => row.item === "objetos_plusmedik_no_listados")).toMatchObject({ status: "WARN" });
  });

  it("la verificación posterior detecta cada permiso o ajuste de más", async () => {
    const mutate = async (sql: string, item: string, status = "BLOCK") => {
      const db = await newDb();
      await apply(db, 19);
      await db.ok(sql);
      const rows = await run(db, post);
      expect(rows.find((row) => row.item === item), sql).toMatchObject({ status });
      expect(verdict(rows).status, sql).toBe(status);
    };
    await mutate("grant select on public.plusmedik_turns to anon;", "tablas_expuestas_a_anon_authenticated_o_public");
    await mutate("grant select (kapso_message_id) on public.plusmedik_audit_runs to authenticated;", "tablas_expuestas_a_anon_authenticated_o_public");
    await mutate("grant select on public.plusmedik_kb_state to public;", "tablas_expuestas_a_anon_authenticated_o_public");
    await mutate("alter table public.plusmedik_turns disable row level security;", "tablas_sin_rls");
    await mutate(fn("plusmedik_kb_revision", "grant execute on function %SIG% to anon"), "ejecutables_por_anon_authenticated_o_public");
    await mutate(fn("plusmedik_kb_revision", "grant execute on function %SIG% to public"), "ejecutables_por_anon_authenticated_o_public");
    await mutate(fn("plusmedik_kb_revision", "revoke execute on function %SIG% from service_role"), "service_role_ejecuta_las_esperadas");
    await mutate(fn("plusmedik_kb_revision", "alter function %SIG% reset search_path"), "security_definer_sin_search_path_fijo");
    await mutate("alter table public.plusmedik_turns disable trigger plusmedik_turns_immutable;", "disparadores_no_habilitados");
    await mutate("grant select (payload_cipher) on public.plusmedik_crm_outbox to service_role;", "cola_al_crm_no_expone_carga_ni_arrendamiento");
    await mutate("grant select on public.plusmedik_crm_outbox to service_role;", "cola_al_crm_no_expone_carga_ni_arrendamiento");
    await mutate(fn("plusmedik_kb_revision", "alter function %SIG% owner to unprivileged"), "propietario_distinto_de_postgres", "WARN");
  });

  it("detecta una versión VIEJA de las funciones que el orden redefine (la 05 deja UNA firma con p_contact_key; la 06 el tipo conversation), solo si esa migración está aplicada", async () => {
    const partway = await newDb();
    await apply(partway, 4);
    // con la 04 aplicada y la 05 pendiente, la firma anterior es la vigente: no es un bloqueo
    const early = await run(partway, post);
    expect(early.find((row) => row.item.startsWith("plusmedik_audit_claim_run"))).toMatchObject({ status: "INFO" });
    expect(blocks(early)).toEqual([]);

    const full = await newDb();
    await apply(full, 16);
    const ok = await run(full, post);
    for (const item of ["plusmedik_audit_claim_run_una_sola_firma_con_p_contact_key", "plusmedik_audit_reserve_send_incluye_el_tipo_conversation", "plusmedik_audit_record_reply_incluye_el_tipo_conversation"]) {
      expect(ok.find((row) => row.item === item), item).toMatchObject({ status: "OK" });
    }

    const stale = await newDb();
    await apply(stale, 16);
    await stale.ok("create function public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer) returns jsonb language sql as 'select null::jsonb';");
    expect((await run(stale, post)).find((row) => row.item.startsWith("plusmedik_audit_claim_run"))).toMatchObject({ status: "BLOCK" });

    const reverted = await newDb();
    await apply(reverted, 16);
    await reverted.ok("do $b$ declare d text; begin select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'plusmedik_audit_reserve_send'; execute replace(d, 'conversation', 'zzz'); end $b$;");
    expect((await run(reverted, post)).find((row) => row.item === "plusmedik_audit_reserve_send_incluye_el_tipo_conversation")).toMatchObject({ status: "BLOCK" });
  });

  it("registro de migraciones: informa si existe y avisa de la versión duplicada con el CRM", async () => {
    const without = await newDb();
    expect((await run(without, pre)).find((row) => row.item === "supabase_migrations.schema_migrations")!.detail).toContain("no existe");
    const withLedger = await newDb();
    await withLedger.ok("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text); insert into supabase_migrations.schema_migrations values ('20261025000000', 'crm_fix'), ('20261024020818', 'crm_quote');");
    const detail = (await run(withLedger, pre)).find((row) => row.item === "supabase_migrations.schema_migrations")!.detail;
    expect(detail).toContain("versiones >= 20261020000000: 2");
    expect(detail).toContain("¿existe la 20261025000000?: 1");
  });

  it("filas previas en plusmedik_audit_runs con las migraciones 02-06 pendientes: aviso (las restricciones nuevas se validan contra ellas)", async () => {
    const db = await newDb();
    await db.ok(readFileSync(join(MIGRATIONS_DIR, files[0]!.file), "utf8"));
    const clean = await run(db, pre);
    expect(clean.find((row) => row.item.startsWith("plusmedik_audit_runs_con_filas"))).toBeUndefined();
    await db.ok("insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('wamid.previo', 'PROCESSING');");
    const rows = await run(db, pre);
    expect(rows.find((row) => row.item.startsWith("plusmedik_audit_runs_con_filas"))).toMatchObject({ status: "WARN" });
    expect(rows.find((row) => row.item === "filas_en_tablas_ya_existentes")!.detail).toContain("plusmedik_audit_runs=1");
  });

  it("falta un rol exigido (service_role): BLOQUEO en la verificación previa", async () => {
    const db = await newDb();
    await db.ok("alter role service_role rename to service_role_ausente;");
    try {
      const rows = await run(db, pre);
      expect(rows.find((row) => row.section === "ROLES" && row.item === "service_role")).toMatchObject({ status: "BLOCK" });
      expect(verdict(rows).status).toBe("BLOCK");
    } finally {
      await db.ok("alter role service_role_ausente rename to service_role;");
    }
  });
});
