import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import { z } from "zod";
import { cachedAiCall, recordAiUsage, usageFromChatCompletions, usageFromGemini, usageFromResponses } from "./cache.js";
import type { JudgeDecision, VisionReading } from "./types.js";
import { hintsBlock } from "./photo-quality.js";

const observationSchema = z.object({
  text: z.string().min(1),
  evidenceType: z.enum([
    "PRINTED_TEXT", "X_MARK", "CHECK", "CIRCLE", "UNDERLINE",
    "STRIKE", "SCRIBBLE", "OTHER", "UNCLEAR"
  ]),
  certainty: z.enum(["HIGH", "MEDIUM", "LOW"]),
  evidenceSummary: z.string()
});

const readingSchema = z.object({
  documentType: z.enum([
    "TEXT_EXPLICIT_REQUEST", "MARK_DEPENDENT_FORM", "HANDWRITTEN_REQUEST",
    "NOT_A_REQUEST", "UNKNOWN"
  ]),
  completeDocumentVisible: z.boolean(),
  requested: z.array(observationSchema),
  uncertain: z.array(observationSchema),
  globalUncertainty: z.array(z.string())
});

const judgeSchema = z.object({
  requested: z.array(observationSchema),
  rejectedKeys: z.array(z.string()),
  unresolvedKeys: z.array(z.string())
});

// Esquema JSON para respuestas estructuradas. zod-to-json-schema (v3) no entiende zod 4 y devolvía solo {"$schema": ...}, que la API
// rechaza ("schema must have a 'type' key"); z.toJSONSchema es el generador nativo de zod 4 y produce el mismo contrato.
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

// El SDK de Gemini espera el enum ThinkingLevel (LOW/MEDIUM/HIGH); la variable de entorno sigue siendo low|medium|high.
export function geminiThinkingLevel(value: string): ThinkingLevel {
  const level = ThinkingLevel[value.trim().toUpperCase() as keyof typeof ThinkingLevel];
  if (!level || level === ThinkingLevel.THINKING_LEVEL_UNSPECIFIED) throw new Error(`GEMINI_THINKING_LEVEL inválido: "${value}" (usa low, medium o high)`);
  return level;
}

export interface VisionReader {
  name: string;
  read(imageBase64: string, mimeType: string): Promise<VisionReading>;
}

const readerInstructions = `
Analiza la solicitud de laboratorio completa como un documento visual.
Devuelve SOLO los estudios que realmente fueron solicitados físicamente.
Una selección puede estar expresada por texto explícito, X, check, círculo,
subrayado, tachado, rayón u otra marca. No listes todas las opciones impresas.
No inventes equivalencias, códigos ni precios. Si una marca puede pertenecer a
más de una opción o su significado no es claro, colócala en uncertain.
HANDWRITTEN_REQUEST significa que el pedido clínico depende de texto manuscrito;
por ahora ese caso no puede ser AUTO. Marca completeDocumentVisible=false si el
documento parece cortado o no permite evaluar todas las selecciones.
`;

export class GeminiReader implements VisionReader {
  name: string;
  private ai: GoogleGenAI;
  constructor(
    private model = process.env.GEMINI_READER_MODEL ?? "gemini-4-argon",
    apiKey = process.env.GEMINI_API_KEY
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is required");
    this.ai = new GoogleGenAI({ apiKey });
    this.name = `gemini:${model}`;
  }

  async read(imageBase64: string, mimeType: string): Promise<VisionReading> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{
        role: "user",
        parts: [
          { text: readerInstructions },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }],
      config: {
        thinkingConfig: {
          thinkingLevel: geminiThinkingLevel(process.env.GEMINI_THINKING_LEVEL ?? "medium")
        },
        // Mismo mecanismo que readImageWithGemini (el campo responseFormat no existe en GenerateContentConfig de este SDK).
        responseMimeType: "application/json",
        responseJsonSchema: strictJsonSchema(readingSchema)
      }
    });

    const parsed = readingSchema.parse(JSON.parse(response.text ?? "{}"));
    return { ...parsed, reader: this.name };
  }
}

export const studyBaseSchema = z.object({
  literalText: z.string(),
  normalizedName: z.string(),
  evidence: z.enum(["x", "check", "circle", "underline", "strike", "scribble", "explicit_text"]),
  confidence: z.enum(["high", "medium", "low"])
});

export const simpleReadingSchema = z.object({
  requestedStudies: z.array(studyBaseSchema.extend({
    // Texto COMPLETO de la línea o fila donde aparece el estudio (con "+", "/", "y", comas y calificadores). Varios estudios de una misma línea
    // comparten el mismo lineText. Preserva la agrupación original que literalText pierde cuando el lector separa una expresión.
    lineText: z.string()
  })),
  uncertainStudies: z.array(z.string()),
  notes: z.string()
});

// Contrato ANTERIOR a lineText. Solo para repetir sin gasto lecturas ya guardadas (la clave de caché incluye prompt y esquema): compat "legacy".
export const legacyReadingSchema = z.object({
  requestedStudies: z.array(studyBaseSchema),
  uncertainStudies: z.array(z.string()),
  notes: z.string()
});
export type ReaderCompat = "legacy" | undefined;

type ModelReading = z.infer<typeof simpleReadingSchema>;
// lineText es obligatorio en lo que devuelve el modelo, pero opcional en el tipo: las lecturas guardadas antes de existir el campo y las simulaciones de
// prueba no lo traen, y en ese caso el sistema se comporta como siempre (sin agrupación por línea).
export type SimpleReading = Omit<ModelReading, "requestedStudies"> & {
  requestedStudies: Array<Omit<ModelReading["requestedStudies"][number], "lineText"> & { lineText?: string }>;
};

const LINE_TEXT_RULE = `- lineText: el texto COMPLETO de la línea o fila de la solicitud donde aparece ese estudio, tal como es visible
  (con "+", "/", "y", comas y calificadores), no solo el estudio. Si varios estudios comparten una misma línea
  (por ejemplo "Gasometría + Lactato" o "TGO / TGP"), todos devuelven la MISMA lineText y cada uno su propio literalText.
  Si cada estudio está en su propia línea o fila, lineText es el texto de esa línea. En un formulario de casillas es
  el rótulo completo de la fila marcada. No inventes ni completes texto que no se vea.
`;

// Instrucciones de los dos lectores (Gemini y GPT: el MISMO texto, la misma imagen y el mismo esquema). El contrato "legacy" conserva byte a byte el prompt
// anterior a lineText para repetir sin gasto lo ya guardado en la caché; el vigente agrega reglas GENERALES de transcripción (nada específico de un estudio).
// `hints`: avisos generales sobre la foto leídos de sus metadatos (photo-quality.ts). Sin avisos el prompt es exactamente el de siempre.
export const simpleReaderInstructionsFor = (legacy: boolean, hints: readonly string[] = []): string =>
  legacy ? legacyReaderInstructions : `${currentReaderInstructions}${hintsBlock(hints)}`;

const legacyReaderInstructions = `
Analiza la imagen completa de esta solicitud de laboratorio.
Devuelve SOLO los estudios que fueron realmente solicitados. Una solicitud puede
estar expresada por texto explícito, X, check, círculo, subrayado, tachado, rayón
u otra marca. No listes todas las opciones impresas en el formato.
Para cada estudio devuelve:
- literalText: el texto tal como es realmente visible en la imagen, sin corregir ni completar.
- normalizedName: el nombre limpio del mismo estudio, sin agregar información que no se vea.

Reglas estrictas:
- No completes pares ni grupos clínicos. No infieras IgG porque aparezca IgM, ni al revés;
  cada variante cuenta solo si está marcada o escrita por sí misma.
- No uses el diagnóstico, la indicación clínica ni el contexto médico para agregar estudios.
- Solo lo visible cuenta: no agregues un estudio porque "normalmente se pide junto con" otro.
- Si una variante, letra o número del estudio no está clara (por ejemplo T3 vs T4,
  IgG vs IgM, B12 vs B1), no la adivines: ponla en uncertainStudies con lo que sí se ve.
- Si no estás seguro de si un estudio fue solicitado, ponlo en uncertainStudies.
Usa "notes" para cualquier observación relevante (imagen cortada, ilegible, etc.).
`;

// Reglas de transcripción vigentes. Son generales: describen CÓMO se escribe una receta (abreviaturas, listas, tablas, calificadores, letra a mano), nunca qué
// estudio es cuál. Lo que no se ve con claridad va a uncertainStudies: ninguna regla autoriza completar, corregir ni adivinar.
const TRANSCRIPTION_RULES = `
Cómo transcribir:
- Copia el texto como está escrito: abreviaturas, siglas, mayúsculas, números, signos (+, /, -, paréntesis) y erratas
  incluidos. No desarrolles abreviaturas ni corrijas la ortografía en literalText. En normalizedName puedes escribir el
  nombre completo solo si la abreviatura es inequívoca; si puede significar más de una cosa, déjala como está.
- Conserva TODO lo que distingue un estudio de otro y está escrito junto a él: letras o números de tipo o subtipo,
  antígeno o anticuerpo ("Ag", "Ac", "anti-"), clase de anticuerpo, total o libre, cualitativo o cuantitativo, método,
  muestra, tiempo o momento de la toma y cualquier otra indicación. Nunca los quites ni los muevas a otro estudio.
- Varios estudios en una misma línea unidos por "/", "+", comas, "y" o "e": devuelve cada estudio por separado, cada uno
  con SU texto tal como está escrito y todos con la misma lineText. No repartas a los demás una indicación o calificador
  escrito una sola vez (por ejemplo, al final de la lista): déjalo en el estudio donde está escrito, la lineText conserva
  la línea completa y en notes explica a cuáles podría aplicar. Si la línea es el nombre de UN solo estudio (un perfil,
  un cociente o un nombre que lleva "y" o "/"), devuélvela como un solo estudio.
- Tablas, columnas y encabezados: si una celda o renglón solo dice una parte del estudio (una sigla, una clase de
  anticuerpo, un método) y el resto está en el encabezado de la fila, de la columna o de la sección que le corresponde,
  literalText es lo que dice la celda y lineText es el encabezado seguido de la celda, en el orden en que se leen
  (por ejemplo "Encabezado: celda"). Si no se ve con claridad a qué encabezado pertenece, pon el estudio en uncertainStudies.
- Letra a mano: transcribe solo las letras que se leen con seguridad. Si una palabra, letra o número no se lee, no lo
  completes con el estudio más parecido: pon en uncertainStudies lo que sí se lee y marca lo ilegible con "?".
`;

const currentReaderInstructions = `
Analiza la imagen completa de esta solicitud de laboratorio.
Devuelve SOLO los estudios que fueron realmente solicitados. Una solicitud puede
estar expresada por texto explícito, X, check, círculo, subrayado, tachado, rayón
u otra marca. No listes todas las opciones impresas en el formato.
Para cada estudio devuelve:
- literalText: el texto tal como es realmente visible en la imagen, sin corregir ni completar.
- normalizedName: el nombre limpio del mismo estudio, sin agregar información que no se vea.
${LINE_TEXT_RULE}${TRANSCRIPTION_RULES}
Reglas estrictas:
- No completes pares ni grupos clínicos. No infieras IgG porque aparezca IgM, ni al revés;
  cada variante cuenta solo si está marcada o escrita por sí misma.
- No uses el diagnóstico, la indicación clínica ni el contexto médico para agregar estudios.
- Solo lo visible cuenta: no agregues un estudio porque "normalmente se pide junto con" otro.
- Si una variante, letra o número del estudio no está clara (por ejemplo T3 vs T4,
  IgG vs IgM, B12 vs B1), no la adivines: ponla en uncertainStudies con lo que sí se ve.
- Si no estás seguro de si un estudio fue solicitado, ponlo en uncertainStudies.
Usa "notes" para cualquier observación relevante (imagen cortada, ilegible, etc.).
`;

const simpleReaderInstructions = simpleReaderInstructionsFor(false);

const UNAVAILABLE_RETRY_DELAYS_MS = [3000, 6000, 12000];
const INVALID_RESPONSE_RETRIES = 1;

function isUnavailable(error: unknown): boolean {
  return (error instanceof ApiError || error instanceof OpenAI.APIError) && error.status === 503;
}

async function withUnavailableRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const delay = UNAVAILABLE_RETRY_DELAYS_MS[attempt];
      if (!isUnavailable(error) || delay === undefined) throw error;
      console.error(`Gemini 503 UNAVAILABLE, reintento ${attempt + 1}/${UNAVAILABLE_RETRY_DELAYS_MS.length} en ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// Tope de tokens de SALIDA de Gemini vía OpenRouter. En ese tope entran el razonamiento Y el JSON (el JSON ocupa unos cientos de tokens; casi todo lo demás es
// razonamiento): con 6144 el razonamiento consumía casi todo y el JSON salía truncado (finish_reason=length). OpenRouter reserva crédito por el máximo pedido
// (sin tope pide 65536 y falla con saldo bajo), así que el tope inicial es holgado pero acotado.
// Si de verdad se trunca, hay UN solo reintento: el razonamiento se agotó, así que repetir lo mismo con más tope paga el doble por el mismo exceso. El reintento
// usa un razonamiento menor (por defecto "low") y un tope 1,5 veces mayor. Es seguro: la lectura de Gemini solo cuenta si el otro lector coincide en el consenso;
// una lectura distinta queda como disputa y nunca se cotiza sola.
// Configurable: OPENROUTER_GEMINI_MAX_TOKENS, OPENROUTER_GEMINI_RETRY_MAX_TOKENS, OPENROUTER_GEMINI_RETRY_REASONING.
export const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
export const OPENROUTER_RETRY_GROWTH = 1.5;
export const OPENROUTER_ABSOLUTE_MAX_TOKENS = 65536;
const LEGACY_OPENROUTER_MAX_TOKENS = 6144;
const REASONING_EFFORTS = ["low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function tokenLimit(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > OPENROUTER_ABSOLUTE_MAX_TOKENS) throw new Error(`${name} inválido: "${raw}" (entero entre 1024 y ${OPENROUTER_ABSOLUTE_MAX_TOKENS})`);
  return value;
}

export function openRouterMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  return tokenLimit(env, "OPENROUTER_GEMINI_MAX_TOKENS") ?? OPENROUTER_DEFAULT_MAX_TOKENS;
}

// Tope del reintento por truncamiento. Si no es mayor que el inicial no hay reintento (fallaría igual y se pagaría otra vez).
export function openRouterRetryMaxTokens(initial: number, env: NodeJS.ProcessEnv = process.env): number {
  return tokenLimit(env, "OPENROUTER_GEMINI_RETRY_MAX_TOKENS") ?? Math.min(Math.ceil(initial * OPENROUTER_RETRY_GROWTH), OPENROUTER_ABSOLUTE_MAX_TOKENS);
}

export function openRouterRetryReasoning(env: NodeJS.ProcessEnv = process.env): ReasoningEffort {
  const raw = env.OPENROUTER_GEMINI_RETRY_REASONING?.trim() || "low";
  if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) throw new Error(`OPENROUTER_GEMINI_RETRY_REASONING inválido: "${raw}" (usa low, medium o high)`);
  return raw as ReasoningEffort;
}

// Mismo prompt, schema e imagen completa, pero Gemini vía OpenRouter (API compatible con OpenAI).
export async function readImageWithGeminiViaOpenRouter(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
  legacy = false,
  client: Pick<OpenAI, "chat"> = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" }),
  hints: readonly string[] = []
): Promise<SimpleReading> {
  const readingSchema = legacy ? legacyReadingSchema : simpleReadingSchema;
  const readerInstructions = simpleReaderInstructionsFor(legacy, hints);
  const model = process.env.OPENROUTER_GEMINI_MODEL ?? "google/gemini-3.8-flash";
  const reasoningEffort = process.env.OPENROUTER_GEMINI_REASONING ?? "medium";
  if (!["low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error(`OPENROUTER_GEMINI_REASONING inválido: "${reasoningEffort}" (usa low, medium o high)`);
  }
  const { $schema: _ignored, ...schema } = z.toJSONSchema(readingSchema);
  const initialMaxTokens = openRouterMaxTokens();
  const retryMaxTokens = openRouterRetryMaxTokens(initialMaxTokens);
  const retryReasoning = openRouterRetryReasoning();
  const request = {
    model,
    max_tokens: initialMaxTokens,
    reasoning: { effort: reasoningEffort },
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: readerInstructions },
        { type: "image_url" as const, image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }],
    response_format: {
      type: "json_schema" as const,
      json_schema: { name: "prescription_simple_reading", strict: true, schema }
    }
  };

  const { messages: _image, max_tokens: _cap, ...paramsWithoutCap } = request;
  // El tope de salida no cambia la respuesta (salvo que trunque), así que no forma parte de la clave de caché; el contrato anterior conserva la suya.
  // (mismo orden de propiedades que antes: la clave de caché es un hash del JSON)
  const params = legacy ? { model: paramsWithoutCap.model, max_tokens: LEGACY_OPENROUTER_MAX_TOKENS, reasoning: paramsWithoutCap.reasoning, response_format: paramsWithoutCap.response_format } : paramsWithoutCap;
  return cachedAiCall({
    label: "gemini-openrouter",
    provider: "openrouter",
    model,
    imageBase64,
    config: { prompt: readerInstructions, mimeType, params },
    parse: (raw) => readingSchema.parse(raw),
    // Contenido que no se puede parsear/validar. Dos causas distintas:
    //  - TRUNCADO (finish_reason=length): repetir la misma petición con el mismo tope vuelve a truncar y se paga otra vez. Se reintenta UNA vez con menos
    //    razonamiento y un tope mayor; si el tope del reintento no supera al actual o vuelve a truncar, se falla sin más reintentos.
    //  - Otro contenido inválido: se reintenta una vez la misma petición (misma imagen, prompt y modelo).
    call: async () => {
      let maxTokens = initialMaxTokens;
      let effort: ReasoningEffort = reasoningEffort as ReasoningEffort;
      let invalidRetries = 0;
      let truncationRetried = false;
      for (let attempt = 1; ; attempt++) {
        const response = await withUnavailableRetry(() => {
          const attemptRequest = { ...request, max_tokens: maxTokens, reasoning: { effort } };
          return client.chat.completions.create(attemptRequest);
        });
        const choice = response.choices[0];
        const usage = usageFromChatCompletions(response.usage);
        try {
          return { value: readingSchema.parse(JSON.parse(choice?.message.content ?? "{}")), usage, reasoningEffort: effort };
        } catch (error) {
          await recordAiUsage({ label: "gemini-openrouter", provider: "openrouter", model, usage, invalid: true, reasoningEffort: effort });
          const detail = `finish_reason=${choice?.finish_reason}, completion_tokens=${response.usage?.completion_tokens}, max_tokens=${maxTokens}, reasoning=${effort}`;
          const tail = `Final del contenido: ${JSON.stringify((choice?.message.content ?? "").slice(-200))}`;
          if (choice?.finish_reason === "length") {
            if (truncationRetried || retryMaxTokens <= maxTokens) {
              throw new Error(`Respuesta de OpenRouter TRUNCADA por el tope de salida (${detail}). No se reintenta: sube OPENROUTER_GEMINI_MAX_TOKENS o baja OPENROUTER_GEMINI_REASONING.\n${tail}`);
            }
            truncationRetried = true;
            console.error(`Respuesta de OpenRouter truncada (${detail}); un reintento con max_tokens=${retryMaxTokens}, reasoning=${retryReasoning}...`);
            maxTokens = retryMaxTokens;
            effort = retryReasoning;
            continue;
          }
          if (invalidRetries >= INVALID_RESPONSE_RETRIES) {
            throw new Error(`Respuesta inválida de OpenRouter tras ${attempt} intentos (${detail}): ${(error as Error).message}\n${tail}`);
          }
          invalidRetries++;
          console.error(`Respuesta inválida de OpenRouter (${(error as Error).message.split("\n")[0]}), reintento ${invalidRetries}/${INVALID_RESPONSE_RETRIES}...`);
        }
      }
    }
  });
}

// Primera conexión real: imagen completa -> Gemini -> JSON simple. Sin OCR, crops ni catálogo.
// Si OPENROUTER_API_KEY está definida, Gemini se llama vía OpenRouter en vez de Google AI Studio.
export async function readImageWithGemini(
  imageBase64: string,
  mimeType: string,
  model = process.env.GEMINI_READER_MODEL ?? "gemini-4-argon",
  apiKey = process.env.GEMINI_API_KEY,
  compat?: ReaderCompat,
  hints: readonly string[] = []
): Promise<SimpleReading> {
  const legacy = compat === "legacy";
  const readingSchema = legacy ? legacyReadingSchema : simpleReadingSchema;
  const readerInstructions = simpleReaderInstructionsFor(legacy, hints);
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) return readImageWithGeminiViaOpenRouter(imageBase64, mimeType, openRouterKey, legacy, undefined, hints);
  if (!apiKey) throw new Error("GEMINI_API_KEY is required (define it in .env)");
  const ai = new GoogleGenAI({ apiKey });
  const request = {
    model,
    contents: [{
      role: "user",
      parts: [
        { text: readerInstructions },
        { inlineData: { mimeType, data: imageBase64 } }
      ]
    }],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(readingSchema)
    }
  };

  return cachedAiCall({
    label: "gemini-aistudio",
    provider: "google-ai-studio",
    model,
    imageBase64,
    config: { prompt: readerInstructions, mimeType, requestConfig: request.config },
    parse: (raw) => readingSchema.parse(raw),
    call: async () => {
      const response = await withUnavailableRetry(() => ai.models.generateContent(request));
      return {
        value: readingSchema.parse(JSON.parse(response.text ?? "{}")),
        usage: usageFromGemini(response.usageMetadata)
      };
    }
  });
}

// Segundo lector independiente: mismo prompt, schema e imagen completa; nunca ve la respuesta de Gemini.
export async function readImageWithOpenAI(
  imageBase64: string,
  mimeType: string,
  model = process.env.OPENAI_READER_MODEL ?? "gpt-6.1-sol",
  apiKey = process.env.OPENAI_API_KEY,
  compat?: ReaderCompat,
  hints: readonly string[] = []
): Promise<SimpleReading> {
  const legacy = compat === "legacy";
  const readingSchema = legacy ? legacyReadingSchema : simpleReadingSchema;
  const readerInstructions = simpleReaderInstructionsFor(legacy, hints);
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (define it in .env)");
  const client = new OpenAI({ apiKey });
  const { $schema: _ignored, ...schema } = z.toJSONSchema(readingSchema);
  const params = {
    model,
    reasoning: { effort: (process.env.OPENAI_READER_REASONING ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" },
    text: {
      format: {
        type: "json_schema" as const,
        name: "prescription_simple_reading",
        strict: true,
        schema
      }
    }
  };
  return cachedAiCall({
    label: "openai-reader",
    provider: "openai",
    model,
    imageBase64,
    config: { prompt: readerInstructions, mimeType, imageDetail: "original", params },
    parse: (raw) => readingSchema.parse(raw),
    call: async () => {
      const response = await client.responses.create({
        ...params,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: readerInstructions },
            { type: "input_image", image_url: `data:${mimeType};base64,${imageBase64}`, detail: "original" }
          ]
        }]
      });
      return {
        value: readingSchema.parse(JSON.parse(response.output_text)),
        usage: usageFromResponses(response.usage)
      };
    }
  });
}

export class OpenAIReader implements VisionReader {
  name: string;
  private client: OpenAI;
  constructor(
    private model = process.env.OPENAI_READER_MODEL ?? "gpt-6.1-sol",
    apiKey = process.env.OPENAI_API_KEY
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");
    this.client = new OpenAI({ apiKey });
    this.name = `openai:${model}`;
  }

  async read(imageBase64: string, mimeType: string): Promise<VisionReading> {
    const response = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: (process.env.OPENAI_READER_REASONING ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" },
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: readerInstructions },
          { type: "input_image", image_url: `data:${mimeType};base64,${imageBase64}`, detail: "original" }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "prescription_vision_reading",
          strict: true,
          schema: strictJsonSchema(readingSchema)
        }
      }
    });

    const parsed = readingSchema.parse(JSON.parse(response.output_text));
    return { ...parsed, reader: this.name };
  }
}

export interface DisputeJudge {
  judge(args: {
    imageBase64: string;
    mimeType: string;
    disputes: Array<{ key: string; a?: unknown; b?: unknown }>;
  }): Promise<JudgeDecision>;
}

export class OpenAIJudge implements DisputeJudge {
  private client: OpenAI;
  constructor(
    private model = process.env.OPENAI_JUDGE_MODEL ?? "gpt-6-astra",
    apiKey = process.env.OPENAI_API_KEY
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");
    this.client = new OpenAI({ apiKey });
  }

  async judge(args: {
    imageBase64: string;
    mimeType: string;
    disputes: Array<{ key: string; a?: unknown; b?: unknown }>;
  }): Promise<JudgeDecision> {
    const response = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: (process.env.OPENAI_JUDGE_REASONING ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" },
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Dos lectores independientes discrepan SOLO en los elementos de abajo.\n` +
              `Mira nuevamente la imagen original y resuelve cada disputa.\n` +
              `No agregues estudios fuera de las disputas. Si no es demostrable visualmente,\n` +
              `deja la key en unresolvedKeys. Nunca decidas códigos o precios.\n\n` +
              JSON.stringify(args.disputes)
          },
          { type: "input_image", image_url: `data:${args.mimeType};base64,${args.imageBase64}`, detail: "original" }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "prescription_dispute_judgement",
          strict: true,
          schema: strictJsonSchema(judgeSchema)
        }
      }
    });

    return judgeSchema.parse(JSON.parse(response.output_text));
  }
}
