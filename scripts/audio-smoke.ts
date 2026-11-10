// Prueba de humo MANUAL de la transcripción de audios contra el servicio REAL de OpenAI, para confirmar ANTES de activar PLUSMEDIK_AUDIO que el modelo elegido acepta una nota de voz de WhatsApp (OGG/Opus).
// No es parte del agente ni de las pruebas automáticas: no toca Supabase, Kapso ni Vercel; hace UNA llamada de pago a OpenAI con el archivo que le des.
//
//   npx tsx scripts/audio-smoke.ts <archivo.ogg>                 hace la llamada real (necesita OPENAI_API_KEY y OPENAI_TRANSCRIPTION_MODEL)
//   npx tsx scripts/audio-smoke.ts <archivo.ogg> --show-text     además imprime la transcripción (por defecto solo cuántos caracteres tiene)
//   npx tsx scripts/audio-smoke.ts <archivo.ogg> --dry-run       NO llama a OpenAI: valida el formato y muestra cómo saldría la petición
//
// Cómo conseguir un audio real: en WhatsApp Web/Desktop, descarga una nota de voz que te hayas enviado (es un .ogg). Úsala solo con audios tuyos o de prueba.
// Resultado esperado: «format: ogg», «transcription: OK» y un número de caracteres mayor que cero. Si OpenAI rechaza el archivo (HTTP 400), el mensaje lo dice con el código de falla y NO se debe activar.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { formatInfo, MIN_AUDIO_BYTES, sniffAudio } from "../src/audio/media.js";
import { createOpenAiTranscriber, usesLanguagesField } from "../src/audio/transcribe.js";
import { AudioFailure } from "../src/audio/types.js";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const showText = args.includes("--show-text");

if (!file) {
  console.error("Uso: npx tsx scripts/audio-smoke.ts <archivo.ogg> [--dry-run] [--show-text]");
  process.exit(2);
}

if (!existsSync(file)) {
  console.error(`No existe el archivo: ${file}`);
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(file));
console.log(`archivo: ${basename(file)} (${bytes.byteLength} bytes; mínimo ${MIN_AUDIO_BYTES})`);

let format;
try {
  format = sniffAudio(bytes);
} catch (error) {
  console.error(`formato: RECHAZADO (${error instanceof AudioFailure ? error.code : "ERROR"}) — no es un audio que el agente pueda transcribir`);
  process.exit(1);
}
const info = formatInfo(format);
const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ?? "(sin definir)";
const language = process.env.PLUSMEDIK_AUDIO_LANGUAGE?.trim().toLowerCase() || "es";
console.log(`format: ${format} → se envía como «audio.${info.ext}» (${info.mime})`);
console.log(`modelo: ${model}; idioma: ${usesLanguagesField(model) ? "(lo detecta el modelo; gpt-transcribe no recibe «language»)" : language}`);

if (dryRun) {
  console.log("dry-run: no se llamó a OpenAI.");
  process.exit(0);
}

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey || model === "(sin definir)") {
  console.error("Faltan OPENAI_API_KEY y/o OPENAI_TRANSCRIPTION_MODEL en el entorno.");
  process.exit(2);
}

try {
  const transcribe = createOpenAiTranscriber({ apiKey, model, language, timeoutMs: 60_000 });
  const text = await transcribe({ bytes, format });
  console.log(`transcription: OK (${text.length} caracteres)`);
  if (showText) console.log(text);
} catch (error) {
  const code = error instanceof AudioFailure ? `${error.code}${error.retryable ? " (reintentable)" : ""}` : "ERROR";
  console.error(`transcription: FALLÓ → ${code}`);
  process.exit(1);
}
