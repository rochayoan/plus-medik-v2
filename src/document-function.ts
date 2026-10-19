import { z } from "zod";

// FUNCIÓN del documento (para qué sirve), distinta de su FORMATO visual (manuscrito, impreso, con casillas). Solo un documento cuya función es
// pedir estudios de laboratorio a un paciente es una solicitud cotizable. Una tarjeta de DERIVACIÓN de una muestra ya tomada, la etiqueta de un
// tubo o cualquier otro documento que no pide estudios a cotizar no lo es, aunque esté escrito igual que una receta.
//
// Cómo se decide (sin rechazar por una palabra suelta):
//  1. Señales BARATAS y deterministas en lo que las dos lecturas ya extrajeron (títulos, campos impresos y su descripción): frases que unen un
//     verbo/sustantivo de envío o derivación con una muestra ("derivación de muestra", "muestra derivada", "etiqueta de muestra"...). Cualquier
//     lectura que las vea basta para activar la comprobación (dirección segura). "Derivación a laboratorio", "tipo de muestra" o "toma de muestra"
//     NO son señales por sí solas.
//  2. Solo si hay señales, una comprobación enfocada en la imagen (dos lecturas independientes) decide la función. Ambas deben decir que es una
//     solicitud médica para seguir; si ambas dicen que no lo es, no es cotizable; si discrepan, dudan o no hay verificación, falla cerrado.

export type FunctionKind = "MEDICAL_REQUEST" | "SAMPLE_DERIVATION" | "SAMPLE_LABEL" | "OTHER_NON_REQUEST" | "UNCLEAR";
export const FUNCTION_KINDS = ["MEDICAL_REQUEST", "SAMPLE_DERIVATION", "SAMPLE_LABEL", "OTHER_NON_REQUEST", "UNCLEAR"] as const;

export const functionCheckSchema = z.object({
  function: z.enum(FUNCTION_KINDS),
  visibleEvidence: z.array(z.string()),
  reason: z.string()
});
export type FunctionCheck = z.infer<typeof functionCheckSchema>;

export interface FunctionRequest {
  instructions: string;
  variant: "A" | "B";
  imageBase64: string;
  mimeType: string;
}

export type FunctionVerdict = "NOT_CHECKED" | "REQUEST" | "NON_QUOTABLE" | "UNCLEAR" | "UNAVAILABLE";

export interface DocumentFunctionInfo {
  // Frases del documento que activaron la comprobación (vacío si no hubo señales).
  cues: string[];
  verdict: FunctionVerdict;
  // Función que dijo cada lectura (vacío si no se comprobó o no estuvo disponible).
  kinds: FunctionKind[];
  notes: string[];
}

const fold = (text: string): string =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const SENDING = "(?:derivacion|derivaciones|derivada|derivadas|derivado|derivados|remision|remisiones|remitida|remitidas|remitido|remitidos|envio|envios|enviada|enviadas|enviado|enviados|traslado|trasladada|trasladadas)";
const SAMPLE = "(?:muestra|muestras|especimen|especimenes|tubo|tubos|jeringa)";
const CUE_PATTERNS: RegExp[] = [
  // "derivación de muestra", "envío de muestras", "remisión de la muestra"
  new RegExp(`\\b${SENDING} (?:de |a |para )?(?:la |las |una |unas |el |los )?${SAMPLE}\\b`),
  // "muestra derivada", "muestras ya tomadas", "muestra enviada"
  new RegExp(`\\b${SAMPLE} (?:ya )?(?:derivad[ao]s?|remitid[ao]s?|enviad[ao]s?|tomad[ao]s?|recolectad[ao]s?|extraid[ao]s?)\\b`),
  // "etiqueta de muestra", "rótulo del tubo", "tarjeta de muestra"
  new RegExp(`\\b(?:etiquetas?|rotulos?|tarjetas?|fichas?) (?:de |del |de la |para )?(?:la )?${SAMPLE}\\b`),
  // "recepción de muestras", "identificación de la muestra", "código de muestra"
  new RegExp(`\\b(?:recepcion|identificacion|codigo) (?:de |del )?(?:la )?${SAMPLE}\\b`)
];

// Líneas (ya extraídas por las lecturas) que indican que el documento puede acompañar una muestra y no ser una solicitud.
export function derivationCues(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const folded = fold(text);
    if (folded !== "" && CUE_PATTERNS.some((pattern) => pattern.test(folded)) && !out.includes(text.trim())) out.push(text.trim());
  }
  return out;
}

export function functionInstructions(variant: "A" | "B", cues: string[]): string {
  const definitions = [
    "- MEDICAL_REQUEST: una solicitud, orden o receta emitida por un médico o centro para que se realicen estudios de laboratorio a un paciente (puede estar escrita a mano, impresa o en un formulario con casillas). Una orden de un paciente 'derivado a laboratorio', con los estudios por realizar, es MEDICAL_REQUEST.",
    "- SAMPLE_DERIVATION: tarjeta o formulario de DERIVACIÓN o ENVÍO de una muestra YA TOMADA, de un laboratorio u hospital de origen a otro laboratorio. Suele nombrar el origen y el destino, traer un código y la prueba escrita, y a menudo el tubo o la jeringa con la muestra delante.",
    "- SAMPLE_LABEL: la etiqueta o rótulo de un tubo o contenedor de muestra.",
    "- OTHER_NON_REQUEST: cualquier otro documento que no pide estudios a cotizar (resultados, informes, facturas, trámites administrativos).",
    "- UNCLEAR: no puedes decidir con lo que se ve."
  ];
  const rules = [
    "- Clasifica por la FUNCIÓN del documento, no por su formato: escrito a mano o impreso no decide nada.",
    "- Una palabra suelta como 'derivación' no basta. Decide por lo que el documento ES: ¿pide estudios a un paciente, o acompaña una muestra que ya fue tomada y enviada a otro laboratorio?",
    "- Una muestra física visible (tubo, jeringa, frasco) o un texto que dice que la muestra ya se tomó y se envía indican derivación de muestra. Una firma y sello de un médico que ordena estudios para un paciente indican solicitud médica.",
    "- visibleEvidence: hasta 5 textos literales u objetos visibles que justifican tu clasificación.",
    "- Ante la duda razonable, UNCLEAR."
  ];
  const method = variant === "A"
    ? "Método: lee primero los títulos y campos impresos del documento y después mira los objetos que aparecen en la foto."
    : "Método: mira primero los objetos de la foto (tubos, jeringas, sellos, firmas) y después lee los títulos y campos impresos.";
  return `
Decide para qué sirve el documento de la imagen. Una lectura previa vio estas frases, que podrían indicar que acompaña una muestra:
${cues.map((cue) => `- ${cue}`).join("\n")}
Funciones posibles:
${(variant === "A" ? definitions : [...definitions].reverse()).join("\n")}
${method}
${rules.join("\n")}
En reason explica en una frase qué es el documento.
`;
}

const NON_REQUEST: ReadonlySet<FunctionKind> = new Set(["SAMPLE_DERIVATION", "SAMPLE_LABEL", "OTHER_NON_REQUEST"]);

// Fusiona las dos lecturas (fallo cerrado):
//  - ambas MEDICAL_REQUEST        -> REQUEST (el formato visual decide el tipo, como siempre)
//  - ambas dicen que NO lo es     -> NON_QUOTABLE (no es una solicitud cotizable)
//  - cualquier otra combinación   -> UNCLEAR (discrepancia o duda: no se cotiza nada)
export function fuseFunction(a: FunctionCheck, b: FunctionCheck): { verdict: FunctionVerdict; kinds: FunctionKind[]; notes: string[] } {
  const kinds = [a.function, b.function];
  const notes = [`lectura A: ${a.function} (${a.reason})`, `lectura B: ${b.function} (${b.reason})`];
  if (kinds.every((kind) => kind === "MEDICAL_REQUEST")) return { verdict: "REQUEST", kinds, notes };
  if (kinds.every((kind) => NON_REQUEST.has(kind))) return { verdict: "NON_QUOTABLE", kinds, notes };
  return { verdict: "UNCLEAR", kinds, notes };
}
