# PlusMedik V2 — migración gradual a Dokploy (fase 1)

## Estado

Esta rama **no es un reemplazo operativo de Vercel**. Permite construir y levantar
un contenedor Node 22 para pruebas de infraestructura sin recibir mensajes reales
de pacientes. No se cambia Kapso, Supabase, CRM, DNS ni variables de Vercel.

El endpoint `/api/kapso/webhook` devuelve intencionalmente **503** para todos
los métodos. `/readyz` también devuelve 503. `/healthz` devuelve 200
si el proceso está vivo, pero incluye `webhookReady:false`.
No confundir salud del contenedor con preparación para el corte de tráfico.

## Arquitectura actual y riesgo bloqueante

La ruta de Vercel `api/kapso/webhook.ts` entrega ACK 200 y difiere el trabajo
mediante `waitUntil(task)`. El análisis de imágenes requiere llamadas a varios
modelos, catálogo y persistencia y puede exceder el tiempo de reintento de Kapso.
Sustituir `waitUntil` por una promesa en memoria, `setTimeout` o un proceso en
segundo plano **no garantiza** la supervivencia del trabajo durante un reinicio.

Antes de migrar el webhook hay que implementar y probar:

1. **Inbox persistente e idempotente**: verificar firma de Kapso, validar
   eventos, persistir un registro de trabajo de forma transaccional y responder
   200 solamente después de confirmar el registro. Si falla, devolver 503.
   Definir minimización/retención del texto de pacientes y permisos estrictos;
   no incluir datos sensibles en logs ni exponer el inbox desde el navegador.
2. **Worker recuperable**: reclamación atómica, leases y vencimientos,
   reintentos con política explícita, recuperación tras SIGTERM/redeploy y
   tratamiento de errores permanentes, sin reenvíos duplicados. Conservar
   `plusmedik_audit_runs` y las garantías de deduplicación actuales.
3. **Aislamiento por teléfono**: `PLUSMEDIK_TEXT_PILOT_GUARD` activo,
   exactamente un teléfono piloto y el filtro `ALLOWED_PHONES`
   compatible, preservando cotizaciones de fotografía de otros contactos.
4. **QA de extremo a extremo**: eventos repetidos, lote mixto, imágenes,
   conversación escrita, pausas humanas, caídas de Supabase/Kapso y reinicio
   del worker entre recepción y envío. Aprobar textos de respaldo y privacidad.
5. **Corte reversible**: actualizar el webhook de Kapso **una sola vez**
   hacia Dokploy tras la verificación; comprobar entradas y respuestas,
   mantener la URL de Vercel accesible y documentar reversión inmediata.
   No tener dos consumidores activos simultáneamente.

La fase 1 deliberadamente no agrega una tabla SQL ni solicita credenciales.

## Construcción local

```bash
npm ci
npm run build:dokploy
npm run typecheck
npx vitest run tests/dokploy-router.test.ts
docker build -f Dockerfile.dokploy -t plusmedik-dokploy:phase1 .
docker run --rm -p 127.0.0.1:3000:3000 plusmedik-dokploy:phase1
```

En otra terminal:

```bash
curl -i http://localhost:3000/healthz
curl -i http://localhost:3000/readyz
curl -i -X POST http://localhost:3000/api/kapso/webhook -d '{}'
```

Resultados previstos: 200, 503 y 503 respectivamente. **No enviar
mensajes reales de pacientes ni registrar un webhook de Kapso en esta fase.**

## Prueba de infraestructura en Dokploy

1. Crear una aplicación **nueva** `plusmedik-agent-staging`, separada del CRM.
   Conectar GitHub al repositorio privado `rochayoan/plus-medik-v2`, rama
   `feat/dokploy-runtime-phase1`. No elegir `main` todavía.
2. Seleccionar tipo de build **Dockerfile** y ruta
   `Dockerfile.dokploy`, contexto raíz `/`, puerto del contenedor **3000**.
   Exponerlo mediante dominio HTTPS de **staging**, distinto al webhook actual.
3. Usar la página **Environment** de Dokploy para pasar variables mínimas,
   solo si se van a probar endpoints protegidos. Nunca subir `.env` ni pegar
   secretos en GitHub o en mensajes. Para un smoke de `/healthz` no hace falta
   ninguna clave de Kapso, OpenAI ni Supabase.
4. Confirmar `/healthz` 200 + `webhookReady:false` y
   `/readyz`/webhook 503. Comprobar Docker logs y recursos del VPS,
   considerando que el CRM ya se ejecuta en el mismo servidor.
5. Mantener **Kapso apuntando a Vercel**, sin modificar DNS ni números. Las
   variables `PLUSMEDIK_TURNS`, `PLUSMEDIK_TEXT_HANDLER`,
   `PLUSMEDIK_REPLY_GUARD`, `PLUSMEDIK_QUOTE_SESSIONS` y conversación
   LLM continúan OFF en la producción actual.

El contenedor usa Node.js 22, un build en dos etapas y usuario sin privilegios.
Las rutas HTTP distintas del webhook reutilizan los handlers TypeScript de
`api/`; sus permisos y banderas siguen siendo los del backend existente.
Las rutas de web/CRM/recovery no constituyen garantía de paridad completa:
se deben probar individualmente con datos sintéticos antes de exponerlas.

## Criterios para declarar completada la migración

- CI + Docker build en verde, y smoke con contenedor en Dokploy.
- Inbox y worker durables demostrados con pruebas de interrupción.
- QA del piloto y fotografías de terceros sin pérdidas ni respuestas duplicadas.
- Backups y ruta de reversión documentados, monitoreo y alertas.
- Actualización controlada de la URL del webhook de Kapso.
- Confirmación posterior de estabilidad y solo entonces retirada de Vercel.
