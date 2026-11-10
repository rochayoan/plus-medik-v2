import { AudioFailure, type AudioFormat } from "./types.js";

// Validación y descarga del medio de un audio. Reglas:
//  · Se baja SOLO del enlace que Kapso entrega (`kapso.media_url` o `kapso.media_data.url`), nunca de un enlace de Meta. Si el enlace falta, no es seguro o venció, se baja por el id del medio con el SDK oficial.
//  · La credencial de Kapso solo se envía a un servidor de Kapso (nunca a un host arbitrario del payload).
//  · El tamaño se acota ANTES y DURANTE la lectura; una descarga más corta que lo declarado es incompleta (se reintenta, no se transcribe a medias).
//  · El formato se decide por los BYTES (firma del archivo), no por el tipo MIME declarado. OpenAI admite OGG/Opus directamente: no se convierte nada (el entorno de Vercel no trae ffmpeg).

// ───────────────────────────── formato ─────────────────────────────

export const MIN_AUDIO_BYTES = 128;

const FORMATS: Record<AudioFormat, { mime: string; ext: string }> = {
  ogg: { mime: "audio/ogg", ext: "ogg" },
  mp3: { mime: "audio/mpeg", ext: "mp3" },
  m4a: { mime: "audio/mp4", ext: "m4a" },
  wav: { mime: "audio/wav", ext: "wav" },
  webm: { mime: "audio/webm", ext: "webm" },
  flac: { mime: "audio/flac", ext: "flac" }
};
export const formatInfo = (format: AudioFormat) => FORMATS[format];

const ascii = (bytes: Uint8Array, from: number, text: string): boolean => text.length + from <= bytes.length && [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0));

// Reconoce el formato por su firma. Devuelve el formato admitido o lanza AudioFailure: AMR y AAC crudo (ADTS) son audios que WhatsApp puede mandar y que el transcriptor NO admite (y aquí no se convierten);
// cualquier otra cosa no es un audio.
export function sniffAudio(bytes: Uint8Array): AudioFormat {
  if (bytes.length === 0) throw new AudioFailure("INVALID_AUDIO");
  if (ascii(bytes, 0, "#!AMR")) throw new AudioFailure("UNSUPPORTED_FORMAT");
  if (bytes.length < MIN_AUDIO_BYTES) throw new AudioFailure("INVALID_AUDIO");
  if (ascii(bytes, 0, "OggS")) {
    // Una página Ogg de verdad: versión 0, marca de inicio de flujo y, como primer paquete, la cabecera de un códec de audio (Opus en las notas de voz de WhatsApp; Vorbis y FLAC también son audio).
    const segments = bytes[26] ?? 0;
    const start = 27 + segments;
    const codec = ascii(bytes, start, "OpusHead") || ascii(bytes, start, "\x01vorbis") || ascii(bytes, start, "\x7fFLAC");
    if (bytes[4] !== 0 || ((bytes[5] ?? 0) & 0x02) === 0 || segments === 0 || !codec) throw new AudioFailure("INVALID_AUDIO");
    return "ogg";
  }
  if (ascii(bytes, 0, "fLaC")) return "flac";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "wav";
  if (ascii(bytes, 4, "ftyp")) return "m4a";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  if (ascii(bytes, 0, "ID3")) return "mp3";
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    const layer = (bytes[1]! >> 1) & 0x3;
    if (layer === 0) throw new AudioFailure("UNSUPPORTED_FORMAT"); // AAC crudo (ADTS)
    return "mp3";
  }
  throw new AudioFailure("INVALID_AUDIO");
}

// ───────────────────────────── enlaces ─────────────────────────────

const META_HOSTS = ["facebook.com", "fbsbx.com", "fbcdn.net", "whatsapp.net", "whatsapp.com", "meta.com", "instagram.com"];
const hostMatches = (host: string, domains: readonly string[]) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

export function parseMediaUrl(value: string | undefined): URL | undefined {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4000) return undefined;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host) && PRIVATE_HOST.test(host) || PRIVATE_HOST.test(host)) return undefined;
    if (hostMatches(host, META_HOSTS)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
export const isKapsoHost = (url: URL): boolean => hostMatches(url.hostname.toLowerCase(), ["kapso.ai"]);

// ───────────────────────────── descarga ─────────────────────────────

export interface MediaFetcher {
  // Sin credenciales.
  rawFetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  // Con la credencial de Kapso (solo se usa contra servidores de Kapso).
  authedFetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  // SDK oficial de Kapso: descarga por id de medio.
  sdkDownload(mediaId: string): Promise<ArrayBuffer>;
}

export interface DownloadedAudio {
  bytes: Uint8Array;
  contentType?: string;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  const known = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  if (known !== undefined && known > maxBytes) throw new AudioFailure("TOO_LARGE");
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AudioFailure("TOO_LARGE");
      }
      chunks.push(value);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    total = buffer.byteLength;
    if (total > maxBytes) throw new AudioFailure("TOO_LARGE");
    chunks.push(buffer);
  }
  // Menos de lo que el servidor declaró: la descarga se cortó. Se reintenta; nunca se transcribe un audio truncado.
  if (known !== undefined && total < known) throw new AudioFailure("MEDIA_UNAVAILABLE", true);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const EXPIRED_STATUS = new Set([401, 403, 404, 410]);

// Descarga el audio: primero el enlace de Kapso (si es seguro) y, si falta, venció o falla, el id del medio con el SDK. Lanza AudioFailure con el código definitivo o reintentable.
export async function downloadAudio(fetcher: MediaFetcher, ref: { mediaUrl?: string; mediaId?: string }, limits: { maxBytes: number; timeoutMs: number }): Promise<DownloadedAudio> {
  const url = parseMediaUrl(ref.mediaUrl);
  let last: AudioFailure | undefined;
  if (url) {
    try {
      const signal = () => ({ signal: AbortSignal.timeout(limits.timeoutMs) });
      let response = await fetcher.rawFetch(url.toString(), signal());
      if ((response.status === 401 || response.status === 403) && isKapsoHost(url)) response = await fetcher.authedFetch(url.toString(), signal());
      if (response.ok) {
        const bytes = await readCapped(response, limits.maxBytes);
        return { bytes, ...(response.headers.get("content-type") ? { contentType: response.headers.get("content-type")! } : {}) };
      }
      last = new AudioFailure(EXPIRED_STATUS.has(response.status) ? "MEDIA_EXPIRED" : "MEDIA_UNAVAILABLE", !EXPIRED_STATUS.has(response.status) && response.status !== 400);
    } catch (error) {
      if (error instanceof AudioFailure && !error.retryable) throw error;
      last = error instanceof AudioFailure ? error : new AudioFailure("MEDIA_UNAVAILABLE", true);
    }
  }
  if (ref.mediaId) {
    try {
      const buffer = await fetcher.sdkDownload(ref.mediaId);
      if (buffer.byteLength > limits.maxBytes) throw new AudioFailure("TOO_LARGE");
      return { bytes: new Uint8Array(buffer) };
    } catch (error) {
      if (error instanceof AudioFailure && !error.retryable) throw error;
      last = new AudioFailure("MEDIA_UNAVAILABLE", true);
    }
  }
  // Sin enlace seguro ni id: no hay de dónde bajarlo.
  throw last ?? new AudioFailure("MEDIA_EXPIRED");
}
