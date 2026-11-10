# G7 · Fase 1 — Memoria simple y objetivos/preguntas pendientes

Estado: **diseño + prototipo probado en `scripts/` y `tests/`. No se tocó `src/`, `supabase/` ni producción.** Complementa [`02`](02-gestor-de-objetivos-conversacionales.md) (visión completa) con el alcance mínimo de la Fase 1 y valida el diseño con el corpus real.

## 1. Objetivo y alcance (deliberadamente pequeño)

**Que ninguna petición del paciente se pierda en silencio y que la recepción (y luego el agente) vean qué quedó pendiente.** No cambia lo que el agente responde ni lo que decide; añade *memoria estructurada* y *visibilidad*.

| Incluye (Fase 1) | No incluye (fases siguientes) |
| --- | --- |
| Preguntas/peticiones con estado `OPEN · ANSWERED · CARRIED · DROPPED` y motivo | Comprensión con modelo (segmentar enunciados con LLM) |
| Objetivos por intención (`QUOTE`, `LAB_INFO`, `HUMAN_ATTENTION`, `MEDIA`…) que persisten entre lotes y caducan a las 24 h | Verificador por procedencia, herramientas, agente |
| Artefactos por **ids**: receta leída, cotización emitida (nunca precios) | Respuesta del agente sobre recetas ya leídas |
| Quién tiene la palabra (`AGENT`/`HUMAN`) y qué se acumuló durante la pausa | Reanudación automática; turno de reanudación |
| **Lista de pendientes para la recepción** (CRM) con alertas | Cambiar la regla de pausa (sigue manual, decisión 4) |
| Opcional 1c: estado resumido en el contexto del modelo | |

**Cómo encaja con la arquitectura TypeScript existente.** Es un módulo puro (`reduce(estado, evento)`) alimentado por eventos que el sistema **ya produce**; el almacenamiento reutiliza el patrón de las sesiones de cotización (RPC `SECURITY DEFINER`, lease + fence, solo `service_role`).

## 2. Prototipo (hecho)

| Archivo | Contenido |
| --- | --- |
| `scripts/g7/phase1/conversation-state.ts` | Tipos, reductor puro e idempotente, `pending()`, `invariantViolations()`. Sin red, sin base de datos, sin texto de pacientes |
| `tests/g7-phase1-state.test.ts` | 10 pruebas: cobertura de un lote con 3 preguntas · texto fijo/«no puedo derivar» no cierran · pausa humana y reanudación manual · persistencia y caducidad de objetivos · idempotencia · pureza · artefactos sin precios · **propiedad: 200 secuencias aleatorias × 25 eventos conservan los invariantes y no pierden preguntas** |
| `scripts/g7/phase1-replay.ts` | Pasa el corpus real por los reductores y mide lo que habría visto la recepción (solo contadores) |

**Reglas del reductor** (las que se pasarían a `src/`):
1. Cada ítem del lote nace `OPEN` con su objetivo (o `CARRIED/HUMAN_PAUSED` si la palabra la tiene una persona).
2. Una respuesta del agente **con contenido** o con **cotización** cierra lo abierto. Un **texto fijo genérico** o «no puedo derivar» **no cierra**: la pregunta pasa a `CARRIED` con motivo (`FIXED_REPLY_ONLY` / `HANDOFF_UNAVAILABLE`).
3. Un mensaje humano cierra lo pendiente como `ANSWERED(STAFF)` (aproximación de la Fase 1) y pasa la palabra a la persona.
4. `HUMAN_RESUME` (manual) reabre lo `CARRIED(HUMAN_PAUSED)`.
5. Un objetivo se cumple cuando todas sus preguntas se cerraron; caduca tras 24 h sin actividad.
6. Eventos idempotentes por id; el reductor nunca muta el estado recibido.

## 3. Qué muestra el corpus real (simulación de un día, 58 conversaciones)

`npx tsx scripts/g7/phase1-replay.ts`:

| Medida | Valor |
| --- | --- |
| Peticiones registradas | 191 |
| Cerradas por el agente | 42 (supone que todo texto libre responde: optimista) |
| Cerradas por una persona | 84 (supone que su primer mensaje atiende lo pendiente) |
| Pendientes al final del día | 65 (34 %): 28 en espera por pausa humana · 11 por «no puedo derivar» · 8 solo con texto fijo · resto abiertas |
| Pendientes por tema | `OTHER` 30 · `MEDIA_DOCUMENT` 12 · `INFO_REQUEST` 8 · `MEDIA_IMAGE` 6 · `RECIPE_OR_QUOTE` 5 · `MEDICAL` 2 · `MEDIA_AUDIO` 2 |
| Alertas (pendiente ≥ 15 min) | **86 peticiones en 33 conversaciones**, 40 de ellas **mientras la palabra la tiene una persona** |
| Tamaño máximo de la cola simultánea | 10 |
| Tiempo hasta cerrar | mediana 0,8 min · p90 38 min |
| Violaciones de invariantes | 0 |

Lectura: la cola de pendientes habría puesto delante de la recepción exactamente lo que hoy se pierde (los 24 lotes sin atención de nadie y los documentos). **Carga estimada: ~86 alertas/día con umbral de 15 min** — el umbral debe fijarse con el responsable de recepción (con 30 min bajaría); la cola máxima simultánea fue 10, manejable. *Cautelas:* "OTHER" incluye mensajes que una persona vería como sociales (👍, "ok"); es una simulación de un día, no una medida de calidad.

## 4. Diseño de implementación (para cuando se apruebe tocar `src/`)

### 4.1 Eventos (los que el sistema ya genera)
| Evento | Dónde nace hoy | Nota |
| --- | --- | --- |
| `PATIENT_BATCH` | `processTurns` / `processContactBatch` tras claim del lote (`turns.ts`) | Ítems por reglas deterministas actuales (`classifyText`, `socialOf`, tipo de medio). Sin texto: `{messageId, topic, goal}` |
| `AGENT_REPLY` + calidad | `deliver()` tras `confirmSend` (`guarded-turn.ts`): `Produced.result`, `signature`, `generic` | `quality`: ANSWER · QUOTE · GENERIC · BLOCKED (se reconoce por `signature`/texto fijo, ya existe `GENERIC_PROMPTS`) |
| `HUMAN_MESSAGE` | `registerControlEvent` (`kapso-webhook.ts`) | Ya registra la pausa; se añade el evento |
| `HUMAN_RESUME` | acción `resume` del CRM (`crm-attention.ts`) | Manual |
| `ARTIFACT` | `imageProducer`/`sessionImageProducer` (ids de estudios, nº de no reconocidos) y cierre de cotización | Sin precios |
| `AGENT_WITHHELD` | `reply_withheld` (limited/blocked/audit) en `deliver()` | Cierra el hueco de «pregunta sin respuesta enviada» |

### 4.2 Almacenamiento (migración 24, aditiva; patrón de las migraciones 11/17/21)
```
plusmedik_conv_events (seq bigserial, contact_key text, event_key text UNIQUE, kind text, payload jsonb, at timestamptz)
    -- append-only; event_key = <messageId|runId>:<kind>:<n> → idempotente
plusmedik_conv_state  (contact_key text PK, version int, state jsonb, updated_at timestamptz)
    -- proyección reconstruible desde los eventos
RPC (SECURITY DEFINER, search_path vacío, solo service_role):
  plusmedik_conv_apply(p_run_id, p_owner, p_fence, p_events jsonb, p_expected_version int)   -- valida lease+fence como quote_begin; CAS por versión; idempotente por event_key
  plusmedik_conv_pending(p_min_age_seconds int, p_limit int)                                   -- lectura STABLE para el CRM (sin tocar tablas)
  plusmedik_conv_erase(p_contact_key text, p_reason text)                                      -- borrado por contacto (coherente con plusmedik_history_erase)
```
Sin teléfonos (solo `contact_key`), sin texto de mensajes, sin precios. Retención configurable (por defecto 30 días de eventos; estado de objetivos cerrados 30 días).

### 4.3 Etapas y banderas (todas apagadas por defecto, una por etapa)
| Etapa | Qué hace | Riesgo | Aceptación |
| --- | --- | --- | --- |
| **1a · escritura en sombra** `PLUSMEDIK_CONV_STATE=shadow` | Solo escribe eventos/estado; no cambia ninguna respuesta ni lectura | Mínimo (si falla se ignora, nunca bloquea un turno) | Respuestas idénticas con/sin bandera (como la prueba del historial); el estado coincide con el replay del corpus |
| **1b · lista de pendientes** `…=pending` + ruta `/api/internal/crm/pending` (token, patrón de `crm-attention`) | El CRM consulta las preguntas `OPEN/CARRIED` ≥ N minutos; sin contenido: `{contactKey→teléfono resuelto por el CRM, topic, since, reason}` | Bajo (solo lectura) | La recepción ve los 24 casos del corpus; sin PII nueva expuesta; el CRM la resuelve por `contact_key` |
| **1c · contexto del modelo** `…=context` | Amplía `ConversationContext` con `pendingTopics`, `recipeRead` (nº de estudios), `quotesIssued`; el modelo deja de decir «¿qué estudios necesitas?» si ya los recibió | Medio (cambia lo que el modelo ve) | Replay: menos respuestas genéricas ante objetivos persistentes (S03/S05/S16 de los escenarios) |
| **1d · aviso al reanudar** | Al ejecutarse `resume` en el CRM se lista lo pendiente al equipo (sin turno automático del agente) | Bajo | Manual como decidió |

### 4.4 Minimización de datos (decisión 1)
- Se guardan **ids, códigos y marcas de tiempo**. Nunca texto del paciente, precios, teléfonos ni nombres de estudios (solo ids de `lab_tests`).
- `topic` es un código cerrado (`HOURS`, `PAYMENT`, `PREPARATION`, `QUOTE_STUDIES`, `MEDIA_DOCUMENT`…).
- El texto íntegro sigue únicamente en `message_history` (ya existente); el estado lo referencia por `messageId`.
- Borrado por contacto y retención con tope; prueba automática «el estado no contiene texto/precios/teléfonos».

### 4.5 Concurrencia, idempotencia y pausa (invariantes que se conservan)
- Escritura de estado **solo con el lease+fence del turno** (si se pierde, no se escribe ni se envía).
- `event_key` único: un reintento de Kapso no duplica preguntas; control optimista por `version` con un reintento (reductor puro).
- Un fallo del estado **nunca** impide responder ni cambia la respuesta (mejor esfuerzo en sombra); no hay otra ruta de envío: la reserva, la pausa y la confirmación final siguen siendo las de `guarded-turn.ts`.
- La pausa humana sigue siendo `plusmedik_attention_contacts`; `holder` del estado es un *reflejo*, no la fuente de verdad.

## 5. Pruebas previstas
| Capa | Qué prueba | Estado |
| --- | --- | --- |
| Reductores puros | Propiedades (idempotencia, pureza, invariantes, ninguna pregunta se pierde) | **Hechas** (`tests/g7-phase1-state.test.ts`) |
| Replay del corpus | Volumen de pendientes/alertas; 0 violaciones | **Hecho** (`phase1-replay.ts`) |
| SQL real | `conv_apply` con lease perdido, fence viejo, versión obsoleta, `event_key` repetido; privilegios (sin acceso directo ni de `service_role` a las tablas); `pending` es `STABLE` y no bloquea | Por escribir con el patrón de `quote-shadow-peek-db.test.ts` |
| Extremo a extremo | Webhook real + PostgreSQL: lote de 3 preguntas → 3 `OPEN`; mensaje humano → `CARRIED`; `resume` → `OPEN`; respuestas idénticas con la bandera apagada/en sombra | Por escribir con el patrón de `tests/g7-instant-photo-in-batch.test.ts` |
| Privacidad | El estado y los eventos no contienen texto, precios ni teléfonos | Por escribir |
| Equivalencia | Con la bandera apagada: mismas respuestas, mismas llamadas a la base | Por escribir (como `batch-engine-wiring`) |

## 6. Riesgos
| Riesgo | Mitigación |
| --- | --- |
| Falsa sensación de atención (se cierra una pregunta que no se respondió bien) | La Fase 1 trata `ANSWER` como optimista y lo declara; la Fase 2 cierra con hechos verificados. Los textos fijos **no** cierran |
| Ruido para la recepción (demasiadas alertas) | Umbral configurable (15/30 min), agrupación por conversación, excluir lo social; medir con el corpus (86/día a 15 min) antes de activar |
| El CRM no puede mostrar la lista | Alternativa inmediata: archivo diario/hora de `history-export --gaps` + vista SQL de solo lectura |
| Divergencia con el estado real de la pausa | `holder` derivado de los eventos humanos; la fuente de verdad sigue siendo `attention_contacts` |
| Crecimiento de eventos | Retención y purga con función (como el historial) |

## 7. Plan mínimo de implementación (cuando apruebe tocar `src/`)
1. Mover `conversation-state.ts` a `src/` con las mismas pruebas (sin cambios de lógica).
2. Migración 24 y pruebas SQL; `src/conversation-state-store.ts` (cliente RPC con tiempos acotados, igual que `message-history`).
3. Cableado en sombra (1a) en `turns.ts`/`guarded-turn.ts`/`kapso-webhook.ts` con la prueba de equivalencia.
4. Ruta `/api/internal/crm/pending` y coordinación con el CRM (1b).
5. Contexto del modelo (1c) solo después de medir en replay.

Estimación relativa: 1 = S, 2 = M, 3 = M, 4 = M (depende del CRM), 5 = S.
