# G5.0 · Resultados, bloqueos, riesgos y condiciones de activación

## 1. Resultado de las pruebas (offline; PostgreSQL 18 efímero; receptor del CRM simulado)

| Dato | Valor |
| --- | --- |
| `tsc --noEmit` | sin errores |
| Suite completa | **86 archivos / 2421 pruebas, todas en verde**, en dos corridas completas consecutivas (≈ 4,5 min cada una). Las **2256** previas siguen pasando; **165 son nuevas** |
| Cambios a pruebas existentes | Solo contratos que cambiaron a propósito: `.env.example` ya no carece de «HANDOFF» (ahora una sola bandera en blanco), las sesiones de G4.0 pueden mencionar al CRM solo mediante `crmHandoff` y la lista de «dónde puede aparecer» admite `src/crm-outbox/`; conteo de migraciones (13); el adaptador de pruebas (RPC nuevas) |
| Gasto / red | cero llamadas a modelos, Kapso, Supabase real o CRM real |

| Archivo nuevo | Pruebas | Cubre |
| --- | --- | --- |
| `tests/crm-outbox-db.test.ts` | 45 | SQL real: esquema/privilegios (sin `payload_cipher` ni arrendamiento para `service_role`), encolado idempotente y anclado al mensaje, arrendamiento y *fence* (también para el mismo emisor), reclamo con `skip locked`, intentos acotados, esperas, token rechazado, rechazos permanentes, vencimiento y borrado de la carga, reencolado, estadísticas, objetivos de revisión de sesión |
| `tests/crm-outbox.test.ts` | 81 | Carga (límites, sin texto literal, cifrado/AAD/manipulación), cliente (clasificación de respuestas, `redirect:"manual"`, token y URL, tiempo límite, nada se registra), servicio (intento inmediato, reintentos, 409, `LOST`), ruta de reintentos, destinatario de derivación, configuración |
| `tests/crm-outbox-e2e.test.ts` | 21 | Webhook real → turno → cola → receptor simulado con el contrato real: confirmación solo con registro; 409 `message_not_ingested` y desconocido; caída/reinicio; concurrencia; pausa humana; médico con aviso de emergencia; cotización con varios mensajes dudosos; estudio retirado; sin duplicados |
| `tests/crm-outbox-boundaries.test.ts` | 15 | El motor de recetas no la conoce; imports mínimos; solo `client.ts` usa la red; sin registros de secretos; carga solo cifrada; sin escritura directa al CRM; apagado por defecto; migración con permisos mínimos |
| `tests/production-defaults.test.ts` (+3) | 3 | Bandera sola sin efecto; configuración incompleta ⇒ derivación bloqueada y solo un código en el registro; ruta de reintentos inerte (503) |

### Pruebas de mutación (16 reglas críticas debilitadas a propósito; las 16 detectadas)
Confirmar sin registro (1) · 409 como éxito (2) · seguir redirecciones con el token (3) · revisión confirmada sin registro (4) · aviso médico perdido (5) · pendiente informado como registrado (6) · arrendamiento perdido como registrado (7) · cifrado sin dato asociado (8) · carga no borrada al enviar (9) · registro sin *fence* (10) · reclamo sin contar el intento (11) · reintentos sin tope (12) · encolar sin comprobar el origen (13) · mismo origen encolado dos veces (14) · token rechazado reintentado enseguida (15) · ruta de reintentos sin secreto (16).
**Una (la 10) sobrevivió al principio**: la prueba existente usaba otro emisor al retomar, así que el dueño distinto ya lo rechazaba. Se añadió el caso del **mismo emisor** con *fence* anterior y se volvió a mutar: detectada. Tras la corrida se verificó por huellas que los archivos quedaron restaurados y se eliminaron las copias.

## 2. Bloqueos (nada de esto se hizo)

| Sistema | Bloqueo | Efecto hoy |
| --- | --- | --- |
| **Supabase** | **Trece** migraciones sin aplicar; sin staging; el mapeo HTTP real de PostgREST para las RPC nuevas (`uuid`, `text[]`, `jsonb`, `boolean`) sin verificar | Sin la 13, el encolado falla ⇒ el paciente **no** recibe promesa (falla cerrado, probado) |
| **CRM** | Receptor existente pero **sin verificar en vivo**: bandera `PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED`, token ≥ 32, y que el CRM **ingiera el mensaje original** del paciente (si no, `409` permanente). Faltan `caseKind`/`reasonCode`, agrupación por solicitud y resolución de vuelta (ver doc 10 §1) | Con el CRM apagado/sin ingesta, los casos quedan `PENDING`/`DEAD` y el paciente no recibe promesa |
| **Reintentos programados** | `vercel.json` **no** programa `/api/outbox/drain` (a propósito). Sin cron, solo se reintenta en el turno | Un caso pendiente no se reintenta hasta programarlo |
| **Vercel** | Variables y `CRON_SECRET` sin confirmar; despliegue de producción sin decidir | — |
| **Laboratorio / operación** | Quién atiende la cola de revisión del CRM y en qué plazo; textos `handoff_confirmed`, `medical_handoff_confirmed`, `review`, `review_confirmed` sin aprobar | La promesa «una persona te escribirá» necesita un responsable real |
| **Kapso** | Sin verificar eventos de texto ni *coexistence* | Igual que antes |

## 3. Riesgos propios de G5.0

| # | Riesgo | Severidad | Mitigación / estado |
| --- | --- | --- | --- |
| R1 | **Promesa sin atención**: el CRM registró el caso, pero nadie lo atiende | Alta (operativa) | Fuera del alcance del código; exige un responsable y un plazo antes de activar. El texto no promete plazo |
| R2 | **Ingesta del mensaje en el CRM no garantizada**: `409` permanente | Alta | Verificar en staging; hasta entonces el paciente no recibe promesa. `MESSAGE_NOT_INGESTED` se reintenta hasta 8 veces/7 días y luego `DEAD` |
| R3 | **El teléfono está en el cuerpo cifrado** (el CRM lo exige) | Media | AES-256-GCM, clave fuera de la base, borrado al enviar o vencer. La clave debe rotarse con un plan (hoy una sola clave; ver §4) |
| R4 | **Latencia del turno**: el primer intento ocurre antes de responder (hasta 5 s por intento, 2 intentos, 1,5 s entre ellos) | Media | Solo reintenta en resultados que lo ameritan; el límite del turno de Vercel no se comprobó con carga real |
| R5 | **Pérdida del acuse**: el CRM crea el caso pero la respuesta no llega ⇒ el paciente recibe texto sin promesa aunque el caso existe | Baja | Es el lado seguro; el reintento recibe `DUPLICATE` y queda `SENT`. No hay mensaje proactivo posterior |
| R6 | **Un caso por mensaje** en cotizaciones de varias fotos: la persona ve varias tarjetas | Baja | Limitación del CRM; el vínculo se conserva en la evidencia |
| R7 | **Sin retorno de resolución**: V2 no sabe cuándo se atendió | Media | Contrato aparte (control de atención, G1); no implementado |
| R8 | **`DEAD` silencioso**: un caso muerto no avisa a nadie | Media | Hay `list`/`stats`/`requeue` en SQL, pero **no hay alerta ni pantalla**; el operador debe consultarlos |
| R9 | **Clave de cifrado perdida o rotada** ⇒ cargas pendientes ilegibles | Media | Se descartan como `INVALID` (visible); no hay rotación con dos claves |
| R10 | **Flujo legado de una imagen** (sesiones apagadas) no deriva a nadie | Baja | Deliberado: no se tocó el flujo de recetas |

## 4. Condiciones para ACTIVAR G5 (nada se activó)

Orden estricto (primero migraciones y CRM, luego variables, por último la bandera):
- [ ] Todo lo de **G2.1 §3**, **G3.1A §5**, **G3.2 §4**, **G4.0 §5** y **G4.1 §4**.
- [ ] Las **trece** migraciones aplicadas en un Supabase de ensayo y validadas por HTTP real (en especial `plusmedik_crm_outbox_*` y `plusmedik_quote_review_targets`).
- [ ] **CRM de ensayo**: `PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED` activo, token ≥ 32 caracteres igual al de V2; **demostrar** que el CRM ingiere el mensaje original (texto e imagen) antes de que V2 envíe el caso; solicitar al CRM (sin que V2 lo toque) `caseKind`/`reasonCode` y una vista de la cola con responsable y plazo.
- [ ] **Operación**: un responsable humano de la cola de revisión del CRM y un plazo; textos aprobados (`handoff_confirmed`, `medical_handoff_confirmed`, `review`, `review_confirmed`).
- [ ] **Vercel**: `PLUSMEDIK_CRM_REVIEW_URL` (https), `PLUSMEDIK_CRM_REVIEW_TOKEN`, `PLUSMEDIK_OUTBOX_KEY` (≥ 32, generada al azar y guardada en un gestor de secretos), `CRON_SECRET`; **programar** `/api/outbox/drain` (p. ej. cada minuto) y decidir una alerta para `DEAD`.
- [ ] **Guion manual en un número de prueba**: «quiero hablar con una persona» → caso en el CRM → confirmación; con el CRM apagado → texto sin promesa y, al encenderlo, el caso llega sin duplicarse; mensaje médico → aviso de emergencia + caso; cotización con una foto dudosa → un caso y `review_confirmed`; repetir el webhook → sin caso duplicado; pausa humana → los casos siguen entregándose y el paciente no recibe nada del drenaje.
- [ ] Orden de banderas: … → `PLUSMEDIK_TURNS` → `PLUSMEDIK_REPLY_GUARD` → `PLUSMEDIK_TEXT_HANDLER` → … → `PLUSMEDIK_QUOTE_SESSIONS` → **`PLUSMEDIK_CRM_HANDOFF`** (la última; sin turnos y manejador de texto no tiene efecto).

## 5. Qué sigue (no hecho aquí)
- Rotación de la clave del cifrado (dos claves activas) y alerta/pantalla para casos `DEAD`.
- Retorno de resolución del CRM y cierre del ciclo con el paciente (control de atención).
- Derivación del flujo legado de una imagen, si se decide.
- Staging con las 13 migraciones y verificación HTTP; pantallas del CRM (G6).
