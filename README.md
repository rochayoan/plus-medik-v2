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

## Pipeline real (`analyzeImage`, `npm run analyze-image -- <imagen>`)

```text
imagen ─┬─> Gemini (OpenRouter) ─┐
        ├─> lector OpenAI ───────┼─> consenso ─> juez (solo disputas)
        └─> señal de documento ──┘            │
            (tipo, integridad, contexto)       ↓
                                  catálogo de Supabase (solo lectura)
                                  matcher exacto/alias  +  GPT-6.1 Sol (opcional, ver banderas)
                                               ↓
                                 safety fail-closed ─> AUTO_SAFE | HUMAN_REVIEW
```

- **Señal de documento:** dos lecturas independientes del tipo (impreso, formulario con marcas, manuscrito...) y de la integridad de la zona de estudios. Una zona que solo se *acerca* a un borde se verifica con dos lecturas enfocadas; cortes, objetos que tapan y trazos ilegibles siempre bloquean. También extrae el contexto impreso (título, muestra declarada).
- **Consenso:** una misma selección visual transcrita distinto (espaciado, plural, texto truncado) cuenta una sola vez; una lectura truncada nunca produce coincidencia por sí sola.
- **Cotización:** una línea por UUID de `lab_tests`, con el precio siempre de Supabase (tarifa Paciente). Los modelos nunca deciden códigos ni precios.
- **Decisión:** cualquier ambigüedad, estudio ausente, perfil sin composición aprobada, documento incompleto o manuscrito => `HUMAN_REVIEW`. Con las banderas apagadas (por defecto), AUTO solo es posible por coincidencia exacta/alias.

### Banderas semánticas (apagadas por defecto)

| Variable | Efecto |
| --- | --- |
| `CATALOG_SEMANTIC_PRIMARY=on` | GPT resuelve todos los estudios contra el catálogo activo completo (dos pasadas independientes + verificador determinístico + contexto del documento) y se contrasta con el matcher exacto. Los resultados quedan como *candidatos*: la decisión sigue en `HUMAN_REVIEW`. |
| `CATALOG_SEMANTIC_AUTO=on` | Además, los MATCH semánticos verificados y los compuestos explícitos (p. ej. GOT/GPT) pueden entrar a una cotización `AUTO_SAFE`. Solo tiene efecto con `PRIMARY=on`. **No activar para usuarios reales sin autorización expresa.** |
| `CATALOG_HANDWRITTEN_AUTO=shadow` | Solo **simula**: para un pedido manuscrito legible informa en `handwrittenShadow` si sería AUTO (documento verificado completo, dos lecturas idénticas sin juez, certeza alta, mismas variantes y matching semántico verificado). **Nunca cambia la decisión real**: el manuscrito sigue en `HUMAN_REVIEW`. Requiere `PRIMARY=on`. |

Las dos primeras solo se encienden con el valor exacto `on`; la de manuscritos solo reconoce `shadow`. Para una prueba local puntual: `CATALOG_SEMANTIC_PRIMARY=on CATALOG_SEMANTIC_AUTO=on npm run analyze-image -- private-data/<imagen>`.

### Cache y control de gasto

- Toda llamada a un modelo pasa por un cache local (`.cache/ai`, ignorado por Git; `AI_CACHE=on|off|refresh`) y queda registrada en `.cache/usage.jsonl`.
- `npx tsx scripts/spend.ts init` fija el presupuesto, `npx tsx scripts/spend.ts` informa el gasto nuevo y `npx tsx scripts/spend.ts estimate` estima costos por etapa.
- Los scripts de validación que pueden gastar (`shadow-match`, `benchmark-catalog`, `semantic-primary-check`, `semantic-auto-check`, `context-check`) **bloquean toda llamada real** salvo que se autorice un máximo por corrida: `PLUSMEDIK_AUTHORIZE_PAID_CALLS=0.15 npx tsx scripts/context-check.ts ...`. Las respuestas ya cacheadas no necesitan autorización.
- `src/pipeline.ts` y `src/safety.ts` son el core original (`PlusMedikCore`), conservado y cubierto por tests; el flujo real es `src/analyze.ts`.

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
