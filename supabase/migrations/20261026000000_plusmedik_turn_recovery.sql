-- PlusMedik V2 G2.1: un turno cuya espera por un envío en vuelo se agotó ('busy' sin liberarse) queda RECUPERABLE, sin enviar nada.
-- Migración ADITIVA y posterior a 20261025000000 (turnos): agrega UNA función. No crea tablas, no modifica ni borra nada. Solo define esquema local: NO se aplica a
-- ningún Supabase remoto desde el repositorio. Orden: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> esta.
--
-- ───────────────────────── Problema ─────────────────────────
-- Si otro envío del mismo contacto sigue "en vuelo" y no se libera mientras este turno espera, el turno no puede responder. Antes quedaba con su lease vigente hasta
-- que venciera solo (hasta 120 s), tiempo durante el cual un reenvío del mensaje recibía 'busy' y no podía recuperarlo.
--
-- ───────────────────────── Qué hace plusmedik_turn_release ─────────────────────────
-- El dueño del lease (owner + fence vigentes) que desiste de esperar:
--   · vence su lease YA, para que cualquier reenvío del mismo mensaje lo reclame de inmediato (taken_over, fence + 1, mismo número de secuencia);
--   · lo marca para atención (attention_reason = BUSY_TIMEOUT) para que no pase inadvertido;
--   · NO cierra el turno, NO reserva ni cancela el envío y NO sube el fence.
-- Es idempotente. Solo actúa sobre un turno SIN envío reservado: con un envío reservado, aceptado, desconocido o cancelado responde 'closed' y no toca nada, así que
-- nunca puede habilitar un segundo envío. La exclusión de envíos sigue dependiendo únicamente de la reserva (migraciones 4-6).
--
-- ───────────────────────── Límites (lo que NO garantiza) ─────────────────────────
-- · La base no guarda el teléfono ni el contenido del mensaje (privacidad): no puede reenviar por su cuenta. El turno solo se retoma si el mensaje se vuelve a
--   entregar (o el paciente escribe de nuevo). Si nadie lo reclama, el recuperador (plusmedik_audit_recover_stale) lo cierra a los 15 min como
--   ABANDONED_BEFORE_SEND, sin respuesta, y queda para atención humana.
-- · Tras 3 intentos de reclamo el turno no se reclama más (exhausted), igual que cualquier corrida.

create or replace function public.plusmedik_turn_release(p_run_id uuid, p_owner text, p_fence bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if p_reason is null or p_reason <> 'BUSY_TIMEOUT' then
    raise exception 'plusmedik_turn: invalid release' using errcode = 'PT422';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state <> 'NOT_RESERVED' or v_run.processing_status not in ('PROCESSING', 'ANALYZED') then
    return jsonb_build_object('status', 'closed');
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  update public.plusmedik_audit_runs set
    lease_expires_at = least(lease_expires_at, now()),
    attention_reason = coalesce(attention_reason, p_reason),
    attention_at = coalesce(attention_at, now())
  where id = p_run_id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'released');
end $$;

revoke all on function public.plusmedik_turn_release(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_release(uuid, text, bigint, text) to service_role;

comment on function public.plusmedik_turn_release(uuid, text, bigint, text) is 'Desiste de esperar un envío en vuelo: vence el lease del turno y lo marca BUSY_TIMEOUT para que se pueda reclamar de nuevo. Nunca envía, reserva ni cierra. Solo service_role.';
