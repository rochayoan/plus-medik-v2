-- PlusMedik V2 G5.9: flujo de cotización por TEXTO. Migración ADITIVA y posterior a 20261101000000 (cola de salida al CRM): agrega UNA función de apoyo y REEMPLAZA dos funciones de la
-- migración 11 (plusmedik_quote_session_read y plusmedik_quote_session_close); no toca tablas, columnas, índices ni datos. Solo define esquema local: NO se aplica a ningún Supabase remoto
-- desde el repositorio.
-- Orden: 1 -> ... -> 13 -> esta.
--
-- ───────────────────────── Qué cambia (y qué no) ─────────────────────────
--   1. El turno que cierra la sesión puede traer su PROPIO ítem. Antes solo contaban los ítems de turnos anteriores (el cierre era siempre un «listo» sin estudios). Ahora un mensaje como
--      «cotízame hemograma y glucosa» agrega su ítem y cierra la sesión en el mismo turno, sin exigir «listo». Para el turno que no trae ítem (el «listo» de siempre) NADA cambia.
--      Si el cierre pide reenviar fotos, el ítem legible del propio turno también pasa a la sesión nueva.
--   2. Un ítem AMBIGUOUS (el paciente escribió un nombre que corresponde a varios estudios del catálogo) queda ACLARADO cuando un mensaje de TEXTO POSTERIOR, ya identificado con certeza
--      (RESOLVED), contiene al menos una de las opciones de CADA grupo ambiguo. Un ítem aclarado aporta los estudios que había identificado; sin aclarar sigue bloqueando la cotización (PT409),
--      exactamente como antes. Los ítems UNRESOLVED, UNCERTAIN, UNREADABLE y en proceso siguen sin poder cotizarse.
--   Todo lo demás (idempotencia por corrida, owner + fence, espera de turnos anteriores en proceso, verificación de que lo cotizado sea EXACTAMENTE lo identificado, cola de revisión, ítems
--   de turnos posteriores a una sesión nueva) es idéntico a la migración 11.

-- ───────────────────────── 0. función de apoyo ─────────────────────────
-- Para cada ítem AMBIGUOUS de la sesión hasta el turno p_seq: si quedó aclarado. Un ítem sin grupos (no debería existir) cuenta como sin aclarar. Solo lectura; no se concede a ningún rol.
create or replace function public.plusmedik_quote_ambiguity_state(p_session_id uuid, p_seq bigint)
returns table (item_seq bigint, study_ids uuid[], settled boolean)
language sql
stable
set search_path = ''
as $$
  select i.seq, i.study_ids,
    jsonb_array_length(i.ambiguous) > 0 and not exists (
      select 1 from jsonb_array_elements(i.ambiguous) g
      where not (array(select (e)::uuid from jsonb_array_elements_text(g) e) && coalesce((
        select array_agg(distinct s) from public.plusmedik_quote_items l cross join lateral unnest(l.study_ids) s
        where l.session_id = p_session_id and l.seq > i.seq and l.seq <= p_seq and l.kind = 'TEXT' and l.status = 'RESOLVED'), '{}'::uuid[])))
  from public.plusmedik_quote_items i
  where i.session_id = p_session_id and i.seq <= p_seq and i.status = 'AMBIGUOUS'
$$;

-- ───────────────────────── 1. lectura para cerrar ─────────────────────────
create or replace function public.plusmedik_quote_session_read(p_run_id uuid, p_owner text, p_fence bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_closed public.plusmedik_quote_sessions%rowtype;
  v_session public.plusmedik_quote_sessions%rowtype;
  v_pending integer;
  v_items jsonb;
  v_result public.plusmedik_quote_results%rowtype;
begin
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);

  select * into v_closed from public.plusmedik_quote_sessions where closed_by_run = p_run_id;
  if found then
    select * into v_result from public.plusmedik_quote_results where session_id = v_closed.id;
    return jsonb_build_object('state', 'replay', 'sessionId', v_closed.id, 'outcome', v_closed.status, 'reasons', to_jsonb(v_closed.reasons),
      'lines', v_result.lines, 'totalBs', v_result.total_bs);
  end if;

  update public.plusmedik_quote_sessions set status = 'EXPIRED', closed_at = clock_timestamp() where contact_key = v_contact and status = 'OPEN' and expires_at <= clock_timestamp();
  select * into v_session from public.plusmedik_quote_sessions where contact_key = v_contact and status = 'OPEN';
  if not found then
    return jsonb_build_object('state', 'none');
  end if;
  v_pending := public.plusmedik_quote_pending_before(v_contact, v_seq);
  if v_pending > 0 then
    return jsonb_build_object('state', 'pending', 'pending', v_pending);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'seq', i.seq, 'kind', i.kind, 'studyIds', to_jsonb(i.study_ids), 'ambiguous', i.ambiguous, 'unresolved', i.unresolved_count, 'reasons', to_jsonb(i.reasons),
    'status', case when i.status = 'PROCESSING' then 'UNREADABLE' else i.status end) order by i.seq), '[]'::jsonb) into v_items
  from public.plusmedik_quote_items i where i.session_id = v_session.id and i.seq <= v_seq;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('state', 'none');
  end if;
  return jsonb_build_object('state', 'ready', 'sessionId', v_session.id, 'items', v_items);
end $$;

-- ───────────────────────── 2. cierre ─────────────────────────
create or replace function public.plusmedik_quote_session_close(p_run_id uuid, p_owner text, p_fence bigint, p_session_id uuid, p_outcome text, p_lines jsonb, p_total numeric, p_reasons text[], p_catalog_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_session public.plusmedik_quote_sessions%rowtype;
  v_prior public.plusmedik_quote_sessions%rowtype;
  v_new_id uuid;
  v_resolved uuid[];
  v_line_ids uuid[];
  v_bad integer;
  v_unreadable integer;
  v_uncertain integer;
  v_sum numeric;
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('QUOTED', 'NEEDS_REVIEW', 'NEEDS_RESEND', 'CANCELLED') or p_session_id is null
     or (p_outcome = 'QUOTED' and (p_lines is null or p_total is null or p_catalog_fingerprint is null or p_catalog_fingerprint !~ '^[A-Za-z0-9_.:-]{1,80}$'))
     or (p_outcome = 'NEEDS_REVIEW' and (p_reasons is null or cardinality(p_reasons) not between 1 and 8))
     or (p_reasons is not null and not (p_reasons <@ array['AMBIGUOUS_STUDY', 'UNRESOLVED_TEXT', 'ENGINE_PARTIAL', 'UNREADABLE_IMAGE', 'STUDY_UNAVAILABLE', 'PRICE_INVALID'])) then
    raise exception 'plusmedik_quote: invalid close' using errcode = 'PT422';
  end if;
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    raise exception 'plusmedik_quote: turn not found' using errcode = 'PT404';
  end if;
  perform 1 from public.plusmedik_contact_turns where contact_key = v_contact for update;
  perform public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);

  select * into v_prior from public.plusmedik_quote_sessions where closed_by_run = p_run_id;
  if found then
    return jsonb_build_object('status', 'replayed', 'sessionId', v_prior.id, 'outcome', v_prior.status);
  end if;
  select * into v_session from public.plusmedik_quote_sessions where id = p_session_id and contact_key = v_contact for update;
  if not found or v_session.status <> 'OPEN' then
    return jsonb_build_object('status', 'not_open');
  end if;
  if public.plusmedik_quote_pending_before(v_contact, v_seq) > 0 then
    return jsonb_build_object('status', 'pending');
  end if;

  -- Cuentan los ítems de turnos ANTERIORES y el del propio turno que cierra (un mensaje que pide cotizar y a la vez trae los estudios).
  select count(*) filter (where i.status in ('UNREADABLE', 'PROCESSING')),
         count(*) filter (where i.status in ('UNRESOLVED', 'UNCERTAIN')),
         coalesce(array_agg(distinct s) filter (where i.status = 'RESOLVED'), '{}'::uuid[])
    into v_unreadable, v_uncertain, v_resolved
  from public.plusmedik_quote_items i left join lateral unnest(i.study_ids) s on true
  where i.session_id = v_session.id and i.seq <= v_seq;

  -- Un ítem AMBIGUOUS aclarado aporta los estudios que sí había identificado; uno sin aclarar sigue siendo una duda y no se cotiza.
  select v_uncertain + count(*) filter (where not a.settled),
         array(select distinct u from unnest(v_resolved || coalesce(array_agg(s) filter (where a.settled and s is not null), '{}'::uuid[])) u)
    into v_uncertain, v_resolved
  from public.plusmedik_quote_ambiguity_state(v_session.id, v_seq) a left join lateral unnest(a.study_ids) s on true;

  if p_outcome = 'QUOTED' then
    if v_unreadable > 0 or v_uncertain > 0 or cardinality(v_resolved) = 0 then
      raise exception 'plusmedik_quote: session is not quotable' using errcode = 'PT409';
    end if;
    if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 60 then
      raise exception 'plusmedik_quote: invalid lines' using errcode = 'PT422';
    end if;
    -- las claves del JSON son studyId / name / priceBs
    select count(*) filter (where l."studyId" is null or l."priceBs" is null or l."priceBs" <= 0 or l.name is null or length(l.name) not between 1 and 200 or l.name ~ '[[:cntrl:]]'),
           coalesce(array_agg(l."studyId"), '{}'::uuid[]), coalesce(sum(l."priceBs"), 0)
      into v_bad, v_line_ids, v_sum
    from jsonb_to_recordset(p_lines) as l("studyId" uuid, name text, "priceBs" numeric);
    if v_bad > 0 or cardinality(v_line_ids) <> (select count(distinct x) from unnest(v_line_ids) x)
       or not (v_line_ids <@ v_resolved and v_resolved <@ v_line_ids) or v_sum <> p_total then
      raise exception 'plusmedik_quote: quote does not match the identified studies' using errcode = 'PT409';
    end if;
  elsif p_outcome = 'NEEDS_REVIEW' then
    if v_unreadable > 0 or (v_uncertain = 0 and not (p_reasons && array['STUDY_UNAVAILABLE', 'PRICE_INVALID'])) then
      raise exception 'plusmedik_quote: review without cause' using errcode = 'PT409';
    end if;
  elsif p_outcome = 'NEEDS_RESEND' then
    if v_unreadable = 0 then
      raise exception 'plusmedik_quote: nothing to resend' using errcode = 'PT409';
    end if;
  end if;

  v_status := p_outcome;
  update public.plusmedik_quote_sessions set status = v_status, closed_at = clock_timestamp(), closed_by_run = p_run_id, closed_seq = v_seq,
    reasons = coalesce(p_reasons, '{}'::text[]) where id = v_session.id;

  if p_outcome = 'QUOTED' then
    insert into public.plusmedik_quote_results (session_id, run_id, lines, total_bs, catalog_fingerprint) values (v_session.id, p_run_id, p_lines, p_total, p_catalog_fingerprint);
  elsif p_outcome = 'NEEDS_REVIEW' then
    insert into public.plusmedik_quote_reviews (session_id, contact_key, run_id, reasons, item_ids)
    values (v_session.id, v_contact, p_run_id, p_reasons, (select coalesce(array_agg(id), '{}'::uuid[]) from public.plusmedik_quote_items where session_id = v_session.id and seq <= v_seq));
  end if;

  -- Lo que queda para seguir (turnos posteriores; y, si se pidió reenviar, lo legible) pasa a una sesión nueva.
  if exists (select 1 from public.plusmedik_quote_items i where i.session_id = v_session.id and (i.seq > v_seq or (p_outcome = 'NEEDS_RESEND' and i.seq <= v_seq and i.status not in ('UNREADABLE', 'PROCESSING', 'DUPLICATE')))) then
    insert into public.plusmedik_quote_sessions (contact_key, expires_at) values (v_contact, greatest(v_session.expires_at, clock_timestamp() + interval '60 seconds')) returning id into v_new_id;
    update public.plusmedik_quote_items set session_id = v_new_id
    where session_id = v_session.id and (seq > v_seq or (p_outcome = 'NEEDS_RESEND' and seq <= v_seq and status not in ('UNREADABLE', 'PROCESSING', 'DUPLICATE')));
  end if;
  return jsonb_build_object('status', 'closed', 'sessionId', v_session.id, 'outcome', v_status, 'carriedTo', v_new_id);
end $$;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_quote_ambiguity_state(uuid, bigint) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_session_read(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text) from public, anon, authenticated;
grant execute on function public.plusmedik_quote_session_read(uuid, text, bigint) to service_role;
grant execute on function public.plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text) to service_role;

comment on function public.plusmedik_quote_session_read(uuid, text, bigint) is 'Estado de la sesión para cerrarla: none | pending | ready | replay. Incluye el ítem del propio turno. Con owner + fence. Solo service_role.';
comment on function public.plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text) is 'Cierra la sesión (QUOTED, NEEDS_REVIEW, NEEDS_RESEND, CANCELLED) verificando que lo cotizado sea exactamente lo identificado (con el ítem del propio turno y las ambigüedades aclaradas). Idempotente por corrida. Solo service_role.';
