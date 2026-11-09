import { stripPaymentTalk } from "../payment-talk.js";
import { describeProviderError } from "../provider-error.js";
import type { AgentDecision, AgentModel, Capabilities, HandoffReason, ModelUsage, PlanOutput, RecentEntry, Utterance, Violation } from "./contracts.js";
import { groundedQuoteCalls, operationalPlan } from "./intent-guard.js";
import { runToolCalls, type ToolRegistry } from "./tools.js";
import { verifyReply } from "./verify.js";

// Tubería FIJA y corta del agente conversacional (no un bucle libre del modelo): 1) el modelo decide qué consultar (a veces nada: saludos, agradecimientos, charla) → 2) herramientas de solo lectura →
// 3) el modelo redacta en TEXTO LIBRE con lo que devolvieron → 4) verificación por procedencia (cifras, dinero, promesas de una persona), con un segundo intento si algo se rechaza.
// «Sin datos» de una herramienta NO es un fallo: el modelo lo sabe y responde con honestidad. Ante un error del modelo devuelve un estado y sin mensaje; quien responde usa el modo esencial.

// off = apagado; live = el agente conversacional ÚNICO atiende a todos los contactos elegibles, con el interruptor de emergencia de la base (src/agent/pilot.ts) y el MODO ESENCIAL (textos fijos, catálogo,
// cotización y derivación deterministas) cuando el interruptor está apagado o el modelo no puede responder.
export type AgentMode = "off" | "live";

// PLUSMEDIK_LLM_CONVERSATION=on (la bandera de la capa conversacional) enciende el agente; cualquier otro valor lo deja apagado (una errata nunca lo enciende).
export function resolveAgentMode(env: Record<string, string | undefined>): AgentMode {
  return env.PLUSMEDIK_LLM_CONVERSATION?.trim().toLowerCase() === "on" ? "live" : "off";
}

export interface AgentTurnInput {
  utterances: readonly Utterance[];
  recent?: readonly RecentEntry[];
  capabilities?: Capabilities;
  now?: Date;
}

export interface AgentDeps {
  model: AgentModel;
  tools: ToolRegistry;
  // Ejecuta la derivación REGISTRADA a una persona (cola al CRM) cuando el plan la pidió y el texto pasó la verificación. Devuelve true solo si el caso quedó registrado. Sin él no existe la derivación.
  handoff?: (reason: HandoffReason) => Promise<boolean>;
  // true si el turno ya no puede producir efectos (venció el plazo y el modo esencial tomó el relevo): antes de derivar se comprueba, para no registrar un caso tardío.
  cancelled?: () => boolean;
}

const EMPTY_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, calls: 0 };
const addUsage = (total: ModelUsage, used: Partial<ModelUsage> | undefined): ModelUsage => ({
  inputTokens: total.inputTokens + (used?.inputTokens ?? 0),
  outputTokens: total.outputTokens + (used?.outputTokens ?? 0),
  reasoningTokens: total.reasoningTokens + (used?.reasoningTokens ?? 0),
  calls: total.calls + 1
});

// Una salida del modelo que no se puede usar. SOLO códigos: `reason` (qué falló), `detail` (campo del esquema y tipo de problema, p. ej. «toolCalls.0.tool:invalid_value»; nunca valores) y `stage` (plan o respond).
export class AgentOutputError extends Error {
  constructor(readonly reason: string, readonly detail?: string, public stage?: "plan" | "respond") {
    super(`agent_output_${reason}`);
    this.name = "AgentOutputError";
  }
}

// Un error del modelo se describe SOLO con códigos de la lista blanca (sin mensaje, sin cuerpo). Una salida vacía o ilegible lleva su motivo, su etapa y el detalle del campo.
const modelFailure = (error: unknown): AgentDecision["modelError"] =>
  error instanceof AgentOutputError ? { cause: "INVALID_OUTPUT", ...(error.stage ? { stage: error.stage } : {}), reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) } : describeProviderError(error);

const MAX_ATTEMPTS = 2;

export async function runAgentTurn(deps: AgentDeps, input: AgentTurnInput): Promise<AgentDecision> {
  const now = input.now ?? new Date();
  const capabilities = input.capabilities ?? { handoff: false, quote: true };
  const recent = input.recent ?? [];
  let usage = EMPTY_USAGE;
  const done = (decision: Omit<AgentDecision, "usage" | "toolRuns" | "facts" | "violations"> & Partial<Pick<AgentDecision, "toolRuns" | "facts" | "violations">>): AgentDecision =>
    ({ toolRuns: [], facts: [], violations: [], ...decision, usage });
  if (input.utterances.length === 0) return done({ status: "VERIFIED" });

  // 1. Preguntas administrativas: consultar el conocimiento aprobado sin gastar
  // una llamada de planificación. Los demás turnos conservan el planificador.
  let plan: PlanOutput;
  const direct = operationalPlan(input.utterances, deps.tools.list(), capabilities);
  if (direct) {
    plan = direct;
  } else {
    try {
      plan = await deps.model.plan({ utterances: input.utterances, recent, tools: deps.tools.list(), capabilities });
      usage = addUsage(usage, plan.usage);
    } catch (error) {
      return done({ status: "MODEL_ERROR", modelError: modelFailure(error) });
    }
  }
  const grounded = groundedQuoteCalls(plan.toolCalls, input.utterances, recent);
  plan = { ...plan, toolCalls: grounded.calls, ...(grounded.rejected && !plan.fallback ? { fallback: "quote_study_not_in_patient_context" } : {}) };
  const planInfo = plan.fallback ? { planFallback: plan.fallback } : {};

  // SILENCIO ante lo CLARAMENTE ajeno al laboratorio. El modelo propone; el sistema exige además que las reglas tampoco vean nada del laboratorio (tema OTHER en todo lo escrito) y que no haya conversación
  // previa (ningún mensaje en las últimas horas). Ante cualquier duda se responde como siempre.
  if (plan.silent === true && input.utterances.every((utterance) => utterance.topic === "OTHER") && recent.length === 0) return done({ status: "SILENT", ...planInfo });

  // 2. Herramientas de solo lectura. «Sin datos» pasa al modelo como una nota, no como un fallo.
  const patientText = input.utterances.map((utterance) => utterance.text).join("\n");
  const { runs, facts, blocks, notes } = await runToolCalls(deps.tools, plan.toolCalls, { now, patientText });
  const hasQuoteBlock = blocks.length > 0;
  const quotePartial = facts.some((fact) => fact.source === "QUOTE_ENGINE" && /PARCIAL/.test(fact.text));
  const handoff = plan.handoff !== undefined && capabilities.handoff && Boolean(deps.handoff) ? plan.handoff : undefined;
  const base = { toolRuns: runs, facts, ...planInfo };

  // 3. y 4. Redacción en texto libre y verificación. Hasta DOS intentos: si la verificación rechaza el primero, el modelo recibe solo los códigos de lo que falló. Nunca más (costo y tiempo acotados).
  let feedback: Violation[] | undefined;
  let firstViolations: Violation[] | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text: string;
    try {
      const response = await deps.model.respond({ utterances: input.utterances, recent, facts, notes, hasQuoteBlock, capabilities, handoff: handoff !== undefined, ...(feedback ? { feedback } : {}) });
      usage = addUsage(usage, response.usage);
      // Métodos de pago: por ahora no se dice nada. Si el redactor los menciona, esas oraciones se IGNORAN (no se rechaza el mensaje): queda lo demás.
      text = stripPaymentTalk(response.text, { split: "sentence" }).trim();
    } catch (error) {
      return done({ status: "MODEL_ERROR", ...base, modelError: modelFailure(error), ...(firstViolations ? { repairs: 1, firstViolations } : {}) });
    }
    const problems = verifyReply({ text, facts, patientText, handoff: handoff !== undefined });
    const repairInfo = firstViolations ? { repairs: 1, firstViolations } : {};
    if (problems.length === 0) {
      // Pasar con una persona: el texto solo puede decirlo si el caso QUEDÓ registrado. Se ejecuta DESPUÉS de verificar y ANTES de entregar el mensaje; si no se registra, no hay mensaje.
      if (handoff !== undefined) {
        const registered = deps.handoff && !deps.cancelled?.() ? await deps.handoff(handoff).catch(() => false) : false;
        if (!registered) return done({ status: "HANDOFF_FAILED", ...base, handoffRequested: true, ...repairInfo });
      }
      // La cotización (precios del catálogo) la agrega el SISTEMA tal cual la armó el motor.
      const reply = [text, ...blocks].join("\n\n");
      return done({ status: "VERIFIED", ...base, reply, ...(hasQuoteBlock ? { quoted: true, ...(quotePartial ? { quotePartial: true } : {}) } : {}), ...(handoff !== undefined ? { handoffRequested: true, handoffRegistered: true } : {}), ...repairInfo });
    }
    if (attempt === MAX_ATTEMPTS) return done({ status: "REJECTED", ...base, violations: problems, ...repairInfo });
    feedback = firstViolations = problems;
  }
  return done({ status: "REJECTED", ...base });
}
