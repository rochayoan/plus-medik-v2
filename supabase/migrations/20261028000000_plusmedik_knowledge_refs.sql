-- PlusMedik V2 G3.1A: trazabilidad de las respuestas basadas en conocimiento. Migración ADITIVA y posterior a 20261027000000 (conocimiento): una tabla y dos funciones nuevas;
-- no modifica ni borra nada anterior. Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio.
-- Orden: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> esta.
--
-- ───────────────────────── Qué resuelve ─────────────────────────
-- Cuando el agente responde con información del laboratorio (un horario, una preparación...), debe quedar registrado QUÉ versiones aprobadas respaldaron esa respuesta, para
-- poder contestar después: «si esta versión era incorrecta, ¿a qué conversaciones se la dijimos?». Cada fila liga un turno (corrida) con (tipo, clave, versión, hash del
-- contenido aprobado). NO guarda el texto del paciente, ni el texto de la respuesta, ni teléfonos: solo referencias a conocimiento ya aprobado.
--
-- ───────────────────────── Garantías ─────────────────────────
--   · Se escribe con owner + fence (lease vigente): una ejecución antigua que revive no puede dejar rastro.
--   · Solo ANTES de reservar el envío: con el envío ya reservado/aceptado/cancelado responde 'closed' y no inserta. Así, toda respuesta basada en conocimiento que se envió
--     tiene su rastro registrado primero (el cliente NO envía si el registro falla).
--   · Idempotente: repetir el mismo registro no duplica (unique por turno, generación del lease, tipo y clave).
--   · Cada intento (generación del lease) deja sus propias referencias: si una ejecución registró la versión 1 y murió antes de enviar, y otra reclama el turno y registra la
--     versión 2, ambas quedan; la respuesta enviada es la de la generación que reservó (la última).
--   · Inmutable: nadie (ni el propietario) puede modificar ni borrar estas filas.
--
-- ───────────────────────── Límites ─────────────────────────
--   · Registra lo que la respuesta DECLARÓ usar; no puede probar que el texto enviado coincida con ello (eso lo cubren las pruebas de la capa de respuestas).
--   · No se verifica contra la tabla de versiones (la versión pudo haberse retirado un instante después): es una foto de lo usado.

create table if not exists public.plusmedik_turn_knowledge_refs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.plusmedik_audit_runs(id),
  lease_fence bigint not null check (lease_fence >= 1),
  kind text not null check (kind in ('BRANCH', 'SCHEDULE', 'POLICY', 'PAYMENT_METHOD', 'FAQ', 'STUDY_PREPARATION')),
  key text not null check (key ~ '^[a-z0-9][a-z0-9_.:-]{0,95}$'),
  version integer not null check (version >= 1),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (run_id, lease_fence, kind, key)
);
create index if not exists plusmedik_turn_knowledge_refs_usage_idx on public.plusmedik_turn_knowledge_refs (kind, key, version);
create index if not exists plusmedik_turn_knowledge_refs_run_idx on public.plusmedik_turn_knowledge_refs (run_id);

alter table public.plusmedik_turn_knowledge_refs enable row level security;
revoke all on table public.plusmedik_turn_knowledge_refs from public, anon, authenticated;
revoke insert, update, delete, truncate on table public.plusmedik_turn_knowledge_refs from service_role;
grant select on table public.plusmedik_turn_knowledge_refs to service_role;

comment on table public.plusmedik_turn_knowledge_refs is 'Qué versiones aprobadas de conocimiento respaldaron la respuesta de cada turno. Sin texto de pacientes ni de respuestas. Inmutable.';

create or replace trigger plusmedik_turn_knowledge_refs_immutable before update or delete on public.plusmedik_turn_knowledge_refs
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_turn_knowledge_refs_no_truncate before truncate on public.plusmedik_turn_knowledge_refs
  for each statement execute function public.plusmedik_audit_forbid_mutation();

-- p_refs: [{kind, key, version, contentHash}] (1..20, sin claves extra). Resultado: {status: 'recorded', count} | {status: 'closed'} (el envío ya se reservó o el turno se cerró).
create or replace function public.plusmedik_turn_record_knowledge(p_run_id uuid, p_owner text, p_fence bigint, p_refs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  e jsonb;
  v_count integer;
begin
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' or jsonb_array_length(p_refs) not between 1 and 20 then
    raise exception 'plusmedik_turn: invalid knowledge references' using errcode = 'PT422';
  end if;
  for e in select * from jsonb_array_elements(p_refs) loop
    if not (jsonb_typeof(e) = 'object' and public.plusmedik_audit_keys_within(e, array['kind', 'key', 'version', 'contentHash']) and e ?& array['kind', 'key', 'version', 'contentHash']
        and jsonb_typeof(e -> 'kind') = 'string' and (e ->> 'kind') in ('BRANCH', 'SCHEDULE', 'POLICY', 'PAYMENT_METHOD', 'FAQ', 'STUDY_PREPARATION')
        and jsonb_typeof(e -> 'key') = 'string' and (e ->> 'key') ~ '^[a-z0-9][a-z0-9_.:-]{0,95}$'
        and jsonb_typeof(e -> 'version') = 'number' and (e ->> 'version') ~ '^[1-9][0-9]{0,8}$'
        and jsonb_typeof(e -> 'contentHash') = 'string' and (e ->> 'contentHash') ~ '^[0-9a-f]{64}$') then
      raise exception 'plusmedik_turn: invalid knowledge references' using errcode = 'PT422';
    end if;
  end loop;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if not exists (select 1 from public.plusmedik_turns where run_id = p_run_id) then
    raise exception 'plusmedik_turn: turn not found' using errcode = 'PT404';
  end if;
  if v_run.send_state <> 'NOT_RESERVED' or v_run.processing_status not in ('PROCESSING', 'ANALYZED') then
    return jsonb_build_object('status', 'closed');
  end if;
  insert into public.plusmedik_turn_knowledge_refs (run_id, lease_fence, kind, key, version, content_hash)
  select p_run_id, p_fence, r ->> 'kind', r ->> 'key', (r ->> 'version')::integer, r ->> 'contentHash' from jsonb_array_elements(p_refs) as r
  on conflict (run_id, lease_fence, kind, key) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'recorded', 'count', v_count);
end $$;

-- Impacto: ¿a qué turnos se les dio información respaldada por esta versión (o por cualquiera del elemento)? Para decidir qué hacer si un dato resultó incorrecto.
-- Devuelve identificadores seudónimos (corrida, clave de contacto) y el estado del envío, nunca teléfonos ni texto. Solo cuenta intentos cuyo envío llegó a reservarse.
create or replace function public.plusmedik_kb_usage(p_kind text, p_key text, p_version integer default null, p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind is null or p_kind not in ('BRANCH', 'SCHEDULE', 'POLICY', 'PAYMENT_METHOD', 'FAQ', 'STUDY_PREPARATION') or p_key is null or p_key !~ '^[a-z0-9][a-z0-9_.:-]{0,95}$'
     or (p_version is not null and p_version < 1) or p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'plusmedik_turn: invalid usage query' using errcode = 'PT422';
  end if;
  return jsonb_build_object('uses', coalesce((
    select jsonb_agg(row_to_json(x)::jsonb) from (
      select r.id as "runId", r.contact_key as "contactKey", f.version, f.recorded_at as "recordedAt", r.send_state as "sendState", r.reply_state as "replyState"
      from public.plusmedik_turn_knowledge_refs f join public.plusmedik_audit_runs r on r.id = f.run_id
      where f.kind = p_kind and f.key = p_key and (p_version is null or f.version = p_version) and f.lease_fence = r.lease_fence
        and r.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN')
      order by f.recorded_at desc, f.id limit p_limit) x), '[]'::jsonb));
end $$;

revoke all on function public.plusmedik_turn_record_knowledge(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_kb_usage(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_record_knowledge(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.plusmedik_kb_usage(text, text, integer, integer) to service_role;

comment on function public.plusmedik_turn_record_knowledge(uuid, text, bigint, jsonb) is 'Registra, antes de reservar el envío y con owner + fence, qué versiones aprobadas respaldan la respuesta de un turno. Idempotente. Solo service_role.';
comment on function public.plusmedik_kb_usage(text, text, integer, integer) is 'A qué turnos (seudónimos) se les respondió con esta versión de conocimiento. Solo service_role.';
