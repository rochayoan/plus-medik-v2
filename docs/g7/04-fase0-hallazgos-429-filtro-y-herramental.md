# G7 · Fase 0 (continuación) — Errores 429, filtro de salida y herramental de evaluación

Estado: **investigación y herramientas locales. No se modificó `src/`, no hay commits ni despliegues, no se envió ningún mensaje real y no se llamó a ningún modelo.**
Fuentes: código del repositorio, registros de producción de Vercel (solo códigos y contadores; no se leyó ninguna variable ni secreto) y pruebas locales deterministas.

## 1. Estado del corpus de 469 mensajes

**El archivo no está en `private-data/g7/`.** Busqué en esa carpeta de este worktree, en `private-data/` de los siete worktrees de PlusMedik y en `Descargas`, `Escritorio` y `Documentos` (archivos `.jsonl`, `.csv`, `.json`, `.xlsx`, `.txt` posteriores al 3-nov). No encontré ninguna exportación. Por eso **no pude verificar la cifra de 469, ni seudonimizar ni medir la línea base real.** No inventé datos: todo lo medido sobre texto de pacientes en este documento es sintético o proviene de telemetría sin contenido.

Las herramientas para hacerlo ya están listas y probadas (§4). Cuando el archivo esté en su sitio basta con:

```
npx tsx scripts/g7/prepare-corpus.ts --expected 469     # verifica + seudonimiza
npx tsx scripts/g7/corpus-baseline.ts                   # línea base real (solo contadores)
```

## 2. Errores 429 (límite de tasa del proveedor)

### 2.1 Qué se observa en producción (2026-11-04, UTC)

| Hecho | Detalle |
| --- | --- |
| Inicio | primer `RATE_LIMITED` a las **13:17**; ninguno entre el 3-nov 00:00 y esa hora |
| Fin | último a las **18:02** (≈ 09:17 → 14:02 en Bolivia); ninguno después hasta el cierre de la muestra (5-nov 03:00) |
| Volumen | 16 eventos visibles en esa franja |
| Éxitos del modelo en la franja | **ninguno visible**: antes de las 13:17 y después de las 18:02 el modelo responde con normalidad (`REPLY`, ~1 s) |
| Latencia del 429 | 4,7 – 6,8 s (los éxitos tardan ~1 s) |
| Otros fallos simultáneos que usan OpenAI | el **intérprete de estudios** falló en el mismo request que un 429 (15:56); y **fotos con `AI_PROCESSING_FAILED`** a las 12:45, 14:48, 14:52, 15:00, 15:20 y 17:21 |
| Alcance | todas las categorías (`GREETING`, `OTHER`, `INFO_REQUEST`) y múltiples contactos |

### 2.2 Lectura

Varios componentes distintos que comparten la misma cuenta de OpenAI (conversación, intérprete de estudios y visión/lectura de recetas) fallaron **a la vez y durante ~5 horas, sin éxitos intermedios**. Eso apunta a una causa **a nivel de cuenta o proyecto**, no a un defecto del código conversacional ni a un pico de uso puntual.

| Hipótesis | A favor | En contra | Cómo confirmarla |
| --- | --- | --- | --- |
| **H1. Cuota/saldo agotado o tope de gasto alcanzado** (`insufficient_quota`, que OpenAI devuelve como HTTP 429) | fallo total y sostenido; afecta a todos los componentes; termina de golpe (recarga o reinicio del tope) | no se puede verificar desde el repo | Panel de OpenAI → *Billing/Usage* y *Limits* del proyecto, 13:00–18:30 UTC |
| **H2. Saturación de TPM/RPM por ráfagas de análisis de recetas** (los lectores y el catálogo con razonamiento alto consumen muchos tokens) | misma clave compartida entre lectura de recetas y conversación | el fallo fue *total*, no intermitente; las llamadas de conversación son pequeñas (~2 400 tokens) | Panel → *Usage* por modelo/hora; correlacionar picos de recetas con los 429 |
| **H3. Incidente del proveedor** | explicaría la simultaneidad | duración inusual; todo el resto normal | Página de estado de OpenAI para esa fecha |

La más probable es **H1**, seguida de H2. **No puedo distinguirlas con lo que el sistema registra**, porque el código solo examina `error.status === 429`.

### 2.3 Qué hace el código ante un 429 (verificado)

- `src/conversation-openai.ts`: cliente con `maxRetries: 0` y plazo de 8 s; **sin reintento ni espera**.
- `src/conversation-model.ts`: cualquier 429 se etiqueta `RATE_LIMITED` sin leer el cuerpo ni las cabeceras (`code`, `type`, `retry-after`, `x-ratelimit-*`), de modo que `insufficient_quota` y `rate_limit_exceeded` **son indistinguibles en los registros**.
- Tras 3 fallos seguidos el circuito se abre 60 s *por instancia* (otra instancia puede seguir intentando).
- El resultado es siempre el **texto fijo** del camino determinista (`DRAFT_TEXTS`), que el paciente percibe como respuesta genérica. No hay modelo de respaldo ni segunda clave.
- Todos los usos de OpenAI comparten `OPENAI_API_KEY`: lectores de recetas, juez, catálogo semántico, transcripción de audio, intérprete de estudios y conversación. Un problema de cuota los detiene a todos a la vez.

### 2.4 Impacto

Durante la franja, **todo mensaje que dependía del modelo recibió un texto fijo**, y las recetas fotografiadas pudieron fallar con aviso técnico. Es un riesgo de **disponibilidad** independiente de la arquitectura nueva, pero que la nueva arquitectura agrava si no se atiende (un agente que razona depende más del proveedor).

### 2.5 Recomendaciones (no aplicadas; requieren su decisión)

1. **Ya (operativo, sin código):** revisar en el panel de OpenAI el saldo/tope y los límites del proyecto en esa franja; activar recarga automática y alertas de gasto y de límite.
2. **Aislar proyectos/claves** por función (conversación, visión, audio) para que la falla de una no detenga a las demás.
3. **Registrar la causa** del 429 con solo códigos (`code`, `type`, presencia de `retry-after`, `remaining` de las cabeceras) para distinguir cuota de tasa.
4. **Reintento con espera acotada** y **modelo/proyecto de respaldo** dentro del presupuesto de tiempo del turno.
5. **Degradación contextual:** ante fallo del modelo, responder con lo que los actos validados permiten, no con un texto genérico (ya previsto en el diseño del agente).
6. **Alerta** cuando la tasa de `FALLBACK` supere un umbral en ventana corta.

## 3. Filtro que descarta respuestas del modelo

### 3.1 Qué se observa en producción
Seis rechazos visibles de `GUARD_REJECTED` entre las 11:00 y las 02:57: `TIME_OR_PROMISE` ×2, `UNGROUNDED` ×2, `DIGITS_OR_CURRENCY` ×1, `HUMAN_PROMISE` ×1. Cada uno termina en un texto fijo. Con la muestra parcial (28 llamadas) equivale a ~18 % de las llamadas, y sumado a los 429, cerca de la mitad de las consultas al modelo no llega al paciente (ver `01` §4).

### 3.2 Medición con el código real (`scripts/g7/guard-audit.ts`)
Se ejecutó `guardModelReply` con los datos de negocio vigentes (`NEGOCIO`, `HORARIOS`, `SERVICIOS`) contra una batería escrita a mano (sesgo posible; se medirá con respuestas reales en el replay).

**39 respuestas razonables → 8 rechazadas (20,5 %):**

| Respuesta rechazada | Razón | Causa |
| --- | --- | --- |
| «¿Qué necesitas **hoy**?», «¿…el día de **hoy**?» | `TIME_OR_PROMISE` | «hoy» está prohibido; solo se exime una fórmula concreta («ayudarte hoy») |
| «¡Hasta **pronto**!» | `TIME_OR_PROMISE` | «pronto» prohibido aunque sea una despedida |
| «Con gusto, **siempre** estamos para ayudarte» | `TIME_OR_PROMISE` | «siempre» prohibido |
| «los estudios que te pidió tu **médico**» | `MEDICAL` | la palabra «médico» basta |
| «ofrecemos … **diagnóstico** molecular» | `MEDICAL` | **repite el dato aprobado del propio laboratorio** (`SERVICIOS`) |
| «**Enseguida** reviso **tu solicitud**» | `HUMAN_PROMISE` | «tu solicitud» se trata como promesa de persona |
| «esa información la revisa **el equipo**» | `HUMAN_PROMISE` | «el equipo» |

**14 respuestas que deben rechazarse → 2 aceptadas (falsos negativos, más graves):**

| Respuesta aceptada | Por qué pasó |
| --- | --- |
| «Tus resultados estarán listos en **24 horas**» | «24» y «horas» existen en `HORARIOS` («24 horas, todos los días») y «resultados» en `SERVICIOS`: el filtro valida **palabras y cifras sueltas, no la afirmación**. Es un plazo de entrega inventado |
| «Estamos en la **calle Libertad**, cerca del mercado» | una dirección inventada sin cifras ni palabras vigiladas |

### 3.3 Diagnóstico
El filtro tiene **dos fallos opuestos a la vez**: bloquea lenguaje cotidiano (porque es léxico) y deja pasar afirmaciones falsas que reutilicen palabras presentes en los datos (porque no entiende qué se afirma). Además **contradice a los datos aprobados** (rechaza repetir «diagnóstico molecular»). Esto confirma la decisión de sustituirlo por un **verificador por procedencia**: cada afirmación verificable (cifra, hora, plazo, dirección, enlace, teléfono, precio, promesa) debe corresponder a un hecho devuelto por una herramienta *en ese turno*; el lenguaje cotidiano no se prohíbe.

> **Riesgo a corto plazo (decisión suya):** los dos falsos negativos son hoy alcanzables en producción solo si el modelo los generara contra las instrucciones del prompt. No cambié nada. Una mitigación mínima y barata (añadir «listo/listos/entrega/domicilio/calle/avenida/zona» a los patrones) sería un parche léxico más; mi recomendación es no parchear y esperar al verificador de procedencia, salvo que desee un parche de emergencia.

## 4. Herramental de evaluación creado (todo local, sin red, sin tocar `src/`)

| Archivo | Para qué |
| --- | --- |
| `scripts/g7/prepare-corpus.ts` | Verifica la exportación (JSONL o CSV de `history-export`): conteo vs 469, duplicados, orden, huérfanos, rango, actores, texto disponible; seudonimiza; escribe en `private-data/g7/` con acceso solo para su usuario (en Windows aplica `icacls`; `0600` no basta). Se niega a escribir fuera de `private-data/` o en rutas que git no ignore |
| `scripts/g7/lib/pseudonymize.ts` | Oculta teléfonos, correos, enlaces, `wamid`, documentos, fechas y nombres (heurística con disparadores); conserva contenido clínico y de estudios. Tabla de equivalencias separada. Lista los textos con posible nombre residual para revisión manual |
| `scripts/g7/lib/corpus.ts` | Lectura, verificación, reconstrucción de lotes de 15 s y **línea base**: porcentaje de respuestas del agente que son textos fijos (genéricos / «no puedo derivar»), lotes sin respuesta, preguntas múltiples respondidas con un solo mensaje, repreguntas, mensajes tras intervención humana, latencia y enrutamiento actual |
| `scripts/g7/corpus-baseline.ts` | Ejecuta la línea base sobre el corpus seudonimizado y guarda solo contadores |
| `scripts/g7/guard-audit.ts` | Auditoría del filtro con el código real (§3) |
| `scripts/g7/probe-understanding.ts` | Sondeo de la comprensión determinista actual sobre los escenarios sintéticos |
| `scripts/g7/lib/schema.ts` | Esquemas (zod) del corpus y de los escenarios |
| `tests/support/g7-scenarios.ts` | **16 escenarios sintéticos** que cubren memoria, preguntas múltiples, receta reconocida y recordada, correferencia, persistencia de objetivos, retoma tras humano, pausa, seguridad médica, pedir persona, social e inyección |
| `tests/g7-corpus.test.ts` | 12 pruebas (seudonimización, lectura JSONL/CSV, lotes, línea base, validez de escenarios). Datos 100 % inventados |

Validación: `tsc --noEmit` sin errores; las 12 pruebas pasan; el flujo completo se probó de punta a punta con un archivo sintético (que se eliminó) y la restricción de permisos de Windows se comprobó con `icacls`.

### Reutilizado de lo existente
Formato de `history-export` (`ExportedMessage`/CSV), `classifyText`, `socialOf`, `extractStudyRequests`, `detectTopics`, `guardModelReply`, `buildPromptSource`/`renderFacts`, `DRAFT_TEXTS`/`ANSWER_TEXTS`/`QUOTE_TEXTS`, el catálogo sintético de `tests/support/study-catalog.ts`, la configuración de vitest con bloqueo de red y la regla de `.gitignore` de `private-data/`.

### Pendiente de construir (siguiente fase)
Arnés de replay que dispare los escenarios y el corpus por el webhook real con PostgreSQL efímero (aún bloqueado por el espacio en disco) y los evaluadores de invariantes/cobertura/rúbrica. El sondeo actual solo cubre la capa de enrutamiento determinista.

## 5. Sondeo de comprensión actual (escenarios sintéticos, 20 mensajes etiquetados)

Resultado de `probe-understanding.ts` (replica la precedencia real del productor de texto, con el catálogo sintético de pruebas):

- **Exactitud de la categoría frente a un lector humano: 75 %.** Las confusiones relevantes: preguntas operativas formuladas con pocas palabras clave («¿entonces cuándo puedo ir?», «¿y la orina?», «¿y el de glucosa también está?») caen en `OTHER`; un cambio de opinión sobre un estudio («mejor sin el colesterol») no se ve como petición de cotización; una inyección con precio queda en `OTHER`.
- **3 de 3 mensajes con dos o más enunciados pierden potencialmente alguno** (el enrutador asigna una sola categoría). El caso crítico `S07` (síntoma + pregunta de horario) sale `MEDICAL` y la pregunta de horario no tiene camino propio.
- Los 20 mensajes son una muestra pequeña y sintética: sirve para fijar la forma de la medición, **no** como cifra definitiva.

## 6. Siguiente paso recomendado

1. **Usted:** dejar la exportación en `private-data/g7/` (o indicar su ruta) y correr los dos comandos de §1. Con eso se obtiene la línea base real y el conteo de 469.
2. **Usted:** revisar en el panel de OpenAI la franja 13:00–18:30 UTC del 4-nov (§2.2) y decidir las mitigaciones de §2.5.
3. **Yo, tras el punto 1:** revisar el informe de nombres residuales, etiquetar los fallos con la taxonomía de `03` §1.1, fijar las metas con la línea base y construir el arnés de replay.
