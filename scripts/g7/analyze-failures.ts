// G7 · Fase 0 — Análisis de causas de fallo del corpus seudonimizado. TODO LOCAL, determinista, sin red ni modelos.
//
//   npx tsx scripts/g7/analyze-failures.ts [--in private-data/g7/pseudo.json]
//
// Terminal: SOLO contadores. Archivos (private-data/g7/, acceso solo para su usuario):
//   failure-report.json       los mismos contadores
//   casebook.private.md       casos de ejemplo por causa con extractos SEUDONIMIZADOS, para que usted los revise. No lo pegue en chats ni en servicios externos.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { analyze } from "./lib/analysis.js";
import { FixtureConversation } from "./lib/schema.js";

const root = resolve(import.meta.dirname, "..", "..");
const dir = join(root, "private-data", "g7");
const idx = process.argv.indexOf("--in");
const input = idx >= 0 && process.argv[idx + 1] ? resolve(root, process.argv[idx + 1]!) : join(dir, "pseudo.json");
const { conversations } = z.object({ conversations: z.array(FixtureConversation) }).parse(JSON.parse(readFileSync(input, "utf8")));
const { report, cases } = analyze(conversations);

const restrict = (target: string) => { if (process.platform === "win32") spawnSync("icacls", [target, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { stdio: "ignore" }); };
const reportPath = join(dir, "failure-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
restrict(reportPath);

const clip = (text: string | null, max = 280) => (text === null ? "—" : text.replace(/\s+/g, " ").slice(0, max));
const byCause = new Map<string, typeof cases>();
for (const item of cases) byCause.set(item.cause, [...(byCause.get(item.cause) ?? []), item]);
const md = ["# Casebook privado (seudonimizado) — NO COMPARTIR", "", "Extractos por causa. Los textos ya están seudonimizados, pero pueden contener contenido clínico."];
for (const [cause, list] of byCause) {
  md.push("", `## ${cause} (${list.length} ejemplos)`);
  for (const item of list) {
    md.push("", `### ${item.conversation} · ${item.batch} · ${String(item.hourBolivia).padStart(2, "0")}h Bolivia`, ...item.patient.map((line) => `- **Paciente:** ${clip(line)}`), ...item.next.map((n) => `- **${n.actor}${n.type && n.type !== "text" ? ` [${n.type}]` : ""}${n.kind ? ` (${n.kind})` : ""}:** ${clip(n.text)}`));
  }
}
const casebookPath = join(dir, "casebook.private.md");
writeFileSync(casebookPath, `${md.join("\n")}\n`, { mode: 0o600 });
restrict(casebookPath);

console.log(JSON.stringify(report, null, 2));
console.log(`\nCasebook privado: private-data/g7/casebook.private.md (${cases.length} casos). No se imprime.`);
