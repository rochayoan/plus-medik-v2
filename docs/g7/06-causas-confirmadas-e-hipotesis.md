# G7 · Fase 0 — Causas confirmadas, hipótesis pendientes y prioridades

Estado: **análisis local y reproducciones con datos inventados. No se modificó `src/`, no hay commits ni despliegues, no se envió ningún mensaje real y ningún dato de pacientes salió de esta máquina.** No leí el contenido de los mensajes: la clasificación es determinista y cruza el corpus seudonimizado con telemetría de producción **sin identificadores** (solo horas y códigos).
Sustituye las cifras de [`05`](05-fase0-linea-base-real-y-prioridades.md) donde difieran (ver §9, correcciones).
Reproducible: `scripts/g7/classify-batches.ts`, `scripts/g7/phase1-replay.ts`, `tests/g7-instant-photo-in-batch.test.ts`.

## 1. Qué está confirmado

| # | Hallazgo | Nivel de evidencia |
| --- | --- | --- |
| C1 | **Un silencio del agente no es, en general, un fallo**: de 183 lotes del paciente, 69 (38 %) terminaron correctamente sin respuesta del agente (51 atendidos por una persona, 18 de silencio legítimo) | Corpus + telemetría |
| C2 | **Fallas reales o técnicas: 90 lotes (49 %)**. Responsables: recepción/proceso 27 · protecciones (tope, guarda, derivación apagada, filtro) 22 · proveedor de IA 20 · agente 17 · base de auditoría 4 | Corpus + telemetría (46 con telemetría directa, 7 inferidos) |
| C3 | **La indisponibilidad de OpenAI duró ≈ 5-6 h** (del 4-nov, ≈ 12:45 a ≈ 18:02-18:38 UTC) y afectó a varios módulos a la vez (§3) | Telemetría |
| C4 | **Defecto D1 (reproducido): en un lote de varios mensajes con una foto, con el motor de lotes en `on` y las fotos instantáneas en `on`, la cotización con precios de la foto se pierde.** El paciente recibe un mensaje sin precios aunque la receta se analizó y cotizó | Prueba reproducible con PostgreSQL real (`tests/g7-instant-photo-in-batch.test.ts`) + 4 casos de producción |
| C5 | **La derivación a una persona está desactivada** en producción: el agente envió 14 respuestas fijas «no puedo derivarlo / no puedo orientar» en el día (7 se clasificaron como insuficiencia de diseño y las otras 7 como error técnico por coincidir con un 429) | Telemetría (`handoff:"blocked"`) |
| C6 | **Los documentos (PDF/archivos) se ignoran por diseño**: el webhook no tiene manejador para ese tipo, no hay claim ni auditoría | Lectura del código + corpus |
| C7 | **Los audios sí se transcriben y se atienden**; los que no recibieron respuesta se deben a la pausa humana, el tope/guarda o la derivación apagada, no a un defecto del audio | Corpus + telemetría (`audio_turn TRANSCRIBED`) |
| C8 | **El tope/guarda (`limited`) retuvo 10 respuestas** en el día, 2 de ellas el texto de respaldo tras un rechazo del filtro | Telemetría |
| C9 | **El claim de auditoría fue rechazado (HTTP 4xx) 4 veces** y el paciente quedó sin respuesta; **no** es un `messageId` inválido (0 de 469 incumplen el patrón de la base) | Telemetría + prueba contra el corpus |
| C10 | **La pausa humana funciona como se diseñó** (0 respuestas del agente tras un mensaje humano en 39 conversaciones) | Corpus |

## 2. Clasificación de los 183 lotes

Criterio: un lote es **fallo** solo si el paciente quedó sin la atención que le correspondía (nadie respondió, respondió algo inservible, o falló la plataforma). Atención humana y silencios legítimos no cuentan. Cada etiqueta lleva responsable y nivel de evidencia (`batch-labels.private.json`, sin texto, para que usted corrija).

| Familia | Lotes | % | Detalle |
| --- | --- | --- | --- |
| **Atención humana correcta** | 51 | 28 % | 30 pausa atendida por persona · 12 atendido junto con un mensaje posterior · 6 el agente no respondió y atendió una persona · 3 pausa aplicada al enviar |
| **Silencio correcto** | 18 | 10 % | 12 social sin acción · 5 fusionado con la respuesta siguiente · 1 reacción/sticker |
| **Respondido** | 24 | 13 % | 21 texto libre (calidad **no evaluada**: requiere lectura humana) · 2 cotización con precios · 1 saludo |
| **Respuesta insuficiente** | 18 | 10 % | 7 «no puedo derivar» · 5 el filtro descartó la respuesta del modelo (`TIME_OR_PROMISE` ×2, `UNGROUNDED`, `HUMAN_PROMISE`, `DIGITS_OR_CURRENCY`) · 5 receta sin cotización completa (2 `HUMAN_REVIEW`, 2 `AUTO_PARTIAL`, 1 `AUTO_COMPLETE` sin precio) · 1 texto genérico a un mensaje concreto |
| **Error técnico** | 24 | 13 % | 14 respuesta fija por 429/error de IA · 6 foto no procesada por fallo de IA · 4 auditoría rechazó el claim |
| **Falta real de respuesta** | 48 | 26 % | **24 pausa humana sin atención de nadie** · 9 tope/guarda retuvo la respuesta (+1 inferido) · 6 sin causa identificada · 3 atendido > 2 h después · 2 documento/ubicación sin manejador · 2 foto sin causa conocida · 1 audio |

Notas de método y límites:
- **Ventana de respuesta**: hasta 2 h; una respuesta humana posterior que cubre varios mensajes del paciente cuenta como atención. Con la ventana estricta (hasta el siguiente mensaje) los «sin atención de nadie» eran 39; con la ventana realista son 24.
- Las **retenciones** (`reply_withheld`) se asignan al lote sin respuesta más cercano que terminó ≤ 150 s antes: puede haber atribuciones cruzadas si dos contactos escribieron a la vez.
- «Respondido» con texto libre **no significa buena respuesta**: el siguiente paso de calidad es etiquetar esos 21 a mano (casebook).
- Los 24 «pausa sin atención» **no son culpa del agente**: es un hueco del proceso de recepción (nadie vio el mensaje). Es justo lo que la cola de pendientes de la Fase 1 cubre.
- Un posible sesgo: «pausa» se infiere de «hay un mensaje humano previo sin respuesta del agente después»; no hay registro explícito en el corpus.

## 3. Errores 429 y fallos de OpenAI

### 3.1 Cronología (4-nov, UTC)
| Hora | Hecho |
| --- | --- |
| 12:30 y 12:34 | Conversación (`gpt-4.1-mini`) y análisis de fotos **funcionan** |
| 12:45 | **Primera foto fallida** (`AI_PROCESSING_FAILED`) |
| 13:17 | **Primer 429** de conversación; el intérprete de estudios (mismo modelo) también falla |
| 12:45 – 17:21 | 6 fotos fallidas; 0 análisis correctos |
| 13:17 – 18:02 | 16 × 429 de conversación (4,7-6,8 s de latencia cada uno) y 6 errores del intérprete (5,5-6,2 s). **Ninguna llamada correcta de `gpt-4.1-mini` en la franja** |
| 18:38 | **Análisis de foto correcto** |
| 19:45 | Conversación e intérprete **correctos** |

El incidente termina entre las 18:02 (último 429) y las 18:38 (primera foto correcta); empieza entre las 12:34 y las 12:45.

### 3.2 Qué descartan y qué apoyan los datos
| Observación | Qué implica |
| --- | --- |
| Fallaron **a la vez** dos módulos distintos con el mismo modelo (conversación e intérprete) **y** el análisis de fotos | Causa a nivel de **cuenta/proyecto**, no un defecto del código conversacional |
| **Volumen bajo**: la conversación hizo ~1 llamada cada 5-30 min en la franja (menor intervalo: 47 s) | Un límite normal de solicitudes/tokens por minuto es **poco plausible** salvo que el nivel de la cuenta tenga límites mínimos (p. ej. 3 solicitudes/min) |
| **Fallo total y sostenido** durante horas, con recuperación súbita | Encaja con **cuota/saldo agotado o tope de gasto alcanzado** y su reposición/reinicio |
| Los límites de velocidad de OpenAI son **por modelo**; fallaron modelos distintos al mismo tiempo (conversación y lectura de recetas) | Un límite por velocidad de *un* modelo no explica el conjunto (pendiente: confirmar que las fotos fallaron por OpenAI y no por OpenRouter/Gemini) |
| 4,7-6,8 s hasta el error | **Anomalía sin explicar**: un rechazo por cuota suele ser inmediato. Podría indicar espera previa del proveedor o de la red |
| `src/conversation-openai.ts` usa `maxRetries: 0` y solo mira `error.status` | **El cuerpo del error nunca se registró**: hoy es imposible distinguir cuota de tasa desde los registros |

### 3.3 Hipótesis y cómo decidir
| Hipótesis | Evidencia a favor | En contra | Se confirma con |
| --- | --- | --- | --- |
| **H1 · Cuota / saldo / tope de gasto** (`insufficient_quota` o equivalente, que OpenAI devuelve como HTTP 429) | Fallo total, multi-módulo, súbito, de horas | Latencia de 5-7 s inesperada | Panel de OpenAI → *Billing* (saldo e historial de recargas del 4-nov), *Limits* (topes mensual/por proyecto) y *Usage* (solicitudes y errores por hora) |
| **H2 · Límite de velocidad** (RPM/TPM) por modelo o nivel de cuenta | Latencia no inmediata (posible espera) | Volumen muy bajo; fallaron varios modelos | Página *Rate limits* del proyecto (RPM/TPM de `gpt-4.1-mini` y de los modelos lectores) y `scripts/g7/openai-limits-probe.ts` (muestra los límites vigentes y el tipo de error HOY) |
| **H3 · Incidente del proveedor** | Simultaneidad | Duración larga; solo esta cuenta | Página de estado de OpenAI (4-nov 12:30-18:40 UTC) |
| **H4 · Las fotos fallaron por otro proveedor** (OpenRouter/Gemini) | El pipeline usa varios | La conversación también cayó | Registro de errores de OpenRouter/Gemini; requiere registrar el origen del error (`ai.ts`) |

**Conclusión provisional (sin confirmar): H1 es la más probable.** La sonda y el panel dan la confirmación en minutos; no hace falta adivinar.

### 3.4 «Separar API keys» no es una solución por sí sola
| Causa real | ¿Ayuda separar claves? |
| --- | --- |
| Saldo/créditos de la **organización** agotados | **No**: todas las claves de la organización comparten el saldo |
| Tope de gasto **por proyecto** | Sí, si cada función vive en su proyecto con su propio tope; pero cada tope debe configurarse bien |
| Límite RPM/TPM **por proyecto/modelo** | Sí, si los límites son por proyecto; no si son del nivel de la organización |
| Incidente del proveedor | No |
Por eso la prioridad es **diagnosticar** (panel + sonda + registrar el cuerpo del error) y **proteger** (alertas de saldo, recarga automática, reintento y degradación), y solo después decidir si separar proyectos.

## 4. Por qué las recetas no terminan en cotización

Embudo de las **34 fotos** del día (corpus) y de los **16 análisis** registrados (telemetría):

| Etapa | Cantidad | Causa | Estado |
| --- | --- | --- | --- |
| Fotos bajo pausa humana: **no se analizan** | 13 | El claim devuelve «pausado» antes de cualquier trabajo | Por diseño |
| Fotos con **fallo técnico** | 8 | 6 fallo de IA (franja del incidente) + 2 rechazo de auditoría del claim | **Confirmado** (telemetría) |
| Fotos analizadas | 16 | — | — |
| ↳ `AUTO_COMPLETE` | 6 | 4 con precio entregado · **1 perdida por D1** (12:30) · 1 bloqueada por pausa humana al enviar | **Confirmado** |
| ↳ `AUTO_PARTIAL` | 4 | **3 perdidas por D1** (19:47, 20:10, 20:38) · 1 bloqueada por pausa al enviar | **Confirmado** (reproducción + telemetría) |
| ↳ `HUMAN_REVIEW` | 6 | Letra manuscrita (`HANDWRITTEN_REQUEST`), `semantic_ambiguous` (2-3 candidatos), `semantic_no_match`, borde cortado/sin verificar. 2 respuestas reemplazadas por un envío más nuevo, 1 retenida por el tope, 3 con aviso de «no pudimos identificar» | Por diseño (modo seguro) |

- De las **10 recetas que el motor logró cotizar** (completa o parcial), **solo 4 llegaron con precio al paciente**. Las otras 6 se perdieron *después* de calcular el precio: 4 por D1 y 2 por la pausa humana al enviar.
- **D1 es el hallazgo más valioso en términos de conversión**: cuesta cotizaciones ya calculadas. La mecánica (leída en `turns.ts`, rama `engine === "on"`): el mensaje final se arma con `mergeProduced([...turnos OTHER, engineProduced])`; la respuesta de cada foto (con su cotización cuando las fotos instantáneas están activas) no se incorpora, y `photoOutcomeOf` la reduce a «RESOLVED sin ids». En el mismo escenario con la ruta de siempre, o con una foto suelta, la cotización llega.
- Pendiente de explicar: una excepción en producción (20:15, lote de 4 mensajes) donde sí llegó el precio. Hipótesis: ese lote cayó en la ruta de respaldo (p. ej. un comando de cancelación con fotos).
- Con `HUMAN_REVIEW` y la derivación apagada, la paciente recibe «no pudimos identificar… foto más clara» y **nadie del equipo es avisado**: callejón sin salida (las recetas manuscritas son las más frecuentes en ese grupo). **Activar la derivación al CRM no lo arregla por sí solo**: en modo de fotos instantáneas `imageProducer` no envía casos al CRM (verificado en el código; ver `07` §G).

## 5. Audios y documentos

**Audios (8):** 3 bajo pausa humana (1 atendida por persona, 1 bloqueada al enviar, 1 atendida junto a otro mensaje) · 2 transcritos y respondidos con «no puedo derivar» · 1 transcrito, el filtro rechazó la respuesta del modelo (`HUMAN_PROMISE`) · 1 respuesta retenida por el tope · 1 sin explicación. **El agente nunca envió un aviso de «no pude escuchar tu audio»** en el día y se observó `audio_turn TRANSCRIBED`: el pipeline funciona. *Pendiente:* confirmar que no hubo fallas de transcripción (la consulta de ese evento agotó el tiempo).

**Documentos (13 mensajes, 4 lotes):** `extractIncomingTurns` los clasifica como `OTHER`; `hasProcessableTurns` exige `handlers.other`, que el webhook **no define** (solo `text`); resultado: respuesta HTTP 200 «ignored», sin claim, sin registro de auditoría y sin respuesta. Solo quedan en `message_history`. De los 4 lotes: 2 sin respuesta de nadie, 1 atendido por persona, 1 bajo pausa sin atención. *Hipótesis pendiente:* que sean órdenes médicas en PDF o comprobantes de pago (el contenido no se leyó).

## 6. Fallos de auditoría (4 + 1)

`audit_unavailable stage=claim kind=REJECTED` a las 07:59, 11:43, 16:53 y 20:05 UTC, y `stage=evidence` a las 20:38. `REJECTED` significa HTTP 4xx distinto de 408/409/410/429 (`src/audit.ts:430`). Descartado: `messageId` inválido (patrón `^[A-Za-z0-9_.=:-]{1,128}$`: 0 de 469 lo incumplen, longitud máxima 90). Los 4 ocurrieron con lotes de texto o texto+foto de distintos contactos, no están ligados a un tipo de medio, ni a la franja del incidente. **Sin el código HTTP y el código de PostgREST no se puede avanzar**: `beginTurn` solo registra `kind`. El proyecto de Supabase del laboratorio no es accesible desde las herramientas de esta sesión (solo hay `scz-reserva` y `CONECTAPRO`, ajenos), así que no pude consultar los registros de la base.

## 7. Hipótesis pendientes (qué falta y cómo cerrarla)

| # | Hipótesis | Cómo se cierra | Quién |
| --- | --- | --- | --- |
| H-A | El 4-nov hubo cuota/saldo agotado en OpenAI (H1) | Panel de OpenAI + `openai-limits-probe.ts` | Usted |
| H-B | Las 6 fotos fallidas lo fueron por OpenAI y no por OpenRouter/Gemini | Registrar el origen del error (cambio en `src/`, ya diseñado en `07`) | Código (tras aprobación) |
| H-C | Los rechazos de auditoría 4xx son un error de la RPC/PostgREST (p. ej. recarga de esquema, 404) o de una validación de contenido | Registrar `status` y `code` del error; revisar el log de API de Supabase de esos 5 instantes | Usted (Supabase) / Código |
| H-D | El lote 20:15 que sí entregó precio cayó en la ruta de respaldo | Reproducción con cancelación + foto | Yo (tests) |
| H-E | Los 6 silencios sin causa son silencios del modelo (`OFF_TOPIC`) o del filtro de atención | Registrar `model:"silent"` ya existe: la consulta no devolvió ninguno; revisar `text_turn` de esas horas | Yo (logs) |
| H-F | Los documentos son órdenes en PDF / comprobantes | Revisar el casebook | Usted |
| H-G | El 429 tarda 5-7 s por una espera previa del proveedor | Registrar `retry-after` y cabeceras `x-ratelimit-*` | Código |
| H-H | De los 21 «respondidos libre», cuántos son buenas respuestas | Etiquetado humano del casebook | Usted + yo |

## 8. Prioridades (por lotes afectados y riesgo)

| Prioridad | Acción | Lotes que toca | Tipo |
| --- | --- | --- | --- |
| **P0-1** | Confirmar la causa de los 429 (panel + sonda); alertas de saldo/límites; recarga automática | 20 (+ 6 fotos) | Operativa, sin código |
| **P0-2** | **Corregir D1** (la cotización de la foto no puede perderse en un lote) | 4 de las 10 recetas cotizadas en el día | **Código pequeño** (diseño en `07`) |
| **P0-3** | **Activar la derivación al CRM** (lista de verificación en `07` §A) y programar el reintento | 14 respuestas «no puedo derivar» | Configuración + decisión operativa |
| **P1-0** | Crear casos de revisión para recetas `HUMAN_REVIEW`/`AUTO_PARTIAL` en modo instantáneo (`07` §G) | 10 análisis del día | Código pequeño |
| **P0-4** | Que el tope/guarda **no retenga** el texto de respaldo ni las derivaciones; subir el tope mientras se prueba su reemplazo | 9-10 | Configuración / código mínimo |
| **P0-5** | Registrar `status`/`code` en los rechazos de auditoría y la causa en los errores de IA; alertas | 4 + 20 | Código mínimo (solo log) |
| **P1-1** | **Cola de pendientes visible para la recepción** (Fase 1) | **24** + 3 tardíos | Código nuevo (`08`) |
| **P1-2** | Manejador mínimo para documentos/ubicación (registrar + derivar o pedir foto) | 2 lotes ahora; 13 mensajes | Código pequeño |
| **P1-3** | Respuesta de respaldo contextual (en lugar de texto genérico) cuando falla el modelo | 14 + 5 filtro | Código pequeño |
| **P2** | Estado de conversación, verificador por procedencia y agente (Fases 2+) | resto | Ya diseñado |

## 9. Correcciones a `05`
- Retenciones del día: **18** (no 17): `limited` **10** (no 9), `audit_guard_unavailable` 4, `blocked` 3, `superseded` 1.
- Lotes bajo pausa humana sin atención de nadie: **24** (no 39), con la ventana realista; 51 lotes se atendieron correctamente por una persona.
- «Fotos: 16 respondidas, 3 con precio» se refinó: **de 16 análisis, 4 llegaron con precio**; 6 de los 10 cotizables se perdieron después de calcular el precio (D1 ×4, pausa ×2).
- «Audios: 5 de 8 sin respuesta» se refinó: no hay un defecto de audio; ver §5.
