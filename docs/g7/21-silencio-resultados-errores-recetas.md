# Correcciones operativas — resultados y recetas

- Solo las consultas **exclusivamente administrativas** sobre entrega/acceso a resultados quedan en silencio sin OpenAI, lectura del catálogo ni mensaje de Kapso.
- La detección usa **todo el lote del contacto**; si contiene una cotización, urgencia, interpretación clínica, queja, solicitud humana u otro motivo no se silencia.
- La entrada queda reclamada y cerrada como `NO_REPLY` con su lease, para mantener auditoría e idempotencia.
- `HUMAN_REVIEW` por catálogo/semántica ahora queda `UNRESOLVED`, no `UNREADABLE_IMAGE`.
- Un error técnico en un análisis ya iniciado deja su ítem `UNCERTAIN`, no ilegible; el mensaje técnico no culpa a la foto.
- No se tocan precios, ni criterios AUTO_SAFE ni las llamadas a los modelos. Falta clasificar fotos de resultados/comprobantes antes del análisis multimodal.
- Validar en CI: `npm run typecheck`, `npm test`. Ningún dato de pacientes, recetas ni claves personales en pruebas.
