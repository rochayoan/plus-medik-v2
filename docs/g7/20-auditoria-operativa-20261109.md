# Plusmedik — Correcciones operativas (9 noviembre 2026)

## Cambios de esta entrega
- Bloquea una cotización inventada por el planificador cuando el texto actual solicita **solo resultados, enlace, descarga o comprobantes**. Si el paciente pide un precio, se conserva la cotización habitual.
- Mantiene íntegra la continuidad de estudios, sinónimos y memoria; no compara literalmente nombres sugeridos por el planificador, ya que puede usar registros confirmados de otros turnos.
- Instrucciones del modelo mejoradas para distinguir resultados administrativos de interpretación clínica y para no responder con cotizaciones a incidentes presenciales.
- Mensaje de contingencia por falta de derivación humana: ya no obliga a enviar una receta ante cualquier consulta.
- Reconocimiento de solicitudes de enlace/descarga en el detector de conocimiento aprobado.
- Mantiene intactos el bloqueo de pagos, envío idempotente, pausa humana, fallback y circuito del proveedor.

## Pendiente
1. Clasificación de imágenes en contexto: `imageProducer` permanece intacto hasta tener pruebas extremo a extremo seguras.
2. Handoff humano efectivo: depende de la cola CRM operacional.
3. Medición de costo y breaker global persistente: no implementados en esta entrega.
4. Auditoría adicional de estudios sugeridos: requiere comprobar referencias del catálogo y memoria sin romper cotizaciones legítimas.

## Pruebas
```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```
No agregar datos de pacientes, recetas ni claves a GitHub.
