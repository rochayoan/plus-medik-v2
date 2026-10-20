import { assembleAnalysis, type DocumentGate } from "../../src/analyze.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../../src/consensus.js";
import type { CatalogStudy } from "../../src/types.js";

// GENERADOR ADVERSARIAL de la herencia de analito: líneas con uno o varios analitos inventados, con marcas de aceptado/rechazado, negaciones y condiciones,
// y las filas tal como un lector podría devolverlas (con y sin una fila que nombre el analito). La verdad se conoce por construcción. Semilla fija.
// NO prueba la visión: las lecturas ya vienen dadas. Regla obligatoria: jamás se cotiza un estudio que no se pidió (variante de otro analito, rechazada, tachada, negada o condicional).

let seed = 20261020;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)]!;
const shuffle = <T,>(list: T[]): T[] => { const copy = [...list]; for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; } return copy; };

const ANALYTES = ["Zetaina", "Anti-lambda", "Gamaina", "Proteina Qu", "Factor Omega", "Kappaina", "Sigmaina", "Anti-rho", "Nuclear Tau", "Ovalbumina Xi", "Zeta B", "Zeta", "Fibrona", "Lumina", "Epsilona", "Trombina Pi"];
interface Analyte { name: string; variants: string[] }
const ANALYTE_LIST: Analyte[] = ANALYTES.map((name, i) => ({ name, variants: i % 3 === 2 ? ["total", "libre"] : ["IgG", "IgM", "IgA"].slice(0, 2 + (i % 2)) }));

export const ADVERSARIAL_CATALOG: CatalogStudy[] = ANALYTE_LIST.flatMap((analyte) => analyte.variants.map((variant): CatalogStudy => {
  const name = `${analyte.name} ${variant}`.toUpperCase();
  return { id: `id:${name}`, code: name, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs: 10, active: true, category: "INMUNOLOGIA" };
}));

const DOC: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] };
const row = (literalText: string, lineText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high", lineText });
const key = (analyte: string, variant: string) => normalizeStudyKey(`${analyte} ${variant}`);
const SEPARATORS = [", ", " / ", " y ", " + ", " | ", " ; ", " - ", " – ", "  ", " · ", " con ", " o ", " e ", " & ", ": ", " (", "\n", " más "];
const MARKS: Array<[string, string]> = [["✓", "✗"], ["(x)", "( )"], ["[x]", "[ ]"], ["☑", "☐"], ["si", "no"], ["SI", "NO"], ["+", "-"], ["(+)", "(-)"], ["1", "0"], ["√", "×"], ["ok", "no"], ["✔", "✘"], ["*", ""], ["", "?"]];
const NEGATIONS = (keep: string, drop: string, analyte: string): string[] => [
  `${analyte} ${keep}, ${drop} tachado`, `${analyte} ${keep}, ${drop} (anulado)`, `${analyte} ${keep}, ${drop} opcional`, `${analyte} ${keep} / ${drop} pendiente de autorización`,
  `${analyte} ${keep}, ${drop} solo si el médico lo confirma`, `${analyte} ${keep} sin ${drop}`, `${analyte} ${keep} (${drop} no)`, `${analyte} ${keep} excepto ${drop}`,
  `${analyte} ${keep}, no ${drop}`, `${analyte} ${keep}, ${drop} ~~tachado~~`, `${analyte} ${keep}; ${drop} si ${keep} positivo`, `${analyte} ${keep} ni ${drop}`
];

export interface Instance { rows: SimpleStudy[]; requested: string[]; notRequested?: string[] }
type Layout = "bare" | "donor";
const layoutRows = (analyte: string, kept: string, others: string[], line: string, layout: Layout): SimpleStudy[] =>
  layout === "donor" ? [row(`${analyte} ${kept}`, line), ...others.map((other) => row(other, line))] : [kept, ...others].map((variant) => row(variant, line));

const variantsOf = (analyte: Analyte) => shuffle(analyte.variants).slice(0, 1 + Math.floor(rnd() * analyte.variants.length));
const pair = () => shuffle(ANALYTE_LIST).slice(0, 2) as [Analyte, Analyte];
const other = (analyte: Analyte, variant: string) => analyte.variants.find((v) => v !== variant)!;

export const STRUCTURES: Record<string, { description: string; make: () => Instance; mustQuoteAll?: boolean; mustHoldAll?: boolean }> = {
  S1_single_analyte_bare_only: {
    description: "ninguna fila nombra el analito: la variante suelta NO hereda de la línea (decisión de seguridad)", mustHoldAll: true,
    make: () => { const a = pick(ANALYTE_LIST), v = variantsOf(a); const line = `${a.name}${pick([": ", " ", ", "])}${v.join(pick([", ", " / ", " y ", " o "]))}`; return { rows: v.map((x) => row(x, line)), requested: v.map((x) => key(a.name, x)) }; }
  },
  S2_donor_single_analyte: {
    description: "una fila nombra el analito y las demás solo la variante, en una línea de texto llano con un único analito: se cotizan todas", mustQuoteAll: true,
    make: () => { const a = pick(ANALYTE_LIST); const v = shuffle(a.variants).slice(0, 2 + Math.floor(rnd() * (a.variants.length - 1))); const line = `${a.name} ${v.join(pick([", ", " / ", " y ", " o "]))}`; return { rows: layoutRows(a.name, v[0]!, v.slice(1), line, "donor"), requested: v.map((x) => key(a.name, x)) }; }
  },
  S3_two_analytes_bare: {
    description: "dos analitos en la línea y solo variantes sueltas: asociación desconocible", mustHoldAll: true,
    make: () => { const [a, b] = pair(); const va = pick(a.variants), vb = pick(b.variants); const line = `${a.name} ${va}${pick(SEPARATORS)}${b.name} ${vb}`; return { rows: [row(va, line), row(vb, line)], requested: [key(a.name, va), key(b.name, vb)] }; }
  },
  S4_donor_of_other_analyte: {
    description: "REGRESIÓN OBLIGATORIA: la fila nombrada es de un analito y la variante suelta es del otro de la misma línea; jamás se asocia al analito equivocado",
    make: () => { const [a, b] = pair(); const vb = pick(b.variants); const line = `${a.name}${pick(SEPARATORS)}${b.name} ${vb}`; return { rows: [row(a.name, line), row(vb, line)], requested: [normalizeStudyKey(a.name), key(b.name, vb)] }; }
  },
  S4b_donor_with_variant_of_other_analyte: {
    description: "REGRESIÓN OBLIGATORIA: la fila nombrada ya trae su variante y la suelta pertenece al otro analito de la línea",
    make: () => { const [a, b] = pair(); const va = pick(a.variants), vb = pick(b.variants); const line = `${a.name} ${va}${pick(SEPARATORS)}${b.name} ${vb}`; return { rows: [row(`${a.name} ${va}`, line), row(vb, line)], requested: [key(a.name, va), key(b.name, vb)] }; }
  },
  S10_marks_donor: {
    description: "REGRESIÓN OBLIGATORIA: marcas de aceptado/rechazado en la línea; el lector devolvió también la opción rechazada como variante suelta (con fila donante)",
    make: () => { const a = pick(ANALYTE_LIST); const keep = pick(a.variants); const drop = other(a, keep); const [ok, no] = pick(MARKS); const line = `${a.name}: ${keep} ${ok}  ${drop} ${no}`.replace(/ {3,}/g, "  "); return { rows: layoutRows(a.name, keep, [drop], line, "donor"), requested: [key(a.name, keep)], notRequested: [key(a.name, drop)] }; }
  },
  S10b_marks_bare: {
    description: "REGRESIÓN OBLIGATORIA: las mismas marcas, sin ninguna fila donante",
    make: () => { const a = pick(ANALYTE_LIST); const keep = pick(a.variants); const drop = other(a, keep); const [ok, no] = pick(MARKS); const line = `${a.name}: ${keep} ${ok}  ${drop} ${no}`; return { rows: layoutRows(a.name, keep, [drop], line, "bare"), requested: [key(a.name, keep)], notRequested: [key(a.name, drop)] }; }
  },
  S11_negation_donor: {
    description: "REGRESIÓN OBLIGATORIA: variantes tachadas, anuladas, opcionales, condicionales o negadas en el texto de la línea (con fila donante)",
    make: () => { const a = pick(ANALYTE_LIST); const keep = pick(a.variants); const drop = other(a, keep); const line = pick(NEGATIONS(keep, drop, a.name)); return { rows: layoutRows(a.name, keep, [drop], line, "donor"), requested: [key(a.name, keep)], notRequested: [key(a.name, drop)] }; }
  },
  S11b_negation_bare: {
    description: "REGRESIÓN OBLIGATORIA: las mismas negaciones, sin fila donante",
    make: () => { const a = pick(ANALYTE_LIST); const keep = pick(a.variants); const drop = other(a, keep); const line = pick(NEGATIONS(keep, drop, a.name)); return { rows: layoutRows(a.name, keep, [drop], line, "bare"), requested: [key(a.name, keep)], notRequested: [key(a.name, drop)] }; }
  },
  S12_same_variant_two_analytes: {
    description: "la misma variante en dos analitos de una línea: una fila suelta no se asigna a ninguno",
    make: () => { const [a, b] = pair(); const shared = a.variants.find((v) => b.variants.includes(v)) ?? a.variants[0]!; const line = `${a.name} ${shared}${pick(SEPARATORS)}${b.name} ${shared}`; return { rows: [row(`${a.name} ${shared}`, line), row(shared, line)], requested: [key(a.name, shared), key(b.name, shared)] }; }
  },
  S13_shared_words_donor: {
    description: "analitos que comparten palabras (\"Zeta\" y \"Zeta B\") con fila donante: se respeta el analito completo de la línea", mustQuoteAll: true,
    make: () => { const a = pick(ANALYTE_LIST.filter((x) => x.name === "Zeta" || x.name === "Zeta B")); const v = shuffle(a.variants); const line = `${a.name} ${v.join(", ")}`; return { rows: layoutRows(a.name, v[0]!, v.slice(1), line, "donor"), requested: v.map((x) => key(a.name, x)) }; }
  }
};

export interface StructureResult { instances: number; correct: number; wrong: number; wrongNegated: number; missed: number; allHeld: number; examples: string[] }

export function evaluateStructure(name: string, count: number): StructureResult {
  const structure = STRUCTURES[name]!;
  const result: StructureResult = { instances: 0, correct: 0, wrong: 0, wrongNegated: 0, missed: 0, allHeld: 0, examples: [] };
  for (let i = 0; i < count; i++) {
    const instance = structure.make();
    const reading = { requestedStudies: instance.rows, uncertainStudies: [], notes: "" };
    const analysis = assembleAnalysis({ consensus: buildSimpleConsensus(reading, reading), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog: ADVERSARIAL_CATALOG, document: DOC, partialAuto: true });
    const quoted = (analysis.internal?.quoted.lines ?? []).map((line) => normalizeStudyKey(line.name));
    const wrong = quoted.filter((q) => !instance.requested.includes(q));
    result.instances++;
    result.correct += quoted.length - wrong.length;
    result.wrong += wrong.length;
    result.wrongNegated += quoted.filter((q) => instance.notRequested?.includes(q)).length;
    result.missed += instance.requested.filter((r) => !quoted.includes(r)).length;
    if (quoted.length === 0) result.allHeld++;
    if (wrong.length > 0 && result.examples.length < 3) result.examples.push(`línea «${instance.rows[0]!.lineText!.replace(/\n/g, "⏎")}» filas [${instance.rows.map((r) => r.literalText).join(" | ")}] → cotizó ${JSON.stringify(wrong)}`);
  }
  return result;
}
