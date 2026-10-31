# PlusMedik V2 — Fase 1: comprobar memoria antes de conectarla a OpenAI

**Estado:** diagnóstico sin cambios en producción. Este documento y su consulta son de solo lectura.

## Hallazgos al revisar `origin/main` (ae5bc978)

- `src/conversation-model.ts`: el modelo no recibe mensajes anteriores, solo el actual y un contexto acotado de cantidades.
- `src/turns.ts`: la memoria vigente resume estudios de la cotización (no es historial de texto).
- Migraciones `plusmedik_turns` y `plusmedik_quote_sessions`: guardan orden, estado e IDs, no texto de pacientes.
- En este repositorio no aparece ninguna consulta a `agent_messages`. La ausencia en el código **no** demuestra que la tabla no exista en el Supabase compartido.
- El proyecto Supabase que documentan los worktrees PlusMedik V2 / CRM es `cvokrtrdzxfchntwwslz`, pero NO se ha corroborado hoy contra la variable sensible de Vercel.
- La conexión Supabase de este asistente no tiene acceso a ese proyecto. Por eso **no es posible confirmar el contenido de la tabla desde aquí**.

## Verificación segura

1. En Supabase, abrir el SQL Editor del proyecto correcto y verificar que la URL del panel contenga `cvokrtrdzxfchntwwslz`. Si no coincide, detenerse.
2. Ejecutar `supabase/queries/plusmedik_agent_messages_discovery_read_only.sql`.
3. Compartir **solo el JSON de metadatos**, que no contiene texto, números de pacientes ni credenciales.
4. Evaluar los nombres y tipos de columnas, sin asumir `phone`, `chat_id`, `conversation_id`, `role`, `content` o `created_at`. Son hipótesis, no columnas confirmadas.
5. Después, diseñar una consulta agregada de validación con el esquema real, **sin devolver ningún texto clínico**: verificar mensajes entrantes/salientes, identidad de un solo paciente, orden temporal, duplicados y datos presentes. `estimated_rows` es aproximado (y puede ser nulo).
6. Si `agent_messages` pertenece a otro agente, no reutilizarla ni mezclar datos. En ese caso estudiar una solución nueva antes de escribir SQL.

## Contrato deseado para la memoria (fase posterior, todavía NO implementada)

- Seleccionar hasta **siete mensajes anteriores** del **mismo contacto** y mismo número de laboratorio, ordenados cronológicamente.
- Incluir ambos sentidos, si el esquema y las políticas lo permiten; nunca introducir el mensaje actual dos veces.
- Limitar longitud y período; mantener aislamiento por contacto; no registrar mensajes en logs.
- Conservar la fuente de verdad de cotizaciones en `lab_tests`, la guarda antibucles y la auditoría. El historial no autoriza al modelo a inventar precios ni ejecutar cambios sin validación.
- No enviar nuevos datos históricos médicos a OpenAI sin aprobación expresa de privacidad del laboratorio y reglas de retención.
- Desplegar primero solo para el número de prueba original. No desactivar `PLUSMEDIK_TEXT_PILOT_GUARD` ni modificar `ALLOWED_PHONES` en esta fase.

## Criterio para continuar

**Si la tabla es reutilizable:** definir un adaptador de lectura, pruebas de aislamiento y saneamiento, con bandera de activación solo para el piloto.

**Si la tabla no es reutilizable:** documentar por qué y proponer almacenamiento cifrado/retención conforme a la política del laboratorio. No construir antes de verificar.
