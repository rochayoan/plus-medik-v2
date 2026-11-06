# G7 · Diagnóstico arquitectónico y propuesta de agente conversacional

Estado: **solo diagnóstico y propuesta. No se implementó nada, no hay commits, push ni deploy.**
Base analizada: rama `feat/history-contact-phone` (commit `6faeeff`), ~18 000 líneas en `src/`, 146 archivos de prueba.

## 0. Alcance y límites de este análisis

- Todo lo afirmado sale de leer el código y los docs `g0`–`g6`. **No ejecuté pruebas ni llamé a ningún servicio.**
- **No tuve acceso a la auditoría de los 469 mensajes.** Por eso la sección 4 (respuestas genéricas) explica *mecanismos estructurales* que producen esos síntomas; falta confirmar cuál pesó más en cada caso con las trazas reales (Fase 0).
- **No conozco las variables de entorno de producción.** Casi todo el comportamiento depende de banderas (`PLUSMEDIK_LLM_CONVERSATION`, `PLUSMEDIK_CONVERSATION_MEMORY`, `PLUSMEDIK_BATCH_ENGINE`, `PLUSMEDIK_ATTENTION_FILTER`, `PLUSMEDIK_DAILY_REPLY_CAP`, `PLUSMEDIK_INSTANT_PHOTO_QUOTES`…). Hay que confirmar cuáles están en `on`; cambia qué parte del diagnóstico aplica (ver §9, preguntas abiertas).

## 1. Resumen ejecutivo

**El sistema es un procesador transaccional muy seguro con enrutamiento por expresiones regulares; el modelo de lenguaje es un componente periférico, sin contexto y con poca autoridad.**

- La *seguridad operativa* (idempotencia, turnos, leases, pausa humana, precios del catálogo) está muy bien resuelta y es el activo más valioso. Se conserva íntegra.
- La *inteligencia conversacional* es estructuralmente imposible con el diseño actual, por cuatro razones que no se arreglan con prompts ni con más reglas:
  1. **El enrutamiento decide antes de entender.** Una cascada de regex (`MEDICAL > HUMAN > INFO > RECIPE`, primera coincidencia gana) elige el camino; el modelo solo se consulta si ninguna regla reclamó el mensaje.
  2. **No existe estado conversacional como entidad.** Lo único persistente es la *sesión de cotización* (ids de estudios) y la última cotización (24 h). No hay objetivos, preguntas pendientes, documentos leídos ni compromisos.
  3. **Cuando el modelo participa, es ciego y está amordazado:** ve un solo mensaje (truncado a 500 caracteres), sin fotos, sin cotizaciones, con "historial" desactivado por defecto y que además excluye justo los mensajes sobre estudios; y su salida pasa por un filtro *léxico* que descarta cualquier cifra u hora y la reemplaza por un texto fijo genérico.
  4. **No hay contabilidad de preguntas.** Un mensaje con varias preguntas se re-clasifica como un solo bloque y gana una categoría; nada garantiza (ni registra) que cada pregunta se respondió o quedó pendiente.
- **Recomendación:** *núcleo agéntico dentro de una carcasa determinista* (Alternativa C, §6). El modelo comprende, planifica y redacta; el código es dueño de la verdad (catálogo, precios, conocimiento aprobado), de los permisos (pausa, derivación, tope) y de la verificación de cada afirmación. Se introduce un **Estado de Conversación persistente** (event-sourced) y una **capa de herramientas con procedencia**. Se migra por fases, con *shadow* y *replay* antes de enviar un solo mensaje distinto a un paciente.

## 2. Ciclo de vida completo de un mensaje (Pregunta 1)

```
Kapso ─POST (lote de 15 s)─► api/kapso/webhook.ts → handleKapsoWebhook (src/kapso-webhook.ts)
  1. Verifica firma HMAC (401 si falla) · clasifica cada evento (human-control.ts: PATIENT / BOT / HUMAN_BUSINESS_APP / STATUS…)
  2. history.observe() en segundo plano (guarda TODO: entrantes, humano, estados) — no influye en decisiones
  3. Eventos HUMANOS (business_app): se registran ANTES del 200 (registerHumanMessage → pausa). Si falla: 503 y Kapso reintenta
  4. extractIncomingTurns (turns.ts): solo "received", sin history_sync, antigüedad ≤ 600 s; filtra ALLOWED_PHONES;
     separa piloto vs. ruta anterior de fotos (puerta del piloto)
  5. 200 inmediato + waitUntil(processTurns)  ← política de ACK: el trabajo corre en segundo plano (maxDuration 300 s)

processTurns (src/turns.ts)
  6. producerFor(turn): IMAGE→sessionImageProducer · TEXT→sessionTextProducer(+handler) · AUDIO→transcribe→TEXT · OTHER→aviso
  7. Filtro de repetición literal (attention-filter, en memoria de la instancia, ventana 90 s)
  8. CLAIMS secuenciales, en orden de llegada (guarded-turn.beginTurn → RPC plusmedik_audit_claim):
       · contacto en HUMAN_PAUSED → 'paused' (se registra PATIENT_SUPPRESSED, SIN contenido, y el mensaje se descarta)
       · lease + fence + número de turno por contacto; duplicado → ignorado; en vuelo en otra ejecución → cede el lote
  9. Un mensaje por contacto → run(producer). Varios → processContactBatch:
       · modo legado: cada unidad produce su respuesta; el último turno las integra (mergeProduced) en UN mensaje
       · modo motor (PLUSMEDIK_BATCH_ENGINE=on): comprender lote → decidir (tabla pura) → ejecutar → componer (batch-*.ts)
 10. Productor de texto (quote-session-turns.sessionTextProducer), en este orden:
       comando (listo/cancelar) → classifyText ∈ {MEDICAL,HUMAN,INFO,GREETING} ⇒ handler →
       pregunta de información ⇒ handler → respuesta de sesión (sí/no/2) → pregunta general ⇒ handler →
       extractStudyRequests contra catálogo (+ intérprete LLM opcional) → anota en sesión → acuse/pregunta/cotiza →
       si no extrajo estudios ⇒ handler (text-handler.ts)
 11. Handler de texto (text-handler.createTextHandler): loop-guard → classifyText → atención selectiva →
       route(): negocio (LLM opcional) → conocimiento aprobado (determinista) → baseReply():
         MEDICAL/HUMAN/INFO ⇒ derivación CRM o texto fijo · GREETING/OTHER/RECIPE ⇒ LLM (si está activo y es "charla") ⇒ texto fijo
 12. deliver (guarded-turn.deliver): reserveSend (busy/superseded/tope diario/guarda antibucles, atómico en la base) →
       confirmSend (re-chequea pausa) → sendText (Kapso) → recordReply → memory.rememberReply → history.recordAgentReply
```

Puntos relevantes: (a) **una corrida = una reserva = un `sendText` con un solo `body`**; (b) la respuesta de un turno puede descartarse como obsoleta (`stale: NEWER_TURN`); (c) los estados en memoria de proceso (`ReplyGate`, `RepeatTracker`, circuito del modelo) son "mejor esfuerzo" en serverless.

## 3. Quién hace qué (Pregunta 2)

| Función | Componentes actuales | Naturaleza |
| --- | --- | --- |
| **Clasificación** | `text-handler.classifyText` (regex), `attention-filter.socialOf` (vocabulario cerrado), `quote-session.parseSessionCommand/Reply/isGeneralQuestion/wantsQuoteNow`, `knowledge-answers.detectTopics` (regex), `batch-understanding` (léxico + negación), `conversation-model` (etiqueta de intención del LLM) | 90 % reglas léxicas |
| **Razonamiento** | Prácticamente ninguno. LLM de conversación (un mensaje, ≤300 tokens de salida), `study-interpreter` (solo nombres de estudios), `batch-understanding` con modelo "cuando hace falta" (solo estudios/intención) | marginal |
| **Memoria** | `plusmedik_quote_sessions` (ids de estudios, TTL), `quoteLastStudies` (24 h), `conversation-memory` (opcional, apagada por defecto), `message-history` (auditoría; **no se lee para decidir**) | fragmentada |
| **Coordinación** | `audit.ts` + migraciones 1-19: claim/lease/fence, `turn_seq`, `reserve_send` (busy/superseded/cap/guard), `deferClosing`/`absorb`/`foldTurn` para lotes | **sólida** |
| **Cotización** | `quote-session.evaluateSession/formatSessionQuote` + `lab_tests` recargado al cerrar; verificación en la base de que lo cotizado = lo identificado | **sólida** |
| **Visión** | `analyze.ts` (2 lectores + juez + catálogo + safety), `partial-auto`, `visual-risk`; `sessionImageProducer` lo reduce a `ItemResult` (ids) | potente pero aislado |
| **Derivación / atención humana** | `human-control` (pausa por mensaje humano), `crm-attention` (pausa/reanuda desde CRM), `crm-outbox` (cola idempotente; solo se confirma al paciente si el CRM registró) | **sólida** |

## 4. Por qué aparecen respuestas genéricas ante preguntas concretas (Pregunta 4)

Todas las salidas genéricas son textos fijos (`DRAFT_TEXTS.greeting / send_recipe / fallback`, `text-handler.ts:73-81`). Se llega a ellos por estos mecanismos (cada uno verificado en código):

1. **La regex decide antes de entender** (`text-handler.ts:28-56`). Palabras como *resultado, seguro, pago, sábado, domingo, estudio, análisis, examen, laboratorio* disparan `INFO_REQUEST` o `RECIPE_OR_QUOTE` aunque el mensaje sea otra cosa («estoy seguro de que…», «mi resultado ya salió, ¿qué hago?»). Primera coincidencia gana: un mensaje con una consulta médica y una de horario es solo `MEDICAL`.
2. **El LLM solo atiende "charla".** `baseReply` lo consulta únicamente si la categoría es `GREETING/OTHER/RECIPE_OR_QUOTE` **y** `isPlainTalk` (el texto no menciona precio ni temas clínicos) (`text-handler.ts:206`). Todo lo operativo (INFO, precio, plazo, muestra, preparación) nunca llega al modelo.
3. **Cuando no hay dato aprobado, el resultado es "no tengo el dato" o derivación**, no una respuesta útil. Esto es correcto por seguridad, pero sin *razonar sobre qué sí puede hacerse* (p. ej. ofrecer cotizar, pedir el estudio, explicar el siguiente paso) se percibe genérico.
4. **El LLM ve un mensaje truncado y sin contexto:** `sanitizeForModel` corta a **500 caracteres** y reemplaza números de ≥4 dígitos por `[número]` (`conversation-model.ts:57-69, 255`); el prompt dice literalmente *"No tienes el historial de la conversación"* (`system-prompt.ts:48`). Un mensaje largo con tres preguntas pierde la tercera antes de llegar al modelo.
5. **El historial, cuando se activa, excluye lo importante.** `storablePatientText` descarta todo mensaje que `classifyText` etiquete `RECIPE_OR_QUOTE` o `MEDICAL` (`conversation-memory.ts:79-84`); como esa regex incluye *estudio, análisis, examen, receta, laboratorio, precio*, **la memoria casi no conserva los mensajes relevantes del laboratorio**. Además: 5 mensajes, 300 caracteres cada uno, 7 días, y solo funciona si `PLUSMEDIK_LLM_CONVERSATION=on` **y** `PLUSMEDIK_CONVERSATION_MEMORY=on`. El rol `STAFF` existe en el tipo (`conversation-model.ts:192`) pero **nada lo alimenta**.
6. **El filtro de salida es léxico, no por procedencia** (`guardModelReply`, `conversation-model.ts:122-162`): sin datos de negocio rechaza *cualquier* cifra, "hoy", "mañana", "pronto", "horas", "resultado", "pago"… y con datos solo permite palabras presentes en un bloque estático. Una respuesta correcta y útil que contenga «en unas 2 horas» o «hoy» se descarta y se envía el texto fijo. Tope: 400 caracteres.
7. **El estado que ve el modelo son tres contadores** (`ConversationContext`: solicitud abierta, estudios, duda, cotización reciente). No ve nombres de estudios, ni la foto, ni qué se cotizó, ni qué preguntó antes.
8. **Elisión en lote:** `mergeProduced` (`turn-batch.ts:75-128`) descarta respuestas "genéricas" (detectadas por igualdad exacta de texto, `turns.ts:168`) y acuses de sesión si hay algo "más concreto", y recorta mensajes a 3 900 caracteres descartando lo que no sea cotización. Es una heurística sobre cadenas ya redactadas; no sabe qué pregunta se está dejando sin contestar.
9. **Confianza en el silencio:** la atención selectiva y `PLUSMEDIK_LLM_SILENCE_OFF_TOPIC` pueden callar un mensaje; el propio `RepeatTracker` ignora una repetición literal dentro de 90 s (un paciente que reenvía porque no le contestaron).

Diagnóstico: no es un problema de *prompt*; es que **el sistema no le entrega al único componente que puede razonar ni el contexto ni la autoridad para hacerlo**.

## 5. Intenciones, objetivos y continuidad (Preguntas 3, 5, 6, 7)

### 5.1 Intenciones y objetivos del paciente (P3)

- No hay entidad "objetivo". La *intención de cotizar* se infiere por léxico (`wantsQuoteNow`: `ASKS_FOR` sin `ADDING`) **por lote** y no se recuerda entre lotes. `docs/g6/02` lo admite: *«La intención no se recuerda entre lotes: "quiero cotizar" en un lote y los estudios en el siguiente se tratan por separado»*.
- Tras cotizar, la sesión se cierra; «y TSH» abre una solicitud nueva. Lo que la conversación "sabe" después es `quoteLastStudies` (ids, 24 h).

### 5.2 Varias preguntas en un lote (P5)

- **Modo legado:** cada texto es su propia unidad; las respuestas se unen con `mergeProduced` (elisión heurística, §4.8).
- **Modo motor (`on`):** `batch-understanding` separa fragmentos en seguridad / estudios / preguntas / charla (bien diseñado: la seguridad nunca se pierde). Pero **todas las preguntas delegadas se concatenan en un solo texto** (`batch-engine.ts:104`: `turns.map(t => t.text).join("\n")`) y se re-clasifican como UNA (`classifyText` → una categoría). `answerFromKnowledge` atiende hasta `MAX_TOPICS = 3` temas detectados por regex; una pregunta que no case con ningún tema se pierde.
- **No hay libro de preguntas:** nada registra "pregunta X: respondida / derivada / pendiente". Si una respuesta se descarta por `NEWER_TURN`, el límite de 3 900 caracteres o el tope diario, la pregunta desaparece sin dejar rastro.

### 5.3 Fotos, estudios reconocidos, cotizaciones, preguntas pendientes (P6)

| Dato | Dónde vive hoy | ¿Lo ve la capa conversacional? |
| --- | --- | --- |
| Foto de receta | Se analiza (`analyzeImage`), se reduce a `ItemResult` {status, studyIds…}; la evidencia completa va a la auditoría (`recordEvidence`) | **No** |
| Estudios reconocidos / no reconocidos de la foto | ids en la sesión; lo "dudoso" como contadores; las líneas ilegibles no se conservan como texto | Solo contadores |
| Cotización emitida | `plusmedik_quote_sessions` (líneas, total) + `quoteLastStudies` (ids, 24 h) | Un número ("cotización reciente de N estudios") |
| Preguntas pendientes | **No existen**; solo `pendingGroups` de ambigüedad de estudios | — |
| Compromisos del agente ("te aviso…") | **No existen**; solo el texto enviado en `message_history` | — |

### 5.4 Retomar tras intervención humana (P7)

- Mensaje humano `business_app` → `registerHumanMessage` → `HUMAN_PAUSED`. Reanudar es **manual** (CRM `resume`). Mientras está pausado, **el mensaje del paciente se descarta** (`claim → 'paused'`, `PATIENT_SUPPRESSED` sin contenido; migración 5, `20261024…human_control.sql:199`). No hay cola: al reanudar, nadie sabe qué preguntó el paciente durante la pausa.
- Lo que escribió el humano se guarda en `message_history` (actor `HUMAN`), pero **el agente no lo lee**. Al reanudar, el modelo no sabe qué se le respondió al paciente, ni qué quedó resuelto.
- La sesión de cotización puede seguir "abierta" por su TTL aunque el humano ya cotizó por otra vía.

## 6. Alternativas arquitectónicas (Preguntas 8 y 9)

### A. Evolutiva: ampliar el uso periférico del LLM
Encender memoria, habilitar `RECIPE_OR_QUOTE`, subir `maxInputChars`, relajar el filtro, más reglas.
- **Pro:** casi sin código; riesgo bajo; reversible por bandera.
- **Contra:** techo bajo. Mantiene el enrutamiento regex-primero, sin estado, sin libro de preguntas. Cada caso nuevo exige otra regla (justo lo que no se quiere). **No recomendada** como solución; sí útil como *línea base medible* (Fase 0).

### B. LLM como parser, código como decisor (extender `batch-*`)
Reemplazar el léxico de `batch-understanding` por una comprensión semántica estructurada (segmentación en enunciados, intenciones múltiples, correferencias) que alimenta la tabla pura de `batch-policy`.
- **Pro:** reutiliza el motor de lotes ya probado (shadow, respaldo, invariantes); decisión 100 % determinista y auditable.
- **Contra:** la política sigue siendo una tabla cerrada: la conversación solo puede hacer lo que la tabla prevé (SUMMARY, CLARIFY, QUOTE…). No resuelve el estado persistente, la memoria de documentos ni la reanudación; la respuesta final seguiría siendo plantillas.

### C. Núcleo agéntico en carcasa determinista (recomendada)
El modelo **comprende, planifica y redacta** sobre un **Estado de Conversación persistente** y **herramientas tipadas con procedencia**; el código **valida el plan, ejecuta las herramientas, verifica cada afirmación y entrega** por la máquina de seguridad existente.
- **Pro:** resuelve las 4 causas raíz (§1); capacidades futuras = nuevas herramientas, no nuevas regex; conserva todos los invariantes porque la carcasa de entrega/coordinación no cambia.
- **Contra:** más superficie nueva (estado, herramientas, verificador, evaluación); exige un arnés de replay serio; latencia mayor por turno (hay margen: `maxDuration 300 s`, y el paciente espera un lote de 15 s de todos modos).

### D. LLM dueño de todo (incluido envío y precios)
**Descartada.** Viola precios solo del sistema autorizado, derivación confirmada solo con registro en el CRM y la pausa humana.

### Reparto de responsabilidades (P9)

| Decide el **código** (no negociable) | Decide el **modelo** (con validación) |
| --- | --- |
| Idempotencia, claims, leases, fencing, orden de turnos, un envío en vuelo | Entender el lote: segmentar enunciados, intención(es), correferencias («eso», «la anterior», «y para mi esposa») |
| Pausa humana (claim + reserva + confirmación final) | Elegir qué herramientas usar y en qué orden; qué preguntar y qué responder primero |
| **Precios, líneas, totales** (`evaluateSession` + `lab_tests` recargado) | Proponer *candidatos* de estudios (el catálogo valida por id) |
| Contenido aprobado: horarios, sucursales, pagos, políticas, preparación, muestra, plazos (servicios de conocimiento) | Redactar el texto final, tono, orden, brevedad; unir varias respuestas en un mensaje natural |
| Piso de seguridad médica y de pedir persona (regex **se mantiene como piso**; el modelo solo puede *agregar* alertas) | Resumir el caso para el humano; redactar el aviso sin dar orientación médica |
| Registro de derivación y regla "solo se promete persona si el CRM lo registró" | Decidir *cuándo* conviene derivar (propone; el código ejecuta) |
| Tope/antibucles, longitud, idioma, formato, privacidad (saneamiento) | Proponer silencio ante lo ajeno (el código lo confirma con el estado) |
| Validación de procedencia de **cada** cifra/hora/URL/teléfono/precio de la respuesta | Reintentar una vez la redacción cuando el verificador la rechaza |

## 7. Propuesta recomendada: "Agente con carcasa determinista"

### 7.1 Vista de capas

```
┌─ CARCASA DE ENTRADA (reutilizar) ─ webhook · firma · clasificación de eventos · claim/lease/fence · pausa · ACK · idempotencia
│
├─ PERCEPCIÓN ─ texto · transcripción de audio · foto → DocumentRecord (vía analyzeImage, sin cambiarlo) · mensajes del humano
│
├─ ESTADO DE CONVERSACIÓN (nuevo, persistente, event-sourced)
│     objetivos · libro de preguntas · documentos leídos · cotizaciones emitidas (id+hash, sin precios) · compromisos · bucle humano
│
├─ PISO DE SEGURIDAD (determinista, reutilizar regex) ─ médico / pedir persona / automático / eco  → solo puede ELEVAR, nunca bajar
│
├─ AGENTE (nuevo)  1) Comprender: enunciados[] con id   2) Planificar: actos[] cubriendo TODOS los enunciados
│                  3) Ejecutar herramientas (determinista)   4) Redactar con referencias a hechos   5) Verificar (+1 reparación)
│
├─ HERRAMIENTAS (envolver lo existente; cada resultado = Hecho con procedencia)
│     buscar_estudio · cotizar (sesión+evaluateSession) · conocimiento (horarios/pagos/…) · datos_de_estudio (muestra/plazo/prep)
│     leer_documento · estado_de_conversación · derivar_a_humano (CRM outbox) · historial_reciente
│
├─ VERIFICADOR DE SALIDA (nuevo, reemplaza el filtro léxico) ─ procedencia de cifras/precios/horas/enlaces · sin consejo médico · sin promesas sin registro
│
└─ CARCASA DE SALIDA (reutilizar) ─ Produced → reserveSend → confirmSend → Kapso → recordReply → historia · reductores actualizan el estado
```

### 7.2 Estado de Conversación (el cambio estructural principal)

Dos tablas nuevas (migraciones 24+, aditivas, mismo patrón de `SECURITY DEFINER` + `search_path` vacío + solo `service_role`):

- `plusmedik_conversation_events` (append-only): `seq`, `contact_key`, `run_id`, `kind`, `payload jsonb`, `at`. Fuente de verdad y base del **replay**.
- `plusmedik_conversation_state` (proyección por contacto, `version` optimista): se reconstruye con reductores puros a partir de los eventos.

Contenido del estado (esquema orientativo):

| Campo | Qué guarda | Notas |
| --- | --- | --- |
| `goals[]` | `{id, kind: QUOTE\|INFO\|RESULTS\|COMPLAINT\|OTHER, status, openedBy, studyIds?}` | Persisten entre lotes (resuelve «quiero cotizar» + estudios después) |
| `openQuestions[]` | `{id, fromMsg, topic, text(saneado), status: OPEN\|ANSWERED\|HANDED_OFF\|DROPPED, answeredBy: factRefs}` | **Invariante de cobertura** (§7.3) |
| `documents[]` | `DocumentRecord`: `{mediaRef, hash, docType, recognized[{studyId,textSeen,confidence}], unrecognized[{textSeen,reason}], outcome, auditRunId}` | Lo que la foto dijo, accesible al agente |
| `quotes[]` | `{quoteId, studyIds, catalogFingerprint, totalHash, issuedAt}` | **Nunca precios**: se rehidratan del sistema autorizado |
| `commitments[]` | Lo que el agente prometió y su respaldo (`handoffCaseId`) | Habilita la regla "no prometer sin registro" |
| `humanLoop` | `{state, since, staffSummary, lastStaffAt, sinceResume[]}` | Para reanudar (§7.5) |

El modelo **propone** actualizaciones (`stateOps`); un validador de esquema las aplica solo si son coherentes. Las escrituras de estado ocurren dentro del lease del turno (misma garantía de fence que las sesiones de cotización).

### 7.3 Invariantes nuevos (verificados por código, no por prompt)

1. **Cobertura:** cada enunciado extraído del lote termina en exactamente un destino: `ANSWERED` (con hechos), `HANDED_OFF` (con caso registrado), `CARRIED` (queda en `openQuestions`, con motivo) o `IGNORED` (con razón cerrada: saludo, eco, automático). Un plan que no cubra todos los ids se rechaza.
2. **Procedencia:** toda cifra, moneda, hora, URL, teléfono o nombre de estudio con precio en el texto final debe coincidir con un `Hecho` devuelto por una herramienta *en este turno*. Los bloques de cotización se **inyectan por referencia** (`{{quote:id}}` → `formatSessionQuote`): el modelo nunca escribe un precio.
3. **Promesas:** "una persona te escribirá" solo si hay `commitment` respaldado por `REGISTERED` en el CRM (generaliza la regla actual `HUMAN_PROMISE`).
4. **Piso de seguridad:** la unión (regex ∪ modelo) decide; el modelo nunca baja un MEDICAL/HUMAN detectado por regla.
5. **Degradación contextual:** si el agente falla, la respuesta se arma desde los *actos* ya validados (conocimiento verbatim, bloque de cotización, pregunta de aclaración específica); el texto genérico solo se usa si no hay ningún acto, y se registra como `degraded`.

### 7.4 Flujo de un turno (sustituye el productor de texto + handler)

```
claim (igual) → pausa (igual) → reunir: lote ordenado + estado + ventana de historia (incl. mensajes del humano) + percepciones
  → piso de seguridad → COMPRENDER (LLM, salida estructurada: enunciados[]) → PLANIFICAR (LLM: actos[] con herramientas)
  → validar plan (esquema, cobertura, ids de catálogo, permisos) → EJECUTAR herramientas (determinista; todas escriben con el lease)
  → REDACTAR (LLM con hechos y referencias) → VERIFICAR (procedencia, seguridad, promesas) → [1 reparación] → Produced
  → reserva/confirmación/envío (igual) → reductores: eventos + proyección de estado
```

Se mantiene una **canalización acotada y fija** (comprender → planificar → ejecutar → redactar → verificar), no un bucle ReAct libre: es auditable, reproducible en replay y con costo/latencia predecibles. Un bucle de herramientas acotado puede añadirse dentro del paso "planificar" en una fase posterior.

### 7.5 Reanudar tras intervención humana

- La pausa y la reanudación **no cambian** (siguen siendo estado del CRM/base).
- **Cambia lo que ocurre durante y después:** (1) los mensajes del humano alimentan `humanLoop` (`staffSummary`, `lastStaffAt`); (2) los mensajes del paciente durante la pausa se anotan como enunciados `CARRIED_BY_PAUSE` (el contenido ya está en `message_history`; hoy solo se pierde la *referencia*, no el texto); (3) al reanudar, el primer turno es un **turno de reanudación**: el agente recibe el resumen del humano y el libro de preguntas, **no repite** lo que el humano ya dijo, solo retoma lo abierto, y el verificador es más estricto (sin cotizar por inferencia en ese primer turno).
- Requiere un RPC interno de lectura reciente del historial (hoy solo existe `plusmedik_history_export` con motivo y rastro, pensado para humanos).

### 7.6 Qué hacer con las protecciones existentes

| Protección | Destino |
| --- | --- |
| Tope de 5 respuestas / 24 h (`daily-reply-cap`) | **Requiere decisión del dueño** (§9). Un agente resolutivo que unifica en un mensaje por lote sigue conviviendo con él, pero un tope por conteo choca con "resolver". Alternativa: tope por *bucle/ráfaga* y por costo, no por conteo |
| Guarda antibucles (`reply-guard`: firma repetida, ráfaga) | Reutilizar; la firma pasa a ser el conjunto de actos |
| Filtro léxico de salida | Reemplazar por el verificador de procedencia (más permisivo en lo legítimo, más estricto en lo inventado) |
| `mergeProduced`, `text-fragments`, marca `generic` | Se retiran cuando el agente cubra el lote (ya previsto en `g6/02`) |
| `attention-filter` (silencio social) | Se conserva como pre-filtro barato; el silencio "ajeno" pasa a ser decisión del agente confirmada por el estado |
| Memoria conversacional (migración 17) | Se subsume en `conversation_events`; se redefine la política de qué se guarda (ver §9, privacidad) |

## 8. Plan por fases: reutilizar / refactorizar / incorporar

### Fase 0 — Medición y línea base *(sin cambio de comportamiento)*
- Exportar los 469 mensajes (`scripts/history-export.ts`), **etiquetar** cada falla por clase (continuidad, genérica, receta, pendiente, operativa, humano) y fijar métricas objetivo.
- **Incorporar:** arnés de replay sobre el sistema *actual* (§10) → medir la línea base; traza de decisión por turno (códigos + referencias a ids, no texto adicional).
- **Reutilizar:** `history-export`, infraestructura de pruebas (PostgreSQL efímero, `offline`, `faults`), patrón shadow.
- *Salida:* informe "qué pasa hoy" con porcentajes por causa raíz. **Esto decide el orden de las fases siguientes.**

### Fase 1 — Estado de Conversación (solo escritura/lectura en sombra)
- **Incorporar:** migraciones 24+ (`events`, `state`), reductores puros, `DocumentRecord` al terminar una foto, ingesta de mensajes del humano, RPC interno de historial reciente.
- **Refactorizar:** `sessionImageProducer` y el cierre de cotización emiten eventos (sin cambiar su respuesta); `conversation-memory` pasa a leer del nuevo almacén.
- **Aceptación:** con la bandera apagada nada cambia (misma prueba de equivalencia que ya existe para el historial); con ella, el estado reconstruido desde eventos coincide con el de los reductores.

### Fase 2 — Capa de herramientas + verificador de procedencia *(refactor sin cambio visible)*
- **Refactorizar:** exponer como herramientas tipadas lo que ya existe: `answerFromKnowledge`, `StudyFactsService`, `extractStudyRequests`/`optionsOf`, `quoteBegin/Read/Close`, `evaluateSession`, `crm.submit`. Cada una devuelve `Hecho{id, kind, valor, procedencia}`.
- **Incorporar:** verificador de salida por procedencia; el flujo legado puede usarlo ya (reemplaza `guardModelReply`) para eliminar rechazos falsos.
- **Reutilizar:** todo el código de negocio actual; solo cambia el contrato de entrada/salida.

### Fase 3 — Agente en sombra
- **Incorporar:** comprender/planificar/redactar/verificar. Corre en paralelo a la ruta actual, **sin enviar ni escribir estado propio** (misma garantía "STABLE/solo lectura" del modo sombra del motor de lotes) y deja la decisión en la traza.
- Comparar con la ruta real en replay y en producción real (solo códigos). Iterar prompts, esquema y herramientas hasta cumplir métricas.
- **Aceptación:** 0 violaciones de invariantes en el corpus de replay; métricas de cobertura y genéricas mejores que la línea base.

### Fase 4 — Activación controlada
- Piloto por contacto (la puerta del piloto ya existe) → porcentaje creciente. El agente atiende conversación/información/aclaración; **las cotizaciones se siguen ejecutando por las herramientas** (precio = catálogo). Respaldo a la ruta anterior si el agente falla *antes* de escribir (mismo patrón que `batch_engine_fallback`).
- **Aceptación:** sin regresiones de seguridad; revisión humana de una muestra de conversaciones; interruptor de apagado inmediato por bandera.

### Fase 5 — Reanudación humana, mensajes múltiples y retiro de legado
- Turno de reanudación (§7.5); salida en varias partes si conviene (requiere extender `Produced`/la reserva de envío, hoy 1 corrida = 1 cuerpo); revisar tope diario; retirar `text-fragments`, `mergeProduced`, `generic`, clasificación regex como enrutador (queda como piso de seguridad).

### Fase 6 — Optimización económica *(etapa posterior que usted anunció)*
- Enrutamiento por modelo/tamaño, caché de percepción, recorte de contexto, ahorro de llamadas. Se diseñó para que sea posible sin rehacer: la canalización fija permite sustituir un paso por un modelo más barato.

### Resumen reutilizar / refactorizar / incorporar

| Reutilizar tal cual | Refactorizar | Incorporar |
| --- | --- | --- |
| `webhook.ts`, `kapso-webhook.ts` (firma, ACK, eventos) | `text-handler.ts` (separar piso de seguridad de respuesta) | Estado de conversación + eventos + reductores |
| `guarded-turn.ts` + `audit.ts` (claim/lease/reserva/envío) | `conversation-model.ts` (filtro → verificador; contexto real) | `DocumentRecord`, libro de preguntas, compromisos |
| `human-control`, `crm-attention`, `crm-outbox` | `conversation-memory.ts` (política de guardado; fuente única) | Capa de herramientas con procedencia |
| `quote-session` (evaluación y formato) y verificación en la base | `batch-understanding/policy` (pasan a validar/ejecutar el plan) | Agente: comprender/planificar/redactar/verificar |
| `knowledge/`, `study-facts/`, `analyze.ts` (como herramientas/percepción) | `turns.ts#processContactBatch` (un solo camino + respaldo) | Turno de reanudación humana |
| `reply-guard`, `message-history`, `offline.ts`, PostgreSQL efímero | `daily-reply-cap` (semántica) | Arnés de replay + evaluación + traza de decisión |

## 9. Riesgos y decisiones que requieren al dueño

### Riesgos técnicos
| Riesgo | Mitigación |
| --- | --- |
| **Alucinación de datos** (precio, horario, promesa) | Procedencia obligatoria; bloques inyectados por referencia; modelo sin escritura de cifras; pruebas adversariales |
| **Inyección de prompt** (texto del paciente, foto, historial) | Entradas como datos delimitados; el modelo no ejecuta, solo propone; todo plan se valida; herramientas con permisos mínimos |
| **Latencia / timeouts** (varias llamadas por turno) | Canalización fija con presupuesto por paso; `maxDuration 300 s`; respaldo al flujo anterior antes de escribir; lease heartbeat ya existe |
| **No determinismo** (replay inestable) | Eventos + cassettes de LLM (caché por hash); métricas por distribución, no por texto exacto |
| **Estado corrupto o contradictorio** | Event-sourcing; proyección reconstruible; versión optimista; reductores puros con pruebas de propiedad |
| **Carreras entre turnos** (estado) | Escritura de estado solo con lease+fence del turno; mismo patrón que `quoteBegin`; prueba de concurrencia contra PostgreSQL real |
| **Regresión de seguridad médica** | Piso regex ∪ modelo; corpus médico dedicado en replay; 0 tolerancia |
| **Complejidad de migrar** | Todo por bandera, aditivo, sombra primero; el flujo legado queda de respaldo hasta Fase 5 |
| **Instancias serverless** (estado en memoria) | El estado nuevo vive en la base, no en proceso (corrige también el `ReplyGate`/`RepeatTracker` de mejor esfuerzo) |

### Decisiones abiertas (necesito su respuesta antes de la Fase 1)
1. **Privacidad:** hoy el texto médico y de cotización *no se envía* al proveedor como contexto "hasta autorización del laboratorio" (`conversation-memory.ts`). Un agente con continuidad real necesita enviar historial (incluida salud) a OpenAI. Las fotos de receta ya se envían a Gemini/OpenAI. ¿Está aprobado el envío de historial textual al proveedor, con qué retención y con qué saneamiento?
2. **Tope diario (5 / 24 h):** ¿se mantiene como protección contra bucles/costo o pasa a un control por ráfaga y repetición?
3. **Respuesta en varias partes:** ¿es deseable enviar más de un mensaje de WhatsApp por lote cuando mejora la lectura?
4. **Reanudación:** ¿la reanuda siempre una persona (CRM) o también por inactividad del humano? ¿Con qué plazo?
5. **Estado de producción:** lista de banderas en `on` y modelo configurado (`OPENAI_CONVERSATION_MODEL`).
6. **Auditoría de 469 mensajes:** ¿puedo trabajar con la exportación local (`history-export`, archivo con permisos 0600, borrado al terminar)?

## 10. Cómo probar con conversaciones reales (replay sin envíos externos) (Pregunta 10)

### 10.1 Qué ya existe (y se reutiliza)
- **Dependencias inyectables:** `QuoteDeps.sendText`, `analyze`, `loadCatalog`, `ConversationClient`, `StudyInterpreter`. Enviar a Kapso = una función; sustituirla por una captura es trivial.
- **PostgreSQL efímero con las migraciones reales** (`tests/support/ephemeral-postgres.ts`, `postgrest-over-psql.ts`) y pruebas de extremo a extremo con webhook real (`tests/text-conversation-e2e.test.ts`, `kapso-batch-e2e.test.ts`, `batch-engine-wiring.test.ts`).
- **Bloqueo de red:** `offline.ts` (`enforceOffline`), guardas de gasto (`scripts/lib/paid-guard.ts`, `spend-ledger.ts`) y caché de llamadas a modelos (`cache.ts`).
- **Modo sombra** del motor de lotes (lectura `STABLE`, sin escrituras) como patrón para el agente nuevo.
- **Fuente de datos real:** `message_history` (texto, actor, `replyTo`, `auditRunId`, estado, agrupación por lote) vía `history-export`.

### 10.2 Qué falta
- **Reconstruir el webhook:** el historial no guarda el payload crudo; el arnés debe sintetizar eventos Kapso firmados (como `textEvent`/`imageEvent` de los tests) agrupando por la ventana de 15 s.
- **Fotos:** el historial solo conserva referencia/pie, no la imagen. La percepción se reemplaza por la **evidencia ya registrada** en la auditoría (`auditRunId`) como `recorded_perception` — válido para evaluar conversación; la calidad de lectura de imágenes se sigue midiendo con el benchmark existente.
- **Reloj virtual:** hay `Date.now()` repartido (TTL de sesión, ventanas, tope diario); el arnés necesita un reloj inyectable.
- **Instantáneas versionadas** del catálogo (`catalogFingerprint` ya existe) y del conocimiento aprobado a la fecha del 4-nov-2026.
- **Cassettes de LLM** (caché por hash de petición) para repetir sin gasto y sin variación; modo "vivo" opcional bajo guarda de gasto, con lista blanca solo al endpoint del proveedor (nunca Kapso ni Supabase real).

### 10.3 Diseño del arnés

```
corpus real (JSONL local, 0600)  ──►  fixture: conversaciones[ {pasos[ {t, lote[], eventosHumanos[], percepciones{msgId→evidencia}} ]} ]
                                                       │
        ┌──────────────── modos ───────────────────────┤
        │ legado  : código actual con las banderas de producción
        │ candidato: agente nuevo (sombra / activo)
        ▼
  webhook REAL firmado → PostgreSQL efímero (migraciones reales) → sendText = captura · analyze = grabado · reloj virtual
        ▼
  resultados: respuestas, estado, traza de decisión  ──►  evaluadores
```

### 10.4 Evaluación en cuatro capas
1. **Invariantes duros (bloquean cualquier despliegue):** ningún envío con contacto pausado; cero precios que no provengan del catálogo; cero promesas de persona sin caso `REGISTERED`; cero consejo médico; una sola respuesta por lote; sin envíos duplicados; todo enunciado cubierto (o `CARRIED`/`HANDED_OFF`). Se ejecutan sobre **todas** las conversaciones y sobre variantes adversarias (reordenamiento, duplicados, reintentos, caídas parciales con `faults.ts`).
2. **Regresión diferencial legado ↔ candidato:** matriz de diferencias por turno (respuesta, acto, derivación), clasificadas automáticamente en "mejora esperada / neutral / sospechosa" para revisión humana.
3. **Rúbrica con juez LLM** (modelo distinto, offline): continuidad, responde lo preguntado, no repite al humano, naturalidad. Calibrado contra un subconjunto etiquetado a mano de los 469 mensajes; se publica el acuerdo juez↔humano.
4. **Métricas de producto** (objetivos fijados en Fase 0): tasa de respuesta genérica, preguntas sin respuesta ni caso, continuidad tras fotos/cotizaciones, retoma tras humano, tasa de derivación y precisión de derivación, latencia p95.

### 10.5 Salvaguardas del propio replay
- Datos reales de salud: archivos locales con permisos `0600`, fuera de git, borrados al terminar; los fixtures versionados serán **sintéticos derivados** (misma estructura, contenido anonimizado).
- Aviso operativo ya conocido: las pruebas con PostgreSQL efímero fallan por `ENOSPC` si el disco `C:` está lleno (es ambiental, no regresión); conviene fijar un directorio de datos con espacio para el arnés.

## 11. Orden recomendado y siguiente paso

1. **Fase 0 (ya posible, sin riesgo):** con su autorización sobre la exportación de los 469 mensajes, construir la línea base. Su resultado confirma (o corrige) la jerarquía de causas de §4 y fija las metas.
2. Resolver las decisiones 1 y 2 de §9 (privacidad y tope), porque condicionan el diseño del estado y del contexto.
3. Fases 1 y 2 pueden avanzar en paralelo (estado y herramientas son independientes), ambas sin cambio visible para pacientes.

*Nada de esto se implementa hasta su aprobación.*
