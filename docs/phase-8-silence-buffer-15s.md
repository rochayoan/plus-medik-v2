# Fase 8.1–8.2: silencio inteligente y buffer de 15 s

Estado: **la parte del buffer de 15 s (diseño de buffer persistente en Supabase) fue REEMPLAZADA por el buffering nativo de Kapso.** La sección «Implementación propuesta» se conserva solo como registro de la decisión y NO se implementó. El «silencio inteligente» (contrato, puntos 1 y 2) no forma parte de este cambio. Nada de esto está habilitado en Production.

## Decisión: buffering nativo de Kapso (reemplaza el buffer en Supabase)

Kapso agrupa los mensajes de un contacto durante 15 segundos y los entrega en un solo POST (`batch: true`, `data[]`). El webhook interpreta ese lote y **no agrega ningún otro buffer**: ni tabla de buffer en Supabase, ni worker, ni cron, ni espera de 15 s en la función. Detalle de la implementación: [`docs/g6/01-buffer-nativo-kapso.md`](g6/01-buffer-nativo-kapso.md).

Cómo queda cada punto del contrato:

| Contrato | Con el buffering nativo de Kapso |
| --- | --- |
| Agrupar la secuencia del mismo contacto | Los mensajes del mismo contacto dentro de un lote son una sola solicitud con **una sola respuesta**. La ventana es la de Kapso: **fija de 15 s, no deslizante** (no se pospone el cierre ante nuevos mensajes; los que lleguen después van en el lote siguiente). |
| Evitar respuestas de grupos obsoletos | No hay versión de grupo. Si el mismo lote llega dos veces a la vez, solo una ejecución lo atiende; la política de respuesta obsoleta entre lotes distintos es la de turnos de siempre. |
| Orden e idempotencia por ID de WhatsApp | Se conservan: cada mensaje se reclama por su ID, en orden, y un lote reenviado no se procesa dos veces. |
| Cinco respuestas / 24 h | Se conserva: el lote completo reserva **un** envío y cuenta como **una** respuesta. |
| Pausa humana | Se conserva: se comprueba en la única reserva y en la confirmación final del envío. |
| No mezclar contactos | Cada contacto se atiende por separado dentro del mismo POST. |
| Fotos de recetas | Se conservan: cada foto mantiene su análisis, su deduplicación y su cotización; las cotizaciones de varias fotos salen juntas en un solo mensaje. |
| Fallo de la infraestructura de agrupación | No hay infraestructura propia de agrupación. Un mensaje que falla conserva su registro de fallo y no impide los demás. |

Requiere la **migración 19** (`20261107000000_plusmedik_batch_fold.sql`), aditiva: una sola función que cierra sin enviar la corrida de un mensaje cuyo contenido viajó dentro de la respuesta de otro.

No cubre (queda fuera de este cambio):

- El silencio ante mensajes sociales o temas ajenos (contrato, puntos 1 y 2), que sigue siendo responsabilidad del filtro de atención existente (G6.0), y el clasificador de intención sobre la solicitud agrupada.
- La ventana deslizante: depende de la configuración de Kapso.

## Contrato

- Procesar solo solicitudes sobre estudios/cotizaciones de laboratorio, horarios y ubicación. Conservar reglas existentes de seguridad clínica y atención humana: nunca ocultar solicitudes explícitas de atención humana ni casos de riesgo.
- Mensajes sociales aislados, agradecimientos y temas ajenos: no enviar respuesta y no consumir cupo.
- Una secuencia de mensajes de texto del mismo contacto se agrupa mediante una ventana **deslizante** de 15 segundos desde el último mensaje.
- Ante nuevos mensajes, posponer el cierre del grupo. Evitar respuesta de grupos obsoletos mediante control de versión por contacto.
- Preservar orden, idempotencia por ID de WhatsApp, restricciones de cinco respuestas / 24 h y pausa humana.
- No mezclar contactos ni conversaciones; no combinar mensajes posteriores a una intervención humana.
- Las fotos de recetas siguen siendo un flujo válido: no descartarlas por un filtro textual; decidir por separado política de imagen en el buffer.
- Si falla la infraestructura de agrupación, no emitir varias respuestas ni descartar silenciosamente una solicitud válida; registrar fallo recuperable.

## Implementación propuesta (DESCARTADA: reemplazada por el buffering nativo de Kapso; no implementada)

1. Tabla persistente de buffer en Supabase, con clave por contacto y línea, versionado, fecha de vencimiento y referencias de mensaje (evitar registrar datos sensibles en logs).
2. Ingesta rápida del webhook: normaliza, deduplica y añade los textos al grupo; no mantener abierta una función 15 s.
3. Worker protegido invocado periódicamente o tarea diferida durable que reclama buffers vencidos y compara versión de grupo; solo el último procesamiento válido puede enviar.
4. Clasificador de intención basado en la solicitud agrupada, por delante del modelo conversacional. Ignorar OTHER/social, pero preservar los caminos autorizados de cotización, información y derivación.
5. Pruebas de concurrencia, reenvíos, reinicios, pausas humanas, límite diario, textos mezclados y cron.
6. Despliegue inicial en Preview con bandera opt-in y métricas de respuestas ignoradas. Production solo después de las pruebas.

## Criterios de aceptación

- Tres mensajes separados por menos de 15 s producen, si son pertinentes, una sola respuesta.
- Mensaje irrelevante aislado: ninguna respuesta, ningún cupo consumido.
- Cotización por texto e imagen y consultas de horarios y ubicación conservadas.
- Mensaje tras intervención humana: ningún envío automático.
- Ningún contacto externo al mismo chat puede compartir buffer.
