import { normalizeStudyKey } from "./consensus.js";

// MENCIONES DE ESTUDIOS: separa lo que el paciente escribió en un estudio por mención, ANTES de buscar en el catálogo. Los pacientes escriben listas de todas las formas:
//   · separadores: saltos de línea, viñetas («-», «•», «1.», «2)»), comas, punto y coma, punto seguido, «+», «/», « - », «y», «e», «o», «u»;
//   · una palabra común a varios estudios y después solo las variantes: «testosterona total y libre», «hepatitis b y c», «toxoplasma igg e igm», «clamidia igg-igm», «bilirrubina total y directa».
//     Las variantes sueltas («libre», «c», «igm») NO se buscan solas (encontraban cualquier cosa: «c» → vitamina C, «directa» → Coombs directo): heredan la palabra común de la mención anterior;
//   · la abreviatura y el nombre largo juntos: «PSA antígeno prostático específico total» (también con errata: «antigueno») → «psa total»; «VPH» = «HPV».
// Un nombre que el catálogo (o la lista de sinónimos) ya conoce ENTERO no se corta aunque tenga «y»: «bilirrubina total y fracciones», «grupo sanguíneo y factor Rh».
// Si el paciente quiere un PANEL lo nombra («perfil lipídico», «perfil tiroideo»): ese nombre no tiene separadores y sigue siendo una sola mención. Estudios escritos por separado se cotizan por separado.
// Solo texto: nunca decide qué estudio es ni su precio (eso lo hace el catálogo con el motor de siempre).

// Variantes que, solas, no nombran un estudio: completan la palabra común de la mención anterior.
const QUALIFIER_WORDS = new Set([
  "total", "totales", "libre", "libres", "directa", "directo", "indirecta", "indirecto", "fraccionada", "fraccionadas", "fracciones",
  "igg", "igm", "iga", "ige", "hdl", "ldl", "vldl", "a", "b", "c", "d", "e", "1", "2",
  "ayunas", "en", "postprandial", "pospandrial", "post", "prandial", "basal", "serico", "serica", "plasmatico", "plasmatica",
  "cuantitativo", "cuantitativa", "cualitativo", "cualitativa", "ionico", "anticuerpos", "antigeno", "ac", "ag"
]);
// «orina» o «sangre» SOLAS son un estudio («hemograma y orina» = examen de orina); «en orina», «en sangre», «de 24 horas» completan la mención anterior.
const SAMPLE_PHRASE = /^(?:en|de)\s+(?:sangre|orina(?:\s+de\s+24\s*(?:h|hrs|horas))?|24\s*(?:h|hrs|horas))$/;
// La mención anterior termina con variantes: se quitan para obtener la palabra común («testosterona total» → «testosterona»; «glucosa en ayunas» → «glucosa»).
const TRAILING_QUALIFIER = new Set([
  "total", "totales", "libre", "libres", "directa", "directo", "indirecta", "indirecto", "igg", "igm", "iga", "ige", "hdl", "ldl", "vldl", "a", "b", "c", "d", "e", "1", "2",
  "cuantitativo", "cuantitativa", "cualitativo", "cualitativa", "serico", "serica", "plasmatico", "plasmatica", "ionico", "ayunas", "postprandial", "basal", "sangre", "orina", "en", "24", "h", "hrs", "horas", "de"
]);
// Menciones que no nombran ningún estudio («precio de los examen», «los laboratorios», «por favor»): se descartan.
const GENERIC_WORDS = new Set([
  "precio", "precios", "costo", "costos", "cotizacion", "cotizar", "valor", "examen", "examenes", "estudio", "estudios", "laboratorio", "laboratorios", "labo", "labos", "analisis", "prueba", "pruebas",
  "de", "del", "los", "las", "el", "la", "un", "una", "unos", "estos", "esos", "este", "ese", "mis", "mi", "por", "favor", "porfa", "porfavor", "gracias", "quiero", "necesito", "cuanto", "cuesta", "cuestan", "sale", "salen",
  // charla alrededor de los estudios («buenas tardes», «quisiera saber si realizan el», «me pidieron estos»)
  "hola", "buenas", "buenos", "buen", "dia", "dias", "tarde", "tardes", "noche", "noches", "disculpe", "disculpa", "saludos", "doctora", "doctor", "dra", "dr", "lic", "licenciada", "senorita",
  "quisiera", "queria", "saber", "si", "realizan", "realiza", "hacen", "hace", "tienen", "tiene", "hay", "me", "le", "les", "podria", "puede", "pueden", "dar", "decir", "que", "con", "y", "o", "para",
  "estas", "esas", "aqui", "ayuda", "consulta", "informacion", "info", "pidieron", "piden", "pide", "mandaron", "manda", "orden", "receta", "medico", "detallados", "detallado", "detalle", "ademas", "tambien", "otro", "otra"
]);
const isGeneric = (text: string): boolean => tokens(text).every((token) => GENERIC_WORDS.has(token));

// Abreviatura + nombre largo (o solo el nombre largo, con erratas comunes): se deja la forma que el catálogo usa.
const EXPANSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bantig?u?enos? prostaticos? especificos?\b/g, "psa"],
  [/\bantig?u?enos? prostaticos?\b/g, "psa"],
  [/\bvirus del? papiloma(?: humano)?\b/g, "hpv"],
  [/\bvph\b/g, "hpv"],
  [/\btoxoplasm(?:a|osis)\b/g, "toxo"],
  [/\bvirus de (?:la )?inmunodeficiencia humana\b/g, "hiv"],
  // El catálogo nombra el VIH por su sigla en inglés en todas sus pruebas («HIV 1,2 (PRUEBA RAPIDA)», «WESTERN BLOT HIV»); «VIH» solo aparece dentro de las listas de los paneles.
  [/\bvih\b/g, "hiv"],
  // «(P. Rápida)» de las recetas y listas de los médicos
  [/\bp rapid(a|o)s?\b/g, "prueba rapid$1"]
];

// Siglas con puntos como las escriben las recetas y los pacientes («H.A.I. Chagas», «H.A.I.Toxo», «V.D.R.L», «H.I.V.», «células L.E.», «8 a.m.»): se juntan («HAI Chagas», «VDRL»), como las nombra
// el catálogo. Sin esto quedaban «h a i chagas», que no coincide con nada. Una sola letra con punto no es sigla («vit. d», «ác. úrico», «P. Rápida»).
export const joinDottedAcronyms = (text: string): string => text.replace(/(?<![A-Za-z])[A-Za-z](?:\.[A-Za-z])+\.?(?![A-Za-z])/g, (acronym) => acronym.replace(/\./g, ""));

// Palabras delante del nombre que no son parte del estudio («labo de nivel de zinc», «examen de», «dosaje de»).
const LEADING_FILLER = /^(?:(?:la|el|una?|unos?|las|los|mi|un)\s+)?(?:labo|laboratorios?|pruebas?|examen(?:es)?|examenes|analisis|estudios?|dosajes?|dosificacion|test|nivel(?:es)?|valor(?:es)?|control|medicion|precios?|costos?|cotizacion(?:es)?)(?!\s+rapid)\s+(?:de\s+(?:la\s+|el\s+|los\s+|las\s+)?|del\s+|para\s+(?:el\s+|la\s+)?)?/;
const TRAILING_COURTESY = /\s+(?:por favor|porfavor|porfa|pf|gracias|muchas gracias)$/;
// Un artículo suelto delante del nombre («un helicobacter pylori», «el perfil lipídico»).
const LEADING_ARTICLE = /^(?:un|una|unos|unas|el|la|los|las)\s+(?=\S)/;

const MAX_MENTIONS = 30;

const clean = (text: string): string => normalizeStudyKey(text);
const tokens = (text: string): string[] => text.split(" ").filter(Boolean);

function stripFiller(text: string): string {
  let current = text.replace(TRAILING_COURTESY, "").trim();
  for (let round = 0; round < 3; round++) {
    const next = current.replace(LEADING_FILLER, "").replace(LEADING_ARTICLE, "").trim();
    if (next === current || next === "") break;
    current = next;
  }
  return current;
}

function expand(text: string): string {
  let current = ` ${text} `;
  for (const [pattern, replacement] of EXPANSIONS) current = current.replace(pattern, replacement);
  // «psa psa total» → «psa total» (la abreviatura y su nombre largo quedaron iguales)
  const out: string[] = [];
  for (const token of tokens(current.trim())) if (out[out.length - 1] !== token) out.push(token);
  return out.join(" ");
}

const onlyQualifiers = (text: string): boolean =>
  SAMPLE_PHRASE.test(text) || (tokens(text).length > 0 && tokens(text).every((token) => QUALIFIER_WORDS.has(token)) && tokens(text).some((token) => token !== "en" && token !== "de"));
function headOf(text: string): string {
  const parts = tokens(text);
  while (parts.length > 1 && TRAILING_QUALIFIER.has(parts[parts.length - 1]!)) parts.pop();
  return parts.length > 0 && parts.length < tokens(text).length ? parts.join(" ") : "";
}

// Primer nivel: separadores que nunca están dentro de un nombre de estudio.
function splitOuter(raw: string): string[] {
  return raw
    .split(/\r?\n|;|,|\s\+\s|\+|\s[-–—]\s|\s\/\s|•|·|▪️|►/)
    // punto seguido entre estudios («Precio de los examen. Testosterona…»), pero no abreviaturas cortas («vit. d», «ac. urico», «dr.»)
    .flatMap((part) => part.split(/(?<=[a-záéíóúñ]{4,})\.\s+/i))
    // numeración en la misma línea: «1. hemograma 2. glucosa 3) creatinina»
    .flatMap((part) => part.split(/\s+\d{1,2}\s*[.)]\s+/))
    .map((part) => part.replace(/^\s*(?:[-*]+|\d{1,2}\s*[.)-])\s+/, "").trim())
    .filter((part) => part !== "");
}

// Segundo nivel: «y», «o», «más», «/», «e» y «u» y el guion pegado entre variantes («igg-igm»).
// «e» y «u» solo son conjunción delante de i-/hi- y o-/ho- («ferritina e hierro», «toxo igg e igm»): así «vitamina e» o «hepatitis e» no se cortan.
// «más» une estudios en los pedidos reales («coproparasitológico simple más un helicobacter pylori»).
function splitInner(text: string): string[] {
  // «igg-igm», «igg/igm» y también seguidas sin nada («rubeola igg igm», «psa total libre»)
  // (también «colesterol total hdl ldl»: real del 4–20 nov)
  const spaced = text.replace(/\b(igg|igm|iga|ige|total|libre|hdl|ldl|vldl)(?:\s*[-/]\s*|\s+)(?=(?:igg|igm|iga|ige|total|libre|hdl|ldl|vldl)\b)/g, "$1 y ");
  return spaced.split(/\s+(?:y|o|mas)\s+|\s+e\s+(?=h?i)|\s+u\s+(?=h?o)|\//).map((part) => part.trim()).filter((part) => part !== "");
}

export interface MentionOptions {
  // ¿El catálogo (nombre o alias) o la lista de sinónimos conoce este texto ENTERO? Así no se corta «bilirrubina total y fracciones».
  readonly isKnownName?: (normalized: string) => boolean;
}

// Las menciones de estudios de un texto, en orden y sin repetir, ya normalizadas (minúsculas, sin tildes, sin relleno). Nunca devuelve menciones vacías.
export function splitStudyMentions(raw: string, options: MentionOptions = {}): string[] {
  const text = joinDottedAcronyms(raw);
  const known = options.isKnownName ?? (() => false);
  const out: string[] = [];
  const push = (mention: string): void => {
    if (mention.length >= 2 && !out.includes(mention) && out.length < MAX_MENTIONS) out.push(mention);
  };
  // La palabra común pasa de una parte a la siguiente aunque las separe una coma («colesterol total, hdl y ldl»).
  let previous = "";
  // Una línea que es ENTERA un nombre del catálogo no se corta por sus comas («HIV 1,2 AG-AC 4ta GENERACION (Elisa)», los paneles con su lista de patógenos): así llegan los nombres que el
  // paciente eligió de una lista de opciones.
  const outers = text.split(/\r?\n/).flatMap((line) => (known(clean(line)) ? [line] : splitOuter(line)));
  for (const outer of outers) {
    const whole = expand(stripFiller(clean(outer)));
    if (whole === "" || isGeneric(whole)) continue;
    if (known(whole)) {
      push(whole);
      previous = whole;
      continue;
    }
    for (const inner of splitInner(outer.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase())) {
      const mention = expand(stripFiller(clean(inner)));
      if (mention === "" || isGeneric(mention)) continue;
      if (previous !== "" && onlyQualifiers(mention)) {
        // Una letra suelta solo reemplaza a otra letra («vitamina d y e» → «vitamina e»); nunca se pega a cualquier nombre («vitamina b12 y d» no es «vitamina b12 d»).
        if (/^[a-e]$/.test(mention) && headOf(previous) === "") continue;
        const completed = `${headOf(previous) || previous} ${mention}`;
        push(completed);
        previous = completed;
        continue;
      }
      push(mention);
      previous = mention;
    }
  }
  return out;
}
