-- PlusMedik V2 F1.2: persistencia transaccional e inmutabilidad de la auditoría.
-- Migración ADITIVA y posterior a 20261020000000 (Fase 6) y 20261021000000 (telemetría). No modifica esas migraciones ni crea tablas nuevas.
-- Solo define esquema local: no se aplica a ningún Supabase remoto desde el repositorio. Orden de ejecución: 20261020000000 -> 20261021000000 -> esta.
--
-- ───────────────────────── Qué garantiza ─────────────────────────
-- 1. ATOMICIDAD. Las evidencias de un análisis (resumen de la corrida, estudios, llamadas de IA y verificaciones) se escriben con UNA función
--    (plusmedik_audit_record_evidence) que es una sola transacción: o se confirma todo o no queda nada. El envío de WhatsApp nunca forma parte de ella.
-- 2. IDEMPOTENCIA. La función bloquea la fila de la corrida y guarda el hash del contenido confirmado. Repetir EXACTAMENTE el mismo contenido (por ejemplo,
--    tras un timeout con resultado desconocido) no duplica nada y responde 'already_recorded'; un contenido distinto sobre una corrida ya registrada se rechaza
--    (PT409). Dos escrituras concurrentes del mismo análisis se serializan por ese bloqueo.
-- 3. LISTA BLANCA. La función rechaza (PT422) claves desconocidas y cualquier valor que no sea un código corto (sin espacios ni texto libre) en los campos JSON.
--    Los mensajes de error nunca incluyen valores recibidos.
-- 4. INMUTABILIDAD de las evidencias históricas (studies, model_calls, checks y las columnas de evidencia de runs):
--      · privilegios: el rol de la API (service_role) solo puede LEER esas tablas; insertar solo ocurre por la función; no hay UPDATE/DELETE/TRUNCATE;
--      · triggers: bloquean UPDATE, DELETE y TRUNCATE incluso al dueño de las tablas, y las columnas de evidencia de runs solo cambian una vez.
-- 5. CICLO DE VIDA de runs (datos operativos): service_role conserva UPDATE solo sobre las columnas operativas; un trigger valida las transiciones de estado.
--
-- ───────────────────────── Límites (lo que NO garantiza) ─────────────────────────
-- · El claim inicial del mensaje (INSERT en runs) y las actualizaciones operativas de runs (recordIgnored, recordFailure) son escrituras SEPARADAS de la
--   transacción de evidencias: pueden fallar sin que falle la evidencia, y viceversa. Una corrida terminada con evidence_recorded_at NULL indica que la
--   evidencia no se confirmó (o no se pudo confirmar): es una brecha de auditoría observable.
-- · service_role se salta RLS (BYPASSRLS); aquí NO se confía en RLS contra él. La restricción es por privilegios y triggers. Nada de esto protege contra el
--   propietario de las tablas, un superusuario o quien administre el proyecto: pueden desactivar triggers o cambiar privilegios. Y la función no puede
--   probar la autenticidad del contenido: quien tenga la credencial de service_role puede registrar evidencia falsa sobre una corrida aún no registrada.
-- · Aún NO existe purga (retención 30/180 días): los triggers bloquean DELETE a todos. La purga controlada llegará en su propia migración. Borrar a mano
--   exige desactivar los triggers a propósito (ALTER TABLE ... DISABLE TRIGGER), y eso debe quedar en un cambio revisado.
-- · Las corridas anteriores a esta migración (sin evidence_recorded_at) conservan sus datos tal cual, pero no se pueden volver a registrar por la función.

alter table public.plusmedik_audit_runs
  add column if not exists evidence_recorded_at timestamptz,
  add column if not exists evidence_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plusmedik_audit_runs_evidence_check') then
    alter table public.plusmedik_audit_runs add constraint plusmedik_audit_runs_evidence_check check (
      (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$')
      and ((evidence_hash is null) = (evidence_recorded_at is null))
    );
  end if;
end $$;

-- Una verificación de cada clase por corrida (DOCUMENT, JUDGE, CATALOG, REPLY). Falla de forma visible si ya hubiera duplicados.
create unique index if not exists plusmedik_audit_checks_run_kind_idx
  on public.plusmedik_audit_checks (run_id, check_kind);

comment on column public.plusmedik_audit_runs.evidence_recorded_at is 'Momento en que se confirmó el conjunto de evidencias del análisis (RPC transaccional). NULL en una corrida terminada = brecha de auditoría.';
comment on column public.plusmedik_audit_runs.evidence_hash is 'SHA-256 del contenido confirmado. Permite reconocer un reintento idéntico (idempotencia) y rechazar uno distinto.';

-- ───────────────────────── validadores (puros, sin acceso a tablas) ─────────────────────────

-- Solo códigos cortos: texto sin espacios ni signos libres, objetos con claves simples, profundidad y tamaño acotados.
create or replace function public.plusmedik_audit_token_json_ok(j jsonb, depth integer default 0)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  pair record;
begin
  if j is null or depth > 4 then return false; end if;
  case jsonb_typeof(j)
    when 'null', 'boolean', 'number' then
      return true;
    when 'string' then
      return (j #>> '{}') ~ '^[A-Za-z0-9_.:-]{0,64}$';
    when 'array' then
      if jsonb_array_length(j) > 64 then return false; end if;
      for item in select value from jsonb_array_elements(j) loop
        if not public.plusmedik_audit_token_json_ok(item, depth + 1) then return false; end if;
      end loop;
      return true;
    when 'object' then
      if (select count(*) from jsonb_object_keys(j)) > 32 then return false; end if;
      for pair in select key, value from jsonb_each(j) loop
        if pair.key !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' or not public.plusmedik_audit_token_json_ok(pair.value, depth + 1) then return false; end if;
      end loop;
      return true;
    else
      return false;
  end case;
end $$;

create or replace function public.plusmedik_audit_keys_within(j jsonb, allowed text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(j) = 'object' then not exists (select 1 from jsonb_object_keys(j) as k where k <> all (allowed)) else false end;
$$;

-- Ausente o null siempre es válido (un dato no medido queda NULL, nunca inventado). Tipos: uint, num (>= 0), snum (con signo), bool, token, name, ts, hex64.
create or replace function public.plusmedik_audit_field_ok(j jsonb, field text, kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when j -> field is null or jsonb_typeof(j -> field) = 'null' then true
    when kind = 'uint'  then jsonb_typeof(j -> field) = 'number' and (j ->> field) ~ '^[0-9]{1,10}$'
    when kind = 'num'   then jsonb_typeof(j -> field) = 'number' and (j ->> field) ~ '^[0-9]{1,9}(\.[0-9]{1,18})?$'
    when kind = 'snum'  then jsonb_typeof(j -> field) = 'number' and (j ->> field) ~ '^-?[0-9]{1,12}(\.[0-9]{1,18})?$'
    when kind = 'bool'  then jsonb_typeof(j -> field) = 'boolean'
    when kind = 'token' then jsonb_typeof(j -> field) = 'string' and (j ->> field) ~ '^[A-Za-z0-9_.:-]{1,64}$'
    when kind = 'name'  then jsonb_typeof(j -> field) = 'string' and (j ->> field) ~ '^[A-Za-z0-9_.:/@+-]{1,128}$'
    when kind = 'ts'    then jsonb_typeof(j -> field) = 'string' and (j ->> field) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
    when kind = 'hex64' then jsonb_typeof(j -> field) = 'string' and (j ->> field) ~ '^[0-9a-f]{64}$'
    else false
  end;
$$;

-- Líneas cotizadas / códigos candidatos: solo identificador, código del catálogo (informativo, texto corto sin control), precio y motivo de la línea.
create or replace function public.plusmedik_audit_catalog_refs_ok(j jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
begin
  if jsonb_typeof(j) <> 'array' then return false; end if;
  if jsonb_array_length(j) > 50 then return false; end if;
  for item in select value from jsonb_array_elements(j) loop
    if not public.plusmedik_audit_keys_within(item, array['labTestId', 'id', 'code', 'priceBs', 'basis']) then return false; end if;
    if not public.plusmedik_audit_field_ok(item, 'labTestId', 'token') or not public.plusmedik_audit_field_ok(item, 'id', 'token') then return false; end if;
    -- El precio puede ser inválido (negativo): la auditoría registra lo que el motor vio, no lo corrige.
    if not public.plusmedik_audit_field_ok(item, 'priceBs', 'snum') then return false; end if;
    if item -> 'code' is not null and jsonb_typeof(item -> 'code') <> 'null' and not (jsonb_typeof(item -> 'code') = 'string' and (item ->> 'code') ~ '^[^[:cntrl:]]{0,64}$') then return false; end if;
    if item -> 'basis' is not null and not (jsonb_typeof(item -> 'basis') = 'array' and public.plusmedik_audit_token_json_ok(item -> 'basis')) then return false; end if;
  end loop;
  return true;
end $$;

create or replace function public.plusmedik_audit_study_ok(j jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.plusmedik_audit_keys_within(j, array['study_index', 'decision', 'blockers', 'catalog_match_status', 'quoted_lines', 'candidate_codes', 'risk_class'])
    and j -> 'study_index' is not null and public.plusmedik_audit_field_ok(j, 'study_index', 'uint')
    and jsonb_typeof(j -> 'decision') = 'string' and public.plusmedik_audit_field_ok(j, 'decision', 'token')
    and (j -> 'blockers' is null or (jsonb_typeof(j -> 'blockers') = 'array' and public.plusmedik_audit_token_json_ok(j -> 'blockers')))
    and public.plusmedik_audit_field_ok(j, 'catalog_match_status', 'token')
    and public.plusmedik_audit_field_ok(j, 'risk_class', 'token')
    and (j -> 'quoted_lines' is null or public.plusmedik_audit_catalog_refs_ok(j -> 'quoted_lines'))
    and (j -> 'candidate_codes' is null or public.plusmedik_audit_catalog_refs_ok(j -> 'candidate_codes'));
$$;

create or replace function public.plusmedik_audit_call_ok(j jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.plusmedik_audit_keys_within(j, array['stage', 'provider', 'model', 'outcome', 'cache_hit', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cost_usd',
      'cost_status', 'safe_reading', 'call_seq', 'completion_seq', 'attempt', 'started_at', 'duration_ms', 'reasoning_effort', 'params_hash', 'error_kind'])
    and (j ->> 'stage') is not null and (j ->> 'provider') is not null and (j ->> 'model') is not null and (j ->> 'outcome') is not null and (j ->> 'cost_status') is not null
    and public.plusmedik_audit_field_ok(j, 'stage', 'token') and public.plusmedik_audit_field_ok(j, 'provider', 'name') and public.plusmedik_audit_field_ok(j, 'model', 'name')
    and public.plusmedik_audit_field_ok(j, 'outcome', 'token') and public.plusmedik_audit_field_ok(j, 'cost_status', 'token') and public.plusmedik_audit_field_ok(j, 'cache_hit', 'bool')
    and public.plusmedik_audit_field_ok(j, 'input_tokens', 'uint') and public.plusmedik_audit_field_ok(j, 'output_tokens', 'uint') and public.plusmedik_audit_field_ok(j, 'reasoning_tokens', 'uint')
    and public.plusmedik_audit_field_ok(j, 'cost_usd', 'num')
    and public.plusmedik_audit_field_ok(j, 'call_seq', 'uint') and public.plusmedik_audit_field_ok(j, 'completion_seq', 'uint') and public.plusmedik_audit_field_ok(j, 'attempt', 'uint')
    and public.plusmedik_audit_field_ok(j, 'duration_ms', 'uint') and public.plusmedik_audit_field_ok(j, 'started_at', 'ts')
    and public.plusmedik_audit_field_ok(j, 'reasoning_effort', 'token') and public.plusmedik_audit_field_ok(j, 'params_hash', 'hex64') and public.plusmedik_audit_field_ok(j, 'error_kind', 'token')
    and (j -> 'safe_reading' is null or (jsonb_typeof(j -> 'safe_reading') = 'object' and public.plusmedik_audit_token_json_ok(j -> 'safe_reading')));
$$;

create or replace function public.plusmedik_audit_check_ok(j jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.plusmedik_audit_keys_within(j, array['check_kind', 'check_status', 'summary'])
    and (j ->> 'check_kind') is not null and (j ->> 'check_status') is not null
    and public.plusmedik_audit_field_ok(j, 'check_kind', 'token') and public.plusmedik_audit_field_ok(j, 'check_status', 'token')
    and (j -> 'summary' is null or (jsonb_typeof(j -> 'summary') = 'object' and public.plusmedik_audit_token_json_ok(j -> 'summary')));
$$;

create or replace function public.plusmedik_audit_run_part_ok(j jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.plusmedik_audit_keys_within(j, array['analysis_decision', 'analysis_outcome', 'review_required', 'recipe_stops', 'document_summary', 'catalog_hash', 'catalog_size', 'config_hash'])
    and public.plusmedik_audit_field_ok(j, 'analysis_decision', 'token') and public.plusmedik_audit_field_ok(j, 'analysis_outcome', 'token')
    and public.plusmedik_audit_field_ok(j, 'review_required', 'bool') and public.plusmedik_audit_field_ok(j, 'catalog_size', 'uint')
    and public.plusmedik_audit_field_ok(j, 'catalog_hash', 'hex64') and public.plusmedik_audit_field_ok(j, 'config_hash', 'hex64')
    and (j -> 'recipe_stops' is null or (jsonb_typeof(j -> 'recipe_stops') = 'array' and public.plusmedik_audit_token_json_ok(j -> 'recipe_stops')))
    and (j -> 'document_summary' is null or (jsonb_typeof(j -> 'document_summary') = 'object' and public.plusmedik_audit_token_json_ok(j -> 'document_summary')));
$$;

-- ───────────────────────── RPC: evidencias de un análisis (una sola transacción) ─────────────────────────
-- Contrato (contract = 1). Los hijos NO llevan run_id: lo fija p_run_id. Cada clave ausente queda NULL/por defecto; nada se inventa.
--   {
--     "contract": 1,
--     "run":        { analysis_decision, analysis_outcome, review_required, recipe_stops[], document_summary{}, catalog_hash, catalog_size, config_hash },
--     "studies":    [ { study_index, decision, blockers[], catalog_match_status, quoted_lines[], candidate_codes[], risk_class } ],
--     "model_calls":[ { stage, provider, model, outcome, cache_hit, tokens..., cost_usd, cost_status, safe_reading{}, call_seq, ..., error_kind } ],
--     "checks":     [ { check_kind, check_status, summary{} } ]
--   }
-- Resultado: {"status":"recorded"|"already_recorded", "studies":n, "model_calls":n, "checks":n}.
-- Errores (sin valores recibidos): PT404 corrida inexistente, PT409 contenido distinto de lo ya confirmado, PT422 contenido no permitido o rechazado por la base.
create or replace function public.plusmedik_audit_record_evidence(p_run_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_hash text;
  v_part jsonb;
  v_studies jsonb;
  v_calls jsonb;
  v_checks jsonb;
  v_item jsonb;
  v_n_studies integer := 0;
  v_n_calls integer := 0;
  v_n_checks integer := 0;
  v_state text;
  v_constraint text;
begin
  -- 1. Validación previa: nada se escribe hasta que TODO el contenido es admisible.
  if p_run_id is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'plusmedik_audit: payload must be a JSON object' using errcode = 'PT422';
  end if;
  if octet_length(p_payload::text) > 1000000 then
    raise exception 'plusmedik_audit: payload too large' using errcode = 'PT422';
  end if;
  if not public.plusmedik_audit_keys_within(p_payload, array['contract', 'run', 'studies', 'model_calls', 'checks']) then
    raise exception 'plusmedik_audit: unknown top-level key' using errcode = 'PT422';
  end if;
  if p_payload -> 'contract' is distinct from to_jsonb(1) then
    raise exception 'plusmedik_audit: unsupported contract' using errcode = 'PT422';
  end if;

  v_part := coalesce(p_payload -> 'run', '{}'::jsonb);
  v_studies := coalesce(p_payload -> 'studies', '[]'::jsonb);
  v_calls := coalesce(p_payload -> 'model_calls', '[]'::jsonb);
  v_checks := coalesce(p_payload -> 'checks', '[]'::jsonb);
  if jsonb_typeof(v_studies) <> 'array' or jsonb_typeof(v_calls) <> 'array' or jsonb_typeof(v_checks) <> 'array'
     or jsonb_array_length(v_studies) > 200 or jsonb_array_length(v_calls) > 200 or jsonb_array_length(v_checks) > 20 then
    raise exception 'plusmedik_audit: invalid collection' using errcode = 'PT422';
  end if;
  if not public.plusmedik_audit_run_part_ok(v_part) then
    raise exception 'plusmedik_audit: invalid run section' using errcode = 'PT422';
  end if;
  for v_item in select value from jsonb_array_elements(v_studies) loop
    if not public.plusmedik_audit_study_ok(v_item) then raise exception 'plusmedik_audit: invalid study entry' using errcode = 'PT422'; end if;
  end loop;
  for v_item in select value from jsonb_array_elements(v_calls) loop
    if not public.plusmedik_audit_call_ok(v_item) then raise exception 'plusmedik_audit: invalid model call entry' using errcode = 'PT422'; end if;
  end loop;
  for v_item in select value from jsonb_array_elements(v_checks) loop
    if not public.plusmedik_audit_check_ok(v_item) then raise exception 'plusmedik_audit: invalid check entry' using errcode = 'PT422'; end if;
  end loop;

  -- jsonb::text es canónico (orden de claves y espacios normalizados): el mismo contenido da el mismo hash aunque llegue con otro orden.
  v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');

  -- 2. Serialización por corrida: dos escrituras del mismo análisis esperan aquí; la segunda ve lo confirmado por la primera.
  select * into v_run from public.plusmedik_audit_runs where id = p_run_id for update;
  if not found then
    raise exception 'plusmedik_audit: run not found' using errcode = 'PT404';
  end if;
  if v_run.evidence_recorded_at is not null then
    if v_run.evidence_hash = v_hash then
      return jsonb_build_object('status', 'already_recorded');
    end if;
    raise exception 'plusmedik_audit: evidence already recorded with different content' using errcode = 'PT409';
  end if;

  -- 3. Escritura. Cualquier fallo revierte TODO (la función es una sola transacción) y se informa sin valores.
  begin
    insert into public.plusmedik_audit_studies (run_id, study_index, decision, blockers, catalog_match_status, quoted_lines, candidate_codes, risk_class)
    select p_run_id, x.study_index, x.decision, coalesce(x.blockers, '[]'::jsonb), x.catalog_match_status, coalesce(x.quoted_lines, '[]'::jsonb), coalesce(x.candidate_codes, '[]'::jsonb), x.risk_class
    from jsonb_to_recordset(v_studies) as x(study_index integer, decision text, blockers jsonb, catalog_match_status text, quoted_lines jsonb, candidate_codes jsonb, risk_class text);
    get diagnostics v_n_studies = row_count;

    insert into public.plusmedik_audit_model_calls (run_id, stage, provider, model, outcome, cache_hit, input_tokens, output_tokens, reasoning_tokens, cost_usd, cost_status,
      safe_reading, call_seq, completion_seq, attempt, started_at, duration_ms, reasoning_effort, params_hash, error_kind)
    select p_run_id, x.stage, x.provider, x.model, x.outcome, coalesce(x.cache_hit, false), x.input_tokens, x.output_tokens, x.reasoning_tokens, x.cost_usd, x.cost_status,
      coalesce(x.safe_reading, '{}'::jsonb), x.call_seq, x.completion_seq, x.attempt, x.started_at, x.duration_ms, x.reasoning_effort, x.params_hash, x.error_kind
    from jsonb_to_recordset(v_calls) as x(stage text, provider text, model text, outcome text, cache_hit boolean, input_tokens integer, output_tokens integer, reasoning_tokens integer,
      cost_usd numeric, cost_status text, safe_reading jsonb, call_seq integer, completion_seq integer, attempt integer, started_at timestamptz, duration_ms integer,
      reasoning_effort text, params_hash text, error_kind text);
    get diagnostics v_n_calls = row_count;

    insert into public.plusmedik_audit_checks (run_id, check_kind, check_status, summary)
    select p_run_id, x.check_kind, x.check_status, coalesce(x.summary, '{}'::jsonb)
    from jsonb_to_recordset(v_checks) as x(check_kind text, check_status text, summary jsonb);
    get diagnostics v_n_checks = row_count;

    update public.plusmedik_audit_runs set
      analysis_decision = case when v_part ? 'analysis_decision' then v_part ->> 'analysis_decision' else analysis_decision end,
      analysis_outcome = case when v_part ? 'analysis_outcome' then v_part ->> 'analysis_outcome' else analysis_outcome end,
      review_required = case when v_part ? 'review_required' then (v_part ->> 'review_required')::boolean else review_required end,
      recipe_stops = case when v_part ? 'recipe_stops' then coalesce(v_part -> 'recipe_stops', '[]'::jsonb) else recipe_stops end,
      document_summary = case when v_part ? 'document_summary' then coalesce(v_part -> 'document_summary', '{}'::jsonb) else document_summary end,
      catalog_hash = case when v_part ? 'catalog_hash' then v_part ->> 'catalog_hash' else catalog_hash end,
      catalog_size = case when v_part ? 'catalog_size' then (v_part ->> 'catalog_size')::integer else catalog_size end,
      config_hash = case when v_part ? 'config_hash' then v_part ->> 'config_hash' else config_hash end,
      processing_status = case when v_part ? 'analysis_decision' and processing_status = 'PROCESSING' then 'ANALYZED' else processing_status end,
      evidence_recorded_at = now(),
      evidence_hash = v_hash
    where id = p_run_id;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    -- Las propias (PT***) y los conflictos de concurrencia pasan tal cual; el resto se reduce a su código para no filtrar valores del contenido.
    if v_state like 'PT%' or v_state in ('40001', '40P01', '55P03', '57014') then
      raise;
    end if;
    raise exception 'plusmedik_audit: evidence rejected by the database' using errcode = 'PT422', detail = 'sqlstate=' || v_state || ' constraint=' || coalesce(v_constraint, '-');
  end;

  return jsonb_build_object('status', 'recorded', 'studies', v_n_studies, 'model_calls', v_n_calls, 'checks', v_n_checks);
end $$;

-- ───────────────────────── RPC: resultado del envío (ciclo de vida + verificación REPLY, una transacción) ─────────────────────────
-- p_reply: { state: ACCEPTED|UNKNOWN, result: quoted|no_quote|technical_issue|ignored, processing_status: COMPLETED|FAILED, provider_message_id? }
-- Mismo contenido repetido => 'already_recorded'; distinto => PT409. El resultado de un envío se registra una sola vez.
create or replace function public.plusmedik_audit_record_reply(p_run_id uuid, p_reply jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.plusmedik_audit_runs%rowtype;
  v_state text;
  v_result text;
  v_status text;
  v_message text;
  v_sqlstate text;
begin
  if p_run_id is null or p_reply is null or not public.plusmedik_audit_keys_within(p_reply, array['state', 'result', 'processing_status', 'provider_message_id']) then
    raise exception 'plusmedik_audit: invalid reply' using errcode = 'PT422';
  end if;
  v_state := p_reply ->> 'state';
  v_result := p_reply ->> 'result';
  v_status := p_reply ->> 'processing_status';
  v_message := p_reply ->> 'provider_message_id';
  if v_state is null or v_state not in ('ACCEPTED', 'UNKNOWN')
     or v_result is null or v_result not in ('quoted', 'no_quote', 'technical_issue', 'ignored')
     or v_status is null or v_status not in ('COMPLETED', 'FAILED')
     or (v_message is not null and v_message !~ '^[A-Za-z0-9_.=:-]{1,128}$') then
    raise exception 'plusmedik_audit: invalid reply' using errcode = 'PT422';
  end if;

  select * into v_run from public.plusmedik_audit_runs where id = p_run_id for update;
  if not found then
    raise exception 'plusmedik_audit: run not found' using errcode = 'PT404';
  end if;
  if v_run.reply_state <> 'NOT_ATTEMPTED' then
    if v_run.reply_state = v_state and v_run.reply_kind is not distinct from v_result and v_run.kapso_outbound_message_id is not distinct from v_message then
      return jsonb_build_object('status', 'already_recorded');
    end if;
    raise exception 'plusmedik_audit: reply already recorded with different content' using errcode = 'PT409';
  end if;

  begin
    update public.plusmedik_audit_runs set
      reply_state = v_state,
      reply_kind = v_result,
      kapso_outbound_message_id = v_message,
      processing_status = v_status,
      completed_at = now()
    where id = p_run_id;
    insert into public.plusmedik_audit_checks (run_id, check_kind, check_status, summary)
    values (p_run_id, 'REPLY', v_state, jsonb_build_object('result', v_result, 'providerAccepted', v_state = 'ACCEPTED'));
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate;
    if v_sqlstate like 'PT%' or v_sqlstate in ('40001', '40P01', '55P03', '57014') then
      raise;
    end if;
    raise exception 'plusmedik_audit: reply rejected by the database' using errcode = 'PT422', detail = 'sqlstate=' || v_sqlstate;
  end;

  return jsonb_build_object('status', 'recorded');
end $$;

-- ───────────────────────── triggers de inmutabilidad ─────────────────────────

-- Evidencias históricas: ni UPDATE, ni DELETE, ni TRUNCATE para nadie (tampoco el propietario). Los mensajes no incluyen valores.
create or replace function public.plusmedik_audit_forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'plusmedik_audit: % on % is not allowed (historical audit evidence is immutable)', tg_op, tg_table_name using errcode = 'PT409';
end $$;

create or replace trigger plusmedik_audit_studies_immutable before update or delete on public.plusmedik_audit_studies
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_audit_model_calls_immutable before update or delete on public.plusmedik_audit_model_calls
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_audit_checks_immutable before update or delete on public.plusmedik_audit_checks
  for each row execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_audit_runs_no_delete before delete on public.plusmedik_audit_runs
  for each row execute function public.plusmedik_audit_forbid_mutation();

create or replace trigger plusmedik_audit_studies_no_truncate before truncate on public.plusmedik_audit_studies
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_audit_model_calls_no_truncate before truncate on public.plusmedik_audit_model_calls
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_audit_checks_no_truncate before truncate on public.plusmedik_audit_checks
  for each statement execute function public.plusmedik_audit_forbid_mutation();
create or replace trigger plusmedik_audit_runs_no_truncate before truncate on public.plusmedik_audit_runs
  for each statement execute function public.plusmedik_audit_forbid_mutation();

-- runs: los datos operativos SÍ se actualizan (estado, cierre, resultado del envío), pero con reglas:
--   · identidad y versiones registradas al reclamar el mensaje: inmutables;
--   · columnas de evidencia: se escriben una sola vez, junto con evidence_recorded_at (y después, nunca);
--   · estado: solo transiciones válidas del ciclo de vida; resultado del envío, código de error e id saliente: se fijan una sola vez.
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

create or replace trigger plusmedik_audit_runs_guard before update on public.plusmedik_audit_runs
  for each row execute function public.plusmedik_audit_runs_guard();

-- ───────────────────────── privilegios ─────────────────────────
-- service_role se salta RLS, pero NO los privilegios de tabla: aquí se le quita todo lo que no necesita. Las inserciones de evidencia solo ocurren por las
-- funciones SECURITY DEFINER (propiedad del dueño de las tablas, search_path fijo, sin SQL dinámico). anon/authenticated/PUBLIC no ejecutan nada.

revoke insert, update, delete, truncate on table public.plusmedik_audit_studies, public.plusmedik_audit_model_calls, public.plusmedik_audit_checks from service_role;
revoke insert, update, delete, truncate on table public.plusmedik_audit_runs from service_role;
grant insert (kapso_message_id, kapso_media_id, processing_status, audit_schema_version, engine_version, flags) on table public.plusmedik_audit_runs to service_role;
grant update (processing_status, completed_at, error_code, reply_state, reply_kind, kapso_outbound_message_id) on table public.plusmedik_audit_runs to service_role;

revoke all on function public.plusmedik_audit_token_json_ok(jsonb, integer) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_keys_within(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_field_ok(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_catalog_refs_ok(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_study_ok(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_call_ok(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_check_ok(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_run_part_ok(jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_forbid_mutation() from public, anon, authenticated;
revoke all on function public.plusmedik_audit_runs_guard() from public, anon, authenticated;
revoke all on function public.plusmedik_audit_record_evidence(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.plusmedik_audit_record_reply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.plusmedik_audit_record_evidence(uuid, jsonb) to service_role;
grant execute on function public.plusmedik_audit_record_reply(uuid, jsonb) to service_role;

comment on function public.plusmedik_audit_record_evidence(uuid, jsonb) is 'Registra de forma atómica e idempotente las evidencias de un análisis. SECURITY DEFINER, search_path fijo, solo service_role.';
comment on function public.plusmedik_audit_record_reply(uuid, jsonb) is 'Registra una sola vez el resultado del envío (ciclo de vida de runs + verificación REPLY) en una transacción. Solo service_role.';
