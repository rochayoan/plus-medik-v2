# G7 · Fase 0 — Decisiones aprobadas, auditoría de producción y línea base

Estado: **diseño y auditoría. No se modificó código, no hay commits ni despliegues.** Continúa [`00-diagnostico-y-propuesta-conversacional.md`](00-diagnostico-y-propuesta-conversacional.md).
Fecha de la auditoría: 2026-11-05 (UTC). Despliegue observado: `dpl_8wCT…` (rama `main`, producción).

## 1. Decisiones aprobadas y su traducción técnica

| # | Decisión del dueño | Consecuencia de diseño | Documento |
| --- | --- | --- | --- |
| 1 | Memoria contextual con privacidad y datos minimizados | Política de datos por clase (§3 de `03`); el estado guarda ids, códigos y resúmenes cortos, nunca precios ni texto íntegro | `02`, `03` |
| 2 | Reemplazar el límite de 5 respuestas por controles contra bucles y abusos, **sin quitarlo hasta probar el reemplazo** | Reemplazo en sombra primero, pruebas de bucle/ráfaga/inundación, retiro escalonado (§4 de `03`) | `03` |
| 3 | Varios mensajes por lote cuando sea necesario | `Produced` pasa a admitir partes ordenadas bajo una sola reserva de envío (Fase 5; sin tocar aún) | `00` §8 |
| 4 | Reanudación humana manual al inicio | Se mantiene `resume` del CRM; el turno de reanudación (Fase 5) se dispara por ese evento | `02` §8 |
| 5 | Auditar banderas de producción sin exponer secretos | Hecho en lo posible (§2). Quedan banderas sin confirmar por falta de acceso a las variables | este doc |
| 6 | Analizar localmente los 469 mensajes sin subirlos al repositorio | Protocolo local de exportación, seudonimización y etiquetado (`03` §2). **Bloqueado hasta recibir el archivo** (§5) | `03` |
| + | **Gestor de objetivos conversacionales** | Módulo de primer nivel del Estado de Conversación | `02` |

## 2. Auditoría de banderas de producción (sin secretos)

**Método.** La API de variables de Vercel respondió `403` y no hay CLI de Vercel instalada, así que **no leí ninguna variable ni valor**. Lo inferí de los registros de arranque y de eventos del webhook (`agent_scope`, `llm_conversation_source`, `history_scope`, `audio_scope`, `text_turn`, `batch_plan`, `llm_conversation`), que solo llevan códigos y contadores. Esos registros no contienen texto de pacientes, claves ni tokens.

| Capacidad | Estado | Evidencia | Confianza |
| --- | --- | --- | --- |
| Turnos (`PLUSMEDIK_TURNS`) | **ON** | `agent_scope.turns=true` | Confirmada |
| Manejador de texto | **ON** | `textHandler=true` | Confirmada |
| Puerta del piloto | **OFF → todos los contactos** | `pilotGate=false`, `allContactsOnTurns=true` | Confirmada |
| `ALLOWED_PHONES` | Sin restricción | `allowedPhonesRestricted=false` | Confirmada |
| Control humano (`PLUSMEDIK_HUMAN_CONTROL`) | **ON** | `humanControl=true` | Confirmada |
| Tope diario de respuestas | **ON** (5/24 h por defecto; el valor exacto no se ve) | `dailyCap=true` | Confirmada |
| Fotos con cotización inmediata | **ON** | `instantPhotoQuotes=true` | Confirmada |
| Motor de lotes | **`on`** (no sombra) | `batchEngine:"on"`; eventos `batch_plan` | Confirmada |
| Conversación con LLM | **ON** | `llm_conversation_source` en cada arranque | Confirmada |
| Modelo conversacional | **`gpt-4.1-mini`, sin razonamiento** (`reasoningTokens:0`) | campo `model` de `llm_conversation` | Confirmada |
| Datos de negocio al modelo | **ON** (`NEGOCIO`, `HORARIOS`, `SERVICIOS`; 3 de 7 secciones confirmadas) | `prompt:"…+datos+silencio"`, `facts` | Confirmada |
| Silencio ante lo ajeno | **ON** | sufijo `+silencio` | Confirmada |
| Guarda antibucles (reply guard) | **ON (inferido)** | la conversación con LLM la exige para encenderse | Alta |
| Historial de mensajes | **ON, en claro** (sin cifrar) | `history_scope {enabled:true, encrypted:false}` | Confirmada |
| Audios | **ON** | `audio_scope {enabled:true}` | Confirmada |
| Conocimiento aprobado (`KNOWLEDGE_ANSWERS`) | **ON (inferido)** | `text_turn` trae el campo `knowledge:"unavailable"` | Alta |
| **Derivación al CRM (`CRM_HANDOFF`)** | **OFF / incompleta** | `text_turn … "handoff":"blocked"` | Confirmada |
| **Memoria conversacional** | **OFF** | sin eventos `conversation_memory` en 24 h | Alta |
| Atención selectiva | **OFF (inferido)** | un «hola» aislado llegó al modelo; con el filtro ON se ignora | Media-alta |
| Preparaciones / datos por estudio / intérprete de estudios | **No confirmado** | `batch_plan.model` muestra `USED`/`FAILED`, lo que indica que el intérprete LLM sí está activo | Parcial |
| Configuraciones inválidas | **Ninguna** | sin eventos `*config_invalid` en 24 h | Alta |

**Pendiente (requiere acceso):** `PLUSMEDIK_STUDY_INFO`, `QUOTE_PREPARATIONS`, `QUOTE_STUDY_DETAILS`, `VISION_DIAGNOSTICS`, valores exactos del tope y del reply guard. Propuesta: que usted ejecute `vercel env ls` (solo nombres y entornos, sin `--json` ni valores) y me pegue la lista, o que habilite el permiso de lectura de variables para la herramienta (no hace falta descifrar nada).

## 3. Hallazgos nuevos de la auditoría (cambian prioridades)

1. **La derivación a una persona está bloqueada en producción.** Todo mensaje clasificado como médico, de pedir persona o de información sin respuesta recibe el texto fijo «*no puedo derivarlo a una persona desde este chat*». Es un hallazgo de alto impacto para «atención humana» y precondición del estado `HANDED_OFF` del gestor de objetivos. **No lo cambié.** Decidir activar `PLUSMEDIK_CRM_HANDOFF` (y su configuración completa) es una decisión de despliegue suya, independiente de este plan.
2. **El modelo conversacional es `gpt-4.1-mini` sin razonamiento**, con ~2 400 tokens de entrada por llamada (casi todo prompt + datos) y ~30 de salida. La inteligencia que se pide no es alcanzable con ese modelo en el rol actual. Elegir/evaluar el modelo del agente será parte de la Fase 3 con el arnés de replay (el costo no es restricción).
3. **Una parte muy grande de las llamadas al modelo termina en texto fijo genérico** (ver §4). Dos causas distintas y medibles: límite de tasa del proveedor (HTTP 429) y el filtro léxico de salida.
4. **El motor de lotes está en `on` y casi todo lo que ve cae en `PROMPT`/`NONE`** (mensajes sin estudios), es decir, el camino genérico/delegado. La parte "inteligente" del motor (cotizar con estudios) se ejercita poco en esta muestra.
5. **Fotos con error técnico:** 3 lotes de 1 mensaje con aviso `TECHNICAL_ERROR` + `BLOCKED_UNREADABLE` en el día (12:45, 14:48 y 15:20 UTC). Requiere revisión aparte (fuera del alcance conversacional, pero afecta "recetas").
6. **Dependencia de `Date.now` / reloj de la base:** el código tiene solo 16 usos directos (la mayoría ya inyectables), pero los TTL de sesión, las ventanas y el tope diario viven en `now()` de PostgreSQL; relevante para el replay (`03` §5).

## 4. Línea base preliminar (telemetría real, sin contenido)

> **Cautela.** Es una muestra parcial: las consultas a los registros tienen límite de filas y de tiempo. Sirve para orientar, **no** como línea base final; la oficial saldrá de la reproducción de los 469 mensajes.

Llamadas al modelo conversacional (28 eventos, 2026-11-04 16:00 → 11-05 02:57 UTC, `gpt-4.1-mini`):

| Resultado | N | % | Qué significa para el paciente |
| --- | --- | --- | --- |
| `REPLY` (respuesta del modelo enviada) | 11 | 39 % | Respuesta natural |
| `FALLBACK · RATE_LIMITED` (429 del proveedor) | 9 | 32 % | Texto fijo genérico. Todas entre 16:00 y 18:02 UTC; tardan 4–7 s |
| `FALLBACK · GUARD_REJECTED` | 5 | 18 % | Texto fijo: `TIME_OR_PROMISE` ×2, `UNGROUNDED` ×2, `DIGITS_OR_CURRENCY` ×1 |
| `REROUTE` (el modelo manda a la vía determinista) | 3 | 11 % | Va a conocimiento/derivación; en estas 3 acabó en «no puedo derivar» |

Lectura: **~50 % de las consultas al modelo termina en un texto fijo** (429 + filtro), sin que el paciente sepa por qué. Los 429 sugieren un problema de cuota/límite con el proveedor o un pico (el circuito del modelo se abre tras 3 fallos y mantiene 60 s de texto fijo). Es un hallazgo operativo con arreglo barato (reintento con espera, segundo modelo/proyecto de respaldo) pero **no lo apliqué**; lo someto a su decisión.

Lotes del motor (20 eventos `batch_plan`): `PROMPT` 11, `NONE` 6, `CLARIFY` 4; **0 con estudios identificados**; `intentSource` = `LEXICON` en 8, `NONE` en 9, `MODEL` en 2; el intérprete falló (`model:"FAILED"`) en 2.

Mensajes de texto clasificados (`text_turn`, 12 eventos): `INFO_REQUEST` 3 (los 3 con `handoff:"blocked"` y `knowledge:"unavailable"`), `OTHER` 6, `RECIPE_OR_QUOTE` 2, `GREETING` 1.

## 5. Qué necesito para cerrar la Fase 0

1. **El archivo con los 469 mensajes, o credenciales locales controladas.** Esta máquina no tiene `.env` ni acceso a la clave de servicio, y no voy a pedirle ni usar secretos por este chat. Dos opciones seguras:
   - (a) Usted ejecuta `scripts/history-export.ts` en su equipo (necesita sus propias variables) con `--from 2026-11-04 --to 2026-11-05 --reason "..." --out private-data/g7/raw.jsonl` y me indica la ruta. `private-data/` ya está en `.gitignore`.
   - (b) Usted me indica un archivo ya exportado. Lo leeré solo en local, lo seudonimizaré y no saldrá de `private-data/`.
2. **Lista de nombres de variables** (`vercel env ls`) para cerrar el §2.
3. **Espacio en disco:** `C:` está al 99 % (3,2 GB libres). El arnés con PostgreSQL efímero ya falla con `ENOSPC` en esas condiciones; hay que liberar espacio o fijar otra unidad para los datos del arnés.
4. Decisiones operativas pendientes (no bloquean el diseño): (i) ¿activar `CRM_HANDOFF`?; (ii) ¿atender los 429 del proveedor ya, como mejora operativa separada?
