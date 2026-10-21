-- Portal web de cotización (convenios, clínicas y doctores).
-- lab_tests y lab_test_aliases ya existen y NO se modifican: solo se leen.
-- Toda escritura de usuarios finales pasa por funciones (create_quote, mark_password_changed) o por el servidor con service role.

-- ── Tarifas ─────────────────────────────────────────────────────────────────
create table public.tariffs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 120),
  notes text,
  created_at timestamptz not null default now()
);

-- Precio de un estudio en una tarifa. Sin fila: se usa lab_tests.price_bs (tarifa Paciente).
create table public.tariff_prices (
  tariff_id uuid not null references public.tariffs(id) on delete cascade,
  lab_test_id uuid not null references public.lab_tests(id) on delete cascade,
  price_bs numeric(12, 2) not null check (price_bs >= 0),
  updated_at timestamptz not null default now(),
  primary key (tariff_id, lab_test_id)
);

-- ── Organizaciones y perfiles ───────────────────────────────────────────────
-- Un doctor independiente es una organización de tipo 'medico' con un solo usuario.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  kind text not null check (kind in ('convenio', 'clinica', 'medico')),
  tariff_id uuid references public.tariffs(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete restrict,
  full_name text not null default '',
  role text not null default 'member' check (role in ('member', 'org_admin', 'admin')),
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  -- Solo el personal de PlusMedik (admin) puede no pertenecer a una organización.
  check (role = 'admin' or organization_id is not null)
);
create index profiles_organization_idx on public.profiles (organization_id);

-- ── Fotos de órdenes ────────────────────────────────────────────────────────
create table public.photo_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  -- null cuando la retención ya borró la imagen.
  storage_path text,
  image_sha256 text,
  status text not null default 'uploading' check (status in ('uploading', 'running', 'done', 'failed')),
  decision text check (decision in ('AUTO_SAFE', 'HUMAN_REVIEW')),
  -- Precarga para el carrito (solo UUIDs de lab_tests y textos leídos); nunca precios.
  result jsonb,
  error text,
  reused_from uuid references public.photo_jobs(id) on delete set null,
  cost_usd numeric(10, 4),
  duration_ms integer,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index photo_jobs_user_created_idx on public.photo_jobs (user_id, created_at desc);
create index photo_jobs_sha_done_idx on public.photo_jobs (image_sha256, finished_at desc) where status = 'done';
create index photo_jobs_active_idx on public.photo_jobs (status, started_at) where status in ('uploading', 'running');

-- ── Cotizaciones ────────────────────────────────────────────────────────────
create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  folio bigint generated always as identity unique,
  organization_id uuid references public.organizations(id) on delete restrict,
  -- Referencia al perfil (no a auth.users) para poder mostrar quién la creó; los usuarios se desactivan, no se borran.
  created_by uuid not null references public.profiles(user_id) on delete restrict,
  patient_name text check (patient_name is null or length(patient_name) <= 160),
  tariff_id uuid references public.tariffs(id) on delete set null,
  -- Copia del nombre de la tarifa al momento de cotizar ('Paciente' si no hay tarifa).
  tariff_name text not null,
  total_bs numeric(12, 2) not null,
  source text not null check (source in ('manual', 'paste', 'photo', 'template', 'repeat')),
  photo_job_id uuid references public.photo_jobs(id) on delete set null,
  valid_until date not null,
  created_at timestamptz not null default now()
);
create index quotes_org_created_idx on public.quotes (organization_id, created_at desc);
create index quotes_user_created_idx on public.quotes (created_by, created_at desc);

-- Copia de nombre, código y precio: una cotización emitida no cambia si después cambia el catálogo.
create table public.quote_items (
  quote_id uuid not null references public.quotes(id) on delete cascade,
  position smallint not null,
  lab_test_id uuid not null references public.lab_tests(id) on delete restrict,
  code text,
  name text not null,
  sample_type text,
  price_bs numeric(12, 2) not null,
  primary key (quote_id, position)
);

create table public.quote_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  lab_test_ids uuid[] not null check (cardinality(lab_test_ids) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, name)
);

-- ── Gasto de IA (lo escribe el servidor) ────────────────────────────────────
create table public.ai_usage (
  id bigint generated always as identity primary key,
  photo_job_id uuid references public.photo_jobs(id) on delete set null,
  label text not null,
  provider text not null,
  model text not null,
  cache_hit boolean not null default false,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cost_usd numeric(12, 6),
  created_at timestamptz not null default now()
);
create index ai_usage_created_idx on public.ai_usage (created_at desc);
create index ai_usage_job_idx on public.ai_usage (photo_job_id);

-- ── Helpers de RLS (security definer: leen profiles sin recursión de políticas) ─
-- Devuelven null si el usuario no tiene perfil o está inactivo, así toda política que los use niega el acceso.
create function public.my_role() returns text
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p where p.user_id = (select auth.uid()) and p.active
$$;

create function public.my_org() returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.organization_id from public.profiles p where p.user_id = (select auth.uid()) and p.active
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.tariffs enable row level security;
alter table public.tariff_prices enable row level security;
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.photo_jobs enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;
alter table public.quote_templates enable row level security;
alter table public.ai_usage enable row level security;

-- tariff_prices y ai_usage: sin políticas para usuarios (solo service role). Los precios llegan al usuario por /api/catalog.

create policy tariffs_select on public.tariffs for select to authenticated
  using (
    (select public.my_role()) = 'admin'
    or id = (select o.tariff_id from public.organizations o where o.id = (select public.my_org()))
  );

create policy organizations_select on public.organizations for select to authenticated
  using ((select public.my_role()) = 'admin' or id = (select public.my_org()));

create policy profiles_select on public.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.my_role()) = 'admin'
    or ((select public.my_role()) = 'org_admin' and organization_id = (select public.my_org()))
  );

create policy photo_jobs_select on public.photo_jobs for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select public.my_role()) is not null)
    or (select public.my_role()) = 'admin'
  );

create policy quotes_select on public.quotes for select to authenticated
  using (
    (created_by = (select auth.uid()) and (select public.my_role()) is not null)
    or (select public.my_role()) = 'admin'
    or ((select public.my_role()) = 'org_admin' and organization_id = (select public.my_org()))
  );

-- Visible si la cotización es visible (la subconsulta aplica la RLS de quotes).
create policy quote_items_select on public.quote_items for select to authenticated
  using (quote_id in (select q.id from public.quotes q));

create policy quote_templates_select on public.quote_templates for select to authenticated
  using (owner_user_id = (select auth.uid()) and (select public.my_role()) is not null);
create policy quote_templates_insert on public.quote_templates for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and (select public.my_role()) is not null);
create policy quote_templates_update on public.quote_templates for update to authenticated
  using (owner_user_id = (select auth.uid()) and (select public.my_role()) is not null)
  with check (owner_user_id = (select auth.uid()));
create policy quote_templates_delete on public.quote_templates for delete to authenticated
  using (owner_user_id = (select auth.uid()) and (select public.my_role()) is not null);

-- ── Funciones para el usuario final ─────────────────────────────────────────
-- Crea una cotización con precios calculados AQUÍ (tarifa de la organización, o precio Paciente): nunca se confía en el cliente.
create function public.create_quote(
  p_lab_test_ids uuid[],
  p_patient_name text default null,
  p_source text default 'manual',
  p_photo_job_id uuid default null,
  p_validity_days integer default 30
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_tariff_id uuid;
  v_tariff_name text;
  v_quote_id uuid;
  v_folio bigint;
  v_total numeric(12, 2);
  v_valid_until date;
begin
  if v_uid is null then
    raise exception 'no autenticado' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles p where p.user_id = v_uid;
  if not found or not v_profile.active then
    raise exception 'usuario inactivo' using errcode = '42501';
  end if;
  if v_profile.organization_id is not null then
    select o.tariff_id into v_tariff_id from public.organizations o where o.id = v_profile.organization_id and o.active;
    if not found then
      raise exception 'organización inactiva' using errcode = '42501';
    end if;
  end if;
  if p_source is null or p_source not in ('manual', 'paste', 'photo', 'template', 'repeat') then
    raise exception 'origen inválido' using errcode = '22023';
  end if;
  if p_lab_test_ids is null or cardinality(p_lab_test_ids) = 0 then
    raise exception 'la cotización está vacía' using errcode = '22023';
  end if;
  if cardinality(p_lab_test_ids) > 200 then
    raise exception 'demasiados estudios' using errcode = '22023';
  end if;
  if p_validity_days is null or p_validity_days not between 1 and 365 then
    raise exception 'validez inválida' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_lab_test_ids) as r(id)
    left join public.lab_tests lt on lt.id = r.id and lt.active
    where lt.id is null
  ) then
    raise exception 'un estudio no existe o no está activo' using errcode = '22023';
  end if;
  if p_photo_job_id is not null and not exists (
    select 1 from public.photo_jobs j where j.id = p_photo_job_id and j.user_id = v_uid
  ) then
    raise exception 'foto inválida' using errcode = '22023';
  end if;

  select coalesce((select t.name from public.tariffs t where t.id = v_tariff_id), 'Paciente') into v_tariff_name;
  v_valid_until := current_date + p_validity_days;

  insert into public.quotes (organization_id, created_by, patient_name, tariff_id, tariff_name, total_bs, source, photo_job_id, valid_until)
  values (v_profile.organization_id, v_uid, nullif(trim(p_patient_name), ''), v_tariff_id, v_tariff_name, 0, p_source, p_photo_job_id, v_valid_until)
  returning id, folio into v_quote_id, v_folio;

  -- Un estudio, una línea (deduplicado por UUID, conservando el orden del carrito).
  insert into public.quote_items (quote_id, position, lab_test_id, code, name, sample_type, price_bs)
  select v_quote_id, row_number() over (order by r.ord), lt.id, lt.code, lt.name, lt.sample_type, coalesce(tp.price_bs, lt.price_bs)
  from (
    select u.id, min(u.ord) as ord from unnest(p_lab_test_ids) with ordinality as u(id, ord) group by u.id
  ) r
  join public.lab_tests lt on lt.id = r.id
  left join public.tariff_prices tp on tp.lab_test_id = lt.id and tp.tariff_id = v_tariff_id;

  select coalesce(sum(qi.price_bs), 0) into v_total from public.quote_items qi where qi.quote_id = v_quote_id;
  update public.quotes q set total_bs = v_total where q.id = v_quote_id;

  return jsonb_build_object('id', v_quote_id, 'folio', v_folio, 'total_bs', v_total, 'valid_until', v_valid_until, 'tariff_name', v_tariff_name);
end;
$$;

-- El usuario ya cambió su contraseña temporal (solo afecta a su propio perfil).
create function public.mark_password_changed() returns void
language sql volatile security definer set search_path = ''
as $$
  update public.profiles set must_change_password = false where user_id = (select auth.uid())
$$;

-- Estudios que el usuario más cotizó en los últimos 90 días (chips de "Frecuentes").
create function public.frequent_studies(p_limit integer default 12)
returns table (lab_test_id uuid, uses bigint)
language sql stable security invoker set search_path = ''
as $$
  select qi.lab_test_id, count(*) as uses
  from public.quote_items qi
  join public.quotes q on q.id = qi.quote_id
  where q.created_by = (select auth.uid()) and q.created_at > now() - interval '90 days'
  group by qi.lab_test_id
  order by uses desc, max(q.created_at) desc
  limit least(greatest(coalesce(p_limit, 12), 1), 50)
$$;

revoke execute on function public.create_quote(uuid[], text, text, uuid, integer) from public, anon;
revoke execute on function public.mark_password_changed() from public, anon;
revoke execute on function public.frequent_studies(integer) from public, anon;
revoke execute on function public.my_role() from public, anon;
revoke execute on function public.my_org() from public, anon;
grant execute on function public.create_quote(uuid[], text, text, uuid, integer) to authenticated;
grant execute on function public.mark_password_changed() to authenticated;
grant execute on function public.frequent_studies(integer) to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.my_org() to authenticated;

-- ── Función de administración (solo service role) ───────────────────────────
-- Importa precios de una tarifa en UNA transacción. Con p_replace, borra los precios que no vienen en el archivo
-- (esos estudios vuelven al precio Paciente). Nunca hay un momento con la tarifa a medio cargar.
create function public.admin_set_tariff_prices(p_tariff_id uuid, p_prices jsonb, p_replace boolean default false)
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_replace then
    delete from public.tariff_prices tp
    where tp.tariff_id = p_tariff_id
      and not exists (
        select 1 from jsonb_to_recordset(p_prices) as x(lab_test_id uuid, price_bs numeric) where x.lab_test_id = tp.lab_test_id
      );
  end if;
  insert into public.tariff_prices (tariff_id, lab_test_id, price_bs, updated_at)
  select p_tariff_id, x.lab_test_id, x.price_bs, now()
  from jsonb_to_recordset(p_prices) as x(lab_test_id uuid, price_bs numeric)
  on conflict (tariff_id, lab_test_id) do update set price_bs = excluded.price_bs, updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.admin_set_tariff_prices(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_tariff_prices(uuid, jsonb, boolean) to service_role;

-- ── Storage: fotos de órdenes (privado; subida con URL firmada creada por el servidor) ─
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quote-photos', 'quote-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
