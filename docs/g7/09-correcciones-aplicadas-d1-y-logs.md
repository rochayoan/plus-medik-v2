# G7 · Correcciones aplicadas en `src/`: D1 y causa exacta en los registros

Estado: **aplicado en el árbol de trabajo, sin commit, sin push, sin despliegue.** Diseño original en [`07`](07-correcciones-minimas.md) (§D y §B1/§C1). Pruebas al final.

## 1. D1 · la cotización de la foto ya no se pierde en un lote

**Qué pasaba.** Con `PLUSMEDIK_INSTANT_PHOTO_QUOTES=on` y `PLUSMEDIK_BATCH_ENGINE=on`, un lote con una foto y texto («hola», una pregunta…) enviaba **solo la respuesta al texto**. Peor de lo que se había descrito: el paciente recibía «¡Hola! … envíame una foto de tu receta» *aunque la foto ya se había analizado y cotizado*. En producción: 4 de las 10 recetas cotizables del 4-nov.

**Causa.** En `turns.ts` (rama `engine === "on"`) el mensaje final se armaba con `mergeProduced([...turnos OTHER, respuesta del motor])`. La respuesta propia de cada foto —su cotización con precios del catálogo, o el aviso «no pudimos identificar…»— viaja en el `Produced.body` de `imageProducer` y no entraba. El motor solo conoce de cada foto un `PhotoOutcome` sin ids de estudios en este modo.

**Cambio (`src/batch-engine.ts` +10 líneas, `src/turns.ts` +9/−2).**
1. `instantPhotoReply(produced, instant)` (nuevo, puro): en modo instantáneo devuelve la respuesta de una foto si es `quoted` o `no_quote`; en cualquier otro caso `undefined`. El fallo técnico de una foto **no** se incorpora (el motor ya lo comunica con su aviso; evita duplicarlo). Sin el modo instantáneo no se incorpora nada (con sesiones, las respuestas de las fotos son acuses que el motor sustituye por su resumen).
2. En `turns.ts` esas respuestas entran al `mergeProduced` **antes** de la respuesta al texto. Se reutiliza la regla de unión de siempre: una cotización jamás se recorta ni se descarta por obsoleta (`stale: NONE`), el tope de 3 900 caracteres sigue igual.
3. La respuesta genérica del texto («¿en qué puedo ayudarte? / envía tu receta») se marca `generic` (por igualdad exacta con `GENERIC_PROMPTS`, igual que ya hace `conversationProducer`) para que `mergeProduced` la descarte cuando hay algo concreto; sin eso el paciente habría recibido la cotización seguida de «envíame tu receta».

**Lo que NO cambia (verificado con pruebas):** el precio sale solo del catálogo (el texto del paciente no lo altera); un único envío por lote; una reentrega idéntica no duplica nada y no deja corridas «en proceso»; lease/fence, reserva de envío y pausa humana son los de `guarded-turn.ts` (no se tocó); con sesiones sin fotos instantáneas el motor se comporta igual; la ruta de siempre y la foto suelta no cambian.

## 2. Registros: causa exacta de los 429 y de los rechazos de auditoría

**Regla única:** en el registro entran **solo códigos de lista blanca** validados con un patrón estricto (si un valor no cumple el patrón se descarta, no se recorta). Nunca el mensaje del error, el cuerpo de la respuesta, claves, cabeceras de autorización, URLs ni texto del paciente. Está probado con errores que traen a propósito una clave, un teléfono y texto clínico en `message`, en el cuerpo y en las cabeceras.

### 2.1 Campos nuevos
| Evento | Cuándo | Campos nuevos |
| --- | --- | --- |
| `llm_conversation` (`outcome: FALLBACK`, `reason: RATE_LIMITED\|TIMEOUT\|ERROR`) | fallo del modelo de conversación | `cause`, `httpStatus`, `errorCode`, `errorType`, `errorName`, `retryAfterS`, `requestId`, `rl` |
| `quote_interpreter` (`reason: ERROR`) | fallo del intérprete de estudios | los mismos |
| `processing_failed` | falla el análisis de una foto | `aiFailures[]`: por cada llamada fallida `{stage, provider, model, errorKind, cause, httpStatus, errorCode, …}` (máx. 6) |
| `audio_job` (`retry`, `failed`) | falla la transcripción | los mismos que `llm_conversation` |
| `audit_unavailable`, `human_event_failed`, `attention_event_not_recorded` | rechazo de la base | `kind`, `httpStatus`, `serverCode` (PT422, PGRST202, 22P02…), `requestId` (id de la petición en Supabase) |

`rl` = `{limitRequests, remainingRequests, resetRequests, limitTokens, remainingTokens, resetTokens}` leídos de las cabeceras `x-ratelimit-*` (números o duraciones como `6m0s`).

### 2.2 Cómo leerlos
| `cause` / `errorCode` | Significa | Qué hacer |
| --- | --- | --- |
| `QUOTA_OR_BILLING` (`insufficient_quota`, `billing_hard_limit_reached`…) | Sin saldo, o tope de gasto alcanzado | Panel de OpenAI → *Billing* y *Limits*. **Separar claves no lo arregla** si el saldo es de la organización |
| `RATE_LIMIT` (`rate_limit_exceeded`) + `rl` + `retryAfterS` | Se superó RPM/TPM | Ver `rl.remaining*` y el límite del modelo; subir de nivel o espaciar |
| `RATE_LIMIT_OR_QUOTA_UNKNOWN` | 429 sin código reconocible | Anotar `requestId` y consultar al soporte del proveedor |
| `TIMEOUT` / `CONNECTION` | Tiempo agotado / red | Revisar estado del proveedor y el presupuesto de tiempo |
| `AUTH` | Clave inválida o sin permiso | Revisar la clave del proyecto |
| `NOT_FOUND` | Modelo inexistente o no habilitado | Revisar `OPENAI_*_MODEL` |
| `SERVER` | 5xx del proveedor | Página de estado |

| `serverCode` (auditoría) | Significa probable |
| --- | --- |
| `PT422` | La función rechazó un parámetro (`invalid claim`): p. ej. `contact_key` o `message_id` fuera de patrón |
| `PGRST202` / HTTP 404 | La función no existe o el esquema de PostgREST no está recargado (migración sin aplicar o recién aplicada) |
| `PGRST301` / HTTP 401·403 | Clave de servicio inválida o sin permiso |
| `22P02`, otros `SQLSTATE` | Dato con formato inválido para la columna |
| `PT409` / `PT410` | Conflicto / lease perdido (ya existían) |

### 2.3 Búsquedas útiles en Vercel (producción)
- Cuota: `QUOTA_OR_BILLING` · Tasa: `"cause":"RATE_LIMIT"` · Auditoría: `serverCode` · Fotos: `aiFailures`.
- Para cerrar la hipótesis de los rechazos de auditoría del 4-nov, la próxima vez que ocurra aparecerá `"stage":"claim","kind":"REJECTED","httpStatus":…,"serverCode":…,"requestId":…` y el `requestId` permite ubicar la fila exacta en los logs de API de Supabase.

### 2.4 Qué NO cambia
- Ningún comportamiento: mismas respuestas, mismos códigos de razón (`RATE_LIMITED`, `TIMEOUT`, `ERROR`), mismo circuito (3 fallos ⇒ 60 s), mismos reintentos de la auditoría (410 lease perdido, 409 conflicto, 4xx rechazo, 5xx/red un reintento).
- La causa del evento de IA (`AiCallEvent.failure`) vive **solo en memoria**: `serializeAiCalls` elige sus campos, de modo que **no se guarda en la auditoría** (probado).
- El cuerpo de la respuesta de Supabase se lee ahora **solo en rechazos 4xx/409** y únicamente para extraer `code` con el patrón de PostgREST/PostgreSQL/PT; el resto se descarta sin guardarse.

## 3. Archivos tocados
`src/batch-engine.ts`, `src/turns.ts` (D1) · `src/provider-error.ts` (nuevo) · `src/conversation-model.ts`, `src/study-interpreter.ts`, `src/cache.ts`, `src/whatsapp-quote.ts`, `src/quote-session-turns.ts`, `src/audio/{types,transcribe,service}.ts`, `src/audit.ts`, `src/guarded-turn.ts`, `src/kapso-webhook.ts` (registros).
No se tocaron: `supabase/`, `api/`, `.env.example`, `vercel.json`, la lógica de precios, la pausa humana ni la reserva de envío.

## 4. Pruebas
Ver el resultado de la suite completa en el informe de la sesión. Nuevas: `tests/g7-instant-photo-in-batch.test.ts` (12, PostgreSQL real), `tests/provider-error.test.ts` (11), `tests/failure-cause-logs.test.ts` (17). Verificación de las pruebas de D1 por **mutación**: quitar la incorporación de las fotos hace fallar 7; quitar el marcado de «genérico» hace fallar 2.

## 5. Validación final y auditoría del diff de `src/` (2026-11-05)

**Resultado:** `tsc` limpio · suite completa **142 archivos / 4 017 pruebas, todas en verde** (con `--maxWorkers=3`) · `migration-preflight-db` (19, incluidas las 6 que habían fallado por disco lleno) en verde. Sin commit, push ni despliegue.

**Alcance del diff:** 13 archivos de `src/` (+90/−29) más el módulo nuevo `src/provider-error.ts`. No se tocó `supabase/`, `api/`, `vercel.json` ni `.env.example`. Se actualizaron dos pruebas de contratos exactos que el cambio modifica a propósito (`audit-lease`: el registro ahora trae `httpStatus`; `conversation-boundaries`: `conversation-model.ts` puede importar `provider-error.ts`, que a su vez tiene una prueba de que es puro).

| Invariante | Evidencia |
| --- | --- |
| **Un solo envío por lote** | D1 solo añade respuestas ya producidas al `mergeProduced` existente, que devuelve UN `Produced` ⇒ una reserva y un `sendText`. Pruebas: `sends.length === 1` en texto+foto, foto+texto, 2 fotos+texto, parcial, foto no cotizable, pregunta+foto |
| **Idempotencia** | D1 no añade ninguna escritura ni claim. Reentrega secuencial idéntica y **tres entregas simultáneas** del mismo lote: 1 envío, exactamente 1 corrida con envío, ninguna en proceso |
| **Leases / fencing** | `guarded-turn.ts` solo cambia el ayudante de registro (`writeErrorKind`); `absorb`, `deferClosing`, reserva y confirmación intactos. Suites `audit-lease`, `turn-recovery-db`, `turns-db` en verde |
| **Pausa humana** | `claim`, `reserveSend`, `confirmSend` y `deliver` sin cambios. Suites `human-control-*`, `crm-attention-*`, `attention-*` en verde |
| **Precios autorizados** | `instantPhotoReply` solo reenvía el `body` que ya produjo `imageProducer` (`formatQuoteMessage` con `publicQuote` del catálogo); no calcula ni escribe precios. Prueba: un texto del paciente con «cuesta Bs 1» no altera el precio |
| **Privacidad de los registros** | Solo códigos de lista blanca; probado con errores que traen clave, teléfono y texto clínico. La causa del evento de IA no se guarda en la auditoría |

**Dos comportamientos observados (heredados, no regresiones):** con D1 el motor encendido queda a la par de la ruta de siempre, que ya hacía lo mismo:
1. Texto con estudios + foto cotizada ⇒ **dos cotizaciones en un mismo mensaje** (cada una correcta, con su total; si repiten estudios se ven dos totales).
2. «listo» + foto cotizada ⇒ la cotización seguida de «Todavía no tengo estudios anotados. Envíame la foto…» (en modo instantáneo la foto no entra a la sesión).
Verificado que la ruta de siempre produce exactamente los mismos textos. Se propone un ajuste posterior (fuera del alcance de esta tanda) y observarlo en la vista previa.
