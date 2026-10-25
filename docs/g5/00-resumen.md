# G5.0 · Derivación segura de casos al CRM — resumen

Fecha: 2026-10-25. Rama `feat/g2-turnos` (worktree `plus-medik-v2-g2`), **sin commit, sin push, sin merge**. Todo local y offline; **no se activó ninguna bandera**. No se tocó `CRM-PLUSMEDIK`, Supabase real ni Kapso, y no se llamó a ningún modelo.

| Documento | Contenido |
| --- | --- |
| [10-g50-derivacion-segura-al-crm.md](10-g50-derivacion-segura-al-crm.md) | Auditoría del contrato con el CRM, contratos faltantes, reglas de oro, flujo, datos, archivos |
| [11-g50-bloqueos-y-activacion.md](11-g50-bloqueos-y-activacion.md) | Resultados de pruebas y mutación, bloqueos, riesgos y condiciones de activación |
| [20-g51-aplicacion-de-migraciones.md](20-g51-aplicacion-de-migraciones.md) | G5.1: preparación y procedimiento manual para aplicar las 13 migraciones (orden, dependencias, riesgos, bloqueos, verificaciones de solo lectura en `supabase/preflight/`) |

## En una frase
Los casos que necesitan a una persona (receta ambigua o ilegible, estudio sin resolver, consulta médica o sin respuesta aprobada, petición explícita) se guardan en una **cola de salida persistente e idempotente** y se entregan al receptor que el CRM ya tiene, con reintentos acotados y manejo de `409`; el paciente solo recibe «una persona del equipo te escribirá» **cuando el CRM ya registró el caso**. Apagado por defecto; el motor de recetas no cambió.
