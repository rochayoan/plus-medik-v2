-- PlusMedik V2 — verificación DESPUÉS de aplicar las 16 migraciones (solo lectura)
-- GENERADO por scripts/migration-manifest.ts a partir de supabase/migrations/*.sql. NO editar a mano (una prueba falla si no coincide).
-- SOLO LECTURA: una sola sentencia SELECT. No contiene DDL, DML, RPC ni datos clínicos; devuelve metadatos y conteos.
-- Ejecutar exclusivamente en el proyecto Supabase cvokrtrdzxfchntwwslz (verificar el identificador en la URL del panel ANTES de ejecutar),
-- con el rol administrativo del SQL Editor. Es seguro ejecutarla dentro de una transacción de solo lectura.
-- Esperado al completar el conjunto: VEREDICTO = OK, todas las migraciones completas y sin BLOCK; filas INSTANTANEA idénticas antes/después.
-- También sirve después de CADA migración: las posteriores aparecerán como pendientes (INFO) y las aplicadas deben estar completas.
-- Funciones con EXECUTE para service_role esperadas por las migraciones: 59.
--
-- Migraciones cubiertas (sha256 del archivo con saltos de línea LF):
--   01  20261020000000_plusmedik_persistent_audit.sql  1110edc1e1b3f6c4961b87bdb763ecea535ef5b1d6ba9086ff314a86b88ad61a
--   02  20261021000000_plusmedik_audit_telemetry.sql  08e555cf0c872ce2380cbd5046c2296a525c20b6caaddee6ae51ccdb53243256
--   03  20261022000000_plusmedik_audit_transactional.sql  1135f673e0a8e5de5ef03dae1acae55427c01ff99f4a5988f90595abe9244079
--   04  20261023000000_plusmedik_audit_leases.sql  1b6546c2a44142a00b771f303dccc43f5ea408cd912a340c3b3e406e63185ee7
--   05  20261024000000_plusmedik_human_control.sql  21430ed091a169945d1f5b9109484c11a34a5d7e9981d715dc2c83c36fc9658d
--   06  20261025000000_plusmedik_turns.sql  2db27531909ec6d2a3d394dba41aa705ae226f5b37bac9985a17de109e08af13
--   07  20261026000000_plusmedik_turn_recovery.sql  034f4ee6769c5537490aa881e96ba39221a9009ca4aedd6967c1aaa04ee02318
--   08  20261027000000_plusmedik_knowledge.sql  3552b34dec191045f3113c879163bcdc87ce120a2589d162710f3f1fbb19c296
--   09  20261028000000_plusmedik_knowledge_refs.sql  aa0b8644dc0f4a2ac98c84ae4c123b03c5e261c41618f4d45ec7dc9245690021
--   10  20261029000000_plusmedik_reply_guard.sql  689c71aa2de466a38cf93fdfeb853a90a8f4ac3bca232995df194014456aec3f
--   11  20261030000000_plusmedik_quote_sessions.sql  af0b7ed8399ccda325b343b07b025a8e7978317659a533b2a2fb7eb2a68ad314
--   12  20261031000000_plusmedik_study_facts.sql  0958eb09426a1b56305f0988c97c21163ea44dd71108bb66e48d52fc6aae8391
--   13  20261101000000_plusmedik_crm_outbox.sql  97567b01091229f081f070f4990eb6e0859c5a9ae4ac849e424c8f903137feb5
--   14  20261102000000_plusmedik_quote_text_flow.sql  2094f37085484e0c889f3fa46a563539b7f7ba61049ffb332064a7059d17d9f5
--   15  20261103000000_plusmedik_crm_attention_control.sql  0f14159a903f1e50d3666923fa0e46edc06d36b752ec7ef6348923b5e43c3bc9
--   16  20261104000000_plusmedik_reply_guard_atomic_rate.sql  33b409b481cbc845ed6b07f2a3b74af86251ba936ac6b5c465127d838097568b
--
-- Resultado: una tabla (orden, seccion, comprobacion, estado, detalle). Estados: OK · INFO · WARN (revisar) · BLOCK (detenerse).
-- La primera fila es el VEREDICTO. Guardar el resultado completo: las filas INSTANTANEA deben ser IDÉNTICAS antes y después.

with
manifest(mig, kind, name, parent) as (
  values
    (1, 'index', 'plusmedik_audit_checks_run_idx', 'plusmedik_audit_checks'),
    (1, 'index', 'plusmedik_audit_model_calls_run_idx', 'plusmedik_audit_model_calls'),
    (1, 'index', 'plusmedik_audit_runs_received_at_idx', 'plusmedik_audit_runs'),
    (1, 'index', 'plusmedik_audit_runs_status_idx', 'plusmedik_audit_runs'),
    (1, 'index', 'plusmedik_audit_studies_pending_idx', 'plusmedik_audit_studies'),
    (1, 'table', 'plusmedik_audit_checks', ''),
    (1, 'table', 'plusmedik_audit_model_calls', ''),
    (1, 'table', 'plusmedik_audit_runs', ''),
    (1, 'table', 'plusmedik_audit_studies', ''),
    (2, 'column', 'attempt', 'plusmedik_audit_model_calls'),
    (2, 'column', 'audit_schema_version', 'plusmedik_audit_runs'),
    (2, 'column', 'call_seq', 'plusmedik_audit_model_calls'),
    (2, 'column', 'catalog_hash', 'plusmedik_audit_runs'),
    (2, 'column', 'catalog_size', 'plusmedik_audit_runs'),
    (2, 'column', 'completion_seq', 'plusmedik_audit_model_calls'),
    (2, 'column', 'config_hash', 'plusmedik_audit_runs'),
    (2, 'column', 'duration_ms', 'plusmedik_audit_model_calls'),
    (2, 'column', 'engine_version', 'plusmedik_audit_runs'),
    (2, 'column', 'error_kind', 'plusmedik_audit_model_calls'),
    (2, 'column', 'flags', 'plusmedik_audit_runs'),
    (2, 'column', 'params_hash', 'plusmedik_audit_model_calls'),
    (2, 'column', 'reasoning_effort', 'plusmedik_audit_model_calls'),
    (2, 'column', 'started_at', 'plusmedik_audit_model_calls'),
    (2, 'constraint', 'plusmedik_audit_model_calls_telemetry_check', 'plusmedik_audit_model_calls'),
    (2, 'constraint', 'plusmedik_audit_runs_telemetry_check', 'plusmedik_audit_runs'),
    (2, 'index', 'plusmedik_audit_model_calls_call_attempt_idx', 'plusmedik_audit_model_calls'),
    (2, 'index', 'plusmedik_audit_runs_config_idx', 'plusmedik_audit_runs'),
    (3, 'column', 'evidence_hash', 'plusmedik_audit_runs'),
    (3, 'column', 'evidence_recorded_at', 'plusmedik_audit_runs'),
    (3, 'constraint', 'plusmedik_audit_runs_evidence_check', 'plusmedik_audit_runs'),
    (3, 'function', 'plusmedik_audit_call_ok', ''),
    (3, 'function', 'plusmedik_audit_catalog_refs_ok', ''),
    (3, 'function', 'plusmedik_audit_check_ok', ''),
    (3, 'function', 'plusmedik_audit_field_ok', ''),
    (3, 'function', 'plusmedik_audit_forbid_mutation', ''),
    (3, 'function', 'plusmedik_audit_keys_within', ''),
    (3, 'function', 'plusmedik_audit_record_evidence', ''),
    (3, 'function', 'plusmedik_audit_record_reply', ''),
    (3, 'function', 'plusmedik_audit_run_part_ok', ''),
    (3, 'function', 'plusmedik_audit_runs_guard', ''),
    (3, 'function', 'plusmedik_audit_study_ok', ''),
    (3, 'function', 'plusmedik_audit_token_json_ok', ''),
    (3, 'index', 'plusmedik_audit_checks_run_kind_idx', 'plusmedik_audit_checks'),
    (3, 'trigger', 'plusmedik_audit_checks_immutable', 'plusmedik_audit_checks'),
    (3, 'trigger', 'plusmedik_audit_checks_no_truncate', 'plusmedik_audit_checks'),
    (3, 'trigger', 'plusmedik_audit_model_calls_immutable', 'plusmedik_audit_model_calls'),
    (3, 'trigger', 'plusmedik_audit_model_calls_no_truncate', 'plusmedik_audit_model_calls'),
    (3, 'trigger', 'plusmedik_audit_runs_guard', 'plusmedik_audit_runs'),
    (3, 'trigger', 'plusmedik_audit_runs_no_delete', 'plusmedik_audit_runs'),
    (3, 'trigger', 'plusmedik_audit_runs_no_truncate', 'plusmedik_audit_runs'),
    (3, 'trigger', 'plusmedik_audit_studies_immutable', 'plusmedik_audit_studies'),
    (3, 'trigger', 'plusmedik_audit_studies_no_truncate', 'plusmedik_audit_studies'),
    (4, 'column', 'attention_at', 'plusmedik_audit_runs'),
    (4, 'column', 'attention_reason', 'plusmedik_audit_runs'),
    (4, 'column', 'lease_attempts', 'plusmedik_audit_runs'),
    (4, 'column', 'lease_expires_at', 'plusmedik_audit_runs'),
    (4, 'column', 'lease_fence', 'plusmedik_audit_runs'),
    (4, 'column', 'lease_owner', 'plusmedik_audit_runs'),
    (4, 'column', 'send_block_reason', 'plusmedik_audit_runs'),
    (4, 'column', 'send_blocked_at', 'plusmedik_audit_runs'),
    (4, 'column', 'send_kind', 'plusmedik_audit_runs'),
    (4, 'column', 'send_reserved_at', 'plusmedik_audit_runs'),
    (4, 'column', 'send_state', 'plusmedik_audit_runs'),
    (4, 'constraint', 'plusmedik_audit_runs_lease_check', 'plusmedik_audit_runs'),
    (4, 'function', 'plusmedik_audit_block_send', ''),
    (4, 'function', 'plusmedik_audit_claim_run', ''),
    (4, 'function', 'plusmedik_audit_fenced_close', ''),
    (4, 'function', 'plusmedik_audit_fenced_record_evidence', ''),
    (4, 'function', 'plusmedik_audit_fenced_record_reply', ''),
    (4, 'function', 'plusmedik_audit_lock_leased', ''),
    (4, 'function', 'plusmedik_audit_prove', ''),
    (4, 'function', 'plusmedik_audit_recover_stale', ''),
    (4, 'function', 'plusmedik_audit_renew_lease', ''),
    (4, 'function', 'plusmedik_audit_reserve_send', ''),
    (4, 'index', 'plusmedik_audit_runs_lease_idx', 'plusmedik_audit_runs'),
    (4, 'view', 'plusmedik_audit_run_phase', ''),
    (5, 'column', 'contact_key', 'plusmedik_audit_runs'),
    (5, 'constraint', 'plusmedik_audit_runs_contact_key_check', 'plusmedik_audit_runs'),
    (5, 'function', 'plusmedik_attention_contacts_guard', ''),
    (5, 'function', 'plusmedik_attention_record_event', ''),
    (5, 'function', 'plusmedik_attention_register_human_message', ''),
    (5, 'function', 'plusmedik_attention_resume', ''),
    (5, 'function', 'plusmedik_attention_status', ''),
    (5, 'function', 'plusmedik_audit_confirm_send', ''),
    (5, 'index', 'plusmedik_attention_events_contact_idx', 'plusmedik_attention_events'),
    (5, 'index', 'plusmedik_audit_runs_contact_idx', 'plusmedik_audit_runs'),
    (5, 'table', 'plusmedik_attention_contacts', ''),
    (5, 'table', 'plusmedik_attention_events', ''),
    (5, 'trigger', 'plusmedik_attention_contacts_guard', 'plusmedik_attention_contacts'),
    (5, 'trigger', 'plusmedik_attention_contacts_no_delete', 'plusmedik_attention_contacts'),
    (5, 'trigger', 'plusmedik_attention_contacts_no_truncate', 'plusmedik_attention_contacts'),
    (5, 'trigger', 'plusmedik_attention_events_immutable', 'plusmedik_attention_events'),
    (5, 'trigger', 'plusmedik_attention_events_no_truncate', 'plusmedik_attention_events'),
    (6, 'function', 'plusmedik_contact_turns_guard', ''),
    (6, 'function', 'plusmedik_turn_claim', ''),
    (6, 'function', 'plusmedik_turn_reserve_send', ''),
    (6, 'index', 'plusmedik_turns_contact_seq_idx', 'plusmedik_turns'),
    (6, 'table', 'plusmedik_contact_turns', ''),
    (6, 'table', 'plusmedik_turns', ''),
    (6, 'trigger', 'plusmedik_contact_turns_guard', 'plusmedik_contact_turns'),
    (6, 'trigger', 'plusmedik_contact_turns_no_delete', 'plusmedik_contact_turns'),
    (6, 'trigger', 'plusmedik_contact_turns_no_truncate', 'plusmedik_contact_turns'),
    (6, 'trigger', 'plusmedik_turns_immutable', 'plusmedik_turns'),
    (6, 'trigger', 'plusmedik_turns_no_truncate', 'plusmedik_turns'),
    (7, 'function', 'plusmedik_turn_release', ''),
    (8, 'function', 'plusmedik_kb_approve', ''),
    (8, 'function', 'plusmedik_kb_assert_actor', ''),
    (8, 'function', 'plusmedik_kb_assert_not_author', ''),
    (8, 'function', 'plusmedik_kb_bump', ''),
    (8, 'function', 'plusmedik_kb_create_draft', ''),
    (8, 'function', 'plusmedik_kb_deactivate', ''),
    (8, 'function', 'plusmedik_kb_edit_draft', ''),
    (8, 'function', 'plusmedik_kb_hash', ''),
    (8, 'function', 'plusmedik_kb_hhmm_ok', ''),
    (8, 'function', 'plusmedik_kb_history', ''),
    (8, 'function', 'plusmedik_kb_list', ''),
    (8, 'function', 'plusmedik_kb_payload_ok', ''),
    (8, 'function', 'plusmedik_kb_reject', ''),
    (8, 'function', 'plusmedik_kb_restore', ''),
    (8, 'function', 'plusmedik_kb_revision', ''),
    (8, 'function', 'plusmedik_kb_snapshot', ''),
    (8, 'function', 'plusmedik_kb_submit', ''),
    (8, 'function', 'plusmedik_kb_text_ok', ''),
    (8, 'function', 'plusmedik_kb_versions_guard', ''),
    (8, 'index', 'plusmedik_kb_events_document_idx', 'plusmedik_kb_events'),
    (8, 'index', 'plusmedik_kb_events_version_idx', 'plusmedik_kb_events'),
    (8, 'index', 'plusmedik_kb_one_approved_idx', 'plusmedik_kb_versions'),
    (8, 'index', 'plusmedik_kb_one_open_idx', 'plusmedik_kb_versions'),
    (8, 'index', 'plusmedik_kb_versions_status_idx', 'plusmedik_kb_versions'),
    (8, 'table', 'plusmedik_kb_documents', ''),
    (8, 'table', 'plusmedik_kb_events', ''),
    (8, 'table', 'plusmedik_kb_state', ''),
    (8, 'table', 'plusmedik_kb_versions', ''),
    (8, 'trigger', 'plusmedik_kb_documents_immutable', 'plusmedik_kb_documents'),
    (8, 'trigger', 'plusmedik_kb_documents_no_truncate', 'plusmedik_kb_documents'),
    (8, 'trigger', 'plusmedik_kb_events_immutable', 'plusmedik_kb_events'),
    (8, 'trigger', 'plusmedik_kb_events_no_truncate', 'plusmedik_kb_events'),
    (8, 'trigger', 'plusmedik_kb_state_no_delete', 'plusmedik_kb_state'),
    (8, 'trigger', 'plusmedik_kb_state_no_truncate', 'plusmedik_kb_state'),
    (8, 'trigger', 'plusmedik_kb_versions_guard', 'plusmedik_kb_versions'),
    (8, 'trigger', 'plusmedik_kb_versions_no_truncate', 'plusmedik_kb_versions'),
    (9, 'function', 'plusmedik_kb_usage', ''),
    (9, 'function', 'plusmedik_turn_record_knowledge', ''),
    (9, 'index', 'plusmedik_turn_knowledge_refs_run_idx', 'plusmedik_turn_knowledge_refs'),
    (9, 'index', 'plusmedik_turn_knowledge_refs_usage_idx', 'plusmedik_turn_knowledge_refs'),
    (9, 'table', 'plusmedik_turn_knowledge_refs', ''),
    (9, 'trigger', 'plusmedik_turn_knowledge_refs_immutable', 'plusmedik_turn_knowledge_refs'),
    (9, 'trigger', 'plusmedik_turn_knowledge_refs_no_truncate', 'plusmedik_turn_knowledge_refs'),
    (10, 'function', 'plusmedik_reply_guard_int', ''),
    (10, 'function', 'plusmedik_reply_guard_reset', ''),
    (10, 'function', 'plusmedik_reply_guard_state_guard', ''),
    (10, 'function', 'plusmedik_reply_guard_status', ''),
    (10, 'function', 'plusmedik_reply_guard_valid', ''),
    (10, 'function', 'plusmedik_turn_reserve_send_guarded', ''),
    (10, 'index', 'plusmedik_audit_runs_reply_guard_idx', 'plusmedik_audit_runs'),
    (10, 'index', 'plusmedik_reply_guard_events_contact_idx', 'plusmedik_reply_guard_events'),
    (10, 'index', 'plusmedik_reply_guard_marks_idx', 'plusmedik_reply_guard_marks'),
    (10, 'table', 'plusmedik_reply_guard_events', ''),
    (10, 'table', 'plusmedik_reply_guard_marks', ''),
    (10, 'table', 'plusmedik_reply_guard_state', ''),
    (10, 'trigger', 'plusmedik_reply_guard_events_immutable', 'plusmedik_reply_guard_events'),
    (10, 'trigger', 'plusmedik_reply_guard_events_no_truncate', 'plusmedik_reply_guard_events'),
    (10, 'trigger', 'plusmedik_reply_guard_marks_immutable', 'plusmedik_reply_guard_marks'),
    (10, 'trigger', 'plusmedik_reply_guard_marks_no_truncate', 'plusmedik_reply_guard_marks'),
    (10, 'trigger', 'plusmedik_reply_guard_state_guard', 'plusmedik_reply_guard_state'),
    (10, 'trigger', 'plusmedik_reply_guard_state_no_delete', 'plusmedik_reply_guard_state'),
    (10, 'trigger', 'plusmedik_reply_guard_state_no_truncate', 'plusmedik_reply_guard_state'),
    (11, 'function', 'plusmedik_quote_ids_of', ''),
    (11, 'function', 'plusmedik_quote_item_begin', ''),
    (11, 'function', 'plusmedik_quote_item_finish', ''),
    (11, 'function', 'plusmedik_quote_items_guard', ''),
    (11, 'function', 'plusmedik_quote_pending_before', ''),
    (11, 'function', 'plusmedik_quote_reasons_of', ''),
    (11, 'function', 'plusmedik_quote_result_valid', ''),
    (11, 'function', 'plusmedik_quote_session_close', ''),
    (11, 'function', 'plusmedik_quote_session_read', ''),
    (11, 'function', 'plusmedik_quote_sessions_guard', ''),
    (11, 'index', 'plusmedik_quote_items_contact_idx', 'plusmedik_quote_items'),
    (11, 'index', 'plusmedik_quote_items_session_idx', 'plusmedik_quote_items'),
    (11, 'index', 'plusmedik_quote_reviews_pending_idx', 'plusmedik_quote_reviews'),
    (11, 'index', 'plusmedik_quote_sessions_closed_by_idx', 'plusmedik_quote_sessions'),
    (11, 'index', 'plusmedik_quote_sessions_contact_idx', 'plusmedik_quote_sessions'),
    (11, 'index', 'plusmedik_quote_sessions_one_open_idx', 'plusmedik_quote_sessions'),
    (11, 'table', 'plusmedik_quote_items', ''),
    (11, 'table', 'plusmedik_quote_results', ''),
    (11, 'table', 'plusmedik_quote_reviews', ''),
    (11, 'table', 'plusmedik_quote_sessions', ''),
    (11, 'trigger', 'plusmedik_quote_items_guard', 'plusmedik_quote_items'),
    (11, 'trigger', 'plusmedik_quote_items_no_delete', 'plusmedik_quote_items'),
    (11, 'trigger', 'plusmedik_quote_items_no_truncate', 'plusmedik_quote_items'),
    (11, 'trigger', 'plusmedik_quote_results_immutable', 'plusmedik_quote_results'),
    (11, 'trigger', 'plusmedik_quote_results_no_truncate', 'plusmedik_quote_results'),
    (11, 'trigger', 'plusmedik_quote_reviews_immutable', 'plusmedik_quote_reviews'),
    (11, 'trigger', 'plusmedik_quote_reviews_no_truncate', 'plusmedik_quote_reviews'),
    (11, 'trigger', 'plusmedik_quote_sessions_guard', 'plusmedik_quote_sessions'),
    (11, 'trigger', 'plusmedik_quote_sessions_no_delete', 'plusmedik_quote_sessions'),
    (11, 'trigger', 'plusmedik_quote_sessions_no_truncate', 'plusmedik_quote_sessions'),
    (12, 'function', 'plusmedik_facts_usage', ''),
    (12, 'function', 'plusmedik_quote_last_studies', ''),
    (12, 'function', 'plusmedik_study_fact_approve', ''),
    (12, 'function', 'plusmedik_study_fact_assert_not_author', ''),
    (12, 'function', 'plusmedik_study_fact_create_draft', ''),
    (12, 'function', 'plusmedik_study_fact_deactivate', ''),
    (12, 'function', 'plusmedik_study_fact_edit_draft', ''),
    (12, 'function', 'plusmedik_study_fact_int', ''),
    (12, 'function', 'plusmedik_study_fact_payload_ok', ''),
    (12, 'function', 'plusmedik_study_fact_reject', ''),
    (12, 'function', 'plusmedik_study_fact_submit', ''),
    (12, 'function', 'plusmedik_study_facts_guard', ''),
    (12, 'function', 'plusmedik_study_facts_list', ''),
    (12, 'function', 'plusmedik_study_facts_snapshot', ''),
    (12, 'function', 'plusmedik_turn_record_facts', ''),
    (12, 'index', 'plusmedik_study_fact_events_fact_idx', 'plusmedik_study_fact_events'),
    (12, 'index', 'plusmedik_study_facts_one_approved_idx', 'plusmedik_study_facts'),
    (12, 'index', 'plusmedik_study_facts_one_open_idx', 'plusmedik_study_facts'),
    (12, 'index', 'plusmedik_study_facts_status_idx', 'plusmedik_study_facts'),
    (12, 'index', 'plusmedik_turn_fact_refs_run_idx', 'plusmedik_turn_fact_refs'),
    (12, 'index', 'plusmedik_turn_fact_refs_usage_idx', 'plusmedik_turn_fact_refs'),
    (12, 'table', 'plusmedik_study_fact_events', ''),
    (12, 'table', 'plusmedik_study_facts', ''),
    (12, 'table', 'plusmedik_turn_fact_refs', ''),
    (12, 'trigger', 'plusmedik_study_fact_events_immutable', 'plusmedik_study_fact_events'),
    (12, 'trigger', 'plusmedik_study_fact_events_no_truncate', 'plusmedik_study_fact_events'),
    (12, 'trigger', 'plusmedik_study_facts_guard', 'plusmedik_study_facts'),
    (12, 'trigger', 'plusmedik_study_facts_no_delete', 'plusmedik_study_facts'),
    (12, 'trigger', 'plusmedik_study_facts_no_truncate', 'plusmedik_study_facts'),
    (12, 'trigger', 'plusmedik_turn_fact_refs_immutable', 'plusmedik_turn_fact_refs'),
    (12, 'trigger', 'plusmedik_turn_fact_refs_no_truncate', 'plusmedik_turn_fact_refs'),
    (13, 'function', 'plusmedik_crm_outbox_claim', ''),
    (13, 'function', 'plusmedik_crm_outbox_enqueue', ''),
    (13, 'function', 'plusmedik_crm_outbox_guard', ''),
    (13, 'function', 'plusmedik_crm_outbox_list', ''),
    (13, 'function', 'plusmedik_crm_outbox_purge', ''),
    (13, 'function', 'plusmedik_crm_outbox_record', ''),
    (13, 'function', 'plusmedik_crm_outbox_requeue', ''),
    (13, 'function', 'plusmedik_crm_outbox_stats', ''),
    (13, 'function', 'plusmedik_crm_outbox_status', ''),
    (13, 'function', 'plusmedik_quote_review_targets', ''),
    (13, 'index', 'plusmedik_crm_outbox_attempts_idx', 'plusmedik_crm_outbox_attempts'),
    (13, 'index', 'plusmedik_crm_outbox_contact_idx', 'plusmedik_crm_outbox'),
    (13, 'index', 'plusmedik_crm_outbox_due_idx', 'plusmedik_crm_outbox'),
    (13, 'index', 'plusmedik_crm_outbox_inflight_idx', 'plusmedik_crm_outbox'),
    (13, 'index', 'plusmedik_crm_outbox_message_idx', 'plusmedik_crm_outbox'),
    (13, 'table', 'plusmedik_crm_outbox', ''),
    (13, 'table', 'plusmedik_crm_outbox_attempts', ''),
    (13, 'trigger', 'plusmedik_crm_outbox_attempts_immutable', 'plusmedik_crm_outbox_attempts'),
    (13, 'trigger', 'plusmedik_crm_outbox_attempts_no_truncate', 'plusmedik_crm_outbox_attempts'),
    (13, 'trigger', 'plusmedik_crm_outbox_guard', 'plusmedik_crm_outbox'),
    (13, 'trigger', 'plusmedik_crm_outbox_no_delete', 'plusmedik_crm_outbox'),
    (13, 'trigger', 'plusmedik_crm_outbox_no_truncate', 'plusmedik_crm_outbox'),
    (14, 'function', 'plusmedik_quote_ambiguity_state', ''),
    (15, 'constraint', 'plusmedik_attention_events_kind_crm_check', 'plusmedik_attention_events'),
    (15, 'constraint', 'plusmedik_attention_events_outcome_crm_check', 'plusmedik_attention_events'),
    (15, 'function', 'plusmedik_attention_crm_action', ''),
    (16, 'function', 'plusmedik_guard_rate_decide', ''),
    (16, 'table', 'plusmedik_guard_rate_ledger', '')
),
migration_files(mig, file) as (
  values
    (1, '20261020000000_plusmedik_persistent_audit.sql'),
    (2, '20261021000000_plusmedik_audit_telemetry.sql'),
    (3, '20261022000000_plusmedik_audit_transactional.sql'),
    (4, '20261023000000_plusmedik_audit_leases.sql'),
    (5, '20261024000000_plusmedik_human_control.sql'),
    (6, '20261025000000_plusmedik_turns.sql'),
    (7, '20261026000000_plusmedik_turn_recovery.sql'),
    (8, '20261027000000_plusmedik_knowledge.sql'),
    (9, '20261028000000_plusmedik_knowledge_refs.sql'),
    (10, '20261029000000_plusmedik_reply_guard.sql'),
    (11, '20261030000000_plusmedik_quote_sessions.sql'),
    (12, '20261031000000_plusmedik_study_facts.sql'),
    (13, '20261101000000_plusmedik_crm_outbox.sql'),
    (14, '20261102000000_plusmedik_quote_text_flow.sql'),
    (15, '20261103000000_plusmedik_crm_attention_control.sql'),
    (16, '20261104000000_plusmedik_reply_guard_atomic_rate.sql')
),
service_functions(name) as (
  values
    ('plusmedik_attention_crm_action'),
    ('plusmedik_attention_record_event'),
    ('plusmedik_attention_register_human_message'),
    ('plusmedik_attention_resume'),
    ('plusmedik_attention_status'),
    ('plusmedik_audit_block_send'),
    ('plusmedik_audit_claim_run'),
    ('plusmedik_audit_confirm_send'),
    ('plusmedik_audit_fenced_close'),
    ('plusmedik_audit_fenced_record_evidence'),
    ('plusmedik_audit_fenced_record_reply'),
    ('plusmedik_audit_record_evidence'),
    ('plusmedik_audit_record_reply'),
    ('plusmedik_audit_recover_stale'),
    ('plusmedik_audit_renew_lease'),
    ('plusmedik_audit_reserve_send'),
    ('plusmedik_crm_outbox_claim'),
    ('plusmedik_crm_outbox_enqueue'),
    ('plusmedik_crm_outbox_list'),
    ('plusmedik_crm_outbox_purge'),
    ('plusmedik_crm_outbox_record'),
    ('plusmedik_crm_outbox_requeue'),
    ('plusmedik_crm_outbox_stats'),
    ('plusmedik_crm_outbox_status'),
    ('plusmedik_facts_usage'),
    ('plusmedik_kb_approve'),
    ('plusmedik_kb_create_draft'),
    ('plusmedik_kb_deactivate'),
    ('plusmedik_kb_edit_draft'),
    ('plusmedik_kb_history'),
    ('plusmedik_kb_list'),
    ('plusmedik_kb_reject'),
    ('plusmedik_kb_restore'),
    ('plusmedik_kb_revision'),
    ('plusmedik_kb_snapshot'),
    ('plusmedik_kb_submit'),
    ('plusmedik_kb_usage'),
    ('plusmedik_quote_item_begin'),
    ('plusmedik_quote_item_finish'),
    ('plusmedik_quote_last_studies'),
    ('plusmedik_quote_review_targets'),
    ('plusmedik_quote_session_close'),
    ('plusmedik_quote_session_read'),
    ('plusmedik_reply_guard_reset'),
    ('plusmedik_reply_guard_status'),
    ('plusmedik_study_fact_approve'),
    ('plusmedik_study_fact_create_draft'),
    ('plusmedik_study_fact_deactivate'),
    ('plusmedik_study_fact_edit_draft'),
    ('plusmedik_study_fact_reject'),
    ('plusmedik_study_fact_submit'),
    ('plusmedik_study_facts_list'),
    ('plusmedik_study_facts_snapshot'),
    ('plusmedik_turn_claim'),
    ('plusmedik_turn_record_facts'),
    ('plusmedik_turn_record_knowledge'),
    ('plusmedik_turn_release'),
    ('plusmedik_turn_reserve_send'),
    ('plusmedik_turn_reserve_send_guarded')
),
-- Qué parte del manifiesto existe hoy en la base (por catálogos; no depende del registro de migraciones, que el SQL Editor no escribe).
present as (
  select m.mig, m.kind, m.name, m.parent,
    case m.kind
      when 'table' then exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = m.name and c.relkind in ('r', 'p'))
      when 'view' then exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = m.name and c.relkind = 'v')
      when 'function' then exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = m.name)
      when 'trigger' then exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname = m.parent and t.tgname = m.name)
      when 'index' then exists (select 1 from pg_indexes i where i.schemaname = 'public' and i.tablename = m.parent and i.indexname = m.name)
      when 'column' then exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || quote_ident(m.parent)) and a.attname = m.name and a.attnum > 0 and not a.attisdropped)
      when 'constraint' then exists (select 1 from pg_constraint k where k.conrelid = to_regclass('public.' || quote_ident(m.parent)) and k.conname = m.name)
    end as ok
  from manifest m
),
migration_state as (
  select p.mig, count(*) as total, count(*) filter (where p.ok) as present,
    string_agg(p.kind || ':' || p.name, ', ' order by p.kind, p.name) filter (where not p.ok) as missing,
    case when count(*) filter (where p.ok) = 0 then 'NOT_APPLIED' when count(*) filter (where p.ok) = count(*) then 'APPLIED' else 'PARTIAL' end as state
  from present p group by p.mig
),
v2_functions as (
  select p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, p.proowner, p.proacl,
    exists (select 1 from service_functions s where s.name = p.proname) as expects_service
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (select name from manifest where kind = 'function')
),
v2_tables as (
  select c.oid, c.relname, c.relkind, c.relrowsecurity, c.relacl, c.relowner
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in (select name from manifest where kind in ('table', 'view'))
),
roles as (
  select (select oid from pg_roles where rolname = 'anon') as anon, (select oid from pg_roles where rolname = 'authenticated') as authenticated, (select oid from pg_roles where rolname = 'service_role') as service
),
checks(ord, section, item, status, detail) as (
  select 10 as ord, 'MIGRACION' as section, lpad(ms.mig::text, 2, '0') || ' ' || f.file as item,
    case ms.state when 'APPLIED' then 'OK' when 'NOT_APPLIED' then 'INFO' else 'BLOCK' end as status,
    case ms.state when 'APPLIED' then format('completa (%s objetos)', ms.total) when 'NOT_APPLIED' then 'aún no aplicada' else format('PARCIAL: faltan %s', left(ms.missing, 400)) end as detail
    from migration_state ms join migration_files f on f.mig = ms.mig
  union all select 11, 'MIGRACION', 'orden', case when exists (select 1 from migration_state a join migration_state b on b.mig > a.mig where a.state = 'NOT_APPLIED' and b.state <> 'NOT_APPLIED') then 'BLOCK' else 'OK' end, 'ninguna migración existe sin las anteriores'
  -- ───────────── Seguridad de tablas y vistas ─────────────
  union all select 20, 'SEGURIDAD', 'tablas_sin_rls', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(relname, ', '), 'todas las tablas de V2 tienen RLS')
    from v2_tables where relkind in ('r', 'p') and not relrowsecurity
  union all select 21, 'SEGURIDAD', 'tablas_expuestas_a_anon_authenticated_o_public', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(distinct t.relname, ', '), 'ninguna')
    from v2_tables t cross join roles r
    where has_table_privilege(r.anon, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r.anon, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_table_privilege(r.authenticated, t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(r.authenticated, t.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
       or exists (select 1 from aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a where a.grantee = 0)
  union all select 22, 'SEGURIDAD', 'tablas_que_service_role_puede_escribir_directamente', 'INFO',
    coalesce((select string_agg(t.relname, ', ' order by t.relname) from v2_tables t cross join roles r where t.relkind in ('r', 'p') and has_table_privilege(r.service, t.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')), 'ninguna (toda escritura pasa por funciones)')
  union all select 23, 'SEGURIDAD', 'cola_al_crm_no_expone_carga_ni_arrendamiento',
    case when to_regclass('public.plusmedik_crm_outbox') is null then 'INFO'
      when not coalesce(has_table_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'SELECT'), false)
       and not coalesce(has_column_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'payload_cipher', 'SELECT'), false)
       and not coalesce(has_column_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'lease_owner', 'SELECT'), false)
       and not coalesce(has_column_privilege(r.service, to_regclass('public.plusmedik_crm_outbox'), 'lease_fence', 'SELECT'), false) then 'OK' else 'BLOCK' end,
    'service_role no debe leer payload_cipher (teléfono cifrado) ni el arrendamiento de la cola'
    from roles r
  -- ───────────── Funciones ─────────────
  union all select 30, 'FUNCIONES', 'ejecutables_por_anon_authenticated_o_public', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(distinct f.proname, ', '), 'ninguna')
    from v2_functions f cross join roles r
    where has_function_privilege(r.anon, f.oid, 'EXECUTE') or has_function_privilege(r.authenticated, f.oid, 'EXECUTE')
       or exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
  union all select 31, 'FUNCIONES', 'service_role_ejecuta_las_esperadas', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce('sin EXECUTE: ' || string_agg(distinct f.proname, ', '), 'las 59 funciones de servicio tienen EXECUTE para service_role')
    from v2_functions f cross join roles r where f.expects_service and not coalesce(has_function_privilege(r.service, f.oid, 'EXECUTE'), false)
  union all select 32, 'FUNCIONES', 'security_definer_sin_search_path_fijo', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(distinct f.proname, ', '), 'todas fijan search_path')
    from v2_functions f where f.prosecdef and not coalesce(array_to_string(f.proconfig, ',') like '%search_path=%', false)
  union all select 33, 'FUNCIONES', 'propietario_distinto_de_postgres', case when count(*) = 0 then 'OK' else 'WARN' end, coalesce(string_agg(distinct f.proname || ' (' || pg_get_userbyid(f.proowner) || ')', ', '), 'todas pertenecen a postgres')
    from v2_functions f where pg_get_userbyid(f.proowner) <> 'postgres'
  union all select 34, 'FUNCIONES', 'cuantas_funciones_de_v2', 'INFO', format('%s funciones presentes de %s esperadas', (select count(distinct proname) from v2_functions), (select count(*) from manifest where kind = 'function'))
  -- ───────────── Versión final de las funciones redefinidas (el orden importa) ─────────────
  union all select 40, 'VERSIONES', 'plusmedik_audit_claim_run_una_sola_firma_con_p_contact_key',
    case when not exists (select 1 from migration_state where mig = 5 and state = 'APPLIED') then 'INFO'
         when to_regprocedure('public.plusmedik_audit_claim_run(text,text,text,integer,integer,text,jsonb,integer,text)') is not null
          and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'plusmedik_audit_claim_run') = 1 then 'OK' else 'BLOCK' end,
    'la migración 05 elimina la firma anterior y deja una con p_contact_key (opcional); solo se exige cuando esa migración está aplicada'
  union all select 41, 'VERSIONES', f.proname || '_incluye_el_tipo_conversation',
    case when not exists (select 1 from migration_state where mig = 6 and state = 'APPLIED') then 'INFO'
         when exists (select 1 from v2_functions v where v.proname = f.proname and v.prosrc like '%conversation%') then 'OK' else 'BLOCK' end,
    'la migración 06 reemplaza esta función; si no contiene "conversation" quedó la versión anterior'
    from (values ('plusmedik_audit_reserve_send'), ('plusmedik_audit_record_reply')) as f(proname)
  -- ───────────── Disparadores, restricciones y datos ─────────────
  union all select 50, 'INTEGRIDAD', 'disparadores_no_habilitados', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(t.tgname || '@' || c.relname, ', '), 'todos habilitados (la inmutabilidad depende de ellos)')
    from manifest m join pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = m.parent join pg_trigger t on t.tgrelid = c.oid and t.tgname = m.name and not t.tgisinternal
    where m.kind = 'trigger' and t.tgenabled <> 'O'
  union all select 51, 'INTEGRIDAD', 'restricciones_sin_validar', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(k.conname, ', '), 'todas validadas')
    from pg_constraint k where k.connamespace = 'public'::regnamespace and k.conname in (select name from manifest where kind = 'constraint') and not k.convalidated
  union all select 52, 'INTEGRIDAD', 'filas_en_tablas_de_v2', 'INFO', coalesce(string_agg(name || '=' || n, ', ' order by name), 'ninguna tabla')
    from (select m.name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', m.name), false, true, '')))[1]::text::bigint as n from manifest m where m.kind = 'table' and to_regclass('public.' || quote_ident(m.name)) is not null) t
  union all select 53, 'INTEGRIDAD', 'objetos_de_v2_en_el_esquema_crm', case when count(*) = 0 then 'OK' else 'BLOCK' end, coalesce(string_agg(u.o, ', '), 'ninguno')
    from (select c.relname as o from pg_class c where c.relnamespace = to_regnamespace('crm') and c.relname like 'plusmedik%'
          union all select p.proname from pg_proc p where p.pronamespace = to_regnamespace('crm') and p.proname like 'plusmedik%') u
  union all
  select 900 as ord, 'INSTANTANEA' as section, 'lab_tests.columnas' as item, 'INFO' as status,
    coalesce((select md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)) from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attnum > 0 and not a.attisdropped), 'tabla ausente') as detail
  union all select 901, 'INSTANTANEA', 'lab_tests.filas', 'INFO',
    coalesce((select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', 'lab_tests'), false, true, '')))[1]::text::bigint::text where to_regclass('public.lab_tests') is not null), 'tabla ausente')
  union all select 902, 'INSTANTANEA', 'lab_test_aliases.filas', 'INFO',
    coalesce((select (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', 'lab_test_aliases'), false, true, '')))[1]::text::bigint::text where to_regclass('public.lab_test_aliases') is not null), 'tabla ausente')
  union all select 903, 'INSTANTANEA', 'lab_tests.politicas_y_triggers', 'INFO',
    coalesce((select md5(coalesce((select string_agg(polname, ',' order by polname) from pg_policy where polrelid = to_regclass('public.lab_tests')), '') || '|' || coalesce((select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid = to_regclass('public.lab_tests') and not tgisinternal), '')) where to_regclass('public.lab_tests') is not null), 'tabla ausente')
  union all select 904, 'INSTANTANEA', 'lab_tests.privilegios_service_role', 'INFO',
    coalesce((select md5(string_agg(a.attname, ',' order by a.attname)) from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attnum > 0 and not a.attisdropped and has_column_privilege((select oid from pg_roles where rolname = 'service_role'), a.attrelid, a.attname, 'SELECT')), 'sin columnas legibles')
  union all select 910, 'INSTANTANEA', 'crm.objetos', 'INFO',
    coalesce((select format('tablas=%s funciones=%s', (select count(*) from pg_class c where c.relnamespace = to_regnamespace('crm') and c.relkind in ('r', 'p')), (select count(*) from pg_proc p where p.pronamespace = to_regnamespace('crm'))) where to_regnamespace('crm') is not null), 'esquema crm ausente')
  union all select 911, 'INSTANTANEA', 'crm.funciones_md5', 'INFO',
    coalesce((select md5(coalesce(string_agg(pg_get_functiondef(p.oid), E'\n' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = to_regnamespace('crm') and p.prokind in ('f', 'p')), 'esquema crm ausente')
  union all select 912, 'INSTANTANEA', 'crm.filas_conversaciones_y_casos', 'INFO',
    coalesce((select format('messages=%s review_cases=%s', (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from crm.messages', '__none__'), false, true, '')))[1]::text::bigint, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from crm.review_cases', '__none__'), false, true, '')))[1]::text::bigint) where to_regclass('crm.messages') is not null and to_regclass('crm.review_cases') is not null), 'tablas del crm ausentes')
)
select ord, section, item, status, detail from (
  select 0 as ord, 'VEREDICTO' as section, 'resumen' as item,
    case when count(*) filter (where status = 'BLOCK') > 0 then 'BLOCK' when count(*) filter (where status = 'WARN') > 0 then 'WARN' else 'OK' end as status,
    format('BLOCK=%s WARN=%s OK=%s INFO=%s', count(*) filter (where status = 'BLOCK'), count(*) filter (where status = 'WARN'), count(*) filter (where status = 'OK'), count(*) filter (where status = 'INFO')) as detail
  from checks
  union all select ord, section, item, status, detail from checks
) result
order by ord, section, item;
