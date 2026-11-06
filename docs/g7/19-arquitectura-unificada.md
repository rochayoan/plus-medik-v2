# G7 · Arquitectura unificada: UN solo agente conversacional

Estado: **cambios solo en el código y las pruebas; sin commit, sin despliegue, Supabase y Vercel sin tocar.** Este documento reemplaza los nombres de variables y los modos de los documentos 11 a 18 (modo sombra, piloto con lista de números, `PLUSMEDIK_AGENT`, `OPENAI_AGENT_*`).

## Configuración (única)
| Variable | Qué hace |
|---|---|
| `PLUSMEDIK_LLM_CONVERSATION=on` | Enciende el agente conversacional ÚNICO para todos los contactos elegibles. Exige `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_TEXT_HANDLER=on` |
| `OPENAI_CONVERSATION_MODEL` | **Única** variable del modelo (obligatoria, sin valor por defecto) |
| `OPENAI_CONVERSATION_REASONING` | Opcional; por defecto **medium** |
| `OPENAI_API_KEY` | La clave de siempre |
| `PLUSMEDIK_DAILY_REPLY_CAP` (`off` lo apaga) / `_MAX` / `_HOURS` | Tope de **6 respuestas por contacto cada 24 h**, ENCENDIDO por defecto con el agente; el mismo de la reserva de envío (no hay tope propio del agente) |
| `PLUSMEDIK_CRM_HANDOFF` + variables del CRM | La derivación a una persona usa la cola al CRM de siempre: solo existe si está encendida y configurada |

**Memoria persistente = parte normal del agente** (migración 24): se enciende con la misma bandera `PLUSMEDIK_LLM_CONVERSATION`, sin variables propias; si la base no responde, el agente decide con el historial de 24 h y no se detiene.

Variables eliminadas: `PLUSMEDIK_CONV_STATE`, `PLUSMEDIK_CONV_STATE_RETENTION_DAYS`, `PLUSMEDIK_AGENT`, `OPENAI_AGENT_MODEL`, `OPENAI_AGENT_REASONING`, `PLUSMEDIK_AGENT_TIMEOUT_MS|SAMPLE|PILOT_PHONES|PILOT_DAILY_MAX|HANDOFF|EXCLUDE_PHONES|DAILY_MAX|DEADLINE_MS`, y de la capa conversacional anterior `PLUSMEDIK_LLM_BUSINESS_INFO|SILENCE_OFF_TOPIC|CATEGORIES|TIMEOUT_MS|MAX_OUTPUT_TOKENS|MAX_INPUT_CHARS`, `PLUSMEDIK_CONVERSATION_MEMORY` y `PLUSMEDIK_MEMORY_*`.

## Qué quedó unificado
- **Una sola capa conversacional**: el agente de `src/agent` (plan → herramientas → actos y texto → verificación por procedencia). La antigua «conversación con modelo» (G5.3) y su memoria corta **ya no se conectan** (webhook y manejador de texto).
- **Un solo modelo y un solo tope**: `OPENAI_CONVERSATION_MODEL`; 6 cada 24 h.
- **Un solo contexto**: mensajes recientes del historial (7 mensajes, 24 h, 400 caracteres cada uno) + memoria persistente (pendientes, última cotización, quién tiene la palabra).
- **Silencio ante lo claramente ajeno** (dentro del núcleo): el modelo lee la petición como `OFF_TOPIC` y el sistema exige además que las reglas no vean nada del laboratorio (tema `OTHER`, sin palabras como laboratorio/estudio/examen/turno/precio…), que no haya pendientes de antes y que no haya conversación en curso (ningún mensaje reciente del asistente o de la recepción). Entonces no se envía nada, el lote se cierra sin respuesta y la memoria da la petición por atendida. Ante la menor duda se responde. La comprensión de intenciones la decide el modelo; las reglas (`classifyText`) quedan solo como pista y para el modo esencial.
- **Herramientas reutilizadas** (sin duplicar): catálogo (`find_studies`), cotización (`quote_studies`, motor de sesiones de cotización), conocimiento aprobado (`lab_info`), memoria (`conversation_state`) y derivación al CRM (cola de siempre). Las **fotos/recetas** las lee el motor de recetas de siempre (el agente las conoce por la memoria).
- **Sin modo sombra ni piloto por lista**: se eliminó el ejecutor en sombra, `PLUSMEDIK_AGENT`, la lista de números y sus topes propios.

## Lo que NO cambia (protecciones)
Idempotencia, leases y fencing, reserva de envío, **un solo envío por lote**, pausa humana, tope diario, guarda de respuestas, precios solo del catálogo, métodos de pago ignorados, cifras solo de hechos citados y la regla de no dar consejos médicos.

## Interruptor de emergencia y modo esencial
`select public.plusmedik_agent_pilot_set(false, 'motivo');` (migración 25) apaga el agente en ≤ 5 s sin redesplegar; nace apagado (sin fila = apagado) y falla cerrado. Apagado, o si el modelo falla, tarda más de 40 s, el verificador rechaza dos veces o hay fotos en el lote, atiende el **modo esencial**: textos fijos, catálogo, cotización y derivación deterministas. No es un segundo agente: es el motor de herramientas sin la capa de lenguaje, para no perder el funcionamiento básico.

## Pendiente para fases siguientes (eliminación gradual, sin urgencia)
1. Borrar el código muerto de la capa G5.3 (`conversation-model.ts`, `conversation-openai.ts`, `conversation-memory.ts`, `system-prompt.ts`, la opción `conversation`/`history` del manejador de texto) y sus pruebas.
2. Quitar el modo piloto por lista de teléfonos que queda en `createAgentPilot` (hoy solo lo usan las pruebas).
3. Integrar las fotos/recetas como herramienta del agente (hoy se atienden en el motor de recetas y el agente las conoce por la memoria).
4. Unificar la clasificación por reglas (`classifyText`, `batch-understanding`) con la comprensión del modelo.

## Puesta en producción (nada aplicado todavía)
1. Supabase: respaldo, verificación previa, migraciones 24 y 25 (docs/g7/17 §2), **antes** de fusionar. Ambas siguen siendo necesarias: la 24 guarda la memoria persistente; la 25 contiene el interruptor de emergencia y la lectura de mensajes recientes.
2. Vercel: reutilizar `PLUSMEDIK_LLM_CONVERSATION=on` y `OPENAI_CONVERSATION_MODEL` si ya existen (si no, definirlas); `OPENAI_CONVERSATION_REASONING` solo si no es medium; si existe `PLUSMEDIK_DAILY_REPLY_CAP_MAX` con 5, ponerla en 6 o borrarla; comprobar `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_TEXT_HANDLER=on`, `PLUSMEDIK_CONTACT_HMAC_KEY`, `KAPSO_PHONE_NUMBER_ID`; **retirar** las variables eliminadas. Con la bandera encendida el tope de 6 se activa solo (exige la migración 18).
3. Desplegar con el interruptor apagado → comprobar `agent_scope` y `agent_pilot {FALLBACK, SWITCH_OFF}` en los registros → encender con `plusmedik_agent_pilot_set(true, '…')`.
