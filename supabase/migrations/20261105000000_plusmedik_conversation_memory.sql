-- MIGRACIÓN 17: memoria conversacional corta por contacto y línea de WhatsApp.
-- Aplicar SOLAMENTE después de las 16 migraciones anteriores y después de aprobar pruebas. Aditiva: una tabla y tres funciones; no toca nada existente.
--
-- Qué guarda: los últimos mensajes de TEXTO del paciente y las respuestas del agente confirmadas como enviadas, para que el modelo conversacional entienda el contexto.
-- Protección de datos:
--   · contact_key es el HMAC del contacto que ya usan los turnos (incluye la línea de WhatsApp del laboratorio): separa pacientes y líneas y NO permite recuperar el teléfono. No hay teléfono en esta tabla.
--   · El texto llega CIFRADO por la aplicación (AES-256-GCM, clave dedicada). La base nunca ve el texto en claro. La aplicación solo guarda texto saneado (sin enlaces, correos ni números largos),
--     y NO guarda mensajes de salud, automáticos ni pedidos de cotización con estudios.
--   · Retención limitada: cada fila vence (1 a 30 días, 7 por defecto), se conservan como máximo 40 mensajes por contacto y cada escritura purga, de forma acotada, filas vencidas.
--   · Acceso solo por funciones: RLS activo y ningún privilegio directo sobre la tabla (ni siquiera service_role). plusmedik_memory_forget borra todo lo de un contacto.
-- Idempotencia: (contact_key, direction, provider_message_id) es único; repetir una escritura responde 'duplicate' y no cambia nada.

create table if not exists public.plusmedik_conversation_messages (
  id uuid primary key default gen_random_uuid(),
  contact_key text not null check (contact_key ~ '^[0-9a-f]{64}$'),
  direction text not null check (direction in ('IN', 'OUT')),
  provider_message_id text not null check (provider_message_id ~ '^[A-Za-z0-9_.=:-]{1,255}$'),
  body_cipher text not null check (body_cipher ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' and length(body_cipher) <= 4000),
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint plusmedik_conversation_messages_once unique (contact_key, direction, provider_message_id),
  constraint plusmedik_conversation_messages_expiry check (expires_at > occurred_at)
);
create index if not exists plusmedik_conversation_messages_recent_idx on public.plusmedik_conversation_messages (contact_key, occurred_at desc, id desc);
create index if not exists plusmedik_conversation_messages_expiry_idx on public.plusmedik_conversation_messages (expires_at);

alter table public.plusmedik_conversation_messages enable row level security;
revoke all on table public.plusmedik_conversation_messages from public, anon, authenticated, service_role;
comment on table public.plusmedik_conversation_messages is 'Memoria conversacional corta. Texto cifrado por la aplicación, sin teléfono, con vencimiento. Solo se accede por las funciones plusmedik_memory_*.';

-- Escribe un mensaje (idempotente) y, en la misma transacción, recorta lo que excede de 40 por contacto y purga como máximo 100 filas vencidas.
create or replace function public.plusmedik_memory_record(
  p_contact_key text, p_direction text, p_message_id text, p_body_cipher text, p_occurred_at timestamptz, p_retention_days integer
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_days integer := coalesce(p_retention_days, 7);
  v_at timestamptz := least(coalesce(p_occurred_at, v_now), v_now);
  v_rows integer;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_direction is null or p_direction not in ('IN', 'OUT')
     or p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:-]{1,255}$'
     or p_body_cipher is null or p_body_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or length(p_body_cipher) > 4000
     or v_days < 1 or v_days > 30 then
    raise exception 'plusmedik_memory: invalid input' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_conversation_messages (contact_key, direction, provider_message_id, body_cipher, occurred_at, expires_at)
  values (p_contact_key, p_direction, p_message_id, p_body_cipher, v_at, v_now + make_interval(days => v_days))
  on conflict (contact_key, direction, provider_message_id) do nothing;
  get diagnostics v_rows = row_count;

  delete from public.plusmedik_conversation_messages
  where id in (select m.id from public.plusmedik_conversation_messages m where m.contact_key = p_contact_key order by m.occurred_at desc, m.id desc offset 40);
  delete from public.plusmedik_conversation_messages
  where id in (select m.id from public.plusmedik_conversation_messages m where m.expires_at < v_now order by m.expires_at limit 100);

  return jsonb_build_object('outcome', case when v_rows = 1 then 'recorded' else 'duplicate' end);
end
$$;

-- Los mensajes vigentes más recientes de UN contacto (nunca de otro), del más nuevo al más antiguo, sin el mensaje que se está atendiendo.
create or replace function public.plusmedik_memory_recent(p_contact_key text, p_limit integer, p_exclude_message_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' then
    raise exception 'plusmedik_memory: invalid input' using errcode = 'PT422';
  end if;
  return jsonb_build_object('messages', coalesce((
    select jsonb_agg(jsonb_build_object('d', s.direction, 'm', s.provider_message_id, 'c', s.body_cipher, 't', s.occurred_at) order by s.occurred_at desc, s.id desc)
    from (
      select m.id, m.direction, m.provider_message_id, m.body_cipher, m.occurred_at
      from public.plusmedik_conversation_messages m
      where m.contact_key = p_contact_key
        and m.expires_at > clock_timestamp()
        and not (m.direction = 'IN' and p_exclude_message_id is not null and m.provider_message_id = p_exclude_message_id)
      order by m.occurred_at desc, m.id desc
      limit v_limit
    ) s
  ), '[]'::jsonb));
end
$$;

-- Borra todo lo guardado de un contacto (solicitud de supresión).
create or replace function public.plusmedik_memory_forget(p_contact_key text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' then
    raise exception 'plusmedik_memory: invalid input' using errcode = 'PT422';
  end if;
  delete from public.plusmedik_conversation_messages where contact_key = p_contact_key;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('deleted', v_rows);
end
$$;

revoke all on function public.plusmedik_memory_record(text, text, text, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_memory_recent(text, integer, text) from public, anon, authenticated;
revoke all on function public.plusmedik_memory_forget(text) from public, anon, authenticated;
grant execute on function public.plusmedik_memory_record(text, text, text, text, timestamptz, integer) to service_role;
grant execute on function public.plusmedik_memory_recent(text, integer, text) to service_role;
grant execute on function public.plusmedik_memory_forget(text) to service_role;
