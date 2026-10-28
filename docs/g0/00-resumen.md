# G0 · Motor conversacional PlusMedik V2 — resumen

> **Errata (G1, 2026-10-24).** G0 afirmó que `feat/phase6-persistent-audit` no estaba fusionada. Es **incorrecto**: el PR #6 la fusionó en `origin/main` el 2026-10-22 (`dfa98da`) y G0 la comparó contra una referencia `origin/main` local desactualizada (no se había hecho `git fetch`). Las secciones afectadas están corregidas abajo y marcadas «(corregido en G1)». Estado real y verificado: [../g1/00-resumen.md](../g1/00-resumen.md).

Fecha de la auditoría: 2026-10-24. Alcance: solo auditar, diseñar y documentar. No se modificó código, no se tocó `CRM-PLUSMEDIK`, no se ejecutó SQL, no se enviaron mensajes ni se hicieron llamadas a modelos, no hubo push ni despliegue.

Documentos:

| Archivo | Contenido |
| --- | --- |
| [01-auditoria.md](01-auditoria.md) | Qué existe, en qué rama, qué se reutiliza y qué falta (tareas 1-3) |
| [02-diseno-conocimiento-y-cotizacion.md](02-diseno-conocimiento-y-cotizacion.md) | Políticas, horarios, preparación, catálogo; recetas y cotización con precios reales (tareas 4-5) |
| [03-diseno-handoff-crm-y-correcciones.md](03-diseno-handoff-crm-y-correcciones.md) | Casos no resueltos al CRM y reutilización de correcciones aprobadas (tarea 6) |
| [04-invariantes-y-roadmap.md](04-invariantes-y-roadmap.md) | Lo que no se puede romper y el roadmap G1-G7 (tareas 7-8) |

## Conclusiones

1. **El motor de recetas es sólido y es lo único "conversacional" que existe hoy.** `analyzeImage` (dos lectores + juez + señal de documento + catálogo + verificador + AUTO parcial) está completo y cubierto: 942 pruebas offline pasan en la rama actual. El motor se reutiliza tal cual; no hay que reconstruirlo.
2. **Todo lo demás del "motor conversacional" no existe.** El webhook procesa únicamente imágenes y descarta en silencio cualquier otro mensaje. No hay estado de conversación, ni intenciones, ni respuestas de texto, ni políticas, horarios, preparación de estudios, ni envío de casos al CRM. Nada de esto está en ninguna rama.
3. **(corregido en G1) Los mecanismos de seguridad que pidió conservar están en `origin/main`, pero dormidos:** el código se fusionó (PR #6) pero según el README las 5 migraciones no están aplicadas (el repositorio no permite confirmarlo) y el control humano está apagado por defecto. Sin migraciones el webhook degrada a la conducta del piloto (fail-open). Los README de `origin/main` siguen diciendo "migraciones NO aplicadas" y "función APAGADA por defecto", y la rama `feat/kapso-pilot` (checkout anterior) quedó atrasada.
4. **El CRM ya publicó los contratos del lado receptor** (revisión de recetas y control de atención). Están apagados y esperan que este repositorio implemente el lado emisor. Hay dependencias externas bloqueantes (ver §Riesgos).
5. **El precio real ya es correcto y seguro:** siempre `lab_tests.price_bs` (tarifa Paciente), nunca de un modelo. Lo que falta es contexto de cotización (preparación, vigencia, convenios), no el precio.

## Diseño en una frase por tarea

- **Conocimiento (T4):** tablas propias del agente `plusmedik_kb_*` y `plusmedik_study_prep`, versionadas e inmutables, con estado `APPROVED` solo tras aprobación del laboratorio. Las respuestas salen de plantillas aprobadas con datos del registro; el modelo clasifica la intención pero no redacta hechos. Sin respuesta aprobada → persona. *Ausencia de dato nunca se presenta como "sin preparación".*
- **Recetas y cotización (T5):** el motor actual no cambia. Se agrega: acumulación por sesión de varias imágenes, cotización desde texto reutilizando el verificador semántico, preparación consolidada adjunta a la cotización, y huella de catálogo/precio en cada cotización emitida.
- **Handoff al CRM (T6):** outbox transaccional en la base del agente + emisor idempotente hacia `POST /api/internal/agent/review-case` (contrato del CRM), con reintento del mismo `eventId` ante `409 message_not_ingested`. La promesa al paciente ("un asesor revisará") solo se envía cuando el caso quedó guardado de forma durable.
- **Correcciones (T6):** las correcciones aprobadas **no** entrenan nada ni cambian prompts. Se promueven, con aprobación del laboratorio, a `lab_test_aliases` (el mecanismo de "decisión del laboratorio" que el verificador ya respeta) y a una batería de regresión sin datos personales.
- **Invariantes (T7):** lista cerrada de 14 en [04](04-invariantes-y-roadmap.md); cualquier fase que los debilite se rechaza.
- **Roadmap (T8):** G1 convergencia → G2 turnos → G3 conocimiento → G4 cotización v2 → G5 handoff CRM → G6 correcciones → G7 piloto endurecido.

## Decisiones que necesito del dueño del proyecto

Las fases no pueden arrancar bien sin estas respuestas; las marcadas ★ bloquean G1/G2.

1. ★ **(resuelta en G1) Rama base.** `origin/main` (`dfa98da`) ya contiene phase6. Pendiente de confirmar por el dueño: cuál es el despliegue de producción del proyecto de Vercel (el repositorio solo muestra que `dfa98da` compiló con éxito).
2. ★ **Manuscritas en producción.** `api/kapso/webhook.ts` pasa `handwrittenAuto: "on"`, aunque el README dice "no activar sin validar". ¿Está autorizado explícitamente?
3. ★ **Entorno Supabase de ensayo.** Las migraciones deben ensayarse primero en un branch/staging; ¿existe y quién lo autoriza?
4. **Dueño y fuente del conocimiento.** ¿Quién del laboratorio aprueba políticas, horarios y preparación, y en qué formato entrega los datos (hoy no hay ninguno en el repositorio)? ¿Se edita luego desde el CRM (cambio fuera de este repo) o por carga controlada?
5. **Texto al paciente cuando el caso pasa a revisión humana** y qué se promete fuera del horario de atención humana.
6. **Privacidad del outbox.** El handoff necesita el texto de los estudios leídos; la auditoría actual lo excluye a propósito. ¿Se permite retenerlo cifrado, con vencimiento corto (propuesta: 7 días)?
7. **Planificador.** Los reintentos necesitan un cron; según el README el plan Hobby de Vercel solo permite ejecución diaria. ¿Qué plan/servicio se usa?
8. **Convenios por WhatsApp.** ¿Un paciente de convenio recibe tarifa de su organización (existe en la rama del portal, sin aplicar) o siempre Paciente? Requiere mapear contacto → organización.
9. **Fuente de verdad de la cotización:** ¿el agente solo informa y el CRM guarda (`crm.quotes`), o el agente emite folio propio? El CRM dice que esto "requerirá su propio contrato".
10. **PDF y audio.** ¿Se aceptan recetas en PDF y notas de voz, o solo imágenes?
11. **Mensajes enviados desde el CRM por la API de Kapso** llegan con `origin: cloud_api` y el agente los clasifica como "bot propio" (no pausa). ¿El CRM llamará a la pausa antes de responder manualmente (contrato `attention/action`)?
12. **Presupuesto de pruebas reales.** El último registro (4C) dejó el gasto nuevo en US$1,5894 sobre un tope de US$1,50: cualquier validación con modelos reales exige nueva autorización y tope.

## Riesgos principales

| Riesgo | Efecto | Mitigación en el diseño |
| --- | --- | --- |
| (corregido en G1) Base de idempotencia fusionada pero con migraciones sin aplicar | Sin migraciones el webhook responde como el piloto (sin deduplicación ni pausa). Activar `REQUIRE_AUDIT_GUARD` o el control humano **antes** de las migraciones silencia al bot para todos | Aplicar las 5 migraciones primero (staging → producción) y recién después activar las banderas; ver [../g1/](../g1/) |
| El CRM aún no ingiere mensajes (webhook propio sin registrar; coexistencia con Kapso sin verificar) | Todo handoff recibe `409 message_not_ingested` | Outbox con reintentos acotados y alerta; G5 no se activa hasta que el CRM ingiera |
| Mensajes del CRM no pausan la IA (origen `cloud_api`) | La IA y una recepcionista responden a la vez | Contrato `attention/action` del CRM antes de que el CRM envíe |
| Datos de conocimiento inexistentes | El agente tendría que inventar horarios/preparación | Plantillas solo con registros `APPROVED`; sin dato → persona |
| Todo mensaje que no es imagen se ignora hoy | Paciente escribe y no recibe nada | G2 prioriza un acuse mínimo y la derivación a persona |
| Costo por receta (varias llamadas, ~US$0,034 esperado) sin límite por contacto | Abuso o gasto inesperado si se abre más allá de `ALLOWED_PHONES` | Límites por contacto y presupuesto diario en G7, antes de abrir el piloto |
