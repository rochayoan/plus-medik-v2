-- MIGRACIÓN 21: historial de mensajes para AUDITORÍA autorizada (entrantes, respuestas del agente y mensajes de recepción humana).
-- Aplicar SOLAMENTE después de las 20 migraciones anteriores y después de aprobar pruebas y la revisión de privacidad. Aditiva: dos tablas y ocho funciones; no toca nada existente.
-- Independiente de la memoria conversacional (migración 17, que es contexto corto para el modelo) y de la auditoría de ejecución (migración 1+, que solo guarda códigos y estados).
--
-- Protección de datos:
--   · contact_key es el HMAC del contacto que ya usan los turnos (incluye la línea de WhatsApp): separa pacientes y líneas y NO permite recuperar el teléfono. No hay teléfono en estas tablas.
--   · El texto llega CIFRADO por la aplicación (AES-256-GCM, clave dedicada PLUSMEDIK_HISTORY_KEY, que vive fuera de la base). La base nunca ve el texto en claro. No se guardan enlaces ni credenciales de medios:
--     de un audio o una imagen solo se guarda su identificador (media_ref) y el tipo.
--   · Retención: por defecto los mensajes se conservan SIN vencimiento (expires_at nulo). Si se define una retención (1 a 3650 días) cada fila vence y cada escritura purga, de forma acotada, filas vencidas. plusmedik_history_erase borra todo lo de un contacto.
--   · Acceso solo por funciones: RLS activo y ningún privilegio directo sobre las tablas (ni siquiera service_role). La exportación exige un motivo y deja un rastro (plusmedik_message_history_access) sin contenido.
-- Idempotencia: (provider, account_id, provider_message_id) es único; repetir una escritura responde 'duplicate' y no cambia nada. El estado de entrega solo avanza (nunca retrocede).

create table if not exists public.plusmedik_message_history (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  provider text not null default 'kapso' check (provider = 'kapso'),
  account_id text not null check (account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  contact_key text not null check (contact_key ~ '^[0-9a-f]{64}$'),
  provider_message_id text not null check (provider_message_id ~ '^[A-Za-z0-9_.=:+/-]{1,255}$'),
  direction text not null check (direction in ('IN', 'OUT')),
  actor text not null check (actor in ('PATIENT', 'AGENT', 'HUMAN', 'OTHER_APP', 'META_AGENT', 'UNKNOWN')),
  origin text check (origin ~ '^[a-z_]{1,40}$'),
  content_kind text not null check (content_kind in ('TEXT', 'AUDIO', 'IMAGE', 'OTHER')),
  message_type text check (message_type ~ '^[a-z_]{1,30}$'),
  body_cipher text check (body_cipher ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' and length(body_cipher) <= 24000),
  key_id text check (key_id ~ '^[0-9a-f]{8}$'),
  media_ref text check (media_ref ~ '^[A-Za-z0-9_.=:+/-]{1,255}$'),
  delivery_state text not null check (delivery_state in ('RECEIVED', 'ACCEPTED', 'UNCERTAIN', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  audit_run_id uuid,
  reply_to_message_id text check (reply_to_message_id ~ '^[A-Za-z0-9_.=:+/-]{1,255}$'),
  occurred_at timestamptz not null,
  delivery_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  constraint plusmedik_message_history_once unique (provider, account_id, provider_message_id),
  constraint plusmedik_message_history_seq_once unique (seq),
  constraint plusmedik_message_history_expiry check (expires_at is null or expires_at > occurred_at),
  constraint plusmedik_message_history_cipher_key check ((body_cipher is null) = (key_id is null)),
  constraint plusmedik_message_history_actor_direction check ((direction = 'IN' and actor = 'PATIENT') or (direction = 'OUT' and actor <> 'PATIENT')),
  constraint plusmedik_message_history_state_direction check ((direction = 'IN' and delivery_state = 'RECEIVED') or (direction = 'OUT' and delivery_state <> 'RECEIVED'))
);
create index if not exists plusmedik_message_history_contact_idx on public.plusmedik_message_history (contact_key, occurred_at, seq);
create index if not exists plusmedik_message_history_time_idx on public.plusmedik_message_history (occurred_at, seq);
create index if not exists plusmedik_message_history_expiry_idx on public.plusmedik_message_history (expires_at);

alter table public.plusmedik_message_history enable row level security;
revoke all on table public.plusmedik_message_history from public, anon, authenticated, service_role;
comment on table public.plusmedik_message_history is 'Historial de mensajes para auditoría autorizada. Texto cifrado por la aplicación, sin teléfono, con vencimiento. Solo se accede por las funciones plusmedik_history_*.';

-- Rastro de cada exportación o supresión: quién pidió qué y por qué (motivo), cuántas filas. Nunca contiene mensajes.
create table if not exists public.plusmedik_message_history_access (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default clock_timestamp(),
  operation text not null check (operation in ('EXPORT', 'ERASE')),
  reason text not null check (length(reason) between 10 and 300),
  contact_key text check (contact_key ~ '^[0-9a-f]{64}$'),
  from_at timestamptz,
  to_at timestamptz,
  row_count integer not null check (row_count >= 0)
);
create index if not exists plusmedik_message_history_access_at_idx on public.plusmedik_message_history_access (at);
alter table public.plusmedik_message_history_access enable row level security;
revoke all on table public.plusmedik_message_history_access from public, anon, authenticated, service_role;
comment on table public.plusmedik_message_history_access is 'Rastro de exportaciones y supresiones del historial (sin contenido de mensajes).';

-- Orden de los estados de entrega de un mensaje saliente: solo avanzan. FAILED gana a SENT (un fallo posterior al envío) pero no a DELIVERED/READ.
create or replace function public.plusmedik_history_rank(p_state text)
returns integer
language sql immutable set search_path = ''
as $$
  select case p_state when 'UNCERTAIN' then 0 when 'ACCEPTED' then 1 when 'SENT' then 2 when 'FAILED' then 3 when 'DELIVERED' then 4 when 'READ' then 5 else -1 end
$$;

-- Escribe un mensaje (idempotente) y, en la misma transacción, purga como máximo 100 filas vencidas.
create or replace function public.plusmedik_history_record(
  p_account_id text, p_contact_key text, p_message_id text, p_direction text, p_actor text, p_origin text,
  p_content_kind text, p_message_type text, p_body_cipher text, p_key_id text, p_media_ref text,
  p_delivery_state text, p_audit_run_id uuid, p_reply_to text, p_occurred_at timestamptz, p_retention_days integer
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_days integer := p_retention_days;
  v_at timestamptz := least(coalesce(p_occurred_at, v_now), v_now);
  v_rows integer;
begin
  if p_account_id is null or p_account_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:+/-]{1,255}$'
     or p_direction is null or p_direction not in ('IN', 'OUT')
     or p_actor is null or p_actor not in ('PATIENT', 'AGENT', 'HUMAN', 'OTHER_APP', 'META_AGENT', 'UNKNOWN')
     or (p_origin is not null and p_origin !~ '^[a-z_]{1,40}$')
     or p_content_kind is null or p_content_kind not in ('TEXT', 'AUDIO', 'IMAGE', 'OTHER')
     or (p_message_type is not null and p_message_type !~ '^[a-z_]{1,30}$')
     or (p_body_cipher is not null and (p_body_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or length(p_body_cipher) > 24000))
     or ((p_body_cipher is null) <> (p_key_id is null)) or (p_key_id is not null and p_key_id !~ '^[0-9a-f]{8}$')
     or (p_media_ref is not null and p_media_ref !~ '^[A-Za-z0-9_.=:+/-]{1,255}$')
     or p_delivery_state is null or p_delivery_state not in ('RECEIVED', 'ACCEPTED', 'UNCERTAIN', 'SENT', 'DELIVERED', 'READ', 'FAILED')
     or (p_reply_to is not null and p_reply_to !~ '^[A-Za-z0-9_.=:+/-]{1,255}$')
     or (v_days is not null and (v_days < 1 or v_days > 3650)) then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_message_history (account_id, contact_key, provider_message_id, direction, actor, origin, content_kind, message_type, body_cipher, key_id, media_ref, delivery_state, audit_run_id, reply_to_message_id, occurred_at, expires_at)
  values (p_account_id, p_contact_key, p_message_id, p_direction, p_actor, p_origin, p_content_kind, p_message_type, p_body_cipher, p_key_id, p_media_ref, p_delivery_state, p_audit_run_id, p_reply_to, v_at, case when v_days is null then null else v_now + make_interval(days => v_days) end)
  on conflict (provider, account_id, provider_message_id) do nothing;
  get diagnostics v_rows = row_count;

  delete from public.plusmedik_message_history
  where id in (select m.id from public.plusmedik_message_history m where m.expires_at < v_now order by m.expires_at limit 100);

  return jsonb_build_object('outcome', case when v_rows = 1 then 'recorded' else 'duplicate' end);
end
$$;

-- Agrega la transcripción (cifrada) a una nota de voz ya registrada. Solo si todavía no tiene texto; nunca reemplaza.
create or replace function public.plusmedik_history_attach_text(p_account_id text, p_contact_key text, p_message_id text, p_body_cipher text, p_key_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_account_id is null or p_account_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:+/-]{1,255}$'
     or p_body_cipher is null or p_body_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or length(p_body_cipher) > 24000
     or p_key_id is null or p_key_id !~ '^[0-9a-f]{8}$' then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  update public.plusmedik_message_history
  set body_cipher = p_body_cipher, key_id = p_key_id
  where provider = 'kapso' and account_id = p_account_id and provider_message_id = p_message_id and contact_key = p_contact_key
    and direction = 'IN' and content_kind = 'AUDIO' and body_cipher is null;
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return jsonb_build_object('outcome', 'updated');
  end if;
  return jsonb_build_object('outcome', case when exists (select 1 from public.plusmedik_message_history where provider = 'kapso' and account_id = p_account_id and provider_message_id = p_message_id and contact_key = p_contact_key) then 'noop' else 'missing' end);
end
$$;

-- Estado de entrega de un mensaje SALIENTE (SENT, DELIVERED, READ o FAILED, según los eventos de Kapso). Solo avanza; un evento fuera de orden o repetido no cambia nada.
create or replace function public.plusmedik_history_delivery(p_account_id text, p_message_id text, p_state text, p_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_account_id is null or p_account_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:+/-]{1,255}$'
     or p_state is null or p_state not in ('SENT', 'DELIVERED', 'READ', 'FAILED') then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  update public.plusmedik_message_history
  set delivery_state = p_state, delivery_at = least(coalesce(p_at, clock_timestamp()), clock_timestamp())
  where provider = 'kapso' and account_id = p_account_id and provider_message_id = p_message_id and direction = 'OUT'
    and public.plusmedik_history_rank(p_state) > public.plusmedik_history_rank(delivery_state);
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return jsonb_build_object('outcome', 'updated');
  end if;
  return jsonb_build_object('outcome', case when exists (select 1 from public.plusmedik_message_history where provider = 'kapso' and account_id = p_account_id and provider_message_id = p_message_id and direction = 'OUT') then 'noop' else 'missing' end);
end
$$;

-- Exportación autorizada (por páginas, en orden cronológico). Exige un motivo y deja un rastro sin contenido. Devuelve el texto CIFRADO: se descifra fuera de la base, con la clave de la aplicación.
create or replace function public.plusmedik_history_export(p_reason text, p_contact_key text, p_from timestamptz, p_to timestamptz, p_after_seq bigint, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_rows jsonb;
  v_count integer;
  v_last bigint;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300
     or (p_contact_key is not null and p_contact_key !~ '^[0-9a-f]{64}$') then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.seq), '[]'::jsonb), count(*), max(s.seq)
  into v_rows, v_count, v_last
  from (
    select m.seq, m.contact_key, m.provider_message_id as message_id, m.direction, m.actor, m.origin, m.content_kind, m.message_type, m.body_cipher, m.key_id, m.media_ref,
           m.delivery_state, m.audit_run_id, m.reply_to_message_id as reply_to, m.occurred_at, m.delivery_at
    from public.plusmedik_message_history m
    where (m.expires_at is null or m.expires_at > clock_timestamp())
      and (p_contact_key is null or m.contact_key = p_contact_key)
      and (p_from is null or m.occurred_at >= p_from)
      and (p_to is null or m.occurred_at < p_to)
      and m.seq > coalesce(p_after_seq, 0)
    order by m.seq
    limit v_limit
  ) s;
  insert into public.plusmedik_message_history_access (operation, reason, contact_key, from_at, to_at, row_count)
  values ('EXPORT', btrim(p_reason), p_contact_key, p_from, p_to, v_count);
  return jsonb_build_object('rows', v_rows, 'next_after_seq', case when v_count = v_limit then v_last else null end);
end
$$;

-- Supresión: borra todo lo guardado de un contacto (con motivo y rastro).
create or replace function public.plusmedik_history_erase(p_contact_key text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' or p_reason is null or length(btrim(p_reason)) < 10 or length(p_reason) > 300 then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  delete from public.plusmedik_message_history where contact_key = p_contact_key;
  get diagnostics v_rows = row_count;
  insert into public.plusmedik_message_history_access (operation, reason, contact_key, row_count) values ('ERASE', btrim(p_reason), p_contact_key, v_rows);
  return jsonb_build_object('deleted', v_rows);
end
$$;

-- Purga de lo vencido (además de la purga acotada de cada escritura). Devuelve cuántas filas borró.
create or replace function public.plusmedik_history_purge(p_limit integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 10000);
  v_rows integer;
begin
  delete from public.plusmedik_message_history
  where id in (select m.id from public.plusmedik_message_history m where m.expires_at < clock_timestamp() order by m.expires_at limit v_limit);
  get diagnostics v_rows = row_count;
  return jsonb_build_object('deleted', v_rows);
end
$$;

-- Conciliación (solo lectura): mensajes que la auditoría de ejecución procesó o respondió y que NO están en el historial (una escritura del historial que falló). No incluye contenido.
create or replace function public.plusmedik_history_gaps(p_since timestamptz, p_limit integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_in jsonb;
  v_out jsonb;
begin
  select coalesce(jsonb_agg(s.kapso_message_id order by s.received_at), '[]'::jsonb) into v_in
  from (
    select r.kapso_message_id, r.received_at from public.plusmedik_audit_runs r
    where r.received_at >= coalesce(p_since, clock_timestamp() - interval '1 day')
      and not exists (select 1 from public.plusmedik_message_history h where h.provider = 'kapso' and h.provider_message_id = r.kapso_message_id)
    order by r.received_at limit v_limit
  ) s;
  select coalesce(jsonb_agg(s.kapso_outbound_message_id order by s.received_at), '[]'::jsonb) into v_out
  from (
    select r.kapso_outbound_message_id, r.received_at from public.plusmedik_audit_runs r
    where r.received_at >= coalesce(p_since, clock_timestamp() - interval '1 day')
      and r.reply_state = 'ACCEPTED' and r.kapso_outbound_message_id is not null
      and not exists (select 1 from public.plusmedik_message_history h where h.provider = 'kapso' and h.provider_message_id = r.kapso_outbound_message_id)
    order by r.received_at limit v_limit
  ) s;
  return jsonb_build_object('inbound_missing', v_in, 'outbound_missing', v_out);
end
$$;

revoke all on function public.plusmedik_history_rank(text) from public, anon, authenticated;
revoke all on function public.plusmedik_history_record(text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_history_attach_text(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_history_delivery(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_history_erase(text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_history_purge(integer) from public, anon, authenticated;
revoke all on function public.plusmedik_history_gaps(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_history_record(text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer) to service_role;
grant execute on function public.plusmedik_history_attach_text(text, text, text, text, text) to service_role;
grant execute on function public.plusmedik_history_delivery(text, text, text, timestamptz) to service_role;
grant execute on function public.plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer) to service_role;
grant execute on function public.plusmedik_history_erase(text, text) to service_role;
grant execute on function public.plusmedik_history_purge(integer) to service_role;
grant execute on function public.plusmedik_history_gaps(timestamptz, integer) to service_role;
