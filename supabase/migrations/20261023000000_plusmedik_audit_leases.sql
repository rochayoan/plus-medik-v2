-- PlusMedik V2 F1.3: leases, fencing y recuperación segura de procesamientos interrumpidos.
-- Migración ADITIVA y posterior a 20261020000000, 20261021000000 y 20261022000000 (no las modifica ni crea tablas). Solo define esquema local: no se aplica a
-- ningún Supabase remoto desde el repositorio. Orden: 20261020000000 -> 20261021000000 -> 20261022000000 -> esta.
--
-- ───────────────────────── Prioridad: nunca enviar dos respuestas al mismo paciente ─────────────────────────
-- La exclusión NO depende del reloj ni de temporizadores: depende de una RESERVA de envío que se concede una sola vez, bajo bloqueo de fila, a la ejecución que
-- posee el lease con la generación (fence) vigente. Una ejecución solo puede llamar a Kapso después de que la base le confirme la reserva.
--
-- Lease: lease_owner (propietario único de la ejecución), lease_expires_at (vencimiento), lease_fence (generación; solo sube), lease_attempts.
--   · plusmedik_audit_claim_run    reclama el mensaje (idempotente por kapso_message_id) y concede el lease; reclama de forma atómica un lease VENCIDO
--                                  (fence + 1) solo si el procesamiento sigue recuperable (sin reserva de envío).
--   · plusmedik_audit_renew_lease  extiende el lease del propietario vigente.
--   · Toda escritura de una corrida con lease exige owner + fence (funciones plusmedik_audit_fenced_* y reserve_send). Una ejecución antigua recibe PT410
--     (lease perdido) y no puede escribir ni enviar. Un trigger lo impone también contra escrituras directas sobre corridas con lease.
--
-- Envío (send_state), la parte más delicada:
--   NOT_RESERVED -> RESERVED (plusmedik_audit_reserve_send, antes de llamar a Kapso) -> ACCEPTED | UNKNOWN (plusmedik_audit_fenced_record_reply)
--   NOT_RESERVED -> CANCELLED (bloqueo previo al envío, ver block_send) | NOT_APPLICABLE (cierre sin respuesta)
--   Una corrida RESERVED NUNCA se reabre ni se vuelve a enviar: si la ejecución muere durante o después de llamar a Kapso, el resultado es DESCONOCIDO y
--   plusmedik_audit_recover_stale lo marca UNKNOWN (SEND_OUTCOME_UNKNOWN) para conciliación o revisión humana. No se asume que Kapso garantice exactly-once.
--
-- Fases (vista plusmedik_audit_run_phase): RECOVERABLE, ANALYZED_UNSENT, SENDING, SENT_ACCEPTED, SEND_UNKNOWN, NEEDS_ATTENTION, CLOSED_NO_SEND.
--
-- ───────────────────────── Límites (lo que NO garantiza) ─────────────────────────
-- · Sin teléfono ni acceso a la imagen en la base (por privacidad, F6), el recuperador NO puede reprocesar ni responder: solo cierra de forma segura lo
--   interrumpido (UNKNOWN / ABANDONED_BEFORE_SEND). Una reanudación automática sólo es posible si el mensaje se vuelve a entregar (reclamo con lease vencido).
-- · Un mensaje cuyo claim nunca llegó a la base no deja rastro recuperable.
-- · Las corridas anteriores a esta migración (sin lease_fence) conservan el comportamiento de F1.2 y NO se reabren nunca.
-- · Quien tenga la credencial de service_role puede llamar a las funciones con el owner/fence que haya obtenido, pero no puede forjar la prueba interna ni
--   escribir columnas protegidas directamente; el propietario/superusuario de la base sigue pudiendo todo (como en F1.2).

alter table public.plusmedik_audit_runs
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists lease_fence bigint,
  add column if not exists lease_attempts integer,
  add column if not exists send_state text not null default 'NOT_RESERVED',
  add column if not exists send_kind text,
  add column if not exists send_reserved_at timestamptz,
  add column if not exists send_blocked_at timestamptz,
  add column if not exists send_block_reason text,
  add column if not exists attention_reason text,
  add column if not exists attention_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plusmedik_audit_runs_lease_check') then
    alter table public.plusmedik_audit_runs add constraint plusmedik_audit_runs_lease_check check (
      send_state in ('NOT_RESERVED', 'RESERVED', 'ACCEPTED', 'UNKNOWN', 'CANCELLED', 'NOT_APPLICABLE')
      and (send_kind is null or send_kind in ('quoted', 'no_quote', 'technical_issue'))
      and (lease_owner is null or lease_owner ~ '^[A-Za-z0-9_.:-]{8,64}$')
      and (lease_fence is null or lease_fence >= 1)
      and (lease_attempts is null or lease_attempts >= 1)
      and ((lease_fence is null) = (lease_attempts is null))
      and (send_block_reason is null or send_block_reason ~ '^[A-Za-z0-9_.:-]{1,64}$')
      and (attention_reason is null or attention_reason ~ '^[A-Za-z0-9_.:-]{1,64}$')
    );
  end if;
end $$;

create index if not exists plusmedik_audit_runs_lease_idx
  on public.plusmedik_audit_runs (lease_expires_at)
  where lease_fence is not null and send_state in ('NOT_RESERVED', 'RESERVED');

comment on column public.plusmedik_audit_runs.lease_owner is 'Identificador único de la ejecución que posee el lease. NULL = corrida sin lease (anterior a F1.3).';
comment on column public.plusmedik_audit_runs.lease_fence is 'Generación del lease: sube en cada cambio de propietario o cierre por recuperación. Toda escritura debe presentar la generación vigente.';
comment on column public.plusmedik_audit_runs.send_state is 'NOT_RESERVED | RESERVED (se concedió el envío; puede haber llamada a Kapso en curso) | ACCEPTED | UNKNOWN (resultado desconocido: nunca se reenvía) | CANCELLED | NOT_APPLICABLE.';
comment on column public.plusmedik_audit_runs.attention_reason is 'Motivo por el que el caso requiere conciliación o revisión humana (SEND_OUTCOME_UNKNOWN, ABANDONED_BEFORE_SEND...).';

-- ───────────────────────── prueba interna de fencing (solo para las funciones de esta migración) ─────────────────────────
-- Las funciones SECURITY DEFINER verifican owner + fence bajo bloqueo de fila y dejan una prueba local a la transacción; el trigger de runs la exige para
-- cualquier cambio de columnas operativas o de lease de una corrida con lease. Nadie más puede ejecutarla (ni service_role).
create or replace function public.plusmedik_audit_prove(p_run_id uuid, p_fence bigint)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('plusmedik.fence_proof', p_run_id::text || ':' || p_fence::text, true);
end $$;

-- ───────────────────────── trigger de runs: F1.2 + lease/fence ─────────────────────────
-- Reemplaza la función del trigger de F1.2 (misma lógica) y agrega: protección de las columnas de lease/envío con la prueba de fencing, fence monotónico
-- y transiciones válidas de send_state. Las corridas sin lease (anteriores) se comportan exactamente como en F1.2.
create or replace function public.plusmedik_audit_runs_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.kapso_message_id, new.kapso_media_id, new.received_at, new.started_at, new.created_at, new.detail_expires_at, new.metrics_expires_at, new.audit_schema_version, new.engine_version, new.flags)
     is distinct from
     (old.id, old.kapso_message_id, old.kapso_media_id, old.received_at, old.started_at, old.created_at, old.detail_expires_at, old.metrics_expires_at, old.audit_schema_version, old.engine_version, old.flags) then
    raise exception 'plusmedik_audit: run identity and registered versions are immutable' using errcode = 'PT409';
  end if;

  if (new.analysis_decision, new.analysis_outcome, new.review_required, new.recipe_stops, new.document_summary, new.catalog_hash, new.catalog_size, new.config_hash, new.evidence_hash, new.evidence_recorded_at)
     is distinct from
     (old.analysis_decision, old.analysis_outcome, old.review_required, old.recipe_stops, old.document_summary, old.catalog_hash, old.catalog_size, old.config_hash, old.evidence_hash, old.evidence_recorded_at)
     and not (old.evidence_recorded_at is null and new.evidence_recorded_at is not null) then
    raise exception 'plusmedik_audit: analysis evidence is immutable once recorded' using errcode = 'PT409';
  end if;

  if old.detail_purged_at is not null and new.detail_purged_at is distinct from old.detail_purged_at then
    raise exception 'plusmedik_audit: purge marker is immutable' using errcode = 'PT409';
  end if;

  -- F1.3: una corrida con lease solo se modifica con la prueba de fencing que dejan las funciones de esta migración (tras verificar owner + fence).
  if old.lease_fence is not null then
    if (new.analysis_decision, new.analysis_outcome, new.review_required, new.recipe_stops, new.document_summary, new.catalog_hash, new.catalog_size, new.config_hash, new.evidence_hash, new.evidence_recorded_at,
        new.processing_status, new.completed_at, new.error_code, new.reply_state, new.reply_kind, new.kapso_outbound_message_id,
        new.lease_owner, new.lease_expires_at, new.lease_fence, new.lease_attempts, new.send_state, new.send_kind, new.send_reserved_at, new.send_blocked_at, new.send_block_reason, new.attention_reason, new.attention_at)
       is distinct from
       (old.analysis_decision, old.analysis_outcome, old.review_required, old.recipe_stops, old.document_summary, old.catalog_hash, old.catalog_size, old.config_hash, old.evidence_hash, old.evidence_recorded_at,
        old.processing_status, old.completed_at, old.error_code, old.reply_state, old.reply_kind, old.kapso_outbound_message_id,
        old.lease_owner, old.lease_expires_at, old.lease_fence, old.lease_attempts, old.send_state, old.send_kind, old.send_reserved_at, old.send_blocked_at, old.send_block_reason, old.attention_reason, old.attention_at)
       and coalesce(current_setting('plusmedik.fence_proof', true), '') <> old.id::text || ':' || old.lease_fence::text then
      raise exception 'plusmedik_audit: lease fencing proof missing or stale' using errcode = 'PT410';
    end if;
    if new.lease_fence < old.lease_fence then
      raise exception 'plusmedik_audit: lease fence cannot decrease' using errcode = 'PT409';
    end if;
    if new.send_state is distinct from old.send_state and not (
         (old.send_state = 'NOT_RESERVED' and new.send_state in ('RESERVED', 'CANCELLED', 'NOT_APPLICABLE'))
      or (old.send_state = 'RESERVED' and new.send_state in ('ACCEPTED', 'UNKNOWN'))) then
      raise exception 'plusmedik_audit: invalid send state transition' using errcode = 'PT409';
    end if;
  end if;

  if new.processing_status is distinct from old.processing_status and not (
       (old.processing_status = 'PROCESSING' and new.processing_status in ('ANALYZED', 'FAILED', 'IGNORED', 'COMPLETED'))
    or (old.processing_status = 'ANALYZED' and new.processing_status in ('COMPLETED', 'FAILED'))
    or (old.processing_status = 'IGNORED' and new.processing_status = 'COMPLETED')) then
    raise exception 'plusmedik_audit: invalid processing status transition' using errcode = 'PT409';
  end if;

  if (old.reply_state <> 'NOT_ATTEMPTED' and new.reply_state is distinct from old.reply_state)
     or (old.reply_kind is not null and new.reply_kind is distinct from old.reply_kind)
     or (old.kapso_outbound_message_id is not null and new.kapso_outbound_message_id is distinct from old.kapso_outbound_message_id)
     or (old.error_code is not null and new.error_code is distinct from old.error_code)
     or (old.completed_at is not null and new.completed_at is null) then
    raise exception 'plusmedik_audit: operational result already recorded' using errcode = 'PT409';
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────── claim / renovación ─────────────────────────

-- Resultado: {"outcome": claimed | taken_over | busy | in_doubt | finished | exhausted, "run_id", "fence", "attempt", "status"}.
--   claimed      mensaje nuevo: lease concedido (fence 1).
--   taken_over   lease VENCIDO de un procesamiento todavía recuperable (sin reserva de envío): nuevo propietario, fence + 1.
--   busy         otro propietario tiene el lease vigente: este webhook es un duplicado en curso.
--   in_doubt     hay (o pudo haber) un envío en curso o sin lease conocido: NO se reabre ni se reenvía.
--   finished     ya terminó (o ya tiene resultado de envío).
--   exhausted    demasiados intentos: lo cierra el recuperador como ABANDONED_BEFORE_SEND.
create or replace function public.plusmedik_audit_claim_run(
  p_message_id text, p_media_id text, p_owner text, p_lease_seconds integer, p_schema_version integer, p_engine_version text, p_flags jsonb, p_max_attempts integer default 3)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_id uuid;
begin
  if p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:-]{1,128}$'
     or (p_media_id is not null and p_media_id !~ '^[A-Za-z0-9_.=:-]{1,128}$')
     or p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{8,64}$'
     or p_lease_seconds is null or p_lease_seconds not between 1 and 900
     or p_schema_version is null or p_schema_version < 2
     or (p_engine_version is not null and p_engine_version !~ '^[0-9a-f]{7,64}$')
     or p_flags is null or jsonb_typeof(p_flags) <> 'object' or not public.plusmedik_audit_token_json_ok(p_flags)
     or p_max_attempts is null or p_max_attempts not between 1 and 10 then
    raise exception 'plusmedik_audit: invalid claim' using errcode = 'PT422';
  end if;

  insert into public.plusmedik_audit_runs (kapso_message_id, kapso_media_id, processing_status, audit_schema_version, engine_version, flags, lease_owner, lease_expires_at, lease_fence, lease_attempts)
  values (p_message_id, p_media_id, 'PROCESSING', p_schema_version, p_engine_version, p_flags, p_owner, now() + make_interval(secs => p_lease_seconds), 1, 1)
  on conflict (kapso_message_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('outcome', 'claimed', 'run_id', v_id, 'fence', 1, 'attempt', 1, 'status', 'PROCESSING');
  end if;

  -- Ya existía: se serializa con cualquier otro webhook o recuperador sobre la misma fila.
  select * into v_run from public.plusmedik_audit_runs where kapso_message_id = p_message_id for update;
  if not found then
    raise exception 'plusmedik_audit: run not found' using errcode = 'PT404';
  end if;
  if v_run.lease_fence is null then
    return jsonb_build_object('outcome', 'in_doubt', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  -- Reintento idéntico de la MISMA ejecución (su primera petición se confirmó pero la respuesta se perdió): sigue siendo suyo, no un duplicado.
  if v_run.lease_owner = p_owner then
    return jsonb_build_object('outcome', 'claimed', 'run_id', v_run.id, 'fence', v_run.lease_fence, 'attempt', v_run.lease_attempts, 'status', v_run.processing_status);
  end if;
  if v_run.send_state = 'RESERVED' then
    return jsonb_build_object('outcome', 'in_doubt', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.send_state <> 'NOT_RESERVED' or v_run.processing_status not in ('PROCESSING', 'ANALYZED') then
    return jsonb_build_object('outcome', 'finished', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.lease_expires_at > now() then
    return jsonb_build_object('outcome', 'busy', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;
  if v_run.lease_attempts >= p_max_attempts then
    return jsonb_build_object('outcome', 'exhausted', 'run_id', v_run.id, 'status', v_run.processing_status);
  end if;

  -- Reclamación atómica del lease vencido: el propietario anterior queda invalidado por el fence.
  perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
  update public.plusmedik_audit_runs set
    lease_owner = p_owner,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    lease_fence = v_run.lease_fence + 1,
    lease_attempts = v_run.lease_attempts + 1
  where id = v_run.id;
  return jsonb_build_object('outcome', 'taken_over', 'run_id', v_run.id, 'fence', v_run.lease_fence + 1, 'attempt', v_run.lease_attempts + 1, 'status', v_run.processing_status);
end $$;

-- Verificación común (bajo bloqueo de fila): la corrida existe y el propietario + generación coinciden. Lanza PT404 / PT410.
create or replace function public.plusmedik_audit_lock_leased(p_run_id uuid, p_owner text, p_fence bigint)
returns public.plusmedik_audit_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if p_run_id is null or p_owner is null or p_owner !~ '^[A-Za-z0-9_.:-]{8,64}$' or p_fence is null or p_fence < 1 then
    raise exception 'plusmedik_audit: invalid lease reference' using errcode = 'PT422';
  end if;
  select * into v_run from public.plusmedik_audit_runs where id = p_run_id for update;
  if not found then
    raise exception 'plusmedik_audit: run not found' using errcode = 'PT404';
  end if;
  if v_run.lease_fence is null or v_run.lease_owner is distinct from p_owner or v_run.lease_fence <> p_fence then
    raise exception 'plusmedik_audit: lease lost' using errcode = 'PT410';
  end if;
  return v_run;
end $$;

-- Renovación controlada: solo el propietario con la generación vigente, y solo mientras el procesamiento siga abierto. No exige que el lease no haya
-- vencido: si nadie lo reclamó (el fence no cambió) sigue siendo el único con derecho a seguir; si alguien lo reclamó, el fence ya no coincide (PT410).
create or replace function public.plusmedik_audit_renew_lease(p_run_id uuid, p_owner text, p_fence bigint, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 900 then
    raise exception 'plusmedik_audit: invalid lease duration' using errcode = 'PT422';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state not in ('NOT_RESERVED', 'RESERVED') then
    return jsonb_build_object('status', 'closed');
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  update public.plusmedik_audit_runs set lease_expires_at = now() + make_interval(secs => p_lease_seconds) where id = p_run_id;
  return jsonb_build_object('status', 'renewed');
end $$;

-- ───────────────────────── escrituras con fencing ─────────────────────────

-- Evidencias del análisis (contrato de F1.2 intacto) presentando owner + fence. Una ejecución antigua recibe PT410 sin escribir nada.
create or replace function public.plusmedik_audit_fenced_record_evidence(p_run_id uuid, p_owner text, p_fence bigint, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_result jsonb;
begin
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  v_result := public.plusmedik_audit_record_evidence(p_run_id, p_payload);
  perform set_config('plusmedik.fence_proof', '', true);
  return v_result;
end $$;

-- Cierre operativo sin envío (imagen ignorada / fallo). p_close: { status: IGNORED|FAILED, error_code, final: bool }.
--   final = true  : no habrá respuesta (send_state NOT_APPLICABLE) y el lease se libera.
--   final = false : seguirá una respuesta (p. ej. aviso técnico) que debe reservarse con reserve_send.
create or replace function public.plusmedik_audit_fenced_close(p_run_id uuid, p_owner text, p_fence bigint, p_close jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_status text;
  v_error text;
  v_final boolean;
begin
  if p_close is null or not public.plusmedik_audit_keys_within(p_close, array['status', 'error_code', 'final']) then
    raise exception 'plusmedik_audit: invalid close' using errcode = 'PT422';
  end if;
  v_status := p_close ->> 'status';
  v_error := p_close ->> 'error_code';
  v_final := coalesce((p_close ->> 'final')::boolean, false);
  if v_status is null or v_status not in ('IGNORED', 'FAILED') or v_error is null or v_error !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception 'plusmedik_audit: invalid close' using errcode = 'PT422';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.processing_status = v_status and v_run.error_code is not distinct from v_error then
    return jsonb_build_object('status', 'already_recorded');
  end if;
  if v_run.send_state <> 'NOT_RESERVED' then
    raise exception 'plusmedik_audit: send already reserved or closed' using errcode = 'PT409';
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  update public.plusmedik_audit_runs set
    processing_status = v_status,
    error_code = v_error,
    completed_at = now(),
    send_state = case when v_final then 'NOT_APPLICABLE' else send_state end,
    lease_expires_at = case when v_final then now() else lease_expires_at end
  where id = p_run_id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'recorded');
end $$;

-- RESERVA DE ENVÍO. Debe concederse antes de llamar a Kapso. Es idempotente para el mismo owner + fence (un reintento tras un resultado desconocido no concede
-- una segunda reserva a otro). Resultados: reserved | blocked (un bloqueo previo canceló el envío) | closed (ya no hay envío posible). PT410 si perdió el lease.
create or replace function public.plusmedik_audit_reserve_send(p_run_id uuid, p_owner text, p_fence bigint, p_kind text, p_lease_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if p_kind is null or p_kind not in ('quoted', 'no_quote', 'technical_issue') or p_lease_seconds is null or p_lease_seconds not between 1 and 900 then
    raise exception 'plusmedik_audit: invalid send reservation' using errcode = 'PT422';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state = 'RESERVED' then
    if v_run.send_kind = p_kind then
      return jsonb_build_object('status', 'reserved');
    end if;
    raise exception 'plusmedik_audit: send reserved with a different kind' using errcode = 'PT409';
  end if;
  if v_run.send_state <> 'NOT_RESERVED' then
    return jsonb_build_object('status', 'closed');
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  -- La comprobación de pausa se hace AQUÍ, bajo el mismo bloqueo de fila que concede la reserva: un bloqueo (block_send) y una reserva no pueden cruzarse.
  if v_run.send_blocked_at is not null then
    update public.plusmedik_audit_runs set
      send_state = 'CANCELLED',
      processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
      completed_at = now(),
      lease_expires_at = now()
    where id = p_run_id;
    perform set_config('plusmedik.fence_proof', '', true);
    return jsonb_build_object('status', 'blocked');
  end if;
  update public.plusmedik_audit_runs set
    send_state = 'RESERVED',
    send_kind = p_kind,
    send_reserved_at = now(),
    lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_run_id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'reserved');
end $$;

-- Resultado del envío (contrato de F1.2 intacto) presentando owner + fence. Solo se puede registrar un envío que se reservó, del mismo tipo que se reservó.
create or replace function public.plusmedik_audit_fenced_record_reply(p_run_id uuid, p_owner text, p_fence bigint, p_reply jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_result jsonb;
begin
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state not in ('RESERVED', 'ACCEPTED', 'UNKNOWN') then
    raise exception 'plusmedik_audit: send was not reserved' using errcode = 'PT409';
  end if;
  if p_reply is null or jsonb_typeof(p_reply) <> 'object' or (p_reply ->> 'result') is distinct from v_run.send_kind then
    raise exception 'plusmedik_audit: reply does not match the reserved send' using errcode = 'PT409';
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  v_result := public.plusmedik_audit_record_reply(p_run_id, p_reply);
  if v_result ->> 'status' = 'recorded' then
    update public.plusmedik_audit_runs set
      send_state = case when (p_reply ->> 'state') = 'ACCEPTED' then 'ACCEPTED' else 'UNKNOWN' end,
      attention_reason = case when (p_reply ->> 'state') = 'ACCEPTED' then attention_reason else 'SEND_OUTCOME_UNKNOWN' end,
      attention_at = case when (p_reply ->> 'state') = 'ACCEPTED' then attention_at else now() end,
      lease_expires_at = now()
    where id = p_run_id;
  end if;
  perform set_config('plusmedik.fence_proof', '', true);
  return v_result;
end $$;

-- ───────────────────────── recuperación ─────────────────────────
-- Función periódica, sin depender de que Kapso reenvíe nada. Es segura por construcción:
--   · NUNCA envía ni reintenta un envío; no tiene teléfono ni acceso a la imagen.
--   · RESERVED con lease vencido (+ gracia corta): el envío pudo ocurrir o no -> send_state UNKNOWN, reply_state UNKNOWN, SEND_OUTCOME_UNKNOWN. No se reabre.
--   · NOT_RESERVED con lease vencido hace más de la gracia larga (tiempo para que un webhook reenviado la reclame): ABANDONED_BEFORE_SEND, sin respuesta.
--   · Sube el fence: cualquier ejecución antigua que reviva queda invalidada (PT410).
--   · FOR UPDATE SKIP LOCKED: dos recuperadores simultáneos nunca procesan la misma corrida.
create or replace function public.plusmedik_audit_recover_stale(p_reserved_grace_seconds integer default 60, p_abandon_grace_seconds integer default 900, p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_unknown integer := 0;
  v_abandoned integer := 0;
begin
  if p_reserved_grace_seconds is null or p_reserved_grace_seconds not between 0 and 86400
     or p_abandon_grace_seconds is null or p_abandon_grace_seconds not between 0 and 604800
     or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'plusmedik_audit: invalid recovery parameters' using errcode = 'PT422';
  end if;
  for v_run in
    select * from public.plusmedik_audit_runs
    where lease_fence is not null
      and ((send_state = 'RESERVED' and lease_expires_at < now() - make_interval(secs => p_reserved_grace_seconds))
        or (send_state = 'NOT_RESERVED' and processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED', 'FAILED') and lease_expires_at < now() - make_interval(secs => p_abandon_grace_seconds)))
    order by lease_expires_at
    limit p_limit
    for update skip locked
  loop
    perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
    if v_run.send_state = 'RESERVED' then
      update public.plusmedik_audit_runs set
        send_state = 'UNKNOWN',
        reply_state = 'UNKNOWN',
        reply_kind = v_run.send_kind,
        processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
        completed_at = coalesce(completed_at, now()),
        attention_reason = 'SEND_OUTCOME_UNKNOWN',
        attention_at = now(),
        lease_fence = lease_fence + 1,
        lease_expires_at = now()
      where id = v_run.id;
      insert into public.plusmedik_audit_checks (run_id, check_kind, check_status, summary)
      values (v_run.id, 'REPLY', 'UNKNOWN', jsonb_build_object('result', v_run.send_kind, 'providerAccepted', false));
      v_unknown := v_unknown + 1;
    else
      update public.plusmedik_audit_runs set
        send_state = 'NOT_APPLICABLE',
        processing_status = case when processing_status in ('PROCESSING', 'ANALYZED') then 'FAILED' else processing_status end,
        error_code = coalesce(error_code, 'LEASE_EXPIRED'),
        completed_at = coalesce(completed_at, now()),
        attention_reason = 'ABANDONED_BEFORE_SEND',
        attention_at = now(),
        lease_fence = lease_fence + 1,
        lease_expires_at = now()
      where id = v_run.id;
      v_abandoned := v_abandoned + 1;
    end if;
    perform set_config('plusmedik.fence_proof', '', true);
  end loop;
  return jsonb_build_object('send_outcome_unknown', v_unknown, 'abandoned_before_send', v_abandoned);
end $$;

-- ───────────────────────── preparación para intervención humana (sin integrar nada todavía) ─────────────────────────
-- Una fase posterior (p. ej. una recepcionista que escribe desde la app del negocio) podrá impedir una respuesta pendiente llamando a block_send con el
-- id del mensaje entrante. La comprobación real ocurre en reserve_send, bajo el bloqueo de fila: o el bloqueo llega antes de la reserva (se cancela el envío) o
-- llega después (too_late). Este módulo no conoce ninguna tabla de otros sistemas. Un bloqueo que llega ANTES de que exista la corrida (claim) no se puede
-- registrar aquí: requeriría una clave de conversación, que esta fase no introduce.
create or replace function public.plusmedik_audit_block_send(p_message_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if p_message_id is null or p_message_id !~ '^[A-Za-z0-9_.=:-]{1,128}$' or p_reason is null or p_reason !~ '^[A-Za-z0-9_.:-]{1,64}$' then
    raise exception 'plusmedik_audit: invalid block' using errcode = 'PT422';
  end if;
  select * into v_run from public.plusmedik_audit_runs where kapso_message_id = p_message_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_run.lease_fence is null then
    return jsonb_build_object('status', 'unsupported');
  end if;
  if v_run.send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN') then
    return jsonb_build_object('status', 'too_late', 'send_state', v_run.send_state);
  end if;
  if v_run.send_state in ('CANCELLED') or v_run.send_blocked_at is not null then
    return jsonb_build_object('status', 'blocked');
  end if;
  if v_run.send_state = 'NOT_APPLICABLE' then
    return jsonb_build_object('status', 'closed');
  end if;
  perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
  update public.plusmedik_audit_runs set send_blocked_at = now(), send_block_reason = p_reason where id = v_run.id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'blocked');
end $$;

-- ───────────────────────── vista de fases ─────────────────────────
create or replace view public.plusmedik_audit_run_phase as
select
  r.id,
  r.kapso_message_id,
  case
    when r.lease_fence is null then
      case when r.reply_state = 'ACCEPTED' then 'SENT_ACCEPTED'
           when r.reply_state = 'UNKNOWN' then 'SEND_UNKNOWN'
           when r.processing_status in ('PROCESSING', 'ANALYZED') then 'LEGACY_IN_PROGRESS'
           else 'CLOSED_NO_SEND' end
    when r.send_state = 'UNKNOWN' then 'SEND_UNKNOWN'
    when r.send_state = 'ACCEPTED' then 'SENT_ACCEPTED'
    when r.send_state = 'RESERVED' then 'SENDING'
    when r.attention_reason is not null then 'NEEDS_ATTENTION'
    when r.send_state in ('CANCELLED', 'NOT_APPLICABLE') then 'CLOSED_NO_SEND'
    when r.processing_status = 'ANALYZED' then 'ANALYZED_UNSENT'
    else 'RECOVERABLE'
  end as phase,
  r.processing_status,
  r.send_state,
  r.lease_expires_at,
  r.lease_attempts,
  r.attention_reason,
  r.send_block_reason
from public.plusmedik_audit_runs r;

-- ───────────────────────── privilegios ─────────────────────────
revoke all on function public.plusmedik_audit_prove(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_audit_lock_leased(uuid, text, bigint) from public, anon, authenticated, service_role;
revoke all on function public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_renew_lease(uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_fenced_record_evidence(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_fenced_close(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_reserve_send(uuid, text, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_fenced_record_reply(uuid, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_recover_stale(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_block_send(text, text) from public, anon, authenticated;
grant execute on function public.plusmedik_audit_claim_run(text, text, text, integer, integer, text, jsonb, integer) to service_role;
grant execute on function public.plusmedik_audit_renew_lease(uuid, text, bigint, integer) to service_role;
grant execute on function public.plusmedik_audit_fenced_record_evidence(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.plusmedik_audit_fenced_close(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.plusmedik_audit_reserve_send(uuid, text, bigint, text, integer) to service_role;
grant execute on function public.plusmedik_audit_fenced_record_reply(uuid, text, bigint, jsonb) to service_role;
grant execute on function public.plusmedik_audit_recover_stale(integer, integer, integer) to service_role;
grant execute on function public.plusmedik_audit_block_send(text, text) to service_role;

revoke all on table public.plusmedik_audit_run_phase from public, anon, authenticated;
grant select on table public.plusmedik_audit_run_phase to service_role;

comment on view public.plusmedik_audit_run_phase is 'Fase operativa de cada corrida: RECOVERABLE, ANALYZED_UNSENT, SENDING, SENT_ACCEPTED, SEND_UNKNOWN, NEEDS_ATTENTION, CLOSED_NO_SEND (LEGACY_IN_PROGRESS = anterior a F1.3).';
comment on function public.plusmedik_audit_reserve_send(uuid, text, bigint, text, integer) is 'Reserva de envío bajo bloqueo de fila: la única autorización para llamar a Kapso. Idempotente para el mismo owner+fence.';
comment on function public.plusmedik_audit_recover_stale(integer, integer, integer) is 'Cierra de forma segura lo interrumpido. Nunca envía ni reintenta envíos; solo marca SEND_OUTCOME_UNKNOWN o ABANDONED_BEFORE_SEND.';
