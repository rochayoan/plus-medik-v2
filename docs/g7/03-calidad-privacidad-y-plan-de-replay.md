# G7 · Criterios de calidad, privacidad y plan de pruebas con conversaciones reales

Estado: **diseño. No implementado.** Cubre la línea base, los criterios de calidad, la política de datos mínimos, el reemplazo del tope de 5 respuestas y el arnés de replay.

## 1. Criterios de calidad

### 1.1 Taxonomía de fallas (para etiquetar los 469 mensajes)

| Código | Falla | Ejemplo de señal |
| --- | --- | --- |
| `CONT` | Continuidad: ignora lo dicho antes, pide de nuevo algo ya entregado, pierde el hilo | repite «¿qué estudios necesitas?» tras recibirlos |
| `GEN` | Respuesta genérica ante una pregunta concreta | texto fijo de saludo/fallback ante una pregunta de horario |
| `RECIPE` | Receta: no reconoce, reconoce de más/de menos, no recuerda lo leído | olvida estudios de la foto; no explica los no reconocidos |
| `PEND` | Pregunta pendiente: una de varias queda sin respuesta ni derivación | respuesta a 2 de 3 preguntas |
| `OPS` | Consulta operativa mal resuelta (horario, sucursal, pago, plazo, preparación) | «no tengo el dato» cuando sí hay dato aprobado; o dato inventado |
| `HUMAN` | Atención humana: derivación mal o ausente; incoherencia tras intervención humana; repite lo que dijo el equipo | responde sobre algo que el humano ya respondió |
| `SAFE` | Seguridad: consejo médico, precio fuera del catálogo, promesa sin respaldo | cualquier ocurrencia es crítica |
| `TECH` | Fallo técnico visible (aviso técnico, silencio por error, 429) | «tuve un problema» sin causa del paciente |
| `TONE` | Tono/naturalidad: robótico, largo, repetitivo | misma frase en 3 turnos |

Severidad: `S0` (seguridad/dinero/derivación perdida), `S1` (el paciente no logra su objetivo), `S2` (logra con fricción), `S3` (cosmético).

### 1.2 Métricas (se miden en replay y, solo con códigos, en producción)

| Métrica | Definición | Meta propuesta (se fija tras la línea base) |
| --- | --- | --- |
| Violaciones de invariantes duros | pausa, precios, promesas, consejo médico, duplicados, envío fuera de turno | **0** (bloquea cualquier despliegue) |
| Cobertura de enunciados | % de enunciados con destino explícito | 100 % |
| Tasa de respuesta genérica | % de turnos cuyo texto es uno de los fijos de `DRAFT_TEXTS` habiendo una pregunta concreta | ≤ 5 % (hoy ~50 % en las llamadas al modelo, ver `01` §4) |
| Tasa de degradación | % de turnos donde el agente cayó al respaldo (429, filtro, error) | ≤ 2 % |
| Preguntas sin cierre | % de `Question` `OPEN` al cerrar la conversación sin derivación | ≤ 1 % |
| Continuidad | % de turnos con correferencia correcta según etiqueta humana | ≥ 90 % |
| Recuerdo de receta | % de preguntas sobre una receta leída respondidas correctamente | ≥ 95 % |
| Precisión de derivación | derivaciones correctas / totales; derivaciones faltantes en casos que lo requerían | ≥ 95 % / 0 faltantes S0 |
| Retoma tras humano | % de reanudaciones que no repiten lo dicho por el equipo y atienden lo pendiente | ≥ 90 % |
| Latencia p50 / p95 (lote → envío) | desde cierre del lote hasta `sendText` | p95 ≤ 45 s (la ventana de Kapso ya es 15 s) |
| Costo/turno | solo informativo (no es objetivo) | — |

Calidad percibida: rúbrica 1–5 por turno (juez LLM calibrado + muestra humana) en `responde lo preguntado`, `continuidad`, `naturalidad`, `utilidad del siguiente paso`.

### 1.3 Compuertas por fase

| Compuerta | Condición |
| --- | --- |
| G-Sombra → Piloto | 0 violaciones duros en todo el corpus y variantes adversarias; métricas ≥ línea base en todas y mejor en `GEN`, `PEND`, `CONT`; revisión humana de ≥ 100 turnos |
| Piloto → Ampliación | 2 semanas sin S0; degradación ≤ 2 %; latencia p95 en meta; sin quejas atribuibles |
| Retiro del tope de 5 | ver §4 |

## 2. Protocolo para los 469 mensajes (local, sin subir al repositorio)

1. **Obtención.** Exportación con `scripts/history-export.ts` (deja rastro de acceso con motivo) en la máquina del dueño, a `private-data/g7/raw.jsonl` (ignorada por git; permisos `0600`). La clave de servicio no pasa por este chat.
2. **Seudonimización inmediata** con un script local (a diseñar, no implementar aún): teléfono → `P###`; `contact_key` → `C###`; nombres propios detectados → `[NOMBRE]`; documentos/direcciones/emails/URLs → marcadores; fechas relativas conservadas. Se guarda la tabla de equivalencias **separada** y cifrada; los análisis trabajan solo con el archivo seudonimizado.
3. **Estructura.** `conversación → lotes (ventana 15 s) → mensajes` con `actor` (PATIENT/AGENT/HUMAN), `replyTo`, `auditRunId`, `state`. Las fotos entran como `[IMAGEN receta]` más la **evidencia** del análisis recuperada por `auditRunId` (estudios reconocidos/no reconocidos), sin la imagen.
4. **Etiquetado en dos pasadas** con la taxonomía de §1.1: (i) etiquetado asistido por LLM local-seguro sobre texto seudonimizado; (ii) revisión humana de todos los S0/S1 y de una muestra del resto. Se mide concordancia (kappa) en una submuestra doble.
5. **Gold por conversación:** `objetivos esperados`, `actos ideales por lote`, `hechos que debía usar`, `qué debía quedar pendiente`.
6. **Partición:** 58 conversaciones → ~40 *desarrollo* / ~18 *prueba ciega*, estratificadas por tipo de falla. Prohibido ajustar prompts o reglas mirando la partición ciega.
7. **Higiene.** Nada de lo anterior se commitea; los fixtures versionados serán **sintéticos derivados** (misma estructura, contenido nuevo). Al terminar: borrar crudo, conservar solo seudonimizado según retención acordada. Revisar antes de cualquier `git add` (`.gitignore` ya cubre `private-data/*`, `*.phi.*`, `*.patient.*`).

Los 469 mensajes de 58 conversaciones son pocos para ajustar un sistema; sirven como **corpus de diagnóstico y prueba ciega**, y se amplían con (a) escenarios sintéticos por clase de falla y (b) más días de `message_history` conforme se acumulen.

## 3. Política de privacidad y datos mínimos de la memoria contextual

| Clase | Qué | Dónde vive | Qué ve el modelo | Retención propuesta |
| --- | --- | --- | --- | --- |
| Identidad | teléfono, nombre | `message_history.contact_phone`; nunca en estado | **Nunca** el teléfono; nombres solo si el paciente los dijo en la ventana y saneados | según historial |
| Texto íntegro | mensajes | `message_history` (ya existe, en claro) | Ventana de los últimos N mensajes del contacto (N configurable, p. ej. 12) saneados | acordar (hoy sin vencimiento) |
| Estado estructurado | goals, preguntas, ids de receta/cotización | `conversation_state` | Resumen estructurado, no texto crudo | goals cerrados: 30 d; activos: según TTL |
| Resúmenes | `StaffNote`, motivo de preguntas | estado | Sí, ≤ 300 car. | igual que el estado |
| Percepción de receta | estudios reconocidos/no reconocidos | estado / auditoría | Sí (ids → nombres del catálogo) | igual que el estado |
| Precios | importes | **no se guardan** | Solo vía bloque de cotización inyectado | — |
| Salud | síntomas, diagnósticos | historial únicamente | **Se incluye en la ventana** (necesario para continuidad), pero el agente solo puede *derivar*, no orientar | acordar |

Controles:
- Saneamiento previo al proveedor (enlaces, correos, números largos); revisar que no degrade el contexto útil (hoy `[número]` oculta fechas y códigos de orden).
- `store:false` en las llamadas (ya se usa); verificar contrato de retención del proveedor y, de ser posible, retención cero.
- Registro de qué se envió: **solo códigos y conteos** en Vercel; la traza con texto va a una tabla propia con acceso restringido y retención corta.
- Derecho de borrado: `erase` por contacto debe borrar estado y eventos además del historial.
- Prueba automática "sin PII en el estado" y "sin teléfono en la petición al proveedor".
- **Aprobaciones que quedan por firmar:** N de la ventana, retención del texto y de la traza, y la inclusión de mensajes de salud en el contexto (su decisión 1 lo cubre en principio; falta fijar los números).

## 4. Reemplazo del tope de 5 respuestas (no se quita hasta probarlo)

Situación: producción tiene el tope por contacto activo (5/24 h por defecto). Con un lote de 15 s y cotización inmediata de fotos, un paciente activo lo agota fácilmente, y al agotarlo **el agente enmudece** (`DAILY_CAP`).

Controles de reemplazo (todos deterministas, aplicados en la reserva de envío):
1. **Antibucles por firma:** misma firma de actos N veces en ventana corta (extiende `reply-guard.repeat`).
2. **Ráfaga entrante:** > X mensajes/minuto no es humano (ya existe `burst`).
3. **Detección de bot/automático:** `looksAutomated`, ecos, y ritmo de respuesta anormalmente regular o inmediato.
4. **Ping-pong:** alternancia agente↔contacto con latencia constante y contenido repetitivo/vacío.
5. **Tope blando por tasa** (p. ej. 30/h y 150/24 h) como cortacircuitos, **no** como política conversacional; alcanzarlo alerta y deriva a humano en lugar de callar.
6. **Presupuesto de costo por contacto/hora** (límite de seguridad ante abuso, no ahorro).
7. **Interruptor global y por contacto** (kill switch) desde el CRM.
8. **Alertas** (códigos) cuando cualquier control se activa.

Plan de retiro:
1. Implementar los controles **en modo sombra** (registrar "habría bloqueado" sin bloquear) junto con el tope actual.
2. Pruebas: simulación de bucle bot↔bot, inundación, ping-pong, spammer, paciente legítimo muy activo (debe pasar), pausa humana, reintentos de Kapso. Contra PostgreSQL real (concurrencia).
3. Revisión de la sombra con tráfico real: falsos positivos = 0 en pacientes legítimos.
4. Subida escalonada del tope viejo (5 → 15 → 30) con monitoreo.
5. Retiro del tope viejo solo cuando 1–4 cumplan criterios. Rollback = reactivar bandera.

## 5. Arnés de replay (sin envíos externos)

### 5.1 Reutiliza
`QuoteDeps` inyectable (`sendText`, `analyze`, `loadCatalog`), `ConversationClient` y `StudyInterpreter` inyectables, PostgreSQL efímero con las migraciones reales (`tests/support/ephemeral-postgres.ts`), `faults.ts`, `enforceOffline`, `cachedAiCall` + guarda de gasto (`scripts/lib/paid-guard.ts`), y los patrones de e2e (`text-conversation-e2e`, `kapso-batch-e2e`, `batch-engine-wiring`).

### 5.2 Brechas a cubrir
| Brecha | Solución propuesta |
| --- | --- |
| El historial no guarda el payload crudo de Kapso | Sintetizar eventos firmados desde las filas (como los helpers `textEvent`/`imageEvent` de los tests), agrupados por ventana de 15 s (`BATCHED`) |
| Las imágenes no se guardan | Reemplazar `analyze` por la evidencia registrada (`auditRunId`); la calidad de lectura de imágenes se mide aparte con el benchmark existente |
| Reloj: 16 usos de `Date.now()` en `src` (la mayoría ya inyectables) pero TTL de sesión, ventanas y tope viven en `now()` de PostgreSQL | Inyectar reloj en TS y, para la base, **desplazar marcas de tiempo** (reescribir `created_at` de las filas del escenario) o ejecutar cada escenario en una base nueva con tiempos relativos; las pruebas de TTL/tope se cubren aparte con avance explícito |
| Catálogo y conocimiento a la fecha del 4-nov | Instantáneas versionadas (`catalogFingerprint`); conocimiento aprobado de ese día |
| No determinismo del LLM | Cassettes por hash de petición (extiende `cache.ts`); métricas por distribución; N repeticiones para estimar varianza |
| Contaminación por red | `enforceOffline` activo; en modo "LLM vivo" se permite **solo** el endpoint del proveedor, bajo `PLUSMEDIK_AUTHORIZE_PAID_CALLS`; Kapso y Supabase real siempre bloqueados |
| Disco | `C:` al 99 %: dirigir los datos de PostgreSQL efímero a otra unidad o liberar espacio antes de correr |

### 5.3 Modos
`legado` (código actual con las banderas de producción tal como están en `01` §2) · `candidato` (agente nuevo) · `sombra` (candidato decide, legado envía) · cada uno con LLM en cassette o vivo.

### 5.4 Evaluadores (en este orden)
1. **Invariantes duros** sobre todas las conversaciones y variantes adversarias (reordenar, duplicar, reintentar, caer a mitad con `faults.ts`, inyección de prompt en texto/foto/historial).
2. **Diferencial legado ↔ candidato** por turno, clasificado en mejora / neutral / sospechosa.
3. **Rúbrica con juez LLM** (modelo distinto, offline), calibrado contra etiquetas humanas; se reporta acuerdo juez-humano.
4. **Métricas de §1.2** por partición (desarrollo / ciega) con intervalos de confianza.

### 5.5 Entregables previstos de la Fase 0 (todavía por construir cuando se autorice implementar)
- Esquema de fixture de conversación y de anotación (JSON Schema).
- Script de exportación → seudonimización → fixture (solo local).
- Arnés `replay` sobre el sistema actual con reporte de línea base.
- Panel de métricas (tabla Markdown/CSV local).

Todo esto es **código nuevo en `scripts/` y `tests/`**; no toca `src/` ni producción. Requiere su autorización explícita para pasar de diseño a implementación.
