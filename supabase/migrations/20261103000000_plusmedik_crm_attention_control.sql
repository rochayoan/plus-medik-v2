-- PlusMedik V2 · Fase 1 de integración con el CRM: pausa y reactivación MANUAL de la IA solicitadas por el servidor del CRM (contrato CRM-PLUSMEDIK/docs/AGENT_ATTENTION_CONTROL_CONTRACT.md).
-- Migración ADITIVA y posterior a 20261102000000: agrega UNA función (plusmedik_attention_crm_action) y AMPLÍA dos restricciones de plusmedik_attention_events (tipos y resultados
-- permitidos). No toca datos ni columnas. Solo define esquema local: NO se aplica a ningún Supabase remoto desde el repositorio.
-- Orden: 1 -> ... -> 14 -> esta.
--
-- ───────────────────────── Qué hace (y qué NO hace) ─────────────────────────
--   · Es una operación PROPIA y explícita (kind CRM_MANUAL_PAUSE / CRM_MANUAL_RESUME, fuente crm_server). NO reutiliza plusmedik_attention_register_human_message: esa función representa
--     exclusivamente un mensaje humano REAL de WhatsApp Business, y aquí no existe ningún mensaje. No se simula nada de WhatsApp.
--   · Idempotente por operación: event_key = 'crm:' || operationId. Repetir la MISMA operación devuelve el resultado ya confirmado (mismo estado y revisión de aquel momento) sin agregar un
--     evento ni cambiar el estado. Reusar un operationId para otra acción u otro contacto es un conflicto (PT409), nunca un resultado ajeno.
--   · Pausar: deja el contacto en HUMAN_PAUSED (revision + 1) y bloquea sus procesamientos pendientes, igual que una pausa humana (claim, reserve_send y confirm_send ya consultan el estado).
--     Un procesamiento con el envío ya reservado no se puede cancelar: queda contado (late_reserved_runs / replied_after_event_runs) y la corrida marcada, como en la pausa humana.
--   · Reactivar: vuelve a ACTIVE (revision + 1) y fija resumed_at; los mensajes humanos anteriores a este instante ya no vuelven a pausar. Reactivar un contacto ya ACTIVE (o inexistente)
--     es válido y devuelve ALREADY_ACTIVE sin cambiar la revisión.
--   · Solo guarda códigos: acción, actor técnico (crm:<id>, sin nombres ni correos) y motivo codificado. El texto libre del motivo vive en el CRM y nunca viaja aquí.
--   · Un solo contacto por llamada; orden de bloqueo: contacto -> corridas (igual que register_human_message).

-- ───────────────────────── restricciones ampliadas ─────────────────────────
-- Las restricciones originales eran en línea (sin nombre propio). Se reemplazan por dos con nombre que admiten, además de los valores anteriores, las dos acciones del CRM y el resultado
-- ALREADY_ACTIVE. Todo lo que ya existe sigue cumpliéndolas. Reaplicar esta migración no falla.
alter table public.plusmedik_attention_events
  drop constraint if exists plusmedik_attention_events_kind_check,
  drop constraint if exists plusmedik_attention_events_outcome_check,
  drop constraint if exists plusmedik_attention_events_kind_crm_check,
  drop constraint if exists plusmedik_attention_events_outcome_crm_check,
  add constraint plusmedik_attention_events_kind_crm_check check (kind in ('HUMAN_BUSINESS_APP', 'UNKNOWN_ORIGIN', 'OTHER_APP_OUTBOUND', 'META_AGENT_OUTBOUND', 'PATIENT_SUPPRESSED', 'MANUAL_RESUME', 'CRM_MANUAL_PAUSE', 'CRM_MANUAL_RESUME')),
  add constraint plusmedik_attention_events_outcome_crm_check check (outcome in ('PAUSED', 'ALREADY_PAUSED', 'STALE_IGNORED', 'RECORDED', 'SUPPRESSED', 'RESUMED', 'ALREADY_ACTIVE'));

-- ───────────────────────── pausa / reactivación manual ─────────────────────────
-- p_action: 'pause' | 'resume'. p_reason debe ser el código de la acción (CRM_MANUAL_PAUSE / CRM_MANUAL_RESUME). p_actor: 'crm:<id>' (pseudónimo; el CRM guarda la persona).
-- Resultado: {outcome: PAUSED | ALREADY_PAUSED | RESUMED | ALREADY_ACTIVE, state, revision, replayed, blocked_runs, late_reserved_runs, replied_after_event_runs}.
-- Errores: PT422 argumento inválido · PT409 operationId reutilizado para otra acción u otro contacto.
create or replace function public.plusmedik_attention_crm_action(p_operation_id text, p_action text, p_contact_key text, p_reason text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.plusmedik_attention_contacts%rowtype;
  v_event public.plusmedik_attention_events%rowtype;
  v_run public.plusmedik_audit_runs%rowtype;
  v_exists boolean := false;
  v_key text;
  v_kind text;
  v_outcome text;
  v_state text;
  v_revision integer;
  v_blocked integer := 0;
  v_late integer := 0;
  v_replied integer := 0;
  v_at timestamptz := now();
  v_inserted integer;
begin
  if p_operation_id is null or p_operation_id !~ '^[A-Za-z0-9_.:-]{8,120}$'
     or p_action is null or p_action not in ('pause', 'resume')
     or p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$'
     or p_reason is distinct from (case p_action when 'pause' then 'CRM_MANUAL_PAUSE' else 'CRM_MANUAL_RESUME' end)
     or p_actor is null or p_actor !~ '^crm:[A-Za-z0-9_-]{1,59}$' then
    raise exception 'plusmedik_attention: invalid crm action' using errcode = 'PT422';
  end if;
  v_key := 'crm:' || p_operation_id;
  v_kind := case p_action when 'pause' then 'CRM_MANUAL_PAUSE' else 'CRM_MANUAL_RESUME' end;
  v_state := case p_action when 'pause' then 'HUMAN_PAUSED' else 'ACTIVE' end;

  -- Bloqueo del contacto (serializa operaciones y mensajes humanos del mismo contacto). Pausar crea el registro si falta; reactivar no inventa uno.
  if p_action = 'pause' then
    insert into public.plusmedik_attention_contacts (contact_key) values (p_contact_key) on conflict (contact_key) do nothing;
  end if;
  select * into v_contact from public.plusmedik_attention_contacts where contact_key = p_contact_key for update;
  v_exists := found;

  -- Repetición de una operación ya confirmada: el mismo resultado, sin evento nuevo.
  select * into v_event from public.plusmedik_attention_events where event_key = v_key;
  if found then
    if v_event.kind <> v_kind or v_event.contact_key is distinct from p_contact_key then
      raise exception 'plusmedik_attention: operation id already used' using errcode = 'PT409';
    end if;
    return jsonb_build_object('outcome', v_event.outcome, 'state', v_state, 'revision', coalesce(v_event.state_revision, 0), 'replayed', true,
      'blocked_runs', v_event.blocked_runs, 'late_reserved_runs', v_event.late_reserved_runs, 'replied_after_event_runs', v_event.replied_after_event_runs);
  end if;

  if p_action = 'pause' then
    if v_contact.state = 'HUMAN_PAUSED' then
      v_outcome := 'ALREADY_PAUSED';
    else
      v_outcome := 'PAUSED';
      update public.plusmedik_attention_contacts set
        state = 'HUMAN_PAUSED', revision = revision + 1, paused_at = now(), pause_reason = p_reason, pause_source = 'crm_server'
      where contact_key = p_contact_key;
    end if;

    -- Procesamientos pendientes del contacto (sin envío reservado): se bloquean, igual que con una pausa humana.
    for v_run in
      select * from public.plusmedik_audit_runs
      where contact_key = p_contact_key and lease_fence is not null and send_state = 'NOT_RESERVED'
        and processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED', 'FAILED') and send_blocked_at is null
      for update
    loop
      perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
      update public.plusmedik_audit_runs set send_blocked_at = now(), send_block_reason = 'HUMAN_PAUSED' where id = v_run.id;
      v_blocked := v_blocked + 1;
    end loop;
    -- Carrera que NO se puede evitar: ya hay un envío reservado o ya se respondió después de esta pausa. Se cuenta y se marca la corrida.
    for v_run in
      select * from public.plusmedik_audit_runs
      where contact_key = p_contact_key and lease_fence is not null and attention_reason is null
        and ((send_state = 'RESERVED') or (send_state in ('ACCEPTED', 'UNKNOWN') and send_reserved_at >= v_at))
      for update
    loop
      perform public.plusmedik_audit_prove(v_run.id, v_run.lease_fence);
      update public.plusmedik_audit_runs set
        attention_reason = case when v_run.send_state = 'RESERVED' then 'HUMAN_PAUSE_AFTER_RESERVATION' else 'BOT_REPLIED_AFTER_HUMAN_EVENT' end,
        attention_at = now()
      where id = v_run.id;
    end loop;
    select count(*) into v_late from public.plusmedik_audit_runs where contact_key = p_contact_key and lease_fence is not null and send_state = 'RESERVED';
    select count(*) into v_replied from public.plusmedik_audit_runs
      where contact_key = p_contact_key and lease_fence is not null and send_state in ('RESERVED', 'ACCEPTED', 'UNKNOWN') and send_reserved_at >= v_at;
    perform set_config('plusmedik.fence_proof', '', true);
  else
    if not v_exists or v_contact.state = 'ACTIVE' then
      v_outcome := 'ALREADY_ACTIVE';
    else
      v_outcome := 'RESUMED';
      update public.plusmedik_attention_contacts set
        state = 'ACTIVE', revision = revision + 1, paused_at = null, pause_reason = null, pause_source = null, resumed_at = now()
      where contact_key = p_contact_key;
    end if;
  end if;

  select * into v_contact from public.plusmedik_attention_contacts where contact_key = p_contact_key;
  v_revision := case when found then v_contact.revision else 0 end;
  insert into public.plusmedik_attention_events (event_key, contact_key, kind, outcome, occurred_at, state_revision, blocked_runs, late_reserved_runs, replied_after_event_runs, detail)
  values (v_key, p_contact_key, v_kind, v_outcome, v_at, v_revision, v_blocked, v_late, v_replied,
          jsonb_build_object('action', p_action, 'reason', p_reason, 'source', 'crm_server', 'actor', p_actor))
  on conflict (event_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    -- Dos llamadas idénticas a la vez sobre un contacto inexistente (reactivar no bloquea ninguna fila): gana la primera; esta devuelve su resultado.
    select * into v_event from public.plusmedik_attention_events where event_key = v_key;
    if v_event.kind <> v_kind or v_event.contact_key is distinct from p_contact_key then
      raise exception 'plusmedik_attention: operation id already used' using errcode = 'PT409';
    end if;
    return jsonb_build_object('outcome', v_event.outcome, 'state', v_state, 'revision', coalesce(v_event.state_revision, 0), 'replayed', true,
      'blocked_runs', v_event.blocked_runs, 'late_reserved_runs', v_event.late_reserved_runs, 'replied_after_event_runs', v_event.replied_after_event_runs);
  end if;
  return jsonb_build_object('outcome', v_outcome, 'state', v_state, 'revision', v_revision, 'replayed', false,
    'blocked_runs', v_blocked, 'late_reserved_runs', v_late, 'replied_after_event_runs', v_replied);
end $$;

-- ───────────────────────── privilegios ─────────────────────────
-- Solo service_role (el servidor del agente). Ningún rol de navegador, anon, authenticated ni crm_app puede ejecutarla directamente.
revoke all on function public.plusmedik_attention_crm_action(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.plusmedik_attention_crm_action(text, text, text, text, text) to service_role;

comment on function public.plusmedik_attention_crm_action(text, text, text, text, text) is 'Pausa o reactivación MANUAL pedida por el servidor del CRM; idempotente por operationId (event_key crm:<id>). No simula mensajes de WhatsApp. Solo service_role.';
