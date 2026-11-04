-- MIGRACIÓN 22: el historial de mensajes guarda el texto EN CLARO por defecto (el cifrado de la migración 21 pasa a ser opcional).
-- Aplicar SOLAMENTE después de la migración 21. Aditiva: una columna y dos funciones nuevas, y una función reemplazada (plusmedik_history_export, misma firma, ahora también devuelve el texto en claro). No borra ni modifica filas.
--
-- Por qué: el laboratorio quiere conservar TODOS los mensajes (entrantes y salientes) en su Supabase para usarlos desde sus otros proyectos, sin configurar claves. El texto se guarda en `body`; `body_cipher` + `key_id`
-- (cifrado con PLUSMEDIK_HISTORY_KEY) siguen existiendo y se usan solo si esa clave se define. Cada fila usa UNA de las dos formas, nunca ambas.
-- Se mantiene todo lo demás de la migración 21: contact_key (HMAC; sin teléfono), RLS sin privilegios directos sobre las tablas, acceso solo por funciones, idempotencia, estado de entrega que solo avanza,
-- exportación con motivo y rastro, supresión por contacto y, por defecto, SIN vencimiento.
-- Las funciones plusmedik_history_record y plusmedik_history_attach_text de la 21 quedan sin uso (la aplicación usa las nuevas); siguen funcionando para filas cifradas.

alter table public.plusmedik_message_history add column if not exists body text check (length(body) <= 20000);

-- Escribe un mensaje (idempotente) con el texto en claro (p_body) o cifrado (p_body_cipher + p_key_id), nunca ambos, y purga como máximo 100 filas vencidas.
create or replace function public.plusmedik_history_save(
  p_account_id text, p_contact_key text, p_message_id text, p_direction text, p_actor text, p_origin text,
  p_content_kind text, p_message_type text, p_body text, p_body_cipher text, p_key_id text, p_media_ref text,
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
     or (p_body is not null and length(p_body) > 20000)
     or (p_body_cipher is not null and (p_body_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or length(p_body_cipher) > 24000))
     or ((p_body_cipher is null) <> (p_key_id is null)) or (p_key_id is not null and p_key_id !~ '^[0-9a-f]{8}$')
     or (p_body is not null and p_body_cipher is not null)
     or (p_media_ref is not null and p_media_ref !~ '^[A-Za-z0-9_.=:+/-]{1,255}$')
     or p_delivery_state is null or p_delivery_state not in ('RECEIVED', 'ACCEPTED', 'UNCERTAIN', 'SENT', 'DELIVERED', 'READ', 'FAILED')
     or (p_reply_to is not null and p_reply_to !~ '^[A-Za-z0-9_.=:+/-]{1,255}$')
     or (v_days is not null and (v_days < 1 or v_days > 3650)) then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_message_history (account_id, contact_key, provider_message_id, direction, actor, origin, content_kind, message_type, body, body_cipher, key_id, media_ref, delivery_state, audit_run_id, reply_to_message_id, occurred_at, expires_at)
  values (p_account_id, p_contact_key, p_message_id, p_direction, p_actor, p_origin, p_content_kind, p_message_type, p_body, p_body_cipher, p_key_id, p_media_ref, p_delivery_state, p_audit_run_id, p_reply_to, v_at, case when v_days is null then null else v_now + make_interval(days => v_days) end)
  on conflict (provider, account_id, provider_message_id) do nothing;
  get diagnostics v_rows = row_count;

  delete from public.plusmedik_message_history
  where id in (select m.id from public.plusmedik_message_history m where m.expires_at < v_now order by m.expires_at limit 100);

  return jsonb_build_object('outcome', case when v_rows = 1 then 'recorded' else 'duplicate' end);
end
$$;

-- Agrega la transcripción (en claro o cifrada, una de las dos) a una nota de voz ya registrada. Solo si todavía no tiene texto; nunca reemplaza.
create or replace function public.plusmedik_history_attach(p_account_id text, p_contact_key text, p_message_id text, p_body text, p_body_cipher text, p_key_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_account_id is null or p_account_id !~ '^[A-Za-z0-9_-]{1,64}$'
     or p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:+/-]{1,255}$'
     or ((p_body is null) = (p_body_cipher is null))
     or (p_body is not null and length(p_body) > 20000)
     or (p_body_cipher is not null and (p_body_cipher !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or length(p_body_cipher) > 24000))
     or ((p_body_cipher is null) <> (p_key_id is null)) or (p_key_id is not null and p_key_id !~ '^[0-9a-f]{8}$') then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  update public.plusmedik_message_history
  set body = p_body, body_cipher = p_body_cipher, key_id = p_key_id
  where provider = 'kapso' and account_id = p_account_id and provider_message_id = p_message_id and contact_key = p_contact_key
    and direction = 'IN' and content_kind = 'AUDIO' and body_cipher is null and body is null;
  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return jsonb_build_object('outcome', 'updated');
  end if;
  return jsonb_build_object('outcome', case when exists (select 1 from public.plusmedik_message_history where provider = 'kapso' and account_id = p_account_id and provider_message_id = p_message_id and contact_key = p_contact_key) then 'noop' else 'missing' end);
end
$$;

-- Exportación autorizada (misma firma que en la 21): ahora también devuelve el texto en claro (body). Exige un motivo y deja un rastro sin contenido.
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
    select m.seq, m.contact_key, m.provider_message_id as message_id, m.direction, m.actor, m.origin, m.content_kind, m.message_type, m.body, m.body_cipher, m.key_id, m.media_ref,
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

comment on table public.plusmedik_message_history is 'Historial de mensajes para auditoría. Texto en claro (body) o cifrado por la aplicación (body_cipher), sin teléfono, sin vencimiento por defecto. Solo se accede por las funciones plusmedik_history_*.';

revoke all on function public.plusmedik_history_save(text, text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_history_attach(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_history_save(text, text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer) to service_role;
grant execute on function public.plusmedik_history_attach(text, text, text, text, text, text) to service_role;
grant execute on function public.plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer) to service_role;
