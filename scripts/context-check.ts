// Validación del matching contextual y de la integridad por borde: antes (sin contexto ni verificación de bordes) vs después.
// Ambas corridas comparten lectores, juez y las dos lecturas de documento; solo cambia lo que se evalúa. Banderas semánticas solo en esta prueba.
// No modifica Supabase, aliases ni políticas.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeImage, defaultAnalyzeDeps, type AnalysisResult, type AnalyzeDeps } from "../src/analyze.js";
import { readDocumentSignal } from "../src/document-signal.js";
import { loadImageFile } from "../src/image.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import { installPaidCallGuard } from "./lib/paid-guard.js";

// Estas pruebas pueden gastar dinero real: sin PLUSMEDIK_AUTHORIZE_PAID_CALLS=<USD> toda llamada real se bloquea (las respuestas en cache no).
installPaidCallGuard("context-check");

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const IMAGES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["r10.png", "marcada1.jpeg", "marcada2.jpeg", "marcada3.jpg", "marcada4.jpeg", "receta.jpeg"];
const catalog = await loadActiveCatalog();
const memo = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
  let value: Promise<R> | undefined;
  return (...args: A) => (value ??= fn(...args));
};
const money = (n: number) => `${n.toFixed(2)} Bs`;

interface Row { text: string; contrast: string; detail: string; price?: number }
function rowsOf(result: AnalysisResult): Row[] {
  return result.matches.map((m) => {
    const info = m.semanticPrimary;
    const ids = info?.studyIds ?? [];
    const codes = ids.map((id) => result.matches.flatMap((x) => [x.study, ...(x.components ?? [])]).find((s) => s?.id === id)?.code ?? "?");
    const priced = (m.components ?? (m.study ? [m.study] : [])).reduce((s, c) => s + c.priceBs, 0);
    return { text: m.matchedText, contrast: info?.contrast ?? m.status, detail: `${info?.kind ?? m.status}${codes.length ? " " + codes.join("+") : ""}${info?.reason && info.contrast !== "CONFIRMS_EXACT" ? " | " + info.reason.slice(0, 80) : ""}`, price: info?.contrast === "SEMANTIC_ONLY" || info?.contrast === "CONFIRMS_EXACT" || info?.contrast === "SEMANTIC_COMPOSITE" ? priced : undefined };
  });
}

const summary: Array<Record<string, unknown>> = [];
for (const file of IMAGES) {
  const image = await loadImageFile(join("private-data", file));
  const baseDeps: AnalyzeDeps = {
    ...defaultAnalyzeDeps,
    readGemini: memo(defaultAnalyzeDeps.readGemini),
    readOpenAI: memo(defaultAnalyzeDeps.readOpenAI),
    judge: memo(defaultAnalyzeDeps.judge)
  };
  const rawDocument = memo(async () => readDocumentSignal({ ...image, deps: {} }));
  const noEdges = memo(async () => readDocumentSignal({ ...image, deps: { verifyEdges: undefined } }));
  const beforeDeps: AnalyzeDeps = {
    ...baseDeps,
    // ANTES: sin verificación de bordes y sin contexto
    readDocument: async () => {
      const r = await noEdges();
      return { signal: { ...r.signal, context: undefined } };
    }
  };
  const afterDeps: AnalyzeDeps = { ...baseDeps, readDocument: async () => ({ signal: (await rawDocument()).signal }) };

  const before = await analyzeImage({ ...image, catalog, semanticPrimary: true, semanticAuto: true }, beforeDeps);
  const after = await analyzeImage({ ...image, catalog, semanticPrimary: true, semanticAuto: true }, afterDeps);
  const doc = after.document;

  console.log(`\n══════════════ ${file} ══════════════`);
  console.log(`CONTEXTO impreso entregado a GPT: ${doc?.context?.lines.length ? doc.context.lines.map((l) => `"${l.slice(0, 70)}"`).join(" | ") : "(ninguno)"}`);
  console.log(`  declaraciones verificadas: muestra=${doc?.context?.muestra ?? "-"} recolección=${doc?.context?.tiempo ?? "-"}${doc?.context?.conflicts.length ? " | conflictos: " + doc.context.conflicts.join("; ") : ""}`);
  console.log(`DOCUMENTO antes:   completo=${before.document?.completeDocumentVisible} ${before.document?.integrityProblems?.length ? "| " + before.document.integrityProblems.map((p) => p.slice(0, 80)).join(" ; ") : ""}`);
  console.log(`DOCUMENTO después: completo=${doc?.completeDocumentVisible} verificados=[${doc?.verifiedEdges?.join(",") ?? ""}] ${doc?.integrityProblems?.length ? "| " + doc.integrityProblems.map((p) => p.slice(0, 80)).join(" ; ") : ""}${doc?.edgeNotes?.length ? " | notas: " + doc.edgeNotes.join(" ; ").slice(0, 200) : ""}`);
  const rowsBefore = rowsOf(before);
  const rowsAfter = rowsOf(after);
  for (let i = 0; i < rowsAfter.length; i++) {
    const b = rowsBefore.find((r) => r.text === rowsAfter[i]!.text);
    const a = rowsAfter[i]!;
    const changed = b && (b.contrast !== a.contrast || b.detail !== a.detail);
    console.log(` ${changed ? "CAMBIA" : "igual "} "${a.text.slice(0, 40)}"\n        antes:   ${b?.contrast} ${b?.detail}\n        después: ${a.contrast} ${a.detail}${a.price !== undefined ? ` (${a.price} Bs)` : ""}`);
  }
  console.log(`DECISIÓN antes:   ${before.decision} [${before.reasons.join(", ")}]`);
  console.log(`DECISIÓN después: ${after.decision} [${after.reasons.join(", ")}]`);
  if (after.quote) {
    console.log("COTIZACIÓN AUTO:");
    for (const line of after.quote.lines) console.log(`   ${String(line.code).padEnd(4)} ${line.name.padEnd(40)} ${String(line.priceBs).padStart(6)} Bs  ${line.id}`);
    console.log(`   TOTAL ${money(after.quote.totalBs)} (${after.quote.lines.length} líneas)`);
  }
  summary.push({ file, before: { decision: before.decision, reasons: before.reasons, complete: before.document?.completeDocumentVisible }, after: { decision: after.decision, reasons: after.reasons, complete: doc?.completeDocumentVisible, verifiedEdges: doc?.verifiedEdges, context: doc?.context, quote: after.quote } });
}

const dir = join(process.cwd(), ".cache", "reports");
await mkdir(dir, { recursive: true });
const path = join(dir, `context-check-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}.json`);
await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), summary }, null, 2));
console.log(`\nReporte: ${path}`);
