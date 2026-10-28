# G5.6 · `system-prompt.es.md` como archivo principal de configuración

Fecha: 2026-10-26. **Sin SQL remoto, sin llamadas a OpenAI, sin tocar el CRM, sin commit, push ni despliegue.** Se corrieron `tsc`, las pruebas offline (ver §6) y órdenes locales de `scripts/agent-config.ts`.

Simplifica G5.5: desaparecen `agent-config/laboratorio.json` y `pendientes.md` (y las órdenes `pending`, `drafts` y `apply` del script). El archivo principal es ahora `agent-config/system-prompt.es.md`.

## 1. Qué hay en el archivo principal
- **Personalidad, tono y reglas de conversación** (texto libre, editable): borrador mío, sin aprobar por el laboratorio.
- **Siete secciones de datos comerciales**: `NEGOCIO`, `SUCURSALES` (con direcciones), `HORARIOS`, `TELEFONOS`, `SERVICIOS`, `METODOS_DE_PAGO`, `POLITICAS`. **Todas están `POR COMPLETAR`**: no se inventó ningún dato (ni siquiera el nombre comercial, que figura como «PlusMedik [POR COMPLETAR: confirmar la grafía]»). Cada una pide `Fuente` y `Vigente hasta`.
- Las reglas de lo que NO es del modelo: estudios, precios, cotizaciones, preparación clínica, muestra y tiempos de entrega (Supabase / backend) y derivaciones al CRM.

## 2. Cómo llega al agente
**G5.7:** el agente LEE el archivo directamente al arrancar (`src/conversation-source.ts`), sin módulo generado ni paso de generación (ver §8). En ejecución, `src/conversation-facts.ts` decide **al usar el dato** qué secciones están disponibles (`CONFIRMADO` y no vencidas) y las inserta en `{{DATOS}}`; las demás se nombran como «sin dato». Sin `PLUSMEDIK_LLM_BUSINESS_INFO=on` el modelo **no recibe ningún dato** (solo conversa y clasifica, como en G5.3).

## 3. Cómo se mantiene seguro con datos comerciales
| Riesgo | Control (código, no depende del texto del prompt) |
| --- | --- |
| Inventar un dato comercial | Cada cifra, hora, teléfono, enlace, correo, día de la semana y tema (pago, sucursal, domicilio, convenio…) de la respuesta debe **existir en los datos confirmados**; si no, se descarta (`UNGROUNDED`) |
| Precios | Palabras de precio y moneda se rechazan siempre; las preguntas de precio ni llegan al modelo |
| Preparación, ayuno, plazos y tiempos de entrega | Se rechazan siempre (`CLINICAL_DATA`); esas preguntas ni llegan al modelo; salen de Supabase |
| Cotizaciones y derivaciones | El modelo no importa nada de eso; frases como «registré tu caso», «derivé», «el total es…», «una persona te escribirá» se rechazan; el sumidero hacia el CRM solo lo llama el manejador por reglas o por una reclasificación a un camino más conservador |
| Orientación médica | Los mensajes médicos nunca llegan al modelo; términos y medicamentos en la respuesta se rechazan |
| Datos vencidos o sin confirmar | No se envían (`PENDING`/`EXPIRED`); sin ninguna sección disponible, las preguntas comerciales ni llaman al modelo (`NO_CONFIRMED_DATA`) |
| Activación accidental | Dos banderas: `PLUSMEDIK_LLM_CONVERSATION=on` y `PLUSMEDIK_LLM_BUSINESS_INFO=on`; la segunda sin ningún dato confirmado y vigente se queda apagada y registra `BUSINESS_DATA_PENDING` |

**Qué mensajes llegan al modelo con datos:** preguntas comerciales clasificadas como información (INFO_REQUEST) que no mencionan precios ni temas clínicos, y mensajes de conversación (saludos, sin clasificar) que no pregunten precios ni temas clínicos. Si el modelo no puede responder con los datos (`INFO_REQUEST`) o reconoce salud o una persona, el mensaje sigue por el camino de siempre (conocimiento aprobado / derivación al CRM / aviso médico).

## 4. Qué cambia en el código
`src/conversation-facts.ts` (nuevo: secciones, vigencia, fichas verificables) · `src/conversation-model.ts` (intención `BUSINESS_INFO`, filtro con respaldo en los datos, bloque de datos por llamada, límites mayores con datos) · `src/conversation-openai.ts` (bandera de datos) · `src/text-handler.ts` (ruta de preguntas comerciales; mensajes de precio/clínicos nunca van al modelo) · `scripts/agent-config.ts` (`check`, `prompt`, `texts`) · `.env.example` (`PLUSMEDIK_LLM_BUSINESS_INFO`).

## 5. Lo que debe completar el laboratorio
Las siete secciones del archivo, cada una con fuente y vigencia (`npm run agent-config -- check` lista lo que falta con el nombre de cada dato): nombre comercial exacto · sucursales con dirección completa, referencias y mapa · horarios por servicio y sucursal, feriados · teléfonos y WhatsApp · servicios que se ofrecen y los que no · métodos de pago aceptados y no aceptados · políticas (entrega de resultados, domicilio, facturación, convenios, citas). Además: aprobar la personalidad, el tono y las reglas del prompt.

## 6. Resultados de las pruebas
`tsc --noEmit` sin errores. Suite completa: **91 archivos / 2566 pruebas en verde**, sin procesos ni carpetas temporales residuales. Pruebas nuevas o reescritas: `agent-config` (validación del archivo principal), `conversation-model` (filtro con datos, vigencia, banderas, manejador), `conversation-adversarial` (modelo hostil con datos: nada inventado llega al paciente; precios, preparación, tiempos, cotizaciones y derivaciones intactos) y `conversation-boundaries` (fronteras estáticas). Las pruebas encontraron y se corrigieron: un día de la semana normalizado mal (`lunes`→`lune`), verbos naturales («atendemos») que no se respaldaban en la sección de horarios, frases de derivación/total («registré tu caso») que pasaban el filtro, y mensajes de preparación/muestra clasificados como «sin clasificar» que llegaban al modelo. Ninguna prueba llama a OpenAI.

## 7. Pendiente
- Datos reales del laboratorio y aprobación del prompt; aprobación de privacidad y modelo (ver `docs/g5/40`).
- Las preguntas sobre «resultados» siguen por el camino determinista.
- Evaluación de la clasificación con mensajes etiquetados antes de un piloto (dentro del presupuesto de gasto).
- Los textos fijos de respaldo siguen diciendo «PlusMedik» en código.
- Retirada de las órdenes `drafts/apply` de carga de conocimiento por archivo: si se quiere precargar el conocimiento aprobado (G3) desde un archivo, habría que rehacerla.

## 8. G5.7 — el archivo se carga solo (sin `prompt --write`) — SUPERADO por G5.8

> **G5.8** (ver [`70-g58-system-prompt-en-typescript.md`](70-g58-system-prompt-en-typescript.md)): el prompt y los datos ahora son constantes de `src/system-prompt.ts`, importadas por `src/conversation-openai.ts`. Ya no existen `agent-config/system-prompt.es.md`, `src/conversation-source.ts`, `PLUSMEDIK_AGENT_PROMPT_FILE` ni el `includeFiles` de Vercel. Lo que sigue es el historial de G5.7.

**Antes:** al editar el archivo había que ejecutar `prompt --write` para regenerar `src/conversation-prompt.generated.ts`; olvidarlo dejaba el agente con un prompt viejo. **Ahora:** ese módulo y esa orden **ya no existen**. El agente lee `agent-config/system-prompt.es.md` al arrancar (`src/conversation-source.ts`, solo `fs`/`path` de Node; una vez por proceso, y solo si la conversación con modelo está activada).

- **Búsqueda del archivo:** `PLUSMEDIK_AGENT_PROMPT_FILE` (única ruta si se define) → directorio de trabajo → ubicación del módulo.
- **Cada versión desplegada usa su archivo:** el despliegue lleva el repositorio; al arrancar se lee; el registro `llm_conversation_source` informa la huella (12 caracteres) y cuántas secciones están confirmadas/pendientes, nunca el contenido. Cada llamada registra además la huella del prompt usado.
- **Falla cerrado:** sin archivo (`PROMPT_FILE_MISSING`) o con marcas inválidas (`PROMPT_FILE_INVALID`) la conversación con modelo queda apagada y todo lo demás sigue igual. Defectos en una sección de datos (`PROMPT_DATA_INVALID`) solo dejan fuera esa sección.
- **Sin pasos de instalación ni compilación:** no hay `postinstall`, `build` ni `prestart` (una prueba lo verifica), porque Docker con `package.json` copiado antes, Dokku, Railway y Vercel los tratan distinto.
- **Hosting:** Node/VPS/Docker/Dokku/Railway: el archivo viaja en el repositorio o imagen (sin excluir `agent-config/`). Vercel: `vercel.json` lo incluye en la función (`includeFiles`) y `.vercelignore` lo deja pasar aunque excluya los demás `.md` (de lo contrario no habría llegado al despliegue).
- **Se conserva:** cotizaciones, seguridad clínica, privacidad (el modelo solo ve lo confirmado y el mensaje saneado) y derivación al CRM no cambian; el filtro de salida sigue siendo código.
- **Pruebas:** escritas (cargador, rutas, fallas, huella, portabilidad y fronteras) pero **NO ejecutadas** en este turno por instrucción; `tsc` sin errores y el cargador se comprobó con un script local (cwd, otro directorio de arranque, ruta explícita, ausente, resolvedor).
