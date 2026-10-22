-- PlusMedik V2 F1.1: telemetría y trazabilidad de IA. Migración ADITIVA sobre la de la Fase 6 (20261020000000); no la modifica ni crea tablas nuevas.
-- Solo define esquema local: no se aplica a ningún Supabase remoto desde el repositorio.
--
-- Compatibilidad: todas las columnas son NULLABLE y sin valor por defecto. Una fila anterior a esta migración conserva NULL = "no medido / desconocido"
-- (audit_schema_version NULL identifica el contrato de la Fase 6, sin telemetría). Nunca se rellena con valores inventados.
-- Privacidad: no hay columnas para prompts, respuestas crudas, mensajes de error, credenciales ni texto clínico; solo códigos, hashes, enteros y fechas.
-- Retención: las columnas nuevas son métricas no clínicas (conservación hasta metrics_expires_at, 180 días). El detalle estructurado (safe_reading, studies,
-- checks, document_summary) mantiene su retención de 30 días, definida por la Fase 6.

alter table public.plusmedik_audit_runs
  add column if not exists audit_schema_version integer,
  add column if not exists engine_version text,
  add column if not exists flags jsonb,
  add column if not exists config_hash text,
  add column if not exists catalog_hash text,
  add column if not exists catalog_size integer;

alter table public.plusmedik_audit_model_calls
  add column if not exists call_seq integer,
  add column if not exists completion_seq integer,
  add column if not exists attempt integer,
  add column if not exists started_at timestamptz,
  add column if not exists duration_ms integer,
  add column if not exists reasoning_effort text,
  add column if not exists params_hash text,
  add column if not exists error_kind text;

-- Las restricciones se agregan una sola vez (las sentencias de la migración se pueden volver a ejecutar sin error).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plusmedik_audit_runs_telemetry_check') then
    alter table public.plusmedik_audit_runs add constraint plusmedik_audit_runs_telemetry_check check (
      (audit_schema_version is null or audit_schema_version >= 2)
      and (engine_version is null or engine_version ~ '^[0-9a-f]{7,64}$')
      and (config_hash is null or config_hash ~ '^[0-9a-f]{64}$')
      and (catalog_hash is null or catalog_hash ~ '^[0-9a-f]{64}$')
      and (catalog_size is null or catalog_size >= 0)
      and (flags is null or jsonb_typeof(flags) = 'object')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plusmedik_audit_model_calls_telemetry_check') then
    alter table public.plusmedik_audit_model_calls add constraint plusmedik_audit_model_calls_telemetry_check check (
      (call_seq is null or call_seq >= 1)
      and (completion_seq is null or completion_seq >= 1)
      and (attempt is null or attempt >= 1)
      and (duration_ms is null or duration_ms >= 0)
      and (reasoning_effort is null or reasoning_effort ~ '^[A-Za-z_.]{1,32}$')
      and (params_hash is null or params_hash ~ '^[0-9a-f]{64}$')
      and (error_kind is null or error_kind in ('TIMEOUT', 'NETWORK', 'RATE_LIMITED', 'HTTP_CLIENT', 'HTTP_SERVER', 'SCHEMA_INVALID', 'BLOCKED', 'UNKNOWN'))
    );
  end if;
end $$;

-- Un intento por llamada lógica y procesamiento. Parcial: las filas anteriores (call_seq NULL) no participan.
create unique index if not exists plusmedik_audit_model_calls_call_attempt_idx
  on public.plusmedik_audit_model_calls (run_id, call_seq, attempt)
  where call_seq is not null;

-- Agrupar análisis por configuración (¿qué cambió cuando cambió el resultado?).
create index if not exists plusmedik_audit_runs_config_idx
  on public.plusmedik_audit_runs (config_hash, received_at desc)
  where config_hash is not null;

comment on column public.plusmedik_audit_runs.audit_schema_version is 'Versión del contrato de auditoría con que se escribió la fila. NULL = Fase 6 (sin telemetría).';
comment on column public.plusmedik_audit_runs.engine_version is 'SHA del commit desplegado (VERCEL_GIT_COMMIT_SHA). NULL = desconocido.';
comment on column public.plusmedik_audit_runs.flags is 'Banderas funcionales del motor (nombres y valores cortos y simples). NULL = no registradas.';
comment on column public.plusmedik_audit_runs.config_hash is 'SHA-256 de motor + contrato + banderas + etapas/modelos/parámetros OBSERVADOS. Cambia si se ejecutan otras etapas. NULL = sin llamadas a modelos registradas.';
comment on column public.plusmedik_audit_runs.catalog_hash is 'SHA-256 del catálogo activo con el que se analizó (ids, aliases, precios, estado). NULL = no se llegó a analizar o fila anterior.';
comment on column public.plusmedik_audit_model_calls.call_seq is 'Orden de INICIO de la llamada lógica dentro del procesamiento (1..n), determinista aunque haya llamadas en paralelo.';
comment on column public.plusmedik_audit_model_calls.completion_seq is 'Orden de finalización del evento dentro del procesamiento. No equivale al orden de inicio.';
comment on column public.plusmedik_audit_model_calls.attempt is 'Intento dentro de la llamada lógica. Solo se ven los intentos que el motor notifica; los reintentos internos por 503 no son observables.';
comment on column public.plusmedik_audit_model_calls.started_at is 'Inicio del intento (reloj del servidor). En intentos posteriores al primero, el fin del intento anterior.';
comment on column public.plusmedik_audit_model_calls.duration_ms is 'Duración del intento en ms (reloj monotónico). NULL = no medida.';
comment on column public.plusmedik_audit_model_calls.reasoning_effort is 'Esfuerzo de razonamiento del intento si se informó, o el configurado en la petición. NULL = desconocido (p. ej. Gemini directo).';
comment on column public.plusmedik_audit_model_calls.params_hash is 'SHA-256 de los parámetros de la petición (modelo, esquema de salida, razonamiento). No incluye prompt ni imagen.';
comment on column public.plusmedik_audit_model_calls.error_kind is 'Clase del fallo deducida de propiedades tipadas del error (nunca del mensaje). Solo en llamadas FAILED.';
