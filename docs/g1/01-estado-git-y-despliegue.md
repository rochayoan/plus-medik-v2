# G1 · 01 Estado de Git, cambios sin commit y despliegue

Fecha: 2026-10-24. Se hizo `git fetch --all --prune` (solo lectura de GitHub) antes de comparar. **G0 comparó contra un `origin/main` sin actualizar y por eso concluyó, erróneamente, que phase6 no estaba fusionada** (errata en [../g0/00-resumen.md](../g0/00-resumen.md)).

## 1. Ramas

| Referencia | Commit | Relación con `origin/main` (`dfa98da`) |
| --- | --- | --- |
| `origin/main` | `dfa98da` — "Merge F0-F2.1 audit and human-control groundwork into main" (2026-10-22 00:21 -04, PR #6) | — |
| `feat/phase6-persistent-audit` | `31b9079` | **Ancestro de `origin/main`**: fusionada por el PR #6. El árbol de `origin/main` es idéntico al de esa rama (`git diff` vacío) |
| `feat/kapso-pilot` (checkout `plus-medik-v2`) | `a57b9a8` | 16 commits detrás, 0 adelante (fusionada por los PR #1-#4) |
| `main` local | `95298a6` | 20 detrás, 0 adelante. **No se tocó** |
| `integration/fase5-cierre` | `30e8985` | 8 detrás, 0 adelante (PR #5) |
| `fix/allow-symbol-marks-in-inheritance` | `cad8ac4` | todo su contenido ya está en `origin/main` |
| `fix/fase5-variant-mismatch-original-reads` | `9aae6df` | 2 commits propios por hash, pero `git cherry` los marca **equivalentes** a commits de `origin/main` (rehechos en `integration/fase5-cierre`) |
| `origin/feat/portal-cotizacion-web` | `95c9783` | **2 commits sin equivalente** (`39f2ca8`, `95c9783`): portal web, producto aparte; no entra en G1 |

Conclusión: **no hay nada que fusionar**. El código de idempotencia, concurrencia, auditoría y pausa humana ya es parte de `main`. Las ramas locales viejas son historia; ninguna contiene trabajo que `main` no tenga, salvo el portal web.

Worktrees existentes (no se modificaron): `plus-medik-v2` (feat/kapso-pilot), `-fase5`, `-integra`, `-marks`, `-phase6-audit`. Se agregó `plus-medik-v2-g1`.

## 2. Cambios sin commit del checkout `plus-medik-v2` — auditados y protegidos

Antes de cualquier operación se respaldaron **sin tocar el árbol de trabajo ni el índice**:

- Rama de respaldo `backup/g1-uncommitted-kapso-pilot` (commit `8c9c676`, sobre `a57b9a8`) con todos los cambios y los archivos nuevos (incluidos `docs/g0/`).
- `.cache/g1-backup/tracked-changes.patch` (sha256 `cd75a4f0…230b`) y copia de los archivos no rastreados en `.cache/g1-backup/untracked/` (`.cache/` está ignorado por Git).

Contenido de los cambios (8 entradas): `src/partial-auto.ts`, `src/whatsapp-quote.ts`, `tests/line-text.test.ts`, `tests/partial-auto.test.ts`, `tests/whatsapp-quote.test.ts`, `src/uncertainty.ts`, `tests/uncertainty.test.ts`, `docs/g0/`.

**Resultado de la comparación (tarea 4):**

| Archivo | Veredicto | Evidencia |
| --- | --- | --- |
| `src/uncertainty.ts`, `tests/uncertainty.test.ts` | **Idénticos** a `origin/main` (ignorando CRLF) | `diff --strip-trailing-cr` sin diferencias |
| `src/partial-auto.ts` — campo `uncertainty` en `StudyDecision`/`PendingItem` y su cálculo | **Ya en `origin/main`** | las 7 expresiones añadidas aparecen en `origin/main:src/partial-auto.ts` |
| `src/whatsapp-quote.ts` — 2 líneas (`uncertainty` en el log) | **Ya en `origin/main`** | ambas aparecen en `origin/main:src/whatsapp-quote.ts` |
| Pruebas modificadas (`line-text`, `partial-auto`, `whatsapp-quote`) | **Ya en `origin/main`** | las tres expectativas con `uncertainty` existen en `origin/main` |
| `docs/g0/` | **Único**: no está en `main` | pasa a la rama de integración (corregido con errata) |

El trabajo sin commit era una versión anterior del commit `b4fec34` ("classify uncertainty per blocker"), ya presente en `main`. **No hay conflicto que resolver**: el contenido valioso ya está integrado.

Diferencias de comportamiento entre el árbol viejo y `main` (para que nadie las "restaure" por error):

- `main` **eliminó** `includeStudyText` / `PILOT_LOG_STUDY_TEXT` del log de diagnóstico (decisión de privacidad: "no hay ninguna bandera que lo permita"). El árbol viejo todavía lo tiene. No se restaura.
- `main` tiene además `impactStudyOf` (el verificador de impacto recibe el texto literal y la línea original de estudios reconstruidos, Fase 5) y toda la máquina de claim/reserva en `whatsapp-quote.ts`, que el árbol viejo no tiene.

El checkout `plus-medik-v2` **no se modificó**: conserva los 8 cambios tal cual. Una vez que el dueño confirme, se puede archivar o actualizar; hacerlo ahora habría sido tocar trabajo sin commit.

## 3. Rama de integración preparada

`integration/g1-consolidacion`, en el worktree `C:\Users\yoanm\Proyectos-Smarky\plus-medik-v2-g1`:

- Base: `origin/main` (`dfa98da`). Sin upstream configurado (para evitar un `git push` accidental).
- Contenido adicional (sin commit): `docs/g0/` (con errata) y `docs/g1/`.
- **Ningún archivo de código fue modificado.** El motor de recetas y su interpretación quedan intactos.
- Dependencias instaladas con `npm ci` en ese worktree (entorno aislado; no hay `.env` en él, por lo que ninguna prueba podría llegar a servicios reales aunque quisiera).

## 4. Qué está desplegado en Vercel

**No se puede determinar con certeza desde el repositorio ni desde GitHub.** Lo que sí se verificó (solo lectura, API de GitHub):

- Existe un proyecto Vercel `plus-medik-v2` (cuenta `rochayoan40-5104s-projects`); el repositorio apunta a `https://plus-medik-v2.vercel.app` como página de inicio.
- **Vercel compila todas las ramas y commits** (estados de commit "Vercel" en `a57b9a8`, `30e8985`, `31b9079`, `f485ae0`, `dfa98da`; en `95c9783` del portal, "Deployment was blocked").
- El último despliegue **exitoso** de `main` es el de `dfa98da`: pendiente 04:22:00Z, completado 04:22:20Z del 2026-10-22, deployment `9DmTYf4XEWem9hKejX6XFSkkTb8o`. Es lo más probable que esté en producción **si** la rama de producción del proyecto es `main`.
- La API de despliegues de GitHub no devolvió despliegues (la integración de Vercel usa estados de commit, no la API de deployments), así que **no consta cuál despliegue tiene el alias de producción**.
- No hay CLI de Vercel instalada ni credenciales de Vercel en esta máquina; no se hicieron peticiones al dominio.

Para confirmarlo (acciones del dueño, sin riesgo): en Vercel → proyecto `plus-medik-v2` → Deployments → el marcado **Production** y su commit; y Settings → Git → *Production Branch*. Una vez aplicadas las migraciones, `plusmedik_audit_runs.engine_version` guarda el `VERCEL_GIT_COMMIT_SHA` de cada procesamiento y lo confirma automáticamente.

Variables de entorno de Vercel: **no verificadas** (no están en el repositorio). Hay que confirmar que **no** estén definidos `PLUSMEDIK_HUMAN_CONTROL`, `REQUIRE_AUDIT_GUARD` ni `CATALOG_*`, y qué valor tiene `ALLOWED_PHONES`.

## 5. Qué hace el código de `main` según la configuración (verificado con una simulación)

Se ejecutó un script desechable (fuera del repositorio, sin red, `fetch` simulado) que reproduce un Supabase **sin las migraciones** (PostgREST devuelve 404 a cualquier RPC desconocida) usando el repositorio de auditoría y `handleImageMessage` reales de `main`:

| Configuración | Resultado | Registro |
| --- | --- | --- |
| Por defecto (migraciones sin aplicar) | **Responde igual que el piloto anterior**: 1 mensaje enviado; una sola RPC fallida | `audit_unavailable {stage:"claim", kind:"REJECTED"}` y luego `reply_sent` |
| `REQUIRE_AUDIT_GUARD=on` (sin migraciones) | **No responde a nadie** | `reply_withheld {reason:"audit_guard_unavailable"}` |
| `PLUSMEDIK_HUMAN_CONTROL=on` (sin migraciones) | **No responde a nadie** | igual |

Regla operativa derivada: **primero migraciones, después banderas.** Activar cualquiera de las dos banderas antes de aplicar las migraciones silencia al bot. Y mientras las migraciones no estén aplicadas, producción **no** tiene deduplicación, lease ni pausa humana, pese a que el código está desplegado.
