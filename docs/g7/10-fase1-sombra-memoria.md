# G7 · Fase 1 — memoria y objetivos pendientes, en modo sombra

Estado: **implementada y probada; APAGADA por defecto; sin commit, push ni deploy; la migración 24 NO está aplicada a ningún Supabase.**
Bandera: `PLUSMEDIK_CONV_STATE` (ausente / vacío / `off` = apagada; `shadow` = registra; cualquier otro valor = apagada y un código `conv_state_config_invalid`).

## 1. Qué hace y qué NO hace

En modo sombra el agente **observa** la conversación de cada contacto y la resume como eventos mínimos. Con eso calcula, con un reductor puro, qué le pidió el paciente que **sigue sin atender**: una petición contestada solo con un texto fijo, un envío que falló, un mensaje que llegó durante la pausa humana, una receta que no llegó a cotizarse.

- **No cambia ninguna respuesta.** No lee la memoria para responder. No toma ni espera un lease. No bloquea un envío. No cambia la pausa humana. No toca el tope diario ni los precios.
- **Si falla, el agente responde igual.** Cada escritura es de mejor esfuerzo, con tiempo acotado (3 s, un reintento corto), y el error se convierte en un código (`conv_state_write_failed` con `eventType`, `kind`, `httpStatus`, `serverCode`). Nunca se registra texto.
- **Apagada = idéntica a hoy.** Sin la bandera no se ejecuta ni se llama nada nuevo (solo se carga el módulo) y no hay registros nuevos (probado).

## 2. Diseño (el más pequeño que funciona)

Solo una tabla de **eventos append-only** (`plusmedik_conv_events`, migración 24). No hay tabla de estado ni compare-and-swap: la proyección se recalcula en TypeScript releyendo los eventos en orden. Reconstruir la verdad = repetir el reductor.

| Evento | Quién lo emite | Qué guarda |
|---|---|---|
| `PATIENT_BATCH` | `processTurns`, tras reclamar el lote (o al encontrar la pausa) | por petición: id del mensaje, tema (`RECIPE_OR_QUOTE`, `INFO_REQUEST`, `MEDIA_IMAGE`…), objetivo, y `p` si estaba en pausa humana |
| `AGENT_REPLY` | `deliver`, solo si Kapso **aceptó** el envío | calidad: `ANSWER`, `QUOTE`, `GENERIC`, `BLOCKED`, `TECHNICAL`, `UNRESOLVED` |
| `HUMAN_MESSAGE` | webhook, al ver un mensaje saliente de una persona | nada (solo el instante) |
| `HUMAN_RESUME` | ruta de atención del CRM, tras confirmar una reanudación manual | nada |
| `ARTIFACT` | los tres puntos donde se lee una receta o se arma una cotización | `RECIPE`/`QUOTE` con **ids de estudios** (nunca precios ni texto) |

Reglas del reductor (`src/conversation-state.ts`, puro y probado con una prueba de propiedad):

1. Un texto fijo genérico, «no puedo derivar», un fallo técnico o «sin cotización» **no cierran** la petición: queda *pospuesta con motivo* (`FIXED_REPLY_ONLY`, `HANDOFF_UNAVAILABLE`, `TECHNICAL_ISSUE`, `NOT_RESOLVED`).
2. Una respuesta con contenido cierra lo abierto **y** lo pospuesto del mismo tema; una cotización cierra además lo pospuesto con objetivo de cotizar. Lo pospuesto por la pausa humana no lo cierra el agente (durante la pausa no responde).
3. Un mensaje de una persona pasa la palabra a `HUMAN` y cierra lo pendiente como atendido por la recepción; un mensaje del paciente durante la pausa queda `CARRIED/HUMAN_PAUSED`; la reanudación **manual** lo reabre.
4. Los objetivos persisten y vencen a las 24 h. Idempotente por id de evento; el orden se reconstruye por instante.

### Por qué es compatible con idempotencia, leases y coordinación

- Cada evento tiene clave única `(contact_key, event_key)`: un reintento de Kapso, un turno repetido o tres entregas simultáneas no duplican nada (probado).
- Las escrituras **no** toman leases: son hechos idempotentes. Un turno que perdió su lease no puede enviar (la reserva lo impide), así que tampoco emite `AGENT_REPLY`.
- La lectura (`plusmedik_conv_events_read`, `plusmedik_conv_contacts_since`) es `STABLE`: la base impide que escriba o bloquee filas.

## 3. Privacidad (la base lo impone, no depende de la disciplina del código)

- **Nunca texto del paciente ni precios.** La restricción `plusmedik_conv_payload_ok` exige que *toda cadena del payload* sea un identificador o código corto (`^[A-Za-z0-9_.=:+/-]{1,128}$`), que toda clave sea un nombre simple y que el payload pese ≤ 4 KB. Una frase, un nombre, un teléfono con espacios o un precio con «Bs» no pasan. Ni siquiera el propietario de la tabla puede insertarlos (probado).
- `contact_key` es el HMAC que ya usan los turnos (incluye la línea de WhatsApp): no hay teléfono en la tabla.
- Sin acceso directo: RLS activo y **ningún privilegio** sobre la tabla ni siquiera para `service_role`; solo funciones `SECURITY DEFINER` con `search_path` vacío, ejecutables solo por `service_role`.
- Retención: cada evento vence (30 días por defecto; `PLUSMEDIK_CONV_STATE_RETENTION_DAYS` de 1 a 365); cada escritura purga hasta 20 vencidos; `plusmedik_conv_purge` a demanda; `plusmedik_conv_erase` borra todo de un contacto, exige un motivo y deja un rastro sin contenido en `plusmedik_message_history_access`.
- El texto de un mensaje pasa por la memoria del proceso **solo** para clasificarlo y se descarta.
- Los registros de Vercel llevan contadores y códigos (`conv_state {op, kind, outcome}`), nunca texto, ids de mensaje ni teléfonos.

## 4. Archivos

- `supabase/migrations/20261112000000_plusmedik_conversation_events.sql` (migración 24, aditiva y reaplicable; **no aplicada**).
- `src/conversation-state.ts` (dominio puro: reductor, codificación/decodificación, invariantes), `src/conversation-state-store.ts` (almacén, lector, registrador, configuración).
- Enganches (todos opcionales y de una línea): `src/guarded-turn.ts` (`AGENT_REPLY`), `src/turns.ts` (`PATIENT_BATCH` + `flush`), `src/kapso-webhook.ts` (`HUMAN_MESSAGE`), `src/crm-attention.ts` (`HUMAN_RESUME`), `src/whatsapp-quote.ts`, `src/quote-session-turns.ts`, `src/batch-execution.ts` (`ARTIFACT`), `api/kapso/webhook.ts` (resolución de la bandera y log `conv_state_scope`).
- `scripts/g7/phase1/conversation-state.ts` ahora solo **re-exporta** el módulo real (una sola copia del reductor para la evaluación y para producción).
- Manifiesto de verificación previa/posterior (`supabase/preflight/*`, regenerado) y `docs/g5/20-…` (fila 24).

## 5. Verificación

| Prueba | Qué demuestra |
|---|---|
| `tests/conversation-state-db.test.ts` (16, PostgreSQL real) | forma estática; el validador rechaza frases, nombres, claves raras, anidados, cadenas largas y payloads grandes; idempotencia; validación de contacto/clave/tipo/fecha/cantidad/retención; fecha futura acotada; retención y purga acotada; supresión con rastro; ningún rol toca la tabla; lecturas de solo lectura; reaplicable |
| `tests/conversation-state-store.test.ts` (28) | ida y vuelta de la codificación; filas ilegibles se ignoran; orden por instante; clasificación de peticiones y de calidad de respuesta; el grabador nunca lanza ni guarda texto y su `flush` está acotado; configuración (valor inválido no enciende) |
| `tests/g7-phase1-state.test.ts` (11) | reglas del reductor + propiedad sobre secuencias aleatorias de eventos |
| `tests/conversation-state-e2e.test.ts` (8, webhook + turnos + PostgreSQL reales) | **encendida u apagada: mismos envíos, mismas corridas de auditoría, mismo historial, mismas llamadas a la base salvo `plusmedik_conv_*` y ningún registro nuevo salvo `conv_state*`**; receta con texto fijo queda pendiente y la cotización la cierra; reentrega ×3 sin duplicar; pausa humana; un envío incierto no cuenta como respuesta; privacidad; migración sin aplicar o red caída no cambia la respuesta |

### Defectos que la verificación encontró (y ya están corregidos)

1. `{1,300}` en una expresión regular de la migración: PostgreSQL limita las repeticiones a 255 → todas las escrituras habrían fallado. Ahora `{1,200}`.
2. `keyvalue()` de jsonpath falla con valores que no son objetos → el validador rechazaba payloads válidos. Ahora filtra por tipo objeto.
3. La restricción se agregaba con `ALTER TABLE`, lo que impedía reaplicar la migración (el procedimiento de aplicación exige que se pueda). Ahora está dentro de `CREATE TABLE`.
4. Una cotización posterior no cerraba una petición ya pospuesta (foto ilegible → foto nueva → cotización quedaba «pendiente» para siempre). Regla 2 de arriba.
5. En el registro de fallos, el `kind` del error pisaba el tipo de evento (ahora `eventType` y `kind`).

## 6. Límites conocidos (decididos, no olvidados)

- La memoria **todavía no se usa** para responder; solo existe `createConversationReader` (`stateOf`, `pendingContacts`). No hay aún un informe para la recepción: es el primer uso previsto (lista de pendientes) y no cambia ninguna respuesta.
- `ARTIFACT/QUOTE` se anota cuando se calcula la cotización, no cuando se entrega; la entrega la dice `AGENT_REPLY`.
- Los audios se anotan como `MEDIA_AUDIO` antes de transcribirse; los documentos (`OTHER`) no se reclaman en turnos, así que no se anotan en esta fase.
- «Una persona escribió» cierra lo pendiente como atendido por la recepción: es una aproximación (la persona pudo contestar otra cosa). Por eso solo se muestra como `STAFF`, nunca como «resuelto por el agente».
- Dos cotizaciones seguidas y el caso «listo + foto» heredan las rarezas de la ruta de siempre (diferido).

## 7. Cómo activarla (cuando usted decida; no lo hice)

1. Aplicar **a mano** la migración 24 (después de la verificación previa de `supabase/preflight/v2_pre_apply_read_only.sql`).
2. Confirmar que existen `PLUSMEDIK_CONTACT_HMAC_KEY` y `KAPSO_PHONE_NUMBER_ID` (ya los usan los turnos).
3. Poner `PLUSMEDIK_CONV_STATE=shadow` en la vista previa primero. Debe aparecer `conv_state_scope {mode: "shadow"}` y luego `conv_state {op: WRITE, outcome: RECORDED|DUPLICATE}`.
4. Vigilar `conv_state_write_failed`: un `serverCode` `PGRST202` indica migración sin aplicar; `PT422`, un evento rechazado por el validador (no debería ocurrir).
5. **Retirar:** quitar la variable. No hace falta tocar la base.
