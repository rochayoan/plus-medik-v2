// G7 · Fase 0 — Línea base medida sobre el corpus seudonimizado (private-data/g7/pseudo.json). TODO LOCAL, determinista, sin red ni modelos.
//
//   npx tsx scripts/g7/corpus-baseline.ts [--in private-data/g7/pseudo.json]
//
// Mide, con lo que ya está en los datos: qué parte de las respuestas del agente son textos fijos (genéricos / «no puedo derivar»), lotes del paciente sin respuesta, preguntas múltiples,
// repreguntas, intervención humana, latencia y cómo clasifica hoy el enrutador de reglas. Escribe baseline-report.json (solo contadores) en private-data/g7/.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { baseline } from "./lib/corpus.js";
import { FixtureConversation } from "./lib/schema.js";

const root = resolve(import.meta.dirname, "..", "..");
const idx = process.argv.indexOf("--in");
const input = idx >= 0 && process.argv[idx + 1] ? resolve(root, process.argv[idx + 1]!) : join(root, "private-data", "g7", "pseudo.json");
const parsed = z.object({ conversations: z.array(FixtureConversation) }).parse(JSON.parse(readFileSync(input, "utf8")));
const report = baseline(parsed.conversations);
writeFileSync(join(root, "private-data", "g7", "baseline-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
