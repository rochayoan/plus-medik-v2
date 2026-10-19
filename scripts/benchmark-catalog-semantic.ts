// Benchmark controlado del resolvedor semántico de catálogo (FASE 2E). Sin imágenes ni Gemini.
// Lee el catálogo en solo lectura y llama a GPT únicamente para los textos que el matcher exacto/alias no resuelve.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExactAliasCatalogResolver } from "../src/catalog.js";
import { resolveCatalogSemantically, type SemanticBatchResult } from "../src/catalog-semantic-resolver.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import type { AiUsage } from "../src/cache.js";
import { installPaidCallGuard } from "./lib/paid-guard.js";

// Estas pruebas pueden gastar dinero real: sin PLUSMEDIK_AUTHORIZE_PAID_CALLS=<USD> toda llamada real se bloquea (las respuestas en cache no).
installPaidCallGuard("benchmark-catalog");

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const TEXTS = ["Prolactnia", "Hemog completo", "T4L", "TSH", "TOXO", "Beta HCG", "Cortisol", "PCR", "Hepatitis B", "Magnesio"];

// No hay tabla de precios propia: el costo solo se calcula si defines las tarifas (USD por millón de tokens).
const priceIn = Number(process.env.OPENAI_CATALOG_PRICE_INPUT_PER_MTOK);
const priceOut = Number(process.env.OPENAI_CATALOG_PRICE_OUTPUT_PER_MTOK);
const canPrice = Number.isFinite(priceIn) && Number.isFinite(priceOut) && process.env.OPENAI_CATALOG_PRICE_INPUT_PER_MTOK !== undefined;
const costOf = (usage?: AiUsage): number | undefined =>
  canPrice && usage ? ((usage.inputTokens ?? 0) * priceIn + (usage.outputTokens ?? 0) * priceOut) / 1_000_000 : undefined;

const catalog = await loadActiveCatalog();
const byId = new Map(catalog.map((study) => [study.id, study]));
const exact = new ExactAliasCatalogResolver(catalog);
const observation = (text: string) => ({ text, evidenceType: "PRINTED_TEXT" as const, certainty: "HIGH" as const, evidenceSummary: "benchmark" });

console.log(`Catálogo activo: ${catalog.length} estudios | modelo: ${process.env.OPENAI_CATALOG_MODEL ?? "gpt-6.1-sol"} | reasoning: ${process.env.OPENAI_CATALOG_REASONING ?? "medium"}`);
console.log(canPrice ? `Tarifas: entrada ${priceIn}/Mtok, salida ${priceOut}/Mtok` : "Tarifas no definidas: costo = n/d (defina OPENAI_CATALOG_PRICE_INPUT_PER_MTOK y OPENAI_CATALOG_PRICE_OUTPUT_PER_MTOK)");

interface Row {
  text: string;
  exact: string;
  exactStudy?: string;
  semantic?: {
    status: string;
    studyId?: string;
    studyName?: string;
    studyCode?: string | null;
    candidateStudyIds?: string[];
    candidateNames?: string[];
    confidence?: string;
    reason: string;
    note?: string;
    candidatesSent: number;
    candidateNamesSent: string[];
    truncated: boolean;
    fullCatalog: boolean;
  };
  usage?: AiUsage;
  costUsd?: number;
  cacheHit?: boolean;
}

function describe(result: SemanticBatchResult, index: number) {
  const item = result.items[index]!;
  const resolution = item.resolution;
  return {
    status: resolution.status,
    studyId: resolution.status === "MATCH" ? resolution.studyId : undefined,
    studyName: resolution.status === "MATCH" ? byId.get(resolution.studyId)?.name : undefined,
    studyCode: resolution.status === "MATCH" ? byId.get(resolution.studyId)?.code : undefined,
    candidateStudyIds: resolution.status === "AMBIGUOUS" ? resolution.candidateStudyIds : undefined,
    candidateNames: resolution.status === "AMBIGUOUS" ? resolution.candidateStudyIds.map((id) => byId.get(id)?.name ?? id) : undefined,
    confidence: resolution.status === "MATCH" ? resolution.confidence : undefined,
    reason: resolution.reason,
    note: item.note,
    candidatesSent: item.candidates.sent,
    candidateNamesSent: item.candidates.studyIds.map((id) => byId.get(id)?.name ?? id),
    truncated: item.candidates.truncated,
    fullCatalog: item.candidates.fullCatalog
  };
}

// 1) Matcher exacto/alias primero: si resuelve, NO se llama a GPT.
const rows: Row[] = [];
const toResolve: string[] = [];
for (const text of TEXTS) {
  const resolution = exact.resolve(observation(text));
  rows.push({
    text,
    exact: resolution.status,
    exactStudy: resolution.status === "MATCHED" ? `${resolution.study.code} ${resolution.study.name}` : undefined
  });
  if (resolution.status === "UNMATCHED") toResolve.push(text);
}

// 2) Una llamada INDIVIDUAL por texto (para medir tokens por caso).
const individual = await Promise.all(toResolve.map((text) => resolveCatalogSemantically({ queries: [{ literalText: text }], catalog })));
toResolve.forEach((text, i) => {
  const row = rows.find((candidate) => candidate.text === text)!;
  row.semantic = describe(individual[i]!, 0);
  row.usage = individual[i]!.usage;
  row.costUsd = costOf(individual[i]!.usage);
  row.cacheHit = individual[i]!.cacheHit;
});

// 3) Comparación: TODOS los no resueltos en UNA sola llamada.
const batch = await resolveCatalogSemantically({ queries: toResolve.map((text) => ({ literalText: text })), catalog });

// ----- salida -----
for (const row of rows) {
  console.log(`\n=== "${row.text}" ===`);
  if (!row.semantic) {
    console.log(`  matcher exacto/alias: ${row.exact}${row.exactStudy ? ` -> ${row.exactStudy}` : ""}  (NO se llamó a GPT)`);
    continue;
  }
  const s = row.semantic;
  console.log(`  matcher exacto/alias: ${row.exact} -> se consultó a GPT${row.cacheHit ? " (CACHE HIT)" : ""}`);
  const shown = s.candidateNamesSent.slice(0, 8).join("; ");
  console.log(`  candidatos enviados: ${s.candidatesSent}${s.fullCatalog ? " (catálogo completo)" : ""}${s.truncated ? " (truncado)" : ""} -> ${shown}${s.candidatesSent > 8 ? `; … +${s.candidatesSent - 8}` : ""}`);
  console.log(`  resultado: ${s.status}${s.studyId ? ` | ${s.studyCode} ${s.studyName} | UUID ${s.studyId} | confidence ${s.confidence}` : ""}`);
  if (s.candidateNames) console.log(`  ambiguos entre: ${s.candidateNames.join("; ")}`);
  console.log(`  reason: ${s.reason}`);
  if (s.note) console.log(`  nota del código: ${s.note}`);
  const u = row.usage;
  console.log(`  tokens: entrada ${u?.inputTokens ?? "n/d"} | salida ${u?.outputTokens ?? "n/d"} | reasoning ${u?.reasoningTokens ?? "n/d"} | costo ${row.costUsd !== undefined ? `$${row.costUsd.toFixed(5)}` : "n/d"}`);
}

const sum = (pick: (usage: AiUsage) => number | undefined) => rows.reduce((total, row) => total + (row.usage ? pick(row.usage) ?? 0 : 0), 0);
const totalIn = sum((u) => u.inputTokens);
const totalOut = sum((u) => u.outputTokens);
const totalReasoning = sum((u) => u.reasoningTokens);
const totalCost = rows.reduce((total, row) => total + (row.costUsd ?? 0), 0);
const calls = toResolve.length;

console.log("\n=== TOTALES (llamadas individuales) ===");
console.log(`textos: ${TEXTS.length} | resueltos por matcher exacto/alias sin GPT: ${TEXTS.length - calls} | llamadas a GPT: ${calls}`);
console.log(`tokens entrada ${totalIn} | salida ${totalOut} (de los cuales reasoning ${totalReasoning})`);
if (canPrice) console.log(`costo total $${totalCost.toFixed(5)} | promedio por llamada $${(totalCost / Math.max(calls, 1)).toFixed(5)} | promedio por texto de la receta $${(totalCost / TEXTS.length).toFixed(5)}`);
else console.log("costo total / promedio: n/d (sin tarifas)");

console.log("\n=== COMPARACIÓN: los mismos textos en UNA sola llamada ===");
const batchCost = costOf(batch.usage);
console.log(`candidatos únicos enviados: ${batch.candidatesSentToModel} | cacheHit: ${batch.cacheHit}`);
console.log(`tokens entrada ${batch.usage?.inputTokens ?? "n/d"} | salida ${batch.usage?.outputTokens ?? "n/d"} | reasoning ${batch.usage?.reasoningTokens ?? "n/d"} | costo ${batchCost !== undefined ? `$${batchCost.toFixed(5)}` : "n/d"}`);
let agree = 0;
toResolve.forEach((text, i) => {
  const solo = rows.find((row) => row.text === text)!.semantic!;
  const together = describe(batch, i);
  const same = solo.status === together.status && solo.studyId === together.studyId;
  if (same) agree++;
  console.log(`  ${same ? "=" : "≠"} "${text}": individual ${solo.status}${solo.studyCode ? ` ${solo.studyCode}` : ""} | en lote ${together.status}${together.studyCode ? ` ${together.studyCode}` : ""}`);
});
console.log(`coinciden ${agree}/${toResolve.length}`);

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const dir = join(process.cwd(), ".cache", "reports");
await mkdir(dir, { recursive: true });
const path = join(dir, `catalog-semantic-benchmark-${stamp}.json`);
await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), model: batch.model, reasoning: batch.reasoning, rows, batch: { usage: batch.usage, candidatesSentToModel: batch.candidatesSentToModel, items: batch.items.map((_, i) => describe(batch, i)) } }, null, 2));
console.log(`\nReporte completo: ${path}`);
