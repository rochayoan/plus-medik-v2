# G6.3 · Conexión del motor de lotes (Fase 3): bandera, modo sombra y respaldo

Estado: **conectado y APAGADO por defecto.** Sin la variable `PLUSMEDIK_BATCH_ENGINE` nada cambia: ni una respuesta, ni una escritura, ni una línea de registro nueva.

## La bandera

`PLUSMEDIK_BATCH_ENGINE` (variable de Vercel; ver `.env.example`):

| Valor | Efecto |
| --- | --- |
| ausente, vacío, `off` | **Apagado** (por defecto). La ruta de siempre. |
| `shadow` | **Modo sombra.** La ruta de siempre responde y escribe exactamente como hoy; el motor nuevo solo DECIDE en paralelo y deja UNA línea de registro por lote (`batch_shadow`) con códigos para comparar. **Exige la migración 20** (lectura de solo lectura). |
| `on` | **Motor encendido.** El motor nuevo atiende el texto de los lotes de Kapso; la ruta de siempre queda de respaldo. No exige la migración 20. |
| cualquier otro valor | Apagado, y se registra `batch_engine_config_invalid` (`INVALID_VALUE`). Una errata nunca lo enciende. |

Condiciones (si no se cumplen queda apagado y se registra `batch_engine_inactive`): `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_TEXT_HANDLER=on` y `PLUSMEDIK_QUOTE_SESSIONS=on` (el motor lee y cierra las sesiones de cotización). El campo `batchEngine` de la línea `agent_scope` (que se escribe al arrancar) dice cuál quedó: `off`, `shadow` u `on`.

Solo actúa en un **lote de Kapso** (varios mensajes de un contacto en un mismo envío) que traiga al menos un texto. Un mensaje suelto sigue siempre la ruta de siempre. Funciona con la puerta del piloto y con todos los contactos, igual que el resto de los turnos.

## Cómo activar el modo sombra

1. **Aplica a mano la migración 20** (`supabase/migrations/20261108000000_plusmedik_quote_shadow_peek.sql`, ver `docs/g5/20-g51-aplicacion-de-migraciones.md` y las verificaciones `supabase/preflight/`). Es aditiva: una sola función nueva, de solo lectura; no cambia ninguna tabla ni función existente. Sin ella el modo sombra no hace nada (cada lote deja `skipped: UNAVAILABLE`); **nunca** recurre a la lectura que escribe.
2. En Vercel (proyecto del webhook, entorno **Production**) agrega `PLUSMEDIK_BATCH_ENGINE` = `shadow` y vuelve a desplegar para que se lea. Para revertir: bórrala o ponla en `off` y vuelve a desplegar.
3. Verifica el arranque: en los registros del webhook, la línea `agent_scope` debe traer `"batchEngine":"shadow"`. Si ves `batch_engine_inactive`, falta alguna de las tres banderas anteriores; si ves `batch_engine_config_invalid`, el valor está mal escrito.
4. Espera tráfico real y busca la línea `batch_shadow` (una por lote con texto). Ejemplo:

```json
{"app":"plusmedik","event":"batch_shadow","phone":"591****0068","agree":false,"direction":"SHADOW_QUOTES_MORE","current":"SESSION_REPLY","shadow":"QUOTE","limits":[],
 "core":"QUOTE","reasons":["QUOTE_BY_INTENT"],"intent":"QUOTE","intentSource":"LEXICON","confirmedBy":null,"sessionOpen":false,"messages":3,"photos":0,"studies":2,"negated":0,"negationDoubts":[],"safety":[],"notices":[]}
```

| Campo | Significado |
| --- | --- |
| `agree` | `true`: la ruta de siempre y el motor nuevo hicieron lo mismo. `false`: difieren. **`null`: la comparación no es fiable** (ver `limits`); no cuenta ni como acuerdo ni como desacuerdo. |
| `direction` | `SAME`; `SHADOW_QUOTES_MORE` (el motor nuevo cotizaría y la ruta de siempre no, p. ej. «Quiero cotizar» + estudios claros); `SHADOW_QUOTES_LESS` (la ruta de siempre cotizó y el nuevo no); `DIFFERENT`; `INCONCLUSIVE`. |
| `limits` | Por qué una comparación no es fiable: `MODEL_NEEDED` (la ruta de siempre consulta a OpenAI cuando un texto queda sin identificar o no se reconoce, y el modo sombra nunca lo hace; solo aplica si OpenAI está configurado), `LEGACY_WAITING` (la ruta de siempre esperó a mensajes anteriores) o `LEGACY_FAILED` (falló). |
| `current` / `shadow` | Clase de lo que respondió la ruta de siempre / decidiría el motor nuevo: `QUOTE`, `REVIEW`, `SESSION_REPLY`, `CANCELLED`, `NOTHING_TO_CANCEL`, `EMPTY`, `DECLINED`, `CONVERSATION`, `SILENT`, `TECHNICAL`, `WAITING`, `OTHER`. Lo que contesta el manejador de texto (saludos, charla, preguntas) puede ser respuesta o silencio y ambos cuentan como coincidencia; solo la seguridad exige respuesta. |
| `core`, `reasons`, `intent`, `intentSource`, `confirmedBy`, `negationDoubts` | Por qué decidió así el motor nuevo (códigos cerrados). |
| `sessionOpen`, `messages`, `photos`, `studies`, `negated`, `safety`, `notices` | Cantidades y tipos. Nunca textos, nombres de estudios, precios ni el teléfono completo (va enmascarado). |
| `skipped` | En lugar de la comparación: `PENDING` (había turnos anteriores en proceso), `REPLAY` (turno ya cerrado, reclamado de nuevo), `UNAVAILABLE` (la lectura falló, la migración 20 no está aplicada o tardó más de 1,5 s) o `PLAN_FAILED`. No afecta la respuesta. |

**Cómo medir sin engañarse:** calcula los porcentajes solo sobre las líneas con `agree` distinto de `null`. Mira todos los `SHADOW_QUOTES_LESS` (el motor nuevo callaría o preguntaría donde hoy se cotiza) y comprueba que los `SHADOW_QUOTES_MORE` sean los casos buscados (intención clara con estudios resueltos). Diferencias esperadas: `DECLINED` («no quiero cotizar» solo existe en el motor nuevo) y las dudas de negación (`negationDoubts`), donde el motor nuevo pregunta en vez de cotizar.

### Qué garantiza el modo sombra: ESTRICTAMENTE de solo lectura

- **Mismas respuestas.** No se modifica, retrasa ni sustituye ninguna respuesta.
- **Sin escrituras, sin bloqueos, sin cupos, sin acciones.** No anota, no cierra, no cotiza, no vence sesiones, no atiende lo delegado (ni conocimiento ni CRM), no reserva ni envía (no consume el tope diario ni la guarda de respuestas) y no llama a OpenAI.
- **Una sola lectura nueva, impuesta por la base:** `plusmedik_quote_shadow_peek` (migración 20) está declarada `STABLE`; PostgreSQL no permite que una función `STABLE` escriba ni tome bloqueos de fila (`SELECT ... FOR UPDATE`), así que la garantía no depende de la disciplina del código. Devuelve la solicitud abierta visible para ese turno (con owner + fence, como el resto) y un booleano de «cotización reciente»; trata como inexistente una sesión vencida **sin** marcarla `EXPIRED` (la lectura de siempre sí lo hace). El modo sombra ya no usa `plusmedik_quote_session_read` ni `plusmedik_quote_last_studies`.
- **Comprobado con la base real:** `tests/quote-shadow-peek-db.test.ts` (la función es `STABLE`; ninguna tabla cambia en ningún estado; una sesión vencida sigue `OPEN`; responde de inmediato aunque otra transacción tenga bloqueada la fila del contacto; privilegios) y `tests/batch-engine-wiring.test.ts` (en 9 escenarios, las respuestas, corridas, sesiones, ítems y **todas** las llamadas a la base son idénticas entre `off` y `shadow` salvo exactamente UNA llamada a la lectura de solo lectura).
- **Nunca rompe un turno.** Cada paso está acotado a 1,5 s y cualquier fallo se traga (queda un código `skipped`).

### Desplegar el código ANTES de aplicar la migración 20

Es seguro. Con la bandera apagada (por defecto) nadie llama a la función nueva: las respuestas, las corridas, las sesiones y todas las llamadas a la base son idénticas a las de siempre (prueba contra una base SIN la migración 20 en `tests/batch-engine-wiring.test.ts`). Con `on` tampoco se usa. Con `shadow` y sin la migración, la lectura falla (el cliente de la base la reintenta una vez), el lote deja `skipped: UNAVAILABLE` y todo lo demás sigue igual: no se recurre a otra lectura.

### Verificar la migración 20 después de aplicarla

Ejecuta `supabase/preflight/v2_migration_20_post_apply_read_only.sql` (una sola sentencia SELECT, solo lectura) en el proyecto correcto: debe dar 15 comprobaciones y el VEREDICTO en `OK` (volatilidad `s`, SECURITY DEFINER, `search_path` vacío, EXECUTE solo para el dueño y `service_role`, sin referencias al esquema `crm`, prerrequisitos presentes y una llamada con una corrida inexistente que responde `unavailable`). Después, la verificación general `supabase/preflight/v2_post_apply_read_only.sql` debe dar VEREDICTO = OK con las 20 migraciones. Ambas están probadas contra PostgreSQL real, con y sin la migración.

## Motor encendido (`on`)

Un lote con texto se atiende así (`src/turns.ts` → `src/batch-engine.ts`):

1. **Respaldo previo.** Si el motor no puede ni entender y decidir el lote (catálogo caído, error en la comprensión o la política), se registra `batch_engine_fallback` (`stage: PROBE`) y `batch_engine_fallback_used` y el lote sigue COMPLETO por la ruta de siempre, que todavía no ha tocado nada.
2. **Cancelación + fotos** en el mismo lote: de la posición de cada foto respecto a la cancelación depende cuáles sobreviven, y eso no se puede reconstruir con seguridad desde aquí; el lote sigue por la ruta de siempre (`batch_engine_skipped`, `CANCEL_WITH_PHOTOS`).
3. **Lotes mixtos de texto y fotos, en cualquier orden.** Las fotos y otros tipos de mensaje se procesan como siempre (análisis, evidencia, deduplicación, sesión; cada una con su corrida). Después, el texto se anota desde el turno de texto **más reciente** (`host`); los demás textos se reclaman y se cierran sin respuesta. Si el último mensaje del lote es ese texto, el mismo turno lo hace todo. Si es una foto (u otro tipo), esa corrida ya tiene su propio ítem y no puede anotar el texto (la base permite un ítem por corrida): el `host` lee la solicitud tal como estaba, descarta la anterior si el lote la cancela y anota el texto, queda cerrado, y el turno que responde —el último, que sí ve todo lo anotado, fotos incluidas— cierra la solicitud y cotiza. Qué aportó cada foto (estado e ids de estudios) lo informa el productor de las fotos, así que el plan lo conoce aunque la foto sea posterior al texto.
   - **Orden:** el texto se interpreta en el orden de llegada (una foto en medio corta la reconstrucción de nombres), el ítem de texto queda con el número del último texto y cada foto conserva el suyo.
   - **Evidencia:** cada foto se analiza una vez y deja su evidencia en su propia corrida; el rastro de conocimiento y de preparaciones de la cotización queda en la corrida que envía; no queda ninguna corrida «en proceso».
4. El motor lee la solicitud, comprende el lote entero, decide UNA vez, ejecuta (anotar, cancelar, cotizar con el catálogo recargado) y compone UN mensaje.
5. Lo médico, pedir a una persona, las preguntas de información y lo genérico (saludos, charla) los contesta el manejador de texto de siempre (con su rastro de conocimiento, derivación al CRM, atención selectiva y modelo de conversación); si falla, se usa el texto fijo seguro.
6. Se conservan sin cambios: la deduplicación por mensaje, la pausa humana, el tope de 5 respuestas cada 24 h, la guarda de respuestas, el rastro de auditoría y que el contenido de un mensaje nunca se registra. Un fallo después de haber anotado o cotizado **no** vuelve a la ruta de siempre (duplicaría escrituras): responde el aviso técnico de siempre, además de los avisos de seguridad que correspondan.

Registros nuevos del motor encendido: `turn_batch` trae `engine:"on"`; `batch_plan` (códigos del plan); `batch_engine_fallback`, `batch_engine_fallback_used`, `batch_engine_skipped`.

## Negaciones, rectificaciones y peticiones posteriores

Reglas generales (ninguna depende de frases concretas; ver `src/batch-understanding.ts`):

1. Una negación (`no`, `nunca`, `jamás`, `tampoco`, `ni`) anula hasta el final de **su cláusula**; la cláusula termina en puntuación, en `pero`/`sino`/`aunque` y **al final de cada mensaje**: un mensaje es una enunciación completa y lo que viene en el siguiente es una petición posterior («no quiero cotizar» + «hemograma completo» anota el hemograma y sigue sin cotizar).
2. Una negación al final de la cláusula («glucosa no») anula la última mención.
3. Una negación sin objeto al final de un mensaje, con más mensajes después («no quiero» + «hemograma»), es una **duda**: no se descarta nada en silencio y no se cotiza por inferencia; se resume lo anotado y se pregunta.
4. Un `no` suelto al inicio de una cláusula («no, mejor glucosa») es una rectificación: no anula lo que sigue; si antes ya había una petición en el lote, es una duda.
5. **Gana lo último que dijo el paciente**, en orden, para cada estudio y para la intención de cotizar: pedir y luego negar saca el estudio; negar y luego pedir lo deja; «cotizar» y luego «no quiero cotizar» es no cotizar, y al revés. Negar un estudio ya anotado en la solicitud abierta es una duda (no se puede deshacer desde aquí).
6. Ante cualquier duda de negación (`negationDoubts`: `DANGLING`, `RECTIFICATION`, `RETRACTS_SESSION`) la política **no cotiza directo** (razón `NEGATION_UNCLEAR`); solo un «listo» explícito cierra. El modelo de lenguaje solo ve lo que el paciente no negó.

Por eso repartir una oración con negación en mensajes ya no da siempre la misma comprensión (antes sí, y eso hacía desaparecer en silencio estudios pedidos). Lo que se prueba ahora, para todos los repartos posibles, es la **seguridad**: ninguno convierte en cotización lo que no lo era ni cotiza un estudio negado; y si el reparto cae en el límite de una cláusula, la comprensión es exactamente la de la oración completa.

## Lo que NO cambió (a propósito)

`text-fragments.ts` (reconstrucción de nombres partidos), `mergeProduced` y todo el flujo por unidades siguen en uso: son la ruta apagada por defecto, el modo sombra y el respaldo. Se retiran en una fase posterior, cuando el modo sombra demuestre que el motor nuevo los cubre.

## Riesgos y límites conocidos

- **El modo sombra necesita la migración 20** en el Supabase compartido con el CRM. Es aditiva y de solo lectura, pero hay que aplicarla a mano antes (o el modo sombra no compara nada).
- **Modo sombra sin OpenAI:** los lotes donde la ruta de siempre consulta al modelo (algo sin identificar) salen `agree: null` / `MODEL_NEEDED` si OpenAI está configurado; no hay forma de compararlos sin llamarlo. Con `on`, el motor sí lo consulta (una vez por lote y solo si hace falta; validado contra el catálogo; nunca define precios).
- **Cancelación + fotos** va por la ruta de siempre.
- **Intención entre lotes:** «quiero cotizar» en un lote y los estudios en el siguiente se tratan por separado.
- **Un turno cierra una sola solicitud** salvo en un lote mixto con último mensaje no texto (el `host` cancela y el último cierra); en el caso de un único turno que cancela y pide otra, se cancela, se anota lo nuevo y se pide confirmar.
- **Relleno conversacional dentro de un mensaje de estudios** («mejor sí, cotizar hemograma») puede quedar como texto sin identificar y obligar a preguntar: viene del resolvedor de estudios de siempre.
- **El orden de las líneas de la cotización** sigue el orden en que llegaron los estudios.

## Pruebas

`tests/batch-engine.test.ts` (configuración, fragmentos, fotos, clasificación y comparación del modo sombra, comparaciones no fiables), `tests/batch-understanding.test.ts` y `tests/batch-policy.test.ts` (negaciones e invariantes), `tests/quote-shadow-peek-db.test.ts` (la migración 20 contra PostgreSQL real), `tests/batch-engine-wiring.test.ts` (extremo a extremo con el webhook, los turnos y PostgreSQL reales: apagado, sombra estrictamente de solo lectura, encendido con lotes mixtos en cualquier orden, respaldo, deduplicación, pausa humana, tope diario, privacidad), `tests/agent-scope.test.ts` (la variable de entorno) y `tests/quote-session-boundaries.test.ts` (quién puede conocer qué).
