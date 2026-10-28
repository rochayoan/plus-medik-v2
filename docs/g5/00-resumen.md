# G5.0 · Derivación segura de casos al CRM — resumen

Fecha: 2026-10-25. Rama `feat/g2-turnos` (worktree `plus-medik-v2-g2`), **sin commit, sin push, sin merge**. Todo local y offline; **no se activó ninguna bandera**. No se tocó `CRM-PLUSMEDIK`, Supabase real ni Kapso, y no se llamó a ningún modelo.

| Documento | Contenido |
| --- | --- |
| [10-g50-derivacion-segura-al-crm.md](10-g50-derivacion-segura-al-crm.md) | Auditoría del contrato con el CRM, contratos faltantes, reglas de oro, flujo, datos, archivos |
| [11-g50-bloqueos-y-activacion.md](11-g50-bloqueos-y-activacion.md) | Resultados de pruebas y mutación, bloqueos, riesgos y condiciones de activación |
| [20-g51-aplicacion-de-migraciones.md](20-g51-aplicacion-de-migraciones.md) | G5.1: preparación y procedimiento manual para aplicar las 15 migraciones (orden, dependencias, riesgos, bloqueos, verificaciones de solo lectura en `supabase/preflight/`) |
| [30-g52-integracion-y-configuracion-del-agente.md](30-g52-integracion-y-configuracion-del-agente.md) | G5.2: integración documental y de configuración de G2–G5, y preparación de la configuración del agente (`agent-config/`: prompt, plantilla de datos del laboratorio, textos a aprobar) |
| [40-g53-conversacion-con-openai.md](40-g53-conversacion-con-openai.md) | G5.3: conversación natural con OpenAI preparada y APAGADA (el modelo conversa y clasifica; precios y datos siguen sujetos al catálogo y al conocimiento aprobado) |
| [50-g55-archivo-unico-de-configuracion.md](50-g55-archivo-unico-de-configuracion.md) | G5.5: `agent-config/laboratorio.json` como único archivo editable (negocio, estilo, sucursales, horarios, servicios, pagos, políticas), integración sin duplicar y lista de datos por completar *(reemplazado por G5.6)* |
| [60-g56-prompt-como-configuracion-principal.md](60-g56-prompt-como-configuracion-principal.md) | G5.6: el prompt como configuración principal (desde G5.8 es `src/system-prompt.ts`) (personalidad, tono, reglas y datos comerciales); el modelo informa solo datos confirmados; Supabase sigue siendo la fuente de precios, estudios, preparación y tiempos |
| [80-g59-cotizacion-por-texto.md](80-g59-cotizacion-por-texto.md) | G5.9: cotización por texto: una lista clara con pedido de cotizar se cotiza sin «listo»; acumulación con confirmación; aclaraciones con opciones del catálogo; abreviaturas validadas contra `lab_tests`; migración 14 |
| [70-g58-system-prompt-en-typescript.md](70-g58-system-prompt-en-typescript.md) | G5.8: `src/system-prompt.ts` (`SYSTEM_PROMPT` + `BUSINESS_DATA`) importado como código; sin Markdown, cargador ni generación; mismo comportamiento y controles |

## En una frase
Los casos que necesitan a una persona (receta ambigua o ilegible, estudio sin resolver, consulta médica o sin respuesta aprobada, petición explícita) se guardan en una **cola de salida persistente e idempotente** y se entregan al receptor que el CRM ya tiene, con reintentos acotados y manejo de `409`; el paciente solo recibe «una persona del equipo te escribirá» **cuando el CRM ya registró el caso**. Apagado por defecto; el motor de recetas no cambió.
