# G5.5 · Archivo único de configuración de PlusMedik

> **REEMPLAZADO por [G5.6](60-g56-prompt-como-configuracion-principal.md):** `agent-config/laboratorio.json`, `pendientes.md` y las órdenes `pending`/`drafts`/`apply` ya no existen; el archivo principal es `agent-config/system-prompt.es.md`. Este documento queda como historia.

Fecha: 2026-10-25. **No se ejecutaron pruebas (`vitest`), SQL remoto ni llamadas a OpenAI; no se tocó el CRM; sin commit, push ni despliegue.** Se corrió `tsc --noEmit` (sin errores) y órdenes **offline** de `scripts/agent-config.ts` sobre el archivo real y sobre un archivo sintético de prueba (fuera del repositorio). La prueba nueva `tests/agent-config.test.ts` está **escrita y compila, pero no se ejecutó**.

## 1. Qué se entrega

**`agent-config/laboratorio.json`** es ahora el ÚNICO archivo que se edita (reemplaza a la plantilla de G5.2). Secciones: `negocio` (nombre comercial, zona horaria), `estilo` (tratamiento, tono, emojis), `vigencia`, `responsables`, `sucursales` (nombre, dirección, **teléfono**, mapa), `servicios` (5 tipos), `horarios` (por servicio, con feriados), `politicas` (5 temas), `metodosDePago`, `preguntasFrecuentes`. Cada sección trae su `_ayuda`.

**No contiene datos inventados.** Lo único escrito es `nombreComercial: "PlusMedik"`, tomado del nombre del proyecto y de los textos actuales del agente, **marcado como por confirmar**. La zona horaria **no** se rellenó: el CRM usa `America/La_Paz` por defecto, pero no es una confirmación del laboratorio (queda anotado como pista). Todo lo demás está en `null`/vacío.

`agent-config/pendientes.md` (generado) lista, con el nombre exacto del campo, lo que falta: **21 elementos**.

## 2. Integración (sin duplicar y sin tocar la cotización)

| Dato | Destino | Detalle |
| --- | --- | --- |
| Nombre comercial y estilo | Prompt del modelo | El prompt ahora tiene los marcadores `{{NOMBRE_COMERCIAL}}` y `{{ESTILO}}`; `npm run agent-config -- prompt --write` los rellena desde el archivo. **Con los valores por defecto el prompt generado es idéntico al anterior** (verificado), así que nada cambia hasta que el laboratorio configure algo |
| Sucursales, horarios, políticas, pagos, preguntas | Conocimiento aprobado (`BRANCH`, `SCHEDULE`, `POLICY`, `PAYMENT_METHOD`, `FAQ`) | Se convierten en **borradores** con la clave derivada; el agente solo lee lo **aprobado** y vigente. El archivo es la única fuente: no hay otra copia de estos datos en el código |
| Zona horaria, sucursal única, vigencia por defecto | Se heredan en los horarios | Evita repetir y contradecirse. Con **dos o más** sucursales completas un horario sin `branchKey` es un error (no se adivina) |
| Servicios | Solo validación | Un servicio «ofrecido» sin horario, o «no ofrecido» sin política, genera aviso |
| Estudios, precios, cotizaciones | **No se tocan** | Siguen saliendo de `lab_tests` y del motor de cotizaciones; esta configuración no los conoce |

**`apply` no duplica:** compara cada dato con el historial de la base (contenido y vigencia): igual → **omitido**; borrador abierto distinto → **editado**; ya aprobado y distinto → **versión nueva**; enviado a aprobación sin decidir → **conflicto** (hay que resolverlo en el CRM). Nunca envía ni aprueba. No se ejecutó.

## 3. Validaciones (offline, probadas con datos de prueba)
Contrato idéntico al de la base (sin importes, horas coherentes, sucursal existente, `fuente` con el formato aceptado, vigencia futura ≤ 400 días); nombre comercial, zona horaria IANA y estilo con valores cerrados; aviso si el nombre comercial difiere del de los textos fijos (`DRAFT_TEXTS` dice «PlusMedik»).

## 4. Qué debe completar el laboratorio (resumen)
1. **Confirmar** el nombre comercial exacto y la **zona horaria**.
2. **Sucursales** (una por sede): clave `branch-…`, nombre, **dirección**, **teléfono**, enlace de mapa (https), con su fuente y vigencia.
3. **Servicios**: para cada uno de los 5, si se ofrece o no.
4. **Horarios** de cada servicio ofrecido (días y franjas, feriados) por sucursal.
5. **Políticas** (texto exacto aprobado, sin importes): entrega de resultados, toma a domicilio, facturación, convenios, citas.
6. **Métodos de pago** (incluidos los que no se aceptan) y **preguntas frecuentes**.
7. **Estilo** (opcional): tratamiento tú/usted, tono, emojis.
8. **Gobierno**: quién redacta y quién aprueba (personas distintas; lo clínico, personal clínico) y una fecha de vigencia común.

## 5. Pendiente / limitaciones
- Ejecutar `tests/agent-config.test.ts` y la suite completa (no se hizo).
- Los textos fijos del agente siguen escritos en código (`DRAFT_TEXTS` dice «PlusMedik»): si el nombre cambia, se actualizan allí.
- Solo cinco temas de política son consultables; el teléfono es por sucursal (una línea general se declara como sucursal o pregunta frecuente).
- Preparación de estudios y datos por estudio (plazo, muestra, requisitos) **no** están en este archivo.
- El CRM tiene sus propios «datos del negocio» (`crm_settings`: nombre, WhatsApp, dirección); no se leyeron ni se modificaron. Si el laboratorio los llena allí, conviene que coincidan con este archivo; hoy son fuentes independientes.
- Migraciones sin aplicar y aprobación del flujo de conocimiento: sin cambios (ver `docs/g5/20`).
