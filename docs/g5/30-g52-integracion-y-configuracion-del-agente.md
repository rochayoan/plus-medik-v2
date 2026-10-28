# G5.2 · Integración de G2–G5 y preparación de la configuración del agente

> **Nota (G5.6):** la plantilla `laboratorio.plantilla.json` y sus órdenes de carga ya no existen; la configuración vive en `agent-config/system-prompt.es.md` (ver [60](60-g56-prompt-como-configuracion-principal.md)).

Fecha: 2026-10-25. Rama `feat/g2-turnos`, partiendo del commit `f69f3bcf`. **No se ejecutó ninguna prueba (`vitest`), SQL remoto, commit, push ni despliegue; no se tocó el CRM, Supabase real ni Kapso; no se activó ninguna bandera.** Solo se corrió `tsc --noEmit` (sin errores) y las órdenes **offline** de `scripts/agent-config.ts`.

## 1. Integración del código pendiente (G2–G5)

Estado: todo el código de G2–G5 ya estaba en el árbol de trabajo (sin versionar) y cableado en `api/kapso/webhook.ts`; se conservó **sin cambios de lógica**. Lo que faltaba para considerarlo integrado era coherencia de configuración y documentación:

| Qué | Antes | Ahora |
| --- | --- | --- |
| Comentarios de `api/kapso/webhook.ts` | Decían que no había manejadores de texto y que la derivación «no tiene variable que la habilite» (falso desde G2.1/G5.0) | Corregidos: describen el cableado real (la derivación sigue bloqueada salvo cola al CRM completa) |
| README | No documentaba ninguna de las banderas de G2–G5 | Sección «Agente conversacional (G2–G5)»: 8 capas, dependencias, migraciones y enlaces de activación |
| `package.json` | Sin acceso a las herramientas nuevas | `npm run agent-config` y `npm run migration-manifest` |
| `.gitignore` | — | `agent-config/laboratorio.json` (datos reales del laboratorio, decisión de versionado pendiente) |
| `.env.example` | Ya tenía todas las variables de G2–G5, en blanco | Sin cambios (verificado variable por variable contra el código) |

Verificado por lectura: cada bandera exige sus dependencias (`turns` → `text handler` → `knowledge answers` → `study info`; sesiones y cola al CRM exigen turnos y manejador de texto); sin configuración completa la derivación sigue bloqueada; el motor de recetas y `ENGINE_FLAGS` no cambiaron.

### Lo que sigue pendiente (no es configuración; son decisiones o herramientas)
- **Herramientas de operación sin cliente propio** (las funciones SQL existen): reactivar un contacto con el limitador de respuestas (`plusmedik_reply_guard_reset`/`_status`), listar/reencolar/purgar la cola al CRM (hay métodos en `src/crm-outbox/repository.ts`, no una orden), consultas de impacto (`plusmedik_kb_usage`, `plusmedik_facts_usage`), reactivar atención humana desde una orden. Hoy solo SQL de servicio.
- **Programar `/api/outbox/drain`** (sin cron en `vercel.json` a propósito) y una **alerta** para casos muertos.
- **Cargadores de borradores** para la preparación de estudios y los datos por estudio (G3 `STUDY_PREPARATION`, G4.1): no existen; sí existe el de conocimiento administrativo (§2).
- **Mecanismo para cargar textos aprobados sin editar código**: no existe; hoy son constantes (`DRAFT_TEXTS`, `ANSWER_TEXTS`, `QUOTE_TEXTS`).
- Las pruebas de estas modificaciones no se ejecutaron (instrucción); lo escrito se comprobó con `tsc` y con corridas offline de la herramienta.

## 2. Configuración del agente (carpeta `agent-config/`)

| Entregable | Contenido | Datos del laboratorio |
| --- | --- | --- |
| `system-prompt.es.md` | Prompt de sistema / especificación: rol, fuentes de verdad, lo que hace y nunca hace, cotización, derivación, estilo, lista de verificación previa al envío | **Ninguno** |
| `laboratorio.json` (en G5.2 `laboratorio.plantilla.json`; unificado en G5.5) | Plantilla vacía: sucursales (con teléfono), servicios (5 tipos), horarios por sucursal y servicio, 5 políticas, métodos de pago, preguntas frecuentes; cada registro con `fuente` y `vigenteHasta` | **Ninguno** (todo `null`) |
| `textos-a-aprobar.md` | Todos los textos fijos del agente (conversación, sesión de cotización, respuestas con conocimiento) con su uso, para que el laboratorio los apruebe | Son borradores de código, sin cifras |
| `scripts/agent-config.ts` | `check` / `drafts` / `texts` (offline) y `apply` (única orden con red; exige `--actor` y `--confirm-project`; solo crea **borradores**) | — |
| `README.md` | Flujo, qué cubre cada sección, qué falta | — |

**Qué hace `check`:** valida cada registro con **el mismo contrato que aplica la base** (los esquemas `zod` de `src/knowledge/types.ts`): sin importes, horas coherentes (apertura < cierre), una sola sucursal por clave, el horario debe apuntar a una sucursal completa, `fuente` con el formato que acepta la base (`^[A-Za-z0-9_.:/#-]{1,120}$`), vigencia `YYYY-MM-DD` futura y de máximo 400 días. Un registro con todo en `null` es **pendiente** (no se carga); uno a medias o inválido es **error**. Avisa si un servicio figura como ofrecido sin horario, si uno NO ofrecido no está declarado en una política, si una política usa un tema que el agente no sabe consultar y cuáles de los cinco temas siguen sin dato.

**Comprobado (offline):** sobre la plantilla vacía → 0 inválidos, 9 pendientes, `--strict` falla como debe; sobre un archivo **sintético** de prueba (guardado fuera del repositorio) → detectó los 6 defectos plantados (dirección faltante, sucursal desconocida, horario con apertura posterior al cierre, importe en el texto, fuente con espacios, vigencia mayor a 400 días) y aceptó los 4 registros correctos; `apply` sin archivo, sin `--actor` o sin `--confirm-project` se niega sin tocar la red.

### Decisiones del modelo que conviene conocer
- **Servicios:** el modelo no tiene un «catálogo de servicios» del laboratorio; los *estudios* y precios salen de `lab_tests`, y los *servicios de atención* (oficina, toma de muestras, entrega de resultados, domicilio, atención humana) se expresan con **horarios** (si se ofrecen) o **políticas** (si no).
- **Teléfonos:** solo por sucursal. No hay «teléfono general»; si el laboratorio lo quiere, se declara como pregunta frecuente o política.
- **Políticas:** solo cinco temas son consultables (`RESULTS_DELIVERY`, `HOME_SAMPLING`, `INVOICING`, `CONVENIOS`, `APPOINTMENTS`). Otros temas (cancelaciones, menores, urgencias…) exigen ampliar código.
- **Preguntas frecuentes:** solo se responden por coincidencia **exacta** de una palabra con una etiqueta.
- **Prompt:** al cierre de G5.2 el agente en ejecución era determinista y no lo usaba; desde G5.3 la parte delimitada del prompt alimenta, solo si se activa `PLUSMEDIK_LLM_CONVERSATION`, la capa de conversación con OpenAI (ver [40-g53-conversacion-con-openai.md](40-g53-conversacion-con-openai.md)).

## 3. Qué falta para usar esta configuración (en orden)
1. **El laboratorio entrega los datos** (con fuente y vigencia) y decide el gobierno: redactor, aprobador administrativo y aprobador clínico (personas distintas), caducidades y textos para «no hay dato».
2. Completar `agent-config/laboratorio.json` (archivo único, ver G5.5); `npm run agent-config -- check --strict` en verde.
3. Aprobar `system-prompt.es.md` y los textos de `textos-a-aprobar.md`.
4. Aplicar las migraciones 08–09 (conocimiento) siguiendo `docs/g5/20-g51-aplicacion-de-migraciones.md`, en un entorno de ensayo primero.
5. Cargar borradores (`apply`, ejecutado por una persona con el proyecto confirmado), enviarlos y aprobarlos desde el CRM (hoy el CRM no tiene esas pantallas: el contrato está en `docs/g3/02-contrato-crm.md`).
6. Solo entonces, y siguiendo el orden de banderas del README, encender `PLUSMEDIK_KNOWLEDGE_ANSWERS` en un número piloto.
