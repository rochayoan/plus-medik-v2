-- PREVIEW de retención; no borra ni activa un scheduler.
-- Detalle estructurado elegible para purga a los 30 días.
select id, detail_expires_at
from public.plusmedik_audit_runs
where detail_purged_at is null and detail_expires_at <= now()
order by detail_expires_at;

-- Métricas agregadas elegibles para eliminación total a los 180 días.
select id, metrics_expires_at
from public.plusmedik_audit_runs
where metrics_expires_at <= now()
order by metrics_expires_at;
