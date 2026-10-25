-- PlusMedik V2 G4.1: datos APROBADOS por estudio para el paciente (tipo de muestra y requisitos especiales, plazo de entrega). Migración ADITIVA y posterior a 20261030000000
-- (sesiones de cotización): tablas y funciones nuevas; no modifica ni borra nada anterior. Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio.
-- Orden: 1 -> ... -> 11 -> esta.
--
-- ───────────────────────── Qué resuelve ─────────────────────────
-- La auditoría de G4.1 encontró que lab_tests solo trae (id, code, name, normalized_name, price_bs, active, category, sample_type) y que ninguna columna nombra un plazo de entrega ni
-- requisitos especiales; sample_type es un dato operativo del catálogo que nadie aprobó para decírselo a un paciente. La preparación y el ayuno ya existen aprobados en G3
-- (STUDY_PREPARATION). Aquí se agregan los dos datos que faltan, con EL MISMO GOBIERNO que G3 (borrador -> pendiente -> aprobado -> inactivo, cuatro ojos, caducidad obligatoria, la IA
-- jamás aprueba) y SIN duplicar el catálogo: cada registro se refiere a lab_tests.id y solo guarda lo que el catálogo no tiene.
--   · SAMPLE      (CLÍNICO)         tipo de muestra y requisitos especiales de la toma; «sin requisitos» es una afirmación explícita, nunca la ausencia de dato.
--   · TURNAROUND  (ADMINISTRATIVO)  plazo de entrega en HORAS o en DÍAS (hábiles o calendario), desde la toma o desde la recepción de la muestra. Cada estudio tiene su unidad: no se convierte.
-- No se guarda ningún precio. No se siembra ningún dato.
--
-- ───────────────────────── Garantías ─────────────────────────
--   · Una versión aprobada y una abierta por (estudio, tipo); la aprobación exige un segundo humano (el que decide no creó, editó ni envió); un rol clínico para SAMPLE y uno administrativo
--     para TURNAROUND; una IA solo puede redactar borradores administrativos (misma función de verificación de actores de G3).
--   · Aprobar exige que el estudio exista y esté ACTIVO en lab_tests (solo lectura); sin catálogo no se aprueba.
--   · Cada cambio de lo aprobado sube la MISMA revisión que G3 (plusmedik_kb_bump), así que la caché de los lectores se invalida igual.
--   · Bitácora inmutable de cada acción; contenido con lista blanca y sin importes.
--   · Trazabilidad: qué versiones de estos datos respaldaron la respuesta de cada turno (plusmedik_turn_fact_refs), registrada ANTES de reservar el envío con owner + fence, igual que G3.1A;
--     y la consulta de impacto inversa (plusmedik_facts_usage).
--   · plusmedik_quote_last_studies: los estudios de la ÚLTIMA cotización entregada al contacto (solo ids, sin precios), con antigüedad máxima, para responder «¿y cuándo estarán?» sin que el
--     paciente repita los nombres. Lectura con owner + fence.
--
-- ───────────────────────── Límites ─────────────────────────
--   · La base no valida que un plazo sea realista: solo que esté aprobado, vigente y bien formado. La verdad la pone el laboratorio al aprobar.
--   · La última cotización se identifica por tiempo; si el paciente pregunta por otra cosa, el texto manda (el cliente prefiere los estudios que nombra el mensaje).

-- ───────────────────────── tablas ─────────────────────────
create table if not exists public.plusmedik_study_facts (
  id uuid primary key default gen_random_uuid(),
  lab_test_id uuid not null,
  fact_kind text not null check (fact_kind in ('SAMPLE', 'TURNAROUND')),
  classification text generated always as (case when fact_kind = 'SAMPLE' then 'CLINICAL' else 'ADMINISTRATIVE' end) stored,
  version integer not null check (version >= 1),
  status text not null check (status in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'INACTIVE')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_ref text check (source_ref is null or source_ref ~ '^[A-Za-z0-9_.:/#-]{1,120}$'),
  valid_from timestamptz,
  valid_until timestamptz,
  created_by text not null check (created_by ~ '^[A-Za-z0-9_.:@-]{1,80}$'),
  created_by_type text not null check (created_by_type in ('HUMAN', 'AI')),
  submitted_by text,
  submitted_at timestamptz,
  approved_by text,
  approved_role text,
  approved_at timestamptz,
  inactivated_by text,
  inactivated_at timestamptz,
  inactive_reason text check (inactive_reason is null or inactive_reason ~ '^[A-Z0-9_]{1,40}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lab_test_id, fact_kind, version),
  check (status <> 'APPROVED' or (approved_by is not null and approved_at is not null and valid_until is not null and valid_from is not null)),
  check (valid_from is null or valid_until is null or valid_from < valid_until)
);
create unique index if not exists plusmedik_study_facts_one_approved_idx on public.plusmedik_study_facts (lab_test_id, fact_kind) where status = 'APPROVED';
create unique index if not exists plusmedik_study_facts_one_open_idx on public.plusmedik_study_facts (lab_test_id, fact_kind) where status in ('DRAFT', 'PENDING_APPROVAL');
create index if not exists plusmedik_study_facts_status_idx on public.plusmedik_study_facts (status, updated_at desc);

create table if not exists public.plusmedik_study_fact_events (
  id uuid primary key default gen_random_uuid(),
  fact_id uuid not null references public.plusmedik_study_facts(id),
  event text not null check (event in ('CREATED', 'EDITED', 'SUBMITTED', 'REJECTED', 'APPROVED', 'SUPERSEDED', 'DEACTIVATED')),
  actor_id text not null check (actor_id ~ '^[A-Za-z0-9_.:@-]{1,80}$'),
  actor_type text not null check (actor_type in ('HUMAN', 'AI', 'SYSTEM')),
  actor_role text not null check (actor_role ~ '^[A-Z_]{1,30}$'),
  from_status text,
  to_status text not null,
  reason text check (reason is null or reason ~ '^[A-Z0-9_]{1,40}$'),
  content_hash text not null,
  at timestamptz not null default clock_timestamp()
);
create index if not exists plusmedik_study_fact_events_fact_idx on public.plusmedik_study_fact_events (fact_id, at);

-- Qué datos aprobados respaldaron la respuesta de un turno. Sin texto del paciente ni de la respuesta.
create table if not exists public.plusmedik_turn_fact_refs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.plusmedik_audit_runs(id),
  lease_fence bigint not null check (lease_fence >= 1),
  fact_kind text not null check (fact_kind in ('SAMPLE', 'TURNAROUND')),
  lab_test_id uuid not null,
  version integer not null check (version >= 1),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (run_id, lease_fence, fact_kind, lab_test_id)
);
create index if not exists plusmedik_turn_fact_refs_usage_idx on public.plusmedik_turn_fact_refs (fact_kind, lab_test_id, version);
create index if not exists plusmedik_turn_fact_refs_run_idx on public.plusmedik_turn_fact_refs (run_id);

alter table public.plusmedik_study_facts enable row level security;
alter table public.plusmedik_study_fact_events enable row level security;
alter table public.plusmedik_turn_fact_refs enable row level security;
revoke all on table public.plusmedik_study_facts, public.plusmedik_study_fact_events, public.plusmedik_turn_fact_refs from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_study_facts, public.plusmedik_study_fact_events, public.plusmedik_turn_fact_refs from service_role;
grant select on table public.plusmedik_study_facts, public.plusmedik_study_fact_events, public.plusmedik_turn_fact_refs to service_role;

comment on table public.plusmedik_study_facts is 'Datos aprobados por estudio para el paciente (tipo de muestra/requisitos y plazo de entrega). Solo APPROVED y vigente se usa para responder. Sin datos sembrados ni precios.';
comment on table public.plusmedik_study_fact_events is 'Bitácora inmutable de acciones sobre los datos por estudio. Sin texto libre.';
comment on table public.plusmedik_turn_fact_refs is 'Qué versiones de datos por estudio respaldaron la respuesta de cada turno. Inmutable.';

-- ───────────────────────── integridad ─────────────────────────
create or replace function public.plusmedik_study_facts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.lab_test_id <> old.lab_test_id or new.fact_kind <> old.fact_kind or new.version <> old.version or new.created_at <> old.created_at
     or new.created_by <> old.created_by or new.created_by_type <> old.created_by_type then
    raise exception 'plusmedik_facts: identity is immutable' using errcode = 'PT409';
  end if;
  if old.status = 'INACTIVE' then
    raise exception 'plusmedik_facts: an inactive version is immutable' using errcode = 'PT409';
  end if;
  if old.status = 'APPROVED' and (new.status <> 'INACTIVE' or new.payload <> old.payload or new.content_hash <> old.content_hash or new.valid_until is distinct from old.valid_until or new.valid_from is distinct from old.valid_from) then
    raise exception 'plusmedik_facts: an approved version can only be deactivated' using errcode = 'PT409';
  end if;
  if old.status = 'PENDING_APPROVAL' and (new.payload <> old.payload or new.content_hash <> old.content_hash) then
    raise exception 'plusmedik_facts: a submitted version cannot change its content' using errcode = 'PT409';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger plusmedik_study_facts_guard before update on public.plusmedik_study_facts for each row execute function public.plusmedik_study_facts_guard();
create or replace trigger plusmedik_study_facts_no_delete before delete on public.plusmedik_study_facts for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_study_facts_no_truncate before truncate on public.plusmedik_study_facts for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_study_fact_events_immutable before update or delete on public.plusmedik_study_fact_events for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_study_fact_events_no_truncate before truncate on public.plusmedik_study_fact_events for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_turn_fact_refs_immutable before update or delete on public.plusmedik_turn_fact_refs for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_turn_fact_refs_no_truncate before truncate on public.plusmedik_turn_fact_refs for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── estructura del contenido ─────────────────────────
create or replace function public.plusmedik_study_fact_int(p jsonb, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case when p is not null and jsonb_typeof(p) = 'number' and (p #>> '{}') ~ '^[0-9]{1,4}$' then (p #>> '{}')::integer between p_min and p_max else false end
$$;

-- Lista blanca por tipo. Devuelve false ante cualquier desvío (los mensajes de error nunca incluyen valores).
create or replace function public.plusmedik_study_fact_payload_ok(p_kind text, p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  e jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or p_kind is null then
    return false;
  end if;
  if not (p ? 'labTestId') or jsonb_typeof(p -> 'labTestId') <> 'string' or (p ->> 'labTestId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if p_kind = 'SAMPLE' then
    if not public.plusmedik_audit_keys_within(p, array['labTestId', 'sampleType', 'requirementsState', 'requirements']) or not (p ?& array['sampleType', 'requirementsState']) then
      return false;
    end if;
    if jsonb_typeof(p -> 'sampleType') <> 'string' or length(p ->> 'sampleType') > 80 or not public.plusmedik_kb_text_ok(p ->> 'sampleType') then
      return false;
    end if;
    if jsonb_typeof(p -> 'requirementsState') <> 'string' or (p ->> 'requirementsState') not in ('HAS_REQUIREMENTS', 'NO_SPECIAL_REQUIREMENTS') then
      return false;
    end if;
    if (p ->> 'requirementsState') = 'NO_SPECIAL_REQUIREMENTS' then
      -- «Sin requisitos especiales» es una afirmación explícita y exclusiva: no admite una lista.
      return not (p ? 'requirements');
    end if;
    if not (p ? 'requirements') or jsonb_typeof(p -> 'requirements') <> 'array' or jsonb_array_length(p -> 'requirements') not between 1 and 6 then
      return false;
    end if;
    for e in select * from jsonb_array_elements(p -> 'requirements') loop
      if jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 200 or not public.plusmedik_kb_text_ok(e #>> '{}') then
        return false;
      end if;
    end loop;
    return true;
  elsif p_kind = 'TURNAROUND' then
    if not public.plusmedik_audit_keys_within(p, array['labTestId', 'unit', 'min', 'max', 'dayType', 'countedFrom', 'note']) or not (p ?& array['unit', 'max', 'countedFrom']) then
      return false;
    end if;
    if jsonb_typeof(p -> 'unit') <> 'string' or (p ->> 'unit') not in ('HOURS', 'DAYS') then
      return false;
    end if;
    if jsonb_typeof(p -> 'countedFrom') <> 'string' or (p ->> 'countedFrom') not in ('SAMPLE_COLLECTION', 'SAMPLE_RECEIPT') then
      return false;
    end if;
    if (p ->> 'unit') = 'HOURS' then
      -- Horas: 1 a 720 (30 días); no admite tipo de día.
      if p ? 'dayType' or not public.plusmedik_study_fact_int(p -> 'max', 1, 720) or (p ? 'min' and not public.plusmedik_study_fact_int(p -> 'min', 1, 719)) then
        return false;
      end if;
    else
      -- Días: 1 a 60, y debe decir si son hábiles o calendario (decirlo mal cambia lo que el paciente entiende).
      if not (p ? 'dayType') or jsonb_typeof(p -> 'dayType') <> 'string' or (p ->> 'dayType') not in ('BUSINESS', 'CALENDAR')
         or not public.plusmedik_study_fact_int(p -> 'max', 1, 60) or (p ? 'min' and not public.plusmedik_study_fact_int(p -> 'min', 1, 59)) then
        return false;
      end if;
    end if;
    if p ? 'min' and (p ->> 'min')::integer >= (p ->> 'max')::integer then
      return false;
    end if;
    if p ? 'note' and (jsonb_typeof(p -> 'note') <> 'string' or length(p ->> 'note') > 200 or not public.plusmedik_kb_text_ok(p ->> 'note')) then
      return false;
    end if;
    return true;
  end if;
  return false;
end $$;

-- ───────────────────────── administración (la usa el CRM / un script; el agente NO) ─────────────────────────
create or replace function public.plusmedik_study_fact_create_draft(
  p_kind text, p_lab_test_id uuid, p_payload jsonb, p_actor_id text, p_actor_type text, p_actor_role text, p_source_ref text default null, p_valid_from timestamptz default null, p_valid_until timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
  v_id uuid;
  v_hash text;
begin
  if p_kind is null or p_kind not in ('SAMPLE', 'TURNAROUND') or p_lab_test_id is null or not public.plusmedik_study_fact_payload_ok(p_kind, p_payload)
     or (p_payload ->> 'labTestId') <> p_lab_test_id::text or (p_source_ref is not null and p_source_ref !~ '^[A-Za-z0-9_.:/#-]{1,120}$') then
    raise exception 'plusmedik_facts: invalid draft' using errcode = 'PT422';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, case when p_kind = 'SAMPLE' then 'CLINICAL' else 'ADMINISTRATIVE' end, 'DRAFT');
  if p_valid_from is not null and p_valid_until is not null and p_valid_from >= p_valid_until then
    raise exception 'plusmedik_facts: invalid validity' using errcode = 'PT422';
  end if;
  -- Serializa los borradores del mismo (estudio, tipo).
  perform pg_advisory_xact_lock(hashtextextended(p_lab_test_id::text || ':' || p_kind, 0));
  if exists (select 1 from public.plusmedik_study_facts where lab_test_id = p_lab_test_id and fact_kind = p_kind and status in ('DRAFT', 'PENDING_APPROVAL')) then
    raise exception 'plusmedik_facts: the element already has an open version' using errcode = 'PT409';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.plusmedik_study_facts where lab_test_id = p_lab_test_id and fact_kind = p_kind;
  v_hash := public.plusmedik_kb_hash(p_payload);
  insert into public.plusmedik_study_facts (lab_test_id, fact_kind, version, status, payload, content_hash, source_ref, valid_from, valid_until, created_by, created_by_type)
  values (p_lab_test_id, p_kind, v_version, 'DRAFT', p_payload, v_hash, p_source_ref, p_valid_from, p_valid_until, p_actor_id, p_actor_type) returning id into v_id;
  insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (v_id, 'CREATED', p_actor_id, p_actor_type, p_actor_role, null, 'DRAFT', v_hash);
  return jsonb_build_object('status', 'created', 'fact_id', v_id, 'version', v_version);
end $$;

create or replace function public.plusmedik_study_fact_edit_draft(
  p_fact_id uuid, p_payload jsonb, p_actor_id text, p_actor_type text, p_actor_role text, p_source_ref text default null, p_valid_from timestamptz default null, p_valid_until timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.plusmedik_study_facts%rowtype;
  v_hash text;
begin
  select * into v_fact from public.plusmedik_study_facts where id = p_fact_id for update;
  if not found then
    raise exception 'plusmedik_facts: version not found' using errcode = 'PT404';
  end if;
  if not public.plusmedik_study_fact_payload_ok(v_fact.fact_kind, p_payload) or (p_payload ->> 'labTestId') <> v_fact.lab_test_id::text
     or (p_source_ref is not null and p_source_ref !~ '^[A-Za-z0-9_.:/#-]{1,120}$') or (p_valid_from is not null and p_valid_until is not null and p_valid_from >= p_valid_until) then
    raise exception 'plusmedik_facts: invalid draft' using errcode = 'PT422';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_fact.classification, 'DRAFT');
  -- Una IA solo edita borradores creados por una IA.
  if p_actor_type = 'AI' and v_fact.created_by_type <> 'AI' then
    raise exception 'plusmedik_facts: an AI actor cannot edit a human draft' using errcode = 'PT403';
  end if;
  if v_fact.status <> 'DRAFT' then
    raise exception 'plusmedik_facts: only a draft can be edited' using errcode = 'PT409';
  end if;
  v_hash := public.plusmedik_kb_hash(p_payload);
  update public.plusmedik_study_facts set payload = p_payload, content_hash = v_hash, source_ref = p_source_ref, valid_from = p_valid_from, valid_until = p_valid_until where id = p_fact_id;
  insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (p_fact_id, 'EDITED', p_actor_id, p_actor_type, p_actor_role, 'DRAFT', 'DRAFT', v_hash);
  return jsonb_build_object('status', 'edited');
end $$;

create or replace function public.plusmedik_study_fact_submit(p_fact_id uuid, p_actor_id text, p_actor_type text, p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.plusmedik_study_facts%rowtype;
begin
  select * into v_fact from public.plusmedik_study_facts where id = p_fact_id for update;
  if not found then
    raise exception 'plusmedik_facts: version not found' using errcode = 'PT404';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_fact.classification, 'SUBMIT');
  if v_fact.status = 'PENDING_APPROVAL' then
    return jsonb_build_object('status', 'already_submitted');
  end if;
  if v_fact.status <> 'DRAFT' then
    raise exception 'plusmedik_facts: only a draft can be submitted' using errcode = 'PT409';
  end if;
  if v_fact.valid_until is null or not public.plusmedik_study_fact_payload_ok(v_fact.fact_kind, v_fact.payload) then
    raise exception 'plusmedik_facts: draft is incomplete' using errcode = 'PT422';
  end if;
  update public.plusmedik_study_facts set status = 'PENDING_APPROVAL', submitted_by = p_actor_id, submitted_at = now() where id = p_fact_id;
  insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (p_fact_id, 'SUBMITTED', p_actor_id, p_actor_type, p_actor_role, 'DRAFT', 'PENDING_APPROVAL', v_fact.content_hash);
  return jsonb_build_object('status', 'submitted');
end $$;

-- Cuatro ojos: el que decide no puede haber creado, editado ni enviado la versión.
create or replace function public.plusmedik_study_fact_assert_not_author(p_fact_id uuid, p_actor_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.plusmedik_study_fact_events where fact_id = p_fact_id and event in ('CREATED', 'EDITED', 'SUBMITTED') and actor_id = p_actor_id) then
    raise exception 'plusmedik_facts: the author of a version cannot decide on it' using errcode = 'PT403';
  end if;
end $$;

create or replace function public.plusmedik_study_fact_reject(p_fact_id uuid, p_actor_id text, p_actor_type text, p_actor_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.plusmedik_study_facts%rowtype;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_]{1,40}$' then
    raise exception 'plusmedik_facts: invalid reason' using errcode = 'PT422';
  end if;
  select * into v_fact from public.plusmedik_study_facts where id = p_fact_id for update;
  if not found then
    raise exception 'plusmedik_facts: version not found' using errcode = 'PT404';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_fact.classification, 'DECIDE');
  if v_fact.status <> 'PENDING_APPROVAL' then
    raise exception 'plusmedik_facts: only a pending version can be rejected' using errcode = 'PT409';
  end if;
  perform public.plusmedik_study_fact_assert_not_author(p_fact_id, p_actor_id);
  update public.plusmedik_study_facts set status = 'DRAFT', submitted_by = null, submitted_at = null where id = p_fact_id;
  insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
  values (p_fact_id, 'REJECTED', p_actor_id, p_actor_type, p_actor_role, 'PENDING_APPROVAL', 'DRAFT', p_reason, v_fact.content_hash);
  return jsonb_build_object('status', 'rejected');
end $$;

-- Aprueba. Reemplaza la versión aprobada anterior y sube la revisión (la de G3), todo en la misma transacción.
create or replace function public.plusmedik_study_fact_approve(p_fact_id uuid, p_actor_id text, p_actor_type text, p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.plusmedik_study_facts%rowtype;
  v_prev public.plusmedik_study_facts%rowtype;
  v_from timestamptz;
  v_revision bigint;
begin
  select * into v_fact from public.plusmedik_study_facts where id = p_fact_id for update;
  if not found then
    raise exception 'plusmedik_facts: version not found' using errcode = 'PT404';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_fact.classification, 'DECIDE');
  if v_fact.status = 'APPROVED' and v_fact.approved_by = p_actor_id then
    return jsonb_build_object('status', 'already_approved');
  end if;
  if v_fact.status <> 'PENDING_APPROVAL' then
    raise exception 'plusmedik_facts: only a pending version can be approved' using errcode = 'PT409';
  end if;
  perform public.plusmedik_study_fact_assert_not_author(p_fact_id, p_actor_id);
  v_from := coalesce(v_fact.valid_from, now());
  if v_fact.valid_until is null or v_fact.valid_until <= now() or v_fact.valid_until > now() + interval '400 days' or v_from >= v_fact.valid_until
     or not public.plusmedik_study_fact_payload_ok(v_fact.fact_kind, v_fact.payload) then
    raise exception 'plusmedik_facts: invalid validity or content' using errcode = 'PT422';
  end if;
  -- El estudio debe existir y estar activo en el catálogo real (solo lectura). Sin catálogo no se aprueba. (Dos pasos: si la tabla no existe, la consulta ni se planifica.)
  if to_regclass('public.lab_tests') is null then
    raise exception 'plusmedik_facts: unknown or inactive study' using errcode = 'PT422';
  end if;
  if not exists (select 1 from public.lab_tests where id = v_fact.lab_test_id and active) then
    raise exception 'plusmedik_facts: unknown or inactive study' using errcode = 'PT422';
  end if;

  select * into v_prev from public.plusmedik_study_facts where lab_test_id = v_fact.lab_test_id and fact_kind = v_fact.fact_kind and status = 'APPROVED' for update;
  if found then
    update public.plusmedik_study_facts set status = 'INACTIVE', inactivated_by = p_actor_id, inactivated_at = now(), inactive_reason = 'SUPERSEDED' where id = v_prev.id;
    insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
    values (v_prev.id, 'SUPERSEDED', p_actor_id, p_actor_type, p_actor_role, 'APPROVED', 'INACTIVE', 'SUPERSEDED', v_prev.content_hash);
  end if;
  update public.plusmedik_study_facts set status = 'APPROVED', valid_from = v_from, approved_by = p_actor_id, approved_role = p_actor_role, approved_at = now() where id = p_fact_id;
  insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (p_fact_id, 'APPROVED', p_actor_id, p_actor_type, p_actor_role, 'PENDING_APPROVAL', 'APPROVED', v_fact.content_hash);
  v_revision := public.plusmedik_kb_bump();
  return jsonb_build_object('status', 'approved', 'revision', v_revision);
end $$;

-- Retira un dato aprobado (deja de usarse de inmediato en cuanto los lectores ven la nueva revisión).
create or replace function public.plusmedik_study_fact_deactivate(p_fact_id uuid, p_actor_id text, p_actor_type text, p_actor_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact public.plusmedik_study_facts%rowtype;
  v_revision bigint;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_]{1,40}$' then
    raise exception 'plusmedik_facts: invalid reason' using errcode = 'PT422';
  end if;
  select * into v_fact from public.plusmedik_study_facts where id = p_fact_id for update;
  if not found then
    raise exception 'plusmedik_facts: version not found' using errcode = 'PT404';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_fact.classification, 'DECIDE');
  if v_fact.status = 'INACTIVE' then
    return jsonb_build_object('status', 'already_inactive');
  end if;
  if v_fact.status <> 'APPROVED' then
    raise exception 'plusmedik_facts: only an approved version can be deactivated' using errcode = 'PT409';
  end if;
  update public.plusmedik_study_facts set status = 'INACTIVE', inactivated_by = p_actor_id, inactivated_at = now(), inactive_reason = p_reason where id = p_fact_id;
  insert into public.plusmedik_study_fact_events (fact_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
  values (p_fact_id, 'DEACTIVATED', p_actor_id, p_actor_type, p_actor_role, 'APPROVED', 'INACTIVE', p_reason, v_fact.content_hash);
  v_revision := public.plusmedik_kb_bump();
  return jsonb_build_object('status', 'deactivated', 'revision', v_revision);
end $$;

-- ───────────────────────── lectura para el agente ─────────────────────────
-- Todo lo aprobado (incluso vencido: el lector evalúa la caducidad al usarlo) y la revisión, de una misma foto.
create or replace function public.plusmedik_study_facts_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  select revision into v_revision from public.plusmedik_kb_state where id;
  return jsonb_build_object('revision', coalesce(v_revision, 0), 'items', coalesce((
    select jsonb_agg(jsonb_build_object('kind', f.fact_kind, 'labTestId', f.lab_test_id, 'classification', f.classification, 'version', f.version, 'versionId', f.id, 'payload', f.payload,
      'validFrom', f.valid_from, 'validUntil', f.valid_until, 'approvedAt', f.approved_at, 'approvedBy', f.approved_by, 'contentHash', f.content_hash) order by f.lab_test_id, f.fact_kind)
    from public.plusmedik_study_facts f where f.status = 'APPROVED'), '[]'::jsonb));
end $$;

create or replace function public.plusmedik_study_facts_list(p_status text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (p_status is not null and p_status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'INACTIVE')) or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'plusmedik_facts: invalid list query' using errcode = 'PT422';
  end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(row_to_json(x)::jsonb) from (
    select f.id as "factId", f.fact_kind as kind, f.lab_test_id as "labTestId", f.version, f.status, f.classification, f.valid_until as "validUntil", f.updated_at as "updatedAt"
    from public.plusmedik_study_facts f where p_status is null or f.status = p_status order by f.updated_at desc, f.id limit p_limit) x), '[]'::jsonb));
end $$;

-- ───────────────────────── trazabilidad ─────────────────────────
-- p_refs: [{kind, labTestId, version, contentHash}] (1..20, sin claves extra). 'closed' si el envío ya se reservó o el turno se cerró. Idempotente.
create or replace function public.plusmedik_turn_record_facts(p_run_id uuid, p_owner text, p_fence bigint, p_refs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  e jsonb;
  v_count integer;
begin
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' or jsonb_array_length(p_refs) not between 1 and 20 then
    raise exception 'plusmedik_facts: invalid references' using errcode = 'PT422';
  end if;
  for e in select * from jsonb_array_elements(p_refs) loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'plusmedik_facts: invalid references' using errcode = 'PT422';
    end if;
    if not (public.plusmedik_audit_keys_within(e, array['kind', 'labTestId', 'version', 'contentHash']) and e ?& array['kind', 'labTestId', 'version', 'contentHash']
        and jsonb_typeof(e -> 'kind') = 'string' and (e ->> 'kind') in ('SAMPLE', 'TURNAROUND')
        and jsonb_typeof(e -> 'labTestId') = 'string' and (e ->> 'labTestId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and jsonb_typeof(e -> 'version') = 'number' and (e ->> 'version') ~ '^[1-9][0-9]{0,8}$'
        and jsonb_typeof(e -> 'contentHash') = 'string' and (e ->> 'contentHash') ~ '^[0-9a-f]{64}$') then
      raise exception 'plusmedik_facts: invalid references' using errcode = 'PT422';
    end if;
  end loop;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if not exists (select 1 from public.plusmedik_turns where run_id = p_run_id) then
    raise exception 'plusmedik_facts: turn not found' using errcode = 'PT404';
  end if;
  if v_run.send_state <> 'NOT_RESERVED' or v_run.processing_status not in ('PROCESSING', 'ANALYZED') then
    return jsonb_build_object('status', 'closed');
  end if;
  insert into public.plusmedik_turn_fact_refs (run_id, lease_fence, fact_kind, lab_test_id, version, content_hash)
  select p_run_id, p_fence, r ->> 'kind', (r ->> 'labTestId')::uuid, (r ->> 'version')::integer, r ->> 'contentHash' from jsonb_array_elements(p_refs) as r
  on conflict (run_id, lease_fence, fact_kind, lab_test_id) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'recorded', 'count', v_count);
end $$;

-- Impacto: ¿a qué turnos (seudónimos) se les dio un dato respaldado por esta versión? Solo cuenta intentos cuyo envío llegó a reservarse.
create or replace function public.plusmedik_facts_usage(p_kind text, p_lab_test_id uuid, p_version integer default null, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('SAMPLE', 'TURNAROUND') or p_lab_test_id is null or (p_version is not null and p_version < 1) or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'plusmedik_facts: invalid usage query' using errcode = 'PT422';
  end if;
  return jsonb_build_object('uses', coalesce((
    select jsonb_agg(row_to_json(x)::jsonb) from (
      select r.id as "runId", r.contact_key as "contactKey", f.version, f.recorded_at as "recordedAt", r.send_state as "sendState", r.reply_state as "replyState"
      from public.plusmedik_turn_fact_refs f join public.plusmedik_audit_runs r on r.id = f.run_id
      where f.fact_kind = p_kind and f.lab_test_id = p_lab_test_id and (p_version is null or f.version = p_version) and f.lease_fence = r.lease_fence
        and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN')
      order by f.recorded_at desc, f.id limit p_limit) x), '[]'::jsonb));
end $$;

-- ───────────────────────── vínculo con las cotizaciones (G4.0) ─────────────────────────
-- Los estudios de la ÚLTIMA cotización entregada al contacto del turno, si es más nueva que p_max_age_seconds. Solo ids (nunca precios).
create or replace function public.plusmedik_quote_last_studies(p_run_id uuid, p_owner text, p_fence bigint, p_max_age_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_result public.plusmedik_quote_results%rowtype;
begin
  if p_max_age_seconds is null or p_max_age_seconds not between 60 and 604800 then
    raise exception 'plusmedik_quote: invalid age' using errcode = 'PT422';
  end if;
  select contact_key into v_contact from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  select q.* into v_result from public.plusmedik_quote_results q join public.plusmedik_quote_sessions s on s.id = q.session_id
  where s.contact_key = v_contact and s.status = 'QUOTED' and q.created_at > clock_timestamp() - make_interval(secs => p_max_age_seconds)
  order by q.created_at desc limit 1;
  if not found then
    return jsonb_build_object('studyIds', '[]'::jsonb);
  end if;
  return jsonb_build_object('studyIds', (select coalesce(jsonb_agg(distinct (l ->> 'studyId')), '[]'::jsonb) from jsonb_array_elements(v_result.lines) l), 'quotedAt', v_result.created_at);
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_study_facts_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_int(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_payload_ok(text, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_assert_not_author(uuid, text) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_create_draft(text, uuid, jsonb, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_edit_draft(uuid, jsonb, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_submit(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_reject(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_approve(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_study_fact_deactivate(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_study_facts_snapshot() from public, anon, authenticated;
revoke all on function public.plusmedik_study_facts_list(text, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_turn_record_facts(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_facts_usage(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_last_studies(uuid, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_study_fact_create_draft(text, uuid, jsonb, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.plusmedik_study_fact_edit_draft(uuid, jsonb, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.plusmedik_study_fact_submit(uuid, text, text, text) to service_role;
grant execute on function public.plusmedik_study_fact_reject(uuid, text, text, text, text) to service_role;
grant execute on function public.plusmedik_study_fact_approve(uuid, text, text, text) to service_role;
grant execute on function public.plusmedik_study_fact_deactivate(uuid, text, text, text, text) to service_role;
grant execute on function public.plusmedik_study_facts_snapshot() to service_role;
grant execute on function public.plusmedik_study_facts_list(text, integer) to service_role;
grant execute on function public.plusmedik_turn_record_facts(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.plusmedik_facts_usage(text, uuid, integer, integer) to service_role;
grant execute on function public.plusmedik_quote_last_studies(uuid, text, bigint, integer) to service_role;

comment on function public.plusmedik_study_fact_approve(uuid, text, text, text) is 'Aprueba un dato por estudio (cuatro ojos, rol por clasificación, estudio activo en lab_tests) y sube la revisión de G3. Solo service_role.';
comment on function public.plusmedik_turn_record_facts(uuid, text, bigint, jsonb) is 'Registra, antes de reservar el envío y con owner + fence, qué versiones de datos por estudio respaldan la respuesta. Idempotente. Solo service_role.';
comment on function public.plusmedik_quote_last_studies(uuid, text, bigint, integer) is 'Ids de los estudios de la última cotización entregada al contacto del turno (sin precios), con antigüedad máxima. Con owner + fence. Solo service_role.';
