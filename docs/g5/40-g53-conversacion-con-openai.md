# G5.3 · Conversación natural con OpenAI (preparada, APAGADA)

> **Ampliado por [G5.6](60-g56-prompt-como-configuracion-principal.md):** con `PLUSMEDIK_LLM_BUSINESS_INFO=on` el modelo también puede informar los datos comerciales CONFIRMADOS del archivo principal (nueva intención `BUSINESS_INFO`), con respaldo verificado por código. Lo descrito aquí rige tal cual cuando esa bandera está apagada.

Fecha: 2026-10-25. Rama `feat/g2-turnos`. **No se llamó a OpenAI, no se ejecutó ninguna prueba (`vitest`), no se tocó el CRM ni Supabase real, no hubo commit, push ni despliegue.** Se corrió `tsc --noEmit` (sin errores) y una comprobación local de las funciones puras del filtro y del saneamiento (sin red). **G5.4 (cierre):** las 42 pruebas nuevas y las 29 adversariales pasan, y la suite completa quedó en 90 archivos / 2511 pruebas en verde con `tsc` sin errores (ver §10).

## 1. Principio

El modelo **conversa y clasifica**; no decide ningún dato. Los precios y estudios siguen saliendo SOLO del catálogo (`lab_tests`); los horarios, direcciones, teléfonos, pagos, políticas, preparación, plazos y resultados, SOLO del conocimiento aprobado; la derivación a una persona, la seguridad clínica y los controles de turnos/bucles son los de siempre. El motor de cotizaciones, las sesiones, el conocimiento, los datos por estudio y la cola al CRM **no conocen** esta capa (prueba estática escrita).

## 2. Flujo (qué mensajes llegan al modelo y cuáles no)

```
mensaje de texto ─► ¿automático o eco de un texto nuestro? ──sí──► sin respuesta (como antes)
        │ no
        ▼
  clasificación por reglas (sin modelo)
   ├─ MEDICAL / HUMAN_REQUEST / INFO_REQUEST ─► camino determinista de siempre   ◄── NUNCA llegan al modelo
   │      (conocimiento aprobado · derivación al CRM · aviso médico)
   └─ GREETING / OTHER / RECIPE_OR_QUOTE
          ├─ OTHER: primero el conocimiento aprobado (si responde, se acabó)
          └─ ¿la categoría está habilitada para el modelo? (por defecto GREETING y OTHER)
                 ├─ no ─► texto fijo
                 └─ sí ─► OpenAI (JSON estricto {intent, reply})
                            ├─ intent = MEDICAL | HUMAN_REQUEST | INFO_REQUEST ─► se DESCARTA su texto y se
                            │        retoma el camino determinista de esa categoría (una sola consulta al modelo)
                            ├─ salida inválida / error / tiempo / circuito abierto ─► texto fijo
                            ├─ el filtro de salida la rechaza ─► texto fijo
                            └─ pasa el filtro ─► se envía (con la misma firma, obsolescencia y topes que un texto fijo)
```

**Segunda red de seguridad:** hoy una frase médica o de información que las reglas no reconocen («no me siento bien») cae en `OTHER` y recibe el texto genérico. Con el modelo, si él la reconoce, el mensaje retoma el camino médico/informativo/derivación. El modelo solo puede **llevar un mensaje a un camino más conservador**, nunca a uno que invente.

## 3. Controles (qué garantiza qué)

| Riesgo | Control | Dónde |
| --- | --- | --- |
| Que invente precios, horarios, preparación, plazos, resultados o datos comerciales | Prompt que lo prohíbe **y** filtro determinista de salida: rechaza cifras, moneda, enlaces/correos, palabras de datos del laboratorio, de tiempo o de promesa; la respuesta rechazada se reemplaza por el texto fijo | `guardModelReply` |
| Orientación médica | Los mensajes médicos por reglas no llegan al modelo; si el modelo los reconoce se descarta su texto; el filtro rechaza términos médicos y medicamentos | text-handler + filtro |
| Prometer una persona, un plazo o «pronto» | El filtro rechaza «una persona/el equipo/te llamaremos/te escribirá…» y promesas de tiempo; «una persona del equipo…» solo sale de los textos fijos con el caso ya registrado | filtro + CRM |
| Fugas del prompt o instrucciones del paciente | El mensaje va entre comillas triples como texto a clasificar; las comillas triples del paciente se neutralizan; el filtro rechaza palabras de fuga (`prompt`, `instrucciones`, `json`…) | prompt + sanear + filtro |
| Salida fuera de formato / otro idioma / basura | JSON estricto con esquema; validación propia; el filtro rechaza otros alfabetos, más de 3 emojis, comillas/código, > 400 caracteres | esquema + filtro |
| Bucles con otro bot y costo | **Exige** la guarda de respuestas (G3.2) encendida y válida; el eco de nuestros textos y los mensajes automáticos no se responden (ni llegan al modelo); tope de respuestas por contacto | resolver + guarda |
| Caídas o lentitud del proveedor | Tiempo máximo por llamada (8 s por defecto), sin reintentos ocultos (`maxRetries: 0`), circuito abierto tras 3 fallas seguidas por 60 s (por instancia): se responde con el texto fijo | adaptador + circuito |
| Salir a la red en pruebas | El adaptador respeta el modo offline (`assertModelCallsAllowed`) | adaptador |
| Datos del paciente en el proveedor | `store: false`; solo el mensaje recortado (500 caracteres por defecto) y saneado (enlaces, correos y números largos reemplazados); el teléfono nunca forma parte de la entrada; el registro solo lleva códigos y contadores | adaptador + sanear + registro |
| Activación accidental | Apagada salvo `PLUSMEDIK_LLM_CONVERSATION=on` **y** modelo, clave, turnos, manejador de texto y guarda; cualquier faltante la deja apagada y se registra un **código** | resolver |

## 4. Configuración (variables de entorno; todas en blanco en `.env.example`)

| Variable | Obligatoria | Detalle |
| --- | --- | --- |
| `PLUSMEDIK_LLM_CONVERSATION` | para activar | Solo `on` la enciende |
| `OPENAI_API_KEY` | sí | La misma del motor de recetas |
| `OPENAI_CONVERSATION_MODEL` | sí | **Sin valor por defecto**: elegirlo es una decisión del dueño (costo, calidad, retención) |
| `OPENAI_CONVERSATION_REASONING` | no | `low`·`medium`·`high`·`xhigh`·`max`, solo si el modelo lo admite |
| `PLUSMEDIK_LLM_CATEGORIES` | no | `GREETING,OTHER` (defecto); `RECIPE_OR_QUOTE` solo si se quiere frasear con el modelo el pedido de la foto |
| `PLUSMEDIK_LLM_SILENCE_OFF_TOPIC` | no | Solo `on` la enciende (apagada por defecto). Un mensaje **claramente ajeno** al laboratorio no recibe respuesta. Quien interpreta si el mensaje tiene relación con el laboratorio es el modelo (`OFF_TOPIC`, con el mensaje y el estado de la conversación; ambiguo ⇒ no se silencia); el sistema solo conserva tres protecciones deterministas: categoría `OTHER` (lo médico y lo humano nunca llegan al modelo), ninguna solicitud abierta / duda / cotización reciente con el contacto (esperando a los mensajes anteriores del lote; si no se puede saber, se responde) y que el texto no parezca de salud. No hay listas de temas del laboratorio. Sin la categoría `OTHER` se ignora y se registra `SILENCE_NEEDS_OTHER`. Vale igual para audios transcritos y lotes |
| `PLUSMEDIK_LLM_TIMEOUT_MS` | no | 1000–30000 (8000) |
| `PLUSMEDIK_LLM_MAX_OUTPUT_TOKENS` | no | 50–2000 (300) |
| `PLUSMEDIK_LLM_MAX_INPUT_CHARS` | no | 50–2000 (500) |

Dependencias: `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_TEXT_HANDLER=on` y `PLUSMEDIK_REPLY_GUARD=on` (válida). **Apagarla** es poner en blanco la bandera: los textos fijos reaparecen sin desplegar código.

## 5. El prompt (`agent-config/system-prompt.es.md`)

Reestructurado en dos partes: el **prompt de conversación** (entre las marcas `PROMPT:BEGIN/END`; ≈ 3 600 caracteres) es lo único que se envía; la **especificación general** del agente queda como referencia. Se convierte a código con `npm run agent-config -- prompt --write` (genera `src/conversation-prompt.generated.ts` con su sha256) y una prueba falla si el código no coincide con el archivo. Cada llamada registra los 12 primeros caracteres del sha256 del prompt para saber qué versión produjo cada respuesta. **Sigue siendo un borrador sin aprobar por el laboratorio** y no contiene ningún dato suyo.

## 6. Lo que sale a OpenAI (decisión de privacidad del laboratorio)

Sale: el texto del mensaje del paciente (hasta 500 caracteres, con enlaces, correos y números largos reemplazados) y la categoría detectada. **No** sale: el teléfono, el identificador del contacto, imágenes, cotizaciones, precios ni conocimiento del laboratorio. **Riesgo residual:** el texto puede contener nombres propios o datos de salud que no se pueden quitar de forma fiable (los mensajes médicos por reglas no se envían, pero «me siento raro» sí podría). Por eso se exige antes de activar: aprobación de privacidad del laboratorio, revisar las condiciones de retención del proveedor para esa cuenta/proyecto, y un aviso al paciente si el laboratorio lo decide.

## 7. Costo y latencia

Una llamada por mensaje elegible (saludo / sin clasificar), con ≈ 900–1 200 tokens fijos de prompt (estimación por longitud, **no medida**) más el mensaje y hasta 300 de salida. No se hizo ninguna llamada ni se midió gasto. Topes: categorías, recorte de entrada, tokens de salida, la guarda de respuestas por contacto, el circuito. **Falta** un tope diario global (requeriría estado compartido en la base; no existe) y la medición con una muestra real autorizada dentro del presupuesto acordado.

## 8. Archivos

`src/conversation-model.ts` (puerto, saneamiento, filtro, circuito, lógica) · `src/conversation-openai.ts` (adaptador y configuración) · `src/conversation-prompt.generated.ts` (generado) · `src/text-handler.ts` (punto de inserción: `route` + `baseReply`, `conversation?` opcional) · `api/kapso/webhook.ts` (cableado) · `scripts/agent-config.ts` (`prompt`) · `.env.example` · `tests/conversation-model.test.ts` (31 casos) · `tests/conversation-boundaries.test.ts` (11) — **escritas, sin ejecutar**.

## 9. Pendiente / requisitos para activar

1. ~~Ejecutar las pruebas nuevas y la suite completa~~ — hecho en G5.4 (§10).
2. **Decidir el modelo** y aprobar el prompt; **aprobación de privacidad** y revisión de retención del proveedor.
3. **Evaluación de la clasificación** con mensajes reales o sintéticos etiquetados (¿con qué frecuencia el modelo deja pasar como conversación algo médico o informativo?), dentro del presupuesto de gasto acordado, antes de encenderlo en un número piloto.
4. Revisar el **filtro** con los mensajes reales de ese piloto: demasiado estricto = texto fijo de más (seguro); demasiado laxo = riesgo. Ajustar con casos, no con recetas.
5. Tope diario global de llamadas y alerta cuando el circuito se abra (hoy solo se registra `CIRCUIT_OPEN`).
6. **No cubre aún:** memoria de la conversación (cada mensaje se atiende solo; el sistema no guarda el texto del paciente), reformular con el modelo las respuestas del conocimiento aprobado (exigiría verificar cada cifra contra el registro aprobado, como hace G4.1), ni conversaciones largas con estado.
7. Orden de banderas: … → `PLUSMEDIK_REPLY_GUARD` → `PLUSMEDIK_TEXT_HANDLER` → … → **`PLUSMEDIK_LLM_CONVERSATION`** (la última; en un número piloto con `ALLOWED_PHONES`).

## 10. Cierre G5.4 (verificación)

- **Pruebas:** `conversation-model` (31) y `conversation-boundaries` (11) pasaron a la primera. Se añadió `tests/conversation-adversarial.test.ts` (29): un cliente simulado **hostil** (precios, cotizaciones, horarios, datos clínicos, promesas, fugas, otros alfabetos) nunca logra que su texto llegue al paciente; lo médico/persona/información sigue derivando por el sumidero; un modelo que pide derivar no puede evitar la derivación médica ni desbloquear una derivación bloqueada, y si el CRM no registra el caso no hay promesa; el proveedor no recibe teléfono, correo ni identificadores; sin la bandera exacta no existe el modelo.
- **Hallazgo y corrección:** la prueba adversarial detectó que «Llámanos al número de la clínica» pasaba el filtro. Se agregaron al filtro las palabras de contacto (`llam*`, `numero*`, `contacto*`, `whatsapp`…) y se ordenó la comprobación de promesas de una persona antes que la de datos del laboratorio (mismo rechazo, motivo más específico).
- **Suite completa:** 90 archivos / 2511 pruebas en verde; `tsc --noEmit` sin errores. Una corrida intermedia falló la prueba de verificación de migraciones (el bloque con PostgreSQL efímero, 13 pruebas omitidas) bajo carga; sola pasa (19/19) y la corrida completa siguiente quedó en verde. No se capturó el detalle del error: sospecha de arranque de PostgreSQL efímero bajo carga (intermitente, no relacionada con G5.3).
