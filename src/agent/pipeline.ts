import { stripPaymentTalk } from "../payment-talk.js";
import { describeProviderError } from "../provider-error.js";
import type { AgentDecision, AgentModel, Capabilities, HandoffReason, IntentReading, ModelUsage, RecentEntry, Utterance, Violation } from "./contracts.js";
import { runToolCalls, type ToolRegistry } from "./tools.js";
import { validateActs, verifyReply } from "./verify.js";

// Tubería FIJA del núcleo conversacional (no un bucle libre del modelo): entender y pedir datos → ejecutar herramientas de solo lectura → decidir actos y redactar → validar actos → verificar por procedencia.
// En esta fase solo produce una DECISIÓN para auditar (el mensaje propuesto NO se envía): `PLUSMEDIK_AGENT=shadow` la compara con lo que respondió el agente actual. Ante cualquier fallo del modelo, de una
// herramienta o de la verificación devuelve un estado y sin mensaje; el sistema actual sigue respondiendo como siempre.

// off = apagado; live = el agente conversacional ÚNICO atiende a todos los contactos elegibles, con el interruptor de emergencia de la base (src/agent/pilot.ts) y el MODO ESENCIAL (textos fijos, catálogo,
// cotización y derivación deterministas) cuando el interruptor está apagado o el modelo no puede responder.
export type AgentMode = "off" | "live";

// PLUSMEDIK_LLM_CONVERSATION=on (la misma bandera de siempre de la capa conversacional) enciende el agente; cualquier otro valor lo deja apagado (una errata nunca lo enciende).
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
  // Ejecuta la derivación REGISTRADA a una persona (cola al CRM) cuando un acto HANDOFF pasó la verificación. Devuelve true solo si el caso quedó registrado. Sin él no existe el acto HANDOFF.
  handoff?: (reason: HandoffReason) => Promise<boolean>;
  // true si el turno ya no puede producir efectos (venció el plazo del piloto y el productor de siempre tomó el relevo): antes de derivar se comprueba, para no registrar un caso tardío.
  cancelled?: () => boolean;
}

const EMPTY_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, calls: 0 };
const addUsage = (total: ModelUsage, used: Partial<ModelUsage> | undefined): ModelUsage => ({
  inputTokens: total.inputTokens + (used?.inputTokens ?? 0),
  outputTokens: total.outputTokens + (used?.outputTokens ?? 0),
  reasoningTokens: total.reasoningTokens + (used?.reasoningTokens ?? 0),
  calls: total.calls + 1
});

// Un error del modelo se describe SOLO con códigos de la lista blanca (sin mensaje, sin cuerpo). Una salida con forma inválida lleva un código propio.
const modelFailure = (error: unknown): AgentDecision["modelError"] =>
  error instanceof AgentOutputError ? { cause: "INVALID_OUTPUT", ...(error.stage ? { stage: error.stage } : {}), reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) } : describeProviderError(error);

// Una salida del modelo que no se puede usar. SOLO códigos: `reason` (qué falló), `detail` (campo del esquema y tipo de problema, p. ej. «acts.0.kind:invalid_value»; nunca valores) y `stage` (plan o respond).
export class AgentOutputError extends Error {
  constructor(readonly reason: string, readonly detail?: string, public stage?: "plan" | "respond") {
    super(`agent_output_${reason}`);
    this.name = "AgentOutputError";
  }
}

export async function runAgentTurn(deps: AgentDeps, input: AgentTurnInput): Promise<AgentDecision> {
  const now = input.now ?? new Date();
  const capabilities = input.capabilities ?? { handoff: false, quote: true };
  const recent = input.recent ?? [];
  let usage = EMPTY_USAGE;
  const done = (decision: Omit<AgentDecision, "usage" | "toolRuns" | "facts" | "violations"> & Partial<Pick<AgentDecision, "toolRuns" | "facts" | "violations">>): AgentDecision =>
    ({ toolRuns: [], facts: [], violations: [], ...decision, usage });
  if (input.utterances.length === 0) return done({ status: "VERIFIED" });

  let toolCalls;
  let intents: IntentReading[] = [];
  try {
    const planned = await deps.model.plan({ utterances: input.utterances, recent, tools: deps.tools.list(), capabilities });
    usage = addUsage(usage, planned.usage);
    toolCalls = planned.toolCalls;
    // Solo se aceptan lecturas de peticiones que existen (el modelo no puede inventar ids).
    const known = new Set(input.utterances.map((utterance) => utterance.id));
    intents = (planned.intents ?? []).filter((reading) => known.has(reading.utterance));
  } catch (error) {
    return done({ status: "MODEL_ERROR", modelError: modelFailure(error) });
  }
  // La intención la decide el MODELO: lo que leyó de cada petición manda sobre la etiqueta de las reglas (que solo rige si el modelo no leyó esa petición).
  const read = new Map(intents.map((reading) => [reading.utterance, reading.intent] as const));

  // SILENCIO ante lo CLARAMENTE ajeno al laboratorio. El modelo propone (OFF_TOPIC en CADA petición); el sistema exige además que las reglas tampoco vean nada del laboratorio (tema OTHER), que no haya nada
  // pendiente de antes y que no haya una conversación en curso (ningún mensaje reciente del asistente ni de la recepción). Ante cualquier duda se responde como siempre.
  if (input.utterances.every((utterance) => !utterance.carried && utterance.topic === "OTHER" && read.get(utterance.id) === "OFF_TOPIC") && !recent.some((entry) => entry.from !== "PATIENT")) {
    return done({ status: "SILENT", intents });
  }

  const { runs, facts, blocks } = await runToolCalls(deps.tools, toolCalls, { now });
  const hasQuoteBlock = blocks.length > 0;

  const patientText = input.utterances.map((utterance) => utterance.text ?? "").join("\n");
  let feedback: Violation[] | undefined;
  let firstViolations: Violation[] | undefined;
  // Hasta DOS intentos: si la validación rechaza el primero, el modelo recibe solo los códigos de lo que falló y decide una vez más. Nunca más (costo y tiempo acotados).
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await deps.model.respond({ utterances: input.utterances, recent, facts, hasQuoteBlock, capabilities, ...(intents.length > 0 ? { intents } : {}), ...(feedback ? { feedback } : {}) });
      usage = addUsage(usage, response.usage);
    } catch (error) {
      return done({ status: "MODEL_ERROR", toolRuns: runs, facts, modelError: modelFailure(error), ...(intents.length > 0 ? { intents } : {}), ...(firstViolations ? { repairs: 1, firstViolations } : {}) });
    }
    // Métodos de pago: por ahora no se dice nada. Si el redactor los menciona, esas frases se IGNORAN (no se rechaza el mensaje): queda lo demás.
    const text = stripPaymentTalk(response.text, { split: "sentence" });
    // Primero los actos; el texto solo se verifica si los actos son válidos (el texto depende de qué actos pidió).
    let problems = validateActs(response.acts, input.utterances, facts, { capabilities, hasQuoteBlock, read });
    if (problems.length === 0) problems = verifyReply({ text, acts: response.acts, facts, patientText });
    const repairInfo = { ...(intents.length > 0 ? { intents } : {}), ...(firstViolations ? { repairs: 1, firstViolations } : {}) };
    if (problems.length === 0) {
      // Pasar con una persona: el texto solo puede decirlo si el caso QUEDÓ registrado. Se ejecuta DESPUÉS de verificar y ANTES de entregar el mensaje; si no se registra, no hay mensaje.
      const handoff = response.acts.find((act) => act.kind === "HANDOFF");
      if (handoff && handoff.kind === "HANDOFF") {
        const registered = deps.handoff && !deps.cancelled?.() ? await deps.handoff(handoff.reason).catch(() => false) : false;
        if (!registered) return done({ status: "HANDOFF_FAILED", acts: response.acts, toolRuns: runs, facts, ...repairInfo });
      }
      // La cotización (precios del catálogo) la agrega el SISTEMA tal cual la armó el motor, solo si un acto la pidió.
      const reply = [text.trim(), ...(response.acts.some((act) => act.kind === "QUOTE") ? blocks : [])].join("\n\n");
      return done({ status: "VERIFIED", acts: response.acts, toolRuns: runs, facts, reply, ...(handoff ? { handoffRegistered: true } : {}), ...repairInfo });
    }
    if (attempt === MAX_ATTEMPTS) return done({ status: "REJECTED", acts: response.acts, toolRuns: runs, facts, violations: problems, ...repairInfo });
    feedback = firstViolations = problems;
  }
  return done({ status: "REJECTED", toolRuns: runs, facts });
}

const MAX_ATTEMPTS = 2;
