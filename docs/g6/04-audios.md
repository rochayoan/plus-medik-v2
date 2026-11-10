# G6.4 · Audios (notas de voz de WhatsApp)

Estado: implementado y probado. **Apagado por defecto** (`PLUSMEDIK_AUDIO`). No usa cola, base de datos, cron ni migraciones.

## Idea

Un audio es un mensaje más: el paciente lo envía, el código lo **transcribe** y la transcripción entra al agente como un texto del paciente, en el lugar donde llegó el audio dentro del lote. Todo lo demás sigue igual (seguridad médica, atención humana, estudios y precios validados contra el catálogo en Supabase, una sola respuesta por lote).

```
Kapso (lote) ─► webhook: firma ─► extrae audios ENTRANTES ─► 200 de inmediato
                                         │
                                         ▼  (de fondo, como un texto o una foto)
            reclama el turno (deduplicación) ─► baja el audio ─► valida el formato ─► OpenAI ─► texto
                                         │
                                         ▼
          el texto reemplaza al audio EN SU LUGAR del lote ─► flujo normal ─► UNA respuesta
```

## Reglas

- **Firma.** `X-Webhook-Signature` se verifica sobre el cuerpo original antes de procesar nada (sin cambios: ya era así).
- **Qué se recorre.** `payload.batch ? payload.data : [payload]`; solo audios **entrantes** y recientes (los salientes, los viejos y los eventos que no son «mensaje recibido» se descartan, como con los textos).
- **De dónde se baja.** Solo de `message.kapso.media_url ?? message.kapso.media_data.url`. **Nunca** de un enlace de Meta (`audio.link`, `audio.url`, `facebook.com`, `fbsbx.com`, `whatsapp.net`…), ni de `http`, ni de hosts internos. Si el enlace falta, es inseguro o venció (401/403/404/410), se baja por `audio.id` con el SDK oficial de Kapso. La credencial de Kapso solo viaja a servidores `*.kapso.ai`.
- **Tamaño.** Máximo 5 MB por defecto (`PLUSMEDIK_AUDIO_MAX_BYTES`), comprobado antes y durante la lectura. Una descarga más corta que lo declarado se reintenta; nunca se transcribe un audio truncado.
- **Formato.** Se decide por los **bytes**, no por el tipo declarado. Un OGG se acepta solo si es una página Ogg de verdad (versión 0, inicio de flujo y primer paquete `OpusHead`, o Vorbis / FLAC). OGG/Opus (la nota de voz de WhatsApp), MP3, M4A/MP4, WAV, WebM y FLAC se envían tal cual, con extensión y tipo MIME acordes (`audio.ogg` / `audio/ogg`) y los bytes exactos recibidos. **No se convierte nada** (Vercel no trae ffmpeg). AMR y AAC crudo no los admite el transcriptor: aviso al paciente. Lo que no es audio (una página de error, un JSON, una imagen) se rechaza sin llamar a OpenAI.
- **Transcripción.** API de audio de OpenAI (`POST /v1/audio/transcriptions`, multipart: `file`, `model`, `response_format=json`). Modelo **configurable y obligatorio** (`OPENAI_TRANSCRIPTION_MODEL`, sin valor por defecto; el que OpenAI recomienda hoy es `gpt-transcribe`). Con `gpt-transcribe` no se manda `language` ni `languages` (OpenAI pide no mandar los dos); con `whisper-1`, `gpt-4o-transcribe` y `gpt-4o-mini-transcribe` sí se manda `language` (`es` por defecto). No se usa la transcripción automática de Kapso. La salida es dato no confiable: una transcripción sin palabras reconocibles, o demasiado larga para procesarse **entera**, se rechaza (jamás se usa un trozo ni se completa nada).
- **Reintentos.** Hasta 3 intentos por audio (descarga + transcripción) dentro del mismo procesamiento, con un plazo total de 150 s (la función dura hasta 300 s). Los errores definitivos (formato inválido, no admitido, sin palabras, demasiado grande) no se reintentan.
- **Orden y una sola respuesta.** El contacto no se atiende hasta que **todos** sus audios estén escuchados. La transcripción reemplaza al audio en la misma posición, así texto, audio y foto conservan el orden en que se escribieron. Con `PLUSMEDIK_BATCH_ENGINE=on` sale una cotización única; sin él, la ruta de siempre.
- **Si un audio no se puede escuchar** (inválido, vencido, ilegible, demasiado largo, falla de OpenAI tras los reintentos o más audios de los que se atienden por lote), el paciente recibe un aviso fijo (sin cifras ni promesas) y la solicitud queda marcada como «ilegible», igual que una foto ilegible: «listo» no cotiza como si el audio no existiera. Nunca se inventa contenido.
- **Se conserva** la deduplicación (el turno se reclama antes de transcribir, así un mensaje repetido nunca se transcribe dos veces), la pausa por atención humana, el tope diario (un audio se reclama como `TEXT`), la guarda de respuestas, la auditoría y la privacidad: nunca se registra el audio, la transcripción, el enlace, el id del mensaje ni el teléfono sin enmascarar; solo códigos.

## Qué NO hay (a propósito)

- **Sin cola ni tablas.** El audio no se guarda en ningún lado; la transcripción vive en memoria hasta que el turno responde.
- **Sin migración.** No hay nada que aplicar en Supabase.
- **Sin cron, sin ruta de reproceso, sin flujo de GitHub Actions.**

Consecuencia aceptada: si la ejecución se interrumpe a mitad de una transcripción (se excede el máximo de 300 s o la función cae), ese audio queda sin respuesta, **igual que hoy le pasaría a un texto o a una foto**; el paciente puede reenviarlo. Kapso no reintenta porque ya recibió el 200 (política de ACK de siempre, documentada en `src/kapso-webhook.ts`).

## Configuración (Production)

| Variable | Obligatoria | Qué es |
| --- | --- | --- |
| `PLUSMEDIK_AUDIO` | sí, `on` | Enciende los audios. Solo tiene efecto con `PLUSMEDIK_TURNS=on` y `PLUSMEDIK_TEXT_HANDLER=on`. |
| `OPENAI_API_KEY` | sí | La misma clave del resto del agente. |
| `OPENAI_TRANSCRIPTION_MODEL` | sí | Modelo de transcripción (decisión del dueño; sin valor por defecto). |
| `PLUSMEDIK_AUDIO_LANGUAGE` | no | ISO-639-1, por defecto `es`. |
| `PLUSMEDIK_AUDIO_MAX_BYTES` | no | 102400–26214400, por defecto 5242880. |
| `PLUSMEDIK_AUDIO_TIMEOUT_MS` | no | 10000–120000, por defecto 60000 (una llamada de transcripción). |
| `PLUSMEDIK_AUDIO_MAX_PER_BATCH` | no | 1–10, por defecto 5. |

Una configuración incompleta o inválida deja los audios **apagados** y registra solo un código (`audio_config_invalid`). Recomendado también: sesiones de cotización, guarda de respuestas, tope diario y `PLUSMEDIK_BATCH_ENGINE=on`.

## Antes de activar

1. **Prueba de humo con una nota de voz real** y el modelo elegido: `OPENAI_API_KEY=… OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe npx tsx scripts/audio-smoke.ts nota-de-voz.ogg` debe mostrar `format: ogg` y `transcription: OK` (una llamada de pago; `--dry-run` no llama). La guía de OpenAI lista los formatos sin `ogg`, pero la referencia de la API sí lo incluye; solo una nota real lo confirma. Si OpenAI la rechazara (HTTP 400) **no se debe activar**: habría que remuxar a WebM/M4A, y eso no está implementado.
2. Ver en los registros de arranque `audio_scope {"enabled":true}` y, con tráfico, `audio_turn {"outcome":"TRANSCRIBED"}`.
3. Para volver atrás basta quitar `PLUSMEDIK_AUDIO` y volver a desplegar.

## Riesgos

- **Compatibilidad de OGG con el modelo elegido:** sin confirmar hasta la prueba de humo real.
- **Exactitud de la voz.** Un modelo de voz puede oír mal o inventar texto sobre silencio. Nada de lo transcrito define estudios ni precios (el catálogo valida los estudios, lo ambiguo se pregunta y el precio sale de Supabase). Un ruido transcrito exactamente como «listo», «sí» o «cancelar» actuaría como esa palabra escrita (riesgo bajo).
- **Costo.** Cada audio es una llamada de pago, acotada por tamaño (5 MB), por lote (5) y por 3 intentos. No hay tope de transcripciones por contacto.
- **Ruta heredada en lotes mixtos.** Con `PLUSMEDIK_BATCH_ENGINE` apagado, un lote de texto, audio y foto puede responder solo con el acuse de la foto (la transcripción sí queda anotada en la solicitud). Con el motor encendido sale una cotización única.
- **Interrupción de la ejecución:** el audio queda sin respuesta (ver arriba).
