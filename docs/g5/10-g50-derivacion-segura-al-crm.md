# G5.0 · Derivación segura de casos al CRM — auditoría de contratos y diseño

## 1. Auditoría del contrato existente (CRM-PLUSMEDIK, **solo lectura**)

El CRM ya tiene el receptor: `POST /api/internal/agent/review-case` (`src/app/api/internal/agent/review-case/route.ts` + `createAgentReviewCase`). Se leyó; **no se modificó**. Lo que exige y devuelve, y cómo lo usa V2:

| Aspecto del CRM | Comportamiento observado | Qué hace V2 |
| --- | --- | --- |
| Interruptor | `PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED`; apagado ⇒ `503 {available:false}` | `UNAVAILABLE`: se reintenta con espera; **no** se promete nada al paciente |
| Autenticación | `Authorization: Bearer <token>` (≥ 32 caracteres), comparación en tiempo constante | `UNAUTHORIZED`: espera ≥ 30 min (configuración equivocada, no tiene sentido insistir cada medio minuto) |
| Cuerpo mínimo | `requiresReview: true`, `eventId` (≤ 120), `kapsoMessageId` (≤ 255), `contactPhone` (≥ 8 dígitos), `phoneNumberId`, `failureReason` (≤ 1000), `detectedTests` (≤ 60) | Todo se arma con límites propios; nada literal del paciente |
| Evidencia | `agentResult` + `detectedTests` ≤ 40 000 caracteres ⇒ si no, `413` | Se poda antes de guardar; `413` ⇒ `DEAD` (rechazo permanente a la vista) |
| `requiresReview ≠ true` | `200 {ignored:true}` | `IGNORED` ⇒ `DEAD` (nunca cuenta como registrado) |
| Cuerpo inválido | `400` | `INVALID` ⇒ `DEAD` |
| Mensaje desconocido | `409 {code:"message_not_ingested"}`: el CRM **no tiene aún** el mensaje original en `crm.messages` (o no coincide teléfono/línea/media) | `MESSAGE_NOT_INGESTED`: se **reintenta** (el CRM puede ingerirlo después) |
| Otro `409` | no documentado | `CONFLICT_UNKNOWN`: se reintenta de forma **acotada** (nunca éxito) |
| Éxito | `200 {created:true}` o `200 {created:false, duplicate:true}` (por `eventId` **o** por mensaje original) | Ambos = **REGISTRADO** (`CREATED` / `DUPLICATE`) |
| Un caso por mensaje | el CRM deduplica por `kapsoMessageId` | Una sesión con varios mensajes dudosos ⇒ **un caso por mensaje** |

### Contratos que **faltan** en el receptor (se documentan; no se implementan en el CRM)
1. **Tipo de caso / motivo estructurado**: no hay campo `caseKind` ni `reasonCode`. Las consultas de texto (persona, médico, sin respuesta aprobada) y los motivos de sesión viajan codificados en `failureReason` y `agentResult.reasonCode`. Pedir al CRM un campo propio permitiría filtrar y priorizar.
2. **Agrupar por solicitud**: el CRM no conoce `sessionId`; no puede mostrar «estas 3 fotos son una sola solicitud» (V2 manda un caso por mensaje y conserva el vínculo en `evidence.sessionId`).
3. **Consulta de estado por `eventId`**: no existe; no hace falta para la entrega (el `POST` es idempotente), pero impide que V2 sepa si el caso ya fue **atendido**.
4. **Retorno de resolución (CRM → V2)**: no hay llamada de vuelta. Solo existe el contrato aparte de control de atención (`docs/g3/02-contrato-crm.md`).
5. **Ingesta del mensaje original**: el receptor responde `409` hasta que el CRM haya guardado el mensaje del paciente (llega por el *coexistence* del webhook de Kapso). **Si esa ingesta no cubre los textos o las fotos de V2, todo caso será `409` permanente.** Debe verificarse en staging.
6. **`503` ambiguo**: significa «apagado» y también «error transitorio»; V2 trata ambos como reintentables.
7. **Aprovisionamiento**: la bandera `PLUSMEDIK_AGENT_REVIEW_INGEST_ENABLED` y un token ≥ 32 caracteres deben existir en el CRM y coincidir con `PLUSMEDIK_CRM_REVIEW_TOKEN` de V2.
8. **Límites**: evidencia ≤ 40 000, `detectedTests` ≤ 60, `failureReason` ≤ 1000 (V2 los respeta).

## 2. Reglas de oro implementadas
1. **Se confirma al paciente solo con el caso registrado.** El texto «una persona del equipo…» sale únicamente si el CRM respondió `CREATED`/`DUPLICATE`. Si queda pendiente, el paciente recibe un texto neutro **sin promesa**; no hay mensaje proactivo posterior.
2. **Idempotencia total**: `eventId = plusmedik-review:<id de la corrida de origen>`; una corrida de origen ⇒ un evento; un mensaje de Kapso ⇒ un evento. Repetir el webhook, reintentar el turno o recuperarlo tras una caída **no duplica**.
3. **Evidencia + motivo + `eventId` conservados**: tabla `plusmedik_crm_outbox` con `reason_codes` (conjunto cerrado de 9) y `evidence` (jsonb podado); bitácora inmutable `plusmedik_crm_outbox_attempts` (estado HTTP, resultado, duración).
4. **El teléfono jamás queda en claro**: el CRM lo exige en el cuerpo, así que la carga se guarda **cifrada por la aplicación** (AES-256-GCM, dato asociado = `eventId`, clave `PLUSMEDIK_OUTBOX_KEY`). La base solo ve texto opaco; `service_role` tiene `SELECT` por columna **sin** `payload_cipher` ni el arrendamiento. Al enviarse con éxito la carga se **borra**; al vencer, también.
5. **Reintentos seguros**: estados `PENDING → IN_FLIGHT → SENT | DEAD`; arrendamiento con dueño y *fence* por emisor (un emisor que perdió el arrendamiento no puede registrar su resultado: `PT410`); cada reclamo cuenta un intento (incluso si el proceso muere); espera 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h, 24 h; máximo 8 intentos; vigencia 7 días.
6. **Rechazos permanentes** (400, 413, 200-ignorado) ⇒ `DEAD` de inmediato, **conservando** la carga para diagnosticar; reencolable (`requeue`) mientras no venza.
7. **Pausa humana y concurrencia**: un caso en cola se entrega aunque la conversación esté en pausa (es justo lo que pide la persona); el drenaje **nunca** escribe al paciente. Reclamo con `skip locked`: dos procesos no toman el mismo evento. Orden de bloqueos coherente con G2 (contacto → corrida).
8. **Recuperación**: un arrendamiento vencido se recupera (y, si ya agotó intentos, pasa a `DEAD/EXHAUSTED`); el turno se repite sin duplicar; la ruta `/api/outbox/drain` reintenta lo pendiente.
9. **Apagado por defecto**: requiere `PLUSMEDIK_CRM_HANDOFF=on` **y** URL, token, clave y `KAPSO_PHONE_NUMBER_ID`, **y** turnos + manejador de texto. Con cualquier faltante, la derivación sigue **bloqueada** (`BLOCKED_HANDOFF`) y solo se registra un **código** (`crm_handoff_config_invalid`), nunca valores.
10. **El motor de recetas no se tocó**; ni `analyze`, lectores, juez, catálogo, `partial-auto` ni `imageProducer` conocen la cola (pruebas de fronteras).

## 3. Flujo
```
turno (texto/imagen)  ──►  clasificar (G2.1/G3/G4.0)  ──►  ¿requiere persona?
                                                          │ sí
                       registerCase(motivo)  ◄────────────┘
                              │
        enqueue (idempotente, cifra la carga)  ─►  fila PENDING
                              │
        intento inmediato (reclamo forzado, hasta 2 con 1,5 s si el resultado vale la pena)
                              │
   CREATED/DUPLICATE ─► SENT (carga borrada) ─► el paciente recibe «una persona del equipo…»
   409 / 5xx / red   ─► PENDING con espera   ─► el paciente recibe texto neutro SIN promesa
   400 / 413 / ignorado ─► DEAD (visible, reencolable)
                              │
          /api/outbox/drain (cron, SIN programar todavía) reintenta lo pendiente
```

### Motivos (`reason_codes`)
`HUMAN_REQUEST`, `MEDICAL_QUERY`, `NO_APPROVED_ANSWER` (texto) · `AMBIGUOUS_STUDY`, `UNRESOLVED_TEXT`, `ENGINE_PARTIAL`, `UNREADABLE_IMAGE` (cotización incierta) · `STUDY_UNAVAILABLE`, `PRICE_INVALID` (cierre de sesión).

### Consecuencias en el texto al paciente
- Consultas de texto: `handoff_confirmed` solo con el caso registrado; **médicas** conservan el aviso de emergencia (`medical_handoff_confirmed`).
- Cotización por sesión (G4.0): un caso por mensaje incierto; `review_confirmed` solo si **todos** quedaron registrados; si no, `review` (sin promesa).
- Sin cola configurada: todo igual que en G4 (derivación bloqueada, sin promesa).

## 4. Datos y migración 13 (`20261101000000_plusmedik_crm_outbox.sql`, **sin aplicar**)
Tablas `plusmedik_crm_outbox` y `plusmedik_crm_outbox_attempts`; disparador de guarda (identidad, evidencia y carga inmutables; `SENT` inmutable; la carga solo puede borrarse); funciones `SECURITY DEFINER` con `search_path` vacío y solo para `service_role`: `enqueue`, `purge`, `claim`, `record`, `status`, `stats`, `list`, `requeue`, y `plusmedik_quote_review_targets` (qué mensajes de una solicitud cerrada en revisión necesitan caso). Probada **solo** en PostgreSQL 18 efímero.

## 5. Archivos
`src/crm-outbox/` (`payload`, `client`, `repository`, `service`, `drain`, `handoff-sink`, `config`, `types`, `index`) · `api/outbox/drain.ts` (inerte) · cambios mínimos en `src/text-handler.ts`, `src/turns.ts`, `src/guarded-turn.ts`, `src/quote-session.ts`, `src/quote-session-turns.ts`, `api/kapso/webhook.ts`, `.env.example`.

## 6. Correcciones al diseño de G0
- G0 proponía enviar el caso **después** de responder; aquí el primer intento va **antes** de la respuesta, porque la confirmación depende de que el CRM lo haya registrado.
- G0 hablaba de adjuntar el texto del paciente; **no se envía ningún texto literal**: solo códigos, ids y nombres del catálogo (privacidad; el CRM ya tiene el mensaje original).
