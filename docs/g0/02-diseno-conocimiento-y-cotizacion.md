# G0 · 02 Diseño: conocimiento del laboratorio, recetas y cotización

Todo el SQL de este documento es un **borrador de diseño**: no se ejecutó, no es una migración y los nombres pueden cambiar en G3/G4.

## 1. Principio rector

El motor de recetas ya aplica una regla: *los modelos leen, el código decide, el laboratorio es dueño de las reglas comerciales.* El motor conversacional la extiende:

- **El modelo clasifica y extrae; no afirma hechos.** Un modelo puede decidir "esto es una pregunta de horario" y extraer "domingo". No puede decidir cuál es el horario.
- **Un hecho (horario, precio, preparación, política) solo sale de un registro `APPROVED`** del laboratorio, renderizado por plantilla. Sin registro aprobado → la conversación pasa a una persona (nunca se improvisa).
- **Ausencia de dato ≠ "no hay requisito".** Si un estudio no tiene preparación registrada se dice "te confirmamos la preparación", jamás "no requiere preparación".
- **Lo clínico queda fuera:** interpretación de resultados, dosis, diagnósticos, contraindicaciones → siempre persona.

## 2. Conocimiento del laboratorio

### 2.1 Qué datos hay que modelar

| Dominio | Ejemplos de pregunta del paciente | Estructura |
| --- | --- | --- |
| Sucursales | ¿dónde están? ¿cómo llego? | `plusmedik_kb_branches` |
| Horarios | ¿a qué hora abren? ¿atienden domingos/feriados? ¿hasta qué hora toman muestras? | `plusmedik_kb_schedules` + excepciones |
| Políticas | ¿aceptan QR/tarjeta? ¿toman muestras a domicilio? ¿cuándo entregan resultados? ¿dan factura? ¿hay convenios? | `plusmedik_kb_entries` (tipo `POLICY`) |
| Preparación por estudio | ¿necesito ayuno para el hemograma? | `plusmedik_study_prep` + perfiles |
| Catálogo | ¿cuánto cuesta X? ¿hacen Y? | `lab_tests` existente (solo lectura) |

### 2.2 Esquema propuesto (agente, esquema `public`, prefijo `plusmedik_`)

```sql
-- BORRADOR DE DISEÑO (no ejecutar)
-- Entradas de texto aprobado. Insert-only: una corrección crea una versión nueva.
create table plusmedik_kb_entries (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,                 -- slug estable: 'payment_methods', 'home_sampling', 'results_delivery'
  version       int  not null,
  kind          text not null check (kind in ('POLICY','FAQ','GENERAL_PREP','CONTACT')),
  body          text not null,                 -- texto para el paciente, corto, con {slots} permitidos
  slots         jsonb not null default '[]',   -- slots que la plantilla puede rellenar (p. ej. branch, date)
  status        text not null check (status in ('DRAFT','APPROVED','RETIRED')),
  approved_by   text, approved_at timestamptz,
  effective_from timestamptz, effective_to timestamptz,
  source_ref    text,                          -- de dónde salió el dato (documento del laboratorio)
  unique (key, version)
);

create table plusmedik_kb_branches (id uuid primary key, name text, address text, maps_url text, phone text, active bool);

create table plusmedik_kb_schedules (
  branch_id uuid references plusmedik_kb_branches,
  service   text check (service in ('OFFICE','SAMPLE_COLLECTION','RESULTS_PICKUP','HOME_SAMPLING')),
  weekday   smallint check (weekday between 0 and 6),
  opens     time, closes time,
  valid_from date, valid_to date, status text, version int
);
create table plusmedik_kb_schedule_exceptions (branch_id uuid, on_date date, service text, closed bool, opens time, closes time, note text);

-- Preparación por estudio. 'NO_PREP' es un valor EXPLÍCITO aprobado, nunca el valor por defecto.
create table plusmedik_study_prep (
  lab_test_id       uuid not null,             -- = lab_tests.id (referencia lógica verificada por una consulta de integridad)
  version           int  not null,
  prep_state        text not null check (prep_state in ('NO_PREP','HAS_PREP')),
  fasting_hours     int,                       -- null = sin ayuno
  profile_codes     text[] not null default '{}',-- p. ej. FIRST_MORNING_URINE, STOOL_3_SAMPLES
  collection_window text,                      -- p. ej. '07:00-10:00'
  instructions      text,                      -- texto aprobado, corto
  turnaround_hours  int,                       -- tiempo de entrega aprobado
  requires_appointment bool, home_sampling_allowed bool,
  status text check (status in ('DRAFT','APPROVED','RETIRED')),
  approved_by text, approved_at timestamptz,
  primary key (lab_test_id, version)
);
create table plusmedik_prep_profiles (code text primary key, instructions text, fasting_hours int, status text, version int);
```

Decisiones de diseño:

- **Insert-only con vista `current`** (la última versión `APPROVED` vigente a la fecha). Permite saber qué se le dijo a un paciente en una fecha dada (la auditoría guarda `key@version`).
- **Perfiles de preparación** (`ayuno 8 h`, `ayuno 12 h`, `primera orina de la mañana`, `heces seriadas`…) evitan cargar 541 filas a mano: el laboratorio asigna un perfil a grupos de estudios y excepciona los que difieren.
- **Sin clave foránea a `lab_tests`**: el catálogo es compartido y lo consulta también el CRM; una consulta de integridad (estudio inactivo con preparación vigente, estudio activo sin dato) alimenta una lista de trabajo para el laboratorio y para G3.
- **Zona horaria fija** `America/La_Paz` en código; "¿está abierto ahora?" se calcula con código determinista, nunca con el modelo.
- **Fuente de la carga inicial:** hoja/CSV aprobada por el laboratorio → script con `--apply` explícito (mismo patrón que `scripts/apply-catalog-aliases.ts`), con vista previa y reporte. No hay datos reales en el repositorio hoy; el contenido lo entrega el laboratorio (decisión 4 del resumen).
- **Edición futura desde el CRM:** el CRM es el panel administrativo natural, pero implica cambios fuera de este repositorio y su propio contrato. G3 no lo requiere.

### 2.3 Cómo se contesta (cadena de respuesta fundamentada)

```
mensaje de texto
  → reglas deterministas primero (pedir persona, baja/opt-out, saludo)
  → clasificador de intención (modelo, esquema cerrado, una llamada barata; baja confianza ⇒ persona)
  → resolución de slots por código (fecha relativa → fecha real, sucursal, estudios nombrados → UUID del catálogo)
  → consulta de registros APPROVED
  → plantilla + datos ⇒ texto final     ← el modelo no escribe el hecho
  → (si falta dato / fuera de alcance / riesgo clínico) ⇒ handoff a persona
```

Intenciones iniciales: `SEND_RECIPE` (imagen), `QUOTE_FROM_TEXT`, `ASK_HOURS`, `ASK_LOCATION`, `ASK_PREP`, `ASK_POLICY`, `ASK_PRICE`, `ASK_STATUS`, `GREETING`, `HUMAN_REQUEST`, `OPT_OUT`, `MEDICAL_ADVICE`, `COMPLAINT`, `OUT_OF_SCOPE`. `HUMAN_REQUEST`, `MEDICAL_ADVICE` y `COMPLAINT` nunca se contestan automáticamente (pasan a persona); `OPT_OUT` solo confirma la baja y deja de escribir al contacto; `OUT_OF_SCOPE` recibe una respuesta fija de alcance con la oferta de pasar a persona.

Reglas de seguridad de la respuesta:

1. Toda cifra, hora o nombre de estudio del texto enviado proviene de un registro; una prueba automática lo verifica (patrón del "verificador" que ya existe para el catálogo).
2. Una respuesta nunca mezcla hechos de versiones distintas ni de registros fuera de vigencia.
3. Un modelo de redacción libre queda **desactivado** por defecto; si más adelante se quiere más naturalidad, solo puede reformular una plantilla ya aprobada y el verificador compara los hechos antes de enviar.
4. Una pregunta con una parte respondible y otra no (p. ej. precio + diagnóstico) se contesta solo en la parte aprobada y deriva el resto.

### 2.4 Horarios: reglas concretas

- `OFFICE`, `SAMPLE_COLLECTION`, `RESULTS_PICKUP` y `HOME_SAMPLING` son servicios distintos con horarios distintos (el cierre de toma de muestras suele ser anterior al de oficina).
- Resolución de "mañana", "el sábado", "feriado" por código con la excepción de fechas cargada por el laboratorio; si el calendario de excepciones no cubre la fecha pedida, se responde el horario regular **y** se aclara que se confirmará (o se deriva), según decisión del laboratorio.
- La decisión pendiente "AM/PM = 08:00/16:00" que ya figura en el proyecto pertenece a este modelo (ventana de toma) y no se codifica hasta que el laboratorio la apruebe.
- Horario de **atención humana**: tabla propia dentro de `plusmedik_kb_schedules` (`service = 'HUMAN_SUPPORT'`) que decide qué se le promete al paciente en un handoff (§3 del documento 03).

## 3. Preparación de estudios: integración con la cotización

Dado el conjunto de estudios **cotizados** (nunca los pendientes) se consolida la preparación de forma determinista:

| Regla | Comportamiento |
| --- | --- |
| Ayuno | Máximo de `fasting_hours` entre los estudios; se indica cuáles lo exigen |
| Muestras distintas | Lista agrupada por tipo (sangre, orina, heces…) usando el perfil |
| Ventanas incompatibles | Si las `collection_window` no se solapan, no se elige: se avisa y se pasa a persona |
| Estudio sin dato de preparación | Línea "Preparación a confirmar: X" y, si es el único dato, derivación; nunca "sin preparación" |
| Estudio con `NO_PREP` explícito | Se omite de la lista |
| Contradicción (perfil y estudio) | Manda el registro del estudio; registro de conflicto para el laboratorio |

El texto de preparación se adjunta como **segundo mensaje o bloque** posterior a la cotización, no dentro del cuerpo del total, para no alterar `formatQuoteMessage`. La preparación **no cambia** si una línea se cotiza; solo informa. Las comprobaciones de seguridad de la cotización siguen siendo las de hoy.

## 4. Recetas y cotización automática con precios reales

### 4.1 Lo que no cambia

`analyzeImage` y `evaluatePartial` conservan sus contratos (`outcome`, `publicQuote`, `internal`, `revision`). El precio sale solo de `lab_tests.price_bs` (`CatalogStudy.priceBs`, tarifa Paciente) con validación `catalog_price_invalid`. Los modelos nunca ven ni deciden un precio ni un código.

### 4.2 Qué se agrega

**a) Sesión de cotización (varias imágenes / varios mensajes).** Una `quote_session` por contacto con ventana corta (propuesta: 30 min desde la última imagen) que acumula las líneas aprobadas por UUID. Reglas:

- El paquete y su componente no se cobran dos veces (se reutiliza `isPackageComponent` como hace `completeQuote`).
- Un estudio repetido entre imágenes no se duplica; queda constancia del texto que lo pidió.
- El mensaje final puede enviarse (a) al terminar cada imagen con el acumulado, o (b) tras un breve silencio. Recomendación: (a) con el acumulado corregido, para no esperar; el número de mensajes por contacto lo limita G7.
- Concurrencia: las imágenes del mismo contacto se serializan con un bloqueo por `contact_key` (hoy solo se excluye por mensaje).

**b) Cotización desde texto.** "Quiero cotizar hemograma, glucosa y TSH". Camino propuesto, reutilizando lo existente:

1. División determinista del mensaje en elementos (comas, saltos de línea, "y"), con una llamada de modelo con esquema cerrado solo si el texto es ambiguo.
2. Cada elemento entra como un estudio ya "leído" (la lectura de texto no tiene incertidumbre visual: no pasa por los dos lectores de imagen) a `shadowMatch` → verificador de identidad → `evaluatePartial`. El resto de la cadena (alias aprobados, variantes, paquetes, servicios, certeza) es idéntica.
3. Lo que el verificador no aprueba queda pendiente igual que en una receta.
4. Se marca el origen `TEXT` en la auditoría, porque la tasa de error esperada es distinta (no hay documento que verificar, pero tampoco evidencia de que el paciente quiso eso).

**c) Vigencia y trazabilidad del precio.** Cada cotización emitida guarda: lista de UUID, precio por línea, `catalogFingerprint` (ya existe), fecha y `revision` (la de `partial-auto`). Una cotización se considera vigente por un plazo que fija el laboratorio (decisión pendiente; propuesta de partida: el texto al paciente dice "precios vigentes a la fecha de hoy"). Si el paciente vuelve después del plazo, se recalcula; si cambió el precio, se informa el nuevo.

**d) Tarifa.** Interfaz `PriceBook.priceFor(contact, studyId)` con una única implementación inicial `PACIENTE`. Los convenios (tarifas por organización, ya modeladas en el portal web sin fusionar) solo se conectan si el dueño lo decide y existe un mapa contacto → organización (decisión 8).

**e) Quién guarda la cotización.** Hoy no hay entidad. El CRM tiene `crm.quotes`/`quote_items` y declaró que la cotización automática del motor conversacional "requerirá su propio contrato". Hasta decidirlo (decisión 9), la cotización del agente es un **resultado auditado**, no un documento comercial; el envío al CRM va por el mismo emisor del handoff (documento 03) con un tipo `QUOTE_SNAPSHOT` si se acuerda.

**f) Mensajes del paciente.** Se mantienen las reglas actuales: lo cotizado con su precio y "Total de los estudios cotizados"; nada de pendientes, bloqueos ni motivos. Se suma: acuse de recibo inmediato ("recibimos tu receta, la estamos revisando", porque el análisis tarda 1-2 min), el bloque de preparación y, cuando hay pendientes, el aviso de revisión humana (documento 03).

### 4.3 Casos a cubrir con la batería de pruebas (sin llamadas reales)

Se reutiliza la batería de generalización existente (`tests/support/generalization-battery.ts`) y se agregan positivos, negativos y variaciones para: texto de cotización con sinónimos y errores de tipeo; lista con un estudio ambiguo; estudios con preparación contradictoria; dos imágenes de la misma receta; la misma imagen reenviada; imagen + texto aclaratorio; pregunta de horario en sábado de feriado; estudio sin dato de preparación. Cumple el principio ya acordado de mejorar por causa raíz y validar con positivos, negativos y variaciones, no por receta.

### 4.4 Costos

La cotización por imagen cuesta lo mismo que hoy (~US$0,034 esperado por receta según el registro de validación). Las respuestas de texto con clasificador pequeño y plantillas cuestan fracciones de centavo por turno. No se hace ninguna llamada real para validar este diseño sin autorización explícita y un tope nuevo (decisión 12).
