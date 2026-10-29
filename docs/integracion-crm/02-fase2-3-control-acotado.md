# Fase 2.3 · Control manual del CRM acotado a contactos autorizados

Estado: implementado y probado en local. **Sin commit, sin migración nueva, todo apagado por defecto.** Nada de esto se ha desplegado ni se ha aplicado en Vercel, Supabase, Kapso ni Dokploy.

## 1. El problema

`PLUSMEDIK_HUMAN_CONTROL` era un interruptor único que, al encenderse, hacía TRES cosas a la vez, todas sobre **todos** los pacientes:

| # | Efecto de `PLUSMEDIK_HUMAN_CONTROL=on` | Dónde |
|---|---|---|
| 1 | Pausa **automática** cuando una persona escribe desde WhatsApp Business (eventos `HUMAN_BUSINESS_APP`, etc.) | `src/kapso-webhook.ts` |
| 2 | Claim de auditoría **obligatorio** con la clave de contacto: sin base o sin clave no se responde | `src/guarded-turn.ts` (`beginTurn`) |
| 3 | Condición para que las rutas del CRM (`attention/*`) muten algo (`controlReady`) | `src/crm-attention.ts` |

Para probar la pausa manual con un solo contacto había que encender también (1) y (2) para todos.

## 2. Diseño

Dos interruptores independientes, sin tocar `ALLOWED_PHONES`:

| Variable | Significado | Por defecto |
|---|---|---|
| `PLUSMEDIK_HUMAN_CONTROL=on` | **Igual que siempre**: pausa automática por mensajes humanos + claim obligatorio para todos + el CRM opera sobre todos los contactos | apagada |
| `PLUSMEDIK_AGENT_CONTROL=on` + `PLUSMEDIK_AGENT_CONTROL_TOKEN` | Habilita las rutas `status` / `action` (Fase 1) | apagada |
| **`PLUSMEDIK_AGENT_CONTROL_PHONES`** (nueva) | Lista explícita de números autorizados (coma, solo dígitos con prefijo de país, máx. 10) | vacía |

Combinaciones (con `PLUSMEDIK_AGENT_CONTROL=on`, token válido y `PLUSMEDIK_CONTACT_HMAC_KEY` ≥ 32):

| `HUMAN_CONTROL` | `…_PHONES` | Rutas del CRM | Webhook |
|---|---|---|---|
| off | vacía | no mutan (`available:false`), como en la Fase 1 | sin cambios |
| off | **lista válida** | solo operan sobre la lista; otro número → **403** antes de tocar la base | **solo para los números de la lista**: claim con clave de contacto, pausa comprobada en reserva y antes de enviar, falla cerrado. Los demás pacientes: flujo de siempre. **Sin** pausa automática por mensajes humanos |
| off | lista **inválida** | 503 `not_configured` + código `INVALID_SCOPE` en el registro | sin cambios |
| on | vacía | operan sobre todos (Fase 1) | control humano global (como siempre) |
| on | lista válida | la lista solo restringe a quién puede operar el CRM | control humano global (como siempre) |

Sin `PLUSMEDIK_AGENT_CONTROL=on` la lista no hace nada.

### Combinación con `PLUSMEDIK_TURNS=on` (soportada, sin bypass)

Con turnos encendidos el webhook reclama **todos** los mensajes (texto, fotos y otros) con la clave de contacto, para todos los pacientes, sea cual sea la lista; el modo acotado deja de intervenir en el webhook (`beginTurn` lo ignora cuando hay turnos) porque ya hay una vía más estricta. La pausa de un contacto autorizado se respeta igual (texto y fotos callan; probado contra PostgreSQL real), y un número fuera de la lista sigue sin poder pausarse desde el CRM (403). Diferencias respecto del modo sin turnos: (a) con Supabase caído **nadie** recibe respuesta (política propia de los turnos) y (b) la lista solo decide a quién puede pausar el CRM, no a quién se le exige la clave.

### Por qué los demás pacientes no se ven afectados

La pausa se aplica en la base por `contact_key`, y solo existe en la corrida si el claim lo recibió. En modo acotado, `beginTurn` solo pasa la clave de contacto cuando el número está en la lista (`scopedControl.covers`). Para cualquier otro número el claim es **idéntico** al de antes (un solo argumento, sin clave), su corrida no tiene `contact_key`, la base no tiene estado ni eventos de atención para ellos, y la política ante una base caída es la histórica (se responde igual, salvo `REQUIRE_AUDIT_GUARD`). Las pruebas lo verifican contra PostgreSQL real.

### Lo que NO cambia

Idempotencia por `operationId` (`crm:<id>`, replay y 409), HMAC del contacto (se calcula solo en el agente), token Bearer exclusivo en tiempo constante, HTTPS obligatorio, rechazo de navegadores, cuerpo estricto, validación de `phoneNumberId`, bloqueo de envíos por pausa (reserva + comprobación final), `confirmed:true` solo con confirmación firme de la base. No hay migraciones nuevas: se reutiliza la función `plusmedik_attention_crm_action` (migración 15).

## 3. Riesgos conocidos del modo acotado

1. **Retirar un número de la lista (o apagar el modo) con la pausa vigente hace que el agente vuelva a responderle**, porque la pausa guardada deja de consultarse. **Es una operación que EXIGE reactivación previa**: primero `resume` (y comprobar `status` = `ACTIVE`), después retirar el número y hacer *redeploy*. Una prueba contra la base real lo documenta.
2. **Autorización por lista ≠ filtrado de pacientes.** `PLUSMEDIK_AGENT_CONTROL_PHONES` no restringe quién recibe respuestas (eso sigue siendo `ALLOWED_PHONES`, que NO debe definirse en producción para esta prueba: dejaría sin atención al resto).
3. **El contacto autorizado pierde el comportamiento "responder aunque la base falle"**: ante una caída de Supabase su mensaje no se responde (es lo deseado y es la garantía de la pausa).
4. **La pausa automática por mensajes humanos NO está activa** en este modo: si una persona escribe desde WhatsApp Business al contacto autorizado, el agente no se pausa solo; solo lo hace el CRM.
5. **Formato de los números:** deben incluir el prefijo de país y coincidir en dígitos con lo que envía Kapso (`+` y espacios se ignoran). Un número sin prefijo no coincidirá nunca (falla cerrado: 403 y el agente lo trata como un paciente más).
6. **El tope de 10** evita que la lista se convierta en un sustituto permanente del control global.
7. Las rutas siguen sin límite de frecuencia: la protección es el token (≥ 32 caracteres).

## 4. Procedimiento de despliegue controlado (a ejecutar solo con autorización)

Requisitos previos: las 15 migraciones ya aplicadas y verificadas (hecho); `PLUSMEDIK_HUMAN_CONTROL`, `PLUSMEDIK_AGENT_CONTROL` y `ALLOWED_PHONES` sin definir en Production (hecho); el contacto autorizado es un número real del equipo con WhatsApp.

**Etapa 0 — Preparación sin tocar producción**
- Revisar el diff completo de la rama y aprobar el commit.
- Generar dos secretos aleatorios de ≥ 32 caracteres (token CRM→agente y clave HMAC de contactos) y guardarlos en un gestor; no escribirlos en el chat, en el repositorio ni en el historial del terminal. **La clave HMAC no debe cambiar después.**
- Anotar el número exacto del contacto autorizado, solo dígitos con prefijo de país.

**Etapa 1 — Desplegar el código con las variables nuevas ausentes**
1. Abrir una PR de la rama hacia `main` y fusionarla (la rama contiene `main`: puede ser *fast-forward*). Vercel construye Production con las variables Production.
2. Verificar: `GET /api/kapso/webhook` → `{"ok":true,...}`; `POST …/attention/status` sin token → **503** `not_configured`; una foto del contacto autorizado se cotiza como antes; sin errores en los registros.
3. Reversión: *Instant Rollback* al deployment anterior (`dfa98da`).

**Etapa 2 — Abrir solo las rutas, sin mutar (`HUMAN_CONTROL` y lista ausentes)**
1. Production → agregar `PLUSMEDIK_AGENT_CONTROL=on` y `PLUSMEDIK_AGENT_CONTROL_TOKEN`; *redeploy*.
2. `status` con el token y el teléfono del contacto → 200 `available:false, reason:"control_disabled"`. Sin token → 401; otro `phoneNumberId` → 403; teléfono mal formado → 400. Sin cambios en la base.

**Etapa 3 — Activar el modo acotado**
1. Agregar `PLUSMEDIK_CONTACT_HMAC_KEY` y `PLUSMEDIK_AGENT_CONTROL_PHONES=<número autorizado>`; *redeploy*. **No** definir `PLUSMEDIK_HUMAN_CONTROL` ni `ALLOWED_PHONES`.
2. `status` del autorizado → `available:true`, `ACTIVE`, anotar `revision`. `status` de OTRO número → **403** `contact_not_authorized`.
3. El autorizado envía una foto → recibe cotización (único gasto de IA).
4. Un paciente NO autorizado (otro número del equipo) envía una foto → recibe su cotización con normalidad.
5. `action pause` (con `operationId` nuevo) → `confirmed:true`, `HUMAN_PAUSED`. Foto del autorizado → **sin respuesta**. Foto del no autorizado → **con respuesta**.
6. Repetir exactamente la misma pausa → `replayed:true`, misma revisión; mismo `operationId` con `resume` → 409.
7. `action resume` → `ACTIVE`; foto del autorizado → respuesta.
8. **Detener** ante cualquier 5xx inesperado, respuesta estando pausado, o que el no autorizado deje de recibir respuesta.

**Etapa 4 — Conectar el CRM** (Dokploy): `PLUSMEDIK_AGENT_CONTROL_ENABLED=true`, `PLUSMEDIK_AGENT_CONTROL_URL=https://<alias de producción>` (sin ruta), el mismo token, `PHONE_NUMBER_ID` igual a `KAPSO_PHONE_NUMBER_ID`. Repetir estado → pausa → reactivación desde la interfaz del CRM sobre el contacto autorizado.

**Reversión de las etapas 2–4:** reactivar (`resume`) al contacto autorizado; quitar `PLUSMEDIK_AGENT_CONTROL_PHONES` y `PLUSMEDIK_AGENT_CONTROL`; *redeploy*. Las rutas pasan a 503 y el webhook queda como siempre.

**Después de la prueba:** para operar sobre todos los pacientes hay que decidir por separado encender `PLUSMEDIK_HUMAN_CONTROL` (que añade la pausa automática por mensajes humanos y el claim obligatorio para todos); eso es otra autorización.

## 5. Pruebas

`tests/crm-scope.test.ts` (30, unitarias: lista, combinaciones de banderas, rutas, flujo del webhook con auditoría simulada y fallos), `tests/crm-scope-e2e.test.ts` (11, contra PostgreSQL real con las 15 migraciones: aislamiento entre contactos, estado/eventos solo del autorizado, pausa automática independiente, caída de Supabase, fallo de la reserva, idempotencia, encendido y apagado de banderas, y la combinación con PLUSMEDIK_TURNS=on: sin bypass de la pausa y falla cerrado ante una caída de Supabase), más las pruebas de frontera y de valores por defecto actualizadas.
