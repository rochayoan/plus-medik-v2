-- PlusMedik V2 · Fase 1 · auditoría SOLO LECTURA de posible historial.
-- Ejecutar únicamente en SQL Editor del proyecto PlusMedik/CRM confirmado.
-- NO muestra texto de pacientes, teléfonos, tokens ni registros de mensajes.
-- No requiere migraciones; no ejecuta DDL ni DML.
-- Ante una tabla ausente, devuelve [] (no falla).

with
matches as (
  select n.nspname as schema_name, c.relname as table_name, c.oid,
         case c.relkind when 'r' then 'TABLE'
                        when 'p' then 'PARTITIONED_TABLE'
                        when 'v' then 'VIEW'
                        when 'm' then 'MATERIALIZED_VIEW'
                        when 'f' then 'FOREIGN_TABLE'
                        else 'OTHER' end as relation_type,
         c.relrowsecurity as row_level_security,
         case when c.reltuples >= 0 then c.reltuples::bigint else null end as estimated_rows
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where c.relname = 'agent_messages'
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and n.nspname not in ('pg_catalog', 'information_schema')
),
described as (
  select m.schema_name, m.table_name, m.relation_type,
         m.row_level_security, m.estimated_rows,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'name', a.attname,
               'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
               'required', a.attnotnull
             ) order by a.attnum
           ) filter (where a.attnum is not null),
           '[]'::jsonb
         ) as columns
    from matches m
    left join pg_catalog.pg_attribute a
      on a.attrelid = m.oid and a.attnum > 0 and not a.attisdropped
   group by m.schema_name, m.table_name, m.relation_type, m.row_level_security, m.estimated_rows
),
related as (
  select n.nspname as schema_name, c.relname as table_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'crm')
     and c.relkind in ('r', 'p', 'v', 'm')
     and (
       c.relname ilike '%message%' or
       c.relname ilike '%conversation%' or
       c.relname ilike '%chat%'
     )
   order by n.nspname, c.relname
   limit 50
)
select jsonb_pretty(
  jsonb_build_object(
    'agent_messages',
      coalesce((select jsonb_agg(to_jsonb(d) order by d.schema_name, d.table_name) from described d), '[]'::jsonb),
    'related_table_names',
      coalesce((select jsonb_agg(r.schema_name || '.' || r.table_name order by r.schema_name, r.table_name) from related r), '[]'::jsonb),
    'lab_tests_present',
      to_regclass('public.lab_tests') is not null,
    'contains_patient_text',
      'NOT_CHECKED: metadata only',
    'message_directions_present',
      'NOT_CHECKED: metadata only'
  )
) as plusmedik_memory_discovery;
