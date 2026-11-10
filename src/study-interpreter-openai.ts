import OpenAI from "openai";
import { usageFromResponses } from "./cache.js";
import { assertModelCallsAllowed } from "./offline.js";
import type { StudyInterpreter } from "./quote-session.js";
import { createStudyInterpreter, INTERPRETER_LIMITS, type InterpreterClient } from "./study-interpreter.js";

// Adaptador de OpenAI (API Responses con llamadas a herramientas) del intérprete de estudios, y lectura de su configuración. APAGADO por defecto: no se crea ningún cliente ni se hace ninguna llamada si
// PLUSMEDIK_SMART_QUOTES no es «on» y TODA la configuración está completa.
//
//   PLUSMEDIK_SMART_QUOTES=on              activa el intérprete (exige las sesiones de cotización)
//   OPENAI_API_KEY                              la misma clave del resto del agente
//   OPENAI_QUOTE_MODEL                          modelo; OBLIGATORIO (sin valor por defecto: elegirlo es una decisión del dueño). Debe admitir llamadas a herramientas y salida JSON estricta
//   OPENAI_QUOTE_REASONING                      opcional: low | medium | high | xhigh | max (solo para modelos que lo admiten)
//   PLUSMEDIK_SMART_QUOTES_TIMEOUT_MS      opcional, 2000–60000 (por defecto 15000): tiempo total de la interpretación de un mensaje
// Cualquier valor inválido o faltante deja el intérprete APAGADO y se registra solo un código (nunca el valor).

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function createOpenAiInterpreterClient(options: { apiKey: string; model: string; reasoningEffort?: Effort }): InterpreterClient {
  let client: OpenAI | undefined;
  return {
    async run({ instructions, message, tools, schemaName, schema, maxOutputTokens, timeoutMs, maxRounds, runTool }) {
      // Modo offline: ninguna llamada a modelos sale (también aquí).
      assertModelCallsAllowed("quote_interpreter", "openai", options.model);
      client ??= new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: timeoutMs });
      const deadline = Date.now() + timeoutMs;
      const functionTools = tools.map((tool) => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: true }));
      // Sin estado en el proveedor (store: false): en cada ronda se reenvía lo anterior, incluidas las llamadas a herramientas y sus resultados.
      let input: Array<Record<string, unknown>> = [{ role: "user", content: message }];
      let toolCalls = 0;
      const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
      for (let round = 1; round <= maxRounds; round++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("interpreter timeout");
        const response = await client.responses.create(
          {
            model: options.model,
            instructions,
            input: input as never,
            tools: functionTools,
            max_output_tokens: maxOutputTokens,
            store: false,
            ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
            text: { format: { type: "json_schema" as const, name: schemaName, strict: true, schema } }
          },
          { timeout: remaining, maxRetries: 0 }
        );
        const used = usageFromResponses(response.usage);
        usage.inputTokens += used?.inputTokens ?? 0;
        usage.outputTokens += used?.outputTokens ?? 0;
        usage.reasoningTokens += used?.reasoningTokens ?? 0;

        const calls = response.output.filter((item) => item.type === "function_call");
        if (calls.length === 0) {
          const text = response.output_text;
          if (typeof text !== "string" || text.trim() === "") throw new Error("empty model output");
          return { text, rounds: round, toolCalls, usage };
        }
        if (round === maxRounds) throw new Error("too many interpreter rounds");
        input = [...input, ...(response.output as unknown as Array<Record<string, unknown>>)];
        for (const call of calls) {
          toolCalls++;
          let args: unknown;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            args = undefined;
          }
          input.push({ type: "function_call_output", call_id: call.call_id, output: runTool(call.name, args) });
        }
      }
      throw new Error("too many interpreter rounds");
    }
  };
}

export type InterpreterConfigError = "TEXT_QUOTES_REQUIRED" | "MISSING_API_KEY" | "MISSING_MODEL" | "INVALID_MODEL" | "INVALID_REASONING" | "INVALID_TIMEOUT";

// Devuelve el intérprete SOLO si la bandera está en «on» y TODA la configuración es válida; si no, undefined (y un código en el registro si estaba habilitada).
export function resolveStudyInterpreter(
  env: Record<string, string | undefined>,
  log: (event: string, data: Record<string, unknown>) => void,
  options: { textQuotesActive: boolean; client?: InterpreterClient; now?: () => number }
): StudyInterpreter | undefined {
  if (env.PLUSMEDIK_SMART_QUOTES?.trim().toLowerCase() !== "on") return undefined;
  const fail = (error: InterpreterConfigError): undefined => {
    log("quote_interpreter_config_invalid", { error });
    return undefined;
  };
  // Sin las sesiones de cotización no hay dónde anotar lo que el intérprete entienda.
  if (!options.textQuotesActive) return fail("TEXT_QUOTES_REQUIRED");
  const model = env.OPENAI_QUOTE_MODEL?.trim();
  if (!model) return fail("MISSING_MODEL");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model)) return fail("INVALID_MODEL");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!options.client && !apiKey) return fail("MISSING_API_KEY");
  const effortRaw = env.OPENAI_QUOTE_REASONING?.trim().toLowerCase();
  if (effortRaw && !(EFFORTS as readonly string[]).includes(effortRaw)) return fail("INVALID_REASONING");
  let timeoutMs: number | undefined;
  const timeoutRaw = env.PLUSMEDIK_SMART_QUOTES_TIMEOUT_MS?.trim();
  if (timeoutRaw) {
    if (!/^\d{4,5}$/.test(timeoutRaw) || Number(timeoutRaw) < 2000 || Number(timeoutRaw) > 60_000) return fail("INVALID_TIMEOUT");
    timeoutMs = Number(timeoutRaw);
  }
  return createStudyInterpreter({
    client: options.client ?? createOpenAiInterpreterClient({ apiKey: apiKey!, model, ...(effortRaw ? { reasoningEffort: effortRaw as Effort } : {}) }),
    model,
    timeoutMs: timeoutMs ?? INTERPRETER_LIMITS.timeoutMs,
    ...(options.now ? { now: options.now } : {}),
    log
  });
}
