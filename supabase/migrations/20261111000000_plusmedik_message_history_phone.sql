-- MIGRACIÓN 23: el historial de mensajes guarda también el TELÉFONO del contacto (solo dígitos), para poder consultar una conversación por número desde otros proyectos.
-- Aplicar SOLAMENTE después de la migración 22, y ANTES de desplegar el código que la usa (el código nuevo llama a plusmedik_history_put). Aditiva: una columna, un índice y una función nuevas, y una función
-- reemplazada (plusmedik_history_export, misma firma, ahora también devuelve contact_phone). No borra nada ni cambia filas existentes.
--
-- contact_key (HMAC del contacto y la línea) sigue siendo el identificador que separa una conversación de otra, también para la memoria conversacional; el teléfono NO lo reemplaza: solo permite saber de quién es.
-- Decisión del laboratorio: guardar el teléfono junto a los mensajes. Las filas anteriores tienen contact_phone nulo y se completan solas la próxima vez que ese contacto escribe (el HMAC no se puede revertir).
-- plusmedik_history_save (migración 22) sigue existiendo y funcionando, sin teléfono.

alter table public.plusmedik_message_history add column if not exists contact_phone text check (contact_phone ~ '^[0-9]{6,20}$');
create index if not exists plusmedik_message_history_phone_idx on public.plusmedik_message_history (contact_phone, occurred_at, seq) where contact_phone is not null;
comment on column public.plusmedik_message_history.contact_phone is 'Teléfono del contacto, solo dígitos. Nulo en las filas anteriores a la migración 23 hasta que ese contacto vuelve a escribir.';

-- Igual que plusmedik_history_save (misma validación y mismo resultado) y además guarda el teléfono: en la fila nueva y en las filas anteriores del mismo contacto que aún no lo tienen.
create or replace function public.plusmedik_history_put(
  p_account_id text, p_contact_key text, p_message_id text, p_direction text, p_actor text, p_origin text,
  p_content_kind text, p_message_type text, p_body text, p_body_cipher text, p_key_id text, p_media_ref text,
  p_delivery_state text, p_audit_run_id uuid, p_reply_to text, p_occurred_at timestamptz, p_retention_days integer,
  p_contact_phone text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_contact_phone is null or p_contact_phone !~ '^[0-9]{6,20}$' then
    raise exception 'plusmedik_history: invalid input' using errcode = 'PT422';
  end if;
  v_result := public.plusmedik_history_save(p_account_id, p_contact_key, p_message_id, p_direction, p_actor, p_origin, p_content_kind, p_message_type, p_body, p_body_cipher, p_key_id, p_media_ref, p_delivery_state, p_audit_run_id, p_reply_to, p_occurred_at, p_retention_days);
  update public.plusmedik_message_history set contact_phone = p_contact_phone where contact_key = p_contact_key and contact_phone is null;
  return v_result;
end
$$;

-- Exportación autorizada (misma firma que en la 21 y la 22): ahora también devuelve el teléfono (contact_phone). Exige un motivo y deja un rastro sin contenido.
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
    select m.seq, m.contact_key, m.contact_phone, m.provider_message_id as message_id, m.direction, m.actor, m.origin, m.content_kind, m.message_type, m.body, m.body_cipher, m.key_id, m.media_ref,
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

comment on table public.plusmedik_message_history is 'Historial de mensajes. Texto en claro (body) o cifrado por la aplicación (body_cipher), con el teléfono del contacto (contact_phone) y su clave HMAC (contact_key), sin vencimiento por defecto. Solo se accede por las funciones plusmedik_history_*.';

revoke all on function public.plusmedik_history_put(text, text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer, text) from public, anon, authenticated;
revoke all on function public.plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_history_put(text, text, text, text, text, text, text, text, text, text, text, text, text, uuid, text, timestamptz, integer, text) to service_role;
grant execute on function public.plusmedik_history_export(text, text, timestamptz, timestamptz, bigint, integer) to service_role;
