// FASE 3D — validación local del primer AUTO semántico. Solo pruebas: las banderas se pasan por argumento, nunca se encienden globalmente.
//  1) Las cinco recetas reales con CATALOG_SEMANTIC_PRIMARY + CATALOG_SEMANTIC_AUTO: ninguna se fuerza a AUTO; se listan los bloqueos.
//  2) Subconjuntos CONTROLADOS (no son recetas reales): los estudios de una receta real que sí superan todas las verificaciones, sin
//     las filas bloqueadas, con GPT real sobre el catálogo real y la señal de documento real de esa receta.
//  3) Referencia independiente: otra llamada a GPT con un prompt distinto (catálogo con códigos y precios) que decide los estudios y se
//     compara contra las líneas y el total de la cotización. El total de la referencia lo suma este script desde el catálogo.
// No modifica Supabase, aliases, modelos ni prompts del pipeline.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { analyzeImage, assembleAnalysis, defaultAnalyzeDeps, type AnalysisResult, type AnalyzeDeps } from "../src/analyze.js";
import { cachedAiCall, usageFromResponses } from "../src/cache.js";
import { buildSimpleConsensus } from "../src/consensus.js";
import { loadImageFile } from "../src/image.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import type { CatalogStudy } from "../src/types.js";
import { installPaidCallGuard } from "./lib/paid-guard.js";

// Estas pruebas pueden gastar dinero real: sin PLUSMEDIK_AUTHORIZE_PAID_CALLS=<USD> toda llamada real se bloquea (las respuestas en cache no).
installPaidCallGuard("semantic-auto-check");

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const RECIPES = ["marcada1.jpeg", "marcada2.jpeg", "marcada3.jpg", "marcada4.jpeg", "receta.jpeg", "r10.png"];
const SUBSETS = ["r10.png", "marcada4.jpeg", "marcada1.jpeg"];
const catalog = await loadActiveCatalog();
const byId = new Map(catalog.map((study) => [study.id, study]));
const byCode = new Map(catalog.filter((s) => s.code).map((s) => [s.code as string, s]));
const money = (n: number) => `${n.toFixed(2)} Bs`;
const memo = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
  let value: Promise<R> | undefined;
  return (...args: A) => (value ??= fn(...args));
};

// ───────────────────────── referencia independiente (solo auditoría; no es parte del pipeline)
const referenceSchema = z.object({
  items: z.array(z.object({ index: z.number().int(), codes: z.array(z.string()), verdict: z.enum(["RESOLVED", "AMBIGUOUS", "NOT_IN_CATALOG"]), note: z.string() })),
  statedTotalBs: z.number()
});
const referencePrompt = (texts: string[]) => `
Eres un auditor independiente de cotizaciones de laboratorio. Recibes los estudios que un paciente marcó en una solicitud (texto tal como
se lee en el formulario) y la lista de precios COMPLETA del laboratorio (código | nombre | precio en Bs).
Para cada texto indica los códigos de la lista que corresponden exactamente a lo pedido:
- RESOLVED: lo pedido corresponde sin duda a uno o más estudios de la lista. Si el texto nombra explícitamente varios estudios
  (p. ej. "GOT/GPT"), devuelve un código por cada uno. Nunca agregues estudios que el texto no nombre.
- AMBIGUOUS: dos o más estudios de la lista podrían ser lo pedido y el texto no permite elegir (codes = los candidatos).
- NOT_IN_CATALOG: ningún estudio de la lista es lo pedido (codes = []).
Después, en statedTotalBs, suma los precios de la lista de los estudios RESOLVED, contando una sola vez cada código repetido.
No uses el diagnóstico ni conocimiento clínico para completar lo que el texto no dice.

LISTA DE PRECIOS:
${catalog.map((s) => `${s.code ?? "?"} | ${s.name} | ${s.priceBs}`).join("\n")}

TEXTOS MARCADOS:
${JSON.stringify(texts.map((text, index) => ({ index, text })))}
`;

async function independentReference(texts: string[]) {
  const model = process.env.OPENAI_REFERENCE_MODEL ?? process.env.OPENAI_READER_MODEL ?? "gpt-6.1-sol";
  const { $schema: _ignored, ...schema } = z.toJSONSchema(referenceSchema);
  const params = {
    model,
    reasoning: { effort: (process.env.OPENAI_REFERENCE_REASONING ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" },
    text: { format: { type: "json_schema" as const, name: "independent_quote_reference", strict: true, schema } }
  };
  const prompt = referencePrompt(texts);
  return cachedAiCall({
    label: "openai-quote-reference",
    provider: "openai",
    model,
    imageBase64: "",
    config: { prompt, params },
    parse: (raw) => referenceSchema.parse(raw),
    call: async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is required (define it in .env)");
      const response = await new OpenAI({ apiKey }).responses.create({ ...params, input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }] });
      return { value: referenceSchema.parse(JSON.parse(response.output_text)), usage: usageFromResponses(response.usage) };
    }
  });
}

const codeOf = (id: string) => byId.get(id)?.code ?? "?";
const memoDeps = (): AnalyzeDeps => ({
  ...defaultAnalyzeDeps,
  readGemini: memo(defaultAnalyzeDeps.readGemini),
  readOpenAI: memo(defaultAnalyzeDeps.readOpenAI),
  judge: memo(defaultAnalyzeDeps.judge),
  readDocument: memo(defaultAnalyzeDeps.readDocument)
});

let anyAuto = 0;
const report: unknown[] = [];

// ───────────────────────── 1) recetas reales con ambas banderas
console.log("══════ 1) CINCO RECETAS REALES (CATALOG_SEMANTIC_PRIMARY + CATALOG_SEMANTIC_AUTO, solo en esta prueba) ══════");
const analyses = new Map<string, AnalysisResult>();
const imagesByRecipe = new Map<string, { imageBase64: string; mimeType: string }>();
for (const recipe of RECIPES) {
  const image = await loadImageFile(join("private-data", recipe));
  imagesByRecipe.set(recipe, image);
  const result = await analyzeImage({ ...image, catalog, semanticPrimary: true, semanticAuto: true }, memoDeps());
  analyses.set(recipe, result);
  if (result.decision === "AUTO_SAFE") anyAuto++;
  console.log(`\n${recipe}: ${result.decision} [${result.reasons.join(", ")}]${result.quote ? ` total ${money(result.quote.totalBs)}` : ""}`);
  const blockers = result.matches.filter((m) => !["CONFIRMS_EXACT", "SEMANTIC_ONLY", "SEMANTIC_COMPOSITE"].includes(m.semanticPrimary?.contrast ?? ""));
  for (const m of blockers) console.log(`   bloquea: "${m.matchedText.slice(0, 48)}" -> ${m.semanticPrimary?.kind} ${m.semanticPrimary?.reason?.slice(0, 90) ?? ""}`);
  report.push({ recipe, decision: result.decision, reasons: result.reasons });
}
console.log(`\nRecetas reales que quedaron AUTO_SAFE: ${anyAuto} de ${RECIPES.length}${anyAuto === 0 ? " (ninguna receta real cumple todas las condiciones; no se fuerza AUTO)" : ""}`);

// ───────────────────────── 2) subconjuntos controlados + 3) referencia independiente
for (const recipe of SUBSETS) {
  const full = analyses.get(recipe)!;
  const image = imagesByRecipe.get(recipe)!;
  const eligible = full.finalVisualStudies.filter((study) => {
    const match = full.matches.find((m) => m.matchedText === study.literalText);
    return study.confidence === "high" && ["CONFIRMS_EXACT", "SEMANTIC_ONLY", "SEMANTIC_COMPOSITE"].includes(match?.semanticPrimary?.contrast ?? "");
  });
  const excluded = full.finalVisualStudies.filter((study) => !eligible.includes(study));
  console.log(`\n══════ 2) SUBCONJUNTO CONTROLADO de ${recipe} (NO es una receta real) ══════`);
  console.log(`Se conservan ${eligible.length} estudios reales de la receta y se excluyen ${excluded.length} bloqueados: ${excluded.map((s) => `"${s.literalText.slice(0, 40)}"`).join(", ") || "ninguno"}`);

  const reader = { requestedStudies: eligible.map(({ source: _s, ...study }) => study), uncertainStudies: [], notes: "" };
  const texts = [...new Set(eligible.map((s) => s.literalText))];
  const batch = await defaultAnalyzeDeps.shadowMatch({ queries: texts.map((literalText) => ({ literalText })), catalog });
  const subset = assembleAnalysis({
    consensus: buildSimpleConsensus(reader, reader),
    judgement: { resolvedStudies: [], unresolvedDisputes: [] },
    catalog,
    document: full.document,
    primary: { batch },
    semanticAuto: true
  });
  console.log(`Documento real: ${full.document?.documentType} completo=${full.document?.completeDocumentVisible} | decisión: ${subset.decision} [${subset.reasons.join(", ")}]`);
  if (!subset.quote) {
    console.log("Sin cotización AUTO.");
    report.push({ recipe, subset: true, decision: subset.decision, reasons: subset.reasons });
    continue;
  }
  const quote = subset.quote;
  console.log("COTIZACIÓN AUTO (prueba controlada):");
  for (const line of quote.lines) {
    const origin = quote.audit?.find((a) => a.id === line.id);
    console.log(`   ${String(line.code).padEnd(4)} ${line.id}  ${line.name.padEnd(36)} ${String(line.priceBs).padStart(6)} Bs   [${origin?.basis.join("+")}] <- ${origin?.texts.map((t) => `"${t.slice(0, 34)}"`).join(", ")}`);
  }
  console.log(`   Subtotal = suma de líneas = ${money(quote.lines.reduce((s, l) => s + l.priceBs, 0))} | Total = ${money(quote.totalBs)} | tarifa ${quote.tariff} | líneas: ${quote.lines.length}`);
  const unique = new Set(quote.lines.map((l) => l.id)).size === quote.lines.length;
  const pricesFromCatalog = quote.lines.every((l) => byId.get(l.id)?.priceBs === l.priceBs);
  console.log(`   Sin duplicados: ${unique} | precios idénticos al catálogo de Supabase: ${pricesFromCatalog}`);

  // referencia independiente
  const ref = await independentReference(texts);
  console.log("REFERENCIA INDEPENDIENTE (otra llamada a GPT, otro prompt, catálogo con códigos y precios):");
  const ourCodes = new Set(quote.lines.map((l) => l.code as string));
  const refCodes = new Set<string>();
  let perStudyOk = true;
  for (const item of ref.items.sort((a, b) => a.index - b.index)) {
    const text = texts[item.index] ?? "?";
    const mine = subset.matches.find((m) => m.matchedText === text)?.semanticPrimary;
    const myCodes = (mine?.studyIds ?? []).map(codeOf).sort();
    const theirs = [...item.codes].sort();
    const same = item.verdict === "RESOLVED" && myCodes.join("+") === theirs.join("+");
    if (!same) perStudyOk = false;
    if (item.verdict === "RESOLVED") item.codes.forEach((c) => refCodes.add(c));
    console.log(`   ${same ? "COINCIDE " : "DIFIERE  "} "${text.slice(0, 44)}" pipeline=${myCodes.join("+")} referencia=${item.verdict} ${theirs.join("+")}${same ? "" : ` | ${item.note.slice(0, 120)}`}`);
  }
  const refTotal = [...refCodes].reduce((sum, code) => sum + (byCode.get(code)?.priceBs ?? 0), 0);
  const codesEqual = ourCodes.size === refCodes.size && [...ourCodes].every((c) => refCodes.has(c));
  console.log(`   Códigos pipeline = referencia: ${codesEqual} | total pipeline ${money(quote.totalBs)} | total referencia (suma desde el catálogo) ${money(refTotal)} | total que declaró el modelo ${money(ref.statedTotalBs)}`);
  console.log(`   VERIFICACIÓN: estudios ${perStudyOk && codesEqual ? "OK" : "FALLA"} | importe ${quote.totalBs === refTotal ? "OK" : "FALLA"} | aritmética del modelo ${ref.statedTotalBs === refTotal ? "OK" : "DIFIERE"}`);
  report.push({ recipe, subset: true, decision: subset.decision, quote, referenceTotal: refTotal, statedTotal: ref.statedTotalBs, codesEqual, perStudyOk });
}

// ───────────────────────── control negativo: lo que el pipeline bloquea, la referencia independiente también lo debe ver bloqueado
console.log("\n══════ CONTROL NEGATIVO (los textos que bloquean las recetas reales) ══════");
const negatives = ["NITROGENO UREICO/UREA/NUS", "AMILASA PANCREATICA", "Perfil Tiroideo", "PERFIL LIPIDICO (COL, HDL, LDL, VLDL, TRIGLICERIDOS)"];
const negativeRef = await independentReference(negatives);
for (const item of negativeRef.items.sort((x, y) => x.index - y.index)) {
  console.log(`   "${negatives[item.index]!.slice(0, 50)}" -> referencia: ${item.verdict} ${item.codes.join("+")} | ${item.note.slice(0, 110)}`);
}

const dir = join(process.cwd(), ".cache", "reports");
await mkdir(dir, { recursive: true });
const path = join(dir, `semantic-auto-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}.json`);
await writeFile(path, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
console.log(`\nReporte: ${path}`);
