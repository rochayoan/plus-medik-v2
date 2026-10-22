-- PlusMedik V2 F2.1: control de atención humana (apagado automático de la IA por mensajes enviados desde WhatsApp Business).
-- Migración posterior a 20261023000000 (leases). No modifica las migraciones anteriores. Solo define esquema local: no se aplica a ningún Supabase remoto.
-- Orden: 20261020000000 -> 20261021000000 -> 20261022000000 -> 20261023000000 -> esta.
--
-- ───────────────────────── Modelo ─────────────────────────
-- UNA fuente de verdad del estado de atención por contacto: plusmedik_attention_contacts (ACTIVE | HUMAN_PAUSED). La clave del contacto es un HMAC del teléfono con
-- una clave dedicada (calculado FUERA de la base: el número nunca se guarda aquí), acotado al número de WhatsApp del laboratorio. Cada evento relevante deja una
-- fila inmutable en plusmedik_attention_events (también sirve para deduplicar: event_key único).
--
-- Los cambios de estado y la autorización de envío se coordinan en la base, con un orden de bloqueo fijo (contacto -> corrida), sin interbloqueos:
--   · plusmedik_attention_register_human_message  pausa al contacto (crea la fila si no existe), bloquea los procesamientos pendientes del contacto y registra
--     el evento. Deduplica por event_key e ignora eventos anteriores a la última reactivación legítima.
--   · plusmedik_audit_claim_run (reemplaza a la de F1.3, mismos 8 argumentos + p_contact_key opcional): no procesa mensajes de un contacto pausado.
--   · plusmedik_audit_reserve_send (reemplaza a la de F1.3): bajo el bloqueo de la corrida, deniega la reserva si el contacto está pausado.
--   · plusmedik_audit_confirm_send (nueva): comprobación final, lo más cerca posible de la llamada a Kapso; si el contacto se pausó, libera la reserva (aún no se envió).
--
-- ───────────────────────── Límites (lo que NO se puede garantizar) ─────────────────────────
-- · Un evento humano que llega DESPUÉS de la comprobación final, o mientras la llamada a Kapso está en curso, no puede cancelar ese envío: no hay forma de
--   retirar un mensaje ya entregado a Kapso. Esa carrera se registra (late_reserved_runs / replied_after_event_runs en el evento y attention_reason en la corrida),
--   pero no se puede evitar.
-- · La pausa depende de que Kapso entregue el evento (y de que el webhook lo registre). Un evento perdido tras agotar los reintentos de Kapso no se recupera.
-- · No hay reactivación automática por tiempo; la reactivación es explícita (plusmedik_attention_resume).

alter table public.plusmedik_audit_runs add column if not exists contact_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plusmedik_audit_runs_contact_key_check') then
    alter table public.plusmedik_audit_runs add constraint plusmedik_audit_runs_contact_key_check check (contact_key is null or contact_key ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create index if not exists plusmedik_audit_runs_contact_idx on public.plusmedik_audit_runs (contact_key) where contact_key is not null;
comment on column public.plusmedik_audit_runs.contact_key is 'HMAC-SHA256 del contacto (clave dedicada, acotado al número del laboratorio). NULL = corrida anterior o sin control de atención.';

-- ───────────────────────── tablas ─────────────────────────

create table if not exists public.plusmedik_attention_contacts (
  contact_key text primary key check (contact_key ~ '^[0-9a-f]{64}$'),
  state text not null default 'ACTIVE' check (state in ('ACTIVE', 'HUMAN_PAUSED')),
  revision integer not null default 1 check (revision >= 1),
  paused_at timestamptz,
  pause_reason text check (pause_reason is null or pause_reason ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  pause_source text check (pause_source is null or pause_source ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  resumed_at timestamptz,
  last_human_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'HUMAN_PAUSED' or (paused_at is not null and pause_reason is not null and pause_source is not null))
);

create table if not exists public.plusmedik_attention_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique check (event_key ~ '^[A-Za-z0-9_.=:-]{1,200}$'),
  contact_key text check (contact_key is null or contact_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('HUMAN_BUSINESS_APP', 'UNKNOWN_ORIGIN', 'OTHER_APP_OUTBOUND', 'META_AGENT_OUTBOUND', 'PATIENT_SUPPRESSED', 'MANUAL_RESUME')),
  outcome text not null check (outcome in ('PAUSED', 'ALREADY_PAUSED', 'STALE_IGNORED', 'RECORDED', 'SUPPRESSED', 'RESUMED')),
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  state_revision integer,
  blocked_runs integer not null default 0 check (blocked_runs >= 0),
  late_reserved_runs integer not null default 0 check (late_reserved_runs >= 0),
  replied_after_event_runs integer not null default 0 check (replied_after_event_runs >= 0),
  detail jsonb not null default '{}'::jsonb
);

create index if not exists plusmedik_attention_events_contact_idx on public.plusmedik_attention_events (contact_key, received_at desc);

alter table public.plusmedik_attention_contacts enable row level security;
alter table public.plusmedik_attention_events enable row level security;
revoke all on table public.plusmedik_attention_contacts, public.plusmedik_attention_events from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_attention_contacts, public.plusmedik_attention_events from service_role;
grant select on table public.plusmedik_attention_contacts, public.plusmedik_attention_events to service_role;

comment on table public.plusmedik_attention_contacts is 'Única fuente de verdad del estado de atención por contacto (ACTIVE | HUMAN_PAUSED). Sin teléfonos: solo el HMAC del contacto.';
comment on table public.plusmedik_attention_events is 'Eventos de control de atención, inmutables; event_key único deduplica. Métricas no clínicas; contact_key es pseudónimo.';

create or replace function public.plusmedik_attention_contacts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.contact_key <> old.contact_key or new.created_at <> old.created_at then
    raise exception 'plusmedik_attention: contact identity is immutable' using errcode = 'PT409';
  end if;
  if (new.state is distinct from old.state and new.revision <> old.revision + 1) or (new.state = old.state and new.revision <> old.revision) then
    raise exception 'plusmedik_attention: revision must advance exactly with a state change' using errcode = 'PT409';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger plusmedik_attention_contacts_guard before update on public.plusmedik_attention_contacts
  for each row execute function public.plusmedik_attention_contacts_guard();
create or replace trigger plusmedik_attention_contacts_no_delete before delete on public.plusmedik_attention_contacts
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_attention_contacts_no_truncate before truncate on public.plusmedik_attention_contacts
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_attention_events_immutable before update or delete on public.plusmedik_attention_events
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_attention_events_no_truncate before truncate on public.plusmedik_attention_events
  for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── trigger de runs: F1.3 + contact_key inmutable + liberar una reserva no usada ─────────────────────────
create or replace function public.plusmedik_audit_runs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.kapso_message_id, new.kapso_media_id, new.received_at, new.started_at, new.created_at, new.detail_expires_at, new.metrics_expires_at, new.audit_schema_version, new.engine_version, new.flags, new.contact_key)
     is distinct from
     (old.id, old.kapso_message_id, old.kapso_media_id, old.received_at, old.started_at, old.created_at, old.detail_expires_at, old.metrics_expires_at, old.audit_schema_version, old.engine_version, old.flags, old.contact_key) then
    raise exception 'plusmedik_audit: run identity and registered versions are immutable' using errcode = 'PT409';
  end if;

  if (new.analysis_decision, new.analysis_outcome, new.review_required, new.recipe_stops, new.document_summary, new.catalog_hash, new.catalog_size, new.config_hash, new.evidence_hash, new.evidence_recorded_at)
     is distinct from
     (old.analysis_decision, old.analysis_outcome, old.review_required, old.recipe_stops, old.document_summary, old.catalog_hash, old.catalog_size, old.config_hash, old.evidence_hash, old.evidence_recorded_at)
     and not (old.evidence_recorded_at is null and new.evidence_recorded_at is not null) then
    raise exception 'plusmedik_audit: analysis evidence is immutable once recorded' using errcode = 'PT409';
  end if;

  if old.detail_purged_at is not null and new.detail_purged_at is distinct from old.detail_purged_at then
    raise exception 'plusmedik_audit: purge marker is immutable' using errcode = 'PT409';
  end if;

  if old.lease_fence is not null then
    if (new.analysis_decision, new.analysis_outcome, new.review_required, new.recipe_stops, new.document_summary, new.catalog_hash, new.catalog_size, new.config_hash, new.evidence_hash, new.evidence_recorded_at,
        new.processing_status, new.completed_at, new.error_code, new.reply_state, new.reply_kind, new.kapso_outbound_message_id,
        new.lease_owner, new.lease_expires_at, new.lease_fence, new.lease_attempts, new.send_state, new.send_kind, new.send_reserved_at, new.send_blocked_at, new.send_block_reason, new.attention_reason, new.attention_at)
       is distinct from
       (old.analysis_decision, old.analysis_outcome, old.review_required, old.recipe_stops, old.document_summary, old.catalog_hash, old.catalog_size, old.config_hash, old.evidence_hash, old.evidence_recorded_at,
        old.processing_status, old.completed_at, old.error_code, old.reply_state, old.reply_kind, old.kapso_outbound_message_id,
        old.lease_owner, old.lease_expires_at, old.lease_fence, old.lease_attempts, old.send_state, old.send_kind, old.send_reserved_at, old.send_blocked_at, old.send_block_reason, old.attention_reason, old.attention_at)
       and coalesce(current_setting('plusmedik.fence_proof', true), '') <> old.id::text || ':' || old.lease_fence::text then
      raise exception 'plusmedik_audit: lease fencing proof missing or stale' using errcode = 'PT410';
    end if;
    if new.lease_fence < old.lease_fence then
      raise exception 'plusmedik_audit: lease fence cannot decrease' using errcode = 'PT409';
    end if;
    -- F2.1: una reserva que todavía no llamó a Kapso se puede liberar (RESERVED -> CANCELLED) si apareció una pausa humana.
    if new.send_state is distinct from old.send_state and not (
         (old.send_state = 'NOT_RESERVED' and new.send_state in ('RESERVED', 'CANCELLED', 'NOT_APPLICABLE'))
      or (old.send_state = 'RESERVED' and new.send_state in ('ACCEPTED', 'UNKNOWN', 'CANCELLED'))) then
      raise exception 'plusmedik_audit: invalid send state transition' using errcode = 'PT409';
    end if;
  end if;

  if new.processing_status is distinct from old.processing_status and not (
       (old.processing_status = 'PROCESSING' and new.processing_status in ('ANALYZED', 'FAILED', 'IGNORED', 'COMPLETED'))
    or (old.processing_status = 'ANALYZED' and new.processing_status in ('COMPLETED', 'FAILED'))
    or (old.processing_status = 'IGNORED' and new.processing_status = 'COMPLETED')) then
    raise exception 'plusmedik_audit: invalid processing status transition' using errcode = 'PT409';
  end if;

  if (old.reply_state <> 'NOT_ATTEMPTED' and new.reply_state is distinct from old.reply_state)
     or (old.reply_kind is not null and new.reply_kind is distinct from old.reply_kind)
     or (old.kapso_outbound_message_id is not null and new.kapso_outbound_message_id is distinct from old.kapso_outbound_message_id)
     or (old.error_code is not null and new.error_code is distinct from old.error_code)
     or (old.completed_at is not null and new.completed_at is null) then
    raise exception 'plusmedik_audit: operational result already recorded' using errcode = 'PT409';
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────── claim: no se procesa a un contacto pausado ─────────────────────────
-- Reemplaza a la de F1.3 (se elimina la firma anterior para que no exista una vía sin comprobación). p_contact_key es opcional: sin él no hay control de
-- atención (los llamadores de producción siempre lo envían cuando el control está activo). Nuevo resultado: "paused" (no se crea ni toca ninguna corrida).
drop function if exists public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer);

create or replace function public.plusmedik_audit_claim_run(
  p_message_id text, p_media_id text, p_owner text, p_lease_seconds integer, p_schema_version integer, p_engine_version text, p_flags jsonb, p_max_attempts integer default 3, p_contact_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_id uuid;
begin
  if p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:-]{1,128}$'
     or (p_media_id is not null and p_media_id !~ '^[A-Za-z0-9_.=:-]{1,128}$')
     or p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{8,64}$'
     or p_lease_seconds is null or p_lease_seconds not between 1 and 900
     or p_schema_version is null or p_schema_version < 2
     or (p_engine_version is not null and p_engine_version !~ '^[0-9a-f]{7,64}$')
     or p_flags is null or jsonb_typeof(p_flags) <> 'object' or not public.plusmedik_audit_token_json_ok(p_flags)
     or p_max_attempts is null or p_max_attempts not between 1 and 10
     or (p_contact_key is not null and p_contact_key !~ '^[0-9a-f]{64}$') then
    raise exception 'plusmedik_audit: invalid claim' using errcode = 'PT422';
  end if;

  -- Atención humana: un contacto pausado no se procesa. Lectura sin bloqueo (un cambio concurrente lo vuelve a comprobar reserve_send).
  if p_contact_key is not null and exists (select 1 from public.plusmedik_attention_contacts where contact_key = p_contact_key and state = 'HUMAN_PAUSED') then
    insert into public.plusmedik_attention_events (event_key, contact_key, kind, outcome, detail)
    values ('inbound:' || p_message_id, p_contact_key, 'PATIENT_SUPPRESSED', 'SUPPRESSED', '{}'::jsonb)
    on conflict (event_key) do nothing;
    return jsonb_build_object('outcome', 'paused');
  end if;

  insert into public.plusmedik_audit_runs (kapso_message_id, kapso_media_id, processing_status, audit_schema_version, engine_version, flags, lease_owner, lease_expires_at, lease_fence, lease_attempts, contact_key)
  values (p_message_id, p_media_id, 'PROCESSING', p_schema_version, p_engine_version, p_flags, p_owner, now() + make_interval(secs => p_lease_seconds), 1, 1, p_contact_key)
  on conflict (kapso_message_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('outcome', 'claimed', 'run_id', v_id, 'fence', 1, 'attempt', 1, 'status', 'PROCESSING');
  end if;

  select * into v_run from public.plusmedik_audit_runs where kapso_message_id = p_message_id for update;
  if not found then
    raise exception 'plusmedik_audit: run not found' using errcode = 'PT404';
  end if;
  if v_run.lease_fence is null then
    return jsonb_build_object('outcome', 'in_doubt', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.lease_owner = p_owner then
    return jsonb_build_object('outcome', 'claimed', 'run_id', v_run.id, 'fence', v_run.lease_fence, 'attempt', v_run.lease_attempts, 'status', v_run.processing_status);
  end if;
  if v_run.send_state = 'RESERVED' then
    return jsonb_build_object('outcome', 'in_doubt', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.send_state <> 'NOT_RESERVED' or v_run.processing_status not in ('PROCESSING', 'ANALYZED') then
    return jsonb_build_object('outcome', 'finished', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.lease_expires_at > now() then
    return jsonb_build_object('outcome', 'busy', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.lease_attempts >= p_max_attempts then
    return jsonb_build_object('outcome', 'exhausted', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;

  perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
  update public.plusmedik_audit_runs set
    lease_owner = p_owner,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    lease_fence = v_run.lease_fence + 1,
    lease_attempts = v_run.lease_attempts + 1
  where id = v_run.id;
  return jsonb_build_object('outcome', 'taken_over', 'run_id', v_run.id, 'fence', v_run.lease_fence + 1, 'attempt', v_run.lease_attempts + 1, 'status', v_run.processing_status);
end $$;

-- ───────────────────────── reserva de envío: respeta la pausa humana ─────────────────────────
-- Reemplaza a la de F1.3 (misma firma y contrato). Bajo el bloqueo de la corrida comprueba el bloqueo explícito de la corrida Y el estado del contacto.
create or replace function public.plusmedik_audit_reserve_send(p_run_id uuid, p_owner text, p_fence bigint, p_kind text, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_paused boolean := false;
begin
  if p_kind is null or p_kind not in ('quoted', 'no_quote', 'technical_issue') or p_lease_seconds is null or p_lease_seconds not between 1 and 900 then
    raise exception 'plusmedik_audit: invalid send reservation' using errcode = 'PT422';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state = 'RESERVED' then
    if v_run.send_kind = p_kind then
      return jsonb_build_object('status', 'reserved');
    end if;
    raise exception 'plusmedik_audit: send reserved with a different kind' using errcode = 'PT409';
  end if;
  if v_run.send_state <> 'NOT_RESERVED' then
    return jsonb_build_object('status', 'closed');
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  if v_run.contact_key is not null then
    select coalesce((select state = 'HUMAN_PAUSED' from public.plusmedik_attention_contacts where contact_key = v_run.contact_key), false) into v_paused;
  end if;
  if v_run.send_blocked_at is not null or v_paused then
    update public.plusmedik_audit_runs set
      send_state = 'CANCELLED',
      send_blocked_at = coalesce(send_blocked_at, now()),
      send_block_reason = coalesce(send_block_reason, 'HUMAN_PAUSED'),
      processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
      completed_at = now(),
      lease_expires_at = now()
    where id = p_run_id;
    perform set_config('plusmedik.fence_proof', '', true);
    return jsonb_build_object('status', 'blocked');
  end if;
  update public.plusmedik_audit_runs set
    send_state = 'RESERVED',
    send_kind = p_kind,
    send_reserved_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_run_id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'reserved');
end $$;

-- Comprobación final, lo más cerca posible de la llamada a Kapso. Con la reserva concedida y SIN haber llamado todavía a Kapso, si el contacto se pausó (o la
-- corrida se bloqueó) la reserva se libera (RESERVED -> CANCELLED) y no se envía. Es idempotente. No elimina la carrera residual entre esta respuesta y la
-- llamada externa: un evento humano posterior ya no puede cancelar ese envío (queda registrado por register_human_message).
create or replace function public.plusmedik_audit_confirm_send(p_run_id uuid, p_owner text, p_fence bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_paused boolean := false;
begin
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state = 'CANCELLED' then
    return jsonb_build_object('status', 'blocked');
  end if;
  if v_run.send_state <> 'RESERVED' then
    return jsonb_build_object('status', 'closed');
  end if;
  if v_run.contact_key is not null then
    select coalesce((select state = 'HUMAN_PAUSED' from public.plusmedik_attention_contacts where contact_key = v_run.contact_key), false) into v_paused;
  end if;
  if v_run.send_blocked_at is null and not v_paused then
    return jsonb_build_object('status', 'proceed');
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  update public.plusmedik_audit_runs set
    send_state = 'CANCELLED',
    send_blocked_at = coalesce(send_blocked_at, now()),
    send_block_reason = coalesce(send_block_reason, 'HUMAN_PAUSED'),
    attention_reason = case when attention_reason = 'HUMAN_PAUSE_AFTER_RESERVATION' then null else attention_reason end,
    processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
    completed_at = coalesce(completed_at, now()),
    lease_expires_at = now()
  where id = p_run_id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'blocked');
end $$;

-- ───────────────────────── control de atención ─────────────────────────

create or replace function public.plusmedik_attention_status(p_contact_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.plusmedik_attention_contacts%rowtype;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' then
    raise exception 'plusmedik_attention: invalid contact' using errcode = 'PT422';
  end if;
  select * into v_contact from public.plusmedik_attention_contacts where contact_key = p_contact_key;
  if not found then
    return jsonb_build_object('exists', false, 'state', 'ACTIVE', 'revision', 0);
  end if;
  return jsonb_build_object('exists', true, 'state', v_contact.state, 'revision', v_contact.revision);
end $$;

-- Un mensaje saliente confirmado desde WhatsApp Business. Resultado: {outcome: PAUSED | ALREADY_PAUSED | STALE_IGNORED | duplicate, revision, blocked_runs,
-- late_reserved_runs, replied_after_event_runs}. Orden de bloqueo: contacto -> corridas (reserve_send/confirm_send solo leen el contacto sin bloquearlo).
create or replace function public.plusmedik_attention_register_human_message(p_event_key text, p_contact_key text, p_occurred_at timestamptz default null, p_reason text default 'HUMAN_WHATSAPP_BUSINESS_APP', p_source text default 'kapso_business_app')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.plusmedik_attention_contacts%rowtype;
  v_run public.plusmedik_audit_runs%rowtype;
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_outcome text;
  v_blocked integer := 0;
  v_late integer := 0;
  v_replied integer := 0;
begin
  if p_event_key is null or p_event_key !~ '^[A-Za-z0-9_.=:-]{1,200}$' or p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_reason is null or p_reason !~ '^[A-Za-z0-9_.:-]{1,64}$' or p_source is null or p_source !~ '^[A-Za-z0-9_.:-]{1,64}$'
     or v_at < now() - interval '400 days' or v_at > now() + interval '1 day' then
    raise exception 'plusmedik_attention: invalid event' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_attention_contacts (contact_key) values (p_contact_key) on conflict (contact_key) do nothing;
  select * into v_contact from public.plusmedik_attention_contacts where contact_key = p_contact_key for update;

  -- Duplicado (misma entrega reenviada o carrera entre webhooks): se serializa por el bloqueo del contacto.
  if exists (select 1 from public.plusmedik_attention_events where event_key = p_event_key) then
    return jsonb_build_object('outcome', 'duplicate', 'state', v_contact.state, 'revision', v_contact.revision);
  end if;

  if v_contact.state = 'HUMAN_PAUSED' then
    v_outcome := 'ALREADY_PAUSED';
    update public.plusmedik_attention_contacts set last_human_event_at = greatest(coalesce(last_human_event_at, v_at), v_at) where contact_key = p_contact_key;
  elsif v_contact.resumed_at is not null and v_at <= v_contact.resumed_at then
    -- Evento anterior a una reactivación legítima: no vuelve a pausar.
    v_outcome := 'STALE_IGNORED';
  else
    v_outcome := 'PAUSED';
    update public.plusmedik_attention_contacts set
      state = 'HUMAN_PAUSED', revision = revision + 1, paused_at = now(), pause_reason = p_reason, pause_source = p_source,
      last_human_event_at = greatest(coalesce(last_human_event_at, v_at), v_at)
    where contact_key = p_contact_key;
  end if;

  if v_outcome <> 'STALE_IGNORED' then
    -- Procesamientos pendientes del contacto (sin envío reservado): se bloquean. Si hay una reserva en curso, se espera su bloqueo de fila y se reevalúa.
    for v_run in
      select * from public.plusmedik_audit_runs
      where contact_key = p_contact_key and lease_fence is not null and send_state = 'NOT_RESERVED'
        and processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED', 'FAILED') and send_blocked_at is null
      for update
    loop
      perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
      update public.plusmedik_audit_runs set send_blocked_at = now(), send_block_reason = 'HUMAN_PAUSED' where id = v_run.id;
      v_blocked := v_blocked + 1;
    end loop;
    -- Carrera que NO se puede evitar: ya hay un envío reservado o ya se respondió después del mensaje humano. Se cuenta y se marca la corrida.
    for v_run in
      select * from public.plusmedik_audit_runs
      where contact_key = p_contact_key and lease_fence is not null and attention_reason is null
        and ((send_state = 'RESERVED') or (send_state in ('ACCEPTED', 'UNKNOWN') and send_reserved_at >= v_at))
      for update
    loop
      perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
      update public.plusmedik_audit_runs set
        attention_reason = case when v_run.send_state = 'RESERVED' then 'HUMAN_PAUSE_AFTER_RESERVATION' else 'BOT_REPLIED_AFTER_HUMAN_EVENT' end,
        attention_at = now()
      where id = v_run.id;
    end loop;
    select count(*) into v_late from public.plusmedik_audit_runs where contact_key = p_contact_key and lease_fence is not null and send_state = 'RESERVED';
    select count(*) into v_replied from public.plusmedik_audit_runs
      where contact_key = p_contact_key and lease_fence is not null and send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN') and send_reserved_at >= v_at;
    perform set_config('plusmedik.fence_proof', '', true);
  end if;

  select * into v_contact from public.plusmedik_attention_contacts where contact_key = p_contact_key;
  insert into public.plusmedik_attention_events (event_key, contact_key, kind, outcome, occurred_at, state_revision, blocked_runs, late_reserved_runs, replied_after_event_runs, detail)
  values (p_event_key, p_contact_key, 'HUMAN_BUSINESS_APP', v_outcome, v_at, v_contact.revision, v_blocked, v_late, v_replied, jsonb_build_object('reason', p_reason, 'source', p_source));
  return jsonb_build_object('outcome', v_outcome, 'state', v_contact.state, 'revision', v_contact.revision, 'blocked_runs', v_blocked, 'late_reserved_runs', v_late, 'replied_after_event_runs', v_replied);
end $$;

-- Eventos informativos que NO cambian el estado (origen desconocido, otra app, agente de Meta). Deduplica por event_key.
create or replace function public.plusmedik_attention_record_event(p_event_key text, p_contact_key text, p_kind text, p_occurred_at timestamptz default null, p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event_key is null or p_event_key !~ '^[A-Za-z0-9_.=:-]{1,200}$' or (p_contact_key is not null and p_contact_key !~ '^[0-9a-f]{64}$')
     or p_kind is null or p_kind not in ('UNKNOWN_ORIGIN', 'OTHER_APP_OUTBOUND', 'META_AGENT_OUTBOUND')
     or p_detail is null or jsonb_typeof(p_detail) <> 'object' or not public.plusmedik_audit_token_json_ok(p_detail)
     or (p_occurred_at is not null and (p_occurred_at < now() - interval '400 days' or p_occurred_at > now() + interval '1 day')) then
    raise exception 'plusmedik_attention: invalid event' using errcode = 'PT422';
  end if;
  insert into public.plusmedik_attention_events (event_key, contact_key, kind, outcome, occurred_at, detail)
  values (p_event_key, p_contact_key, p_kind, 'RECORDED', p_occurred_at, p_detail)
  on conflict (event_key) do nothing;
  if not found then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  return jsonb_build_object('outcome', 'RECORDED');
end $$;

-- Reactivación explícita (la usará el futuro panel/CRM). Eventos humanos anteriores a este momento ya no vuelven a pausar.
create or replace function public.plusmedik_attention_resume(p_contact_key text, p_reason text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.plusmedik_attention_contacts%rowtype;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' or p_reason is null or p_reason !~ '^[A-Za-z0-9_.:-]{1,64}$' or p_actor is null or p_actor !~ '^[A-Za-z0-9_.:@-]{1,64}$' then
    raise exception 'plusmedik_attention: invalid resume' using errcode = 'PT422';
  end if;
  select * into v_contact from public.plusmedik_attention_contacts where contact_key = p_contact_key for update;
  if not found or v_contact.state = 'ACTIVE' then
    return jsonb_build_object('outcome', 'already_active', 'revision', coalesce(v_contact.revision, 0));
  end if;
  update public.plusmedik_attention_contacts set state = 'ACTIVE', revision = revision + 1, paused_at = null, pause_reason = null, pause_source = null, resumed_at = now()
  where contact_key = p_contact_key returning * into v_contact;
  insert into public.plusmedik_attention_events (event_key, contact_key, kind, outcome, occurred_at, state_revision, detail)
  values ('resume:' || gen_random_uuid()::text, p_contact_key, 'MANUAL_RESUME', 'RESUMED', now(), v_contact.revision, jsonb_build_object('reason', p_reason, 'actor', replace(replace(p_actor, '@', '_at_'), '.', '_')));
  return jsonb_build_object('outcome', 'resumed', 'revision', v_contact.revision);
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_attention_contacts_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_reserve_send(uuid, text, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_confirm_send(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.plusmedik_attention_status(text) from public, anon, authenticated;
revoke all on function public.plusmedik_attention_register_human_message(text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_attention_record_event(text, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_attention_resume(text, text, text) from public, anon, authenticated;
grant execute on function public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer, text) to service_role;
grant execute on function public.plusmedik_audit_reserve_send(uuid, text, bigint, text, integer) to service_role;
grant execute on function public.plusmedik_audit_confirm_send(uuid, text, bigint) to service_role;
grant execute on function public.plusmedik_attention_status(text) to service_role;
grant execute on function public.plusmedik_attention_register_human_message(text, text, timestamptz, text, text) to service_role;
grant execute on function public.plusmedik_attention_record_event(text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.plusmedik_attention_resume(text, text, text) to service_role;
