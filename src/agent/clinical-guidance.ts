import { plain } from "../text-normalize.js";
import type { Fact } from "./contracts.js";

// ORIENTACIÓN GENERAL (revisión del 23-nov, decisión del dueño): menos «no tengo el dato, consulta con tu médico» y menos derivación, con control.
//   · PREPARACIÓN (ayuno, horario, cómo tomar o llevar la muestra): si el laboratorio no tiene una indicación aprobada, el modelo da orientación general (con las horas o días que correspondan) y el SISTEMA
//     agrega siempre la nota para confirmarlo con el laboratorio. Caso real: «¿Para un hemograma es necesario que vaya en ayunas?» → «No tengo confirmada la preparación… consúltalo con tu médico».
//   · VALORES DE REFERENCIA: los del laboratorio cuando estén cargados (hecho REFERENCE_RANGE). Mientras no estén, el modelo explica qué mide el estudio y que el rango viene en su informe, SIN cifras (los rangos
//     de internet no son los del laboratorio: cambian por método, sexo y edad). Caso real: «¿me puede decir los valores de ref de la ferritina?» → «No tengo disponibles los valores… consulta con tu médico».
//   · INTERPRETAR un resultado propio («mi ferritina salió 15»), síntomas o medicamentos: nada de esto aplica; sigue el camino de siempre (la Dra).
// Determinista: lo decide el texto del paciente, no el modelo. Cada vez que se usa queda en el registro (`guidance`) para que la Dra revise esas respuestas.

export type GuidanceKind = "PREPARATION" | "REFERENCE";

const PREPARATION = /\b(ayuno\w*|ayunas|preparaci\w*|prepararme|preparar\w*|puedo (comer|desayunar|tomar agua|tomar cafe|tomar mate)|debo (comer|desayunar|ir sin comer)|sin comer|abstinencia|primera orina|orina de 24|(como|cuando|donde|en que) (recojo|recoger|junto|juntar|tomo|tomar|llevo|llevar|traigo|traer|guardo|guardar|conservo|conservar)\w* (la |las |mi |mis |una |el )?(muestra\w*|orina|heces|frasco\w*)|frasco\w*)\b/;
const REFERENCE = /\b(valor\w* (de )?ref\w*|ref(erencia)?s? de|rango\w* (de )?(ref\w*|normal\w*)|valor\w* normal\w*|niveles? normal\w*|cuanto (debe|deberia|tiene que) (salir|estar|dar|ser)|cual es (el|lo) normal)\b/;
// Un resultado PROPIO o de alguien cercano (con su cifra, «me salió», «está alto»): es interpretación, la ve la Dra.
const OWN_RESULT = /\b(mi|mis|me salio|salio|salieron|me dio|tengo|tiene|tenia|resultado\w*|esta (alto|alta|bajo|baja|elevad\w*)|es grave|preocup\w*|significa\w*)\b|\d/;
// Síntomas o medicamentos: tampoco (orientación médica).
const MEDICAL = /\b(medicamento\w*|medicina\w*|pastilla\w*|insulina|tratamiento\w*|antibiotic\w*|anticoagulant\w*|dolor\w*|fiebre|sintoma\w*|sangrado|mareo\w*|embarazad\w*|tomo|estoy tomando|toma (un|una|el|la)|me recetaron)\b/;

export function guidanceFor(patientText: string, facts: readonly Fact[]): GuidanceKind[] {
  const text = plain(patientText.slice(0, 2000));
  if (!text || MEDICAL.test(text)) return [];
  const out: GuidanceKind[] = [];
  const approvedPreparation = facts.some((fact) => fact.source === "LAB_INFO" && fact.refs.some((ref) => /^(STUDY_PREPARATION|SAMPLE):/.test(ref)));
  if (PREPARATION.test(text) && !approvedPreparation) out.push("PREPARATION");
  const approvedRange = facts.some((fact) => fact.source === "REFERENCE_RANGE");
  if (REFERENCE.test(text) && !OWN_RESULT.test(text) && !approvedRange) out.push("REFERENCE");
  return out;
}

const GUIDANCE_TEXT: Record<GuidanceKind, string> = {
  PREPARATION:
    "ORIENTACIÓN GENERAL DE PREPARACIÓN: el laboratorio no tiene cargada una indicación aprobada para esto. Responde con lo habitual en laboratorios clínicos para ese estudio (si necesita ayuno y de cuántas horas, horario de la toma, abstinencia, cómo recoger, conservar o llevar la muestra), en 1 a 3 frases claras. Puedes dar las horas o días que correspondan. No diagnostiques ni hables de medicamentos. NO digas que no tienes el dato ni que lo consulte con su médico. El sistema agrega al final la nota para confirmarlo con el laboratorio: no la escribas tú.",
  REFERENCE:
    "VALORES DE REFERENCIA: el laboratorio aún no tiene cargados los suyos. Explica en 1 o 2 frases, en general, qué mide ese estudio, y que su rango de referencia viene impreso en su informe junto al resultado, porque depende del método del laboratorio, la edad y el sexo. NO des cifras ni rangos. NO digas que no tienes el dato ni que lo consulte con su médico. Si quiere hacerse el estudio, ofrécele cotizarlo."
};

export const guidanceFacts = (kinds: readonly GuidanceKind[]): Fact[] => kinds.map((kind, index) => ({ id: `guidance-${index + 1}`, source: "GENERAL_GUIDANCE", text: GUIDANCE_TEXT[kind], refs: [] }));

// La nota que el SISTEMA agrega a toda orientación general de preparación (no depende del modelo).
export const PREPARATION_NOTE = "ℹ️ Es una orientación general: confírmala con el laboratorio antes de tu toma.";
export const withPreparationNote = (text: string): string => (text.includes(PREPARATION_NOTE) ? text : `${text}\n\n${PREPARATION_NOTE}`);

// Cifras que la orientación de preparación puede dar sin que estén en los datos: una cantidad con su unidad de tiempo o volumen («8 a 12 horas», «3 días», «20 ml»). Dinero, teléfonos, horarios y enlaces siguen
// exigiendo procedencia.
export const GUIDANCE_FIGURES = /\b\d{1,3}(?:\s*(?:a|-|–|y|o)\s*\d{1,3})?\s*(?:horas?|hrs?|h|dias?|minutos?|min|ml|cc|semanas?)\b/g;
