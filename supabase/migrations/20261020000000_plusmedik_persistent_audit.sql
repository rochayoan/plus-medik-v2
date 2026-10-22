-- PlusMedik V2 Fase 6. Solo define esquema local; no programa purga ni aplica cambios remotos.
-- No contiene imágenes, teléfonos, payloads crudos, prompts, respuestas crudas ni razonamientos.

create table if not exists public.plusmedik_audit_runs (
  id uuid primary key default gen_random_uuid(),
  kapso_message_id text not null unique,
  kapso_media_id text,
  received_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  processing_status text not null check (processing_status in ('PROCESSING', 'ANALYZED', 'COMPLETED', 'FAILED', 'IGNORED')),
  analysis_decision text check (analysis_decision in ('AUTO_SAFE', 'HUMAN_REVIEW')),
  analysis_outcome text check (analysis_outcome in ('AUTO_COMPLETE', 'AUTO_PARTIAL', 'HUMAN_REVIEW', 'AUTO_SAFE')),
  review_required boolean,
  recipe_stops jsonb not null default '[]'::jsonb,
  document_summary jsonb not null default '{}'::jsonb,
  reply_state text not null default 'NOT_ATTEMPTED' check (reply_state in ('NOT_ATTEMPTED', 'ACCEPTED', 'UNKNOWN')),
  reply_kind text,
  kapso_outbound_message_id text,
  error_code text,
  detail_expires_at timestamptz not null default (now() + interval '30 days'),
  metrics_expires_at timestamptz not null default (now() + interval '180 days'),
  detail_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plusmedik_audit_studies (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.plusmedik_audit_runs(id) on delete cascade,
  study_index integer not null check (study_index >= 0),
  decision text not null check (decision in ('AUTO', 'HUMAN_REVIEW')),
  blockers jsonb not null default '[]'::jsonb,
  catalog_match_status text,
  quoted_lines jsonb not null default '[]'::jsonb,
  candidate_codes jsonb not null default '[]'::jsonb,
  risk_class text,
  created_at timestamptz not null default now(),
  unique (run_id, study_index)
);

create table if not exists public.plusmedik_audit_model_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.plusmedik_audit_runs(id) on delete cascade,
  stage text not null,
  provider text not null,
  model text not null,
  outcome text not null check (outcome in ('OK', 'FAILED', 'INVALID', 'CACHE_HIT')),
  cache_hit boolean not null default false,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens is null or reasoning_tokens >= 0),
  cost_usd numeric(18, 9),
  cost_status text not null check (cost_status in ('PROVIDER_REPORTED', 'TOKENS_ONLY', 'NO_PROVIDER_CALL', 'UNAVAILABLE')),
  safe_reading jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.plusmedik_audit_checks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.plusmedik_audit_runs(id) on delete cascade,
  check_kind text not null check (check_kind in ('DOCUMENT', 'JUDGE', 'CATALOG', 'REPLY')),
  check_status text not null,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists plusmedik_audit_runs_received_at_idx on public.plusmedik_audit_runs (received_at desc);
create index if not exists plusmedik_audit_runs_status_idx on public.plusmedik_audit_runs (processing_status, received_at desc);
create index if not exists plusmedik_audit_studies_pending_idx on public.plusmedik_audit_studies (decision, run_id) where decision = 'HUMAN_REVIEW';
create index if not exists plusmedik_audit_model_calls_run_idx on public.plusmedik_audit_model_calls (run_id, created_at);
create index if not exists plusmedik_audit_checks_run_idx on public.plusmedik_audit_checks (run_id, created_at);

alter table public.plusmedik_audit_runs enable row level security;
alter table public.plusmedik_audit_studies enable row level security;
alter table public.plusmedik_audit_model_calls enable row level security;
alter table public.plusmedik_audit_checks enable row level security;

revoke all on table public.plusmedik_audit_runs, public.plusmedik_audit_studies, public.plusmedik_audit_model_calls, public.plusmedik_audit_checks from anon, authenticated;
grant select, insert, update, delete on table public.plusmedik_audit_runs, public.plusmedik_audit_studies, public.plusmedik_audit_model_calls, public.plusmedik_audit_checks to service_role;

comment on table public.plusmedik_audit_runs is 'Server-only PlusMedik audit. No patient images, phone numbers, raw payloads, prompts, or model raw output.';
