# G5.1 · Preparación para aplicar las 15 migraciones SQL (procedimiento manual)

Fecha: 2026-10-25. **No se ejecutó SQL remoto, no se modificó ningún dato, no se activó ninguna bandera, no hubo commit, push ni despliegue.** Todo lo de este documento se verificó contra archivos locales y contra un PostgreSQL 18 efímero. La cuenta de Supabase conectada a esta sesión **no tiene permiso sobre el proyecto** (la consulta de metadatos del proyecto devolvió «no tienes permiso»), de modo que ni siquiera una lectura remota fue posible: lo que está **aplicado hoy** solo lo puede decir la verificación previa de §5, ejecutada por una persona.

Entregables nuevos (todos locales): `supabase/preflight/v2_pre_apply_read_only.sql`, `supabase/preflight/v2_post_apply_read_only.sql` (generados), `scripts/migration-manifest.ts` (generador y manifiesto), `tests/migration-preflight-db.test.ts` (19 pruebas, incluida la ejecución real de ambos SQL).

## 1. Project ID configurado (sin mostrar credenciales)

| Dónde | Resultado |
| --- | --- |
| `.env` de V2 (worktree principal `plus-medik-v2`), variable `SUPABASE_URL` | proyecto **`cvokrtrdzxfchntwwslz`** |
| `.env` y `.env.local` del CRM (`CRM-PLUSMEDIK`), `SUPABASE_URL` | el **mismo** `cvokrtrdzxfchntwwslz` |
| Documentación del CRM (`supabase/preflight/*`) | «Ejecutar exclusivamente en el proyecto Supabase cvokrtrdzxfchntwwslz» |
| Worktree `plus-medik-v2-g2` | no tiene `.env` ni `.vercel/` ni `supabase/config.toml`: el identificador no está versionado aquí |

Conclusión: **V2 y el CRM comparten un único proyecto Supabase** (base `public` del agente + esquema `crm`). Solo se leyeron los *nombres* de las variables y el identificador del proyecto (que es parte de la URL, no un secreto); no se imprimió ninguna clave.
**No verificado** (requiere una persona): que el proyecto de producción en Vercel use ese mismo identificador, y que el panel de Supabase muestre ese identificador en su URL al momento de ejecutar.

## 2. Qué está aplicado y qué falta

Evidencia disponible en el repositorio y la documentación (ninguna prueba remota):
- Migraciones 01-05 existen en `origin/main` (`dfa98da`); la auditoría de G1 documentó que **no se aplicaron** y que con las migraciones sin aplicar el piloto responde igual (la auditoría rechaza el *claim* y se responde de todos modos).
- Migraciones 06-14 existen **solo** en este worktree, **sin commit**; nunca se enviaron a ningún lado.
- Del lado del CRM, su documento `SUPABASE_APPLY_ORDER.md` confirma que **sus** migraciones 1-12 se aplicaron a mano en el SQL Editor (salvo la última, pendiente); nada de eso incluye objetos `plusmedik_*`.

⇒ Lo esperado es **las 15 pendientes**. Pero «esperado» no es «verificado»: la verificación previa (§5) clasifica cada migración como pendiente (`NOT_APPLIED`), aplicada (`APPLIED`) o parcial (`PARTIAL`, bloqueo) mirando los catálogos de PostgreSQL, **no** el registro `supabase_migrations` (el SQL Editor no escribe en él, así que no sirve como prueba).

## 3. Orden obligatorio, dependencias y contenido

Orden = orden de nombre de archivo (el prefijo numérico es la versión). Dependencias calculadas del texto de las migraciones: ninguna usa un objeto creado por una migración **posterior**, y ningún objeto referenciado queda sin crear (comprobado por script).

| # | Archivo | Líneas | Tablas | Vistas | Funciones | Triggers | Índices | Cols+Restr. | sha256 (inicio) | Depende de |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | `20261020000000_plusmedik_persistent_audit.sql` | 83 | 4 | 0 | 0 | 0 | 5 | 0+0 | `1110edc1e1b3…` | — |
| 02 | `20261021000000_plusmedik_audit_telemetry.sql` | 77 | 0 | 0 | 0 | 0 | 2 | 14+2 | `08e555cf0c87…` | 01 |
| 03 | `20261022000000_plusmedik_audit_transactional.sql` | 495 | 0 | 0 | 12 | 9 | 1 | 2+1 | `1135f673e0a8…` | 01 |
| 04 | `20261023000000_plusmedik_audit_leases.sql` | 569 | 0 | 1 | 10 | 0 | 1 | 11+1 | `1b6546c2a441…` | 01, 03 |
| 05 | `20261024000000_plusmedik_human_control.sql` | 504 | 2 | 0 | 6 | 5 | 2 | 1+1 | `21430ed091a1…` | 01, 03, 04 |
| 06 | `20261025000000_plusmedik_turns.sql` | 328 | 2 | 0 | 3 | 5 | 1 | 0+0 | `2db27531909e…` | 01, 03, 04, 05 |
| 07 | `20261026000000_plusmedik_turn_recovery.sql` | 53 | 0 | 0 | 1 | 0 | 0 | 0+0 | `034f4ee6769c…` | 01, 04 |
| 08 | `20261027000000_plusmedik_knowledge.sql` | 779 | 4 | 0 | 19 | 8 | 5 | 0+0 | `3552b34dec19…` | 03 (y `lab_tests`, en tiempo de ejecución) |
| 09 | `20261028000000_plusmedik_knowledge_refs.sql` | 117 | 1 | 0 | 2 | 2 | 2 | 0+0 | `aa0b8644dc0f…` | 01, 03, 04, 06 |
| 10 | `20261029000000_plusmedik_reply_guard.sql` | 365 | 3 | 0 | 6 | 7 | 3 | 0+0 | `689c71aa2de4…` | 01, 03, 04, 05, 06 |
| 11 | `20261030000000_plusmedik_quote_sessions.sql` | 531 | 4 | 0 | 10 | 10 | 6 | 0+0 | `af0b7ed8399c…` | 01, 03, 04, 06 |
| 12 | `20261031000000_plusmedik_study_facts.sql` | 597 | 3 | 0 | 15 | 7 | 6 | 0+0 | `0958eb09426a…` | 01, 03, 04, 06, 08, 11 (y `lab_tests`) |
| 13 | `20261101000000_plusmedik_crm_outbox.sql` | 407 | 2 | 0 | 10 | 5 | 5 | 0+0 | `97567b010912…` | 01, 03, 04, 06, 11 |
| 14 | `20261102000000_plusmedik_quote_text_flow.sql` | 197 | 0 | 0 | 1 | 0 | 0 | 0+0 | `2094f3708548…` | 11 (agrega una función de apoyo y reemplaza dos suyas) |
| 15 | `20261103000000_plusmedik_crm_attention_control.sql` | 158 | 0 | 0 | 1 | 0 | 0 | 0+2 | `0f14159a903f…` | 05 (agrega la pausa/reactivación manual del CRM y amplía dos restricciones de `plusmedik_attention_events`) |

Totales: **25 tablas, 1 vista, 254 objetos en el manifiesto, 59 funciones con `EXECUTE` para `service_role`**. El sha256 completo de cada archivo (con saltos de línea LF) está en el encabezado de ambos SQL de verificación.

**Funciones que el orden redefine** (el orden decide la versión final; saltarse una deja una versión vieja): `plusmedik_audit_runs_guard` (03→04→05), `plusmedik_audit_reserve_send` (04→05→06), `plusmedik_audit_claim_run` (04→05; la 05 **elimina** la firma anterior y deja una con `p_contact_key` opcional, de modo que los llamadores antiguos siguen funcionando), `plusmedik_audit_record_reply` (03→06). `plusmedik_quote_session_read` y `plusmedik_quote_session_close` (11→14: el turno que cierra puede traer su propio ítem y una ambigüedad aclarada se puede cotizar; ver `docs/g5/80-g59-cotizacion-por-texto.md`). La restricción `plusmedik_audit_runs_lease_check` se elimina y se vuelve a crear en la 06.

Ninguna migración inserta datos, borra datos ni toca `lab_tests`, `lab_test_aliases` ni el esquema `crm` (búsqueda automática en las pruebas y verificación con base real).

## 4. Auditoría: permisos, compatibilidad y conflictos

**Permisos.** Todas las funciones de V2 son `SECURITY DEFINER` con `search_path` vacío y `EXECUTE` solo para `service_role` (`revoke … from public, anon, authenticated` en cada una); las tablas tienen RLS y `anon`/`authenticated`/`public` no tienen ningún privilegio. La 03 **recorta** a `service_role` (`INSERT/UPDATE/DELETE/TRUNCATE` en las tablas de auditoría): cualquier escritor directo ajeno dejaría de funcionar. Se buscó: ni V2 ni el CRM escriben en esas tablas (el único `plusmedik_` en el CRM es una cadena de interfaz). La cola al CRM (13) además impide que `service_role` lea `payload_cipher` y el arrendamiento (`SELECT` por columnas).

**Esquema `crm`.** V2 no crea, altera ni lee nada en `crm`; el CRM no define ningún objeto `plusmedik_*`. Las verificaciones comprueban que no aparezca ningún objeto de V2 en `crm` y toman una **instantánea** (columnas de `lab_tests`, filas, políticas, privilegios de `service_role`, número y definición de las funciones de `crm`, filas de `crm.messages` y `crm.review_cases`) que debe ser **idéntica antes y después**.

**`lab_tests`.** Las migraciones 08 y 12 solo la consultan dentro de funciones (`id`, `active`), con comprobación de existencia. Hallazgo para activar más adelante: la migración `202610230009` del CRM concede a `service_role` `SELECT` **por columna** sobre `lab_tests` (`id, code, name, price_bs, active, category, sample_type`) y **no** incluye `normalized_name`, que sí lee el cargador de catálogo de V2 (`src/supabase-catalog.ts`). Si en la base real `service_role` no tuviera el privilegio de tabla completo (que Supabase concede por defecto), el cargador de V2 fallaría. La verificación previa lo comprueba columna por columna (`service_role puede leer lab_tests.*`, aviso).

**Versión de PostgreSQL.** Se exige ≥ 14 (`create or replace trigger`). Las migraciones se probaron en PostgreSQL 18; un recorrido estático no encontró funciones posteriores a la 14 (`sha256`, `generated always … stored`, `make_interval`, `jsonb_build_object`, `to_jsonb`). **La versión del proyecto no se pudo consultar**; la verificación previa la muestra.

**Idempotencia.** Todas las sentencias son `create … if not exists`, `create or replace` o están guardadas con `if not exists`; **volver a ejecutar las 14 sobre una base ya migrada no falla ni cambia nada** (prueba). Es lo que permite reintentar un archivo tras un corte.

**Colisiones.** Todos los nombres llevan el prefijo `plusmedik_`. Búsquedas hechas: nombres de relación existentes con otro tipo, restricciones o índices del mismo nombre en otra tabla (el guardián `if not exists` los omitiría en silencio), objetos `plusmedik_*` desconocidos, objetos `plusmedik*` en `crm`, sobrecargas. No hay colisión conocida; la base real puede tener alguna y la verificación previa la reportaría.

## 5. Las verificaciones de solo lectura

Son **una sola sentencia `SELECT`** cada una (prueba estática: sin `insert/update/delete/create/alter/drop/grant/revoke/truncate/call/begin/commit/set/execute`), sin datos clínicos ni secretos; devuelven una tabla `(orden, sección, comprobación, estado, detalle)` con la fila de **VEREDICTO** primero. Estados: `OK`, `INFO`, `WARN` (revisar), `BLOCK` (detenerse). Se probaron contra PostgreSQL real, incluso dentro de `begin read only`.

`v2_pre_apply_read_only.sql` (antes): versión y sesión; roles `anon/authenticated/service_role`; catálogo (`lab_tests` y sus columnas/tipos, privilegios de `service_role`, `lab_test_aliases`, RLS); colisiones (§4); registro de migraciones (si existe) y aviso de la versión duplicada; **estado de cada migración por objetos** (pendiente / aplicada / parcial / hueco de orden); filas en tablas de V2 ya existentes (y aviso si hay filas en `plusmedik_audit_runs` con las migraciones 02-06 pendientes, porque sus restricciones nuevas se validan contra ellas); transacciones largas; privilegios por defecto; **instantánea**.

`v2_post_apply_read_only.sql` (después, y después de **cada** migración): estado de cada migración (la aplicada debe estar completa); orden; RLS de todas las tablas; ningún privilegio para `anon`/`authenticated`/`public` (incluso por columna); las 58 funciones de servicio con `EXECUTE`; ninguna función ejecutable por `anon`/`authenticated`/`public`; `SECURITY DEFINER` con `search_path` fijo; propietario `postgres`; versión final de las funciones redefinidas (una sola firma de `claim_run`, `conversation` presente) cuando su migración ya está aplicada; triggers habilitados; restricciones validadas; filas por tabla; cola al CRM sin lectura de `payload_cipher`/arrendamiento; nada de V2 en `crm`; **instantánea**.

Se regeneran con `npx tsx scripts/migration-manifest.ts` y una prueba falla si los archivos no coinciden con las migraciones (si alguien edita una migración, hay que regenerar **y** volver a revisar este documento).

## 6. Procedimiento exacto (manual, en este orden)

**Antes de tocar nada (equipo, sin SQL):**
1. Decidir y registrar quién ejecuta y quién revisa. Elegir una ventana de bajo tráfico (el piloto recibe mensajes reales).
2. **Confirmar un punto de restauración** (copia de seguridad o PITR del plan de Supabase). Si no existe, no continuar.
3. Confirmar que **todas las banderas siguen apagadas** y que en Vercel no se cambia nada durante el procedimiento.
4. Confirmar el commit que está desplegado (qué versión del código llama a las funciones de auditoría).
5. *(Recomendado, requiere decisión del dueño)* **hacer commit** de las migraciones 06-14 y de las verificaciones, para que lo que se aplica sea exactamente lo revisado y reproducible. Hoy están sin versionar.
6. En la máquina local, comprobar que cada archivo coincide con el sha256 de §3 (PowerShell: `Get-FileHash -Algorithm SHA256 <archivo>`; ojo, el hash de referencia es con saltos de línea LF: si el archivo tiene CRLF, comparar con `(Get-Content -Raw <archivo>) -replace "`r`n","`n"`) y ejecutar `npx tsx scripts/migration-manifest.ts --check` (debe decir que coinciden).

**En el panel de Supabase:**
7. Abrir el proyecto y **leer el identificador en la URL del panel: debe ser `cvokrtrdzxfchntwwslz`**. Si es otro, parar. Abrir *SQL Editor* con el rol administrativo `postgres`.
8. Pegar **`v2_pre_apply_read_only.sql`** completo en una consulta nueva y ejecutar. **Guardar la tabla de resultados completa** (captura o exportación). Condiciones para seguir: `VEREDICTO = OK` (o `WARN` entendido y aceptado por escrito) y las 14 migraciones en «pendiente». Si alguna sale `YA APLICADA`, **parar**: averiguar quién y cuándo la aplicó. Si hay `BLOCK` (parcial, hueco, colisión, rol o catálogo ausente, PostgreSQL < 14): **parar**.
9. Para cada migración **N = 01 … 14, una por una**:
   1. Abrir el archivo `supabase/migrations/<archivo N>` **sin modificarlo**, copiar su contenido completo y pegarlo en una consulta **nueva** (no reutilizar la anterior).
   2. **No** agregar `begin`/`commit`. Ejecutar **una sola vez**. Las migraciones 05 y 06 contienen `drop function`/`drop constraint`: el panel puede pedir confirmar una «operación destructiva»; es lo esperado (la 05 elimina la firma antigua de `claim_run` y crea la nueva en la misma ejecución; la 06 elimina y recrea `plusmedik_audit_runs_lease_check`).
   3. El resultado esperado es éxito sin filas. Ante **cualquier** error: **parar**, copiar el mensaje completo; no avanzar a la siguiente. Como cada archivo es repetible, puede volver a ejecutarse el mismo (nunca saltarlo ni editarlo a mano) una vez entendida la causa.
   4. Ejecutar **`v2_post_apply_read_only.sql`**. Condiciones: ninguna fila `BLOCK`; las migraciones 1..N en `OK` («completa»); las N+1..14 en `INFO` («aún no aplicada»). Anotar fecha, persona, archivo y resultado.
10. Terminada la 15: ejecutar otra vez **`v2_pre_apply_read_only.sql`** (debe mostrar las 15 como «YA APLICADA» sin `BLOCK`) y **`v2_post_apply_read_only.sql`** (`VEREDICTO = OK`). **Comparar las filas `INSTANTANEA` con las guardadas en el paso 8: deben ser idénticas** (catálogo y esquema `crm` sin cambios). Cualquier diferencia es un bloqueo.
11. Si el API de Supabase devolviera «function not found» para alguna función nueva, esperar unos segundos (PostgREST recarga su caché al detectar DDL); como último recurso, el panel permite recargar el esquema. No es parte de las migraciones.
12. **Dejar todas las banderas apagadas.** Aplicar las migraciones no activa nada. La activación sigue el orden y las condiciones de `docs/g2/11`, `docs/g3/11`, `docs/g3/13`, `docs/g4/11`, `docs/g4/13` y `docs/g5/11`.

**Si algo sale mal:** no hay scripts de reversa (no existe «down»). Todo es aditivo y las tablas nuevas quedan vacías, así que mientras las banderas sigan apagadas el sistema se comporta como antes (los llamadores antiguos de `claim_run` siguen funcionando). Una reversión parcial no se improvisa: se decide con el punto de restauración del paso 2, o con una migración nueva revisada. **No** borrar objetos «a mano» con la tabla de resultados como guía sin revisión.

## 7. Riesgos

| # | Riesgo | Severidad | Mitigación |
| --- | --- | --- | --- |
| R1 | **Número de versión duplicado entre repositorios**: V2 `20261025000000_plusmedik_turns` y CRM `20261025000000_crm_fix_patient_note_and_follow_up_rpcs` | Alta si se usara la CLI | **No** usar `supabase db push` ni `apply_migration` con estos archivos; aplicar a mano (como ya hace el CRM). Si algún día se adopta la CLI, renombrar una de las dos (p. ej. `20261025000001`), lo que obliga a actualizar pruebas y documentos; no se hizo |
| R2 | **Versiones de longitud distinta en el mismo registro** (CRM de 12 dígitos, V2 de 14): el orden de texto no refleja el orden real | Media si se usara un registro | Misma mitigación: aplicación manual; el estado se decide por objetos, no por el registro |
| R3 | **Recorte de privilegios de `service_role`** en las tablas de auditoría (03) | Media | No hay escritores ajenos conocidos; el piloto sin las migraciones ya degrada a «sin auditoría» |
| R4 | **Ventana intermedia insegura entre 01 y 03**: la 01 deja a `service_role` con permisos completos «provisionales» sobre tablas aún vacías | Baja | Aplicar 01-03 seguidas; las tablas están vacías; `anon`/`authenticated` no tienen acceso |
| R5 | **Estado intermedio de las funciones redefinidas** si se aplica solo una parte | Media | Aplicar las 15 en la misma ventana; la verificación posterior solo exige la versión final cuando la migración correspondiente ya está aplicada |
| R6 | **Bloqueos de tabla**: `ALTER TABLE plusmedik_audit_runs` toma bloqueo exclusivo breve (02-06) | Baja | Ventana de bajo tráfico; la verificación previa avisa de transacciones largas |
| R7 | **Filas previas en `plusmedik_audit_runs`**: las restricciones nuevas se validan contra ellas y podrían fallar | Baja (esperado vacío) | La verificación previa cuenta filas y avisa |
| R8 | **PostgreSQL < 14 o con diferencias**: solo se probó en 18 | Media | La verificación previa bloquea < 14 y muestra la versión; ideal probar antes en una copia (ver bloqueos) |
| R9 | **Atomicidad del SQL Editor**: una ejecución con varias sentencias suele correr como una sola transacción implícita, pero no se verificó en este proyecto | Media | Los archivos son repetibles; la verificación posterior detecta `PARCIAL`; no se envuelven en `begin/commit` para no dejar una transacción abierta si falla |
| R10 | **Límites del panel** (tiempo máximo de consulta, tamaño del texto pegado; la 08 pesa ≈ 50 KB) | Baja | Una migración por consulta; si el panel corta, usar una conexión administrativa directa |
| R11 | **Exposición por la Data API**: toda función de `public` es invocable como RPC | Alta si fallara | Probado: nada ejecutable por `anon`/`authenticated`/`public`; la verificación posterior lo comprueba en la base real |
| R12 | **Verificaciones no sustituyen un ensayo**: PostgREST real, rendimiento y concurrencia no están probados | Media | Staging o copia del proyecto antes de producción |
| R13 | **Hash del archivo depende de saltos de línea** (CRLF/LF en Windows) | Baja | El hash de referencia es con LF y el paso 6 explica cómo comprobarlo |
| R14 | **Los archivos 06-14 y las verificaciones no están versionados** | Media | Hacer commit antes de aplicar (decisión del dueño) |

## 8. Bloqueos (antes de aplicar)

1. **Sin permiso remoto desde esta sesión**: el estado real de la base y el identificador visible en el panel solo los puede confirmar una persona.
2. **Punto de restauración no confirmado** (copia de seguridad/PITR del plan).
3. **Versión de PostgreSQL del proyecto desconocida.**
4. **Sin staging ni copia del proyecto** donde ensayar (la base de producción es compartida con el CRM).
5. **Archivos sin commit** (06-14, verificaciones, generador, prueba).
6. **Commit desplegado en Vercel sin confirmar** y banderas actuales sin confirmar.
7. **Decisión pendiente** sobre el número de versión duplicado (R1) si se quisiera usar herramientas de migración en el futuro.
8. **Responsables** de ejecutar y revisar, y ventana de mantenimiento, sin asignar.

## 9. Resultados de las pruebas de esta preparación

| Dato | Valor |
| --- | --- |
| `tests/migration-preflight-db.test.ts` | **19 pruebas** (6 estáticas y 13 contra PostgreSQL 18 efímero; aplican las 15 migraciones) |
| Cubre | base limpia; aplicar las 15 de una vez y **de a una** (tras cada una, lo aplicado completo y lo siguiente pendiente); reintento de las 15; parcial; hueco de orden; catálogo ausente, id de otro tipo, columna o privilegio de `service_role` faltante; relación de otro tipo, restricción o índice homónimo en otra tabla, objeto de V2 en `crm`; 12 permisos o ajustes de más (anon, authenticated, public, columna, RLS, EXECUTE, `search_path`, propietario, trigger deshabilitado, lectura de la carga cifrada); versiones viejas de las funciones redefinidas; registro de migraciones; filas previas; rol ausente; ejecución dentro de `begin read only`; instantánea idéntica antes/después |
| Gasto / red | cero llamadas remotas |
