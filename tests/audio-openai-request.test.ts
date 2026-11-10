import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enforceOffline, releaseOfflineForTests } from "../src/offline.js";
import { downloadAudio, MIN_AUDIO_BYTES, sniffAudio, type MediaFetcher } from "../src/audio/media.js";
import { createOpenAiTranscriber, usesLanguagesField } from "../src/audio/transcribe.js";
import { buildOggOpus, oggCrc, parseOgg } from "./support/ogg-opus.js";

// La petición REAL a la API de transcripción de OpenAI, contra un servidor HTTP local (sin red externa): el multipart que sale por el cable, no el objeto FormData. Se comprueba nombre del archivo, tipo MIME,
// que los bytes lleguen idénticos y los campos del modelo. Y el archivo OGG/Opus de una nota de voz de WhatsApp: estructura válida, reconocimiento por bytes y rechazo de lo que no lo es.
// OJO: lo que NO se puede probar sin llamar a OpenAI es que su servicio acepte el OGG/Opus real: eso lo confirma scripts/audio-smoke.ts con un audio real antes de activar.

interface Part { name: string; filename?: string; contentType?: string; body: Buffer }
interface Captured { method?: string; url?: string; headers: IncomingHttpHeaders; parts: Part[]; raw: Buffer }

function parseMultipart(contentType: string, body: Buffer): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) throw new Error("sin boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const next = body.indexOf(delimiter, at + delimiter.length);
    if (next < 0) break;
    const chunk = body.subarray(at + delimiter.length + 2, next - 2); // sin el CRLF tras el delimitador ni el CRLF antes del siguiente
    const split = chunk.indexOf("\r\n\r\n");
    const head = chunk.subarray(0, split).toString("latin1");
    const disposition = /name="([^"]*)"(?:; filename="([^"]*)")?/.exec(head);
    parts.push({ name: disposition?.[1] ?? "", ...(disposition?.[2] !== undefined ? { filename: disposition[2] } : {}), ...(/content-type:\s*([^\r\n]+)/i.exec(head) ? { contentType: /content-type:\s*([^\r\n]+)/i.exec(head)![1]!.trim() } : {}), body: Buffer.from(chunk.subarray(split + 4)) });
    at = next;
  }
  return parts;
}

describe("OpenAI: la petición de transcripción por el cable", () => {
  let server: Server;
  let baseUrl = "";
  let status = 200;
  let answer: unknown = { text: "hola, quisiera un hemograma" };
  const calls: Captured[] = [];

  beforeAll(async () => {
    // Las pruebas bloquean la red real; aquí se habilita SOLO para hablar con el servidor local de este archivo (127.0.0.1) y se vuelve a bloquear al terminar.
    releaseOfflineForTests();
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks);
        calls.push({ method: request.method, url: request.url, headers: request.headers, parts: parseMultipart(String(request.headers["content-type"]), raw), raw });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    enforceOffline({ strict: false });
  });

  const partsOf = (call: Captured) => Object.fromEntries(call.parts.map((part) => [part.name, part]));

  it("gpt-transcribe: POST /audio/transcriptions multipart con el archivo `audio.ogg` (audio/ogg) y los bytes EXACTOS de la nota de voz, el modelo y response_format json; sin `language` ni `languages` ni temperatura", async () => {
    const ogg = buildOggOpus({ comment: "nota de voz" });
    calls.length = 0;
    const transcribe = createOpenAiTranscriber({ apiKey: "sk-prueba-123", model: "gpt-transcribe", language: "es", timeoutMs: 5000, baseUrl });
    await expect(transcribe({ bytes: ogg, format: sniffAudio(ogg) })).resolves.toBe("hola, quisiera un hemograma");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe("POST");
    expect(call!.url).toBe("/v1/audio/transcriptions");
    expect(call!.headers.authorization).toBe("Bearer sk-prueba-123");
    expect(String(call!.headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    const parts = partsOf(call!);
    expect(Object.keys(parts).sort()).toEqual(["file", "model", "response_format"]);
    expect(parts.file).toMatchObject({ filename: "audio.ogg", contentType: "audio/ogg" });
    expect(Buffer.compare(parts.file!.body, Buffer.from(ogg))).toBe(0);
    expect(parts.model!.body.toString()).toBe("gpt-transcribe");
    expect(parts.response_format!.body.toString()).toBe("json");
  });

  it("los modelos que usan `language` (whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe) lo reciben; gpt-transcribe y sus variantes no", async () => {
    const ogg = buildOggOpus();
    const run = async (model: string) => {
      calls.length = 0;
      await createOpenAiTranscriber({ apiKey: "k", model, language: "es", timeoutMs: 5000, baseUrl })({ bytes: ogg, format: "ogg" });
      return partsOf(calls[0]!);
    };
    for (const model of ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]) expect((await run(model)).language?.body.toString(), model).toBe("es");
    for (const model of ["gpt-transcribe", "GPT-Transcribe", "gpt-transcribe-2026-01-01"]) {
      const parts = await run(model);
      expect(parts.language, model).toBeUndefined();
      expect(parts.languages, model).toBeUndefined();
    }
    expect(usesLanguagesField("gpt-transcribe")).toBe(true);
    expect(usesLanguagesField("gpt-transcribe-mini")).toBe(true);
    expect(usesLanguagesField("gpt-4o-transcribe")).toBe(false);
    expect(usesLanguagesField("gpt-transcriber-x")).toBe(false);
  });

  it("cada formato admitido sale con SU extensión y SU tipo MIME", async () => {
    const samples: Array<[ReturnType<typeof sniffAudio>, string, string]> = [["ogg", "audio.ogg", "audio/ogg"], ["mp3", "audio.mp3", "audio/mpeg"], ["m4a", "audio.m4a", "audio/mp4"], ["wav", "audio.wav", "audio/wav"], ["webm", "audio.webm", "audio/webm"], ["flac", "audio.flac", "audio/flac"]];
    for (const [format, filename, mime] of samples) {
      calls.length = 0;
      await createOpenAiTranscriber({ apiKey: "k", model: "gpt-transcribe", timeoutMs: 5000, baseUrl })({ bytes: new Uint8Array(300), format });
      expect(partsOf(calls[0]!).file).toMatchObject({ filename, contentType: mime });
    }
  });

  it("no manda NADA más allá de lo previsto: ni el teléfono, ni el id del mensaje, ni la clave en el cuerpo", async () => {
    calls.length = 0;
    await createOpenAiTranscriber({ apiKey: "sk-secreta-999", model: "gpt-transcribe", timeoutMs: 5000, baseUrl })({ bytes: buildOggOpus(), format: "ogg" });
    expect(calls[0]!.raw.toString("latin1")).not.toContain("sk-secreta-999");
    expect(calls[0]!.parts.map((part) => part.name).sort()).toEqual(["file", "model", "response_format"]);
  });

  it("errores del servicio: 400 con un cuerpo que repite contenido NO se propaga; 5xx es reintentable", async () => {
    const ogg = buildOggOpus();
    status = 400;
    answer = { error: { message: "no se pudo leer TEXTO_SECRETO" } };
    const bad = await createOpenAiTranscriber({ apiKey: "k", model: "gpt-transcribe", timeoutMs: 5000, baseUrl })({ bytes: ogg, format: "ogg" }).catch((error) => error);
    expect(bad).toMatchObject({ code: "INVALID_AUDIO", retryable: false });
    expect(JSON.stringify(bad) + String(bad.message)).not.toContain("TEXTO_SECRETO");
    status = 503;
    expect(await createOpenAiTranscriber({ apiKey: "k", model: "gpt-transcribe", timeoutMs: 5000, baseUrl })({ bytes: ogg, format: "ogg" }).catch((error) => error)).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    status = 200;
    answer = { text: "hola, quisiera un hemograma" };
  });
});

describe("la nota de voz OGG/Opus de WhatsApp", () => {
  it("el archivo de prueba es un Ogg/Opus estructuralmente válido: 3 páginas, CRC correcto, OpusHead con marca de inicio, OpusTags y fin de flujo", () => {
    const ogg = buildOggOpus();
    const pages = parseOgg(ogg);
    expect(pages.map((page) => page.sequence)).toEqual([0, 1, 2]);
    expect(pages.map((page) => page.headerType)).toEqual([0x02, 0x00, 0x04]);
    expect(Buffer.from(pages[0]!.firstPacket).toString("latin1").startsWith("OpusHead")).toBe(true);
    expect(Buffer.from(pages[1]!.firstPacket).toString("latin1").startsWith("OpusTags")).toBe(true);
    expect(pages[2]!.granule).toBe(960 * 40);
    expect(ogg.byteLength).toBeGreaterThanOrEqual(MIN_AUDIO_BYTES);
    // el CRC de verdad protege: un byte cambiado lo rompe
    const broken = Uint8Array.from(ogg);
    broken[60] = broken[60]! ^ 0xff;
    expect(() => parseOgg(broken)).toThrow(/CRC/);
    expect(oggCrc(new Uint8Array(0))).toBe(0);
  });

  it("se reconoce por sus bytes como ogg (sin mirar el tipo declarado) y pasa tal cual por la descarga", async () => {
    const ogg = buildOggOpus({ comment: "wa" });
    expect(sniffAudio(ogg)).toBe("ogg");
    const fetcher: MediaFetcher = {
      rawFetch: async () => new Response(ogg, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(ogg.byteLength) } }),
      authedFetch: async () => { throw new Error("no"); },
      sdkDownload: async () => { throw new Error("no"); }
    };
    const got = await downloadAudio(fetcher, { mediaUrl: "https://media.kapso.ai/voice.ogg" }, { maxBytes: 5_000_000, timeoutMs: 5000 });
    expect(Buffer.compare(Buffer.from(got.bytes), Buffer.from(ogg))).toBe(0);
    expect(sniffAudio(got.bytes)).toBe("ogg");
  });

  it("un «OggS» que no es una página válida de audio se rechaza: sin marca de inicio, versión distinta, sin segmentos o con un códec que no es de audio", () => {
    const base = buildOggOpus();
    const mutate = (change: (copy: Uint8Array) => void) => {
      const copy = Uint8Array.from(base);
      change(copy);
      return copy;
    };
    for (const [name, bytes] of [
      ["sin marca de inicio de flujo", mutate((copy) => { copy[5] = 0x00; })],
      ["versión de Ogg distinta de 0", mutate((copy) => { copy[4] = 1; })],
      ["sin segmentos", mutate((copy) => { copy[26] = 0; })],
      ["primer paquete que no es un códec de audio", mutate((copy) => { copy.set([...Buffer.from("NotAudio")], 28); })]
    ] as const) expect(() => sniffAudio(bytes), name).toThrowError(expect.objectContaining({ code: "INVALID_AUDIO", retryable: false }));
    // un archivo cortado: demasiado pequeño para ser una nota de voz
    expect(() => sniffAudio(base.slice(0, 60))).toThrowError(expect.objectContaining({ code: "INVALID_AUDIO" }));
  });

  it("Vorbis y FLAC dentro de Ogg también son audio; Speex/Theora u otra cosa no", () => {
    const withCodec = (header: number[]) => {
      const copy = Uint8Array.from(buildOggOpus());
      copy.set(header, 28);
      return copy;
    };
    expect(sniffAudio(withCodec([0x01, ...Buffer.from("vorbis")]))).toBe("ogg");
    expect(sniffAudio(withCodec([0x7f, ...Buffer.from("FLAC")]))).toBe("ogg");
    expect(() => sniffAudio(withCodec([0x80, ...Buffer.from("theora")]))).toThrowError(expect.objectContaining({ code: "INVALID_AUDIO" }));
  });
});
