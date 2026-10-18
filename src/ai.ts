import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
          thinkingLevel: (process.env.GEMINI_THINKING_LEVEL ?? "medium") as "low" | "medium" | "high"
        },
        responseFormat: {
          text: {
            mimeType: "application/json",
            schema: zodToJsonSchema(readingSchema)
          }
        }
      }
    });

    const parsed = readingSchema.parse(JSON.parse(response.text ?? "{}"));
    return { ...parsed, reader: this.name };
  }
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
          schema: zodToJsonSchema(readingSchema)
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
          schema: zodToJsonSchema(judgeSchema)
        }
      }
    });

    return judgeSchema.parse(JSON.parse(response.output_text));
  }
}
