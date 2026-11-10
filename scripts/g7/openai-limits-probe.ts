// G7 · Sonda de límites de OpenAI — LA EJECUTA USTED, con su propia clave, en su equipo. No la ejecuté (no tengo acceso a ninguna clave) ni envía datos de pacientes: cada petición es «ping» de 16 tokens como máximo.
//
//   PowerShell:   $env:OPENAI_API_KEY="sk-..."; npx tsx scripts/g7/openai-limits-probe.ts --models gpt-4.1-mini,<modelo-lector>,<modelo-catalogo>
//   (sin --models usa OPENAI_CONVERSATION_MODEL o gpt-4.1-mini)
//
// Imprime, por modelo: código HTTP, tipo/código de error, límites vigentes (RPM/TPM) y un diagnóstico: cuota/facturación vs. límite de solicitudes. Sirve para saber cómo está la cuenta HOY y
// cuáles son los límites reales de cada modelo; NO reconstruye el incidente del 4-nov (eso se confirma en el panel de OpenAI: Facturación/Uso/Límites, 13:00–18:30 UTC).
// No imprime la clave. Hace una petición por modelo (máximo 6 modelos).
import { interpretProbe } from "./lib/openai-probe.js";

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const key = process.env.OPENAI_API_KEY?.trim();
if (!key) { console.error("Defina OPENAI_API_KEY en el entorno (no se imprime)."); process.exit(1); }
const models = (flag("models") ?? process.env.OPENAI_CONVERSATION_MODEL ?? "gpt-4.1-mini").split(",").map((m) => m.trim()).filter(Boolean).slice(0, 6);

for (const model of models) {
  const started = Date.now();
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: "ping", max_output_tokens: 16, store: false })
    });
    const headers: Record<string, string | undefined> = {};
    response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
    const body = await response.json().catch(() => ({}));
    const result = interpretProbe({ status: response.status, body, headers, ms: Date.now() - started });
    console.log(JSON.stringify({ model, ...result }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ model, diagnosis: "SIN_CONEXION", ms: Date.now() - started, explanation: error instanceof Error ? error.name : "error de red" }, null, 2));
  }
}
