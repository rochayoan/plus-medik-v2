// G7 · Evaluación EN VIVO del núcleo conversacional con un modelo REAL de OpenAI — LA EJECUTA USTED (o quien tenga una clave), en su equipo.
//
// Qué envía a OpenAI: SOLO los escenarios sintéticos de scripts/g7/lib/agent-scenarios.ts (frases inventadas, un catálogo y un conocimiento ficticios). NO lee ningún archivo de pacientes, ni la base,
// ni el corpus privado, y no acepta texto de fuera: no hay opción para ello. Las herramientas (cotización, horarios, memoria) corren localmente sobre los datos ficticios.
//
//   PowerShell:
//     $env:OPENAI_API_KEY="sk-..."
//     npx tsx scripts/g7/agent-live-eval.ts --models <modelo1>,<modelo2> --reasoning medium --price-in 2 --price-out 10
//   o con un archivo .env (ignorado por git):   npx tsx --env-file=.env scripts/g7/agent-live-eval.ts --models <modelo>
//
//   --models         lista de modelos (máximo 4). Obligatorio.
//   --reasoning      low | medium | high | xhigh | max (solo para modelos que lo admiten)
//   --scenarios      ids separados por coma (por omisión, todos); --list los muestra
//   --repeat         repeticiones por escenario (1–3; por omisión 1): sirve para ver la variabilidad
//   --timeout-ms     tiempo de cada llamada al modelo (3000–60000; por omisión 30000)
//   --price-in/-out  USD por millón de tokens, para estimar el costo (no hay precios incorporados)
//   --preflight      NO llama a nadie: revisa la configuración (variables de entorno) y sale
//   --check-models   lista de modelos: comprueba cuáles están DISPONIBLES en la cuenta (lectura GET /v1/models/<id>: sin datos ni gasto) y sale. Antes de evaluar cada modelo también se comprueba.
//   --out            carpeta de resultados (por omisión private-data/g7/agent-live/, ignorada por git)
//
// Imprime, por modelo: cada escenario (cumple / falla y por qué), cuántas respuestas pasaron el verificador a la primera y cuántas tras la reparación, rechazos del verificador (a revisar a mano: ¿bloqueó algo
// correcto?), latencia p50/p95, tokens y costo estimado. Guarda el detalle (incluidos los mensajes propuestos, que son sintéticos) en la carpeta de resultados. Nunca imprime la clave.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentModel, createOpenAiAgentClient } from "../../src/agent/openai.js";
import { gate, preflight, runAll, summarize, type ScenarioRun } from "./lib/agent-eval.js";
import { checkModelAvailability } from "./lib/model-check.js";
import { AGENT_SCENARIOS } from "./lib/agent-scenarios.js";

const flag = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const fail = (message: string): never => { console.error(message); process.exit(1); };

if (has("list")) {
  for (const scenario of AGENT_SCENARIOS) console.log(`${scenario.id.padEnd(24)} ${scenario.title}`);
  process.exit(0);
}

if (has("preflight")) {
  const lines = preflight(process.env);
  for (const line of lines) console.log(`${line.level.padEnd(5)} ${line.item}: ${line.detail}`);
  process.exit(lines.some((line) => line.level === "BLOCK") ? 2 : 0);
}

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) fail("Defina OPENAI_API_KEY en el entorno o en un .env (no se imprime). Sin clave no se llama a nadie.");
const checkList = (flag("check-models") ?? "").split(",").map((model) => model.trim()).filter(Boolean).slice(0, 8);
if (checkList.length > 0) {
  let missing = 0;
  for (const model of checkList) {
    const result = await checkModelAvailability({ apiKey: apiKey!, model });
    if (result.availability !== "AVAILABLE") missing += 1;
    console.log(`${result.availability === "AVAILABLE" ? "DISPONIBLE   " : "NO DISPONIBLE"} ${model}${result.httpStatus ? ` (HTTP ${result.httpStatus}${result.errorCode ? `, ${result.errorCode}` : ""})` : result.availability === "NO_CONNECTION" ? " (sin conexión)" : ""}`);
  }
  process.exit(missing > 0 ? 4 : 0);
}
const models = (flag("models") ?? "").split(",").map((model) => model.trim()).filter(Boolean).slice(0, 4);
if (models.length === 0) fail("Indique --models <modelo1,modelo2> (sin valor por defecto: elegir el modelo es decisión del dueño).");
for (const model of models) if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) fail(`Nombre de modelo inválido: ${model}`);
const reasoning = flag("reasoning")?.toLowerCase();
if (reasoning && !["low", "medium", "high", "xhigh", "max"].includes(reasoning)) fail("--reasoning inválido");
const repeat = Math.min(3, Math.max(1, Number(flag("repeat") ?? 1) || 1));
const timeoutMs = Number(flag("timeout-ms") ?? 30_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 3000 || timeoutMs > 60_000) fail("--timeout-ms debe estar entre 3000 y 60000");
const ids = flag("scenarios")?.split(",").map((id) => id.trim()).filter(Boolean);
const scenarios = ids ? AGENT_SCENARIOS.filter((scenario) => ids.includes(scenario.id)) : AGENT_SCENARIOS;
if (scenarios.length === 0) fail("Ningún escenario coincide (use --list).");
const priceIn = flag("price-in") !== undefined ? Number(flag("price-in")) : undefined;
const priceOut = flag("price-out") !== undefined ? Number(flag("price-out")) : undefined;
const price = priceIn !== undefined && priceOut !== undefined && Number.isFinite(priceIn) && Number.isFinite(priceOut) ? { inputPerMTok: priceIn, outputPerMTok: priceOut } : undefined;
const outDir = flag("out") ?? join("private-data", "g7", "agent-live");
mkdirSync(outDir, { recursive: true });

console.log(`Escenarios sintéticos: ${scenarios.length} × ${repeat} repetición(es) × ${models.length} modelo(s). Solo texto inventado sale hacia OpenAI.\n`);

for (const modelName of models) {
  console.log(`══ ${modelName}${reasoning ? ` (razonamiento ${reasoning})` : ""}`);
  const available = await checkModelAvailability({ apiKey: apiKey!, model: modelName });
  if (available.availability !== "AVAILABLE") {
    console.log(`NO DISPONIBLE en la cuenta (${available.availability}${available.httpStatus ? `, HTTP ${available.httpStatus}` : ""}${available.errorCode ? `, ${available.errorCode}` : ""}): no se evalúa.\n`);
    process.exitCode = 4;
    continue;
  }
  const model = createAgentModel({ client: createOpenAiAgentClient({ apiKey: apiKey!, model: modelName, ...(reasoning ? { reasoningEffort: reasoning as "low" } : {}) }), timeoutMs });
  const all: ScenarioRun[] = [];
  for (let round = 1; round <= repeat; round++) {
    const runs = await runAll(model, {
      scenarios,
      modelName,
      onProgress: (run) => console.log(`${run.failures.length === 0 ? "OK  " : "FALLA"} ${run.id.padEnd(24)} ${String(run.latencyMs).padStart(6)} ms${run.decision?.repairs ? "  (reparado)" : ""}${run.failures.length > 0 ? `\n      · ${run.failures.join("\n      · ")}` : ""}`)
    });
    all.push(...runs);
  }
  const summary = summarize(all, price);
  console.log(`\nResumen ${modelName}: ${summary.passed}/${summary.scenarios} cumplen · verificadas ${summary.verified} (a la primera ${summary.firstPass}, tras reparar ${summary.repaired}) · rechazadas ${summary.rejected} · errores del modelo ${summary.modelErrors}`);
  console.log(`Latencia p50 ${summary.latencyMs.p50} ms · p95 ${summary.latencyMs.p95} ms · máx ${summary.latencyMs.max} ms · tokens entrada ${summary.usage.inputTokens} salida ${summary.usage.outputTokens} (razonamiento ${summary.usage.reasoningTokens}) · llamadas ${summary.usage.calls}${summary.costUsd !== undefined ? ` · costo estimado USD ${summary.costUsd}` : ""}`);
  const verdict = gate(summary);
  console.log(verdict.pass ? `PUERTA: APROBADO (${modelName})` : `PUERTA: NO APROBADO (${modelName}): ${verdict.reasons.join("; ")}`);
  if (!verdict.pass) process.exitCode = 3;
  if (summary.rejectedList.length > 0) console.log(`Rechazadas por el verificador (LEA el mensaje propuesto en el archivo: ¿bloqueó algo correcto?): ${summary.rejectedList.map((item) => `${item.id} [${item.violations.join(",")}]`).join("; ")}`);
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${modelName.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  writeFileSync(file, JSON.stringify({ model: modelName, reasoning: reasoning ?? null, repeat, summary, runs: all.map((run) => ({ id: run.id, title: run.title, latencyMs: run.latencyMs, failures: run.failures, status: run.decision?.status, acts: run.decision?.acts, toolRuns: run.decision?.toolRuns, violations: run.decision?.violations, firstViolations: run.decision?.firstViolations, repairs: run.decision?.repairs, modelError: run.decision?.modelError, usage: run.decision?.usage, reply: run.decision?.reply })) }, null, 2));
  console.log(`Detalle: ${file}\n`);
}
