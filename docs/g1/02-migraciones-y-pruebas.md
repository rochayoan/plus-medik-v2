# G1 · 02 Migraciones pendientes y resultado de las pruebas

Ninguna migración se aplicó ni se ejecutó SQL contra Supabase. Las pruebas usaron un PostgreSQL **efímero local** (clúster temporal en 127.0.0.1, destruido al terminar).

## 1. Resultado de las pruebas offline (tarea 6)

| Dato | Valor |
| --- | --- |
| Árbol probado | `integration/g1-consolidacion` = `origin/main` (`dfa98da`), instalación limpia con `npm ci` (121 paquetes) |
| Entorno | Windows 10, Node 24.15, PostgreSQL 18 (autodetectado en `C:\Program Files\PostgreSQL\18`), sin `.env`, `PLUSMEDIK_OFFLINE=1`, red bloqueada por `vitest.config.ts` |
| `tsc --noEmit` | sin errores |
| `vitest run` | **52 archivos, 1347 pruebas, todas en verde** (54,6 s) |
| Pruebas omitidas | 0 (las de base de datos corrieron de verdad; no hubo aviso de PostgreSQL ausente) |
| Procesos residuales | ningún `postgres` quedó activo |
| Gasto / red | cero llamadas a modelos, a Kapso o a Supabase |

Comparación con el checkout anterior (rama `feat/kapso-pilot`): 40 archivos / 942 pruebas. Las 405 pruebas adicionales son las de auditoría, leases y pausa humana (más ajustes).

Suites de la infraestructura reutilizable (todas verdes):

| Suite | Pruebas | Qué cubre |
| --- | --- | --- |
| `audit.test.ts`, `audit-telemetry.test.ts`, `audit-transactional.test.ts` | 10 · 52 · 24 | Serialización de evidencia, telemetría de IA, atomicidad e idempotencia por hash de contenido |
| `audit-lease.test.ts` | 37 | Claim, duplicados, fencing, reserva/confirmación de envío, política sin base |
| `audit-db.test.ts` | 57 | Migraciones 1-3 desde cero contra PostgreSQL real, privilegios, triggers de inmutabilidad |
| `audit-lease-db.test.ts` | 38 | Migración 4: claim/lease concurrente, fencing, reserva única, recuperación con `SKIP LOCKED`, compatibilidad con filas anteriores |
| `human-control.test.ts`, `human-control-db.test.ts` | 59 · 31 | Clasificación de eventos de Kapso, estados `ACTIVE`/`HUMAN_PAUSED`, carreras, privilegios |
| `human-control-e2e.test.ts`, `audit-recovery-e2e.test.ts` | 24 · 21 | Webhook real + repositorios reales + PostgreSQL real (Kapso y el motor simulados) |

Lo que estas pruebas **no** demuestran (hay que verificarlo en staging o en el piloto):

1. **PostgREST real.** Las pruebas traducen las RPC a SQL con un adaptador (`postgrest-over-psql`). La conversión de `errcode 'PT410'/'PT409'/'PT422'` en estados HTTP 410/409/422 es una característica de PostgREST que aquí está simulada.
2. **Versión de PostgreSQL de Supabase.** Se probó en PG 18; las migraciones usan `create or replace trigger` (PG ≥ 14). Hay que confirmar la versión del proyecto.
3. **Formato real de los eventos de Kapso.** Los eventos de las pruebas siguen la documentación; no hay capturas reales de un eco de `business_app`.
4. **Entorno serverless real** (vida de `waitUntil`, varias instancias concurrentes, latencia hacia Supabase).
5. **Que los eventos salientes lleguen al webhook del agente** (ver [03](03-atencion-humana-crm.md)).

## 2. Inventario de las cinco migraciones (tarea 5)

Todas viven en `supabase/migrations/`, **no modifican `lab_tests`, `lab_test_aliases` ni el esquema `crm`** (búsqueda de esos nombres: sin coincidencias) y todos sus objetos llevan el prefijo `plusmedik_`. Son acumulativas y deben aplicarse en este orden:

| # | Archivo | Líneas | Crea / cambia | Depende de | Notas de riesgo |
| --- | --- | --- | --- | --- | --- |
| 1 | `20261020000000_plusmedik_persistent_audit` | 82 | Tablas `plusmedik_audit_runs`, `_studies`, `_model_calls`, `_checks`; índices; RLS activado; `service_role` con permisos completos (provisional, lo restringe la 3) | — | `create table if not exists`: repetible. Columnas `detail_expires_at` (30 d) y `metrics_expires_at` (180 d): **no hay purga** |
| 2 | `20261021000000_plusmedik_audit_telemetry` | 76 | Columnas de telemetría (engine/config/catalog hash, secuencia de llamadas, duración, `error_kind`) y restricciones | 1 | Aditiva, todas las columnas nulas; restricciones guardadas con `if not exists` |
| 3 | `20261022000000_plusmedik_audit_transactional` | 494 | Funciones de validación en lista blanca; RPC `plusmedik_audit_record_evidence` y `record_reply` (`SECURITY DEFINER`, `search_path=''`); triggers de inmutabilidad; **revoca** INSERT/UPDATE/DELETE/TRUNCATE a `service_role` y concede solo INSERT/UPDATE por columnas en `runs` | 1, 2 | Cambia los privilegios del rol que usa la API: cualquier otro escritor directo de esas tablas dejaría de funcionar (no existe ninguno en este repositorio) |
| 4 | `20261023000000_plusmedik_audit_leases` | 568 | Columnas de lease/envío en `runs`; `claim_run`, `renew_lease`, `fenced_record_evidence`, `fenced_close`, `reserve_send`, `fenced_record_reply`, `recover_stale`, `block_send`; vista `plusmedik_audit_run_phase`; redefine `runs_guard` | 1-3 | Introduce la reserva de envío (corazón de "un solo envío"). Las filas anteriores a esta migración quedan como `LEGACY_IN_PROGRESS` y nunca se reabren |
| 5 | `20261024000000_plusmedik_human_control` | 503 | Columna `runs.contact_key`; tablas `plusmedik_attention_contacts` y `_events` (inmutables); `status`, `register_human_message`, `record_event`, `resume`, `confirm_send`; redefine `claim_run`, `reserve_send`, `runs_guard` | 1-4 | **Única sentencia destructiva:** `drop function if exists plusmedik_audit_claim_run(<firma de la migración 4>)`, seguida de la nueva con `p_contact_key` opcional (los llamadores sin control humano siguen funcionando) |

Resumen de objetos: 6 tablas, 1 vista, ~30 definiciones de función (algunas redefinidas; todas con `revoke … from public, anon, authenticated` y `grant execute … to service_role`), triggers anti-UPDATE/DELETE/TRUNCATE. Ninguna sentencia borra ni modifica datos existentes.

### Hallazgos de la revisión

| # | Hallazgo | Impacto | Acción propuesta |
| --- | --- | --- | --- |
| M1 | Redefiniciones acumulativas (`runs_guard` ×3, `claim_run` ×2, `reserve_send` ×2): aplicar solo algunas deja un estado intermedio | Un estado intermedio funciona como "sin auditoría" pero puede rechazar llamadas (p. ej. `p_contact_key` con solo la migración 4 aplicada) | Aplicar siempre las cinco, en orden, cada una en su propia transacción; nunca activar banderas hasta completar las cinco |
| M2 | Sin scripts de reversa (down) | Revertir = migración nueva que elimine objetos; se perdería solo la auditoría | Plan de reversa por **banderas**: apagar `REQUIRE_AUDIT_GUARD`/control humano devuelve el comportamiento previo mientras el código lo tolera |
| M3 | Triggers que bloquean DELETE/TRUNCATE (incluso al dueño) y **no existe purga** pese a las columnas de caducidad | La retención de 30/180 días y cualquier pedido de borrado no se pueden cumplir sin una migración que desactive los triggers de forma controlada | Migración de retención propia (diferida a G7), con vista previa en `supabase/queries/plusmedik_audit_retention_preview.sql` |
| M4 | La migración 5 trae un `kind` cerrado en `plusmedik_attention_events` (`HUMAN_BUSINESS_APP`, `UNKNOWN_ORIGIN`, `OTHER_APP_OUTBOUND`, `META_AGENT_OUTBOUND`, `PATIENT_SUPPRESSED`, `MANUAL_RESUME`) | La **pausa manual del CRM** y la detección de "saliente ajeno" no caben sin ampliar la restricción | Migración nueva en G2/G5 (no modificar la 5) |
| M5 | Versión de PostgreSQL y estados HTTP de PostgREST sin verificar (ver §1) | Un fallo de mapeo cambiaría la política de errores del cliente (`REJECTED` en lugar de `LEASE_LOST`) | Verificación explícita en staging con llamadas reales a las RPC |
| M6 | La base es compartida con el CRM (esquema `crm`, rol `crm_app`) y con el catálogo | Sin colisión de nombres; las funciones de `public` quedan expuestas por PostgREST pero revocadas a `anon`/`authenticated` (probado) | En staging, comprobar que `crm_app` no recibe ningún permiso nuevo (el CRM lo exige en `SUPABASE_APPLY_ORDER.md`) |
| M7 | Rendimiento: bloqueos de fila por mensaje, índices de lease | Irrelevante a escala del piloto | Revisar con carga en G7 |
| M8 | `recover_stale` está implementada pero la ruta `api/audit/recover.ts` está **inerte** (sin `CRON_SECRET` ni cron) | Las corridas interrumpidas no se concilian solas | Decisión del plan/planificador (decisión 7 de G0) |

**Veredicto de las migraciones:** técnicamente coherentes, probadas contra PostgreSQL real, aditivas y sin tocar datos ni objetos ajenos. Riesgo principal: **operativo** (orden y banderas), no de diseño. No hay impedimento técnico para aplicarlas en un entorno de ensayo.

## 3. Procedimiento recomendado de aplicación (para que lo autorice el dueño; no se ejecutó)

1. **Staging primero**: un branch/proyecto de Supabase de ensayo con el catálogo copiado o simulado. Confirmar versión de PostgreSQL.
2. Aplicar 1→5 en orden. Verificar sin escribir datos de pacientes: existencia de objetos, `has_function_privilege('anon', …)` = falso para todas, RLS activo, y que `crm_app` (si existe en staging) no ganó permisos.
3. Llamar las RPC reales por HTTP con datos sintéticos (claim → evidencia → reserva → confirmación → resultado; claim duplicado; fencing con otro propietario) para validar el mapeo PT4xx→HTTP.
4. Repetir en producción solo con autorización explícita, fuera del horario de atención, con `ALLOWED_PHONES` acotado.
5. **Después** (nunca antes): `REQUIRE_AUDIT_GUARD=on`; luego `PLUSMEDIK_CONTACT_HMAC_KEY` (≥ 32 caracteres, clave nueva) y `PLUSMEDIK_HUMAN_CONTROL=on`, primero para números de prueba.
6. Verificar con el número piloto: una respuesta normal, un reenvío duplicado, una pausa y una reactivación reales.
7. Programar la recuperación (`CRON_SECRET` + cron) cuando se decida el planificador.

## 4. Riesgos técnicos globales (resumen)

| Riesgo | Severidad | Mitigación |
| --- | --- | --- |
| Producción sin deduplicación/lease/pausa mientras no se apliquen las migraciones | Alta | Aplicar (staging → producción) y confirmar despliegue |
| Activar banderas antes de las migraciones silencia al bot | Alta | Orden estricto documentado arriba |
| Mensajes enviados desde el CRM no pausan la IA | Alta (cuando el CRM habilite el envío) | [03](03-atencion-humana-crm.md) |
| Webhook de Kapso registrado solo para "mensajes entrantes" (README) → la pausa humana no recibiría los salientes | Alta para el control humano | Verificar la suscripción de eventos en Kapso antes de activar |
| Sin purga de datos de auditoría | Media | Migración de retención (G7) |
| Ejecución interrumpida deja filas en `PROCESSING` hasta que alguien las reclame | Media | Recuperación periódica |
| Resultado de envío incierto jamás se reenvía (decisión de diseño) | Aceptada | Conciliación manual en Kapso (`SEND_UNKNOWN`) |
| Cambios locales sin commit en `plus-medik-v2` | Baja (ya redundantes, respaldados) | Archivar tras confirmar |
