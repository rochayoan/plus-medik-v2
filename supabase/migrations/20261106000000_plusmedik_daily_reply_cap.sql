-- MIGRACIÓN 18: tope de respuestas del agente por contacto en una ventana móvil (por defecto 5 cada 24 horas).
-- Aplicar SOLAMENTE después de las 17 migraciones anteriores y después de aprobar pruebas. Aditiva: una función nueva; no toca tablas ni funciones existentes.
--
-- Qué cuenta: cada respuesta que el AGENTE reservó para enviar (texto, cotización, foto, aviso técnico). Cada una es una corrida de auditoría (plusmedik_audit_runs) con
-- send_state RESERVED / ACCEPTED / UNKNOWN (un envío incierto cuenta: puede haber llegado). Lo que no se envió (CANCELLED, bloqueado, sin reservar) no cuenta.
-- Lo que NO cuenta: los mensajes de las recepcionistas (desde el CRM o WhatsApp Business) no son corridas del agente, así que nunca se limitan ni se cuentan.
--
-- Cómo evita duplicados: el contador se DERIVA de las corridas (no hay un contador aparte que desincronizar), una corrida cuenta una sola vez, la reserva ya es idempotente por corrida
-- (un reintento de la misma corrida no consume otro cupo) y la comprobación ocurre con el bloqueo por contacto: dos mensajes simultáneos del mismo contacto se serializan.
-- Al llegar al tope la corrida se cancela (send_block_reason = 'DAILY_CAP') y el agente no responde hasta que las respuestas más antiguas salgan de la ventana.

create or replace function public.plusmedik_turn_reserve_send_capped(
  p_run_id uuid, p_owner text, p_fence bigint, p_kind text,
  p_lease_seconds integer, p_stale_policy text, p_guard jsonb, p_cap jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_contact text;
  v_run public.plusmedik_audit_runs%rowtype;
  v_max integer;
  v_window integer;
  v_count integer;
  v_now timestamptz;
begin
  if p_cap is null then
    return public.plusmedik_turn_reserve_send_guarded(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy, p_guard);
  end if;
  if jsonb_typeof(p_cap) <> 'object'
     or coalesce(p_cap ->> 'max', '') !~ '^[0-9]{1,4}$'
     or coalesce(p_cap ->> 'windowSeconds', '') !~ '^[0-9]{2,6}$'
     or p_kind is null or p_kind not in ('quoted','no_quote','technical_issue','conversation') then
    raise exception 'plusmedik_cap: invalid cap' using errcode = 'PT422';
  end if;
  v_max := (p_cap ->> 'max')::integer;
  v_window := (p_cap ->> 'windowSeconds')::integer;
  if v_max < 1 or v_max > 1000 or v_window < 60 or v_window > 604800 then
    raise exception 'plusmedik_cap: invalid cap' using errcode = 'PT422';
  end if;

  select contact_key into v_contact from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_cap: turn not found' using errcode = 'PT404';
  end if;

  -- Serialización por contacto y fencing, antes de contar.
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  -- Una corrida que ya fue reservada (o cancelada) no vuelve a consumir cupo: la reserva existente es idempotente.
  if v_run.send_state <> 'NOT_RESERVED' then
    return public.plusmedik_turn_reserve_send_guarded(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy, p_guard);
  end if;

  v_now := clock_timestamp();
  select count(*) into v_count
    from public.plusmedik_audit_runs r
    where r.contact_key = v_contact and r.id <> p_run_id
      and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN')
      and r.send_reserved_at > v_now - make_interval(secs => v_window);

  if v_count >= v_max then
    perform public.plusmedik_audit_prove(p_run_id, p_fence);
    update public.plusmedik_audit_runs set
      send_state = 'CANCELLED',
      send_blocked_at = coalesce(send_blocked_at, now()),
      send_block_reason = coalesce(send_block_reason, 'DAILY_CAP'),
      processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
      completed_at = coalesce(completed_at, now()),
      lease_expires_at = now()
    where id = p_run_id;
    perform set_config('plusmedik.fence_proof', '', true);
    return jsonb_build_object('status', 'limited', 'reason', 'DAILY_CAP');
  end if;

  return public.plusmedik_turn_reserve_send_guarded(p_run_id, p_owner, p_fence, p_kind, p_lease_seconds, p_stale_policy, p_guard);
end $$;

revoke all on function public.plusmedik_turn_reserve_send_capped(uuid, text, bigint, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_reserve_send_capped(uuid, text, bigint, text, integer, text, jsonb, jsonb) to service_role;
comment on function public.plusmedik_turn_reserve_send_capped(uuid, text, bigint, text, integer, text, jsonb, jsonb) is 'Reserva de envío con tope de respuestas del agente por contacto en una ventana móvil. Cuenta corridas con envío reservado/aceptado/incierto; no cuenta mensajes humanos.';
