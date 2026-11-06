> ⚠ **Nombres de variables y modos reemplazados por la arquitectura unificada: ver [19-arquitectura-unificada.md](19-arquitectura-unificada.md).**

# G7 · Fase 2 — núcleo agéntico en sombra

Estado: **implementado y probado con modelos simulados; APAGADO por defecto; sin commit, push ni deploy; nunca se llamó a OpenAI de verdad.** Con `PLUSMEDIK_AGENT=shadow` decide en segundo plano qué respondería a cada lote, **sin enviar nada** ni cambiar ninguna respuesta, lease, pausa humana, tope diario ni precio.
Ajusta el diseño de `docs/g7/11`: la tubería quedó como *plan (herramientas) → herramientas → respuesta (actos + texto) → validar actos → verificar texto*; los actos pueden cubrir varias peticiones; la cotización es una herramienta cuyo bloque con precios agrega el sistema.

## 1. Qué funciona hoy

| Capacidad | Cómo |
|---|---|
| **Modelo OpenAI configurable (Responses API)** | `src/agent/openai.ts`: salida JSON estricta, `store: false`, razonamiento y tiempo configurables, sin herramientas nativas (las ejecuta nuestra tubería). Sin `OPENAI_AGENT_MODEL` no hay valor por defecto (decisión del dueño) |
| **Comprensión contextual** | una petición por mensaje del lote (clasificada), más lo **pendiente de turnos anteriores** (memoria de la Fase 1) como peticiones que hay que cubrir, más mensajes recientes si la memoria conversacional los provee. Los temas de salud llegan al modelo **sin texto** |
| **Planificación** | el modelo decide qué herramientas consultar (≤4) y luego los **actos** (`ANSWER`, `CLARIFY`, `QUOTE`, `HANDOFF`, `ACK`, `DEFER`); cada petición debe quedar cubierta; un tema médico solo se deriva o se aplaza |
| **Redacción natural** | un solo mensaje en español de Bolivia que cubre todas las peticiones del lote |
| **Herramientas existentes** | `lab_info` (conocimiento aprobado y vigente), `find_studies` (catálogo, sin precios), `quote_studies` (**el mismo motor de las sesiones de cotización**: nombres exactos, sinónimos, ambigüedades, precios válidos, estudio activo; solo cotiza si todo quedó identificado), `conversation_state` (pendientes y última cotización por nombre) |
| **Precios autorizados** | el modelo **nunca ve ni escribe precios**: los hechos de cotización no llevan cifras; el bloque con precios del catálogo lo arma el motor y lo agrega el sistema solo si un acto `QUOTE` lo pidió. Un precio escrito por el redactor, aunque coincida con el catálogo, se rechaza |
| **Verificador de procedencia** | toda cifra, hora, día, teléfono o enlace debe salir de un hecho citado o del propio mensaje del paciente; ninguna cifra de dinero sale del redactor; ninguna promesa de que una persona atenderá sin un acto `HANDOFF` disponible; cobertura de todas las peticiones |
| **Continuidad y pendientes** | `conversation_state`, peticiones `carried`, y la invariante de cobertura obliga a atender o aplazar con honestidad lo que quedó pendiente |
| **Auditoría de la decisión** | log `agent_shadow` con estado, actos, herramientas, códigos de violación, largo y huella del mensaje propuesto, tokens, latencia y la **causa codificada** si falla el modelo (429 de cuota vs. límite de solicitudes, etc.). Nunca texto |

## 2. Cómo conserva las garantías de producción

- **Un solo envío por lote / idempotencia / leases:** el ejecutor no recibe ninguna función de envío ni toma leases. Solo observa los mensajes que `processTurns` **ya reclamó**: una reentrega duplicada no se reclama y por tanto no se decide (probado ×3), y un lote de tres mensajes produce una respuesta real y **una** decisión.
- **Pausa humana:** los mensajes que esperan por la pausa no se reclaman, así que no se deciden; además, si la memoria dice que una persona tiene la palabra, no decide.
- **No retrasa al paciente:** corre en segundo plano dentro del mismo `waitUntil` que ya usa el webhook; con plazos propios (decisión 60 s, espera final 90 s; configurables en `createAgentShadow`) y tope de 4 decisiones simultáneas. Un modelo que no responde se descarta con un código.
- **Control de costo:** `PLUSMEDIK_AGENT_SAMPLE` (1–100 %) decide, de forma determinista por mensaje, qué lotes pasan por el modelo.
- **Apagado = idéntico a hoy:** sin la bandera no se crea cliente, no hay llamadas ni registros nuevos. Un valor inválido deja el agente apagado con un código (`agent_config_invalid`; nunca el valor).
- **Privacidad:** el texto del paciente solo viaja al modelo, saneado y acotado (enlaces, correos, teléfonos y cifras largas tapados; comillas triples neutralizadas; salud sin texto). El mensaje propuesto **no** se escribe en el registro de Vercel ni en ninguna tabla: solo llega al `record` inyectado (hoy solo pruebas).

## 3. Activación (cuando usted lo decida; no lo hice)

```
PLUSMEDIK_AGENT=shadow
OPENAI_AGENT_MODEL=<modelo elegido>     # obligatorio; recomendación en docs/g7/11 §5
OPENAI_AGENT_REASONING=medium           # opcional
PLUSMEDIK_AGENT_SAMPLE=10               # recomendado al empezar
PLUSMEDIK_CONV_STATE=shadow             # opcional: da memoria (pendientes, última cotización); exige la migración 24
```
Exige el modo turnos. Verás `agent_scope {mode, model, sample}` al arrancar y `agent_shadow {...}` por lote. Retirar: quitar `PLUSMEDIK_AGENT`.
Nota: activarlo **envía texto de pacientes (saneado y sin salud) a OpenAI** además de lo que ya envía la conversación con modelo; confírmelo antes de encenderlo con tráfico real.

## 4. Pruebas (específicas, sin repetir la suite completa)

| Archivo | Pruebas | Cubre |
|---|---|---|
| `tests/agent-core.test.ts` | 33 | validación de actos, verificador, herramientas (incl. cotización contra catálogo: certeza, ambigüedad, a medias, inactivo, precio inválido), tubería, errores del modelo con causa codificada |
| `tests/agent-openai.test.ts` | 17 | lo que ve el modelo (saneado, sin salud, sin precios), esquemas estrictos, interpretación de la salida, cliente Responses (SDK simulado), configuración |
| `tests/agent-shadow.test.ts` | 17 | peticiones por mensaje, pendientes, ejecutor (códigos sin texto, fallos, pausa humana, medios, herramientas, muestreo, concurrencia, plazos) |
| `tests/agent-shadow-e2e.test.ts` | 11 (webhook + turnos + PostgreSQL reales) | **mismos envíos, corridas de auditoría, historial y llamadas a la base** con la sombra encendida; cotización con precios solo del sistema; continuidad entre mensajes; un lote = una decisión; reentrega ×3; pausa humana; modelo que falla o no responde; privacidad |
Además se ampliaron las listas de las pruebas de límites entre módulos y `tsc` queda limpio. Corrieron también `turns*`, `g7-phase1-state` y `conversation-state-store` (verdes).

## 5. Qué falta conectar (honesto)

1. **Nunca se probó contra OpenAI real.** El adaptador está probado contra un SDK simulado: falta una corrida real con su clave (calidad de planes/redacción, latencia, costo) antes de decidir el modelo.
2. **Dónde guardar las propuestas para compararlas.** Hoy solo hay conteos y una huella; para revisar «actual vs. propuesto» hace falta un sumidero con retención (p. ej. una tabla como el historial) o un modo de replay local. Decisión de privacidad pendiente.
3. **Fotos, audios y documentos** siguen su ruta de siempre; el núcleo solo decide sobre texto.
4. **`HANDOFF` no existe en producción** (derivación al CRM bloqueada): el plan debe usar `DEFER` y queda pendiente visible. Activarla requiere la lista de verificación de `docs/g7/07`.
5. **Cotizar desde una receta ya leída** (sin nombres escritos): las fotos siguen en el motor actual; el núcleo no recupera «los estudios de mi foto» salvo por la última cotización (`conversation_state`).
6. **Mensajes recientes** dependen de la memoria conversacional (apagada en producción); sin ella el contexto son solo los pendientes y la última cotización.
7. **Responder de verdad** (modo `on`): no existe a propósito. Exige replay, sombra en vivo comparada, tope diario reemplazado y su aprobación.

## 6. Siguientes pasos

1. Ejecutar la sonda de límites y una **corrida de replay local** del modelo candidato sobre el corpus pseudonimizado y los 16 escenarios sintéticos (sin servicios externos para datos reales hasta decidirlo).
2. Elegir el sumidero de propuestas y su retención; añadir un informe «actual vs. propuesto» para revisión humana.
3. Activar en vista previa con `PLUSMEDIK_AGENT_SAMPLE` bajo y la memoria de la Fase 1.
4. Con los resultados: decidir modelo, ajustar instrucciones, y diseñar el piloto acotado (un contacto de prueba) con el tope diario sustituido.
