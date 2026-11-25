import { normalizeStudyKey } from "./consensus.js";
import { extractWithNotes, isKnownStudyPhrase, preferredByMethod, preferredBySample } from "./quote-session.js";
import type { CatalogStudy } from "./types.js";
import { typoCandidates } from "./catalog-search.js";
import { isTypoOf } from "./typo.js";
import { splitStudyMentions } from "./study-mentions.js";

// Reglas para ELEGIR la versión de un estudio cuando no se especifica (método, cuantificación, total/libre, IgG/IgM, muestra) y las elecciones fijas del laboratorio (grupos).
// Las usan la cotización por texto y la de fotos de recetas: la misma información técnica del laboratorio decide en los dos caminos.

// Palabras de relleno delante del nombre de un estudio («prueba de», «dosaje de», «examen de»).
export const FILLER = /^(?:(?:la|el|una?|unos?|las|los)\s+)?(?:pruebas?|examen(?:es)?|analisis|estudios?|dosajes?|dosificacion|test|nivel(?:es)?)(?!\s+rapid)\s+(?:de\s+(?:la\s+|el\s+|los\s+|las\s+)?|del\s+|para\s+(?:el\s+|la\s+)?)?/;
export const coreOfMention = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(FILLER, "").trim();

// Entre varias opciones, la que tiene TODAS las palabras que el paciente escribió («psa total» → las dos PSA TOTAL, no la LIBRE); si quedan varias que solo cambian de método, el método preferido.
// Se mira el nombre ENTERO (también lo que va entre paréntesis: «PROTEINA C REACTIVA (PCR CUANTITATIVO)»), y una opción con una palabra de VARIANTE que el paciente no escribió no es lo que pidió:
// «pcr cuantitativo» no es la SEMI cuantitativa (pasaba porque a ese nombre del catálogo le falta el «)»).
export const VARIANT_WORDS = new Set(["semi", "semicuantitativo", "semicuantitativa", "cualitativo", "cualitativa", "cuantitativo", "cuantitativa", "total", "libre", "igg", "igm", "iga", "ige", "ss", "ds", "neonatal", "inversa"]);
export const nameWords = (value: string): Set<string> => new Set(normalizeStudyKey(value.replace(/\([^)]*\)/g, " ")).split(" ").filter(Boolean));
export const allNameWords = (value: string): Set<string> => new Set(normalizeStudyKey(value).split(" ").filter(Boolean));
// El estudio sin su variante ni su método: «PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO» y «(PCR CUANTITATIVO) (FIA Fluorescencia)» son el mismo; «HEPATITIS B ANTIGENO…» y «HEPATITIS B ANTICORE…» no.
export const METHOD_WORDS = new Set(["eclia", "clia", "cmia", "elisa", "ifi", "fia", "fluorescencia", "inmunofluorescencia", "prueba", "rapida", "rapido", "test", "latex", "hep2"]);
export const variantBase = (value: string): string => [...allNameWords(value)].filter((word) => !VARIANT_WORDS.has(word) && !METHOD_WORDS.has(word)).sort().join(" ");
export function namedChoice(candidates: readonly CatalogStudy[], mention: string): CatalogStudy | undefined {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter(Boolean);
  if (asked.length < 2) return undefined;
  const askedSet = new Set(asked);
  // Un panel solo se elige si el paciente pidió un panel: su lista larga tiene casi cualquier palabra («vih 1 y 2» no es el PANEL INTIMA PLUS de Bs 1250 porque su lista diga «VIH» y «Herpes simple 1»).
  const options = askedSet.has("panel") || askedSet.has("perfil") ? candidates : candidates.filter((candidate) => !isPanel(candidate));
  // Solo entre versiones del MISMO estudio se descarta la que agrega una variante no pedida; entre estudios distintos rige la regla de siempre.
  const sameStudy = options.length > 1 && options.every((candidate) => variantBase(candidate.name) === variantBase(options[0]!.name));
  const withAll = options.filter((candidate) => {
    const words = sameStudy ? allNameWords(candidate.name) : nameWords(candidate.name);
    return asked.every((word) => words.has(word)) && (!sameStudy || [...words].every((word) => !VARIANT_WORDS.has(word) || askedSet.has(word)));
  });
  if (withAll.length === 1) return withAll[0];
  if (withAll.length > 1) {
    const byMethod = preferredByMethod(withAll);
    return byMethod && withAll.every((candidate) => candidate === byMethod || sameWithoutMethod(candidate, byMethod)) ? byMethod : undefined;
  }
  return undefined;
}
// ¿La palabra NOMBRA a estos estudios? Está en el nombre de cada uno (palabra entera), es un alias aprobado de cada uno o es una frase de la lista de sinónimos.
export function namesWord(word: string, studies: readonly CatalogStudy[]): boolean {
  if (studies.length === 0) return false;
  if (isKnownStudyPhrase(word)) return true;
  return studies.every((study) => nameWords(study.name).has(word) || normalizeStudyKey(study.name).split(" ").includes(word) || (study.normalizedAliases ?? []).includes(word));
}
// Dos opciones que solo se diferencian por el método entre paréntesis («PSA TOTAL (ECLIA)» y «PSA TOTAL (FIA Fluorescencia)»).
export const sameWithoutMethod = (a: CatalogStudy, b: CatalogStudy): boolean => normalizeStudyKey(a.name.replace(/\([^)]*\)/g, " ")) === normalizeStudyKey(b.name.replace(/\([^)]*\)/g, " "));

// ───────────── Versiones de un MISMO estudio cuando el médico no las especifica (dueño y cotizaciones reales de la Dra, 20-nov) ─────────────
// Se elige como la Dra, sin preguntar al paciente, solo entre versiones del mismo estudio (mismo nombre sin método, cuantificación, clase de anticuerpo ni muestra):
//   · muestra: en SANGRE (19-nov) — «LDH» no es la «LDH de LÍQUIDOS»;
//   · clase de anticuerpo: IgG + IgM juntas (la Dra en citomegalovirus, rubéola, toxo, clamidia, Epstein-Barr, tuberculosis, herpes 2 y hepatitis A); nunca IgA sola;
//   · método / cuantificación / versión (simple, seriado, express): la MÁS BARATA y, si empatan en precio, la de menor tiempo de entrega (respuestas del laboratorio, 24-nov: anti-TG, vitamina D,
//     dengue, PCR, hemocultivo, paternidad; reemplaza «ECLIA primero» del 12-nov y «PCR → cuantitativa» del 20-nov);
//   · total / libre (T3, T4, PSA, testosterona y cualquier otro): sin decir cuál, el TOTAL directo, sin ofrecer el libre (laboratorio, 24-nov: «ofrecer muchas opciones cansa al paciente»);
//   · si aun así empatan, o difieren en otra cosa (herpes zóster vs. tipo 2), NO se elige: se pregunta al paciente.
export const QUANT_WORDS = new Set(["semi", "semicuantitativo", "semicuantitativa", "cualitativo", "cualitativa", "cuantitativo", "cuantitativa"]);
export const IG_WORDS = new Set(["igg", "igm", "iga", "ige", "igd"]);
export const FORM_WORDS = new Set(["total", "libre", "neonatal", "inversa", "ss", "ds", "simple", "doble", "cadena"]);
export const VERSION_METHOD_WORDS = new Set([...METHOD_WORDS, "inmuno", "inmunocromatografia", "quimioluminiscencia", "electroquimioluminiscencia", "automatizado", "automatizada", "convencional", "seriado", "seriada", "x", "x2", "x3", "express"]);
export const OTHER_SAMPLE = /\b(?:orina|urin\w*|\w+uria|24|heces|liquido|liquidos|lcr|esputo|semen|saliva|hisopado|secrecion)\b/;
export const STOP_WORDS = new Set(["de", "del", "en", "y", "la", "el"]);
export const isPanel = (study: CatalogStudy): boolean => study.name.length > 90 || /^(?:panel|perfil)\b/i.test(study.name.trim());
// Las palabras pedidas están en el nombre (las de 5+ letras por su raíz, sin las 2 últimas letras: «reumatoide» ↔ «reumatoideo», «glicosilad» ↔ «glicosilada»; pero «electrolitos» ≠ «electroforesis»).
export const hasWord = (words: ReadonlySet<string>, asked: string): boolean => {
  if (asked.length < 5) return words.has(asked);
  const root = asked.slice(0, Math.max(5, asked.length - 2));
  return [...words].some((word) => word.startsWith(root));
};
// El nombre del estudio sin lo que va entre paréntesis (también un paréntesis sin cerrar) ni método, cuantificación, clase, forma o muestra.
export const versionBase = (name: string): Set<string> => {
  // «SERIADO X 2» → «x2» (la versión; el número suelto no distingue otro estudio).
  const words = normalizeStudyKey(name.replace(/\([^)]*\)/g, " ").replace(/\([^)]*$/, " ")).replace(/\bx (\d)\b/g, "x$1").split(" ");
  // «IgG E IgM»: la «e» une dos clases (no es la hepatitis E).
  const joinsClasses = words.filter((word) => IG_WORDS.has(word)).length > 1;
  return new Set(words.filter((word) => word !== "" && !VERSION_METHOD_WORDS.has(word) && !QUANT_WORDS.has(word) && !IG_WORDS.has(word) && !FORM_WORDS.has(word) && !STOP_WORDS.has(word)
    && !OTHER_SAMPLE.test(word) && !(joinsClasses && (word === "e" || word === "y"))));
};
export const hoursOf = (text: string | null | undefined): number | undefined => {
  const value = normalizeStudyKey(text ?? "");
  const n = Number(value.match(/\d+/)?.[0] ?? NaN);
  if (/minuto/.test(value)) return Number.isNaN(n) ? undefined : n / 60;
  if (/hora/.test(value)) return Number.isNaN(n) ? undefined : n;
  if (/en el dia|mismo dia/.test(value)) return 10;
  if (/dia/.test(value)) return Number.isNaN(n) ? undefined : n * 24;
  if (/semana/.test(value)) return Number.isNaN(n) ? undefined : n * 168;
  return undefined;
};
// La MÁS BARATA; si empatan en precio, la de menor tiempo de entrega si es UNA. Lo que el paciente dijo (método o cuantificación) manda.
export function cheapestVersion(pool: readonly CatalogStudy[], asked: readonly string[]): CatalogStudy | undefined {
  let candidates = [...pool];
  const said = asked.filter((word) => VERSION_METHOD_WORDS.has(word) || QUANT_WORDS.has(word));
  if (said.length > 0) candidates = candidates.filter((study) => said.every((word) => hasWord(allNameWords(study.name), word)));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  const lowest = Math.min(...candidates.map((study) => study.priceBs));
  candidates = candidates.filter((study) => study.priceBs === lowest);
  if (candidates.length === 1) return candidates[0];
  const hours = candidates.map((study) => hoursOf(study.turnaroundText));
  if (hours.some((value) => value === undefined)) return undefined;
  const best = Math.min(...(hours as number[]));
  const fastest = candidates.filter((_, index) => hours[index] === best);
  return fastest.length === 1 ? fastest[0] : undefined;
}
// La búsqueda entrega pocas opciones (tope de 4): para elegir la versión más barata hacen falta TODAS las versiones del mismo estudio («toxoplasma»: sin esto quedaba fuera «INMUNO TOXO IgG» y salía la
// ELISA de Bs 90). Se suman las del catálogo con el mismo nombre base que alguna de las opciones.
export function withVersionSiblings(candidates: readonly CatalogStudy[], catalog: readonly CatalogStudy[]): CatalogStudy[] {
  const key = (study: CatalogStudy) => [...versionBase(study.name)].sort().join(" ");
  const bases = new Set(candidates.filter((study) => !isPanel(study)).map(key));
  const siblings = catalog.filter((study) => study.active && !isPanel(study) && bases.has(key(study)) && !candidates.some((item) => item.id === study.id));
  return [...candidates, ...siblings];
}
export function chooseVersions(candidates: readonly CatalogStudy[], mention: string): CatalogStudy[] | undefined {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter((word) => word !== "" && !STOP_WORDS.has(word));
  if (asked.length === 0 || candidates.length < 2) return undefined;
  // «doble cadena» = ds, «simple cadena» = ss
  const askedForms = new Set(asked.filter((word) => FORM_WORDS.has(word)));
  if (askedForms.has("doble")) askedForms.add("ds");
  if (askedForms.has("simple")) askedForms.add("ss");
  let pool = candidates.filter((study) => !isPanel(study));
  if (!asked.some((word) => OTHER_SAMPLE.test(word))) {
    const blood = pool.filter((study) => !OTHER_SAMPLE.test(normalizeStudyKey(study.name)));
    if (blood.length > 0) pool = blood;
  }
  pool = pool.filter((study) => { const words = allNameWords(study.name); return asked.every((word) => FORM_WORDS.has(word) || hasWord(words, word)); });
  if (pool.length === 0) return undefined;
  // Solo las versiones «puras» (las demás agregan algo más al nombre: «CARGA VIRAL», «pneumoniae», «H.A.I.»).
  const bases = pool.map((study) => versionBase(study.name));
  const minimal = [...bases].sort((a, b) => a.size - b.size)[0]!;
  if (!bases.every((base) => [...minimal].every((word) => base.has(word)))) return undefined;
  pool = pool.filter((_, index) => bases[index]!.size === minimal.size);
  // Forma (total/libre/neonatal/ss/ds): la que no agrega una forma no pedida; si todas agregan una, se pregunta.
  // «simple» es una forma solo en «simple cadena» (anti-DNA); en «HEMOCULTIVO … SIMPLE» es la versión de una muestra.
  const formsOf = (study: CatalogStudy) => { const words = allNameWords(study.name); return [...words].filter((word) => FORM_WORDS.has(word) && word !== "cadena" && (word !== "simple" || words.has("cadena"))); };
  let plain = pool.filter((study) => formsOf(study).every((word) => askedForms.has(word)));
  // Sin decir total ni libre: el TOTAL (laboratorio, 24-nov).
  if (plain.length === 0 && askedForms.size === 0) plain = pool.filter((study) => formsOf(study).every((word) => word === "total"));
  if (plain.length === 0) return undefined;
  pool = plain;
  if (pool.length === 1) return pool;
  // Clase de anticuerpo: IgG + IgM (o la que pidió).
  const igOf = (study: CatalogStudy) => [...allNameWords(study.name)].filter((word) => IG_WORDS.has(word));
  if (pool.some((study) => igOf(study).length > 0)) {
    const askedIg = asked.filter((word) => IG_WORDS.has(word));
    // Una prueba que trae las dos clases juntas («DENGUE TEST RAPIDO IgG E IgM»): sin pedir una clase, compite por precio con IgG + IgM por separado (gana la más barata, laboratorio 24-nov).
    const combined = askedIg.length === 0 ? cheapestVersion(pool.filter((study) => igOf(study).length > 1), asked) : undefined;
    if (pool.some((study) => igOf(study).length > 1) && askedIg.length > 0) return undefined;
    pool = pool.filter((study) => igOf(study).length <= 1);
    const present = new Set(pool.flatMap(igOf));
    const classes = (askedIg.length > 0 ? askedIg : ["igg", "igm"]).filter((cls) => present.has(cls));
    const out: CatalogStudy[] = [];
    for (const cls of classes) {
      const pick = cheapestVersion(pool.filter((study) => { const ig = igOf(study); return ig.length === 1 && ig[0] === cls; }), asked);
      if (!pick) {
        out.length = 0;
        break;
      }
      out.push(pick);
    }
    // La prueba combinada gana si cuesta lo mismo o menos que las separadas juntas: se le descuenta el precio de cada una y se mira si queda algo. Solo se compara; ningún precio sale de aquí.
    let combinedLeft = combined?.priceBs ?? Number.POSITIVE_INFINITY;
    for (const study of out) combinedLeft -= study.priceBs;
    if (combined && (out.length === 0 || combinedLeft <= 0)) return [combined];
    return out.length > 0 ? out : undefined;
  }
  const pick = cheapestVersion(pool, asked);
  return pick ? [pick] : undefined;
}

// Siglas con puntos en el catálogo («H.I.V 1,2», «H.A.I. TOXO», «CELULAS L.E.»): normalizadas quedan «h i v», que nadie escribe así. Se agrega (solo en memoria, sin tocar el catálogo) el alias
// con la sigla junta («hiv 1 2», «hai toxo»). Así la prueba rápida de HIV de Bs 50 aparece entre las opciones de «vih».
export const dottedCache = new WeakMap<readonly CatalogStudy[], readonly CatalogStudy[]>();
export function withJoinedAcronyms(catalog: readonly CatalogStudy[]): readonly CatalogStudy[] {
  const cached = dottedCache.get(catalog);
  if (cached) return cached;
  const out = catalog.map((study) => {
    if (!/\b(?:[A-Za-z]\.){2,}/.test(study.name)) return study;
    const joined = normalizeStudyKey(study.name.replace(/\b((?:[A-Za-z]\.){2,}[A-Za-z]?)\.?/g, (acronym) => acronym.replace(/\./g, "")));
    const bare = normalizeStudyKey(study.name.replace(/\([^)]*\)/g, " ").replace(/\b((?:[A-Za-z]\.){2,}[A-Za-z]?)\.?/g, (acronym) => acronym.replace(/\./g, "")));
    const extra = [joined, bare].filter((alias) => alias !== "" && alias !== study.normalizedName && !(study.normalizedAliases ?? []).includes(alias));
    return extra.length > 0 ? { ...study, normalizedAliases: [...(study.normalizedAliases ?? []), ...new Set(extra)] } : study;
  });
  dottedCache.set(catalog, out);
  return out;
}

// ───────────── Nombres de GRUPO: lo que la Dra cotiza cuando el médico escribe el nombre del perfil (capturas 4–20 nov) ─────────────
// Si el catálogo tiene un estudio con ese nombre (un panel), manda el catálogo. «pending»: el laboratorio aún no confirmó la composición → se ofrecen como opciones (no se cotizan solos).
// `labDefault`: lo que el LABORATORIO decidió cotizar cuando el estudio se nombra a secas (respuestas del 24-nov). Manda aunque el catálogo tenga un alias con ese nombre (p. ej. «hcg» está en las tres HCG).
// `note`: lo que el redactor debe decir en una frase (p. ej. anti-DNA: el médico confirma cuál).
// `ask` (dueño, 25-nov): estudios con muchas opciones que dependen de un dato que solo tiene el paciente (zona de la muestra, tamaño): NO se elige; se le pide ese dato con este texto ({precio}: el
// precio si todas cuestan lo mismo; {desde}: el más bajo). `hideOptions`: no se listan las opciones (biopsias: el precio lo confirma la doctora con el tamaño de la muestra).
export type StudyGroup = { phrases: readonly string[]; components: readonly string[]; pending?: true; labDefault?: true; note?: string; ask?: string; hideOptions?: true };
export const STUDY_GROUPS: ReadonlyArray<StudyGroup> = [
  { phrases: ["chagas", "examen de chagas", "prueba de chagas", "test de chagas"], components: ["HAI CHAGAS"], labDefault: true },
  { phrases: ["factor reumatoide", "factor reumatoideo", "latex factor reumatoide", "latex", "fr", "factor rx", "reumatoide"], components: ["LATEX FACTOR REUMATOIDE (SEMI CUANTITATIVO)"], labDefault: true },
  { phrases: ["hcg", "beta hcg", "bhcg", "b hcg", "prueba de embarazo", "test de embarazo", "examen de embarazo", "embarazo", "gonadotropina corionica humana"], components: ["HCG SUB UNIDAD BETA-CUALITATIVA (HCG)"], labDefault: true },
  { phrases: ["dengue", "test de dengue", "prueba de dengue", "examen de dengue"], components: ["DENGUE TEST RAPIDO IgG E IgM"], labDefault: true },
  { phrases: ["paternidad", "prueba de paternidad", "adn paternidad", "prueba de adn", "examen de paternidad", "test de paternidad"], components: ["ADN (Paternidad 2 muestras- padre e hijo) - Sangre con EDTA, Hisopado Bucal"], labDefault: true },
  { phrases: ["ionograma", "electrolitos", "electrolitos en sangre"], components: ["IONOGRAMA 1 (sodio, potasio, cloro)"], labDefault: true },
  { phrases: ["anti dna", "antidna", "anti adn", "antiadn", "anti dna igg"], components: ["ANTI-DNA ss (Simple Cadena) IgG (Elisa)", "ANTI-DNA ds (Doble Cadena) IgG (Elisa)"], labDefault: true, note: "Anti-DNA: se cotizan las dos versiones (simple y doble cadena) porque el laboratorio lo indica así; dile en una frase que su médico confirma cuál necesita." },
  // Respuestas del dueño (25-nov), con la regla «sin especificar = la más barata»:
  //   · anticore sin clase → el TOTAL (Bs 150: mide IgG e IgM en una sola prueba; IgG + IgM por separado costaban Bs 400). «anti HBc» cotizaba solo la IgG;
  //   · vitamina D → 25 (OH) por FIA; colesterol → total; micológico → el directo (KOH); panel respiratorio → el de 20 patógenos; galactomanano → el antígeno por ELISA (no el IgG de Bs 600).
  { phrases: ["anticore", "anti core", "anti hbc", "antihbc", "anti hbc total", "anticore total", "hepatitis b anticore", "anticore hepatitis b", "anticore de hepatitis b", "anticore hepatitis", "hbcab", "anticuerpo anticore", "anticuerpos anticore"], components: ["HEPATITIS B ANTICORE TOTAL"], labDefault: true },
  { phrases: ["vitamina d", "vit d", "vitamina d 25", "vitamina d 25 oh", "vitamina d 25oh", "25 oh vitamina d", "25 oh vit d", "25 hidroxi vitamina d", "25 hidroxivitamina d", "vitamina d total"], components: ["VITAMINA D 25 (OH) (FIA Fluorescencia)"], labDefault: true },
  { phrases: ["colesterol", "colesterol serico", "colesterolemia"], components: ["COLESTEROL TOTAL"], labDefault: true },
  { phrases: ["micologico", "examen micologico", "estudio micologico", "micologico directo", "koh", "examen directo koh", "hongos koh"], components: ["MICOLÓGICO DIRECTO - MICROSCOPIA KOH 10 %"], labDefault: true },
  { phrases: ["panel respiratorio", "panel respiratorio mixto", "panel respiratorio qpcr", "panel respiratorio mixto qpcr", "panel viral respiratorio", "panel de virus respiratorios"], components: ["PANEL RESPIRATORIO MIXTO qPCR (20 PATOGENOS) VIRUS: Sincitial A/B, Influenza B, Influenza A, SARS-CoV-2, Adenovirus humano, Rinovirus Humano, Coronavirus humano 229E/OC43, Coronavirus humano NL63/HKU1, Parainfluenza Humana 1/2, Parainfluenza humana 3/4, Bocavirus, Metapneumovirus, Enterovirus. BACTERIAS: Streptococcus pyogenes, Haemophilus influenzae, Bordetella pertussis, Streptococcus neumoniae, Mycoplasma pneumoniae, Legionella pneumophila."], labDefault: true },
  { phrases: ["galactomanano", "galactomanano antigeno", "antigeno galactomanano", "antigeno de galactomanano", "galactomanano aspergilosis", "aspergilosis", "aspergillus galactomanano"], components: ["GALACTOMANANO Antigeno (ASPERGILOSIS) CUANTITATIVO (Elisa)"], labDefault: true },
  // Herpes sin tipo → «tipo 1 y 2» (cubre lo pedido; el «tipo 2» solo es más barato pero no cubre el 1 y el zóster es otro virus). Dueño, 25-nov, hasta que responda el laboratorio.
  { phrases: ["herpes", "herpes simple", "herpes simplex", "herpes 1 y 2", "herpes tipo 1 y 2", "herpes igg igm", "herpes igg e igm", "herpes igg y igm", "hsv", "hsv 1 y 2", "herpes 1 2"], components: ["HERPES tipo 1 y 2 IgG (Elisa)", "HERPES tipo 1 y 2 IgM (Elisa)"], labDefault: true },
  { phrases: ["herpes igg", "herpes simple igg", "hsv igg", "herpes 1 y 2 igg"], components: ["HERPES tipo 1 y 2 IgG (Elisa)"], labDefault: true },
  { phrases: ["herpes igm", "herpes simple igm", "hsv igm", "herpes 1 y 2 igm"], components: ["HERPES tipo 1 y 2 IgM (Elisa)"], labDefault: true },
  // Hepatitis B: el médico dice el marcador; sin método, la más barata (dueño, 25-nov). Los nombres del catálogo dicen «SUP.», nadie lo escribe así: sin estas frases quedaban en duda.
  { phrases: ["antigeno de superficie", "antigeno superficie", "hepatitis b antigeno de superficie", "hepatitis b antigeno superficie", "antigeno de superficie hepatitis b", "antigeno de superficie de hepatitis b", "antigeno de superficie para hepatitis b", "hbsag", "hepatitis b hbsag", "hbsag hepatitis b", "ag hbs", "aghbs", "hbs ag", "antigeno australiano", "hepatitis b antigeno de sup", "antigeno de sup"], components: ["HEPATITIS B ANTIGENO DE SUP. (PRUEBA RAPIDA)"], labDefault: true },
  { phrases: ["hbsag eclia", "antigeno de superficie eclia", "hepatitis b antigeno de superficie eclia", "antigeno de superficie por eclia", "hbsag por eclia"], components: ["HEPATITIS B ANTIGENO DE SUP. (ECLIA)"], labDefault: true },
  { phrases: ["anticuerpo de superficie", "anticuerpos de superficie", "hepatitis b anticuerpo de superficie", "anticuerpo de superficie hepatitis b", "anticuerpo de superficie de hepatitis b", "anti hbs", "antihbs", "anti hbsag", "hepatitis b anticuerpo de sup", "anticuerpo de sup"], components: ["HEPATITIS B ANTICUERPO DE SUP. PRUEBA RAPIDA"], labDefault: true },
  // Se le PIDE el dato al paciente (dueño, 25-nov): muchas opciones que dependen de la muestra.
  { phrases: ["cultivo de secrecion", "cultivo secrecion", "cultivo de secreciones", "cultivo de secrecion convencional", "cultivo y antibiograma de secrecion"], components: ["CULTIVO DE SECRECION FARINGEA - CONVENCIONAL", "CULTIVO DE SECRECION NASAL - CONVENCIONAL", "CULTIVO DE SECRECION URETRAL - CONVENCIONAL", "CULTIVO DE SECRECION VAGINAL - CONVENCIONAL", "CULTIVO DE SECRECIÓN BRONQUIAL - CONVENCIONAL", "CULTIVO DE SECRECIÓN OCULAR - CONVENCIONAL"], pending: true, ask: "Para el *cultivo de secreción* necesito saber de qué zona es la muestra (faríngea, nasal, uretral, vaginal, bronquial u ocular). Todas cuestan {precio}: dime cuál te indicó tu médico y te lo cotizo." },
  { phrases: ["microalbuminuria", "microalbumina", "micro albuminuria", "microalbumina en orina", "microalbuminuria en orina"], components: ["MICROALBUMINURIA 24 HORAS (FIA Inmunofluorescencia)", "MICROALBUMINURIA OCASIONAL (FIA Inmunofluorescencia)"], pending: true, ask: "La *microalbuminuria* puede ser en orina de 24 horas u ocasional, y las dos cuestan {precio}. Dime cuál te indicó tu médico y te la cotizo." },
  { phrases: ["biopsia", "biopsias", "estudio de biopsia", "anatomia patologica", "histopatologia", "histopatologico", "estudio histopatologico", "pieza quirurgica", "pieza operatoria"], components: ["BIOPSIAS PEQUEÑAS (ENDOSCOPICAS O PUNCION)", "MUESTRA PEQUEÑA (1 FRASCO 100 ML)", "MUESTRA MEDIANA (1 FRASCO 500 ML)", "MUESTRA GRANDE (1 FRASCO 1000 ML)", "MUESTRA FRASCO (1 LITRO A 5 LITROS)", "MUESTRA FRASCO (MAYOR A 5 LITROS)"], pending: true, hideOptions: true, ask: "El estudio de *biopsia* cuesta desde {desde}, según el tamaño o la cantidad de la muestra. Indícame ese dato (por ejemplo, en qué frasco o de qué tamaño es) y la doctora te confirma el precio por este chat." },
  { phrases: ["transaminasas", "transaminasa", "transa"], components: ["TRANSAMINASA GOT", "TRANSAMINASA GPT"] },
  { phrases: ["perfil lipidico", "perfil de lipidos", "lipidograma", "perfil lipidico completo"], components: ["COLESTEROL TOTAL", "COLESTEROL HDL", "COLESTEROL LDL", "TRIGLICERIDOS"] },
  { phrases: ["perfil hepatico", "hepatograma", "pruebas hepaticas", "funcion hepatica", "hepatico", "perfil hepatico completo"], components: ["TRANSAMINASA GOT", "TRANSAMINASA GPT", "BILIRRUBINA TOTAL Y FRACCIONES", "FOSFATASA ALCALINA", "GAMA GLUTAMIL TRANSFERASA GGT"] },
  { phrases: ["perfil renal", "funcion renal", "pruebas renales", "perfil renal completo"], components: ["CREATININA", "UREA", "EXAMEN GENERAL DE ORINA COMPLETA"] },
  // Composición confirmada por el laboratorio (24-nov): TP + INR, TTPa y fibrinógeno.
  { phrases: ["coagulograma", "pruebas de coagulacion", "perfil de coagulacion", "coagulacion"], components: ["TIEMPO DE PROTROMBINA + INR", "TIEMPO PARCIAL DE TROMBOPLASTINA (APTT)", "FIBRINOGENO"] }
];
export type GroupFound = { studies: CatalogStudy[]; pending: boolean; note?: string; ask?: string; hideOptions?: true };
export function groupOf(mention: string, catalog: readonly CatalogStudy[]): GroupFound | undefined {
  const key = normalizeStudyKey(mention);
  const group = STUDY_GROUPS.find((item) => item.phrases.includes(key));
  if (!group) return undefined;
  if (!group.labDefault && catalog.some((study) => normalizeStudyKey(study.name) === key || (study.normalizedAliases ?? []).includes(key))) return undefined;
  return foundGroup(group, catalog);
}
function foundGroup(group: StudyGroup, catalog: readonly CatalogStudy[]): GroupFound | undefined {
  const byName = new Map(catalog.filter((study) => study.active).map((study) => [normalizeStudyKey(study.name), study]));
  const studies = group.components.map((name) => byName.get(normalizeStudyKey(name))).filter((study): study is CatalogStudy => study !== undefined);
  // Una elección del laboratorio vale solo si están TODOS sus estudios (si el catálogo cambió un nombre, sigue la regla general).
  if (group.labDefault && studies.length !== group.components.length) return undefined;
  if (studies.length === 0) return undefined;
  const ask = group.ask ? askText(group.ask, studies) : undefined;
  return { studies, pending: group.pending === true, ...(group.note ? { note: group.note } : {}), ...(ask ? { ask } : {}), ...(group.hideOptions ? { hideOptions: true as const } : {}) };
}
// {precio}: el precio común (si todas cuestan lo mismo); {desde}: el más bajo. Sin precio común, «{precio}» pasa a «desde …». Los precios salen del catálogo, nunca del texto.
function askText(template: string, studies: readonly CatalogStudy[]): string {
  const prices = studies.map((study) => study.priceBs).filter((price) => Number.isFinite(price) && price > 0);
  if (prices.length === 0) return template.replace(/\s*Todas cuestan \{precio\}:?/i, "").replace(/,? y las dos cuestan \{precio\}/i, "").replace(/ desde \{desde\}/, "");
  const lowest = Math.min(...prices);
  const same = prices.every((price) => price === lowest);
  return template.replace("{precio}", same ? `Bs ${lowest}` : `desde Bs ${lowest}`).replace("{desde}", `Bs ${lowest}`);
}
// Grupos «se le pide el dato al paciente» cuyas opciones aparecen (al menos dos) entre estos estudios: para la receta, donde no hay frase del paciente sino las opciones del modelo.
export function askGroupsAmong(ids: Iterable<string>, catalog: readonly CatalogStudy[]): GroupFound[] {
  const present = new Set(ids);
  const out: GroupFound[] = [];
  for (const group of STUDY_GROUPS) {
    if (!group.ask) continue;
    const found = foundGroup(group, catalog);
    if (found && found.studies.filter((study) => present.has(study.id)).length >= 2) out.push(found);
  }
  return out;
}
// Una línea de la receta que es uno de esos estudios: por su frase («cultivo de secreción») o porque TODAS las opciones del modelo son de UN solo grupo así.
export function askGroupFor(text: string, candidateIds: readonly string[], catalog: readonly CatalogStudy[]): GroupFound | undefined {
  for (const key of new Set([normalizeStudyKey(text), normalizeStudyKey(coreOfMention(text))])) {
    const group = STUDY_GROUPS.find((item) => item.ask && item.phrases.includes(key));
    const found = group ? foundGroup(group, catalog) : undefined;
    if (found) return found;
  }
  const ids = new Set(candidateIds);
  const groups = askGroupsAmong(ids, catalog);
  if (groups.length !== 1) return undefined;
  const members = new Set(groups[0]!.studies.map((study) => study.id));
  return [...ids].every((id) => members.has(id)) ? groups[0] : undefined;
}

// ───────────── El MISMO examen con nombres distintos en el catálogo (dueño, 25-nov: «urea y BUN son lo mismo»; sin método = el más barato) ─────────────
// Los nombres no comparten la base (por eso la regla de versiones no los veía como versiones): «ANA (ANTICUERPOS ANTINUCLEARES) Elisa» y «ANA / FAN HEP2 IFI». Si la duda es solo entre estos: el
// que nombra lo escrito; si no, el más barato que respete el método escrito; si empatan en precio, el primero de la lista.
export const SAME_EXAM: ReadonlyArray<readonly string[]> = [
  ["UREA", "BUN DE UREA"],
  ["ANA (ANTICUERPOS ANTINUCLEARES) Elisa", "ANA / FAN HEP2 IFI"],
  ["GIARDIA (AG. EN HECES prueba rapida)", "Giardiasis Elisa"],
  ["ANTI-CCP (FIA Fluorescencia)", "ANTI-CCP3 (3ra. Generación) Elisa"],
  ["GALACTOMANANO Antigeno (ASPERGILOSIS) CUANTITATIVO (Elisa)", "GALACTOMANANO antigeno (ASPERGILOSIS) Inmunocromatografia"]
];
export function sameExamChoice(candidates: readonly CatalogStudy[], text: string): CatalogStudy | undefined {
  if (candidates.length < 2) return undefined;
  const set = SAME_EXAM.find((names) => candidates.every((study) => names.some((name) => normalizeStudyKey(name) === normalizeStudyKey(study.name))));
  if (!set) return undefined;
  const order = (study: CatalogStudy) => set.findIndex((name) => normalizeStudyKey(name) === normalizeStudyKey(study.name));
  const key = normalizeStudyKey(coreOfMention(text));
  const exact = candidates.filter((study) => normalizeStudyKey(study.name) === key || (study.normalizedAliases ?? []).includes(key));
  if (exact.length === 1) return exact[0];
  const asked = key.split(" ").filter((word) => VERSION_METHOD_WORDS.has(word));
  const pool = asked.length > 0 ? candidates.filter((study) => asked.every((word) => hasWord(allNameWords(study.name), word))) : [...candidates];
  if (pool.length === 0) return undefined;
  return [...pool].sort((a, b) => a.priceBs - b.priceBs || order(a) - order(b))[0];
}

// ¿El texto nombra una muestra que no es sangre (orina, heces, líquido, hisopado…)?
export const mentionsOtherSample = (text: string): boolean => normalizeStudyKey(text).split(" ").some((word) => OTHER_SAMPLE.test(word));

// ───────────── Fotos de recetas: la misma decisión para un estudio LEÍDO con certeza que el catálogo no resolvió a uno solo ─────────────
// Lo que el laboratorio decidió para el texto vale igual para la receta (dueño, 24-nov: «es información que debe ayudar a decidir también en las fotos»):
//   · un nombre de grupo/elección fija («chagas», «coagulograma», «perfil lipídico») → sus estudios, solo si el catálogo los tiene TODOS;
//   · varias versiones del MISMO estudio sin decir cuál → la regla de versiones (sangre, TOTAL, IgG + IgM, la más barata; empate → la más rápida).
// Nunca elige entre estudios distintos (hepatitis B antígeno vs. anticore): ahí sigue la duda con opciones (el médico lo especifica; la lectura debe captarlo).
//   · (25-nov) la línea es EXACTAMENTE el nombre (o un alias) de UNA de las opciones («GLUCOSA», «AMONIO») → esa; la carga viral solo si la receta la nombra; el mismo examen con otro nombre → SAME_EXAM.
export type ReadingChoice = { studies: CatalogStudy[]; rule: "LAB_GROUP" | "VERSION" | "EXACT_NAME" | "SAME_EXAM"; note?: string };
// Pruebas moleculares (carga viral, detección por PCR): nunca por defecto; solo si la línea las nombra («CMV» → IgG + IgM, no la carga viral de Bs 600).
const MOLECULAR_NAME = /\b(?:carga viral|deteccion|biologia molecular)\b|\bqpcr\b/;
const MOLECULAR_ASKED = /\b(?:carga|viral|deteccion|pcr|qpcr|adn|arn|genotipo|genotipificacion|molecular)\b/;
export function decideFromReading(text: string, candidateIds: readonly string[], catalog: readonly CatalogStudy[], options: { bloodDefault?: boolean } = {}): ReadingChoice | undefined {
  const keys = [...new Set([normalizeStudyKey(text), normalizeStudyKey(coreOfMention(text))])].filter((key) => key !== "");
  for (const key of keys) {
    const group = STUDY_GROUPS.find((item) => item.phrases.includes(key));
    if (!group || group.pending) continue;
    const found = groupOf(key, catalog);
    if (found && !found.pending && found.studies.length === group.components.length && found.studies.every((study) => study.active)) {
      return { studies: found.studies, rule: "LAB_GROUP", ...(found.note ? { note: found.note } : {}) };
    }
  }
  const byId = new Map(catalog.map((study) => [study.id, study]));
  const offered = [...new Set(candidateIds)].map((id) => byId.get(id)).filter((study): study is CatalogStudy => Boolean(study && study.active));
  if (offered.length < 2) return undefined;
  // La línea ES el nombre (o un alias aprobado) de UNA de las opciones: esa. Salvo que el documento declare otra muestra y alguna opción sea de otra muestra («SODIO» con «MUESTRA: ORINA»).
  const exact = offered.filter((study) => keys.some((key) => normalizeStudyKey(study.name) === key || (study.normalizedAliases ?? []).includes(key)));
  const otherSampleOption = offered.some((study) => OTHER_SAMPLE.test(normalizeStudyKey(study.name)));
  if (exact.length === 1 && !(options.bloodDefault === false && otherSampleOption)) return { studies: exact, rule: "EXACT_NAME" };
  // Sin nombrar una prueba molecular, la carga viral / detección no es una opción.
  const molecularAsked = keys.some((key) => MOLECULAR_ASKED.test(key));
  const candidates = molecularAsked ? offered : offered.filter((study) => !MOLECULAR_NAME.test(normalizeStudyKey(study.name)));
  if (candidates.length === 0) return undefined;
  // Queda una sola (la otra era la carga viral): sigue la regla de versiones con sus hermanas del catálogo («CMV» con IgG y carga viral → IgG + IgM).
  if (candidates.length === 1 && isPanel(candidates[0]!)) return undefined;
  const same = sameExamChoice(candidates, text);
  if (same) return { studies: [same], rule: "SAME_EXAM" };
  // Solo si la duda del modelo es ENTRE VERSIONES DE UN MISMO ESTUDIO (todas sus opciones tienen el mismo nombre base: «TSH (ECLIA)» y «TSH (FIA)», «TOXO IgG» e «INMUNO TOXO IgM»).
  // Si duda entre estudios distintos («FSH» y «LH», «GOT» y «GPT», «HAI CHAGAS» y «HAI TOXO»), eso no lo decide ninguna regla de versiones: sigue la duda (es de lectura).
  const key = (study: CatalogStudy) => [...versionBase(study.name)].sort().join(" ");
  const bases = new Set(candidates.map(key));
  // Muestra por defecto EN SANGRE (dueño, 19-nov): «ÁCIDO ÚRICO» entre el de sangre y el «EN ORINA 24 HORAS» es el de sangre si la receta no dice orina. Vale solo si las versiones en sangre son de un
  // mismo estudio y cada opción de otra muestra lleva ese mismo nombre (es el mismo análisis en otra muestra, no otro estudio).
  if (bases.size > 1 && options.bloodDefault !== false && !mentionsOtherSample(text)) {
    const blood = candidates.filter((study) => !OTHER_SAMPLE.test(normalizeStudyKey(study.name)));
    const bloodBases = new Set(blood.map(key));
    const [only] = [...bloodBases];
    const sameAnalysis = (study: CatalogStudy) => { const words = allNameWords(study.name); return only !== undefined && only.split(" ").every((word) => words.has(word)); };
    if (bloodBases.size === 1 && only !== "" && candidates.every((study) => blood.includes(study) || sameAnalysis(study))) {
      const chosen = chooseAmong(blood.length > 1 ? blood : candidates, text, catalog);
      return chosen && chosen.every((study) => study.active && key(study) === only) ? { studies: chosen, rule: "VERSION" } : undefined;
    }
  }
  if (bases.size !== 1 || bases.has("")) return undefined;
  const related = (studies: readonly CatalogStudy[]) => studies.length > 0 && studies.every((study) => study.active && bases.has(key(study)));
  // 1) Lo que cotizaría el TEXTO con esa misma línea (nombres, alias, sinónimos: «toxoplasma» = «toxo»), si lo resuelve entero y sin dudas.
  const text_ = textDecisionFor(text, catalog);
  if (!text_.unresolved && text_.doubt.length === 0 && related(text_.sure)) return { studies: text_.sure, rule: "VERSION" };
  // 2) Si no, la regla de versiones sobre las opciones del modelo.
  const chosen = chooseAmong(candidates, text, catalog);
  return chosen && related(chosen) ? { studies: chosen, rule: "VERSION" } : undefined;
}

// Lo que la cotización por texto haría con una línea: la misma separación de nombres («toxoplasma igg e igm» → dos; «toxoplasma» → «toxo»), el mismo motor (quote-session.ts) y la misma decisión
// entre opciones (chooseAmong), sobre el mismo catálogo (siglas con puntos unidas). Sin dividir en palabras sueltas ni sugerencias: lo que no se resuelve entero queda sin resolver.
export function textDecisionFor(text: string, rawCatalog: readonly CatalogStudy[]): { sure: CatalogStudy[]; doubt: CatalogStudy[]; unresolved: boolean } {
  const catalog = withJoinedAcronyms(rawCatalog);
  const known = knownNamesOf(catalog);
  const split = splitStudyMentions(text, { isKnownName: (name) => known.has(name) || isKnownStudyPhrase(name) });
  const mentions = split.length > 0 ? split : [text];
  const sure = new Map<string, CatalogStudy>();
  const doubt = new Map<string, CatalogStudy>();
  let unresolved = false;
  for (const mention of mentions) {
    const one = mentionDecision(mention, catalog);
    for (const study of one.sure) sure.set(study.id, study);
    for (const study of one.doubt) doubt.set(study.id, study);
    unresolved ||= one.unresolved;
  }
  return { sure: [...sure.values()], doubt: [...doubt.values()], unresolved };
}

function mentionDecision(text: string, catalog: readonly CatalogStudy[]): { sure: CatalogStudy[]; doubt: CatalogStudy[]; unresolved: boolean } {
  const group = groupOf(coreOfMention(text), catalog);
  if (group) return group.pending ? { sure: [], doubt: group.studies, unresolved: false } : { sure: group.studies, doubt: [], unresolved: false };
  const core = coreOfMention(text);
  const withoutBlood = core.replace(/\b(?:serico|serica|plasmatico|plasmatica|sanguineo|sanguinea|en sangre)\b/g, " ").replace(/\s+/g, " ").trim();
  const forms = [...new Set([text, core, sampleAsAdjective(core), withoutBlood].filter((form) => form.length >= 2))];
  const byId = new Map(catalog.map((study) => [study.id, study]));
  for (const form of forms) {
    const { extraction, notes } = extractWithNotes(`cotizar ${form}`, catalog, { fuzzy: true });
    if (!extraction?.isRequest || (extraction.matched.length === 0 && extraction.result.ambiguous.length === 0)) continue;
    const fuzzy = new Set(notes.interpreted.map((item) => item.studyName));
    const sure = new Map<string, CatalogStudy>();
    const doubt = new Map<string, CatalogStudy>();
    const groups = extraction.result.ambiguous.map((group) => group.map((id) => byId.get(id)).filter((study): study is CatalogStudy => study !== undefined));
    for (const study of extraction.matched) {
      const review = reviewFuzzy(study, text, catalog);
      if ("replace" in review) sure.set(review.replace.id, review.replace);
      else if ("keep" in review || !fuzzy.has(study.name)) sure.set(study.id, study);
      else groups.push(review.doubt);
    }
    for (const group of groups) {
      const chosen = chooseAmong(group, text, catalog);
      if (chosen) for (const study of chosen) sure.set(study.id, study);
      else for (const study of group) doubt.set(study.id, study);
    }
    return { sure: [...sure.values()], doubt: [...doubt.values()], unresolved: extraction.result.unresolved > 0 };
  }
  return { sure: [], doubt: [], unresolved: true };
}

// Sugerencias por ERRATA (solo opciones, nunca se cobran solas): primero un nombre con elección del laboratorio («hgc» → «hcg» → la HCG cualitativa); si no, los estudios del catálogo que
// se parecen por una letra («lipsaa» → LIPASA). `exclude`: los que ya están cotizados.
export function typoSuggestions(forms: readonly string[], catalog: readonly CatalogStudy[], exclude: { has(id: string): boolean } = new Set<string>(), limit = 5): CatalogStudy[] {
  const typoPhrase = STUDY_GROUPS.filter((group) => group.labDefault).flatMap((group) => group.phrases).find((phrase) => forms.some((form) => isTypoOf(normalizeStudyKey(form), phrase)));
  const typoDefault = typoPhrase ? groupOf(typoPhrase, catalog)?.studies.filter((study) => !exclude.has(study.id)) ?? [] : [];
  return typoDefault.length > 0 ? typoDefault : forms.flatMap((form) => typoCandidates(form, catalog, limit)).filter((study) => !exclude.has(study.id));
}

// ───────────── La búsqueda por parecido nunca elige SOLA una variante que el paciente no escribió ─────────────
// «hepatitis» → «HEPATITIS E» (la «e» no se escribió y hay otras hepatitis); «testosterona» → «TOTAL» (existe la LIBRE). Ni se queda con un nombre al que le falta lo escrito:
// «hemoglobina glicosilad» → «HEMOGLOBINA» (falta «glicosilada»). En esos casos el resultado pasa a ser una duda entre las opciones que sí tienen todo lo escrito.
export const SIGNIFICANT = (word: string): boolean => word.length >= 4 && !STOP_WORDS.has(word);
export function reviewFuzzy(study: CatalogStudy, mention: string, catalog: readonly CatalogStudy[]): { keep: CatalogStudy } | { replace: CatalogStudy } | { doubt: CatalogStudy[] } {
  const asked = normalizeStudyKey(coreOfMention(mention)).split(" ").filter((word) => word !== "");
  const words = allNameWords(study.name);
  if (asked.filter(SIGNIFICANT).some((word) => !hasWord(words, word))) {
    const alternatives = catalog.filter((other) => !isPanel(other) && asked.filter(SIGNIFICANT).every((word) => hasWord(allNameWords(other.name), word)));
    if (alternatives.length === 1) return { replace: alternatives[0]! };
    if (alternatives.length > 1 && alternatives.length <= 8) return { doubt: alternatives };
    return { keep: study };
  }
  const extra = [...words].filter((word) => !asked.includes(word) && (/^[a-e]$/.test(word) || FORM_WORDS.has(word) || IG_WORDS.has(word)));
  if (extra.length === 0) return { keep: study };
  const siblings = catalog.filter((other) => other.id !== study.id && !isPanel(other) && asked.every((word) => hasWord(allNameWords(other.name), word)));
  return siblings.length === 0 ? { keep: study } : { doubt: [study, ...siblings].slice(0, 8) };
}

// El paciente nombra la muestra con «de/en + sustantivo» y el catálogo con el adjetivo: «frotis de sangre periférica» → «frotis sanguineo», «calprotectina en heces» → «calprotectina fecal», «sedimento de
// orina» → «sedimento urinario». «Periférica» es la sangre de una vena (la de siempre): no cambia el estudio. Solo agrega una forma más para buscar; si no hay cambio, devuelve el mismo texto.
export const sampleAsAdjective = (core: string): string =>
  core
    .replace(/\b(?:de|en)\s+(?:la\s+)?sangre(?:\s+(?:periferica|venosa|total))?\b/g, "sanguineo")
    .replace(/\bsangre\s+periferica\b/g, "sanguineo")
    .replace(/\bperiferic[oa]\b/g, "sanguineo")
    .replace(/\b(?:de|en)\s+(?:las\s+)?(?:heces|deposiciones?)(?:\s+fecales)?\b/g, "fecal")
    .replace(/\b(?:de|en)\s+(?:la\s+)?orina\b/g, "urinario")
    .replace(/\b(sanguineo)(?:\s+sanguineo)+\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

// Entre varias opciones para lo que se pidió (texto del paciente o línea de la receta), lo que se cotiza; undefined = no se elige (se ofrecen las opciones).
// «psa total»: entre PSA TOTAL (ECLIA), PSA TOTAL (FIA) y PSA LIBRE (ECLIA) quedan los que tienen TODAS las palabras pedidas, y entre esos el método preferido (el mismo de la ruta de siempre).
// Un alias que comparten TODAS las opciones («atg» en la anti-TG CLIA y ECLIA; «panel ITS» en los 4 paneles de ITS): lo escrito no distingue entre ellas, así que no se elige por las palabras
// del nombre (antes «panel its» elegía el único panel que dice «ITS» en el nombre). Se elige la versión como siempre o, si no son versiones del mismo estudio, se ofrecen las opciones.
// Versiones del mismo estudio sin especificar: como las elige la Dra (ver chooseVersions).
// Si a lo elegido le falta algo que el paciente escribió y UN estudio lo tiene todo, es ese («hemoglobina glicosilad» no es la «HEMOGLOBINA» en sangre).
export function chooseAmong(candidates: readonly CatalogStudy[], text: string, catalog: readonly CatalogStudy[]): CatalogStudy[] | undefined {
  const same = sameExamChoice(candidates, text);
  if (same) return [same];
  const blood = preferredBySample(candidates, text);
  const sharedAlias = candidates.length > 1 && candidates.every((study) => (study.normalizedAliases ?? []).includes(normalizeStudyKey(coreOfMention(text))));
  const named = blood || sharedAlias ? undefined : namedChoice(candidates, text);
  const chosen = blood ? [blood] : named ? [named] : chooseVersions(withVersionSiblings(candidates, catalog), sharedAlias ? [...versionBase(candidates[0]!.name)].join(" ") : text);
  return chosen?.map((study) => { const review = reviewFuzzy(study, text, catalog); return "replace" in review ? review.replace : study; });
}

// Nombres (y alias aprobados y sinónimos) que el catálogo conoce ENTEROS: no se cortan por su «y» («bilirrubina total y fracciones», «grupo sanguíneo y factor Rh»).
const knownCache = new WeakMap<readonly CatalogStudy[], Set<string>>();
export function knownNamesOf(catalog: readonly CatalogStudy[]): Set<string> {
  const cached = knownCache.get(catalog);
  if (cached) return cached;
  const names = new Set<string>();
  for (const study of catalog) {
    const bare = normalizeStudyKey(study.name.replace(/\([^)]*\)/g, " "));
    names.add(normalizeStudyKey(study.name));
    names.add(bare);
    names.add(normalizeStudyKey(bare.replace(/\btipo\b/g, " "))); // «HERPES tipo 1 y 2 IgG (Elisa)» = «herpes 1 y 2 igg»
    for (const alias of study.normalizedAliases ?? []) names.add(normalizeStudyKey(alias));
  }
  knownCache.set(catalog, names);
  return names;
}
