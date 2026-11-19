-- MIGRACIÓN 26: medición del MENÚ de intención del saludo (cuándo se mostró, qué opción eligió el paciente y cómo la eligió).
-- Aplicar SOLAMENTE después de las 25 migraciones anteriores. Aditiva y reaplicable: una tabla y dos funciones; no toca nada existente. NO se aplica a ningún Supabase remoto desde aquí.
--
-- Qué se guarda: SOLO códigos cerrados y la clave HMAC del contacto (la misma de las demás tablas). Nunca texto del paciente ni del agente, ni teléfonos.
--   event:  SHOWN (salió el menú) · SKIPPED (el paciente siguió escribiendo y el menú no salió) · CHOSEN (eligió una opción) · INVALID_CHOICE (un número que no está en el menú)
--   option: QUOTE · RESULTS · LOCATION · HOME_VISIT · HUMAN · OTHER (solo con CHOSEN)
--   via:    NUMBER (respondió con el número) · WORDS (respondió con palabras justo después del menú) (solo con CHOSEN)
-- La aplicación registra con plusmedik_agent_menu_event (mejor esfuerzo: si falla, el paciente no lo nota). Los registros vencen a los 180 días: el reporte ya no los cuenta y se pueden borrar a mano
-- (delete from public.plusmedik_agent_menu_events where expires_at < now();). La migración no borra nada.
--
-- Reporte (solo lectura), desde el editor SQL de Supabase:
--     select * from public.plusmedik_agent_menu_report(now() - interval '7 days');
-- Devuelve, por día (hora de Bolivia), cuántas veces se mostró el menú, cuántas no salió porque el paciente siguió escribiendo, y cuántas elecciones hubo por opción y por forma de elegir.

create table if not exists public.plusmedik_agent_menu_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  contact_key text not null check (contact_key ~ '^[0-9a-f]{64}$'),
  event text not null check (event in ('SHOWN', 'SKIPPED', 'CHOSEN', 'INVALID_CHOICE')),
  option text check (option is null or option in ('QUOTE', 'RESULTS', 'LOCATION', 'HOME_VISIT', 'HUMAN', 'OTHER')),
  via text check (via is null or via in ('NUMBER', 'WORDS')),
  expires_at timestamptz not null default (clock_timestamp() + interval '180 days'),
  check ((event = 'CHOSEN') = (option is not null and via is not null))
);

create index if not exists plusmedik_agent_menu_events_at_idx on public.plusmedik_agent_menu_events (at);

alter table public.plusmedik_agent_menu_events enable row level security;
revoke all on table public.plusmedik_agent_menu_events from public, anon, authenticated, service_role;
comment on table public.plusmedik_agent_menu_events is 'Medición del menú de intención del saludo: solo códigos cerrados y la clave HMAC del contacto (sin texto ni teléfonos). Vence a los 180 días.';

create or replace function public.plusmedik_agent_menu_event(p_contact_key text, p_event text, p_option text, p_via text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_event is null or p_event not in ('SHOWN', 'SKIPPED', 'CHOSEN', 'INVALID_CHOICE')
     or (p_option is not null and p_option not in ('QUOTE', 'RESULTS', 'LOCATION', 'HOME_VISIT', 'HUMAN', 'OTHER'))
     or (p_via is not null and p_via not in ('NUMBER', 'WORDS'))
     or ((p_event = 'CHOSEN') <> (p_option is not null and p_via is not null)) then
    raise exception 'plusmedik_agent_menu: invalid input' using errcode = 'PT422';
  end if;
  insert into public.plusmedik_agent_menu_events (contact_key, event, option, via) values (p_contact_key, p_event, p_option, p_via);
  return jsonb_build_object('recorded', true);
end $$;

create or replace function public.plusmedik_agent_menu_report(p_since timestamptz)
returns table (day date, shown bigint, skipped bigint, invalid_choice bigint, chosen bigint, option text, via text, chosen_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select (e.at at time zone 'America/La_Paz')::date as day, e.event, e.option, e.via
    from public.plusmedik_agent_menu_events e
    where e.at >= coalesce(p_since, clock_timestamp() - interval '7 days') and e.expires_at > clock_timestamp()
  ), totals as (
    select b.day,
           count(*) filter (where b.event = 'SHOWN') as shown,
           count(*) filter (where b.event = 'SKIPPED') as skipped,
           count(*) filter (where b.event = 'INVALID_CHOICE') as invalid_choice,
           count(*) filter (where b.event = 'CHOSEN') as chosen
    from base b group by b.day
  ), choices as (
    select b.day, b.option, b.via, count(*) as chosen_count from base b where b.event = 'CHOSEN' group by b.day, b.option, b.via
  )
  select t.day, t.shown, t.skipped, t.invalid_choice, t.chosen, c.option, c.via, coalesce(c.chosen_count, 0)
  from totals t left join choices c on c.day = t.day
  order by t.day desc, c.chosen_count desc nulls last;
$$;

revoke all on function public.plusmedik_agent_menu_event(text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_agent_menu_report(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.plusmedik_agent_menu_event(text, text, text, text) to service_role;

comment on function public.plusmedik_agent_menu_event(text, text, text, text) is 'Registra un evento del menú de intención (solo códigos cerrados). Solo service_role.';
comment on function public.plusmedik_agent_menu_report(timestamp with time zone) is 'Solo lectura (STABLE): reporte diario del menú de intención. Se ejecuta desde el editor SQL (no se concede a la API).';
