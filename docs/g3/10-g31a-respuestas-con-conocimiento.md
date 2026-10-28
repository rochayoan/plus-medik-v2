# G3.1A · Respuestas del manejador de texto con conocimiento aprobado

Todo local, offline y **apagado por defecto**. Nada se aplicó a Supabase real, no se envió nada por Kapso, no se llamó a ningún modelo, no se activó ninguna bandera, no hay commit/push/merge. No se tocó `CRM-PLUSMEDIK` ni el motor de recetas.

## 1. Qué hace

El manejador de texto de G2.1 ahora puede, **si se le entrega el servicio de conocimiento**, responder preguntas generales con datos que el laboratorio **aprobó** y que **siguen vigentes**. Sin ese servicio es idéntico a G2.1 (una prueba lo fija).

```
texto ─► clasificador de G2.1 ─┬─ MEDICAL / HUMAN_REQUEST / GREETING / RECIPE ─► como en G2.1 (NO consulta conocimiento)
                               └─ INFO_REQUEST / OTHER ─► detectTopics ─► consulta KnowledgeService (aprobado + vigente)
                                                               │
                              ┌── hay datos ─────────────────────┴───────────────── no hay datos / falla ──┐
                              ▼                                                                            ▼
              plantilla + datos aprobados (sin modelo)                                   respuesta de G2.1 (aviso «no disponible», derivación bloqueada)
                              │
        registrar REFERENCIAS (versiones aprobadas usadas) ── falla ─► NO se envía; se responde como sin conocimiento
                              │
                 reserva → comprobación final (pausa humana) → Kapso → resultado   (la máquina de siempre)
```

## 2. Temas que entiende (reglas, sin modelos)

| Tema | Ejemplos | Fuente aprobada | Responde |
| --- | --- | --- | --- |
| Horarios | "¿a qué hora abren?", "horario de toma de muestras" | `SCHEDULE` (+ `BRANCH` aprobada y vigente) por servicio | Horario semanal agrupado por día + excepción de **hoy** + "en este momento: abierto/cerrado" si se pregunta por ahora |
| Ubicación | "¿dónde están?", "su dirección" | `BRANCH` | Nombre, dirección, mapa, teléfono, notas |
| Pagos | "¿aceptan tarjeta?" | `PAYMENT_METHOD` | Lo que **sí** y lo que **no** acepta, tal como lo aprobó el laboratorio |
| Políticas | "¿cuándo entregan los resultados?", "¿emiten factura?", "¿convenios?", "¿agendar cita?", "¿a domicilio?" | `POLICY` por **tema** fijo: `RESULTS_DELIVERY`, `HOME_SAMPLING`, `INVOICING`, `CONVENIOS`, `APPOINTMENTS` | Título y cuerpo aprobados |
| Preguntas frecuentes | "¿tienen estacionamiento?" | `FAQ` por **etiqueta exacta** (una palabra del mensaje que sea etiqueta aprobada) | Pregunta y respuesta aprobadas; si coinciden varias, no responde |
| Preparación de estudios | "¿necesito ayuno para X?" | `STUDY_PREPARATION` (clínica) del estudio **identificado en el catálogo** | Ayuno, ventana e indicaciones tal cual; "no requiere preparación" solo si el laboratorio lo declaró |

- Hasta **3 temas** por mensaje; cada sección se responde por separado. Lo que no tiene datos se declara: *«Sobre los horarios no tengo información disponible por ahora.»*
- **Si NADA tiene datos**, no hay respuesta con conocimiento y el bot responde como en G2.1.
- Los títulos y conectores son plantillas fijas (borradores a aprobar por el laboratorio) validadas sin cifras ni promesas; **todo número de una respuesta sale de un registro aprobado** (una prueba de «fact-check» lo verifica en cada respuesta).

### Identificación del estudio (preparación)
Solo por coincidencia **exacta** de palabras completas con el nombre normalizado o un alias aprobado de un estudio **activo** del catálogo. La frase más específica gana (`glucosa postprandial` sobre `glucosa`); un alias de más de un estudio es **ambiguo**. Sin un estudio identificado con certeza se **pregunta cuál es** (no se adivina). Máximo 5 estudios; cada uno por separado, **sin combinar** indicaciones («no puedo indicarte cómo combinarlas»). El catálogo se pide solo ante preguntas de preparación (caché de 5 min) y de él se usan id, nombre, alias y estado: nunca precios.

## 3. Lo que NO se responde con conocimiento
`MEDICAL` (síntomas, dosis, urgencias…), `HUMAN_REQUEST`, saludos y «cotizar»: **ni siquiera se consulta** el servicio (probado: cero llamadas `plusmedik_kb_*`). La derivación a una persona sigue **bloqueada** (G2.1). Las **imágenes** (recetas, cotizaciones) no cambian.

## 4. Trazabilidad (migración 9, nueva)
`20261028000000_plusmedik_knowledge_refs.sql` (preparada, **no aplicada**, probada solo en PostgreSQL efímero): tabla inmutable `plusmedik_turn_knowledge_refs` (turno, generación del lease, tipo, clave, versión, hash del contenido) y dos funciones.

| Función | Contrato |
| --- | --- |
| `plusmedik_turn_record_knowledge(run, owner, fence, refs)` | Con **owner + fence** (una ejecución antigua no deja rastro). **Solo antes de reservar el envío** (`closed` si ya se reservó): todo envío basado en conocimiento tiene su rastro primero. Idempotente. Cada intento deja sus propias referencias |
| `plusmedik_kb_usage(kind, key, version?, limit)` | «¿A qué turnos (seudónimos: corrida + clave de contacto) se les respondió con esta versión?» Solo cuenta turnos cuyo envío llegó a reservarse. Para decidir qué hacer si una versión resultó incorrecta |

**Regla de oro:** si el rastro no se puede registrar (base caída, `closed`, función ausente por migración sin aplicar), **no se envía la respuesta con datos**: se responde lo que correspondería sin conocimiento. No se guarda texto del paciente ni de la respuesta: solo códigos de conocimiento ya aprobado. Los logs llevan temas, estado y tipo/clave/versión (sin texto ni teléfono).

## 5. Concurrencia, idempotencia, pausa humana
- **Respuestas informativas = `stale: NONE`** (decisión nueva): una respuesta con datos **no se descarta** aunque llegue otro mensaje después, porque el paciente se quedaría sin la respuesta a su primera pregunta. Los envíos siguen sin solaparse (un envío en vuelo por contacto). Los avisos «no disponible» siguen siendo descartables.
- Duplicados: un mismo mensaje entregado varias veces → **una** respuesta y el rastro **una vez**. Ejecución colgada + otra que reclama el lease: responde la segunda con su propio rastro (generación 2); la primera no puede enviar.
- Pausa humana antes / durante / entre el rastro y el envío: no se envía y el turno **no consta como «dicho»** en la consulta de impacto.
- `busy` agotado, recuperación y base caída: sin cambios (ver G2.0/G2.1).

## 6. Activación (todo apagado)
`PLUSMEDIK_KNOWLEDGE_ANSWERS` (en blanco en `.env.example`) solo tiene efecto con `PLUSMEDIK_TURNS=on` **y** `PLUSMEDIK_TEXT_HANDLER=on`. Sin ellas el texto se ignora (probado sobre el módulo real de Vercel). El servicio se crea de forma **perezosa** (cargar el módulo no exige configuración). Con las banderas pero sin Supabase/clave de contacto: falla cerrado.

## 7. Archivos
Nuevos: `supabase/migrations/20261028000000_plusmedik_knowledge_refs.sql` · `src/knowledge-answers.ts` · `src/text-normalize.ts` · `tests/knowledge-answers.test.ts` · `tests/text-handler-knowledge.test.ts` · `tests/knowledge-answers-e2e.test.ts` · `tests/knowledge-refs-db.test.ts`.
Modificados: `src/text-handler.ts` (opción `knowledge`; ruta de G2.1 intacta como `baseReply`) · `src/turns.ts` (rastro antes de responder) · `src/guarded-turn.ts` (`persist` informa si se confirmó) · `src/audit.ts` (`recordKnowledgeRefs`) · `api/kapso/webhook.ts` y `.env.example` (bandera apagada) · pruebas de fronteras/defectos y el adaptador de pruebas.
