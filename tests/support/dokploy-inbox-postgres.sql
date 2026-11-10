-- Dokploy isolated DB test: no Supabase remote access, no patient data.
-- Invoked only after docs/deploy/sql/plusmedik_dokploy_inbox.staging.sql
-- has been loaded into a throwaway PostgreSQL 16 instance.
begin;
set local role service_role;
do $block$
declare
  v_id uuid;
  v_duplicate uuid;
  v_row record;
  v_next record;
  v_status text;
  v_ciphertext text;
  v_count bigint;
  v_owner uuid := '00000000-0000-4000-8000-000000000001';
  v_other uuid := '00000000-0000-4000-8000-000000000002';
begin
  v_id := public.plusmedik_dokploy_enqueue(repeat('a',64),'AAAAAAAA','BBBBBBBB','CCCCCCCC');
  v_duplicate := public.plusmedik_dokploy_enqueue(repeat('a',64),'AAAAAAAA','BBBBBBBB','CCCCCCCC');
  if v_id is null or v_duplicate is distinct from v_id then
    raise exception 'duplicate webhook created multiple inbox entries';
  end if;
  select count(*) into v_count from public.plusmedik_dokploy_inbox where payload_sha256=repeat('a',64);
  if v_count <> 1 then raise exception 'expected exactly one row'; end if;

  select * into v_row from public.plusmedik_dokploy_claim(v_owner);
  if v_row.job_id is distinct from v_id or v_row.job_generation <> 1 then
    raise exception 'first lease claim failed';
  end if;

  -- Another worker cannot claim the same leased event.
  select * into v_next from public.plusmedik_dokploy_claim(v_other);
  if found then raise exception 'concurrent claim acquired leased event'; end if;

  if public.plusmedik_dokploy_finish(v_id,v_other,v_row.job_generation,true)
    or public.plusmedik_dokploy_renew(v_id,v_other,v_row.job_generation)
    or public.plusmedik_dokploy_finish(v_id,v_owner,v_row.job_generation+1,true) then
    raise exception 'invalid owner or fence could mutate lease';
  end if;

  if not public.plusmedik_dokploy_renew(v_id,v_owner,v_row.job_generation) then
    raise exception 'valid worker could not renew lease';
  end if;
  if not public.plusmedik_dokploy_finish(v_id,v_owner,v_row.job_generation,true) then
    raise exception 'valid worker could not finish job';
  end if;
  if public.plusmedik_dokploy_finish(v_id,v_owner,v_row.job_generation,true) then
    raise exception 'replayed finish unexpectedly succeeded';
  end if;

  select status,ciphertext_b64 into v_status,v_ciphertext
    from public.plusmedik_dokploy_inbox where id=v_id;
  if v_status <> 'completed' or v_ciphertext is not null then
    raise exception 'finished job retained encrypted payload';
  end if;
  v_duplicate := public.plusmedik_dokploy_enqueue(repeat('a',64),'AAAAAAAA','BBBBBBBB','CCCCCCCC');
  if v_duplicate is distinct from v_id then
    raise exception 'duplicate event re-enqueued after completion';
  end if;
  select * into v_next from public.plusmedik_dokploy_claim(v_other);
  if found then raise exception 'completed event was reclaimed'; end if;
end $block$;
rollback;

-- Privileges must be absent even if RLS policies change later.
select case
  when has_table_privilege('anon','public.plusmedik_dokploy_inbox','SELECT')
    or has_table_privilege('authenticated','public.plusmedik_dokploy_inbox','SELECT')
    or has_function_privilege('anon','public.plusmedik_dokploy_claim(uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.plusmedik_dokploy_enqueue(text,text,text,text)','EXECUTE')
  then 1 else 0
end as public_access_violation;
