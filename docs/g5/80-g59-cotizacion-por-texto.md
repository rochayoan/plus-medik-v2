# G5.9 · Cotización por texto (lista clara, acumulación y aclaraciones)

Fecha: 2026-10-26. **Sin SQL remoto, sin llamadas a OpenAI, sin tocar el CRM, Supabase real ni Kapso, sin commit, push ni despliegue.** Todo es local y sigue **apagado por defecto** (no hay banderas nuevas: vive dentro de `PLUSMEDIK_QUOTE_SESSIONS`, que ya exige turnos y manejador de texto).

Parte de la cotización por texto de G4.0 (`src/quote-session.ts`, `src/quote-session-turns.ts`): reutiliza la sesión por contacto, el resolvedor exacto del catálogo, el cierre verificado por la base y la cola de revisión. **No se tocó el flujo de fotografías** (`sessionImageProducer`, el motor de recetas y sus acuses siguen idénticos).

## 1. Qué hace ahora un mensaje de texto

| El paciente escribe | El agente |
| --- | --- |
| Una lista **clara** (todo identificado) **y pide cotizar** o el precio: «cotízame hemograma y glucosa», «¿cuánto cuesta el hemograma?» | Anota el mensaje y **cotiza en ese mismo turno**, junto con lo que la solicitud ya tuviera acumulado (fotos y mensajes anteriores). No exige «LISTO» |
| Estudios **sin pedir cotizar** («hemograma, glucosa», «y también TSH») | Los **acumula**, lista lo anotado hasta ahora y pregunta «¿Eso es todo?». **SÍ** (o «dale», «ok», «eso es todo»…) cotiza; «LISTO», «cotiza» y «¿cuánto es en total?» también |
| Un nombre que corresponde a **varios estudios** del catálogo («creatinina») | **Pregunta** con las opciones del catálogo, numeradas. Se aclara con el número («2», «el segundo») o escribiendo el nombre exacto. Nunca elige por su cuenta |
| Algo que **no se identifica** | Pide el nombre exacto o una foto; no cotiza a medias. Si el paciente escribe «LISTO», el caso queda en revisión (cola → CRM) como en G4.0 |
| «no», «todavía no», «espera» | Sigue esperando lo que falte |
| Una **pregunta general** («¿qué es el hemograma?», «¿para qué sirve la glucosa?») | No es una lista: la atiende el manejador de siempre (y, con la capa conversacional activa, el prompt de `src/system-prompt.ts`) |
| Preparación, ayuno, muestra, plazos, médico, «quiero hablar con una persona», horarios… | Siguen su camino de siempre (datos aprobados de Supabase, aviso médico, derivación por el backend/CRM). Nunca entran a la sesión |
| Después de cotizar: cualquier otra cosa | La conversación sigue. Un estudio nuevo abre **otra** solicitud (no arrastra la anterior) |

Sin «LISTO» el agente **nunca** manda un caso a revisión por iniciativa propia: ante una duda pregunta. Solo lo que el paciente no puede arreglar escribiendo (un estudio retirado del catálogo, un precio inválido) se cierra como revisión.

## 2. Nombres habituales, abreviaturas y sinónimos
`src/study-synonyms.ts` es una lista de **grupos de frases** («bh» = «biometría hemática» = «hemograma» = «hemograma completo»; «glicemia» = «glucemia» = «glucosa»…). No contiene ids, precios ni estudios: son frases para **buscar** en el catálogo.
- Cada frase se busca con el **mismo resolvedor exacto** del motor (nombre o alias aprobado de un estudio **activo** de `lab_tests`). Lo que el catálogo no tiene, no se reconoce ni se inventa.
- Si las frases de un grupo llegan a estudios **distintos** del catálogo (p. ej. «hemograma» y «hemograma completo» son dos estudios), es **ambiguo** y se pregunta.
- Lo que el catálogo tiene tal cual gana a cualquier sinónimo.
- Una línea sin separadores («hemograma glucosa tsh») se divide en los nombres del catálogo (el más largo primero) **solo si toda la línea queda cubierta**; si sobra una palabra que no es relleno, no se adivina nada. Viñetas y numeración («1.», «-») no estorban. Frases generales («unos análisis») no abren una solicitud.
- La lista es una **semilla de abreviaturas estándar**; la forma correcta de ampliarla es con alias aprobados en el catálogo (`lab_test_aliases`), que el resolvedor ya usa.

## 3. Garantías que se conservan
- **Precios y estudios solo de `lab_tests`**: se leen del catálogo **recargado al cerrar**; la base rechaza (PT409) una cotización que no sea exactamente lo identificado.
- **Una ambigüedad aclarada** (migración 14): un grupo queda aclarado cuando un mensaje de **texto posterior**, ya identificado con certeza, trae una de sus opciones. Una respuesta anterior a la pregunta, una foto, la opción de otro grupo o un mensaje dudoso **no** aclaran. Sin aclarar sigue bloqueando la cotización, en el TS y en la base.
- **El modelo no interviene**: no hay llamadas a OpenAI en este flujo. Los precios, requisitos clínicos y derivaciones conservan los controles del backend.
- Idempotencia por mensaje (un reintento repite la misma cotización guardada), pausa humana, guarda antibucles (las preguntas llevan firma `QUOTE_ASK:<n>`, las confirmaciones `QUOTE_ADDED:<n>`), privacidad (no se guarda texto del paciente; las preguntas muestran nombres del catálogo, nunca lo que escribió).
- Las respuestas nuevas son **borradores sin cifras ni importes ni promesas a una persona** (`assertSafeQuoteTexts`); están listadas en `agent-config/textos-a-aprobar.md`.

## 4. Migración 14 (`20261102000000_plusmedik_quote_text_flow.sql`, local, **no aplicada**)
Aditiva: una función de apoyo (`plusmedik_quote_ambiguity_state`) y el reemplazo de `plusmedik_quote_session_read` y `plusmedik_quote_session_close`. Sin tablas, columnas ni datos. Cambios: (1) el turno que cierra **cuenta su propio ítem** (antes solo los anteriores; para el «listo» de siempre no hay ítem propio y nada cambia); (2) la regla de ambigüedad aclarada. Si la sesión pide reenviar fotos, el ítem legible del propio turno pasa a la solicitud nueva. Sin esta migración la cotización por texto de G4.0 funciona como antes, pero un mensaje que pide cotizar **no** puede cerrar en el mismo turno (la base lo rechazaría).
Hay que sumarla al plan de G5.1: son **14** migraciones; `docs/g5/20` y los SQL de verificación (`supabase/preflight`) se regeneraron.

## 5. Archivos
Nuevos: `src/study-synonyms.ts` · `supabase/migrations/20261102000000_plusmedik_quote_text_flow.sql` · este documento.
Modificados: `src/quote-session.ts` (extracción con sinónimos y listas, resumen/aclaraciones, respuestas cortas, textos) · `src/quote-session-turns.ts` (el productor de texto) · `src/text-handler.ts` (`asksForPrice`) · `src/system-prompt.ts` (la regla de cotizar) · `scripts/agent-config.ts` y `agent-config/textos-a-aprobar.md` · `supabase/preflight/*` y `docs/g5/20` · pruebas.

## 6. Pruebas
`quote-session` (137), `quote-session-turns` (44), `quote-session-boundaries` (12), `quote-session-db` (72, contra PostgreSQL 18 efímero con las 14 migraciones) y `quote-session-e2e` (38: webhook real + manejador real + repositorios reales). Ninguna llama a OpenAI, a Kapso ni a un Supabase remoto.

## 7. Pendiente
- Aplicar la migración 14 junto con las demás (sigue el procedimiento de `docs/g5/20`) y probar en un entorno de ensayo con Kapso/Supabase de pruebas.
- **El clasificador trata «sangre» como tema médico** (`sangr…`): «glucosa en sangre» o «examen de sangre» salen por el aviso médico y no llegan a la cotización. Es una regla de seguridad existente; afinarla es una decisión del laboratorio.
- Las abreviaturas de `study-synonyms.ts` deben ser revisadas por el laboratorio; lo ideal es mover lo aprobado a alias de `lab_tests`.
- Los textos fijos de la ruta determinista (`DRAFT_TEXTS`, p. ej. «envíame una foto de tu receta») no mencionan aún la opción de escribir los estudios; quedan por aprobar.
- «Sí» cierra la solicitud abierta aunque el agente no hubiera hecho la pregunta en ese momento (la solicitud vence a los 30 minutos sin actividad). Un «sí» sin solicitud abierta es un mensaje cualquiera.
- Después de cotizar, un estudio nuevo abre otra solicitud: no se suma a la cotización anterior (no hay «cotización combinada»).
- No se cubren cantidades («2 hemogramas»), ni errores de tipeo (el resolvedor es exacto, por diseño).
