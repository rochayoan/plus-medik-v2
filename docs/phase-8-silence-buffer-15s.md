# Fase 8.1–8.2: silencio inteligente y buffer de 15 s

Estado: diseño de implementación, NO habilitado en Production.

## Contrato

- Procesar solo solicitudes sobre estudios/cotizaciones de laboratorio, horarios y ubicación. Conservar reglas existentes de seguridad clínica y atención humana: nunca ocultar solicitudes explícitas de atención humana ni casos de riesgo.
- Mensajes sociales aislados, agradecimientos y temas ajenos: no enviar respuesta y no consumir cupo.
- Una secuencia de mensajes de texto del mismo contacto se agrupa mediante una ventana **deslizante** de 15 segundos desde el último mensaje.
- Ante nuevos mensajes, posponer el cierre del grupo. Evitar respuesta de grupos obsoletos mediante control de versión por contacto.
- Preservar orden, idempotencia por ID de WhatsApp, restricciones de cinco respuestas / 24 h y pausa humana.
- No mezclar contactos ni conversaciones; no combinar mensajes posteriores a una intervención humana.
- Las fotos de recetas siguen siendo un flujo válido: no descartarlas por un filtro textual; decidir por separado política de imagen en el buffer.
- Si falla la infraestructura de agrupación, no emitir varias respuestas ni descartar silenciosamente una solicitud válida; registrar fallo recuperable.

## Implementación propuesta

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
