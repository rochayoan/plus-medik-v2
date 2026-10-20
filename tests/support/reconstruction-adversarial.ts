import { assembleAnalysis, type DocumentGate } from "../../src/analyze.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../../src/consensus.js";
import type { CatalogStudy } from "../../src/types.js";
import { BATTERY_CATALOG } from "./generalization-battery.js";

// GENERADOR ADVERSARIAL de la comprobación de lecturas originales sobre estudios RECONSTRUIDOS (herencia de analito y paquete). Se inyectan desacuerdos
// del lector B y se cuenta cuántas veces se cotiza algo que B no leyó igual que A. Analitos inventados, semilla fija, verdad conocida por construcción.
// NO prueba la visión: las lecturas ya vienen dadas. Invariante: SOLO se cotiza lo que AMBOS lectores leyeron igual.

let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = <T,>(list: T[]): T => list[Math.floor(rnd() * list.length)]!;
const shuffle = <T,>(list: T[]): T[] => [...list].sort(() => rnd() - 0.5);

const ANALYTES = ["Zetaina", "Anti-lambda", "Gamaina", "Kappa Sigma", "Sigmaina", "Factor Omega", "Nuclear Tau", "Fibrona"];
const VARIANTS = ["IgG", "IgM", "IgA"];
export const RECONSTRUCTION_CATALOG: CatalogStudy[] = ANALYTES.flatMap((analyte) => VARIANTS.map((variant): CatalogStudy => {
  const name = `${analyte} ${variant}`.toUpperCase();
  return { id: `id:${name}`, code: name, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs: 10, active: true, category: "INMUNOLOGIA" };
}));

const DOC: DocumentGate = { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] };
export const row = (literalText: string, normalizedName: string, lineText: string, confidence: SimpleStudy["confidence"] = "high"): SimpleStudy => ({ literalText, normalizedName, evidence: "check", confidence, lineText });
const key = (analyte: string, variant: string) => normalizeStudyKey(`${analyte} ${variant}`);

export function analyze(a: SimpleStudy[], b: SimpleStudy[], catalog: CatalogStudy[]) {
  const consensus = buildSimpleConsensus({ requestedStudies: a, uncertainStudies: [], notes: "" }, { requestedStudies: b, uncertainStudies: [], notes: "" });
  const result = assembleAnalysis({ consensus, judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, document: DOC, partialAuto: true });
  return { result, quoted: (result.internal?.quoted.lines ?? []).map((line) => normalizeStudyKey(line.name)), codes: (result.internal?.quoted.lines ?? []).map((line) => line.code) };
}

export interface Scenario { a: SimpleStudy[]; b: SimpleStudy[]; readByBoth: string[]; catalog?: CatalogStudy[] }

// Cada modo describe qué leyó cada lector en las filas sueltas (la fila donante la leen igual los dos).
export const MODES: Record<string, { description: string; expectQuoted: "readByBoth" | "none-extra"; make: () => Scenario }> = {
  bare_B_reads_other_variant_name_analyte_only: {
    description: "REGRESIÓN OBLIGATORIA: fila suelta; A lee una variante, B otra, ambos con normalizedName solo el analito (se emparejan por nombre)", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2, v3] = shuffle(VARIANTS) as [string, string, string]; const line = `${analyte} ${v1}, ${v2}, ${v3}`; const donor = row(`${analyte} ${v1}`, `${analyte} ${v1}`, line); return { a: [donor, row(v2, analyte, line)], b: [donor, row(v3, analyte, line)], readByBoth: [key(analyte, v1)] }; }
  },
  bare_B_reads_other_variant_name_with_variant: {
    description: "fila suelta con desacuerdo de variante y normalizedName con la variante: son filas distintas (disputa)", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2, v3] = shuffle(VARIANTS) as [string, string, string]; const line = `${analyte} ${v1}, ${v2}, ${v3}`; const donor = row(`${analyte} ${v1}`, `${analyte} ${v1}`, line); return { a: [donor, row(v2, `${analyte} ${v2}`, line)], b: [donor, row(v3, `${analyte} ${v3}`, line)], readByBoth: [key(analyte, v1)] }; }
  },
  bare_B_other_line: {
    description: "B leyó la fila suelta en otra línea: no hay línea fiable, no se reconstruye", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2, v3] = shuffle(VARIANTS) as [string, string, string]; const line = `${analyte} ${v1}, ${v2}, ${v3}`; const donor = row(`${analyte} ${v1}`, `${analyte} ${v1}`, line); return { a: [donor, row(v2, `${analyte} ${v2}`, line)], b: [donor, row(v3, `${analyte} ${v3}`, `${analyte} ${v3}`)], readByBoth: [key(analyte, v1)] }; }
  },
  bare_B_visible_text_differs_same_variants: {
    description: "fila suelta: mismo isotipo pero B transcribió otro texto visible (se emparejan por nombre): la correspondencia no es inequívoca", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2] = shuffle(VARIANTS) as [string, string]; const line = `${analyte} ${v1}, ${v2}`; const donor = row(`${analyte} ${v1}`, `${analyte} ${v1}`, line); return { a: [donor, row(v2, analyte, line)], b: [donor, row(`${v2} cuantitativo`, analyte, line)], readByBoth: [key(analyte, v1)] }; }
  },
  bare_both_agree_name_analyte_only: {
    description: "POSITIVO: ambos leen la misma fila suelta (aunque su normalizedName sea solo el analito): se cotiza y no se pierde cobertura", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2, v3] = shuffle(VARIANTS) as [string, string, string]; const line = `${analyte} ${v1}, ${v2}, ${v3}`; const rows = [row(`${analyte} ${v1}`, analyte, line), row(v2, analyte, line), row(v3, analyte, line)]; return { a: rows, b: rows, readByBoth: [key(analyte, v1), key(analyte, v2), key(analyte, v3)] }; }
  },
  bare_both_agree_different_spacing: {
    description: "POSITIVO: ambos leen la misma variante con distintas mayúsculas o puntuación (\"IgM\" / \"IGM.\"): es el mismo texto visible", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const line = `${analyte} IgG, IgM`; const donor = row(`${analyte} IgG`, `${analyte} IgG`, line); return { a: [donor, row("IgM", analyte, line)], b: [donor, row("IGM.", analyte, line)], readByBoth: [key(analyte, "IgG"), key(analyte, "IgM")] }; }
  },
  bare_X_mark_only_in_one_reader: {
    description: "POSITIVO: la fila suelta es la misma para los dos y solo uno incluyó la X de selección en el texto de la fila: es la misma lectura y se cotiza", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2] = shuffle(VARIANTS) as [string, string]; const line = `${analyte} ${v1} X, ${v2} X`; const donor = row(`${analyte} ${v1}`, `${analyte} ${v1}`, line); const name = pick([analyte, `${analyte} ${v2}`]); return { a: [donor, row(`${v2} X`, name, line)], b: [donor, row(v2, name, line)], readByBoth: [key(analyte, v1), key(analyte, v2)] }; }
  },
  bare_X_mark_B_reads_other_variant: {
    description: "REGRESIÓN OBLIGATORIA: con la X de selección en el texto de la fila, si los lectores leen variantes distintas no se cotiza la reconstruida", expectQuoted: "readByBoth",
    make: () => { const analyte = pick(ANALYTES); const [v1, v2, v3] = shuffle(VARIANTS) as [string, string, string]; const line = `${analyte} ${v1} X, ${v2} X, ${v3} X`; const donor = row(`${analyte} ${v1}`, `${analyte} ${v1}`, line); return { a: [donor, row(`${v2} X`, analyte, line)], b: [donor, row(`${v3} X`, analyte, line)], readByBoth: [key(analyte, v1)] }; }
  },
  package_B_component_differs: {
    description: "paquete reunido: B leyó un componente con otro texto visible (se emparejan por nombre): no se reúne ni se cotiza el paquete", expectQuoted: "readByBoth",
    make: () => { const line = "ZETAINA + KAPPAINA"; return { a: [row("Zetaina", "Zetaina", line), row("Kappaina en sangre", "Kappaina", line)], b: [row("Zetaina", "Zetaina", line), row("Kappaina", "Kappaina", line)], readByBoth: [], catalog: BATTERY_CATALOG }; }
  },
  package_both_agree: {
    description: "POSITIVO: paquete reunido cuando los dos lectores leen los mismos componentes", expectQuoted: "readByBoth",
    make: () => { const line = "ZETAINA + KAPPAINA"; const rows = [row("Zetaina", "Zetaina", line), row("Kappaina en sangre", "Kappaina", line)]; return { a: rows, b: rows, readByBoth: [normalizeStudyKey("ZETAINA + KAPPAINA")], catalog: BATTERY_CATALOG }; }
  }
};

export interface ModeResult { instances: number; quoted: number; notReadByBoth: number; missed: number }

export function evaluateMode(name: string, count: number): ModeResult {
  const mode = MODES[name]!;
  const out: ModeResult = { instances: 0, quoted: 0, notReadByBoth: 0, missed: 0 };
  for (let i = 0; i < count; i++) {
    const scenario = mode.make();
    const { quoted } = analyze(scenario.a, scenario.b, scenario.catalog ?? RECONSTRUCTION_CATALOG);
    out.instances++;
    out.quoted += quoted.length;
    out.notReadByBoth += quoted.filter((q) => !scenario.readByBoth.includes(q)).length;
    out.missed += scenario.readByBoth.filter((r) => !quoted.includes(r)).length;
  }
  return out;
}
