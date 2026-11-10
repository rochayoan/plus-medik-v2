-- PlusMedik V2 — verificación de la migración 20 (plusmedik_quote_shadow_peek) DESPUÉS de aplicarla (solo lectura).
-- SOLO LECTURA: una sola sentencia SELECT. No contiene DDL ni DML y no escribe nada: lo único que ejecuta además de leer el catálogo del sistema es UNA llamada a la propia función con un identificador
-- de corrida inexistente (que, por ser STABLE, la base no deja escribir), y solo si la función existe.
-- Ejecutar exclusivamente en el proyecto Supabase cvokrtrdzxfchntwwslz (verificar el identificador en la URL del panel ANTES de ejecutar), con el rol administrativo del SQL Editor.
-- Esperado: TODAS las filas con estado OK y la última fila (VEREDICTO) en OK. Cualquier FALLA: no activar PLUSMEDIK_BATCH_ENGINE=shadow y avisar.
-- Antes de aplicar la migración, la fila 1 sale FALLA y el resto INFO/FALLA: es lo esperado.
-- Para ejecutarla dentro de una transacción de solo lectura: begin read only; <este SELECT>; rollback;

with f as (
  select to_regprocedure('public.plusmedik_quote_shadow_peek(uuid,text,bigint,integer)') as oid
),
p as (
  select pr.oid, pr.provolatile, pr.prosecdef, pr.proconfig, pr.proacl, pr.proowner, pg_get_userbyid(pr.proowner) as owner_name, pg_get_functiondef(pr.oid) as def
  from f join pg_proc pr on pr.oid = f.oid
),
grantees as (
  select distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee
  from p cross join lateral aclexplode(p.proacl) a
  where a.privilege_type = 'EXECUTE'
),
checks(n, check_name, expected, actual, ok) as (
  select 1, 'la función existe con la firma (uuid, text, bigint, integer)', 'sí', case when (select oid from f) is not null then 'sí' else 'no' end, (select oid from f) is not null
  union all select 2, 'es STABLE (la base impide que escriba o bloquee filas)', 's', coalesce((select provolatile::text from p), '-'), coalesce((select provolatile = 's' from p), false)
  union all select 3, 'es SECURITY DEFINER', 'true', coalesce((select prosecdef::text from p), '-'), coalesce((select prosecdef from p), false)
  union all select 4, 'search_path vacío', 'search_path=""', coalesce((select array_to_string(proconfig, ',') from p), '-'), coalesce((select 'search_path=""' = any (proconfig) from p), false)
  union all select 5, 'anon NO puede ejecutarla', 'false', coalesce((select has_function_privilege('anon', (select oid from f), 'EXECUTE')::text from p), '-'), coalesce((select not has_function_privilege('anon', (select oid from f), 'EXECUTE') from p), false)
  union all select 6, 'authenticated NO puede ejecutarla', 'false', coalesce((select has_function_privilege('authenticated', (select oid from f), 'EXECUTE')::text from p), '-'), coalesce((select not has_function_privilege('authenticated', (select oid from f), 'EXECUTE') from p), false)
  union all select 7, 'service_role SÍ puede ejecutarla', 'true', coalesce((select has_function_privilege('service_role', (select oid from f), 'EXECUTE')::text from p), '-'), coalesce((select has_function_privilege('service_role', (select oid from f), 'EXECUTE') from p), false)
  union all select 8, 'PUBLIC no tiene EXECUTE (la lista de privilegios es explícita)', 'false', coalesce((select (proacl is null or exists (select 1 from grantees where grantee = 'PUBLIC'))::text from p), '-'), coalesce((select proacl is not null and not exists (select 1 from grantees where grantee = 'PUBLIC') from p), false)
  union all select 9, 'solo el dueño y service_role tienen EXECUTE', 'service_role + dueño', coalesce((select string_agg(grantee, ' + ' order by grantee) from grantees), '-'),
    coalesce((select not exists (select 1 from grantees g where g.grantee <> 'service_role' and g.grantee <> (select owner_name from p)) from p), false)
  union all select 10, 'no menciona el esquema crm ni lab_tests', 'false', coalesce((select (def ~* '\mcrm\.|\mlab_tests\M')::text from p), '-'), coalesce((select def !~* '\mcrm\.|\mlab_tests\M' from p), false)
  union all select 11, 'todo lo que nombra es de public.plusmedik_* (sin dependencias fuera de PlusMedik)', 'true', coalesce((select (def !~ 'public\.(?!plusmedik_)')::text from p), '-'), coalesce((select def !~ 'public\.(?!plusmedik_)' from p), false)
  union all select 12, 'prerrequisito: migración 19 (plusmedik_turn_fold) presente', 'sí', case when to_regprocedure('public.plusmedik_turn_fold(uuid,text,bigint)') is not null then 'sí' else 'no' end, to_regprocedure('public.plusmedik_turn_fold(uuid,text,bigint)') is not null
  union all select 13, 'prerrequisito: migración 11/14 (plusmedik_quote_pending_before y plusmedik_quote_session_read)', 'sí',
    case when to_regprocedure('public.plusmedik_quote_pending_before(text,bigint)') is not null and to_regprocedure('public.plusmedik_quote_session_read(uuid,text,bigint)') is not null then 'sí' else 'no' end,
    to_regprocedure('public.plusmedik_quote_pending_before(text,bigint)') is not null and to_regprocedure('public.plusmedik_quote_session_read(uuid,text,bigint)') is not null
  union all select 14, 'prerrequisito: tablas de turnos, corridas, sesiones, ítems y resultados', 'sí',
    case when to_regclass('public.plusmedik_turns') is not null and to_regclass('public.plusmedik_audit_runs') is not null and to_regclass('public.plusmedik_quote_sessions') is not null
          and to_regclass('public.plusmedik_quote_items') is not null and to_regclass('public.plusmedik_quote_results') is not null then 'sí' else 'no' end,
    to_regclass('public.plusmedik_turns') is not null and to_regclass('public.plusmedik_audit_runs') is not null and to_regclass('public.plusmedik_quote_sessions') is not null
      and to_regclass('public.plusmedik_quote_items') is not null and to_regclass('public.plusmedik_quote_results') is not null
  -- Prueba funcional sin efectos: un identificador de corrida inexistente debe responder "unavailable" sin tocar nada. Solo se ejecuta si la función existe (CASE).
  union all select 15, 'llamada con una corrida inexistente responde unavailable (sin escribir)', 'unavailable',
    case when (select oid from f) is not null
         then coalesce((xpath('/row/state/text()', query_to_xml('select public.plusmedik_quote_shadow_peek(''00000000-0000-4000-8000-000000000000''::uuid, ''owner-00000001'', 1, 86400)->>''state'' as state', false, true, '')))[1]::text, '-')
         else '-' end,
    case when (select oid from f) is not null
         then coalesce((xpath('/row/state/text()', query_to_xml('select public.plusmedik_quote_shadow_peek(''00000000-0000-4000-8000-000000000000''::uuid, ''owner-00000001'', 1, 86400)->>''state'' as state', false, true, '')))[1]::text, '-') = 'unavailable'
         else false end
)
select n, check_name, expected, actual, case when ok then 'OK' else 'FALLA' end as estado
from checks
union all
select 99, 'VEREDICTO', 'todas OK', (select count(*) filter (where ok) || ' de ' || count(*) from checks), case when (select bool_and(ok) from checks) then 'OK' else 'FALLA' end
order by n;
