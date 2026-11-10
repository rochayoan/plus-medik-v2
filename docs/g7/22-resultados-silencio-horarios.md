# Política de resultados y horarios

- Las consultas exclusivamente sobre resultados (incluidas urgencia, problemas de acceso y preguntas de interpretación) se silencian por código **antes de IA**. Quedan auditadas como `NO_REPLY`.
- Si el mismo lote pide horario general de atención y resultados, se sustituye internamente por **solo la pregunta del horario general**. Se contesta usando información aprobada, nunca horas inventadas.
- Si hay cotización, cita, personal solicitado expresamente u otro motivo independiente, se conserva el flujo ordinario; la instrucción del agente no debe responder la parte de resultados.
- El prompt puede solicitar `silent:true`, pero solo el backend decide no enviar. El silencio de solo resultados es determinista y no consume tokens.
- No se cambian reglas clínicas AUTO_SAFE, precios, sesiones, modelos ni secretos.
