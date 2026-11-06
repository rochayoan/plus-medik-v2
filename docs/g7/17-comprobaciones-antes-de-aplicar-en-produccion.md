> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 5c — comprobaciones antes de aplicar cambios en producción

Decisiones vigentes: `gpt-6.1-sol` (razonamiento medio) · 100 % de los contactos elegibles, sin rollout · tope diario del agente nuevo 6 · memoria, herramientas, protecciones y agente anterior como respaldo · **el agente NO se enciende para pacientes** hasta autorización expresa.
Estado: **nada se ha aplicado en Supabase ni en Vercel, nada desplegado, el interruptor del agente no existe aún (= apagado).**

## 0. Dónde estamos (honesto)
| Requisito | Estado |
|---|---|
| Cuenta con acceso a `gpt-6.1-sol` y el modelo funciona | **PENDIENTE: no hay clave de OpenAI en este entorno** (§1) |
| Migraciones 24 y 25 listas, con respaldo y verificación previa | **listas y probadas contra PostgreSQL real; respaldo y verificación previa son pasos suyos en el Supabase de PlusMedik** (§2) |
| Variables de Vercel preparadas, interruptor apagado | **preparadas** (§3); no puedo listar ni definir variables desde aquí |
| Reversión inmediata y agente anterior como respaldo | **verificado en pruebas** (§4) |
| Pruebas con PostgreSQL tras el último cambio (se quitó el tapado de datos) | ver §5 |

## 1. Verificar la cuenta y el modelo (necesita su clave)
```powershell
cd C:\Users\yoanm\Proyectos-Smarky\plus-medik-v2-g2
powershell -ExecutionPolicy Bypass -File scripts\g7\setup-openai-key.ps1     # la clave se pide sin mostrarla y queda solo en .env (ignorado por git)
npx tsx --env-file=.env scripts/g7/agent-live-eval.ts --check-models gpt-6.1-sol
npx tsx --env-file=.env scripts/g7/agent-live-eval.ts --models gpt-6.1-sol --reasoning medium
```
Debe imprimir `DISPONIBLE gpt-6.1-sol` y `PUERTA: APROBADO`. Solo viaja texto sintético. Si no, el agente no se enciende.

## 2. Supabase: respaldo, verificación previa, aplicación y comprobación
**Respaldo (antes de tocar nada):**
1. En el panel de Supabase del proyecto de PlusMedik: *Database → Backups* — confirme que existe una copia automática reciente (o PITR activo) y anote su fecha.
2. Copia manual del esquema (las migraciones solo AGREGAN objetos, no modifican datos existentes; con el esquema alcanza para reconstruir). Con la cadena de conexión del panel (*Project Settings → Database*) en una variable de entorno (nunca en el chat):
   ```powershell
   $env:PG_URL = "<cadena de conexión>"      # no la pegue en ningún archivo del proyecto
   pg_dump --schema-only --no-owner --file="private-data\respaldo-esquema-antes-de-24-25.sql" $env:PG_URL
   Remove-Item Env:PG_URL
   ```
   `private-data\` está ignorado por git. Hace falta espacio libre en disco.

**Verificar que aplica los archivos probados** (sha256 con saltos de línea LF; deben coincidir):
```powershell
foreach ($f in "20261112000000_plusmedik_conversation_events.sql","20261113000000_plusmedik_agent_pilot.sql") { $t=[IO.File]::ReadAllText("supabase\migrations\$f").Replace("`r`n","`n"); "$f " + [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t))).Replace("-","").ToLower() }
```
- 24 → `78b1b697b54b04e7bd41dd91c63755d64c8c96727b874b8b219f0b5e56b74bf9`
- 25 → `192775dc58fd553b9351ea494f60e7bd1c91d3330e2d865a7fce4e2f9ea51201`

**Verificación previa (solo lectura):** `supabase/preflight/v2_pre_apply_read_only.sql` en el editor SQL. Debe dar veredicto OK con **23 aplicadas y 24–25 pendientes**, sin bloqueos. Si hay un bloqueo o falta una de las 23, **no continuar** y avisarme.

**Aplicar, en este orden y una sola vez cada una** (editor SQL, pegando el contenido del archivo): 24, luego 25.

**Verificación posterior:** `supabase/preflight/v2_post_apply_read_only.sql` → OK con las 25. Y dos comprobaciones rápidas:
```sql
select public.plusmedik_agent_pilot_state();                          -- debe devolver {"enabled": false, ...}  (apagado)
select public.plusmedik_conv_contacts_since(now() - interval '1 day', 1);   -- debe devolver {"contacts": []}
```
**No** ejecutar `plusmedik_agent_pilot_set(true, …)`: eso es el encendido y requiere su autorización.

## 3. Vercel: variables con el interruptor apagado (sin encender)
Proyecto `plus-medik-v2`, entorno **Production**. Las variables solo surten efecto con el siguiente despliegue; aunque queden definidas y desplegadas, **el agente nuevo no responde a nadie mientras el interruptor de la base siga apagado** (cada lote deja `agent_pilot {FALLBACK, SWITCH_OFF}` y responde el agente de siempre).
```powershell
# (PLUSMEDIK_CONV_STATE es opcional: no se define al empezar; el agente usa los últimos mensajes del historial, 24 h. La migración 24 se aplica igual, queda sin uso)
"live"        | vercel env add PLUSMEDIK_AGENT             production
"gpt-6.1-sol" | vercel env add OPENAI_AGENT_MODEL          production
"medium"      | vercel env add OPENAI_AGENT_REASONING      production
"6"           | vercel env add PLUSMEDIK_AGENT_DAILY_MAX   production
```
Opcionales: `PLUSMEDIK_AGENT_DEADLINE_MS=30000`, `PLUSMEDIK_AGENT_EXCLUDE_PHONES=<números de control>`. **No** definir `PLUSMEDIK_AGENT_HANDOFF`. Comprobar con `vercel env ls production` que existen `OPENAI_API_KEY`, `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_CONTACT_HMAC_KEY`, `KAPSO_PHONE_NUMBER_ID` (y conviene `PLUSMEDIK_KNOWLEDGE_ANSWERS=on`).
Orden seguro: **migraciones (§2) → variables → despliegue**. Si se desplegara con `PLUSMEDIK_AGENT=live` **sin** la migración 25, el interruptor no se puede leer y el agente nuevo queda apagado (falla cerrado): no hay daño, solo `agent_pilot_switch {unreadable:true}` en el registro.
Tras el despliegue debe verse `agent_scope {mode:"live", everyone:true, …}` al arrancar. Los pacientes deben seguir recibiendo exactamente lo de siempre.

Nota sobre el tope: 6 es casi lo mismo que el 5 global; al alcanzarlo el paciente deja de recibir respuestas automáticas ese día (sin aviso).

## 4. Reversión (lista y probada)
1. `select public.plusmedik_agent_pilot_set(false, 'motivo');` → en ≤ 5 s todos al agente anterior, sin redesplegar.
2. Quitar `PLUSMEDIK_AGENT` y redesplegar.
3. Las migraciones son aditivas: no hace falta revertirlas. El respaldo del esquema (§2) cubre cualquier imprevisto.
Respaldo automático: ante modelo caído/lento, salida inválida, verificación fallida, foto en el lote, persona al mando o corta-circuito abierto, responde el agente anterior.

## 5. Verificación hecha (sin repetir la suite completa)
- **Sin base de datos:** adaptador, cable real del SDK contra un servidor local, núcleo, piloto y alcance global, escenarios y límites del código: verdes; `tsc` limpio.
- **Con PostgreSQL real:** piloto y alcance global (28 escenarios), memoria, migración 25 y cadena de 25 migraciones: verdes (los escenarios se repitieron tras quitar el tapado de datos; ver el informe de la sesión).
- Nota: ya no se tapan datos personales ni se retienen mensajes de salud (decisión del dueño, 6-nov).

## 6. Qué falta antes de pedirle la autorización final
1. **Usted:** liberar espacio en C: (≥ 2 GB) y que yo repita los escenarios con PostgreSQL.
2. **Usted:** crear el `.env` con la clave (§1) → verifico disponibilidad y funcionamiento de `gpt-6.1-sol` (**PUERTA: APROBADO**).
3. **Usted (o yo con acceso):** respaldo y verificación previa en el Supabase de PlusMedik (§2) y comprobar variables existentes en Vercel (§3).
4. **Autorización expresa** para (a) aplicar las migraciones 24 y 25, (b) definir las variables y desplegar con el interruptor apagado, y, **aparte**, (c) el encendido.
