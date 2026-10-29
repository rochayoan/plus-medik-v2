# G4.1 · Requisitos del paciente y tiempos de entrega

Todo local, offline y **apagado por defecto**. Nada se aplicó a Supabase real, no se envió nada por Kapso, no se llamó a ningún modelo, no se activó ninguna bandera, no hay commit/push/merge. No se tocó `CRM-PLUSMEDIK` ni el motor de recetas, y **ningún precio ni el flujo de cotización de G4.0 se modificó**.

## 1. Auditoría: qué existe y qué no

| Dato | `lab_tests` (catálogo) | Conocimiento de G3 | Conclusión |
| --- | --- | --- | --- |
| id, código, nombre, nombre normalizado, precio (`price_bs`), activo, categoría | ✅ columnas conocidas (las que lee `loadActiveCatalog` y el CRM) | — | Fuente única de identidad y precio. **No se duplica** |
| Alias | ✅ `lab_test_aliases` | — | Identificación exacta del estudio |
| **Tipo de muestra** | ⚠️ `sample_type` existe (texto, puede ser nulo), **pero es un dato operativo del catálogo que nadie aprobó para decírselo a un paciente** | ❌ | Falta un dato **aprobado** |
| **Preparación / ayuno** | ❌ | ✅ `STUDY_PREPARATION` (G3.0/G3.1A) | Ya resuelto; se integra |
| **Requisitos especiales** (traer frasco, evitar algo…) | ❌ ninguna columna | ⚠️ solo dentro de las indicaciones de preparación | Falta un dato **aprobado** y estructurado |
| **Plazo de entrega por estudio** | ❌ ninguna columna (se buscó `turnaround`, `delivery`, `plazo`, `entrega` en este repositorio y en el CRM, solo lectura) | ⚠️ solo la política **general** `RESULTS_DELIVERY` (texto libre) | Falta un dato **aprobado**, estructurado y con unidad |

Limitación de la auditoría: **no se consultó la base real** (restricción de la fase). Se auditó lo que el código de este repositorio y del CRM lee de `lab_tests`; si la tabla real tuviera columnas adicionales, no las veríamos. `scripts/inspect-catalog.ts` (solo lectura) permite que alguien autorizado lo confirme.

**Decisión**: no se confía en `sample_type` para el paciente ni se inventa un plazo. Se agregan los dos datos que faltan **con el mismo gobierno que G3** (borrador → pendiente → aprobado → retirado, cuatro ojos, caducidad obligatoria, la IA jamás aprueba) y referidos solo por `lab_tests.id`.

## 2. Qué se agregó

| Tipo | Clasificación (quién aprueba) | Contenido (lista blanca) |
| --- | --- | --- |
| `TURNAROUND` — plazo de entrega | Administrativa (aprobador administrativo) | `unit` **HORAS** (1–720) o **DÍAS** (1–60, con `dayType` **hábiles/calendario** obligatorio), `max`, `min` opcional (< `max`), `countedFrom` **toma/recepción** de la muestra, `note` opcional sin importes |
| `SAMPLE` — tipo de muestra y requisitos | **Clínica** (aprobador clínico) | `sampleType`; `requirementsState`: `HAS_REQUIREMENTS` (1–6 requisitos) o `NO_SPECIAL_REQUIREMENTS` (**afirmación explícita y exclusiva**; la ausencia de un registro NUNCA equivale a «sin requisitos») |
| Preparación / ayuno | Clínica | Sin cambios (G3.0) |

Cada estudio conserva **su** unidad: el sistema nunca convierte horas en días ni al revés. «Hasta N» es la lectura literal de un `max` sin `min`; un rango se dice «entre A y B».

## 3. Cómo se consulta

```
texto del paciente ─► ¿pregunta por plazo / muestra / requisitos? (reglas, sin modelos)
      │ no ─► como siempre (G3.1A)
      ▼ sí
 ¿qué estudio?  1) nombre o alias EXACTO en el mensaje  ─ ambiguo ─► «no pude identificar con certeza…» (no se responde por él)
                2) si no nombra ninguno: estudios de la ÚLTIMA COTIZACIÓN entregada (≤ 24 h, solo ids, sin precios)
                3) ninguno ─► «necesito el nombre del estudio»  (no se adivina)
      ▼
 servicio de lectura (aprobado + vigente AL USAR el dato; revisión compartida con G3; falla cerrado)
      ▼
 por estudio: dato ─► texto con plantilla fija + valores del registro │ sin dato ─► «No tengo … de X disponible por ahora»
      ▼
 rastro de versiones ANTES de reservar el envío (sin rastro no se envía el dato) ─► reserva ─► comprobación final ─► Kapso
```

- **Información incompleta o ambigua → se dice claramente.** Un estudio sin dato aprobado, vencido o retirado, o un nombre ambiguo, nunca recibe un plazo supuesto; y **no se promete una persona**: la derivación sigue bloqueada (G2.1) y la respuesta sin datos es la de siempre.
- **Pregunta general** («¿cuándo entregan los resultados?») = política de G3, sin cambios. **Pregunta por un estudio concreto** = el dato de ese estudio (la política general no se mezcla: podría contradecirlo).
- Un mensaje con **precio** («¿cuánto cuesta y cuánto demora…?») sigue el camino de cotización: el precio solo sale al cerrar la solicitud (G4.0).
- Lo **médico** y pedir **a una persona** nunca consultan estos datos.

## 4. Vínculo con las cotizaciones de G4.0 (sin tocar precios ni duplicar el catálogo)
- Tras una cotización entregada, «¿y para cuándo estarían?» responde por **los estudios de esa cotización** (`plusmedik_quote_last_studies`: lectura con owner + fence que devuelve **solo ids**). Los precios, el total y el resultado guardado de la cotización **no cambian** (probado), y estas respuestas **nunca** incluyen precios.
- Una pregunta de información en medio de una solicitud **no se anota como estudio** (la atiende el manejador de siempre) y la solicitud sigue intacta.
- Con más de 5 estudios en la cotización se pide cuál (no se responde de golpe).

## 5. Seguridad, idempotencia, concurrencia (heredadas y probadas)
Mismo claim con lease/fencing, reserva única, pausa humana, comprobación final y antibucles (la firma lleva `OTHER:TURNAROUND`, así la base detecta la misma consulta repetida). Mensaje duplicado → una respuesta y un rastro; preguntas simultáneas → todas respondidas sin solaparse, cada una con su rastro. Sin texto del paciente ni teléfonos en logs o tablas.

## 6. Migración 12 `20261031000000_plusmedik_study_facts.sql` (preparada, **no aplicada**)
Aditiva (las 11 anteriores con hash fijado). Tablas `plusmedik_study_facts`, `plusmedik_study_fact_events` (inmutable), `plusmedik_turn_fact_refs` (inmutable); funciones de administración (`create_draft`, `edit_draft`, `submit`, `reject`, `approve`, `deactivate`), de lectura (`snapshot`, `list`), de rastro (`record_facts`, `facts_usage`) y `quote_last_studies`. `lab_tests` solo se **lee** (al aprobar: el estudio debe existir y estar activo). Sube la **misma revisión** que G3 (`plusmedik_kb_bump`), así que la caché de ambos lectores se invalida igual.

## 7. Activación (todo apagado)
`PLUSMEDIK_STUDY_INFO=on` (en blanco en `.env.example`) solo tiene efecto con `PLUSMEDIK_TURNS`, `PLUSMEDIK_TEXT_HANDLER` y `PLUSMEDIK_KNOWLEDGE_ANSWERS` en `on`. Sin la migración 12 o sin datos aprobados el bot dice que no tiene el dato (falla cerrado, probado). El servicio se crea de forma perezosa.

## 8. Un defecto previo encontrado y corregido en el camino
La auditoría del cableado de Vercel mostró que `api/kapso/webhook.ts` solo exponía 8 de las operaciones del repositorio de auditoría: **faltaban** `recordKnowledgeRefs` (G3.1A), `releaseTurn` (G2.1) y las de sesiones (G4.0). En producción, con esas banderas, el rastro de conocimiento no se habría podido registrar (toda respuesta con datos habría caído al texto sin datos) y las sesiones habrían respondido siempre con el aviso técnico: **fallo cerrado, no inseguro, pero las funciones no habrían funcionado**. Las pruebas de extremo a extremo no lo detectaban porque arman sus propias dependencias. Se completó el proxy y se agregó una prueba que exige que **toda** operación de `AuditRepository` esté en el cableado.

## 9. Archivos
Nuevos: `supabase/migrations/20261031000000_plusmedik_study_facts.sql` · `src/study-facts/{types,store,service,admin,index}.ts` · `tests/study-facts{,-db,-e2e,-boundaries}.test.ts` · `tests/knowledge-answers-facts.test.ts` · `tests/text-handler-facts.test.ts` · `docs/g4/12-…` · `docs/g4/13-…`.
Modificados: `src/knowledge-answers.ts` (temas, estudio por nombre o contexto, plantillas) · `src/text-handler.ts` (contexto, regla de precio) · `src/turns.ts` (contexto perezoso, doble rastro) · `src/audit.ts` (`recordFactRefs`, `quoteLastStudies`) · `src/guarded-turn.ts` y `src/quote-session*.ts` (una opción cada uno) · `api/kapso/webhook.ts` y `.env.example` · pruebas de apoyo.
