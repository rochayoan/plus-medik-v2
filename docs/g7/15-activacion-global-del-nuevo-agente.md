> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 5 — activación global del nuevo agente al 100 % (preparada; PENDIENTE DE AUTORIZACIÓN FINAL)

Estado: **código, migraciones y configuración preparados y probados; NADA desplegado ni activado; las migraciones 24 y 25 no están aplicadas; no hay commit.** Este documento es el procedimiento que se ejecutará solo con su autorización final.

## 1. Qué significa `PLUSMEDIK_AGENT=live`

El núcleo conversacional atiende a **todos los contactos elegibles** (los que se pueden identificar y que hoy ya procesa el agente), **sin porcentajes ni variables de alcance**. `PLUSMEDIK_AGENT_ROLLOUT` ya no existe.

Lo que **no** cambia (protecciones actuales):
- El envío sigue por la misma máquina (lease, reserva de envío, pausa humana justo antes de enviar, un solo envío por lote, idempotencia, guarda de respuestas, tope diario). El núcleo no tiene vía de envío propia.
- Cotización y recetas: mismo motor y catálogo; el modelo nunca ve ni escribe precios. Las fotos y documentos siguen en el motor actual.
- Cifras, horas, teléfonos y enlaces solo salen de hechos aprobados; los temas de salud solo se derivan o se aplazan; no se promete a una persona sin derivación registrada (la derivación humana sigue desactivada hasta validar el CRM).

### Respaldo y reversión
- **El agente anterior responde ante cualquier problema**: interruptor apagado o ilegible, modelo caído o lento, salida inválida, verificación fallida (tras una reparación), derivación no registrada, plazo vencido (40 s), lote con fotos/documentos, persona al mando. El paciente recibe exactamente lo de hoy, una sola vez (un contacto con un solo mensaje, por su ruta individual de siempre).
- **Corta-circuito**: tras 3 fallos seguidos del proveedor (cuota, caída, plazo) nadie espera al modelo durante 1 minuto; todos reciben al agente anterior al instante.
- **Interruptor de la base (migración 25)**: `select public.plusmedik_agent_pilot_set(false, 'motivo');` apaga a **todos** en ≤ 5 s, sin redesplegar. Nace apagado (sin fila = apagado) y falla cerrado (si la base no responde, el agente nuevo no responde). Ningún rol de la API puede cambiarlo.
- Opcional: `PLUSMEDIK_AGENT_EXCLUDE_PHONES` (hasta 20 números) siguen siempre con el agente anterior (p. ej. números de control).

## 2. Qué se envía al modelo

Qué se envía a OpenAI: el texto de los mensajes de los pacientes **tal cual lo escriben** (decisión del dueño, 6-nov: no se tapan datos personales ni se retienen mensajes de salud). No viajan la clave, el teléfono de la conversación ni los ids de la plataforma; `store:false`; los registros de Vercel llevan solo códigos y contadores (nunca el texto). La regla de que el agente **no da consejos médicos** (solo aplaza o deriva) sigue vigente: es una regla de seguridad del agente, no de privacidad.

## 3. Puertas antes de encender (en este orden)

| # | Puerta | Cómo | Estado |
|---|---|---|---|
| 1 | **El modelo existe en SU cuenta** | `npx tsx scripts/g7/agent-live-eval.ts --check-models gpt-6.1-sol,gpt-6-astra` (lectura GET /v1/models/<id>; sin datos ni gasto) | **PENDIENTE: no hay clave de OpenAI en este entorno** |
| 2 | **El modelo funciona** (llamada real con datos SINTÉTICOS) | `npx tsx scripts/g7/agent-live-eval.ts --models <el primero DISPONIBLE> --reasoning medium` → imprime **PUERTA: APROBADO/NO APROBADO** (sin errores del proveedor, ≥ 90 % de escenarios, ≥ 75 % verificados a la primera, p95 ≤ 25 s) | **PENDIENTE: ídem** |
| 3 | Configuración completa | `npx tsx scripts/g7/agent-live-eval.ts --preflight` con las variables definidas | listo para ejecutar |
| 4 | Producción lista | `supabase/preflight/v2_pre_apply_read_only.sql` (solo lectura) en el Supabase de PlusMedik | **PENDIENTE: este entorno no tiene acceso a ese proyecto** |
| 5 | Reversión lista | el interruptor de la base (§1) y las pruebas de §6 | **verificado en pruebas** |

Las puertas 1 y 2 usan su clave de OpenAI y solo texto inventado. Si crea un archivo `.env` local (ignorado por git) con solo `OPENAI_API_KEY=...`, las ejecuto yo con `npx tsx --env-file=.env ...`; o las corre usted y me pega la salida (no imprime la clave).

## 4. Secuencia de despliegue (no ejecutada)

**Supabase (a mano, tras la puerta 4):** migración **24** `20261112000000_plusmedik_conversation_events.sql` y migración **25** `20261113000000_plusmedik_agent_pilot.sql` (aditivas, reaplicables; la 25 nace con el interruptor apagado), y luego `supabase/preflight/v2_post_apply_read_only.sql`.

**Vercel (Production):**
```
# PLUSMEDIK_CONV_STATE=shadow   <- OPCIONAL y NO se define al empezar: sin la memoria estructurada el agente decide con los mensajes recientes del historial (últimas 24 h)
PLUSMEDIK_AGENT=live
OPENAI_AGENT_MODEL=gpt-6.1-sol          # decisión del dueño; aprobar en las puertas 1 y 2
OPENAI_AGENT_REASONING=medium
PLUSMEDIK_AGENT_DAILY_MAX=6             # decisión del dueño (ver docs/g7/16 §4)
PLUSMEDIK_AGENT_DEADLINE_MS=30000       # opcional
PLUSMEDIK_AGENT_EXCLUDE_PHONES=<opcional>
```
Ya deben existir `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_CONTACT_HMAC_KEY`, `KAPSO_PHONE_NUMBER_ID`, `OPENAI_API_KEY`; conviene `PLUSMEDIK_KNOWLEDGE_ANSWERS=on` y el historial encendido (por omisión lo está). **No** definir `PLUSMEDIK_AGENT_HANDOFF=on`.

**Orden:** (1) migraciones; (2) variables y **despliegue con el interruptor apagado**: debe verse `agent_scope {mode:"live", everyone:true, …}` y `agent_pilot {status:"FALLBACK", reason:"SWITCH_OFF"}`, y los pacientes siguen igual; (3) **autorización final**; (4) `select public.plusmedik_agent_pilot_set(true, 'activación global');`.

## 5. Decisiones pendientes de usted
1. **Autorización final** para aplicar las migraciones, desplegar y encender (después de las puertas 1–4).
2. **Tope diario**: sin `PLUSMEDIK_AGENT_DAILY_MAX` rige el tope global de siempre (5 respuestas por paciente cada 24 h) también para el agente nuevo, y con eso no puede sostener una conversación. Decidido: 6 (solo para el agente nuevo; casi igual al global, ver docs/g7/16 §4). «Mantén las protecciones actuales» lo deja en 5 si no se indica otra cosa.
3. **Modelo**: el que apruebe la puerta 2 (candidatos del repositorio: `gpt-6.1-sol`, `gpt-6-astra`).

## 6. Qué observar las primeras horas (registro de Vercel)
`agent_pilot.status` (`VERIFIED` ≥ 80 % de lo que llega al agente nuevo; `REJECTED` frecuente → leer `violations`), `repairs`, `latencyMs` (p95 < 20 s), `usage` (tokens → costo), `modelError.cause` (`QUOTA_OR_BILLING`, `RATE_LIMIT`, `TIMEOUT`, `AUTH`), `agent_pilot_breaker {open:true}` (el proveedor falla; nadie queda sin respuesta), `conv_state_write_failed` con `PGRST202` (migración 24 sin aplicar). Leer en el historial una muestra de respuestas del agente nuevo (actor AGENT). Al primer síntoma: apagar con el interruptor.

## 7. Verificación crítica hecha (sin repetir la suite completa)
- **Aislamiento y respaldo con PostgreSQL real (webhook + turnos + repositorios reales):** todo paciente recibe la respuesta del agente nuevo una sola vez; un excluido sigue con el anterior; **al apagar el interruptor todos vuelven al anterior en el siguiente mensaje**; en una caída simulada del proveedor ningún paciente se queda sin respuesta (corta-circuito); reentrega ×3 y simultánea → una respuesta; pausa humana; fotos por la ruta de siempre; tope global frente a tope propio; derivación (sin CRM, con CRM, CRM que falla); reanudación manual; privacidad de los registros.
- **Cable real del SDK de OpenAI contra un servidor local:** petición estricta sin estado y sin herramientas, errores reales (429 de cuota y de velocidad, 500, 401, tiempo agotado, salida inválida) con su causa y sin el mensaje del proveedor; lo que viaja no contiene precios ni texto de salud.
- Migración 25 (PostgreSQL real), cadena de 25 migraciones, memoria, límites del código, preflight y puerta de aprobación.
- **No verificado**: ningún modelo real de OpenAI ni el estado real de producción (§3, puertas 1, 2 y 4).

## 8. Límites vigentes
Fotos, documentos y lotes que los incluyan: motor actual (el agente nuevo no lee imágenes; conoce su resultado después por la memoria). Derivación humana: aplazada hasta validar el CRM. Reanudación: manual. Una respuesta ya enviada no se puede retirar.
