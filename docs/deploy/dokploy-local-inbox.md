# PlusMedik V2 → Dokploy, inbox cifrado en volumen local (SIN nuevas migraciones SQL)

**Estado:** opción de despliegue preparada en `feat/dokploy-durable-inbox`. No cambia el esquema de Supabase, no importa ni copia datos de Supabase y NO cambia el webhook de Kapso automáticamente. **No habilitar mensajes reales hasta aprobar las pruebas de extremo a extremo.**

## Arquitectura

Kapso → HTTPS Dokploy `/api/kapso/webhook` → HMAC de firma → AES-256-GCM → archivo cifrado con `fsync` en volumen persistente → ACK 200 → worker de la misma instancia → **Supabase existente** (catálogo, auditoría y sesiones mediante funciones originales) → Kapso API.

Los archivos de trabajos completados pierden el contenido cifrado; retienen un identificador HMAC para deduplicar reintentos. Los fallidos se reintentan (máx. 7) con leases de 5 min. Las entradas muertas requieren intervención manual. **Una sola réplica de Dokploy**: no es una cola para despliegues con múltiples workers concurrentes ni varios servidores.

Este modo evita añadir la tabla de inbox a Supabase. **NO elimina la dependencia del Supabase original:** las credenciales `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` siguen siendo necesarias para el motor de cotización.

## 1. Añadir un volumen real en Dokploy

Aplicación **Agente Plusmedik**, no editar CRM, cotizador ni bd_cotizador.

- En **Advanced → Mounts** de la aplicación, seleccionar **Volume Mount** (volumen Docker gestionado). Usar un nombre estable y exclusivo, por ejemplo `plusmedik-agent-inbox`, con **Mount Path `/data`**. Este montaje debe sobrevivir a deploy/recreate. No usar File Mount, un volumen temporal ni la capa efímera del contenedor.
- El Dockerfile crea `/data/plusmedik-inbox` y asigna su propietario al usuario `node` (UID 1000) dentro de la imagen. Verificar que el volumen montado permita escritura al UID 1000; los host-bind mounts pueden requerir ajustar permisos del directorio del host de forma independiente.
- El runtime inspecciona `/proc/self/mountinfo` y requiere un montaje exacto en `/data` o `/data/plusmedik-inbox`; si no existe, responde 503. Solo crear el directorio dentro del contenedor NO basta.
- Configurar **1 réplica** para este servicio. No reemplazar el volumen ni borrarlo entre deploys. Salvaguardar el volumen y la clave AES: si se pierde el volumen se pierden mensajes no procesados, y si se pierde la clave no se podrán leer.

## 2. Variables privadas en Dokploy

Esta sección es un **inventario**, nunca pegar secretos en GitHub, capturas ni chats. Mantener los flags de activación apagados mientras se configuran las variables.

Configuración de cola en el VPS:

```dotenv
PLUSMEDIK_DOKPLOY_INBOX_STORAGE=local
PLUSMEDIK_DOKPLOY_SPOOL_DIR=/data/plusmedik-inbox
PLUSMEDIK_DOKPLOY_VOLUME_CONFIRMED=on
PLUSMEDIK_DOKPLOY_INBOX_KEY=<32 bytes aleatorios base64, 44 caracteres>
```

La clave AES de la cola es **nueva, exclusiva**, distinta de cualquier token previo y estable entre reinicios. Para generarla localmente sin publicarla: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Guardarla en un gestor de secretos y en Dokploy; nunca en `NEXT_PUBLIC_*`.

Credenciales existentes del **mismo PlusMedik**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_SECRET`, `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`. Verificar que sean del agente PlusMedik y no de otros clientes. No transferir claves por chat.

Guardias y flags **solamente cuando estemos listos para las pruebas**:

```dotenv
REQUIRE_AUDIT_GUARD=on
PLUSMEDIK_DOKPLOY_WORKER=on
PLUSMEDIK_DOKPLOY_ACCEPT_WEBHOOK=on
```

Con esas banderas, el receptor se declara configurado si el resto de variables también existe. **Activarlas únicamente en un ensayo controlado y no registrar aún el webhook de Kapso.**

Para habilitar turnos + conversación de texto, **seguir el piloto y el resto de guards del agente existente**. Requisitos relevantes: `PLUSMEDIK_TEXT_PILOT_GUARD=on`, un solo teléfono en `PLUSMEDIK_AGENT_CONTROL_PHONES`, `PLUSMEDIK_CONTACT_HMAC_KEY` válido, `PLUSMEDIK_TURNS=on`, `PLUSMEDIK_TEXT_HANDLER=on`, `PLUSMEDIK_REPLY_GUARD=on`. Las cotizaciones por texto no estarán activas si esas banderas siguen apagadas. Para ensayos iniciales limitar `ALLOWED_PHONES` al número de control.

## 3. Validación y corte gradual

1. Tras un deploy manual, verificar `/healthz` HTTP 200 (solo proceso vivo).
2. Verificar `/readyz` HTTP 200 **únicamente** con flags, claves y volumen correctos; no basta para declarar aptitud de producción.
3. Enviar un evento sintético **firmado** que no contenga mensajes de pacientes ni desencadene envíos. Verificar `200/QUEUED` solo tras persistencia, `401` firma inválida, `503` si el volumen no es accesible; mismo evento duplicado → un archivo, contenido cifrado, finalización sin cuerpo. Ejecutar solo en un entorno aislado de prueba o con evento no procesable.
4. Confirmar recuperación tras reinicio del contenedor, reintentos tras interrupciones, estados `dead`, errores de Supabase y de Kapso, más pruebas de imagen y texto con teléfono de piloto. Monitorizar en logs eventos `inbox_claim_unavailable`, `inbox_finish_unavailable`, `inbox_job_retry_scheduled`, `inbox_lease_lost`.
5. Aprobar un corte reversible y cambiar **un único webhook de Kapso** de Vercel a Dokploy. Mantener Vercel como rollback; nunca activar dos destinos simultáneos para el mismo número.

**Riesgo residual:** el almacenamiento local de una réplica no replica mensajes a otro VPS ni reemplaza backups. Una caída de disco o borrado de volumen puede causar pérdida irreversible. La confirmación de envío de WhatsApp también puede ser ambigua después de un corte de red; el ledger original mitiga duplicados pero no promete exactamente una vez.

## Estado del SQL

`docs/deploy/sql/plusmedik_dokploy_inbox.install.sql` y `...staging.sql` quedan **sin ejecutar** y no se usan en este modo. No modificar el Supabase actual por la migración del agente.
