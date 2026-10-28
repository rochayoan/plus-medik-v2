# G1 · 03 Atención humana y CRM: cómo evitar respuestas automáticas cuando una recepcionista asume la conversación

Fuentes: código de `src/human-control.ts`, `src/kapso-webhook.ts`, `src/audit.ts` y migración 5 (este repositorio); y, **solo en lectura**, `CRM-PLUSMEDIK/docs/AGENT_ATTENTION_CONTROL_CONTRACT.md`, `AGENT_REVIEW_CASE_CONTRACT.md`, `src/app/api/messages/send/route.ts`, `src/app/api/agent-control/[contactKey]/route.ts` y `src/lib/kapso-message-classification.ts`. No se modificó nada del CRM.

## 1. Por dónde puede "tomar" una recepcionista la conversación

| # | Canal de la recepcionista | Qué ve el agente | ¿Pausa la IA hoy? | Estado |
| --- | --- | --- | --- | --- |
| A | Escribe desde la app **WhatsApp Business** del laboratorio | Evento saliente con `origin: business_app` → `HUMAN_BUSINESS_APP` | **Sí**, si `PLUSMEDIK_HUMAN_CONTROL=on` y las migraciones están aplicadas | Implementado y probado (59 + 31 + 24 pruebas). **Depende de que Kapso entregue ese evento al webhook del agente** (ver §4) |
| B | Escribe desde el **CRM** (`POST /api/messages/send` → API de Kapso) | Saliente con `origin: cloud_api` → `BOT_OUTBOUND` ("el propio bot") | **No** | **Brecha.** El envío del CRM está apagado (`KAPSO_CRM_SEND_ENABLED=false`) y su ruta no llama a ningún control del agente |
| C | Pulsa **"pausar IA"** en la ficha del paciente del CRM | Nada hoy: el CRM llamaría a `POST /api/internal/crm/attention/action` | No existe | Endpoints y pausa manual **sin implementar** en el agente; la interfaz del CRM está deshabilitada hasta que existan |
| D | Toma un **caso de revisión** (`crm.review_cases`) sin escribir todavía | Nada | No | Sin vínculo definido entre caso abierto y pausa |
| E | Otra app o agente de Meta en el mismo número | `OTHER_APP_OUTBOUND` / `META_AGENT_OUTBOUND` | No (solo se registra) | Diseño intencional: no se interpreta como humano |
| F | Escribe un mensaje cuyo origen falta o no se reconoce | `UNKNOWN_ORIGIN` | No (solo se registra) | Diseño intencional: no se inventa que fue humano |

Reglas ya garantizadas por la base cuando hay pausa: el claim no procesa a un contacto pausado (`PATIENT_SUPPRESSED`), pausar bloquea los procesamientos pendientes, `reserve_send` y `confirm_send` vuelven a consultar el estado inmediatamente antes de llamar a Kapso, y no hay reactivación por tiempo. **Carrera residual conocida y documentada:** un mensaje humano que llegue después de `confirm_send` no cancela un envío en curso; queda registrado como `late_reserved_runs`/`replied_after_event_runs`.

## 2. La brecha del canal B (el CRM) y cómo cerrarla

El CRM envía con la API de Kapso, por lo que sus mensajes salen con `origin: cloud_api`, igual que los del propio agente. Para el agente son indistinguibles de los suyos y **no pausan**: si una recepcionista responde desde el CRM mientras el agente analiza o antes de que llegue otra foto, el agente puede hablar encima.

Defensa en profundidad propuesta (cada capa es independiente):

| Capa | Mecanismo | Dónde | Cuándo |
| --- | --- | --- | --- |
| L1 — **Explícita** | El CRM pausa al agente **antes** de enviar su primer mensaje manual (acción `pause`, `reasonCode: CRM_MANUAL_PAUSE`, idempotente por `operationId`). Si el agente no confirma, el CRM debe avisar a la persona y decidir (no enviar a ciegas, o enviar y marcar "IA no pausada") | Contrato ya definido por el CRM; el agente implementa los endpoints y una función SQL propia de pausa manual (el contrato prohíbe reutilizar `register_human_message`) | G5; **requisito previo para que el CRM habilite `KAPSO_CRM_SEND_ENABLED`** |
| L2 — **Autoría del mensaje** | El agente ya guarda el id del mensaje que envía (`plusmedik_audit_runs.kapso_outbound_message_id`, columna que `recordReply` rellena). Un saliente `cloud_api` cuyo id **no** es de ningún procesamiento propio es ajeno (CRM u otro cliente de la API) y se trata como intervención humana (`FOREIGN_CLOUD_API`) | Webhook + nueva consulta/índice + ampliar la restricción de `kind` (hallazgo M4) | G5. Requiere margen de gracia: el eco "sent" del propio mensaje puede llegar antes de que `recordReply` guarde el id, así que se debe esperar o contrastar con reservas recientes del mismo contacto para no pausar por error a su propio bot (el error en esa dirección es seguro: se pausa de más, no se responde de más) |
| L3 — **Origen humano** | `business_app` (canal A) | Implementado | Activar tras migraciones |
| L4 — **Respaldo en la base** | `claim`, `reserve_send` y `confirm_send` re-consultan la pausa | Implementado | — |
| L5 — **Revisión humana abierta** | Al crear un caso de revisión para un contacto, el agente podría pasarlo a `AWAITING_HUMAN_REVIEW` (pausa por motivo propio) hasta que el caso se resuelva o se reactive | Decisión del dueño (afecta lo que recibe el paciente que reenvía una foto) | G5 |

Recomendación: **L1 + L3 como obligatorias; L2 como respaldo** (cubre el caso en que el CRM falle en pausar, o se use otra herramienta con la API de Kapso). L5 solo con decisión expresa.

## 3. Diferencias entre el contrato del CRM y lo que existe en el agente

| Punto del contrato | Estado en el agente | Trabajo pendiente |
| --- | --- | --- |
| `POST /api/internal/crm/attention/status` con `contactPhone` + `phoneNumberId` | Existe la RPC `plusmedik_attention_status` y `contactKeyOf`; no hay ruta HTTP | Ruta con token `PLUSMEDIK_AGENT_CONTROL_TOKEN` (tiempo constante, solo HTTPS), validar `phoneNumberId == KAPSO_PHONE_NUMBER_ID`, calcular el `contact_key` internamente; control apagado → `available:false`, nunca inventar estado |
| `POST …/attention/action` `pause` | **No existe** | Función SQL nueva idempotente (`event_key = crm:<operationId>`, `pause_source = crm_server`, motivo `CRM_MANUAL_PAUSE`) y ampliar la restricción de `kind`/`outcome` |
| `…/action` `resume` | Existe `plusmedik_attention_resume(contact_key, motivo, actor)` | Exponerla; misma operación repetida devuelve el resultado ya confirmado |
| `confirmed: true` solo con confirmación firme | El cliente RPC distingue `UNKNOWN_OUTCOME` | Mapear `UNKNOWN_OUTCOME` → no confirmado |
| El agente es la única fuente de verdad (`ACTIVE`/`HUMAN_PAUSED`) | Cierto (tabla `plusmedik_attention_contacts`) | El CRM guarda su `attention_mode` solo tras confirmación remota (ya lo contempla) |
| Claves de contacto distintas | El agente usa HMAC con clave propia; el CRM usa su `whatsapp_contact_key` | No unificar: nunca compartir `PLUSMEDIK_CONTACT_HMAC_KEY` con el CRM (el contrato lo prohíbe) |
| `PLUSMEDIK_HUMAN_CONTROL` deshabilitado → `action` responde sin mutar | No existe el endpoint | Implementarlo con esa conducta por defecto |
| Casos de revisión (`/api/internal/agent/review-case`) | No existe el emisor | G5; requiere que el CRM ingiera antes el mensaje original (si no, `409 message_not_ingested`) |

## 4. Verificaciones que hacen falta antes de activar el control humano (nada se activó)

1. **Suscripción de eventos en Kapso.** El README de despliegue dice: *registrar el webhook "para mensajes entrantes de WhatsApp"*. La pausa humana necesita además los eventos **salientes** (`whatsapp.message.sent`) y no se sabe si el webhook actual los recibe. Hasta confirmarlo, el canal A no funciona aunque todo el código esté activo. La documentación de Kapso, según el propio código, no precisa en qué evento llega el eco de `business_app`.
2. **Coexistencia de webhooks** (agente y CRM): el CRM mantiene su webhook sin registrar hasta que Kapso confirme que ambos pueden recibir los mismos eventos sin sustituirse. Ese punto condiciona también el handoff de casos (G5).
3. **Números de prueba**: usar `ALLOWED_PHONES` con 1-2 números del propio equipo para ejecutar el guion de §5.

## 5. Guion de pruebas manuales para el piloto (cuando el dueño autorice)

Orden con `PLUSMEDIK_HUMAN_CONTROL=on` y las migraciones aplicadas, solo para números de prueba:

1. El paciente envía una foto → respuesta única. Reenviar el mismo mensaje desde el simulador de Kapso → sin segunda respuesta (`duplicate_ignored`).
2. Una persona escribe desde WhatsApp Business al paciente → `human_event outcome=PAUSED`. El paciente envía otra foto → sin respuesta (`duplicate_ignored reason=HUMAN_PAUSED`).
3. Una persona escribe **mientras** el análisis está en curso → no hay respuesta automática (`reply_withheld reason=blocked`), o queda registrada la carrera.
4. Reactivar con `plusmedik_attention_resume` (por ahora desde una sesión administrativa) → la siguiente foto vuelve a responderse.
5. Con la clave HMAC ausente → el bot no responde a nadie (falla cerrada) y lo registra.
6. **Canal B** (cuando el CRM habilite el envío): enviar un mensaje desde el CRM sin pausa previa y comprobar el comportamiento actual (el agente seguirá respondiendo: es la brecha); luego repetir con L1/L2 implementadas.

## 6. Criterios de aceptación para que el CRM pueda habilitar `KAPSO_CRM_SEND_ENABLED`

- Endpoints `attention/status` y `attention/action` implementados, probados con un doble del CRM y desplegados con el control aún apagado.
- L1 operativa de extremo a extremo (el CRM pausa y espera confirmación antes de enviar).
- Eventos salientes confirmados en el webhook del agente (§4.1).
- Prueba de pausa/reactivación manual exitosa en el número piloto.
- Decisión del dueño sobre L5 (¿un caso abierto pausa al agente?).
