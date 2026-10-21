import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Base de datos en memoria con lo mínimo de Supabase (roles, auth.uid(), storage.buckets) y las tablas de catálogo existentes,
// para probar la migración real, la RLS y create_quote sin tocar el proyecto de producción.
const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);

-- Catálogo existente (columnas que lee src/supabase-catalog.ts).
create table public.lab_tests (
  id uuid primary key,
  code text,
  name text not null,
  normalized_name text not null,
  price_bs numeric not null,
  active boolean not null default true,
  category text,
  sample_type text
);
create table public.lab_test_aliases (
  id bigint generated always as identity primary key,
  lab_test_id uuid not null references public.lab_tests(id),
  normalized_alias text not null
);

-- Privilegios por defecto de Supabase: la RLS es la que protege.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
`;

export const ids = {
  hemograma: "00000000-0000-4000-8000-000000000001",
  glicemia: "00000000-0000-4000-8000-000000000002",
  tsh: "00000000-0000-4000-8000-000000000003",
  inactivo: "00000000-0000-4000-8000-000000000004",
  tarifaA: "10000000-0000-4000-8000-000000000001",
  orgA: "20000000-0000-4000-8000-000000000001",
  orgB: "20000000-0000-4000-8000-000000000002",
  orgInactiva: "20000000-0000-4000-8000-000000000003",
  userA: "30000000-0000-4000-8000-000000000001",
  userA2: "30000000-0000-4000-8000-000000000002",
  orgAdminA: "30000000-0000-4000-8000-000000000003",
  userB: "30000000-0000-4000-8000-000000000004",
  admin: "30000000-0000-4000-8000-000000000005",
  inactiveUser: "30000000-0000-4000-8000-000000000006",
  userInactiveOrg: "30000000-0000-4000-8000-000000000007"
} as const;

const SEED = `
insert into public.lab_tests (id, code, name, normalized_name, price_bs, active, sample_type) values
  ('${ids.hemograma}', 'HEM01', 'Hemograma completo', 'hemograma completo', 50, true, 'Sangre'),
  ('${ids.glicemia}', 'GLI01', 'Glicemia', 'glicemia', 20, true, 'Suero'),
  ('${ids.tsh}', null, 'TSH', 'tsh', 80, true, 'Suero'),
  ('${ids.inactivo}', 'OLD01', 'Estudio viejo', 'estudio viejo', 10, false, null);

insert into public.tariffs (id, name) values ('${ids.tarifaA}', 'Convenio A');
-- La tarifa A tiene precio propio para hemograma; glicemia y TSH caen al precio Paciente.
insert into public.tariff_prices (tariff_id, lab_test_id, price_bs) values ('${ids.tarifaA}', '${ids.hemograma}', 40);

insert into public.organizations (id, name, kind, tariff_id, active) values
  ('${ids.orgA}', 'Clínica A', 'clinica', '${ids.tarifaA}', true),
  ('${ids.orgB}', 'Dr. B', 'medico', null, true),
  ('${ids.orgInactiva}', 'Convenio cerrado', 'convenio', null, false);

insert into auth.users (id) values
  ('${ids.userA}'), ('${ids.userA2}'), ('${ids.orgAdminA}'), ('${ids.userB}'), ('${ids.admin}'), ('${ids.inactiveUser}'), ('${ids.userInactiveOrg}');

insert into public.profiles (user_id, organization_id, full_name, role, active) values
  ('${ids.userA}', '${ids.orgA}', 'Usuario A', 'member', true),
  ('${ids.userA2}', '${ids.orgA}', 'Usuario A2', 'member', true),
  ('${ids.orgAdminA}', '${ids.orgA}', 'Jefa A', 'org_admin', true),
  ('${ids.userB}', '${ids.orgB}', 'Doctor B', 'member', true),
  ('${ids.admin}', null, 'PlusMedik', 'admin', true),
  ('${ids.inactiveUser}', '${ids.orgA}', 'Ex usuario', 'member', false),
  ('${ids.userInactiveOrg}', '${ids.orgInactiva}', 'Usuario cerrado', 'member', true);
`;

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const dir = join(import.meta.dirname, "..", "..", "supabase", "migrations");
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(await readFile(join(dir, file), "utf8"));
  }
  await db.exec(SEED);
  return db;
}

// Ejecuta `fn` como un usuario autenticado (rol authenticated + auth.uid()), igual que una petición con su JWT.
export async function asUser<T>(db: PGlite, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.exec(userId ? "set role authenticated" : "set role anon");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}
