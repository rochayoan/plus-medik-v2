// FASE 3A — comparación en MODO SOMBRA sobre las recetas reales. No modifica el pipeline ni escribe en Supabase.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeImage, type AnalysisResult } from "../src/analyze.js";
import { shadowMatch, simulateShadowPolicy, supportOf, type FinalShadow, type Outcome, type SimulatedDecision } from "../src/catalog-shadow.js";
import { preselectCandidates } from "../src/catalog-semantic-resolver.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { readDocumentSignal, type DocumentSignal } from "../src/document-signal.js";
import { loadImageFile } from "../src/image.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import type { CatalogStudy } from "../src/types.js";
import { ADVERSARIAL, GROUND_TRUTH, type Truth } from "./data/shadow-ground-truth.js";
import { installPaidCallGuard } from "./lib/paid-guard.js";

// Estas pruebas pueden gastar dinero real: sin PLUSMEDIK_AUTHORIZE_PAID_CALLS=<USD> toda llamada real se bloquea (las respuestas en cache no).
installPaidCallGuard("shadow-match");

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const RECIPES = ["marcada1.jpeg", "marcada2.jpeg", "marcada3.jpg", "marcada4.jpeg", "receta.jpeg"];
const catalog = await loadActiveCatalog();
const byId = new Map(catalog.map((study) => [study.id, study]));
const byCode = new Map(catalog.filter((s) => s.code).map((s) => [s.code as string, s]));
const codeOf = (id: string) => byId.get(id)?.code ?? "?";

// Precios de tarifa para el costo (USD por millón de tokens), dados por el usuario para el catálogo.
const priceIn = Number(process.env.OPENAI_CATALOG_PRICE_INPUT_PER_MTOK ?? 2);
const priceOut = Number(process.env.OPENAI_CATALOG_PRICE_OUTPUT_PER_MTOK ?? 10);

type Verdict = "CORRECT" | "CORRECT_ABSTAIN" | "ACCEPTABLE_ABSTAIN" | "MISSED" | "WRONG";

function describeOutcome(o: Outcome): string {
  if (o.kind === "MATCH") return `MATCH ${codeOf(o.studyId)} ${byId.get(o.studyId)?.name.slice(0, 34)} [${o.support}]`;
  if (o.kind === "COMPOSITE") return `COMPOSITE ${o.components.map((c) => codeOf(c.studyId)).join("+")}`;
  if (o.kind === "AMBIGUOUS") return `AMBIGUOUS ${o.studyIds.map(codeOf).join("/")}`;
  if (o.kind === "REJECTED") return `REJECTED(verificador) ${o.studyIds.map(codeOf).join("/")}`;
  return "NO_MATCH";
}

function grade(truth: Truth, shadow: FinalShadow): Verdict {
  const o = shadow.outcome;
  const abstains = o.kind === "AMBIGUOUS" || o.kind === "NO_MATCH" || o.kind === "REJECTED" || !shadow.agreement;
  const single = o.kind === "MATCH" && shadow.agreement ? codeOf(o.studyId) : undefined;
  const composite = o.kind === "COMPOSITE" && shadow.agreement ? o.components.map((c) => codeOf(c.studyId)).sort().join("+") : undefined;
  const expected = [...truth.codes].sort().join("+");
  switch (truth.kind) {
    case "MATCH":
      if (single === truth.codes[0]) return "CORRECT";
      if (single || composite) return "WRONG";
      return "MISSED";
    case "MATCH_OR_AMBIGUOUS":
      if (single === truth.codes[0]) return "CORRECT";
      if (single || composite) return "WRONG";
      return "ACCEPTABLE_ABSTAIN";
    case "AMBIGUOUS":
      return single || composite ? "WRONG" : "CORRECT_ABSTAIN";
    case "NONE":
      return single || composite ? "WRONG" : "CORRECT_ABSTAIN";
    case "COMPOSITE":
      if (composite === expected) return "CORRECT";
      if (single || composite) return "WRONG";
      return abstains ? "MISSED" : "MISSED";
  }
}

interface Row {
  rawStatuses: string;
  intercepted: boolean;
  recipe: string;
  text: string;
  confidence: string;
  current: string;
  shadow: string;
  support: string;
  truth: string;
  verdict: Verdict;
  agreement: boolean;
  modelReading: string;
  notes: string;
  preselectionHadAnswer?: boolean;
}
const rows: Row[] = [];
const summaries: Array<{ document: DocumentSignal; recipe: string; analysis: AnalysisResult; shadowBatch: Awaited<ReturnType<typeof shadowMatch>>; strict: SimulatedDecision; withComposites: SimulatedDecision }> = [];
let tokensIn = 0, tokensOut = 0, tokensReasoning = 0, newCalls = 0, hits = 0, docTokensIn = 0, docTokensOut = 0;

for (const recipe of RECIPES) {
  const { imageBase64, mimeType } = await loadImageFile(join("private-data", recipe));
  const analysis = await analyzeImage({ imageBase64, mimeType, catalog });
  const doc = await readDocumentSignal({ imageBase64, mimeType });
  for (const usage of doc.usage) { tokensIn += usage.inputTokens ?? 0; tokensOut += usage.outputTokens ?? 0; tokensReasoning += usage.reasoningTokens ?? 0; docTokensIn += usage.inputTokens ?? 0; docTokensOut += usage.outputTokens ?? 0; }
  newCalls += doc.calls; hits += doc.cacheHits;
  const queries = analysis.finalVisualStudies.map((study) => ({ literalText: study.literalText }));
  const batch = await shadowMatch({ queries, catalog });
  for (const usage of batch.usage) { tokensIn += usage.inputTokens ?? 0; tokensOut += usage.outputTokens ?? 0; tokensReasoning += usage.reasoningTokens ?? 0; }
  newCalls += batch.calls; hits += batch.cacheHits;

  const studies = analysis.finalVisualStudies.map((s) => ({ literalText: s.literalText, confidence: s.confidence }));
  const common = { document: doc.signal, unresolvedVisualDisputes: analysis.unresolvedDisputes.length, studies, results: batch.results, catalog };
  const strict = simulateShadowPolicy({ ...common, allowExplicitComposites: false });
  const withComposites = simulateShadowPolicy({ ...common, allowExplicitComposites: true });
  summaries.push({ document: doc.signal, recipe, analysis, shadowBatch: batch, strict, withComposites });

  batch.results.forEach((result, i) => {
    const study = analysis.finalVisualStudies[i]!;
    const match = analysis.matches[i]!;
    const truth = GROUND_TRUTH[normalizeStudyKey(result.literalText)];
    const current = match.status === "MATCHED" ? `exacto/alias ${match.study?.code}`
      : match.status === "MODEL_SUGGESTED" ? `sugerido por GPT ${match.study?.code}`
      : match.semanticResolution ? `${match.semanticResolution.status} (2E)` : "UNMATCHED";
    const o = result.outcome;
    const matchedStudy = o.kind === "MATCH" ? byId.get(o.studyId) : undefined;
    const preselect = matchedStudy ? preselectCandidates({ literalText: result.literalText }, catalog) : undefined;
    const intercepted = result.modelNotes.rawStatuses.some((raw) => raw === "MATCH") && !(o.kind === "MATCH" && result.agreement);
    rows.push({
      rawStatuses: result.modelNotes.rawStatuses.join("/"), intercepted,
      recipe, text: result.literalText, confidence: study.confidence, current, shadow: describeOutcome(o),
      support: o.kind === "MATCH" ? o.support : o.kind === "COMPOSITE" ? o.components.map((c) => c.support).join("/") : "-",
      truth: truth ? `${truth.kind} ${truth.codes.join("+")}` : "SIN VERDAD DE TERRENO",
      verdict: truth ? grade(truth, result) : "MISSED", agreement: result.agreement,
      modelReading: result.modelNotes.reading,
      notes: o.kind === "AMBIGUOUS" || o.kind === "REJECTED" || o.kind === "NO_MATCH" ? o.reason : "",
      preselectionHadAnswer: preselect ? preselect.studies.some((s) => s.id === matchedStudy!.id) : undefined
    });
  });
}

// ─────────── informe ───────────
const money = (n: number) => `${n.toFixed(2)} Bs`;
console.log(`Catálogo activo: ${catalog.length} | modelo: ${summaries[0]?.shadowBatch.model} (${summaries[0]?.shadowBatch.reasoning}) | llamadas nuevas: ${newCalls} | cache HIT: ${hits}`);
for (const s of summaries) {
  const mine = rows.filter((r) => r.recipe === s.recipe);
  console.log(`\n══════ ${s.recipe} ══════`);
  console.log(`Tipo de documento (2 lecturas): ${s.document.documentType}${s.document.agreement ? "" : " (las lecturas NO coinciden)"} | completo: ${s.document.completeDocumentVisible} | ${s.document.reasons[0].slice(0, 150)}`);
  console.log(`Decisión ACTUAL: ${s.analysis.decision} [${s.analysis.reasons.join(", ")}] | subtotal actual exacto/alias: ${money(s.analysis.matches.filter((m) => m.status === "MATCHED").reduce((sum, m, _i, arr) => sum + (arr.findIndex((x) => x.study?.id === m.study?.id) === arr.indexOf(m) ? m.study!.priceBs : 0), 0))}`);
  for (const r of mine) {
    console.log(` ${r.verdict.padEnd(18)} "${r.text.slice(0, 44)}" [${r.confidence}]\n     actual: ${r.current}\n     sombra: ${r.shadow}${r.agreement ? "" : "  (pasadas NO coinciden)"}\n     verdad: ${r.truth}${r.notes ? `\n     motivo: ${r.notes.slice(0, 170)}` : ""}`);
  }
  console.log(` SOMBRA política estricta (compuestos → revisión): ${s.strict.decision} [${s.strict.reasons.join(", ")}] | subtotal verificado ${money(s.strict.verifiedSubtotalBs)} (${s.strict.verifiedLines.length} estudios)`);
  console.log(` SOMBRA compuestos explícitos permitidos:          ${s.withComposites.decision} [${s.withComposites.reasons.join(", ")}] | subtotal verificado ${money(s.withComposites.verifiedSubtotalBs)} (${s.withComposites.verifiedLines.length} estudios)`);
}

const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
console.log(`\n══════ TOTALES (${rows.length} estudios en 5 recetas) ══════`);
console.log(`CORRECT ${count("CORRECT")} | CORRECT_ABSTAIN ${count("CORRECT_ABSTAIN")} | ACCEPTABLE_ABSTAIN ${count("ACCEPTABLE_ABSTAIN")} | MISSED (abstención innecesaria) ${count("MISSED")} | WRONG (error de matching) ${count("WRONG")}`);
const currentOk = rows.filter((r) => r.current.startsWith("exacto/alias")).length;
console.log(`Resueltos por el sistema actual con exacto/alias: ${currentOk} | por GPT sombra con MATCH verificado y pasadas concordantes: ${rows.filter((r) => r.shadow.startsWith("MATCH") && r.agreement).length}`);
const sem = rows.filter((r) => r.preselectionHadAnswer !== undefined);
console.log(`Cobertura de la preselección léxica 2E sobre los MATCH de GPT: ${sem.filter((r) => r.preselectionHadAnswer).length} de ${sem.length} incluían el estudio correcto`);
console.log(`Recetas AUTO simuladas: estricta ${summaries.filter((s) => s.strict.decision === "AUTO_SAFE").length}/5 | con compuestos explícitos ${summaries.filter((s) => s.withComposites.decision === "AUTO_SAFE").length}/5 | actual ${summaries.filter((s) => s.analysis.decision === "AUTO_SAFE").length}/5`);
const matches = rows.filter((r) => r.shadow.startsWith("MATCH") && r.agreement);
const bySupport = (name: string) => matches.filter((r) => r.support === name).length;
console.log(`Soporte de los ${matches.length} MATCH verificados: EXACT ${bySupport("EXACT")} | LEXICAL ${bySupport("LEXICAL")} | SEMANTIC ${bySupport("SEMANTIC")} (sin exacto ni palabras del nombre)`);
console.log(`Pasadas que no coinciden en las recetas: ${rows.filter((r) => !r.agreement).length}`);
console.log(`Preselección léxica sin el estudio correcto: ${sem.filter((r) => !r.preselectionHadAnswer).map((r) => `"${r.text}" -> ${r.shadow}`).join("; ") || "ninguno"}`);
console.log(`Intervenciones del verificador en recetas (el modelo dijo MATCH y no quedó MATCH): ${rows.filter((r) => r.intercepted).length}${rows.filter((r) => r.intercepted).map((r) => `\n   "${r.text}": modelo ${r.rawStatuses} -> ${r.shadow}`).join("")}`);
console.log(`Señal de documento (10 lecturas): entrada ${docTokensIn} | salida ${docTokensOut} | costo $${((docTokensIn * priceIn + docTokensOut * priceOut) / 1_000_000).toFixed(4)}`);
const cost = (tokensIn * priceIn + tokensOut * priceOut) / 1_000_000;
console.log(`Tokens nuevos: entrada ${tokensIn} | salida ${tokensOut} (reasoning ${tokensReasoning}) | costo $${cost.toFixed(4)} (tarifa $${priceIn}/$${priceOut} por Mtok)`);

// ─────────── conjunto adversarial (no son recetas) ───────────
console.log("\n══════ CONJUNTO ADVERSARIAL (sinónimos, abreviaturas y textos genuinamente ambiguos) ══════");
const adv = await shadowMatch({ queries: ADVERSARIAL.map((a) => ({ literalText: a.text })), catalog });
for (const usage of adv.usage) { tokensIn += usage.inputTokens ?? 0; tokensOut += usage.outputTokens ?? 0; tokensReasoning += usage.reasoningTokens ?? 0; }
newCalls += adv.calls; hits += adv.cacheHits;
const advRows = adv.results.map((result, i) => {
  const truth = ADVERSARIAL[i]!.truth;
  return { rawStatuses: result.modelNotes.rawStatuses.join("/"), intercepted: result.modelNotes.rawStatuses.some((raw) => raw === "MATCH") && !(result.outcome.kind === "MATCH" && result.agreement), text: result.literalText, truth: `${truth.kind} ${truth.codes.join("+")}`, shadow: describeOutcome(result.outcome), agreement: result.agreement, verdict: grade(truth, result), reason: result.outcome.kind === "AMBIGUOUS" || result.outcome.kind === "REJECTED" || result.outcome.kind === "NO_MATCH" ? result.outcome.reason : "" };
});
for (const row of advRows) console.log(` ${row.verdict.padEnd(18)} "${row.text}" -> ${row.shadow}${row.agreement ? "" : " (pasadas NO coinciden)"} | verdad: ${row.truth}${row.verdict === "WRONG" || row.verdict === "MISSED" ? `\n     ${row.reason.slice(0, 160)}` : ""}`);
const advCount = (v: Verdict) => advRows.filter((r) => r.verdict === v).length;
console.log(`Intervenciones del verificador en el adversarial: ${advRows.filter((r) => r.intercepted).length}${advRows.filter((r) => r.intercepted).map((r) => `\n   "${r.text}": modelo ${r.rawStatuses} -> ${r.shadow}`).join("")}`);
console.log(`ADVERSARIAL (${advRows.length}): CORRECT ${advCount("CORRECT")} | CORRECT_ABSTAIN ${advCount("CORRECT_ABSTAIN")} | ACCEPTABLE_ABSTAIN ${advCount("ACCEPTABLE_ABSTAIN")} | MISSED ${advCount("MISSED")} | WRONG ${advCount("WRONG")}`);
const adversarialCost = (tokensIn * priceIn + tokensOut * priceOut) / 1_000_000;
console.log(`Tokens nuevos acumulados (recetas + adversarial): entrada ${tokensIn} | salida ${tokensOut} (reasoning ${tokensReasoning}) | costo $${adversarialCost.toFixed(4)}`);

const dir = join(process.cwd(), ".cache", "reports");
await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const path = join(dir, `catalog-shadow-${stamp}.json`);
await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), tokens: { in: tokensIn, out: tokensOut, reasoning: tokensReasoning }, costUsd: cost, rows, adversarial: advRows, recipes: summaries.map((s) => ({ recipe: s.recipe, document: s.document, current: s.analysis.decision, strict: s.strict, withComposites: s.withComposites })) }, null, 2));
console.log(`\nReporte: ${path}`);
