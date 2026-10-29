# G4.0 · Base de cotización conversacional V2

> **G5.9:** la cotización por texto se amplió (lista clara con pedido de cotizar sin «listo», acumulación con confirmación, aclaraciones, abreviaturas y migración 14). Ver `docs/g5/80-g59-cotizacion-por-texto.md`; lo que sigue describe la base de G4.0.

Todo local, offline y **apagado por defecto**. Nada se aplicó a Supabase real, no se envió nada por Kapso, no se llamó a ningún modelo, no se activó ninguna bandera, no hay commit/push/merge. No se tocó `CRM-PLUSMEDIK`. El motor de recetas (`analyze`, lectores, juez, catálogo, `partial-auto`) y el flujo de una foto sola **no se modificaron**.

## 1. El problema

Hoy cada foto se cotiza sola en cuanto llega. Un paciente real manda varias fotos de una misma receta, agrega estudios por texto («y también glucosa») o repite la misma foto. Cotizar cada mensaje por separado produce cotizaciones parciales, repetidas y contradictorias. G4.0 agrega una **sesión por contacto** que junta todo y cotiza **una sola vez**, cuando el paciente declara que terminó.

## 2. Cómo funciona

```
foto ──► [descarga, tamaño, tipo] ──► hash ──► ¿ya está en la sesión? ─ sí ─► «esa foto ya la tenía» (sin gastar análisis)
                                                  │ no
                                                  ▼
                                   MOTOR DE RECETAS de siempre (deps.analyze) ──► ¿qué dijo?
                                     completo ─► identificada │ parcial ─► incierta │ sin cotización ─► ilegible
texto ─► ¿«listo» / «cancelar»?  ─ sí ─► cierre (abajo)
        ¿información / médico / saludo? ─► manejador de siempre (la sesión no se toca)
        estudios escritos ─► resolvedor EXACTO del catálogo (nombre o alias aprobado) ─► identificado / ambiguo / sin resolver
cada mensaje ─► «ítem» de la sesión (solo ids de estudios y códigos) ─► confirmación SIN precios («llevas N mensajes… escribe LISTO»)

«listo» ─► espera (acotada) a los mensajes ANTERIORES aún en proceso
        ─► catálogo RECARGADO ahora ─► evaluar:
             ilegible  ─► «reenvía esas fotos» (la sesión conserva lo legible)
             dudoso    ─► SIN precio + caso en la COLA DE REVISIÓN (para el futuro flujo humano)
             todo claro ─► cotización única: sin repetidos, precios de lab_tests de este instante
```

### Reglas de oro (probadas)
| Regla | Cómo se garantiza |
| --- | --- |
| **No cotizar antes de completar** | Solo «listo» cierra; una foto o un texto solo confirman. Una sesión vencida **jamás** se cotiza por el paso del tiempo |
| **Solo estudios y precios vigentes de `lab_tests`** | El texto se resuelve con el `ExactAliasCatalogResolver` del motor; los precios se leen del catálogo **recargado al cerrar** (nunca el de una caché); un estudio retirado o un precio inválido manda a revisión |
| **Nunca inventar estudios, equivalencias ni precios** | Sin aproximaciones: «examen de orina» no equivale a «orina» salvo que el catálogo lo diga; relleno de cortesía solo en los extremos; la base **rechaza** (PT409) una cotización que no coincida *exactamente* con los estudios identificados por los ítems |
| **Duplicados** | Foto repetida (mismo hash) → no se analiza; estudio repetido (entre mensajes o dentro de uno) → una línea, y se avisa |
| **Ambiguo / incompleto** | Alias de varios estudios, fragmentos sin resolver, resultado parcial del motor → sin precio, caso en la cola. Foto ilegible → se pide reenviar y se conserva el resto |
| **Casos inciertos → revisión humana futura** | `plusmedik_quote_reviews` (estado `PENDING`, solo códigos e ids). **Nadie la consume todavía**: el mensaje al paciente **no promete** que una persona lo atenderá |
| **Idempotencia** | Un ítem por corrida (único); reintento o ejecución que reclama el lease → mismo ítem; cerrar es idempotente por corrida (`replay`: mismo resultado sin recalcular) |
| **Concurrencia** | Todo bajo el bloqueo del contacto (contacto → corrida). «Listo» tras una foto que aún se analiza **espera** y la incluye; dos cierres simultáneos → uno solo; lo que llega después del turno que cierra pasa a una sesión nueva |
| **Pausa humana** | Un contacto pausado no se reclama: no se agrega nada, no se confirma ni se cotiza (heredado de la máquina de turnos) |
| **Antibucles** | Autorrespuestas y ecos no entran ni cierran la sesión; las confirmaciones pasan por la guarda de G3.2 con firma `QUOTE_ADDED:<n>` (cada una distinta, sin falsos bucles); la cotización (`quoted`) y los avisos (`no_quote`) nunca se limitan |
| **Privacidad** | No se guarda texto del paciente ni teléfonos: solo ids de estudios del catálogo, códigos, contadores y el hash de cada foto |

## 3. Datos (migración 11 `20261030000000_plusmedik_quote_sessions.sql`, preparada, **no aplicada**)
- `plusmedik_quote_sessions` (una abierta por contacto; estados `OPEN`, `QUOTED`, `NEEDS_REVIEW`, `NEEDS_RESEND`, `CANCELLED`, `EXPIRED`).
- `plusmedik_quote_items` (por turno: tipo, estado, ids de estudios, grupos ambiguos, sin-resolver, motivos, hash de foto).
- `plusmedik_quote_results` (qué se cotizó: líneas, total, huella del catálogo; inmutable).
- `plusmedik_quote_reviews` (cola de revisión; inmutable).
- Funciones (todas `SECURITY DEFINER`, `search_path` vacío, solo `service_role`, con owner + fence): `…_item_begin`, `…_item_finish`, `…_session_read`, `…_session_close`.
Aditiva, sin tocar lo anterior (las 10 previas con hash fijado), sin SQL dinámico, sin referencias a `lab_tests`: la verificación de existencia y precio vigentes la hace el cliente al cerrar y queda registrada con la huella del catálogo.

## 4. Activación (todo apagado)
`PLUSMEDIK_QUOTE_SESSIONS=on` (en blanco en `.env.example`) solo tiene efecto con `PLUSMEDIK_TURNS=on` **y** `PLUSMEDIK_TEXT_HANDLER=on`: sin el manejador de texto nadie podría escribir «listo», así que **las fotos siguen cotizándose una por una como siempre** (probado). Con la bandera y sin la migración 11, una foto o un estudio escrito responden con el aviso técnico y **no se anota ni se cotiza nada** (falla cerrado, probado).

## 5. Archivos
Nuevos: `supabase/migrations/20261030000000_plusmedik_quote_sessions.sql` · `src/quote-session.ts` (lógica pura) · `src/quote-session-turns.ts` (productores de foto y texto) · `tests/quote-session{,-turns,-db,-e2e,-boundaries}.test.ts` · `docs/g4/`.
Modificados: `src/audit.ts` (cuatro operaciones opcionales) · `src/guarded-turn.ts` (`quoteSessions` en la configuración) · `src/turns.ts` (elige el productor; `conversationProducer` exportado) · `api/kapso/webhook.ts` y `.env.example` (una bandera en blanco) · pruebas de apoyo (`postgrest-over-psql`, `production-defaults`, `reply-guard*`, `knowledge-refs-db`) · `turns-e2e` y `turns` (esperas por condición).
