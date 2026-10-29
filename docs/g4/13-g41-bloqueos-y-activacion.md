# G4.1 · Resultados, bloqueos, riesgos y condiciones de activación

## 1. Resultado de las pruebas (offline; PostgreSQL 18 efímero; sin servicios reales)

| Dato | Valor |
| --- | --- |
| `tsc --noEmit` | sin errores |
| Suite completa | **82 archivos / 2256 pruebas, todas en verde**, en dos corridas completas consecutivas (≈ 5 min). Las **2078** previas siguen pasando; **178 son nuevas** |
| Cambios a pruebas existentes | Solo contratos que cambiaron a propósito: el manejador de texto recibe un 2.º argumento (contexto) en `turns.test`; conteo/posición de migraciones; listas de «dónde puede aparecer» en las pruebas de fronteras; el adaptador de pruebas (RPC nuevas) |
| Gasto / red | cero llamadas a modelos, Kapso o Supabase real |

| Archivo nuevo | Pruebas | Cubre |
| --- | --- | --- |
| `tests/study-facts-db.test.ts` | 64 | SQL real: esquema/privilegios/inmutabilidad, 28 contenidos inválidos, gobierno (roles por clasificación, cuatro ojos, la IA no aprueba), vigencia ≤ 400 días, estudio activo en `lab_tests`, versiones y reemplazo, retiro, instantánea, rastro (idempotente, `closed` tras reservar, lease), impacto, última cotización, aditividad |
| `tests/study-facts.test.ts` | 32 | Contrato del contenido (espejo del SQL), servicio de lectura: unidad aprobada, caducidad al usar, estudio desconocido/inactivo/sin catálogo, contenido inválido, caché por revisión, falla cerrado |
| `tests/knowledge-answers-facts.test.ts` | 32 | Detección de temas (apagada = G3.1A), plazo en horas/días hábiles/calendario/rango, singular/plural, sin dato, ambiguo, política general vs. por estudio, muestra/requisitos, última cotización, fact-check de cifras, sin precios |
| `tests/text-handler-facts.test.ts` | 12 | Qué mensajes consultan los datos (y cuáles no: precio, médico, personas), contexto perezoso, rastro y respaldo, firma, privacidad |
| `tests/study-facts-e2e.test.ts` | 20 | Administración real → webhook real → respuesta → rastro en la base → impacto; unidades; muestra; sin dato; ambiguo; tras cotizar (G4.0) sin alterar precios; retiro/reemplazo/vencimiento; idempotencia; concurrencia; pausa humana; antibucles; fallas cerradas; privacidad |
| `tests/study-facts-boundaries.test.ts` | 10 | El motor de recetas y las sesiones no los conocen; administración inaccesible al agente; sin precios ni duplicación del catálogo; banderas; **el proxy de Vercel expone todo `AuditRepository`** |

### Pruebas de mutación (16 reglas críticas debilitadas a propósito; las 16 detectadas)
Autor aprueba lo suyo (1) · rol que no depende de la clasificación (4) · aprobar un estudio inactivo (1) · días sin hábiles/calendario (1) · rastro después de reservar (1) · última cotización sin antigüedad (1) · instantánea con pendientes (1) · ignorar caducidad (2) · «sin requisitos» sin dato (1) · hábiles dichos calendario (3) · ambiguo cae al contexto (2) · mezclar política general (1) · no registrar el rastro (6) · cableado sin la última cotización (1) · mensaje con precio respondido como dato (1) · pregunta con estudios anotada como lista (1).
**Una mutación (R16) no se detectaba al principio**: mi prueba usaba una frase que la extracción rechazaba por sí sola. Se agregó el caso que sí la necesita («hemograma y colesterol, ¿cuánto demoran?») y se volvió a mutar: detectada. Tras cada corrida se verificó por texto la restauración y se eliminaron las copias de seguridad para que no queden obsoletas.

## 2. Bloqueos (nada de esto se hizo)

| Sistema | Bloqueo | Efecto hoy |
| --- | --- | --- |
| **Supabase** | **Doce** migraciones sin aplicar; sin staging; el mapeo HTTP real de PostgREST para las RPC nuevas (`jsonb`, `uuid`, `text[]`) sin verificar; **columnas reales de `lab_tests` sin consultar** (no se tocó la base real) | Con la bandera y la 12 sin aplicar: el dato es «no disponible» y el rastro no se puede registrar ⇒ no se envía nada con datos (falla cerrado, probado) |
| **Laboratorio** | **Cero datos aprobados** de plazo, muestra ni requisitos; sin definir quién aprueba (clínico/administrativo, dos personas distintas); plantillas sin aprobar; sin decidir qué hacer con `sample_type` del catálogo | El bot responde «no tengo el dato» (verificado) |
| **CRM** | Sin pantallas para cargar/aprobar estos datos (existe el contrato en `src/study-facts/admin.ts` y el script de borradores no está hecho) | Solo se pueden cargar con un script o SQL de servicio |
| **Derivación a una persona** | Sigue bloqueada (G5): ante información incompleta o ambigua el paciente recibe «no tengo el dato» sin promesa de una persona | Conserva la derivación segura, pero sin camino de escalamiento |
| **Kapso** | Sin verificar eventos de texto ni ventana de 24 h | Igual que antes |
| **Dueño** | Despliegue de producción y variables sin confirmar | — |

## 3. Riesgos propios de G4.1

| # | Riesgo | Severidad | Mitigación / estado |
| --- | --- | --- | --- |
| R1 | **Un plazo aprobado mal redactado o desactualizado se repite tal cual** (p. ej. «hasta 24 horas» cuando ahora son 48) | Media | Es el propósito del flujo de aprobación: caducidad ≤ 400 días, retiro inmediato (misma revisión que G3, ≤ 15 s por instancia) y la consulta `plusmedik_facts_usage` dice a quién se le dijo cada versión |
| R2 | **Semántica de «hasta N»**: un `max` sin `min` se dice «hasta N horas/días» (lectura literal). El laboratorio debe aprobar con eso en mente | Media | Documentado; el rango exige `min < max` |
| R3 | **El plazo no es una promesa por cotización**: es el dato del estudio; no considera feriados, urgencias ni la carga del día | Media | Las notas aprobadas (`note`) lo permiten; no se promete nada más |
| R4 | **Mezcla de estudios con plazos distintos**: se informa cada uno por separado; no se calcula «el total» (eso sería una regla clínica/operativa que hoy no existe) | Baja | Deliberado |
| R5 | **Rastro doble no atómico**: conocimiento (G3) y datos por estudio se registran con dos llamadas; si la 2.ª falla se responde sin datos, pero la 1.ª pudo quedar registrada aunque la respuesta con datos no salió | Baja | La consulta de impacto solo cuenta turnos con envío reservado; puede sobrecontar un turno cuyo envío fue el texto sin datos |
| R6 | **El eco de un dato no lo reconoce el detector de textos propios** (solo compara plantillas fijas); lo corta la detección de repeticiones de la base | Baja | Probado en e2e (3 respuestas máx.) |
| R7 | **«Última cotización» por tiempo (24 h)**: si el paciente cotizó dos solicitudes seguidas, «¿cuándo estarán?» se refiere a la última | Baja | El nombre del estudio en el mensaje manda sobre el contexto; el encabezado dice «Sobre los estudios de tu última cotización» |
| R8 | **Clasificación por palabras**: «demora», «plazo», «muestra» pueden aparecer en otros contextos | Baja–media | Falso positivo = una respuesta «necesito el nombre del estudio»; nunca un dato inventado |
| R9 | **`sample_type` del catálogo queda sin usar** y duplica en parte lo que se pide aprobar | Baja | Una importación como BORRADOR (que alguien apruebe) evitaría reescribirlo; no se hizo |
| R10 | **Cada pregunta de estos temas** consulta el catálogo (caché de 5 min) y el servicio (revisión cada 15 s); la última cotización, una RPC más | Baja | Acotado |

## 4. Condiciones para ACTIVAR G4.1 (en números de prueba; nada se activó)

Orden estricto (primero migraciones, después banderas):
- [ ] Todo lo de **G2.1 §3**, **G3.1A §5**, **G3.2 §4** y **G4.0 §5**.
- [ ] Las **doce** migraciones aplicadas y validadas en un Supabase de ensayo por HTTP real (en especial `plusmedik_study_fact_*`, `plusmedik_turn_record_facts`, `plusmedik_quote_last_studies`), y confirmar con `scripts/inspect-catalog.ts` (solo lectura) las columnas reales de `lab_tests`.
- [ ] **Gobierno**: dos personas distintas por clasificación (clínica para muestra/requisitos, administrativa para plazos).
- [ ] **Un primer lote de datos reales APROBADOS** (p. ej. los 20 estudios más cotizados): plazo en la unidad que el laboratorio use, desde cuándo se cuenta y, si aplica, tipo de muestra y requisitos.
- [ ] **Textos de `ANSWER_TEXTS` aprobados** por el laboratorio (incluye los nuevos).
- [ ] Guion manual en un número de prueba: pregunta por nombre → dato correcto; sin dato → aviso; retirar el dato → ya no responde; vencido → no responde; tras una cotización «¿y cuándo estarán?»; pregunta con precio → sigue el camino de cotización; consulta de impacto encuentra la conversación; pausa humana → silencio.
- [ ] Orden de banderas: … → `PLUSMEDIK_TURNS` → `PLUSMEDIK_REPLY_GUARD` → `PLUSMEDIK_TEXT_HANDLER` → `PLUSMEDIK_KNOWLEDGE_ANSWERS` → `PLUSMEDIK_QUOTE_SESSIONS` → **`PLUSMEDIK_STUDY_INFO`** (la última; sin las respuestas con conocimiento no tiene efecto).

## 5. Qué sigue (no hecho aquí)
- Script de carga de **borradores** (nunca aprueba) a partir de una hoja aprobada, con vista previa y `--apply` explícito, e importación opcional de `sample_type` como borrador.
- Staging con las 12 migraciones y verificación HTTP; pantallas en el CRM (G5) y derivación real.
- Aclaraciones por texto en G4.x («¿cuál de las dos creatininas?») y reenvío de una cotización guardada.
