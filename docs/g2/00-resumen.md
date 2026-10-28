# G2.0 · Base del motor conversacional — resumen

Fecha: 2026-10-24. Rama `feat/g2-turnos` (worktree `C:\Users\yoanm\Proyectos-Smarky\plus-medik-v2-g2`), creada desde `origin/main` (`dfa98da`). **Sin commit, sin push, sin merge.** No se tocó `CRM-PLUSMEDIK`, ni el checkout `plus-medik-v2` (8 cambios sin commit intactos), ni el respaldo `backup/g1-uncommitted-kapso-pilot`, ni la rama `integration/g1-consolidacion`.

| Documento | Contenido |
| --- | --- |
| [01-contratos-y-decisiones.md](01-contratos-y-decisiones.md) | Modelo, garantías, contrato SQL y TypeScript, decisiones y alternativas, límites |
| [02-pruebas-y-bloqueos.md](02-pruebas-y-bloqueos.md) | Resultados, mecanismos reutilizados, riesgos, bloqueos y condiciones para G2.1 |

## Qué se construyó

La coordinación para que **texto, imagen y mensajes consecutivos de un mismo contacto** se procesen con las garantías que Phase 6 ya daba a las imágenes, sin reconstruir nada:

- **Un turno es una corrida de auditoría.** Hereda claim idempotente, lease con fencing, reserva de envío, comprobación final, recuperación y pausa humana.
- **Migración 6 (preparada, no aplicada):** numeración de turnos por contacto, **un solo envío en vuelo por contacto** (`busy`), descarte de **respuestas obsoletas** (`superseded`) y el tipo de envío `conversation`. Dos funciones envolventes llaman a las existentes; las dos únicas funciones redefinidas difieren de las originales solo en el nuevo tipo (comprobado texto a texto).
- **Código:** la máquina `claim → trabajo → reserva → comprobación final → Kapso → resultado` se extrajo a `guarded-turn.ts` sin cambiar su comportamiento; `turns.ts` clasifica y ordena los mensajes y ejecuta los claims de un lote uno por uno y el trabajo en paralelo; el webhook usa todo esto **solo si** el modo turnos está configurado.
- **Todo apagado:** `PLUSMEDIK_TURNS` (en blanco por defecto). Aun encendida, **no hay manejadores de conversación**: el texto y los demás mensajes se siguen ignorando y solo las imágenes pasan por la coordinación. Nada responde a texto todavía.

## Resultado

- `tsc` sin errores; **55 archivos / 1430 pruebas en verde**: las 1347 de G1 sin regresión + 83 nuevas (31 de SQL real, 31 de coordinación, 21 de extremo a extremo con PostgreSQL real). Repetidas dos veces: estables. Prueba de mutación: desactivar la regla de "un envío en vuelo" hace fallar 4 pruebas.
- Motor de recetas y precios: **cero cambios** (comprobado con `git diff`); recetas manuscritas: sin cambios.
- Cero llamadas a servicios; la migración se probó **solo** en PostgreSQL efímero.

## Archivos

Modificados: `src/audit.ts` · `src/whatsapp-quote.ts` · `src/kapso-webhook.ts` · `api/kapso/webhook.ts` · `.env.example` · `tests/audit-transactional.test.ts` y `tests/human-control.test.ts` (ajuste posicional de la lista de migraciones) · `tests/support/postgrest-over-psql.ts`.
Nuevos: `src/guarded-turn.ts` · `src/turns.ts` · `supabase/migrations/20261025000000_plusmedik_turns.sql` · `tests/turns.test.ts` · `tests/turns-db.test.ts` · `tests/turns-e2e.test.ts` · `docs/g2/` (y copia de `docs/g0`, `docs/g1` para los enlaces).

## Lo que debes saber antes de G2.1

1. La migración 6 es la **sexta sin aplicar**: producción sigue sin deduplicación/lease/pausa hasta aplicar las cinco de Phase 6 (hallazgo de G1, sin cambios).
2. `busy` es una espera **acotada** (8 × 1,5 s): si no se libera, el turno no responde y queda recuperable. Es un límite deliberado y documentado.
3. La obsolescencia descarta respuestas **solo** cuando un turno más nuevo ya reservó o envió la suya; las cotizaciones nunca se descartan.
4. Las condiciones exactas para G2.1 están en [02 §5](02-pruebas-y-bloqueos.md).
