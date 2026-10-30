-- POSTFLIGHT migración 16 G3.2: SOLO LECTURA.
-- Ejecutar solamente DESPUÉS de aplicar 20261104000000_plusmedik_reply_guard_atomic_rate.sql
-- en el Supabase de PlusMedik. No cambia tablas, funciones, permisos ni registros.
-- No devuelve teléfonos, contactos, mensajes, recetas ni IDs.

with checks as (
  select 10 as n, 'Tabla de cuota atómica'::text as comprobacion,
    (to_regclass('public.plusmedik_guard_rate_ledger') is not null)::text as resultado,
    'true'::text as esperado,
    case when to_regclass('public.plusmedik_guard_rate_ledger') is not null then 'OK' else 'BLOCK' end as estado
  union all
  select 11, 'RLS activo en ledger',
    coalesce((select relrowsecurity::text from pg_class where oid = to_regclass('public.plusmedik_guard_rate_ledger')), 'false'),
    'true', case when (select relrowsecurity from pg_class where oid = to_regclass('public.plusmedik_guard_rate_ledger')) then 'OK' else 'BLOCK' end
  union all
  select 12, 'Permiso lectura service_role (sin escritura)',
    (has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'SELECT')
      and not has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'INSERT')
      and not has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'UPDATE')
      and not has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'DELETE'))::text,
    'true', case when
      has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'SELECT')
      and not has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'INSERT')
      and not has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'UPDATE')
      and not has_table_privilege('service_role', to_regclass('public.plusmedik_guard_rate_ledger'), 'DELETE')
    then 'OK' else 'BLOCK' end
  union all
  select 13, 'Sin lectura para anon ni authenticated',
    (not has_table_privilege('anon', to_regclass('public.plusmedik_guard_rate_ledger'), 'SELECT')
      and not has_table_privilege('authenticated', to_regclass('public.plusmedik_guard_rate_ledger'), 'SELECT'))::text,
    'true', case when
      not has_table_privilege('anon', to_regclass('public.plusmedik_guard_rate_ledger'), 'SELECT')
      and not has_table_privilege('authenticated', to_regclass('public.plusmedik_guard_rate_ledger'), 'SELECT')
    then 'OK' else 'BLOCK' end
  union all
  select 20, 'Función privada de decisión atómica existe',
    (to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)') is not null)::text,
    'true', case when to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)') is not null then 'OK' else 'BLOCK' end
  union all
  select 21, 'Función auxiliar no ejecutable por anon/authenticated/PUBLIC',
    (not has_function_privilege('anon', to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)'), 'EXECUTE')
      and not has_function_privilege('authenticated', to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)'), 'EXECUTE')
      and not exists (
        select 1 from pg_proc pr
        cross join lateral aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) acl
        where pr.oid = to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)')
          and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      ))::text,
    'true', case when
      not has_function_privilege('anon', to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)'), 'EXECUTE')
      and not has_function_privilege('authenticated', to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)'), 'EXECUTE')
      and not exists (
        select 1 from pg_proc pr
        cross join lateral aclexplode(coalesce(pr.proacl, acldefault('f', pr.proowner))) acl
        where pr.oid = to_regprocedure('public.plusmedik_guard_rate_decide(jsonb,jsonb,timestamp with time zone,timestamp with time zone,uuid)')
          and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
    then 'OK' else 'BLOCK' end
  union all
  select 22, 'Guarda de reservas autorizada solo a service_role',
    (has_function_privilege('service_role', to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE')
      and not has_function_privilege('anon', to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE')
      and not has_function_privilege('authenticated', to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE'))::text,
    'true', case when
      has_function_privilege('service_role', to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE')
      and not has_function_privilege('anon', to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE')
      and not has_function_privilege('authenticated', to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE')
    then 'OK' else 'BLOCK' end
  union all
  select 23, 'Guarda sigue SECURITY DEFINER con search_path fijo',
    coalesce((select (prosecdef and 'search_path=' = any(array(select split_part(x,'=',1) || '=' from unnest(proconfig) x)))::text
       from pg_proc where oid = to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)')), 'false'),
    'true', case when exists (
      select 1 from pg_proc p where p.oid = to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)')
        and p.prosecdef and 'search_path=' = any(array(select split_part(x,'=',1) || '=' from unnest(p.proconfig) x))
    ) then 'OK' else 'BLOCK' end
  union all
  select 30, 'Filas actuales en ledger (puede aumentar con actividad)',
    (select count(*)::text from public.plusmedik_guard_rate_ledger),
    'informativo', 'INFO'
  union all
  select 31, 'Filas con más de 1000 cupos o estructura inválida',
    (select count(*)::text from public.plusmedik_guard_rate_ledger
      where jsonb_typeof(state) <> 'object'
         or jsonb_typeof(state -> 'slots') <> 'array'
         or jsonb_array_length(state -> 'slots') > 1000),
    '0', case when (select count(*) from public.plusmedik_guard_rate_ledger
      where jsonb_typeof(state) <> 'object'
         or jsonb_typeof(state -> 'slots') <> 'array'
         or jsonb_array_length(state -> 'slots') > 1000) = 0 then 'OK' else 'BLOCK' end
)
select n, comprobacion, coalesce(resultado,'null') as resultado, esperado, estado from checks
union all
select 0, 'VEREDICTO',
  case when count(*) filter (where estado = 'BLOCK') = 0 then 'OK' else 'BLOCK' end,
  'BLOCK=0',
  'INFO' from checks
order by n;
