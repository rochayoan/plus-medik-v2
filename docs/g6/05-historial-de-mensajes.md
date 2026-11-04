# G6.5 · Historial de mensajes para auditoría

Estado: implementado y probado. **Apagado por defecto** (`PLUSMEDIK_HISTORY`). Requiere la **migración 21** (aditiva, **no aplicada**). No usa cola, cron ni rutas HTTP nuevas.

## Para qué sirve y por qué no existía

Para **auditar conversaciones reales** hace falta el texto de lo que escribió el paciente y de lo que respondió el agente. Hasta ahora no se guardaba en ningún sitio:

| Dónde se podría haber guardado | Por qué no sirve |
| --- | --- |
| Auditoría de ejecución (`plusmedik_audit_*`) | Solo códigos y estados, por diseño (privacidad). El texto del turno vive "solo en memoria" (`src/turns.ts`). |
| Memoria conversacional (`plusmedik_conversation_messages`, migración 17) | Es contexto corto **para el modelo**: apagada por defecto, descarta lo que parece de salud y las cotizaciones, satura el texto, y vence a los 7 días. Sin `PLUSMEDIK_CONVERSATION_MEMORY` no guarda nada. |
| Mensajes de la recepción humana | Solo se registra la pausa (fecha y clave), sin el texto. |
| `agent_messages` / `crm.messages` | Este repositorio **no las escribe** (una prueba lo exige). `agent_messages` es del sistema anterior (último mensaje: 20-oct-2026). |

Este módulo es **aparte**: tabla, clave, retención y funciones propias. No lee ni escribe nada de la memoria, no usa el modelo y **no influye en ninguna decisión del agente**: si se apaga o falla, el agente responde exactamente igual (hay una prueba que compara las respuestas con y sin historial).

## Qué guarda

| Tipo | Cómo se registra | Estado |
| --- | --- | --- |
| Mensaje del paciente (texto) | Al llegar el webhook, cifrado | `RECEIVED` |
| Audio del paciente | Tipo y referencia del medio (nunca el enlace); la **transcripción** se agrega cifrada al transcribirse | `RECEIVED` |
| Imagen del paciente | Tipo, referencia del medio y pie (cifrado); nunca el enlace ni la imagen | `RECEIVED` |
| Otros tipos (documento, ubicación, reacción…) | Solo el tipo | `RECEIVED` |
| Respuesta del agente | Cuando **Kapso la aceptó** (`deliver()` en `src/guarded-turn.ts`), con el id del mensaje al que responde y la corrida de auditoría | `ACCEPTED` |
| Envío incierto (Kapso falló sin saberse si salió) | Con un id propio `uncertain:<mensaje>` | `UNCERTAIN` |
| Mensaje de la recepción humana, de otra app o del agente de Meta | Cuando Kapso lo informa (`origin` distinto de `cloud_api`), con su actor | `SENT`… |
| Estado de entrega | Eventos `sent` / `delivered` / `read` / `failed` de Kapso | `SENT` → `DELIVERED` → `READ` / `FAILED` |

- **Aceptado no es entregado.** `ACCEPTED` significa que Kapso aceptó la solicitud de envío. Solo `DELIVERED`/`READ` confirman la entrega, y solo si Kapso envía esos eventos. El estado **solo avanza** (un evento tardío o repetido no retrocede nada).
- **No se guarda** lo que nunca se envió: respuestas canceladas por `HUMAN_PAUSED`, `DAILY_CAP`, obsolescencia o pérdida del lease. El mensaje del paciente sí queda, y la corrida de auditoría explica por qué no hubo respuesta.
- **No se guarda** lo reimportado del historial de WhatsApp (`history_sync`), ni los mensajes de otra línea, ni los de contactos fuera de `ALLOWED_PHONES`.
- **Actores:** `PATIENT`, `AGENT`, `HUMAN` (WhatsApp Business), `OTHER_APP`, `META_AGENT`, `UNKNOWN`. La recepción humana nunca se confunde con el agente.
- **Límite conocido:** un mensaje enviado por Kapso con origen `cloud_api` que **no** es de este agente (otra automatización) no se registra: no se puede distinguir del agente.

## Orden e idempotencia

- Único por `(proveedor, línea, mensaje)`: reintentos del webhook, lotes repetidos y ecos no duplican nada.
- Orden cronológico por `seq` (autonumérico, en el orden de escritura) y `occurred_at` (hora del mensaje; la fecha futura se acota a "ahora").
- Mensajes agrupados (`BATCHED`): cada mensaje del lote se guarda; la única respuesta del lote se guarda una vez.

## Protección de datos

- **Cifrado:** AES-256-GCM en la aplicación con `PLUSMEDIK_HISTORY_KEY` (**fuera de la base**, ≥ 32 caracteres, distinta de las demás claves; si coincide con alguna queda apagado). La línea, el contacto, la dirección y el id del mensaje van como dato autenticado: **una fila cifrada no se puede pasar a otro contacto ni mensaje** (hay una prueba que lo manipula). Cada fila lleva la huella corta de su clave (`key_id`) para poder rotarla.
- **Sin teléfono:** solo la clave HMAC del contacto (la misma de los turnos; incluye la línea). **Sin enlaces** de medios ni credenciales.
- **Acceso:** RLS activo y **ningún privilegio directo** sobre las tablas, ni siquiera `service_role`; solo siete funciones `SECURITY DEFINER` con `search_path` vacío, concedidas únicamente a `service_role`. No hay ninguna ruta HTTP que lea el historial.
- **Registros de Vercel:** solo contadores y códigos (`message_history {op, recorded, duplicate, …}`); nunca texto, teléfonos, ids de mensaje ni claves.
- **Retención:** por defecto **sin vencimiento**: todos los mensajes (los que entran y los que salen) se conservan en Supabase para siempre. Opcionalmente `PLUSMEDIK_HISTORY_RETENTION_DAYS` (1–3650) pone un tope, y entonces lo vencido no se exporta y se purga (acotado) en cada escritura y con `plusmedik_history_purge`. **Supresión:** `plusmedik_history_erase` (por contacto, con motivo y rastro); además, quitar la clave vuelve ilegible todo lo cifrado con ella.
- **Autorización para activarlo:** exige además `PLUSMEDIK_HISTORY_PRIVACY_REVIEWED=yes`. Es una confirmación explícita de que el laboratorio revisó la privacidad (se guardan conversaciones **incluyendo temas de salud**). Sin ella, queda apagado.

## Exportación autorizada

No hay endpoint. Se hace en una máquina de confianza con las claves en el entorno:

```
npx tsx scripts/history-export.ts --reason "revisión de calidad noviembre 2026" --out export.jsonl [--format csv]
     [--phone 591XXXXXXXX | --contact-key <hmac>] [--from 2026-11-01] [--to 2026-11-04]
```

- La base devuelve el texto **cifrado**; se descifra en el script con `PLUSMEDIK_HISTORY_KEY` (y `PLUSMEDIK_HISTORY_KEY_PREVIOUS` si se rotó).
- **Exige un motivo** (≥ 10 caracteres) y cada página exportada deja una fila en `plusmedik_message_history_access` (motivo, contacto, rango, cuántas filas; **sin contenido**).
- El archivo se crea con permisos `0600` y la terminal solo muestra contadores. Contiene conversaciones reales: no se sube a ningún lado y se borra al terminar la auditoría. El CSV neutraliza las fórmulas (`= + - @`).
- `--erase` (con `--phone`/`--contact-key` y `--reason`) suprime todo lo de un contacto.

## Si falla la escritura

| Situación | Qué pasa |
| --- | --- |
| La base no responde / rechaza | El agente **no se entera**: responde igual. Cada operación está acotada a 3 s. Queda `message_history_write_failed {op, failed}` (solo códigos). |
| El cifrado falla | No se escribe nada (jamás en claro) y queda el mismo código. |
| Falta la clave o la configuración es insegura | Queda **apagado** desde el arranque (`message_history_config_invalid {error}`). |
| Un mensaje no llegó a guardarse | **No se pierde en silencio:** `--gaps` (`plusmedik_history_gaps`) compara con la auditoría de ejecución y lista los ids de los mensajes procesados o respondidos que faltan en el historial. |

Límite honesto: el webhook responde 200 de inmediato (política de ACK de siempre), así que Kapso no reintenta un mensaje cuya escritura al historial falló. Lo que **sí** pasó por el agente se detecta con `--gaps`; un mensaje que el agente nunca procesó (p. ej. un contacto fuera de alcance) no tiene corrida de auditoría con la que compararlo.

## Configuración (Production)

| Variable | Obligatoria | Qué es |
| --- | --- | --- |
| `PLUSMEDIK_HISTORY` | sí, `on` | Enciende el historial. |
| `PLUSMEDIK_HISTORY_PRIVACY_REVIEWED` | sí, `yes` | Confirma la revisión de privacidad del laboratorio. |
| `PLUSMEDIK_HISTORY_KEY` | sí | Clave dedicada de cifrado (≥ 32 caracteres). |
| `PLUSMEDIK_CONTACT_HMAC_KEY` / `KAPSO_PHONE_NUMBER_ID` | sí | Las de siempre (clave del contacto y línea). |
| `PLUSMEDIK_HISTORY_RETENTION_DAYS` | no | Tope opcional, 1–3650 días. En blanco = sin vencimiento (se conserva todo). |
| `PLUSMEDIK_HISTORY_KEY_PREVIOUS` | no | Solo para el script de exportación, tras rotar la clave. |

No depende de `PLUSMEDIK_TURNS`: el webhook registra entrantes, mensajes humanos y estados aunque los turnos estén apagados; las respuestas del agente se registran cuando el agente responde.

## Plan de activación gradual

1. **Revisión de privacidad y retención** con el laboratorio (qué se guarda, quién exporta, cuántos días). Sin esto, no continuar.
2. **Preview / base de pruebas:** aplicar la migración 21 (a mano, en el SQL Editor, después de las 20 anteriores; `supabase/preflight/v2_post_apply_read_only.sql` verifica el resultado), definir las variables del cuadro y desplegar. Verificar en los registros `history_scope {"enabled":true}` y `message_history {op:"OBSERVE"…}`.
3. **Prueba con un contacto propio:** enviar un mensaje, una nota de voz y una foto; confirmar las filas y los estados de entrega; exportar con `scripts/history-export.ts` y comprobar que el texto coincide; ejecutar `--gaps` (debe salir vacío).
4. **Production:** repetir con `ALLOWED_PHONES`/piloto acotado y revisar `message_history_write_failed` (debe ser 0). Ampliar solo después.
5. **Para volver atrás:** quitar `PLUSMEDIK_HISTORY` y volver a desplegar (el agente no cambia). Para borrar lo guardado: `--erase` por contacto o dejar que venza.

## Riesgos y mitigaciones

- **Datos de salud en reposo.** Mitigación: cifrado con clave fuera de la base, RLS sin acceso directo, exportación con motivo y rastro, confirmación explícita de privacidad para activarlo.
- **Pérdida o filtración de la clave.** Perder la clave = no poder leer; filtrarla + acceso a la base = poder leer todo. Guardarla en un gestor de secretos, rotarla (`key_id`) y limitar quién tiene el service role.
- **Escrituras perdidas** (base caída). Mitigación: acotadas, no afectan al agente, con conciliación (`--gaps`). No hay reintento diferido (a propósito: sin cola).
- **Lo que no se ve:** mensajes de otras automatizaciones con origen `cloud_api`; entrega confirmada si Kapso no envía los eventos de estado.
