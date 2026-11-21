# G0 · 03 Diseño: casos no resueltos al CRM y reutilización de correcciones

Alcance: solo este repositorio (el emisor). El CRM ya tiene el receptor y las tablas; **no se modifica**. Las citas del contrato vienen de `CRM-PLUSMEDIK/docs/AGENT_REVIEW_CASE_CONTRACT.md` y `AGENT_ATTENTION_CONTROL_CONTRACT.md`.

## 1. Cuándo hay handoff

Entrada: `AnalysisResult.outcome` y `internal` (ya existen). Salida: qué ve el paciente y si se crea un caso.

| Situación | Paciente recibe | Caso en el CRM |
| --- | --- | --- |
| `AUTO_COMPLETE` | Cotización completa (+ preparación) | No |
| `AUTO_PARTIAL` | Cotización de lo seguro + aviso "un asesor revisará el resto" | Sí: pendientes del `internal` |
| `HUMAN_REVIEW`, motivos `READING` / `IDENTITY` / `POLICY` | Aviso "un asesor revisará tu receta" | Sí |
| `HUMAN_REVIEW`, motivos solo `DOCUMENT` de calidad (corte, ilegible, incompleta) | Pedido de foto más clara (como hoy); si reenvía y vuelve a fallar → caso | Tras el segundo intento |
| `HUMAN_REVIEW` por `not_a_request` (p. ej. tarjeta de derivación de muestra) | Mensaje de alcance + oferta de persona | Opcional (decisión del laboratorio) |
| Fallo técnico (`technical_issue`) | Mensaje técnico neutro (como hoy) | Sí, con motivo `TECHNICAL`; sin texto del error |
| Paciente pide persona, queja, consulta médica | Aviso de derivación | Sí, tipo `CONVERSATION` (ver §6) |

La clase de incertidumbre (`uncertaintyKinds`) ya clasifica cada bloqueo; es la base del triage y de la tabla anterior. El mapeo exacto de motivos → acción es una configuración versionada, no código disperso.

## 2. Contrato de salida (agente → CRM)

Se implementa tal cual el contrato `POST /api/internal/agent/review-case`:

| Campo del contrato | Origen en el agente |
| --- | --- |
| `eventId` | `plusmedik-review:` + `runId` de la auditoría (estable ante reintentos; la unicidad la fija el CRM por `agent_event_id`) |
| `requiresReview` | `outcome !== "AUTO_COMPLETE"` y la tabla anterior |
| `kapsoMessageId` | `message.id` del mensaje original (el mismo que el claim) |
| `contactPhone` | `image.from` del webhook en curso (normalizado a dígitos) |
| `phoneNumberId` | `KAPSO_PHONE_NUMBER_ID` |
| `recipeMediaId` | `message.image.id` si existe, si no `null` |
| `auditId` | `runId` |
| `failureReason` | Códigos, no texto libre: `"IDENTITY:catalog_ambiguous(2); DOCUMENT:document_may_alter_study(1)"` (≤ 1000). Nunca texto de modelos, jueces, ni errores |
| `detectedTests` | ≤ 60 elementos: por estudio pendiente `{ name: literalText, catalogTestId?: id solo si hay un único candidato, candidates?: [ids], blockers: [...] }` y, aparte, los estudios ya cotizados `{ name, catalogTestId, quoted: true }` |
| `agentResult` | Subconjunto estable de `internal`: `outcome`, `revision`, `quoted.lines` (id, precio), `pending` (kind, blockers, uncertainty, candidatos), `recipeStops`, `document.type`, `document.zones`, `advisories` |

Controles:

- Tamaño: el CRM rechaza > 40.000 caracteres (413); el emisor poda candidatos y avisos antes de enviar y registra qué podó.
- **No se envía la imagen ni una URL**: solo `recipeMediaId`; el CRM ya tiene el mensaje original en su Inbox cuando lo ingiere.
- Autenticación: `Authorization: Bearer ${PLUSMEDIK_AGENT_REVIEW_INGEST_TOKEN}`, token exclusivo agente→CRM, comparado en tiempo constante por el CRM, nunca logueado.
- El catálogo del CRM no se toca; `catalogTestId` es solo evidencia.

## 3. Entrega confiable: outbox transaccional

El envío al CRM **no** puede depender de que el CRM esté disponible en ese segundo (puede estar apagado → 503, sin el mensaje ingerido → 409, caído).

```sql
-- BORRADOR DE DISEÑO (no ejecutar)
create table plusmedik_handoff_outbox (
  event_id        text primary key,            -- 'plusmedik-review:<runId>'
  run_id          uuid not null,               -- plusmedik_audit_runs.id
  kind            text not null check (kind in ('REVIEW_CASE','QUOTE_SNAPSHOT','CONVERSATION')),
  payload         jsonb not null,              -- minimizado; vence con expires_at
  status          text not null check (status in ('PENDING','SENT','DUPLICATE','DEAD')),
  attempts        int  not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_kind text,                        -- código (HTTP_503, MESSAGE_NOT_INGESTED, TIMEOUT...), nunca texto del servidor
  created_at timestamptz not null default now(), sent_at timestamptz,
  expires_at timestamptz not null              -- propuesta: 7 días; al vencer se borra el payload
);
```

Reglas:

1. **Se escribe en la misma transacción que la evidencia del análisis** (se extiende `plusmedik_audit_record_evidence`, o una función hermana con el mismo fencing). Si la fila no está confirmada, el agente **no promete** revisión humana al paciente. Así la promesa siempre está respaldada por un registro durable.
2. **Primer intento en línea**, justo después de enviar la respuesta al paciente (con `waitUntil`), con plazo corto. Si responde `created`/`duplicate` → `SENT`. Si responde `409 message_not_ingested`, `503` o hay timeout → queda `PENDING` con retroceso exponencial.
3. **Siempre el mismo `eventId` y el mismo cuerpo** en cada reintento (el contrato lo exige para `409`).
4. **Reintentos acotados** (propuesta: 8 intentos en 24 h). Superado el límite → `DEAD` + alerta; un `DEAD` es trabajo para una persona, no se descarta en silencio.
5. **Procesador:** una ruta tipo `api/audit/recover.ts` (mismo patrón: `CRON_SECRET`, inerte hasta configurarse). Requiere un planificador con frecuencia de minutos (decisión 7). Alternativa si no se dispone: reintentos al recibir el siguiente mensaje del mismo contacto, solo como degradación.
6. **El handoff nunca bloquea ni reintenta el envío al paciente**, y un fallo del handoff nunca provoca un segundo mensaje al paciente. Es un canal aparte con su propia idempotencia.
7. **Privacidad:** el payload contiene texto de estudios y teléfono; por eso `expires_at` corto, acceso solo `service_role` y nada de ello en logs (los logs mantienen la política de "solo códigos"). La auditoría permanente sigue sin texto clínico. Es la decisión 6 del resumen.

Dependencias externas que hoy bloquean el uso real (no del diseño):

- El CRM debe **ingerir el mensaje original** (hoy su webhook de Kapso está sin registrar, pendiente de verificar con Kapso que ambos webhooks puedan coexistir). Sin eso, todo handoff recibe `409`. El outbox lo tolera, pero el flujo útil no existe hasta entonces.
- `PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED` está en `false` en el CRM.

## 4. Mensajes al paciente en un handoff

Todos pasan por el mismo camino de envío seguro (claim → reserva → confirmación → Kapso → resultado). Requieren texto aprobado por el laboratorio (decisión 5). Variantes:

- Con horario de atención humana abierto: "Recibimos tu receta. Un asesor la revisará y te escribirá en este chat."
- Fuera de horario: se promete el siguiente horario real leído de `plusmedik_kb_schedules` (`HUMAN_SUPPORT`), nunca un plazo inventado.
- Cotización parcial: la lista cotizada, el total y el aviso (sin decir qué falta ni por qué, como hoy).

Cuando una persona responde al paciente, la **pausa de IA** ya existente evita que el agente hable encima (para mensajes enviados desde WhatsApp Business). Nota: el aviso de handoff del propio agente (`origin: cloud_api`) jamás pausa a su propio contacto, por diseño.

## 5. Control de atención desde el CRM

El contrato pide dos endpoints en el agente. Lo que ya hay en phase6 cubre `status` y `resume`; falta la **pausa manual**:

| Endpoint | Implementación |
| --- | --- |
| `POST /api/internal/crm/attention/status` | Valida token, `contactPhone` y `phoneNumberId` (debe coincidir con `KAPSO_PHONE_NUMBER_ID`), calcula `contact_key` con `contactKeyOf`, llama `plusmedik_attention_status`. Estado desconocido o control apagado → `available: false`, nunca inventa |
| `POST /api/internal/crm/attention/action` (`pause`) | **Función SQL nueva** (`plusmedik_attention_manual_pause`), idempotente por `operationId` (`event_key = crm:<operationId>`), fuente `crm_server`, motivo `CRM_MANUAL_PAUSE`. Prohibido reutilizar `plusmedik_attention_register_human_message` (el contrato lo veta: representa un mensaje humano real) |
| `…/action` (`resume`) | Reutiliza `plusmedik_attention_resume`; repetir el mismo `operationId` devuelve el resultado ya confirmado |

Reglas del contrato que se respetan: token exclusivo CRM→agente (`PLUSMEDIK_AGENT_CONTROL_TOKEN`), HTTPS, comparación en tiempo constante, rechazo de llamadas de navegador, `confirmed: true` solo con confirmación firme, sin enviar el texto del motivo al agente, y sin habilitar `PLUSMEDIK_HUMAN_CONTROL` en este trabajo (el endpoint responde sin mutar mientras esté apagado).

**Riesgo abierto (decisión 11):** los mensajes que el CRM envíe con la API de Kapso tendrán `origin: cloud_api` y el agente los toma por propios. Para que la IA no hable encima de una recepcionista que escribe desde el CRM, el CRM debe pausar (acción `pause`) antes de enviar. Es un requisito del CRM, no del agente, pero el agente debe documentarlo y probarlo en el piloto.

## 6. Conversaciones sin receta

Un mensaje que el motor no puede o no debe contestar (queja, consulta médica, pedido de persona, sin respuesta aprobada) también es un handoff. Tipo `CONVERSATION`: sin `detectedTests`, con `failureReason` codificado (`NO_APPROVED_ANSWER`, `MEDICAL_ADVICE`, `COMPLAINT`, `HUMAN_REQUEST`). El contrato actual del CRM exige `detectedTests` como arreglo (puede ir vacío) y `kapsoMessageId` ingerido; si el CRM quiere distinguir estos casos, es un cambio de contrato a pedir (fuera de G0).

## 7. Reutilizar las correcciones aprobadas

### 7.1 Qué existe del lado del CRM

`crm.review_case_corrections` guarda por caso: `original_detected_tests`, `selected_tests`, `discarded_detected_tests`, `added_tests`, `correction_reason`, `observations`, autor y fecha; y la cotización corregida enlazada (`quote_id`). Reglas del contrato: es evidencia; **no hay entrenamiento automático, ni cambios de prompt, ni cambios del catálogo**. Este diseño las respeta: la reutilización pasa por decisiones humanas explícitas del laboratorio.

### 7.2 Dos tipos de aprendizaje, con destinos distintos

| Tipo de corrección | Ejemplo | Destino | Efecto en producción |
| --- | --- | --- | --- |
| **Identidad de texto** | "Hb glicosilada" → estudio X | `lab_test_aliases` (alias aprobado) | El verificador ya trata un alias aprobado único como **decisión del laboratorio** (`approvedAliasOwner`); no hay código nuevo en la ruta de seguridad |
| **Regla comercial** | paquete vs suma, variante por defecto de TSH, AM/PM | Registro de políticas del laboratorio (futuro `plusmedik_kb_entries`/reglas) | Solo cuando el laboratorio la formaliza |
| **Error de lectura de una receta concreta** | letra ilegible de un médico | **Ninguno** | No es generalizable; queda como evidencia y métrica |
| **Error del motor** (se cotizó mal) | falso AUTO | Caso de regresión + revisión de causa raíz | Corrección de código por causa raíz, nunca por receta |

### 7.3 Pipeline propuesto (G6)

```
CRM: caso corregido y aprobado  ──(lectura autorizada por contrato)──▶  tabla agente: plusmedik_correction_candidates
                                                                              │ normaliza el texto literal, enlaza UUID del catálogo
                                                                              ▼
                                             agrupa por (texto normalizado → UUID): conteo, revisores distintos, contexto
                                                                              ▼
                                  lista de trabajo del laboratorio (aprobar / rechazar / "es política")
                                                                              ▼
              aprobado ──▶ scripts/apply-catalog-aliases.ts --apply  (vista previa + auditoría de colisiones: audit-catalog-aliases.ts)
                          └──▶ caso de la batería de regresión sin datos personales (texto → UUID esperado)
```

Salvaguardas contra mala promoción:

1. **Solo correcciones de revisores autorizados** y con caso en estado resuelto; nunca una conversación no revisada.
2. **Umbral de reutilización** (propuesta: ≥ 2 correcciones independientes del mismo texto normalizado → mismo UUID, o 1 con aprobación explícita del responsable del laboratorio). Un conflicto (mismo texto → UUIDs distintos) bloquea y se envía a decisión.
3. **No se promueve nada que dependa de contexto del documento** (tipo de muestra, tiempo, "AM/PM"): el verificador usa ese contexto y un alias lo fijaría a ciegas. La auditoría existente ya marca los alias que "fijarían variante por política" (23 en el último informe).
4. **Prueba de colisiones antes de aplicar** (`audit-catalog-aliases.ts` ya detecta colisiones/contradicciones; la última auditoría local dio 0 colisiones en los 20 aprobados).
5. **Todo `--apply` es manual, con vista previa y registro**; ningún proceso automático escribe en `lab_test_aliases`.
6. **Derecho de retirada:** un alias aprobado se puede retirar con la misma herramienta, y la batería de regresión confirma que ningún caso previo cambia.
7. **Los datos personales no viajan:** del caso solo se extrae texto del estudio ya normalizado (sin nombre, edad, médico ni teléfono); si el texto contiene datos personales evidentes se descarta.

### 7.4 Métricas (sin entrenamiento)

Por semana y por tipo de causa (`READING`/`IDENTITY`/`DOCUMENT`/`POLICY`): casos enviados a revisión, tiempo hasta primera acción, % corregido sin cambios (el motor tenía razón), % con estudios agregados/descartados, alias promovidos, y — la métrica de seguridad — **falsos AUTO** (`WRONG_AUTO`, objetivo 0) detectados cuando una persona corrige un estudio que el motor cotizó solo. Un solo falso AUTO abre una investigación de causa raíz.

### 7.5 Cómo llega la corrección al agente

El CRM no expone hoy una vía para que el agente lea correcciones (por diseño no escribe ni lee del agente). Hay tres opciones, a decidir con el CRM en G6: (a) exportación periódica manual/CSV revisada por el laboratorio (la más simple y la propuesta de partida); (b) endpoint de lectura del CRM con token propio; (c) vista de solo lectura en la base compartida. Ninguna se implementa en G0.
