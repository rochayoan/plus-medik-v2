-- PlusMedik: reactivación transaccional de la IA al volver a escribir el paciente
-- después de 10 minutos sin mensajes enviados por una asesora desde WhatsApp
-- Business del teléfono. No depende de cron ni de variables nuevas.
-- No reactiva pausas manuales del CRM ni registra números de teléfono.

create or replace function public.plusmedik_attention_resume_if_idle(p_contact_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact public.plusmedik_attention_contacts%rowtype;
  v_idle_since timestamptz;
begin
  if p_contact_key is null or p_contact_key !~ '^[0-9a-f]{64}$' then
    raise exception 'plusmedik_attention: invalid contact' using errcode = 'PT422';
  end if;

  -- El bloqueo del contacto serializa con eventos de asesora y acciones del CRM.
  select * into v_contact
  from public.plusmedik_attention_contacts
  where contact_key = p_contact_key
  for update;

  if not found or v_contact.state = 'ACTIVE' then
    return jsonb_build_object('outcome', 'ALREADY_ACTIVE');
  end if;

  if v_contact.pause_source is distinct from 'kapso_business_app' then
    return jsonb_build_object('outcome', 'MANUAL_PAUSED');
  end if;

  -- El instante más reciente manda. paused_at protege contra relojes
  -- desfasados o mensajes antiguos entregados con retraso.
  v_idle_since := greatest(v_contact.paused_at, v_contact.last_human_event_at);
  if v_idle_since is null or now() < v_idle_since + interval '10 minutes' then
    return jsonb_build_object('outcome', 'NOT_DUE');
  end if;

  update public.plusmedik_attention_contacts
  set state = 'ACTIVE', revision = revision + 1,
      paused_at = null, pause_reason = null, pause_source = null, resumed_at = now()
  where contact_key = p_contact_key;

  insert into public.plusmedik_attention_events
    (event_key, contact_key, kind, outcome, occurred_at, state_revision, detail)
  values
    ('resume:' || gen_random_uuid()::text, p_contact_key, 'MANUAL_RESUME',
     'RESUMED', now(), v_contact.revision + 1,
      jsonb_build_object('reason', 'BUSINESS_APP_IDLE_10_MIN', 'source', 'agent_auto'));

  return jsonb_build_object('outcome', 'RESUMED');
end $$;

revoke all on function public.plusmedik_attention_resume_if_idle(text) from public, anon, authenticated;
grant execute on function public.plusmedik_attention_resume_if_idle(text) to service_role;
