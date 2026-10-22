-- Consultas de revisión. Ejecutar manualmente por personal autorizado; no modifican datos.

-- Historial por fecha y estado
select received_at, kapso_message_id, processing_status, analysis_decision, analysis_outcome, reply_state
from public.plusmedik_audit_runs
where received_at >= :from and received_at < :to
order by received_at desc;

-- Estudios cotizados y pendientes, sin texto clínico libre
select r.received_at, r.kapso_message_id, s.study_index, s.decision,
       s.quoted_lines, s.candidate_codes, s.blockers
from public.plusmedik_audit_runs r
join public.plusmedik_audit_studies s on s.run_id = r.id
where r.received_at >= :from and r.received_at < :to
order by r.received_at desc, s.study_index;

-- Motivos de bloqueo más frecuentes
select blocker, count(*) as total
from public.plusmedik_audit_studies s
cross join lateral jsonb_array_elements_text(s.blockers) blocker
group by blocker
order by total desc, blocker;

-- Costos solo cuando fueron reportados por el proveedor
select date_trunc('day', r.received_at) as day,
       count(distinct r.id) as runs,
       sum(m.cost_usd) filter (where m.cost_status = 'PROVIDER_REPORTED') as provider_reported_cost_usd
from public.plusmedik_audit_runs r
left join public.plusmedik_audit_model_calls m on m.run_id = r.id
group by 1
order by 1 desc;
