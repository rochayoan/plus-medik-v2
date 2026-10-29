# G3.0 · Contrato para la futura administración desde CRM-PLUSMEDIK

**No se modificó `CRM-PLUSMEDIK`.** Este documento define lo que el CRM necesitaría implementar; cada cambio del CRM es una fase propia con su autorización. Referencia ejecutable: `src/knowledge/admin.ts` y `tests/knowledge-e2e.test.ts`.

## 1. Modelo de integración

El conocimiento vive en la **base del agente** (esquema `public`, prefijo `plusmedik_kb_`), igual que la auditoría. El CRM **no** crea tablas de conocimiento propias: administra llamando a **funciones RPC** de esa base. Así hay una sola fuente de verdad, la bitácora es única y el agente lee exactamente lo que el CRM aprobó. Esto es coherente con la regla del CRM de no tocar tablas del agente directamente: solo ejecutaría funciones documentadas.

```
Persona (CRM UI) ──▶ servidor del CRM ──▶ RPC plusmedik_kb_* (con actor declarado) ──▶ base del agente
                                                                               ▲
agente (Vercel) ── solo lectura: plusmedik_kb_snapshot / plusmedik_kb_revision ┘
```

## 2. Identidad y roles (lo que el CRM debe aportar)

La base **no autentica personas**: confía en el actor que declara el servidor del CRM y hace cumplir las reglas. Por tanto el CRM debe:

| Requisito | Detalle |
| --- | --- |
| Autenticar y autorizar a la persona | Con su propio login/roles. Mapear `crm.user_role` a los roles de conocimiento (ver tabla) |
| Declarar el actor en cada llamada | `p_actor_id` = seudónimo estable (`crm:<uuid>`; **nunca** nombre, correo ni teléfono), `p_actor_type` = `HUMAN`, `p_actor_role` |
| No dejar que una IA use un rol humano | Una IA usa `p_actor_type = 'AI'` y `p_actor_role = 'AI_DRAFTER'` (la base rechaza combinaciones cruzadas) |
| Llamar solo desde el servidor | Nunca desde el navegador; token propio; sin reutilizar secretos del agente ni claves HMAC |
| Conservar el texto libre | Motivos largos, comentarios y adjuntos se guardan **en el CRM**; a la base solo van códigos (`^[A-Z0-9_]{1,40}$`) |

Roles de conocimiento (a mapear con los roles del CRM; la decisión de quién es qué es del laboratorio):

| Rol | Puede |
| --- | --- |
| `EDITOR` | redactar y enviar a aprobación (administrativo y clínico) |
| `ADMIN_APPROVER` | aprobar/rechazar/desactivar/restaurar **administrativo** |
| `CLINICAL_APPROVER` | aprobar/rechazar/desactivar/restaurar **preparación de estudios** (personal clínico autorizado) |
| `AI_DRAFTER` | solo redactar borradores administrativos (nunca enviar ni aprobar) |

## 3. Funciones (RPC) — todas `SECURITY DEFINER`, hoy ejecutables solo por `service_role`

Errores (PostgREST: `PT###` → HTTP): `PT403` sin permiso · `PT404` no existe · `PT409` conflicto de estado/duplicado · `PT422` contenido o argumento inválido. Los mensajes **nunca incluyen valores**.

| Función | Argumentos | Resultado | Notas |
| --- | --- | --- | --- |
| `plusmedik_kb_create_draft` | `p_kind, p_key, p_payload jsonb, p_actor_id, p_actor_type, p_actor_role, p_source_ref?, p_valid_from?, p_valid_until?` | `{status:"created", document_id, version_id, version}` | `409` si el elemento ya tiene una versión abierta. `p_source_ref` = referencia al documento del laboratorio que respalda el dato (`^[A-Za-z0-9_.:/#-]{1,120}$`) |
| `plusmedik_kb_edit_draft` | `p_version_id, p_payload, actor…, p_source_ref?, p_valid_from?, p_valid_until?` | `{status:"edited"}` | Solo `DRAFT` |
| `plusmedik_kb_submit` | `p_version_id, actor…` | `submitted` \| `already_submitted` | Exige `valid_until` y contenido completo; solo personas |
| `plusmedik_kb_reject` | `p_version_id, actor…, p_reason` | `{status:"rejected"}` | Vuelve a `DRAFT`; aprobador ≠ autor |
| `plusmedik_kb_approve` | `p_version_id, actor…` | `approved` (+`revision`) \| `already_approved` | Aprobador de la clasificación ≠ autor; caducidad ≤ 400 días; preparación: estudio activo en el catálogo |
| `plusmedik_kb_deactivate` | `p_version_id, actor…, p_reason` | `deactivated` (+`revision`) \| `already_inactive` | Inmediato, sin segundo humano |
| `plusmedik_kb_restore` | `p_version_id, actor…, p_reason` | `restored` (+`revision`) \| `already_approved` | Solo una versión que ya estuvo aprobada y no venció |
| `plusmedik_kb_history` | `p_kind, p_key` | `{versions[], events[]}` | Para la pantalla de detalle y auditoría |
| `plusmedik_kb_list` | `p_status?, p_kind?, p_limit (1–500)` | `{items[]}` | Bandejas: "pendientes de aprobar", "por vencer"… |
| `plusmedik_kb_snapshot` / `plusmedik_kb_revision` | — | `{revision, items[]}` / `{revision}` | **Lectura del agente**; el CRM puede usarlas para previsualizar "lo que ve el agente" |

Idempotencia y reintentos: aprobar/desactivar/restaurar/enviar son idempotentes por **estado** (repetir devuelve `already_*`). `create_draft` no lo es (devuelve `409` si el primero se confirmó): ante una respuesta incierta (`UNAVAILABLE`), **consultar `history` antes de repetir**.

## 4. Pantallas sugeridas (para una fase futura del CRM)

1. **Bandeja** (`list`): pendientes de aprobar (por clasificación), borradores, por vencer (agrupar por `validUntil`), vencidos.
2. **Editor** por tipo (formularios con los campos de [01 §2](01-arquitectura-y-modelo.md)); fuente (`source_ref`) y vigencia obligatorias; vista previa de cómo respondería el agente.
3. **Revisión**: diferencia con la versión aprobada vigente; botones aprobar/rechazar visibles solo para el rol correcto y **ocultos para el autor** (la base igual lo impide).
4. **Historial** (`history`): línea de tiempo con actor, rol, hora y motivo; restaurar una versión anterior.
5. **Alertas de caducidad**: avisar al aprobador N días antes (el CRM calcula con `validUntil`; no hay renovación automática).
6. **Preparación de estudios**: lista de estudios activos del catálogo (`lab_tests`, solo lectura, que el CRM ya consulta) con su estado de preparación: *sin registro* · *pendiente* · *aprobada* · *vencida* · *sin preparación declarada*. Un estudio sin registro **no** se muestra como "sin preparación".

## 5. Lo que hay que autorizar y hacer en el CRM / base (nada hecho en G3.0)

| # | Cambio | Responsable | Detalle |
| --- | --- | --- | --- |
| C1 | Permiso del CRM sobre las funciones | Dueño + quien administre Supabase | Hoy solo `service_role` ejecuta. Opciones: (a) el servidor del CRM usa una credencial de servicio **distinta** de la del agente; (b) crear un rol de base de datos para el CRM con `EXECUTE` solo sobre las funciones de administración (migración aparte, autorizada), y que el **agente no tenga** esas funciones. Recomendado (b) cuando haya más de una persona administrando |
| C2 | Mapeo de roles | Laboratorio + CRM | Quién es `EDITOR`, `ADMIN_APPROVER`, `CLINICAL_APPROVER` |
| C3 | Rutas del CRM | Fase del CRM | Rutas internas que llamen a las RPC desde el servidor |
| C4 | Invalidación inmediata (opcional) | Agente + CRM | Endpoint interno del agente `POST /api/internal/crm/knowledge/invalidate` (mismo patrón de token exclusivo CRM→agente que `attention/*`) para que un retiro urgente no espere los 15 s |
| C5 | Contrato de cotización/handoff | Aparte | Este contrato **no** toca cotizaciones ni casos de revisión |

## 6. Compatibilidad con los contratos existentes del CRM

- No usa `crm.*` ni cambia el catálogo; sin claves foráneas cruzadas.
- No reutiliza `PLUSMEDIK_AGENT_CONTROL_TOKEN` ni `PLUSMEDIK_AGENT_REVIEW_INGEST_TOKEN`; si se agrega C4 necesitaría su **propio** token.
- Las correcciones de revisión humana (`crm.review_case_corrections`) **no** se convierten en conocimiento automáticamente: una corrección que revele un dato faltante (p. ej. un horario) entra como **borrador** y sigue el mismo ciclo de aprobación.
