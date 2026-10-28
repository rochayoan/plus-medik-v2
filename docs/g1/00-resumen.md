# G1 · Convergencia y consolidación — resumen

Fecha: 2026-10-24. Rama de integración: `integration/g1-consolidacion` (worktree `C:\Users\yoanm\Proyectos-Smarky\plus-medik-v2-g1`), basada en `origin/main` (`dfa98da`), sin cambios de código.

| Documento | Contenido |
| --- | --- |
| [01-estado-git-y-despliegue.md](01-estado-git-y-despliegue.md) | Ramas, cambios sin commit (respaldados y comparados), despliegue en Vercel, comportamiento de `main` según la configuración |
| [02-migraciones-y-pruebas.md](02-migraciones-y-pruebas.md) | Resultado de las pruebas offline, inventario y riesgos de las 5 migraciones, procedimiento de aplicación |
| [03-atencion-humana-crm.md](03-atencion-humana-crm.md) | Contrato con el CRM y cómo evitar respuestas automáticas cuando una recepcionista asume la conversación |
| [04-infraestructura-y-siguiente-paso.md](04-infraestructura-y-siguiente-paso.md) | Infraestructura reutilizable, riesgos, recomendación y primer paso de G2 |

## Lo más importante

1. **Corrección de G0.** Phase 6 **ya está fusionada en `origin/main`** (PR #6, 2026-10-22). G0 la dio por no fusionada porque se comparó contra un `origin/main` sin actualizar. No hay nada que fusionar: el árbol de `origin/main` es idéntico al de `feat/phase6-persistent-audit`.
2. **Los cambios sin commit del checkout viejo eran redundantes**: están todos en `main` (comparados línea por línea). Quedaron respaldados de todos modos.
3. **Las pruebas pasan.** Instalación limpia en un worktree aislado, `tsc` sin errores y **52 archivos / 1347 pruebas en verde**, incluidas las de PostgreSQL real (efímero) para auditoría, leases, recuperación y pausa humana. Cero llamadas a servicios, cero omitidas.
4. **El código está desplegado, pero la protección no opera hasta aplicar las migraciones.** Sin ellas el webhook responde como el piloto (verificado con una simulación): no hay deduplicación, lease ni pausa. Y activar `REQUIRE_AUDIT_GUARD` o el control humano **antes** de las migraciones silencia al bot para todos.
5. **Hay dos brechas reales en la atención humana**: (a) los mensajes enviados desde el CRM tienen `origin: cloud_api` y no pausan al agente; (b) el README manda registrar el webhook de Kapso "para mensajes entrantes": la pausa humana necesita también los salientes, y no está confirmado que los reciba.
6. **Despliegue en Vercel: no determinable con certeza.** Evidencia: `dfa98da` compiló con éxito el 2026-10-22 04:22Z y es el último de `main`. Falta que el dueño confirme cuál es el despliegue de producción y qué variables tiene.

## Lo que se hizo (por tarea)

| # | Tarea | Resultado |
| --- | --- | --- |
| 1 | Inspeccionar ramas | Hecho tras `git fetch`: [01 §1](01-estado-git-y-despliegue.md) |
| 2 | Despliegue de Vercel | Evidencia reunida; **no concluyente**: [01 §4](01-estado-git-y-despliegue.md) |
| 3 | Proteger cambios sin commit | Rama `backup/g1-uncommitted-kapso-pilot` + patch con hash; árbol de trabajo intacto |
| 4 | Comparar duplicados | `uncertainty`, `partial-auto`, `whatsapp-quote`: **ya en `main`**; sin conflictos |
| 5 | Revisar las 5 migraciones | Inventario, dependencias y 8 hallazgos: [02 §2](02-migraciones-y-pruebas.md) |
| 6 | Pruebas offline de Phase 6 | 1347/1347 con PostgreSQL real: [02 §1](02-migraciones-y-pruebas.md) |
| 7 | ¿Se puede consolidar? | Ya consolidada; ver veredicto abajo |
| 8 | Rama de integración | `integration/g1-consolidacion` preparada (docs, sin commit) |
| 9 | Reutilizar mecanismos | Sin reescribir nada; estado en [04](04-infraestructura-y-siguiente-paso.md) |
| 10 | Mantener la interpretación de recetas | Cero cambios en `src/`; ninguna regla tocada |
| 11 | Contrato de atención humana con el CRM | [03](03-atencion-humana-crm.md) |
| 12 | Documentar | Estos documentos + errata en `docs/g0/` |

## Veredicto (tarea 7)

- **Código: consolidado y verificado.** No hay conflictos técnicos que resolver; los únicos "conflictos" eran ramas locales atrasadas y un árbol sin commit ya contenido en `main`.
- **Operación: pendiente.** Consolidar ahora significa *activar con orden*, no fusionar: confirmar despliegue → ensayar migraciones en staging → aplicarlas → activar `REQUIRE_AUDIT_GUARD` → activar control humano para números de prueba.
- **Condiciones para activar el control humano en producción** (no se activó nada): migraciones aplicadas, clave HMAC dedicada, suscripción de eventos salientes confirmada en Kapso, L1 del CRM implementada (ver [03](03-atencion-humana-crm.md)).

## Qué necesito del dueño (para pasar a G2)

1. Confirmar en Vercel: despliegue de producción (commit), rama de producción y variables (`ALLOWED_PHONES`, y que `PLUSMEDIK_HUMAN_CONTROL`, `REQUIRE_AUDIT_GUARD`, `CATALOG_*` **no** estén definidas).
2. Autorizar (o no) un Supabase de ensayo para aplicar las 5 migraciones y validar las RPC por HTTP.
3. Confirmar si el webhook de Kapso recibe eventos salientes.
4. Confirmar `handwrittenAuto: "on"` en el webhook (pendiente desde G0).
5. Indicar si quiere que se haga commit de `docs/` en `integration/g1-consolidacion` (y si luego se abre un PR solo de documentación). **No se hizo ningún commit.**
6. Presupuesto de pruebas con modelos reales (el último registro superó el tope): G1 no necesitó ninguna.
