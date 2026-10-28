# PlusMedik V2

Core limpio para lectura segura de solicitudes de laboratorio mediante **dos lectores multimodales independientes + juez de discrepancias + catálogo + safety gate determinista**.

## Principio

```text
imagen completa
   ├─> Gemini reader ─┐
   └─> OpenAI reader ─┤
                      ├─> consenso
             disputa ─┘
                 ↓
          juez premium
                 ↓
             catálogo
                 ↓
           safety gate
          ↙           ↘
     AUTO_SAFE   HUMAN_REVIEW
```

Los modelos **leen**. Ningún modelo autoriza AUTO por sí solo. El código determinista controla catálogo, incertidumbre y decisión final.

## Alcance inicial

- Sí: órdenes digitales/impresas y formularios no manuscritos.
- Sí: X, check, círculo, subrayado, tachado o rayón como evidencia visual que los modelos deben interpretar.
- No por ahora: solicitudes clínicas cuyo contenido depende de escritura manuscrita.
- No todavía: WhatsApp, Supabase, UI, CRM, pedidos, pagos o producción.

## Modelos iniciales

Configurables por `.env`:

- Reader A: `gemini-4-argon`
- Reader B: `gpt-6.1-sol`
- Judge (solo discrepancias): `gpt-6-astra`

No están hardcodeados como decisión permanente. El benchmark decidirá si se mantienen.

## Estructura deliberadamente pequeña

```text
src/
  types.ts       contratos del dominio
  ai.ts          readers + judge
  consensus.ts   comparación de lecturas
  catalog.ts     resolución determinista
  safety.ts      fail-closed
  pipeline.ts    orquestación
  index.ts
scripts/
  benchmark.ts
tests/
  core.test.ts
private-data/    ignorado por Git
```

No se migran los experimentos V5 descartados ni sus flags.

## Seguridad

AUTO_SAFE requiere, como mínimo:

1. documento soportado y visible completo;
2. cero incertidumbre visual;
3. toda disputa entre readers resuelta explícitamente;
4. todas las selecciones con certeza HIGH;
5. cada estudio resuelto de forma única en el catálogo;
6. ninguna regla/política pendiente.

Si algo falla: `HUMAN_REVIEW`.

Objetivo de producto: `WRONG_AUTO = 0`.

## Pipeline real (`analyzeImage`, `npm run analyze-image -- <imagen>`)

```text
imagen ─┬─> Gemini (OpenRouter) ─┐
        ├─> lector OpenAI ───────┼─> consenso ─> juez (solo disputas)
        └─> señal de documento ──┘            │
            (tipo, integridad, contexto)       ↓
                                  catálogo de Supabase (solo lectura)
                                  matcher exacto/alias  +  GPT-6.1 Sol (opcional, ver banderas)
                                               ↓
                                 safety fail-closed ─> AUTO_SAFE | HUMAN_REVIEW
```

- **Señal de documento:** dos lecturas independientes del tipo (impreso, formulario con marcas, manuscrito...) y de la integridad de la zona de estudios. Una zona que solo se *acerca* a un borde se verifica con dos lecturas enfocadas; cortes, objetos que tapan y trazos ilegibles siempre bloquean. También extrae el contexto impreso (título, muestra declarada).
- **Consenso:** una misma selección visual transcrita distinto (espaciado, plural, texto truncado) cuenta una sola vez; una lectura truncada nunca produce coincidencia por sí sola.
- **Cotización:** una línea por UUID de `lab_tests`, con el precio siempre de Supabase (tarifa Paciente). Los modelos nunca deciden códigos ni precios.
- **Decisión:** cualquier ambigüedad, estudio ausente, perfil sin composición aprobada, documento incompleto o manuscrito => `HUMAN_REVIEW`. Con las banderas apagadas (por defecto), AUTO solo es posible por coincidencia exacta/alias.

### Banderas semánticas (apagadas por defecto)

| Variable | Efecto |
| --- | --- |
| `CATALOG_SEMANTIC_PRIMARY=on` | GPT resuelve todos los estudios contra el catálogo activo completo (dos pasadas independientes + verificador determinístico + contexto del documento) y se contrasta con el matcher exacto. Los resultados quedan como *candidatos*: la decisión sigue en `HUMAN_REVIEW`. |
| `CATALOG_SEMANTIC_AUTO=on` | Además, los MATCH semánticos verificados y los compuestos explícitos (p. ej. GOT/GPT) pueden entrar a una cotización `AUTO_SAFE`. Solo tiene efecto con `PRIMARY=on`. **No activar para usuarios reales sin autorización expresa.** |
| `CATALOG_HANDWRITTEN_AUTO=shadow` | Solo **simula**: para un pedido manuscrito legible informa en `handwrittenShadow` si sería AUTO (documento verificado completo, dos lecturas idénticas sin juez, certeza alta, mismas variantes y matching semántico verificado). **Nunca cambia la decisión real**: el manuscrito sigue en `HUMAN_REVIEW`. Requiere `PRIMARY=on`. |
| `CATALOG_HANDWRITTEN_AUTO=on` | El pedido manuscrito deja de ir a revisión por serlo y se rige por los **mismos requisitos que un impreso** (lectura confiable, consenso, variantes claras, matching verificado y precios del catálogo). |
| `CATALOG_PARTIAL_AUTO=on` | **AUTO parcial**: cada estudio se decide por separado; los seguros se cotizan automáticamente aunque otros requieran revisión (ver abajo). |

Las banderas de AUTO (`PRIMARY`, `AUTO`, `PARTIAL`, y `HANDWRITTEN=on`) solo se encienden con el valor exacto `on`; `HANDWRITTEN=shadow` solo simula.

### Salida pública y registro interno (con `CATALOG_PARTIAL_AUTO=on`)

`analyzeImage` devuelve, además de los campos heredados (que no cambian de significado: `decision=AUTO_SAFE` y `quote` existen solo cuando TODA la receta quedó cotizada):

| Campo | Para quién | Contenido |
| --- | --- | --- |
| `outcome` | sistema | `AUTO_COMPLETE` (nada pendiente), `AUTO_PARTIAL` (hay estudios cotizados y otros pendientes) o `HUMAN_REVIEW` (ningún estudio verificable, o un motivo que invalida toda la lectura). |
| `publicQuote` | **paciente** | Solo los estudios cotizados con su precio y "Total de los estudios cotizados". Sin estados, advertencias, motivos, UUID ni pendientes. Ausente si no hay cotización automática. |
| `internal` | **CRM / revisión humana** | Decisión por estudio, pendientes (estudios dudosos, disputas, zona de la receta que no se ve), bloqueos, problemas del documento, UUID y auditoría de cada línea. |

**Riesgo visual por estudio** (`src/visual-risk.ts`). Un corte, sello, objeto, trazo ilegible, caja inválida o problema sin tipo no detiene la receta: crea una *zona desconocida* que solo se registra en `internal.document.zones`. Cada estudio visible y sin otros bloqueos se clasifica como `CLEAR` (sin zonas), `INDEPENDENT` (dos lecturas independientes confirmaron que su texto y su marca se ven enteros y que ninguna zona puede afectarlo), `AFFECTED` (una zona lo afecta o podría afectarlo, o su casilla/texto está tapado) o `UNKNOWN` (sin verificación, error, sin respuesta, o un título oculto podría calificarlo). Solo `CLEAR` e `INDEPENDENT` se cotizan; la zona desconocida siempre queda pendiente, por lo que nunca hay AUTO completo con zonas sin ver. En zonas no localizadas (trazos borrados, caja inválida, duda sin causa) no se descarta un título oculto, así que los estudios con variantes de muestra/tiempo quedan pendientes. Solo detienen toda la receta: tipo de documento incierto, no es una solicitud, manuscrito sin permiso y ausencia de estudios. `completeQuote` (`src/quote-completion.ts`) permite completar luego con revisión humana sin duplicar cobros. Para una prueba local puntual: `CATALOG_SEMANTIC_PRIMARY=on CATALOG_SEMANTIC_AUTO=on npm run analyze-image -- private-data/<imagen>`.

### Función del documento y texto con "+"

- **Función, no formato** (`src/document-function.ts`). Escrito a mano, impreso o con casillas dice *cómo* se escribe; no *para qué sirve*. Si alguna de las dos lecturas de la señal de documento extrajo una frase que une envío/derivación con una muestra ("derivación de muestra", "muestra derivada", "etiqueta de muestra", "recepción de muestras"...), dos lecturas independientes de la imagen clasifican la función: `MEDICAL_REQUEST`, `SAMPLE_DERIVATION`, `SAMPLE_LABEL`, `OTHER_NON_REQUEST` o `UNCLEAR`. Solo dos `MEDICAL_REQUEST` mantienen el documento como solicitud; dos "no es solicitud" lo vuelven `NOT_A_REQUEST`; cualquier discrepancia, duda, error o falta de verificador lo vuelve `UNKNOWN` (ambos detienen toda la receta). Una palabra suelta ("derivación a laboratorio", "tipo de muestra", "paciente derivado") no activa nada, y una solicitud válida que menciona un envío se confirma sin perder estudios. El motivo queda en `internal.document.function`, nunca en la salida pública.
- **"+" en el texto.** Un texto «A + B» pide varias cosas: un único estudio que solo cubre A no se cotiza (se rechaza con el elemento no cubierto); si el texto es exactamente el nombre o alias aprobado de un paquete, manda el catálogo. Un paquete cuyo nombre lista sus estudios con "+" ("A + B", hasta 4 elementos sencillos) se trata como los paquetes con paréntesis: no se cobra junto con ninguno de sus componentes (en el flujo parcial y en el heredado). Si varios estudios cotizados por separado forman un paquete del catálogo, `internal.advisories` lo avisa al CRM sin sustituir precios.

- **Señales sin palabras clave.** Además de las frases de derivación, activan la comprobación los OBJETOS de muestra que las lecturas ya describen al explicar qué tapa o aparece en la foto (jeringa, vial, tubo de ensayo/de sangre, frasco de orina...). No cuesta ninguna llamada extra. "Tubo gástrico" o "tubo digestivo" no cuentan.
- **Grupo de paquete retenido.** Si los estudios aprobados cubren TODOS los componentes de un paquete activo (nombre con paréntesis o con "+"), el grupo queda pendiente (`package_alternative_unresolved`): con las filas ya separadas por los lectores no se puede distinguir "pedidos por separado" de "la expresión del paquete", y el precio aplicable lo decide el laboratorio. Los estudios independientes de la receta se cotizan. Una parte de los componentes no forma grupo. Limitación: el emparejamiento exige que el elemento del nombre del paquete y el estudio compartan el mismo analito base; abreviaturas distintas ("SHBG" frente a "SHBG Globulina fijadora...") no se detectan.

### documentFunction y lineText (dentro de las lecturas existentes)

- **`documentFunction`** (señal de documento, dos lecturas): cada lectura clasifica para qué sirve el documento (`MEDICAL_REQUEST`, `SAMPLE_DERIVATION`, `SAMPLE_LABEL`, `OTHER_NON_REQUEST`, `UNCLEAR`) y cita la evidencia (`functionEvidence`). Ambas solicitud: sigue; ambas "no es solicitud": `NOT_A_REQUEST`; cualquier discrepancia o duda: `UNKNOWN` (bloquea toda la receta, sin arbitraje). No depende de palabras clave ni agrega llamadas. Si ambas dicen solicitud pero extrajeron una frase explícita de derivación o rótulo de muestra, una comprobación enfocada (2 lecturas) confirma o corrige. Las lecturas guardadas antes del campo siguen usando las señales por palabras clave y objetos.
- **`lineText`** (lectores Gemini y OpenAI): cada estudio trae el texto completo de su línea; varios estudios de una línea comparten el mismo. Solo se usa si AMBOS lectores coinciden (ignorando espaciado, mayúsculas y puntuación; una versión más corta o distinta no se completa). Usos: (1) si la línea ES el nombre o alias aprobado de un paquete y las filas leídas cubren EXACTAMENTE sus componentes, la línea se trata como ese paquete (un estudio, precio del catálogo); (2) si la línea es un paquete aprobado y las filas no lo reconstruyen sin ambigüedad, el grupo queda pendiente (`package_line_unreconstructable`); (3) componentes pedidos cada uno en SU PROPIA línea simple no se reemplazan por el paquete ni se retienen; (4) un servicio pedido en la línea (ATB/antibiograma) que el estudio no cubre bloquea el estudio (`line_service_not_covered`); (5) un elemento de la línea que ninguna fila representa se avisa al CRM (`internal.advisories`). Nunca se inventan estudios ni precios.
- **Compatibilidad / repeticiones sin gasto:** el prompt y el esquema incluyen estos campos en la clave de caché, así que las lecturas guardadas antes no coinciden. `legacyReplayDeps` (src/analyze.ts) vuelve a leer la caché con el contrato anterior para comparar antes/después sin llamadas; en producción nunca se usa. El manifiesto de la Fase 4C se actualiza con `phase4c-preflight.ts --refresh-code "motivo"` (exige imágenes y referencia idénticas).

### Modo offline (protección centralizada)

`src/offline.ts`. Dos capas independientes que ninguna guarda de gasto puede saltarse:
- **Llamadas a modelos:** `cachedAiCall` consulta el modo offline ANTES de la guarda de gasto; con `PLUSMEDIK_OFFLINE=1` (o `enforceOffline()`) una respuesta que no está en cache nunca llega a la llamada real. Las cacheadas se siguen sirviendo. Una vez activado por código es pegajoso (borrar la variable no lo desactiva).
- **Red:** `fetch`, `http(s).request/get` lanzan `OfflineViolation`, así que ni siquiera un SDK que eluda `cachedAiCall` (OpenAI, Gemini, Supabase) puede salir. Debe activarse ANTES de crear los clientes.
- Toda la suite de pruebas corre con la red bloqueada (`vitest.config.ts`). Los scripts de repetición sin gasto importan `scripts/lib/offline-boot.ts` como PRIMER import. Los scripts de pago NO deben importarlo; siguen usando `PLUSMEDIK_AUTHORIZE_PAID_CALLS`.

### Verificador de identidad del matching semántico (reglas generales)

El verificador determinista (`src/catalog-shadow.ts`) revisa cada decisión del modelo contra el catálogo. Reglas relevantes:

- **Alias aprobado = decisión del laboratorio.** Si el texto es exactamente un alias aprobado de UN solo estudio activo (y nadie más lo reclama ni coincide con un nombre), el estudio se acepta sin compararlo con sus variantes hermanas ni con las alternativas del modelo: el alias ya fija la variante ("T4L" = T4 LIBRE). Lo que CONTRADICE sigue bloqueando: un calificador que el alias o el texto dice y el estudio contradice, y el contexto declarado del documento cuando existe una variante compatible. Un nombre exacto sin alias no tiene esta autoridad.
- **Coordinación elíptica.** En un compuesto como "X total y libre" el fragmento que solo trae calificadores ("libre", "IgM") hereda el analito del fragmento hermano, únicamente si ambos estudios son variantes del mismo analito. Nunca mezcla familias distintas.
- **Servicios adicionales.** "Urocultivo y ATB": si el texto pide un antibiograma y el nombre del estudio no lo incluye (ni un alias aprobado lo cubre), el estudio queda en revisión. Cotizar solo el cultivo ignoraría parte de lo pedido; si el laboratorio lo cubre, se declara con un alias aprobado.
- **Certeza.** Una disputa que existía solo por certeza ("no alta en ambos") y que el juez confirmó viendo la imagen se resuelve como certeza alta únicamente si ambos lectores transcribieron el mismo estudio, sin incertidumbres relacionadas ni variantes distintas, ninguno con certeza baja y al menos uno alta (queda una nota de auditoría). En cualquier otro caso manda la lectura MÁS débil, sin depender de qué lector usó el juez como referencia.
- **Siguen siendo decisiones del laboratorio** (no del código): la composición y el precio de un perfil (p. ej. perfil lipídico), qué variante es la predeterminada (TSH, VIH, BUN/Urea...), si un cultivo incluye antibiograma, y si "AM/PM" significa 08:00/16:00.

### Cache y control de gasto

- Toda llamada a un modelo pasa por un cache local (`.cache/ai`, ignorado por Git; `AI_CACHE=on|off|refresh`) y queda registrada en `.cache/usage.jsonl`.
- `npx tsx scripts/spend.ts init` fija el presupuesto, `npx tsx scripts/spend.ts` informa el gasto nuevo y `npx tsx scripts/spend.ts estimate` estima costos por etapa.
- Los scripts de validación que pueden gastar (`shadow-match`, `benchmark-catalog`, `semantic-primary-check`, `semantic-auto-check`, `context-check`) **bloquean toda llamada real** salvo que se autorice un máximo por corrida: `PLUSMEDIK_AUTHORIZE_PAID_CALLS=0.15 npx tsx scripts/context-check.ts ...`. Las respuestas ya cacheadas no necesitan autorización.
- `src/pipeline.ts` y `src/safety.ts` son el core original (`PlusMedikCore`), conservado y cubierto por tests; el flujo real es `src/analyze.ts`.

## Privacidad

Nunca commitear imágenes de pacientes, nombres, teléfonos, OCR clínico ni datasets privados. `private-data/` y `benchmark-private/` están ignorados.

## Arranque

```bash
cp .env.example .env
npm install
npm run check
```

Luego se migrará **solo** el catálogo/resolver/policies probados del repo anterior y se ejecutará el benchmark offline antes de integrar WhatsApp o persistencia.

## Orden de trabajo

1. Verificar que el scaffold compila/tests.
2. Migrar catálogo + reglas seguras desde PlusMedik actual.
3. Conectar benchmark privado existente.
4. Ejecutar Reader A + Reader B + Judge sobre los casos consumidos.
5. Medir `EXACT_DOCUMENT`, `AUTO_SAFE`, `WRONG_AUTO`, falsos y omitidos.
6. Solo si el resultado justifica la arquitectura, integrar el flujo real.

No se reescribe WhatsApp ni infraestructura antes de demostrar el core.

## WhatsApp (Kapso) en Vercel — piloto mínimo

`api/kapso/webhook.ts` (`POST /api/kapso/webhook`; `GET` devuelve el estado):

1. Verifica la firma HMAC-SHA256 del cuerpo crudo (`x-webhook-signature`, secreto `WEBHOOK_SECRET`). Sin firma válida o sin secreto: 401.
2. Toma solo mensajes ENTRANTES de tipo imagen (texto, audio, reacciones y mensajes salientes se ignoran). Si `ALLOWED_PHONES` está definida, solo responde a esos números.
3. Responde 200 de inmediato y sigue en segundo plano (`waitUntil`), así Kapso no reintenta mientras el motor trabaja.
4. Descarga la imagen, carga el catálogo activo (Supabase, solo lectura) y llama a `analyzeImage` con las banderas ya validadas por argumento (semántico, AUTO parcial, manuscrito); el AUTO MATCH no cambia.
5. Envía por Kapso UNA respuesta con cada estudio verificado, su precio, el total ("Total de los estudios cotizados") y emojis (`src/whatsapp-quote.ts`). Con una cotización parcial solo van los estudios seguros; los pendientes, bloqueos y la función del documento se registran en el log del servidor (JSON, teléfono enmascarado) y nunca se mencionan al paciente. El log (`event: analysis`) está minimizado: solo códigos y enumeraciones (decisión, bloqueos, clase de incertidumbre, riesgo visual, certeza, códigos del catálogo, contadores); no incluye el teléfono completo, el nombre ni el texto de los estudios leídos, el texto de las líneas ni texto libre de los modelos, y no hay ninguna bandera que lo permita.
6. Si no hay cotización (ningún estudio verificable, no es una solicitud, imagen ilegible) se pide una foto más clara; si algo falla, un mensaje técnico neutro. Nunca se envía el detalle de un error.

Sin CRM, pedidos, tablas ni sistema propio de duplicados: la única defensa es responder 200 enseguida. Un reintento de Kapso (si el 200 no llegara a tiempo) podría generar una segunda respuesta.

### Pasos mínimos para desplegar
1. En Vercel (proyecto con este repositorio, rama `feat/kapso-pilot` o `main` tras el merge), define: `WEBHOOK_SECRET`, `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_GEMINI_MODEL`, `OPENAI_READER_MODEL`, `OPENAI_READER_REASONING`, `OPENAI_JUDGE_REASONING`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (y `ALLOWED_PHONES` para el piloto). No definas `CATALOG_*`.
2. `vercel.json` ya fija `maxDuration: 300` para la función (el motor tarda ~1–2 min); `.vercelignore` excluye `private-data`, `.cache`, `.env`, pruebas y scripts.
3. Despliega y comprueba `GET https://<dominio>/api/kapso/webhook` → `{"ok":true}`.
4. En Kapso, registra el webhook `https://<dominio>/api/kapso/webhook` para mensajes entrantes de WhatsApp, con el mismo secreto que `WEBHOOK_SECRET`.
5. Envía una foto desde un número de `ALLOWED_PHONES` y revisa los registros de Vercel (`event: analysis`, `reply_sent`).

## Auditoría persistente (Supabase) — migraciones NO aplicadas

Cada imagen procesada deja una corrida en `plusmedik_audit_runs` y sus evidencias en `plusmedik_audit_studies`, `plusmedik_audit_model_calls` y `plusmedik_audit_checks` (sin imágenes, teléfonos, prompts, respuestas crudas, razonamientos ni texto clínico libre). Las migraciones están en `supabase/migrations/` y **no se han aplicado a ningún Supabase remoto**; se ejecutan en este orden, sin modificar las anteriores: `20261020000000` (Fase 6) → `20261021000000` (telemetría de IA) → `20261022000000` (transaccional e inmutabilidad) → `20261023000000` (leases, fencing y recuperación) → `20261024000000` (control de atención humana).

- **Atomicidad.** Las evidencias de un análisis (resumen de la corrida, estudios, llamadas de IA y verificaciones) y el resultado del envío se escriben con las funciones `plusmedik_audit_record_evidence` y `plusmedik_audit_record_reply`: una transacción cada una, con lista blanca de campos, validación previa y errores sin valores. **Quedan fuera** (escrituras separadas y por tanto no atómicas con lo anterior): el claim del mensaje (INSERT en `runs`) y las actualizaciones operativas `recordIgnored`/`recordFailure`. Una corrida terminada con `evidence_recorded_at` NULL indica evidencia no confirmada (brecha de auditoría observable). El envío a WhatsApp nunca forma parte de la transacción.
- **Idempotencia y reintentos.** La función bloquea la fila de la corrida y guarda el hash del contenido: el mismo contenido repetido responde `already_recorded` (sin duplicar); uno distinto sobre una corrida ya registrada se rechaza (409). Si una petición termina sin respuesta (timeout, red, 5xx) no se sabe si se confirmó: el cliente repite UNA vez, con exactamente los mismos bytes; si tampoco hay respuesta el resultado queda `UNKNOWN_OUTCOME`, se registra solo ese código y el procesamiento continúa (fail-open). **El envío a WhatsApp nunca se repite** por un fallo de auditoría. Peor caso con Supabase colgado: 2 intentos de 5 s por escritura.
- **Inmutabilidad.** `service_role` solo LEE `studies`, `model_calls` y `checks` y solo actualiza las columnas operativas de `runs`; triggers impiden UPDATE/DELETE/TRUNCATE de las evidencias (incluso al propietario), cambiar las columnas de evidencia ya registradas y las transiciones de estado inválidas. **Límites:** `service_role` se salta RLS (no se confía en RLS contra él); el propietario o un superusuario pueden desactivar triggers o cambiar privilegios, y quien tenga la credencial de `service_role` puede registrar evidencia (no la puede reescribir, pero la base no prueba su autenticidad). Aún no existe purga: los triggers bloquean todo DELETE (la retención de 30/180 días se aplicará en su propia migración).
- **Pruebas contra PostgreSQL real.** `tests/audit-db.test.ts` crea un clúster efímero (directorio temporal, 127.0.0.1, se destruye al terminar), aplica las tres migraciones desde cero y prueba la función, los privilegios y los triggers. Usa los binarios de PostgreSQL instalados (autodetecta `C:\Program Files\PostgreSQL\*\bin`, `/usr/lib/postgresql` o el PATH; `PLUSMEDIK_PG_BIN` fuerza una carpeta). Sin PostgreSQL esas pruebas se omiten con un aviso.

### Leases, reserva de envío y recuperación (F1.3) — migración NO aplicada

**Prioridad: nunca enviar dos respuestas al mismo paciente.** La exclusión no depende del reloj ni de temporizadores: depende de una **reserva de envío** que la base concede una sola vez, bajo bloqueo de fila, a la ejecución que posee el lease con la generación (fence) vigente. `handleImageMessage` solo llama a Kapso después de que la base confirme esa reserva; con cualquier otro resultado (bloqueada, lease perdido, cerrada, base no disponible o resultado desconocido) **no envía**: un mensaje no enviado se concilia después, uno duplicado no se puede deshacer.

**Flujo:** `claim (lease)` → descarga → análisis → evidencia (con fencing) → **reserva** → Kapso → resultado (con fencing). Cada ejecución tiene un propietario único (UUID) y toda escritura sobre la corrida presenta `owner + fence`. Si otra ejecución reclama el lease (o el recuperador cierra la corrida) el fence cambia y la base rechaza a la antigua con 410 (`LEASE_LOST`); un trigger lo impone también contra escrituras directas sobre corridas con lease. El latido que renueva el lease durante el análisis (cada 40 s, lease de 120 s) solo mejora la disponibilidad: sin él, lo peor que pasa es que otra ejecución reclame el lease y la antigua no pueda enviar.

**Estados** (`send_state` + `processing_status`; vista `plusmedik_audit_run_phase`):

| Fase | `processing_status` / `send_state` | Significado | ¿Se reanuda? |
| --- | --- | --- | --- |
| A. `RECOVERABLE` | `PROCESSING` / `NOT_RESERVED` | Procesamiento sin envío reservado | Sí: un webhook reenviado reclama el lease **vencido** (fence + 1) |
| B. `ANALYZED_UNSENT` | `ANALYZED` / `NOT_RESERVED` | Análisis terminado, sin intento de envío | Sí (se vuelve a analizar; la primera evidencia confirmada se conserva) |
| C. `SENDING` | cualquiera / `RESERVED` | Envío reservado o en curso (Kapso pudo o no haberse llamado) | **Nunca**: ni el webhook ni el recuperador lo reenvían |
| D. `SENT_ACCEPTED` | `COMPLETED`/`FAILED` / `ACCEPTED` | Kapso aceptó el mensaje | Terminal |
| E. `SEND_UNKNOWN` | `COMPLETED`/`FAILED` / `UNKNOWN` | Resultado desconocido (`SEND_OUTCOME_UNKNOWN`) | Terminal: conciliación o revisión humana |
| F. `NEEDS_ATTENTION` | `FAILED` / `NOT_APPLICABLE` | Abandonada antes de enviar (`ABANDONED_BEFORE_SEND`) | Terminal: revisión humana |
| — `CLOSED_NO_SEND` | `IGNORED`,`COMPLETED` / `NOT_APPLICABLE`,`CANCELLED` | Sin respuesta por diseño (imagen enorme) o bloqueada | Terminal |

Las corridas anteriores a F1.3 (sin lease) conservan el contrato de F1.2, aparecen como `LEGACY_IN_PROGRESS` y **nunca se reabren**.

**Puntos de interrupción y qué pasa:** (1) antes de que el claim llegue a la base: no queda rastro; (2) tras el claim, durante la descarga/análisis o antes de la evidencia: fase A, la reanuda un reenvío del webhook con el lease vencido o la cierra el recuperador como `ABANDONED_BEFORE_SEND` (sin responder); (3) tras la evidencia y antes de reservar: fase B, igual que A; (4) tras reservar y antes de llamar a Kapso, durante la llamada, o tras aceptarla y antes de guardar el resultado (caída de Vercel, Supabase caído): fase C, no se reenvía; el recuperador la marca `UNKNOWN`; (5) tras guardar el resultado: terminal.

**Riesgo residual de duplicados y su mitigación**
- *Dos webhooks del mismo mensaje*: claim atómico; el segundo ve `busy`/`in_doubt`/`finished` y se ignora.
- *Ejecución antigua que revive*: fencing (410) en evidencia, cierre, reserva y resultado; sin reserva no hay envío.
- *Timeout al reservar*: la reserva es idempotente para el mismo propietario; si tampoco hay respuesta, **no se envía**.
- *Kapso aceptó pero no se guardó el resultado*: queda `RESERVED`; el recuperador lo marca `UNKNOWN` y no se reenvía. No se asume que la API de WhatsApp/Kapso ofrezca exactly-once ni claves de idempotencia: no hay ninguna documentada que este proyecto use.
- *Residual*: el claim es la primera escritura; si la base no responde en ese momento no hay lease. Por defecto (política heredada) se responde igual y se registra `audit_unavailable stage=claim`; `requireAuditGuard: true` en `QuoteDeps` lo impide. Un duplicado solo es posible si, mientras la base está caída, Kapso entrega el mismo mensaje dos veces (el webhook responde 200 de inmediato, así que no reintenta).
- *Residual*: una ejecución a la que el recuperador marcó `UNKNOWN` mientras seguía viva puede enviar su mensaje (el único); su registro se rechaza y la corrida queda `UNKNOWN` (honesto: no se pudo confirmar).

**Recuperación sin depender del webhook.** `plusmedik_audit_recover_stale` (RPC) cierra de forma segura lo interrumpido: `RESERVED` con lease vencido (+60 s) → `UNKNOWN`; `NOT_RESERVED` con lease vencido hace más de 15 min → `ABANDONED_BEFORE_SEND`. **No envía nada**, usa `FOR UPDATE SKIP LOCKED` (dos recuperadores no pisan la misma corrida) y sube el fence. Como la base no guarda teléfono ni imagen (privacidad), el recuperador no puede responder al paciente; una reanudación automática con respuesta solo ocurre si el mensaje se vuelve a entregar. Reanudar sin reenvío exigiría guardar el destinatario y acceso a la imagen: **no implementado** a la espera de una decisión explícita de privacidad.

**Activación futura (no configurada):** el endpoint `GET|POST /api/audit/recover` (`src/audit-recovery.ts`) está **inerte**: sin `CRON_SECRET` responde 503. Para activarlo: (1) aplicar las cuatro migraciones; (2) definir `CRON_SECRET` en Vercel (secreto aleatorio largo); (3) agregar a `vercel.json` `"crons": [{ "path": "/api/audit/recover", "schedule": "*/10 * * * *" }]` (Vercel Cron llama por GET con `Authorization: Bearer $CRON_SECRET`; verifique los límites de crons de su plan de Vercel: según su documentación en el plan Hobby solo se permite una ejecución diaria, y un intervalo de minutos requiere un plan superior); (4) vigilar los logs `audit_recovery` y la consulta `select * from plusmedik_audit_run_phase where phase in ('SEND_UNKNOWN','NEEDS_ATTENTION')`. Alternativa sin HTTP si se habilita `pg_cron`: `select cron.schedule('plusmedik-audit-recovery', '*/10 * * * *', $$select public.plusmedik_audit_recover_stale()$$);`.

**Conciliación de `SEND_UNKNOWN`:** compare con la conversación en Kapso si existe un mensaje saliente posterior a `send_reserved_at`. No hay una consulta automática (la API no se asume); hoy es una revisión humana.

**Preparación para intervención humana (sin integrar):** `plusmedik_audit_block_send(message_id, motivo)` impide una respuesta pendiente si aún no se reservó (`blocked`) o informa `too_late` si ya se reservó. La comprobación real ocurre en `reserve_send`, bajo el mismo bloqueo de fila: un bloqueo y una reserva no se pueden cruzar. No conoce ninguna tabla de otros sistemas. Un bloqueo que llegue **antes** de que exista la corrida no se puede registrar aquí (requeriría una clave de conversación que esta fase no introduce).

### Atención humana: apagado automático de la IA (F2.1) — migración NO aplicada, función APAGADA por defecto

Cuando una persona del laboratorio escribe al paciente desde **WhatsApp Business**, la IA deja de responder a ese contacto hasta que se reactive de forma explícita. Se reutiliza el criterio de La Fija (un mensaje saliente con `message.kapso.origin === "business_app"`), sin copiar sus tablas ni su lógica de restaurante.

**Eventos de Kapso reconocidos** (formato v2 verificado en https://docs.kapso.ai/docs/platform/webhooks/message-events; `src/human-control.ts`): se clasifica por `direction` + `origin` + estado, no solo por el nombre del evento (`X-Webhook-Event`).

| Clase | Cómo se reconoce | Efecto |
| --- | --- | --- |
| Paciente | `direction: inbound` (o `whatsapp.message.received`) | Imágenes → motor de recetas; el origin de un entrante (`cloud_api`) no se usa |
| **Intervención humana** | `direction: outbound` + `origin: business_app`, evento de creación (`sent`) | **Pausa** al contacto |
| Bot propio | `outbound` + `origin: cloud_api` (lo enviado por la API de Kapso) | Ninguno: el bot jamás se apaga a sí mismo |
| Estados de entrega | `delivered`, `read`, `failed` (cabecera o `message.kapso.status`); comparten `message.id` con el mensaje original | Ninguno: **nunca** son una intervención |
| Historial importado | `origin: history_sync` | Ninguno |
| Otra app / agente de Meta | `other_app`, `meta_business_agent` | Solo se registra (no se interpreta como humano) |
| **Origen desconocido** | saliente sin `origin` o con uno no reconocido | Se registra como `UNKNOWN_ORIGIN`; no se inventa que fue humano |
| Otros | eventos de conversación/contacto/thread, sin mensaje, dirección ausente | Ninguno |

Kapso no documenta en qué evento llega exactamente un eco de `business_app` (solo que lleva ese origen); por eso el criterio no depende del nombre del evento. El webhook de La Fija solo mira `direction`/`origin`, no valida firma ni distingue estados: aquí se conserva la verificación de firma (`x-webhook-signature`) y se descartan los estados de entrega.

**Estado persistente (única fuente de verdad):** tabla `plusmedik_attention_contacts` (`ACTIVE` | `HUMAN_PAUSED`, `revision`, `paused_at`, `pause_reason = HUMAN_WHATSAPP_BUSINESS_APP`, `pause_source`, `resumed_at`, `last_human_event_at`, `updated_at`). La fila se crea si no existe (incluso sin ningún análisis previo). Tabla `plusmedik_attention_events` (inmutable; `event_key` único deduplica). El contacto se identifica con `contact_key = HMAC-SHA256(PLUSMEDIK_CONTACT_HMAC_KEY, "plusmedik-contact-v1|<KAPSO_PHONE_NUMBER_ID>|<dígitos del teléfono>")`: estable entre conversaciones, acotado al número del laboratorio y sin guardar el teléfono. Los procesamientos (`plusmedik_audit_runs`) guardan la misma clave (`contact_key`), que es lo que permite bloquear los pendientes de un contacto.

**Máquina de estados:** `ACTIVE` → (mensaje humano posterior a la última reactivación) → `HUMAN_PAUSED` → (`plusmedik_attention_resume`, explícita) → `ACTIVE`. La revisión sube exactamente con cada cambio de estado. Un evento humano repetido es `duplicate`; otro mientras está pausado es `ALREADY_PAUSED` (solo adelanta `last_human_event_at`); uno **anterior a la última reactivación** es `STALE_IGNORED` y no vuelve a pausar. No hay reactivación por tiempo.

**Coordinación con el envío (todo en la base, orden de bloqueo fijo contacto → corrida):**
1. *Antes del análisis*: `plusmedik_audit_claim_run` no procesa a un contacto pausado (registra `PATIENT_SUPPRESSED`).
2. *Al pausar*: se bloquean los procesamientos pendientes del contacto (los que aún no reservaron envío).
3. *En la reserva* (`reserve_send`): bajo el bloqueo de la corrida se vuelve a consultar el bloqueo y el estado del contacto (respaldo ante un claim concurrente que la pausa no pudo ver).
4. *Comprobación final* (`plusmedik_audit_confirm_send`, justo antes de llamar a Kapso): si el contacto se pausó tras la reserva, la reserva (aún sin usar) se libera y no se envía.

**Lo que NO se puede garantizar:** un evento humano que llega después de la comprobación final, o mientras la llamada a Kapso está en curso, **no puede cancelar ese envío**; tampoco se puede retirar un mensaje ya entregado a Kapso, ni se asume exactly-once. Esa carrera se registra como evento auditable (`late_reserved_runs` y `replied_after_event_runs` en el evento, y `attention_reason = HUMAN_PAUSE_AFTER_RESERVATION | BOT_REPLIED_AFTER_HUMAN_EVENT` en la corrida). Tampoco se recupera un evento humano que Kapso no entregue (o que agote sus reintentos).

**Falla cerrada.** Con el control activo no se responde si: no hay clave estable del contacto (clave dedicada ausente o teléfono ausente), no hay auditoría, el claim falla (aunque `requireAuditGuard` no esté definido: el control lo implica), o la reserva o la comprobación final no obtienen respuesta. Un evento humano que no se pudo registrar responde **503** para que Kapso reintente (a los 10 s y 40 s, máximo 3 intentos; el registro es idempotente).

**Política de ACK (explicación y consecuencias).** *Imágenes*: sin cambios — se responde 200 de inmediato y se procesa en segundo plano (`waitUntil`). Consecuencia heredada: si el claim falla después del 200, Kapso **no** reintentará una entrega ya confirmada; con el control activo el paciente no recibe respuesta automática (puede reenviar la foto) y queda `reply_withheld`. Esperar el claim antes del 200 sería una mejora para otra fase. *Eventos humanos*: se registra la pausa **antes** de responder, con plazos cortos (2 intentos de 3 s) por debajo de los 10 s que Kapso concede; si falla, 503 y reintento de Kapso. Riesgo residual: si se agotan los 3 intentos, el evento se pierde.

**Configuración (documentada; NO configurada en producción):** `PLUSMEDIK_HUMAN_CONTROL=on` activa el control (apagado si falta); `PLUSMEDIK_CONTACT_HMAC_KEY` (≥ 32 caracteres, clave **dedicada**, distinta de `WEBHOOK_SECRET` y de cualquier otra); `KAPSO_PHONE_NUMBER_ID` (ya existente) acota las claves; `REQUIRE_AUDIT_GUARD=on` exige el claim aunque el control esté apagado (requisito de producción recomendado). Las pruebas usan valores simulados. Para activarlo: aplicar las cinco migraciones (previo ensayo), definir las variables en Vercel y verificar en un número piloto (`ALLOWED_PHONES`) con una pausa y una reactivación reales.

**Reactivación:** `plusmedik_attention_resume(contact_key, motivo, actor)` (solo `service_role`). No hay pantallas ni endpoint de control manual todavía. Reactivar no desbloquea lo ya cancelado: el paciente puede reenviar su foto.

## Agente conversacional (G2–G5) — migraciones NO aplicadas, TODO APAGADO por defecto

Sobre la auditoría y el control humano, el webhook puede coordinar turnos, responder texto con datos **aprobados** del laboratorio, cotizar varias fotos en una solicitud, derivar casos al CRM y, opcionalmente, conversar de forma natural con un modelo. **Cada capa es una bandera; ninguna está activa**, y cada una solo tiene efecto si se cumplen sus dependencias. Sin la bandera (o con una dependencia ausente) el comportamiento es el del piloto anterior. El motor de recetas (`analyze`, lectores, juez, catálogo, `partial-auto`) no cambia con ninguna de ellas.

| Orden | Bandera (`=on`) | Depende de | Migraciones | Qué hace |
| --- | --- | --- | --- | --- |
| 1 | `PLUSMEDIK_HUMAN_CONTROL` + `PLUSMEDIK_CONTACT_HMAC_KEY` | — | 01–05 | Pausa de la IA cuando una persona escribe desde WhatsApp Business |
| 2 | `PLUSMEDIK_TURNS` | 1 | 01–07 | Coordina mensajes consecutivos de un contacto (un solo envío en vuelo) |
| 3 | `PLUSMEDIK_REPLY_GUARD` (+ `_CONFIG` opcional) | 2 | 10 | Protección contra bucles y exceso de respuestas (se recomienda **antes** que el texto) |
| 4 | `PLUSMEDIK_TEXT_HANDLER` | 2 | — | Responde texto con textos fijos **borrador**; sin datos médicos ni cifras |
| 5 | `PLUSMEDIK_KNOWLEDGE_ANSWERS` | 2, 4 | 08, 09 | Responde con conocimiento **aprobado y vigente** (horarios, sucursales, pagos, políticas, preparación); sin dato, dice que no lo tiene |
| 6 | `PLUSMEDIK_QUOTE_SESSIONS` | 2, 4 | 11, 14 | Varias fotos y textos se cotizan una sola vez: con «listo», o sin él cuando el paciente escribe una lista clara de estudios y pide cotizar (G5.9; acumula y confirma si hay dudas de que terminó, y pregunta ante nombres ambiguos). Ver [`docs/g5/80-g59-cotizacion-por-texto.md`](docs/g5/80-g59-cotizacion-por-texto.md) |
| 7 | `PLUSMEDIK_STUDY_INFO` | 2, 4, 5 | 12 | Plazo de entrega, tipo de muestra y requisitos **por estudio**, solo si están aprobados |
| 8 | `PLUSMEDIK_CRM_HANDOFF` + `PLUSMEDIK_CRM_REVIEW_URL` + `PLUSMEDIK_CRM_REVIEW_TOKEN` + `PLUSMEDIK_OUTBOX_KEY` | 2, 4 | 13 | Deriva casos al CRM; «una persona del equipo…» solo con el caso ya registrado. Con cualquier faltante la derivación sigue bloqueada |
| 9 | `PLUSMEDIK_LLM_CONVERSATION` + `OPENAI_API_KEY` + `OPENAI_CONVERSATION_MODEL` (sin valor por defecto); opcional `PLUSMEDIK_LLM_BUSINESS_INFO` | 2, 3, 4 | — | Conversación natural con OpenAI (G5.3/G5.6): el modelo conversa y clasifica; con la segunda bandera además informa los datos comerciales CONFIRMADOS de `src/system-prompt.ts` (sucursales, horarios, teléfonos, servicios, pagos, políticas), verificados contra esos datos. Precios, estudios, preparación clínica y tiempos de entrega siguen saliendo de Supabase; cotizaciones y derivaciones, del backend; lo médico y las personas nunca dependen del modelo. Un filtro determinista descarta cualquier salida con cifras, datos del laboratorio o promesas. Ver [`docs/g5/40-g53-conversacion-con-openai.md`](docs/g5/40-g53-conversacion-con-openai.md) |
| 10 | `PLUSMEDIK_ATTENTION_FILTER` (+ `_REPEAT_SECONDS` y `_SETTLE_MS` opcionales) | 2, 4 | — | Atención selectiva (G6.0): no responde saludos aislados, cortesías, ruido ni repeticiones (sin modelo ni consultas), agrupa las confirmaciones de varios mensajes seguidos y le da al modelo el **estado** de la conversación (cantidades, no textos). Lo médico, pedir a una persona y cualquier posible solicitud se procesan siempre. Ver [`docs/g6/00-g60-atencion-selectiva.md`](docs/g6/00-g60-atencion-selectiva.md) |
| 11 | `PLUSMEDIK_AGENT_CONTROL` + `PLUSMEDIK_AGENT_CONTROL_TOKEN` (token exclusivo CRM→agente) | 1 (para operar) | 15 | Rutas internas `POST /api/internal/crm/attention/status` y `/action` (Fase 1 de la integración con el CRM): el CRM consulta el estado real de atención y pausa o reactiva la IA de un contacto, de forma idempotente por `operationId` y sin simular mensajes de WhatsApp. Sin `PLUSMEDIK_HUMAN_CONTROL` no muta nada (`available:false`). Ver [`docs/integracion-crm/01-fase1-control-de-atencion.md`](docs/integracion-crm/01-fase1-control-de-atencion.md) |

- **Migraciones:** 13 archivos en `supabase/migrations/`; **ninguna aplicada**. Aplicación **manual** y en orden, con verificaciones de solo lectura antes y después: ver [`docs/g5/20-g51-aplicacion-de-migraciones.md`](docs/g5/20-g51-aplicacion-de-migraciones.md) (`npm run migration-manifest -- --check` comprueba que las verificaciones coinciden con las migraciones).
- **Datos del laboratorio:** el repositorio **no contiene ninguno**. La configuración (prompt, sucursales, teléfonos, horarios, servicios, políticas) se escribe en **un solo archivo de código**, [`src/system-prompt.ts`](src/system-prompt.ts) (`SYSTEM_PROMPT` y `BUSINESS_DATA`; se importa, sin Markdown ni generación; guía en [`agent-config/`](agent-config/README.md)): personalidad, tono, reglas de conversación y datos comerciales: negocio, sucursales y direcciones, horarios, teléfonos, servicios, pagos, políticas; todo POR COMPLETAR); `npm run agent-config -- check` lo valida y lista lo que falta.
- **Activación:** requisitos y orden por capa en `docs/g2/11`, `docs/g3/11`, `docs/g3/13`, `docs/g4/11`, `docs/g4/13` y `docs/g5/11`. Los reintentos de la cola al CRM (`api/outbox/drain.ts`) están inertes y **sin cron** en `vercel.json`.
