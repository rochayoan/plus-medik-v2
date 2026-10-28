# Configuración del agente conversacional de PlusMedik

**El archivo principal es [`src/system-prompt.ts`](../src/system-prompt.ts).** Es código TypeScript normal: `SYSTEM_PROMPT` (personalidad, tono, reglas de conversación) y `BUSINESS_DATA` (datos comerciales: negocio, sucursales y direcciones, horarios, teléfonos, servicios, métodos de pago y políticas). El agente lo **importa** como cualquier módulo: no hay Markdown, ni lectura de archivos, ni paso de generación, ni dependencia del hosting. Todo está **apagado por defecto** y **no contiene ningún dato del laboratorio** (las siete secciones de datos están POR_COMPLETAR).

Esta carpeta solo conserva el documento de textos fijos para aprobación:

| Archivo | Qué es | ¿Se edita? |
| --- | --- | --- |
| [`../src/system-prompt.ts`](../src/system-prompt.ts) | **Archivo principal.** `SYSTEM_PROMPT` y `BUSINESS_DATA` | **Sí** |
| [`textos-a-aprobar.md`](textos-a-aprobar.md) | Textos fijos de la ruta determinista (respaldo del agente) para aprobación. Generado: `npm run agent-config -- texts --write` | No |

## Qué decide cada parte

| Parte | De dónde sale | Quién lo usa |
| --- | --- | --- |
| Personalidad, tono, reglas de conversación | `SYSTEM_PROMPT` | El modelo (con `PLUSMEDIK_LLM_CONVERSATION=on`) |
| **Datos comerciales** (negocio, sucursales, direcciones, horarios, teléfonos, servicios, métodos de pago, políticas) | `BUSINESS_DATA` | El modelo, solo con `PLUSMEDIK_LLM_BUSINESS_INFO=on` y solo las secciones `CONFIRMADO` y vigentes |
| **Estudios, precios, cotizaciones** | Supabase (`lab_tests`) y el motor de cotizaciones | El backend. El modelo nunca los da ni los modifica |
| **Preparación clínica, tipo de muestra, tiempos de entrega** | Supabase (datos aprobados por estudio) | El backend. El modelo nunca los da |
| **Derivación a una persona** | Cola hacia el CRM (backend) | El backend; «una persona del equipo…» solo con el caso ya registrado |

## Cómo editar

1. Abre `src/system-prompt.ts` y cambia el texto de `SYSTEM_PROMPT` o de una sección de `BUSINESS_DATA`.
2. Opcional: `npx tsc --noEmit` (el texto es una cadena; el compilador solo avisa si rompes la sintaxis, por ejemplo con una comilla invertida o `${`) y `npm run agent-config -- check` (lista lo que falta con el nombre de cada dato; `--strict` falla si queda algo pendiente o vencido). `npm run agent-config -- prompt` muestra el prompt final tal como lo recibirá el modelo.
3. Despliega como siempre. **No hay nada que generar.**

Cada sección de datos se escribe así:

```ts
HORARIOS: {
  estado: "CONFIRMADO",
  fuente: "acta-2026-10#horarios",
  vigenteHasta: "2027-06-30",
  datos: `
- (un dato por línea, tal como lo confirmó el laboratorio, sin precios)
`
},
```

- Cambia a `CONFIRMADO` **solo cuando todos los datos de la sección están completos** y confirmados por escrito. Una sección `POR_COMPLETAR` no se envía al modelo (y el modelo sabe que no la tiene).
- `fuente`: código del documento (letras, números y `_ . : / # -`, sin espacios). `vigenteHasta`: `AAAA-MM-DD`, máximo 400 días; al vencer, el agente deja de usar esa sección.
- Sin importes (el validador los rechaza); sin ningún `[POR COMPLETAR]` dentro de una sección confirmada.
- No uses comillas invertidas ni `${` dentro del texto (son una plantilla de TypeScript).

## Cómo lo usa el agente (igual en cualquier hosting)

`src/conversation-openai.ts` importa `SYSTEM_PROMPT` y `BUSINESS_DATA` de `src/system-prompt.ts`, valida los datos (`validateBusinessData`) y se los entrega a `createConversationModel` como las instrucciones del modelo (el marcador `{{DATOS}}` se reemplaza en cada llamada por las secciones confirmadas y vigentes). Como es código importado, viaja con el despliegue en Node, Docker, VPS, Dokku, Railway o Vercel sin configurar nada: ni `includeFiles`, ni rutas, ni variables de entorno para el prompt. El registro `llm_conversation_source` informa la huella (12 caracteres) y cuántas secciones están confirmadas/pendientes, nunca el contenido.

## Cómo se protege (aunque se edite el prompt)
El filtro de salida es código (`guardModelReply`), no texto del prompt: aunque alguien debilite las reglas, una respuesta del modelo se descarta si trae precios o moneda, preparación o plazos, términos médicos, promesas de una persona o de un momento, o cualquier cifra, horario, teléfono, enlace, día o tema que **no esté en los datos confirmados**. Los mensajes médicos o que piden a una persona nunca llegan al modelo, y las preguntas de precios o clínicas (preparación, muestra, tiempos) siguen por Supabase.

## Límites conocidos
- Las preguntas sobre «resultados» (cuándo/dónde entregan) se resuelven por el camino determinista (mezclan la política con el tiempo de entrega de cada estudio, que es de Supabase).
- Los textos fijos de respaldo (`textos-a-aprobar.md`) dicen «PlusMedik» en código: si el nombre comercial cambia, se actualizan en `src/text-handler.ts` (`DRAFT_TEXTS`).
- Si el modelo falla o su respuesta se descarta, el paciente recibe el texto fijo / la derivación de siempre.
- Hay otra ruta, independiente y opcional, para el conocimiento **aprobado y versionado** (G3: `src/knowledge`, con aprobación de dos personas desde el CRM). Con `PLUSMEDIK_LLM_BUSINESS_INFO=on`, los datos de `BUSINESS_DATA` prevalecen para las preguntas comerciales; la ruta G3 sigue siendo la de lo clínico por estudio.
