# Integración CRM · Fase 1 · Control de atención desde el CRM

Rama: `feat/crm-attention-control` (sale de `feat/g2-turnos`). Fecha: 2026-10-28. **Sin SQL remoto, sin migraciones aplicadas, sin cambios en el CRM, Kapso, Supabase, Vercel ni Dokploy, sin banderas activadas, sin push ni despliegue.** Todo es local y queda **apagado por defecto**.

Implementa, del lado del agente, el contrato `CRM-PLUSMEDIK/docs/AGENT_ATTENTION_CONTROL_CONTRACT.md` (incluida la adenda F5): el CRM consulta el estado real de atención de un contacto y pausa o reactiva la IA. Antes de esto, el CRM fallaba cerrado (no podía pausar, y por eso tampoco responder desde su interfaz).

## 1. Qué se agregó

| Pieza | Archivo | Qué hace |
| --- | --- | --- |
| Migración 15 | `supabase/migrations/20261103000000_plusmedik_crm_attention_control.sql` | Función `plusmedik_attention_crm_action` (pausa/reactivación manual idempotente) y dos restricciones ampliadas de `plusmedik_attention_events` |
| Lógica | `src/crm-attention.ts` | Manejador HTTP, validaciones, configuración y repositorio |
| Rutas | `api/internal/crm/attention/status.ts` y `action.ts` | Funciones de Vercel (`POST /api/internal/crm/attention/status` y `/action`) |
| Variables | `.env.example` | `PLUSMEDIK_AGENT_CONTROL` y `PLUSMEDIK_AGENT_CONTROL_TOKEN`, en blanco |

Se **reutiliza**, sin modificar: el estado por contacto (`plusmedik_attention_contacts`), el cálculo del contacto con HMAC (`contactKeyOf`), `plusmedik_attention_status`, el cliente RPC con reintento idéntico de la auditoría (`createSupabaseRpc`), la comprobación de pausa en `claim`/`reserve_send`/`confirm_send` y el bloqueo de procesamientos pendientes. **No se tocó el webhook de Kapso ni `api/kapso/webhook.ts`.**

## 2. Contrato implementado

### `POST /api/internal/crm/attention/status`
Cuerpo `{contactPhone, phoneNumberId}` → `200 {ok:true, available:true, state:"ACTIVE"|"HUMAN_PAUSED", revision}`. Un contacto que nunca habló es `ACTIVE`, revisión `0`.

### `POST /api/internal/crm/attention/action`
Cuerpo `{operationId, action:"pause"|"resume", contactPhone, phoneNumberId, reasonCode, actor}` → `200 {ok:true, confirmed:true, state, revision, outcome, replayed}`.
- `reasonCode` debe ser `CRM_MANUAL_PAUSE` para pausar y `CRM_MANUAL_RESUME` para reactivar; `actor` es `crm:<id>` (`crm:system` para las acciones automáticas). El texto libre del motivo **no viaja** (el cuerpo debe tener exactamente esos campos; cualquier otro se rechaza).
- **Idempotente por `operationId`** (`event_key = crm:<operationId>`): repetir la misma operación devuelve el resultado ya confirmado (`replayed:true`, mismo estado y revisión de aquel momento) sin agregar un evento. Reusar un `operationId` para otra acción u otro contacto → `409` sin confirmar.
- Pausar un contacto ya pausado → `ALREADY_PAUSED`; reactivar uno ya `ACTIVE` (o inexistente) → `confirmed:true, state:"ACTIVE"`, `ALREADY_ACTIVE` (lo que la adenda F5 exige de la reactivación automática repetida).

### Autenticación y límites (contrato «Autenticación y límites»)
| Regla | Implementación |
| --- | --- |
| Bearer exclusivo | `PLUSMEDIK_AGENT_CONTROL_TOKEN` (≥ 32 caracteres), comparado en tiempo constante (hash + `timingSafeEqual`); no es la service key, ni la clave HMAC, ni credenciales de Kapso; una prueba estática verifica que el código no lee ninguna de ellas salvo la clave HMAC de contactos |
| Solo HTTPS (salvo localhost) | `403 https_required` según la URL o `x-forwarded-proto` |
| Sin navegador | `403` si llega `Origin` o `Sec-Fetch-*` |
| Teléfono | `^\+?[0-9]{8,15}$`; `400` si no |
| `phoneNumberId` | debe ser exactamente `KAPSO_PHONE_NUMBER_ID`; `403` si es otro número |
| El `contact_key` se calcula aquí | HMAC con `PLUSMEDIK_CONTACT_HMAC_KEY`; ni la clave ni el hash salen en ninguna respuesta |
| Cuerpo | JSON obligatorio, ≤ 2 KB, objeto con la forma exacta |

### Respuestas honestas (nunca se inventa un estado)
| Situación | Respuesta |
| --- | --- |
| Funcionalidad apagada o mal configurada | `503 {ok:false, available:false, error:"not_configured"}`; ni se mira la petición ni se toca la base |
| Configurada, pero `PLUSMEDIK_HUMAN_CONTROL` apagado o clave HMAC inválida | `200` `status` → `{available:false, reason:"control_disabled"}`; `action` → `{available:false, confirmed:false}`. **No se muta nada** (regla 1 del contrato) |
| Base caída, resultado incierto, respuesta inesperada de la RPC | `503`; `action` nunca devuelve `confirmed:true` |
| Token ausente/incorrecto | `401` |

## 3. La pausa es real, no un mensaje simulado
`plusmedik_attention_crm_action` es una operación **propia**: tipo de evento `CRM_MANUAL_PAUSE`/`CRM_MANUAL_RESUME`, fuente `crm_server`. **No** llama a `plusmedik_attention_register_human_message` (que representa un mensaje humano real de WhatsApp Business), no usa el tipo `HUMAN_BUSINESS_APP` y no escribe `last_human_event_at`. Pausar:
1. deja el contacto en `HUMAN_PAUSED` (revisión +1) con motivo `CRM_MANUAL_PAUSE`;
2. bloquea sus procesamientos **pendientes** (la reserva de envío responde `blocked`);
3. si ya hay un envío **reservado** no se puede cancelar: queda contado (`late_reserved_runs`) y la corrida marcada, igual que con una pausa humana;
4. desde ese momento `claim` suprime los mensajes del paciente (`PATIENT_SUPPRESSED`) y no hay respuesta automática.

Reactivar vuelve a `ACTIVE` (revisión +1) y fija `resumed_at` (los mensajes humanos anteriores ya no vuelven a pausar). Se puede reactivar también una pausa humana (el CRM reactiva a los 10 minutos). El agente **no** reactiva por tiempo.

## 4. Migración 15 (local, **no aplicada**)
Aditiva: **una función** y **dos restricciones con nombre** (`..._kind_crm_check`, `..._outcome_crm_check`) que reemplazan las dos restricciones en línea de `plusmedik_attention_events`, admitiendo además `CRM_MANUAL_PAUSE`, `CRM_MANUAL_RESUME` y el resultado `ALREADY_ACTIVE`. No toca datos, columnas, otras tablas ni el esquema `crm`. `SECURITY DEFINER`, `search_path` vacío, sin acceso para `public`, `anon` ni `authenticated`; solo `service_role`. Reaplicar no falla. Orden: después de la 14.
Se regeneraron los SQL de verificación de solo lectura (`supabase/preflight/`) y `docs/g5/20` (ahora **15 migraciones**, 254 objetos en el manifiesto). **Si el CRM llama a `action` sin aplicar la 15, la RPC no existe → `503` sin confirmar** (falla cerrado).

## 5. Pruebas realizadas
| Archivo | Pruebas | Qué cubre |
| --- | --- | --- |
| `tests/crm-attention.test.ts` | 62 | Unitarias con repositorio simulado: configuración apagada, auth (401), HTTPS, navegador, forma del cuerpo, validación de teléfono/`phoneNumberId`/acción/actor/`operationId`, control no operativo, estado y acciones, fallos sin `confirmed:true`, registro sin datos, traducción estricta de la RPC |
| `tests/crm-attention-db.test.ts` | 29 | **Integración contra PostgreSQL 18 efímero** con las 15 migraciones: estado y revisión, eventos con solo códigos, no es un mensaje humano, bloqueo de pendientes, carrera con envío reservado, claim suprimido, reactivación, idempotencia (incluida **concurrencia real** de 6 llamadas idénticas), conflicto PT409, validaciones PT422, privilegios, restricciones, reaplicar la migración |
| `tests/crm-attention-e2e.test.ts` | 10 | **Extremo a extremo**: rutas reales + webhook real + manejador de texto real + PostgreSQL real: ciclo responder→pausar→callar→reactivar→responder, pausa **a mitad de un procesamiento** (la respuesta calculada no se envía), coexistencia con la pausa humana de WhatsApp Business, token incorrecto, otro `phoneNumberId`, apagado por defecto, contactos independientes, registro sin datos sensibles |
| `tests/crm-attention-boundaries.test.ts` | 17 | Estáticas: quién puede nombrarlo, token exclusivo y comparación en tiempo constante, orden auth→cuerpo→base, sin simular WhatsApp, migración aditiva y restringida, registro solo con códigos |
| `tests/production-defaults.test.ts` | +3 | Rutas apagadas sin configuración, configuración inválida con código, control humano apagado |
Más los contadores de migraciones (14→15) en las pruebas existentes. Ninguna prueba llama a OpenAI, Kapso, el CRM ni un Supabase remoto.

## 6. Pasos pendientes para conectar el CRM (nada hecho)
Cada paso requiere autorización por separado.

1. **Revisar y publicar** esta rama (push y, si se desea, pull request). Aún no se hizo.
2. **Aplicar la migración 15** en un entorno de ensayo junto con las anteriores (procedimiento y verificaciones de solo lectura en `docs/g5/20`). En producción solo con autorización expresa.
3. **Generar el token** (≥ 32 caracteres, aleatorio) y guardarlo en un gestor de secretos. Debe ser **distinto** de cualquier otro secreto. Mismo valor en el agente (`PLUSMEDIK_AGENT_CONTROL_TOKEN`) y en el CRM (variable del mismo nombre).
4. **Configurar el agente de ensayo** (Vercel de pruebas): `PLUSMEDIK_AGENT_CONTROL=on`, `PLUSMEDIK_AGENT_CONTROL_TOKEN`, `KAPSO_PHONE_NUMBER_ID`, `PLUSMEDIK_CONTACT_HMAC_KEY` y `SUPABASE_*`. Primero con `PLUSMEDIK_HUMAN_CONTROL` **apagado**: el CRM debe ver `available:false` y nada se muta.
5. **Configurar el CRM de ensayo** (solo variables, sin cambios de código): `PLUSMEDIK_AGENT_CONTROL_ENABLED=true`, `PLUSMEDIK_AGENT_CONTROL_URL=https://<agente-de-ensayo>` y el token. El CRM debe usar el **mismo** `PHONE_NUMBER_ID` que `KAPSO_PHONE_NUMBER_ID` del agente.
6. **Encender el control humano** en el ensayo (`PLUSMEDIK_HUMAN_CONTROL=on` con la clave HMAC): verificar manualmente estado real e idempotencia (repetir la misma operación; reactivar un contacto activo) con 1–2 números de `ALLOWED_PHONES`.
7. **Confirmar con Kapso** que el webhook del agente recibe los eventos salientes y que agente y CRM pueden coexistir (Fase 3 del plan). No depende de esta fase, pero condiciona el canal de WhatsApp Business.
8. **Solo entonces**, el CRM podría habilitar el envío desde su interfaz (`KAPSO_CRM_SEND_ENABLED`), cuando la pausa previa esté verificada de extremo a extremo.

## 7. Riesgos y decisiones
- **Sin la migración 15 aplicada** las acciones del CRM responden `503` (falla cerrado), no silenciosamente.
- **Una instancia de Vercel con la bandera encendida y sin `PLUSMEDIK_HUMAN_CONTROL`** responde `available:false`: es correcto y seguro, pero el CRM seguirá sin poder enviar hasta encender el control humano.
- **Pausa con envío ya reservado**: la carrera sigue existiendo (no se puede cancelar un envío en curso); queda registrada, como con la pausa humana.
- **Tipo de teléfono**: se acepta `^\+?[0-9]{8,15}$`; si el CRM enviara separadores o más de 15 dígitos, recibiría `400`. El CRM reconstruye el teléfono normalizado, así que no debería ocurrir; conviene verificarlo en el ensayo.
- **`operationId` mínimo de 8 caracteres** (`[A-Za-z0-9_.:-]`, hasta 120): cubre UUID y los derivados del id del caso.
- **Canal B / L2 (autoría del mensaje)** y L5 (un caso abierto pausa al agente) **no** se implementan aquí: son fases posteriores del plan.
- Las rutas no aplican límite de tasa propio; el token exclusivo y HTTPS son la barrera. Si el agente quedara expuesto a Internet, conviene limitar por IP en Vercel.
