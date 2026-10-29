# G5.8 · El system prompt como código TypeScript (`src/system-prompt.ts`)

Fecha: 2026-10-26. **Sin SQL remoto, sin llamadas a OpenAI, sin tocar el CRM, Supabase ni Kapso, sin commit, push ni despliegue.** Solo se ejecutó `tsc --noEmit` (sin errores); las pruebas se actualizaron pero **no se ejecutaron**, por instrucción.

Sustituye la carga por archivo de G5.7: el prompt deja de ser un Markdown leído al arrancar y pasa a ser una constante exportada, como en el patrón `prompts.ts` → `route.ts`.

## 1. Cómo queda conectado
```
src/system-prompt.ts
  export const SYSTEM_PROMPT     (instrucciones; un {{DATOS}})
  export const BUSINESS_DATA     (siete secciones comerciales, hoy POR_COMPLETAR)
        │ import
        ▼
src/conversation-openai.ts       resolveConversationModel(): solo si PLUSMEDIK_LLM_CONVERSATION=on
  buildPromptSource()            validateBusinessData(BUSINESS_DATA) → secciones + problemas + huella sha256
        │
        ▼
src/conversation-model.ts        createConversationModel({ prompt, sections, … })
  por llamada: {{DATOS}} ← renderFacts(secciones CONFIRMADAS y vigentes)  →  `instructions` de OpenAI
  salida: guardModelReply (filtro determinista)  →  text-handler (clasificación y reencaminamiento)
```

## 2. Qué cambió
| Archivo | Cambio |
| --- | --- |
| `src/system-prompt.ts` | **Nuevo.** `SYSTEM_PROMPT` (identidad, personalidad, tono, reglas, restricciones, clasificación, formato) migrado íntegro del Markdown, y `BUSINESS_DATA` con negocio, sucursales, horarios, teléfonos, servicios, métodos de pago y políticas (todas POR_COMPLETAR; nada inventado) |
| `src/conversation-facts.ts` | Tipos `BusinessData`/`BusinessSection` y `validateBusinessData` (misma validación que antes: fuente, vigencia AAAA-MM-DD, sin pendientes ni importes en secciones confirmadas) |
| `src/conversation-openai.ts` | Importa el prompt y los datos; `buildPromptSource()`; falla cerrado con `PROMPT_INVALID` si la plantilla no tiene exactamente un `{{DATOS}}`; sin rutas, `cwd` ni lectura de archivos |
| `scripts/agent-config.ts` | `check`, `prompt` y `texts` leen el módulo (sin Markdown ni cargador) |
| Eliminados | `src/conversation-source.ts`, `agent-config/system-prompt.es.md`, `PLUSMEDIK_AGENT_PROMPT_FILE`, `includeFiles` de `vercel.json` y las líneas `!agent-config/…` de `.vercelignore` |
| Pruebas | `agent-config`, `conversation-model` y `conversation-boundaries` reescritas para el nuevo módulo (fronteras G5.8: solo importa un tipo, sin `fs`/`process.env`, sin scripts de instalación, apagada por defecto) |

## 3. Qué NO cambió
Banderas y apagado por defecto (`PLUSMEDIK_LLM_CONVERSATION`, `PLUSMEDIK_LLM_BUSINESS_INFO`, `OPENAI_CONVERSATION_MODEL`…), filtro de salida (`guardModelReply`), saneamiento del mensaje, privacidad (`store:false`, sin texto en registros), clasificación (`MODEL_INTENTS`), reencaminamiento de lo médico y de las personas al camino determinista, y las reglas: precios y estudios solo de `lab_tests`; recetas y cotizaciones, del motor existente; preparación, muestra y plazos, de los datos aprobados en Supabase; derivación a una persona, del backend/CRM. El modelo no puede inventar datos, modificar cotizaciones ni ejecutar operaciones críticas.

## 4. Cómo se edita y se despliega
Abrir `src/system-prompt.ts`, cambiar el texto y desplegar como siempre (Node, Docker, VPS, Dokku, Railway o Vercel): el prompt es código importado, así que viaja en el despliegue sin `includeFiles`, rutas ni variables. Dentro de las plantillas de texto no usar comillas invertidas ni `${`. Opcional: `npx tsc --noEmit` y `npm run agent-config -- check`.

## 5. Pendiente
- **Ejecutar la suite** (las pruebas reescritas no se corrieron).
- Datos reales del laboratorio en `BUSINESS_DATA` y aprobación del prompt; aprobación de privacidad y modelo; evaluación de la clasificación (ver `docs/g5/40` y `60`).
