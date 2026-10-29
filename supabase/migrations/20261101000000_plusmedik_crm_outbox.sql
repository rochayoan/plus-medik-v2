-- PlusMedik V2 G5.0: cola de salida (outbox) persistente e idempotente hacia el CRM. Migración ADITIVA y posterior a 20261031000000 (datos por estudio): tablas y funciones nuevas;
-- no modifica ni borra nada anterior. Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio.
-- Orden: 1 -> ... -> 12 -> esta.
--
-- ───────────────────────── Qué resuelve ─────────────────────────
-- Los casos que el agente no debe resolver solo (recetas ambiguas, estudios sin resolver, consultas que piden una persona) deben llegar al CRM sin perderse ni duplicarse, aunque el CRM
-- esté apagado (503), todavía no tenga el mensaje original (409 message_not_ingested) o no responda. Contrato receptor REAL (CRM-PLUSMEDIK/docs/AGENT_REVIEW_CASE_CONTRACT.md):
-- POST /api/internal/agent/review-case con `eventId` como clave de idempotencia; el CRM además deduplica por el mensaje original. Aquí se guarda el evento ANTES de enviarlo.
--
-- ───────────────────────── Garantías ─────────────────────────
--   · Idempotente: el `eventId` es 'plusmedik-review:' + el id de la corrida del mensaje original, y hay un solo evento por mensaje. Reencolar (turno repetido, ejecución que reclama
--     el lease) devuelve el mismo evento, jamás otro. La base verifica que el mensaje y el contacto correspondan a esa corrida: un cliente no puede fabricar un evento ajeno.
--   · Se encola con owner + fence (lease vigente) bajo el bloqueo del contacto: una ejecución antigua que revive no encola.
--   · Entrega con arrendamiento (lease) propio y generación (fence): un solo envío en vuelo por evento; si el que envía muere, el arrendamiento vence y otro lo retoma. Cada reclamo
--     cuenta como un intento (también los que no se sabe si llegaron: repetirlos es seguro porque el CRM es idempotente), así que los reintentos están ACOTADOS (por defecto 8).
--   · Retroceso exponencial (30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h, 24 h). Un 409 message_not_ingested se reintenta (el CRM puede ingerir el mensaje después). Rechazos permanentes
--     (400, 413, 200 ignorado) pasan a DEAD de inmediato. DEAD nunca se descarta en silencio: queda a la vista (stats/list) y se puede reencolar mientras no venza.
--   · Privacidad: el cuerpo (que lleva el teléfono, exigido por el contrato) se guarda CIFRADO por la aplicación (AES-256-GCM); la base solo ve un texto opaco. Se borra al entregarse
--     (SENT) y al vencer (por defecto 7 días). Quedan: el hash del cuerpo, códigos de motivo y de resultado, contadores y tiempos. Nunca texto del paciente ni teléfono en claro.
--   · Bitácora inmutable de cada intento (estado HTTP y código de resultado; nunca el cuerpo ni el texto del servidor).
--
-- ───────────────────────── Límites ─────────────────────────
--   · La base no habla con el CRM: lo hace la aplicación (src/crm-outbox). Que el CRM ingiera el mensaje original (webhook de Kapso) es una dependencia externa sin verificar.
--   · Un evento enviado y registrado por el CRM no se puede «des-registrar» desde aquí.

-- ───────────────────────── tablas ─────────────────────────
create table if not exists public.plusmedik_crm_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique check (event_id ~ '^plusmedik-review:[0-9a-f-]{36}$'),
  kind text not null check (kind in ('REVIEW_CASE', 'CONVERSATION')),
  origin_run_id uuid not null unique references public.plusmedik_audit_runs(id),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  kapso_message_id text not null check (kapso_message_id ~ '^[A-Za-z0-9_.=:-]{1,255}$'),
  reason_codes text[] not null check (cardinality(reason_codes) between 1 and 4
    and reason_codes <@ array['HUMAN_REQUEST', 'MEDICAL_QUERY', 'NO_APPROVED_ANSWER', 'AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'STUDY_UNAVAILABLE', 'PRICE_INVALID']),
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_FLIGHT', 'SENT', 'DEAD')),
  delivery text check (delivery is null or delivery in ('CREATED', 'DUPLICATE')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  lease_owner text check (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{8,64}$'),
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  last_http_status integer check (last_http_status is null or last_http_status between 100 and 599),
  last_result text check (last_result is null or last_result in ('CREATED', 'DUPLICATE', 'MESSAGE_NOT_INGESTED', 'CONFLICT_UNKNOWN', 'UNAUTHORIZED', 'UNAVAILABLE', 'INVALID', 'TOO_LARGE', 'IGNORED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK')),
  dead_reason text check (dead_reason is null or dead_reason in ('EXHAUSTED', 'EXPIRED', 'REJECTED_INVALID', 'REJECTED_TOO_LARGE', 'REJECTED_IGNORED')),
  payload_cipher text check (payload_cipher is null or (payload_cipher ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' and length(payload_cipher) <= 60000)),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and pg_column_size(evidence) < 4000),
  session_id uuid references public.plusmedik_quote_sessions(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  check (status <> 'SENT' or (payload_cipher is null and delivery is not null and sent_at is not null)),
  check (status <> 'DEAD' or dead_reason is not null),
  check (status <> 'IN_FLIGHT' or (lease_owner is not null and lease_expires_at is not null)),
  check (status not in ('PENDING', 'IN_FLIGHT') or payload_cipher is not null)
);
create unique index if not exists plusmedik_crm_outbox_message_idx on public.plusmedik_crm_outbox (kapso_message_id);
create index if not exists plusmedik_crm_outbox_due_idx on public.plusmedik_crm_outbox (next_attempt_at) where status = 'PENDING';
create index if not exists plusmedik_crm_outbox_inflight_idx on public.plusmedik_crm_outbox (lease_expires_at) where status = 'IN_FLIGHT';
create index if not exists plusmedik_crm_outbox_contact_idx on public.plusmedik_crm_outbox (contact_key, created_at desc);

create table if not exists public.plusmedik_crm_outbox_attempts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.plusmedik_crm_outbox(id),
  attempt_no integer not null check (attempt_no >= 0),
  http_status integer check (http_status is null or http_status between 100 and 599),
  result text not null check (result in ('CREATED', 'DUPLICATE', 'MESSAGE_NOT_INGESTED', 'CONFLICT_UNKNOWN', 'UNAUTHORIZED', 'UNAVAILABLE', 'INVALID', 'TOO_LARGE', 'IGNORED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK', 'REQUEUED')),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 600000),
  at timestamptz not null default clock_timestamp()
);
create index if not exists plusmedik_crm_outbox_attempts_idx on public.plusmedik_crm_outbox_attempts (outbox_id, at);

alter table public.plusmedik_crm_outbox enable row level security;
alter table public.plusmedik_crm_outbox_attempts enable row level security;
revoke all on table public.plusmedik_crm_outbox, public.plusmedik_crm_outbox_attempts from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_crm_outbox_attempts from service_role;
-- La cola se lee SOLO por columnas (sin el cuerpo cifrado ni el arrendamiento) o por las funciones.
revoke all on table public.plusmedik_crm_outbox from service_role;
grant select on table public.plusmedik_crm_outbox_attempts to service_role;
-- El cuerpo cifrado NO se puede leer con SELECT directo: solo lo devuelve el reclamo (con arrendamiento).
grant select (id, event_id, kind, origin_run_id, contact_key, kapso_message_id, reason_codes, status, delivery, attempts, max_attempts, next_attempt_at, expires_at, lease_expires_at, last_http_status,
  last_result, dead_reason, payload_hash, evidence, session_id, created_at, updated_at, sent_at) on table public.plusmedik_crm_outbox to service_role;

comment on table public.plusmedik_crm_outbox is 'Cola de salida hacia el CRM (contrato review-case). Cuerpo cifrado por la aplicación y borrado al entregarse o vencer. Sin texto del paciente ni teléfono en claro.';
comment on table public.plusmedik_crm_outbox_attempts is 'Bitácora inmutable de intentos de entrega al CRM (estado HTTP y código de resultado).';

create or replace function public.plusmedik_crm_outbox_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.event_id <> old.event_id or new.kind <> old.kind or new.origin_run_id <> old.origin_run_id or new.contact_key <> old.contact_key
     or new.kapso_message_id <> old.kapso_message_id or new.reason_codes <> old.reason_codes or new.payload_hash <> old.payload_hash or new.evidence <> old.evidence
     or new.created_at <> old.created_at or new.expires_at <> old.expires_at then
    raise exception 'plusmedik_outbox: event identity and evidence are immutable' using errcode = 'PT409';
  end if;
  if old.status = 'SENT' then
    raise exception 'plusmedik_outbox: a sent event is immutable' using errcode = 'PT409';
  end if;
  if new.payload_cipher is not null and old.payload_cipher is not null and new.payload_cipher <> old.payload_cipher then
    raise exception 'plusmedik_outbox: the payload cannot change' using errcode = 'PT409';
  end if;
  if new.payload_cipher is not null and old.payload_cipher is null then
    raise exception 'plusmedik_outbox: a scrubbed payload cannot come back' using errcode = 'PT409';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;

create or replace trigger plusmedik_crm_outbox_guard before update on public.plusmedik_crm_outbox for each row execute function public.plusmedik_crm_outbox_guard();
create or replace trigger plusmedik_crm_outbox_no_delete before delete on public.plusmedik_crm_outbox for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_crm_outbox_no_truncate before truncate on public.plusmedik_crm_outbox for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_crm_outbox_attempts_immutable before update or delete on public.plusmedik_crm_outbox_attempts for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_crm_outbox_attempts_no_truncate before truncate on public.plusmedik_crm_outbox_attempts for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── 1. encolar ─────────────────────────
-- Resultados: created | exists (mismo evento: devuelve su estado). PT422 argumentos inválidos; PT409 el mensaje o el contacto no corresponden a la corrida de origen; PT410 sin lease.
create or replace function public.plusmedik_crm_outbox_enqueue(
  p_run_id uuid, p_owner text, p_fence bigint, p_origin_run_id uuid, p_kind text, p_kapso_message_id text, p_reasons text[], p_cipher text, p_hash text, p_evidence jsonb,
  p_session_id uuid default null, p_ttl_seconds integer default 604800, p_max_attempts integer default 8)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_origin public.plusmedik_audit_runs%rowtype;
  v_row public.plusmedik_crm_outbox%rowtype;
  v_id uuid;
begin
  if p_origin_run_id is null or p_kind is null or p_kind not in ('REVIEW_CASE', 'CONVERSATION') or p_kapso_message_id is null or p_kapso_message_id !~ '^[A-Za-z0-9_.=:-]{1,255}$'
     or p_reasons is null or cardinality(p_reasons) not between 1 and 4
     or not (p_reasons <@ array['HUMAN_REQUEST', 'MEDICAL_QUERY', 'NO_APPROVED_ANSWER', 'AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'STUDY_UNAVAILABLE', 'PRICE_INVALID'])
     or p_cipher is null or p_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or length(p_cipher) > 60000 or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' or pg_column_size(p_evidence) >= 4000
     or p_ttl_seconds is null or p_ttl_seconds not between 3600 and 2592000 or p_max_attempts is null or p_max_attempts not between 1 and 20 then
    raise exception 'plusmedik_outbox: invalid event' using errcode = 'PT422';
  end if;
  select contact_key into v_contact from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_outbox: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);

  select * into v_origin from public.plusmedik_audit_runs where id = p_origin_run_id;
  if not found or v_origin.contact_key is distinct from v_contact or v_origin.kapso_message_id <> p_kapso_message_id then
    raise exception 'plusmedik_outbox: the message does not belong to the origin run' using errcode = 'PT409';
  end if;
  if p_session_id is not null and not exists (select 1 from public.plusmedik_quote_sessions where id = p_session_id and contact_key = v_contact) then
    raise exception 'plusmedik_outbox: the session does not belong to the contact' using errcode = 'PT409';
  end if;

  select * into v_row from public.plusmedik_crm_outbox where origin_run_id = p_origin_run_id;
  if found then
    return jsonb_build_object('status', 'exists', 'outboxId', v_row.id, 'state', v_row.status, 'delivery', v_row.delivery, 'eventId', v_row.event_id);
  end if;
  insert into public.plusmedik_crm_outbox (event_id, kind, origin_run_id, contact_key, kapso_message_id, reason_codes, payload_cipher, payload_hash, evidence, session_id, expires_at, max_attempts)
  values ('plusmedik-review:' || p_origin_run_id::text, p_kind, p_origin_run_id, v_contact, p_kapso_message_id, p_reasons, p_cipher, p_hash, p_evidence, p_session_id,
          clock_timestamp() + make_interval(secs => p_ttl_seconds), p_max_attempts)
  returning id into v_id;
  return jsonb_build_object('status', 'created', 'outboxId', v_id, 'state', 'PENDING', 'delivery', null, 'eventId', 'plusmedik-review:' || p_origin_run_id::text);
end $$;

-- ───────────────────────── limpieza de vencidos ─────────────────────────
-- Lo no entregado cuyo plazo venció pasa a DEAD (EXPIRED) y su cuerpo se borra. Devuelve cuántos.
create or replace function public.plusmedik_crm_outbox_purge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.plusmedik_crm_outbox set payload_cipher = null, status = 'DEAD', dead_reason = coalesce(dead_reason, 'EXPIRED'), lease_owner = null, lease_expires_at = null
  where status in ('PENDING', 'IN_FLIGHT', 'DEAD') and expires_at <= clock_timestamp() and payload_cipher is not null;
  get diagnostics v_count = row_count;
  return jsonb_build_object('purged', v_count);
end $$;

-- ───────────────────────── 2. reclamar para enviar ─────────────────────────
-- Reclama hasta p_limit eventos listos (PENDING con su hora cumplida, o IN_FLIGHT cuyo arrendamiento venció) —o uno concreto—, sin bloquear a otros procesos (skip locked). Con p_force y un
-- evento concreto se ignora la hora (lo usa el turno que acaba de encolarlo para el primer intento en línea). Cada reclamo cuenta un intento. Devuelve los cuerpos cifrados para que la aplicación los envíe.
create or replace function public.plusmedik_crm_outbox_claim(p_owner text, p_lease_seconds integer, p_limit integer, p_outbox_id uuid default null, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_result jsonb;
begin
  if p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{8,64}$' or p_lease_seconds is null or p_lease_seconds not between 5 and 300 or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'plusmedik_outbox: invalid claim' using errcode = 'PT422';
  end if;
  perform public.plusmedik_crm_outbox_purge();
  -- Un envío cuyo arrendamiento venció sin resultado y que ya agotó sus intentos no se reintenta: DEAD (a la vista).
  update public.plusmedik_crm_outbox set status = 'DEAD', dead_reason = 'EXHAUSTED', lease_owner = null, lease_expires_at = null
  where status = 'IN_FLIGHT' and lease_expires_at < clock_timestamp() and attempts >= max_attempts;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from (
    select id from public.plusmedik_crm_outbox
    where ((status = 'PENDING' and (next_attempt_at <= clock_timestamp() or (coalesce(p_force, false) and p_outbox_id is not null))) or (status = 'IN_FLIGHT' and lease_expires_at < clock_timestamp()))
      and expires_at > clock_timestamp() and attempts < max_attempts and (p_outbox_id is null or id = p_outbox_id)
    order by next_attempt_at, created_at limit p_limit for update skip locked) due;
  update public.plusmedik_crm_outbox set status = 'IN_FLIGHT', lease_owner = p_owner, lease_fence = lease_fence + 1, lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    attempts = attempts + 1
  where id = any (v_ids);
  select coalesce(jsonb_agg(jsonb_build_object('outboxId', o.id, 'eventId', o.event_id, 'cipher', o.payload_cipher, 'attempt', o.attempts, 'fence', o.lease_fence) order by o.next_attempt_at, o.created_at), '[]'::jsonb)
    into v_result from public.plusmedik_crm_outbox o where o.id = any (v_ids);
  return jsonb_build_object('claimed', v_result);
end $$;

-- ───────────────────────── 3. registrar el resultado de un envío ─────────────────────────
-- Resultados: sent | retry | dead | already_sent. PT410 si el arrendamiento ya no es de quien envió (otro lo retomó): su resultado no se aplica.
create or replace function public.plusmedik_crm_outbox_record(p_outbox_id uuid, p_owner text, p_fence bigint, p_http_status integer, p_outcome text, p_duration_ms integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.plusmedik_crm_outbox%rowtype;
  v_seconds integer;
  v_backoff integer[] := array[30, 120, 600, 1800, 7200, 21600, 43200, 86400];
  v_dead text;
begin
  if p_outcome is null or p_outcome not in ('CREATED', 'DUPLICATE', 'MESSAGE_NOT_INGESTED', 'CONFLICT_UNKNOWN', 'UNAUTHORIZED', 'UNAVAILABLE', 'INVALID', 'TOO_LARGE', 'IGNORED', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK')
     or (p_http_status is not null and p_http_status not between 100 and 599) or (p_duration_ms is not null and p_duration_ms not between 0 and 600000) or p_owner is null or p_fence is null then
    raise exception 'plusmedik_outbox: invalid result' using errcode = 'PT422';
  end if;
  select * into v_row from public.plusmedik_crm_outbox where id = p_outbox_id for update;
  if not found then
    raise exception 'plusmedik_outbox: event not found' using errcode = 'PT404';
  end if;
  if v_row.status = 'SENT' then
    return jsonb_build_object('status', 'already_sent');
  end if;
  if v_row.status <> 'IN_FLIGHT' or v_row.lease_owner is distinct from p_owner or v_row.lease_fence <> p_fence then
    raise exception 'plusmedik_outbox: lease lost' using errcode = 'PT410';
  end if;
  insert into public.plusmedik_crm_outbox_attempts (outbox_id, attempt_no, http_status, result, duration_ms) values (p_outbox_id, v_row.attempts, p_http_status, p_outcome, p_duration_ms);

  if p_outcome in ('CREATED', 'DUPLICATE') then
    update public.plusmedik_crm_outbox set status = 'SENT', delivery = p_outcome, sent_at = clock_timestamp(), payload_cipher = null, lease_owner = null, lease_expires_at = null,
      last_http_status = p_http_status, last_result = p_outcome where id = p_outbox_id;
    return jsonb_build_object('status', 'sent', 'delivery', p_outcome);
  end if;
  v_dead := case p_outcome when 'INVALID' then 'REJECTED_INVALID' when 'TOO_LARGE' then 'REJECTED_TOO_LARGE' when 'IGNORED' then 'REJECTED_IGNORED' else null end;
  if v_dead is not null then
    -- Rechazo permanente: reintentar el mismo cuerpo no cambia nada. Queda a la vista (y reencolable tras corregir la causa mientras no venza).
    update public.plusmedik_crm_outbox set status = 'DEAD', dead_reason = v_dead, lease_owner = null, lease_expires_at = null, last_http_status = p_http_status, last_result = p_outcome where id = p_outbox_id;
    return jsonb_build_object('status', 'dead', 'reason', v_dead);
  end if;
  if v_row.attempts >= v_row.max_attempts then
    update public.plusmedik_crm_outbox set status = 'DEAD', dead_reason = 'EXHAUSTED', lease_owner = null, lease_expires_at = null, last_http_status = p_http_status, last_result = p_outcome where id = p_outbox_id;
    return jsonb_build_object('status', 'dead', 'reason', 'EXHAUSTED');
  end if;
  v_seconds := v_backoff[least(v_row.attempts, 8)];
  -- Un token rechazado es una configuración equivocada: no tiene sentido insistir cada medio minuto.
  if p_outcome = 'UNAUTHORIZED' then
    v_seconds := greatest(v_seconds, 1800);
  end if;
  update public.plusmedik_crm_outbox set status = 'PENDING', next_attempt_at = clock_timestamp() + make_interval(secs => v_seconds), lease_owner = null, lease_expires_at = null,
    last_http_status = p_http_status, last_result = p_outcome where id = p_outbox_id;
  return jsonb_build_object('status', 'retry', 'afterSeconds', v_seconds);
end $$;

-- ───────────────────────── 4. consulta ─────────────────────────
-- Estado de varios eventos (por id de evento): para saber si el CRM ya registró un caso antes de confirmarle algo al paciente. Solo códigos.
create or replace function public.plusmedik_crm_outbox_status(p_event_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_event_ids is null or cardinality(p_event_ids) not between 1 and 50 or exists (select 1 from unnest(p_event_ids) e where e !~ '^plusmedik-review:[0-9a-f-]{36}$') then
    raise exception 'plusmedik_outbox: invalid status query' using errcode = 'PT422';
  end if;
  return jsonb_build_object('events', coalesce((select jsonb_agg(jsonb_build_object('eventId', o.event_id, 'state', o.status, 'delivery', o.delivery, 'attempts', o.attempts, 'lastResult', o.last_result)) from public.plusmedik_crm_outbox o
    where o.event_id = any (p_event_ids)), '[]'::jsonb));
end $$;

create or replace function public.plusmedik_crm_outbox_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) as n from public.plusmedik_crm_outbox group by status) c), '{}'::jsonb),
    'oldestPendingSeconds', (select floor(extract(epoch from (clock_timestamp() - min(created_at)))) from public.plusmedik_crm_outbox where status in ('PENDING', 'IN_FLIGHT')),
    'deadByReason', coalesce((select jsonb_object_agg(dead_reason, n) from (select dead_reason, count(*) as n from public.plusmedik_crm_outbox where status = 'DEAD' group by dead_reason) d), '{}'::jsonb));
end $$;

create or replace function public.plusmedik_crm_outbox_list(p_status text default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (p_status is not null and p_status not in ('PENDING', 'IN_FLIGHT', 'SENT', 'DEAD')) or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'plusmedik_outbox: invalid list query' using errcode = 'PT422';
  end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(row_to_json(x)::jsonb) from (
    select o.id as "outboxId", o.event_id as "eventId", o.kind, o.reason_codes as "reasons", o.status, o.delivery, o.attempts, o.last_http_status as "lastHttpStatus", o.last_result as "lastResult",
           o.dead_reason as "deadReason", o.next_attempt_at as "nextAttemptAt", o.expires_at as "expiresAt", o.created_at as "createdAt", (o.payload_cipher is not null) as "canRequeue"
    from public.plusmedik_crm_outbox o where p_status is null or o.status = p_status order by o.created_at desc, o.id limit p_limit) x), '[]'::jsonb));
end $$;

-- ───────────────────────── 5. recuperación manual ─────────────────────────
-- Devuelve un DEAD a la cola mientras su cuerpo exista (no haya vencido). Reinicia los intentos y deja constancia. p_actor es un seudónimo (nunca nombre ni correo).
create or replace function public.plusmedik_crm_outbox_requeue(p_outbox_id uuid, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.plusmedik_crm_outbox%rowtype;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9_.:-]{3,64}$' then
    raise exception 'plusmedik_outbox: invalid actor' using errcode = 'PT422';
  end if;
  select * into v_row from public.plusmedik_crm_outbox where id = p_outbox_id for update;
  if not found then
    raise exception 'plusmedik_outbox: event not found' using errcode = 'PT404';
  end if;
  if v_row.status <> 'DEAD' then
    return jsonb_build_object('status', 'not_dead', 'state', v_row.status);
  end if;
  if v_row.payload_cipher is null or v_row.expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 'expired');
  end if;
  update public.plusmedik_crm_outbox set status = 'PENDING', dead_reason = null, attempts = 0, next_attempt_at = clock_timestamp(), lease_owner = null, lease_expires_at = null where id = p_outbox_id;
  insert into public.plusmedik_crm_outbox_attempts (outbox_id, attempt_no, result) values (p_outbox_id, 0, 'REQUEUED');
  return jsonb_build_object('status', 'requeued');
end $$;

-- ───────────────────────── 6. casos de una solicitud en revisión (G4.0) ─────────────────────────
-- Los mensajes de la sesión cerrada por ESTA corrida (NEEDS_REVIEW) que quedaron dudosos, con el mensaje y el adjunto originales, para derivar un caso por mensaje (el CRM acepta un
-- caso por mensaje). Incluye el mensaje de cierre, que ancla los motivos de toda la sesión (estudio retirado, precio inválido). Con owner + fence. Solo ids y códigos.
create or replace function public.plusmedik_quote_review_targets(p_run_id uuid, p_owner text, p_fence bigint, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_run public.plusmedik_audit_runs%rowtype;
  v_session public.plusmedik_quote_sessions%rowtype;
begin
  select contact_key into v_contact from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_outbox: turn not found' using errcode = 'PT404';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  select * into v_session from public.plusmedik_quote_sessions where id = p_session_id and contact_key = v_contact and closed_by_run = p_run_id and status = 'NEEDS_REVIEW';
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object('found', true, 'sessionReasons', to_jsonb(v_session.reasons),
    'closing', jsonb_build_object('runId', v_run.id, 'kapsoMessageId', v_run.kapso_message_id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('runId', i.run_id, 'kapsoMessageId', r.kapso_message_id, 'mediaId', r.kapso_media_id, 'kind', i.kind, 'status', i.status,
        'studyIds', to_jsonb(i.study_ids), 'ambiguous', i.ambiguous, 'unresolved', i.unresolved_count, 'reasons', to_jsonb(i.reasons)) order by i.seq)
      from public.plusmedik_quote_items i join public.plusmedik_audit_runs r on r.id = i.run_id
      where i.session_id = p_session_id and i.status in ('AMBIGUOUS', 'UNRESOLVED', 'UNCERTAIN') and i.seq < v_session.closed_seq), '[]'::jsonb));
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_crm_outbox_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_enqueue(uuid, text, bigint, uuid, text, text, text[], text, text, jsonb, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_purge() from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_claim(text, integer, integer, uuid, boolean) from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_record(uuid, text, bigint, integer, text, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_status(text[]) from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_stats() from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_list(text, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_crm_outbox_requeue(uuid, text) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_review_targets(uuid, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.plusmedik_crm_outbox_enqueue(uuid, text, bigint, uuid, text, text, text[], text, text, jsonb, uuid, integer, integer) to service_role;
grant execute on function public.plusmedik_crm_outbox_purge() to service_role;
grant execute on function public.plusmedik_crm_outbox_claim(text, integer, integer, uuid, boolean) to service_role;
grant execute on function public.plusmedik_crm_outbox_record(uuid, text, bigint, integer, text, integer) to service_role;
grant execute on function public.plusmedik_crm_outbox_status(text[]) to service_role;
grant execute on function public.plusmedik_crm_outbox_stats() to service_role;
grant execute on function public.plusmedik_crm_outbox_list(text, integer) to service_role;
grant execute on function public.plusmedik_crm_outbox_requeue(uuid, text) to service_role;
grant execute on function public.plusmedik_quote_review_targets(uuid, text, bigint, uuid) to service_role;

comment on function public.plusmedik_crm_outbox_enqueue(uuid, text, bigint, uuid, text, text, text[], text, text, jsonb, uuid, integer, integer) is 'Encola (idempotente por mensaje) un caso para el CRM con owner + fence; verifica que el mensaje corresponda a la corrida de origen. Solo service_role.';
comment on function public.plusmedik_crm_outbox_claim(text, integer, integer, uuid, boolean) is 'Reclama eventos listos con arrendamiento y generación; cada reclamo cuenta un intento. Solo service_role.';
comment on function public.plusmedik_crm_outbox_record(uuid, text, bigint, integer, text, integer) is 'Registra el resultado de un envío (fenced): SENT, reintento con retroceso, o DEAD. Solo service_role.';
