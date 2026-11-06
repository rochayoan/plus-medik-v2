# G7 · Correcciones mínimas — derivación al CRM, respuestas de respaldo, fallos de auditoría y el defecto D1

Estado: **diseño. Nada de esto se aplicó** (no se tocó `src/`, `supabase/` ni la configuración de producción). Cada corrección indica si es **configuración**, **código mínimo** o **migración**, su riesgo, su prueba y cómo revertirla.
Evidencia y cifras: [`06`](06-causas-confirmadas-e-hipotesis.md). Orden recomendado al final (§7).

## Principios de las correcciones
1. **Mínimas y reversibles**: preferir configuración y registros antes que lógica nueva.
2. **No relajar ninguna protección** (idempotencia, turnos, pausa humana, precios solo del catálogo, derivación confirmada solo con registro). Donde una protección causa daño colateral, se acota el daño, no la protección.
3. **Primero observar**: lo que hoy no se registra (cuerpo del error de OpenAI, código HTTP del rechazo de auditoría) se registra antes de decidir.
4. Toda corrección de código llega con una prueba que falla antes y pasa después (como `tests/g7-instant-photo-in-batch.test.ts`).

---

## A. Derivación al CRM (hoy desactivada)

**Problema.** `text_turn … "handoff":"blocked"`: toda consulta médica, de «hablar con una persona» o de información sin respuesta recibe el texto fijo «no puedo derivarlo a una persona desde este chat». 14 respuestas el 4-nov. Además, ninguna receta `HUMAN_REVIEW` llega a una persona (ver G: **activar la derivación no basta para las fotos instantáneas**).

**Cambio.** Es **configuración y operación, no código**: el código ya existe y está probado (`src/crm-outbox/*`, 165 pruebas en G5.0). `webhook.ts` solo lo habilita con `PLUSMEDIK_CRM_HANDOFF=on` **y** configuración completa; cualquier faltante deja la derivación bloqueada y registra un código.

**Lista de verificación previa a activarla** (de `docs/g5/11`; ninguna se pudo comprobar desde aquí):
| # | Requisito | Quién |
| --- | --- | --- |
| 1 | Migración 13 (`crm_outbox`) aplicada en el Supabase de producción y verificada con `supabase/preflight/` | Usted |
| 2 | Variables en Vercel: `PLUSMEDIK_CRM_HANDOFF`, `PLUSMEDIK_CRM_REVIEW_URL` (https), `PLUSMEDIK_CRM_REVIEW_TOKEN` (≥ 32), `PLUSMEDIK_OUTBOX_KEY` (≥ 32, distinta de otras claves), `KAPSO_PHONE_NUMBER_ID` | Usted |
| 3 | Receptor del CRM operativo (`PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED`) y que **ingiera el mensaje original** del paciente: si no, el CRM responde `409 message_not_ingested` y el caso nunca se confirma | CRM |
| 4 | **Programar `/api/outbox/drain`** (hoy `vercel.json` no tiene cron) con `CRON_SECRET`; sin cron un caso pendiente solo se reintenta en el turno | Usted |
| 5 | **Una persona responsable de la cola de revisión y un plazo** (R1 de G5.0: «promesa sin atención»). Los textos `handoff_confirmed`, `medical_handoff_confirmed`, `review_confirmed` deben estar aprobados por el laboratorio | Laboratorio |
| 6 | Alerta para casos `DEAD` | Usted |

**Garantías que se conservan.** Al paciente solo se le dice «una persona te escribirá» cuando el CRM **ya registró** el caso (si no, el texto fijo sin promesa). Lo médico mantiene el aviso de urgencia. Idempotente por mensaje.

**Prueba.** Vista previa de Vercel con un número propio: (a) pedir «quiero hablar con una persona» → caso visible en el CRM y confirmación; (b) apagar el CRM → texto sin promesa; (c) mensaje con `409` → sin promesa; (d) pausa humana intacta.
**Reversión.** Quitar `PLUSMEDIK_CRM_HANDOFF` y redesplegar.
**Impacto esperado.** 14 respuestas del día pasan de «no puedo derivar» a derivación registrada (consultas médicas, pedir persona, información sin respuesta y revisión del flujo de sesiones «LISTO»). **No cubre** las recetas fotografiadas en modo instantáneo (ver G).

---

## B. Respuestas de respaldo (qué recibe el paciente cuando el modelo falla)

**Problema.** Ante 429/error/filtro la respuesta es un texto fijo genérico (~50 % de las llamadas del día), a veces incluso retenido por el tope; el paciente no sabe qué pasó y nadie del equipo se entera.

**B1. Registrar la causa (código mínimo, solo log).** En `src/conversation-model.ts` (`failureKind`) y `src/study-interpreter-openai.ts`: añadir al registro `llm_conversation`/`quote_interpreter` los campos **`httpStatus`, `errorCode`, `errorType` (códigos cerrados del proveedor, nunca el mensaje), `retryAfter` y los `x-ratelimit-remaining-*`**. Esto distingue cuota de velocidad y fija la duración real. Riesgo mínimo (solo logs). Prueba: cliente simulado que lanza un error con `status:429, code:"insufficient_quota"` y comprobar el registro sin texto de pacientes.

**B2. Reintento acotado y circuito consciente de la causa (código pequeño).**
- `insufficient_quota` (cuota): **no reintentar**; abrir el circuito de inmediato y emitir una alerta (log con código `LLM_QUOTA`).
- `rate_limit_exceeded` o 5xx: **un** reintento con espera de 1-2 s. El presupuesto del turno debe subir de 8 s a ~20 s (la función dura hasta 300 s y el webhook ya respondió 200; el lote de Kapso ya espera 15 s).
- La indisponibilidad del proveedor no puede apagar a la vez el intérprete de estudios y la conversación sin aviso: comparten alerta.

**B3. Que el respaldo no se pierda ni sea inútil (configuración + código mínimo).**
1. **Config:** subir `PLUSMEDIK_DAILY_REPLY_CAP_MAX` (p. ej. de 5 a 30) y revisar `PLUSMEDIK_REPLY_GUARD_CONFIG` **mientras** se prueba el reemplazo (decisión 2: el límite no se quita hasta tener el reemplazo probado). Con el tope en 5, 10 respuestas se retuvieron el 4-nov, 2 de ellas el propio respaldo.
2. **Código mínimo:** el aviso técnico y las derivaciones no deben contar contra ningún tope conversacional (en `guarded-turn.ts` la guarda ya ignora imágenes/cotizaciones; extenderlo a `technical_issue` y a respuestas con `signature` de derivación). Requiere probar con la reserva de la base (migración existente `reserve_send_guarded`): puede resolverse sin migración pasando `guard` solo cuando corresponde.
3. **Visibilidad:** toda pregunta que reciba un texto fijo (respaldo) se registra como pendiente (Fase 1, `08`): el equipo la ve aunque el paciente haya recibido un texto genérico.

**B4. Lo que NO se recomienda ahora.** Parchear las listas de palabras del filtro (`hoy`, `pronto`, `siempre`…) o añadir palabras a los patrones peligrosos: son parches léxicos a un diseño que se reemplaza por el verificador por procedencia (Fase 2). Única excepción si lo prefiere como medida de emergencia: eximir de `TIME_OR_PROMISE` las fórmulas de cortesía (`hoy`, `hasta pronto`, `siempre estamos`), pero **también** hay que cerrar los dos falsos negativos (plazo inventado, dirección inventada), y eso tampoco es posible bien con listas.

**Reversión.** B1/B2: bandera o revertir el commit; B3.1: devolver el valor.

---

## C. Fallos de auditoría (claim rechazado, evidencia rechazada)

**Problema.** 4 lotes quedaron sin atender porque `plusmedik_turn_claim` respondió HTTP 4xx (`audit_unavailable stage=claim kind=REJECTED`); 1 evidencia de foto fue rechazada. El agente falla cerrado (correcto: sin claim no hay exclusión demostrable), pero **silenciosamente**: el paciente queda sin respuesta y nadie lo ve.

**C1. Registrar la causa (código mínimo, solo log).** `AuditWriteError` ya trae `status`; `beginTurn` (`guarded-turn.ts:145`) y `persist` solo registran `kind`. Añadir `status` y, en el cliente RPC (`src/audit.ts` ~ línea 430), el `code` de PostgREST (`PGRST…`/`PT…`) **sin cuerpo**. Con eso se distingue «función no encontrada/recarga de esquema» (404) de «validación del claim» (`PT422`, 400) o permisos (401/403). Prueba: servidor simulado que devuelve cada código.

**C2. Compensación existente, sin código:** `scripts/history-export.ts --gaps` lista los mensajes entrantes que **no tienen corrida de auditoría**: es exactamente la lista de pacientes que el agente no atendió por fallo de auditoría. Ejecutarlo cada hora (o diario al inicio) y enviar el resultado a la recepción cubre el hueco hasta tener la cola de pendientes (Fase 1).

**C3. Reintento (solo si C1 muestra que es transitorio).** `REJECTED` no se reintenta hoy (es 4xx); si C1 revela p. ej. un 404 durante recargas de esquema, un único reintento tras 300 ms para 404/PGRST202 es seguro (el claim es idempotente por mensaje).

**C4. Alerta.** ≥ 2 `audit_unavailable` en 1 h ⇒ alerta (log con código `AUDIT_DEGRADED`).

**Pregunta abierta para usted.** El proyecto de Supabase del laboratorio no está disponible en las herramientas de esta sesión; si me da acceso de solo lectura a los logs de API de esos 5 instantes (07:59, 11:43, 16:53, 20:05 y 20:38 UTC) se cierra la hipótesis H-C sin esperar el despliegue de C1.

---

## D. Defecto D1 — la cotización de la foto se pierde en un lote

**Reproducción (hecha, sin tocar `src/`).** `tests/g7-instant-photo-in-batch.test.ts` (PostgreSQL efímero + migraciones reales + webhook real): con `instantPhotoQuotes` y motor de lotes `on`, texto+foto y foto+texto envían **un mensaje sin precios**; los controles (ruta de siempre; foto suelta) sí los envían. Las pruebas del defecto están marcadas `it.fails`: **fallarán cuando se corrija**, y ahí se quita la marca.

**Causa (lectura de `src/turns.ts`, rama `engine === "on"`).** El mensaje final se arma con `mergeProduced([...turnos OTHER, engineProduced])`. Las respuestas de los turnos de imagen (`results`) alimentan al motor solo a través de `photoOutcomeOf`, que para `imageProducer` (sin `produced.photo`) devuelve `RESOLVED` **sin ids de estudios**; la cotización (`produced.body`, `result:"quoted"`) no se incorpora.

**Cambio mínimo propuesto (código, ~10 líneas):**
```ts
// turns.ts, rama engine === "on", antes del merge final
const quotedPhotos = runnable
  .map((item, position) => ({ item, position }))
  .filter(({ item }) => item.unit.turn.kind === "IMAGE")
  .map(({ item, position }) => ({ position, produced: results.get(item)! }))
  .filter(({ produced }) => produced.kind === "reply" && produced.result === "quoted");
const merged = mergeProduced([...rest.map(({ item }) => results.get(item)!), ...quotedPhotos.map((p) => p.produced), engineProduced]);
// y marcar included[position] = true para las fotos incorporadas
```
`mergeProduced` ya **nunca recorta ni descarta una cotización** (`result:"quoted"` manda y su `stale` es `NONE`), así que el comportamiento de unión/longitud/idempotencia existente se conserva.

**Riesgos y pruebas a añadir:** (1) la respuesta del motor puede decir «no tengo estudios anotados» mientras la cotización de la foto sí está; verificar el texto combinado (orden: cotización primero); (2) dos fotos cotizadas en un lote (dos bloques con precios); (3) foto parcial + texto de duda; (4) cancelación + foto (va por la ruta de respaldo, ya existente); (5) el total sigue saliendo solo del catálogo; (6) límite de 3 900 caracteres con dos cotizaciones; (7) la excepción de producción del lote de 4 mensajes (H-D).
**Reversión.** Revertir el commit; no hay migración.
**Impacto esperado.** Recupera las cotizaciones ya calculadas (4 de las 10 del día).

---

## E. Pausa humana: pendientes invisibles

El hueco (24 lotes sin atención de nadie + 3 atendidos > 2 h tarde) no se corrige tocando la pausa: se corrige **mostrando lo pendiente**. Diseño completo y prototipo probado en [`08`](08-fase1-memoria-y-objetivos-pendientes.md). Simulación sobre el corpus: la recepción habría recibido 86 alertas de ≥ 15 min en el día, 40 de ellas durante una pausa humana.

---

## F. Documentos, ubicaciones y reacciones

**Problema.** Los documentos (13 mensajes, 4 lotes) y las ubicaciones se ignoran sin huella. **Cambio mínimo:** definir `handlers.other` en `api/kapso/webhook.ts` y propagar el tipo (`document`, `location`…) en `IncomingTurn`; la respuesta fija «Recibí tu archivo; no puedo abrirlo por este chat. Si es tu receta, envíala como foto» **sin promesa de persona** salvo que la derivación (A) haya registrado el caso (entonces `handoff_confirmed`). Las reacciones y stickers se siguen ignorando. Prueba: webhook real con un `document` (claim, auditoría, respuesta, caso, no cuenta contra el tope). *Antes:* revisar en el casebook qué son esos documentos para elegir el texto.

---

## G. Casos de revisión para fotos instantáneas (hallazgo nuevo)

**Problema (verificado en el código).** Con `PLUSMEDIK_INSTANT_PHOTO_QUOTES=on`, `producerFor` usa `imageProducer` (`whatsapp-quote.ts`), que **no** usa `crmHandoff`. Solo `quote-session-turns.ts` (`reviewReply`), `batch-execution.ts` y el manejador de texto envían casos al CRM. Resultado: una receta `HUMAN_REVIEW` o `AUTO_PARTIAL` recibe «no pudimos identificar… foto más clara» y **ningún caso se crea**, aunque la derivación esté activa. En el día: 6 análisis `HUMAN_REVIEW` y 4 `AUTO_PARTIAL`, ninguno con aviso al equipo.

**Cambio mínimo (código pequeño).** En `imageProducer`, tras registrar la evidencia, si el resultado es `HUMAN_REVIEW`/`AUTO_PARTIAL` y `deps.turns?.crmHandoff` existe, enviar un caso `RECIPE_REVIEW` (el contrato del CRM ya acepta `recipeMediaId`, `auditId`, `agentResult`, `detectedTests`; ver `tests/support/fake-crm.ts`). El texto al paciente solo promete a una persona si el CRM confirma el registro (misma regla que `reviewReply`). Riesgo: ruido en la cola de recepción (10 casos/día en la muestra). Prueba: webhook real con análisis simulado `HUMAN_REVIEW` → caso registrado, mensaje sin promesa si el CRM falla, idempotente por mensaje.

## 7. Orden recomendado de aplicación

| Orden | Corrección | Tipo | Dependencia |
| --- | --- | --- | --- |
| 1 | Panel de OpenAI + `openai-limits-probe.ts` (causa de los 429) | Operativo | — |
| 2 | **B1 + C1** (registrar causas) | Código mínimo (log) | — |
| 3 | **D1** (foto en lote) | Código mínimo + prueba ya escrita | — |
| 4 | **A** (derivación al CRM) | Configuración + operación | Responsable de la cola, cron |
| 5 | **B3.1** (subir el tope) | Configuración | — |
| 6 | **C2** (`--gaps` periódico) | Operativo | — |
| 7 | **B2** (reintento/circuito) y **B3.2** (respaldo fuera del tope) | Código pequeño | B1 |
| 8 | **F** (documentos) y **G** (casos de revisión de fotos) | Código pequeño | A |
| 9 | Fase 1 (cola de pendientes) | Código nuevo + migración | `08` |

Cada paso se despliega por separado, con su prueba, en vista previa antes de producción, sin tocar el flujo de precios ni la pausa humana.
