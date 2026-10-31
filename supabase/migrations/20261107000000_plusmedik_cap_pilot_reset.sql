-- Optional admin-only pilot reset. Not activated until a reset row is explicitly inserted.
-- Preserve immutable audit records; five new agent reservations are allowed after exempt_before.
-- Resets expire automatically; records beyond the normal sliding window cease to matter.
create table if not exists public.plusmedik_cap_pilot_resets (
  contact_key text primary key,
  exempt_before timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint pilot_reset_expiry_check check (expires_at > exempt_before)
);
alter table public.plusmedik_cap_pilot_resets enable row level security;
revoke all on public.plusmedik_cap_pilot_resets from public, anon, authenticated, service_role;
-- No Data API role may insert, read or modify resets. Admin SQL editor (postgres) only.

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
      and r.send_reserved_at > v_now - make_interval(secs => v_window)
      and r.send_reserved_at > coalesce((select max(exempt_before) from public.plusmedik_cap_pilot_resets x
         where x.contact_key = v_contact and x.expires_at > v_now), '-infinity'::timestamptz);

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

-- Admin-only use, after verifying exact contact_key in the audit rows:
-- insert into public.plusmedik_cap_pilot_resets(contact_key, exempt_before, expires_at)
-- values ('CONFIRMED_PILOT_CONTACT_KEY', clock_timestamp(), clock_timestamp() + interval '24 hours')
-- on conflict(contact_key) do update set exempt_before=excluded.exempt_before, expires_at=excluded.expires_at;
