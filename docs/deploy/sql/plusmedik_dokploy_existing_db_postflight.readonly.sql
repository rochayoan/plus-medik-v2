-- PLUSMEDIK V2 / DOKPLOY: POSTCHECK, READ ONLY, NO PATIENT DATA
-- Run only AFTER reviewed additive inbox SQL on the existing PlusMedik Supabase.
-- Do not run any live WhatsApp tests or modify Kapso until every BLOCK is solved.
with objects as (
  select to_regclass('public.plusmedik_dokploy_inbox') as inbox
),
checks (ord, check_name, ok) as (
  select 10, 'Inbox table exists',
    (select inbox is not null from objects)
  union all select 11, 'Inbox RLS enabled',
    coalesce((select relrowsecurity from pg_class where oid=(select inbox from objects)),false)
  union all select 12, 'Service role may read and write inbox',
    coalesce(has_table_privilege('service_role',(select inbox from objects),'SELECT'),false)
    and coalesce(has_table_privilege('service_role',(select inbox from objects),'INSERT'),false)
    and coalesce(has_table_privilege('service_role',(select inbox from objects),'UPDATE'),false)
  union all select 13, 'Anon and authenticated cannot read inbox',
    not coalesce(has_table_privilege('anon',(select inbox from objects),'SELECT'),false)
    and not coalesce(has_table_privilege('authenticated',(select inbox from objects),'SELECT'),false)
  union all select 14, 'Anon and authenticated cannot write inbox',
    not coalesce(has_table_privilege('anon',(select inbox from objects),'INSERT'),false)
    and not coalesce(has_table_privilege('authenticated',(select inbox from objects),'INSERT'),false)
    and not coalesce(has_table_privilege('anon',(select inbox from objects),'UPDATE'),false)
    and not coalesce(has_table_privilege('authenticated',(select inbox from objects),'UPDATE'),false)
  union all select 15, 'No public DELETE or TRUNCATE privilege',
    not coalesce(has_table_privilege('anon',(select inbox from objects),'DELETE'),false)
    and not coalesce(has_table_privilege('authenticated',(select inbox from objects),'DELETE'),false)
    and not coalesce(has_table_privilege('anon',(select inbox from objects),'TRUNCATE'),false)
    and not coalesce(has_table_privilege('authenticated',(select inbox from objects),'TRUNCATE'),false)
  union all select 20, 'Queue RPC enqueue service-role only',
    coalesce(has_function_privilege('service_role',
       to_regprocedure('public.plusmedik_dokploy_enqueue(text,text,text,text)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('anon',
       to_regprocedure('public.plusmedik_dokploy_enqueue(text,text,text,text)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('authenticated',
       to_regprocedure('public.plusmedik_dokploy_enqueue(text,text,text,text)'),'EXECUTE'),false)
  union all select 21, 'Queue RPC claim service-role only',
    coalesce(has_function_privilege('service_role',
       to_regprocedure('public.plusmedik_dokploy_claim(uuid)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('anon',
       to_regprocedure('public.plusmedik_dokploy_claim(uuid)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('authenticated',
       to_regprocedure('public.plusmedik_dokploy_claim(uuid)'),'EXECUTE'),false)
  union all select 22, 'Queue RPC renew service-role only',
    coalesce(has_function_privilege('service_role',
       to_regprocedure('public.plusmedik_dokploy_renew(uuid,uuid,integer)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('anon',
       to_regprocedure('public.plusmedik_dokploy_renew(uuid,uuid,integer)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('authenticated',
       to_regprocedure('public.plusmedik_dokploy_renew(uuid,uuid,integer)'),'EXECUTE'),false)
  union all select 23, 'Queue RPC finish service-role only',
    coalesce(has_function_privilege('service_role',
       to_regprocedure('public.plusmedik_dokploy_finish(uuid,uuid,integer,boolean)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('anon',
       to_regprocedure('public.plusmedik_dokploy_finish(uuid,uuid,integer,boolean)'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('authenticated',
       to_regprocedure('public.plusmedik_dokploy_finish(uuid,uuid,integer,boolean)'),'EXECUTE'),false)
  union all select 24, 'Queue RPC health service-role only',
    coalesce(has_function_privilege('service_role',
       to_regprocedure('public.plusmedik_dokploy_health()'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('anon',
       to_regprocedure('public.plusmedik_dokploy_health()'),'EXECUTE'),false)
    and not coalesce(has_function_privilege('authenticated',
       to_regprocedure('public.plusmedik_dokploy_health()'),'EXECUTE'),false)
  union all select 30, 'Original audit table preserved',
    to_regclass('public.plusmedik_audit_runs') is not null
  union all select 31, 'Original reply guard preserved',
    to_regclass('public.plusmedik_guard_rate_ledger') is not null
)
select ord as orden, check_name as comprobacion,
  case when ok then 'OK' else 'BLOCK' end as estado
from checks
order by ord;
