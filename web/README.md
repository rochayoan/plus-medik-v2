# PlusMedik · Portal de cotización

Portal web donde convenios, clínicas y médicos cotizan estudios de laboratorio para sus pacientes, con usuario y contraseña.
Objetivo: más de 100 usuarios, unos 50 cotizando a la vez, con respuesta instantánea.

> **Estado del proyecto, decisiones tomadas, pendientes y reglas para seguir desarrollando: [CLAUDE.md](CLAUDE.md).**

## Cómo es rápido

- **La búsqueda no toca el servidor.** `/api/catalog` entrega una sola vez el catálogo activo con la tarifa del usuario ya aplicada.
  - El navegador lo guarda en IndexedDB y lo revalida con ETag: la respuesta es 304, sin cuerpo, si nada cambió.
  - Buscar, filtrar y armar la cotización ocurre en memoria (MiniSearch + `normalizeStudyKey` del core).
- **En el servidor**, el catálogo se cachea en memoria por instancia (`CATALOG_CACHE_TTL_MS`). Las peticiones simultáneas comparten una sola carga, así que no hay estampida contra Supabase.
- **Guardar una cotización** es una sola llamada a `create_quote`, una función SQL que recalcula los precios. Nunca se confía en el precio que envía el navegador.
- **Las fotos se suben directo a Supabase Storage** (URL firmada, imagen reducida a 2400 px en el celular). Se analizan en segundo plano (`after()`); el usuario sigue cotizando mientras tanto.

## Flujo del usuario

1. **Buscador:** escribir «hemo», «tsh» o «glic» → Enter agrega el estudio → el foco vuelve al buscador. La tecla `/` enfoca el buscador desde cualquier parte.
2. **Pegar lista** (botón, o pegar directo en el buscador):
   - lo que coincide exacto con un nombre o alias entra solo;
   - lo demás ofrece 2 o 3 opciones para elegir con un toque.
   - No usa IA ($0).
3. **Foto de la orden:** los lectores del core (`analyzeImage`) precargan el carrito.
   - Solo entra solo lo que el core resolvió de forma única y con certeza alta.
   - Lo ambiguo, sugerido o no encontrado queda «por revisar», con la foto al lado para comparar.
   - Nada se cotiza sin que el usuario lo vea.
4. **Atajos:** frecuentes (los estudios más usados en los últimos 90 días), plantillas propias, y repetir desde el historial.
5. **Salida:**
   - PDF con logo, folio y validez;
   - **Copiar texto** listo para pegar en el WhatsApp del paciente;
   - Abrir WhatsApp;
   - Enviar PDF (Web Share en el celular).

## Precios

**Precio efectivo** = `tariff_prices.price_bs` de la tarifa de la organización. Si el estudio no tiene precio en esa tarifa, se usa `lab_tests.price_bs` (Paciente).

La misma regla está en `priceCatalog` ([lib/catalog-server.ts](lib/catalog-server.ts)) y en `create_quote` (migración). Cada cotización guarda una copia de nombre y precio: cambiar el catálogo después no altera las cotizaciones emitidas.

## Puesta en marcha

1. **Migración.** En el Supabase de PlusMedik (el que tiene `lab_tests`), aplicar [supabase/migrations/20261019000000_portal_cotizacion.sql](supabase/migrations/20261019000000_portal_cotizacion.sql).
   - La migración no modifica `lab_tests` ni `lab_test_aliases`.
   - Crea las tablas del portal con RLS, las funciones `create_quote`, `frequent_studies`, `mark_password_changed` y `admin_set_tariff_prices`, y el bucket privado `quote-photos`.
2. **Supabase Auth:**
   - desactivar el registro público (*Allow new users to sign up* → off), porque las cuentas las crea PlusMedik desde `/admin`;
   - usar **JWT signing keys asimétricas** (por defecto en proyectos nuevos): así `getClaims()` verifica la sesión localmente, sin una ida al servidor de Auth en cada petición.
3. **Primer administrador.** Crear el usuario en el panel de Supabase (Auth → Add user) y luego:
   ```sql
   insert into public.profiles (user_id, full_name, role, must_change_password)
   values ('<uuid del usuario>', 'Nombre', 'admin', true);
   ```
4. **Variables.** Copiar [.env.example](.env.example) a `.env.local` (desarrollo) o cargarlas en Vercel.
5. **Logo (opcional).** Poner `public/brand/logo.png`; sin archivo, el PDF muestra el nombre de la marca.

```bash
npm install          # en la raíz del repo (workspaces: core + web)
npm run dev -w web   # compila el core (../dist) y levanta Next en http://localhost:3000
npm run check -w web # typecheck + tests (incluye migración y RLS sobre PGlite)
```

## Despliegue en Vercel

- **Dos proyectos Vercel en el mismo repo:** la raíz es el piloto de WhatsApp (`api/kapso/webhook.ts`, ver README raíz) y este portal es otro proyecto.
- **Proyecto:** *Root Directory* = `web`. Vercel detecta el workspace e instala desde la raíz. `npm run build` compila primero el core (`prebuild`).
- **Región de las funciones = región del Supabase.** Por ejemplo, `gru1` si el proyecto está en `sa-east-1`. Cada consulta cruza esa distancia.
- **Variables:** ver `.env.example`.
  - `SUPABASE_SERVICE_ROLE_KEY` y las claves de IA solo en el servidor (sin `NEXT_PUBLIC_`).
  - `ANALYZER_MODE=mock` está bloqueado en producción.
- **Cron:** [vercel.json](vercel.json) ejecuta `/api/cron/cleanup` a diario (protegido por `CRON_SECRET`).
  - Borra fotos con más de `PHOTO_RETENTION_DAYS` (son datos clínicos).
  - Cierra los análisis que quedaron colgados.

## Administración (`/admin`, rol `admin`)

- **Monitoreo:** cotizaciones por organización y por origen (buscador, lista, foto, plantilla, repetir); tiempos de lectura de fotos (p50 y p95) y uso de IA por modelo.
- **Organizaciones:** crear, asignar tarifa, activar o desactivar. Un médico independiente es una organización de tipo «Médico».
- **Usuarios:** alta con contraseña temporal (se muestra una vez, con un mensaje listo para enviar), restablecer, editar y desactivar.
  - Desactivar bloquea el ingreso en Auth y el acceso a los datos (RLS).
  - Nunca se borran usuarios: sus cotizaciones se conservan.
- **Tarifas:** descargar la plantilla CSV (todos los estudios con su precio Paciente) → editar la columna `precio` en Excel → importar con vista previa → aplicar.
  - La aplicación es atómica.
  - Opcionalmente, reemplaza toda la tarifa.

## Pruebas

- `npm run check -w web` (vitest):
  - búsqueda, pegar lista, correspondencia `AnalysisResult` → precarga (con el `assembleAnalysis` real del core), texto de WhatsApp, CSV de tarifas y PDF;
  - **migración + RLS + `create_quote`** sobre Postgres en memoria (PGlite), con dos organizaciones, roles, usuarios inactivos y precios manipulados.
- **Carga** ([load/quote-flow.js](load/quote-flow.js), k6). Solo contra un **preview + Supabase de staging** con `ANALYZER_MODE=mock`, nunca contra producción.
  - Usuarios de prueba: `npx tsx web/load/seed-load-users.ts --url … --confirm <ref> --count 100`.
  - Metas: p95 de guardar cotización < 400 ms; p95 del catálogo 304 < 150 ms; < 1 % de errores.

## Estructura

```text
app/(app)/cotizar          cotizador (componentes en components/quoter)
app/(app)/cotizacion/[id]  resultado: PDF, copiar texto, WhatsApp
app/(app)/historial        historial con búsqueda y "repetir"
app/(app)/admin            monitoreo, organizaciones, usuarios, tarifas
app/api/catalog            catálogo + tarifa (ETag)
app/api/photo-jobs         subida firmada, inicio y estado del análisis de foto
app/api/quotes/[id]/pdf    PDF
app/api/cron/cleanup       retención de fotos
lib/                       lógica pura (búsqueda, lista, precarga, CSV, texto) + acceso a Supabase
supabase/migrations        esquema del portal
proxy.ts                   sesión (Next 16: "proxy" = middleware)
```
