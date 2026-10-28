# G3.0 · Pruebas, riesgos y condiciones para pasar a G3.1

## 1. Resultado de las pruebas (offline; PostgreSQL 18 efímero; sin servicios reales)

| Dato | Valor |
| --- | --- |
| `tsc --noEmit` | sin errores |
| Suite completa | **64 archivos / 1600 pruebas, todas en verde** (≈ 2 min). Las **1505** de G2.1 siguen pasando; **95 son nuevas** |
| Cambios a pruebas existentes | **Ninguno** |
| Gasto / red | cero llamadas a modelos, Kapso o Supabase; sin procesos `postgres` residuales |
| Mutación | Se debilitó a propósito cada regla crítica y las pruebas la detectaron (ver §3) |

### Pruebas nuevas

| Archivo | Pruebas | Qué demuestra |
| --- | --- | --- |
| `tests/knowledge-db.test.ts` | 42 | Migración 8 contra PostgreSQL real: **sin datos**; RLS/privilegios; inmutabilidad (incluso del propietario); ciclo de vida de los 6 tipos con eventos; versionado (una aprobada/una abierta, supersede); revisión (+1 exacto en aprobar/desactivar/restaurar, sin cambio en crear/editar/enviar/rechazar); recuperación de versiones; **matriz de permisos** (IA, editor, aprobador de otra clasificación, tipo/rol cruzados, actores mal formados); **cuatro ojos** (creó/editó/envió); caducidad (sin fecha, pasada, >400 días, límites); contenido (lista blanca, claves de precio, 13 variaciones de importes, horarios, preparación); catálogo (estudio inexistente/inactivo, sin tabla de catálogo → falla cerrado); **concurrencia** (borradores simultáneos, aprobaciones simultáneas, aprobar vs desactivar, instantánea consistente con una aprobación sin confirmar, revisión sin saltos); lista e historial |
| `tests/knowledge-service.test.ts` | 35 | Servicio de lectura sin base: "no disponible" en toda consulta, caducidad al usar, contenido inválido, procedencia, horarios (zona horaria, cierre exclusivo, excepciones, fecha local vs UTC), políticas/pagos/FAQ, preparación con catálogo, **sin consolidación clínica**, caché (plazo de revisión, recarga por revisión, `invalidate`, una sola carga a la vez, copia más nueva no se pisa, base caída con plazo máximo y falla cerrado) |
| `tests/knowledge-e2e.test.ts` | 10 | Cliente de administración REAL + servicio REAL + PostgreSQL REAL: flujo completo (lo clínico exige aprobador clínico), invalidación (aprobar/retirar/restaurar), dos cachés convergen, caducidad con reloj controlado, permisos vistos por el cliente, IA→persona→persona con trazabilidad, base caída, lecturas concurrentes mientras se aprueba (nunca una mezcla), **prueba diferencial SQL↔zod con 55 contenidos** |
| `tests/knowledge-boundaries.test.ts` | 8 | Análisis estático: el conocimiento no importa nada del motor de recetas y viceversa; sin precios; del catálogo solo `id/name/active`; **el agente no importa ni nombra las funciones de escritura**; el índice de lectura no exporta la administración; el webhook, los turnos y el manejador de texto no conocen el módulo; `.env.example` sin variables nuevas |

## 2. Qué se reutilizó y qué no se tocó

- Reutilizado: `plusmedik_audit_forbid_mutation` (inmutabilidad), `plusmedik_audit_keys_within` (lista blanca), `createSupabaseRpc` (cliente RPC con reintento idéntico y errores sin valores), el arnés de PostgreSQL efímero y el adaptador PostgREST de pruebas.
- **No se tocó**: `analyze`, lectores, juez, catálogo, `partial-auto`, `uncertainty`, `quote-completion`, `whatsapp-quote`, precios, ni el webhook, los turnos, el manejador de texto ni la función de Vercel. Las migraciones 1–7 siguen idénticas (hashes fijados). Ninguna bandera nueva. `CRM-PLUSMEDIK` intacto.

## 3. Pruebas de mutación

| # | Regla debilitada a propósito | Resultado |
| --- | --- | --- |
| M1 | Quitar el "cuatro ojos" | **1** prueba falla (la de cuatro ojos) |
| M2 | Permitir que una IA envíe/decida (quitar su restricción de acción) | **3** fallan |
| M3 | Que cualquier aprobador apruebe lo clínico (y viceversa) | **3** fallan |
| M4 | Que aprobar no suba la revisión | **6** fallan (revisión exacta, concurrencia, instantánea) |
| M5 | Que el servicio ignore la caducidad | **5** fallan |

Tras cada mutación el archivo se restauró y se comprobó idéntico (`cmp`).

## 4. Riesgos

| # | Riesgo | Severidad | Mitigación / estado |
| --- | --- | --- | --- |
| R1 | **La base no autentica personas**: quien tenga `service_role` puede declarar cualquier actor y aprobar | Alta si se filtra la credencial | El agente no incluye las funciones de escritura (prueba estática); bitácora inmutable; recomendado rol de base de datos propio para el CRM (C1) y credencial distinta |
| R2 | **Cuatro ojos imposible con una sola persona autorizada** | Media (operativa) | Decisión A1 del laboratorio; el diseño no se relaja por conveniencia |
| R3 | **Cobertura**: ~541 estudios sin preparación cargada = "no disponible" para casi todo al inicio | Media | Carga por lotes priorizada por frecuencia; medir cobertura |
| R4 | **Caducidad = apagón del tema**: si nadie renueva, el agente deja de responder esa información | Media | Alertas de vencimiento en el CRM (contrato §4); caducidades escalonadas |
| R5 | **Retiro urgente tarda ≤ 15 s** en llegar a cada instancia | Baja | `invalidate()` + endpoint C4 opcional |
| R6 | **Desfase de relojes**: `valid_from` es el instante de aprobación en el reloj de la base; un lector con el reloj atrasado ve "aún no vigente" unos segundos | Baja | Falla cerrado; documentado |
| R7 | **Tamaño de la instantánea** (todo lo aprobado en una llamada) al crecer la preparación por estudio | Baja-media | Aceptable a cientos de filas; si crece, paginar o cargar por tipo (migración posterior) |
| R8 | **Texto libre de los contenidos** (FAQ, políticas) puede contener datos sensibles o promesas indebidas | Media | La aprobación humana es el control; sin importes (regla); revisión del laboratorio; no hay filtro semántico |
| R9 | La validación de importes es por patrón: formas muy inusuales ("cuarenta y cinco bolivianos") no se detectan | Baja | Revisión humana; el importe real siempre viene del catálogo |
| R10 | Un estudio desactivado en el catálogo conserva su preparación aprobada (no se entrega, pero existe) | Baja | El servicio devuelve `INACTIVE_STUDY`; limpieza futura desde el CRM |
| R11 | **Migración 8 sin aplicar** (la octava): aplicar exige las siete anteriores, staging y autorización | Alta (heredado) | G1/G2: orden estricto migraciones → banderas |
| R12 | PostgREST real sin verificar para `PT403/PT404/PT409/PT422` de estas funciones y la conversión `jsonb` de `revision()` | Media | Staging con RPC reales (condición de G3.1) |
| R13 | Perfiles de preparación (p. ej. "ayuno 8 h") no existen: cada estudio es un registro | Baja | Decisión C4 del laboratorio; extensión posterior |

## 5. Condiciones para pasar a G3.1

G3.1 = **conectar** el conocimiento al manejador de texto (respuestas con plantillas sobre datos aprobados) y cargar los primeros datos reales. No debe empezar hasta que:

1. **Gobierno resuelto** (A1–A5 de [03](03-informacion-del-laboratorio.md)): roles, quién aprueba lo administrativo y lo clínico, caducidades, alertas, textos de "no disponible".
2. **Datos reales entregados** al menos para un primer lote útil: sucursales, horario de oficina y de atención humana, 3–5 políticas más preguntadas, métodos de pago. (La preparación clínica puede ir en un lote posterior.)
3. **Supabase de ensayo autorizado** con las **ocho** migraciones; RPC reales por HTTP (códigos `PT4xx` y `revision()`), versión de PostgreSQL confirmada, y verificación de que `lab_tests.id`/`active` existen como se asumen.
4. **Una vía de carga/aprobación** disponible: o bien el CRM (fase propia, ver [02](02-contrato-crm.md)), o bien un **script de carga con vista previa y `--apply` explícito** que cree *borradores* (nunca aprobados) y un procedimiento de aprobación con los dos roles. Sin vía para aprobar no hay datos que leer.
5. **Decisión sobre credenciales** (C1): credencial separada o rol de base de datos para quien administra.
6. Para **G2.1/G3.1 en conjunto**: el tope de respuestas por contacto y la activación acotada por `ALLOWED_PHONES` (condiciones de G2.1), porque G3.1 hace que el bot responda con información útil.
7. **Diseño de plantillas**: texto aprobado por el laboratorio para cada tipo de respuesta basada en conocimiento (el manejador no redacta con modelo); cada plantilla solo con campos aprobados y verificadas por una prueba de "todo hecho citado proviene de un registro".
8. Presupuesto de pruebas con modelos reales **solo si** se decide usar un clasificador de intención con modelo (el actual es por reglas; el gasto previo superó el tope: pedir autorización y tope nuevos).

Lo que G3.1 **no** incluye: cotizaciones nuevas, sesión multi-imagen, emisor al CRM ni consolidación clínica automática.
