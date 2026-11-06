-- MIGRACIÓN 24: eventos de conversación (memoria estructurada: preguntas y objetivos pendientes, recetas y cotizaciones por IDS) — Fase 1 del plan G7, en MODO SOMBRA.
-- Aplicar SOLAMENTE después de las 23 migraciones anteriores. Aditiva: una tabla y seis funciones; no toca nada existente. Solo define esquema local: NO se aplica a ningún Supabase remoto.
--
-- Qué guarda: hechos mínimos e inmutables de la conversación de un contacto («llegó un lote con estas peticiones», «el agente respondió con esta calidad», «una persona escribió», «una persona reanudó al
-- agente», «se leyó una receta / se emitió una cotización con estos ids de estudios»). La proyección (qué quedó pendiente) la calcula la aplicación con un reductor puro (src/conversation-state.ts):
-- no hay tabla de estado que mantener sincronizada y reconstruir la verdad es releer los eventos en orden.
--
-- Protección de datos (la base lo IMPONE, no depende de la disciplina de quien escribe):
--   · NUNCA texto del paciente: toda cadena del payload debe ser un identificador o código corto (^[A-Za-z0-9_.=:+/-]{1,128}$) y toda clave un nombre simple; el payload pesa a lo sumo 4 KB. Una frase,
--     un nombre o un teléfono no pasan la validación. NUNCA precios (solo ids de lab_tests).
--   · contact_key es el HMAC del contacto que ya usan los turnos (incluye la línea de WhatsApp): no hay teléfono en la tabla.
--   · Retención: cada evento vence (por defecto a los 30 días; 1 a 365); cada escritura purga, de forma acotada, eventos vencidos. plusmedik_conv_erase borra todo lo de un contacto y deja un rastro
--     (en plusmedik_message_history_access) sin contenido.
--   · Acceso solo por funciones: RLS activo y ningún privilegio directo sobre la tabla (ni siquiera service_role).
-- Idempotencia: (contact_key, event_key) es único; repetir una escritura responde «duplicate» y no cambia nada (un reintento de Kapso nunca duplica un evento).
-- Orden: occurred_at y seq (autonumérico). Una fecha futura se acota a «ahora».
-- La lectura (plusmedik_conv_events_read, plusmedik_conv_contacts_since) es STABLE: la base impide que escriba o bloquee filas.

-- Forma permitida del payload: objeto pequeño, claves simples, cadenas SOLO identificadores/códigos cortos (nunca frases). Números y booleanos libres.
create or replace function public.plusmedik_conv_payload_ok(p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_payload is not null
    and jsonb_typeof(p_payload) = 'object'
    and pg_column_size(p_payload) <= 4096
    and not exists (select 1 from jsonb_path_query(p_payload, 'lax $.**') as v where jsonb_typeof(v) = 'string' and (v #>> '{}') !~ '^[A-Za-z0-9_.=:+/-]{1,128}$')
    and not exists (select 1 from jsonb_path_query(p_payload, 'lax $.** ? (@.type() == "object").keyvalue().key') as k where (k #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]{0,31}$')
$$;

create table if not exists public.plusmedik_conv_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  contact_key text not null check (contact_key ~ '^[0-9a-f]{64}$'),
  event_key text not null check (event_key ~ '^[A-Za-z0-9_.=:+/-]{1,200}$'),
  kind text not null check (kind in ('PATIENT_BATCH', 'AGENT_REPLY', 'HUMAN_MESSAGE', 'HUMAN_RESUME', 'ARTIFACT', 'DROP')),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  constraint plusmedik_conv_events_once unique (contact_key, event_key),
  constraint plusmedik_conv_events_seq_once unique (seq),
  constraint plusmedik_conv_events_expiry check (expires_at is null or expires_at > occurred_at),
  constraint plusmedik_conv_events_payload check (public.plusmedik_conv_payload_ok(payload))
);
create index if not exists plusmedik_conv_events_contact_idx on public.plusmedik_conv_events (contact_key, occurred_at, seq);
create index if not exists plusmedik_conv_events_time_idx on public.plusmedik_conv_events (occurred_at, seq);
create index if not exists plusmedik_conv_events_expiry_idx on public.plusmedik_conv_events (expires_at);

alter table public.plusmedik_conv_events enable row level security;
revoke all on table public.plusmedik_conv_events from public, anon, authenticated, service_role;
comment on table public.plusmedik_conv_events is 'Eventos mínimos de la conversación (ids y códigos, sin texto de pacientes ni precios). Solo se accede por las funciones plusmedik_conv_*.';

-- Escribe hasta 50 eventos de UN contacto. p_events: [{event_key, kind, payload, occurred_at}]. Idempotente por (contact_key, event_key).
create or replace function public.plusmedik_conv_append(p_contact_key text, p_events jsonb, p_retention_days integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event jsonb;
  v_recorded integer := 0;
  v_duplicate integer := 0;
  v_id uuid;
  v_at timestamptz;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) not between 1 and 50
     or p_retention_days is null or p_retention_days not between 1 and 365 then
    raise exception 'plusmedik_conv: invalid append' using errcode = 'PT422';
  end if;
  for v_event in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(v_event) <> 'object'
       or coalesce(v_event ->> 'event_key', '') !~ '^[A-Za-z0-9_.=:+/-]{1,200}$'
       or coalesce(v_event ->> 'kind', '') not in ('PATIENT_BATCH', 'AGENT_REPLY', 'HUMAN_MESSAGE', 'HUMAN_RESUME', 'ARTIFACT', 'DROP')
       or coalesce(v_event ->> 'occurred_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})$'
       or not public.plusmedik_conv_payload_ok(coalesce(v_event -> 'payload', '{}'::jsonb)) then
      raise exception 'plusmedik_conv: invalid event' using errcode = 'PT422';
    end if;
    v_at := least((v_event ->> 'occurred_at')::timestamptz, clock_timestamp());
    v_id := null;
    insert into public.plusmedik_conv_events (contact_key, event_key, kind, payload, occurred_at, expires_at)
    values (p_contact_key, v_event ->> 'event_key', v_event ->> 'kind', coalesce(v_event -> 'payload', '{}'::jsonb), v_at, v_at + make_interval(days => p_retention_days))
    on conflict (contact_key, event_key) do nothing
    returning id into v_id;
    if v_id is null then v_duplicate := v_duplicate + 1; else v_recorded := v_recorded + 1; end if;
  end loop;
  -- Purga acotada de eventos vencidos (nunca más de 20 por escritura).
  delete from public.plusmedik_conv_events where id in (select id from public.plusmedik_conv_events where expires_at is not null and expires_at < clock_timestamp() order by expires_at limit 20);
  return jsonb_build_object('recorded', v_recorded, 'duplicate', v_duplicate);
end $$;

-- Eventos vigentes de un contacto desde p_since, en orden (occurred_at, seq). STABLE: no escribe ni bloquea filas.
create or replace function public.plusmedik_conv_events_read(p_contact_key text, p_since timestamptz, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' or p_since is null or p_limit is null or p_limit not between 1 and 2000 then
    raise exception 'plusmedik_conv: invalid read' using errcode = 'PT422';
  end if;
  return jsonb_build_object('events', coalesce((
    select jsonb_agg(jsonb_build_object('key', e.event_key, 'kind', e.kind, 'payload', e.payload, 'at', e.occurred_at) order by e.occurred_at, e.seq)
    from (select * from public.plusmedik_conv_events where contact_key = p_contact_key and occurred_at >= p_since and (expires_at is null or expires_at > clock_timestamp()) order by occurred_at, seq limit p_limit) e
  ), '[]'::jsonb));
end $$;

-- Contactos con actividad desde p_since (para listar pendientes). STABLE.
create or replace function public.plusmedik_conv_contacts_since(p_since timestamptz, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_since is null or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'plusmedik_conv: invalid contacts query' using errcode = 'PT422';
  end if;
  return jsonb_build_object('contacts', coalesce((
    select jsonb_agg(jsonb_build_object('contact_key', c.contact_key, 'last_at', c.last_at) order by c.last_at desc)
    from (select contact_key, max(occurred_at) as last_at from public.plusmedik_conv_events where occurred_at >= p_since and (expires_at is null or expires_at > clock_timestamp()) group by contact_key order by max(occurred_at) desc limit p_limit) c
  ), '[]'::jsonb));
end $$;

-- Borra TODO lo guardado de un contacto (derecho de supresión). Exige un motivo y deja un rastro sin contenido.
create or replace function public.plusmedik_conv_erase(p_contact_key text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' or p_reason is null or length(p_reason) not between 10 and 300 then
    raise exception 'plusmedik_conv: invalid erase' using errcode = 'PT422';
  end if;
  delete from public.plusmedik_conv_events where contact_key = p_contact_key;
  get diagnostics v_deleted = row_count;
  insert into public.plusmedik_message_history_access (operation, reason, contact_key, row_count) values ('ERASE', p_reason, p_contact_key, v_deleted);
  return v_deleted;
end $$;

-- Purga de eventos vencidos (acotada).
create or replace function public.plusmedik_conv_purge(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit not between 1 and 10000 then
    raise exception 'plusmedik_conv: invalid purge' using errcode = 'PT422';
  end if;
  delete from public.plusmedik_conv_events where id in (select id from public.plusmedik_conv_events where expires_at is not null and expires_at < clock_timestamp() order by expires_at limit p_limit);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.plusmedik_conv_payload_ok(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_conv_append(text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_conv_events_read(text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_conv_contacts_since(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_conv_erase(text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_conv_purge(integer) from public, anon, authenticated;
grant execute on function public.plusmedik_conv_append(text, jsonb, integer) to service_role;
grant execute on function public.plusmedik_conv_events_read(text, timestamptz, integer) to service_role;
grant execute on function public.plusmedik_conv_contacts_since(timestamptz, integer) to service_role;
grant execute on function public.plusmedik_conv_erase(text, text) to service_role;
grant execute on function public.plusmedik_conv_purge(integer) to service_role;

comment on function public.plusmedik_conv_append(text, jsonb, integer) is 'Escribe eventos mínimos de conversación (ids y códigos, nunca texto). Idempotente por (contact_key, event_key).';
comment on function public.plusmedik_conv_events_read(text, timestamptz, integer) is 'Solo lectura (STABLE): eventos vigentes de un contacto en orden.';
comment on function public.plusmedik_conv_contacts_since(timestamptz, integer) is 'Solo lectura (STABLE): contactos con actividad reciente.';
