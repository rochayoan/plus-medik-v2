# G3.1A · Bloqueos, riesgos y condiciones de activación

## 1. Resultado de las pruebas (offline; PostgreSQL 18 efímero; sin servicios reales)

| Dato | Valor |
| --- | --- |
| `tsc --noEmit` | sin errores |
| Suite completa | **68 archivos / 1719 pruebas, todas en verde** (≈ 2 min). Las **1600** previas siguen pasando; **119 son nuevas** |
| Cambios a pruebas existentes | Solo dos aserciones de G3.0 que decían «nada está conectado» (`knowledge-boundaries`), reemplazadas por una **lista blanca precisa** de dónde puede aparecer el conocimiento; ajuste posicional de la lista de migraciones |
| Estabilidad | El e2e de PostgreSQL se repitió 2 veces seguidas sin fallos tras corregir un defecto de aislamiento de la propia prueba |
| Gasto / red | cero llamadas a modelos, Kapso o Supabase real |
| Mutación | 5 reglas nuevas debilitadas a propósito: todas detectadas (ver resumen) |

| Archivo nuevo | Pruebas | Cubre |
| --- | --- | --- |
| `tests/knowledge-answers.test.ts` | 66 | 32 formas de preguntar → tema; identificación de estudios; cada tipo de respuesta; no inventar; fact-check; plantillas; caché; construcción perezosa |
| `tests/text-handler-knowledge.test.ts` | 23 | consulta/no consulta por categoría; orden rastro→reserva→envío; privacidad; sin datos; fallos de trazabilidad; compatibilidad con G2.1 |
| `tests/knowledge-refs-db.test.ts` | 11 | migración 9 en SQL real: rastro antes de reservar, idempotencia, fencing, intentos, impacto, inmutabilidad, concurrencia |
| `tests/knowledge-answers-e2e.test.ts` | 14 | administración real → webhook real → respuesta → rastro en la base → consulta de impacto; retiro, vencimiento, versión nueva, preparación clínica, duplicados, lease, concurrencia, pausa humana, caída de la base |
| (ampliadas) `production-defaults`, `knowledge-boundaries` | +2, +3 | banderas apagadas, falla cerrado, fronteras de código |

## 2. Qué se reutilizó
Toda la infraestructura de Phase 6/G2: claim, lease/fencing, reserva única, pausa humana, recuperación, `busy`, `stale`; el servicio y el cliente de administración de G3.0; el clasificador y la derivación bloqueada de G2.1. **No se tocó**: `analyze`, lectores, juez, catálogo, `partial-auto`, cotización, `whatsapp-quote`, precios, ni las banderas del motor de recetas.

## 3. Bloqueos (nada de esto se hizo)

| Sistema | Bloqueo | Efecto hoy |
| --- | --- | --- |
| **Supabase** | **Nueve** migraciones sin aplicar (5 de Phase 6, 6 turnos, 7 recuperación, 8 conocimiento, 9 trazabilidad); sin staging autorizado; mapeo HTTP real de PostgREST para `plusmedik_kb_*` y `plusmedik_turn_record_knowledge` sin verificar | Sin migración 9 no se puede dejar rastro → **ninguna respuesta con datos se envía** (falla cerrado, probado) |
| **Laboratorio** | **Cero datos aprobados**; sin roles definidos; textos de plantilla sin aprobar | El bot responde como sin conocimiento (verificado) |
| **CRM** | No hay pantallas de administración; sin credencial/rol de base de datos propio para quien administra; contrato receptor de derivación apagado | Los datos solo podrían cargarse con un script de borradores (no existe) o desde el CRM (fase propia). La derivación a una persona sigue bloqueada |
| **Kapso** | Suscripción de eventos de texto entrantes / salientes sin verificar; ventana de 24 h sin verificar | Sin cambios respecto a G2.1 |
| **Dueño** | Despliegue de producción y variables sin confirmar | — |

## 4. Riesgos propios de G3.1A

| # | Riesgo | Severidad | Mitigación / estado |
| --- | --- | --- | --- |
| R1 | **Bucles con bots** (heredado de G2.1): ahora cada pregunta recibe una respuesta rica; no hay tope de respuestas por contacto | **Alta** si se activa | Condición de activación (abajo) |
| R2 | **Una política por tema**: dos políticas vigentes del mismo `topic` son *ambiguas* y el bot, correctamente, no responde con ninguna | Media (operativa) | Documentar a quien cargue; el CRM debería impedir duplicados vigentes |
| R3 | **Temas de política fijos** (`RESULTS_DELIVERY`, `HOME_SAMPLING`, `INVOICING`, `CONVENIOS`, `APPOINTMENTS`): una política con otro código no se encuentra | Media | El laboratorio debe usar esos códigos; ampliar la lista requiere cambio de código y pruebas |
| R4 | **Clasificador por palabras**: falsos negativos («cita», «turno», «estacionamiento» sin etiqueta) caen en el texto genérico; falsos positivos posibles (p. ej. «turno» ≠ cita) | Media | Diseño conservador: lo ambiguo nunca recibe datos; ampliar con casos reales |
| R5 | **Identificación del estudio**: solo coincide con nombre normalizado o **alias aprobado**; hoy hay ~20 alias aprobados en el catálogo, así que casi toda pregunta de preparación terminará en «¿cuál es el estudio?» | Media | Ampliar alias aprobados (herramienta existente, decisión del laboratorio) |
| R6 | **La respuesta es el texto aprobado tal cual**: si el laboratorio aprueba un texto confuso o incorrecto, el bot lo repite | Media | Es el propósito del flujo de aprobación; la consulta de impacto (`plusmedik_kb_usage`) permite saber a quién se le dijo |
| R7 | **Out-of-order**: con `stale: NONE`, una respuesta lenta puede llegar después de otra más reciente | Baja | Cada respuesta encabeza con su tema; se prefirió esto a dejar al paciente sin respuesta |
| R8 | **Latencia**: cada pregunta hace 1 consulta de revisión a Supabase (≤ cada 15 s por instancia) y, en preparación, una carga de catálogo (cada 5 min) | Baja | Acotado; sin modelos |
| R9 | **Reloj**: `valid_from` es la hora de la base; un lector con el reloj atrasado ve «aún no vigente» unos segundos | Baja | Falla cerrado |
| R10 | **Límite de longitud**: una respuesta de más de 3800 caracteres no se envía (se responde como sin conocimiento) | Baja | Evita truncar a medias |
| R11 | **El rastro registra lo que se declaró usar**, no prueba que el texto enviado coincida | Baja | El fact-check de pruebas cubre la capa de respuestas |
| R12 | `plusmedik_kb_usage` devuelve la clave de contacto seudónima: permite saber *qué contactos* recibieron una versión (útil para corregir), pero es un dato de salud indirecto | Media (privacidad) | Solo `service_role`; el teléfono real solo existe en el CRM |

## 5. Condiciones para ACTIVAR G3.1A (en números de prueba; nada se activó)

Orden estricto (primero migraciones, después banderas; igual que G1/G2):

- [ ] Todo lo de **G2.1 §3** (staging, textos, Kapso, tope por contacto) — G3.1A hereda esas condiciones.
- [ ] Las **nueve** migraciones aplicadas y validadas en Supabase de ensayo con las RPC reales por HTTP (códigos `PT4xx`, `revision()`, `plusmedik_turn_record_knowledge`, `plusmedik_kb_usage`).
- [ ] **Gobierno resuelto** (roles de aprobación) y **vía de carga/aprobación** disponible (CRM o script de borradores).
- [ ] **Un primer lote de datos reales APROBADOS**: sucursal, horario, 1–2 políticas con los **códigos de tema** reconocidos, métodos de pago; la preparación clínica en un lote posterior.
- [ ] Exactamente **una política vigente por tema** y exactamente un horario por sucursal y servicio.
- [ ] Plantillas de `ANSWER_TEXTS` y de `DRAFT_TEXTS` **aprobadas** por el laboratorio.
- [ ] Guion manual en un número de prueba: pregunta con dato → respuesta correcta; sin dato → aviso; retirar el dato → ya no responde; dato vencido → no responde; consulta de impacto encuentra la conversación; pausa humana → silencio.
- [ ] Orden de banderas: `REQUIRE_AUDIT_GUARD` → `PLUSMEDIK_CONTACT_HMAC_KEY` + `PLUSMEDIK_HUMAN_CONTROL` → `PLUSMEDIK_TURNS` → `PLUSMEDIK_TEXT_HANDLER` → **`PLUSMEDIK_KNOWLEDGE_ANSWERS`** (la última), con `ALLOWED_PHONES` de 1–2 números del equipo.

## 6. Qué sigue (no hecho aquí)
- **G3.1B (sugerido):** script de carga de **borradores** con vista previa y `--apply` explícito (nunca aprueba), listado de cobertura de preparación por estudio y alias de estudios frecuentes.
- **G3.2:** ampliar temas con casos reales; endpoint de invalidación inmediata (contrato C4).
- **G5:** derivación real al CRM, que reemplazaría el aviso «no disponible» por una derivación confirmada.

## 7. Pruebas de mutación (reglas nuevas debilitadas a propósito)

| # | Regla debilitada | Resultado |
| --- | --- | --- |
| N1 | Enviar la respuesta con datos aunque el rastro no se pueda registrar | **4** pruebas fallan |
| N2 | Consultar conocimiento también ante lo médico/saludos | **2** fallan |
| N3 | Que la respuesta informativa sea descartable por obsolescencia | **2** fallan |
| N4 | Permitir registrar el rastro después de reservar el envío (SQL) | **2** fallan |
| N5 | Que la frase menos específica también identifique estudios | **1** falla |

Tras cada mutación el archivo se restauró y se comprobó idéntico (`cmp`).
