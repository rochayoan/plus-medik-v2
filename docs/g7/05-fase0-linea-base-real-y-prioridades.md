# G7 · Fase 0 — Línea base real (469 mensajes del 4-nov-2026) y mejoras prioritarias

Estado: **análisis local. No se modificó `src/`, no hay commits ni despliegues, no se envió ningún mensaje real y ningún dato de pacientes salió de esta máquina** (ni a servicios externos ni a esta conversación: todo el análisis se hizo con scripts deterministas que solo imprimen contadores; los extractos de texto están en un archivo privado que **no leí**).
> **Erratas (ver [`06`](06-causas-confirmadas-e-hipotesis.md) §9):** retenciones del día = 18 (`limited` 10, no 9); lotes bajo pausa sin atención de nadie = 24 con la ventana realista (no 39); de 16 análisis de fotos, 4 llegaron con precio y 6 de las 10 recetas cotizables se perdieron tras calcular el precio (defecto D1 ×4, pausa ×2).

Continúa [`04`](04-fase0-hallazgos-429-filtro-y-herramental.md). Reproducible con `scripts/g7/prepare-corpus.ts`, `corpus-baseline.ts` y `analyze-failures.ts`.

## 1. Archivo y verificación

| Punto | Resultado |
| --- | --- |
| Ubicación | No estaba en `private-data/g7/` de este worktree: estaba en `plus-medik-v2/private-data/g7.jsonl` (otro worktree) y en `Descargas`. Las dos copias son idénticas (SHA-256 igual). Copié una a `private-data/g7/historial.jsonl` (ignorada por git) |
| Formato | **No era el del exportador** (`scripts/history-export.ts`), sino filas de la tabla `plusmedik_message_history`: `seq, occurred_at, contact_phone, contact_key, direction, actor, origin, message_type, body, delivery_state, provider_message_id`. **El script no lo leía; añadí un adaptador** (`fromHistoryRow`) con prueba. Faltan `replyTo` y `auditRunId` (solo los da el exportador oficial) |
| Conteo | **469 registros válidos, 0 inválidos, sin duplicados** (coincide con lo esperado) · **58 contactos** · 2026-11-04 07:20 → 11-05 01:03 UTC (03:20 → 21:03 Bolivia) |
| Actores | Paciente 260 · **Recepción humana 142** · Agente 67 |
| Tipos | Texto 376 · imagen 57 · documento 23 · audio 8 · reacción 2 · ubicación 2 · sticker 1. Con texto: 82,5 % |
| Seudonimización | 58 conversaciones, 392 lotes de 15 s. Sustituciones: 1 teléfono, 10 enlaces, 2 nombres (con disparador). **29 textos con posible nombre residual: se enmascararon todas las palabras sospechosas** (44 sustituciones `[NOMBRE?]`, sobre-enmascara a propósito). La heurística no garantiza anonimato total: el corpus es solo para uso local |
| Salvaguardas | Salida solo en `private-data/g7/`; ACL de Windows restringida a su usuario; tabla de equivalencias aparte (`equivalences.private.json`) |

Observación del archivo: 46 mensajes tienen `seq` fuera de orden respecto a la hora (se ordena por hora); los mensajes enviados por el agente y por humanos quedan registrados con marcas distintas, normal.

**Limpieza pendiente (suya):** borrar `Descargas\plusmedik_historial_2026-11-04_469.jsonl` y `plus-medik-v2\private-data\g7.jsonl` cuando termine, porque contienen datos sin seudonimizar.

## 2. Línea base real

### 2.1 Quién atiende
| | |
| --- | --- |
| Conversaciones abiertas por | paciente 38 · **recepción humana 19** · agente 1 |
| Quién respondió | **solo humano 26** · agente y humano 13 · solo agente 15 · nadie 4 |
| Lotes del paciente | 183 → **121 sin ninguna respuesta del agente (66 %)** |
| Latencia (fin del lote → respuesta) | agente p50 **24 s**, p90 35 s · humano p50 2 min, p90 ≈ 92 min |
| Agente después de un mensaje humano | **0 de 39 conversaciones**: una vez que un humano escribe, el agente no vuelve a hablar (no hubo ninguna reanudación en el día) |

### 2.2 Por qué 121 lotes quedaron sin respuesta del agente
| Causa (inferida del patrón, ver §6) | Lotes | Notas |
| --- | --- | --- |
| **Pausa humana activa** | **71** | 32 en conversaciones abiertas por la recepción, 39 en pacientes que el agente ya atendía o era nuevos. De los 71: 32 los contestó la persona, **39 quedaron sin respuesta de nadie** dentro de la ventana (10 de ellos tras haber sido atendidos antes por el agente) |
| Social (agradecimientos, saludos): silencio esperado | 14 | correcto |
| **Tope de 5 respuestas / 24 h** | 8 | además 18 lotes ocurrieron con el tope ya alcanzado (se solapan con la pausa) |
| Sin agente, contestó un humano (sin pausa previa) | 7 | |
| Causa desconocida | 6 | candidatos: silencio por tema ajeno del modelo, fallos de auditoría |
| Fusionado con la respuesta siguiente | 6 | normal |
| **Tipo de mensaje no soportado** (documento, ubicación, reacción, sticker) | 5 | el webhook no tiene manejador para esos tipos: se ignoran |
| Foto sin respuesta inmediata / audio sin respuesta | 3 / 1 | |

Los sin respuesta se concentran en **07–09 h** (41), y a las **10 h** y **13 h** (12 cada una), hora de Bolivia; 8 ocurren de madrugada (03 y 06 h).

### 2.3 Calidad de las 67 respuestas del agente
| | |
| --- | --- |
| Texto libre (modelo, acuses…) | 40 (60 %) |
| **Texto fijo «no puedo derivarlo a una persona» / aviso médico** | **14 (21 %)** |
| **Texto fijo genérico** (saludo / «¿sobre qué quieres saber?» / «con gusto te ayudo a cotizar») | **11 (16 %)** |
| Cotización con precios | 2 con pie de cotización (4 mensajes con precios en todo el día) |
| A mensajes concretos (pregunta, info, receta, médico, persona): fijos | **17 de 32 (53 %)** |
| Preguntas de información (`INFO_REQUEST`) respondidas con «no puedo derivar» | **9 de 12 (75 %)** |
| Tras «no puedo derivar»: paciente insiste en < 5 min / humano interviene en < 60 min | 6 de 14 / 4 de 14 (mediana 2 min) |

Enrutamiento de las reglas sobre 210 mensajes del paciente con texto: **`OTHER` 142 (68 %)**, `INFO_REQUEST` 27, `RECIPE_OR_QUOTE` 20, `GREETING` 19, `MEDICAL` 2. Más de dos de cada tres mensajes caen en la categoría "sin camino propio".

### 2.4 Cruce con los errores 429 (telemetría)
| | Respuestas del agente | Fijas (genéricas + bloqueo) | % fijas |
| --- | --- | --- | --- |
| **Dentro de la franja 429** (13:17–18:02 UTC) | 23 | 17 | **74 %** |
| Fuera de la franja | 44 | 13 | 30 % |

*Criterio amplio (coincidencia por prefijo del texto fijo): 30 de 67 respuestas son fijas (45 %); con coincidencia exacta, 25 (37 %). Las dos cifras apuntan a lo mismo.* La caída de OpenAI explica la mayor parte de los textos genéricos del día, y aun fuera de esa franja casi un tercio de las respuestas son fijas.

### 2.5 Medios
| | |
| --- | --- |
| Fotos del paciente | 34: 21 con el agente activo (16 respondidas en < 5 min, **solo 3 con precio**; 5 sin respuesta) y 13 bajo pausa humana |
| Documentos (PDF/archivo) | **13: el agente no respondió ninguno** (11 con el agente activo) |
| Audios | 8: 3 respondidos, 5 no (3 bajo pausa) |
| La recepción envía | 23 imágenes y 10 documentos: gestiones que el agente no puede hacer hoy |

### 2.6 Telemetría de envíos retenidos (`reply_withheld`, 4-nov 07:00 → 5-nov 02:00 UTC, 17 eventos)
`limited` (tope diario o guarda) **9** · `audit_guard_unavailable` **4** (la base de auditoría no respondió: el agente calla por diseño) · `blocked` (pausa humana) 3 · `superseded` 1. En dos casos el tope retuvo incluso el texto fijo de respaldo tras un rechazo del filtro (mismo request).

### 2.7 Otros
Preguntas múltiples: solo 9 mensajes con 2+ signos de pregunta (3 lotes respondidos con un único mensaje); repetición literal tras respuesta: 1. **Son problemas menores en esta muestra; no son la causa principal.**

## 3. Fallos conversacionales más importantes (ordenados por impacto)

| # | Fallo | Evidencia | Clase | Severidad |
| --- | --- | --- | --- | --- |
| **F1** | **La pausa humana apaga al agente para el resto del día y los mensajes quedan sin atender.** 71 lotes (39 % de los del paciente); 39 sin respuesta de nadie. Ninguna reanudación en 39 conversaciones | `agentAfterHuman = 0`; `pausedBatches` | `HUMAN`, `PEND`, `CONT` | S1 |
| **F2** | **Indisponibilidad del proveedor de IA** (13:17–18:02 UTC) convierte respuestas en textos fijos: 74 % de las respuestas fijas en esa franja | §2.4; `04` §2 | `TECH`, `GEN` | S1 |
| **F3** | **La derivación está bloqueada**: 14 respuestas «no puedo derivarlo»; 75 % de las preguntas informativas recibieron eso; el paciente insiste o la persona interviene | §2.3 | `HUMAN`, `OPS` | S0/S1 |
| **F4** | **El agente ignora lo que no es texto ni foto**: 13 documentos, ubicaciones, reacciones; audios sin respuesta | §2.5 | `RECIPE`, `OPS` | S1 |
| **F5** | **Las recetas casi no producen cotización**: 16 fotos respondidas, 3 con precio (19 %); resto sin precio (5 mencionan revisión) | §2.5 | `RECIPE` | S1 |
| **F6** | **Tope de 5 y guarda `limited` retienen respuestas** (9 retenidos, 8 lotes), incluso el respaldo fijo | §2.2, §2.6 | `PEND`, `TECH` | S1 |
| **F7** | **Respuestas genéricas ante preguntas concretas** (53 %) y 67 % de los mensajes sin camino propio (`OTHER`) | §2.3 | `GEN`, `OPS` | S1 |
| **F8** | **Fallos de auditoría de base de datos** (4 retenciones `audit_guard_unavailable`): el paciente queda sin respuesta | §2.6 | `TECH` | S1 |
| F9 | Filtro de salida: rechaza ~20 % de respuestas razonables y deja pasar plazos/direcciones inventados | `04` §3 | `GEN`, `SAFE` | S1 (rechazo) / S0 (pasa) |

## 4. Qué NO es el problema principal (en esta muestra)
- **Preguntas múltiples en un mismo mensaje** (9 mensajes) y **repreguntas por mala respuesta** (1): existen pero son marginales hoy.
- **Latencia del agente**: 24 s de mediana, razonable (incluye la ventana de Kapso).
- **Pausa humana que falla**: funciona perfectamente (0 respuestas tras un mensaje humano). El problema es el *diseño* de qué pasa después, no la implementación.

## 5. Mejoras prioritarias

### P0 — Operativas, sin esperar la arquitectura (alto impacto, bajo esfuerzo)
1. **OpenAI:** revisar el panel (saldo/tope/límites 13:00–18:30 UTC), activar recarga automática y alertas; **separar proyectos/claves** (conversación, visión, audio) *(F2)*.
2. **Activar la derivación al CRM** con su configuración completa y probarla en vista previa *(F3)*; sin ella, el estado "derivado" del gestor de objetivos no existe.
3. **Cola de pendientes durante la pausa humana, visible para la recepción** (lista de preguntas sin atender desde la pausa, con alerta si pasan N minutos). No cambia la regla de reanudación manual (decisión 4), pero evita los 39 lotes abandonados *(F1)*. Requiere código nuevo (Fase 1 del plan).
4. **Tope/guarda:** que el tope no retenga el texto de respaldo ni las derivaciones; subir el límite mientras se prueba el reemplazo *(F6)*. Es una decisión de configuración.
5. **Auditoría:** reintento corto del `claim` y alerta cuando `audit_guard_unavailable` supere un umbral *(F8)*.

### P1 — Núcleo de la inteligencia (las fases ya aprobadas)
6. **Estado de conversación + gestor de objetivos** con libro de preguntas: ataca F1, F5, F7 de raíz (`02`).
7. **Verificador de salida por procedencia** que sustituya al filtro léxico *(F9)*; además cerraría hoy los dos falsos negativos peligrosos.
8. **Modelo del agente más capaz** que `gpt-4.1-mini` sin razonamiento, evaluado en replay (el costo no es restricción).
9. **Degradación contextual** en vez de texto genérico cuando falla el modelo *(F2, F7)*.
10. **Tratar documentos, ubicaciones y audio como entradas de primera clase** (recibir, registrar, responder qué se hará, derivar) *(F4)*; los PDF de órdenes son candidatos a pasar por el mismo lector de recetas.

### P2 — Calidad de recetas (paralelo, otro frente)
11. Diagnosticar por qué solo 3 de 16 fotos respondidas llegan a precio (¿lectura, catálogo, política de dudas, flujo de revisión?) con el benchmark de visión existente *(F5)*.

### Orden sugerido
`P0.1 → P0.2 → P0.5` (días, sin riesgo) en paralelo con la **Fase 1** (estado y cola de pendientes). Después herramientas + verificador (Fase 2) y el agente en sombra con este corpus como evaluación (Fase 3).

## 6. Limitaciones del análisis (para no sobreinterpretar)
- **Un solo día** y 58 contactos; patrones horarios y de franja 429 pueden no repetirse.
- Las **causas son inferencias de patrón**, no registros: p. ej. «pausa humana» = hay un mensaje humano anterior sin respuesta del agente después. Podría haber otra causa (silencio del modelo, tope) coincidente. El archivo no trae `replyTo` ni `auditRunId`, así que no se puede enlazar cada respuesta con su corrida de auditoría.
- La ventana de «respondido» termina en el siguiente mensaje del paciente o a las 2 h; una respuesta posterior cuenta como no respondida.
- **No leí el contenido de los mensajes**: la clasificación del enrutador son reglas, no juicio humano; el enrutamiento `OTHER` incluye mensajes que una persona vería claramente (hay que etiquetarlos). El casebook privado (`private-data/g7/casebook.private.md`, 52 casos) está para que **usted** lo revise y confirme o corrija las causas.
- Los textos fijos se reconocen por igualdad exacta con `DRAFT_TEXTS`; un mensaje combinado o con otro formato cuenta como «libre».
- La seudonimización por heurística no es una garantía de anonimato; el corpus no debe salir de este equipo.

## 7. Siguiente paso
1. **Usted:** revisar el casebook (52 casos) y marcar si las causas inferidas coinciden; decidir P0.1–P0.5.
2. **Yo (con su aprobación para escribir código):** (a) etiquetado asistido de los 183 lotes con la taxonomía de `03` §1.1 mediante un modelo local o a mano, sin enviar texto a servicios externos; (b) arnés de replay sobre el sistema actual; (c) arrancar Fase 1 (estado de conversación y cola de pendientes).
