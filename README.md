# PlusMedik V2

Core limpio para lectura segura de solicitudes de laboratorio mediante **dos lectores multimodales independientes + juez de discrepancias + catálogo + safety gate determinista**.

## Principio

```text
imagen completa
   ├─> Gemini reader ─┐
   └─> OpenAI reader ─┤
                      ├─> consenso
             disputa ─┘
                 ↓
          juez premium
                 ↓
             catálogo
                 ↓
           safety gate
          ↙           ↘
     AUTO_SAFE   HUMAN_REVIEW
```

Los modelos **leen**. Ningún modelo autoriza AUTO por sí solo. El código determinista controla catálogo, incertidumbre y decisión final.

## Alcance inicial

- Sí: órdenes digitales/impresas y formularios no manuscritos.
- Sí: X, check, círculo, subrayado, tachado o rayón como evidencia visual que los modelos deben interpretar.
- No por ahora: solicitudes clínicas cuyo contenido depende de escritura manuscrita.
- No todavía: WhatsApp, Supabase, UI, CRM, pedidos, pagos o producción.

## Modelos iniciales

Configurables por `.env`:

- Reader A: `gemini-4-argon`
- Reader B: `gpt-6.1-sol`
- Judge (solo discrepancias): `gpt-6-astra`

No están hardcodeados como decisión permanente. El benchmark decidirá si se mantienen.

## Estructura deliberadamente pequeña

```text
src/
  types.ts       contratos del dominio
  ai.ts          readers + judge
  consensus.ts   comparación de lecturas
  catalog.ts     resolución determinista
  safety.ts      fail-closed
  pipeline.ts    orquestación
  index.ts
scripts/
  benchmark.ts
tests/
  core.test.ts
private-data/    ignorado por Git
```

No se migran los experimentos V5 descartados ni sus flags.

## Seguridad

AUTO_SAFE requiere, como mínimo:

1. documento soportado y visible completo;
2. cero incertidumbre visual;
3. toda disputa entre readers resuelta explícitamente;
4. todas las selecciones con certeza HIGH;
5. cada estudio resuelto de forma única en el catálogo;
6. ninguna regla/política pendiente.

Si algo falla: `HUMAN_REVIEW`.

Objetivo de producto: `WRONG_AUTO = 0`.

## Privacidad

Nunca commitear imágenes de pacientes, nombres, teléfonos, OCR clínico ni datasets privados. `private-data/` y `benchmark-private/` están ignorados.

## Arranque

```bash
cp .env.example .env
npm install
npm run check
```

Luego se migrará **solo** el catálogo/resolver/policies probados del repo anterior y se ejecutará el benchmark offline antes de integrar WhatsApp o persistencia.

## Orden de trabajo

1. Verificar que el scaffold compila/tests.
2. Migrar catálogo + reglas seguras desde PlusMedik actual.
3. Conectar benchmark privado existente.
4. Ejecutar Reader A + Reader B + Judge sobre los casos consumidos.
5. Medir `EXACT_DOCUMENT`, `AUTO_SAFE`, `WRONG_AUTO`, falsos y omitidos.
6. Solo si el resultado justifica la arquitectura, integrar el flujo real.

No se reescribe WhatsApp ni infraestructura antes de demostrar el core.
