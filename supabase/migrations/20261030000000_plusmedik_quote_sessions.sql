-- PlusMedik V2 G4.0: sesiones de cotización conversacional. Migración ADITIVA y posterior a 20261029000000 (guarda de respuestas): tablas y funciones nuevas; no modifica ni
-- borra nada anterior. Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio.
-- Orden: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> esta.
--
-- ───────────────────────── Qué resuelve ─────────────────────────
-- Hoy cada foto se cotiza sola. Un paciente real manda varias fotos y texto («y también glucosa»). Una SESIÓN agrupa lo que un contacto va enviando (fotos y estudios escritos) y
-- solo se cotiza cuando el paciente declara que terminó («listo»). La sesión no hace análisis ni conoce precios: guarda, por turno, QUÉ ESTUDIOS (lab_tests.id) se identificaron
-- y con qué certeza. Los precios los pone el cliente al cerrar, con el catálogo recargado en ese momento, y la base verifica que lo cotizado sea EXACTAMENTE lo identificado.
--
-- ───────────────────────── Garantías ─────────────────────────
--   · Todo se escribe con owner + fence (lease vigente) bajo el bloqueo del contacto (contacto -> corrida): una ejecución antigua que revive no escribe; dos turnos no se pisan.
--   · Un ítem por turno (unique por corrida): un mensaje entregado dos veces o una ejecución que reclama el lease de otra no duplica estudios.
--   · Una foto repetida en la misma sesión (mismo hash del archivo) se marca DUPLICATE antes de analizarla (no se gasta un análisis más ni se cuenta dos veces).
--   · No se cotiza una sesión con ítems en proceso, ambiguos, sin resolver, inciertos o ilegibles: close(QUOTED) los rechaza (PT409). Lo cotizado debe ser EXACTAMENTE la unión de los
--     estudios identificados (ni uno más ni uno menos), con precios positivos cuya suma coincide con el total: la base nunca acepta un estudio que no salió de un ítem.
--   · No se cierra mientras haya un turno ANTERIOR del contacto aún en proceso (el paciente escribió «listo» justo después de una foto que todavía se analiza): responde 'pending'.
--   · Cerrar es idempotente por corrida: una ejecución que reclama el turno repite exactamente el mismo resultado (replay) sin volver a decidir.
--   · Los ítems de turnos POSTERIORES al que cierra pasan a una sesión nueva; lo que no se cotizó por ilegible no se arrastra.
--   · La sesión caduca (EXPIRED) sin cotizar nada: nunca se cotiza solo por paso del tiempo.
--   · Los casos inciertos quedan en una COLA DE REVISIÓN (plusmedik_quote_reviews, estado PENDING) para el futuro flujo humano: solo códigos y referencias. Nadie la consume todavía.
--   · Sin texto del paciente, sin teléfonos. Solo ids de estudios del catálogo, contadores, códigos y el hash de cada foto.
--
-- ───────────────────────── Límites ─────────────────────────
--   · La base no puede verificar contra lab_tests (tabla del CRM, ausente aquí): la verificación de existencia y precio vigentes la hace el cliente al cerrar y queda registrada
--     (huella del catálogo). Entre esa carga y el envío el precio puede cambiar unos segundos.
--   · Cerrar no garantiza que el paciente reciba el mensaje (puede pausarse el contacto entre ambos): queda el resultado en plusmedik_quote_results y el estado del envío en la corrida.

-- ───────────────────────── tablas ─────────────────────────
create table if not exists public.plusmedik_quote_sessions (
  id uuid primary key default gen_random_uuid(),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  status text not null default 'OPEN' check (status in ('OPEN', 'QUOTED', 'NEEDS_REVIEW', 'NEEDS_RESEND', 'CANCELLED', 'EXPIRED')),
  created_at timestamptz not null default clock_timestamp(),
  last_activity_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  closed_by_run uuid references public.plusmedik_audit_runs(id),
  closed_seq bigint,
  reasons text[] not null default '{}',
  check ((status = 'OPEN') = (closed_at is null and closed_by_run is null)),
  check (status not in ('QUOTED', 'NEEDS_REVIEW', 'NEEDS_RESEND', 'CANCELLED') or closed_by_run is not null),
  check (reasons <@ array['AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'STUDY_UNAVAILABLE', 'PRICE_INVALID'])
);
create unique index if not exists plusmedik_quote_sessions_one_open_idx on public.plusmedik_quote_sessions (contact_key) where status = 'OPEN';
create unique index if not exists plusmedik_quote_sessions_closed_by_idx on public.plusmedik_quote_sessions (closed_by_run) where closed_by_run is not null;
create index if not exists plusmedik_quote_sessions_contact_idx on public.plusmedik_quote_sessions (contact_key, created_at desc);

create table if not exists public.plusmedik_quote_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.plusmedik_quote_sessions(id),
  run_id uuid not null unique references public.plusmedik_audit_runs(id),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  seq bigint not null check (seq >= 1),
  kind text not null check (kind in ('IMAGE', 'TEXT')),
  status text not null check (status in ('PROCESSING', 'RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'UNCERTAIN', 'UNREADABLE', 'DUPLICATE')),
  image_hash text check (image_hash is null or image_hash ~ '^[0-9a-f]{64}$'),
  study_ids uuid[] not null default '{}' check (cardinality(study_ids) <= 60),
  ambiguous jsonb not null default '[]' check (jsonb_typeof(ambiguous) = 'array' and jsonb_array_length(ambiguous) <= 20 and pg_column_size(ambiguous) < 4000),
  unresolved_count integer not null default 0 check (unresolved_count between 0 and 50),
  reasons text[] not null default '{}' check (reasons <@ array['AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'UNSUPPORTED_IMAGE']),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check (kind = 'IMAGE' or image_hash is null),
  check ((status = 'PROCESSING') = (finished_at is null))
);
create index if not exists plusmedik_quote_items_session_idx on public.plusmedik_quote_items (session_id, seq);
create index if not exists plusmedik_quote_items_contact_idx on public.plusmedik_quote_items (contact_key, seq desc);

create table if not exists public.plusmedik_quote_results (
  session_id uuid primary key references public.plusmedik_quote_sessions(id),
  run_id uuid not null references public.plusmedik_audit_runs(id),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 60),
  total_bs numeric(12, 2) not null check (total_bs > 0),
  catalog_fingerprint text not null check (catalog_fingerprint ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.plusmedik_quote_reviews (
  session_id uuid primary key references public.plusmedik_quote_sessions(id),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  run_id uuid not null references public.plusmedik_audit_runs(id),
  reasons text[] not null check (cardinality(reasons) between 1 and 8 and reasons <@ array['AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'STUDY_UNAVAILABLE', 'PRICE_INVALID']),
  item_ids uuid[] not null,
  status text not null default 'PENDING' check (status = 'PENDING'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists plusmedik_quote_reviews_pending_idx on public.plusmedik_quote_reviews (created_at) where status = 'PENDING';

alter table public.plusmedik_quote_sessions enable row level security;
alter table public.plusmedik_quote_items enable row level security;
alter table public.plusmedik_quote_results enable row level security;
alter table public.plusmedik_quote_reviews enable row level security;
revoke all on table public.plusmedik_quote_sessions, public.plusmedik_quote_items, public.plusmedik_quote_results, public.plusmedik_quote_reviews from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_quote_sessions, public.plusmedik_quote_items, public.plusmedik_quote_results, public.plusmedik_quote_reviews from service_role;
grant select on table public.plusmedik_quote_sessions, public.plusmedik_quote_items, public.plusmedik_quote_results, public.plusmedik_quote_reviews to service_role;

comment on table public.plusmedik_quote_sessions is 'Sesión de cotización de un contacto: agrupa fotos y estudios escritos hasta que el paciente dice «listo». Sin texto ni teléfonos.';
comment on table public.plusmedik_quote_items is 'Lo identificado por cada mensaje de una sesión (ids del catálogo y certeza). Sin texto del paciente; solo el hash de la foto.';
comment on table public.plusmedik_quote_results is 'Qué se cotizó (estudios, precios, total y huella del catálogo) al cerrar una sesión. Inmutable.';
comment on table public.plusmedik_quote_reviews is 'Cola para el futuro flujo de revisión humana: sesiones con casos inciertos. Nadie la consume todavía.';

-- Guardas de integridad: nada se borra; los ítems solo salen de PROCESSING una vez o cambian de sesión; la sesión solo pasa de OPEN a un estado final.
create or replace function public.plusmedik_quote_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.run_id <> old.run_id or new.contact_key <> old.contact_key or new.seq <> old.seq or new.kind <> old.kind or new.created_at <> old.created_at
     or new.image_hash is distinct from old.image_hash then
    raise exception 'plusmedik_quote: item identity is immutable' using errcode = 'PT409';
  end if;
  if new.status <> old.status or new.study_ids is distinct from old.study_ids or new.ambiguous is distinct from old.ambiguous
     or new.unresolved_count <> old.unresolved_count or new.reasons is distinct from old.reasons or new.finished_at is distinct from old.finished_at then
    if old.status <> 'PROCESSING' then
      raise exception 'plusmedik_quote: a finished item is immutable' using errcode = 'PT409';
    end if;
  end if;
  return new;
end $$;

create or replace function public.plusmedik_quote_sessions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.contact_key <> old.contact_key or new.created_at <> old.created_at then
    raise exception 'plusmedik_quote: session identity is immutable' using errcode = 'PT409';
  end if;
  if old.status <> 'OPEN' then
    raise exception 'plusmedik_quote: a closed session is immutable' using errcode = 'PT409';
  end if;
  return new;
end $$;

create or replace trigger plusmedik_quote_items_guard before update on public.plusmedik_quote_items for each row execute function public.plusmedik_quote_items_guard();
create or replace trigger plusmedik_quote_items_no_delete before delete on public.plusmedik_quote_items for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_items_no_truncate before truncate on public.plusmedik_quote_items for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_sessions_guard before update on public.plusmedik_quote_sessions for each row execute function public.plusmedik_quote_sessions_guard();
create or replace trigger plusmedik_quote_sessions_no_delete before delete on public.plusmedik_quote_sessions for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_sessions_no_truncate before truncate on public.plusmedik_quote_sessions for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_results_immutable before update or delete on public.plusmedik_quote_results for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_results_no_truncate before truncate on public.plusmedik_quote_results for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_reviews_immutable before update or delete on public.plusmedik_quote_reviews for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_quote_reviews_no_truncate before truncate on public.plusmedik_quote_reviews for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── validación del resultado de un ítem ─────────────────────────
-- {status: RESOLVED|AMBIGUOUS|UNRESOLVED|UNCERTAIN|UNREADABLE, studyIds:[uuid], ambiguous:[[uuid]], unresolved:int, reasons:[código]}
-- Coherencia: RESOLVED = con estudios y nada dudoso; AMBIGUOUS = con grupos ambiguos y sin sin-resolver; UNRESOLVED = con fragmentos sin resolver; UNCERTAIN/UNREADABLE = con motivo.
create or replace function public.plusmedik_quote_result_valid(p jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_status text;
  v_ids jsonb;
  v_amb jsonb;
  v_unres integer;
  v_reasons jsonb;
  g jsonb;
  x jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  if not public.plusmedik_audit_keys_within(p, array['status', 'studyIds', 'ambiguous', 'unresolved', 'reasons']) or not (p ?& array['status', 'studyIds', 'ambiguous', 'unresolved', 'reasons']) then
    return false;
  end if;
  if jsonb_typeof(p -> 'status') <> 'string' or jsonb_typeof(p -> 'studyIds') <> 'array' or jsonb_typeof(p -> 'ambiguous') <> 'array'
     or jsonb_typeof(p -> 'unresolved') <> 'number' or jsonb_typeof(p -> 'reasons') <> 'array' then
    return false;
  end if;
  v_status := p ->> 'status';
  v_ids := p -> 'studyIds';
  v_amb := p -> 'ambiguous';
  v_reasons := p -> 'reasons';
  if (p ->> 'unresolved') !~ '^[0-9]{1,2}$' then
    return false;
  end if;
  v_unres := (p ->> 'unresolved')::integer;
  if v_status not in ('RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'UNCERTAIN', 'UNREADABLE') or jsonb_array_length(v_ids) > 60 or jsonb_array_length(v_amb) > 20 or v_unres > 50 or jsonb_array_length(v_reasons) > 6 then
    return false;
  end if;
  for x in select * from jsonb_array_elements(v_ids) loop
    if jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return false;
    end if;
  end loop;
  for g in select * from jsonb_array_elements(v_amb) loop
    if jsonb_typeof(g) <> 'array' or jsonb_array_length(g) not between 2 and 8 then
      return false;
    end if;
    for x in select * from jsonb_array_elements(g) loop
      if jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        return false;
      end if;
    end loop;
  end loop;
  for x in select * from jsonb_array_elements(v_reasons) loop
    if jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'UNSUPPORTED_IMAGE') then
      return false;
    end if;
  end loop;
  if v_status = 'RESOLVED' then
    return jsonb_array_length(v_ids) >= 1 and jsonb_array_length(v_amb) = 0 and v_unres = 0 and jsonb_array_length(v_reasons) = 0;
  elsif v_status = 'AMBIGUOUS' then
    return jsonb_array_length(v_amb) >= 1 and v_unres = 0;
  elsif v_status = 'UNRESOLVED' then
    return v_unres >= 1;
  elsif v_status = 'UNCERTAIN' then
    return jsonb_array_length(v_reasons) >= 1;
  end if;
  return jsonb_array_length(v_ids) = 0 and jsonb_array_length(v_amb) = 0 and v_unres = 0 and jsonb_array_length(v_reasons) >= 1;
end $$;

create or replace function public.plusmedik_quote_reasons_of(p jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array(select jsonb_array_elements_text(p -> 'reasons')), '{}'::text[])
$$;

create or replace function public.plusmedik_quote_ids_of(p jsonb)
returns uuid[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array(select u from (select distinct (e)::uuid as u from jsonb_array_elements_text(p -> 'studyIds') e) q order by u), '{}'::uuid[])
$$;

-- ¿Hay un turno ANTERIOR del contacto que todavía no terminó (y por tanto puede aportar un ítem)?
create or replace function public.plusmedik_quote_pending_before(p_contact text, p_seq bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id
  where t.contact_key = p_contact and t.seq < p_seq and r.processing_status in ('PROCESSING', 'ANALYZED')
$$;

-- ───────────────────────── 1. alta de un ítem ─────────────────────────
-- Resultados: created | exists (la corrida ya tenía ítem: reintento/ejecución que reclama el lease) | duplicate (foto repetida en la sesión) | full (tope de ítems).
-- p_result nulo = ítem EN PROCESO (foto que aún se analiza; se completa con plusmedik_quote_item_finish). Con p_result el ítem nace terminado (texto, foto ilegible).
create or replace function public.plusmedik_quote_item_begin(p_run_id uuid, p_owner text, p_fence bigint, p_kind text, p_image_hash text, p_result jsonb, p_ttl_seconds integer, p_max_items integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_run public.plusmedik_audit_runs%rowtype;
  v_item public.plusmedik_quote_items%rowtype;
  v_session public.plusmedik_quote_sessions%rowtype;
  v_status text;
  v_count integer;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('IMAGE', 'TEXT') or p_ttl_seconds is null or p_ttl_seconds not between 60 and 86400 or p_max_items is null or p_max_items not between 1 and 50
     or (p_image_hash is not null and (p_kind <> 'IMAGE' or p_image_hash !~ '^[0-9a-f]{64}$'))
     or (p_result is not null and not public.plusmedik_quote_result_valid(p_result)) then
    raise exception 'plusmedik_quote: invalid item' using errcode = 'PT422';
  end if;
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);

  select * into v_item from public.plusmedik_quote_items where run_id = p_run_id;
  if found then
    select count(*)::integer into v_count from public.plusmedik_quote_items where session_id = v_item.session_id and status <> 'DUPLICATE' and seq <= v_item.seq;
    return jsonb_build_object('status', 'exists', 'itemId', v_item.id, 'sessionId', v_item.session_id, 'itemStatus', v_item.status, 'position', v_count, 'studyIds', to_jsonb(v_item.study_ids),
      'unresolved', v_item.unresolved_count, 'ambiguousGroups', jsonb_array_length(v_item.ambiguous));
  end if;

  -- Una sesión vencida se cierra sin cotizar nada.
  update public.plusmedik_quote_sessions set status = 'EXPIRED', closed_at = clock_timestamp() where contact_key = v_contact and status = 'OPEN' and expires_at <= clock_timestamp();
  select * into v_session from public.plusmedik_quote_sessions where contact_key = v_contact and status = 'OPEN';
  if not found then
    insert into public.plusmedik_quote_sessions (contact_key, expires_at) values (v_contact, clock_timestamp() + make_interval(secs => p_ttl_seconds)) returning * into v_session;
  end if;

  select count(*)::integer into v_count from public.plusmedik_quote_items where session_id = v_session.id and status <> 'DUPLICATE';
  if v_count >= p_max_items then
    return jsonb_build_object('status', 'full', 'sessionId', v_session.id, 'count', v_count);
  end if;

  if p_image_hash is not null and exists (select 1 from public.plusmedik_quote_items i where i.session_id = v_session.id and i.image_hash = p_image_hash and i.status not in ('UNREADABLE', 'DUPLICATE')) then
    v_status := 'DUPLICATE';
  elsif p_result is null then
    v_status := 'PROCESSING';
  else
    v_status := p_result ->> 'status';
  end if;

  insert into public.plusmedik_quote_items (session_id, run_id, contact_key, seq, kind, status, image_hash, study_ids, ambiguous, unresolved_count, reasons, finished_at)
  values (v_session.id, p_run_id, v_contact, v_seq, p_kind, v_status, p_image_hash,
          case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then '{}'::uuid[] else public.plusmedik_quote_ids_of(p_result) end,
          case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then '[]'::jsonb else p_result -> 'ambiguous' end,
          case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then 0 else (p_result ->> 'unresolved')::integer end,
          case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then '{}'::text[] else public.plusmedik_quote_reasons_of(p_result) end,
          case when v_status = 'PROCESSING' then null else clock_timestamp() end)
  returning id into v_id;
  update public.plusmedik_quote_sessions set last_activity_at = clock_timestamp(), expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds) where id = v_session.id;

  select count(*)::integer into v_count from public.plusmedik_quote_items where session_id = v_session.id and status <> 'DUPLICATE' and seq <= v_seq;
  return jsonb_build_object('status', case when v_status = 'DUPLICATE' then 'duplicate' else 'created' end, 'itemId', v_id, 'sessionId', v_session.id, 'itemStatus', v_status, 'position', v_count,
    'studyIds', case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then '[]'::jsonb else to_jsonb(public.plusmedik_quote_ids_of(p_result)) end,
    'unresolved', case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then 0 else (p_result ->> 'unresolved')::integer end,
    'ambiguousGroups', case when v_status in ('PROCESSING', 'DUPLICATE') or p_result is null then 0 else jsonb_array_length(p_result -> 'ambiguous') end);
end $$;

-- ───────────────────────── 2. resultado de una foto ─────────────────────────
create or replace function public.plusmedik_quote_item_finish(p_run_id uuid, p_owner text, p_fence bigint, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_item public.plusmedik_quote_items%rowtype;
begin
  if p_result is null or not public.plusmedik_quote_result_valid(p_result) then
    raise exception 'plusmedik_quote: invalid item result' using errcode = 'PT422';
  end if;
  select contact_key into v_contact from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  select * into v_item from public.plusmedik_quote_items where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: item not found' using errcode = 'PT404';
  end if;
  if v_item.status <> 'PROCESSING' then
    if v_item.status = p_result ->> 'status' and v_item.study_ids = public.plusmedik_quote_ids_of(p_result) and v_item.ambiguous = p_result -> 'ambiguous'
       and v_item.unresolved_count = (p_result ->> 'unresolved')::integer and v_item.reasons = public.plusmedik_quote_reasons_of(p_result) then
      return jsonb_build_object('status', 'already_finished', 'itemStatus', v_item.status);
    end if;
    raise exception 'plusmedik_quote: item already finished with a different result' using errcode = 'PT409';
  end if;
  update public.plusmedik_quote_items set status = p_result ->> 'status', study_ids = public.plusmedik_quote_ids_of(p_result), ambiguous = p_result -> 'ambiguous',
    unresolved_count = (p_result ->> 'unresolved')::integer, reasons = public.plusmedik_quote_reasons_of(p_result), finished_at = clock_timestamp()
  where id = v_item.id;
  return jsonb_build_object('status', 'finished', 'itemStatus', p_result ->> 'status');
end $$;

-- ───────────────────────── 3. lectura para cerrar ─────────────────────────
-- state: none (sin sesión abierta con ítems anteriores a este turno) | pending (aún hay turnos anteriores en proceso: esperar) | ready (con los ítems) | replay (esta corrida
-- ya cerró una sesión: se repite el mismo resultado). Un ítem EN PROCESO cuya corrida ya terminó se informa como UNREADABLE (el análisis se perdió).
create or replace function public.plusmedik_quote_session_read(p_run_id uuid, p_owner text, p_fence bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_closed public.plusmedik_quote_sessions%rowtype;
  v_session public.plusmedik_quote_sessions%rowtype;
  v_pending integer;
  v_items jsonb;
  v_result public.plusmedik_quote_results%rowtype;
begin
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);

  select * into v_closed from public.plusmedik_quote_sessions where closed_by_run = p_run_id;
  if found then
    select * into v_result from public.plusmedik_quote_results where session_id = v_closed.id;
    return jsonb_build_object('state', 'replay', 'sessionId', v_closed.id, 'outcome', v_closed.status, 'reasons', to_jsonb(v_closed.reasons),
      'lines', v_result.lines, 'totalBs', v_result.total_bs);
  end if;

  update public.plusmedik_quote_sessions set status = 'EXPIRED', closed_at = clock_timestamp() where contact_key = v_contact and status = 'OPEN' and expires_at <= clock_timestamp();
  select * into v_session from public.plusmedik_quote_sessions where contact_key = v_contact and status = 'OPEN';
  if not found then
    return jsonb_build_object('state', 'none');
  end if;
  v_pending := public.plusmedik_quote_pending_before(v_contact, v_seq);
  if v_pending > 0 then
    return jsonb_build_object('state', 'pending', 'pending', v_pending);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'seq', i.seq, 'kind', i.kind, 'studyIds', to_jsonb(i.study_ids), 'ambiguous', i.ambiguous, 'unresolved', i.unresolved_count, 'reasons', to_jsonb(i.reasons),
    'status', case when i.status = 'PROCESSING' then 'UNREADABLE' else i.status end) order by i.seq), '[]'::jsonb) into v_items
  from public.plusmedik_quote_items i where i.session_id = v_session.id and i.seq < v_seq;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('state', 'none');
  end if;
  return jsonb_build_object('state', 'ready', 'sessionId', v_session.id, 'items', v_items);
end $$;

-- ───────────────────────── 4. cierre ─────────────────────────
-- p_outcome: QUOTED (p_lines + p_total) | NEEDS_REVIEW (p_reasons) | NEEDS_RESEND | CANCELLED. Resultados: closed | replayed | pending | not_open.
-- PT409 si el resultado pedido no es coherente con los ítems (cotizar con dudas, cotizar algo que ningún ítem identificó, total que no suma...).
create or replace function public.plusmedik_quote_session_close(p_run_id uuid, p_owner text, p_fence bigint, p_session_id uuid, p_outcome text, p_lines jsonb, p_total numeric, p_reasons text[], p_catalog_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_session public.plusmedik_quote_sessions%rowtype;
  v_prior public.plusmedik_quote_sessions%rowtype;
  v_new_id uuid;
  v_resolved uuid[];
  v_line_ids uuid[];
  v_bad integer;
  v_unreadable integer;
  v_uncertain integer;
  v_sum numeric;
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('QUOTED', 'NEEDS_REVIEW', 'NEEDS_RESEND', 'CANCELLED') or p_session_id is null
     or (p_outcome = 'QUOTED' and (p_lines is null or p_total is null or p_catalog_fingerprint is null or p_catalog_fingerprint !~ '^[A-Za-z0-9_.:-]{1,80}$'))
     or (p_outcome = 'NEEDS_REVIEW' and (p_reasons is null or cardinality(p_reasons) not between 1 and 8))
     or (p_reasons is not null and not (p_reasons <@ array['AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'STUDY_UNAVAILABLE', 'PRICE_INVALID'])) then
    raise exception 'plusmedik_quote: invalid close' using errcode = 'PT422';
  end if;
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);

  select * into v_prior from public.plusmedik_quote_sessions where closed_by_run = p_run_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'sessionId', v_prior.id, 'outcome', v_prior.status);
  end if;
  select * into v_session from public.plusmedik_quote_sessions where id = p_session_id and contact_key = v_contact for update;
  if not found or v_session.status <> 'OPEN' then
    return jsonb_build_object('status', 'not_open');
  end if;
  if public.plusmedik_quote_pending_before(v_contact, v_seq) > 0 then
    return jsonb_build_object('status', 'pending');
  end if;

  select count(*) filter (where i.status in ('UNREADABLE', 'PROCESSING')),
         count(*) filter (where i.status in ('AMBIGUOUS', 'UNRESOLVED', 'UNCERTAIN')),
                  coalesce(array_agg(distinct s) filter (where i.status = 'RESOLVED'), '{}'::uuid[])
    into v_unreadable, v_uncertain, v_resolved
  from public.plusmedik_quote_items i left join lateral unnest(i.study_ids) s on true
  where i.session_id = v_session.id and i.seq < v_seq;

  if p_outcome = 'QUOTED' then
    if v_unreadable > 0 or v_uncertain > 0 or cardinality(v_resolved) = 0 then
      raise exception 'plusmedik_quote: session is not quotable' using errcode = 'PT409';
    end if;
    if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 60 then
      raise exception 'plusmedik_quote: invalid lines' using errcode = 'PT422';
    end if;
    -- las claves del JSON son studyId / name / priceBs
    select count(*) filter (where l."studyId" is null or l."priceBs" is null or l."priceBs" <= 0 or l.name is null or length(l.name) not between 1 and 200 or l.name ~ '[[:cntrl:]]'),
           coalesce(array_agg(l."studyId"), '{}'::uuid[]), coalesce(sum(l."priceBs"), 0)
      into v_bad, v_line_ids, v_sum
    from jsonb_to_recordset(p_lines) as l("studyId" uuid, name text, "priceBs" numeric);
    if v_bad > 0 or cardinality(v_line_ids) <> (select count(distinct x) from unnest(v_line_ids) x)
       or not (v_line_ids <@ v_resolved and v_resolved <@ v_line_ids) or v_sum <> p_total then
      raise exception 'plusmedik_quote: quote does not match the identified studies' using errcode = 'PT409';
    end if;
  elsif p_outcome = 'NEEDS_REVIEW' then
    if v_unreadable > 0 or (v_uncertain = 0 and not (p_reasons && array['STUDY_UNAVAILABLE', 'PRICE_INVALID'])) then
      raise exception 'plusmedik_quote: review without cause' using errcode = 'PT409';
    end if;
  elsif p_outcome = 'NEEDS_RESEND' then
    if v_unreadable = 0 then
      raise exception 'plusmedik_quote: nothing to resend' using errcode = 'PT409';
    end if;
  end if;

  v_status := p_outcome;
  update public.plusmedik_quote_sessions set status = v_status, closed_at = clock_timestamp(), closed_by_run = p_run_id, closed_seq = v_seq,
    reasons = coalesce(p_reasons, '{}'::text[]) where id = v_session.id;

  if p_outcome = 'QUOTED' then
    insert into public.plusmedik_quote_results (session_id, run_id, lines, total_bs, catalog_fingerprint) values (v_session.id, p_run_id, p_lines, p_total, p_catalog_fingerprint);
  elsif p_outcome = 'NEEDS_REVIEW' then
    insert into public.plusmedik_quote_reviews (session_id, contact_key, run_id, reasons, item_ids)
    values (v_session.id, v_contact, p_run_id, p_reasons, (select coalesce(array_agg(id), '{}'::uuid[]) from public.plusmedik_quote_items where session_id = v_session.id and seq < v_seq));
  end if;

  -- Lo que queda para seguir (turnos posteriores; y, si se pidió reenviar, lo legible) pasa a una sesión nueva.
  if exists (select 1 from public.plusmedik_quote_items i where i.session_id = v_session.id and (i.seq > v_seq or (p_outcome = 'NEEDS_RESEND' and i.seq < v_seq and i.status not in ('UNREADABLE', 'PROCESSING', 'DUPLICATE')))) then
    insert into public.plusmedik_quote_sessions (contact_key, expires_at) values (v_contact, greatest(v_session.expires_at, clock_timestamp() + interval '60 seconds')) returning id into v_new_id;
    update public.plusmedik_quote_items set session_id = v_new_id
    where session_id = v_session.id and (seq > v_seq or (p_outcome = 'NEEDS_RESEND' and seq < v_seq and status not in ('UNREADABLE', 'PROCESSING', 'DUPLICATE')));
  end if;
  return jsonb_build_object('status', 'closed', 'sessionId', v_session.id, 'outcome', v_status, 'carriedTo', v_new_id);
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_quote_items_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_quote_sessions_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_quote_result_valid(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_reasons_of(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_ids_of(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_pending_before(text, bigint) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_item_begin(uuid, text, bigint, text, text, jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_item_finish(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_session_read(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text) from public, anon, authenticated;
grant execute on function public.plusmedik_quote_item_begin(uuid, text, bigint, text, text, jsonb, integer, integer) to service_role;
grant execute on function public.plusmedik_quote_item_finish(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.plusmedik_quote_session_read(uuid, text, bigint) to service_role;
grant execute on function public.plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text) to service_role;

comment on function public.plusmedik_quote_item_begin(uuid, text, bigint, text, text, jsonb, integer, integer) is 'Agrega a la sesión abierta del contacto lo identificado por un turno (idempotente por corrida; detecta fotos repetidas). Con owner + fence. Solo service_role.';
comment on function public.plusmedik_quote_item_finish(uuid, text, bigint, jsonb) is 'Completa el ítem de una foto en proceso. Idempotente. Con owner + fence. Solo service_role.';
comment on function public.plusmedik_quote_session_read(uuid, text, bigint) is 'Estado de la sesión para cerrarla: none | pending | ready | replay. Con owner + fence. Solo service_role.';
comment on function public.plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text) is 'Cierra la sesión (QUOTED, NEEDS_REVIEW, NEEDS_RESEND, CANCELLED) verificando que lo cotizado sea exactamente lo identificado. Idempotente por corrida. Solo service_role.';
