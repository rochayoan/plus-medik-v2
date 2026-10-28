# G4.0 · Base de cotización conversacional V2 — resumen

Fecha: 2026-10-24. Rama `feat/g2-turnos` (worktree `plus-medik-v2-g2`), **sin commit, sin push, sin merge**. Todo local y offline; **no se activó ninguna bandera**. No se tocó `CRM-PLUSMEDIK`, Supabase real ni Kapso, y no se llamó a ningún modelo.

| Documento | Contenido |
| --- | --- |
| [10-g40-cotizacion-conversacional.md](10-g40-cotizacion-conversacional.md) | Diseño: sesiones por contacto, reglas de oro, datos, activación, archivos |
| [11-g40-bloqueos-y-activacion.md](11-g40-bloqueos-y-activacion.md) | Resultados de pruebas, mutación, fragilidad de `turns-e2e`, riesgos, bloqueos y condiciones de activación |

## En una frase
Varias fotos y textos de un contacto se juntan en una **sesión** y se cotizan **una sola vez**, cuando el paciente escribe «listo», con los estudios y precios de `lab_tests` **de ese instante**; lo ambiguo, incompleto o incierto **no recibe precio** y queda en una **cola de revisión** para el futuro flujo humano. Apagado por defecto; el flujo de recetas de una foto sola no cambió.

## G5.0 (continuación)
Derivación segura de casos al CRM mediante una cola de salida idempotente, apagada por defecto, migración 13. Ver [../g5/00-resumen.md](../g5/00-resumen.md).

## G4.1 (continuación)
Requisitos del paciente y tiempos de entrega por estudio (plazo en horas o días, tipo de muestra y requisitos), solo con datos **aprobados**, **apagado por defecto** (`PLUSMEDIK_STUDY_INFO`), migración 12. Ver [12-g41-requisitos-y-tiempos-de-entrega.md](12-g41-requisitos-y-tiempos-de-entrega.md) y [13-g41-bloqueos-y-activacion.md](13-g41-bloqueos-y-activacion.md).
