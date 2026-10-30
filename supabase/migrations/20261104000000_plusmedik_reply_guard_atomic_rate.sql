-- MIGRACIÓN 16: cuota de respuestas atómica por contacto.
-- Aplicar SOLAMENTE después de las 15 migraciones anteriores y después de
-- aprobar pruebas. Nunca editar ni reaplicar retrospectivamente migración 10.
-- La tabla guarda únicamente tiempos numéricos y códigos, jamás teléfonos,
-- contenido médico ni texto de WhatsApp.

create table if not exists public.plusmedik_guard_rate_ledger (
  contact_key text primary key references public.plusmedik_contact_turns(contact_key),
  state jsonb not null default '{"slots":[],"allowed":true}'::jsonb,
  constraint plusmedik_guard_rate_ledger_shape check (
    jsonb_typeof(state) = 'object'
    and jsonb_typeof(state -> 'slots') = 'array'
    and jsonb_array_length(state -> 'slots') <= 1000
    and pg_column_size(state) < 64000
  )
);
alter table public.plusmedik_guard_rate_ledger enable row level security;
revoke all on table public.plusmedik_guard_rate_ledger from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_guard_rate_ledger from service_role;
grant select on table public.plusmedik_guard_rate_ledger to service_role;

-- Rescatar como máximo los últimos 1000 envíos conversacionales ya existentes:
-- una instalación viva NO recupera artificialmente la cuota al actualizar.
with recent as (
  select r.contact_key, r.id as run_id, extract(epoch from r.send_reserved_at) as ts,
    row_number() over (partition by r.contact_key order by r.send_reserved_at desc, r.id) as rn
  from public.plusmedik_audit_runs r
  join public.plusmedik_turns t on t.run_id = r.id
  left join public.plusmedik_reply_guard_state s on s.contact_key = r.contact_key
  where t.turn_kind in ('TEXT','OTHER')
    and r.send_kind in ('conversation','technical_issue')
    and r.send_state in ('RESERVED','ACCEPTED','UNKNOWN')
    and r.send_reserved_at > clock_timestamp() - interval '24 hours'
    and (s.counted_since is null or r.send_reserved_at > s.counted_since)
)
insert into public.plusmedik_guard_rate_ledger (contact_key, state)
select contact_key, jsonb_build_object('slots',jsonb_agg(jsonb_build_object('r',run_id,'t',ts) order by ts), 'allowed',true)
from recent where rn <= 1000 group by contact_key
on conflict (contact_key) do nothing;

-- Función privada y pura: filtra los tiempos expirados o anteriores al último
-- reset y aplica cada regla. No puede ser invocada por el cliente.
create or replace function public.plusmedik_guard_rate_decide(
  p_previous jsonb, p_rules jsonb, p_now timestamptz, p_since timestamptz, p_run_id uuid
) returns jsonb language plpgsql immutable set search_path = ''
as $$
declare
  v_slots jsonb := '[]'::jsonb;
  v_now numeric := extract(epoch from p_now);
  v_since numeric := case when p_since is null then null else extract(epoch from p_since) end;
  v_item jsonb;
  v_time numeric;
  v_rule jsonb;
  v_rule_index integer := 0;
  v_count integer;
  v_seconds integer;
  v_max integer;
begin
  for v_item in select value from jsonb_array_elements(coalesce(p_previous -> 'slots', '[]'::jsonb)) loop
    v_time := (v_item ->> 't')::numeric;
    if v_time > v_now - 86400 and (v_since is null or v_time > v_since) then
      v_slots := v_slots || jsonb_build_array(v_item);
    end if;
  end loop;

  for v_rule in select value from jsonb_array_elements(p_rules) loop
    v_seconds := (v_rule ->> 'windowSeconds')::integer;
    v_max := (v_rule ->> 'max')::integer;
    select count(*) into v_count from jsonb_array_elements_text(v_slots) x(ts)
      where (x.ts::jsonb ->> 't')::numeric > v_now - v_seconds;
    if v_count >= v_max then
      return jsonb_build_object(
        'slots',v_slots, 'allowed',false, 'count',v_count,
        'windowSeconds',v_seconds, 'max',v_max, 'rule',v_rule_index
      );
    end if;
    v_rule_index := v_rule_index + 1;
  end loop;

  return jsonb_build_object('slots', v_slots || jsonb_build_array(jsonb_build_object('r',p_run_id,'t',v_now)), 'allowed',true);
end $$;
revoke all on function public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamptz,timestamptz,uuid) from public, anon, authenticated;

-- Migración idempotente: sustituye SOLO la función existente y mantiene
-- exactamente la misma firma, parámetros, roles y bloqueo por atención humana.

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
  v_rate_state jsonb;
  v_rule_seconds integer;
  v_rule_max integer;
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
  -- No delegar una rama BUSY directamente a turn_reserve_send:
  -- entre esta comprobación y su segunda consulta, el envío en vuelo puede
  -- terminar y turn_reserve_send devolver RESERVED sin comprobar la cuota.
  -- En tal caso se debe responder BUSY y reintentar bajo la guarda.
  if exists (select 1 from public.plusmedik_audit_runs r
             where r.contact_key = v_contact and r.id <> p_run_id
               and r.send_state = 'RESERVED' and r.lease_expires_at > now()) then
    return jsonb_build_object('status','busy');
  end if;
  -- Las rutas de prioridad mantienen su semántica anterior, pero NUNCA
  -- conceden una reserva sin pasar por la cuota.
  if v_run.send_blocked_at is not null or v_paused
     or (p_stale_policy = 'NEWER_TURN' and exists (
          select 1 from public.plusmedik_turns t join public.plusmedik_audit_runs r on r.id = t.run_id
          where t.contact_key = v_contact and t.seq > v_seq and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN'))) then
    v_result := public.plusmedik_turn_reserve_send(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy);
    if v_result ->> 'status' = 'reserved' then
      raise exception 'plusmedik_guard: priority state changed; retry' using errcode = 'PT409';
    end if;
    return v_result;
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

  -- G5.9 / migración 16: cuota deslizante atómica.
  -- ON CONFLICT DO UPDATE opera sobre la última versión de la fila (incluso
  -- bajo concurrencia READ COMMITTED); el valor devuelto se deriva de ESE estado,
  -- no de un COUNT con snapshot anterior a la espera del bloqueo.
  if v_reason is null then
    insert into public.plusmedik_guard_rate_ledger (contact_key, state)
    values (v_contact, public.plusmedik_guard_rate_decide('{}'::jsonb, p_guard -> 'rules', v_now, v_since, p_run_id))
    on conflict (contact_key) do update
      set state = public.plusmedik_guard_rate_decide(public.plusmedik_guard_rate_ledger.state, p_guard -> 'rules', v_now, v_since, p_run_id)
    returning state into v_rate_state;

    if v_rate_state ->> 'allowed' = 'false' then
      v_reason := 'RATE_LIMITED';
      v_count := (v_rate_state ->> 'count')::integer;
      v_rule_seconds := (v_rate_state ->> 'windowSeconds')::integer;
      v_rule_max := (v_rate_state ->> 'max')::integer;
      v_index := (v_rate_state ->> 'rule')::integer;
      -- Un único evento por ventana, igual que G3.2.
      if not exists (
        select 1 from public.plusmedik_reply_guard_events e
        where e.contact_key = v_contact and e.kind = 'RATE_LIMITED'
          and e.created_at > v_now - make_interval(secs => v_rule_seconds)
      ) then
        insert into public.plusmedik_reply_guard_events (contact_key, run_id, kind, detail)
          values (v_contact, p_run_id, 'RATE_LIMITED', jsonb_build_object(
            'rule', v_index, 'count', v_count, 'windowSeconds', v_rule_seconds, 'max', v_rule_max
          ));
      end if;
    end if;
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
  if v_result ->> 'status' <> 'reserved' then
    -- No se envió ni se reservó: devolver el hueco, dentro de la misma
    -- transacción, mientras la fila de cuota sigue bloqueada.
    update public.plusmedik_guard_rate_ledger
      set state = jsonb_set(
        state, '{slots}',
        coalesce((
          select jsonb_agg(e.value)
          from jsonb_array_elements(state -> 'slots') e
          where e.value ->> 'r' is distinct from p_run_id::text
        ), '[]'::jsonb)
      )
    where contact_key = v_contact;
    return v_result;
  end if;
  if v_signature is not null then
    insert into public.plusmedik_reply_guard_marks (run_id, contact_key, signature) values (p_run_id, v_contact, v_signature) on conflict (run_id) do nothing;
  end if;
  return v_result;
end $$;

revoke all on function public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb) to service_role;
comment on table public.plusmedik_guard_rate_ledger is 'Estado interno de la cuota deslizante, un registro por contacto, sin contenido del paciente. Solo la función con privilegios puede modificarlo.';
