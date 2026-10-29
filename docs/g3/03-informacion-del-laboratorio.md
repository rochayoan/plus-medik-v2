# G3.0 · Información que necesitamos obtener del laboratorio

Hoy el repositorio **no contiene ningún dato** del laboratorio, y no debe inventarse ninguno. Lo siguiente es una lista de **qué pedir**, no de datos. Cada dato llega como borrador con su fuente (`source_ref`: p. ej. el documento firmado donde consta), lo revisa una persona distinta de quien lo redactó y lo aprueba el rol correspondiente.

## A. Decisiones de gobierno (necesarias antes de cargar nada)

| # | Pregunta | Por qué importa |
| --- | --- | --- |
| A1 | ¿Quién puede ser **aprobador administrativo** y quién **aprobador clínico** (personal autorizado)? ¿Cuántas personas hay en cada rol? | El diseño exige dos personas distintas (redactor y aprobador). Con una sola persona no se puede aprobar lo propio |
| A2 | ¿Quién redacta (editor)? ¿Se permite que una IA proponga borradores administrativos (nunca clínicos) que una persona revisa? | La IA solo redacta; no es obligatoria |
| A3 | ¿Cada cuánto debe revisarse cada tipo de contenido? Hoy: caducidad obligatoria, máx. 400 días | Fija `valid_until` por tipo (p. ej. horarios más corto que políticas) |
| A4 | ¿Quién avisa y a quién cuando algo está por vencer? | Vencido = el agente deja de responder ese tema |
| A5 | ¿Qué se responde cuando el dato no está disponible (derivar a persona, pedir la foto, "te confirmamos")? Textos aprobados | Hoy son borradores de G2.1 |

## B. Datos administrativos (por cada uno: fuente, vigencia y responsable)

| Tipo | Qué hay que entregar |
| --- | --- |
| **Sucursales** | Nombre, dirección, enlace de mapa (https), teléfono de contacto, notas (referencias). Identificador corto estable (`branch-…`) |
| **Horarios** (por sucursal **y por servicio**) | Atención en oficina · toma de muestras · entrega de resultados · toma a domicilio · **atención humana** (la que se promete al derivar). Días y franjas (pueden ser varias por día), zona horaria, **feriados y excepciones** (fecha, cerrado o con horario especial). Si un servicio no se ofrece, decirlo por **política**, no con un horario vacío |
| **Políticas de atención** | Una por tema: entrega de resultados, toma a domicilio, facturación, convenios, citas, cancelaciones, menores de edad, urgencias, reclamos… (lista de temas la define el laboratorio). Texto exacto aprobado, **sin importes** |
| **Métodos de pago** | Cada método con su etiqueta y si se **acepta o no**; notas (p. ej. condiciones). Sin montos |
| **Preguntas frecuentes** | Pregunta, respuesta aprobada y etiquetas. Sin importes ni datos clínicos |

Reglas para quien redacta: los precios **no** se escriben en el conocimiento (salen del catálogo); nada de datos de pacientes; un dato por registro; indicar la fuente.

## C. Datos clínicos — preparación de estudios (solo personal clínico autorizado)

| # | Qué entregar |
| --- | --- |
| C1 | Para **cada estudio activo del catálogo** (hoy ~541): la preparación aprobada **o** la declaración explícita de que **no requiere preparación**. Un estudio sin registro se tratará como "sin información disponible" |
| C2 | Si requiere preparación: ayuno en horas (0–48) y/o instrucciones; ventana de toma si aplica; indicaciones especiales de muestra (p. ej. orina de la mañana, recolección seriada) |
| C3 | **Reglas de combinación** cuando se piden varios estudios (¿qué ayuno rige?, ¿conflictos de ventanas?, ¿cuáles se toman en días distintos?). Hoy **no hay consolidación automática** a propósito |
| C4 | Si se prefieren **perfiles de preparación** (p. ej. "ayuno 8 h", "ayuno 12 h", "primera orina") para asignar por grupos y excepcionar estudios. Hoy el modelo es por estudio; los perfiles requerirían una extensión |
| C5 | Decisiones comerciales/clínicas pendientes ya identificadas en fases anteriores: composición de perfiles (p. ej. lipídico), variante por defecto de TSH/VIH/BUN-Urea, si el urocultivo incluye antibiograma, significado de "AM/PM" (¿08:00/16:00?), paquete vs suma. Afectan a la cotización, no a este módulo, pero conviene resolverlas juntas |
| C6 | Qué hacer si el paciente pregunta algo clínico fuera de la preparación (siempre a persona; confirmar el texto) |

## D. Orden de carga recomendado

1. Roles y gobierno (A1–A5).
2. Sucursales → horarios de **atención humana** y de oficina → políticas más preguntadas → métodos de pago → preguntas frecuentes (valor inmediato, riesgo bajo).
3. Preparación: empezar por los **estudios más cotizados** (se puede sacar de la auditoría de cotizaciones, sin datos de pacientes) y avanzar por lotes; cada lote con revisión clínica.
4. Medir cobertura: % de estudios cotizados con preparación aprobada vigente.

## E. Formato de entrega sugerido

Una hoja por tipo con las columnas de [01 §2](01-arquitectura-y-modelo.md), más: `fuente` (documento), `vigente_hasta`, `responsable`. Para preparación: `id de estudio` (el UUID del catálogo, no el nombre). El script de carga (G3.1, con `--apply` explícito y vista previa) los convertiría en **borradores**; nunca en datos aprobados.
