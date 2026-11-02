// Tipos y códigos cerrados del procesamiento de audios (notas de voz de WhatsApp). Nada aquí lleva texto del paciente: solo códigos.

// Por qué un audio no se pudo usar. Son códigos cerrados (se registran): nunca el texto de un error.
export const AUDIO_FAILURE_CODES = [
  "INVALID_AUDIO", // no es un audio (bytes que no corresponden a ningún formato de audio) o está vacío/truncado
  "UNSUPPORTED_FORMAT", // es audio, pero de un formato que el transcriptor no admite y que aquí no se convierte (p. ej. AMR, AAC crudo)
  "TOO_LARGE", // más grande que el límite de bytes
  "TOO_LONG", // la transcripción es más larga de lo que se procesa entero (no se usa un trozo)
  "MEDIA_EXPIRED", // el enlace del medio venció o no se autoriza y no hay otra forma de bajarlo
  "MEDIA_UNAVAILABLE", // no se pudo descargar tras los reintentos
  "UNINTELLIGIBLE", // la transcripción no contiene palabras reconocibles
  "UNAVAILABLE", // el transcriptor no respondió o falló tras los reintentos
  "TOO_MANY" // más audios en el lote de los que se atienden
] as const;
export type AudioFailureCode = (typeof AUDIO_FAILURE_CODES)[number];

// Un error del procesamiento de un audio. `retryable`: repetir el mismo intento puede funcionar (red, 5xx, límite de tasa); lo demás es definitivo.
export class AudioFailure extends Error {
  constructor(readonly code: AudioFailureCode, readonly retryable = false) {
    super(`audio_${code.toLowerCase()}`);
    this.name = "AudioFailure";
  }
}

export type AudioFormat = "ogg" | "mp3" | "m4a" | "wav" | "webm" | "flac";

// Lo que el webhook sabe de un audio entrante (de Kapso). El medio se baja SOLO de `mediaUrl` (media_url o media_data.url de Kapso, nunca de Meta) o, si falta o venció, por `mediaId` con el SDK oficial.
export interface AudioRef {
  messageId: string;
  from: string;
  mediaUrl?: string;
  mediaId?: string;
}

export type ResolvedAudio = { ok: true; text: string } | { ok: false; code: AudioFailureCode };
