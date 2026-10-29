import { createHash } from "node:crypto";
import OpenAI from "openai";
import { usageFromResponses } from "./cache.js";
import { availableSections, validateBusinessData, type DataSection } from "./conversation-facts.js";
import { CONVERSATION_CATEGORIES, createConversationModel, DEFAULT_CATEGORIES, type ConversationCategory, type ConversationClient, type ConversationModel } from "./conversation-model.js";
import { assertModelCallsAllowed } from "./offline.js";
import { BUSINESS_DATA, SYSTEM_PROMPT } from "./system-prompt.js";

// Adaptador de OpenAI (API Responses) y lectura de la configuración de la capa conversacional (G5.3). APAGADA por defecto: no se crea ningún cliente ni se hace ninguna llamada si
// PLUSMEDIK_LLM_CONVERSATION no es «on» y TODA la configuración está completa. Ver src/conversation-model.ts para lo que el modelo puede y no puede hacer.
//
//   PLUSMEDIK_LLM_CONVERSATION=on          activa la capa (exige además PLUSMEDIK_TURNS, PLUSMEDIK_TEXT_HANDLER y la guarda de respuestas de G3.2 encendida y válida)
//   OPENAI_API_KEY                         clave de OpenAI (la misma que ya usa el motor de recetas)
//   OPENAI_CONVERSATION_MODEL              modelo; OBLIGATORIO (no hay valor por defecto: elegirlo es una decisión del dueño)
//   OPENAI_CONVERSATION_REASONING          opcional: low | medium | high | xhigh | max (solo para modelos que lo admiten)
//   PLUSMEDIK_LLM_BUSINESS_INFO=on         opcional (G5.6): además de conversar, el modelo recibe los datos comerciales CONFIRMADOS y vigentes de src/system-prompt.ts (sucursales,
//                                          horarios, teléfonos, servicios, pagos, políticas) y puede informarlos. Sin ningún dato confirmado y vigente se queda apagada (y se registra un código)
//   PLUSMEDIK_LLM_CATEGORIES               opcional: GREETING,OTHER (por defecto) y/o RECIPE_OR_QUOTE — qué mensajes pueden pasar por el modelo
//   PLUSMEDIK_LLM_TIMEOUT_MS               opcional, 1000–30000 (por defecto 8000)
//   PLUSMEDIK_LLM_MAX_OUTPUT_TOKENS        opcional, 50–2000 (por defecto 300; 500 con los datos comerciales)
//   PLUSMEDIK_LLM_MAX_INPUT_CHARS          opcional, 50–2000 (por defecto 500): lo que se envía del mensaje del paciente
// Cualquier valor inválido o faltante deja la capa APAGADA y se registra solo un código (nunca el valor).
// Las instrucciones y los datos comerciales NO vienen del entorno ni de un archivo: están en src/system-prompt.ts (SYSTEM_PROMPT y BUSINESS_DATA), que se importa como cualquier módulo.

// Lo que se le entrega al modelo conversacional: la plantilla del prompt, las secciones de datos ya validadas y la huella de ambas (identifica la versión desplegada).
export interface PromptSource {
  prompt: string;
  sections: readonly DataSection[];
  sha256: string;
  // Defectos de las secciones de datos CONFIRMADAS (esas secciones no se envían).
  problems?: readonly string[];
  origin?: string;
}

const MARKER = "{{DATOS}}";

// El prompt de src/system-prompt.ts con sus datos validados. Se calcula al activar la capa (una vez por arranque).
export function buildPromptSource(prompt: string = SYSTEM_PROMPT, data = BUSINESS_DATA): PromptSource {
  const report = validateBusinessData(data);
  return { prompt, sections: report.sections, problems: report.problems, sha256: createHash("sha256").update(`${prompt}\n${JSON.stringify(report.sections)}`).digest("hex"), origin: "code" };
}

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface OpenAiConversationClientOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: Effort;
}

export function createOpenAiConversationClient(options: OpenAiConversationClientOptions): ConversationClient {
  let client: OpenAI | undefined;
  return {
    async complete({ instructions, message, schemaName, schema, maxOutputTokens, timeoutMs }) {
      // Modo offline: ninguna llamada a modelos sale (también aquí, que no pasa por cachedAiCall: esa ruta guarda en disco y está pensada para imágenes).
      assertModelCallsAllowed("conversation", "openai", options.model);
      client ??= new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: timeoutMs });
      const response = await client.responses.create(
        {
          model: options.model,
          instructions,
          input: message,
          max_output_tokens: maxOutputTokens,
          // El texto del paciente no se conserva en el proveedor para reutilizarlo.
          store: false,
          ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
          text: { format: { type: "json_schema" as const, name: schemaName, strict: true, schema } }
        },
        { timeout: timeoutMs, maxRetries: 0 }
      );
      const text = response.output_text;
      if (typeof text !== "string" || text.trim() === "") throw new Error("empty model output");
      return { text, usage: usageFromResponses(response.usage) };
    }
  };
}

export type ConversationConfigError =
  | "RESPONSE_GUARD_REQUIRED"
  | "MISSING_API_KEY"
  | "MISSING_MODEL"
  | "INVALID_MODEL"
  | "INVALID_REASONING"
  | "INVALID_CATEGORIES"
  | "INVALID_TIMEOUT"
  | "INVALID_MAX_OUTPUT"
  | "INVALID_MAX_INPUT"
  // El SYSTEM_PROMPT no tiene exactamente UN marcador {{DATOS}}: la conversación con modelo queda apagada.
  | "PROMPT_INVALID"
  // Solo se registran (no apagan la conversación): secciones de datos con defectos (esas secciones no se envían) o PLUSMEDIK_LLM_BUSINESS_INFO=on sin ninguna sección confirmada y vigente.
  | "PROMPT_DATA_INVALID"
  | "BUSINESS_DATA_PENDING";

function integerIn(value: string | undefined, min: number, max: number): number | undefined | "INVALID" {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d{1,6}$/.test(value.trim())) return "INVALID";
  const parsed = Number(value.trim());
  return parsed >= min && parsed <= max ? parsed : "INVALID";
}

// Devuelve el modelo conversacional solo si la capa está habilitada Y la configuración está completa; si no, undefined (y un código en el registro si estaba habilitada).
export function resolveConversationModel(
  env: Record<string, string | undefined>,
  log: (event: string, data: Record<string, unknown>) => void,
  options: { responseGuardActive: boolean; client?: ConversationClient; source?: PromptSource; now?: () => number }
): ConversationModel | undefined {
  if (env.PLUSMEDIK_LLM_CONVERSATION?.trim().toLowerCase() !== "on") return undefined;
  const fail = (error: ConversationConfigError): undefined => {
    log("llm_conversation_config_invalid", { error });
    return undefined;
  };
  // Sin la guarda de respuestas (G3.2) un bucle con otro bot costaría dinero y no se detendría: la capa exige que esté encendida.
  if (!options.responseGuardActive) return fail("RESPONSE_GUARD_REQUIRED");
  const model = env.OPENAI_CONVERSATION_MODEL?.trim();
  if (!model) return fail("MISSING_MODEL");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) return fail("INVALID_MODEL");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!options.client && !apiKey) return fail("MISSING_API_KEY");

  const effortRaw = env.OPENAI_CONVERSATION_REASONING?.trim().toLowerCase();
  if (effortRaw && !(EFFORTS as readonly string[]).includes(effortRaw)) return fail("INVALID_REASONING");
  const timeoutMs = integerIn(env.PLUSMEDIK_LLM_TIMEOUT_MS, 1000, 30_000);
  if (timeoutMs === "INVALID") return fail("INVALID_TIMEOUT");
  const maxOutputTokens = integerIn(env.PLUSMEDIK_LLM_MAX_OUTPUT_TOKENS, 50, 2000);
  if (maxOutputTokens === "INVALID") return fail("INVALID_MAX_OUTPUT");
  const maxInputChars = integerIn(env.PLUSMEDIK_LLM_MAX_INPUT_CHARS, 50, 2000);
  if (maxInputChars === "INVALID") return fail("INVALID_MAX_INPUT");

  let categories: readonly ConversationCategory[] = DEFAULT_CATEGORIES;
  const categoriesRaw = env.PLUSMEDIK_LLM_CATEGORIES?.trim();
  if (categoriesRaw) {
    const parts = categoriesRaw.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean);
    if (parts.length === 0 || !parts.every((part): part is ConversationCategory => (CONVERSATION_CATEGORIES as readonly string[]).includes(part))) return fail("INVALID_CATEGORIES");
    categories = [...new Set(parts)];
  }

  // Instrucciones y datos: SYSTEM_PROMPT y BUSINESS_DATA de src/system-prompt.ts (importados; sin archivos ni generación).
  const source = options.source ?? buildPromptSource();
  if (source.prompt.split(MARKER).length !== 2) return fail("PROMPT_INVALID");
  if (source.problems && source.problems.length > 0) log("llm_conversation_config_invalid", { error: "PROMPT_DATA_INVALID" satisfies ConversationConfigError });
  const sections = source.sections;
  // Qué versión del prompt quedó cargada (huella y recuentos; nunca el contenido).
  log("llm_conversation_source", { origin: source.origin ?? "injected", prompt: source.sha256.slice(0, 12), confirmed: sections.filter((section) => section.status === "CONFIRMED" && section.text !== "").length, pending: sections.filter((section) => section.status !== "CONFIRMED" || section.text === "").length });

  // Datos comerciales (G5.6): bandera aparte. Si no hay ningún dato confirmado y vigente, la conversación sigue pero SIN datos (y queda el código en el registro).
  let businessInfo = env.PLUSMEDIK_LLM_BUSINESS_INFO?.trim().toLowerCase() === "on";
  if (businessInfo && availableSections(sections, new Date((options.now ?? Date.now)())).usable.length === 0) {
    log("llm_conversation_config_invalid", { error: "BUSINESS_DATA_PENDING" satisfies ConversationConfigError });
    businessInfo = false;
  }

  return createConversationModel({
    client: options.client ?? createOpenAiConversationClient({ apiKey: apiKey!, model, ...(effortRaw ? { reasoningEffort: effortRaw as Effort } : {}) }),
    prompt: source.prompt,
    promptId: `${source.sha256.slice(0, 12)}${businessInfo ? "+datos" : ""}`,
    model,
    categories,
    sections,
    businessInfo,
    ...(options.now ? { now: options.now } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxInputChars !== undefined ? { maxInputChars } : {}),
    log
  });
}
