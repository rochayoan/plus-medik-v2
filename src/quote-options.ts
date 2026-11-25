import type { AnalysisResult } from "./analyze.js";
import type { CatalogStudy } from "./types.js";
import { emojiFor, formatBs, turnaroundSuffix } from "./whatsapp-quote.js";
import { askGroupFor, askGroupsAmong } from "./study-choice.js";

// Estudios POSIBLES (dudosos): lo que el motor no pudo confirmar con certeza pero que el catálogo sí tiene. En vez de rechazarlos, se muestran con su precio del catálogo, NUMERADOS y FUERA del total, para que
// el paciente confirme cuál quiso (decisión del dueño, 19-nov: «que mi agente no sea tan rechazador»). Lo usan la cotización por texto del agente y la de fotos. Nunca se suman ni se cotizan solos.

export const DOUBTFUL_LIMIT = 8;
// Un nombre de catálogo larguísimo (paneles con la lista de patógenos) se acorta en la lista.
const MAX_OPTION_NAME = 90;
const shortName = (name: string): string => (name.length > MAX_OPTION_NAME ? `${name.slice(0, MAX_OPTION_NAME - 1).trimEnd()}…` : name);
const priced = (study: CatalogStudy): boolean => study.active && Number.isFinite(study.priceBs) && study.priceBs > 0;

// `asks`: estudios que dependen de un dato del paciente (dueño, 25-nov: cultivo de secreción, microalbuminuria, biopsia): se le pide ese dato debajo de la lista. Los de `hideOptions`
// (biopsia) no se listan: el precio lo confirma la doctora con el tamaño de la muestra.
export function formatDoubtfulOptions(studies: readonly CatalogStudy[], afterQuote: boolean, catalog: readonly CatalogStudy[] = []): string | undefined {
  const asks = askGroupsAmong(studies.map((study) => study.id), catalog);
  const hidden = new Set(asks.filter((group) => group.hideOptions).flatMap((group) => group.studies.map((study) => study.id)));
  const valid = studies.filter((study) => priced(study) && !hidden.has(study.id)).slice(0, DOUBTFUL_LIMIT);
  const askLines = asks.map((group) => `👉 ${group.ask}`);
  if (valid.length === 0 && askLines.length === 0) return undefined;
  if (valid.length === 0) return [afterQuote ? "🔎 *Para completar tu cotización:*" : "🩺 *PlusMedik*", "", ...askLines].join("\n");
  const lines = valid.map((study, index) => `${index + 1}. ${emojiFor(study.name)} ${shortName(study.name)} — ${formatBs(study.priceBs)}${study.turnaroundText ? turnaroundSuffix(study.turnaroundText) : ""}`);
  const asked = askLines.length > 0 ? ["", ...askLines] : [];
  return afterQuote
    ? ["🔎 *Posiblemente también pediste alguno de estos* (no están sumados en el total):", "", ...lines, ...asked, "", "¿Quieres que agregue alguno a tu cotización? Responde con el número o el nombre. 😊"].join("\n")
    : ["🩺 *PlusMedik* · Opciones que encontré", "", ...lines, ...asked, "", "Dime cuál (o cuáles) te interesa y te armo la cotización. 😊"].join("\n");
}

// Las opciones AGRUPADAS por lo que pidió el paciente (cotización por texto del agente, 20-nov): «Para «pcr»: 1… 2… 3…», con la numeración seguida para que responda con el número. Sin el tope
// de 8 de antes (dejaba estudios «pendientes» sin opciones); solo un máximo por pedido y uno total para que el mensaje no sea interminable.
export const OPTIONS_PER_MENTION = 6;
export const OPTIONS_TOTAL_LIMIT = 30;
// `typo`: el grupo salió de una errata o de lo que el modelo cree que quiso escribir («hgc»). Si es la ÚNICA opción de todo el mensaje y tiene un solo estudio, se pregunta directo «¿Quisiste decir…?» con su
// precio (revisión del 23-nov); si hay varias, va en la lista numerada de siempre.
export function formatGroupedOptions(groups: ReadonlyArray<{ label: string; studies: readonly CatalogStudy[]; typo?: boolean }>, afterQuote: boolean): string | undefined {
  const shown = groups.map((group) => ({ ...group, valid: group.studies.filter(priced) })).filter((group) => group.valid.length > 0);
  if (shown.length === 1 && shown[0]!.typo === true && shown[0]!.valid.length === 1) {
    const study = shown[0]!.valid[0]!;
    return [
      `🔎 ¿Con «${shown[0]!.label}» quisiste decir *${shortName(study.name)}*? ${emojiFor(study.name)} — ${formatBs(study.priceBs)}${study.turnaroundText ? turnaroundSuffix(study.turnaroundText) : ""}`,
      afterQuote ? "Si es así, respóndeme «sí» y te lo sumo a la cotización 😊" : "Si es así, respóndeme «sí» y te armo la cotización 😊",
      TYPO_DOCTOR_NOTE
    ].join("\n");
  }
  let n = 0;
  const sections: string[] = [];
  for (const group of groups) {
    const valid = group.studies.filter(priced).slice(0, Math.min(OPTIONS_PER_MENTION, OPTIONS_TOTAL_LIMIT - n));
    if (valid.length === 0) continue;
    sections.push(`*Para «${group.label}»:*`, ...valid.map((study) => `${++n}. ${emojiFor(study.name)} ${shortName(study.name)} — ${formatBs(study.priceBs)}${study.turnaroundText ? turnaroundSuffix(study.turnaroundText) : ""}`), "");
  }
  if (n === 0) return undefined;
  return afterQuote
    ? ["🔎 *Posiblemente también pediste alguno de estos* (no están sumados en el total):", "", ...sections, "¿Quieres que agregue alguno a tu cotización? Responde con el número o el nombre. 😊", OPTIONS_DOCTOR_NOTE].join("\n")
    : ["🩺 *PlusMedik* · Opciones que encontré", "", ...sections, "Dime cuál (o cuáles) te interesa y te armo la cotización. 😊", OPTIONS_DOCTOR_NOTE].join("\n");
}

// Lo que el paciente pidió y el catálogo no tiene (ni parecido). Indicación del laboratorio (dueño, 20-nov): se cotiza lo que sí está y de lo demás se le dice que LA DOCTORA se lo confirma por este chat.
// Nunca se dice que no lo tenemos o que no lo realizamos, ni se mencionan otros laboratorios (algunos estudios se envían a otro laboratorio: eso lo decide la doctora).
export const OPTIONS_DOCTOR_NOTE = "Si no es ninguno de estos, te lo confirma la doctora por este chat.";
export const TYPO_DOCTOR_NOTE = "Si no es ese, te lo confirma la doctora por este chat.";
const DOCTOR_CONFIRMS_LIMIT = 10;
export function formatDoctorConfirms(mentions: readonly string[]): string | undefined {
  const shown = [...new Set(mentions.map((mention) => mention.trim()).filter((mention) => mention !== ""))].slice(0, DOCTOR_CONFIRMS_LIMIT);
  if (shown.length === 0) return undefined;
  const label = (mention: string) => mention.charAt(0).toUpperCase() + mention.slice(1);
  return [
    shown.length === 1 ? "👩‍⚕️ *Este estudio te lo confirma la doctora:*" : "👩‍⚕️ *Estos estudios te los confirma la doctora:*",
    "",
    ...shown.map((mention) => `▫️ ${label(mention)}`),
    "",
    "Te escribirá por este chat con el precio y el tiempo de entrega. 😊"
  ].join("\n");
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
    if (item.kind !== "STUDY" || !Array.isArray(item.candidates) || item.candidates.length === 0) continue;
    // Más de 4 opciones solo si son las de UN estudio que depende de un dato del paciente (cultivo de secreción: 6 zonas; biopsia: 6 tamaños).
    if (item.candidates.length > MAX_CANDIDATES_PER_LINE && !askGroupFor(item.text ?? "", item.candidates.map((candidate) => candidate.id), catalog)) continue;
    if (!Array.isArray(item.uncertainty) || item.uncertainty.length === 0 || item.uncertainty.some((kind) => kind !== "READING" && kind !== "IDENTITY")) continue;
    for (const candidate of item.candidates) {
      const study = byId.get(candidate.id);
      if (study && priced(study) && !quoted.has(study.id)) found.set(study.id, study);
    }
  }
  return [...found.values()].slice(0, DOUBTFUL_LIMIT);
}
