> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 5d — revisión de restricciones del agente nuevo

Criterio del dueño: **conservar** memoria, gestor de objetivos, herramientas, cotizaciones verificadas, coordinación y protecciones existentes; **revisar** restricciones nuevas que impiden cotizar, límites que bloquean conversaciones y decisiones que debería tomar el modelo; **eliminar o simplificar** complejidad sin necesidad demostrada.
Estado: cambios solo en código y pruebas; **nada aplicado en Supabase ni Vercel, sin commit, el agente sigue sin encenderse.**

## Cambios hechos (todos con prueba)
| Restricción | Problema | Ahora |
|---|---|---|
| Cotizar solo si TODO quedaba identificado | un estudio dudoso dejaba sin cotizar a los demás | se cotiza lo identificado con certeza como **PARCIAL** (precios solo del catálogo, en el bloque del sistema); el hecho le dice al modelo que lo avise y pregunte por el resto (`QUOTE` + `CLARIFY`). La memoria deja lo dudoso pendiente (`UNRESOLVED`) y **no** anota las opciones ambiguas como cotizadas (referencias `option:` en vez de `study:`) |
| La etiqueta de las reglas (regex amplia: «vitamina», «diabetes»…) obligaba a derivar aunque el modelo entendiera otra cosa | contradecía las instrucciones («la etiqueta es solo una pista») | **manda lo que el modelo leyó**; la etiqueta rige solo si el modelo no leyó esa petición |
| Un mensaje de salud no podía cotizarse | «tengo diabetes, cuánto cuesta la glucosa» quedaba sin cotización | un tema de salud admite `DEFER`, `HANDOFF` y **`QUOTE`** (la cotización la arma el sistema y no interpreta nada); sigue sin poder `ANSWER`/`CLARIFY`/`ACK` |
| Cualquier palabra de moneda se rechazaba (`PRICE_OUTSIDE_QUOTE`) | «aceptamos dólares y bolivianos» (formas de pago aprobadas) era rechazado | se rechaza una **cifra** de dinero (símbolo, o número —en cifras o letras— junto a una moneda); nombrar una moneda no |
| «una persona», «el equipo», «registr…» a secas contaban como promesa de atención | «el equipo toma muestras de 7 a 10» o «ven con una persona de confianza» se rechazaban | solo cuenta lo que **promete una acción** («una persona del laboratorio te contactará», «registrar tu caso», «nuestro equipo te escribirá») |
| Texto del paciente cortado a 500 caracteres | una lista larga de estudios se cotizaba incompleta en silencio | 1 500 caracteres |
| Tope de salida 400 (plan) y 900 (respuesta) tokens | en la API Responses el razonamiento cuenta dentro del tope: con razonamiento medio la salida podía quedar vacía o cortada y todo turno caía al agente anterior | techos 2 500 y 4 000 (se paga lo usado) |
| Comentario obsoleto («porcentaje de despliegue») | quedaba de antes de quitar el rollout | corregido |

## Métodos de pago: IGNORADOS por ahora (decisión del dueño)
Hasta que se implementen los métodos de pago, **nadie** dice nada de cómo pagar: ni «sí se puede pagar con QR» ni montos. Pero **no se bloquea nada**: lo de pagos se ignora y el resto se atiende como siempre. Ejemplo: «hola» + «quiero cotizar hemograma» + «voy a pagar por QR» → se cotiza el hemograma y del QR no se dice nada. Módulo puro: `src/payment-talk.ts`.
- **Entrada (`processTurns`, bandera `ignorePayment: true` en el webhook)**: de cada mensaje de texto se **quitan las frases de pago** («quiero cotizar hemograma y pago con QR» → «quiero cotizar hemograma») y un mensaje que es **solo** de pagos no se atiende (ni se reclama, como una repetición). Sirve igual para el agente de siempre y el nuevo, porque ambos reciben ya el texto limpio.
- Se conserva la frase si es de **salud** o de **pedir a una persona**, y la pregunta de **precio** aunque diga «pago» («¿cuánto pago por un hemograma?»).
- **Agente nuevo**: además, los mensajes anteriores (historial) también se recortan antes de llegar al modelo; el modelo tiene la instrucción de no mencionar pagos y, si lo hace, **esas oraciones se ignoran** (no se rechaza el mensaje; solo se rechaza si lo único que dijo eran pagos y no queda nada). `lab_info` no devuelve datos de pago (`skipPayment: true` en el conocimiento).
- Para reactivarlo cuando se implementen los pagos: quitar `ignorePayment` y `skipPayment` del webhook, el recorte en `pipeline.ts`/`shadow.ts` y la línea de pagos de las instrucciones.
- Límite conocido: el recorte es por frases; si una misma frase mezcla compra y pago sin separador («hemograma con pago QR») se pierde entera.

## Conservado a propósito
Memoria (eventos, reductor, pendientes), herramientas (`lab_info`, `find_studies`, `quote_studies`, `conversation_state`), precios solo del catálogo, cifras/horas/teléfonos/enlaces solo de hechos citados o del paciente, nada de consejos médicos, sin promesas de una persona mientras la derivación esté apagada, un solo envío por lote, lease/reserva/pausa humana/idempotencia, interruptor de la base, corta-circuito y agente anterior como respaldo.

## Evaluado y NO tocado (sin evidencia aún)
- **Tope diario 6**: decisión del dueño. Casi igual al global (5); al alcanzarlo el paciente deja de recibir respuestas automáticas ese día. Es la restricción que más puede cortar conversaciones; se decide con datos de las primeras horas.
- **Dos llamadas al modelo (plan + respuesta) y hasta 2 intentos**: simplificarlo a una sola llamada ahorra latencia pero es un cambio de diseño que hoy no se puede medir (no hay clave en este entorno). Revisar con los `latencyMs`/`repairs` reales.
- **Modo `pilot` (lista de teléfonos) y su tope propio**: sigue siendo la vía para probar con el propio número antes del 100 %; se puede borrar cuando ya no haga falta.
- **`PLUSMEDIK_AGENT_SAMPLE` (modo sombra) y la derivación al CRM**: inertes o apagados; no estorban.
- **Límite de 900 caracteres del texto del redactor (sin contar la cotización)** y **4 llamadas a herramientas por turno**: holgados para WhatsApp; sin evidencia de que corten nada.

## Qué mirar con el modelo real (cuando haya clave)
`repairs` y `REJECTED` por código de violación: si un código se repite, es una restricción que sobra o una instrucción que falta. Ese es el criterio para el siguiente recorte.
