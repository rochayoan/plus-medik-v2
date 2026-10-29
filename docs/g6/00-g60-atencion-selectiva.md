# G6.0 / G6.1 · Atención selectiva, filtro previo y memoria conversacional

> **G6.1 (ajuste, ver sección 9):** el silencio nunca cierra ni toca una solicitud; «gracias», «ok gracias», «ok», «dale» y 👍 ya **no** equivalen a «sí». Donde esta página los menciona como confirmación, vale la sección 9.

Fecha: 2026-10-26. **Sin SQL remoto, sin llamadas a OpenAI, sin tocar el CRM, Supabase real ni Kapso, sin commit, push ni despliegue. Sin migración nueva.** Todo es local y queda **apagado por defecto** (`PLUSMEDIK_ATTENTION_FILTER`).

Objetivo: gastar lo mínimo —llamadas al modelo y mensajes de WhatsApp— sin romper conversaciones. El principio rector es **conservador: ante la duda, el mensaje se procesa.**

## 1. Cómo funciona el filtro

Dos puntos, ambos deterministas y ambos **antes** de cualquier modelo, visión, conocimiento o derivación:

| # | Dónde | Qué descarta | Costo |
| --- | --- | --- | --- |
| 1 | `processTurns` (`src/turns.ts`), **antes de reclamar el turno** | La **repetición literal** de un mensaje de texto del mismo contacto dentro de la ventana (90 s por defecto) | Cero: ni siquiera se escribe en la base |
| 2 | Manejador de texto (`src/text-handler.ts`), **antes de enrutar** | Un **saludo aislado**, una **cortesía/agradecimiento** hecha solo de un vocabulario cerrado, y un mensaje **sin letras** (emoji, signos, risas) | El turno se cierra auditado como «sin respuesta» (`NO_REPLY`); ni modelo, ni conocimiento, ni envío |

Lo que **nunca** se descarta (se evalúa primero, en `decideAttention`):

- **Urgencias y temas médicos** (`MEDICAL`) y **pedir a una persona** (`HUMAN_REQUEST`, incluido el mensaje tan largo que requiere a una persona): siguen su camino de siempre aunque lleven «hola» o «gracias» («me duele el pecho, gracias»).
- **Horarios y toda pregunta de información**, **cotizaciones** (texto o foto), **estudios con o sin pedir cotizar**, **respuestas a una solicitud abierta** («sí», «2», «el segundo», «eso nomás», «sí, esos estudios») y cualquier mensaje con una palabra que **no esté en el vocabulario social** («gracias, ¿y los horarios?», «ayuda», «no entiendo», «?», «¿hola?»).
- Las **fotos**: el filtro ni las mira (`sessionImageProducer` no lo conoce; una prueba estática lo verifica).
- **Pausa humana, idempotencia, guarda de respuestas y derivaciones**: no se tocan. Un turno descartado no envía nada; uno procesado pasa por la misma máquina de siempre (claim con lease, reserva, comprobación final).

### El vocabulario social (cerrado y conservador)
`socialOf(texto)` solo reconoce un mensaje de hasta 8 palabras hecho **exclusivamente** de saludos y cortesías (`hola`, `buenas tardes`, `gracias`, `ok`, `perfecto`, `listo`, `adiós`…), con **al menos una palabra ancla** (agradecimiento, acuse o despedida: «por favor» o «ayuda» solos no cuentan) y sin ninguna palabra de solicitud (estudios, precios, horarios, urgencias, personas). Reglas extra que nacieron de las pruebas:
- Un **signo de pregunta** vuelve el mensaje procesable («¿hola?» puede ser «¿hay alguien?»); solo un saludo de varias palabras lo admite («hola, ¿cómo están?»).
- Con un **«no»** solo se descarta el rechazo cortés («no, gracias»); «no entiendo», «no está bien», «no hay problema» se procesan.
- Un **pulgar arriba** (👍 ✅) es ruido: un acuse no confirma nada (G6.1).

### Repeticiones
`createRepeatTracker`: memoria **por instancia, de mejor esfuerzo**, solo una **huella SHA-256 truncada** de `contacto + texto normalizado` (nunca el texto ni el teléfono), acotada (2 000 entradas) y con caducidad. No prolonga la ventana con la repetición. **No** aplica a lo médico/humano, a las respuestas cortas de una solicitud abierta ni a mensajes de una palabra; y si el turno terminó en falla técnica o sin envío, la huella se **olvida** (el paciente que reintenta es atendido). Si la instancia cambia, el mensaje se procesa: la falla es siempre hacia procesar.

## 2. Mensajes que dependen del contexto
Se entienden con **reglas** y la solicitud abierta del contacto, sin modelo:

| Mensaje | Qué pasa |
| --- | --- |
| «¿cuánto sería todo?», «cuánto me sale en total», «el total por favor» | Pide el precio de lo anotado (nuevas frases de precio en `asksForPrice`) |
| «agrega glucosa», «añade TSH», «incluye hemograma», «falta la glucosa» | Suma el estudio (verbos nuevos como relleno); valida contra `lab_tests` y pregunta «¿Eso es todo?» |
| «el segundo», «la 3», «2» | Elige la opción numerada de una duda abierta |
| «sí», «sí, esos estudios», «eso nomás», «solo eso», «listo» | **Confirmación explícita**: cierra y cotiza lo anotado |
| «ok», «ok gracias», «dale», «vale», «perfecto», 👍 | **No** confirman: silencio (G6.1) |
| «gracias», «hola» con una solicitud abierta | **Se ignoran sin tocarla**: la solicitud sigue abierta (vence a los 30 min como siempre) |
| «listo» sin nada abierto tras una **cotización reciente** | Es un acuse: no se responde. Sin cotización reciente se explica como antes («no tengo nada anotado») |

## 3. Memoria conversacional: qué se reutilizó
**No se creó ninguna tabla, función ni migración** (siguen siendo 14; una prueba lo verifica). La memoria por contacto ya existía:

| Necesidad | Fuente existente |
| --- | --- |
| Estudios acumulados, fotos, aclaraciones y estado de la solicitud | Sesión de cotización (`plusmedik_quote_sessions/items`, G4.0/G5.9) vía `quoteRead` |
| Última cotización | `quoteLastStudies` (G4.1; ventana de 24 h) |
| Orden real de los mensajes de un contacto | `seq` del turno (G2.0), ahora expuesto en `TurnContext.seq` |
| Pausa humana / idempotencia / repetición de respuestas | Auditoría y guarda de respuestas (G2/G3.2), sin cambios |

Lo único nuevo en memoria es **volátil y por instancia** (se pierde sin consecuencias): la huella de repeticiones y la puerta de agrupamiento.

## 4. Qué contexto recibe OpenAI
**Antes de G6.0:** solo el mensaje actual, saneado (sin enlaces, correos ni números largos), con la categoría que detectó el sistema y las instrucciones/datos de `src/system-prompt.ts`. **No recibía historial.** `store: false`.

**Con G6.0 (y solo con `PLUSMEDIK_ATTENTION_FILTER=on` + sesiones de cotización):** además, un bloque con el **estado** de la conversación, calculado por el sistema, que se antepone al mensaje:

```
Estado de la conversación (lo calcula el sistema; no es un mensaje del paciente):
- Hay una solicitud de cotización abierta con 2 estudios identificados y una duda por aclarar.
- Ya se entregó una cotización reciente de 3 estudios.
```
- Solo **cantidades y banderas** (`ConversationContext`: `openRequest`, `openStudies`, `openDoubt`, `recentQuoteStudies`); cifras acotadas a 0–99 y frases fijas. **Nunca** nombres de estudios, precios, ids, teléfonos ni el texto de mensajes anteriores (el texto del paciente no se guarda, así que no hay historial que enviar).
- Se calcula **solo si hace falta** (justo antes de consultar al modelo) y si no se puede leer, el modelo recibe solo el mensaje. Lo médico, pedir a una persona, la información y los precios siguen sin pasar por el modelo.
- El prompt (`src/system-prompt.ts`) explica al modelo cómo usarlo («solo para entender referencias; no lo repitas ni menciones cifras») y que no tiene el historial. El filtro de salida existente sigue descartando cifras, precios y promesas.
- **Menos llamadas:** saludos, cortesías y ruido ya no llegan al modelo (antes una cortesía como «gracias» era `OTHER` y sí lo consultaba).

## 5. Evitar respuestas duplicadas y agrupar mensajes seguidos
- **Idempotencia** por mensaje (claim) y **repeticiones literales** (arriba), más la guarda de respuestas repetidas de G3.2: sin cambios.
- **Agrupamiento (nuevo):** cuando un paciente escribe estudios en varios mensajes seguidos, cada confirmación de «anotado» espera `PLUSMEDIK_ATTENTION_SETTLE_MS` (2 s por defecto). Si llegó un mensaje **más nuevo que también va a responder**, la anterior **calla** —su estudio YA quedó anotado en la solicitud— y la más nueva, que ve todos los estudios, confirma **una sola vez con la lista completa**. La puerta ordena por el número de turno que da la base (no por el orden en que esta instancia empieza a procesar) y la que confirma espera, acotado, a que terminen las anteriores.
- Un mensaje que no responde por esta vía (un saludo ignorado, una pregunta que atiende el manejador) se **retira** de la puerta: no silencia la confirmación de un estudio anterior. Una cotización pedida después («cotiza») reemplaza las confirmaciones pendientes.
- **Nunca se pierde un mensaje:** un mensaje silenciado ya está en la solicitud. Si cambia la instancia, se responde como antes (a lo sumo una confirmación de más).

## 6. Configuración (todo en blanco = apagado / valores por defecto)
| Variable | Efecto |
| --- | --- |
| `PLUSMEDIK_ATTENTION_FILTER=on` | Activa el filtro. **Solo** con `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_TEXT_HANDLER=on`; sola no tiene efecto |
| `PLUSMEDIK_ATTENTION_REPEAT_SECONDS` | Ventana de repetición, 5–600 (90) |
| `PLUSMEDIK_ATTENTION_SETTLE_MS` | Espera de la confirmación para agrupar, 0–10 000 (2 000); 0 = no agrupa |

Un valor inválido deja el filtro **apagado** (todo se procesa como antes) y se registra el código `attention_filter_config_invalid`. Los registros llevan códigos (`attention_filter {action, reason, category}`), nunca texto. **No requiere migración.**

## 7. Archivos
Nuevo: `src/attention-filter.ts` (puro). Modificados: `src/text-handler.ts` (filtro, frases de precio, contexto al modelo), `src/turns.ts` (repeticiones antes del claim, memoria), `src/guarded-turn.ts` (`attention` en la configuración, `TurnContext.seq`), `src/quote-session-turns.ts` (puerta, afirmaciones, «listo» tras cotizar), `src/quote-session.ts` (verbos de «agrega», «eso nomás», tipo de configuración), `src/conversation-model.ts` (`ConversationContext`, `contextBlock`), `src/system-prompt.ts` (una regla), `api/kapso/webhook.ts` (cableado), `.env.example`.
Pruebas: `attention-filter` (120: vocabulario con positivos y negativos, seguridad, repeticiones, puerta, configuración, turnos con repositorio simulado, contexto del modelo), `attention-boundaries` (17: fronteras estáticas), `attention-e2e` (8, contra PostgreSQL efímero con las 14 migraciones: webhook real, sesiones reales, flujo completo, agrupamiento de tres webhooks en paralelo, pausa humana, contexto del modelo con la base real), `production-defaults` (+2) y ajuste de `conversation-boundaries`. Suite completa: `tsc` limpio y 94 archivos / 2 830 pruebas verdes (la prueba de límites de G4.1 se ajustó: la consulta de «cotización reciente» vive en `turns.ts`). Ninguna llama a OpenAI, a Kapso ni a un Supabase remoto.

## 8. Pendiente / decisiones del laboratorio
- **Silencio ante un saludo:** con el filtro, un «hola» a secas **no recibe respuesta** (es lo pedido). Conviene que el laboratorio lo apruebe: el paciente solo recibe contestación cuando escribe algo accionable. El texto de saludo (`DRAFT_TEXTS.greeting`) queda sin uso con el filtro encendido.
- **Información no horaria** (direcciones, pagos, facturas, convenios…) **no se descarta** aunque la consigna menciona solo horarios: se considera posible solicitud. Si el laboratorio quiere ignorarla, es un cambio de una línea en `decideAttention`.
- **Memoria volátil por instancia** (repeticiones y agrupamiento): en producción con varias instancias simultáneas el efecto se reduce (falla hacia procesar). Si hace falta garantía, requeriría una tabla (otra migración) — no se hizo para no duplicar memoria.
- El vocabulario social y las frases de precio son una **semilla en español**; revisar con conversaciones reales en un entorno de ensayo.
- Probar el agrupamiento (2 s) con Kapso real: añade esa espera a la confirmación de «anotado» (no a las cotizaciones).
- Sin cantidades («2 hemogramas»), sin quitar estudios («quita la glucosa») y sin tolerancia a errores de tipeo (siguen pendientes de G5.9).

## 9. G6.1 · El silencio no es una confirmación
Ajuste sobre G6.0 (sin migración, sin llamadas a OpenAI, apagado por defecto igual que antes):

1. **Silencio absoluto:** saludos aislados, agradecimientos, cortesías, acuses y ruido (`hola`, `gracias`, `ok gracias`, `ok`, `dale`, `vale`, `perfecto`, 👍…) no reciben respuesta ni llegan a OpenAI. El turno se cierra solo como «sin respuesta» (`NO_REPLY`).
2. **El silencio nunca cierra, cancela, bloquea ni borra:** un mensaje ignorado no anota, completa, cierra ni cancela nada en la solicitud ni en su memoria (estudios, fotos, aclaraciones, última cotización). Verificado contra PostgreSQL: tras ocho mensajes de cortesía la sesión sigue `OPEN` con los mismos ítems.
3. **Después, todo sigue normal:** una cotización por texto o por foto se procesa como siempre y suma lo que ya estaba anotado; «¿cuánto sería todo?» sigue entendiéndose.
4. **«Gracias» y «ok gracias» no cierran una cotización pendiente.** Se quitó del código la regla de G6.0 que trataba una cortesía afirmativa como «sí» (`socialOf` ya no tiene `affirmative`), y `ok`, `okay` y `dale` salieron de las palabras que confirman en `parseSessionReply`; `gracias` ya no acompaña a ninguna confirmación (ni a un «no»: «no gracias» es una cortesía y se ignora).
5. **Saludo + solicitud = solicitud:** «Hola, cotízame glucosa» o «gracias, cuánto cuesta el hemograma» se atienden (cualquier palabra de solicitud saca al mensaje del silencio).
6. **Solo una confirmación explícita cierra** (según haya o no solicitud abierta): `LISTO`, «sí», «sí, esos estudios», «sí, eso es todo», «eso nomás», «solo eso», «correcto», «de acuerdo», «adelante», o pedir el total («¿cuánto sería todo?», «cotiza todo»). Sin solicitud abierta, esas frases no hacen nada.
7. **Seguridad intacta:** lo médico y pedir a una persona ganan al silencio aunque lleven «gracias» («ok gracias, quiero hablar con una persona» se deriva como siempre) y no tocan la solicitud.
8. **Costo:** el filtro sigue antes de cualquier modelo; lo ignorado no consume tokens ni consultas.

**Cambio de comportamiento a notar:** un «ok» o «dale» solos, que en G5.9 respondían «¿Eso es todo?» como un sí, ahora se ignoran; el paciente debe escribir «sí» o «listo». Es lo pedido (solo confirmaciones explícitas) y conviene que el laboratorio lo apruebe.
