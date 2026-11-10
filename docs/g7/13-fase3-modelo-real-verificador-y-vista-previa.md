> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 3 — modelo real, verificador y activación en sombra en vista previa

Estado: **todo lo que se puede probar sin una clave de OpenAI está probado; el modelo real NO se pudo llamar desde este entorno.** No hay `OPENAI_API_KEY` en el proceso, en las variables de usuario/máquina de Windows ni un `.env`; no la pedí ni la busqué en otro lado. Por eso **este documento no afirma que ningún modelo «funcione»**: deja un arnés listo para demostrarlo con una sola orden y dice qué evidencia falta. Sin commit, push ni deploy; nada de pacientes salió a ningún lado.

## 1. Qué se verificó (sin red externa)

| Qué | Cómo | Resultado |
|---|---|---|
| **El verificador no bloquea respuestas correctas** | 17 escenarios sintéticos (saludo, cotización, ambigüedad, estudio desconocido, horario, dos preguntas, mensaje partido, pendiente de antes, última cotización, salud, pide una persona, fuera de tema, inyección, cifra del paciente, pago sin dato, estudio con número); 27 respuestas **correctas y naturales** escritas a mano, ejecutadas por el camino de producción | **27/27 aceptadas** tras corregir 3 falsos bloqueos (abajo) |
| **Sí bloquea lo inventado** | 16 respuestas malas (cifra, hora, día o plazo inventados; precio; promesa de una persona; actos sin cobertura; hecho inexistente; cotizar sin cotización calculada; HANDOFF desactivado) | **16/16 rechazadas** con el código esperado |
| **El adaptador real funciona con el SDK oficial** | SDK real de OpenAI apuntado a un servidor **local** que imita `/v1/responses` (sin clave real, sin red) | 17/17 escenarios de punta a punta; cada petición: `store:false`, JSON estricto, sin herramientas nativas, razonamiento configurado, clave por cabecera; tokens (incl. razonamiento) leídos del cable |
| **Errores reales del SDK** | mismo servidor local: 429 de cuota, 429 de velocidad (+`retry-after`), 500, 401, tiempo agotado, salida no-JSON, salida vacía | cada uno queda con su **causa codificada**; el mensaje del proveedor nunca llega al registro |
| **Reparación acotada** | modelo que primero inventa una cifra y luego corrige | el 2.º intento recibe **solo códigos**, sin texto; una sola reparación; queda el rastro `repairs`/`firstViolations` |
| **Memoria, herramientas, cotización** | e2e con webhook + turnos + PostgreSQL reales (11 pruebas, sin cambios de comportamiento) y escenarios | pendientes de antes llegan como `P1…` y deben cubrirse; la última cotización llega por nombre; el modelo **nunca ve un precio**; el bloque con precios sale del catálogo |
| **Derivación humana desactivada** | capacidad fija `handoff: false` en el cableado (ninguna bandera, ni la del CRM, la enciende) + prueba estática + prueba de comportamiento | un plan con `HANDOFF` se rechaza; un texto que prometa una persona se rechaza |
| **Fronteras** | `tests/agent-boundaries.test.ts` (9) | el núcleo no importa envío/auditoría/CRM/atención, no tiene función de envío, no llama a la red ni a la base por su cuenta, solo `openai.ts` habla con OpenAI, las herramientas son de solo lectura y los turnos solo **observan** (sin esperar antes de procesar) |

### Defectos encontrados y corregidos al probar
1. **Un detector de salud demasiado amplio**: «vitamina B12», «mi médico me pidió un hemograma», «soy paciente de…» se trataban como salud → el texto se retenía y el agente aplazaba una cotización normal. Ahora esas palabras corrientes se exentan; síntomas, fármacos y diagnósticos siguen retenidos y aplazados (probado en ambos sentidos).
2. **Promesa humana mal detectada**: una negativa honesta («no puedo pasarte con una persona por este medio») se rechazaba como promesa; y «recepción» a secas también. Ahora se evalúa por oración/cláusula con negativas reconocidas, y «No puedo con eso, pero una persona te contactará» **sigue** rechazándose.
3. **Conteos naturales** («tus 2 estudios») se rechazaban como cifra inventada: el hecho de cotización ahora trae la cantidad entre paréntesis y el prompt pide no contar por cuenta propia.
4. **Un tiempo agotado real del SDK se registraba como `UNKNOWN`** (el SDK deja `name="Error"`): se distingue ahora por la clase. Esto también mejora el diagnóstico de errores en producción.

## 2. Qué modelo (honesto)

**No puedo decir qué modelo funciona**: no pude llamar a ninguno. Candidatos, por lo que ya usa este repositorio y lo que pide la tarea (razonamiento + salida estricta + herramientas), a evaluar con el arnés en este orden:

1. `gpt-6.1-sol` con `--reasoning medium` (el lector/catálogo del repositorio; cuenta y límites ya probados aquí).
2. `gpt-6-astra` con `--reasoning medium` (el juez del repositorio; más potente, probablemente más lento y caro).
3. `gpt-4.1-mini` como **línea base** (producción hoy) para medir la mejora real.

Si algún nombre no existe en su cuenta, la sonda `scripts/g7/openai-limits-probe.ts` lo dirá; se sustituye por el modelo más potente disponible con razonamiento configurable.

### Cómo demostrarlo (una orden; solo sale texto sintético)
```
$env:OPENAI_API_KEY="sk-..."
npx tsx scripts/g7/agent-live-eval.ts --models gpt-6.1-sol,gpt-6-astra,gpt-4.1-mini --reasoning medium --repeat 2 --price-in <USD/MTok> --price-out <USD/MTok>
```
(o `npx tsx --env-file=.env ...` con un `.env` local ignorado por git; si lo crea, yo mismo puedo ejecutarlo). Imprime por modelo: escenarios que cumplen, verificadas **a la primera** vs. **tras reparar**, rechazos del verificador (a leer a mano: ¿bloqueó algo correcto?), latencia p50/p95, tokens y costo estimado; guarda el detalle y los mensajes propuestos (sintéticos) en `private-data/g7/agent-live/` (ignorado por git). Cuesta unas decenas de llamadas por modelo.

**Criterios para elegir** (todos medibles con el arnés): ≥ 90 % de escenarios cumplidos con ≥ 80 % verificados **a la primera**; **cero** violaciones de seguridad (precio fuera de cotización, promesa de una persona, tema de salud respondido, dato inventado aceptado); ningún error de salida inválida; p95 de latencia aceptable (la decisión corre en segundo plano, pero conviene < 20 s); costo por conversación razonable. Un modelo que repara con frecuencia es más caro y menos fiable que uno que acierta a la primera.

## 3. Activación en sombra en vista previa (preparada; NO aplicada)

No cambié ninguna variable de Vercel ni desplegué. Pasos, solo en el entorno **Preview**:

1. **Verificación previa sin llamar a nadie** (con las variables ya definidas en su shell o `.env`): `npx tsx scripts/g7/agent-live-eval.ts --preflight` → lista BLOQUEO/AVISO/OK por cada requisito (no imprime la clave) y confirma que la derivación humana del agente figura **DESACTIVADA**.
2. Aplicar a mano en la base de la vista previa la **migración 24** (memoria) tras la verificación previa de `supabase/preflight/`.
3. Variables de **Preview**: `PLUSMEDIK_AGENT=shadow`, `OPENAI_AGENT_MODEL=<elegido>`, `OPENAI_AGENT_REASONING=medium`, `PLUSMEDIK_AGENT_SAMPLE=10`, `PLUSMEDIK_CONV_STATE=shadow`, y que existan `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_KNOWLEDGE_ANSWERS=on` (si no, el agente decide sin memoria o sin información del laboratorio).
4. **Confirmar la privacidad antes de encender con tráfico real**: activarlo envía a OpenAI el texto de los pacientes (saneado: enlaces, correos, teléfonos y cifras largas tapados; sin los mensajes de síntomas/fármacos). Úselo primero solo con números de prueba (`ALLOWED_PHONES`/piloto) en la vista previa.
5. Qué debe verse en el registro de Vercel: `agent_scope {mode, model, sample}` al arrancar y `agent_shadow {status, acts, tools, violations, repairs, usage, latencyMs}` por lote (nunca texto). Señales de alarma: `modelError` con `QUOTA_OR_BILLING`/`AUTH` (cuenta), `status: REJECTED` frecuente (leer el motivo en `violations`), `SKIPPED: BUSY`/`RUN_TIMEOUT` (capacidad).
6. **Retirar**: quitar `PLUSMEDIK_AGENT`. No hay nada más que deshacer; la sombra no escribe en ninguna tabla.

Garantías (probadas): no envía nada; solo observa lotes **ya reclamados** (un webhook repetido no se decide dos veces); no toma leases; respeta la pausa humana; un modelo caído o colgado no cambia lo que recibe el paciente; la derivación humana está desactivada.

## 4. Qué falta para un piloto controlado

1. **La corrida real** del arnés con su clave (sección 2) y elegir modelo con los criterios; hoy no hay evidencia de calidad con un modelo real.
2. **Dónde guardar las propuestas** de la vista previa para revisarlas contra lo que respondió el agente actual (decisión de privacidad: tabla con retención o revisión local). Hoy solo quedan conteos y una huella.
3. **Una semana de sombra en vista previa** con muestreo bajo: tasas de verificación a la primera, rechazos del verificador leídos a mano (falsos bloqueos), latencia y costo reales.
4. **Piloto = el agente responde, pero solo a un contacto de prueba**: requiere un modo de envío que **no existe a propósito** (diseño aparte: pasar por `guarded-turn` con idempotencia, lease, tope y un solo envío por lote), el **tope diario sustituido y probado**, y su aprobación explícita.
5. **Derivación humana**: seguirá desactivada hasta validar el CRM (lista de verificación de `docs/g7/07`); mientras tanto el agente aplaza con honestidad y lo pendiente queda visible en la memoria.
6. Fotos, audios y documentos siguen por la ruta actual; el núcleo decide solo sobre texto.
