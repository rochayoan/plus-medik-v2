import type { MediaFetcher } from "./media.js";
import { AudioPipeline } from "./service.js";
import { createOpenAiTranscriber } from "./transcribe.js";

// Arma la transcripción de audios a partir del entorno. APAGADO por defecto: nada de esto existe a menos que el que despliega lo encienda Y lo configure completo.
//   PLUSMEDIK_AUDIO=on                 lo enciende (solo tiene efecto con turnos y manejador de texto; ver api/kapso/webhook.ts). No necesita migraciones.
//   OPENAI_API_KEY                     la misma clave del resto del agente
//   OPENAI_TRANSCRIPTION_MODEL         modelo de transcripción; OBLIGATORIO (sin valor por defecto: elegirlo es una decisión del dueño)
//   PLUSMEDIK_AUDIO_LANGUAGE           opcional: idioma esperado ISO-639-1 de 2 letras (por defecto «es»)
//   PLUSMEDIK_AUDIO_MAX_BYTES          opcional: 102400–26214400 (por defecto 5242880 = 5 MB; una nota de voz de WhatsApp de varios minutos pesa unos cientos de KB)
//   PLUSMEDIK_AUDIO_TIMEOUT_MS         opcional: 10000–120000 (por defecto 60000): plazo de UNA llamada de transcripción
//   PLUSMEDIK_AUDIO_MAX_PER_BATCH      opcional: 1–10 (por defecto 5): audios que se atienden por contacto y lote
// Un valor faltante o inválido deja los audios APAGADOS (se siguen ignorando como hasta ahora) y se registra solo un código, nunca el valor.

export type AudioConfigError = "MISSING_API_KEY" | "MISSING_MODEL" | "INVALID_LANGUAGE" | "INVALID_MAX_BYTES" | "INVALID_TIMEOUT" | "INVALID_MAX_PER_BATCH";

const integerIn = (value: string | undefined, min: number, max: number): number | undefined | "INVALID" => {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{1,9}$/.test(value.trim())) return "INVALID";
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : "INVALID";
};

export interface AudioRuntime {
  fetcher: MediaFetcher;
  // Solo pruebas.
  fetchFn?: typeof fetch;
}

export function resolveAudio(env: Record<string, string | undefined>, log: (event: string, data: Record<string, unknown>) => void, runtime: AudioRuntime): AudioPipeline | undefined {
  if (env.PLUSMEDIK_AUDIO?.trim().toLowerCase() !== "on") return undefined;
  const fail = (error: AudioConfigError) => {
    log("audio_config_invalid", { error });
    return undefined;
  };
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_TRANSCRIPTION_MODEL?.trim();
  if (!apiKey) return fail("MISSING_API_KEY");
  if (!model) return fail("MISSING_MODEL");
  const language = env.PLUSMEDIK_AUDIO_LANGUAGE?.trim().toLowerCase() || "es";
  if (!/^[a-z]{2}$/.test(language)) return fail("INVALID_LANGUAGE");
  const maxBytes = integerIn(env.PLUSMEDIK_AUDIO_MAX_BYTES, 102_400, 26_214_400);
  if (maxBytes === "INVALID") return fail("INVALID_MAX_BYTES");
  const timeoutMs = integerIn(env.PLUSMEDIK_AUDIO_TIMEOUT_MS, 10_000, 120_000);
  if (timeoutMs === "INVALID") return fail("INVALID_TIMEOUT");
  const maxPerBatch = integerIn(env.PLUSMEDIK_AUDIO_MAX_PER_BATCH, 1, 10);
  if (maxPerBatch === "INVALID") return fail("INVALID_MAX_PER_BATCH");
  return new AudioPipeline({
    transcriber: createOpenAiTranscriber({ apiKey, model, language, timeoutMs: timeoutMs ?? 60_000, ...(runtime.fetchFn ? { fetchFn: runtime.fetchFn } : {}) }),
    fetcher: runtime.fetcher,
    log,
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxPerBatch !== undefined ? { maxPerBatch } : {})
  });
}
