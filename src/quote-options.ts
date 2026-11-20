import type { AnalysisResult } from "./analyze.js";
import type { CatalogStudy } from "./types.js";
import { emojiFor, formatBs } from "./whatsapp-quote.js";

// Estudios POSIBLES (dudosos): lo que el motor no pudo confirmar con certeza pero que el catálogo sí tiene. En vez de rechazarlos, se muestran con su precio del catálogo, NUMERADOS y FUERA del total, para que
// el paciente confirme cuál quiso (decisión del dueño, 19-nov: «que mi agente no sea tan rechazador»). Lo usan la cotización por texto del agente y la de fotos. Nunca se suman ni se cotizan solos.

export const DOUBTFUL_LIMIT = 8;
// Un nombre de catálogo larguísimo (paneles con la lista de patógenos) se acorta en la lista.
const MAX_OPTION_NAME = 90;
const shortName = (name: string): string => (name.length > MAX_OPTION_NAME ? `${name.slice(0, MAX_OPTION_NAME - 1).trimEnd()}…` : name);
const priced = (study: CatalogStudy): boolean => study.active && Number.isFinite(study.priceBs) && study.priceBs > 0;

export function formatDoubtfulOptions(studies: readonly CatalogStudy[], afterQuote: boolean): string | undefined {
  const valid = studies.filter(priced).slice(0, DOUBTFUL_LIMIT);
  if (valid.length === 0) return undefined;
  const lines = valid.map((study, index) => `${index + 1}. ${emojiFor(study.name)} ${shortName(study.name)} — ${formatBs(study.priceBs)}${study.turnaroundText ? ` (entrega: ${study.turnaroundText})` : ""}`);
  return afterQuote
    ? ["🔎 *Posiblemente también pediste alguno de estos* (no están sumados en el total):", "", ...lines, "", "¿Quieres que agregue alguno a tu cotización? Responde con el número o el nombre. 😊"].join("\n")
    : ["🩺 *PlusMedik* · Opciones que encontré", "", ...lines, "", "Dime cuál (o cuáles) te interesa y te armo la cotización. 😊"].join("\n");
}

// Las opciones AGRUPADAS por lo que pidió el paciente (cotización por texto del agente, 20-nov): «Para «pcr»: 1… 2… 3…», con la numeración seguida para que responda con el número. Sin el tope
// de 8 de antes (dejaba estudios «pendientes» sin opciones); solo un máximo por pedido y uno total para que el mensaje no sea interminable.
export const OPTIONS_PER_MENTION = 6;
export const OPTIONS_TOTAL_LIMIT = 30;
export function formatGroupedOptions(groups: ReadonlyArray<{ label: string; studies: readonly CatalogStudy[] }>, afterQuote: boolean): string | undefined {
  let n = 0;
  const sections: string[] = [];
  for (const group of groups) {
    const valid = group.studies.filter(priced).slice(0, Math.min(OPTIONS_PER_MENTION, OPTIONS_TOTAL_LIMIT - n));
    if (valid.length === 0) continue;
    sections.push(`*Para «${group.label}»:*`, ...valid.map((study) => `${++n}. ${emojiFor(study.name)} ${shortName(study.name)} — ${formatBs(study.priceBs)}${study.turnaroundText ? ` (entrega: ${study.turnaroundText})` : ""}`), "");
  }
  if (n === 0) return undefined;
  return afterQuote
    ? ["🔎 *Posiblemente también pediste alguno de estos* (no están sumados en el total):", "", ...sections, "¿Quieres que agregue alguno a tu cotización? Responde con el número o el nombre. 😊"].join("\n")
    : ["🩺 *PlusMedik* · Opciones que encontré", "", ...sections, "Dime cuál (o cuáles) te interesa y te armo la cotización. 😊"].join("\n");
}

// Máximo de candidatos de UNA línea dudosa de la receta: más que esto ya no es «posiblemente», es no saber qué dice (se pide otra foto o lo ve una persona).
const MAX_CANDIDATES_PER_LINE = 4;

// Los posibles de una FOTO: líneas pendientes cuya duda es solo de LECTURA (qué dice) o de IDENTIDAD (cuál estudio del catálogo es), con candidatos del catálogo. Nunca si la duda es del DOCUMENTO (zona que no
// se ve, quizá no es una solicitud, algo que podría alterar el estudio) o de POLÍTICA (precio inválido, compuesto, manuscrito fuera de alcance), ni si algo invalida toda la lectura.
// Nunca lanza: ante un análisis incompleto o inesperado no hay posibles (la cotización sale como siempre).
export function possibleStudiesFromAnalysis(analysis: AnalysisResult, catalog: readonly CatalogStudy[]): CatalogStudy[] {
  const internal = analysis.internal;
  if (!internal || !Array.isArray(internal.pending) || !Array.isArray(internal.recipeStops) || internal.recipeStops.length > 0) return [];
  const byId = new Map(catalog.map((study) => [study.id, study]));
  const quoted = new Set((internal.quoted?.lines ?? []).map((line) => line.id));
  const found = new Map<string, CatalogStudy>();
  for (const item of internal.pending) {
    if (item.kind !== "STUDY" || !Array.isArray(item.candidates) || item.candidates.length === 0 || item.candidates.length > MAX_CANDIDATES_PER_LINE) continue;
    if (!Array.isArray(item.uncertainty) || item.uncertainty.length === 0 || item.uncertainty.some((kind) => kind !== "READING" && kind !== "IDENTITY")) continue;
    for (const candidate of item.candidates) {
      const study = byId.get(candidate.id);
      if (study && priced(study) && !quoted.has(study.id)) found.set(study.id, study);
    }
  }
  return [...found.values()].slice(0, DOUBTFUL_LIMIT);
}
