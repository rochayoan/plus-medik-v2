# Revisión operativa de conversaciones — 9 noviembre 2026

## Alcance
Cambios preparados en rama de revisión. No se modifica el envío, el catálogo, la persistencia de resultados ni las credenciales. **Nunca incluir conversaciones, nombres, teléfonos o accesos a resultados reales en pruebas o commits.**

## Correcciones
- Solicitudes administrativas (horarios, ubicación, acceso al local, resultados, enlace, comprobantes y preparación): si existe `lab_info`, pasan al conocimiento aprobado sin usar el modelo de planificación. El modelo redacta solo con hechos que el verificador permite.
- Una imagen enviada durante una consulta sobre resultados **no se considera automáticamente una receta por este cambio**: esa ruta multimodal requiere una intervención adicional de clasificación visual/contextual. Este PR evita que un texto administrativo del agente provoque una cotización por error, pero no modifica `imageProducer`.
- `quote_studies` rechaza el plan completo si contiene nombres de estudios ausentes del texto del paciente y sus antecedentes autorizados (no cotiza silenciosamente un subconjunto).
- El modo esencial no fuerza al paciente a volver a hablar de recetas cuando no puede derivarlo.
- Las preguntas por enlace o descarga de resultados se reconocen como solicitudes administrativas en el detector de conocimiento.
- Si OpenAI comunica cuota/agote de facturación, el circuito **de la instancia** se abre por 15 minutos. En ejecución serverless la protección no se comparte entre instancias: hace falta un breaker persistente para garantía global.

## Pruebas antes de merge
```bash
npm ci
npm run typecheck
npm test
```
Verificar manualmente con datos ficticios: puerta cerrada, enlace de resultados, receta por texto, cotización con un estudio inventado, derivación con CRM operativo/no operativo, 429 de cuota y respuesta a imagen fuera de contexto.

## Riesgos pendientes
1. No existe clasificador confiable de **imágenes** antes del motor de recetas: requiere análisis del enrutamiento con historial de intención entre webhooks, y pruebas de no pérdida de auditoría/lease.
2. El CRM debe estar realmente operativo para derivar; la frase segura no sustituye la integración.
3. Persistencia de cotizaciones en seguimiento de estudios: comprobar los mensajes «solo faltaba glucosa» y «sí» de casos de regresión sin copiar texto clínico real.
4. El breaker de cuota de 15 min es local, no global.
5. Los resultados médicos y claves de acceso nunca deben exponerse en logs ni ejemplos.
