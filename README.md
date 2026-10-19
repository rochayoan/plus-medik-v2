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
