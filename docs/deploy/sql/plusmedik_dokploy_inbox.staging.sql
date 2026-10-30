-- PlusMedik V2: Dokploy encrypted webhook inbox STAGING DRAFT, not a registered production migration.
-- Do not apply to production; promote with migration manifest & security review first.
-- This migration adds a retryable queue, NOT a webhook cutover.
-- Patient bodies are encrypted by the Node application before reaching this table.
-- No plaintext, telephone number, API key or WhatsApp message content is indexed.
create table if not exists public.plusmedik_dokploy_inbox (
  id uuid primary key default gen_random_uuid(),
  payload_sha256 text not null unique check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  iv_b64 text,
  tag_b64 text,
  ciphertext_b64 text,
  status text not null default 'pending' check (status in ('pending','leased','completed','dead')),
  attempts integer not null default 0 check (attempts between 0 and 7),
  lease_owner uuid,
  lease_generation integer not null default 0 check (lease_generation >= 0),
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((iv_b64 is null and tag_b64 is null and ciphertext_b64 is null)
     or (iv_b64 is not null and tag_b64 is not null and ciphertext_b64 is not null)),
  check (status <> 'leased' or (lease_owner is not null and lease_until is not null))
);
create index if not exists plusmedik_dokploy_inbox_work_idx on public.plusmedik_dokploy_inbox (available_at, created_at) where status='pending';
create index if not exists plusmedik_dokploy_inbox_expired_idx on public.plusmedik_dokploy_inbox (lease_until) where status='leased';
alter table public.plusmedik_dokploy_inbox enable row level security;
revoke all on table public.plusmedik_dokploy_inbox from public, anon, authenticated;
revoke all on table public.plusmedik_dokploy_inbox from service_role;
grant select, insert, update on table public.plusmedik_dokploy_inbox to service_role;

-- Atomic insert/duplicate ACK. A duplicate of a completed event is NOT requeued.
create or replace function public.plusmedik_dokploy_enqueue(
 p_sha text, p_iv text, p_tag text, p_ciphertext text
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
 if p_sha !~ '^[0-9a-f]{64}$' or length(p_iv)>80 or length(p_tag)>80
    or length(p_ciphertext)>1500000
    or p_iv is null or p_tag is null or p_ciphertext is null
    or length(p_iv)<8 or length(p_tag)<8 or length(p_ciphertext)<8 then
    raise exception 'invalid queue envelope' using errcode='P2001';
 end if;
 insert into public.plusmedik_dokploy_inbox (payload_sha256,iv_b64,tag_b64,ciphertext_b64)
 values (p_sha,p_iv,p_tag,p_ciphertext)
 on conflict (payload_sha256) do nothing
 returning id into v_id;
 if v_id is null then
   select id into v_id from public.plusmedik_dokploy_inbox where payload_sha256=p_sha;
 end if;
 return v_id;
end $$;

-- One atomic claim, short lease (300 seconds); expired leases may be taken over.
-- No payload returned by the regular REST table endpoints to anonymous users.
create or replace function public.plusmedik_dokploy_claim(p_owner uuid)
returns table(job_id uuid, job_generation integer, job_iv text, job_tag text, job_ciphertext text)
language plpgsql security invoker set search_path='' as $$
declare v_id uuid;
begin
 if p_owner is null then raise exception 'owner required' using errcode='P2001'; end if;
 -- Expired jobs that exhausted retries are quarantined, never silently discarded.
 update public.plusmedik_dokploy_inbox
 set status='dead',lease_owner=null,lease_until=null,updated_at=now()
 where status='leased' and lease_until<now() and attempts>=7;
 select i.id into v_id
 from public.plusmedik_dokploy_inbox i
 where (i.status='pending' and i.available_at<=now() and i.attempts<7)
    or (i.status='leased' and i.lease_until<now() and i.attempts<7)
 order by i.created_at,i.id
 limit 1 for update skip locked;
 if v_id is null then return; end if;
 return query
 update public.plusmedik_dokploy_inbox i
 set status='leased',lease_owner=p_owner,lease_generation=i.lease_generation+1,
     lease_until=now()+interval '300 seconds',attempts=i.attempts+1,updated_at=now()
 where i.id=v_id
 returning i.id,i.lease_generation,i.iv_b64,i.tag_b64,i.ciphertext_b64;
end $$;

create or replace function public.plusmedik_dokploy_renew(p_id uuid,p_owner uuid,p_generation integer)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.plusmedik_dokploy_inbox
 set lease_until=now()+interval '300 seconds',updated_at=now()
 where id=p_id and status='leased' and lease_owner=p_owner
   and lease_generation=p_generation and lease_until>now();
 return found;
end $$;

-- Safe fence on completion. Clear encrypted patient payload after success;
-- retain dead-letter encrypted content for bounded, manual incident review.
create or replace function public.plusmedik_dokploy_finish(
 p_id uuid,p_owner uuid,p_generation integer,p_ok boolean
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.plusmedik_dokploy_inbox
 set status=case when p_ok then 'completed' when attempts>=7 then 'dead' else 'pending' end,
     available_at=case when p_ok then available_at else now()+make_interval(secs => least(300, (5 * power(2, least(attempts,6)))::integer)) end,
     lease_owner=null,lease_until=null,updated_at=now(),
     completed_at=case when p_ok then now() else completed_at end,
     iv_b64=case when p_ok then null else iv_b64 end,
     tag_b64=case when p_ok then null else tag_b64 end,
     ciphertext_b64=case when p_ok then null else ciphertext_b64 end
 where id=p_id and status='leased' and lease_owner=p_owner
   and lease_generation=p_generation and lease_until>now();
 return found;
end $$;

-- Restrict new functions explicitly, including the default PUBLIC EXECUTE grant.
revoke all on function public.plusmedik_dokploy_enqueue(text,text,text,text) from public,anon,authenticated;
revoke all on function public.plusmedik_dokploy_claim(uuid) from public,anon,authenticated;
revoke all on function public.plusmedik_dokploy_renew(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.plusmedik_dokploy_finish(uuid,uuid,integer,boolean) from public,anon,authenticated;
grant execute on function public.plusmedik_dokploy_enqueue(text,text,text,text) to service_role;
grant execute on function public.plusmedik_dokploy_claim(uuid) to service_role;
grant execute on function public.plusmedik_dokploy_renew(uuid,uuid,integer) to service_role;
grant execute on function public.plusmedik_dokploy_finish(uuid,uuid,integer,boolean) to service_role;

-- Lightweight readiness check; fails if this migration has not been applied.
create or replace function public.plusmedik_dokploy_health()
returns boolean language plpgsql security invoker set search_path='' as $
begin
 -- Check that this RPC can actually access the queue under service_role.
 -- A constant SELECT true would report readiness even with missing table grants.
 perform 1 from public.plusmedik_dokploy_inbox limit 1;
 return true;
end $;
revoke all on function public.plusmedik_dokploy_health() from public,anon,authenticated;
grant execute on function public.plusmedik_dokploy_health() to service_role;
