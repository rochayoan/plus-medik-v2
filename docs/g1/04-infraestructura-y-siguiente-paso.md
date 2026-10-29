# G1 · 04 Infraestructura reutilizable, riesgos, recomendación y siguiente paso (G2)

## 1. Estado de la infraestructura reutilizable

Estado = verificado por pruebas en G1 (PostgreSQL real efímero) · operativo = funcionando en producción.

| Mecanismo | Dónde | Pruebas | Operativo en producción hoy | Para activarlo |
| --- | --- | --- | --- | --- |
| Firma HMAC del webhook, lista blanca de teléfonos, límites de imagen | `whatsapp-quote.ts`, `kapso-webhook.ts` | ✅ | Sí (código desplegado) | — |
| ACK 200 inmediato + trabajo en segundo plano | `api/kapso/webhook.ts` | ✅ | Sí | — |
| Claim atómico por `message_id` (idempotencia) | migraciones 4-5, `audit.ts` | ✅ 38 + 21 + e2e | **No** (sin migraciones degrada a piloto) | Aplicar migraciones |
| Lease + fencing + latido | migración 4 | ✅ | **No** | ídem |
| Reserva de envío + confirmación + "envío incierto no se reenvía" | migraciones 4-5 | ✅ | **No** | ídem |
| Auditoría transaccional e inmutable, telemetría de IA | migraciones 1-3 | ✅ 57 + 52 + 24 | **No** | ídem |
| Recuperación de corridas interrumpidas | migración 4 + `api/audit/recover.ts` | ✅ | **No** (ruta inerte sin `CRON_SECRET`/cron) | Migraciones + secreto + planificador |
| Pausa por intervención humana (canal `business_app`) | migración 5, `human-control.ts` | ✅ 59 + 31 + 24 | **No** (bandera apagada) | Migraciones + HMAC + bandera + eventos salientes |
| Pausa manual desde el CRM, endpoints `attention/*` | — | — | Inexistente | G5 |
| Emisor de casos al CRM | — | — | Inexistente | G5 |
| Interpretación de recetas (`analyzeImage`, `evaluatePartial`) | `analyze.ts` y módulos | ✅ (la mayor parte de las 1347) | Sí | — **No se modificó** |
| Modo offline, guarda de gasto, caché | `offline.ts`, `cache.ts`, `scripts/lib` | ✅ | Sí (scripts/pruebas) | — |

Todo se reutiliza tal cual; **no hay reconstrucción pendiente**. Las únicas piezas que G2-G5 extienden son: el conjunto cerrado de tipos de envío (`quoted | no_quote | technical_issue`, repetido como restricción en SQL y TypeScript), la restricción de `kind` de `plusmedik_attention_events`, y el hecho de que el claim/lease solo se invoca hoy para imágenes.

## 2. Riesgos técnicos priorizados

| # | Riesgo | Severidad | Dónde se mitiga |
| --- | --- | --- | --- |
| 1 | Producción sin deduplicación/lease/pausa mientras no se apliquen las migraciones | Alta | [02 §3](02-migraciones-y-pruebas.md) |
| 2 | Banderas activadas antes que las migraciones silencian al bot | Alta | Orden documentado; probado por simulación |
| 3 | Mensajes del CRM (`cloud_api`) no pausan la IA | Alta cuando el CRM envíe | [03 §2](03-atencion-humana-crm.md): L1 + L2 |
| 4 | El webhook de Kapso puede no recibir eventos salientes → la pausa humana no se dispararía nunca | Alta para el control humano | Verificar suscripción antes de activar |
| 5 | Despliegue de producción y variables desconocidos | Media-alta | Confirmación del dueño |
| 6 | Sin purga/retención de datos de auditoría; triggers impiden DELETE | Media | Migración de retención (G7) |
| 7 | PostgREST real y versión de PostgreSQL de Supabase sin verificar | Media | Staging con RPC reales |
| 8 | `handwrittenAuto: "on"` activo por código pese a la advertencia del README | Media | Confirmación del dueño |
| 9 | Recuperación periódica inactiva | Media | Planificador (decisión 7 de G0) |
| 10 | Cada imagen carga el catálogo completo de Supabase y no hay acuse al paciente durante 1-2 min | Baja-media | G2 (acuse) y G4 (caché) |
| 11 | Un único envío por mensaje de imagen; las imágenes del mismo contacto no se serializan | Baja-media | G2 (bloqueo por contacto) |
| 12 | Cambios sin commit en `plus-medik-v2` (redundantes, respaldados) | Baja | Archivar tras confirmar |

## 3. Recomendación fundamentada (tarea 7)

**Consolidar = no fusionar nada; activar con orden. Y no empezar G2 sobre una base cuyo mecanismo de seguridad no está operativo.**

Fundamentos:

1. La evidencia de código es completa: `origin/main` contiene phase6 íntegra, y su suite (incluida la de PostgreSQL real) pasa 1347/1347 en una instalación limpia aislada.
2. El riesgo que queda no está en el código sino en el orden de activación y en cuatro hechos no verificables desde aquí (despliegue de producción, variables, versión/mapeo de Supabase, eventos salientes de Kapso).
3. G2 generaliza el claim/lease a "turnos" con una migración nueva; hacerlo sin haber ensayado las cinco anteriores obligaría a descubrir sus problemas mezclados con los de G2.

Plan:

| Orden | Paso | Quién | Riesgo |
| --- | --- | --- | --- |
| 1 | Confirmar el despliegue de producción y las variables (ver [00](00-resumen.md)) | Dueño | Ninguno |
| 2 | Decidir si se hace commit de `docs/` en `integration/g1-consolidacion` y si se abre un PR de solo documentación | Dueño | Ninguno |
| 3 | Ensayar las 5 migraciones y las RPC por HTTP en staging | Dueño autoriza; ejecución asistida | Bajo (entorno de ensayo) |
| 4 | Aplicar en producción, `REQUIRE_AUDIT_GUARD=on`, validar con `ALLOWED_PHONES` | Dueño | Medio, acotado por el orden y la lista blanca |
| 5 | Activar control humano en números de prueba tras confirmar eventos salientes | Dueño | Medio |

## 4. Siguiente paso concreto para iniciar G2

G2 (runtime de turnos) puede arrancar **en paralelo** con los pasos 1-3 porque su primera mitad es solo local y offline:

**G2.0 — pruebas primero, sin tocar producción (sobre `integration/g1-consolidacion`):**

1. Crear la rama `feat/g2-turnos` desde `integration/g1-consolidacion` y escribir las pruebas que definen el contrato, **antes** del código, con el arnés existente (PostgreSQL efímero y webhook real con Kapso/motor simulados):
   - un mensaje de texto, audio, PDF o ubicación recibe el mismo tratamiento seguro que hoy una imagen: un claim, una reserva, un solo envío, auditoría, y respeta la pausa humana;
   - un mensaje duplicado de cualquier tipo no genera segunda respuesta;
   - imagen → cotización conserva exactamente su comportamiento actual (no regresión: reutilizar la suite existente);
   - dos mensajes del mismo contacto se serializan.
2. Diseñar la **migración 6** aditiva (nombre sugerido `20261025…_plusmedik_turns.sql`; no modifica las cinco anteriores) que: amplíe el conjunto de tipos de envío (`quoted | no_quote | technical_issue` → añade los de turno: acuse, mensaje fijo, derivación a persona), amplíe `plusmedik_attention_events.kind` (pausa manual del CRM y saliente ajeno, hallazgo M4) y agregue el tipo de mensaje entrante y el bloqueo por `contact_key`. Revisarla y probarla **solo contra el PostgreSQL efímero**; no aplicarla.
3. Generalizar el tipo `IncomingImage` de `src/whatsapp-quote.ts` a un evento entrante con `kind`, manteniendo `extractIncomingImages` y `handleImageMessage` sin cambios de comportamiento, y añadir el router de eventos con política fija por tipo (acuse y oferta de persona; sin IA de conversación todavía).
4. Texto de los mensajes fijos: **requiere aprobación del laboratorio** (decisión 5 de G0); hasta entonces, plantillas marcadas como borrador y desactivadas por bandera.

**G2.1 — cuando los pasos 1-4 del plan estén hechos:** ensayar la migración 6 en staging junto con las cinco anteriores, y activar el router solo para `ALLOWED_PHONES`.

No hay que empezar G3 (políticas/horarios) ni G4 antes de que G2.0 tenga las pruebas en verde.
