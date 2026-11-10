-- PlusMedik V2 G6.1: buffering nativo de Kapso. Un mensaje de un lote cuyo contenido viaja DENTRO de la respuesta de otro mensaje del mismo lote se cierra sin enviar nada.
-- Migración ADITIVA y posterior a 20261106000000 (tope diario): agrega UNA función. No crea tablas, no modifica ni borra nada. Solo define esquema local: NO se aplica a
-- ningún Supabase remoto desde el repositorio. Se aplica ANTES de desplegar el código que usa los lotes.
--
-- ───────────────────────── Problema ─────────────────────────
-- Kapso entrega los mensajes de un contacto en lotes de 15 s. Todos se reclaman (deduplicación por mensaje), pero se contestan con UN solo mensaje que envía una sola corrida. Las demás
-- corridas del lote (por ejemplo, la de una foto ya analizada) no envían nada y deben terminar. Hasta ahora la base solo ofrecía dos salidas para una corrida con evidencia
-- registrada (ANALYZED): enviar su propia respuesta (COMPLETED) o marcarla como fallo (FAILED). Cerrarla «sin respuesta» (IGNORED) está prohibido por la transición de estados, y un
-- error_code ya escrito no se puede cambiar.
-- Dejarla en ANALYZED es peor que un detalle de auditoría: las sesiones de cotización esperan a que no queden turnos anteriores PROCESSING/ANALYZED, así que «listo» no podría cotizar.
--
-- ───────────────────────── Qué hace plusmedik_turn_fold ─────────────────────────
-- El dueño del lease (owner + fence vigentes) de un turno SIN envío reservado lo da por atendido dentro de otra respuesta:
--   · processing_status PROCESSING / ANALYZED / IGNORED -> COMPLETED (la evidencia del análisis, si existe, se conserva intacta);
--   · send_state NOT_RESERVED -> NOT_APPLICABLE: esta corrida nunca envía ni cuenta para el tope de respuestas (el tope solo cuenta RESERVED / ACCEPTED / UNKNOWN);
--   · error_code = 'BATCHED' si no tenía uno (un fallo ya registrado se conserva);
--   · vence su lease. Nadie puede reclamar de nuevo ese mensaje: el reclamo de una corrida con el envío ya NOT_APPLICABLE responde «finished» (duplicado), igual que con un cierre final.
-- Es idempotente. Con un envío ya reservado, aceptado, desconocido o cancelado responde 'closed' y no toca nada: nunca habilita ni cancela un envío. La exclusión de envíos sigue
-- dependiendo únicamente de la reserva (migraciones 4-6 y 18).
--
-- ───────────────────────── Límites (lo que NO garantiza) ─────────────────────────
-- · No registra a qué corrida se sumó el contenido: el mensaje del lote lo envía otra corrida del mismo contacto y lleva su propio rastro (referencias de conocimiento).
-- · Un turno FAILED conserva su estado (el fallo es la verdad de la auditoría); solo se marca NOT_APPLICABLE y vence su lease.

create or replace function public.plusmedik_turn_fold(p_run_id uuid, p_owner text, p_fence bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
begin
  if not exists (select 1 from public.plusmedik_turns where run_id = p_run_id) then
    raise exception 'plusmedik_turn: turn not found' using errcode = 'PT404';
  end if;
  v_run := public.plusmedik_audit_lock_leased(p_run_id, p_owner, p_fence);
  if v_run.send_state = 'NOT_APPLICABLE' and v_run.error_code is not distinct from 'BATCHED' then
    return jsonb_build_object('status', 'already_recorded');
  end if;
  if v_run.send_state <> 'NOT_RESERVED' then
    return jsonb_build_object('status', 'closed');
  end if;
  perform public.plusmedik_audit_prove(p_run_id, p_fence);
  update public.plusmedik_audit_runs set
    processing_status = case when processing_status in ('PROCESSING', 'ANALYZED', 'IGNORED') then 'COMPLETED' else processing_status end,
    error_code = coalesce(error_code, 'BATCHED'),
    completed_at = coalesce(completed_at, now()),
    send_state = 'NOT_APPLICABLE',
    lease_expires_at = least(lease_expires_at, now())
  where id = p_run_id;
  perform set_config('plusmedik.fence_proof', '', true);
  return jsonb_build_object('status', 'folded');
end $$;

revoke all on function public.plusmedik_turn_fold(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.plusmedik_turn_fold(uuid, text, bigint) to service_role;

comment on function public.plusmedik_turn_fold(uuid, text, bigint) is 'Da por atendido un turno de un lote cuyo contenido viajó dentro de la respuesta de otro: lo completa sin enviar ni contar para el tope. Nunca envía, reserva ni cancela un envío. Con owner + fence. Solo service_role.';
