import { downloadAudio, sniffAudio, type MediaFetcher } from "./media.js";
import type { Transcriber } from "./transcribe.js";
import { AudioFailure, type AudioFailureCode, type AudioRef, type ResolvedAudio } from "./types.js";

// Transcripción de audios (notas de voz de WhatsApp): baja el audio, valida el formato y lo transcribe con reintentos acotados. Es lo único que el resto del agente conoce de los audios.
// Sin cola ni base de datos: corre dentro del mismo procesamiento del turno (el webhook ya respondió 200 y el trabajo sigue de fondo, igual que con un texto o una foto). La deduplicación es la de
// siempre: el turno se reclama ANTES de llegar aquí, así que un mensaje repetido nunca se transcribe dos veces.
// Si algo falla devuelve un código de falla DEFINITIVO (el paciente recibe un aviso); nunca se inventa contenido.
// Nunca se registra el texto del mensaje, la transcripción ni el teléfono: solo códigos.

export interface AudioPipelineOptions {
  transcriber: Transcriber;
  fetcher: MediaFetcher;
  log(event: string, data: Record<string, unknown>): void;
  maxBytes?: number;
  downloadTimeoutMs?: number;
  // Intentos (descarga + transcripción) por audio y la espera entre ellos.
  attempts?: number;
  backoffMs?: readonly number[];
  // Plazo total para UN audio (debe quedar muy por debajo del tiempo de la función).
  deadlineMs?: number;
  // Audios que se atienden por contacto y lote; los demás reciben un aviso.
  maxPerBatch?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AudioPipeline {
  readonly maxPerBatch: number;
  private readonly o: Required<Pick<AudioPipelineOptions, "maxBytes" | "downloadTimeoutMs" | "attempts" | "deadlineMs">> & AudioPipelineOptions;

  constructor(options: AudioPipelineOptions) {
    this.o = { maxBytes: 5 * 1024 * 1024, downloadTimeoutMs: 20_000, attempts: 3, deadlineMs: 150_000, ...options };
    this.maxPerBatch = options.maxPerBatch ?? 5;
  }

  // Transcribe el audio de un turno YA reclamado.
  async resolve(ref: AudioRef): Promise<ResolvedAudio> {
    const sleep = this.o.sleep ?? realSleep;
    const now = this.o.now ?? Date.now;
    const deadline = now() + this.o.deadlineMs;
    const media = { mediaUrl: ref.mediaUrl, mediaId: ref.mediaId };
    let last: AudioFailure = new AudioFailure("UNAVAILABLE", true);
    for (let attempt = 1; attempt <= this.o.attempts; attempt++) {
      if (attempt > 1) {
        if (now() + 1000 >= deadline) break;
        await sleep(this.o.backoffMs?.[attempt - 2] ?? 1000 * attempt);
      }
      try {
        const downloaded = await downloadAudio(this.o.fetcher, media, { maxBytes: this.o.maxBytes, timeoutMs: this.o.downloadTimeoutMs });
        const format = sniffAudio(downloaded.bytes);
        const text = await this.o.transcriber({ bytes: downloaded.bytes, format });
        this.o.log("audio_job", { event: "transcribed", attempt });
        return { ok: true, text };
      } catch (error) {
        last = error instanceof AudioFailure ? error : new AudioFailure("UNAVAILABLE", true);
        if (!last.retryable) break;
        this.o.log("audio_job", { event: "retry", code: last.code, attempt, ...(last.cause ?? {}) });
      }
    }
    const code: AudioFailureCode = last.retryable ? "UNAVAILABLE" : last.code;
    this.o.log("audio_job", { event: "failed", code, ...(last.cause ?? {}) });
    return { ok: false, code };
  }
}
