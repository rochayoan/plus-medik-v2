# G3.0 · Arquitectura y modelo de conocimiento

Todo local y offline. La migración 8 **no contiene ningún dato**; ningún texto, horario ni preparación de este repositorio es información del laboratorio (las pruebas usan fixtures que dicen "PRUEBA").

## 1. Principios (qué se garantiza y dónde se hace cumplir)

| Principio | Cómo se cumple | Dónde |
| --- | --- | --- |
| Solo se responde con lo **aprobado por el laboratorio** | La lectura solo ve versiones `APPROVED`; sin versión aprobada y vigente el resultado es `UNAVAILABLE` | SQL (`plusmedik_kb_snapshot`) + servicio |
| **No se inventa**: falta o está desactualizado → resultado estructurado "no disponible" | `KnowledgeResult = AVAILABLE | UNAVAILABLE{reason}`; 9 razones codificadas; nunca texto | `src/knowledge/types.ts`, `service.ts` |
| **La IA no aprueba** su propio conocimiento | La IA solo puede crear/editar **borradores administrativos propios**; no envía, aprueba, rechaza, desactiva ni restaura; nada clínico. Se aplica en la base, y el agente en ejecución ni siquiera importa las funciones de escritura (prueba estática) | SQL (`plusmedik_kb_assert_actor`) + pruebas de fronteras |
| **Cuatro ojos** | Quien creó, editó o envió una versión no puede aprobarla ni rechazarla | SQL (`plusmedik_kb_assert_not_author`) |
| **Lo clínico lo valida personal clínico autorizado** | La preparación de estudios (`STUDY_PREPARATION`) solo la aprueba el rol `CLINICAL_APPROVER`; el aprobador administrativo no puede, ni al revés | SQL |
| **Administrativo ≠ clínico** | La clasificación se **deriva** del tipo (columna generada, no elegible); tablas comunes pero funciones, roles y esquemas de contenido distintos; consultas separadas | SQL + `classificationOf` |
| **Caducidad** | `valid_until` obligatorio (máx. 400 días); evaluado **al usar el dato**, nunca depende de la caché | SQL + servicio |
| **Versionado y trazabilidad** | Versiones inmutables; una aprobada y una abierta por elemento; bitácora inmutable (quién, rol, de/a estado, motivo codificado, hash) | SQL (triggers) |
| **No duplicar precios ni catálogo** | Preparación vinculada por `lab_tests.id` (sin FK, solo lectura al aprobar); cualquier texto que mencione un importe se rechaza; sin columnas de precio | SQL + zod + pruebas |
| **Recetas/cotizaciones/imágenes separadas** | El módulo no importa nada del motor de recetas y el motor no conoce el módulo (prueba estática) | pruebas de fronteras |

## 2. Entidades

Una sola familia de tablas con contenido tipado por `kind`; la separación administrativo/clínico está en los **roles, funciones y reglas**, no en datos duplicados.

| `kind` | Clasificación | Clave (`key`) | Contenido (lista blanca estricta) |
| --- | --- | --- | --- |
| `BRANCH` (sucursal) | Administrativa | `branch-<slug>` | `name`, `address`, `mapsUrl?` (https), `phone?`, `notes?` |
| `SCHEDULE` (horario) | Administrativa | libre (`schedule:<sucursal>:<servicio>`) | `branchKey`, `service` (`OFFICE` · `SAMPLE_COLLECTION` · `RESULTS_PICKUP` · `HOME_SAMPLING` · `HUMAN_SUPPORT`), `timezone`, `weekly[{day 0-6, opens, closes}]`, `exceptions[{date, closed, opens?, closes?, note?}]?`, `notes?` |
| `POLICY` (política de atención) | Administrativa | `policy:<slug>` | `topic` (MAYÚSCULAS), `title`, `body` |
| `PAYMENT_METHOD` | Administrativa | `payment:<slug>` | `method`, `label`, `accepted` (el laboratorio también puede declarar lo que **no** acepta), `notes?` |
| `FAQ` | Administrativa | `faq:<slug>` | `question`, `answer`, `tags?` |
| `STUDY_PREPARATION` (preparación) | **Clínica** | `study:<lab_tests.id>` | `labTestId`, `prepState` (`HAS_PREPARATION` · `NO_PREPARATION_REQUIRED`), `fastingHours?` (0-48), `instructions?`, `collectionWindow?` |

Reglas de contenido relevantes:
- **"Sin preparación" es una afirmación clínica explícita y exclusiva** (`NO_PREPARATION_REQUIRED` no admite ayuno ni instrucciones) y debe aprobarla un aprobador clínico. La **ausencia** de registro es "no disponible", nunca "no requiere preparación".
- `HAS_PREPARATION` debe decir cuál (ayuno y/o instrucciones).
- Todo texto: 1–2000 caracteres y **sin importes** (`Bs 45`, `45 bolivianos`, `$5`, `10 dólares`…). Los precios salen solo de `lab_tests.price_bs`.
- Tipos de servicio (`HUMAN_SUPPORT`) permiten, en G3.1, prometer el horario real de atención humana (pendiente de G5).

## 3. Estados y transiciones

```
        crear                enviar                aprobar (≠ autor, rol aprobador)
(nada) ───────▶ DRAFT ───────────▶ PENDING_APPROVAL ─────────────────────────▶ APPROVED
                 ▲   editar          │  rechazar (motivo codificado)              │  │
                 └───────────────────┘                                            │  │ nueva versión aprobada
                                                                   desactivar ◀──┘  └──▶ la anterior pasa a INACTIVE (SUPERSEDED)
                                              APPROVED ◀── restaurar (solo lo que ya estuvo aprobado, no vencido) ── INACTIVE
```

| Estado | Significado | ¿Se usa para responder? |
| --- | --- | --- |
| `DRAFT` | Borrador editable (persona o IA administrativa) | No |
| `PENDING_APPROVAL` | Enviado por una persona; contenido congelado | No |
| `APPROVED` | Aprobado por la persona con rol aprobador; vigente entre `valid_from` y `valid_until` | **Sí**, mientras esté vigente |
| `INACTIVE` | Reemplazado (`SUPERSEDED`) o retirado (motivo codificado) | No |

Invariantes (índices parciales): **una** versión `APPROVED` y **una** abierta (`DRAFT`/`PENDING_APPROVAL`) por elemento. El contenido solo cambia en `DRAFT`. Ni siquiera el propietario de la base puede editar/borrar historial (triggers).

## 4. Permisos

| Acción | `EDITOR` | `ADMIN_APPROVER` | `CLINICAL_APPROVER` | `AI_DRAFTER` (IA) |
| --- | --- | --- | --- | --- |
| Crear / editar borrador administrativo | ✅ | ✅ | ✅ | ✅ (solo borradores **creados por una IA**) |
| Crear / editar borrador **clínico** | ✅ | ✅ | ✅ | ❌ |
| Enviar a aprobación | ✅ | ✅ | ✅ | ❌ |
| Aprobar / rechazar administrativo | ❌ | ✅ (≠ autor) | ❌ | ❌ |
| Aprobar / rechazar **clínico** | ❌ | ❌ | ✅ (≠ autor) | ❌ |
| Desactivar / restaurar (misma clasificación) | ❌ | ✅ | ✅ | ❌ |

- Retirar un dato incorrecto **no** exige segundo humano (debe ser inmediato). Restaurar tampoco, porque solo recupera contenido ya aprobado antes, sin cambios.
- Un laboratorio con **una sola** persona autorizada no podrá aprobar lo que redactó: decisión del laboratorio (ver [03](03-informacion-del-laboratorio.md)).
- **Límite honesto:** la base no autentica personas (lo hace el CRM). Quien tenga la credencial `service_role` puede declarar cualquier actor. Defensas: solo el CRM debe administrar; el agente no incluye las funciones de escritura; bitácora inmutable con el actor declarado; recomendado a futuro un rol de base de datos propio para el CRM (ver [02](02-contrato-crm.md)).

## 5. Consulta (lo que usará el manejador de G2.1/G3.1)

`src/knowledge/index.ts` (solo lectura). Todas las consultas devuelven `KnowledgeResult<T>`:

```ts
{ status: "AVAILABLE", data, provenance: [{kind, key, version, approvedAt, approvedBy, validUntil, contentHash}], omitted: [{key, reason}] }
{ status: "UNAVAILABLE", reason, kind, key? }
```

| Método | Devuelve | `UNAVAILABLE` si |
| --- | --- | --- |
| `getBranches()` / `getBranch(key)` | sucursales vigentes (+ `omitted` si alguna venció/está inválida) | ninguna aprobada y vigente |
| `getSchedule({branchKey, service})` | horario aprobado; **exige la sucursal también aprobada y vigente** | falta/vence el horario o la sucursal; dos vigentes (`AMBIGUOUS`) |
| `getScheduleStatus(query, at?)` | ¿abierto? calculado por código con la **zona horaria del horario**; excepciones mandan sobre el horario semanal; cierre exclusivo | igual que arriba; zona inválida (`INVALID_CONTENT`) |
| `getPolicy(topic)` | política aprobada del tema | falta, vencida o ambigua |
| `getPaymentMethods()` | métodos con `accepted` true/false | ninguno vigente |
| `getFaq(key)` / `findFaqByTag(tag)` | pregunta(s) aprobadas | falta/vencida |
| `getStudyPreparation(studyIds, catalog)` | por estudio: preparación aprobada + nombre del catálogo | `UNKNOWN_STUDY`, `INACTIVE_STUDY`, `CATALOG_UNAVAILABLE`, `NO_APPROVED_VERSION`, `EXPIRED`… |

- La preparación de varios estudios se informa **por separado**: **no hay consolidación clínica automática** (p. ej. "ayuno máximo"). Esa regla debe definirla el laboratorio.
- `omitted` obliga al consumidor a saber que una lista puede estar incompleta (p. ej. métodos de pago donde uno venció).
- Razones: `NO_APPROVED_VERSION` · `EXPIRED` · `NOT_YET_VALID` · `INVALID_CONTENT` · `STORE_UNAVAILABLE` · `UNKNOWN_STUDY` · `INACTIVE_STUDY` · `CATALOG_UNAVAILABLE` · `AMBIGUOUS`.

**Integración con el manejador de G2.1 (no hecha en G3.0):** `createTextHandler` hoy responde textos fijos. En G3.1 se le inyectaría un puerto `knowledge: KnowledgeService`; para una categoría `INFO_REQUEST` consultaría el tema, y **solo con `AVAILABLE`** redactaría la respuesta con **plantillas** que rellenan los campos aprobados (sin modelo); con `UNAVAILABLE` conservaría el comportamiento actual (`handoff_unavailable`). La guarda de textos (sin cifras) cubre las plantillas fijas; los datos aprobados (horas, direcciones) entrarían como variables verificadas.

## 6. Caché, invalidación y recuperación

| Mecanismo | Detalle |
| --- | --- |
| **Revisión** | Tabla `plusmedik_kb_state`: contador que sube en la **misma transacción** que aprobar, desactivar o restaurar (no con crear/editar/enviar/rechazar). Concurrentes se serializan (1,2,3… sin saltos). |
| **Instantánea consistente** | `plusmedik_kb_snapshot()` devuelve revisión + todo lo aprobado en **una sola sentencia** (misma foto): el contenido nunca es más viejo que la revisión devuelta, ni se ve una aprobación a medias. |
| **Caché del servicio** | Copia + revisión. Cada `revisionCheckMs` (15 s) pregunta solo la revisión (barato); si cambió, recarga **todo** (una recarga a la vez, nunca se pisa una copia más nueva con una más vieja). `invalidate()` fuerza la recarga. |
| **Base caída** | Se usa la copia hasta `maxStaleMs` (5 min) desde la última verificación; después, `STORE_UNAVAILABLE` (falla cerrado). |
| **Caducidad** | Se evalúa **al usar** el dato con el reloj actual; la caché no puede servir lo vencido. |
| **Propagación máxima de un retiro** | ≤ `revisionCheckMs` por instancia (15 s) salvo `invalidate()`. Para retiro urgente: bajar el plazo o una llamada de invalidación desde el CRM (contrato en [02](02-contrato-crm.md)). |
| **Recuperar una versión aprobada** | `plusmedik_kb_restore`: vuelve a ser la vigente una versión que **ya estuvo aprobada** (contenido idéntico, mismo hash), la actual pasa a `INACTIVE`, sube la revisión y queda evento `RESTORED`. No restaura lo vencido ni lo nunca aprobado. |
| **Recuperar de un error de carga** | Retirar (`deactivate`) es inmediato y sin segundo humano; luego restaurar la anterior o crear una versión corregida. |

## 7. Decisiones y alternativas descartadas

| # | Decisión | Por qué | Descartado |
| --- | --- | --- | --- |
| D1 | Familia de tablas única con `kind` y contenido `jsonb` validado por lista blanca | Un solo ciclo de aprobación y una sola bitácora; tipos nuevos sin migración de tablas | Una tabla por tipo (8× más SQL y permisos duplicados) |
| D2 | La clasificación se **deriva** del tipo (columna generada) | No se puede "bajar" una preparación a administrativa para saltarse al aprobador clínico | Campo elegible |
| D3 | Validación **doble** (SQL = autoridad; zod = lectura y cliente) con prueba diferencial de 56 contenidos | Si el CRM o un script llegara a escribir directo, la base igual rechaza; la lectura nunca sirve algo inválido | Solo una capa |
| D4 | `valid_until` obligatorio, sin renovación automática | La preparación y los horarios cambian; lo viejo no debe vivir para siempre | Caducidad opcional |
| D5 | Sin clave foránea a `lab_tests`; comprobación al aprobar y al leer (catálogo activo) | Contrato con el CRM: nada de FK ni escrituras sobre el catálogo | FK |
| D6 | Sin consolidación clínica automática | Es una regla clínica que el laboratorio no ha definido | "Ayuno máximo" |
| D7 | Motivos de rechazo/retiro **codificados** (no texto libre) | Privacidad y trazabilidad sin PII; el texto libre vive en el CRM | Campo libre |
| D8 | El servicio es de **lectura**; administración en un cliente aparte que el agente no importa | La IA/agente no puede aprobar aunque quisiera | Un solo repositorio con ambas |
| D9 | Instantánea completa en lugar de consulta por clave | Una ida a la base por intervalo, no por mensaje; revisión consistente | Una consulta por pregunta (más latencia y sin coherencia) |
| D10 | Sin datos sembrados; ni siquiera "ejemplos" | Un dato de ejemplo en producción sería información oficial falsa | Plantillas con datos de muestra |
