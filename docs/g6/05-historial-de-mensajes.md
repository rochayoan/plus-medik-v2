# G6.5 · Historial de mensajes

Estado: implementado y probado. **Encendido por defecto y sin variables nuevas.** Requiere las **migraciones 21 y 22** (aditivas). No usa cola, cron ni rutas HTTP nuevas.

## Qué hace

Guarda en el Supabase del laboratorio **todos los mensajes**, los que entran y los que salen, **para siempre**, en una tabla propia (`plusmedik_message_history`), para tenerlos disponibles en los demás proyectos y poder auditar conversaciones reales:

| Tipo | Cómo se registra | Estado |
| --- | --- | --- |
| Mensaje del paciente (texto) | Al llegar el webhook | `RECEIVED` |
| Audio del paciente | Tipo y referencia del medio (nunca el enlace); la **transcripción** se agrega al transcribirse | `RECEIVED` |
| Imagen del paciente | Tipo, referencia del medio y pie (nunca el enlace ni la imagen) | `RECEIVED` |
| Otros tipos (documento, ubicación, reacción…) | Solo el tipo | `RECEIVED` |
| Respuesta del agente | Cuando **Kapso la aceptó** (`deliver()` en `src/guarded-turn.ts`), con el id del mensaje al que responde y la corrida de auditoría | `ACCEPTED` |
| Envío incierto (Kapso falló sin saberse si salió) | Con un id propio `uncertain:<mensaje>` | `UNCERTAIN` |
| Mensaje de la recepción humana, de otra app o del agente de Meta | Cuando Kapso lo informa (`origin` distinto de `cloud_api`), con su actor | `SENT`… |
| Estado de entrega | Eventos `sent` / `delivered` / `read` / `failed` de Kapso | `SENT` → `DELIVERED` → `READ` / `FAILED` |

- **Texto en claro y sin vencimiento por defecto.** Se lee directamente desde Supabase (columna `body`), con la clave de servicio, desde cualquier proyecto. Es la misma forma en que funcionaba `agent_messages`.
- **Aceptado no es entregado.** `ACCEPTED` significa que Kapso aceptó la solicitud de envío; `DELIVERED`/`READ` solo llegan si Kapso envía esos eventos. El estado **solo avanza**.
- **No se guarda** lo que nunca se envió (respuestas canceladas por `HUMAN_PAUSED`, `DAILY_CAP`, obsolescencia o pérdida del lease); el mensaje del paciente sí queda y la corrida de auditoría explica por qué no hubo respuesta.
- **Se guarda para TODOS los contactos**, sin lista de números: `ALLOWED_PHONES` y el piloto deciden a quién **atiende** el agente, no a quién se guarda (un contacto que el agente no atiende queda con su mensaje y sin respuesta).
- **No se guarda** lo reimportado del historial de WhatsApp (`history_sync`) ni los mensajes de otra línea de WhatsApp.
- **Actores:** `PATIENT`, `AGENT`, `HUMAN`, `OTHER_APP`, `META_AGENT`, `UNKNOWN`. La recepción humana nunca se confunde con el agente.
- **Límite conocido:** un mensaje enviado por Kapso con origen `cloud_api` que no es de este agente (otra automatización) no se registra: no se puede distinguir del agente.

## Independiente del agente

No usa la memoria conversacional ni el modelo y **no influye en ninguna decisión**: si se apaga o falla, el agente responde exactamente igual (hay una prueba que compara las respuestas con y sin historial). Las escrituras son en segundo plano o acotadas a 3 s, y nunca interrumpen un mensaje.

## Orden e idempotencia

- Único por `(proveedor, línea, mensaje)`: reintentos del webhook y ecos no duplican nada.
- Orden cronológico por `seq` (autonumérico) y `occurred_at` (hora del mensaje; una fecha futura se acota a "ahora").
- Mensajes agrupados (`BATCHED`): cada mensaje del lote se guarda; la única respuesta del lote se guarda una vez.

## Datos y acceso

- **Sin teléfono en la tabla:** solo `contact_key`, el HMAC del contacto que ya usan los turnos (incluye la línea). Para saber de qué paciente es, se calcula esa clave con el teléfono (`scripts/history-export.ts --phone`). **Sin enlaces** de medios ni credenciales.
- **Acceso:** RLS activo y **ningún privilegio directo** sobre las tablas, ni siquiera `service_role`; solo funciones `SECURITY DEFINER` con `search_path` vacío, concedidas únicamente a `service_role`. Los demás proyectos leen con la clave de servicio, llamando a `plusmedik_history_export` (con motivo y rastro) o, si prefieren una vista propia, creándola ellos.
- **Registros de Vercel:** solo contadores y códigos; nunca texto, teléfonos, ids de mensaje ni claves.
- **Datos de salud en claro:** los mensajes pueden incluir temas de salud y quedan en claro dentro de la base. Quien tenga la clave de servicio de Supabase puede leerlos: protégela como siempre.

## Cifrado opcional

Si se define `PLUSMEDIK_HISTORY_KEY` (≥ 32 caracteres, distinta de cualquier otra clave; si coincide queda apagado), el texto se guarda **cifrado** (AES-256-GCM, con contacto, línea, dirección y mensaje como dato autenticado) y solo se lee con el script de exportación y esa clave. Útil si se prefiere que la base nunca vea el texto; a cambio los otros proyectos no podrán leerlo.

## Retención

Por defecto **no vence nada**. `PLUSMEDIK_HISTORY_RETENTION_DAYS` (1–3650) pone un tope opcional; lo vencido no se exporta y se purga en cada escritura y con `plusmedik_history_purge`. `--erase` suprime todo lo de un contacto (con motivo y rastro).

## Exportación

No hay endpoint. En una máquina de confianza:

```
npx tsx scripts/history-export.ts --reason "revisión de calidad noviembre 2026" --out export.jsonl [--format csv]
     [--phone 591XXXXXXXX | --contact-key <hmac>] [--from 2026-11-01] [--to 2026-11-04]
```

- Exige un motivo (≥ 10 caracteres); cada página exportada deja una fila en `plusmedik_message_history_access` (motivo, contacto, rango, filas; **sin contenido**).
- El archivo se crea con permisos `0600` y la terminal solo muestra contadores. Contiene conversaciones reales: no se sube a ningún lado. El CSV neutraliza las fórmulas (`= + - @`).
- `--gaps` lista los mensajes que la auditoría de ejecución procesó o respondió y que faltan en el historial (escrituras que fallaron). `--erase` suprime un contacto.

## Si falla la escritura

| Situación | Qué pasa |
| --- | --- |
| La base no responde / rechaza (por ejemplo, migraciones sin aplicar) | El agente **no se entera**: responde igual. Queda `message_history_write_failed {op, failed}` (solo códigos). |
| Falta `PLUSMEDIK_CONTACT_HMAC_KEY` o `KAPSO_PHONE_NUMBER_ID` | Queda **apagado** desde el arranque (`message_history_config_invalid {error}`). |
| Un mensaje no llegó a guardarse | `--gaps` lo detecta comparando con la auditoría de ejecución. |

Límite honesto: el webhook responde 200 de inmediato (política de ACK de siempre), así que Kapso no reintenta un mensaje cuya escritura al historial falló. No hay reintento diferido (a propósito: sin cola).

## Configuración

| Variable | Obligatoria | Qué es |
| --- | --- | --- |
| *(ninguna)* | — | Encendido por defecto con lo que el agente ya tiene (`PLUSMEDIK_CONTACT_HMAC_KEY`, `KAPSO_PHONE_NUMBER_ID`). |
| `PLUSMEDIK_HISTORY=off` | no | Lo apaga. |
| `PLUSMEDIK_HISTORY_KEY` | no | Cifra el texto (ver arriba). |
| `PLUSMEDIK_HISTORY_RETENTION_DAYS` | no | Tope opcional, 1–3650. |

## Puesta en marcha

1. Aplicar las migraciones **21** y **22** en el SQL Editor (en ese orden; `supabase/preflight/v2_post_apply_read_only.sql` verifica).
2. Hacer el merge del PR y que Vercel despliegue. En los registros debe salir `history_scope {"enabled":true}`.
3. Probar con un número propio y comprobar `select direction, body from public.plusmedik_message_history order by seq desc limit 10;` (solo desde el SQL Editor, que corre como `postgres`).
4. Para volver atrás: `PLUSMEDIK_HISTORY=off` y redesplegar.

## Riesgos

- **Texto en claro de conversaciones de salud, sin vencimiento.** Mitigación: RLS sin acceso directo, acceso solo con la clave de servicio, y la opción de cifrar o poner un tope cuando se quiera.
- **Escrituras perdidas** si la base está caída: sin reintento diferido; se detectan con `--gaps`.
- **Lo que no se ve:** mensajes de otras automatizaciones con origen `cloud_api`; entrega confirmada si Kapso no envía los eventos de estado.
