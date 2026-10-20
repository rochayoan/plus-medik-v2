import OpenAI from "openai";
import { z } from "zod";
import { strictJsonSchema } from "./ai.js";
import { cachedAiCall, usageFromResponses, type AiUsage } from "./cache.js";

// Verificación de IMPACTO por estudio (cotización parcial). Cuando una receta tiene zonas cortadas u ocultas que NO invalidan la lectura (puede
// haber MÁS estudios que no se ven), cada estudio visible solo se cotiza si dos lecturas independientes de la imagen confirman que esas zonas no
// pueden modificar su interpretación (continuación de su texto, un "NO" o tachado, una variante, una marca que lo anule) y que su fila y su
// marca se ven enteras. Solo cuenta la evidencia CONCRETA sobre ese estudio: una duda genérica sobre lo que haya fuera del encuadre no lo afecta
// (el riesgo de un título oculto se informa aparte, en qualifiersMayBeHidden). Ante error, falta de respuesta o desacuerdo real el estudio queda
// pendiente: nunca se asume información oculta.

export interface ImpactStudy {
  key: string;
  // Lo que está ESCRITO en la fila (texto literal de los lectores). Nunca el texto que el sistema reconstruyó: el verificador trabaja sobre la imagen.
  text: string;
  // Solo en estudios reconstruidos (variante suelta que heredó el analito, filas reunidas en un paquete): la línea completa donde está escrito `text`.
  line?: string;
}

// Qué concluyó la verificación sobre UN estudio (la peor de las dos lecturas):
//  INDEPENDENT        ambas lecturas: fila y marca enteras y ninguna zona que no se ve puede afectarlo.
//  AFFECTED           alguna lectura dice que una zona oculta o cortada lo afecta.
//  POSSIBLY_AFFECTED  alguna lectura no puede descartar que lo afecte.
//  NOT_FULLY_VISIBLE  su texto o su marca no se ven enteros (casilla tapada, texto cortado).
//  NO_ANSWER          la lectura no dijo nada de ese estudio.
export type ImpactStatus = "INDEPENDENT" | "AFFECTED" | "POSSIBLY_AFFECTED" | "NOT_FULLY_VISIBLE" | "NO_ANSWER";

export interface StudyImpactResult {
  // false si la verificación no pudo hacerse (error, sin verificador): entonces ningún estudio queda confirmado.
  available: boolean;
  // Claves de los estudios que AMBAS lecturas confirmaron como no afectados.
  unaffected: Set<string>;
  // Veredicto por estudio (opcional por compatibilidad: si falta, quien no está en `unaffected` se considera afectado).
  findings?: Map<string, ImpactStatus>;
  // true si alguna lectura vio que en lo oculto podría haber un título o instrucción que califique a los estudios (muestra, 24 h, población).
  qualifierRisk: boolean;
  notes: string[];
}

const impactSchema = z.object({
  items: z.array(z.object({
    index: z.number().int(),
    rowFullyVisible: z.boolean(),
    selectionFullyVisible: z.boolean(),
    affected: z.enum(["NO", "POSSIBLY", "YES"]),
    note: z.string()
  })),
  qualifiersMayBeHidden: z.boolean(),
  reason: z.string()
});
export type ImpactCheck = z.infer<typeof impactSchema>;

export interface ImpactRequest {
  instructions: string;
  variant: "A" | "B";
  imageBase64: string;
  mimeType: string;
}

// Dos riesgos DISTINTOS, con respuestas separadas:
//  - LOCAL (rowFullyVisible, selectionFullyVisible, affected): un elemento concreto (corte, sello, dedo, doblez, trazo ilegible) toca la fila de ESE
//    estudio, su marca o la continuación de su texto. Exige evidencia nombrada; una duda genérica sobre lo que haya fuera del encuadre no cuenta.
//  - GENERAL (qualifiersMayBeHidden): lo que no se ve podría ser un título o instrucción que califique a los estudios. No cambia `affected`; el
//    código mantiene pendientes los estudios cuya interpretación depende de ese calificador (variantes de muestra, tiempo o población).
// Las dos lecturas comparten las mismas definiciones; difieren en el método (estudio por estudio, o zona por zona).
export function impactInstructions(variant: "A" | "B", studies: ImpactStudy[], problems: string[]): string {
  const local = [
    "- Riesgo LOCAL sobre un estudio = un elemento CONCRETO (corte del borde, sello, dedo, doblez, otra hoja, trazo borrado o ilegible) que se superpone o toca la fila de ESE estudio, su casilla o marca de selección, o la continuación inmediata de su texto o de su línea (la línea siguiente, lo que sigue a la derecha, un 'NO', un tachado, una variante como IgG/IgM, un trazo que lo anule).",
    "- rowFullyVisible: true solo si el nombre o texto de ese estudio se ve ENTERO (todas las letras y su continuación). Si un objeto o un borde tapa parte de ESE texto, false. Nunca supongas lo que hay debajo de un objeto.",
    "- selectionFullyVisible: true solo si su marca de selección (X, check, círculo, subrayado, tachado) se ve entera o, en un pedido escrito a mano, la línea completa del estudio es legible. Si la casilla o la marca de ESE estudio está cubierta o cortada, false.",
    "- affected = YES si ves evidencia concreta de que algo oculto o cortado altera ese estudio. affected = POSSIBLY SOLO si puedes NOMBRAR el elemento concreto y decir dónde está respecto a la fila, la marca o la continuación de ESE estudio (p. ej. «el sello cubre el final de su línea»). affected = NO si ningún elemento concreto toca su fila, su marca ni su continuación.",
    "- Una duda general NO es evidencia: que pudiera haber algo fuera del encuadre, bajo un doblez lejano, en otra columna o en otra parte del documento NO justifica POSSIBLY ni YES para este estudio. Eso solo se informa en qualifiersMayBeHidden.",
    "- note: si affected no es NO, nombra el elemento y dónde está; si es NO, di dónde está el estudio respecto a las zonas problemáticas (p. ej. «lejos del sello»)."
  ];
  const general = [
    "- qualifiersMayBeHidden (una sola respuesta para todo el documento, no por estudio): true SOLO si hay evidencia concreta de que lo que no se ve tapa o corta un título, encabezado de sección o instrucción que califica a los estudios (muestra: sangre, orina, 24 horas; población: pediátrico, neonatal), p. ej. un doblez, sello o recorte sobre la zona donde van los títulos e instrucciones, o una línea de título o instrucción visible pero cortada.",
    "- qualifiersMayBeHidden = false si lo que no se ve está lejos de títulos, encabezados e instrucciones, o si lo que califica a los estudios ya se ve impreso. Que falten filas o columnas de estudios fuera del encuadre no es, por sí solo, un título oculto.",
    "- qualifiersMayBeHidden NO cambia affected de ningún estudio: la decisión de qué estudios dependen de esa información general no es tuya."
  ];
  const method = variant === "A"
    ? "Método: recorre los estudios en orden y, para cada uno, busca qué elemento problemático toca su fila, su marca o su continuación."
    : "Método: primero ubica cada zona problemática de la lista y qué filas, marcas o continuaciones toca (si no toca ninguna, no afecta a ningún estudio); después responde por cada estudio en orden.";
  return `
Esta solicitud de estudios de laboratorio tiene zonas que no se ven completas:
${problems.map((problem) => `- ${problem}`).join("\n")}
Los estudios que ya se identificaron como solicitados son:
${studies.map((study, index) => `${index}. ${study.text}${study.line ? ` (escrito en la línea «${study.line}»)` : ""}`).join("\n")}${studies.some((study) => study.line) ? "\nCuando se indica la línea, el estudio es exactamente ese texto tal como está escrito dentro de esa línea. Localiza la fila por lo que se ve escrito en la imagen: no completes, no infieras ni agregues el nombre del estudio, y no uses la línea para suponer lo que hay en una zona que no se ve." : ""}
Mira la imagen y, para CADA estudio (con su índice), responde por separado dos preguntas: (1) el riesgo LOCAL sobre ese estudio y (2) la información general oculta.
${method}
${[...local, ...general].join("\n")}
En reason explica en una frase qué ves alrededor de las zonas problemáticas.
`;
}

// Un estudio queda confirmado solo si en ESTA lectura su fila y su marca se ven enteras y NADA lo afecta.
export function impactCheckPassed(value: ImpactCheck, studies: ImpactStudy[]): { passed: Set<string>; qualifierRisk: boolean; notes: string[]; status: Map<string, ImpactStatus> } {
  const passed = new Set<string>();
  const notes: string[] = [];
  const status = new Map<string, ImpactStatus>();
  studies.forEach((study, index) => {
    const item = value.items.find((candidate) => candidate.index === index);
    if (!item) { notes.push(`«${study.text}»: sin respuesta`); status.set(study.key, "NO_ANSWER"); }
    else if (!item.rowFullyVisible) { notes.push(`«${study.text}»: su texto no se ve entero`); status.set(study.key, "NOT_FULLY_VISIBLE"); }
    else if (!item.selectionFullyVisible) { notes.push(`«${study.text}»: su marca o línea no se ve entera`); status.set(study.key, "NOT_FULLY_VISIBLE"); }
    else if (item.affected !== "NO") { notes.push(`«${study.text}»: una zona oculta o cortada ${item.affected === "YES" ? "lo afecta" : "podría afectarlo"}`); status.set(study.key, item.affected === "YES" ? "AFFECTED" : "POSSIBLY_AFFECTED"); }
    else { passed.add(study.key); status.set(study.key, "INDEPENDENT"); }
  });
  return { passed, qualifierRisk: value.qualifiersMayBeHidden, notes, status };
}

// De las dos lecturas manda la más desfavorable (solo es INDEPENDENT si ambas lo son).
const SEVERITY: ImpactStatus[] = ["AFFECTED", "NOT_FULLY_VISIBLE", "POSSIBLY_AFFECTED", "NO_ANSWER", "INDEPENDENT"];
export function worstImpact(a: ImpactStatus, b: ImpactStatus): ImpactStatus {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b;
}

export interface ImpactDeps {
  call: (request: ImpactRequest) => Promise<{ value: unknown; usage?: AiUsage }>;
  model: string;
  reasoning: string;
}

function params(model: string, reasoning: string) {
  return {
    model,
    reasoning: { effort: reasoning as "low" | "medium" | "high" | "xhigh" | "max" },
    text: { format: { type: "json_schema" as const, name: "study_impact_verification", strict: true, schema: strictJsonSchema(impactSchema) } }
  };
}

function defaultDeps(): ImpactDeps {
  const model = process.env.OPENAI_READER_MODEL ?? "gpt-6.1-sol";
  const reasoning = process.env.OPENAI_DOCUMENT_REASONING ?? "medium";
  return {
    model,
    reasoning,
    call: async (request) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is required (define it in .env)");
      const response = await new OpenAI({ apiKey }).responses.create({
        ...params(model, reasoning),
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: request.instructions },
            { type: "input_image", image_url: `data:${request.mimeType};base64,${request.imageBase64}`, detail: "original" }
          ]
        }]
      });
      return { value: JSON.parse(response.output_text), usage: usageFromResponses(response.usage) };
    }
  };
}

// Dos lecturas independientes (instrucciones en distinto orden). Falla cerrado: cualquier error deja la verificación como no disponible.
export async function verifyStudyImpact(
  args: { imageBase64: string; mimeType: string; studies: ImpactStudy[]; problems: string[] },
  deps: Partial<ImpactDeps> = {}
): Promise<StudyImpactResult> {
  const resolved = { ...defaultDeps(), ...deps };
  if (args.studies.length === 0) return { available: true, unaffected: new Set(), qualifierRisk: false, notes: [] };
  const one = async (variant: "A" | "B"): Promise<ImpactCheck> => {
    const instructions = impactInstructions(variant, args.studies, args.problems);
    return cachedAiCall({
      label: "openai-study-impact",
      provider: "openai",
      model: resolved.model,
      imageBase64: args.imageBase64,
      config: { prompt: instructions, mimeType: args.mimeType, params: params(resolved.model, resolved.reasoning) },
      parse: (raw) => impactSchema.parse(raw),
      call: async () => {
        const response = await resolved.call({ instructions, variant, imageBase64: args.imageBase64, mimeType: args.mimeType });
        return { value: impactSchema.parse(response.value), usage: response.usage };
      }
    });
  };
  try {
    const [a, b] = await Promise.all([one("A"), one("B")]);
    const resultA = impactCheckPassed(a, args.studies);
    const resultB = impactCheckPassed(b, args.studies);
    const unaffected = new Set([...resultA.passed].filter((key) => resultB.passed.has(key)));
    const findings = new Map(args.studies.map((study) => [study.key, worstImpact(resultA.status.get(study.key) ?? "NO_ANSWER", resultB.status.get(study.key) ?? "NO_ANSWER")] as const));
    return {
      available: true,
      unaffected,
      findings,
      qualifierRisk: resultA.qualifierRisk || resultB.qualifierRisk,
      notes: [...resultA.notes.map((note) => `lectura A: ${note}`), ...resultB.notes.map((note) => `lectura B: ${note}`)]
    };
  } catch (error) {
    return { available: false, unaffected: new Set(), qualifierRisk: true, notes: [`verificación de impacto no disponible: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
