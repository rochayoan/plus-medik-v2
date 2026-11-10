// G7 · Fase 0 — Verifica el archivo exportado del historial, lo seudonimiza y lo prepara como corpus de evaluación. TODO LOCAL: sin red, sin Supabase, sin modelos.
//
//   npx tsx scripts/g7/prepare-corpus.ts [--in private-data/g7/<archivo>.jsonl|.csv] [--expected 469] [--verify-only]
//
// Entrada: la salida de scripts/history-export.ts (JSONL o CSV). Si no se indica --in se usa el único .jsonl/.csv de private-data/g7/ (los que empiezan por «pseudo», «verify» o «baseline» se ignoran).
// Salida (todo dentro de private-data/g7/, ignorado por git, permisos 0600):
//   verify-report.json          contadores de la verificación (sin texto)
//   pseudo.json                 corpus seudonimizado (conversaciones → lotes → mensajes)
//   equivalences.private.json   tabla dato real ↔ seudónimo. LA PARTE SENSIBLE: guárdela aparte; no hace falta para evaluar
//   residual-names.private.json mensajes con posible nombre propio residual, para revisión manual
// La terminal solo muestra contadores. El script se niega a escribir fuera de private-data/ o en una ruta que git no ignore.

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { buildFixture, readRaw, verify } from "./lib/corpus.js";

const root = resolve(import.meta.dirname, "..", "..");
const dirFlag = (() => { const index = process.argv.indexOf("--dir"); return index >= 0 ? process.argv[index + 1] : undefined; })();
// --dir permite probar el flujo con datos sintéticos en otra carpeta de private-data/ sin tocar private-data/g7/.
const dir = dirFlag ? resolve(root, dirFlag) : join(root, "private-data", "g7");

function flag(name: string): string | true | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
}
const fail = (message: string): never => { console.error(message); process.exit(1); };

function assertPrivate(path: string): void {
  const rel = relative(root, resolve(path));
  if (rel.startsWith("..") || !rel.replaceAll("\\", "/").startsWith("private-data/")) fail("Ruta fuera de private-data/: no se escribe.");
  // Si es un repositorio git, la ruta debe estar ignorada (si git no está disponible, la regla de private-data/ ya se comprobó arriba).
  const check = spawnSync("git", ["check-ignore", "-q", rel], { cwd: root });
  if (check.error === undefined && check.status === 1) fail("git NO ignora esa ruta: no se escribe (revisa .gitignore).");
}

function pickInput(): string {
  const given = flag("in");
  if (typeof given === "string") return resolve(root, given);
  if (!existsSync(dir)) return fail("No existe private-data/g7/. Deje allí la exportación del historial (jsonl o csv).");
  const candidates = readdirSync(dir).filter((name) => /\.(jsonl|csv)$/i.test(name) && !/^(pseudo|verify|baseline|residual|equivalences)/i.test(name));
  if (candidates.length === 0) return fail("No hay ningún .jsonl/.csv de entrada en private-data/g7/.");
  if (candidates.length > 1) return fail(`Hay ${candidates.length} archivos candidatos; indique uno con --in.`);
  return join(dir, candidates[0]!);
}

// En Windows el modo 0600 no restringe nada: se quita la herencia de permisos y se deja acceso solo al usuario actual (mejor esfuerzo).
function restrictToCurrentUser(target: string): void {
  if (process.platform !== "win32") return;
  const result = spawnSync("icacls", [target, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { stdio: "ignore" });
  if (result.status !== 0) console.warn(`Aviso: no se pudo restringir el acceso de ${basename(target)}; hágalo manualmente.`);
}

function write(name: string, data: unknown): string {
  const target = join(dir, name);
  assertPrivate(target);
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  restrictToCurrentUser(target);
  return name;
}

const input = pickInput();
assertPrivate(input);
const expected = flag("expected");
const read = readRaw(readFileSync(input, "utf8"));
const report = verify(read, typeof expected === "string" ? Number(expected) : 469);
write("verify-report.json", report);

console.log(`Archivo: ${basename(input)} (${report.format})`);
console.log(`Registros válidos: ${report.total} · inválidos: ${report.invalidRecords} · esperados: ${expected ?? 469} → ${report.matchesExpectedTotal ? "COINCIDE" : "NO COINCIDE"}`);
console.log(`Contactos: ${report.contacts} · mensajes por contacto (mín/mediana/máx): ${report.messagesPerContact.min}/${report.messagesPerContact.median}/${report.messagesPerContact.max}`);
console.log(`Rango: ${report.range ? `${report.range.from} → ${report.range.to}` : "—"} · días: ${report.daysCovered.join(", ")}`);
console.log(`Actores: ${JSON.stringify(report.byActor)}`);
console.log(`Tipos: ${JSON.stringify(report.byKind)}`);
console.log(`Texto: ${JSON.stringify(report.textStatus)} (${report.withTextPct} % con texto)`);
console.log(`Duplicados: ${report.duplicateMessageIds} · fuera de orden por hora: ${report.seqOutOfOrderByTime} · replyTo huérfanos: ${report.replyToOrphans} · sin hora: ${report.missingTimestamp}`);

if (flag("verify-only")) process.exit(0);
if (report.total === 0) fail("Nada que seudonimizar.");

const built = buildFixture(read.messages);
write("pseudo.json", { generatedAt: new Date().toISOString(), conversations: built.conversations });
write("equivalences.private.json", built.equivalences);
write("residual-names.private.json", built.residualCandidates);
console.log(`\nSeudonimizado: ${built.conversations.length} conversaciones, ${built.conversations.reduce((sum, conversation) => sum + conversation.batches.length, 0)} lotes.`);
console.log(`Sustituciones: ${JSON.stringify(built.stats)}`);
console.log(`Textos con posible nombre residual (revisar a mano en residual-names.private.json): ${built.residualNameTexts}`);
console.log(`Salida en ${relative(root, dir).replaceAll("\\", "/")}/ (acceso solo para su usuario). equivalences.private.json es la tabla sensible: no la mueva ni la suba.`);
