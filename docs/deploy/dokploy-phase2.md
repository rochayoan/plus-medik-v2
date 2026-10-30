# PlusMedik V2 — Dokploy, fase 2: inbox cifrado y worker (STAGING)

**Estado: código preparado para pruebas; NO habilitado para recibir pacientes.**
Este documento NO autoriza cambios en Kapso, WhatsApp, Vercel ni Supabase de producción.

## Flujo propuesto

1. Dokploy recibe POST `/api/kapso/webhook` en Node.js.
2. Verifica HMAC-SHA256 con `WEBHOOK_SECRET` sobre el cuerpo original;
   rechaza cuerpos inválidos antes de llamar a la base.
3. Cifra el evento completo (AES-256-GCM, clave exclusiva de 32 bytes), lo
   guarda en Supabase y espera confirmación de la función RPC `enqueue`.
   **Solamente después responde 200**. Si la base falla, devuelve 503
   para que Kapso pueda reintentar.
4. El worker reclama trabajos con `FOR UPDATE SKIP LOCKED`, lease de 300
   segundos, renovación cada 60 segundos, propietario UUID y generación de
   fence. Revalida la firma, reconstruye el request y llama al controlador
   existente; espera los trabajos programados antes de cerrar el evento.
5. Los eventos fallidos vuelven a `pending`, con backoff y máximo 7 intentos;
   los agotados pasan a `dead`, requieren alerta y revisión manual.
   Un evento completado conserva solo su identificador HMAC, estado y fechas;
   se borra el cuerpo cifrado. No se registra el cuerpo ni el teléfono.

**Advertencia:** esto es entrega *al menos una vez*, NO garantía
automática de entrega exactamente una vez a WhatsApp. El motor usa además
`plusmedik_audit_runs` para evitar respuestas duplicadas y gestionar los
envíos inciertos. Si la llamada externa queda con resultado desconocido,
nunca se debe reenviar automáticamente ese mensaje sin revisión.
El mecanismo de pausa humana, el procesamiento mixto, los tiempos largos,
el fallo entre confirmación de envío y cierre de cola, y el reinicio
del contenedor deben superar pruebas reales controladas antes del corte.

## Activación segura y variables

El SQL no forma parte del manifiesto oficial de migraciones (16); es exclusivo para pruebas aisladas hasta revisión y promoción formal.

La fase 1 sigue siendo el comportamiento por defecto:
`/healthz` = 200 (`webhookReady:false`),
`/readyz` = 503,
`/api/kapso/webhook` = 503.

En un **proyecto Supabase de staging** separado, revisar el SQL experimental
`docs/deploy/sql/plusmedik_dokploy_inbox.staging.sql`;
aplicarla únicamente tras revisión de permisos, cifrado y backups.
Todavía no se ha aplicado mediante esta conversación.
El repositorio contiene pruebas SQL contra PostgreSQL 16 efímero.

Para habilitar exclusivamente un ensayo sintético en Dokploy **después** de
preparar una base de staging y todas las protecciones:

- `PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK=on`
- `PLUSMEDIK_DOKPLOY_WORKER=on`
- `REQUIRE_AUDIT_GUARD=on` (requiere migraciones de auditoría existentes)
- `PLUSMEDIK_DOKPLOY_INBOX_KEY`: clave aleatoria exclusiva, codificada en
  base64, de 32 bytes, distinta de las claves de WhatsApp/CRM. Nunca
  mostrarla en logs o chat ni subirla a GitHub.
- `WEBHOOK_SECRET`: secreto de la firma del webhook utilizado solo con
  mensajes sintéticos en el ensayo.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: credenciales de staging.
  Nunca exponer service_role en navegador, ni compartir claves entre
  staging y producción.

No cambiar el webhook registrado en Kapso. La configuración se comprueba
antes de aceptar tráfico, y `/readyz` exige también que la RPC de salud
de la base responda. **Un 200 en /readyz no es aprobación de corte**: solo
indica que están presentes la configuración y el esquema. Verificar el
worker, los permisos y el comportamiento bajo interrupciones.

### Prueba sintética

Con credenciales exclusivas de staging, enviar un payload sintético firmado,
con `x-webhook-signature` válido, y comprobar:
- `200/QUEUED` solo después de la RPC; con error de base, `503`.
- Misma carga dos veces => una sola fila de inbox.
- Después de procesarse: contenido cifrado eliminado y estado completed.
- Si se reinicia el trabajador antes de completar: lease expira y
  se recupera sin dos respuestas externas.
- El flag OFF implica `503` incluso con firma válida.
- Que no haya respuestas reales ni llamadas a modelos desde las pruebas
  de CI; usar clientes falsos y contactos de prueba autorizados.

## Pendientes para el corte

- Verificar contra el **Supabase real de PlusMedik** que las migraciones
  anteriores existen y `REQUIRE_AUDIT_GUARD=on` tiene efecto. Este proyecto
  no está disponible mediante la conexión actual; no asumir compatibilidad
  solo por las pruebas aisladas.
- Aprobar el tratamiento de información sensible cifrada, política de
  retención, gestión de la clave y acceso a registros `dead`.
- Agregar métricas, alerta para mensajes sin procesar y revisión de
  errores, así como una tarea de purga con retención autorizada.
- Cargar imágenes de prueba por Kapso a staging y completar QA extremo a
  extremo, incluida reconexión, lease vencido y observabilidad.
- Confirmar recursos del VPS y copia de seguridad, consolidar la
  configuración y hacer el corte reversible, sin dos consumidores a la vez.

**En este PR todo permanece en una rama de desarrollo.** Hasta finalizar
la validación, Vercel conserva el webhook de producción.
