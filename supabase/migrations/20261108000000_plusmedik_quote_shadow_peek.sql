-- PlusMedik V2 · migración 20: lectura de SOLO LECTURA de la solicitud abierta, para el modo sombra del motor de lotes (PLUSMEDIK_BATCH_ENGINE=shadow).
-- Crea UNA función nueva; no toca tablas, columnas, índices, triggers ni datos, y no modifica ninguna función existente. Solo define esquema local: NO se aplica a ningún Supabase remoto.
-- Por qué existe: plusmedik_quote_session_read (la lectura de siempre) toma bloqueos de fila y marca como vencidas las sesiones vencidas; es correcta para quien va a cerrar la solicitud, pero el
-- modo sombra no debe escribir NADA. Esta función es STABLE: PostgreSQL no permite que una función STABLE modifique datos ni tome bloqueos de fila (SELECT ... FOR UPDATE), así que la garantía de
-- "solo lectura" la impone la propia base, no la disciplina de quien la llama.
-- Qué devuelve (jsonb): { state, pending?, items?, recent }
--   state: none | pending | ready | replay | lease_lost | unavailable
--   items: los ítems de la solicitud abierta VISIBLES para ese turno (seq <= el del turno), con la misma forma que plusmedik_quote_session_read
--   recent: ¿hubo una cotización entregada a este contacto en los últimos p_recent_seconds? (solo un booleano; nunca ids ni precios)
-- Con owner + fence del turno (como el resto): sin el lease vigente no devuelve datos. Solo service_role.

create or replace function public.plusmedik_quote_shadow_peek(p_run_id uuid, p_owner text, p_fence bigint, p_recent_seconds integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact text;
  v_seq bigint;
  v_run public.plusmedik_audit_runs%rowtype;
  v_session public.plusmedik_quote_sessions%rowtype;
  v_pending integer;
  v_items jsonb;
  v_recent boolean;
begin
  if p_run_id is null or p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{8,64}$' or p_fence is null or p_fence < 1
     or p_recent_seconds is null or p_recent_seconds not between 60 and 604800 then
    raise exception 'plusmedik_quote: invalid peek' using errcode = 'PT422';
  end if;
  select * into v_run from public.plusmedik_audit_runs where id = p_run_id;
  if not found then
    return jsonb_build_object('state', 'unavailable', 'recent', false);
  end if;
  if v_run.lease_fence is null or v_run.lease_owner is distinct from p_owner or v_run.lease_fence <> p_fence then
    return jsonb_build_object('state', 'lease_lost', 'recent', false);
  end if;
  select contact_key, seq into v_contact, v_seq from public.plusmedik_turns where run_id = p_run_id;
  if not found then
    return jsonb_build_object('state', 'unavailable', 'recent', false);
  end if;

  select exists (
    select 1 from public.plusmedik_quote_results q join public.plusmedik_quote_sessions s on s.id = q.session_id
    where s.contact_key = v_contact and s.status = 'QUOTED' and q.created_at > clock_timestamp() - make_interval(secs => p_recent_seconds)
  ) into v_recent;

  if exists (select 1 from public.plusmedik_quote_sessions where closed_by_run = p_run_id) then
    return jsonb_build_object('state', 'replay', 'recent', v_recent);
  end if;
  -- Una sesión vencida se trata como inexistente (la lectura de siempre la marcaría EXPIRED; esta no escribe).
  select * into v_session from public.plusmedik_quote_sessions where contact_key = v_contact and status = 'OPEN' and expires_at > clock_timestamp();
  if not found then
    return jsonb_build_object('state', 'none', 'recent', v_recent);
  end if;
  v_pending := public.plusmedik_quote_pending_before(v_contact, v_seq);
  if v_pending > 0 then
    return jsonb_build_object('state', 'pending', 'pending', v_pending, 'recent', v_recent);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'seq', i.seq, 'kind', i.kind, 'studyIds', to_jsonb(i.study_ids), 'ambiguous', i.ambiguous, 'unresolved', i.unresolved_count, 'reasons', to_jsonb(i.reasons),
    'status', case when i.status = 'PROCESSING' then 'UNREADABLE' else i.status end) order by i.seq), '[]'::jsonb) into v_items
  from public.plusmedik_quote_items i where i.session_id = v_session.id and i.seq <= v_seq;
  if jsonb_array_length(v_items) = 0 then
    return jsonb_build_object('state', 'none', 'recent', v_recent);
  end if;
  return jsonb_build_object('state', 'ready', 'items', v_items, 'recent', v_recent);
end $$;

revoke all on function public.plusmedik_quote_shadow_peek(uuid, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_quote_shadow_peek(uuid, text, bigint, integer) to service_role;

comment on function public.plusmedik_quote_shadow_peek(uuid, text, bigint, integer) is 'Solo lectura (STABLE): la solicitud abierta visible para un turno y si hubo una cotización reciente. No escribe, no bloquea filas y no vence sesiones. Con owner + fence. Solo service_role.';
