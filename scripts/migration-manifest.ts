// Manifiesto de las migraciones SQL de PlusMedik V2 y generador de las verificaciones de SOLO LECTURA (antes y después de aplicarlas a mano en el SQL Editor).
// El manifiesto se DERIVA del texto de las migraciones (no se escribe a mano): lo que cada archivo crea, qué agrega con ALTER y a quién concede EXECUTE.
//   npx tsx scripts/migration-manifest.ts           escribe supabase/preflight/v2_pre_apply_read_only.sql y v2_post_apply_read_only.sql
//   npx tsx scripts/migration-manifest.ts --check   falla si los archivos escritos no coinciden con las migraciones actuales
// NO se conecta a ninguna base: solo lee archivos locales y escribe texto.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIR = join(root, "supabase", "migrations");
export const PREFLIGHT_DIR = join(root, "supabase", "preflight");
export const PRE_FILE = "v2_pre_apply_read_only.sql";
export const POST_FILE = "v2_post_apply_read_only.sql";
// Proyecto Supabase compartido con el CRM (según .env de V2 y del CRM). Es un identificador, no un secreto.
export const EXPECTED_PROJECT_REF = "cvokrtrdzxfchntwwslz";

export type ObjectKind = "table" | "view" | "function" | "trigger" | "index" | "column" | "constraint";
export interface ManifestEntry { mig: number; kind: ObjectKind; name: string; parent: string }
export interface MigrationInfo { index: number; file: string; version: string; sha256: string; lines: number }
export interface Manifest {
  migrations: MigrationInfo[];
  // Cada objeto aparece una sola vez, atribuido a la PRIMERA migración que lo define (las demás solo lo reemplazan).
  entries: ManifestEntry[];
  // Funciones a las que alguna migración concede EXECUTE a service_role.
  serviceFunctions: string[];
  // Objetos redefinidos por migraciones posteriores (el ORDEN decide la versión final).
  redefined: Array<{ name: string; kind: ObjectKind; migrations: number[] }>;
}

const stripComments = (sql: string) => sql.replaceAll("\r\n", "\n").split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");

export function readMigrations(dir = MIGRATIONS_DIR): Array<{ file: string; text: string; raw: string }> {
  return readdirSync(dir).filter((name) => name.endsWith(".sql")).sort().map((file) => {
    const raw = readFileSync(join(dir, file), "utf8");
    return { file, raw, text: stripComments(raw) };
  });
}

export function buildManifest(dir = MIGRATIONS_DIR): Manifest {
  const files = readMigrations(dir);
  const all: ManifestEntry[] = [];
  const serviceFunctions = new Set<string>();
  files.forEach(({ text }, index) => {
    const mig = index + 1;
    const add = (kind: ObjectKind, name: string, parent = "") => all.push({ mig, kind, name, parent });
    for (const m of text.matchAll(/create table if not exists public\.([a-z_0-9]+)/gi)) add("table", m[1]!);
    for (const m of text.matchAll(/create (?:or replace )?view public\.([a-z_0-9]+)/gi)) add("view", m[1]!);
    for (const m of text.matchAll(/create or replace function public\.([a-z_0-9]+)\s*\(/gi)) add("function", m[1]!);
    for (const m of text.matchAll(/create or replace trigger ([a-z_0-9]+)\s+(?:before|after)[^;]*?\bon public\.([a-z_0-9]+)/gi)) add("trigger", m[1]!, m[2]!);
    for (const m of text.matchAll(/create (?:unique )?index if not exists ([a-z_0-9]+)\s+on public\.([a-z_0-9]+)/gi)) add("index", m[1]!, m[2]!);
    for (const statement of text.matchAll(/alter table public\.([a-z_0-9]+)\s+([^;]*?);/gi)) {
      for (const column of statement[2]!.matchAll(/add column if not exists ([a-z_0-9]+)/gi)) add("column", column[1]!, statement[1]!);
      for (const constraint of statement[2]!.matchAll(/add constraint ([a-z_0-9]+)/gi)) add("constraint", constraint[1]!, statement[1]!);
    }
    for (const m of text.matchAll(/grant execute on function public\.([a-z_0-9]+)\s*\([^;]*?\)\s+to\s+service_role/gi)) serviceFunctions.add(m[1]!);
  });
  const first = new Map<string, ManifestEntry>();
  const seen = new Map<string, Set<number>>();
  for (const entry of all) {
    const key = `${entry.kind}:${entry.name}`;
    if (!first.has(key)) first.set(key, entry);
    seen.set(key, (seen.get(key) ?? new Set()).add(entry.mig));
  }
  const entries = [...first.values()].sort((a, b) => a.mig - b.mig || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const redefined = [...seen.entries()].filter(([, set]) => set.size > 1).map(([key, set]) => ({ kind: key.split(":")[0] as ObjectKind, name: key.split(":")[1]!, migrations: [...set].sort((a, b) => a - b) }))
    .filter((item) => item.kind === "function" || item.kind === "constraint").sort((a, b) => a.name.localeCompare(b.name));
  const migrations = files.map(({ file, raw }, index) => ({ index: index + 1, file, version: file.split("_")[0]!, sha256: createHash("sha256").update(raw.replaceAll("\r\n", "\n")).digest("hex"), lines: raw.split(/\r?\n/).length }));
  return { migrations, entries, serviceFunctions: [...serviceFunctions].sort(), redefined };
}

const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;
const valuesOf = (rows: string[][]) => rows.map((row) => `    (${row.join(", ")})`).join(",\n");

function manifestCte(manifest: Manifest): string {
  const rows = manifest.entries.map((e) => [String(e.mig), lit(e.kind), lit(e.name), lit(e.parent)]);
  const files = manifest.migrations.map((m) => [String(m.index), lit(m.file)]);
  const service = manifest.serviceFunctions.map((name) => [lit(name)]);
  return `manifest(mig, kind, name, parent) as (
  values
${valuesOf(rows)}
),
migration_files(mig, file) as (
  values
${valuesOf(files)}
),
service_functions(name) as (
  values
${valuesOf(service)}
),
-- Qué parte del manifiesto existe hoy en la base (por catálogos; no depende del registro de migraciones, que el SQL Editor no escribe).
present as (
  select m.mig, m.kind, m.name, m.parent,
    case m.kind
      when 'table' then exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = m.name and c.relkind in ('r', 'p'))
      when 'view' then exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = m.name and c.relkind = 'v')
      when 'function' then exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = m.name)
      when 'trigger' then exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname = m.parent and t.tgname = m.name)
      when 'index' then exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.tablename = m.parent and i.indexname = m.name)
      when 'column' then exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || quote_ident(m.parent)) and a.attname = m.name and a.attnum > 0 and not a.attisdropped)
      when 'constraint' then exists (select 1 from pg_constraint k where k.conrelid = to_regclass('public.' || quote_ident(m.parent)) and k.conname = m.name)
    end as ok
  from manifest m
),
migration_state as (
  select p.mig, count(*) as total, count(*) filter (where p.ok) as present,
    string_agg(p.kind || ':' || p.name, ', ' order by p.kind, p.name) filter (where not p.ok) as missing,
    case when count(*) filter (where p.ok) = 0 then 'NOT_APPLIED' when count(*) filter (where p.ok) = count(*) then 'APPLIED' else 'PARTIAL' end as state
  from present p group by p.mig
)`;
}

// Cuenta filas de una tabla sin escribir nada (SELECT count(*) ejecutado por query_to_xml). Solo se evalúa para tablas que existen.
const countRows = (table: string) => `(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', ${table}), false, true, '')))[1]::text::bigint`;

// Instantánea de lo que NO debe cambiar al aplicar las migraciones (catálogo de laboratorio y esquema del CRM): se guarda antes y se compara después.
const SNAPSHOT = `
  select 900 as ord, 'INSTANTANEA' as section, 'lab_tests.columnas' as item, 'INFO' as status,
    coalesce((select md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)) from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attnum > 0 and not a.attisdropped), 'tabla ausente') as detail
  union all select 901, 'INSTANTANEA', 'lab_tests.filas', 'INFO',
    coalesce((select ${countRows("'lab_tests'")}::text where to_regclass('public.lab_tests') is not null), 'tabla ausente')
  union all select 902, 'INSTANTANEA', 'lab_test_aliases.filas', 'INFO',
    coalesce((select ${countRows("'lab_test_aliases'")}::text where to_regclass('public.lab_test_aliases') is not null), 'tabla ausente')
  union all select 903, 'INSTANTANEA', 'lab_tests.politicas_y_triggers', 'INFO',
    coalesce((select md5(coalesce((select string_agg(polname, ',' order by polname) from pg_policy where polrelid = to_regclass('public.lab_tests')), '') || '|' || coalesce((select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = to_regclass('public.lab_tests') and not tgisinternal), '')) where to_regclass('public.lab_tests') is not null), 'tabla ausente')
  union all select 904, 'INSTANTANEA', 'lab_tests.privilegios_service_role', 'INFO',
    coalesce((select md5(string_agg(a.attname, ',' order by a.attname)) from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attnum > 0 and not a.attisdropped and has_column_privilege((select oid from pg_roles where rolname = 'service_role'), a.attrelid, a.attname, 'SELECT')), 'sin columnas legibles')
  union all select 910, 'INSTANTANEA', 'crm.objetos', 'INFO',
    coalesce((select format('tablas=%s funciones=%s', (select count(*) from pg_class c where c.relnamespace = to_regnamespace('crm') and c.relkind in ('r', 'p')), (select count(*) from pg_proc p where p.pronamespace = to_regnamespace('crm'))) where to_regnamespace('crm') is not null), 'esquema crm ausente')
  union all select 911, 'INSTANTANEA', 'crm.funciones_md5', 'INFO',
    coalesce((select md5(coalesce(string_agg(pg_get_functiondef(p.oid), E'\\n' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = to_regnamespace('crm') and p.prokind in ('f', 'p')), 'esquema crm ausente')
  union all select 912, 'INSTANTANEA', 'crm.filas_conversaciones_y_casos', 'INFO',
    coalesce((select format('messages=%s review_cases=%s', ${countRows("'__none__'").replace("public.%I", "crm.messages")}, ${countRows("'__none__'").replace("public.%I", "crm.review_cases")}) where to_regclass('crm.messages') is not null and to_regclass('crm.review_cases') is not null), 'tablas del crm ausentes')`;

const COMMON_HEAD = (manifest: Manifest, title: string, body: string[]) => `-- ${title}
-- GENERADO por scripts/migration-manifest.ts a partir de supabase/migrations/*.sql. NO editar a mano (una prueba falla si no coincide).
-- SOLO LECTURA: una sola sentencia SELECT. No contiene DDL, DML, RPC ni datos clínicos; devuelve metadatos y conteos.
-- Ejecutar exclusivamente en el proyecto Supabase ${EXPECTED_PROJECT_REF} (verificar el identificador en la URL del panel ANTES de ejecutar),
-- con el rol administrativo del SQL Editor. Es seguro ejecutarla dentro de una transacción de solo lectura.
${body.map((line) => `-- ${line}`).join("\n")}
--
-- Migraciones cubiertas (sha256 del archivo con saltos de línea LF):
${manifest.migrations.map((m) => `--   ${String(m.index).padStart(2, "0")}  ${m.file}  ${m.sha256}`).join("\n")}
--
-- Resultado: una tabla (orden, seccion, comprobacion, estado, detalle). Estados: OK · INFO · WARN (revisar) · BLOCK (detenerse).
-- La primera fila es el VEREDICTO. Guardar el resultado completo: las filas INSTANTANEA deben ser IDÉNTICAS antes y después.
`;

const SELECT_ALL = `
select ord, section, item, status, detail from (
  select 0 as ord, 'VEREDICTO' as section, 'resumen' as item,
    case when count(*) filter (where status = 'BLOCK') > 0 then 'BLOCK' when count(*) filter (where status = 'WARN') > 0 then 'WARN' else 'OK' end as status,
    format('BLOCK=%s WARN=%s OK=%s INFO=%s', count(*) filter (where status = 'BLOCK'), count(*) filter (where status = 'WARN'), count(*) filter (where status = 'OK'), count(*) filter (where status = 'INFO')) as detail
  from checks
  union all select ord, section, item, status, detail from checks
) result
order by ord, section, item;
`;

const ENV_AND_COLLISIONS = `
  -- ───────────── Entorno ─────────────
  select 10 as ord, 'ENTORNO' as section, 'version_de_postgres' as item,
    case when current_setting('server_version_num')::int >= 140000 then 'OK' else 'BLOCK' end as status,
    'se exige 14 o más (create or replace trigger). ' || version() as detail
  union all select 11, 'ENTORNO', 'sesion', 'INFO',
    format('base=%s usuario=%s superusuario=%s transaccion_solo_lectura=%s', current_database(), current_user, current_setting('is_superuser'), current_setting('transaction_read_only'))
  union all select 12, 'ENTORNO', 'gen_random_uuid', case when exists (select 1 from pg_proc p where p.proname = 'gen_random_uuid') then 'OK' else 'BLOCK' end, 'las tablas usan default gen_random_uuid()'
  union all select 13, 'ENTORNO', 'disparadores_de_evento', 'INFO',
    coalesce((select string_agg(evtname || ' (' || evtevent || ')', ', ' order by evtname) from pg_event_trigger), 'ninguno') || ' — los de Supabase (PostgREST, GraphQL) son normales'
  union all select 14, 'ENTORNO', 'usuario_administrativo', case when current_user in ('postgres', 'supabase_admin') or current_setting('is_superuser') = 'on' then 'OK' else 'WARN' end,
    'las funciones SECURITY DEFINER quedan a nombre de quien ejecuta la migración; debe ser postgres'
  -- ───────────── Roles ─────────────
  union all select 20, 'ROLES', r, case when exists (select 1 from pg_roles where rolname = r) then 'OK' else 'BLOCK' end, 'rol exigido por las migraciones (REVOKE/GRANT)'
    from unnest(array['anon', 'authenticated', 'service_role']) as r
  union all select 21, 'ROLES', 'crm_app', 'INFO', case when exists (select 1 from pg_roles where rolname = 'crm_app') then 'existe (rol del CRM; V2 no lo usa)' else 'no existe' end
  -- ───────────── Catálogo del laboratorio (solo lectura para V2) ─────────────
  union all select 30, 'CATALOGO', 'lab_tests', case when to_regclass('public.lab_tests') is not null then 'OK' else 'BLOCK' end, 'las migraciones 08 y 12 lo consultan dentro de sus funciones (con comprobación de existencia)'
  union all select 31, 'CATALOGO', 'lab_tests.' || c.col || ' (' || c.typ || ')',
    case when exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attname = c.col and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = c.typ) then 'OK' else 'BLOCK' end,
    'columna usada por las funciones de conocimiento y de datos por estudio'
    from (values ('id', 'uuid'), ('active', 'boolean')) as c(col, typ)
  union all select 32, 'CATALOGO', 'lab_tests.' || c.col,
    case when exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attname = c.col and not a.attisdropped) then 'OK' else 'WARN' end,
    'columna que lee el cargador de catálogo de V2 (src/supabase-catalog.ts)'
    from unnest(array['code', 'name', 'normalized_name', 'price_bs', 'category', 'sample_type']) as c(col)
  union all select 33, 'CATALOGO', 'service_role puede leer lab_tests.' || c.col,
    case when not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attname = c.col and not a.attisdropped) then 'WARN'
         when coalesce(has_column_privilege((select oid from pg_roles where rolname = 'service_role'), to_regclass('public.lab_tests'), c.col, 'SELECT'), false) then 'OK' else 'WARN' end,
    'V2 lee el catálogo con la clave de servicio; la migración 202610230009 del CRM solo concede ESTAS columnas por separado: si falta una, el cargador de V2 falla'
    from unnest(array['id', 'code', 'name', 'normalized_name', 'price_bs', 'active', 'category', 'sample_type']) as c(col)
  union all select 34, 'CATALOGO', 'lab_test_aliases', case when to_regclass('public.lab_test_aliases') is not null then 'OK' else 'WARN' end, 'columnas lab_test_id y normalized_alias (las lee el cargador de catálogo)'
  union all select 35, 'CATALOGO', 'rls_lab_tests', 'INFO', coalesce((select case when relrowsecurity then 'RLS activo (el CRM añadió políticas para crm_app); las funciones de V2 son SECURITY DEFINER' else 'RLS inactivo' end from pg_class where oid = to_regclass('public.lab_tests')), 'tabla ausente')
  -- ───────────── Colisiones con objetos existentes ─────────────
  union all select 40, 'COLISIONES', 'relacion_de_otro_tipo', case when count(*) = 0 then 'OK' else 'BLOCK' end,
    coalesce('mismo nombre pero otro tipo: ' || string_agg(c.relname || ' (' || c.relkind::text || ')', ', '), 'ninguna')
    from manifest m join pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = m.name
    where (m.kind = 'table' and c.relkind not in ('r', 'p')) or (m.kind = 'view' and c.relkind <> 'v')
  union all select 41, 'COLISIONES', 'restriccion_o_indice_en_otra_tabla', case when count(*) = 0 then 'OK' else 'BLOCK' end,
    coalesce('el nombre ya existe en otra tabla (el guard "if not exists" lo omitiría en silencio): ' || string_agg(x.name, ', '), 'ninguna')
    from (
      select m.name from manifest m join pg_constraint k on k.conname = m.name where m.kind = 'constraint' and k.conrelid is distinct from to_regclass('public.' || quote_ident(m.parent))
      union all select m.name from manifest m join pg_indexes i on i.schemaname = 'public' and i.indexname = m.name where m.kind = 'index' and i.tablename <> m.parent
    ) x
  union all select 42, 'COLISIONES', 'objetos_plusmedik_no_listados', case when count(*) = 0 then 'OK' else 'WARN' end,
    coalesce('existen objetos plusmedik_* que ninguna migración crea: ' || string_agg(u.o, ', '), 'ninguno')
    from (
      select 'relacion:' || c.relname as o from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'plusmedik\\_%' and c.relkind in ('r', 'p', 'v', 'S') and c.relname not in (select name from manifest where kind in ('table', 'view'))
      union all select 'funcion:' || p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'plusmedik\\_%' and p.proname not in (select name from manifest where kind = 'function')
    ) u
  union all select 43, 'COLISIONES', 'objetos_plusmedik_en_crm', case when count(*) = 0 then 'OK' else 'BLOCK' end,
    coalesce('V2 no debe tener nada en el esquema crm: ' || string_agg(u.o, ', '), 'ninguno (V2 solo escribe en public)')
    from (
      select c.relname as o from pg_class c where c.relnamespace = to_regnamespace('crm') and c.relname like 'plusmedik%'
      union all select p.proname from pg_proc p where p.pronamespace = to_regnamespace('crm') and p.proname like 'plusmedik%'
    ) u
  union all select 44, 'COLISIONES', 'funciones_sobrecargadas', 'INFO',
    coalesce((select string_agg(p.proname || ' x' || n, ', ' order by p.proname) from (select proname, count(*) as n from pg_proc where pronamespace = 'public'::regnamespace and proname in (select name from manifest where kind = 'function') group by proname having count(*) > 1) p), 'ninguna con más de una firma')
  -- ───────────── Estado de cada migración (por objetos; el SQL Editor no escribe el registro de migraciones) ─────────────
`;

const LEDGER = `
  union all select 60, 'REGISTRO', 'supabase_migrations.schema_migrations', 'INFO',
    case when to_regclass('supabase_migrations.schema_migrations') is null then 'no existe: las migraciones se aplican a mano y no quedan registradas'
      else format('versiones >= 20261020000000: %s; ¿existe la 20261025000000?: %s',
        (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations where version >= ''20261020000000''', false, true, '')))[1]::text,
        (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations where version = ''20261025000000''', false, true, '')))[1]::text) end
  union all select 61, 'REGISTRO', 'version_20261025000000_duplicada', 'INFO',
    'AVISO FIJO: V2 (20261025000000_plusmedik_turns) y el CRM (20261025000000_crm_fix_patient_note_and_follow_up_rpcs) comparten el número de versión: NO usar "supabase db push" desde ninguno de los dos repositorios sobre este proyecto'`;

export function renderPreflight(manifest = buildManifest()): string {
  return `${COMMON_HEAD(manifest, `PlusMedik V2 — verificación ANTES de aplicar las ${manifest.migrations.length} migraciones (solo lectura)`, [
    "Esperado: VEREDICTO = OK, las migraciones existentes como YA APLICADA y las restantes como pendientes; ninguna fila BLOCK.",
    "Si alguna migración aparece APPLIED (INFO), ya se aplicó: no repetirla sin entender por qué. PARTIAL o un hueco de orden = BLOCK.",
    "Guardar las filas INSTANTANEA: se comparan con la verificación posterior (el catálogo y el esquema crm no deben cambiar)."
  ])}
with
${manifestCte(manifest)},
checks(ord, section, item, status, detail) as (${ENV_AND_COLLISIONS}
  union all select 50 + ms.mig, 'MIGRACION', lpad(ms.mig::text, 2, '0') || ' ' || f.file,
    case ms.state
      when 'NOT_APPLIED' then case when exists (select 1 from migration_state l where l.mig > ms.mig and l.state <> 'NOT_APPLIED') then 'BLOCK' else 'OK' end
      when 'APPLIED' then 'INFO'
      else 'BLOCK' end,
    case ms.state
      when 'NOT_APPLIED' then case when exists (select 1 from migration_state l where l.mig > ms.mig and l.state <> 'NOT_APPLIED') then 'HUECO DE ORDEN: una migración posterior ya existe sin esta' else format('pendiente (0 de %s objetos)', ms.total) end
      when 'APPLIED' then format('YA APLICADA (%s de %s objetos)', ms.present, ms.total)
      else format('PARCIAL: %s de %s objetos; faltan: %s', ms.present, ms.total, left(ms.missing, 400)) end
    from migration_state ms join migration_files f on f.mig = ms.mig
  union all select 80, 'DATOS', 'filas_en_tablas_ya_existentes', case when coalesce(sum(n), 0) = 0 then 'OK' else 'WARN' end,
    coalesce(string_agg(name || '=' || n, ', ' order by name), 'ninguna tabla de V2 existe todavía')
    from (select m.name, ${countRows("m.name")} as n from manifest m where m.kind = 'table' and to_regclass('public.' || quote_ident(m.name)) is not null) t
  union all select 81, 'DATOS', 'plusmedik_audit_runs_con_filas_y_migraciones_2_a_6_pendientes', 'WARN',
    'las migraciones 02-06 agregan restricciones CHECK a plusmedik_audit_runs: con filas previas se validan contra ellas y pueden fallar (ver docs/g5/20)'
    where exists (select 1 from migration_state where mig between 2 and 6 and state = 'NOT_APPLIED')
      and case when to_regclass('public.plusmedik_audit_runs') is null then false else (${countRows("'plusmedik_audit_runs'")}) > 0 end
  union all select 82, 'ACTIVIDAD', 'transacciones_largas', case when count(*) = 0 then 'OK' else 'WARN' end,
    coalesce('abiertas hace más de 5 min: ' || string_agg(format('pid=%s estado=%s', pid, state), '; '), 'ninguna (las migraciones toman bloqueos breves sobre plusmedik_audit_runs)')
    from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and xact_start < now() - interval '5 minutes'
  union all select 83, 'PRIVILEGIOS', 'privilegios_por_defecto_en_public', 'INFO',
    coalesce((select string_agg(format('%s/%s=%s', r.rolname, d.defaclobjtype, d.defaclacl::text), '; ') from pg_default_acl d join pg_roles r on r.oid = d.defaclrole where d.defaclnamespace = 'public'::regnamespace), 'sin entradas (Supabase suele conceder a anon/authenticated/service_role; cada migración lo revoca objeto por objeto)')${LEDGER}
  union all${SNAPSHOT}
)${SELECT_ALL}`;
}

// Primera migración que define un objeto (para condicionar las comprobaciones de «versión final» a que esa migración ya esté aplicada).
function definingMigration(manifest: Manifest, kind: ObjectKind, name: string): number {
  const entry = manifest.entries.find((e) => e.kind === kind && e.name === name);
  if (!entry) throw new Error(`el manifiesto no contiene ${kind} ${name}`);
  return entry.mig;
}

export function renderPostflight(manifest = buildManifest()): string {
  const serviceCount = manifest.serviceFunctions.length;
  const controlMig = definingMigration(manifest, "function", "plusmedik_audit_confirm_send");
  const turnsMig = definingMigration(manifest, "table", "plusmedik_turns");
  return `${COMMON_HEAD(manifest, `PlusMedik V2 — verificación DESPUÉS de aplicar las ${manifest.migrations.length} migraciones (solo lectura)`, [
    "Esperado al completar el conjunto: VEREDICTO = OK, todas las migraciones completas y sin BLOCK; filas INSTANTANEA idénticas antes/después.",
    "También sirve después de CADA migración: las posteriores aparecerán como pendientes (INFO) y las aplicadas deben estar completas.",
    `Funciones con EXECUTE para service_role esperadas por las migraciones: ${serviceCount}.`
  ])}
with
${manifestCte(manifest)},
v2_functions as (
  select p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, p.proowner, p.proacl,
    exists (select 1 from service_functions s where s.name = p.proname) as expects_service
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (select name from manifest where kind = 'function')
),
v2_tables as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relacl, c.relowner
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in (select name from manifest where kind in ('table', 'view'))
),
roles as (
  select (select oid from pg_roles where rolname = 'anon') as anon, (select oid from pg_roles where rolname = 'authenticated') as authenticated, (select oid from pg_roles where rolname = 'service_role') as service
),
checks(ord, section, item, status, detail) as (
  select 10 as ord, 'MIGRACION' as section, lpad(ms.mig::text, 2, '0') || ' ' || f.file as item,
    case ms.state when 'APPLIED' then 'OK' when 'NOT_APPLIED' then 'INFO' else 'BLOCK' end as status,
    case ms.state when 'APPLIED' then format('completa (%s objetos)', ms.total) when 'NOT_APPLIED' then 'aún no aplicada' else format('PARCIAL: faltan %s', left(ms.missing, 400)) end as detail
    from migration_state ms join migration_files f on f.mig = ms.mig
  union all select 11, 'MIGRACION', 'orden', case when exists (select 1 from migration_state a join migration_state b on b.mig > a.mig where a.state = 'NOT_APPLIED' and b.state <> 'NOT_APPLIED') then 'BLOCK' else 'OK' end, 'ninguna migración existe sin las anteriores'
  -- ───────────── Seguridad de tablas y vistas ─────────────
  union all select 20, 'SEGURIDAD', 'tablas_sin_rls', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(relname, ', '), 'todas las tablas de V2 tienen RLS')
    from v2_tables where relkind in ('r', 'p') and not relrowsecurity
  union all select 21, 'SEGURIDAD', 'tablas_expuestas_a_anon_authenticated_o_public', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(distinct t.relname, ', '), 'ninguna')
    from v2_tables t cross join roles r
    where has_table_privilege(r.anon, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r.anon, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_table_privilege(r.authenticated, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r.authenticated, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
       or exists (select 1 from aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a where a.grantee = 0)
  union all select 22, 'SEGURIDAD', 'tablas_que_service_role_puede_escribir_directamente', 'INFO',
    coalesce((select string_agg(t.relname, ', ' order by t.relname) from v2_tables t cross join roles r where t.relkind in ('r', 'p') and has_table_privilege(r.service, t.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')), 'ninguna (toda escritura pasa por funciones)')
  union all select 23, 'SEGURIDAD', 'cola_al_crm_no_expone_carga_ni_arrendamiento',
    case when to_regclass('public.plusmedik_crm_outbox') is null then 'INFO'
      when not coalesce(has_table_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'SELECT'), false)
       and not coalesce(has_column_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'payload_cipher', 'SELECT'), false)
       and not coalesce(has_column_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'lease_owner', 'SELECT'), false)
       and not coalesce(has_column_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'lease_fence', 'SELECT'), false) then 'OK' else 'BLOCK' end,
    'service_role no debe leer payload_cipher (teléfono cifrado) ni el arrendamiento de la cola'
    from roles r
  -- ───────────── Funciones ─────────────
  union all select 30, 'FUNCIONES', 'ejecutables_por_anon_authenticated_o_public', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(distinct f.proname, ', '), 'ninguna')
    from v2_functions f cross join roles r
    where has_function_privilege(r.anon, f.oid, 'EXECUTE') or has_function_privilege(r.authenticated, f.oid, 'EXECUTE')
       or exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  union all select 31, 'FUNCIONES', 'service_role_ejecuta_las_esperadas', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce('sin EXECUTE: ' || string_agg(distinct f.proname, ', '), 'las ${serviceCount} funciones de servicio tienen EXECUTE para service_role')
    from v2_functions f cross join roles r where f.expects_service and not coalesce(has_function_privilege(r.service, f.oid, 'EXECUTE'), false)
  union all select 32, 'FUNCIONES', 'security_definer_sin_search_path_fijo', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(distinct f.proname, ', '), 'todas fijan search_path')
    from v2_functions f where f.prosecdef and not coalesce(array_to_string(f.proconfig, ',') like '%search_path=%', false)
  union all select 33, 'FUNCIONES', 'propietario_distinto_de_postgres', case when count(*) = 0 then 'OK' else 'WARN' end, coalesce(string_agg(distinct f.proname || ' (' || pg_get_userbyid(f.proowner) || ')', ', '), 'todas pertenecen a postgres')
    from v2_functions f where pg_get_userbyid(f.proowner) <> 'postgres'
  union all select 34, 'FUNCIONES', 'cuantas_funciones_de_v2', 'INFO', format('%s funciones presentes de %s esperadas', (select count(distinct proname) from v2_functions), (select count(*) from manifest where kind = 'function'))
  -- ───────────── Versión final de las funciones redefinidas (el orden importa) ─────────────
  union all select 40, 'VERSIONES', 'plusmedik_audit_claim_run_una_sola_firma_con_p_contact_key',
    case when not exists (select 1 from migration_state where mig = ${controlMig} and state = 'APPLIED') then 'INFO'
         when to_regprocedure('public.plusmedik_audit_claim_run(text,text,text,integer,integer,text,jsonb,integer,text)') is not null
          and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'plusmedik_audit_claim_run') = 1 then 'OK' else 'BLOCK' end,
    'la migración ${String(controlMig).padStart(2, "0")} elimina la firma anterior y deja una con p_contact_key (opcional); solo se exige cuando esa migración está aplicada'
  union all select 41, 'VERSIONES', f.proname || '_incluye_el_tipo_conversation',
    case when not exists (select 1 from migration_state where mig = ${turnsMig} and state = 'APPLIED') then 'INFO'
         when exists (select 1 from v2_functions v where v.proname = f.proname and v.prosrc like '%conversation%') then 'OK' else 'BLOCK' end,
    'la migración ${String(turnsMig).padStart(2, "0")} reemplaza esta función; si no contiene "conversation" quedó la versión anterior'
    from (values ('plusmedik_audit_reserve_send'), ('plusmedik_audit_record_reply')) as f(proname)
  -- ───────────── Disparadores, restricciones y datos ─────────────
  union all select 50, 'INTEGRIDAD', 'disparadores_no_habilitados', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(t.tgname || '@' || c.relname, ', '), 'todos habilitados (la inmutabilidad depende de ellos)')
    from manifest m join pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = m.parent join pg_trigger t on t.tgrelid = c.oid and t.tgname = m.name and not t.tgisinternal
    where m.kind = 'trigger' and t.tgenabled <> 'O'
  union all select 51, 'INTEGRIDAD', 'restricciones_sin_validar', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(k.conname, ', '), 'todas validadas')
    from pg_constraint k where k.connamespace = 'public'::regnamespace and k.conname in (select name from manifest where kind = 'constraint') and not k.convalidated
  union all select 52, 'INTEGRIDAD', 'filas_en_tablas_de_v2', 'INFO', coalesce(string_agg(name || '=' || n, ', ' order by name), 'ninguna tabla')
    from (select m.name, ${countRows("m.name")} as n from manifest m where m.kind = 'table' and to_regclass('public.' || quote_ident(m.name)) is not null) t
  union all select 53, 'INTEGRIDAD', 'objetos_de_v2_en_el_esquema_crm', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(u.o, ', '), 'ninguno')
    from (select c.relname as o from pg_class c where c.relnamespace = to_regnamespace('crm') and c.relname like 'plusmedik%'
          union all select p.proname from pg_proc p where p.pronamespace = to_regnamespace('crm') and p.proname like 'plusmedik%') u
  union all${SNAPSHOT}
)${SELECT_ALL}`;
}

export function expectedFiles(manifest = buildManifest()): Record<string, string> {
  return { [PRE_FILE]: renderPreflight(manifest), [POST_FILE]: renderPostflight(manifest) };
}

function main(): void {
  const check = process.argv.includes("--check");
  const files = expectedFiles();
  let drift = 0;
  for (const [name, content] of Object.entries(files)) {
    const path = join(PREFLIGHT_DIR, name);
    if (check) {
      let current = "";
      try { current = readFileSync(path, "utf8").replaceAll("\r\n", "\n"); } catch { current = ""; }
      if (current !== content) { console.error(`DESACTUALIZADO: ${name}`); drift++; }
    } else {
      mkdirSync(PREFLIGHT_DIR, { recursive: true });
      writeFileSync(path, content);
      console.log(`escrito ${name} (${content.split("\n").length} líneas)`);
    }
  }
  if (check && drift > 0) process.exit(1);
  if (check) console.log("las verificaciones coinciden con las migraciones");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
