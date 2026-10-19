import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import OpenAI from "openai";
import { z } from "zod";
import { cachedAiCall, recordAiUsage, usageFromChatCompletions, usageFromGemini, usageFromResponses } from "./cache.js";
import type { JudgeDecision, VisionReading } from "./types.js";

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

export const simpleReaderInstructionsFor = (legacy: boolean): string => `
Analiza la imagen completa de esta solicitud de laboratorio.
Devuelve SOLO los estudios que fueron realmente solicitados. Una solicitud puede
estar expresada por texto explícito, X, check, círculo, subrayado, tachado, rayón
u otra marca. No listes todas las opciones impresas en el formato.
Para cada estudio devuelve:
- literalText: el texto tal como es realmente visible en la imagen, sin corregir ni completar.
- normalizedName: el nombre limpio del mismo estudio, sin agregar información que no se vea.
${legacy ? "" : LINE_TEXT_RULE}
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

// Mismo prompt, schema e imagen completa, pero Gemini vía OpenRouter (API compatible con OpenAI).
async function readImageWithGeminiViaOpenRouter(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
  legacy = false
): Promise<SimpleReading> {
  const readingSchema = legacy ? legacyReadingSchema : simpleReadingSchema;
  const readerInstructions = simpleReaderInstructionsFor(legacy);
  const model = process.env.OPENROUTER_GEMINI_MODEL ?? "google/gemini-3.8-flash";
  const reasoningEffort = process.env.OPENROUTER_GEMINI_REASONING ?? "medium";
  if (!["low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error(`OPENROUTER_GEMINI_REASONING inválido: "${reasoningEffort}" (usa low, medium o high)`);
  }
  const client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
  const { $schema: _ignored, ...schema } = z.toJSONSchema(readingSchema);
  const request = {
    model,
    // OpenRouter reserva crédito por el máximo de salida; sin tope pide 65536 y falla con saldo bajo.
    max_tokens: 6144,
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

  const { messages: _image, ...params } = request;
  return cachedAiCall({
    label: "gemini-openrouter",
    provider: "openrouter",
    model,
    imageBase64,
    config: { prompt: readerInstructions, mimeType, params },
    parse: (raw) => readingSchema.parse(raw),
    // Contenido que no se puede parsear/validar: se reintenta la misma petición (misma imagen, prompt y modelo).
    call: async () => {
      for (let attempt = 0; ; attempt++) {
        const response = await withUnavailableRetry(() => client.chat.completions.create(request));
        const choice = response.choices[0];
        const usage = usageFromChatCompletions(response.usage);
        try {
          return { value: readingSchema.parse(JSON.parse(choice?.message.content ?? "{}")), usage };
        } catch (error) {
          await recordAiUsage({ label: "gemini-openrouter", provider: "openrouter", model, usage, invalid: true });
          if (attempt >= INVALID_RESPONSE_RETRIES) {
            throw new Error(
              `Respuesta inválida de OpenRouter tras ${attempt + 1} intentos (finish_reason=${choice?.finish_reason}, ` +
                `completion_tokens=${response.usage?.completion_tokens}): ${(error as Error).message}\n` +
                `Final del contenido: ${JSON.stringify((choice?.message.content ?? "").slice(-200))}`
            );
          }
          console.error(`Respuesta inválida de OpenRouter (${(error as Error).message.split("\n")[0]}), reintento ${attempt + 1}/${INVALID_RESPONSE_RETRIES}...`);
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
  compat?: ReaderCompat
): Promise<SimpleReading> {
  const legacy = compat === "legacy";
  const readingSchema = legacy ? legacyReadingSchema : simpleReadingSchema;
  const readerInstructions = simpleReaderInstructionsFor(legacy);
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) return readImageWithGeminiViaOpenRouter(imageBase64, mimeType, openRouterKey, legacy);
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
  compat?: ReaderCompat
): Promise<SimpleReading> {
  const legacy = compat === "legacy";
  const readingSchema = legacy ? legacyReadingSchema : simpleReadingSchema;
  const readerInstructions = simpleReaderInstructionsFor(legacy);
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
