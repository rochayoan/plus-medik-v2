# G7 · Fase 4 — piloto del nuevo agente (un número autorizado)

Estado: **implementado y probado; NO desplegado; las migraciones 24 y 25 NO están aplicadas a ningún Supabase; no hay commit.** Apagado por defecto en tres capas independientes (variable, lista de números e interruptor de la base).

## 1. Qué es el piloto

El núcleo conversacional (G7 fases 1–3) **responde de verdad**, pero solo:

1. con `PLUSMEDIK_AGENT=pilot` en el despliegue,
2. a los números de `PLUSMEDIK_AGENT_PILOT_PHONES` (de 1 a 5, solo dígitos), y
3. mientras el **interruptor de la base** diga «encendido» (migración 25; **nace apagado**).

Todos los demás contactos siguen con el agente actual **sin ninguna llamada nueva** (ni al modelo, ni al interruptor, ni al historial). En modo piloto no corre la sombra para los demás.

### Cómo responde sin un camino de envío paralelo
El piloto **no envía**. `src/agent/pilot.ts` decide y verifica la respuesta y se la entrega a `src/turns.ts`, que la manda por la MISMA máquina de siempre (`guarded-turn`): claim con lease, reserva de envío, comprobación de pausa humana justo antes de enviar, un solo envío por lote, idempotencia por mensaje, guarda de respuestas y tope diario. Los demás mensajes del lote se cierran sin respuesta.

### Si el piloto no puede o no debe responder, responde el agente de siempre
Interruptor apagado o ilegible · modelo caído (cuota, 429, tiempo) · salida inválida · verificación fallida (cifra inventada, precio escrito por el modelo, promesa de una persona, tema de salud respondido…) tras **una** reparación · derivación no registrada · plazo vencido (40 s por omisión; ver docs/g7/15) · lote con fotos/documentos · una persona al mando. En todos esos casos el lote sigue **completo** por la ruta de siempre (un contacto con un solo mensaje, por la ruta individual de siempre), que todavía no había tocado nada: el paciente recibe exactamente lo de hoy, una sola vez.

## 2. Inteligencia conversacional (lo que cambia respecto a hoy)

| Antes (agente actual) | Piloto |
|---|---|
| Expresiones regulares deciden la intención y qué se responde | El **modelo entiende la intención** (QUOTE, INFO, HUMAN, MEDICAL, FOLLOW_UP…) leyendo el mensaje y los anteriores; la etiqueta de las reglas es solo una pista. Gana lo más estricto: si el modelo entiende «salud», solo se puede derivar o aplazar |
| Un texto fijo cuando no hay certeza | Respuesta natural cuyos datos se **verifican por procedencia** (cifras, horas, teléfonos, enlaces solo de hechos citados o del mensaje del paciente); sin cifras de dinero del modelo |
| Varias preguntas → una respuesta, a veces la genérica | Una petición por mensaje; cada una **debe** quedar cubierta por un acto (responder, aclarar, cotizar, aplazar con honestidad, derivar) |
| Sin memoria entre mensajes | Memoria de la fase 1 (pendientes, última cotización, última receta por nombres), **mensajes recientes del historial** (sin el lote actual; los de salud tapados) y **pendientes de antes** como peticiones que hay que cubrir |
| Un pendiente atendido de otro tema queda abierto | La respuesta **declara qué pendientes atendió** (`closes`) y hasta qué lote contestó (`upto`): se cierran los atendidos y no se da por atendido lo que llegó mientras se respondía |
| Cotiza con el motor y el catálogo | Igual: `quote_studies` usa el **mismo motor**; el modelo nunca ve ni escribe precios; el sistema agrega el bloque con los precios del catálogo |
| Derivación al CRM bloqueada | Derivación real **solo si** `PLUSMEDIK_AGENT_HANDOFF=on` y hay cola al CRM: el caso se registra con el lease del turno **antes** de responder, y el mensaje solo promete a una persona si el CRM lo registró |

Correcciones hechas en la memoria al probar: **todo evento** (el lote del paciente, la respuesta del agente y el mensaje de la recepción) se fecha con el instante de **observación** (ms, una sola base de tiempo), no con la marca en segundos de Kapso (una respuesta en el mismo segundo cerraba por error el mensaje siguiente, y la contestación de la recepción no cerraba lo que acababa de contestar), y las respuestas del piloto fijan su **calidad** (cotizado / aplazado → sin resolver / sin derivación) en vez de deducirla del texto.

## 3. Interruptor (desactivación inmediata)

```sql
select public.plusmedik_agent_pilot_set(true,  'inicio del piloto con mi número');   -- enciende
select public.plusmedik_agent_pilot_set(false, 'apagado de emergencia');             -- apaga YA
select public.plusmedik_agent_pilot_state();                                          -- estado
select * from public.plusmedik_agent_pilot_log order by id desc;                      -- quién/cuándo (sin datos de pacientes)
```
- Lo ejecuta quien administra la base (editor SQL de Supabase). **Ningún rol de la API puede cambiarlo** (ni `service_role`).
- La aplicación lo lee con un vencimiento de **5 s como máximo** antes de cada lote: apagarlo surte efecto en segundos, **sin redesplegar**.
- **Falla cerrado**: si la base no responde, el piloto no responde. Un «encendido» viejo no se reutiliza tras un error.
- Reaplicar la migración no cambia su estado.

## 4. Qué se envía al modelo

Qué se envía a OpenAI: el texto de los mensajes de los pacientes **tal cual lo escriben** (decisión del dueño, 6-nov: no se tapan datos personales ni se retienen mensajes de salud). No viajan la clave, el teléfono de la conversación ni los ids de la plataforma; `store:false`; los registros de Vercel llevan solo códigos y contadores (nunca el texto). La regla de que el agente **no da consejos médicos** (solo aplaza o deriva) sigue vigente: es una regla de seguridad del agente, no de privacidad.

## 5. Despliegue controlado (preparado; NO ejecutado)

1. **Migraciones a mano** en el Supabase de producción, tras `supabase/preflight/v2_pre_apply_read_only.sql`: **24** (memoria) y **25** (interruptor, historial reciente). Son aditivas y reaplicables.
2. **Variables en Vercel (Production)**: `PLUSMEDIK_AGENT=pilot`, `OPENAI_AGENT_MODEL=<modelo>`, `OPENAI_AGENT_REASONING=medium`, `PLUSMEDIK_AGENT_PILOT_PHONES=<su número, solo dígitos con código de país>`; opcional `PLUSMEDIK_AGENT_PILOT_DAILY_MAX` (40). Debe estar `PLUSMEDIK_TURNS=on` (ya lo está) y conviene `PLUSMEDIK_KNOWLEDGE_ANSWERS=on` para `lab_info`. **No** poner `PLUSMEDIK_AGENT_HANDOFF=on` mientras el CRM no esté validado.
3. Antes de desplegar: `npx tsx scripts/g7/agent-live-eval.ts --preflight` con esas variables (sin llamar a nadie; no imprime la clave ni el teléfono).
4. **Desplegar con el interruptor APAGADO.** Debe verse `agent_scope {mode:"pilot", phones:1, …}` y, solo para su número, `agent_pilot {status:"FALLBACK", reason:"SWITCH_OFF"}`; para todos los demás, nada nuevo.
5. Encender: `select public.plusmedik_agent_pilot_set(true, '…');` y escribir desde el número del piloto. Debe verse `agent_pilot {status:"VERIFIED", …}` y la respuesta del agente nuevo.
6. Observar: `agent_pilot.status` (`VERIFIED`, `REJECTED`, `MODEL_ERROR`, `HANDOFF_FAILED`, `FALLBACK`), `violations`, `repairs`, `latencyMs`, `usage`, `modelError.cause` (`QUOTA_OR_BILLING`, `RATE_LIMIT`, `TIMEOUT`…).

### Reversión (de la más rápida a la más completa)
1. **`select public.plusmedik_agent_pilot_set(false, 'motivo');`** → en ≤ 5 s el agente actual atiende a todos, también al número del piloto.
2. Quitar `PLUSMEDIK_AGENT` (o ponerlo en `off`) y redesplegar → el piloto deja de existir en el código en ejecución.
3. Las migraciones son aditivas: no hace falta revertirlas. Lo ya enviado al paciente no se puede retirar (como siempre).

## 6. Verificación hecha (pruebas específicas; la suite completa no se repitió)

| Prueba | Qué demuestra |
|---|---|
| `tests/agent-pilot-e2e.test.ts` (21; webhook + turnos + PostgreSQL reales) | **aislamiento**: con el piloto encendido para otro número, mismos envíos, corridas de auditoría, historial y llamadas a la base; ni una consulta del interruptor ni del historial reciente; el modelo no se toca · el número del piloto recibe la respuesta del agente nuevo por la ruta de envío (una sola; precios solo del catálogo; historial y memoria) · interruptor apagado → lo de siempre · **apagado inmediato** sin redesplegar · **falla cerrado** · reentrega ×3 y entregas simultáneas → una respuesta · lote de 3 → una respuesta · **pausa humana** · fotos → ruta de siempre · tope propio del piloto sin tocar el de los demás · modelo caído/cifra inventada/precio/plazo → el paciente recibe exactamente lo de siempre, una vez · pendientes de antes llegan y se cierran · aplazos quedan visibles · mensajes recientes · cambio de tema · derivación (sin CRM, con CRM, CRM que falla) · **reanudación manual** · privacidad |
| `tests/agent-pilot.test.ts` (19) | lista de números, interruptor (caché corto, falla cerrado, lecturas compartidas), decisión y respaldo ante cualquier problema, plazo y derivación tardía, derivación real, mensajes recientes, configuración |
| `tests/agent-pilot-db.test.ts` (14; PostgreSQL real) | migración 25: nace apagado, nadie de la API lo cambia, rastro, reaplicable, lecturas STABLE; mensajes recientes (solo texto legible, orden, límite, ids excluidos, vencidos, recorte a 600, validaciones, roles) |
| `tests/agent-boundaries.test.ts` (12) | el piloto solo lee dos funciones STABLE, no envía; los turnos solo desvían un contacto de la lista y un lote de texto, después de reclamarlo, con respaldo exacto; el cableado fija las condiciones; variables en blanco |
| memoria: `g7-phase1-state`, `conversation-state-store`, `conversation-state-db`, `conversation-state-e2e` | `closes`/`upto`, fecha de observación, codificación |
| cadena de migraciones | preflight, orden y cantidad (25) |

## 7. Qué falta para que sea verdaderamente operativo (honesto)

1. **Nunca se ha probado con un modelo real de OpenAI.** Toda la prueba usa dobles y un servidor local. El propio piloto de un número es la primera prueba real; por eso empieza con el interruptor apagado y se observa antes de ampliar. Si el verificador rechaza respuestas correctas de un modelo real, el paciente recibe lo de siempre (sin daño) y queda `violations` en el registro para ajustarlo.
2. **Fotos, audios que no se transcriben y documentos**: siguen por el motor actual. Un lote con una foto (aunque traiga texto) no pasa por el agente nuevo. El agente conoce el resultado después (memoria: última receta y cotización), pero no lee imágenes.
3. **Derivación humana**: la cola al CRM **no está configurada ni validada en producción**. Hasta entonces, un pedido de hablar con una persona o un tema de salud se **aplaza con honestidad** (queda pendiente a la vista de la recepción) y no se promete nada. Para activarla: validar el CRM (lista de `docs/g7/07`) y poner `PLUSMEDIK_AGENT_HANDOFF=on`.
4. **Reanudación**: sigue siendo manual (decisión vigente). Al reanudar, lo pospuesto por la pausa se reabre y el agente lo ve como pendiente; no hay reanudación automática.
5. **Tope diario de 5 respuestas**: sigue igual para todos; el piloto tiene su tope propio (40) solo para su número. Falta el reemplazo probado del tope global.
6. **Ampliar del piloto a más gente** requiere: una semana observando tasas de `VERIFIED` a la primera, rechazos leídos a mano, latencia y costo; revisión de calidad de las respuestas del número del piloto (están en el historial); y decidir qué hacer con fotos y derivación.
7. **Selección del modelo**: sin convertirla en otro proyecto, basta con `OPENAI_AGENT_MODEL` y mirar `agent_pilot` del número del piloto; cambiarlo es cambiar una variable.
8. **Sin almacén de propuestas rechazadas**: cuando el verificador rechaza, el texto propuesto no se guarda; solo los códigos. Si hace falta leerlos para ajustar, hay que decidir una retención explícita.
