// VERDAD DE TERRENO para la prueba en modo sombra. Sale de las imágenes de las 5 recetas y del catálogo real
// (códigos de lab_tests), NO de las respuestas de GPT. Cada entrada dice qué es lo correcto para el texto leído.
//
//  MATCH                 un único estudio correcto (codes[0]).
//  MATCH_OR_AMBIGUOUS    un estudio es correcto, pero abstenerse (AMBIGUOUS) también es aceptable.
//  AMBIGUOUS             varios estudios son plausibles: elegir uno sería un error.
//  COMPOSITE             el texto nombra varios estudios explícitamente (componentes exactos en codes).
//  NONE                  no existe en el catálogo un estudio que corresponda: cualquier MATCH sería un error.

export type TruthKind = "MATCH" | "MATCH_OR_AMBIGUOUS" | "AMBIGUOUS" | "COMPOSITE" | "NONE";

export interface Truth {
  kind: TruthKind;
  codes: string[];
  why: string;
}

// Conjunto ADVERSARIAL: textos que no están en las 5 recetas. Mezcla sinónimos/abreviaturas/errores (deben resolverse)
// con textos genuinamente ambiguos o sin estudio (deben abstenerse). Mide si GPT inventa o elige variantes por defecto.
export const ADVERSARIAL: Array<{ text: string; truth: Truth }> = [
  { text: "Glucosa en ayunas", truth: { kind: "MATCH", codes: ["397"], why: "Glucosa en ayunas = GLUCOSA." } },
  { text: "TGO", truth: { kind: "MATCH", codes: ["418"], why: "TGO = transaminasa GOT." } },
  { text: "TGP", truth: { kind: "MATCH", codes: ["419"], why: "TGP = transaminasa GPT." } },
  { text: "BUN", truth: { kind: "MATCH", codes: ["372"], why: "BUN = BUN DE UREA." } },
  { text: "VSG", truth: { kind: "MATCH", codes: ["103"], why: "VSG = ERITROSEDIMENTACION VSG." } },
  { text: "Hb glicosilada", truth: { kind: "MATCH", codes: ["401"], why: "Hemoglobina glicosilada (HbA1c)." } },
  { text: "Prolactnia", truth: { kind: "MATCH", codes: ["165"], why: "Error de tipeo de prolactina." } },
  { text: "Hemog completo", truth: { kind: "MATCH", codes: ["108"], why: "Abreviatura de hemograma completo." } },
  { text: "Biometria hematica", truth: { kind: "MATCH", codes: ["108"], why: "Sinónimo de hemograma." } },
  { text: "Orina de rutina", truth: { kind: "MATCH", codes: ["514"], why: "Examen general de orina." } },
  { text: "Colesterol HDL", truth: { kind: "MATCH", codes: ["376"], why: "Nombre exacto." } },
  { text: "T4 libre", truth: { kind: "MATCH", codes: ["172"], why: "T4 LIBRE (ECLIA); la única T4 libre." } },
  { text: "TTPA", truth: { kind: "MATCH", codes: ["119"], why: "TTPA = tiempo parcial de tromboplastina activado." } },
  { text: "Fosfatasa alcalina", truth: { kind: "MATCH", codes: ["389"], why: "Nombre exacto." } },
  { text: "Acido urico", truth: { kind: "MATCH", codes: ["366"], why: "Ácido úrico sérico; la uricosuria (503) es en orina." } },
  { text: "Anti TPO", truth: { kind: "MATCH", codes: ["54"], why: "Anticuerpos anti-TPO." } },
  { text: "Toxoplasmosis IgM Elisa", truth: { kind: "MATCH", codes: ["239"], why: "TOXO IgM (ELISA): método e isotipo explícitos." } },
  { text: "Glucosa", truth: { kind: "MATCH", codes: ["397"], why: "Nombre exacto del estudio general." } },
  { text: "Hemoglobina", truth: { kind: "MATCH_OR_AMBIGUOUS", codes: ["107"], why: "Nombre exacto; la glicosilada y la fetal tienen otros nombres." } },
  { text: "Hierro", truth: { kind: "MATCH_OR_AMBIGUOUS", codes: ["402"], why: "Hierro sérico; también hay saturación y perfil ferrocinético." } },
  { text: "Colesterol", truth: { kind: "MATCH_OR_AMBIGUOUS", codes: ["378"], why: "Suele ser el total, pero existen HDL, LDL y VLDL." } },
  { text: "Amilasa", truth: { kind: "MATCH_OR_AMBIGUOUS", codes: ["368"], why: "Suele ser la sérica, pero existe amilasa en orina de 24 h." } },
  { text: "TSH", truth: { kind: "AMBIGUOUS", codes: ["178", "179", "180"], why: "ECLIA, FIA y neonatal." } },
  { text: "Calcio", truth: { kind: "AMBIGUOUS", codes: ["374", "373", "505"], why: "Calcio sérico, iónico y en orina de 24 h." } },
  { text: "Cortisol", truth: { kind: "AMBIGUOUS", codes: ["146", "147", "511"], why: "08:00, 16:00 y en orina." } },
  { text: "Insulina", truth: { kind: "AMBIGUOUS", codes: ["159", "160", "161"], why: "Basal, postcarga y postprandial." } },
  { text: "T3", truth: { kind: "AMBIGUOUS", codes: ["168", "170", "169", "171"], why: "Libre, total, neonatal e inversa." } },
  { text: "PSA", truth: { kind: "AMBIGUOUS", codes: ["256", "257", "258"], why: "Libre y total (dos métodos)." } },
  { text: "Magnesio", truth: { kind: "AMBIGUOUS", codes: ["408", "518"], why: "Sérico y en orina de 24 h." } },
  { text: "Hepatitis B", truth: { kind: "AMBIGUOUS", codes: ["207", "208"], why: "Decenas de estudios de hepatitis B." } },
  { text: "PCR", truth: { kind: "AMBIGUOUS", codes: ["474", "475", "476"], why: "Proteína C reactiva (3 variantes) o PCR molecular." } },
  { text: "Beta HCG", truth: { kind: "AMBIGUOUS", codes: ["144", "145", "450"], why: "Cuantitativa, varón y cualitativa." } },
  { text: "TOXO", truth: { kind: "AMBIGUOUS", codes: ["238", "239", "231", "232"], why: "IgG/IgM y dos métodos." } },
  { text: "Anticardiolipina", truth: { kind: "AMBIGUOUS", codes: ["20", "21", "22"], why: "IgA, IgG e IgM." } },
  { text: "Vitamina D", truth: { kind: "AMBIGUOUS", codes: ["536", "537", "538", "539"], why: "1,25, 25-OH (dos métodos) y D3." } },
  { text: "Examen de heces", truth: { kind: "AMBIGUOUS", codes: ["288", "289"], why: "Parasitológico simple o seriado." } },
  { text: "Elisa para PSA Total", truth: { kind: "NONE", codes: [], why: "El catálogo solo tiene PSA total por ECLIA y por FIA; ELISA no existe." } },
  { text: "Perfil hepatico", truth: { kind: "NONE", codes: [], why: "No existe un perfil hepático ni el texto lista componentes." } },
  { text: "Estudio inexistente xyz", truth: { kind: "NONE", codes: [], why: "Texto sin sentido clínico." } }
];

export const GROUND_TRUTH: Record<string, Truth> = {
  "creatinina serica": { kind: "MATCH", codes: ["384"], why: "Creatinina sérica = CREATININA; los cocientes y la depuración tienen otros nombres." },
  "glicemia basal": { kind: "MATCH", codes: ["397"], why: "Glicemia basal = glucosa en ayunas = GLUCOSA (las variantes neonatal, postcarga y postprandial son otros estudios)." },
  "hemograma completo": { kind: "MATCH", codes: ["108"], why: "Hemograma completo = HEMOGRAMA COMPLETO AUTOMATIZADO." },
  "perfil lipidico col hdl ldl vldl trigliceridos": { kind: "COMPOSITE", codes: ["378", "376", "377", "379", "421"], why: "El texto lista los cinco componentes; no existe un perfil lipídico único en el catálogo." },
  "transaminasas got gpt": { kind: "COMPOSITE", codes: ["418", "419"], why: "El texto nombra GOT y GPT; son dos estudios en el catálogo." },
  "examen general de orina": { kind: "MATCH", codes: ["514"], why: "Examen general de orina = EXAMEN GENERAL DE ORINA COMPLETA." },
  "nitrogeno ureico urea nus": { kind: "AMBIGUOUS", codes: ["372", "423"], why: "El formulario junta BUN, urea y NUS; el catálogo tiene BUN DE UREA y UREA como estudios distintos." },
  "nitrogeno ureico ureanus": { kind: "AMBIGUOUS", codes: ["372", "423"], why: "Variante de lectura del mismo ítem del formulario (BUN / urea / NUS)." },
  "nitrogeno ureico": { kind: "MATCH_OR_AMBIGUOUS", codes: ["372"], why: "Nitrógeno ureico = BUN (372); abstenerse es aceptable porque el formulario lo agrupa con la urea." },
  "amilasa pancreatica": { kind: "NONE", codes: [], why: "La amilasa pancreática (isoenzima) no equivale a la amilasa total (368); no existe un estudio específico." },
  "proteina c reactiva pcr cualitativa": { kind: "MATCH", codes: ["474"], why: "PCR cualitativa = PROTEINA C REACTIVA (PCR CUALITATIVO); no es la Proteína C de coagulación (136)." },
  "reaccion de widal": { kind: "MATCH", codes: ["481"], why: "Nombre exacto del catálogo." },
  "bilirrubinas totales y fracciones": { kind: "MATCH", codes: ["371"], why: "BILIRRUBINA TOTAL Y FRACCIONES." },
  "bilirrubina totales y fracciones": { kind: "MATCH", codes: ["371"], why: "Variante de lectura de BILIRRUBINA TOTAL Y FRACCIONES." },
  "dhea s": { kind: "MATCH", codes: ["151"], why: "DHEA-S (sulfato); no es DHEA (150)." },
  "fsh": { kind: "MATCH", codes: ["154"], why: "FSH (ECLIA); es el único estudio de FSH." },
  "lh": { kind: "MATCH", codes: ["162"], why: "LH (ECLIA); es el único estudio de LH." },
  "progesterona dia 21 del ciclo": { kind: "MATCH", codes: ["164"], why: "Progesterona; el día del ciclo es una indicación, no otro estudio (la 17-OH es 163/184)." },
  "prolactina prl": { kind: "MATCH", codes: ["165"], why: "PROLACTINA (ECLIA)." },
  "estradiol e2": { kind: "MATCH", codes: ["152"], why: "E2 = estradiol; no son los estrógenos totales (153)." },
  "orina completa": { kind: "MATCH", codes: ["514"], why: "Orina completa = EXAMEN GENERAL DE ORINA COMPLETA." },
  "perfil tiroideo": { kind: "NONE", codes: [], why: "No existe un perfil tiroideo en el catálogo y el texto no lista componentes: la composición debe definirla el laboratorio." },
  "recuento de plaquetas": { kind: "MATCH", codes: ["114"], why: "Nombre exacto del catálogo." },
  "anticoagulante lupico": { kind: "MATCH", codes: ["25"], why: "ANTICOAGULANTE LUPICO." },
  "anticardiolipinas ig m": { kind: "MATCH", codes: ["22"], why: "Anticardiolipina IgM (isotipo explícito)." },
  "anticardiolipinas ig g": { kind: "MATCH", codes: ["21"], why: "Anticardiolipina IgG (isotipo explícito)." },
  "b2 glicoproteina ig m": { kind: "MATCH", codes: ["59"], why: "Beta 2 glicoproteína IgM (isotipo explícito)." }
};
