-- PLUSMEDIK V2 / DOKPLOY: PRECHECK EXISTING SUPABASE, READ ONLY
-- Check dashboard project ref is cvokrtrdzxfchntwwslz before running.
-- Never execute against the CRM's different Supabase project.
-- Single SELECT: no DDL, no DML, no patient records, no phone numbers.
-- Expected on the current production database:
--   Every REQUIRED row = OK;
--   Dokploy queue rows = INFO (not installed yet);
--   Every BLOCK must be investigated before applying additive SQL.

with checks (ord, component, status, detail) as (
  select 10, 'Catálogo: lab_tests',
    case when to_regclass('public.lab_tests') is not null then 'OK' else 'BLOCK' end,
    'Tabla existente; no se lee su contenido'
  union all select 11, 'Catálogo: lab_test_aliases',
    case when to_regclass('public.lab_test_aliases') is not null then 'OK' else 'BLOCK' end,
    'Sin lectura de estudios ni precios'
  union all select 20, 'Auditoría: plusmedik_audit_runs',
    case when to_regclass('public.plusmedik_audit_runs') is not null then 'OK' else 'BLOCK' end,
    'Requisito para deduplicación y envíos seguros'
  union all select 21, 'Turnos: plusmedik_turns',
    case when to_regclass('public.plusmedik_turns') is not null then 'OK' else 'BLOCK' end,
    'Migration 6'
  union all select 22, 'Sesiones: plusmedik_quote_sessions',
    case when to_regclass('public.plusmedik_quote_sessions') is not null then 'OK' else 'BLOCK' end,
    'Migration 11'
  union all select 23, 'Guarda: plusmedik_guard_rate_ledger',
    case when to_regclass('public.plusmedik_guard_rate_ledger') is not null then 'OK' else 'BLOCK' end,
    'Migration 16'
  union all select 30, 'Guarda atómica: reserva autorizada',
    case when to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)') is not null then 'OK' else 'BLOCK' end,
    'La función debe existir'
  union all select 31, 'Guarda atómica: permisos service_role',
    case when coalesce(has_function_privilege('service_role',
      to_regprocedure('public.plusmedik_turn_reserve_send_guarded(uuid,text,bigint,text,integer,text,jsonb)'), 'EXECUTE'), false)
    then 'OK' else 'BLOCK' end,
    'Sin imprimir credenciales'
  union all select 32, 'Supabase: rol service_role',
    case when exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls)
    then 'OK' else 'BLOCK' end,
    'El rol de servidor debe tener BYPASSRLS'
  union all select 40, 'Cola Dokploy: tabla adicional',
    case when to_regclass('public.plusmedik_dokploy_inbox') is null then 'INFO' else 'WARN' end,
    'INFO = nueva tabla aún no instalada; WARN = existe y requiere inspección previa'
  union all select 41, 'Cola Dokploy: función enqueue',
    case when to_regprocedure('public.plusmedik_dokploy_enqueue(text,text,text,text)') is null then 'INFO' else 'WARN' end,
    'INFO = aún no instalada; WARN = posible instalación previa'
  union all select 42, 'Cola Dokploy: función claim',
    case when to_regprocedure('public.plusmedik_dokploy_claim(uuid)') is null then 'INFO' else 'WARN' end,
    'INFO = aún no instalada; WARN = posible instalación previa'
)
select ord as orden, component as comprobacion, status as estado, detail as detalle
from checks
order by ord;
