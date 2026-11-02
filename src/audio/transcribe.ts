import { assertModelCallsAllowed } from "../offline.js";
import { formatInfo } from "./media.js";
import { AudioFailure, type AudioFormat } from "./types.js";

// Transcripción con OpenAI (API de audio), SIN depender de la transcripción automática de Kapso. La salida es DATO NO CONFIABLE: nunca define estudios ni precios; entra al agente como texto escrito por el
// paciente y pasa por las mismas validaciones contra el catálogo. Una transcripción vacía, sin palabras o demasiado larga para procesarse ENTERA se rechaza: jamás se usa un trozo ni se completa nada.

export const MAX_TRANSCRIPT_CHARS = 4000;

export type Transcriber = (audio: { bytes: Uint8Array; format: AudioFormat }) => Promise<string>;

// Texto -> transcripción válida. Lanza UNINTELLIGIBLE (sin palabras), TOO_LONG (no cabe entera) o UNAVAILABLE (respuesta que no es lo esperado).
export function validateTranscript(raw: unknown): string {
  if (typeof raw !== "string") throw new AudioFailure("UNAVAILABLE", true);
  const text = raw.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if ((text.match(/\p{L}/gu) ?? []).length < 2) throw new AudioFailure("UNINTELLIGIBLE");
  if (text.length > MAX_TRANSCRIPT_CHARS) throw new AudioFailure("TOO_LONG");
  return text;
}

// `gpt-transcribe` (el modelo recomendado por OpenAI) sustituye el campo `language` por `languages` y pide NO mandar los dos. La codificación de `languages` en multipart no está documentada, así que con ese
// modelo no se manda ninguno de los dos: él detecta el idioma (y lo informa en su respuesta). Los demás modelos (whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe) sí reciben `language`.
export const usesLanguagesField = (model: string): boolean => /^gpt-transcribe($|[-_.])/i.test(model.trim());

export interface OpenAiTranscriberOptions {
  apiKey: string;
  // Obligatorio (sin valor por defecto: elegirlo es una decisión del dueño).
  model: string;
  // Idioma esperado (ISO-639-1), p. ej. "es". Ayuda a la exactitud; no obliga. No se manda con gpt-transcribe (ver arriba).
  language?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

export function createOpenAiTranscriber(options: OpenAiTranscriberOptions): Transcriber {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return async ({ bytes, format }) => {
    // Modo offline: ninguna llamada a modelos sale.
    assertModelCallsAllowed("audio_transcription", "openai", options.model);
    const info = formatInfo(format);
    const form = new FormData();
    // El archivo lleva nombre con extensión y tipo MIME acordes al formato (la referencia de OpenAI pide «enough format metadata»), y exactamente los bytes recibidos.
    form.append("file", new Blob([Buffer.from(bytes)], { type: info.mime }), `audio.${info.ext}`);
    form.append("model", options.model);
    // `json` es el formato por defecto y el único que aceptan todos los modelos; la temperatura por defecto de la API ya es 0.
    form.append("response_format", "json");
    if (options.language && !usesLanguagesField(options.model)) form.append("language", options.language);
    let response: Response;
    try {
      response = await (options.fetchFn ?? fetch)(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs)
      });
    } catch {
      // Tiempo agotado o red caída: se puede repetir.
      throw new AudioFailure("UNAVAILABLE", true);
    }
    if (!response.ok) {
      // Nunca se lee ni se propaga el cuerpo del error (podría eco del contenido).
      if (response.status === 413) throw new AudioFailure("TOO_LARGE");
      if (response.status === 400 || response.status === 415 || response.status === 422) throw new AudioFailure("INVALID_AUDIO");
      if (response.status === 401 || response.status === 403 || response.status === 404) throw new AudioFailure("UNAVAILABLE");
      throw new AudioFailure("UNAVAILABLE", true);
    }
    const body = (await response.json().catch(() => undefined)) as { text?: unknown } | undefined;
    return validateTranscript(body?.text);
  };
}
