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

## Usar el Supabase existente de PlusMedik: sin crear otro proyecto

El laboratorio conserva su Supabase actual (`cvokrtrdzxfchntwwslz`) y sus 16 migraciones oficiales.
La cola utiliza nombres adicionales `plusmedik_dokploy_*`, sin alterar el catálogo,
las tablas de auditoría, las sesiones ni la configuración del CRM. No se debe aplicar
el SQL a un Supabase de otros negocios ni a una base externa de Dokploy.

**Secuencia obligatoria antes de permitir un webhook real:**

1. En el SQL Editor del proyecto de PlusMedik, revisar y ejecutar SOLO la consulta
   `docs/deploy/sql/plusmedik_dokploy_existing_db_preflight.readonly.sql`.
   No necesita credenciales ni devuelve información de pacientes.
2. Ejecutar también `supabase/preflight/v2_post_apply_read_only.sql` para comprobar
   las 16 migraciones oficiales. Si cualquier fila aparece como BLOCK, investigar.
3. Verificar la copia de seguridad y confirmar permisos y acceso del equipo.
   Revisar **Database → Backups** en Supabase y verificar la política del
   plan: algunos planes no incluyen copias diarias. En caso de no disponer de
   respaldo reciente, realizar una exportación con herramientas oficiales,
   mantenerla fuera del repositorio y comprobar la posibilidad de restaurarla.
   NO basta con que el SQL sea aditivo: el despliegue requiere respaldo real.
   El SQL aditivo `docs/deploy/sql/plusmedik_dokploy_inbox.staging.sql` es
   **DRAFT NO APROBADO PARA PRODUCCIÓN**; no ejecutarlo todavía. El SQL incluye una
   transacción única y falla si detecta una instalación previa (no reemplaza datos).
4. Una vez revisado formalmente el SQL aditivo y aplicada la versión aprobada,
   ejecutar `docs/deploy/sql/plusmedik_dokploy_existing_db_postflight.readonly.sql`
   y confirmar que todas las comprobaciones están en OK.
5. Solo después configurar las variables privadas de Dokploy y realizar pruebas
   sintéticas controladas. **Kapso seguirá apuntando a Vercel** hasta el corte
   autorizado y reversible.

La conexión Supabase disponible en este chat actualmente no incluye el proyecto
de PlusMedik; por eso esta secuencia de SQL Editor es manual y no se debe
confundir un resultado sobre otro proyecto con una validación real.

## Activación segura y variables

El SQL no forma parte del manifiesto oficial de migraciones (16); es exclusivo para pruebas aisladas hasta revisión y promoción formal.

La fase 1 sigue siendo el comportamiento por defecto:
`/healthz` = 200 (`webhookReady:false`),
`/readyz` = 503,
`/api/kapso/webhook` = 503.

En el **Supabase existente de PlusMedik**, y solo después del preflight sin BLOCK y de confirmar el backup, revisar el SQL experimental
`docs/deploy/sql/plusmedik_dokploy_inbox.staging.sql`;
aplicarlo únicamente tras aprobación de permisos, cifrado y backups; nunca ejecutar esta versión DRAFT directamente en producción.
Todavía no se ha aplicado mediante esta conversación.
El repositorio contiene pruebas SQL contra PostgreSQL 16 efímero.

Para habilitar exclusivamente un ensayo sintético en Dokploy **después** de
instalar una versión revisada de la cola en la base existente y de configurar todas las protecciones:

- `PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK=on`
- `PLUSMEDIK_DOKPLOY_WORKER=on`
- `REQUIRE_AUDIT_GUARD=on` (requiere migraciones de auditoría existentes)
- `PLUSMEDIK_DOKPLOY_INBOX_KEY`: clave aleatoria exclusiva, codificada en
  base64, de 32 bytes, distinta de las claves de WhatsApp/CRM. Nunca
  mostrarla en logs o chat ni subirla a GitHub.
- `WEBHOOK_SECRET`: secreto de la firma del webhook utilizado solo con
  mensajes sintéticos en el ensayo. No enviar mensajes a pacientes durante la prueba.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: credenciales privadas del Supabase existente. No exponerlas fuera del servidor.
- `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`: necesarios para declarar el receptor configurado. Usar exclusivamente credenciales de prueba aprobadas; **si faltan, el webhook devuelve 503 sin aceptar eventos**.
  Nunca exponer service_role en navegador ni en repositorios.

Para habilitar **turnos o texto** se exige además:
`PLUSMEDIK_TEXT_PILOT_GUARD=on`, exactamente un teléfono en
`PLUSMEDIK_AGENT_CONTROL_PHONES` incluido en `ALLOWED_PHONES` cuando
esa lista esté limitada, y una `PLUSMEDIK_CONTACT_HMAC_KEY` exclusiva de
al menos 32 caracteres. Si se enciende `PLUSMEDIK_TEXT_HANDLER`, también
se exige `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_REPLY_GUARD=on`.
La cotización conversacional exige el manejador de texto; la conversación
OpenAI exige además un `OPENAI_CONVERSATION_MODEL` configurado.
Con estas dependencias incompletas se rechaza el webhook con 503.

No cambiar el webhook registrado en Kapso. La configuración se comprueba
antes de aceptar tráfico, y `/readyz` exige también que la RPC de salud
de la base responda. **Un 200 en /readyz no es aprobación de corte**: solo
indica que están presentes la configuración y el esquema. Verificar el
worker, los permisos y el comportamiento bajo interrupciones.

### Prueba sintética

Con un conjunto de credenciales de prueba controladas y sin pacientes reales, enviar un payload sintético firmado,
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

- Verificar con el **preflight del Supabase real de PlusMedik** que las migraciones
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
