# G3.0 · Base de conocimiento del laboratorio — resumen

Fecha: 2026-10-24. Rama `feat/g2-turnos` (worktree `plus-medik-v2-g2`), **sin commit, sin push, sin merge**. Todo local y offline; **no se activó ninguna bandera** y no se agregó ninguna variable de entorno. No se tocó `CRM-PLUSMEDIK`, el motor de recetas, el webhook, los turnos ni el manejador de texto.

| Documento | Contenido |
| --- | --- |
| [01-arquitectura-y-modelo.md](01-arquitectura-y-modelo.md) | Principios, entidades, estados, permisos, consulta, caché/invalidación/recuperación, decisiones |
| [02-contrato-crm.md](02-contrato-crm.md) | Contrato de administración desde el CRM (funciones, roles, errores, pantallas, qué autorizar) |
| [03-informacion-del-laboratorio.md](03-informacion-del-laboratorio.md) | Qué debemos obtener del laboratorio (gobierno, datos administrativos, preparación clínica) |
| [04-pruebas-riesgos-y-g31.md](04-pruebas-riesgos-y-g31.md) | Resultados, mutación, riesgos y condiciones para G3.1 |

## Qué se construyó

- **Migración 8** `20261027000000_plusmedik_knowledge.sql` (preparada, **no aplicada**, probada solo en PostgreSQL efímero): 4 tablas (`documents`, `versions`, `events`, `state`) y 11 funciones. **No siembra ningún dato.** Estados `DRAFT → PENDING_APPROVAL → APPROVED → INACTIVE`; una versión aprobada y una abierta por elemento; bitácora inmutable; contador de revisión transaccional; instantánea consistente.
- **Seis tipos** con contenido de lista blanca: sucursal, horario, política, método de pago, pregunta frecuente y **preparación de estudios** (clínica, vinculada a `lab_tests.id`).
- **Reglas en la base**: la IA solo redacta borradores administrativos propios y nunca envía/aprueba; lo clínico solo lo aprueba un aprobador clínico; cuatro ojos; caducidad obligatoria (≤ 400 días); ningún texto puede mencionar un importe; "sin preparación" es una afirmación explícita, nunca la ausencia de dato.
- **Código** (`src/knowledge/`): `KnowledgeService` de **solo lectura** con resultado estructurado `AVAILABLE | UNAVAILABLE{reason}`, procedencia por respuesta, horarios con zona horaria y excepciones, caché con invalidación por revisión y falla cerrado; cliente de **administración** de referencia para el CRM (que el agente no importa).

## Resultado

`tsc` limpio; **64 archivos / 1600 pruebas en verde** (las 1505 previas sin cambios + 95 nuevas). Cinco mutaciones de reglas críticas fueron detectadas. Prueba diferencial: el validador SQL y el de TypeScript coinciden en 55 contenidos.

## Archivos

Nuevos: `supabase/migrations/20261027000000_plusmedik_knowledge.sql` · `src/knowledge/{types,schedule,store,service,admin,index}.ts` · `tests/knowledge-{db,service,e2e,boundaries}.test.ts` · `tests/support/knowledge-fixtures.ts` · `docs/g3/`.
Modificado (solo soporte de pruebas): `tests/support/postgrest-over-psql.ts` (acepta las funciones `plusmedik_kb_*` y sus parámetros).

## Lo más importante para decidir

1. **Gobierno**: ¿quién será aprobador administrativo y aprobador clínico? Con una sola persona autorizada no se puede aprobar lo propio.
2. **Datos**: el repositorio no tiene ninguno; sin ellos todo es "no disponible". La lista de lo que hay que pedir está en [03](03-informacion-del-laboratorio.md).
3. **Quién administra**: el CRM (fase propia, [02](02-contrato-crm.md)) o un script de carga de borradores. La base no autentica personas: conviene una credencial/rol distinto para quien administra.
4. Nada de esto responde a pacientes todavía: G3.0 no conecta el conocimiento al manejador (G3.1).

## G3.1A (continuación)
El conocimiento aprobado se conectó al manejador de texto, **apagado por defecto** (`PLUSMEDIK_KNOWLEDGE_ANSWERS`), con trazabilidad en la migración 9. Ver [10-g31a-respuestas-con-conocimiento.md](10-g31a-respuestas-con-conocimiento.md) y [11-g31a-bloqueos-y-activacion.md](11-g31a-bloqueos-y-activacion.md).

## G3.2 (continuación)
Protección contra bucles y exceso de respuestas, **apagada por defecto** (`PLUSMEDIK_REPLY_GUARD`), con la migración 10. Ver [12-g32-proteccion-contra-bucles.md](12-g32-proteccion-contra-bucles.md) y [13-g32-bloqueos-y-activacion.md](13-g32-bloqueos-y-activacion.md).
