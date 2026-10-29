-- PlusMedik V2 G3.2: protección contra bucles y exceso de respuestas. Migración ADITIVA y posterior a 20261028000000 (trazabilidad de conocimiento): tablas y funciones nuevas;
-- no modifica ni borra nada anterior (solo agrega un índice). Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio.
-- Orden: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> esta.
--
-- ───────────────────────── Qué resuelve ─────────────────────────
-- Un bot (o un cliente con un fallo) que le escribe al laboratorio y al que el laboratorio responde puede encadenar respuestas sin fin. Esta migración agrega, DENTRO de la
-- reserva de envío (el único punto atómico, bajo el bloqueo de la fila del contacto), un tope de respuestas por contacto y ventana de tiempo y la detección de dos señales de
-- bucle que NO dependen del texto del paciente:
--   · ráfaga: demasiados mensajes de texto entrantes del contacto en pocos segundos (un humano no escribe así);
--   · repetición: el agente está a punto de dar, al mismo contacto, la MISMA respuesta (misma «firma», un código cerrado como INFO_REQUEST:HOURS) por enésima vez.
-- Los umbrales viajan en cada llamada (p_guard): son configuración del cliente, no constantes de la base.
--
-- ───────────────────────── Garantías ─────────────────────────
--   · Solo limita lo CONVERSACIONAL: turnos de texto u otros (no imágenes) y envíos 'conversation' o 'technical_issue'. Una cotización ('quoted', 'no_quote') o un turno de imagen
--     NUNCA se limita: un paciente que manda su receta siempre recibe su cotización.
--   · Precedencia intacta: una reserva ya concedida se repite igual (idempotente); pausa humana / bloqueo previo, 'busy' (otro envío en vuelo) y 'superseded' los resuelve la
--     función de turnos de siempre, ANTES de evaluar el tope. Con p_guard nulo la función ES la de siempre.
--   · Atómico y serializado: se evalúa y se reserva bajo el mismo bloqueo del contacto (contacto -> corrida); dos turnos simultáneos no pueden pasar ambos el último hueco.
--   · NUNCA permanente: el tope es una ventana deslizante (se libera sola); la supresión por bucle caduca (máximo 24 h por restricción de la tabla); y plusmedik_reply_guard_reset
--     la levanta antes, con registro. Un bloqueo no toca la pausa humana y la pausa humana no se levanta aquí.
--   · Auditable: la corrida bloqueada queda CANCELLED con su motivo (RATE_LIMITED, SUPPRESSED, LOOP_SUSPECTED, REPEAT_SUSPECTED) y las transiciones (entrar en supresión, primer
--     tope de una ventana, recuperación) quedan en una bitácora inmutable. Sin texto del paciente ni de la respuesta, sin teléfonos: solo códigos, contadores y la clave seudónima.
--
-- ───────────────────────── Límites ─────────────────────────
--   · Un mensaje bloqueado no se reintenta solo (la corrida queda cerrada): el paciente verá la respuesta en su siguiente mensaje fuera del bloqueo. No hay aviso de «te respondo luego»:
--     enviar uno a un bot reabriría el bucle.
--   · La firma de repetición la calcula el cliente a partir de la categoría y el tema; no ve el texto. Dos preguntas distintas con la misma firma cuentan como repetición.

create index if not exists plusmedik_audit_runs_reply_guard_idx on public.plusmedik_audit_runs (contact_key, send_reserved_at)
  where send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN');

-- ───────────────────────── tablas ─────────────────────────
-- Marca de cada envío conversacional concedido: su firma (código cerrado). Se escribe en la misma transacción que la reserva.
create table if not exists public.plusmedik_reply_guard_marks (
  run_id uuid primary key references public.plusmedik_audit_runs(id),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  signature text not null check (signature ~ '^[A-Z0-9_.:-]{1,64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists plusmedik_reply_guard_marks_idx on public.plusmedik_reply_guard_marks (contact_key, signature, created_at desc);

-- Estado por contacto: supresión temporal (caduca sola) y desde cuándo se cuentan los envíos (se adelanta al recuperar).
create table if not exists public.plusmedik_reply_guard_state (
  contact_key text primary key references public.plusmedik_contact_turns(contact_key),
  suppressed_until timestamptz,
  reason text check (reason is null or reason in ('LOOP_BURST', 'LOOP_REPEAT')),
  counted_since timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((suppressed_until is null) = (reason is null)),
  check (suppressed_until is null or suppressed_until <= updated_at + interval '24 hours')
);

create table if not exists public.plusmedik_reply_guard_events (
  id uuid primary key default gen_random_uuid(),
  contact_key text not null references public.plusmedik_contact_turns(contact_key),
  run_id uuid references public.plusmedik_audit_runs(id),
  kind text not null check (kind in ('RATE_LIMITED', 'LOOP_SUSPECTED', 'REPEAT_SUSPECTED', 'RECOVERED')),
  detail jsonb not null check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) < 1000),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists plusmedik_reply_guard_events_contact_idx on public.plusmedik_reply_guard_events (contact_key, created_at desc);

alter table public.plusmedik_reply_guard_marks enable row level security;
alter table public.plusmedik_reply_guard_state enable row level security;
alter table public.plusmedik_reply_guard_events enable row level security;
revoke all on table public.plusmedik_reply_guard_marks, public.plusmedik_reply_guard_state, public.plusmedik_reply_guard_events from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_reply_guard_marks, public.plusmedik_reply_guard_state, public.plusmedik_reply_guard_events from service_role;
grant select on table public.plusmedik_reply_guard_marks, public.plusmedik_reply_guard_state, public.plusmedik_reply_guard_events to service_role;

comment on table public.plusmedik_reply_guard_marks is 'Firma (código cerrado) de cada respuesta conversacional concedida. Sin texto. Inmutable.';
comment on table public.plusmedik_reply_guard_state is 'Supresión temporal por bucle (caduca, máx. 24 h) y desde cuándo se cuentan los envíos de un contacto. Solo lo modifican las funciones de la guarda.';
comment on table public.plusmedik_reply_guard_events is 'Bitácora inmutable de bloqueos y recuperaciones de la guarda de respuestas. Sin texto ni teléfonos.';

create or replace function public.plusmedik_reply_guard_state_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.contact_key <> old.contact_key then
    raise exception 'plusmedik_guard: contact identity is immutable' using errcode = 'PT409';
  end if;
  return new;
end $$;

create or replace trigger plusmedik_reply_guard_state_guard before update on public.plusmedik_reply_guard_state
  for each row execute function public.plusmedik_reply_guard_state_guard();
create or replace trigger plusmedik_reply_guard_state_no_delete before delete on public.plusmedik_reply_guard_state
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_reply_guard_state_no_truncate before truncate on public.plusmedik_reply_guard_state
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_reply_guard_marks_immutable before update or delete on public.plusmedik_reply_guard_marks
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_reply_guard_marks_no_truncate before truncate on public.plusmedik_reply_guard_marks
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_reply_guard_events_immutable before update or delete on public.plusmedik_reply_guard_events
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_reply_guard_events_no_truncate before truncate on public.plusmedik_reply_guard_events
  for each statement execute function public.plusmedik_audit_forbid_mutation();

-- ───────────────────────── validación de la configuración ─────────────────────────
create or replace function public.plusmedik_reply_guard_int(p jsonb, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case when p is not null and jsonb_typeof(p) = 'number' and (p #>> '{}') ~ '^[0-9]{1,6}$' then (p #>> '{}')::integer between p_min and p_max else false end
$$;

-- {rules:[{windowSeconds,max}] (1..4), burst:{windowSeconds,max}, repeat:{windowSeconds,max}, cooldownSeconds, signature?}
create or replace function public.plusmedik_reply_guard_valid(p_guard jsonb)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  r jsonb;
begin
  if p_guard is null or jsonb_typeof(p_guard) <> 'object' then
    return false;
  end if;
  if not public.plusmedik_audit_keys_within(p_guard, array['rules', 'burst', 'repeat', 'cooldownSeconds', 'signature'])
     or not (p_guard ?& array['rules', 'burst', 'repeat', 'cooldownSeconds']) then
    return false;
  end if;
  if jsonb_typeof(p_guard -> 'rules') <> 'array' then
    return false;
  end if;
  if jsonb_array_length(p_guard -> 'rules') not between 1 and 4 then
    return false;
  end if;
  for r in select * from jsonb_array_elements(p_guard -> 'rules') loop
    if jsonb_typeof(r) <> 'object' then
      return false;
    end if;
    if not public.plusmedik_audit_keys_within(r, array['windowSeconds', 'max']) or not (r ?& array['windowSeconds', 'max'])
       or not public.plusmedik_reply_guard_int(r -> 'windowSeconds', 1, 86400) or not public.plusmedik_reply_guard_int(r -> 'max', 1, 1000) then
      return false;
    end if;
  end loop;
  foreach r in array array[p_guard -> 'burst', p_guard -> 'repeat'] loop
    if r is null or jsonb_typeof(r) <> 'object' then
      return false;
    end if;
    if not public.plusmedik_audit_keys_within(r, array['windowSeconds', 'max']) or not (r ?& array['windowSeconds', 'max'])
       or not public.plusmedik_reply_guard_int(r -> 'windowSeconds', 1, 86400) or not public.plusmedik_reply_guard_int(r -> 'max', 2, 1000) then
      return false;
    end if;
  end loop;
  if not public.plusmedik_reply_guard_int(p_guard -> 'cooldownSeconds', 1, 86400) then
    return false;
  end if;
  if p_guard ? 'signature' and not (jsonb_typeof(p_guard -> 'signature') = 'string' and (p_guard ->> 'signature') ~ '^[A-Z0-9_.:-]{1,64}$') then
    return false;
  end if;
  return true;
end $$;

-- ───────────────────────── reserva de envío con guarda ─────────────────────────
-- Resultados: los de plusmedik_turn_reserve_send (reserved | blocked | closed | busy | superseded) y limited {reason}. PT410 si perdió el lease; PT404 si no es un turno;
-- PT422 si los argumentos o la configuración son inválidos.
create or replace function public.plusmedik_turn_reserve_send_guarded(p_run_id uuid, p_owner text, p_fence bigint, p_kind text, p_lease_seconds integer, p_stale_policy text, p_guard jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_turn_kind text;
  v_run public.plusmedik_audit_runs%rowtype;
  v_state public.plusmedik_reply_guard_state%rowtype;
  v_paused boolean := false;
  v_now timestamptz;
  v_since timestamptz;
  v_signature text;
  v_cooldown integer;
  v_reason text;
  v_count integer;
  v_rule jsonb;
  v_index integer := 0;
  v_result jsonb;
begin
  if p_guard is null then
    return public.plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy);
  end if;
  if p_kind is null or p_kind not in ('quoted', 'no_quote', 'technical_issue', 'conversation')
     or p_stale_policy is null or p_stale_policy not in ('NONE', 'NEWER_TURN')
     or p_lease_seconds is null or p_lease_seconds not between 1 and 900
     or not public.plusmedik_reply_guard_valid(p_guard) then
    raise exception 'plusmedik_guard: invalid send reservation' using errcode = 'PT422';
  end if;
  select contact_key, seq, turn_kind into v_contact, v_seq, v_turn_kind from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_guard: turn not found' using errcode = 'PT404';
  end if;
  -- Imágenes y cotizaciones nunca se limitan.
  if v_turn_kind = 'IMAGE' or p_kind not in ('conversation', 'technical_issue') then
    return public.plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy);
  end if;

  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  -- Una reserva ya concedida (o un cierre) se repite igual: idempotente.
  if v_run.send_state <> 'NOT_RESERVED' then
    return public.plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy);
  end if;
  select coalesce((select state = 'HUMAN_PAUSED' from public.plusmedik_attention_contacts where contact_key = v_contact), false) into v_paused;
  -- Pausa humana / bloqueo previo, otro envío en vuelo y respuesta obsoleta: la función de turnos decide, antes que el tope.
  if v_run.send_blocked_at is not null or v_paused
     or exists (select 1 from public.plusmedik_audit_runs r where r.contact_key = v_contact and r.id <> p_run_id and r.send_state = 'RESERVED' and r.lease_expires_at > now())
     or (p_stale_policy = 'NEWER_TURN' and exists (
          select 1 from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id
          where t.contact_key = v_contact and t.seq > v_seq and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN'))) then
    return public.plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy);
  end if;

  v_now := clock_timestamp();
  v_signature := p_guard ->> 'signature';
  v_cooldown := (p_guard ->> 'cooldownSeconds')::integer;
  insert into public.plusmedik_reply_guard_state (contact_key) values (v_contact) on conflict (contact_key) do nothing;
  select * into v_state from public.plusmedik_reply_guard_state where contact_key = v_contact;
  v_since := coalesce(v_state.counted_since, '-infinity'::timestamptz);

  -- 1. Supresión vigente (por una ráfaga o una repetición anterior): no se responde hasta que caduque o se recupere.
  if v_state.suppressed_until is not null and v_state.suppressed_until > v_now then
    v_reason := 'SUPPRESSED';
  end if;

  -- 2. Ráfaga: demasiados mensajes de texto entrantes en poco tiempo (cuenta el actual).
  if v_reason is null then
    select count(*) into v_count from public.plusmedik_turns t
    where t.contact_key = v_contact and t.turn_kind in ('TEXT', 'OTHER') and t.created_at > v_since
      and t.created_at > v_now - make_interval(secs => (p_guard #>> '{burst,windowSeconds}')::integer);
    if v_count >= (p_guard #>> '{burst,max}')::integer then
      v_reason := 'LOOP_SUSPECTED';
      update public.plusmedik_reply_guard_state set suppressed_until = v_now + make_interval(secs => v_cooldown), reason = 'LOOP_BURST', updated_at = v_now where contact_key = v_contact;
      insert into public.plusmedik_reply_guard_events (contact_key, run_id, kind, detail) values (v_contact, p_run_id, 'LOOP_SUSPECTED',
        jsonb_build_object('signal', 'BURST', 'count', v_count, 'windowSeconds', (p_guard #>> '{burst,windowSeconds}')::integer, 'max', (p_guard #>> '{burst,max}')::integer, 'cooldownSeconds', v_cooldown));
    end if;
  end if;

  -- 3. Repetición: la misma respuesta (firma) ya se dio demasiadas veces a este contacto en la ventana.
  if v_reason is null and v_signature is not null then
    select count(*) into v_count from public.plusmedik_reply_guard_marks m join public.plusmedik_audit_runs r on r.id = m.run_id
    where m.contact_key = v_contact and m.signature = v_signature and m.created_at > v_since
      and m.created_at > v_now - make_interval(secs => (p_guard #>> '{repeat,windowSeconds}')::integer)
      and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN');
    if v_count >= (p_guard #>> '{repeat,max}')::integer then
      v_reason := 'REPEAT_SUSPECTED';
      update public.plusmedik_reply_guard_state set suppressed_until = v_now + make_interval(secs => v_cooldown), reason = 'LOOP_REPEAT', updated_at = v_now where contact_key = v_contact;
      insert into public.plusmedik_reply_guard_events (contact_key, run_id, kind, detail) values (v_contact, p_run_id, 'REPEAT_SUSPECTED',
        jsonb_build_object('signal', 'REPEAT', 'signature', v_signature, 'count', v_count, 'windowSeconds', (p_guard #>> '{repeat,windowSeconds}')::integer, 'max', (p_guard #>> '{repeat,max}')::integer, 'cooldownSeconds', v_cooldown));
    end if;
  end if;

  -- 4. Tope por contacto y ventana (deslizante: se libera sola). Cualquier regla excedida limita.
  if v_reason is null then
    for v_rule in select * from jsonb_array_elements(p_guard -> 'rules') loop
      select count(*) into v_count from public.plusmedik_audit_runs r join public.plusmedik_turns t on t.run_id = r.id
      where r.contact_key = v_contact and t.turn_kind in ('TEXT', 'OTHER') and r.send_kind in ('conversation', 'technical_issue')
        and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN') and r.send_reserved_at > v_since
        and r.send_reserved_at > v_now - make_interval(secs => (v_rule ->> 'windowSeconds')::integer);
      if v_count >= (v_rule ->> 'max')::integer then
        v_reason := 'RATE_LIMITED';
        -- Un solo registro por ventana: no se llena la bitácora con cada mensaje de un contacto ya limitado.
        if not exists (select 1 from public.plusmedik_reply_guard_events e where e.contact_key = v_contact and e.kind = 'RATE_LIMITED'
                       and e.created_at > v_now - make_interval(secs => (v_rule ->> 'windowSeconds')::integer)) then
          insert into public.plusmedik_reply_guard_events (contact_key, run_id, kind, detail) values (v_contact, p_run_id, 'RATE_LIMITED',
            jsonb_build_object('rule', v_index, 'count', v_count, 'windowSeconds', (v_rule ->> 'windowSeconds')::integer, 'max', (v_rule ->> 'max')::integer));
        end if;
        exit;
      end if;
      v_index := v_index + 1;
    end loop;
  end if;

  if v_reason is not null then
    perform public.plusmedik_audit_prove(p_run_id, p_fence);
    update public.plusmedik_audit_runs set
      send_state = 'CANCELLED',
      send_blocked_at = coalesce(send_blocked_at, now()),
      send_block_reason = coalesce(send_block_reason, v_reason),
      processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
      completed_at = coalesce(completed_at, now()),
      lease_expires_at = now()
    where id = p_run_id;
    perform set_config('plusmedik.fence_proof', '', true);
    return jsonb_build_object('status', 'limited', 'reason', v_reason);
  end if;

  v_result := public.plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy);
  if v_result ->> 'status' = 'reserved' and v_signature is not null then
    insert into public.plusmedik_reply_guard_marks (run_id, contact_key, signature) values (p_run_id, v_contact, v_signature) on conflict (run_id) do nothing;
  end if;
  return v_result;
end $$;

-- ───────────────────────── recuperación y consulta ─────────────────────────
-- Levanta la supresión de un contacto y reinicia el conteo (los envíos anteriores dejan de contar). No toca la pausa humana ni borra nada. Deja el registro RECOVERED con quién (código).
create or replace function public.plusmedik_reply_guard_reset(p_contact_key text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_had boolean;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' or p_actor is null or p_actor !~ '^[A-Za-z0-9_.:-]{3,64}$' then
    raise exception 'plusmedik_guard: invalid reset' using errcode = 'PT422';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = p_contact_key for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  insert into public.plusmedik_reply_guard_state (contact_key) values (p_contact_key) on conflict (contact_key) do nothing;
  select suppressed_until is not null and suppressed_until > v_now into v_had from public.plusmedik_reply_guard_state where contact_key = p_contact_key;
  update public.plusmedik_reply_guard_state set suppressed_until = null, reason = null, counted_since = v_now, updated_at = v_now where contact_key = p_contact_key;
  insert into public.plusmedik_reply_guard_events (contact_key, kind, detail) values (p_contact_key, 'RECOVERED', jsonb_build_object('actor', p_actor, 'hadSuppression', v_had));
  return jsonb_build_object('status', 'reset', 'hadSuppression', v_had);
end $$;

create or replace function public.plusmedik_reply_guard_status(p_contact_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state public.plusmedik_reply_guard_state%rowtype;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' then
    raise exception 'plusmedik_guard: invalid status query' using errcode = 'PT422';
  end if;
  select * into v_state from public.plusmedik_reply_guard_state where contact_key = p_contact_key;
  return jsonb_build_object(
    'suppressedUntil', case when v_state.suppressed_until > clock_timestamp() then v_state.suppressed_until end,
    'reason', case when v_state.suppressed_until > clock_timestamp() then v_state.reason end,
    'countedSince', v_state.counted_since,
    'events', coalesce((select jsonb_agg(row_to_json(x)::jsonb) from (
      select e.kind, e.detail, e.run_id as "runId", e.created_at as "createdAt" from public.plusmedik_reply_guard_events e
      where e.contact_key = p_contact_key order by e.created_at desc, e.id limit 20) x), '[]'::jsonb));
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_reply_guard_state_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_reply_guard_int(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_reply_guard_valid(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_turn_reserve_send_guarded(uuid, text, bigint, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_reply_guard_reset(text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_reply_guard_status(text) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_reserve_send_guarded(uuid, text, bigint, text, integer, text, jsonb) to service_role;
grant execute on function public.plusmedik_reply_guard_reset(text, text) to service_role;
grant execute on function public.plusmedik_reply_guard_status(text) to service_role;

comment on function public.plusmedik_turn_reserve_send_guarded(uuid, text, bigint, text, integer, text, jsonb) is 'Reserva de envío de un turno con tope de respuestas por contacto y ventana y detección de ráfagas y repeticiones (solo conversación). Con p_guard nulo es la reserva de turnos. Solo service_role.';
comment on function public.plusmedik_reply_guard_reset(text, text) is 'Levanta la supresión por bucle de un contacto y reinicia el conteo de envíos; deja registro. No toca la pausa humana. Solo service_role.';
comment on function public.plusmedik_reply_guard_status(text) is 'Supresión vigente y últimos eventos de la guarda de un contacto. Solo service_role.';
