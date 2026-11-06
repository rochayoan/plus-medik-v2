> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 2 — núcleo conversacional: arquitectura mínima y modelo recomendado

Estado: **contratos, herramientas de solo lectura, verificador por procedencia y tubería fija implementados y probados con un modelo SIMULADO. No están conectados a ninguna respuesta real.** El modelo de producción no cambia. Sin commit, push ni deploy.
Bandera prevista: `PLUSMEDIK_AGENT=off|shadow` (`resolveAgentMode`; no existe un modo «on» en esta fase y nada la lee todavía en producción).

## 1. La idea en una frase

El modelo de lenguaje **entiende** lo que pidió el paciente y **decide cómo decirlo**; todo lo que el agente **afirma** sale de hechos con procedencia que producen herramientas deterministas; y los **efectos** (precios, derivar a una persona, enviar) los siguen ejecutando los mecanismos que ya funcionan.

Es la respuesta a lo que midió la Fase 0: el filtro léxico actual (`guardModelReply`) rechazaba ~20 % de respuestas correctas y, a la vez, dejaba pasar datos inventados («24 horas», una dirección) porque pregunta «¿suena prohibido?» en vez de «¿de dónde salió esto?».

## 2. Tubería fija (no un bucle libre)

```
peticiones del lote (Fase 1) ──► plan(modelo) ──► validar plan ──► herramientas (solo lectura) ──► redactar(modelo) ──► verificar por procedencia ──► DECISIÓN
                                    │                 │                                                                      │
                                    │                 └─ cobertura: cada petición tiene ≥1 acto; médico solo se deriva/aplaza └─ VERIFIED | REJECTED | MODEL_ERROR
                                    └─ acotado: ≤4 llamadas a herramientas, 4 s cada una, nunca lanza
```

Dos llamadas al modelo por turno, no un bucle: más fácil de probar, de acotar en costo y tiempo y de auditar. Si un turno necesita más pasos, el plan los pide como `toolCalls` (máximo 4) y el resto es determinista.

### Actos (qué puede hacer el agente con cada petición)

| Acto | Quién escribe el texto | Garantía |
|---|---|---|
| `ANSWER` + `factIds` | el modelo, **solo con los hechos citados** | cada cifra/hora/teléfono/enlace/día debe estar en un hecho citado o en el mensaje del paciente |
| `CLARIFY` | el modelo (una pregunta) | no afirma nada |
| `QUOTE` | **el sistema** (motor + catálogo) | el redactor no escribe precios; si repite el bloque debe ser idéntico |
| `HANDOFF` | **el sistema** (derivación registrada) | solo con este acto el texto puede decir que una persona atenderá |
| `ACK` | el modelo | cortesía sin datos |
| `DEFER` | el modelo | dice con honestidad que no puede ahora; sin inventar ni prometer |

Invariantes que verifica `src/agent/verify.ts` (puro): **cobertura** (nada queda sin destino — el defecto de la Fase 0 «tres preguntas, una respuesta»); un tema `MEDICAL` solo admite `HANDOFF`/`DEFER`; ningún precio sale del redactor; ninguna promesa humana sin `HANDOFF`; cifras con procedencia (reutiliza `extractTokens`, la misma extracción de horas/teléfonos/enlaces que ya usa el filtro actual).

### Herramientas (todas `readOnly: true`; envuelven lo que ya existe)

| Herramienta | Envuelve | Devuelve |
|---|---|---|
| `lab_info` | `answerFromKnowledge` (conocimiento aprobado y vigente, con versiones y hash) | texto aprobado + referencias |
| `find_studies` | `searchCatalog` | nombres del catálogo y su id, **sin precios** |
| `conversation_state` | `createConversationReader` (Fase 1) | temas y motivos pendientes, solo códigos |

Todo fallo (herramienta desconocida, entrada inválida, tiempo, error, sin dato) se vuelve un código en el rastro; nunca un texto de relleno ni una excepción.

## 3. Qué se reutiliza y qué no se toca

Se reutiliza: idempotencia y leases (`guarded-turn`), coordinación de turnos, pausa humana, tope diario hasta que su reemplazo esté probado, precios del catálogo (`quote-session`/`batch-execution`), conocimiento aprobado (G3/G4.1), memoria de la Fase 1, transcripción de audio, historial de mensajes.
No se introduce: LangGraph, Agents SDK, bucle libre de herramientas, escritura desde herramientas, ni memoria con texto del paciente.

## 4. Archivos

`src/agent/contracts.ts` (hechos, actos, plan, herramientas, puerto del modelo, rastro), `src/agent/verify.ts` (validación del plan y del texto), `src/agent/tools.ts` (registro acotado + 3 herramientas), `src/agent/pipeline.ts` (tubería y `resolveAgentMode`). Pruebas: `tests/agent-core.test.ts`.

## 5. Modelo recomendado

**Honestidad primero:** no puedo comprobar desde aquí qué modelos tiene habilitados su cuenta, sus límites ni su precio vigente (no tengo clave y no envié nada). Lo que sí sé es lo que ya usa el repositorio, y la recomendación se apoya en eso y se **decide con evidencia** (sección 6), no a ojo.

| Rol | Recomendación | Razón |
|---|---|---|
| **Planificador + redactor (candidato principal)** | `gpt-6.1-sol` con razonamiento **medio** | Ya es el modelo del lector y del catálogo (`OPENAI_READER_MODEL`, `OPENAI_CATALOG_MODEL`; el repositorio le asigna 2/10 USD por millón de tokens de entrada/salida), de modo que su cuenta, sus límites y su comportamiento con herramientas y salida estructurada ya están probados en este sistema. Medio equilibra calidad y latencia: un paciente espera una respuesta en segundos, no en minutos |
| **Turnos difíciles (solo si el replay lo justifica)** | `gpt-6-astra` | Es el juez del repositorio, con razonamiento alto. Reservarlo para lotes con varias peticiones, ambigüedad o plan rechazado dos veces; usarlo siempre encarece y alarga cada respuesta |
| **Línea base y plan B** | `gpt-4.1-mini` (producción hoy) | Para medir la mejora de verdad y como respaldo si el modelo nuevo falla o se agota la cuota |

Lo que pesa en la elección, en orden: (1) **cumplir el contrato** (plan válido con cobertura, salida estructurada estricta, llamadas a herramientas bien formadas), (2) **calidad de la redacción en español de Bolivia** con tono natural, (3) **latencia p95** (el webhook tiene hasta 300 s, pero la ventana de agrupación de Kapso es de 15 s y la experiencia se nota en segundos), (4) **costo por conversación** (secundario: usted priorizó calidad), (5) límites de la cuenta.

Para saber cómo está su cuenta **hoy** (cuota/facturación frente a límite de solicitudes, y los RPM/TPM reales de cada modelo) ejecute, con su clave y en su equipo:

```
$env:OPENAI_API_KEY="sk-..."; npx tsx scripts/g7/openai-limits-probe.ts --models gpt-4.1-mini,gpt-6.1-sol,gpt-6-astra
```

(una petición «ping» de 16 tokens por modelo; no envía datos de pacientes ni imprime la clave). Si alguno responde que no existe o no tiene acceso, el plan no cambia: se sustituye por el modelo más potente que sí tenga con razonamiento configurable.

## 6. Cómo se decide (replay, antes de cualquier cambio en producción)

1. **Adaptador** del puerto `AgentModel` con la API de Responses de OpenAI (`store: false`, salida JSON estricta; `study-interpreter-openai.ts` ya usa ese patrón). Aún no escrito: es lo primero de la siguiente etapa.
2. **Replay local** sobre los 183 lotes (469 mensajes) del corpus privado (`private-data/`, nunca al repositorio ni a un servicio externo) y las 16 sintéticas (`tests/support/g7-scenarios.ts`) **solo con el texto ya pseudonimizado**, comparando `gpt-4.1-mini` frente a `gpt-6.1-sol` (y `gpt-6-astra` en los difíciles).
3. **Métricas** (todas calculables sin leer texto de pacientes en la conversación de trabajo): % `VERIFIED`; cobertura (peticiones con acto); violaciones por código; falsos rechazos del filtro actual que el nuevo acepta; datos inventados que el actual dejaba pasar y el nuevo rechaza; p50/p95 de latencia; tokens y costo por conversación; revisión humana de una muestra pequeña de pares (actual vs. propuesto).
4. **Criterio para pasar a sombra en vivo:** cero violaciones de seguridad (precio fuera de cotización, promesa humana sin derivación, tema médico respondido) en el replay; cobertura 100 %; p95 aceptable; y la revisión humana prefiere al nuevo en la mayoría de los casos.
5. **Sombra en vivo** (`PLUSMEDIK_AGENT=shadow`): decide para cada turno **sin enviar** y se compara con lo que respondió el agente actual (el modelo de producción no cambia). Solo después, y con su aprobación, un piloto acotado.

## 7. Qué NO resuelve esta fase

- No contesta nada: es contrato, verificación y rastro. Para que «entienda y resuelva con naturalidad» falta el adaptador, el replay y la comparación (secciones 5–6).
- La derivación a una persona sigue sin estar activa en producción (`CRM handoff` apagado): hasta que se active, `HANDOFF` es un acto que el sistema **no puede ejecutar**; el plan debe usar `DEFER` y la memoria de la Fase 1 lo deja pendiente a la vista de la recepción.
- Documentos y audios siguen su ruta actual; el núcleo los verá como peticiones (`MEDIA_*`) y decidirá `CLARIFY`/`DEFER` hasta que existan herramientas para ellos.
