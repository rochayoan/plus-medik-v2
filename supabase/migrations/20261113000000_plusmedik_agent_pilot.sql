-- MIGRACIÓN 25: piloto del nuevo agente conversacional (G7, Fase 4) — interruptor de DESACTIVACIÓN INMEDIATA y lectura acotada de los mensajes recientes de UN contacto.
-- Aplicar SOLAMENTE después de las 24 migraciones anteriores. Aditiva y reaplicable: una tabla de una sola fila, una bitácora y tres funciones; no toca nada existente. NO se aplica a ningún Supabase remoto desde aquí.
--
-- Interruptor: el piloto solo responde si esta fila existe y dice enabled = true. La migración NO siembra datos: sin fila el estado es APAGADO. Una persona lo cambia desde el editor SQL de Supabase (no hace falta redesplegar ni cambiar variables):
--     select public.plusmedik_agent_pilot_set(false, 'motivo');     -- apaga YA (el agente actual atiende a todos, también al número del piloto)
--     select public.plusmedik_agent_pilot_set(true,  'motivo');     -- lo enciende (además del número permitido y la variable PLUSMEDIK_AGENT=pilot en el despliegue)
-- La aplicación lee el estado con plusmedik_agent_pilot_state() unos segundos como máximo antes de cada lote y FALLA CERRADO: si no puede leerlo, el piloto no responde.
-- plusmedik_agent_pilot_set NO se concede a ningún rol de la API (ni siquiera service_role): solo la ejecuta quien administra la base. Cada cambio deja un rastro (sin datos de pacientes).
--
-- Mensajes recientes: plusmedik_history_recent devuelve, de UN contacto, como mucho 20 mensajes de TEXTO recientes (el texto en claro ya guardado por el historial), en orden, sin los ids que se le indiquen
-- (los del lote que se está atendiendo). Es de solo lectura (STABLE), solo para service_role, y recorta cada texto a 600 caracteres. La aplicación solo la llama para el contacto del piloto y sanea el texto
-- antes de usarlo; un mensaje de salud nunca se envía al proveedor (lo filtra la aplicación).

create table if not exists public.plusmedik_agent_pilot_switch (
  id smallint primary key check (id = 1),
  enabled boolean not null default false,
  reason text check (reason is null or length(reason) <= 200),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.plusmedik_agent_pilot_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  enabled boolean not null,
  reason text check (reason is null or length(reason) <= 200)
);

alter table public.plusmedik_agent_pilot_switch enable row level security;
alter table public.plusmedik_agent_pilot_log enable row level security;
revoke all on table public.plusmedik_agent_pilot_switch from public, anon, authenticated, service_role;
revoke all on table public.plusmedik_agent_pilot_log from public, anon, authenticated, service_role;
comment on table public.plusmedik_agent_pilot_switch is 'Interruptor del piloto del nuevo agente (una sola fila; nace apagado). Se cambia con plusmedik_agent_pilot_set desde el editor SQL.';

create or replace function public.plusmedik_agent_pilot_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Sin fila (la migración no siembra datos) el estado es APAGADO.
  select jsonb_build_object('enabled', coalesce((select s.enabled from public.plusmedik_agent_pilot_switch s where s.id = 1), false), 'updated_at', (select s.updated_at from public.plusmedik_agent_pilot_switch s where s.id = 1));
$$;

create or replace function public.plusmedik_agent_pilot_set(p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_enabled is null or p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 200 then
    raise exception 'plusmedik_agent_pilot: invalid input' using errcode = 'PT422';
  end if;
  insert into public.plusmedik_agent_pilot_switch (id, enabled, reason, updated_at) values (1, p_enabled, p_reason, clock_timestamp())
  on conflict (id) do update set enabled = excluded.enabled, reason = excluded.reason, updated_at = excluded.updated_at;
  insert into public.plusmedik_agent_pilot_log (enabled, reason) values (p_enabled, p_reason);
  return public.plusmedik_agent_pilot_state();
end $$;

create or replace function public.plusmedik_history_recent(p_contact_key text, p_limit integer, p_exclude text[], p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_limit is null or p_limit not between 1 and 20
     or p_since is null
     or (p_exclude is not null and cardinality(p_exclude) > 50) then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  return jsonb_build_object('messages', coalesce((
    select jsonb_agg(jsonb_build_object('direction', r.direction, 'actor', r.actor, 'body', r.body, 'at', r.occurred_at) order by r.occurred_at, r.seq)
    from (
      select m.direction, m.actor, left(m.body, 600) as body, m.occurred_at, m.seq
      from public.plusmedik_message_history m
      where m.contact_key = p_contact_key
        and m.content_kind = 'TEXT'
        and m.body is not null
        and m.occurred_at >= p_since
        and (m.expires_at is null or m.expires_at > clock_timestamp())
        and (m.direction = 'IN' or m.delivery_state in ('ACCEPTED', 'SENT', 'DELIVERED', 'READ'))
        and (p_exclude is null or m.provider_message_id <> all (p_exclude))
      order by m.occurred_at desc, m.seq desc
      limit p_limit
    ) r
  ), '[]'::jsonb));
end $$;

revoke all on function public.plusmedik_agent_pilot_state() from public, anon, authenticated;
revoke all on function public.plusmedik_agent_pilot_set(boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_history_recent(text, integer, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.plusmedik_agent_pilot_state() to service_role;
grant execute on function public.plusmedik_history_recent(text, integer, text[], timestamptz) to service_role;

comment on function public.plusmedik_agent_pilot_state() is 'Solo lectura (STABLE): estado del interruptor del piloto del nuevo agente.';
comment on function public.plusmedik_history_recent(text, integer, text[], timestamp with time zone) is 'Solo lectura (STABLE): últimos mensajes de texto de UN contacto (máximo 20, texto recortado a 600).';
