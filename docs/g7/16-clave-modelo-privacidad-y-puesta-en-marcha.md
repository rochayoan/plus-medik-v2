> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 5b — clave de OpenAI, verificación del modelo y Vercel

Decisiones confirmadas: modelo `gpt-6.1-sol` con razonamiento medio · alcance 100 % de los contactos elegibles, sin rollout · tope diario del agente nuevo: **6 respuestas** · memoria, herramientas, protecciones y agente anterior como respaldo.
Estado: **nada desplegado, nada activado, Supabase sin modificar.** Este documento enumera lo que falta y no se ejecuta nada sin su autorización.

## 1. Configurar la clave de OpenAI LOCAL de forma segura (usted, 2 minutos)

La clave **no se pega en el chat**. Se guarda solo en `.env` (ya ignorado por git) con un script que la pide sin mostrarla:

```powershell
cd C:\Users\yoanm\Proyectos-Smarky\plus-medik-v2-g2
powershell -ExecutionPolicy Bypass -File scripts\g7\setup-openai-key.ps1
```
El script: (1) se niega a seguir si `.env` no está ignorado por git; (2) pide la clave sin mostrarla (no queda en el historial de PowerShell); (3) escribe solo `OPENAI_API_KEY=` en `.env` y lo deja legible únicamente por su usuario de Windows; (4) nunca imprime la clave.
Recomendación: use una clave **de proyecto** (no la de la cuenta principal) con límite de gasto, y revóquela o rótela al terminar si el equipo es compartido. Para borrarla: `Remove-Item .env`.

## 2. Verificar el modelo con datos sintéticos (yo, o usted)

Cuando exista el `.env`, avíseme y ejecuto (o ejecútelo usted; no imprime la clave):

```powershell
# 1) ¿Está gpt-6.1-sol disponible en SU cuenta? (lectura GET /v1/models/<id>: sin datos ni gasto)
npx tsx --env-file=.env scripts/g7/agent-live-eval.ts --check-models gpt-6.1-sol
# 2) Llamada real con los 17 escenarios SINTÉTICOS (frases y catálogo inventados; ningún dato de pacientes)
npx tsx --env-file=.env scripts/g7/agent-live-eval.ts --models gpt-6.1-sol --reasoning medium
```
Resultado esperado: `DISPONIBLE gpt-6.1-sol` y `PUERTA: APROBADO` (sin errores del proveedor, ≥ 90 % de escenarios cumplidos, ≥ 75 % verificados a la primera, p95 ≤ 25 s). Guarda el detalle en `private-data/g7/agent-live/` (ignorado por git). Si no está disponible o no pasa, **no se enciende** y se decide el siguiente paso (otro modelo, ajustar instrucciones).

## 3. Migraciones 24 y 25 (listas; NO aplicadas)

Aditivas, reaplicables, sin siembra de datos, en este orden y **a mano** en el Supabase de PlusMedik (proyecto de la verificación `supabase/preflight/…`). Verifique que el archivo que aplica es el probado comparando su sha256 (texto con saltos de línea LF):

| # | Archivo | sha256 |
|---|---|---|
| 24 | `supabase/migrations/20261112000000_plusmedik_conversation_events.sql` | `78b1b697b54b04e7bd41dd91c63755d64c8c96727b874b8b219f0b5e56b74bf9` |
| 25 | `supabase/migrations/20261113000000_plusmedik_agent_pilot.sql` | `192775dc58fd553b9351ea494f60e7bd1c91d3330e2d865a7fce4e2f9ea51201` |

1. **Antes**: ejecutar `supabase/preflight/v2_pre_apply_read_only.sql` (solo lectura; debe dar «23 aplicadas, 24 y 25 pendientes» y sin bloqueos).
2. Aplicar la 24 y luego la 25 (editor SQL de Supabase).
3. **Después**: `supabase/preflight/v2_post_apply_read_only.sql` (debe dar OK con las 25).
4. El interruptor queda **apagado** (sin fila = apagado). Se enciende solo en el paso final con `select public.plusmedik_agent_pilot_set(true, 'activación global');` y se apaga con `(false, 'motivo')`.

Desde este entorno **no tengo acceso** al Supabase de PlusMedik (la conexión disponible solo ve otros dos proyectos), por eso no puedo ni verificar ni aplicar; lo haría con su autorización si me da acceso, o lo ejecuta usted.

## 4. Configuración de Vercel (lista; NO aplicada)

Proyecto `plus-medik-v2`. Las variables solo surten efecto con el **siguiente despliegue**. Desde la carpeta del proyecto (con `vercel link` hecho), cada valor entra por stdin (no queda en el historial):

```powershell
# (PLUSMEDIK_CONV_STATE es opcional: no se define al empezar; el agente usa los últimos mensajes del historial, 24 h. La migración 24 se aplica igual, queda sin uso)
"live"        | vercel env add PLUSMEDIK_AGENT             production
"gpt-6.1-sol" | vercel env add OPENAI_AGENT_MODEL          production
"medium"      | vercel env add OPENAI_AGENT_REASONING      production
"6"           | vercel env add PLUSMEDIK_AGENT_DAILY_MAX   production
```
Opcionales: `PLUSMEDIK_AGENT_DEADLINE_MS=30000` (plazo antes de responder el agente de siempre) y `PLUSMEDIK_AGENT_EXCLUDE_PHONES=<números de control>`. **No** definir `PLUSMEDIK_AGENT_HANDOFF` (la derivación al CRM sigue sin validar).
Comprobar que ya existen (`vercel env ls production`): `OPENAI_API_KEY`, `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_CONTACT_HMAC_KEY`, `KAPSO_PHONE_NUMBER_ID`; conviene `PLUSMEDIK_KNOWLEDGE_ANSWERS=on`. Desde aquí no puedo listarlas (la integración de Vercel devuelve 403 y no hay CLI).
Verificación previa de esta configuración (probada en simulación, sin llamar a nadie): `--preflight` → todo OK salvo el recordatorio de aplicar la migración 25 y que el interruptor nace apagado.

**Sobre el tope de 6**: el tope global de siempre es 5 por paciente cada 24 h; 6 casi no cambia nada. Cuando un paciente alcanza el tope, **no recibe más respuestas automáticas ese día** (se retiene el envío; no hay aviso). Si lo que busca es sostener conversaciones, 40 sería lo coherente; lo dejo en 6 porque es lo que confirmó.

## 5. Qué se envía al modelo

Qué se envía a OpenAI: el texto de los mensajes de los pacientes **tal cual lo escriben** (decisión del dueño, 6-nov: no se tapan datos personales ni se retienen mensajes de salud). No viajan la clave, el teléfono de la conversación ni los ids de la plataforma; `store:false`; los registros de Vercel llevan solo códigos y contadores (nunca el texto). La regla de que el agente **no da consejos médicos** (solo aplaza o deriva) sigue vigente: es una regla de seguridad del agente, no de privacidad.

## 6. Qué falta exactamente (y quién)

| Falta | Quién | Para qué |
|---|---|---|
| Crear `.env` con la clave (§1) | usted | verificar el modelo |
| `--check-models` y la corrida sintética con **PUERTA: APROBADO** (§2) | yo (con el `.env`) o usted | confirmar que `gpt-6.1-sol` está en su cuenta y funciona |
| Verificación previa en el Supabase de PlusMedik (§3.1) y comprobar variables existentes de Vercel (§4) | usted, o yo si me da acceso | confirmar que producción está lista |
| **Autorización final** para: aplicar migraciones 24 y 25, definir variables, desplegar con el interruptor apagado y encender | **usted** | ejecutar |

Orden de ejecución tras su autorización: migraciones → variables → despliegue (interruptor apagado; los pacientes no notan nada) → comprobar `agent_scope {mode:"live", everyone:true}` y `agent_pilot {FALLBACK, SWITCH_OFF}` → encender → vigilar los registros (`docs/g7/15` §6) → apagar al primer síntoma.
