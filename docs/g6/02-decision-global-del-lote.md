# G6.2 · Decisión global por lote (Fases 1 y 2)

Estado: implementado y probado. La Fase 3 lo conectó a los turnos **apagado por defecto** (ver `03-conexion-del-motor-de-lotes.md`: bandera `PLUSMEDIK_BATCH_ENGINE`, modo sombra y respaldo). Sin la bandera, la ruta actual no cambia.

## Idea

Hoy un lote de Kapso se procesa mensaje por mensaje y las respuestas se pegan después. El rediseño decide **una vez por lote**: entiende toda la solicitud, decide qué responder con una tabla pura y compone UN mensaje con bloques tipados. Así no hay acuses intermedios ni frases genéricas que descartar, y una intención clara con estudios resueltos cotiza directo.

```
mensajes del lote ──► comprender ──► decidir (tabla pura) ──► ejecutar ──► componer ──► UN Produced
                      batch-understanding  batch-policy       batch-execution  batch-compose
```

| Módulo | Qué hace | Efectos |
| --- | --- | --- |
| `src/batch-understanding.ts` | Reconstruye nombres de estudios partidos por **cobertura del catálogo** (sin listas de frases), separa seguridad/comandos/preguntas, resuelve la **negación** y detecta la intención. Puede apoyarse en OpenAI (puerto inyectado). | ninguno (puro) |
| `src/batch-policy.ts` | Plan tipado: bloques de seguridad y avisos + UN bloque principal (`QUOTE`, `CLARIFY`, `SUMMARY`, `REVIEW`, `DECLINED`, `CANCELLED`, `PROMPT`, `NONE`...). | ninguno (puro) |
| `src/batch-compose.ts` | Renderiza el plan con los textos fijos de siempre, en orden fijo (seguridad → avisos → principal). | ninguno (puro) |
| `src/batch-execution.ts` | Ejecuta el plan contra las sesiones **existentes** (`quoteRead/quoteBegin/quoteClose`), cotiza con el catálogo recargado y devuelve el `Produced` de la máquina de envío de siempre. | sesiones (con owner + fence) |

## Reglas

- **Cotización directa**: intención clara (o confirmación) + todo resuelto → se anota, se cierra la sesión y se cotiza, sin pedir otra confirmación. Los **precios salen de `lab_tests` recargado al cotizar**; el plan y el modelo nunca los llevan. La base verifica que lo cotizado sea exactamente lo identificado.
- **Ambigüedad**: no se cotiza; se pregunta solo el primer grupo con sus opciones, y solo el nombre de lo que no se identificó. «Listo» con dudas cierra a revisión.
- **Negación general**: una palabra de negación (no, nunca, jamás, tampoco, ni) anula hasta el final de **su cláusula** (puntuación, «pero», «sino», «aunque»). Lo anulado no cuenta como estudio ni como intención: «no quiero cotizar» → `DECLINE` (se respeta, no se cotiza ni se insiste); «no quiero hemograma, quiero glucosa» → solo glucosa. La excepción la dicta el catálogo (si la negación es parte del nombre de un estudio reconocido, no es negación). Un «no» que es el mensaje entero sigue siendo la respuesta «falta algo».
- **Seguridad primero y sin depender de nada**: lo médico y pedir a una persona se separan antes de interpretar, nunca llegan al modelo y siempre reciben su respuesta aunque falle la sesión, el catálogo o el cierre (si el manejador de siempre falla se usa el texto fijo seguro). Insertar un mensaje de seguridad nunca cambia los estudios ni la decisión de fondo.
- **OpenAI de apoyo**: una consulta por lote y solo si queda algo sin resolver o la intención no está clara. Su salida se valida contra el catálogo (ids inventados o inactivos, ambigüedades de una opción y campos extra —precios— se descartan). Una sigla desconocida exige que el modelo la mencione explícitamente para dejar de bloquear.
- **Un turno cierra una sola sesión** (la base es idempotente por corrida): si el lote cancela la solicitud abierta y pide otra, se cancela, se anota lo nuevo y se pide confirmar en lugar de cotizar en el mismo turno.

## Cómo se conectó y qué falta

1. HECHO (Fase 3): bandera apagada por defecto + modo sombra que compara el plan con la respuesta actual (solo códigos) + respaldo a la ruta de siempre. Ver `03-conexion-del-motor-de-lotes.md`.
2. Pendiente (fase posterior, tras observar el modo sombra): retirar `text-fragments.ts`, la marca `generic` y la fusión de cadenas (`mergeProduced`) de la ruta de texto.

## Límites conocidos

- La intención de cotizar sin modelo usa la detección de verbos de siempre (`wantsQuoteNow`), ahora sobre el texto **sin lo negado**.
- La intención no se recuerda entre lotes: «quiero cotizar» en un lote y los estudios en el siguiente se tratan por separado.
- Tras cotizar la sesión se cierra: agregar «y TSH» después abre una solicitud nueva (cotiza solo lo nuevo).
- Una sigla desconocida bloquea la cotización aunque sea charla, salvo que el modelo la descarte.
- La negación (alcance por cláusula y mensaje, rectificaciones, «gana lo último», dudas) quedó refinada en la Fase 3: ver `03-conexion-del-motor-de-lotes.md`.
