import { describe, expect, it, vi } from "vitest";
import { AUDIO_TEXTS, assertSafeAudioTexts, failureTextKey } from "../src/audio-turns.js";
import { resolveAudio } from "../src/audio/config.js";
import { downloadAudio, isKapsoHost, parseMediaUrl, sniffAudio, type MediaFetcher } from "../src/audio/media.js";
import { AudioPipeline } from "../src/audio/service.js";
import { createOpenAiTranscriber, MAX_TRANSCRIPT_CHARS, validateTranscript } from "../src/audio/transcribe.js";
import { AUDIO_FAILURE_CODES, AudioFailure } from "../src/audio/types.js";
import { extractIncomingTurns } from "../src/turns.js";
import { buildOggOpus, oggCrc, parseOgg } from "./support/ogg-opus.js";

// Procesamiento de audios (Fase 5), piezas aisladas: formato por firma, enlaces, descarga, transcripción de OpenAI, validación de la transcripción, el servicio (descarga -> valida -> transcribe, sin cola ni
// base de datos) y la lectura del payload de Kapso. El flujo completo con el webhook y la base real está en audio-e2e.test.ts.

const bytesOf = (head: number[] | string, length = 400): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(length);
  const prefix = typeof head === "string" ? [...head].map((char) => char.charCodeAt(0)) : head;
  out.set(prefix);
  return out;
};
const OGG = () => buildOggOpus();

describe("formato del audio: se decide por los BYTES, no por el tipo declarado", () => {
  it("reconoce OGG/Opus (nota de voz de WhatsApp) y los demás formatos que OpenAI admite", () => {
    expect(sniffAudio(OGG())).toBe("ogg");
    expect(sniffAudio(bytesOf("fLaC"))).toBe("flac");
    expect(sniffAudio(bytesOf("ID3"))).toBe("mp3");
    expect(sniffAudio(bytesOf([0xff, 0xfb, 0x90]))).toBe("mp3");
    expect(sniffAudio(bytesOf([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    const wav = bytesOf("RIFF");
    wav.set([...("WAVE")].map((c) => c.charCodeAt(0)), 8);
    expect(sniffAudio(wav)).toBe("wav");
    const m4a = bytesOf([0, 0, 0, 0x20]);
    m4a.set([...("ftypM4A ")].map((c) => c.charCodeAt(0)), 4);
    expect(sniffAudio(m4a)).toBe("m4a");
  });

  it("AMR y AAC crudo son audios que el transcriptor NO admite y que aquí no se convierten: UNSUPPORTED_FORMAT (definitivo)", () => {
    for (const bytes of [bytesOf("#!AMR\n"), bytesOf([0xff, 0xf1, 0x50])]) {
      expect(() => sniffAudio(bytes)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_FORMAT", retryable: false }));
    }
  });

  it("lo que no es audio (HTML, JSON de error, vacío, diminuto, imagen) es INVALID_AUDIO, aunque se declare como audio", () => {
    for (const bytes of [new Uint8Array(0), bytesOf("<html><body>expired</body></html>"), bytesOf('{"error":"expired"}'), bytesOf([0xff, 0xd8, 0xff, 0xe0]), OGG().slice(0, 40)]) {
      expect(() => sniffAudio(bytes)).toThrowError(expect.objectContaining({ code: "INVALID_AUDIO", retryable: false }));
    }
  });
});

describe("enlaces del medio: solo Kapso, nunca Meta, nunca algo interno", () => {
  it("acepta un enlace https de Kapso o de un almacenamiento público y rechaza Meta, http, credenciales incrustadas y hosts internos", () => {
    expect(parseMediaUrl("https://media.kapso.ai/a/b.ogg?sig=x")?.hostname).toBe("media.kapso.ai");
    expect(parseMediaUrl("https://storage.example.com/a.ogg")?.hostname).toBe("storage.example.com");
    for (const bad of [
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", "https://graph.facebook.com/v20.0/123", "https://mmg.whatsapp.net/v/t62/a.enc", "https://scontent.xx.fbcdn.net/a.ogg", "https://x.meta.com/a",
      "http://media.kapso.ai/a.ogg", "https://user:pass@media.kapso.ai/a.ogg", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.5/a", "https://192.168.1.1/a", "https://169.254.169.254/latest", "https://[::1]/a",
      "https://service.internal/a", "ftp://media.kapso.ai/a", "no es un enlace", "", undefined
    ]) expect(parseMediaUrl(bad), String(bad)).toBeUndefined();
    expect(isKapsoHost(new URL("https://media.kapso.ai/x"))).toBe(true);
    expect(isKapsoHost(new URL("https://kapso.ai.evil.com/x"))).toBe(false);
    expect(isKapsoHost(new URL("https://notkapso.ai/x"))).toBe(false);
  });
});

function fetcher(plan: { raw?: (url: string) => Response | Promise<Response>; authed?: (url: string) => Response | Promise<Response>; sdk?: (id: string) => ArrayBuffer | Promise<ArrayBuffer> } = {}) {
  const calls = { raw: [] as string[], authed: [] as string[], sdk: [] as string[] };
  const impl: MediaFetcher = {
    async rawFetch(url) {
      calls.raw.push(url);
      return plan.raw ? plan.raw(url) : new Response(OGG(), { status: 200 });
    },
    async authedFetch(url) {
      calls.authed.push(url);
      return plan.authed ? plan.authed(url) : new Response(OGG(), { status: 200 });
    },
    async sdkDownload(id) {
      calls.sdk.push(id);
      if (!plan.sdk) throw new Error("sin SDK");
      return plan.sdk(id);
    }
  };
  return { impl, calls };
}
const LIMITS = { maxBytes: 1000, timeoutMs: 5000 };
const URL_OK = "https://media.kapso.ai/a.ogg";

describe("descarga del audio", () => {
  it("baja del enlace de Kapso sin credenciales y devuelve los bytes y el tipo declarado", async () => {
    const f = fetcher({ raw: () => new Response(OGG(), { status: 200, headers: { "content-type": "audio/ogg" } }) });
    const got = await downloadAudio(f.impl, { mediaUrl: URL_OK, mediaId: "m1" }, LIMITS);
    expect(got.bytes.byteLength).toBe(OGG().byteLength);
    expect(got.contentType).toBe("audio/ogg");
    expect(f.calls).toEqual({ raw: [URL_OK], authed: [], sdk: [] });
  });

  it("401/403 de un servidor de KAPSO reintenta con la credencial de Kapso; de cualquier otro servidor NUNCA se envía la credencial", async () => {
    const kapso = fetcher({ raw: () => new Response("no", { status: 403 }), authed: () => new Response(OGG(), { status: 200 }) });
    await expect(downloadAudio(kapso.impl, { mediaUrl: URL_OK }, LIMITS)).resolves.toBeTruthy();
    expect(kapso.calls.authed).toEqual([URL_OK]);
    const other = fetcher({ raw: () => new Response("no", { status: 403 }) });
    await expect(downloadAudio(other.impl, { mediaUrl: "https://storage.example.com/a.ogg" }, LIMITS)).rejects.toMatchObject({ code: "MEDIA_EXPIRED", retryable: false });
    expect(other.calls.authed).toEqual([]);
  });

  it("enlace vencido (404/410/403) con id de medio: baja por el SDK oficial; sin id es MEDIA_EXPIRED definitivo", async () => {
    const withId = fetcher({ raw: () => new Response("gone", { status: 410 }), sdk: () => OGG().buffer as ArrayBuffer });
    const got = await downloadAudio(withId.impl, { mediaUrl: URL_OK, mediaId: "m1" }, LIMITS);
    expect(got.bytes.byteLength).toBe(OGG().byteLength);
    expect(withId.calls.sdk).toEqual(["m1"]);
    const withoutId = fetcher({ raw: () => new Response("gone", { status: 404 }) });
    await expect(downloadAudio(withoutId.impl, { mediaUrl: URL_OK }, LIMITS)).rejects.toMatchObject({ code: "MEDIA_EXPIRED", retryable: false });
  });

  it("un enlace de Meta o inseguro NO se usa jamás: se baja por el id con el SDK o no se baja", async () => {
    const meta = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1";
    const viaSdk = fetcher({ sdk: () => OGG().buffer as ArrayBuffer });
    await downloadAudio(viaSdk.impl, { mediaUrl: meta, mediaId: "m1" }, LIMITS);
    expect(viaSdk.calls.raw).toEqual([]);
    expect(viaSdk.calls.sdk).toEqual(["m1"]);
    const none = fetcher();
    await expect(downloadAudio(none.impl, { mediaUrl: meta }, LIMITS)).rejects.toMatchObject({ code: "MEDIA_EXPIRED" });
    expect(none.calls).toEqual({ raw: [], authed: [], sdk: [] });
    await expect(downloadAudio(none.impl, {}, LIMITS)).rejects.toMatchObject({ code: "MEDIA_EXPIRED" });
  });

  it("errores de red o 5xx son REINTENTABLES (y prueban el SDK si hay id); si todo falla, MEDIA_UNAVAILABLE", async () => {
    const down = fetcher({ raw: () => { throw new TypeError("fetch failed"); } });
    await expect(downloadAudio(down.impl, { mediaUrl: URL_OK }, LIMITS)).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: true });
    const server = fetcher({ raw: () => new Response("x", { status: 503 }), sdk: () => { throw new Error("sdk caído"); } });
    await expect(downloadAudio(server.impl, { mediaUrl: URL_OK, mediaId: "m1" }, LIMITS)).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: true });
    expect(server.calls.sdk).toEqual(["m1"]);
  });

  it("acota el tamaño ANTES y DURANTE la lectura (TOO_LARGE definitivo) y no acepta una descarga más corta que lo declarado", async () => {
    const declared = fetcher({ raw: () => new Response(OGG(), { status: 200, headers: { "content-length": "5000" } }) });
    await expect(downloadAudio(declared.impl, { mediaUrl: URL_OK }, LIMITS)).rejects.toMatchObject({ code: "TOO_LARGE", retryable: false });
    const streamed = fetcher({ raw: () => new Response(new Uint8Array(2000), { status: 200 }) });
    await expect(downloadAudio(streamed.impl, { mediaUrl: URL_OK }, LIMITS)).rejects.toMatchObject({ code: "TOO_LARGE" });
    const truncated = fetcher({ raw: () => new Response(OGG(), { status: 200, headers: { "content-length": "900" } }) });
    await expect(downloadAudio(truncated.impl, { mediaUrl: URL_OK }, LIMITS)).rejects.toMatchObject({ code: "MEDIA_UNAVAILABLE", retryable: true });
    const sdkBig = fetcher({ sdk: () => new ArrayBuffer(5000) });
    await expect(downloadAudio(sdkBig.impl, { mediaId: "m1" }, LIMITS)).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
});

describe("transcripción de OpenAI", () => {
  it("valida la transcripción: sin palabras es UNINTELLIGIBLE; demasiado larga NO se recorta (TOO_LONG); no-texto es UNAVAILABLE reintentable", () => {
    expect(validateTranscript("  Quiero   un hemograma\ncompleto.  ")).toBe("Quiero un hemograma completo.");
    for (const empty of ["", "   ", "...", "🙂", "1 2 3", "a"]) expect(() => validateTranscript(empty), JSON.stringify(empty)).toThrowError(expect.objectContaining({ code: "UNINTELLIGIBLE" }));
    expect(() => validateTranscript("a".repeat(MAX_TRANSCRIPT_CHARS + 1))).toThrowError(expect.objectContaining({ code: "TOO_LONG", retryable: false }));
    expect(validateTranscript("a".repeat(MAX_TRANSCRIPT_CHARS))).toHaveLength(MAX_TRANSCRIPT_CHARS);
    for (const bad of [undefined, null, 5, {}, ["x"]]) expect(() => validateTranscript(bad)).toThrowError(expect.objectContaining({ code: "UNAVAILABLE", retryable: true }));
  });

  it("llama a la API de audio de OpenAI con el modelo configurado, el archivo con su extensión, temperatura 0 y SIN transcripción de Kapso", async () => {
    const seen: { url?: string; headers?: Record<string, string>; form?: FormData } = {};
    const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.url = String(url);
      seen.headers = init?.headers as Record<string, string>;
      seen.form = init?.body as FormData;
      return new Response(JSON.stringify({ text: "Necesito glucosa en ayunas" }), { status: 200 });
    }) as unknown as typeof fetch;
    const transcribe = createOpenAiTranscriber({ apiKey: "sk-prueba", model: "modelo-de-prueba", language: "es", timeoutMs: 5000, fetchFn });
    await expect(transcribe({ bytes: OGG(), format: "ogg" })).resolves.toBe("Necesito glucosa en ayunas");
    expect(seen.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen.headers).toEqual({ Authorization: "Bearer sk-prueba" });
    expect(seen.form!.get("model")).toBe("modelo-de-prueba");
    expect(seen.form!.get("language")).toBe("es");
    // la temperatura por defecto de la API ya es 0: no se manda
    expect(seen.form!.get("temperature")).toBeNull();
    expect(seen.form!.get("response_format")).toBe("json");
    const file = seen.form!.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(OGG().byteLength);
  });

  it("clasifica los errores de OpenAI sin leer su cuerpo: 400/415/422 audio inválido, 413 grande, 401/403/404 no disponible (definitivo), 429/5xx/red reintentables", async () => {
    const run = async (status: number | "network") => {
      const fetchFn = (async () => {
        if (status === "network") throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ error: { message: "eco del contenido SECRETO" } }), { status });
      }) as unknown as typeof fetch;
      return createOpenAiTranscriber({ apiKey: "k", model: "m", timeoutMs: 1000, fetchFn })({ bytes: OGG(), format: "ogg" }).catch((error: AudioFailure) => error);
    };
    expect(await run(400)).toMatchObject({ code: "INVALID_AUDIO", retryable: false });
    expect(await run(415)).toMatchObject({ code: "INVALID_AUDIO", retryable: false });
    expect(await run(413)).toMatchObject({ code: "TOO_LARGE", retryable: false });
    for (const status of [401, 403, 404]) expect(await run(status)).toMatchObject({ code: "UNAVAILABLE", retryable: false });
    for (const status of [429, 500, 502, 503, "network" as const]) expect(await run(status)).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(JSON.stringify(await run(400))).not.toContain("SECRETO");
  });

  it("una respuesta sin texto o con texto vacío no se acepta ni se completa", async () => {
    const answer = (body: unknown) => createOpenAiTranscriber({ apiKey: "k", model: "m", timeoutMs: 1000, fetchFn: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch })({ bytes: OGG(), format: "ogg" }).catch((error: AudioFailure) => error);
    expect(await answer({})).toMatchObject({ code: "UNAVAILABLE" });
    expect(await answer({ text: "" })).toMatchObject({ code: "UNINTELLIGIBLE" });
    expect(await answer({ text: "   " })).toMatchObject({ code: "UNINTELLIGIBLE" });
  });
});

function pipeline(over: { transcriber?: ConstructorParameters<typeof AudioPipeline>[0]["transcriber"]; fetcher?: MediaFetcher; options?: Partial<ConstructorParameters<typeof AudioPipeline>[0]> } = {}) {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const service = new AudioPipeline({
    transcriber: over.transcriber ?? (async () => "quiero cotizar hemograma"),
    fetcher: over.fetcher ?? fetcher().impl,
    log: (event, data) => logs.push([event, data]),
    sleep: async () => undefined,
    ...over.options
  });
  return { service, logs };
}
const REF = { messageId: "wamid.A1", from: "59170000001", mediaUrl: URL_OK, mediaId: "m1" };

describe("transcripción de un audio (servicio; sin cola, sin base de datos)", () => {
  it("descarga, valida el formato, transcribe y devuelve el texto; el audio no se guarda en ningún lado", async () => {
    const transcriber = vi.fn(async (_input: { bytes: Uint8Array; format: string }) => "Quiero cotizar hemograma y glucosa");
    const { service } = pipeline({ transcriber });
    expect(await service.resolve(REF)).toEqual({ ok: true, text: "Quiero cotizar hemograma y glucosa" });
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(transcriber.mock.calls[0]![0]).toMatchObject({ format: "ogg" });
    // el servicio no tiene cola: ni encolar, ni liberar, ni atrasados
    for (const removed of ["enqueue", "release", "stale"]) expect((service as unknown as Record<string, unknown>)[removed], removed).toBeUndefined();
  });

  it("falla reintentable (OpenAI 503) se reintenta dentro del plazo y luego sale bien", async () => {
    let calls = 0;
    const transcriber = vi.fn(async () => {
      if (++calls < 3) throw new AudioFailure("UNAVAILABLE", true);
      return "necesito colesterol";
    });
    const { service, logs } = pipeline({ transcriber });
    expect(await service.resolve(REF)).toEqual({ ok: true, text: "necesito colesterol" });
    expect(transcriber).toHaveBeenCalledTimes(3);
    expect(logs.filter(([event, data]) => event === "audio_job" && data.event === "retry")).toHaveLength(2);
  });

  it("si agota los reintentos: UNAVAILABLE definitivo; no queda a medias ni se inventa texto", async () => {
    const transcriber = vi.fn(async () => { throw new AudioFailure("UNAVAILABLE", true); });
    const { service } = pipeline({ transcriber });
    expect(await service.resolve(REF)).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(transcriber).toHaveBeenCalledTimes(3);
  });

  it("el plazo total manda: si ya no queda tiempo para otro intento, no lo empieza", async () => {
    let clock = 0;
    const transcriber = vi.fn(async () => { clock += 100_000; throw new AudioFailure("UNAVAILABLE", true); });
    const { service } = pipeline({ transcriber, options: { now: () => clock, deadlineMs: 150_000 } });
    expect(await service.resolve(REF)).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(transcriber).toHaveBeenCalledTimes(2);
  });

  it("un error DEFINITIVO no se reintenta: formato inválido, no admitido, sin palabras, demasiado grande", async () => {
    for (const code of ["INVALID_AUDIO", "UNSUPPORTED_FORMAT", "UNINTELLIGIBLE", "TOO_LARGE", "TOO_LONG"] as const) {
      const transcriber = vi.fn(async () => { throw new AudioFailure(code); });
      const { service } = pipeline({ transcriber });
      expect(await service.resolve(REF), code).toEqual({ ok: false, code });
      expect(transcriber, code).toHaveBeenCalledTimes(1);
    }
  });

  it("archivo que no es audio: ni se transcribe ni se envía a OpenAI", async () => {
    const transcriber = vi.fn(async () => "x");
    const html = fetcher({ raw: () => new Response(bytesOf("<html>expired</html>"), { status: 200 }) });
    const { service } = pipeline({ transcriber, fetcher: html.impl });
    expect(await service.resolve(REF)).toEqual({ ok: false, code: "INVALID_AUDIO" });
    const amr = pipeline({ transcriber, fetcher: fetcher({ raw: () => new Response(bytesOf("#!AMR\n"), { status: 200 }) }).impl });
    expect(await amr.service.resolve(REF)).toEqual({ ok: false, code: "UNSUPPORTED_FORMAT" });
    expect(transcriber).not.toHaveBeenCalled();
  });

  it("enlace vencido con id: el SDK lo recupera y se transcribe; sin id ni enlace seguro es MEDIA_EXPIRED", async () => {
    const f = fetcher({ raw: () => new Response("gone", { status: 410 }), sdk: () => OGG().buffer as ArrayBuffer });
    const { service } = pipeline({ fetcher: f.impl });
    expect(await service.resolve(REF)).toMatchObject({ ok: true });
    expect(f.calls.sdk).toEqual(["m1"]);
    const gone = pipeline({ fetcher: fetcher({ raw: () => new Response("gone", { status: 410 }) }).impl });
    expect(await gone.service.resolve({ ...REF, mediaId: undefined })).toEqual({ ok: false, code: "MEDIA_EXPIRED" });
  });

  it("el registro solo lleva códigos y cantidades: nunca el teléfono, el enlace, el id del mensaje ni la transcripción", async () => {
    const { service, logs } = pipeline({ transcriber: async () => "TEXTO_SECRETO_DEL_PACIENTE" });
    await service.resolve(REF);
    const failing = pipeline({ transcriber: async () => { throw new AudioFailure("UNAVAILABLE", true); } });
    await failing.service.resolve(REF);
    const serialized = JSON.stringify([...logs, ...failing.logs]);
    for (const forbidden of ["TEXTO_SECRETO", "59170000001", "kapso", "wamid.A1", "m1"]) expect(serialized, forbidden).not.toContain(forbidden);
  });
});

describe("configuración: APAGADA por defecto", () => {
  const log = vi.fn();
  const runtime = { fetcher: fetcher().impl };
  const FULL = { PLUSMEDIK_AUDIO: "on", OPENAI_API_KEY: "sk-x", OPENAI_TRANSCRIPTION_MODEL: "modelo" };

  it("sin la variable, vacía u «off»: apagado, sin aviso; solo «on» la enciende", () => {
    for (const value of [undefined, "", "off", "true", "1", "shadow"]) {
      log.mockClear();
      expect(resolveAudio({ ...FULL, PLUSMEDIK_AUDIO: value }, log, runtime), String(value)).toBeUndefined();
      expect(log).not.toHaveBeenCalled();
    }
    expect(resolveAudio({}, log, runtime)).toBeUndefined();
    expect(resolveAudio(FULL, log, runtime)).toBeInstanceOf(AudioPipeline);
    expect(resolveAudio({ ...FULL, PLUSMEDIK_AUDIO: " ON " }, log, runtime)).toBeInstanceOf(AudioPipeline);
  });

  it("configuración incompleta o inválida: sigue APAGADO y registra solo un código (nunca el valor)", () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ OPENAI_API_KEY: undefined }, "MISSING_API_KEY"], [{ OPENAI_TRANSCRIPTION_MODEL: undefined }, "MISSING_MODEL"],
      [{ PLUSMEDIK_AUDIO_LANGUAGE: "espanol" }, "INVALID_LANGUAGE"], [{ PLUSMEDIK_AUDIO_MAX_BYTES: "10" }, "INVALID_MAX_BYTES"],
      [{ PLUSMEDIK_AUDIO_MAX_BYTES: "abc" }, "INVALID_MAX_BYTES"], [{ PLUSMEDIK_AUDIO_TIMEOUT_MS: "5" }, "INVALID_TIMEOUT"], [{ PLUSMEDIK_AUDIO_MAX_PER_BATCH: "0" }, "INVALID_MAX_PER_BATCH"]
    ];
    for (const [override, error] of cases) {
      log.mockClear();
      expect(resolveAudio({ ...FULL, ...override }, log, runtime), error).toBeUndefined();
      expect(log).toHaveBeenCalledWith("audio_config_invalid", { error });
      expect(JSON.stringify(log.mock.calls)).not.toContain("sk-x");
    }
  });

  it("NO necesita clave de cifrado, base de datos ni migraciones: con la clave de OpenAI y el modelo basta", () => {
    expect(resolveAudio({ PLUSMEDIK_AUDIO: "on", OPENAI_API_KEY: "sk-x", OPENAI_TRANSCRIPTION_MODEL: "modelo" }, log, runtime)).toBeInstanceOf(AudioPipeline);
  });

  it("el modelo de transcripción NO tiene valor por defecto y se leen los límites opcionales", () => {
    const configured = resolveAudio({ ...FULL, PLUSMEDIK_AUDIO_MAX_PER_BATCH: "2" }, log, runtime)!;
    expect(configured.maxPerBatch).toBe(2);
    expect(resolveAudio(FULL, log, runtime)!.maxPerBatch).toBe(5);
  });
});

describe("avisos al paciente", () => {
  it("no llevan cifras, precios ni promesas, y cada código de falla tiene su aviso", () => {
    expect(() => assertSafeAudioTexts()).not.toThrow();
    expect(() => assertSafeAudioTexts({ ...AUDIO_TEXTS, invalid: "Cuesta Bs 5" })).toThrow();
    expect(() => assertSafeAudioTexts({ ...AUDIO_TEXTS, invalid: "Una persona te llamará" })).toThrow();
    for (const code of AUDIO_FAILURE_CODES) expect(AUDIO_TEXTS[failureTextKey(code)], code).toBeTruthy();
  });
});

describe("payload de Kapso: solo audios ENTRANTES, con el enlace de Kapso", () => {
  const audioMessage = (over: Record<string, any> = {}) => ({
    message: { id: "wamid.AU1", timestamp: String(Math.floor(Date.now() / 1000)), type: "audio", from: "59170000001", audio: { id: "media-1", voice: true, mime_type: "audio/ogg; codecs=opus", link: "https://lookaside.fbsbx.com/x", url: "https://mmg.whatsapp.net/y" },
      kapso: { direction: "inbound", status: "received", origin: "cloud_api", has_media: true, media_url: "https://media.kapso.ai/a.ogg", media_data: { url: "https://media.kapso.ai/b.ogg" } }, ...over }
  });
  const options = { audio: true, nowSeconds: Date.now() / 1000, eventName: "whatsapp.message.received" };

  it("usa kapso.media_url ?? kapso.media_data.url (nunca audio.link/audio.url, que son de Meta) y el id del audio para el SDK", () => {
    const [turn] = extractIncomingTurns(audioMessage() as never, null, options);
    expect(turn).toMatchObject({ kind: "AUDIO", messageId: "wamid.AU1", from: "59170000001", mediaUrl: "https://media.kapso.ai/a.ogg", mediaId: "media-1" });
    const second = extractIncomingTurns({ message: { ...audioMessage().message, kapso: { direction: "inbound", media_data: { url: "https://media.kapso.ai/b.ogg" } } } } as never, null, options)[0];
    expect(second?.mediaUrl).toBe("https://media.kapso.ai/b.ogg");
    const onlyId = extractIncomingTurns({ message: { ...audioMessage().message, kapso: { direction: "inbound" } } } as never, null, options)[0];
    expect(onlyId).toMatchObject({ kind: "AUDIO", mediaId: "media-1" });
    expect(onlyId).not.toHaveProperty("mediaUrl");
  });

  it("recorre payload.batch ? payload.data : [payload]; ignora los audios salientes, los viejos y los que no son mensajes recibidos; con la bandera apagada un audio es un mensaje de otro tipo", () => {
    const batch = { batch: true, data: [audioMessage(), { message: { ...audioMessage().message, id: "wamid.AU2", kapso: { direction: "outbound", media_url: "https://media.kapso.ai/z.ogg" } } },
      { message: { ...audioMessage().message, id: "wamid.AU3", timestamp: "1000" } }, { message: { id: "wamid.T1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: "59170000001", text: { body: "hola" }, kapso: { direction: "inbound" } } }] };
    const turns = extractIncomingTurns(batch as never, "true", options);
    expect(turns.map((turn) => [turn.messageId, turn.kind])).toEqual([["wamid.AU1", "AUDIO"], ["wamid.T1", "TEXT"]]);
    expect(extractIncomingTurns(batch as never, "true", { ...options, eventName: "whatsapp.message.sent" })).toEqual([]);
    expect(extractIncomingTurns(audioMessage() as never, null, { ...options, audio: false })[0]).toMatchObject({ kind: "OTHER" });
    expect(extractIncomingTurns(audioMessage() as never, null, { nowSeconds: options.nowSeconds, eventName: options.eventName })[0]).toMatchObject({ kind: "OTHER" });
  });
});
