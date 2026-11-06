import type { AgentDecision, AgentModel, ModelUsage } from "../../../src/agent/contracts.js";
import { DEFAULT_REASONING, resolveAgentSettings } from "../../../src/agent/openai.js";
import { runAgentTurn } from "../../../src/agent/pipeline.js";
import { prepareAgentTurn } from "../../../src/agent/shadow.js";
import { createConversationReader, type ConversationStore } from "../../../src/conversation-state-store.js";
import { encodeEvent } from "../../../src/conversation-state.js";
import { AGENT_SCENARIOS, CONTACT_KEY, FIXTURE_CATALOG, fixtureAnswer, NOW, PHONE, type AgentScenario, type Expectation, type ScriptedReply } from "./agent-scenarios.js";

// G7 · Evaluación del núcleo conversacional con escenarios sintéticos. Ejecuta CADA escenario por el MISMO camino que producción (prepareAgentTurn → peticiones, pendientes de la memoria, herramientas reales
// contra el catálogo y el conocimiento FICTICIOS, tubería y verificador), solo que el modelo es el que se le entregue: uno real (arnés en vivo) o uno guionado (pruebas). Nunca recibe datos de pacientes.

export interface ScenarioRun {
  id: string;
  title: string;
  decision: AgentDecision | undefined;
  skipped?: string;
  latencyMs: number;
  failures: string[];
}

const memoryStore = (scenario: AgentScenario): ConversationStore => {
  const rows = (scenario.events ?? []).map((event) => { const row = encodeEvent(event); return { key: row.event_key, kind: row.kind, payload: row.payload, at: row.occurred_at }; });
  return { append: async () => ({ recorded: 0, duplicate: 0 }), read: async () => rows, contactsSince: async () => [] };
};

export async function runScenario(model: AgentModel, scenario: AgentScenario, _options: { modelName?: string } = {}): Promise<{ decision: AgentDecision | undefined; skipped?: string; latencyMs: number }> {
  const started = Date.now();
  // El MISMO camino que producción: peticiones, pendientes de la memoria, herramientas reales (catálogo y conocimiento FICTICIOS), tubería y verificador.
  const prepared = await prepareAgentTurn(
    {
      loadCatalog: async () => FIXTURE_CATALOG,
      answer: fixtureAnswer,
      reader: createConversationReader({ store: memoryStore(scenario), now: () => NOW }),
      contactKeyFor: (phone) => (phone === PHONE ? CONTACT_KEY : undefined),
      // Mismas capacidades que producción sin la cola al CRM: la derivación humana no está disponible.
      capabilities: { handoff: false, quote: true },
      now: () => NOW
    },
    PHONE,
    scenario.turns.map((text, index) => ({ messageId: `wamid.eval-${scenario.id}-${index + 1}`, kind: "TEXT" as const, text }))
  );
  if (prepared.kind === "skip") return { decision: undefined, skipped: prepared.reason, latencyMs: Date.now() - started };
  const decision = await runAgentTurn({ model, tools: prepared.tools }, { utterances: prepared.utterances, recent: prepared.recent, capabilities: { handoff: false, quote: true }, now: new Date(NOW) });
  return { decision, latencyMs: Date.now() - started };
}

// Falta (texto) de cada expectativa que no se cumple; vacío = cumple.
export function evaluate(decision: AgentDecision | undefined, expectation: Expectation, skipped?: string): string[] {
  const failures: string[] = [];
  if (!decision) return [`no hubo decisión${skipped ? ` (${skipped})` : ""}`];
  const wantVerified = expectation.verified ?? true;
  if (wantVerified && decision.status !== "VERIFIED") failures.push(`estado ${decision.status}${decision.violations.length > 0 ? ` (${decision.violations.map((v) => v.code).join(",")})` : ""}${decision.modelError ? ` causa ${decision.modelError.cause}` : ""}`);
  if (!wantVerified && decision.status === "VERIFIED") failures.push("debía rechazarse y pasó");
  if (decision.status !== "VERIFIED") return failures;
  const kinds = new Set((decision.acts ?? []).map((act) => act.kind));
  for (const kind of expectation.acts ?? []) if (!kinds.has(kind)) failures.push(`falta el acto ${kind}`);
  for (const kind of expectation.noActs ?? []) if (kinds.has(kind)) failures.push(`sobra el acto ${kind}`);
  const reply = decision.reply ?? "";
  const hasBlock = (decision.acts ?? []).some((act) => act.kind === "QUOTE");
  if (expectation.quoteBlock === true && !hasBlock) failures.push("falta la cotización del sistema");
  if (expectation.quoteBlock === false && hasBlock) failures.push("no debía cotizar");
  const tools = new Set(decision.toolRuns.filter((run) => run.ok).map((run) => run.tool));
  for (const tool of expectation.tools ?? []) if (!tools.has(tool)) failures.push(`no consultó ${tool}`);
  for (const pattern of expectation.replyMatch ?? []) if (!pattern.test(reply)) failures.push(`el mensaje no cumple ${pattern}`);
  for (const pattern of expectation.replyNoMatch ?? []) if (pattern.test(reply)) failures.push(`el mensaje no debía cumplir ${pattern}`);
  return failures;
}

export async function runAll(model: AgentModel, options: { scenarios?: readonly AgentScenario[]; modelName?: string; onProgress?: (run: ScenarioRun) => void } = {}): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];
  for (const scenario of options.scenarios ?? AGENT_SCENARIOS) {
    const result = await runScenario(model, scenario, options.modelName ? { modelName: options.modelName } : {});
    const run: ScenarioRun = { id: scenario.id, title: scenario.title, decision: result.decision, ...(result.skipped ? { skipped: result.skipped } : {}), latencyMs: result.latencyMs, failures: evaluate(result.decision, scenario.expect, result.skipped) };
    runs.push(run);
    options.onProgress?.(run);
  }
  return runs;
}

// Un modelo GUIONADO: devuelve, escenario por escenario, la respuesta que se le indique. Sirve para probar el verificador y el propio arnés sin red.
export function scriptedModel(reply: ScriptedReply, usage: Partial<ModelUsage> = {}): AgentModel {
  return {
    async plan() { return { toolCalls: reply.calls, usage }; },
    async respond() { return { acts: reply.acts, text: reply.text, usage }; }
  };
}

// ───────────────────────────── resumen ─────────────────────────────

export interface EvalSummary {
  scenarios: number;
  passed: number;
  verified: number;
  // De los verificados, cuántos pasaron a la PRIMERA y cuántos necesitaron el segundo intento (reparación).
  firstPass: number;
  repaired: number;
  rejected: number;
  modelErrors: number;
  skipped: number;
  // Escenarios que el VERIFICADOR rechazó: candidatos a «bloqueó una respuesta correcta» (hay que leer el texto propuesto).
  rejectedList: Array<{ id: string; violations: string[] }>;
  failedList: Array<{ id: string; failures: string[] }>;
  latencyMs: { p50: number; p95: number; max: number };
  usage: ModelUsage;
  costUsd?: number;
}

const percentile = (sorted: number[], p: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);

// `price`: USD por millón de tokens (de entrada y de salida); sin él no se calcula el costo (los precios los fija quien evalúa, no este código).
export function summarize(runs: readonly ScenarioRun[], price?: { inputPerMTok: number; outputPerMTok: number }): EvalSummary {
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, calls: 0 };
  for (const run of runs) {
    const used = run.decision?.usage;
    if (!used) continue;
    usage.inputTokens += used.inputTokens;
    usage.outputTokens += used.outputTokens;
    usage.reasoningTokens += used.reasoningTokens;
    usage.calls += used.calls;
  }
  const latencies = runs.map((run) => run.latencyMs).sort((a, b) => a - b);
  return {
    scenarios: runs.length,
    passed: runs.filter((run) => run.failures.length === 0).length,
    verified: runs.filter((run) => run.decision?.status === "VERIFIED").length,
    firstPass: runs.filter((run) => run.decision?.status === "VERIFIED" && !run.decision.repairs).length,
    repaired: runs.filter((run) => run.decision?.status === "VERIFIED" && run.decision.repairs).length,
    rejected: runs.filter((run) => run.decision?.status === "REJECTED").length,
    modelErrors: runs.filter((run) => run.decision?.status === "MODEL_ERROR").length,
    skipped: runs.filter((run) => run.skipped).length,
    rejectedList: runs.filter((run) => run.decision?.status === "REJECTED").map((run) => ({ id: run.id, violations: run.decision!.violations.map((v) => v.code) })),
    failedList: runs.filter((run) => run.failures.length > 0).map((run) => ({ id: run.id, failures: run.failures })),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.at(-1) ?? 0 },
    usage,
    ...(price ? { costUsd: Number(((usage.inputTokens * price.inputPerMTok + (usage.outputTokens + 0) * price.outputPerMTok) / 1_000_000).toFixed(4)) } : {})
  };
}

// ───────────────────────────── puerta de aprobación antes de encender ─────────────────────────────

export interface GateResult { pass: boolean; reasons: string[] }

// Criterios para dar por BUENO a un modelo real con los escenarios sintéticos (ver docs/g7/15): sin errores del proveedor, al menos el 90 % de escenarios cumplidos, al menos el 75 % verificados a la
// primera (sin reparar) y una latencia p95 razonable. Un rechazo del verificador no es un fallo de seguridad (el paciente recibiría lo de siempre) pero un modelo que se equivoca seguido no vale la pena.
export function gate(summary: EvalSummary): GateResult {
  const reasons: string[] = [];
  if (summary.scenarios === 0) reasons.push("no se evaluó ningún escenario");
  if (summary.modelErrors > 0) reasons.push(`${summary.modelErrors} escenario(s) con error del proveedor o salida inválida`);
  if (summary.scenarios > 0 && summary.passed / summary.scenarios < 0.9) reasons.push(`solo ${summary.passed}/${summary.scenarios} escenarios cumplen (mínimo 90 %)`);
  if (summary.scenarios > 0 && summary.firstPass / summary.scenarios < 0.75) reasons.push(`solo ${summary.firstPass}/${summary.scenarios} verificados a la primera (mínimo 75 %)`);
  if (summary.latencyMs.p95 > 25_000) reasons.push(`latencia p95 de ${summary.latencyMs.p95} ms (máximo 25000)`);
  return { pass: reasons.length === 0, reasons };
}

// ───────────────────────────── verificación previa de la configuración (sin llamar a nadie) ─────────────────────────────

export interface PreflightLine { level: "OK" | "WARN" | "BLOCK"; item: string; detail: string }

// Revisa la configuración SIN llamar a OpenAI ni mostrar ningún valor secreto. Hay UN solo agente conversacional: PLUSMEDIK_LLM_CONVERSATION=on, OPENAI_CONVERSATION_MODEL y OPENAI_API_KEY.
export function preflight(env: Record<string, string | undefined>): PreflightLine[] {
  const lines: PreflightLine[] = [];
  const codes: string[] = [];
  const settings = resolveAgentSettings({ ...env, OPENAI_API_KEY: env.OPENAI_API_KEY?.trim() || "presente-para-validar" }, (event, data) => { codes.push(`${event}:${String(data.error)}`); });
  const on = (name: string) => env[name]?.trim().toLowerCase() === "on";
  lines.push(on("PLUSMEDIK_LLM_CONVERSATION") ? { level: "OK", item: "PLUSMEDIK_LLM_CONVERSATION", detail: "on (agente conversacional único para todos los contactos elegibles, con el interruptor de emergencia de la base)" } : { level: "BLOCK", item: "PLUSMEDIK_LLM_CONVERSATION", detail: "debe valer «on»" });
  lines.push(settings ? { level: "OK", item: "configuración del modelo", detail: `modelo ${env.OPENAI_CONVERSATION_MODEL?.trim()}, razonamiento ${env.OPENAI_CONVERSATION_REASONING?.trim() || DEFAULT_REASONING}` } : { level: "BLOCK", item: "configuración del modelo", detail: codes.join(", ") || "incompleta (OPENAI_CONVERSATION_MODEL es obligatoria)" });
  lines.push(env.OPENAI_API_KEY?.trim() ? { level: "OK", item: "OPENAI_API_KEY", detail: "definida" } : { level: "BLOCK", item: "OPENAI_API_KEY", detail: "falta" });
  lines.push(on("PLUSMEDIK_TURNS") ? { level: "OK", item: "PLUSMEDIK_TURNS", detail: "on (los turnos envían la respuesta por la misma ruta de siempre: lease, reserva, pausa humana, un envío por lote)" } : { level: "BLOCK", item: "PLUSMEDIK_TURNS", detail: "debe valer «on»: sin turnos no hay lotes ni respuestas que enviar" });
  lines.push(on("PLUSMEDIK_TEXT_HANDLER") ? { level: "OK", item: "PLUSMEDIK_TEXT_HANDLER", detail: "on (es el modo esencial cuando el interruptor está apagado o el modelo no responde)" } : { level: "BLOCK", item: "PLUSMEDIK_TEXT_HANDLER", detail: "debe valer «on»: es el modo esencial de respaldo" });
  const cap = env.PLUSMEDIK_DAILY_REPLY_CAP?.trim().toLowerCase();
  lines.push(cap === "off" ? { level: "WARN", item: "tope diario", detail: "PLUSMEDIK_DAILY_REPLY_CAP=off: sin tope de respuestas por contacto" } : { level: "OK", item: "tope diario", detail: `${env.PLUSMEDIK_DAILY_REPLY_CAP_MAX?.trim() || "6"} respuestas por contacto cada ${env.PLUSMEDIK_DAILY_REPLY_CAP_HOURS?.trim() || "24"} h (encendido por defecto con el agente; exige la migración 18)` });
  lines.push({ level: "WARN", item: "memoria persistente (migración 24)", detail: "parte normal del agente: se enciende con la misma bandera y exige la migración 24 aplicada; si la base no responde, el agente decide con los mensajes recientes del historial (24 h)" });
  const historyOff = env.PLUSMEDIK_HISTORY?.trim().toLowerCase() === "off";
  if (historyOff) lines.push({ level: "WARN", item: "PLUSMEDIK_HISTORY", detail: "con el historial apagado el agente no ve los mensajes recientes (solo la memoria persistente)" });
  lines.push(on("PLUSMEDIK_KNOWLEDGE_ANSWERS") ? { level: "OK", item: "PLUSMEDIK_KNOWLEDGE_ANSWERS", detail: "on (herramienta lab_info con conocimiento aprobado)" } : { level: "WARN", item: "PLUSMEDIK_KNOWLEDGE_ANSWERS", detail: "sin esto no existe la herramienta lab_info: toda pregunta del laboratorio se aplaza" });
  lines.push({ level: "WARN", item: "interruptor de emergencia (migración 25)", detail: "la migración 25 debe estar aplicada; el interruptor NACE APAGADO: nadie recibe al agente hasta ejecutar select public.plusmedik_agent_pilot_set(true, 'motivo'); y se apaga YA con (false, 'motivo')" });
  lines.push(on("PLUSMEDIK_CRM_HANDOFF")
    ? { level: "WARN", item: "derivación humana del agente", detail: "disponible SOLO si la cola al CRM está completamente configurada (PLUSMEDIK_CRM_REVIEW_URL/TOKEN, PLUSMEDIK_OUTBOX_KEY) y validada; el agente solo promete una persona cuando el CRM registró el caso" }
    : { level: "OK", item: "derivación humana del agente", detail: "NO disponible (PLUSMEDIK_CRM_HANDOFF sin «on»): el agente aplaza con honestidad y lo pendiente queda visible" });
  return lines;
}
