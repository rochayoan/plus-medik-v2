-- PlusMedik V2 G3.0: base de conocimiento del laboratorio (sucursales, horarios, políticas, métodos de pago, preguntas frecuentes y preparación de estudios).
-- Migración ADITIVA y posterior a 20261026000000 (turnos recuperables): crea tablas y funciones nuevas; no modifica ni borra nada anterior. Solo define esquema local:
-- NO se aplica a ningún Supabase remoto desde el repositorio. Orden: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> esta.
--
-- ───────────────────────── NO CONTIENE DATOS ─────────────────────────
-- Ninguna fila de conocimiento: ni horarios, ni políticas, ni preparaciones. Todo dato debe entrar como borrador, ser enviado y APROBADO por una persona autorizada del
-- laboratorio. Una consulta sin versión aprobada y vigente no tiene respuesta (el servicio devuelve "conocimiento no disponible"; nunca se inventa).
--
-- ───────────────────────── Modelo ─────────────────────────
-- plusmedik_kb_documents  elemento lógico estable: (kind, key). La clasificación se DERIVA del tipo y no se puede elegir:
--                          ADMINISTRATIVE = BRANCH, SCHEDULE, POLICY, PAYMENT_METHOD, FAQ · CLINICAL = STUDY_PREPARATION (indicaciones de preparación de un estudio).
-- plusmedik_kb_versions   versiones inmutables del contenido. Estados: DRAFT -> PENDING_APPROVAL -> APPROVED -> INACTIVE. Como máximo UNA versión aprobada y UNA abierta
--                          (borrador o pendiente) por elemento. Solo APPROVED y vigente (valid_from <= ahora < valid_until) se usa para responder.
-- plusmedik_kb_events     bitácora inmutable de cada acción (quién, con qué rol, cuándo, de qué estado a cuál, motivo codificado, hash del contenido).
-- plusmedik_kb_state      contador de revisión: sube en la MISMA transacción que cualquier cambio de lo aprobado (aprobar, desactivar, restaurar). Es la señal para
--                          invalidar cachés: la instantánea devuelve revisión y contenido en una sola sentencia (misma foto de la base).
--
-- ───────────────────────── Quién puede qué (se aplica AQUÍ, no en el cliente) ─────────────────────────
-- El llamador (hoy service_role; mañana el servidor del CRM) declara quién actúa: p_actor_id (seudónimo, p. ej. crm:<uuid>), p_actor_type (HUMAN | AI) y p_actor_role.
-- La base no autentica a las personas (eso es del CRM); sí hace cumplir las reglas:
--   · Una IA (AI) solo puede crear y editar BORRADORES ADMINISTRATIVOS que ella misma creó, con el rol AI_DRAFTER. NO puede enviar, aprobar, rechazar, desactivar ni
--     restaurar nada, ni tocar contenido CLÍNICO.
--   · Enviar a aprobación: una persona (HUMAN) con rol EDITOR, ADMIN_APPROVER o CLINICAL_APPROVER.
--   · Aprobar / rechazar / restaurar / desactivar: una persona con el rol APROBADOR de la clasificación (ADMIN_APPROVER para lo administrativo, CLINICAL_APPROVER para la
--     preparación de estudios). Un aprobador administrativo no puede aprobar preparación clínica.
--   · CUATRO OJOS: quien aprueba o rechaza no puede ser quien creó, editó o envió esa versión.
-- Límite: quien tenga la credencial de service_role puede declarar cualquier actor; la defensa es que el CRM sea el único que la use para administrar, que el agente
-- en ejecución NUNCA llame a las funciones de administración (una prueba lo verifica en el código) y la bitácora inmutable.
--
-- ───────────────────────── Caducidad ─────────────────────────
-- Toda versión aprobada exige valid_until (máximo 400 días desde la aprobación). Vencida, deja de responder aunque siga APPROVED. No hay renovación automática: se
-- crea una versión nueva y se aprueba de nuevo.
--
-- ───────────────────────── Catálogo ─────────────────────────
-- La preparación de un estudio se vincula por el identificador lab_tests.id (referencia lógica, SIN clave foránea, como exige el contrato con el CRM). Al aprobar se
-- comprueba que el estudio existe y está activo (solo lectura). No se guarda ningún precio ni se duplica el catálogo; un contenido que mencione un importe se rechaza.
--
-- ───────────────────────── Límites ─────────────────────────
-- · La instantánea trae todo lo aprobado en una llamada (cientos de filas a lo sumo con preparación por estudio); si crece, se pagina en otra migración.
-- · La clave del documento de preparación es 'study:<uuid>': si un estudio se desactiva en el catálogo, su preparación aprobada sigue existiendo (el servicio lo marca
--   como estudio inactivo y no la entrega).
-- · Aprobar exige un segundo humano: un laboratorio con una sola persona autorizada no podrá aprobar lo que redactó (decisión del laboratorio, documentada).

-- ───────────────────────── tablas ─────────────────────────
create table if not exists public.plusmedik_kb_state (
  id boolean primary key default true check (id),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.plusmedik_kb_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('BRANCH', 'SCHEDULE', 'POLICY', 'PAYMENT_METHOD', 'FAQ', 'STUDY_PREPARATION')),
  key text not null check (key ~ '^[a-z0-9][a-z0-9_.:-]{0,95}$'),
  classification text generated always as (case when kind = 'STUDY_PREPARATION' then 'CLINICAL' else 'ADMINISTRATIVE' end) stored,
  created_at timestamptz not null default now(),
  unique (kind, key)
);

create table if not exists public.plusmedik_kb_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.plusmedik_kb_documents(id),
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
  unique (document_id, version),
  check (status <> 'APPROVED' or (approved_by is not null and approved_at is not null and valid_until is not null and valid_from is not null)),
  check (valid_from is null or valid_until is null or valid_from < valid_until)
);

create unique index if not exists plusmedik_kb_one_approved_idx on public.plusmedik_kb_versions (document_id) where status = 'APPROVED';
create unique index if not exists plusmedik_kb_one_open_idx on public.plusmedik_kb_versions (document_id) where status in ('DRAFT', 'PENDING_APPROVAL');
create index if not exists plusmedik_kb_versions_status_idx on public.plusmedik_kb_versions (status, updated_at desc);

create table if not exists public.plusmedik_kb_events (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.plusmedik_kb_versions(id),
  document_id uuid not null references public.plusmedik_kb_documents(id),
  event text not null check (event in ('CREATED', 'EDITED', 'SUBMITTED', 'REJECTED', 'APPROVED', 'SUPERSEDED', 'DEACTIVATED', 'RESTORED')),
  actor_id text not null check (actor_id ~ '^[A-Za-z0-9_.:@-]{1,80}$'),
  actor_type text not null check (actor_type in ('HUMAN', 'AI', 'SYSTEM')),
  actor_role text not null check (actor_role ~ '^[A-Z_]{1,30}$'),
  from_status text,
  to_status text not null,
  reason text check (reason is null or reason ~ '^[A-Z0-9_]{1,40}$'),
  content_hash text not null,
  at timestamptz not null default clock_timestamp()
);
create index if not exists plusmedik_kb_events_version_idx on public.plusmedik_kb_events (version_id, at);
create index if not exists plusmedik_kb_events_document_idx on public.plusmedik_kb_events (document_id, at);

alter table public.plusmedik_kb_state enable row level security;
alter table public.plusmedik_kb_documents enable row level security;
alter table public.plusmedik_kb_versions enable row level security;
alter table public.plusmedik_kb_events enable row level security;
revoke all on table public.plusmedik_kb_state, public.plusmedik_kb_documents, public.plusmedik_kb_versions, public.plusmedik_kb_events from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_kb_state, public.plusmedik_kb_documents, public.plusmedik_kb_versions, public.plusmedik_kb_events from service_role;
grant select on table public.plusmedik_kb_state, public.plusmedik_kb_documents, public.plusmedik_kb_versions, public.plusmedik_kb_events to service_role;

comment on table public.plusmedik_kb_versions is 'Versiones del conocimiento del laboratorio. Solo APPROVED y vigente se usa para responder. Sin datos sembrados.';
comment on table public.plusmedik_kb_events is 'Bitácora inmutable de acciones sobre el conocimiento. Actores seudónimos; motivos codificados; sin texto libre.';

-- ───────────────────────── inmutabilidad ─────────────────────────
create or replace function public.plusmedik_kb_versions_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'plusmedik_kb: % on % is not allowed (knowledge history is immutable)', tg_op, tg_table_name using errcode = 'PT409';
  end if;
  if (new.id, new.document_id, new.version, new.created_by, new.created_by_type, new.created_at)
     is distinct from (old.id, old.document_id, old.version, old.created_by, old.created_by_type, old.created_at) then
    raise exception 'plusmedik_kb: version identity is immutable' using errcode = 'PT409';
  end if;
  -- El contenido solo cambia mientras es borrador.
  if old.status <> 'DRAFT' and (new.payload, new.content_hash, new.source_ref, new.valid_until)
     is distinct from (old.payload, old.content_hash, old.source_ref, old.valid_until) then
    raise exception 'plusmedik_kb: content is immutable once submitted' using errcode = 'PT409';
  end if;
  -- valid_from solo puede fijarse (si estaba vacío) en el instante de la aprobación.
  if old.status <> 'DRAFT' and new.valid_from is distinct from old.valid_from
     and not (old.status = 'PENDING_APPROVAL' and new.status = 'APPROVED' and old.valid_from is null) then
    raise exception 'plusmedik_kb: content is immutable once submitted' using errcode = 'PT409';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'DRAFT' and new.status = 'PENDING_APPROVAL')
    or (old.status = 'PENDING_APPROVAL' and new.status in ('DRAFT', 'APPROVED'))
    or (old.status = 'APPROVED' and new.status = 'INACTIVE')
    or (old.status = 'INACTIVE' and new.status = 'APPROVED')) then
    raise exception 'plusmedik_kb: invalid status transition' using errcode = 'PT409';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger plusmedik_kb_versions_guard before update or delete on public.plusmedik_kb_versions
  for each row execute function public.plusmedik_kb_versions_guard();
create or replace trigger plusmedik_kb_versions_no_truncate before truncate on public.plusmedik_kb_versions
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_kb_documents_immutable before update or delete on public.plusmedik_kb_documents
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_kb_documents_no_truncate before truncate on public.plusmedik_kb_documents
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_kb_events_immutable before update or delete on public.plusmedik_kb_events
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_kb_events_no_truncate before truncate on public.plusmedik_kb_events
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_kb_state_no_delete before delete on public.plusmedik_kb_state
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_kb_state_no_truncate before truncate on public.plusmedik_kb_state
  for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── validación del contenido ─────────────────────────
-- Un texto no puede mencionar un importe: los precios salen SOLO del catálogo (lab_tests.price_bs). Cubre "Bs 45", "45 Bs", "$ 10", "10 USD", "45 bolivianos".
create or replace function public.plusmedik_kb_text_ok(t text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select t is not null and length(btrim(t)) between 1 and 2000
     and t !~* '(\m(bs|bob|usd|us\$|bolivianos?|d[oó]lar(es)?)\.?\s*\d|\$\s*\d|\d\s*(bs|bob|usd|bolivianos?|d[oó]lar(es)?)\M)';
$$;

create or replace function public.plusmedik_kb_hhmm_ok(t text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
$$;

-- Estructura por tipo: claves permitidas (lista blanca), obligatorias y tipos. Devuelve false ante cualquier desvío; los mensajes de error nunca incluyen valores.
create or replace function public.plusmedik_kb_payload_ok(p_kind text, p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  e jsonb;
  k text;
  s text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 12000 then
    return false;
  end if;
  -- todo valor de texto de primer nivel cumple la regla de texto (sin importes)
  for k, e in select * from jsonb_each(p) loop
    if jsonb_typeof(e) = 'string' and not public.plusmedik_kb_text_ok(e #>> '{}') then
      return false;
    end if;
  end loop;

  if p_kind = 'BRANCH' then
    return public.plusmedik_audit_keys_within(p, array['name', 'address', 'mapsUrl', 'phone', 'notes'])
       and p ?& array['name', 'address'] and jsonb_typeof(p -> 'name') = 'string' and jsonb_typeof(p -> 'address') = 'string'
       and (not p ? 'mapsUrl' or (jsonb_typeof(p -> 'mapsUrl') = 'string' and (p ->> 'mapsUrl') ~ '^https://\S{1,255}$'))
       and (not p ? 'phone' or (jsonb_typeof(p -> 'phone') = 'string' and (p ->> 'phone') ~ '^[+0-9 ()-]{5,30}$'))
       and (not p ? 'notes' or jsonb_typeof(p -> 'notes') = 'string');
  elsif p_kind = 'SCHEDULE' then
    if not (public.plusmedik_audit_keys_within(p, array['branchKey', 'service', 'weekly', 'exceptions', 'timezone', 'notes'])
        and p ?& array['branchKey', 'service', 'weekly', 'timezone']
        and jsonb_typeof(p -> 'branchKey') = 'string' and (p ->> 'branchKey') ~ '^[a-z0-9][a-z0-9_.:-]{0,95}$'
        and jsonb_typeof(p -> 'service') = 'string' and (p ->> 'service') in ('OFFICE', 'SAMPLE_COLLECTION', 'RESULTS_PICKUP', 'HOME_SAMPLING', 'HUMAN_SUPPORT')
        and jsonb_typeof(p -> 'timezone') = 'string' and (p ->> 'timezone') ~ '^[A-Za-z]+(/[A-Za-z_]+){1,2}$'
        and jsonb_typeof(p -> 'weekly') = 'array' and jsonb_array_length(p -> 'weekly') between 1 and 28
        and (not p ? 'exceptions' or (jsonb_typeof(p -> 'exceptions') = 'array' and jsonb_array_length(p -> 'exceptions') <= 400))
        and (not p ? 'notes' or jsonb_typeof(p -> 'notes') = 'string')) then
      return false;
    end if;
    for e in select * from jsonb_array_elements(p -> 'weekly') loop
      if not (jsonb_typeof(e) = 'object' and public.plusmedik_audit_keys_within(e, array['day', 'opens', 'closes']) and e ?& array['day', 'opens', 'closes']
          and jsonb_typeof(e -> 'day') = 'number' and (e ->> 'day') ~ '^[0-6]$'
          and jsonb_typeof(e -> 'opens') = 'string' and public.plusmedik_kb_hhmm_ok(e ->> 'opens')
          and jsonb_typeof(e -> 'closes') = 'string' and public.plusmedik_kb_hhmm_ok(e ->> 'closes')
          and (e ->> 'opens') < (e ->> 'closes')) then
        return false;
      end if;
    end loop;
    if p ? 'exceptions' then
      for e in select * from jsonb_array_elements(p -> 'exceptions') loop
        if not (jsonb_typeof(e) = 'object' and public.plusmedik_audit_keys_within(e, array['date', 'closed', 'opens', 'closes', 'note'])
            and e ?& array['date', 'closed']
            and jsonb_typeof(e -> 'date') = 'string' and (e ->> 'date') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
            and jsonb_typeof(e -> 'closed') = 'boolean'
            and (not e ? 'note' or (jsonb_typeof(e -> 'note') = 'string' and public.plusmedik_kb_text_ok(e ->> 'note')))) then
          return false;
        end if;
        if (e -> 'closed') = 'false'::jsonb then
          if not (e ?& array['opens', 'closes'] and jsonb_typeof(e -> 'opens') = 'string' and jsonb_typeof(e -> 'closes') = 'string'
              and public.plusmedik_kb_hhmm_ok(e ->> 'opens') and public.plusmedik_kb_hhmm_ok(e ->> 'closes') and (e ->> 'opens') < (e ->> 'closes')) then
            return false;
          end if;
        elsif e ? 'opens' or e ? 'closes' then
          return false;
        end if;
      end loop;
    end if;
    return true;
  elsif p_kind = 'POLICY' then
    return public.plusmedik_audit_keys_within(p, array['topic', 'title', 'body'])
       and p ?& array['topic', 'title', 'body'] and jsonb_typeof(p -> 'topic') = 'string' and (p ->> 'topic') ~ '^[A-Z][A-Z_]{1,39}$'
       and jsonb_typeof(p -> 'title') = 'string' and jsonb_typeof(p -> 'body') = 'string';
  elsif p_kind = 'PAYMENT_METHOD' then
    return public.plusmedik_audit_keys_within(p, array['method', 'label', 'accepted', 'notes'])
       and p ?& array['method', 'label', 'accepted'] and jsonb_typeof(p -> 'method') = 'string' and (p ->> 'method') ~ '^[a-z0-9][a-z0-9_.-]{0,39}$'
       and jsonb_typeof(p -> 'label') = 'string' and jsonb_typeof(p -> 'accepted') = 'boolean'
       and (not p ? 'notes' or jsonb_typeof(p -> 'notes') = 'string');
  elsif p_kind = 'FAQ' then
    if not (public.plusmedik_audit_keys_within(p, array['question', 'answer', 'tags']) and p ?& array['question', 'answer']
        and jsonb_typeof(p -> 'question') = 'string' and jsonb_typeof(p -> 'answer') = 'string'
        and (not p ? 'tags' or (jsonb_typeof(p -> 'tags') = 'array' and jsonb_array_length(p -> 'tags') <= 12))) then
      return false;
    end if;
    if p ? 'tags' then
      for e in select * from jsonb_array_elements(p -> 'tags') loop
        if not (jsonb_typeof(e) = 'string' and (e #>> '{}') ~ '^[a-z0-9][a-z0-9_-]{0,29}$') then
          return false;
        end if;
      end loop;
    end if;
    return true;
  elsif p_kind = 'STUDY_PREPARATION' then
    if not (public.plusmedik_audit_keys_within(p, array['labTestId', 'prepState', 'fastingHours', 'instructions', 'collectionWindow'])
        and p ?& array['labTestId', 'prepState']
        and jsonb_typeof(p -> 'labTestId') = 'string' and (p ->> 'labTestId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and jsonb_typeof(p -> 'prepState') = 'string' and (p ->> 'prepState') in ('NO_PREPARATION_REQUIRED', 'HAS_PREPARATION')
        and (not p ? 'instructions' or jsonb_typeof(p -> 'instructions') = 'string')
        and (not p ? 'collectionWindow' or jsonb_typeof(p -> 'collectionWindow') = 'string')) then
      return false;
    end if;
    if (p ->> 'prepState') = 'NO_PREPARATION_REQUIRED' then
      -- "No requiere preparación" es una afirmación clínica explícita: no admite instrucciones ni ayuno, y debe ser aprobada como cualquier otra.
      return not (p ? 'fastingHours' or p ? 'instructions' or p ? 'collectionWindow');
    end if;
    -- HAS_PREPARATION: debe decir QUÉ preparación hay.
    if p ? 'fastingHours' and not (jsonb_typeof(p -> 'fastingHours') = 'number' and (p ->> 'fastingHours') ~ '^([0-9]|[1-3][0-9]|4[0-8])$') then
      return false;
    end if;
    return p ? 'instructions' or p ? 'fastingHours';
  end if;
  return false;
end $$;

-- ───────────────────────── utilidades internas ─────────────────────────
create or replace function public.plusmedik_kb_hash(p jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p::text, 'UTF8')), 'hex');
$$;

create or replace function public.plusmedik_kb_bump()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision bigint;
begin
  insert into public.plusmedik_kb_state (id, revision) values (true, 1)
  on conflict (id) do update set revision = public.plusmedik_kb_state.revision + 1, updated_at = now()
  returning revision into v_revision;
  return v_revision;
end $$;

-- Verifica quién actúa. p_class = clasificación del elemento; p_action: DRAFT | SUBMIT | DECIDE.
create or replace function public.plusmedik_kb_assert_actor(p_id text, p_type text, p_role text, p_class text, p_action text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9_.:@-]{1,80}$' or p_type is null or p_type not in ('HUMAN', 'AI')
     or p_role is null or p_role not in ('EDITOR', 'ADMIN_APPROVER', 'CLINICAL_APPROVER', 'AI_DRAFTER')
     or p_class is null or p_class not in ('ADMINISTRATIVE', 'CLINICAL') or p_action is null or p_action not in ('DRAFT', 'SUBMIT', 'DECIDE') then
    raise exception 'plusmedik_kb: invalid actor' using errcode = 'PT422';
  end if;
  -- Una IA solo redacta borradores administrativos; el rol de IA es exclusivo de la IA.
  if (p_type = 'AI') <> (p_role = 'AI_DRAFTER') then
    raise exception 'plusmedik_kb: role does not match actor type' using errcode = 'PT403';
  end if;
  if p_type = 'AI' then
    if p_action <> 'DRAFT' or p_class <> 'ADMINISTRATIVE' then
      raise exception 'plusmedik_kb: an AI actor may only draft administrative knowledge' using errcode = 'PT403';
    end if;
    return;
  end if;
  if p_action in ('DRAFT', 'SUBMIT') and p_role in ('EDITOR', 'ADMIN_APPROVER', 'CLINICAL_APPROVER') then
    return;
  end if;
  if p_action = 'DECIDE' and ((p_class = 'ADMINISTRATIVE' and p_role = 'ADMIN_APPROVER') or (p_class = 'CLINICAL' and p_role = 'CLINICAL_APPROVER')) then
    return;
  end if;
  raise exception 'plusmedik_kb: actor is not allowed to perform this action' using errcode = 'PT403';
end $$;

-- ───────────────────────── escritura ─────────────────────────

-- Crea un borrador (y el elemento si no existe). Un elemento solo admite UNA versión abierta a la vez (PT409 si ya hay una).
create or replace function public.plusmedik_kb_create_draft(
  p_kind text, p_key text, p_payload jsonb, p_actor_id text, p_actor_type text, p_actor_role text, p_source_ref text default null, p_valid_from timestamptz default null, p_valid_until timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.plusmedik_kb_documents%rowtype;
  v_version integer;
  v_id uuid;
  v_hash text;
begin
  if p_kind is null or p_kind not in ('BRANCH', 'SCHEDULE', 'POLICY', 'PAYMENT_METHOD', 'FAQ', 'STUDY_PREPARATION') or p_key is null or p_key !~ '^[a-z0-9][a-z0-9_.:-]{0,95}$'
     or not public.plusmedik_kb_payload_ok(p_kind, p_payload)
     or (p_source_ref is not null and p_source_ref !~ '^[A-Za-z0-9_.:/#-]{1,120}$')
     or (p_kind = 'STUDY_PREPARATION' and p_key <> 'study:' || (p_payload ->> 'labTestId')) then
    raise exception 'plusmedik_kb: invalid draft' using errcode = 'PT422';
  end if;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, case when p_kind = 'STUDY_PREPARATION' then 'CLINICAL' else 'ADMINISTRATIVE' end, 'DRAFT');
  if p_valid_from is not null and p_valid_until is not null and p_valid_from >= p_valid_until then
    raise exception 'plusmedik_kb: invalid validity' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_kb_documents (kind, key) values (p_kind, p_key) on conflict (kind, key) do nothing;
  select * into v_doc from public.plusmedik_kb_documents where kind = p_kind and key = p_key for update;
  if exists (select 1 from public.plusmedik_kb_versions where document_id = v_doc.id and status in ('DRAFT', 'PENDING_APPROVAL')) then
    raise exception 'plusmedik_kb: the element already has an open version' using errcode = 'PT409';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.plusmedik_kb_versions where document_id = v_doc.id;
  v_hash := public.plusmedik_kb_hash(p_payload);
  insert into public.plusmedik_kb_versions (document_id, version, status, payload, content_hash, source_ref, valid_from, valid_until, created_by, created_by_type)
  values (v_doc.id, v_version, 'DRAFT', p_payload, v_hash, p_source_ref, p_valid_from, p_valid_until, p_actor_id, p_actor_type)
  returning id into v_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (v_id, v_doc.id, 'CREATED', p_actor_id, p_actor_type, p_actor_role, null, 'DRAFT', v_hash);
  return jsonb_build_object('status', 'created', 'document_id', v_doc.id, 'version_id', v_id, 'version', v_version);
end $$;

-- Edita un borrador. Una IA solo edita borradores creados por una IA.
create or replace function public.plusmedik_kb_edit_draft(
  p_version_id uuid, p_payload jsonb, p_actor_id text, p_actor_type text, p_actor_role text, p_source_ref text default null, p_valid_from timestamptz default null, p_valid_until timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
  v_doc public.plusmedik_kb_documents%rowtype;
  v_ver public.plusmedik_kb_versions%rowtype;
  v_hash text;
begin
  select document_id into v_doc_id from public.plusmedik_kb_versions where id = p_version_id;
  if not found then
    raise exception 'plusmedik_kb: version not found' using errcode = 'PT404';
  end if;
  select * into v_doc from public.plusmedik_kb_documents where id = v_doc_id for update;
  select * into v_ver from public.plusmedik_kb_versions where id = p_version_id for update;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_doc.classification, 'DRAFT');
  if v_ver.status <> 'DRAFT' then
    raise exception 'plusmedik_kb: only a draft can be edited' using errcode = 'PT409';
  end if;
  if p_actor_type = 'AI' and v_ver.created_by_type <> 'AI' then
    raise exception 'plusmedik_kb: an AI actor may not edit human drafts' using errcode = 'PT403';
  end if;
  if not public.plusmedik_kb_payload_ok(v_doc.kind, p_payload) or (p_source_ref is not null and p_source_ref !~ '^[A-Za-z0-9_.:/#-]{1,120}$')
     or (v_doc.kind = 'STUDY_PREPARATION' and v_doc.key <> 'study:' || (p_payload ->> 'labTestId'))
     or (p_valid_from is not null and p_valid_until is not null and p_valid_from >= p_valid_until) then
    raise exception 'plusmedik_kb: invalid draft' using errcode = 'PT422';
  end if;
  v_hash := public.plusmedik_kb_hash(p_payload);
  update public.plusmedik_kb_versions set payload = p_payload, content_hash = v_hash, source_ref = p_source_ref, valid_from = p_valid_from, valid_until = p_valid_until where id = p_version_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (p_version_id, v_doc.id, 'EDITED', p_actor_id, p_actor_type, p_actor_role, 'DRAFT', 'DRAFT', v_hash);
  return jsonb_build_object('status', 'edited', 'version_id', p_version_id);
end $$;

-- Envía a aprobación: exige contenido completo y caducidad.
create or replace function public.plusmedik_kb_submit(p_version_id uuid, p_actor_id text, p_actor_type text, p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
  v_doc public.plusmedik_kb_documents%rowtype;
  v_ver public.plusmedik_kb_versions%rowtype;
begin
  select document_id into v_doc_id from public.plusmedik_kb_versions where id = p_version_id;
  if not found then
    raise exception 'plusmedik_kb: version not found' using errcode = 'PT404';
  end if;
  select * into v_doc from public.plusmedik_kb_documents where id = v_doc_id for update;
  select * into v_ver from public.plusmedik_kb_versions where id = p_version_id for update;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_doc.classification, 'SUBMIT');
  if v_ver.status = 'PENDING_APPROVAL' then
    return jsonb_build_object('status', 'already_submitted');
  end if;
  if v_ver.status <> 'DRAFT' then
    raise exception 'plusmedik_kb: only a draft can be submitted' using errcode = 'PT409';
  end if;
  if v_ver.valid_until is null or not public.plusmedik_kb_payload_ok(v_doc.kind, v_ver.payload) then
    raise exception 'plusmedik_kb: draft is incomplete' using errcode = 'PT422';
  end if;
  update public.plusmedik_kb_versions set status = 'PENDING_APPROVAL', submitted_by = p_actor_id, submitted_at = now() where id = p_version_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (p_version_id, v_doc.id, 'SUBMITTED', p_actor_id, p_actor_type, p_actor_role, 'DRAFT', 'PENDING_APPROVAL', v_ver.content_hash);
  return jsonb_build_object('status', 'submitted');
end $$;

-- Cuatro ojos: el que decide no puede haber creado, editado ni enviado la versión.
create or replace function public.plusmedik_kb_assert_not_author(p_version_id uuid, p_actor_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.plusmedik_kb_events where version_id = p_version_id and event in ('CREATED', 'EDITED', 'SUBMITTED') and actor_id = p_actor_id) then
    raise exception 'plusmedik_kb: the author of a version cannot decide on it' using errcode = 'PT403';
  end if;
end $$;

-- Rechaza: vuelve a borrador (el contenido no cambia; se puede editar y volver a enviar).
create or replace function public.plusmedik_kb_reject(p_version_id uuid, p_actor_id text, p_actor_type text, p_actor_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
  v_doc public.plusmedik_kb_documents%rowtype;
  v_ver public.plusmedik_kb_versions%rowtype;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_]{1,40}$' then
    raise exception 'plusmedik_kb: invalid reason' using errcode = 'PT422';
  end if;
  select document_id into v_doc_id from public.plusmedik_kb_versions where id = p_version_id;
  if not found then
    raise exception 'plusmedik_kb: version not found' using errcode = 'PT404';
  end if;
  select * into v_doc from public.plusmedik_kb_documents where id = v_doc_id for update;
  select * into v_ver from public.plusmedik_kb_versions where id = p_version_id for update;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_doc.classification, 'DECIDE');
  if v_ver.status <> 'PENDING_APPROVAL' then
    raise exception 'plusmedik_kb: only a pending version can be rejected' using errcode = 'PT409';
  end if;
  perform public.plusmedik_kb_assert_not_author(p_version_id, p_actor_id);
  update public.plusmedik_kb_versions set status = 'DRAFT', submitted_by = null, submitted_at = null where id = p_version_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
  values (p_version_id, v_doc.id, 'REJECTED', p_actor_id, p_actor_type, p_actor_role, 'PENDING_APPROVAL', 'DRAFT', p_reason, v_ver.content_hash);
  return jsonb_build_object('status', 'rejected');
end $$;

-- Aprueba. Reemplaza (desactiva) la versión aprobada anterior del elemento y sube la revisión, todo en la misma transacción.
create or replace function public.plusmedik_kb_approve(p_version_id uuid, p_actor_id text, p_actor_type text, p_actor_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
  v_doc public.plusmedik_kb_documents%rowtype;
  v_ver public.plusmedik_kb_versions%rowtype;
  v_prev public.plusmedik_kb_versions%rowtype;
  v_from timestamptz;
  v_revision bigint;
begin
  select document_id into v_doc_id from public.plusmedik_kb_versions where id = p_version_id;
  if not found then
    raise exception 'plusmedik_kb: version not found' using errcode = 'PT404';
  end if;
  select * into v_doc from public.plusmedik_kb_documents where id = v_doc_id for update;
  select * into v_ver from public.plusmedik_kb_versions where id = p_version_id for update;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_doc.classification, 'DECIDE');
  if v_ver.status = 'APPROVED' and v_ver.approved_by = p_actor_id then
    return jsonb_build_object('status', 'already_approved');
  end if;
  if v_ver.status <> 'PENDING_APPROVAL' then
    raise exception 'plusmedik_kb: only a pending version can be approved' using errcode = 'PT409';
  end if;
  perform public.plusmedik_kb_assert_not_author(p_version_id, p_actor_id);
  v_from := coalesce(v_ver.valid_from, now());
  if v_ver.valid_until is null or v_ver.valid_until <= now() or v_ver.valid_until > now() + interval '400 days' or v_from >= v_ver.valid_until
     or not public.plusmedik_kb_payload_ok(v_doc.kind, v_ver.payload) then
    raise exception 'plusmedik_kb: invalid validity or content' using errcode = 'PT422';
  end if;
  if v_doc.kind = 'STUDY_PREPARATION' then
    -- El estudio debe existir y estar activo en el catálogo real (solo lectura). Sin catálogo no se aprueba preparación. (Dos pasos: si la tabla no existe, la consulta
    -- ni siquiera se planifica.)
    if to_regclass('public.lab_tests') is null then
      raise exception 'plusmedik_kb: unknown or inactive study' using errcode = 'PT422';
    end if;
    if not exists (select 1 from public.lab_tests where id = (v_ver.payload ->> 'labTestId')::uuid and active) then
      raise exception 'plusmedik_kb: unknown or inactive study' using errcode = 'PT422';
    end if;
  end if;

  select * into v_prev from public.plusmedik_kb_versions where document_id = v_doc.id and status = 'APPROVED' for update;
  if found then
    update public.plusmedik_kb_versions set status = 'INACTIVE', inactivated_by = p_actor_id, inactivated_at = now(), inactive_reason = 'SUPERSEDED' where id = v_prev.id;
    insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
    values (v_prev.id, v_doc.id, 'SUPERSEDED', p_actor_id, p_actor_type, p_actor_role, 'APPROVED', 'INACTIVE', 'SUPERSEDED', v_prev.content_hash);
  end if;
  update public.plusmedik_kb_versions set status = 'APPROVED', valid_from = v_from, approved_by = p_actor_id, approved_role = p_actor_role, approved_at = now() where id = p_version_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, content_hash)
  values (p_version_id, v_doc.id, 'APPROVED', p_actor_id, p_actor_type, p_actor_role, 'PENDING_APPROVAL', 'APPROVED', v_ver.content_hash);
  v_revision := public.plusmedik_kb_bump();
  return jsonb_build_object('status', 'approved', 'revision', v_revision);
end $$;

-- Retira lo aprobado (queda INACTIVE). No exige un segundo humano: retirar información incorrecta debe ser inmediato. Sube la revisión.
create or replace function public.plusmedik_kb_deactivate(p_version_id uuid, p_actor_id text, p_actor_type text, p_actor_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
  v_doc public.plusmedik_kb_documents%rowtype;
  v_ver public.plusmedik_kb_versions%rowtype;
  v_revision bigint;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_]{1,40}$' then
    raise exception 'plusmedik_kb: invalid reason' using errcode = 'PT422';
  end if;
  select document_id into v_doc_id from public.plusmedik_kb_versions where id = p_version_id;
  if not found then
    raise exception 'plusmedik_kb: version not found' using errcode = 'PT404';
  end if;
  select * into v_doc from public.plusmedik_kb_documents where id = v_doc_id for update;
  select * into v_ver from public.plusmedik_kb_versions where id = p_version_id for update;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_doc.classification, 'DECIDE');
  if v_ver.status = 'INACTIVE' then
    return jsonb_build_object('status', 'already_inactive');
  end if;
  if v_ver.status <> 'APPROVED' then
    raise exception 'plusmedik_kb: only an approved version can be deactivated' using errcode = 'PT409';
  end if;
  update public.plusmedik_kb_versions set status = 'INACTIVE', inactivated_by = p_actor_id, inactivated_at = now(), inactive_reason = p_reason where id = p_version_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
  values (p_version_id, v_doc.id, 'DEACTIVATED', p_actor_id, p_actor_type, p_actor_role, 'APPROVED', 'INACTIVE', p_reason, v_ver.content_hash);
  v_revision := public.plusmedik_kb_bump();
  return jsonb_build_object('status', 'deactivated', 'revision', v_revision);
end $$;

-- Recupera una versión que ya fue APROBADA antes (contenido inmutable): vuelve a ser la vigente y la actual pasa a INACTIVE. Solo un aprobador de la clasificación y solo si
-- su caducidad sigue en el futuro (si no, hay que crear una versión nueva). No se puede "restaurar" algo que nunca estuvo aprobado.
create or replace function public.plusmedik_kb_restore(p_version_id uuid, p_actor_id text, p_actor_type text, p_actor_role text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
  v_doc public.plusmedik_kb_documents%rowtype;
  v_ver public.plusmedik_kb_versions%rowtype;
  v_prev public.plusmedik_kb_versions%rowtype;
  v_revision bigint;
begin
  if p_reason is null or p_reason !~ '^[A-Z0-9_]{1,40}$' then
    raise exception 'plusmedik_kb: invalid reason' using errcode = 'PT422';
  end if;
  select document_id into v_doc_id from public.plusmedik_kb_versions where id = p_version_id;
  if not found then
    raise exception 'plusmedik_kb: version not found' using errcode = 'PT404';
  end if;
  select * into v_doc from public.plusmedik_kb_documents where id = v_doc_id for update;
  select * into v_ver from public.plusmedik_kb_versions where id = p_version_id for update;
  perform public.plusmedik_kb_assert_actor(p_actor_id, p_actor_type, p_actor_role, v_doc.classification, 'DECIDE');
  if v_ver.status = 'APPROVED' then
    return jsonb_build_object('status', 'already_approved');
  end if;
  if v_ver.status <> 'INACTIVE' or not exists (select 1 from public.plusmedik_kb_events where version_id = p_version_id and event = 'APPROVED') then
    raise exception 'plusmedik_kb: only a previously approved version can be restored' using errcode = 'PT409';
  end if;
  if v_ver.valid_until is null or v_ver.valid_until <= now() then
    raise exception 'plusmedik_kb: the version has expired' using errcode = 'PT422';
  end if;
  if v_doc.kind = 'STUDY_PREPARATION' then
    if to_regclass('public.lab_tests') is null then
      raise exception 'plusmedik_kb: unknown or inactive study' using errcode = 'PT422';
    end if;
    if not exists (select 1 from public.lab_tests where id = (v_ver.payload ->> 'labTestId')::uuid and active) then
      raise exception 'plusmedik_kb: unknown or inactive study' using errcode = 'PT422';
    end if;
  end if;
  select * into v_prev from public.plusmedik_kb_versions where document_id = v_doc.id and status = 'APPROVED' for update;
  if found then
    update public.plusmedik_kb_versions set status = 'INACTIVE', inactivated_by = p_actor_id, inactivated_at = now(), inactive_reason = 'SUPERSEDED' where id = v_prev.id;
    insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
    values (v_prev.id, v_doc.id, 'SUPERSEDED', p_actor_id, p_actor_type, p_actor_role, 'APPROVED', 'INACTIVE', 'SUPERSEDED', v_prev.content_hash);
  end if;
  update public.plusmedik_kb_versions set status = 'APPROVED', approved_by = p_actor_id, approved_role = p_actor_role, approved_at = now(), inactivated_by = null, inactivated_at = null, inactive_reason = null where id = p_version_id;
  insert into public.plusmedik_kb_events (version_id, document_id, event, actor_id, actor_type, actor_role, from_status, to_status, reason, content_hash)
  values (p_version_id, v_doc.id, 'RESTORED', p_actor_id, p_actor_type, p_actor_role, 'INACTIVE', 'APPROVED', p_reason, v_ver.content_hash);
  v_revision := public.plusmedik_kb_bump();
  return jsonb_build_object('status', 'restored', 'revision', v_revision);
end $$;

-- ───────────────────────── lectura ─────────────────────────

-- Revisión actual (0 si nunca hubo cambios aprobados). Barata: sirve para invalidar cachés.
create or replace function public.plusmedik_kb_revision()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('revision', coalesce((select revision from public.plusmedik_kb_state where id), 0));
$$;

-- TODO lo aprobado (incluso lo ya vencido, para poder distinguir "vencido" de "inexistente") junto con la revisión, en UNA sentencia: misma foto de la base, así que el
-- contenido nunca es más viejo que la revisión devuelta. La vigencia la evalúa quien consume en el momento de usar el dato.
create or replace function public.plusmedik_kb_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', coalesce((select revision from public.plusmedik_kb_state where id), 0),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', d.kind, 'key', d.key, 'classification', d.classification, 'version', v.version, 'versionId', v.id, 'payload', v.payload,
        'validFrom', v.valid_from, 'validUntil', v.valid_until, 'approvedAt', v.approved_at, 'approvedBy', v.approved_by, 'contentHash', v.content_hash)
        order by d.kind, d.key)
      from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id
      where v.status = 'APPROVED'), '[]'::jsonb));
$$;

-- Administración (CRM): historial de un elemento y lista filtrada. Solo metadatos y contenido; nunca datos de pacientes (no existen aquí).
create or replace function public.plusmedik_kb_history(p_kind text, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'versions', coalesce((select jsonb_agg(jsonb_build_object('versionId', v.id, 'version', v.version, 'status', v.status, 'payload', v.payload, 'validFrom', v.valid_from, 'validUntil', v.valid_until,
        'createdBy', v.created_by, 'createdByType', v.created_by_type, 'approvedBy', v.approved_by, 'approvedAt', v.approved_at, 'contentHash', v.content_hash) order by v.version)
      from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id where d.kind = p_kind and d.key = p_key), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'event', e.event, 'actorId', e.actor_id, 'actorType', e.actor_type, 'actorRole', e.actor_role,
        'from', e.from_status, 'to', e.to_status, 'reason', e.reason, 'at', e.at) order by e.at, e.id)
      from public.plusmedik_kb_events e join public.plusmedik_kb_versions v on v.id = e.version_id join public.plusmedik_kb_documents d on d.id = e.document_id
      where d.kind = p_kind and d.key = p_key), '[]'::jsonb));
$$;

create or replace function public.plusmedik_kb_list(p_status text default null, p_kind text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 500 or (p_status is not null and p_status not in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'INACTIVE'))
     or (p_kind is not null and p_kind not in ('BRANCH', 'SCHEDULE', 'POLICY', 'PAYMENT_METHOD', 'FAQ', 'STUDY_PREPARATION')) then
    raise exception 'plusmedik_kb: invalid filter' using errcode = 'PT422';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(row_to_json(x)::jsonb) from (
      select d.kind, d.key, d.classification, v.id as "versionId", v.version, v.status, v.valid_until as "validUntil", v.created_by as "createdBy", v.created_by_type as "createdByType", v.updated_at as "updatedAt"
      from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id
      where (p_status is null or v.status = p_status) and (p_kind is null or d.kind = p_kind)
      order by v.updated_at desc, v.id limit p_limit) x), '[]'::jsonb));
end $$;

-- ───────────────────────── privilegios ─────────────────────────
-- Internas: nadie las ejecuta directamente.
revoke all on function public.plusmedik_kb_versions_guard() from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_text_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_hhmm_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_payload_ok(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_hash(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_bump() from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_assert_actor(text, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_kb_assert_not_author(uuid, text) from public, anon, authenticated, service_role;
-- Lectura (agente) y administración (hoy service_role; el CRM necesitará un permiso propio y autorizado aparte).
revoke all on function public.plusmedik_kb_create_draft(text, text, jsonb, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_edit_draft(uuid, jsonb, text, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_submit(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_reject(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_approve(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_deactivate(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_restore(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_revision() from public, anon, authenticated;
revoke all on function public.plusmedik_kb_snapshot() from public, anon, authenticated;
revoke all on function public.plusmedik_kb_history(text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_list(text, text, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_kb_create_draft(text, text, jsonb, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.plusmedik_kb_edit_draft(uuid, jsonb, text, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.plusmedik_kb_submit(uuid, text, text, text) to service_role;
grant execute on function public.plusmedik_kb_reject(uuid, text, text, text, text) to service_role;
grant execute on function public.plusmedik_kb_approve(uuid, text, text, text) to service_role;
grant execute on function public.plusmedik_kb_deactivate(uuid, text, text, text, text) to service_role;
grant execute on function public.plusmedik_kb_restore(uuid, text, text, text, text) to service_role;
grant execute on function public.plusmedik_kb_revision() to service_role;
grant execute on function public.plusmedik_kb_snapshot() to service_role;
grant execute on function public.plusmedik_kb_history(text, text) to service_role;
grant execute on function public.plusmedik_kb_list(text, text, integer) to service_role;

comment on function public.plusmedik_kb_approve(uuid, text, text, text) is 'Aprueba una versión pendiente: solo una persona con el rol aprobador de la clasificación, distinta de quien la redactó; exige caducidad (máx. 400 días). Sube la revisión.';
comment on function public.plusmedik_kb_snapshot() is 'Todo lo aprobado + la revisión, en una sola sentencia. La vigencia se evalúa al usar el dato.';
