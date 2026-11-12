// Aprendizaje semanal (solo LOCAL): lee una exportación del historial (scripts/history-export.ts, formato jsonl) y cuenta qué estudios escritos por los pacientes el catálogo NO reconoce, y cuáles se preguntan
// con opciones. El resultado (frases de estudios, sin teléfonos ni nombres de pacientes) sirve para preparar la lista de sinónimos que la doctora aprueba antes de cargarla.
//
//   npx tsx scripts/mine-unmatched-mentions.ts export.jsonl [--out analisis-local/sinonimos-candidatos.md]
//
// Nada de esto se sube a ningún lado: la salida va a analisis-local/ (fuera del repositorio) y la exportación se borra al terminar.

import { readFileSync, writeFileSync } from "node:fs";
import { extractWithNotes } from "../src/quote-session.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--"));
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : undefined;
if (!input) {
  console.error("Uso: npx tsx scripts/mine-unmatched-mentions.ts export.jsonl [--out archivo.md]");
  process.exit(1);
}

const catalog = await loadActiveCatalog();
const names = new Map(catalog.map((study) => [study.id, study.name]));
const notFound = new Map<string, number>();
const interpreted = new Map<string, number>();
const options = new Map<string, number>();
let messages = 0;
let withStudies = 0;

for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let row: { direction?: string; text?: string | null };
  try {
    row = JSON.parse(line);
  } catch {
    continue;
  }
  if (row.direction !== "IN" || typeof row.text !== "string" || row.text.trim() === "") continue;
  messages++;
  const { extraction, notes } = extractWithNotes(row.text, catalog, { fuzzy: true });
  if (extraction) withStudies++;
  for (const mention of notes.notFound) notFound.set(mention.toLowerCase(), (notFound.get(mention.toLowerCase()) ?? 0) + 1);
  for (const item of notes.interpreted) interpreted.set(`${item.mention.toLowerCase()} => ${item.studyName}`, (interpreted.get(`${item.mention.toLowerCase()} => ${item.studyName}`) ?? 0) + 1);
  for (const group of extraction?.result.ambiguous ?? []) {
    const key = group.map((id) => names.get(id) ?? "?").sort().join(" | ");
    options.set(key, (options.get(key) ?? 0) + 1);
  }
}

const top = (map: Map<string, number>, limit = 60) => [...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([key, count]) => `- ${count} × ${key}`);
const report = [
  `# Candidatos a sinónimos (${new Date().toISOString().slice(0, 10)})`,
  "",
  `Mensajes de pacientes revisados: ${messages}. Con estudios reconocibles: ${withStudies}.`,
  "",
  "## Lo que el catálogo no reconoce (¿falta un sinónimo o un estudio?)",
  ...top(notFound),
  "",
  "## Lo que se interpretó por parecido (confirmar que es correcto; si se repite, conviene un sinónimo aprobado)",
  ...top(interpreted),
  "",
  "## Dudas que se preguntan con opciones (si siempre eligen la misma, definir una variante preferida con la doctora)",
  ...top(options),
  ""
].join("\n");

if (out) {
  writeFileSync(out, report);
  console.log(`Informe guardado en ${out}`);
} else console.log(report);
