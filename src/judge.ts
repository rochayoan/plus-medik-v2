import OpenAI from "openai";
import { z } from "zod";
import type { SimpleReading } from "./ai.js";
import type { SimpleDispute, SimpleStudy } from "./consensus.js";

const decisionSchema = z.object({
  key: z.string(),
  verdict: z.enum(["confirmed", "rejected", "unresolved"]),
  reason: z.string()
});

// Schema que se le pide al modelo; la respuesta se valida decisión por decisión (ver applyJudgeDecisions).
const decisionsSchema = z.object({ decisions: z.array(decisionSchema) });
const rawDecisionsSchema = z.object({ decisions: z.array(z.unknown()) });

export interface ResolvedStudy {
  key: string;
  verdict: "confirmed" | "rejected";
  study: SimpleStudy;
  reason: string;
}

export interface UnresolvedDispute {
  dispute: SimpleDispute;
  reason: string;
}

export interface SimpleJudgement {
  resolvedStudies: ResolvedStudy[];
  unresolvedDisputes: UnresolvedDispute[];
}

const judgeInstructions = `
Eres el juez de una solicitud de laboratorio. Dos lectores independientes (readerA = Gemini,
readerB = OpenAI) discreparon SOLO en las disputas listadas abajo. Mira de nuevo la imagen
original completa y resuelve cada disputa.

Reglas estrictas:
- La imagen es la única fuente de verdad. Las lecturas de los lectores son pistas, no evidencia.
- Resuelve exactamente las disputas listadas, una decisión por cada "key", copiando la key tal cual.
- No agregues estudios nuevos ni decisiones sobre estudios que no estén en las disputas.
- No uses el diagnóstico ni el contexto médico para completar o inferir estudios.
- No infieras IgG por IgM ni al revés.
- Veredictos:
  - confirmed: se ve claramente en la imagen que ese estudio fue solicitado, tal como está descrito en la disputa.
  - rejected: se ve claramente que ese estudio NO fue solicitado (por ejemplo, el texto visible es otro).
  - unresolved: si no es claro visualmente, o la imagen no permite demostrarlo.
- En "reason" explica brevemente qué se ve en la imagen.
`;

export async function judgeDisputesWithOpenAI(args: {
  imageBase64: string;
  mimeType: string;
  gemini: SimpleReading;
  openai: SimpleReading;
  disputes: SimpleDispute[];
  model?: string;
  apiKey?: string;
}): Promise<SimpleJudgement> {
  const { imageBase64, mimeType, gemini, openai, disputes } = args;
  if (disputes.length === 0) return { resolvedStudies: [], unresolvedDisputes: [] };

  const apiKey = args.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (define it in .env)");
  const model = args.model ?? process.env.OPENAI_JUDGE_MODEL ?? process.env.OPENAI_READER_MODEL ?? "gpt-6.1-sol";

  const client = new OpenAI({ apiKey });
  const { $schema: _ignored, ...schema } = z.toJSONSchema(decisionsSchema);
  const response = await client.responses.create({
    model,
    reasoning: { effort: (process.env.OPENAI_JUDGE_REASONING ?? "high") as "low" | "medium" | "high" | "xhigh" | "max" },
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: `${judgeInstructions}\nLectura readerA (Gemini):\n${JSON.stringify(gemini)}\n\n` +
            `Lectura readerB (OpenAI):\n${JSON.stringify(openai)}\n\nDisputas a resolver:\n${JSON.stringify(disputes)}`
        },
        { type: "input_image", image_url: `data:${mimeType};base64,${imageBase64}`, detail: "original" }
      ]
    }],
    text: {
      format: {
        type: "json_schema",
        name: "prescription_simple_judgement",
        strict: true,
        schema
      }
    }
  });

  const { decisions } = rawDecisionsSchema.parse(JSON.parse(response.output_text));
  return applyJudgeDecisions(disputes, decisions);
}

// El juez solo decide sobre las disputas dadas: se ignoran keys desconocidas, lo omitido queda unresolved
// y un estudio confirmado/rechazado siempre sale de lo que ya leyeron los lectores (nunca inventado).
// Una decisión sin verdict válido (omitido o fuera de confirmed/rejected/unresolved) nunca se infiere:
// la disputa pasa a unresolvedDisputes.
export function applyJudgeDecisions(disputes: SimpleDispute[], rawDecisions: unknown[]): SimpleJudgement {
  const resolvedStudies: ResolvedStudy[] = [];
  const unresolvedDisputes: UnresolvedDispute[] = [];

  for (const dispute of disputes) {
    const forDispute = rawDecisions.filter(
      (candidate) => typeof candidate === "object" && candidate !== null && (candidate as { key?: unknown }).key === dispute.key
    );
    const decision = forDispute
      .map((candidate) => decisionSchema.safeParse(candidate))
      .find((parsed) => parsed.success)?.data;
    const study = dispute.readerA.requested ?? dispute.readerB.requested;

    if (!decision) {
      unresolvedDisputes.push({
        dispute,
        reason: forDispute.length > 0
          ? "El juez devolvió una decisión sin verdict válido para esta disputa."
          : "El juez no devolvió decisión para esta disputa."
      });
    } else if (decision.verdict === "unresolved" || !study) {
      const reason = decision.verdict !== "unresolved" && !study
        ? `Sin estudio solicitado por ningún lector; no se puede ${decision.verdict === "confirmed" ? "confirmar" : "resolver"}. ${decision.reason}`
        : decision.reason;
      unresolvedDisputes.push({ dispute, reason });
    } else {
      resolvedStudies.push({ key: dispute.key, verdict: decision.verdict, study, reason: decision.reason });
    }
  }

  return { resolvedStudies, unresolvedDisputes };
}
