# G4.2 — Preparación aprobada en el mismo mensaje de cotización

Implementación aislada en `feat/quote-approved-preparations`. **Desactivada por defecto** y sin cambios a `lab_tests`, precios, matching, migraciones, datos clínicos ni despliegue.

## Flujo
1. El motor existente identifica los estudios de una receta (foto) o de una lista escrita (sesión de cotización).
2. La cotización se calcula exactamente como antes, con precios vigentes de `lab_tests`.
3. Solo si `PLUSMEDIK_QUOTE_PREPARATIONS=on`, se consultan las preparaciones mediante `KnowledgeService.getStudyPreparation`, que entrega únicamente versiones `APPROVED`, vigentes, con contenido válido, de estudios activos.
4. Solo para **UUID realmente cotizados**, y como máximo **5 estudios**, se añaden en el **mismo mensaje** indicaciones clínicas que ya aprobó el laboratorio. No se consulta OpenAI para esta tarea.
5. Se pueden agrupar estudios solo cuando el texto de preparación es **exactamente el mismo**. No se suman horas de ayuno ni se deduce una combinación clínica. Si existen indicaciones diferentes se muestran separadas y se informa que deben confirmar la combinación con el laboratorio.
6. Si uno o más estudios no tienen preparación aprobada, no se inventan instrucciones ni se declara que no requieren preparación. Se listan únicamente las aprobadas y se avisa que las demás no están confirmadas.
7. Antes de reservar el envío, se graban las referencias de todas las versiones clínicas mostradas mediante `recordKnowledgeRefs` con el lease del turno. Si falla la lectura, la trazabilidad, la lista supera 5 estudios o se excede la longitud máxima sin truncar, **la cotización normal se envía intacta**.

## Configuración y requisitos
- `PLUSMEDIK_QUOTE_PREPARATIONS=on` en entorno de prueba, inicialmente con teléfonos piloto.
- Exige además `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_TEXT_HANDLER=on`, `PLUSMEDIK_KNOWLEDGE_ANSWERS=on` y `PLUSMEDIK_REPLY_GUARD=on` válida.
- Exige migraciones y funciones de conocimiento y auditoría existentes; **no añade migraciones**.
- Si los 470 requisitos siguen en estado `DRAFT`, **ninguno se anexa**. No se publican ni se aprueban automáticamente.
- Los 74 sin preparación y los estudios de revisión clínica quedan intactos. Los precios nunca proceden del texto clínico.

## Alcance
- Cotización inmediata por fotografía, sin sesiones.
- Cotización al cerrar sesión de texto y/o varias fotografías; también el caso de replay, sin duplicar textos.
- No modifica la detección de nombres, alias, matching semántico, reglas de cotización parcial, CRM, ChatGPT, ni el formato original de los precios.
- No altera el tratamiento de preguntas de preparación: el usuario puede seguir consultándola explícitamente, siempre con conocimiento aprobado.

## Verificación pendiente antes de activar
- Ejecutar `npm run check` sobre esta rama, probar con Supabase/Kapso de ensayo y verificar el rastro de conocimiento asociado al turno.
- Probar citas con 0, 1, 2 y 6 preparaciones aprobadas; igualdad estricta frente a diferencias; reversión, caducidad e inactividad; fallo de la base o de la auditoría.
- Confirmar con el laboratorio el texto del aviso y el formato final. Nunca activar automáticamente en producción.
