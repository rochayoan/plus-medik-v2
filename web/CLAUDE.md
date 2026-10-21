# Portal de cotización web: guía para agentes

Lee esto antes de tocar `web/`. La instalación, el despliegue y la operación están en [README.md](README.md).

## Qué es

Es el portal donde convenios, clínicas y médicos de PlusMedik cotizan estudios de laboratorio para sus pacientes, con usuario y contraseña. El objetivo de negocio es bajar el costo de personal que hoy cotiza a mano.

- **Carga esperada:** más de 100 usuarios y unos 50 cotizando a la vez. La rapidez es un requisito: los médicos no deben quejarse.
- **Relación con el core:** reutiliza el core del repo (`../src`, la lectura de órdenes por foto) para precargar la cotización desde una foto.

## Decisiones del cliente (no reabrir sin preguntarle al dueño del proyecto)

1. **Precios.** Cada organización tiene su tarifa (`tariff_prices`). Si un estudio no tiene precio en ella, se usa el precio Paciente (`lab_tests.price_bs`).
2. **Salida.** Un PDF con logo y un texto ordenado para copiar y pegar en el WhatsApp del paciente.
3. **Foto dudosa.** La foto precarga el carrito y el usuario confirma lo dudoso.
   - Solo entra solo lo seguro.
   - No existe una cola de revisión del personal de PlusMedik.
4. **Infraestructura.** Vercel (proyecto con *Root Directory* `web`) y el Supabase de PlusMedik (el mismo que tiene `lab_tests`).
5. **Cuentas.** Las crea PlusMedik desde `/admin`; no hay registro público. Se entrega una contraseña temporal y es obligatorio cambiarla en el primer ingreso.
   - Un médico independiente es una organización de tipo `medico` con un solo usuario.

## Estado al 21-10-2026

**Hecho y verificado en local** (tests, typecheck, `next build` y prueba de humo con `next start`):

- **Acceso:** login, cambio de contraseña obligatorio, proxy de sesión.
- **Cotizador** (`/cotizar`):
  - buscador local instantáneo;
  - pegar lista;
  - foto con precarga y revisión;
  - frecuentes, plantillas, repetir;
  - borrador en `localStorage`;
  - barra inferior en el celular.
- **Resultado** (`/cotizacion/[id]`): PDF, copiar texto para WhatsApp, abrir WhatsApp, compartir el PDF (Web Share).
- **Historial** con búsqueda por paciente o folio.
- **Admin:** monitoreo, organizaciones, usuarios (alta, reset, edición, desactivación) y tarifas (plantilla CSV → vista previa → aplicación atómica).
- **Base de datos:** migración con RLS y funciones. Probada en PGlite: 22 tests de precios, roles, aislamiento entre organizaciones e importación.

**No verificado todavía** (nadie lo corrió):

- **Supabase real.** No había acceso, así que la migración **no está aplicada**. El login real, la RLS real, Storage y `create_quote` solo se probaron en PGlite.
- **Columnas reales de `lab_tests` y `lab_test_aliases`.** La migración asume `lab_tests.id uuid`, `code`, `name`, `normalized_name`, `price_bs`, `active` y `sample_type`, porque eso lee `src/supabase-catalog.ts`. Confírmalo antes de aplicar.
- **Foto con modelos reales desde la web.** El flujo está cableado y la lógica del core está probada, pero falta la prueba de punta a punta.
- **Prueba de carga** [load/quote-flow.js](load/quote-flow.js): escrita, sin ejecutar.
- **Revisión visual en el navegador:** nadie ha visto las pantallas.
- **Despliegue en Vercel.**

## Próximos pasos, en orden

1. **Acceso al Supabase de PlusMedik.** Confirmar las columnas de catálogo (punto anterior).
2. **Migración.** Aplicar [supabase/migrations/](supabase/migrations/), primero en un branch o staging de Supabase. Después, crear el primer admin (SQL en el README).
3. **Proyecto Vercel:**
   - *Root Directory* `web`;
   - funciones en la misma región que Supabase;
   - variables de [.env.example](.env.example);
   - desplegar primero en preview.
4. **Prueba de punta a punta manual:**
   - crear una tarifa, una organización y un usuario;
   - ingresar;
   - cotizar por las 4 vías: buscador, lista, foto y plantilla/repetir;
   - generar el PDF y copiar el texto.
5. **Prueba de carga k6** contra preview + staging con `ANALYZER_MODE=mock`.
6. **Datos pendientes del cliente:** logo (`public/brand/logo.png`), dirección, teléfono, horario y las tarifas de los convenios en CSV.

**Ideas no comprometidas:**

- Usar las decisiones por estudio del AUTO parcial del core (`CATALOG_PARTIAL_AUTO`, `src/partial-auto.ts`) para marcar más ítems como seguros en la precarga.
- Índice trigram para buscar pacientes en el historial.
- Estimar el costo de OpenAI en el monitoreo (hoy OpenAI no lo reporta por llamada; solo hay tokens).

## Invariantes (no romper)

- **El precio lo calcula solo el servidor,** con la misma regla en dos lugares:
  - `create_quote` (SQL, en la migración);
  - `priceCatalog` ([lib/catalog-server.ts](lib/catalog-server.ts)).
  - Nunca aceptes precios del navegador. Si cambias la regla, cambia ambos lugares y sus tests.
- **Las cotizaciones emitidas son inmutables.** `quote_items` guarda copias de nombre, código y precio.
- **La foto nunca decide sola.** `prefillFromAnalysis` ([lib/photo-prefill.ts](lib/photo-prefill.ts)) solo marca `sure`:
  - todo lo de un `AUTO_SAFE`, o
  - un `MATCHED` leído con confianza `high`.
  - Todo lo demás pasa a `choose`, `confirm` o `not_found`.
  - Nunca se toman precios del core: su `quote.tariff = "PACIENTE"` se ignora.
- **RLS en todas las tablas del portal.**
  - Los usuarios solo escriben a través de funciones (`create_quote`, `mark_password_changed`) o en sus propias plantillas.
  - `adminClient()` (service role, [lib/supabase/admin.ts](lib/supabase/admin.ts)) solo se usa en el servidor y después de verificar la sesión.
  - Cada server action de `/admin` vuelve a llamar a `requireAdmin()`.
- **Los usuarios se desactivan, no se borran.** `quotes.created_by` apunta a `profiles` con `restrict`.
- **Las fotos son datos clínicos:**
  - bucket privado `quote-photos`;
  - retención por cron (`/api/cron/cleanup`);
  - nunca commitear imágenes (`private-data/` está ignorado).
- **`ANALYZER_MODE=mock` está bloqueado en producción.** La prueba de carga jamás se corre contra producción, porque crea cotizaciones reales.
- **Gasto de IA:**
  - en la web, `AI_CACHE` se fuerza a `off` y el uso se registra en `ai_usage` mediante `setUsageSink` ([lib/photo/run-job.ts](lib/photo/run-job.ts));
  - no definas `CATALOG_*` en Vercel hasta decidirlo con datos (es el mismo criterio que el piloto de WhatsApp en el README raíz);
  - los scripts del core que gastan dinero exigen `PLUSMEDIK_AUTHORIZE_PAID_CALLS`.

## Trampas técnicas (ya resueltas: no las reintroduzcas)

- **La web importa el core compilado:** `@core/*` → `../dist/*` (paths de tsconfig + alias de vitest).
  - Turbopack no resuelve los imports `./x.js` → `.ts` de archivos fuera de `web/`.
  - Por eso `predev`, `prebuild` y `pretypecheck` corren `npm run build --prefix ..` (`tsc -p tsconfig.build.json`).
  - Si cambias `../src`, recompila antes de probar la web.
- **En el navegador solo se importan** `@core/catalog`, `@core/consensus` y tipos, porque no usan Node. Nunca importes `@core/analyze` ni `@core/cache` en un componente `"use client"`.
- **Next.js 16:**
  - el middleware se llama `proxy.ts`;
  - `params`, `searchParams`, `cookies()` y `headers()` son async;
  - el proxy no corre en `/api/*`: las rutas validan con `getSession()` y aceptan `Authorization: Bearer <jwt>` (lo usa k6).
- **Tailwind v4:** las clases propias (`btn-primary`, `btn-secondary`, `input`, `card`, `label`…) se definen con `@utility` en [app/globals.css](app/globals.css). `@layer components` + `@apply` falla.
- **`getSession()`** ([lib/session.ts](lib/session.ts)) usa `getClaims()`:
  - con claves JWT asimétricas de Supabase verifica localmente, que es lo rápido;
  - con el secreto HS256 legacy hace una ida a Auth en cada petición.
- **Tests de base de datos:** [tests/db/harness.ts](tests/db/harness.ts) levanta PGlite con un stub mínimo de Supabase y aplica las migraciones reales en orden.
  - El stub incluye: roles `anon`/`authenticated`/`service_role`, `auth.uid()` leído de `request.jwt.claim.sub`, `storage.buckets` y las tablas de catálogo.
  - Una migración nueva va en `supabase/migrations/` con prefijo de fecha y se prueba en [tests/db/rls.test.ts](tests/db/rls.test.ts).
- **`server-only`** se reemplaza por un stub en vitest, para poder probar módulos de servidor.
- **`vitest.config.ts` de la raíz:**
  - limita los tests del core a `tests/**` (si no, tomaría los de `web/`);
  - bloquea la red (`tests/support/offline-network.ts`).
- **Dos proyectos Vercel en el mismo repo:**
  - la raíz: piloto de WhatsApp en `api/kapso/webhook.ts` (ver README raíz). Su `.vercelignore` es de ese proyecto;
  - `web`: este portal.

## Mapa

| Qué | Dónde |
| --- | --- |
| Esquema, RLS y funciones SQL | [supabase/migrations/](supabase/migrations/) |
| Cotizador (cliente) | [components/quoter/](components/quoter/) (`quoter.tsx` orquesta) |
| Catálogo + tarifa (ETag, cache en memoria) | [app/api/catalog/route.ts](app/api/catalog/route.ts), [lib/catalog-server.ts](lib/catalog-server.ts) |
| Búsqueda / pegar lista | [lib/search.ts](lib/search.ts), [lib/paste.ts](lib/paste.ts) |
| Foto: subida firmada → `after()` → precarga | [app/api/photo-jobs/](app/api/photo-jobs/), [lib/photo/run-job.ts](lib/photo/run-job.ts), [lib/photo-prefill.ts](lib/photo-prefill.ts) |
| PDF / texto WhatsApp | [lib/pdf/quote-pdf.tsx](lib/pdf/quote-pdf.tsx), [lib/whatsapp-text.ts](lib/whatsapp-text.ts) |
| Sesión y clientes Supabase | [lib/session.ts](lib/session.ts), [lib/supabase/](lib/supabase/), [proxy.ts](proxy.ts) |
| Admin | [app/(app)/admin/](app/(app)/admin/) |
| CSV de tarifas | [lib/tariff-csv.ts](lib/tariff-csv.ts) |

## Comandos

```bash
npm install            # en la raíz (workspaces: core + web)
npm run check          # core: typecheck + tests
npm run check -w web   # portal: compila el core, typecheck + tests (incluye la RLS sobre PGlite)
npm run dev -w web     # requiere web/.env.local (ver .env.example)
```

**Cómo verificar un cambio:**

- lógica pura → `web/tests/`;
- SQL o RLS → `tests/db/rls.test.ts`;
- UI → no hay tests: levanta `npm run dev -w web` y pruébalo en el navegador.
