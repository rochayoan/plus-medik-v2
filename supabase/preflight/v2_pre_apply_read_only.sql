-- PlusMedik V2 — verificación ANTES de aplicar las 21 migraciones (solo lectura)
-- GENERADO por scripts/migration-manifest.ts a partir de supabase/migrations/*.sql. NO editar a mano (una prueba falla si no coincide).
-- SOLO LECTURA: una sola sentencia SELECT. No contiene DDL, DML, RPC ni datos clínicos; devuelve metadatos y conteos.
-- Ejecutar exclusivamente en el proyecto Supabase cvokrtrdzxfchntwwslz (verificar el identificador en la URL del panel ANTES de ejecutar),
-- con el rol administrativo del SQL Editor. Es seguro ejecutarla dentro de una transacción de solo lectura.
-- Esperado: VEREDICTO = OK, las migraciones existentes como YA APLICADA y las restantes como pendientes; ninguna fila BLOCK.
-- Si alguna migración aparece APPLIED (INFO), ya se aplicó: no repetirla sin entender por qué. PARTIAL o un hueco de orden = BLOCK.
-- Guardar las filas INSTANTANEA: se comparan con la verificación posterior (el catálogo y el esquema crm no deben cambiar).
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
--   17  20261105000000_plusmedik_conversation_memory.sql  dc498daf5ef825b9be84ae81fa643fadcc9a71346146b24efd1340ef63bb716f
--   18  20261106000000_plusmedik_daily_reply_cap.sql  c16ed9d3088c055169e62f7a75cce78f25855d44ddba57a9a77128387b9cc606
--   19  20261107000000_plusmedik_batch_fold.sql  c64848610b18f85e0b0a388adb0263379478af5aba86b66c2ea62ef87814e25a
--   20  20261108000000_plusmedik_quote_shadow_peek.sql  82d45e295d56a8580b882b5bfd94a2741b1961a315af4b7bf1e23b2beeecfe9f
--   21  20261109000000_plusmedik_message_history.sql  00c79db4d432b9c1b799b6d726e48ab3e8fcec8f4007af22be97c707d3731547
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
    (16, 'table', 'plusmedik_guard_rate_ledger', ''),
    (17, 'function', 'plusmedik_memory_forget', ''),
    (17, 'function', 'plusmedik_memory_recent', ''),
    (17, 'function', 'plusmedik_memory_record', ''),
    (17, 'index', 'plusmedik_conversation_messages_expiry_idx', 'plusmedik_conversation_messages'),
    (17, 'index', 'plusmedik_conversation_messages_recent_idx', 'plusmedik_conversation_messages'),
    (17, 'table', 'plusmedik_conversation_messages', ''),
    (18, 'function', 'plusmedik_turn_reserve_send_capped', ''),
    (19, 'function', 'plusmedik_turn_fold', ''),
    (20, 'function', 'plusmedik_quote_shadow_peek', ''),
    (21, 'function', 'plusmedik_history_attach_text', ''),
    (21, 'function', 'plusmedik_history_delivery', ''),
    (21, 'function', 'plusmedik_history_erase', ''),
    (21, 'function', 'plusmedik_history_export', ''),
    (21, 'function', 'plusmedik_history_gaps', ''),
    (21, 'function', 'plusmedik_history_purge', ''),
    (21, 'function', 'plusmedik_history_rank', ''),
    (21, 'function', 'plusmedik_history_record', ''),
    (21, 'index', 'plusmedik_message_history_access_at_idx', 'plusmedik_message_history_access'),
    (21, 'index', 'plusmedik_message_history_contact_idx', 'plusmedik_message_history'),
    (21, 'index', 'plusmedik_message_history_expiry_idx', 'plusmedik_message_history'),
    (21, 'index', 'plusmedik_message_history_time_idx', 'plusmedik_message_history'),
    (21, 'table', 'plusmedik_message_history', ''),
    (21, 'table', 'plusmedik_message_history_access', '')
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
    (16, '20261104000000_plusmedik_reply_guard_atomic_rate.sql'),
    (17, '20261105000000_plusmedik_conversation_memory.sql'),
    (18, '20261106000000_plusmedik_daily_reply_cap.sql'),
    (19, '20261107000000_plusmedik_batch_fold.sql'),
    (20, '20261108000000_plusmedik_quote_shadow_peek.sql'),
    (21, '20261109000000_plusmedik_message_history.sql')
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
    ('plusmedik_history_attach_text'),
    ('plusmedik_history_delivery'),
    ('plusmedik_history_erase'),
    ('plusmedik_history_export'),
    ('plusmedik_history_gaps'),
    ('plusmedik_history_purge'),
    ('plusmedik_history_record'),
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
    ('plusmedik_memory_forget'),
    ('plusmedik_memory_recent'),
    ('plusmedik_memory_record'),
    ('plusmedik_quote_item_begin'),
    ('plusmedik_quote_item_finish'),
    ('plusmedik_quote_last_studies'),
    ('plusmedik_quote_review_targets'),
    ('plusmedik_quote_session_close'),
    ('plusmedik_quote_session_read'),
    ('plusmedik_quote_shadow_peek'),
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
    ('plusmedik_turn_fold'),
    ('plusmedik_turn_record_facts'),
    ('plusmedik_turn_record_knowledge'),
    ('plusmedik_turn_release'),
    ('plusmedik_turn_reserve_send'),
    ('plusmedik_turn_reserve_send_capped'),
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
checks(ord, section, item, status, detail) as (
  -- ───────────── Entorno ─────────────
  select 10 as ord, 'ENTORNO' as section, 'version_de_postgres' as item,
    case when current_setting('server_version_num')::int >= 140000 then 'OK' else 'BLOCK' end as status,
    'se exige 14 o más (create or replace trigger). ' || version() as detail
  union all select 11, 'ENTORNO', 'sesion', 'INFO',
    format('base=%s usuario=%s superusuario=%s transaccion_solo_lectura=%s', current_database(), current_user, current_setting('is_superuser'), current_setting('transaction_read_only'))
  union all select 12, 'ENTORNO', 'gen_random_uuid', case when exists (select 1 from pg_proc p where p.proname = 'gen_random_uuid') then 'OK' else 'BLOCK' end, 'las tablas usan default gen_random_uuid()'
  union all select 13, 'ENTORNO', 'disparadores_de_evento', 'INFO',
    coalesce((select string_agg(evtname || ' (' || evtevent || ')', ', ' order by evtname) from pg_event_trigger), 'ninguno') || ' — los de Supabase (PostgREST, GraphQL) son normales'
  union all select 14, 'ENTORNO', 'usuario_administrativo', case when current_user in ('postgres', 'supabase_admin') or current_setting('is_superuser') = 'on' then 'OK' else 'WARN' end,
    'las funciones SECURITY DEFINER quedan a nombre de quien ejecuta la migración; debe ser postgres'
  -- ───────────── Roles ─────────────
  union all select 20, 'ROLES', r, case when exists (select 1 from pg_roles where rolname = r) then 'OK' else 'BLOCK' end, 'rol exigido por las migraciones (REVOKE/GRANT)'
    from unnest(array['anon', 'authenticated', 'service_role']) as r
  union all select 21, 'ROLES', 'crm_app', 'INFO', case when exists (select 1 from pg_roles where rolname = 'crm_app') then 'existe (rol del CRM; V2 no lo usa)' else 'no existe' end
  -- ───────────── Catálogo del laboratorio (solo lectura para V2) ─────────────
  union all select 30, 'CATALOGO', 'lab_tests', case when to_regclass('public.lab_tests') is not null then 'OK' else 'BLOCK' end, 'las migraciones 08 y 12 lo consultan dentro de sus funciones (con comprobación de existencia)'
  union all select 31, 'CATALOGO', 'lab_tests.' || c.col || ' (' || c.typ || ')',
    case when exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attname = c.col and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = c.typ) then 'OK' else 'BLOCK' end,
    'columna usada por las funciones de conocimiento y de datos por estudio'
    from (values ('id', 'uuid'), ('active', 'boolean')) as c(col, typ)
  union all select 32, 'CATALOGO', 'lab_tests.' || c.col,
    case when exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attname = c.col and not a.attisdropped) then 'OK' else 'WARN' end,
    'columna que lee el cargador de catálogo de V2 (src/supabase-catalog.ts)'
    from unnest(array['code', 'name', 'normalized_name', 'price_bs', 'category', 'sample_type']) as c(col)
  union all select 33, 'CATALOGO', 'service_role puede leer lab_tests.' || c.col,
    case when not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.lab_tests') and a.attname = c.col and not a.attisdropped) then 'WARN'
         when coalesce(has_column_privilege((select oid from pg_roles where rolname = 'service_role'), to_regclass('public.lab_tests'), c.col, 'SELECT'), false) then 'OK' else 'WARN' end,
    'V2 lee el catálogo con la clave de servicio; la migración 202610230009 del CRM solo concede ESTAS columnas por separado: si falta una, el cargador de V2 falla'
    from unnest(array['id', 'code', 'name', 'normalized_name', 'price_bs', 'active', 'category', 'sample_type']) as c(col)
  union all select 34, 'CATALOGO', 'lab_test_aliases', case when to_regclass('public.lab_test_aliases') is not null then 'OK' else 'WARN' end, 'columnas lab_test_id y normalized_alias (las lee el cargador de catálogo)'
  union all select 35, 'CATALOGO', 'rls_lab_tests', 'INFO', coalesce((select case when relrowsecurity then 'RLS activo (el CRM añadió políticas para crm_app); las funciones de V2 son SECURITY DEFINER' else 'RLS inactivo' end from pg_class where oid = to_regclass('public.lab_tests')), 'tabla ausente')
  -- ───────────── Colisiones con objetos existentes ─────────────
  union all select 40, 'COLISIONES', 'relacion_de_otro_tipo', case when count(*) = 0 then 'OK' else 'BLOCK' end,
    coalesce('mismo nombre pero otro tipo: ' || string_agg(c.relname || ' (' || c.relkind::text || ')', ', '), 'ninguna')
    from manifest m join pg_class c on c.relnamespace = 'public'::regnamespace and c.relname = m.name
    where (m.kind = 'table' and c.relkind not in ('r', 'p')) or (m.kind = 'view' and c.relkind <> 'v')
  union all select 41, 'COLISIONES', 'restriccion_o_indice_en_otra_tabla', case when count(*) = 0 then 'OK' else 'BLOCK' end,
    coalesce('el nombre ya existe en otra tabla (el guard "if not exists" lo omitiría en silencio): ' || string_agg(x.name, ', '), 'ninguna')
    from (
      select m.name from manifest m join pg_constraint k on k.conname = m.name where m.kind = 'constraint' and k.conrelid is distinct from to_regclass('public.' || quote_ident(m.parent))
      union all select m.name from manifest m join pg_indexes i on i.schemaname = 'public' and i.indexname = m.name where m.kind = 'index' and i.tablename <> m.parent
    ) x
  union all select 42, 'COLISIONES', 'objetos_plusmedik_no_listados', case when count(*) = 0 then 'OK' else 'WARN' end,
    coalesce('existen objetos plusmedik_* que ninguna migración crea: ' || string_agg(u.o, ', '), 'ninguno')
    from (
      select 'relacion:' || c.relname as o from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'plusmedik\_%' and c.relkind in ('r', 'p', 'v', 'S') and c.relname not in (select name from manifest where kind in ('table', 'view'))
      union all select 'funcion:' || p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'plusmedik\_%' and p.proname not in (select name from manifest where kind = 'function')
    ) u
  union all select 43, 'COLISIONES', 'objetos_plusmedik_en_crm', case when count(*) = 0 then 'OK' else 'BLOCK' end,
    coalesce('V2 no debe tener nada en el esquema crm: ' || string_agg(u.o, ', '), 'ninguno (V2 solo escribe en public)')
    from (
      select c.relname as o from pg_class c where c.relnamespace = to_regnamespace('crm') and c.relname like 'plusmedik%'
      union all select p.proname from pg_proc p where p.pronamespace = to_regnamespace('crm') and p.proname like 'plusmedik%'
    ) u
  union all select 44, 'COLISIONES', 'funciones_sobrecargadas', 'INFO',
    coalesce((select string_agg(p.proname || ' x' || n, ', ' order by p.proname) from (select proname, count(*) as n from pg_proc where pronamespace = 'public'::regnamespace and proname in (select name from manifest where kind = 'function') group by proname having count(*) > 1) p), 'ninguna con más de una firma')
  -- ───────────── Estado de cada migración (por objetos; el SQL Editor no escribe el registro de migraciones) ─────────────

  union all select 50 + ms.mig, 'MIGRACION', lpad(ms.mig::text, 2, '0') || ' ' || f.file,
    case ms.state
      when 'NOT_APPLIED' then case when exists (select 1 from migration_state l where l.mig > ms.mig and l.state <> 'NOT_APPLIED') then 'BLOCK' else 'OK' end
      when 'APPLIED' then 'INFO'
      else 'BLOCK' end,
    case ms.state
      when 'NOT_APPLIED' then case when exists (select 1 from migration_state l where l.mig > ms.mig and l.state <> 'NOT_APPLIED') then 'HUECO DE ORDEN: una migración posterior ya existe sin esta' else format('pendiente (0 de %s objetos)', ms.total) end
      when 'APPLIED' then format('YA APLICADA (%s de %s objetos)', ms.present, ms.total)
      else format('PARCIAL: %s de %s objetos; faltan: %s', ms.present, ms.total, left(ms.missing, 400)) end
    from migration_state ms join migration_files f on f.mig = ms.mig
  union all select 80, 'DATOS', 'filas_en_tablas_ya_existentes', case when coalesce(sum(n), 0) = 0 then 'OK' else 'WARN' end,
    coalesce(string_agg(name || '=' || n, ', ' order by name), 'ninguna tabla de V2 existe todavía')
    from (select m.name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', m.name), false, true, '')))[1]::text::bigint as n from manifest m where m.kind = 'table' and to_regclass('public.' || quote_ident(m.name)) is not null) t
  union all select 81, 'DATOS', 'plusmedik_audit_runs_con_filas_y_migraciones_2_a_6_pendientes', 'WARN',
    'las migraciones 02-06 agregan restricciones CHECK a plusmedik_audit_runs: con filas previas se validan contra ellas y pueden fallar (ver docs/g5/20)'
    where exists (select 1 from migration_state where mig between 2 and 6 and state = 'NOT_APPLIED')
      and case when to_regclass('public.plusmedik_audit_runs') is null then false else ((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', 'plusmedik_audit_runs'), false, true, '')))[1]::text::bigint) > 0 end
  union all select 82, 'ACTIVIDAD', 'transacciones_largas', case when count(*) = 0 then 'OK' else 'WARN' end,
    coalesce('abiertas hace más de 5 min: ' || string_agg(format('pid=%s estado=%s', pid, state), '; '), 'ninguna (las migraciones toman bloqueos breves sobre plusmedik_audit_runs)')
    from pg_stat_activity where pid <> pg_backend_pid() and datname = current_database() and xact_start < now() - interval '5 minutes'
  union all select 83, 'PRIVILEGIOS', 'privilegios_por_defecto_en_public', 'INFO',
    coalesce((select string_agg(format('%s/%s=%s', r.rolname, d.defaclobjtype, d.defaclacl::text), '; ') from pg_default_acl d join pg_roles r on r.oid = d.defaclrole where d.defaclnamespace = 'public'::regnamespace), 'sin entradas (Supabase suele conceder a anon/authenticated/service_role; cada migración lo revoca objeto por objeto)')
  union all select 60, 'REGISTRO', 'supabase_migrations.schema_migrations', 'INFO',
    case when to_regclass('supabase_migrations.schema_migrations') is null then 'no existe: las migraciones se aplican a mano y no quedan registradas'
      else format('versiones >= 20261020000000: %s; ¿existe la 20261025000000?: %s',
        (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations where version >= ''20261020000000''', false, true, '')))[1]::text,
        (xpath('/row/c/text()', query_to_xml('select count(*) as c from supabase_migrations.schema_migrations where version = ''20261025000000''', false, true, '')))[1]::text) end
  union all select 61, 'REGISTRO', 'version_20261025000000_duplicada', 'INFO',
    'AVISO FIJO: V2 (20261025000000_plusmedik_turns) y el CRM (20261025000000_crm_fix_patient_note_and_follow_up_rpcs) comparten el número de versión: NO usar "supabase db push" desde ninguno de los dos repositorios sobre este proyecto'
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
