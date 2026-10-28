# G2.1 · Manejador conversacional mínimo de texto

Todo local, offline y **apagado por defecto**. Nada se aplicó a Supabase, no se envió ningún mensaje, no se llamó a ningún modelo, no se activó ninguna bandera, no hay commit/push/merge. No se tocó `CRM-PLUSMEDIK`.

## 1. Auditoría del webhook: cómo se identifica lo entrante

`src/kapso-webhook.ts` → `extractIncomingTurns` (`src/turns.ts`). Basado en el formato de Kapso v2 que ya documentaba el repositorio (`src/human-control.ts`) y en las fixtures de pruebas; **no verificado con capturas reales**.

| Tipo (`message.type`) | Turno | Qué se lee | Observaciones |
| --- | --- | --- | --- |
| `text` | `TEXT` | `message.text.body` (solo en memoria) | Vacío o solo espacios: no es turno |
| `image` (o `message.image`) | `IMAGE` | `media_url` / `image.link` / `image.url` / `image.id` | Sin medio: no es turno. El **pie de foto no se lee** |
| `audio`, `document`, `video`, `sticker`, `location`, `contacts`, `interactive`, `button`, otros | `OTHER` | nada | **Sin manejador: no se reclaman ni se responden** (como hoy). Las respuestas a botones (`interactive`) no se leen |
| `reaction` | ninguno | | |
| `direction ≠ inbound` | ninguno | | Salientes (bot, humano, eco) |

**Brechas encontradas y cerradas (solo para texto y otros tipos; las imágenes no cambian):**

| Riesgo | Antes | Ahora (modo turnos) |
| --- | --- | --- |
| Un evento que no es "mensaje recibido" (`sent`, `delivered`, `read`, `failed`, de conversación) con forma de mensaje | se trataba como entrante | **descartado** según `x-webhook-event` (debe terminar en `.received`; sin cabecera se acepta) |
| Mensajes **importados del historial** (`origin: history_sync`) | se habrían contestado | **descartados** |
| Mensajes **viejos** (reentrega tardía, reproceso) | se habrían contestado | **descartados** si tienen más de 10 min, más de 5 min en el futuro, o no traen instante |

Con el modo apagado el extractor y el webhook no cambian en absoluto (sigue `extractIncomingImages`).

## 2. Funcionamiento del manejador (`src/text-handler.ts`)

Determinista: **sin modelos**, sin red, sin persistencia propia. Clasifica con reglas (sin tildes, mayúsculas ni signos; máximo 4000 caracteres examinados) y responde con textos fijos.

| Categoría (prioridad ↓) | Ejemplos | Respuesta | `stale` |
| --- | --- | --- | --- |
| `MEDICAL` | dolor, fiebre, dosis, "interpretar resultado", urgencia, embarazo | `medical_unavailable` (no se da orientación médica; remite a emergencias) | `NEWER_TURN` |
| `HUMAN_REQUEST` | "quiero un asesor", "hablar con una persona" | derivación (ver §4) | según §4 |
| `INFO_REQUEST` | horarios, ubicación, pagos, ayuno, domicilio, resultados, convenios | derivación (ver §4) | según §4 |
| `RECIPE_OR_QUOTE` | "cotizar", "cuánto cuesta", "receta" | `send_recipe` (pide la foto de la receta) | `NEWER_TURN` |
| `GREETING` | "hola", "buenas tardes" | `greeting` | `NEWER_TURN` |
| `OTHER` (y vacío) | "gracias", emojis | `fallback` (pide la foto) | `NEWER_TURN` |

Un mensaje de más de 4000 caracteres sin nada reconocible en ese tramo se trata como `HUMAN_REQUEST` (necesita a una persona). La prioridad es deliberadamente conservadora: lo médico gana a todo; pedir a una persona gana a la información; la información gana a cotizar ("¿cuánto cuesta con convenio?" no se responde como cotización).

**Textos** (`DRAFT_TEXTS`): son **BORRADORES que debe aprobar el laboratorio**. El constructor rechaza (error `UnsafeTextError`) cualquier texto configurado con cifras, moneda, días, plazos, horarios o promesas de gratuidad/descuento: la configuración no puede introducir un dato inventado. Ningún texto afirma un horario, un precio, una política o un dato médico; solo uno (`handoff_confirmed`) promete que una persona atenderá, y únicamente se usa con la derivación persistida.

**Privacidad:** el texto del paciente solo vive en memoria durante el turno. El único registro es `text_turn { category, handoff }` (códigos). No va al log, a la auditoría ni a tablas (verificado volcando todas las tablas).

## 3. Reutilización de Phase 6 y G2.0 (nada reconstruido)

El manejador **solo produce un cuerpo de respuesta**: reclamar, numerar, reservar, esperar, descartar, confirmar la pausa, enviar y registrar lo hace la misma máquina de `guarded-turn.ts` que las imágenes. Por eso hereda sin código nuevo: idempotencia por `message_id`, lease/fencing, reserva única, "un envío incierto no se reenvía", pausa humana en el claim/reserva/comprobación final, recuperación, auditoría inmutable.

## 4. Derivación a una persona: BLOQUEADA

Requisito: no confirmar una derivación a menos que su persistencia esté garantizada. Hoy **no lo está**: el contrato receptor del CRM (`POST /api/internal/agent/review-case`) está apagado (`PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED=false`), el CRM aún no ingiere los mensajes del agente (respondería `409 message_not_ingested`) y este repositorio no tiene el outbox/emisor (G5).

Diseño implementado:

```
HandoffSink { operational: boolean; record(request): Promise<"RECORDED" | "DUPLICATE"> }
```

| Situación | Respuesta al paciente | Qué se registra |
| --- | --- | --- |
| Sumidero **no operativo** (por defecto: `BLOCKED_HANDOFF`) | `handoff_unavailable` (o `medical_unavailable`): **no promete nada** | nada; `text_turn{handoff:"blocked"}` |
| Operativo y `record` resuelve (`RECORDED` o `DUPLICATE`) | `handoff_confirmed` con `stale: NONE` (**nunca se descarta**) | la solicitud (clave `handoff:<messageId>`, idempotente) |
| Operativo y `record` **falla** | `handoff_unavailable` — **no** se confirma; no se filtra el error | `text_turn{handoff:"failed"}` |
| Pausa humana mientras se persiste | **no se envía** la confirmación (la persona ya tomó el caso); la solicitud persistida se conserva | la solicitud |

`HandoffRequest` = `{ eventId, kapsoMessageId, contactPhone (solo en memoria), reason: HUMAN_REQUEST|INFO_REQUEST|MEDICAL }`: sin texto del paciente. **No existe ninguna variable de entorno que lo habilite**: `api/kapso/webhook.ts` instancia el manejador con `BLOCKED_HANDOFF`; desbloquearlo exige un cambio de código en G5 (sumidero real) y la aprobación del dueño.

Para desbloquearla (G5) hacen falta: outbox transaccional en la base del agente escrito junto con la evidencia; emisor idempotente hacia el CRM; el CRM con la bandera de ingestión encendida, token exclusivo y el mensaje original ya ingerido; y que `record` solo resuelva cuando el CRM respondió `created`/`duplicate` **o** cuando el outbox esté confirmado Y haya alguien que lo lea (decisión del dueño: ¿basta el outbox para prometer?).

## 5. `busy` agotado: turno recuperable (migración 7)

Migración **`20261026000000_plusmedik_turn_recovery.sql`** (probada solo en PostgreSQL efímero, **no aplicada**; 1 función, sin tablas, no modifica las anteriores — la 6 está fijada por hash):

`plusmedik_turn_release(run, owner, fence, 'BUSY_TIMEOUT')`: el dueño del lease que desiste de esperar **vence su lease al instante** y lo marca `attention_reason = BUSY_TIMEOUT`. No cierra, no reserva, no cancela, no sube el fence. Con envío reservado/aceptado/desconocido/cancelado responde `closed` y no toca nada → **no puede habilitar un segundo envío** (la exclusión sigue siendo solo la reserva).

| Qué pasa | Resultado |
| --- | --- |
| Otro envío del contacto sigue en vuelo y la espera (8 × 1,5 s por defecto) se agota | El turno **no envía**, se libera y queda marcado; log `reply_withheld{busy_timeout}` |
| El mensaje se reentrega (Kapso o el paciente reescribe lo mismo) | `taken_over` (fence + 1), **mismo número de secuencia**, reserva, **una** respuesta; un tercer reenvío ya no responde (`finished`) |
| Nadie lo reclama | El recuperador (`recover_stale`) lo cierra a los 15 min como `ABANDONED_BEFORE_SEND`, sin responder, para atención |
| 3 reclamos agotados | `exhausted`: no hay bucle |

**Límite honesto:** la base no guarda teléfono ni contenido, así que **no puede reenviar por sí sola**. "Recuperable" = retomable si el mensaje se reentrega; si no, queda cerrado sin responder y visible para atención. Con Kapso confirmando el 200 de inmediato no reentrega por sí mismo (ACK sin cambios): en la práctica es el paciente quien reescribe. Mitigación: la espera es larga frente a un envío normal (segundos) y solo se agota si el envío en vuelo está colgado.

## 6. Descarte de obsoletas — sin tocar cotizaciones ni evidencia

| Respuesta | `stale` | ¿Se descarta si un turno más nuevo ya respondió? |
| --- | --- | --- |
| Cotización / pedido de otra foto (imagen) | `NONE` | **Nunca** |
| Aviso técnico de una imagen | `NEWER_TURN` | Sí |
| Respuestas fijas del manejador (saludo, pedir receta, no disponible, médico) | `NEWER_TURN` | Sí |
| Confirmación de una derivación persistida | `NONE` | **Nunca** |

Descartar solo cancela el **envío** (`CANCELLED / SUPERSEDED`): la corrida, el turno, la solicitud de derivación y la evidencia de análisis permanecen (inmutables).

## 7. Garantías de idempotencia y concurrencia (probadas contra PostgreSQL real)

| Garantía | Cómo | Prueba |
| --- | --- | --- |
| Mismo texto entregado N veces (simultáneas o tardías) → **una** respuesta | claim atómico por `message_id` | e2e |
| Ejecución colgada + otra que reclama el lease → una respuesta; la antigua revive y **no puede enviar** | lease + fence (PT410) | e2e |
| Derivación reprocesada → misma clave `handoff:<id>` | clave determinista | unitaria + e2e |
| Textos consecutivos a la vez → envíos **nunca solapados** y, si salen varios, **en orden de turno** | reserva con `busy` + `NEWER_TURN` bajo bloqueo del contacto | e2e (máx. 1 simultáneo; orden por `seq`) |
| Envío incierto → no se reintenta; el reenvío del mismo mensaje tampoco | `UNKNOWN` terminal | e2e |
| Base caída al reclamar → no se corre el manejador ni se responde; al reservar → no se envía y queda recuperable | falla cerrado | e2e |
| Pausa humana antes / durante / entre reserva y envío / reactivación | claim, reserva, `confirm_send` | e2e |

## 8. Compatibilidad con recetas

- Cero cambios en `analyze.ts`, lectores, juez, catálogo, `partial-auto.ts`, `uncertainty.ts`, precios ni `ENGINE_FLAGS` (una prueba fija el literal de las banderas).
- `imageProducer` y `handleImageMessage` no se tocaron en G2.1. Las imágenes ignoran los nuevos filtros del extractor. Una imagen sigue produciendo la misma cotización, `send_kind = quoted` y política `NONE` (probado con el webhook y PostgreSQL reales).
- Producción: **sin banderas el comportamiento es el de antes** (prueba sobre el módulo real `api/kapso/webhook.ts`): un texto → `200 ignored`, nada programado, nada enviado. Con `PLUSMEDIK_TURNS` solo (sin manejador) o con `PLUSMEDIK_TEXT_HANDLER` solo (sin turnos): igual. Con ambas pero sin Supabase ni clave de contacto: falla cerrado, no se envía nada.

## 9. Archivos de G2.1

Nuevos: `src/text-handler.ts` · `supabase/migrations/20261026000000_plusmedik_turn_recovery.sql` · `tests/text-handler.test.ts` · `tests/turns-g21.test.ts` · `tests/turn-recovery-db.test.ts` · `tests/text-conversation-e2e.test.ts` · `tests/production-defaults.test.ts` · este documento.
Modificados (sobre G2.0): `src/audit.ts` (`releaseTurn`) · `src/guarded-turn.ts` (liberar en `busy` agotado) · `src/turns.ts` (filtros de entrantes) · `src/kapso-webhook.ts` (pasa evento y hora) · `api/kapso/webhook.ts` (`PLUSMEDIK_TEXT_HANDLER`, derivación bloqueada) · `.env.example`.
