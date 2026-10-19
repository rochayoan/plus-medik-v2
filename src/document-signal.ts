import OpenAI from "openai";
import { z } from "zod";
import { strictJsonSchema } from "./ai.js";
import { cachedAiCall, usageFromResponses, type AiUsage } from "./cache.js";
import { identityTokens, type ShadowContext } from "./catalog-shadow.js";
import { normalizeStudyKey } from "./consensus.js";
import type { DocumentType } from "./types.js";

// Señal de TIPO e INTEGRIDAD del documento. Conserva el enum DocumentType, el campo completeDocumentVisible y las reglas de
// src/safety.ts (manuscrito, no es solicitud, tipo incierto, documento incompleto), y el criterio de dos lecturas independientes
// de fuseIndependentReadings (tipo distinto -> UNKNOWN; completo solo si ambas lecturas lo ven completo).
//
// La integridad no es un booleano que se dispara con cualquier recorte: se evalúa SOLO la zona relevante (lista de estudios con
// sus casillas y marcas, o las líneas del pedido manuscrito). El modelo debe enumerar las filas/marcas cortadas por el borde, las
// ocultas por objetos (sellos, dedos, dobleces, otras hojas) y los trazos borrados o ilegibles, y delimitar la zona con una caja. El
// código decide: cualquier elemento enumerado, una respuesta incoherente o una caja inválida => incompleto.
// Una caja que solo se ACERCA al borde no bloquea por sí sola: dispara una verificación enfocada en ese borde (dos lecturas
// independientes que deben nombrar lo que hay junto al borde y confirmar que nada continúa fuera). Si no se puede verificar, bloquea.
//
// Además extrae el CONTEXTO impreso (título, instrucciones) que ayuda a distinguir variantes del catálogo. Solo cuenta lo que ambas
// lecturas coinciden en declarar y que el texto de la línea respalda; nunca incluye datos del paciente.

const DOCUMENT_TYPES = ["TEXT_EXPLICIT_REQUEST", "MARK_DEPENDENT_FORM", "HANDWRITTEN_REQUEST", "NOT_A_REQUEST", "UNKNOWN"] as const;

// Coordenadas normalizadas 0..1000 relativas a la imagen completa.
const regionSchema = z.object({ left: z.number().int(), top: z.number().int(), right: z.number().int(), bottom: z.number().int() });
export type Region = z.infer<typeof regionSchema>;

const contextLineSchema = z.object({
  text: z.string(),
  role: z.enum(["TITLE", "INSTRUCTION", "SECTION", "OTHER"]),
  appliesToAllStudies: z.boolean(),
  declaresSpecimen: z.enum(["BLOOD", "URINE", "STOOL", "OTHER_FLUID", "NONE"]),
  declaresCollection: z.enum(["H24", "OCCASIONAL", "NONE"])
});
export type ContextLine = z.infer<typeof contextLineSchema>;

const signalSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  studyRegion: regionSchema,
  studyRegionComplete: z.boolean(),
  rowsCutByImageEdge: z.array(z.string()),
  rowsHiddenByObjects: z.array(z.string()),
  erasedOrIllegible: z.boolean(),
  irrelevantCrops: z.array(z.string()),
  printedContext: z.array(contextLineSchema).default([]),
  reason: z.string()
});
export type RawSignal = z.infer<typeof signalSchema>;

// La zona de estudios no puede acercarse al borde de la imagen sin verificación: 15/1000 = 1.5 %.
export const EDGE_MARGIN = 15;

export type Edge = "top" | "bottom" | "left" | "right";
const EDGE_NAMES: Record<Edge, string> = { top: "superior", bottom: "inferior", left: "izquierdo", right: "derecho" };

const definitions: Record<(typeof DOCUMENT_TYPES)[number], string> = {
  TEXT_EXPLICIT_REQUEST: "TEXT_EXPLICIT_REQUEST: solicitud impresa o digitada que nombra explícitamente los estudios pedidos.",
  MARK_DEPENDENT_FORM: "MARK_DEPENDENT_FORM: formulario impreso con una lista de estudios donde los pedidos se indican con una marca (X, check, círculo, subrayado, tachado, rayón...). Los datos manuscritos del paciente, del diagnóstico o del médico NO lo convierten en manuscrito: lo que importa es cómo se piden los estudios.",
  HANDWRITTEN_REQUEST: "HANDWRITTEN_REQUEST: el pedido clínico depende de texto manuscrito (los estudios están escritos a mano como texto libre).",
  NOT_A_REQUEST: "NOT_A_REQUEST: el documento no es una solicitud de estudios de laboratorio.",
  UNKNOWN: "UNKNOWN: no se puede determinar el tipo de documento."
};

export function documentInstructions(variant: "A" | "B"): string {
  const order = variant === "A" ? [...DOCUMENT_TYPES] : [...DOCUMENT_TYPES].reverse();
  return `
Clasifica el documento de la imagen (una solicitud de estudios de laboratorio) y evalúa si la ZONA RELEVANTE está completa, sin leer ni listar los estudios.
Tipos posibles:
${order.map((type) => `- ${definitions[type]}`).join("\n")}
HANDWRITTEN_REQUEST significa que el pedido clínico depende de texto manuscrito; por ahora ese caso no puede ser AUTO.

ZONA RELEVANTE: la lista impresa de estudios con sus casillas, óvalos y marcas, o las líneas donde se escribe el pedido manuscrito, y cualquier
sección donde haya marcas o escritura que pida estudios ("Otros estudios", banco de sangre, imagenología) cuando tenga contenido.
- studyRegion: la caja que contiene toda esa zona, en coordenadas 0 a 1000 relativas a la imagen completa (left, top, right, bottom).
- rowsCutByImageEdge: filas de estudios, casillas, marcas o líneas de pedido que el borde de la imagen corta o que continúan fuera de la foto
  (texto cortado a media palabra, una raya que sale de la imagen, casillas que quedan a medias). Vacío si ninguna.
- rowsHiddenByObjects: filas o marcas que un sello, dedo, doblez, rotura u otra hoja tapan o vuelven ilegibles. Vacío si ninguna.
- erasedOrIllegible: true si hay trazos borrados, tachados ilegibles o escritura ilegible en la zona relevante que podrían ocultar un estudio pedido.
- irrelevantCrops: recortes u ocultamientos que NO tocan la zona relevante (encabezado, título, datos del paciente, firmas, sellos,
  tablas administrativas vacías, márgenes, otra hoja de fondo). Descríbelos aquí en vez de marcar el documento como incompleto.
- studyRegionComplete=false solo si algún elemento de las listas anteriores es verdadero o no puedes comprobar que toda la zona relevante está dentro de la
  imagen. Un recorte irrelevante NO lo vuelve false. Ante la duda sobre la zona relevante, responde false.

printedContext: líneas IMPRESAS (texto literal) del título, encabezados e instrucciones que califican los estudios pedidos, p. ej. el título del
formulario, una indicación de muestra ("Muestra: orina de 24 horas") o una instrucción general. NO incluyas nombres de estudios, datos del
paciente o del médico, fechas, números de registro, direcciones, firmas ni sellos. Para cada línea:
- role: TITLE, INSTRUCTION, SECTION (encabezado de una parte del formulario) u OTHER.
- appliesToAllStudies: true solo si la línea califica TODOS los estudios del formulario (no solo una sección).
- declaresSpecimen: BLOOD, URINE, STOOL u OTHER_FLUID solo si la línea DECLARA la muestra de los estudios (p. ej. "Solicitud de examen de sangre",
  "Muestra de orina"). NONE si no la declara: el nombre de un servicio, área o institución (p. ej. "Servicio de banco de sangre", "Sangre segura",
  "Laboratorio") NO es una declaración de muestra.
- declaresCollection: H24 u OCCASIONAL solo si la línea declara cómo se recolecta (orina de 24 horas / ocasional); NONE en otro caso.
Si no hay líneas útiles, devuelve [].
En reason explica en una frase qué ves (qué documento es, cómo se piden los estudios y qué recortes hay).
`;
}

export interface IntegrityEvaluation {
  complete: boolean;
  problems: string[];
}

function validRegion(r: Region): boolean {
  return r.left >= 0 && r.top >= 0 && r.right <= 1000 && r.bottom <= 1000 && r.left < r.right && r.top < r.bottom;
}

// Bordes a los que se acerca la caja de estudios (vacío si la caja es inválida: eso es un problema duro, no de proximidad).
export function touchedEdges(region: Region): Edge[] {
  if (!validRegion(region)) return [];
  const { left, top, right, bottom } = region;
  return [top < EDGE_MARGIN && "top", bottom > 1000 - EDGE_MARGIN && "bottom", left < EDGE_MARGIN && "left", right > 1000 - EDGE_MARGIN && "right"].filter(Boolean) as Edge[];
}

// Problemas que NUNCA se relajan: lo que el modelo no confirma, lo que enumera como cortado/oculto/ilegible y una caja inválida.
export function hardProblems(raw: RawSignal): string[] {
  const problems: string[] = [];
  if (!raw.studyRegionComplete) problems.push("el modelo no confirma que la zona de estudios esté completa");
  for (const row of raw.rowsCutByImageEdge) problems.push(`cortado por el borde: ${row}`);
  for (const row of raw.rowsHiddenByObjects) problems.push(`oculto por un objeto: ${row}`);
  if (raw.erasedOrIllegible) problems.push("hay trazos borrados o escritura ilegible en la zona de estudios");
  if (!validRegion(raw.studyRegion)) problems.push("la caja de la zona de estudios es inválida");
  return problems;
}

const proximityProblem = (edges: Edge[]) => `la zona de estudios toca el borde ${edges.map((edge) => EDGE_NAMES[edge]).join(" y ")} de la imagen`;

// La decisión de integridad es del código: no basta con que el modelo diga "completo". Los bordes verificados no cuentan como problema.
export function evaluateIntegrity(raw: RawSignal, verifiedEdges: ReadonlySet<Edge> = new Set()): IntegrityEvaluation {
  const problems = hardProblems(raw);
  const unverified = touchedEdges(raw.studyRegion).filter((edge) => !verifiedEdges.has(edge));
  if (unverified.length > 0) problems.push(proximityProblem(unverified));
  return { complete: problems.length === 0, problems };
}

// ───────────────────────────── verificación enfocada de bordes ─────────────────────────────

const edgeCheckSchema = z.object({
  checks: z.array(z.object({
    edge: z.enum(["top", "bottom", "left", "right"]),
    elementsNearEdge: z.array(z.object({ text: z.string(), fullyVisible: z.boolean() })),
    anythingContinuesBeyondEdge: z.boolean()
  })),
  reason: z.string()
});
export type EdgeCheck = z.infer<typeof edgeCheckSchema>;

export interface EdgeRequest {
  instructions: string;
  variant: "A" | "B";
  edges: Edge[];
  imageBase64: string;
  mimeType: string;
}

export function edgeInstructions(variant: "A" | "B", edges: Edge[]): string {
  const meaning: Record<Edge, string> = {
    top: "top: el borde SUPERIOR de la imagen tal como se ve (la parte de arriba de la foto)",
    bottom: "bottom: el borde INFERIOR de la imagen (la parte de abajo de la foto)",
    left: "left: el borde IZQUIERDO de la imagen",
    right: "right: el borde DERECHO de la imagen"
  };
  const list = (variant === "A" ? edges : [...edges].reverse()).map((edge) => `- ${meaning[edge]}`).join("\n");
  const rules = [
    "- elementsNearEdge: los elementos de CONTENIDO de la lista de estudios (nombres, casillas, marcas, texto de pedido) más cercanos a ese borde, con su texto literal. Si no hay ninguno junto al borde, devuelve [].",
    "- fullyVisible: true solo si ese elemento se ve ENTERO dentro de la imagen (todas las letras, la casilla completa, la marca completa).",
    "- anythingContinuesBeyondEdge: true si algún TEXTO, casilla, marca o fila de estudios queda cortado por el borde, o si el contenido de la lista evidentemente continúa fuera de la foto (una palabra a medias, una casilla partida, una fila o columna de estudios que sigue más allá del borde). Las líneas divisorias, bordes de tabla o rayas de subrayado que solo llegan hasta el borde de la foto NO cuentan por sí solas. Si hay una duda razonable de que haya contenido de estudios fuera de la foto, true."
  ];
  return `
Revisa SOLO los bordes de la imagen indicados y comprueba si la lista de estudios de la solicitud queda completa dentro de la foto.
Bordes a revisar:
${list}
Para cada borde devuelve una entrada en checks:
${(variant === "A" ? rules : [...rules].reverse()).join("\n")}
Ignora el encabezado, datos del paciente, firmas, sellos y márgenes: solo importa la lista de estudios y sus marcas.
En reason explica en una frase qué hay junto a cada borde.
`;
}

// Acepta un borde solo si el modelo nombró al menos un elemento junto a él, todos enteros, y nada continúa fuera.
export function edgeCheckPassed(value: EdgeCheck, edges: Edge[]): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  for (const edge of edges) {
    const check = value.checks.find((candidate) => candidate.edge === edge);
    if (!check) notes.push(`${EDGE_NAMES[edge]}: sin verificación`);
    else if (check.anythingContinuesBeyondEdge) notes.push(`${EDGE_NAMES[edge]}: algo continúa más allá del borde`);
    else if (check.elementsNearEdge.length === 0 || check.elementsNearEdge.some((element) => element.text.trim() === "")) notes.push(`${EDGE_NAMES[edge]}: no se identificó lo que hay junto al borde`);
    else if (check.elementsNearEdge.some((element) => !element.fullyVisible)) notes.push(`${EDGE_NAMES[edge]}: hay un elemento que no se ve entero`);
  }
  return { ok: notes.length === 0, notes };
}

// ───────────────────────────── contexto impreso ─────────────────────────────

export interface DocumentContext extends ShadowContext {
  // Declaraciones que no se pudieron aplicar (líneas que contradicen a otras) y líneas que solo vio una de las dos lecturas.
  conflicts: string[];
  unagreedLines: string[];
}

const SPECIMEN_TOKEN: Record<string, { value: string; token: string }> = {
  BLOOD: { value: "sangre", token: "sangre" },
  URINE: { value: "orina", token: "orina" },
  STOOL: { value: "heces", token: "heces" }
};
const COLLECTION_TOKEN: Record<string, { value: string; token: string }> = {
  H24: { value: "24h", token: "24h" },
  OCCASIONAL: { value: "ocasional", token: "ocasional" }
};

// Solo las líneas que AMBAS lecturas vieron. Una declaración (muestra / recolección) existe si ambas la atribuyen a la misma línea,
// la línea califica a todos los estudios y su texto la respalda ("sangre", "orina"... aparecen de verdad en la línea).
// Declaraciones distintas entre líneas => conflicto: el contexto no desambigua esa característica.
export function fuseContext(a: ContextLine[], b: ContextLine[]): DocumentContext {
  const keyOf = (line: ContextLine) => normalizeStudyKey(line.text).replace(/ /g, "");
  const bByKey = new Map(b.map((line) => [keyOf(line), line]));
  const lines: string[] = [];
  const unagreed: string[] = [];
  const specimens = new Set<string>();
  const collections = new Set<string>();
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const lineA of a) {
    const key = keyOf(lineA);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const lineB = bByKey.get(key);
    if (!lineB) { unagreed.push(lineA.text); continue; }
    lines.push(lineA.text);
    if (!(lineA.appliesToAllStudies && lineB.appliesToAllStudies)) continue;
    const tokens = new Set(identityTokens(lineA.text));
    if (lineA.declaresSpecimen === lineB.declaresSpecimen && SPECIMEN_TOKEN[lineA.declaresSpecimen] && tokens.has(SPECIMEN_TOKEN[lineA.declaresSpecimen]!.token)) {
      specimens.add(SPECIMEN_TOKEN[lineA.declaresSpecimen]!.value);
    }
    if (lineA.declaresCollection === lineB.declaresCollection && COLLECTION_TOKEN[lineA.declaresCollection] && tokens.has(COLLECTION_TOKEN[lineA.declaresCollection]!.token)) {
      collections.add(COLLECTION_TOKEN[lineA.declaresCollection]!.value);
    }
  }
  for (const line of b) if (!seen.has(keyOf(line)) && keyOf(line) !== "") { seen.add(keyOf(line)); unagreed.push(line.text); }
  const context: DocumentContext = { lines, conflicts, unagreedLines: unagreed };
  if (specimens.size === 1) context.muestra = [...specimens][0];
  else if (specimens.size > 1) conflicts.push(`muestras declaradas contradictorias: ${[...specimens].join(", ")}`);
  if (collections.size === 1) context.tiempo = [...collections][0];
  else if (collections.size > 1) conflicts.push(`recolecciones declaradas contradictorias: ${[...collections].join(", ")}`);
  return context;
}

// ───────────────────────────── señal fusionada ─────────────────────────────

export interface DocumentSignal {
  documentType: DocumentType;
  // true solo si AMBAS lecturas consideran completa la zona relevante (ver evaluateIntegrity).
  completeDocumentVisible: boolean;
  agreement: boolean;
  integrity: {
    problems: string[];
    irrelevantCrops: string[];
    studyRegion?: Region;
    // Bordes a los que se acercaba la zona y que la verificación enfocada confirmó completos.
    verifiedEdges?: string[];
    edgeNotes?: string[];
  };
  reasons: [string, string];
  context?: DocumentContext;
}

const union = (a: Region, b: Region): Region => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });

// Misma semántica que fuseIndependentReadings: tipo distinto -> UNKNOWN; completo solo si ambas lecturas lo ven completo.
export function fuseSignals(a: RawSignal, b: RawSignal, verifiedEdges: ReadonlySet<Edge> = new Set()): DocumentSignal {
  const agreement = a.documentType === b.documentType;
  const evalA = evaluateIntegrity(a, verifiedEdges);
  const evalB = evaluateIntegrity(b, verifiedEdges);
  const problems = [...evalA.problems.map((p) => `lectura A: ${p}`), ...evalB.problems.map((p) => `lectura B: ${p}`)];
  return {
    documentType: agreement ? a.documentType : "UNKNOWN",
    completeDocumentVisible: evalA.complete && evalB.complete,
    agreement,
    integrity: {
      problems,
      irrelevantCrops: [...new Set([...a.irrelevantCrops, ...b.irrelevantCrops])],
      studyRegion: validRegion(a.studyRegion) && validRegion(b.studyRegion) ? union(a.studyRegion, b.studyRegion) : undefined,
      verifiedEdges: [...verifiedEdges].map((edge) => EDGE_NAMES[edge])
    },
    reasons: [a.reason, b.reason],
    context: fuseContext(a.printedContext, b.printedContext)
  };
}

export interface SignalRequest {
  instructions: string;
  variant: "A" | "B";
  imageBase64: string;
  mimeType: string;
}

export interface SignalDeps {
  complete: (request: SignalRequest) => Promise<{ value: unknown; usage?: AiUsage }>;
  // Verificación enfocada de bordes (solo se llama si la zona se acerca a un borde y no hay problemas duros).
  verifyEdges?: (request: EdgeRequest) => Promise<{ value: unknown; usage?: AiUsage }>;
  model: string;
  reasoning: string;
}

function params(model: string, reasoning: string, name: string, schema: Record<string, unknown>) {
  return {
    model,
    reasoning: { effort: reasoning as "low" | "medium" | "high" | "xhigh" | "max" },
    text: { format: { type: "json_schema" as const, name, strict: true, schema } }
  };
}
const signalParams = (model: string, reasoning: string) => params(model, reasoning, "document_integrity_signal", strictJsonSchema(signalSchema));
const edgeParams = (model: string, reasoning: string) => params(model, reasoning, "document_edge_verification", strictJsonSchema(edgeCheckSchema));

function defaultDeps(): SignalDeps {
  const model = process.env.OPENAI_READER_MODEL ?? "gpt-6.1-sol";
  const reasoning = process.env.OPENAI_DOCUMENT_REASONING ?? "medium";
  const call = async (p: ReturnType<typeof params>, text: string, imageBase64: string, mimeType: string) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required (define it in .env)");
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      ...p,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text },
          { type: "input_image", image_url: `data:${mimeType};base64,${imageBase64}`, detail: "original" }
        ]
      }]
    });
    return { value: JSON.parse(response.output_text), usage: usageFromResponses(response.usage) };
  };
  return {
    model,
    reasoning,
    complete: (request) => call(signalParams(model, reasoning), request.instructions, request.imageBase64, request.mimeType),
    verifyEdges: (request) => call(edgeParams(model, reasoning), request.instructions, request.imageBase64, request.mimeType)
  };
}

export interface DocumentSignalResult {
  signal: DocumentSignal;
  usage: AiUsage[];
  calls: number;
  cacheHits: number;
}

export async function readDocumentSignal(args: { imageBase64: string; mimeType: string; deps?: Partial<SignalDeps> }): Promise<DocumentSignalResult> {
  const resolved = { ...defaultDeps(), ...args.deps };
  const usage: AiUsage[] = [];
  let calls = 0;
  let cacheHits = 0;
  const one = async (variant: "A" | "B"): Promise<RawSignal> => {
    const instructions = documentInstructions(variant);
    let called = false;
    const value = await cachedAiCall({
      label: "openai-document-signal",
      provider: "openai",
      model: resolved.model,
      imageBase64: args.imageBase64,
      config: { prompt: instructions, mimeType: args.mimeType, params: signalParams(resolved.model, resolved.reasoning) },
      parse: (raw) => signalSchema.parse(raw),
      call: async () => {
        called = true;
        const response = await resolved.complete({ instructions, variant, imageBase64: args.imageBase64, mimeType: args.mimeType });
        if (response.usage) usage.push(response.usage);
        return { value: signalSchema.parse(response.value), usage: response.usage };
      }
    });
    if (called) calls++;
    else cacheHits++;
    return value;
  };
  const [a, b] = await Promise.all([one("A"), one("B")]);

  // Verificación de bordes: solo si la ÚNICA objeción es la proximidad al borde (sin cortes, ocultamientos ni dudas del modelo) y es una
  // solicitud que podría llegar a AUTO. Cualquier fallo o duda deja el borde sin verificar, y entonces bloquea.
  const touched = [...new Set([...touchedEdges(a.studyRegion), ...touchedEdges(b.studyRegion)])];
  const relevantType = a.documentType === b.documentType && (a.documentType === "TEXT_EXPLICIT_REQUEST" || a.documentType === "MARK_DEPENDENT_FORM");
  const onlyProximity = hardProblems(a).length === 0 && hardProblems(b).length === 0;
  let verified = new Set<Edge>();
  const edgeNotes: string[] = [];
  if (touched.length > 0 && relevantType && onlyProximity && resolved.verifyEdges) {
    const verifyEdges = resolved.verifyEdges;
    const verifyOne = async (variant: "A" | "B") => {
      const instructions = edgeInstructions(variant, touched);
      let called = false;
      const value = await cachedAiCall({
        label: "openai-document-edges",
        provider: "openai",
        model: resolved.model,
        imageBase64: args.imageBase64,
        config: { prompt: instructions, mimeType: args.mimeType, params: edgeParams(resolved.model, resolved.reasoning) },
        parse: (raw) => edgeCheckSchema.parse(raw),
        call: async () => {
          called = true;
          const response = await verifyEdges({ instructions, variant, edges: touched, imageBase64: args.imageBase64, mimeType: args.mimeType });
          if (response.usage) usage.push(response.usage);
          return { value: edgeCheckSchema.parse(response.value), usage: response.usage };
        }
      });
      if (called) calls++;
      else cacheHits++;
      return value;
    };
    try {
      const [ea, eb] = await Promise.all([verifyOne("A"), verifyOne("B")]);
      const resultA = edgeCheckPassed(ea, touched);
      const resultB = edgeCheckPassed(eb, touched);
      edgeNotes.push(...resultA.notes.map((note) => `verificación A: ${note}`), ...resultB.notes.map((note) => `verificación B: ${note}`));
      if (resultA.ok && resultB.ok) verified = new Set(touched);
    } catch (error) {
      edgeNotes.push(`verificación de borde no disponible: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const signal = fuseSignals(a, b, verified);
  signal.integrity.edgeNotes = edgeNotes;
  return { signal, usage, calls, cacheHits };
}
