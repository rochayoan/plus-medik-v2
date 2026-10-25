-- PlusMedik V2 G2.0: turnos conversacionales (coordinación de mensajes consecutivos de un mismo contacto).
-- Migración ADITIVA y posterior a 20261024000000 (control de atención). No modifica las migraciones anteriores: solo REEMPLAZA dos funciones con la misma firma (cada
-- una difiere de la versión que reemplaza únicamente en el nuevo tipo de envío 'conversation'; una prueba lo comprueba) y AMPLÍA una restricción de runs.
-- Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio. Orden: 1 -> 2 -> 3 -> 4 -> 5 -> esta.
--
-- ───────────────────────── Qué agrega ─────────────────────────
-- Un TURNO es un mensaje entrante de un contacto (texto, imagen u otro). Cada turno ES una corrida de plusmedik_audit_runs (mismo claim, lease, fencing, reserva,
-- confirmación, recuperación y pausa humana de F1.3/F2.1): no se reconstruye nada. Esta migración agrega solo lo que faltaba para varios turnos consecutivos:
--
--   1. SECUENCIA POR CONTACTO (plusmedik_contact_turns / plusmedik_turns). Cada turno recibe el número 1, 2, 3... de su contacto, en el orden en que lo reclama la
--      base (orden de LLEGADA a nuestro sistema, no el de WhatsApp). Un reintento o una toma del lease conserva el número.
--   2. UN SOLO ENVÍO EN VUELO POR CONTACTO (plusmedik_turn_reserve_send). Mientras otro turno del mismo contacto tiene su envío reservado y vigente, la reserva
--      responde 'busy' y no cambia nada: el cliente espera y reintenta. Así dos respuestas al mismo paciente no se cruzan ni se reordenan por una carrera.
--   3. RESPUESTAS OBSOLETAS. Con la política NEWER_TURN, si un turno MÁS NUEVO del contacto ya reservó o envió su respuesta, la respuesta de este turno se descarta
--      (CANCELLED / SUPERSEDED) en vez de llegar después de la nueva. Con NONE (p. ej. una cotización) nunca se descarta. La comprobación y la reserva ocurren bajo el
--      mismo bloqueo del contacto, por lo que no hay hueco entre ambas; y como mientras un envío está reservado ningún otro turno del contacto puede reservar, no hace
--      falta una segunda comprobación de obsolescencia en confirm_send.
--   4. Nuevo tipo de envío 'conversation' (respuesta a un turno que no es una cotización).
--
-- La pausa humana, el lease/fence y "un envío incierto jamás se reenvía" los siguen aplicando las funciones existentes, que las nuevas llaman SIN reimplementarlas.
--
-- ───────────────────────── Orden de bloqueo (sin interbloqueos) ─────────────────────────
-- fila del contacto en plusmedik_contact_turns  ->  corrida (plusmedik_audit_runs). Ambas funciones nuevas toman primero la fila del contacto. La pausa humana
-- (register_human_message) bloquea attention_contacts -> corridas y nunca toca plusmedik_contact_turns: no puede cerrar un ciclo con esta migración.
--
-- ───────────────────────── Privacidad ─────────────────────────
-- No se guarda el texto del mensaje, ni el teléfono, ni ningún contenido: solo la clave HMAC del contacto, un número de secuencia y el tipo de turno.
--
-- ───────────────────────── Límites (lo que NO garantiza) ─────────────────────────
-- · La secuencia es el orden de llegada a la base: dos mensajes entregados fuera de orden por Kapso quedan en el orden en que llegaron.
-- · Un envío 'busy' que no se libera dentro del tiempo de espera del cliente deja el turno sin respuesta (queda recuperable o, si nadie lo reclama, abandonado).
-- · Un turno anterior a esta migración (o reclamado por el camino heredado) no tiene número de secuencia y no participa en NEWER_TURN, pero SÍ cuenta para 'busy'.
-- · Un mensaje humano posterior a la comprobación final sigue sin poder cancelar un envío en curso (límite heredado de F2.1).

-- ───────────────────────── 1. tipo de envío 'conversation' ─────────────────────────
alter table public.plusmedik_audit_runs drop constraint if exists plusmedik_audit_runs_lease_check;
alter table public.plusmedik_audit_runs add constraint plusmedik_audit_runs_lease_check check (
  send_state in ('NOT_RESERVED', 'RESERVED', 'ACCEPTED', 'UNKNOWN', 'CANCELLED', 'NOT_APPLICABLE')
  and (send_kind is null or send_kind in ('quoted', 'no_quote', 'technical_issue', 'conversation'))
  and (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{8,64}$')
  and (lease_fence is null or lease_fence >= 1)
  and (lease_attempts is null or lease_attempts >= 1)
  and ((lease_fence is null) = (lease_attempts is null))
  and (send_block_reason is null or send_block_reason ~ '^[A-Za-z0-9_.:-]{1,64}$')
  and (attention_reason is null or attention_reason ~ '^[A-Za-z0-9_.:-]{1,64}$')
);

-- ───────────────────────── 2. tablas ─────────────────────────
create table if not exists public.plusmedik_contact_turns (
  contact_key text primary key check (contact_key ~ '^[0-9a-f]{64}$'),
  last_seq bigint not null default 0 check (last_seq >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plusmedik_turns (
  run_id uuid primary key references public.plusmedik_audit_runs(id),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  seq bigint not null check (seq >= 1),
  turn_kind text not null check (turn_kind in ('IMAGE', 'TEXT', 'OTHER')),
  created_at timestamptz not null default now(),
  unique (contact_key, seq)
);

create index if not exists plusmedik_turns_contact_seq_idx on public.plusmedik_turns (contact_key, seq desc);

alter table public.plusmedik_contact_turns enable row level security;
alter table public.plusmedik_turns enable row level security;
revoke all on table public.plusmedik_contact_turns, public.plusmedik_turns from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_contact_turns, public.plusmedik_turns from service_role;
grant select on table public.plusmedik_contact_turns, public.plusmedik_turns to service_role;

comment on table public.plusmedik_contact_turns is 'Contador de turnos por contacto (clave HMAC, sin teléfono). Solo avanza de uno en uno y solo lo modifica plusmedik_turn_claim.';
comment on table public.plusmedik_turns is 'Un turno (mensaje entrante) por corrida: número de secuencia del contacto y tipo. Inmutable. Sin contenido del mensaje.';

create or replace function public.plusmedik_contact_turns_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.contact_key <> old.contact_key or new.created_at <> old.created_at then
    raise exception 'plusmedik_turn: contact identity is immutable' using errcode = 'PT409';
  end if;
  if new.last_seq <> old.last_seq + 1 then
    raise exception 'plusmedik_turn: sequence only advances by one' using errcode = 'PT409';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger plusmedik_contact_turns_guard before update on public.plusmedik_contact_turns
  for each row execute function public.plusmedik_contact_turns_guard();
create or replace trigger plusmedik_contact_turns_no_delete before delete on public.plusmedik_contact_turns
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_contact_turns_no_truncate before truncate on public.plusmedik_contact_turns
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_turns_immutable before update or delete on public.plusmedik_turns
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_turns_no_truncate before truncate on public.plusmedik_turns
  for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── 3. funciones anteriores: solo se amplía el tipo de envío ─────────────────────────
-- Copias de las versiones vigentes (migración 5 y migración 3) con UNA diferencia: aceptan 'conversation'. Conservan firma, permisos y comportamiento.

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
  if p_kind is null or p_kind not in ('quoted', 'no_quote', 'technical_issue', 'conversation') or p_lease_seconds is null or p_lease_seconds not between 1 and 900 then
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

create or replace function public.plusmedik_audit_record_reply(p_run_id uuid, p_reply jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_state text;
  v_result text;
  v_status text;
  v_message text;
  v_sqlstate text;
begin
  if p_run_id is null or p_reply is null or not public.plusmedik_audit_keys_within(p_reply, array['state', 'result', 'processing_status', 'provider_message_id']) then
    raise exception 'plusmedik_audit: invalid reply' using errcode = 'PT422';
  end if;
  v_state := p_reply ->> 'state';
  v_result := p_reply ->> 'result';
  v_status := p_reply ->> 'processing_status';
  v_message := p_reply ->> 'provider_message_id';
  if v_state is null or v_state not in ('ACCEPTED', 'UNKNOWN')
     or v_result is null or v_result not in ('quoted', 'no_quote', 'technical_issue', 'conversation', 'ignored')
     or v_status is null or v_status not in ('COMPLETED', 'FAILED')
     or (v_message is not null and v_message !~ '^[A-Za-z0-9_.=:-]{1,128}$') then
    raise exception 'plusmedik_audit: invalid reply' using errcode = 'PT422';
  end if;

  select * into v_run from public.plusmedik_audit_runs where id = p_run_id for update;
  if not found then
    raise exception 'plusmedik_audit: run not found' using errcode = 'PT404';
  end if;
  if v_run.reply_state <> 'NOT_ATTEMPTED' then
    if v_run.reply_state = v_state and v_run.reply_kind is not distinct from v_result and v_run.kapso_outbound_message_id is not distinct from v_message then
      return jsonb_build_object('status', 'already_recorded');
    end if;
    raise exception 'plusmedik_audit: reply already recorded with different content' using errcode = 'PT409';
  end if;

  begin
    update public.plusmedik_audit_runs set
      reply_state = v_state,
      reply_kind = v_result,
      kapso_outbound_message_id = v_message,
      processing_status = v_status,
      completed_at = now()
    where id = p_run_id;
    insert into public.plusmedik_audit_checks (run_id, check_kind, check_status, summary)
    values (p_run_id, 'REPLY', v_state, jsonb_build_object('result', v_result, 'providerAccepted', v_state = 'ACCEPTED'));
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate like 'PT%' or v_sqlstate in ('40001', '40P01', '55P03', '57014') then
      raise;
    end if;
    raise exception 'plusmedik_audit: reply rejected by the database' using errcode = 'PT422', detail = 'sqlstate=' || v_sqlstate;
  end;

  return jsonb_build_object('status', 'recorded');
end $$;

-- ───────────────────────── 4. claim de un turno ─────────────────────────
-- Reclama el mensaje con la función existente (idempotente, lease, pausa humana) y, si el turno es nuevo, le asigna el siguiente número de su contacto. Toma
-- primero la fila del contacto: los claims de un mismo contacto se numeran en el orden en que la base los serializa. Resultado: el de plusmedik_audit_claim_run
-- (+ seq y turn_kind cuando hay turno). 'paused', 'busy', 'in_doubt', 'finished' y 'exhausted' no crean turno.
create or replace function public.plusmedik_turn_claim(
  p_message_id text, p_media_id text, p_owner text, p_lease_seconds integer, p_schema_version integer, p_engine_version text, p_flags jsonb, p_max_attempts integer default 3,
  p_contact_key text default null, p_turn_kind text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim jsonb;
  v_run_id uuid;
  v_seq bigint;
  v_kind text;
  v_run_contact text;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' or p_turn_kind is null or p_turn_kind not in ('IMAGE', 'TEXT', 'OTHER') then
    raise exception 'plusmedik_turn: invalid claim' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_contact_turns (contact_key) values (p_contact_key) on conflict (contact_key) do nothing;
  perform 1 from public.plusmedik_contact_turns where contact_key = p_contact_key for update;

  v_claim := public.plusmedik_audit_claim_run(p_message_id, p_media_id, p_owner, p_lease_seconds, p_schema_version, p_engine_version, p_flags, p_max_attempts, p_contact_key);
  if v_claim ->> 'outcome' not in ('claimed', 'taken_over') then
    return v_claim;
  end if;

  v_run_id := (v_claim ->> 'run_id')::uuid;
  select contact_key into v_run_contact from public.plusmedik_audit_runs where id = v_run_id;
  if v_run_contact is distinct from p_contact_key then
    raise exception 'plusmedik_turn: message belongs to another contact' using errcode = 'PT409';
  end if;

  select seq, turn_kind into v_seq, v_kind from public.plusmedik_turns where run_id = v_run_id;
  if not found then
    update public.plusmedik_contact_turns set last_seq = last_seq + 1 where contact_key = p_contact_key returning last_seq into v_seq;
    insert into public.plusmedik_turns (run_id, contact_key, seq, turn_kind) values (v_run_id, p_contact_key, v_seq, p_turn_kind);
    v_kind := p_turn_kind;
  end if;
  return v_claim || jsonb_build_object('seq', v_seq, 'turn_kind', v_kind);
end $$;

-- ───────────────────────── 5. reserva de envío de un turno ─────────────────────────
-- Resultados: reserved | blocked (pausa humana o bloqueo previo) | closed | busy (otro turno del contacto tiene un envío reservado y vigente: reintentar) |
-- superseded (política NEWER_TURN y un turno más nuevo ya reservó o envió su respuesta: esta se descarta). PT410 si perdió el lease; PT404 si no es un turno.
-- Una reserva ya concedida (mismo propietario y generación) se repite sin comprobar 'busy' ni obsolescencia: es idempotente, como la función que envuelve.
create or replace function public.plusmedik_turn_reserve_send(p_run_id uuid, p_owner text, p_fence bigint, p_kind text, p_lease_seconds integer, p_stale_policy text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if p_kind is null or p_kind not in ('quoted', 'no_quote', 'technical_issue', 'conversation')
     or p_stale_policy is null or p_stale_policy not in ('NONE', 'NEWER_TURN')
     or p_lease_seconds is null or p_lease_seconds not between 1 and 900 then
    raise exception 'plusmedik_turn: invalid send reservation' using errcode = 'PT422';
  end if;
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_turn: turn not found' using errcode = 'PT404';
  end if;

  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state <> 'NOT_RESERVED' then
    return public.plusmedik_audit_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds);
  end if;

  if exists (
    select 1 from public.plusmedik_audit_runs r
    where r.contact_key = v_contact and r.id <> p_run_id and r.send_state = 'RESERVED' and r.lease_expires_at > now()
  ) then
    return jsonb_build_object('status', 'busy');
  end if;

  if p_stale_policy = 'NEWER_TURN' and exists (
    select 1 from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id
    where t.contact_key = v_contact and t.seq > v_seq and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN')
  ) then
    perform public.plusmedik_audit_prove(p_run_id, p_fence);
    update public.plusmedik_audit_runs set
      send_state = 'CANCELLED',
      send_blocked_at = coalesce(send_blocked_at, now()),
      send_block_reason = coalesce(send_block_reason, 'SUPERSEDED'),
      processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
      completed_at = coalesce(completed_at, now()),
      lease_expires_at = now()
    where id = p_run_id;
    perform set_config('plusmedik.fence_proof', '', true);
    return jsonb_build_object('status', 'superseded');
  end if;

  return public.plusmedik_audit_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds);
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_contact_turns_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_turn_claim(text, text, text, integer, integer, text, jsonb, integer, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_turn_reserve_send(uuid, text, bigint, text, integer, text) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_claim(text, text, text, integer, integer, text, jsonb, integer, text, text) to service_role;
grant execute on function public.plusmedik_turn_reserve_send(uuid, text, bigint, text, integer, text) to service_role;

comment on function public.plusmedik_turn_claim(text, text, text, integer, integer, text, jsonb, integer, text, text) is 'Reclama un mensaje entrante como turno del contacto (claim existente + número de secuencia). Solo service_role.';
comment on function public.plusmedik_turn_reserve_send(uuid, text, bigint, text, integer, text) is 'Reserva de envío de un turno: un solo envío en vuelo por contacto y descarte de respuestas obsoletas (NEWER_TURN). Delega la pausa humana y el fencing en la reserva existente. Solo service_role.';
