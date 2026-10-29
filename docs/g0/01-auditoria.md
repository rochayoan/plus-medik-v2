# G0 · 01 Auditoría de la arquitectura actual

Método: lectura del código y de la historia git de todas las ramas/worktrees locales, de los contratos y migraciones del CRM (solo lectura) y ejecución de la suite offline de la rama actual. No se ejecutó nada contra servicios reales. No se ejecutaron las pruebas de la rama `feat/phase6-persistent-audit` (su `node_modules` está incompleto y sus pruebas de base de datos exigen PostgreSQL local): lo que se afirma de ella viene de leer su código, su README y sus pruebas.

> **Errata (G1, 2026-10-24).** La tabla de ramas de esta sección y las afirmaciones «sin fusionar» de G0 se hicieron contra un `origin/main` desactualizado. Estado real: el PR #6 fusionó `feat/phase6-persistent-audit` en `origin/main` (`dfa98da`) el 2026-10-22; el árbol de `origin/main` es idéntico al de phase6. Ver [../g1/01-estado-git-y-despliegue.md](../g1/01-estado-git-y-despliegue.md). Lo que sigue siendo cierto: migraciones sin aplicar (no confirmado), control humano apagado por defecto, y todo lo demás de este documento sobre capacidades.

## 1. Mapa de ramas: dónde vive cada cosa (corregido en G1: ver errata)

El hallazgo más importante de la auditoría es que **el código está repartido en ramas y el piloto desplegado no tiene los mecanismos de seguridad avanzados**.

| Rama / worktree | Commit | Qué aporta | ¿Fusionada en `origin/main`? |
| --- | --- | --- | --- |
| `origin/main` | `f485ae0` | Motor de recetas + piloto mínimo Kapso (PR #1-#5) | — |
| `feat/kapso-pilot` (checkout actual, `plus-medik-v2`) | `a57b9a8` + cambios sin commit | Igual que el piloto; el trabajo sin commit (`src/uncertainty.ts` y ajustes al log) es idéntico o duplica lo ya commiteado en phase6 (`uncertainty.ts` es byte a byte igual) | Sí (PR #3/#4); la rama quedó atrasada |
| `main` local | `95298a6` | Atrasada respecto a `origin/main` (no tiene el webhook) | — |
| `fix/allow-symbol-marks-in-inheritance`, `fix/fase5-variant-mismatch-original-reads` | — | Correcciones del lector, ya incorporadas por `integration/fase5-cierre` | Sí (PR #5) |
| **`feat/phase6-persistent-audit`** (`plus-medik-v2-phase6-audit`) | `31b9079` (**fusionada en `origin/main` por el PR #6**, `dfa98da`; la columna siguiente decía «No» por error) | Auditoría persistente, telemetría de IA, leases/fencing/reserva de envío, recuperación, control de atención humana, `src/kapso-webhook.ts`, `api/audit/recover.ts`; 5 migraciones SQL; 37 archivos y ~7.800 líneas agregadas respecto de `origin/main` | **No** (6 commits adelante de `origin/main`) |
| `origin/feat/portal-cotizacion-web` | `95c9783` | Portal web de cotización para médicos/convenios (`web/`), tarifas por organización, `ai_usage`, migración propia | **No**; es un producto aparte que reutiliza el core |

Consecuencia: toda fase nueva debe partir de una base que contenga phase6. El README de phase6 lo dice con claridad: *"migraciones NO aplicadas"*, *"función APAGADA por defecto"*.

## 2. Inventario por capacidad

Leyenda: ✅ existe y está probado · 🟡 existe parcialmente o solo en otra rama / sin activar · ❌ no existe.

### 2.1 Kapso y webhook

| Capacidad | Estado | Detalle |
| --- | --- | --- |
| Verificación de firma HMAC-SHA256 del cuerpo crudo, comparación en tiempo constante, falla cerrada sin secreto | ✅ | `verifyWebhookSignature` en `src/whatsapp-quote.ts` |
| Soporte de lotes (`x-webhook-batch`) y cabeceras `x-webhook-event`, `x-idempotency-key` | ✅ (lotes) / 🟡 (cabeceras solo en phase6) | `extractIncomingImages`; `classifyKapsoEvent` y `eventsOf` en `src/human-control.ts` (phase6) |
| Lista blanca de teléfonos para el piloto (`ALLOWED_PHONES`) | ✅ | `isAllowedPhone`; sin definir = abierto a cualquiera |
| ACK inmediato 200 y trabajo en segundo plano (`waitUntil`, `maxDuration: 300`) | ✅ | `api/kapso/webhook.ts`, `vercel.json` |
| Descarga de medios (URL alojada con reintento autenticado, o `media.download` por id) | ✅ | `realDeps.downloadImage` |
| Envío de texto por Kapso | ✅ | `messages.sendText`; solo texto, sin plantillas, botones, listas ni estados "escribiendo" |
| Clasificación de eventos salientes (humano / bot / estados / historial / origen desconocido) | 🟡 phase6 | `classifyKapsoEvent` |
| Procesamiento de texto, audio, PDF, documentos, ubicación, reacciones | ❌ | Se descartan con `200 "ignored"` sin respuesta al paciente |

### 2.2 Procesamiento de mensajes e idempotencia / concurrencia

| Capacidad | `origin/main` y rama actual | phase6 |
| --- | --- | --- |
| Deduplicación de reintentos de Kapso | ❌ solo "responder 200 enseguida" (el README lo admite) | ✅ claim atómico por `message_id` (`plusmedik_audit_claim_run`) |
| Exclusión de ejecuciones concurrentes del mismo mensaje | ❌ | ✅ lease (120 s, latido 40 s) + fencing: toda escritura presenta `owner + fence`; la base rechaza al antiguo con 410 |
| Garantía de "un solo envío" | ❌ | ✅ `reserve_send` bajo bloqueo de fila → `confirm_send` justo antes de llamar a Kapso → resultado; un envío incierto nunca se reintenta (`SEND_OUTCOME_UNKNOWN`) |
| Recuperación de procesamientos interrumpidos | ❌ | 🟡 `plusmedik_audit_recover_stale` + `api/audit/recover.ts` **inerte** (sin cron, sin `CRON_SECRET` responde 503) |
| Evidencia inmutable y transaccional | ❌ | ✅ `record_evidence`/`record_reply` con hash de contenido, triggers anti-UPDATE/DELETE |
| Procesamiento de varias imágenes en un mismo evento | ✅ en paralelo (`Promise.all`), cada una **independiente** | igual |
| Serialización por contacto (varias imágenes seguidas del mismo paciente) | ❌ | ❌ (solo hay exclusión por mensaje, no por contacto) |

### 2.3 IA

| Capacidad | Estado | Detalle |
| --- | --- | --- |
| Dos lectores multimodales independientes (Gemini vía OpenRouter, OpenAI) + consenso + juez solo en disputas | ✅ | `src/ai.ts`, `consensus.ts`, `judge.ts` |
| Señal de documento (tipo, integridad, función del documento, contexto impreso) | ✅ | `document-signal.ts`, `document-function.ts` |
| Resolución semántica contra el catálogo completo + verificador determinista | ✅ | `catalog-shadow.ts`, `catalog-semantic-resolver.ts` |
| Verificación de impacto de zonas no visibles | ✅ | `study-impact.ts`, `visual-risk.ts` |
| Caché local, registro de uso, guarda de gasto, modo offline centralizado | ✅ | `cache.ts`, `offline.ts`, `scripts/lib/paid-guard.ts`; en Vercel `AI_CACHE=off` |
| Telemetría por llamada y clasificación de fallos | 🟡 phase6 | `withAiCallObserver`, migración de telemetría |
| Modelo de lenguaje para **conversar** (intención, redacción, preguntas) | ❌ | Todos los prompts existentes son de lectura de imágenes/catálogo |
| Límite de gasto o de frecuencia por contacto dentro del webhook | ❌ | `ALLOWED_PHONES` es el único freno; la guarda de gasto aplica a scripts, no al runtime |

### 2.4 Recetas y cotización

| Capacidad | Estado |
| --- | --- |
| Salida `outcome`: `AUTO_COMPLETE` / `AUTO_PARTIAL` / `HUMAN_REVIEW`; `publicQuote` (paciente) separada de `internal` (CRM) | ✅ `partial-auto.ts` |
| Precio siempre de `lab_tests.price_bs` (tarifa Paciente), una línea por UUID, sin doble cobro paquete+componente | ✅ |
| Clasificación de la incertidumbre por bloqueo (`READING` / `IDENTITY` / `DOCUMENT` / `POLICY`) | ✅ `uncertainty.ts` (en rama actual sin commit; commiteado en phase6) |
| Completar una cotización parcial con resoluciones humanas sin duplicar cobros, con control de revisión (`revision`) | ✅ `quote-completion.ts` — **función pura sin persistencia ni llamador** |
| Mensaje al paciente: lista de estudios, precios y "Total de los estudios cotizados"; mensaje de "foto más clara"; mensaje técnico neutro | ✅ `whatsapp-quote.ts` |
| Cotización a partir de **texto** (lista escrita por el paciente) | ❌ |
| Una receta de varias páginas/imágenes como una sola cotización | ❌ (cada imagen responde por separado y puede duplicar estudios) |
| Cotización persistida (folio, vigencia, huella del catálogo con que se calculó) | 🟡 La huella (`catalogFingerprint`) se guarda en la auditoría de phase6; no hay entidad "cotización" |
| Tarifas por convenio/organización | 🟡 Solo en el portal web (rama sin fusionar, migración sin aplicar); el motor y el webhook usan solo Paciente |
| Preparación del estudio, ayuno, instrucciones, tiempo de entrega | ❌ |

Limitación visible hoy: **todo `HUMAN_REVIEW` produce el mismo mensaje "envía una foto más clara"**, aunque la causa sea de identidad o de política y una foto mejor no la resuelva. El paciente queda sin camino y nadie del laboratorio se entera.

### 2.5 Handoff humano

| Capacidad | Estado |
| --- | --- |
| Pausa automática de la IA cuando una persona escribe desde WhatsApp Business (`origin: business_app`) | 🟡 phase6, apagada (`PLUSMEDIK_HUMAN_CONTROL`), exige `PLUSMEDIK_CONTACT_HMAC_KEY` dedicada |
| Estado persistente `ACTIVE` / `HUMAN_PAUSED` por contacto (HMAC, sin guardar el teléfono), eventos inmutables, reactivación explícita (`plusmedik_attention_resume`) | 🟡 phase6 |
| Coordinación pausa ↔ envío (claim no procesa pausados; pausar bloquea pendientes; reserva y confirmación vuelven a consultar) | 🟡 phase6; carrera residual documentada |
| Pausa **manual** desde el CRM e idempotente por `operationId` | ❌ (el contrato lo exige y prohíbe reutilizar `register_human_message`) |
| Endpoints `POST /api/internal/crm/attention/status` y `/action` | ❌ |
| Envío de casos no resueltos al CRM | ❌ (el CRM tiene el receptor, apagado) |
| Mensaje al paciente que anuncie la revisión humana | ❌ |

### 2.6 Políticas, horarios, preparación, catálogo de laboratorio

| Elemento | Estado |
| --- | --- |
| Catálogo de estudios (`lab_tests`: id, code, name, normalized_name, price_bs, active, category, sample_type) y alias (`lab_test_aliases`) | ✅ lectura solo con `loadActiveCatalog`; 541 estudios activos y 544 totales en el último informe local (18-oct); se carga completo de Supabase **en cada imagen** |
| Cobertura de alias aprobados | 🟡 20 aprobados en el informe de cobertura; 604 recomendados sin colisiones pendientes de decisión del laboratorio |
| Políticas comerciales (formas de pago, domicilio, entrega de resultados, facturas, convenios) | ❌ — en el código no hay ninguna (búsqueda de "horario", "ayuno", "preparación", "política", "sucursal", "domicilio" en `src/` y `api/`: sin resultados) |
| Horarios y sucursales | ❌ |
| Preparación de estudios | ❌ — `sample_type` es lo único cercano |
| Decisiones del laboratorio ya identificadas como pendientes | 🟡 composición/precio de perfiles (lipídico), variante por defecto (TSH, VIH, BUN/Urea), si un cultivo incluye antibiograma, AM/PM = 08:00/16:00, paquete vs suma (p. ej. 177) |

## 3. Reutilizable vs. faltante (matriz de decisión)

| Componente | Decisión | Nota |
| --- | --- | --- |
| `analyzeImage` y toda la cadena de lectura/catálogo/seguridad | **Reutilizar sin cambios** | Es la parte validada; cualquier cambio exige la batería offline y autorización de gasto |
| `publicQuote` / `internal` | **Reutilizar** | Es el contrato natural hacia paciente y hacia CRM |
| `completeQuote` | **Reutilizar y conectar** | Falta persistencia y quién la invoca (G4/G6) |
| Verificación de firma, lista blanca, ACK+`waitUntil`, límites de imagen | **Reutilizar** | |
| Claim/lease/fencing/reserva/confirmación, auditoría inmutable, recuperación | **Reutilizar (rama phase6)** | Generalizar de "imagen" a "turno" en G2 |
| Control de atención humana (`human-control.ts` + migración 5) | **Reutilizar y extender** | Agregar pausa manual por operación del CRM (G5) |
| `uncertaintyKinds` | **Reutilizar** | Base del triage hacia el CRM |
| `catalogFingerprint` | **Reutilizar** | Base de la vigencia de la cotización |
| Mensajes de `whatsapp-quote.ts` | **Reutilizar y mover a un compositor de respuestas** | Hoy son constantes en el módulo |
| Tarifas por convenio del portal | **Diferir** | Producto aparte; se evalúa en G4 solo si el dueño lo decide |
| Router de eventos de cualquier tipo, estado de conversación | **Construir (G2)** | |
| Base de conocimiento, horarios, preparación | **Construir (G3)** | |
| Cotización desde texto, sesión multi-imagen, preparación en la cotización | **Construir (G4)** | |
| Outbox + emisor al CRM, endpoints de control de atención | **Construir (G5)** | |
| Bucle de correcciones | **Construir (G6)** | |
| Límites por contacto / presupuesto en runtime, alertas, runbook | **Construir (G7)** | |

## 4. Hallazgos y deudas (ordenados por impacto)

1. **(corregido en G1) Base de seguridad fusionada pero con migraciones sin aplicar.** El código está en `origin/main`; sin las migraciones la deduplicación, el lease y la pausa no operan y el webhook responde como el piloto (fail-open, verificado con una simulación en G1).
2. **Silencio ante cualquier mensaje que no sea imagen.** Un paciente que escribe "hola" o "¿a qué hora abren?" no recibe nada.
3. **`HUMAN_REVIEW` y `AUTO_PARTIAL` no llegan a ninguna persona.** Los pendientes viven solo en el log del servidor (y en la auditoría de phase6, que a propósito no guarda texto de estudios).
4. **Manuscritas activadas por código** (`handwrittenAuto: "on"` en el webhook) frente a la advertencia del README. Confirmar con el dueño.
5. **Cada imagen pide el catálogo completo a Supabase** (dos consultas paginadas) y la receta tarda 1-2 min sin acuse al paciente.
6. **Sin serialización por contacto**: dos fotos seguidas generan dos respuestas independientes con posibles estudios repetidos.
7. **Mensajes del CRM no pausan la IA** (`origin: cloud_api` se clasifica como "bot propio"); depende del contrato `attention/action`.
8. **Recuperación (`api/audit/recover`) inerte** y dependiente del plan de Vercel para su cron.
9. **El árbol de trabajo actual tiene cambios sin commit** (`src/partial-auto.ts`, `src/whatsapp-quote.ts`, pruebas, `src/uncertainty.ts`). Duplican trabajo ya commiteado en phase6; conviene resolverlos en G1 en lugar de sumar una tercera versión.
10. **Bloqueo de coordinación con el CRM:** el receptor de casos devuelve `409 message_not_ingested` hasta que el CRM ingiera el mensaje original, y su webhook propio está sin registrar a la espera de verificar la coexistencia con el del agente.

## 5. Contratos del CRM (lado receptor, solo lectura)

Tomados de `CRM-PLUSMEDIK/docs/AGENT_REVIEW_CASE_CONTRACT.md` y `AGENT_ATTENTION_CONTROL_CONTRACT.md` (están sin commit en el árbol de trabajo del CRM y su código receptor existe y está apagado). Resumen de lo que el agente debe cumplir:

- **Revisión:** `POST /api/internal/agent/review-case`, `Authorization: Bearer` con `PLUSMEDIK_AGENT_REVIEW_INGEST_TOKEN` (≥ 32 caracteres, exclusivo agente→CRM). Campos obligatorios: `eventId`, `requiresReview: true`, `kapsoMessageId`, `contactPhone` (≥ 8 dígitos), `phoneNumberId`, `failureReason` (≤ 1000), `detectedTests` (arreglo, ≤ 60). Opcionales: `recipeMediaId`, `auditId`, `agentResult`. Evidencia total ≤ 40.000 caracteres (si no, 413). Respuestas: creado / duplicado / `409 message_not_ingested` / 503 apagado.
- **Atención:** `POST /api/internal/crm/attention/status` y `/action` en el agente, con `PLUSMEDIK_AGENT_CONTROL_TOKEN` (exclusivo CRM→agente). El agente calcula internamente el `contact_key` (el CRM nunca conoce la clave HMAC) y es la única fuente de verdad de `ACTIVE`/`HUMAN_PAUSED`. `operationId` es idempotente; nunca `confirmed: true` ante incertidumbre. El CRM aborta a los 5 s y no reintenta solo.
- **Reglas transversales:** el agente no sube imágenes al CRM (solo `recipeMediaId`); `detectedTests`/`agentResult` son evidencia histórica que el CRM no interpreta; las correcciones se guardan en `crm.review_case_corrections` y **no producen entrenamiento automático, cambios de prompt ni cambios de catálogo**.
- **Aislamiento de datos:** el CRM vive en el esquema `crm`; el agente en `public`; el CRM solo hace `SELECT` en `lab_tests`/`lab_test_aliases`. Sin claves foráneas cruzadas.
