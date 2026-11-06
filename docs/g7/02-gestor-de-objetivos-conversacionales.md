# G7 · Gestor de objetivos conversacionales (diseño)

Estado: **diseño. No implementado.** Extiende el «Estado de Conversación» de [`00`](00-diagnostico-y-propuesta-conversacional.md) §7.2 y responde al pedido de recordar **intenciones, preguntas pendientes, recetas y cotizaciones**.

## 1. Propósito y principio

Hoy lo único que persiste de una conversación es la sesión de cotización (ids de estudios) y la última cotización (24 h). El gestor de objetivos (**GOM**, *Goal & Obligation Manager*) convierte el hilo en un conjunto pequeño de **entidades con ciclo de vida**: qué quiere el paciente, qué falta por contestar, qué documentos aportó y qué se le entregó. Es la memoria *estructurada* del agente; el texto íntegro sigue viviendo solo en `message_history`.

Principios:
1. **El estado lo escribe el código, el modelo propone.** El modelo emite `ops` tipadas; un validador las aplica o las rechaza. El modelo nunca escribe el estado directamente.
2. **Event-sourced.** Cada cambio es un evento inmutable; la proyección se puede reconstruir y reproducir (clave para replay).
3. **Mínimo necesario.** Ids, códigos y resúmenes cortos; jamás precios, teléfonos ni texto íntegro (ver `03` §3).
4. **Nada se pierde en silencio.** Toda pregunta nace `OPEN` y solo sale por un destino explícito.

## 2. Modelo de dominio

```
Conversación (contact_key)
 ├─ Goal[]        qué quiere lograr el paciente
 ├─ Question[]    cada pregunta o petición concreta, con su destino
 ├─ Artifact[]    Recipe (receta/foto/orden) · Quote (cotización emitida) · StaffNote (lo que dijo una persona)
 ├─ Commitment[]  lo que el agente dijo que haría (solo si está respaldado)
 └─ HumanLoop     estado de atención humana y resumen de la intervención
```

### 2.1 Goal
| Campo | Detalle |
| --- | --- |
| `id`, `kind` | `QUOTE` · `STUDY_INFO` (muestra/plazo/preparación de un estudio) · `LAB_INFO` (horarios, sucursales, pagos, políticas) · `RESULTS_FOLLOWUP` · `COMPLAINT` · `HUMAN_ATTENTION` · `SOCIAL` · `OTHER` |
| `status` | `ACTIVE` → `FULFILLED` · `ABANDONED` (el paciente cambió de tema/dijo que no) · `HANDED_OFF` · `EXPIRED` |
| `openedBy` | `messageId` que lo originó |
| `links` | `recipeIds[]`, `quoteIds[]`, `studyIds[]`, `sessionId?` (la sesión de cotización es el **mecanismo de ejecución** de un Goal `QUOTE`, no su dueño) |
| `confidence`, `source` | `EXPLICIT` (lo dijo) / `INFERRED` (el modelo lo deduce; no autoriza acciones irreversibles como cotizar por inferencia) |
| `ttl` | por tipo: `QUOTE` 24 h sin actividad antes de pasar a `EXPIRED`; `COMPLAINT` y `HUMAN_ATTENTION` no expiran sin cierre humano |

### 2.2 Question
Cada **enunciado** del lote (pregunta, petición o dato aportado que requiere reacción) recibe un `Question` con `id` estable (`hash(messageId, offset)`).
- `status`: `OPEN` → `ANSWERED` (con `factRefs`) · `HANDED_OFF` (con `caseId` registrado) · `CARRIED` (se pospone con motivo: pausa humana, espera de dato del paciente, tope) · `DROPPED` (motivo cerrado: saludo, eco, automático, retractado).
- `goalId` obligatorio (preguntas sueltas se agrupan en un Goal `OTHER`).
- `topic` (código cerrado), `askedAt`, `answeredAt`, `attempts`.
- **Invariante de cobertura:** al cerrar un turno no puede haber un `Question` creado en ese turno en `OPEN` sin destino.

### 2.3 Artifacts
- **Recipe** (`DocumentRecord`): `{mediaRef, hash, docType, recognized[{studyId, confidence}], unrecognized[{textSeen≤40, reason}], outcome, auditRunId}`. Se crea al terminar el análisis de la foto (el pipeline `analyzeImage` no cambia). Permite: «¿qué viste en mi receta?», «¿por qué falta X?», reenvío duplicado, y cotizar «lo de la receta de ayer».
- **Quote**: `{quoteId, studyIds[], catalogFingerprint, totalHash, issuedAt, sessionId}`. **Sin precios.** Para volver a mostrar una cotización, se re-materializa desde `quote_sessions` o se recalcula con el catálogo vigente y se avisa si cambió (huella distinta).
- **StaffNote**: resumen breve (≤300 car.) de lo que escribió una persona del equipo y cuándo; se genera al llegar el evento `business_app`.

### 2.4 Commitment
`{text≤120, kind, backedBy: caseId|quoteId|null}`. El verificador de salida rechaza cualquier frase que prometa a una persona o un resultado si no existe un `Commitment` con `backedBy` válido (generaliza la regla `HUMAN_PROMISE` actual).

### 2.5 HumanLoop
`{state: AGENT | HUMAN_ACTIVE | RESUMING, since, staffSummary, lastStaffAt, carried[]}`. Se sincroniza con la pausa existente (`plusmedik_attention_contacts`), que sigue siendo la fuente de verdad del permiso de envío.

## 3. Ciclo de vida en cada turno

```
gather      lee estado (versión v) + lote + ventana de historia + percepciones
extract     LLM → enunciados[] (cada uno con id, span, tipo)           ← sin escribir
plan        LLM → actos[] y stateOps[]                                  ← sin escribir
validate    cobertura: cada enunciado → acto | CARRIED | DROPPED        ← determinista
execute     herramientas (cotizar, conocimiento, derivar…) con el lease del turno
compose     LLM redacta; verificador comprueba procedencia/promesas
commit      aplica stateOps + eventos, con control optimista de versión y fence del lease
deliver     reserva/confirmación/envío (máquina existente)
```

Reglas:
- **Escritura sólo con lease+fence** del turno (misma garantía que `quoteBegin/Close`). Si el lease se pierde, no se escribe estado y no se envía.
- **Idempotencia:** clave de evento = `(contact_key, messageId|runId, opIndex)`; reprocesar el mismo mensaje no duplica goals, preguntas ni compromisos. Un `claim` ya existente no re-extrae.
- **Concurrencia entre lotes del mismo contacto:** el estado tiene `version`; el commit falla con conflicto si otro turno confirmó antes y reintenta una vez sobre el estado nuevo (los reductores son puros). Un turno cuyo envío quedó `superseded` **igualmente** commitea el estado (las preguntas se transfieren al turno más nuevo como `OPEN`, que las ve en su `gather`).
- **Orden:** los lotes se aplican por `turn_seq`; la reconstrucción desde eventos es determinista.

## 4. Operaciones (las únicas que el modelo puede proponer)

| Op | Efecto | Validación |
| --- | --- | --- |
| `openGoal{kind, source, links?}` | crea o reutiliza un Goal activo del mismo `kind` y estudios | dedupe por `kind`+`studyIds` |
| `updateGoal{id, status, reason}` | transiciones permitidas de la máquina de estados | rechaza `FULFILLED` de `QUOTE` sin `Quote` emitida; rechaza `INFERRED→cotizar` |
| `answerQuestion{qid, factRefs[]}` | `OPEN→ANSWERED` | `factRefs` deben existir en las herramientas ejecutadas **este turno** |
| `handoffQuestion{qid, reason}` | `OPEN→HANDED_OFF` | exige caso `REGISTERED` en el CRM (si no, queda `CARRIED` con motivo `HANDOFF_UNAVAILABLE`) |
| `carryQuestion{qid, reason}` | `OPEN→CARRIED` | motivo en lista cerrada |
| `dropQuestion{qid, reason}` | `OPEN→DROPPED` | motivo en lista cerrada; no aplica a lo médico/humano |
| `linkArtifact{goalId, artifactId}` | asocia receta/cotización | el artefacto debe existir y ser del mismo contacto |
| `addCommitment{...}` | registra compromiso | exige `backedBy` |

Lo **no** permitido al modelo: borrar eventos, editar precios, marcar `FULFILLED` un Goal de cotización sin cotización emitida, cerrar `HUMAN_ATTENTION`/`COMPLAINT`.

## 5. Casos que el diseño debe resolver

| Caso | Comportamiento esperado |
| --- | --- |
| «Quiero cotizar» y los estudios llegan en otro lote | `openGoal(QUOTE, EXPLICIT)` persiste; el siguiente lote lo continúa sin pedir de nuevo |
| 3 preguntas en un mismo mensaje (horario + preparación + precio) | 3 `Question`; todas con destino; la respuesta las atiende en orden o declara cuál queda pendiente |
| «¿y para mi esposa?» tras una cotización | correferencia: nuevo Goal `QUOTE` ligado al anterior (`relatedTo`), sin heredar los estudios (se preguntan) |
| Foto con 4 estudios, 1 ilegible | `Recipe` con `recognized[3]`, `unrecognized[1]`; respuesta menciona lo reconocido y pregunta específicamente por la línea no leída; el Goal `QUOTE` queda `ACTIVE` |
| Misma foto reenviada | detectada por `hash`; se responde referenciando la receta ya leída |
| «Ya no quiero» / cambia de tema | `updateGoal(ABANDONED)`; no se vuelve a cotizar por inferencia |
| Pregunta durante la pausa humana | se registra `Question` `CARRIED(HUMAN_PAUSED)`; al reanudar entra al turno de reanudación |
| El humano ya respondió la pregunta | `StaffNote` + el agente marca la pregunta `ANSWERED(by=STAFF)` y no la repite |
| Cotización de ayer y el catálogo cambió | se avisa que los precios se recalcularon (huella distinta); precios siempre del sistema |
| Mensaje automático/eco | `DROPPED(AUTOMATED)`; no crea goals |
| Texto médico | `Goal HUMAN_ATTENTION/MEDICAL` abierto por el **piso de seguridad**; el agente no da orientación; `HANDED_OFF` solo con caso registrado |

## 6. Interacción con componentes existentes

- **Sesiones de cotización:** se conservan sin cambios; el GOM crea/consulta la sesión vía las mismas herramientas. La sesión es detalle de ejecución del Goal `QUOTE`.
- **`conversation-memory` (mig. 17):** queda subsumida; mientras tanto convive (está apagada en producción).
- **`message-history`:** sigue siendo el registro íntegro; el GOM guarda referencias (`messageId`), no copias.
- **Control humano / CRM:** `HumanLoop` lee el estado; no lo modifica.
- **Reply guard y tope:** la firma de respuesta pasa a ser el conjunto de actos.

## 7. Persistencia (migraciones aditivas propuestas, 24+)

- `plusmedik_conversation_events(seq bigserial, contact_key, run_id, event_key unique, kind, payload jsonb, at)` — append-only.
- `plusmedik_conversation_state(contact_key pk, version int, state jsonb, updated_at)` — proyección.
- RPC `SECURITY DEFINER`, `search_path` vacío, solo `service_role`: `conv_state_read`, `conv_state_commit(expected_version, events[], run_id, lease)` (valida lease/fence igual que `quote_begin`), `conv_events_since`.
- Sin teléfonos (solo `contact_key`); retención configurable; borrado por contacto (`erase`) coherente con el del historial.
- Lectura de **solo lectura STABLE** para el modo sombra (patrón de la migración 20).

## 8. Reanudación humana (manual al inicio)

1. El humano escribe → pausa (existente) → se genera `StaffNote` y `HumanLoop.state=HUMAN_ACTIVE`.
2. Mensajes del paciente durante la pausa → `Question CARRIED(HUMAN_PAUSED)` (el texto íntegro ya está en `message_history`).
3. El CRM ejecuta `resume` → `HumanLoop.state=RESUMING`.
4. Siguiente mensaje (o un disparo manual) → **turno de reanudación:** el agente recibe `StaffNote`, preguntas `CARRIED` y objetivos activos; no repite lo que el humano ya dijo; no cotiza por inferencia en ese primer turno; si hay preguntas respondidas por el humano, las marca `ANSWERED(by=STAFF)`.
5. Disparo por inactividad del humano o proactivo (el agente escribe primero): **fuera de alcance** por ahora (decisión 4).

## 9. Riesgos específicos del GOM

| Riesgo | Mitigación |
| --- | --- |
| El modelo crea goals espurios o los cierra mal | Máquina de estados estricta; `INFERRED` no habilita acciones; métricas de precisión de goals en replay |
| Estado desactualizado tras cambios del catálogo | Solo ids + huella; precios siempre recalculados |
| Crecimiento del estado | Tope por entidades; archivado de goals cerrados a eventos; resúmenes ≤ N caracteres |
| Doble escritura en carreras | CAS por `version` + lease/fence; pruebas de concurrencia contra PostgreSQL real |
| Fuga de datos personales por resúmenes | Saneamiento previo, límites de longitud, lista de campos permitidos, pruebas de "no PII" sobre el estado |
| Complejidad de cobertura | El invariante de cobertura se prueba por propiedad (ningún lote termina con `OPEN` sin destino) |

## 10. Pruebas del GOM (previstas)

- **Unitarias/propiedad:** reductores puros (idempotencia por `event_key`; reconstrucción = proyección; transiciones inválidas rechazadas).
- **Base real:** `conv_state_commit` con lease perdido, versión obsoleta, reintento; privilegios; `STABLE` en la lectura de sombra.
- **Conversacionales (replay):** cada caso del §5 como escenario con aserciones sobre estado final y respuesta.
- **Adversariales:** inyección en `summary`, ids de otro contacto, goals duplicados, mensajes fuera de orden, reenvíos.
