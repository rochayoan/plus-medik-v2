// CALIBRACIÓN del verificador del modo sombra, SIN llamadas a modelos: se le "fuerza" una elección al verificador y se mide
//  (a) si bloquea los errores simulados que debe bloquear, y (b) si deja pasar las respuestas correctas (falsos rechazos).
import { verifyDecision, type Outcome, type RawDecision } from "../src/catalog-shadow.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import { ADVERSARIAL, GROUND_TRUTH } from "./data/shadow-ground-truth.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const catalog = await loadActiveCatalog();
const byCode = new Map(catalog.map((s) => [s.code as string, s]));
const forced = (status: RawDecision["status"], codes: string[], fragments: string[] = []): RawDecision => ({
  index: 0, status, studies: codes.map((c) => byCode.get(c)!), alternatives: [], fragments, reading: "", confidence: "high", reason: "", notes: []
});
const why = (o: Outcome) => (o.kind === "MATCH" ? `MATCH [${o.support}]` : `${o.kind}${"reason" in o ? ` | ${o.reason.slice(0, 90)}` : ""}`);

// ── (a) los 13 errores simulados originales: un MATCH equivocado o por defecto que DEBE bloquearse ──
const ORIGINAL_TRAPS: Array<[string, string]> = [
  ["TSH", "178"], ["TOXO IgG", "238"], ["TOXO IgM", "238"], ["Magnesio", "408"], ["Calcio", "374"], ["PSA Total", "257"],
  ["Amilasa pancreatica", "368"], ["Cortisol", "146"], ["T3", "168"], ["Insulina", "159"], ["Colesterol", "378"], ["Sodio", "415"], ["Glucosa en orina", "397"]
];
// ── trampas NUEVAS (no se usaron para afinar la regla): familias de estudios con la misma raíz ──
const EXTENDED_TRAPS: Array<[string, string]> = [
  ["Vitamina D", "537"], ["Hepatitis B", "208"], ["Anticardiolipina", "21"], ["Beta HCG", "144"], ["Toxo", "238"], ["Hormona de crecimiento", "155"],
  ["Potasio", "416"], ["IgG", "429"], ["Proteina S", "138"], ["Anti DNA", "27"], ["ANCA", "16"], ["Hemocultivo", "82"],
  ["Tincion de Gram", "88"], ["HCG", "450"], ["Herpes IgG", "222"], ["CK", "382"], ["Tiroxina", "174"]
];

function runTraps(label: string, traps: Array<[string, string]>) {
  console.log(`\n== ${label}`);
  let blocked = 0;
  const missed: string[] = [];
  for (const [text, code] of traps) {
    const out = verifyDecision(text, forced("MATCH", [code]), catalog);
    const ok = out.kind !== "MATCH";
    if (ok) blocked++; else missed.push(`"${text}"->${code}`);
    console.log(`${ok ? "BLOQUEA" : "PASA   "} "${text}" -> ${byCode.get(code)!.name.slice(0, 38)} : ${why(out)}`);
  }
  console.log(`-> bloqueados ${blocked} de ${traps.length}${missed.length ? ` | se escapan: ${missed.join(", ")}` : ""}`);
  return { blocked, total: traps.length, missed };
}

const original = runTraps("(a) los 13 errores simulados originales", ORIGINAL_TRAPS);
const extended = runTraps("(a2) trampas nuevas, no usadas para afinar", EXTENDED_TRAPS);

// ── (b) respuestas CORRECTAS: el verificador no debe rechazarlas ni degradarlas ──
function runCorrect(label: string, cases: Array<{ text: string; code: string; acceptAmbiguous: boolean }>) {
  console.log(`\n== ${label}`);
  let ok = 0;
  const bad: string[] = [];
  for (const { text, code, acceptAmbiguous } of cases) {
    const out = verifyDecision(text, forced("MATCH", [code]), catalog);
    const pass = out.kind === "MATCH" || (acceptAmbiguous && out.kind === "AMBIGUOUS");
    if (pass) ok++; else bad.push(`"${text}" -> ${why(out)}`);
    if (!pass || (out.kind !== "MATCH")) console.log(`${pass ? "ACEPTABLE" : "FALSO RECHAZO"} "${text}" -> ${why(out)}`);
  }
  console.log(`-> pasan ${ok} de ${cases.length}${bad.length ? `\n   falsos rechazos: ${bad.join("; ")}` : ""}`);
  return { ok, total: cases.length, bad };
}

const ORIGINALS: Record<string, string> = {};
const recipeCases = Object.entries(GROUND_TRUTH)
  .filter(([, t]) => t.kind === "MATCH" || t.kind === "MATCH_OR_AMBIGUOUS")
  .map(([norm, t]) => ({ text: ORIGINALS[norm] ?? norm, code: t.codes[0]!, acceptAmbiguous: t.kind === "MATCH_OR_AMBIGUOUS" }));
const adversarialCases = ADVERSARIAL.filter((a) => a.truth.kind === "MATCH" || a.truth.kind === "MATCH_OR_AMBIGUOUS")
  .map((a) => ({ text: a.text, code: a.truth.codes[0]!, acceptAmbiguous: a.truth.kind === "MATCH_OR_AMBIGUOUS" }));
const correctRecipes = runCorrect("(b) los 21 casos correctos de las recetas", recipeCases);
const correctAdversarial = runCorrect("(b2) casos correctos del conjunto adversarial", adversarialCases);

// equivalencias correctas ADICIONALES (calificadores redundantes, muestra explícita, variantes nombradas): tampoco deben degradarse
const EXTRA_CORRECT: Array<[string, string]> = [
  ["Calcio total", "374"], ["Calcio en suero", "374"], ["Calcio ionico", "373"], ["Cortisol en orina", "511"], ["Cortisol 4 PM", "147"],
  ["Insulina basal", "159"], ["Insulina post carga", "160"], ["Colesterol total", "378"], ["IgG Total", "429"], ["IgE Total", "428"],
  ["IgA Total", "426"], ["IgM Total", "430"], ["Glucosa postcarga", "399"], ["Glicemia postprandial", "400"], ["T3 libre", "168"],
  ["Tiroxina libre", "172"], ["Amilasa serica", "368"], ["Uricemia", "366"], ["Hemoglobina glicosilada", "401"], ["Proteinas totales", "410"]
];
const extraCorrect = runCorrect("(b3) equivalencias correctas adicionales", EXTRA_CORRECT.map(([text, code]) => ({ text, code, acceptAmbiguous: false })));

// compuestos con componentes correctos
console.log("\n== (c) compuestos con componentes correctos");
const composite = (text: string, norm: string, fragments: string[]) => {
  const out = verifyDecision(text, forced("COMPOSITE", GROUND_TRUTH[norm]!.codes, fragments), catalog);
  console.log(`${out.kind === "COMPOSITE" ? "OK " : "FALLA"} ${text} -> ${out.kind}`);
  return out.kind === "COMPOSITE";
};
const comps = [
  composite("TRANSAMINASAS GOT/GPT", normalizeStudyKey("TRANSAMINASAS GOT/GPT"), ["GOT", "GPT"]),
  composite("PERFIL LIPIDICO (COL, HDL, LDL, VLDL, TRIGLICERIDOS)", normalizeStudyKey("PERFIL LIPIDICO (COL, HDL, LDL, VLDL, TRIGLICERIDOS)"), ["COL", "HDL", "LDL", "VLDL", "TRIGLICERIDOS"])
];

console.log(`\nRESUMEN: errores originales bloqueados ${original.blocked}/${original.total} | trampas nuevas bloqueadas ${extended.blocked}/${extended.total} | correctos de recetas ${correctRecipes.ok}/${correctRecipes.total} | correctos adversarial ${correctAdversarial.ok}/${correctAdversarial.total} | correctos adicionales ${extraCorrect.ok}/${extraCorrect.total} | compuestos ${comps.filter(Boolean).length}/${comps.length}`);
