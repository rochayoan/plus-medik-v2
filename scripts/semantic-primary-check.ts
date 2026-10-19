// FASE 3B — validación de la integración semántica principal (solo pruebas; la bandera nunca se enciende en producción).
// Por receta: flujo clásico (bandera apagada) vs flujo con CATALOG_SEMANTIC_PRIMARY (bandera encendida) vs modo sombra independiente.
// Las dos corridas comparten las mismas lecturas (lectores, juez, documento) para que la única diferencia sea el matching.
// No modifica Supabase, aliases ni el safety de producción.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeImage, defaultAnalyzeDeps, type AnalysisResult, type AnalyzeDeps } from "../src/analyze.js";
import { shadowMatch, simulateShadowPolicy, type FinalShadow, type Outcome } from "../src/catalog-shadow.js";
import { loadImageFile } from "../src/image.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import { installPaidCallGuard } from "./lib/paid-guard.js";

// Estas pruebas pueden gastar dinero real: sin PLUSMEDIK_AUTHORIZE_PAID_CALLS=<USD> toda llamada real se bloquea (las respuestas en cache no).
installPaidCallGuard("semantic-primary-check");

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const ALL = ["marcada1.jpeg", "marcada2.jpeg", "marcada3.jpg", "marcada4.jpeg", "receta.jpeg"];
const recipes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL;
const catalog = await loadActiveCatalog();
const byId = new Map(catalog.map((study) => [study.id, study]));
const codeOf = (id: string) => byId.get(id)?.code ?? "?";

const memo = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
  let value: Promise<R> | undefined;
  return (...args: A) => (value ??= fn(...args));
};
const idsOf = (o: Outcome): string[] =>
  o.kind === "MATCH" ? [o.studyId] : o.kind === "COMPOSITE" ? o.components.map((c) => c.studyId) : o.kind === "NO_MATCH" ? [] : o.studyIds;
const describe = (kind: string, ids: string[]) => `${kind}${ids.length > 0 ? " " + ids.map(codeOf).join("/") : ""}`;
const money = (n: number) => `${n.toFixed(2)} Bs`;

let regressions = 0;
let wiringErrors = 0;
const report: unknown[] = [];

for (const recipe of recipes) {
  const { imageBase64, mimeType } = await loadImageFile(join("private-data", recipe));
  const base = defaultAnalyzeDeps;
  const deps: AnalyzeDeps = {
    ...base,
    readGemini: memo(base.readGemini),
    readOpenAI: memo(base.readOpenAI),
    judge: memo(base.judge),
    readDocument: memo(base.readDocument)
  };
  const classic: AnalysisResult = await analyzeImage({ imageBase64, mimeType, catalog, semanticPrimary: false }, deps);
  const primary: AnalysisResult = await analyzeImage({ imageBase64, mimeType, catalog, semanticPrimary: true }, deps);

  // Modo sombra independiente sobre los mismos textos (debe coincidir con lo integrado).
  const shadow = await shadowMatch({ queries: primary.finalVisualStudies.map((s) => ({ literalText: s.literalText })), catalog });
  const sim = simulateShadowPolicy({
    document: primary.document,
    unresolvedVisualDisputes: primary.unresolvedDisputes.length,
    studies: primary.finalVisualStudies.map((s) => ({ literalText: s.literalText, confidence: s.confidence })),
    results: shadow.results,
    catalog,
    allowExplicitComposites: false
  });

  console.log(`\n══════ ${recipe} ══════`);
  console.log(`documento: ${primary.document?.documentType} completo=${primary.document?.completeDocumentVisible}${primary.document?.integrityProblems?.length ? " | " + primary.document.integrityProblems[0]!.slice(0, 110) : ""}`);
  console.log(`CLÁSICO (bandera apagada): ${classic.decision} [${classic.reasons.join(", ")}]${classic.quote ? ` total ${money(classic.quote.totalBs)}` : ""}`);
  console.log(`INTEGRADO (bandera encendida): ${primary.decision} [${primary.reasons.join(", ")}]${primary.quote ? ` total ${money(primary.quote.totalBs)}` : ""}`);
  const candidate = primary.semanticPrimary?.autoCandidate;
  console.log(`  candidato a AUTO semántico (sin autorizar): ${candidate?.decision} [${candidate?.reasons.join(", ")}]${candidate?.quote ? ` total ${money(candidate.quote.totalBs)} (${candidate.quote.lines.length} estudios)` : ""}`);
  if (candidate?.quote) for (const line of candidate.quote.lines) console.log(`    candidato línea: ${line.code} ${line.name} ${line.priceBs} Bs`);
  console.log(`  sombra independiente (política estricta):   ${sim.decision} [${sim.reasons.join(", ")}] verificado ${money(sim.verifiedSubtotalBs)} (${sim.verifiedLines.length} estudios)`);

  const perStudy = primary.matches.map((match, i) => {
    const mine = match.semanticPrimary!;
    const theirs: FinalShadow = shadow.results[i]!;
    const sameAsShadow = mine.kind === theirs.outcome.kind && [...mine.studyIds].sort().join("|") === idsOf(theirs.outcome).sort().join("|") && mine.agreement === theirs.agreement;
    if (!sameAsShadow) wiringErrors++;
    const exact = match.status === "SEMANTIC_CANDIDATE" ? "UNMATCHED" : match.status;
    console.log(`  ${mine.contrast.padEnd(18)} "${match.matchedText.slice(0, 40)}" exacto=${exact}${match.status === "MATCHED" ? " " + match.study?.code : ""} | semántico=${describe(mine.kind, mine.studyIds)}${mine.support ? ` [${mine.support}]` : ""}${mine.agreement ? "" : " (pasadas NO coinciden)"}${sameAsShadow ? "" : "  <<< DIFIERE DE SOMBRA"}`);
    for (const component of match.components ?? []) console.log(`      └ "${component.fragment}" -> ${component.code} ${component.name} (${component.priceBs} Bs) ${component.id}`);
    return { literalText: match.matchedText, exact, contrast: mine.contrast, semantic: describe(mine.kind, mine.studyIds), sameAsShadow };
  });

  // Regresiones: la integración nunca puede ser más permisiva que el flujo clásico, ni cambiar una cotización AUTO.
  const laxer = primary.decision === "AUTO_SAFE" && classic.decision !== "AUTO_SAFE";
  const quoteChanged = primary.decision === "AUTO_SAFE" && classic.decision === "AUTO_SAFE" && JSON.stringify(primary.quote) !== JSON.stringify(classic.quote);
  const lostCandidate = classic.decision === "AUTO_SAFE" && primary.decision !== "AUTO_SAFE";
  // El candidato semántico debe coincidir con la política simulada de sombra salvo contradicciones con el exacto.
  const contradictions = primary.matches.filter((m) => m.semanticPrimary?.contrast === "CONTRADICTS_EXACT").length;
  const shadowAgrees = contradictions > 0 || candidate?.decision === sim.decision;
  if (laxer || quoteChanged) regressions++;
  console.log(`  verificación: más permisivo que el clásico=${laxer} | cotización AUTO alterada=${quoteChanged} | AUTO clásico perdido por el contraste=${lostCandidate} | candidato = sombra=${shadowAgrees}`);
  report.push({ recipe, classic: { decision: classic.decision, reasons: classic.reasons, quote: classic.quote }, primary: { decision: primary.decision, reasons: primary.reasons, quote: primary.quote, candidate }, shadow: sim, perStudy, laxer, quoteChanged, lostCandidate, shadowAgrees });
}

console.log(`\nRegresiones (integrado más permisivo o cotización alterada): ${regressions} | diferencias con la sombra independiente: ${wiringErrors}`);
const dir = join(process.cwd(), ".cache", "reports");
await mkdir(dir, { recursive: true });
const path = join(dir, `semantic-primary-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}.json`);
await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), regressions, wiringErrors, report }, null, 2));
console.log(`Reporte: ${path}`);
