import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// FRONTERAS DEL CÓDIGO de los audios (análisis estático): quién los conoce, que nada fuera del cableado lea el entorno, que la credencial de Kapso no viaje a cualquier host, que el audio ni la transcripción
// se registren, que NO haya cola, base de datos, cron ni migración para los audios, y que todo siga apagado por defecto.

const root = join(__dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
const source = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const code = (path: string) => source(path).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).map((line) => line.replace(/\s\/\/.*$/, "")).join("\n");
const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
const importsOf = (path: string) => [...source(path).matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((match) => match[1]!);
const files = [...walk(join(root, "src")), ...walk(join(root, "api"))].filter((path) => path.endsWith(".ts"));
const AUDIO = files.filter((path) => rel(path).startsWith("src/audio/"));
const IMPORTS_AUDIO = /\/audio\/|audio-turns/;

describe("audios: dónde pueden aparecer", () => {
  it("solo los turnos, la configuración de turnos, el cableado de Vercel y el ruteo de audios importan el procesamiento de audios", () => {
    const importers = files.filter((path) => !rel(path).startsWith("src/audio/") && importsOf(path).some((imported) => IMPORTS_AUDIO.test(imported))).map(rel).sort();
    expect(importers).toEqual(["api/kapso/webhook.ts", "src/audio-turns.ts", "src/guarded-turn.ts", "src/turns.ts"]);
  });

  it("el motor de recetas, las cotizaciones por foto de siempre, el motor de lotes, las sesiones, la auditoría y la cola del CRM NO conocen los audios", () => {
    for (const name of ["analyze", "whatsapp-quote", "batch-engine", "batch-execution", "batch-policy", "batch-understanding", "batch-compose", "batch-shadow", "quote-session", "quote-session-turns", "text-handler", "audit", "human-control", "reply-guard", "kapso-webhook"]) {
      expect(source(join(root, "src", `${name}.ts`)), name).not.toMatch(/\/audio\/|audio-turns|AudioPipeline/);
    }
    for (const path of files.filter((p) => rel(p).startsWith("src/crm-outbox/"))) expect(source(path), rel(path)).not.toMatch(/\/audio\/|AudioPipeline/);
  });
});

describe("audios: SIN cola, sin base de datos, sin cron y sin migración", () => {
  it("el procesamiento de audios no toca Supabase ni ninguna función de la base, y no cifra ni guarda nada", () => {
    for (const path of [...AUDIO, join(root, "src/audio-turns.ts")]) {
      expect(code(path), rel(path)).not.toMatch(/supabase|createSupabaseRpc|\brpc\(|createCipheriv|createDecipheriv|enqueue|queue|\bcola\b/i);
      // (las variables PLUSMEDIK_AUDIO_* son de configuración; lo que no puede haber son funciones de base plusmedik_audio_*)
      expect(code(path), rel(path)).not.toMatch(/plusmedik_audio_/);
      expect(importsOf(path).some((imported) => /audit\.js$|supabase|crypto/.test(imported)), rel(path)).toBe(path.endsWith("audio-turns.ts") ? true : false);
    }
    expect(AUDIO.map(rel).sort()).toEqual(["src/audio/config.ts", "src/audio/media.ts", "src/audio/service.ts", "src/audio/transcribe.ts", "src/audio/types.ts"]);
  });

  it("no hay ruta de reproceso, ni flujo programado, ni cron de Vercel, ni migraciones de audios, ni variables de clave o de cron para audios", () => {
    expect(existsSync(join(root, "api/audio"))).toBe(false);
    expect(existsSync(join(root, ".github/workflows/audio-drain.yml"))).toBe(false);
    expect((JSON.parse(source(join(root, "vercel.json"))) as { crons?: unknown[]; functions?: Record<string, unknown> }).crons).toBeUndefined();
    expect(Object.keys((JSON.parse(source(join(root, "vercel.json"))) as { functions: Record<string, unknown> }).functions)).toEqual(["api/kapso/webhook.ts"]);
    expect(readdirSync(join(root, "supabase/migrations")).filter((name) => /audio/i.test(name))).toEqual([]);
    for (const name of [".env.example", "README.md"]) expect(source(join(root, name)), name).not.toMatch(/PLUSMEDIK_AUDIO_KEY|audio\/drain|audio_jobs/);
    const webhook = source(join(root, "api/kapso/webhook.ts"));
    expect(webhook).not.toMatch(/audioRuntime|createAudioRecovery|audio\/drain/);
    expect(code(join(root, "src/kapso-webhook.ts"))).not.toMatch(/enqueue|AudioPipeline|audioRecovery|scheduleRecovery/);
  });
});

describe("audios: pureza y secretos", () => {
  it("ningún módulo de src/audio lee el entorno (la configuración lo recibe del cableado) ni importa el SDK de Kapso, el webhook o la ruta de api", () => {
    for (const path of AUDIO) {
      expect(code(path), rel(path)).not.toMatch(/process\.env/);
      expect(importsOf(path).some((imported) => /@kapso|kapso-webhook|api\//.test(imported)), rel(path)).toBe(false);
    }
  });

  it("la credencial de Kapso solo se envía a un servidor de Kapso, y nunca se descarga de Meta", () => {
    const media = code(join(root, "src/audio/media.ts"));
    expect(media).toMatch(/\(response\.status === 401 \|\| response\.status === 403\) && isKapsoHost\(url\)\) response = await fetcher\.authedFetch/);
    expect(media.match(/fetcher\.authedFetch\(/g)).toHaveLength(1);
    for (const host of ["facebook.com", "fbsbx.com", "fbcdn.net", "whatsapp.net"]) expect(media).toContain(`"${host}"`);
    // el enlace se toma SOLO de lo que Kapso entrega (nunca de audio.link / audio.url, que son de Meta)
    const turns = code(join(root, "src/turns.ts"));
    expect(turns).toMatch(/message\.kapso\?\.media_url, message\.kapso\?\.media_data\?\.url/);
    const start = turns.indexOf("options.audio &&");
    const audioBranch = turns.slice(start, turns.indexOf('} else if (type && type !== "reaction")', start));
    expect(audioBranch.length).toBeGreaterThan(100);
    expect(audioBranch).not.toMatch(/audio\?\.(link|url)\b/);
  });

  it("el cableado de Vercel solo entrega a la descarga el cliente de Kapso (enlace propio o id con el SDK oficial) y nada más", () => {
    const webhook = code(join(root, "api/kapso/webhook.ts"));
    expect(webhook).toMatch(/rawFetch: \(url, init\) => kapsoClient\(\)\.rawFetch\(url, init\)/);
    expect(webhook).toMatch(/authedFetch: \(url, init\) => kapsoClient\(\)\.fetch\(url, init\)/);
    expect(webhook).toMatch(/kapsoClient\(\)\.media\.download\(\{ mediaId, phoneNumberId: phoneNumberId\(\), as: "arrayBuffer" \}\)/);
  });

  it("el audio y la transcripción nunca se registran en claro", () => {
    for (const path of [...AUDIO, join(root, "src/audio-turns.ts")]) {
      for (const call of code(path).matchAll(/\blog\(\s*"[a-z_]+"\s*,\s*\{([^}]*)\}/g)) {
        expect(call[1], rel(path)).not.toMatch(/\b(text|transcript|body|mediaUrl|url|bytes)\b/);
        expect(call[1], rel(path)).not.toMatch(/(^|[ ,])from(\s*[:,}]|\s*$)/);
      }
    }
  });

  it("la transcripción SOLO entra al agente como texto del paciente por el turno: el módulo de audios no conoce el catálogo ni los precios", () => {
    for (const path of [...AUDIO, join(root, "src/audio-turns.ts")]) {
      expect(code(path), rel(path)).not.toMatch(/priceBs|toCents|totalBs|loadCatalog|evaluateSession|extractStudyRequests|lab_tests/);
    }
  });
});

describe("audios: apagados por defecto", () => {
  it("el cableado solo los activa con PLUSMEDIK_AUDIO=on, turnos y manejador de texto y la configuración completa", () => {
    const webhook = source(join(root, "api/kapso/webhook.ts"));
    expect(webhook).toMatch(/const audioRequested = on\("PLUSMEDIK_AUDIO"\);/);
    expect(webhook).toMatch(/audioRequested && turnsEnabled && textHandlerEnabled \? resolveAudio\(process\.env/);
    expect(webhook).toMatch(/const audioActive = Boolean\(audioPipeline && turnsEnabled && textHandlerEnabled && !replyGuardInvalid\);/);
    expect(webhook).toMatch(/\.\.\.\(audioActive \? \{ audio: audioPipeline \} : \{\}\)/);
    expect(source(join(root, ".env.example"))).toMatch(/^PLUSMEDIK_AUDIO=\r?$/m);
    expect(source(join(root, "README.md"))).toMatch(/PLUSMEDIK_AUDIO.*apagada por defecto/);
  });

  it("el webhook NO cambia: verifica la firma antes que nada y responde 200 y programa el trabajo igual que siempre (los audios se transcriben dentro del turno)", () => {
    const webhook = code(join(root, "src/kapso-webhook.ts"));
    expect(webhook.indexOf("verifyWebhookSignature(rawBody")).toBeGreaterThan(0);
    expect(webhook.indexOf("verifyWebhookSignature(rawBody")).toBeLessThan(webhook.indexOf("JSON.parse(rawBody)"));
    // lo único propio de los audios en el webhook es reconocerlos al extraer los turnos
    expect(webhook).toMatch(/audio: Boolean\(deps\.quote\.turns\.audio && deps\.quote\.turns\.handlers\?\.text\)/);
    expect(webhook).toMatch(/deps\.schedule\(processTurns\(turns, deps\.quote\)\);\s*return text\(200, "ok"\);/);
  });
});
