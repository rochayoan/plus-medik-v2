// G7 · Fase 0 — Clasifica los lotes del paciente (atención humana correcta / silencio correcto / respondido / insuficiente / error técnico / falta real). TODO LOCAL, sin red ni modelos.
//
//   npx tsx scripts/g7/classify-batches.ts [--in private-data/g7/pseudo.json] [--telemetry private-data/g7/telemetry.private.json]
//
// Terminal: SOLO contadores. Archivo: private-data/g7/batch-labels.private.json (id de conversación/lote, etiqueta, causa, responsable, evidencia; SIN texto) para que usted corrija etiquetas.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { classifyBatches, Telemetry } from "./lib/batch-classification.js";
import { FixtureConversation } from "./lib/schema.js";

const root = resolve(import.meta.dirname, "..", "..");
const dir = join(root, "private-data", "g7");
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? resolve(root, process.argv[i + 1]!) : fallback; };
const { conversations } = z.object({ conversations: z.array(FixtureConversation) }).parse(JSON.parse(readFileSync(arg("in", join(dir, "pseudo.json")), "utf8")));
const telemetry = Telemetry.parse(JSON.parse(readFileSync(arg("telemetry", join(dir, "telemetry.private.json")), "utf8")));
const { labels, summary } = classifyBatches(conversations, telemetry);

const target = join(dir, "batch-labels.private.json");
writeFileSync(target, `${JSON.stringify({ summary, labels }, null, 2)}\n`, { mode: 0o600 });
if (process.platform === "win32") spawnSync("icacls", [target, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { stdio: "ignore" });
console.log(JSON.stringify(summary, null, 2));
