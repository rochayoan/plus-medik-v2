import type { AgentDecision, AgentModel, ModelUsage } from "../../../src/agent/contracts.js";
import { resolveAgentSettings } from "../../../src/agent/openai.js";
import { resolveAgentPilotSettings } from "../../../src/agent/pilot.js";
import { createAgentShadow, type AgentShadowRecord } from "../../../src/agent/shadow.js";
import { createConversationReader, type ConversationStore } from "../../../src/conversation-state-store.js";
import { encodeEvent } from "../../../src/conversation-state.js";
import { AGENT_SCENARIOS, CONTACT_KEY, FIXTURE_CATALOG, fixtureAnswer, NOW, PHONE, type AgentScenario, type Expectation, type ScriptedReply } from "./agent-scenarios.js";

// G7 · Evaluación del núcleo conversacional con escenarios sintéticos. Ejecuta CADA escenario por el MISMO camino que producción (createAgentShadow → utterancesOf, pendientes de la memoria, herramientas reales
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

export async function runScenario(model: AgentModel, scenario: AgentScenario, options: { modelName?: string } = {}): Promise<{ decision: AgentDecision | undefined; skipped?: string; latencyMs: number }> {
  const records: AgentShadowRecord[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const shadow = createAgentShadow({
    model,
    modelName: options.modelName ?? "evaluacion",
    loadCatalog: async () => FIXTURE_CATALOG,
    answer: fixtureAnswer,
    reader: createConversationReader({ store: memoryStore(scenario), now: () => NOW }),
    contactKeyFor: (phone) => (phone === PHONE ? CONTACT_KEY : undefined),
    // Mismas capacidades que producción: la derivación humana está DESACTIVADA hasta validar el CRM.
    capabilities: { handoff: false, quote: true },
    log: (event, data) => { if (event === "agent_shadow") logs.push(data); },
    record: (record) => { records.push(record); },
    now: () => NOW,
    runTimeoutMs: 120_000,
    flushMs: 125_000
  });
  const started = Date.now();
  shadow.observe({ from: PHONE, turns: scenario.turns.map((text, index) => ({ messageId: `wamid.eval-${scenario.id}-${index + 1}`, kind: "TEXT" as const, text })) });
  await shadow.flush();
  const latencyMs = Date.now() - started;
  const skipped = logs.find((entry) => entry.status === "SKIPPED");
  return { decision: records[0]?.decision, ...(skipped ? { skipped: String(skipped.reason) } : {}), latencyMs };
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

// Revisa la configuración de la vista previa SIN llamar a OpenAI ni mostrar ningún valor secreto.
export function preflight(env: Record<string, string | undefined>): PreflightLine[] {
  const lines: PreflightLine[] = [];
  const codes: string[] = [];
  const settings = resolveAgentSettings({ ...env, OPENAI_API_KEY: env.OPENAI_API_KEY?.trim() || "presente-para-validar" }, (event, data) => { codes.push(`${event}:${String(data.error)}`); });
  const on = (name: string) => env[name]?.trim().toLowerCase() === "on";
  const mode = env.PLUSMEDIK_AGENT?.trim().toLowerCase();
  const live = mode === "live";
  // «scoped»: el agente nuevo RESPONDE (piloto o global); exige turnos y el interruptor de la base (la memoria es opcional).
  const pilot = mode === "pilot" || live;
  lines.push(mode === "shadow" || pilot ? { level: "OK", item: "PLUSMEDIK_AGENT", detail: live ? "live (responde a TODOS los contactos elegibles, con el interruptor de la base encendido y el agente de siempre como respaldo)" : pilot ? "pilot (responde SOLO a la lista del piloto y con el interruptor de la base encendido)" : "shadow" } : { level: "BLOCK", item: "PLUSMEDIK_AGENT", detail: "debe valer «shadow» o «pilot»" });
  lines.push(settings ? { level: "OK", item: "configuración del modelo", detail: `modelo ${env.OPENAI_AGENT_MODEL?.trim()}${pilot ? "" : `, muestreo ${settings.sample} %`}` } : { level: "BLOCK", item: "configuración del modelo", detail: codes.join(", ") || "incompleta" });
  lines.push(env.OPENAI_API_KEY?.trim() ? { level: "OK", item: "OPENAI_API_KEY", detail: "definida" } : { level: "BLOCK", item: "OPENAI_API_KEY", detail: "falta" });
  lines.push(on("PLUSMEDIK_TURNS") ? { level: "OK", item: "PLUSMEDIK_TURNS", detail: pilot ? "on (los turnos envían la respuesta del piloto por la misma ruta de siempre)" : "on (el agente en sombra observa los turnos reclamados)" } : { level: "BLOCK", item: "PLUSMEDIK_TURNS", detail: "debe valer «on»: sin turnos no hay lotes que observar ni respuestas que enviar" });
  const memory = env.PLUSMEDIK_CONV_STATE?.trim().toLowerCase() === "shadow";
  lines.push(memory ? { level: "OK", item: "PLUSMEDIK_CONV_STATE", detail: "shadow (memoria de pendientes y última cotización; exige la migración 24 aplicada)" } : { level: pilot && env.PLUSMEDIK_HISTORY?.trim().toLowerCase() === "off" ? "BLOCK" : "WARN", item: "PLUSMEDIK_CONV_STATE", detail: "sin la memoria estructurada el agente decide con los mensajes recientes del historial (últimas 24 h): no recuerda pendientes ni la última cotización de una receta en foto" });
  lines.push(on("PLUSMEDIK_KNOWLEDGE_ANSWERS") ? { level: "OK", item: "PLUSMEDIK_KNOWLEDGE_ANSWERS", detail: "on (herramienta lab_info con conocimiento aprobado)" } : { level: "WARN", item: "PLUSMEDIK_KNOWLEDGE_ANSWERS", detail: "sin esto no existe la herramienta lab_info: toda pregunta del laboratorio se aplaza" });
  if (pilot && env.PLUSMEDIK_HISTORY?.trim().toLowerCase() === "off") lines.push({ level: memory ? "WARN" : "BLOCK", item: "PLUSMEDIK_HISTORY", detail: memory ? "con el historial apagado el agente no ve los mensajes recientes de la conversación (solo la memoria estructurada)" : "sin historial ni memoria estructurada el agente no tiene ningún contexto de la conversación" });
  if (!pilot) {
    const sample = Number(env.PLUSMEDIK_AGENT_SAMPLE?.trim() || 100);
    lines.push(sample <= 25 ? { level: "OK", item: "PLUSMEDIK_AGENT_SAMPLE", detail: `${sample} %` } : { level: "WARN", item: "PLUSMEDIK_AGENT_SAMPLE", detail: "recomendado 25 % o menos al empezar (control de costo)" });
    // La derivación humana del agente está fija en «no disponible» en la sombra (api/kapso/webhook.ts); aquí solo se informa.
    lines.push({ level: "OK", item: "derivación humana del agente", detail: "DESACTIVADA (capacidad fija en false hasta validar el CRM; ninguna bandera la enciende)" });
    return lines;
  }
  // Piloto o global: el alcance (nunca se imprimen los números), el interruptor de la base y la derivación.
  const phoneCodes: string[] = [];
  const phones = resolveAgentPilotSettings(env, (_event, data) => { phoneCodes.push(String(data.error)); }, live ? "live" : "pilot");
  if (live) {
    lines.push(phones?.exclude ? { level: "OK", item: "alcance del agente nuevo", detail: `TODOS los contactos elegibles, sin porcentajes; ${phones.exclude.size} número(s) excluido(s) (no se muestran)` } : { level: "BLOCK", item: "alcance del agente nuevo", detail: phoneCodes.join(", ") || "inválido (PLUSMEDIK_AGENT_EXCLUDE_PHONES: hasta 20 teléfonos de solo dígitos)" });
    lines.push(phones?.dailyMax !== undefined ? { level: "OK", item: "PLUSMEDIK_AGENT_DAILY_MAX", detail: `tope diario propio de ${phones.dailyMax} respuestas por paciente para quien atiende el agente nuevo` } : { level: "WARN", item: "PLUSMEDIK_AGENT_DAILY_MAX", detail: "sin definir: rige el tope global de siempre (5 respuestas por paciente cada 24 h) también para el agente nuevo; con ese tope no puede sostener una conversación larga. Decisión del dueño" });
  } else lines.push(phones ? { level: "OK", item: "PLUSMEDIK_AGENT_PILOT_PHONES", detail: `${phones.phones?.size ?? 0} número(s) permitido(s) (no se muestran); tope diario propio ${phones.dailyMax}` } : { level: "BLOCK", item: "PLUSMEDIK_AGENT_PILOT_PHONES", detail: phoneCodes.join(", ") || "inválida" });
  lines.push({ level: "WARN", item: "interruptor de la base (migración 25)", detail: "la migración 25 debe estar aplicada; el interruptor NACE APAGADO: nadie recibe al agente nuevo hasta ejecutar select public.plusmedik_agent_pilot_set(true, 'motivo'); y se apaga YA con (false, 'motivo')" });
  lines.push(phones?.handoffEnabled
    ? { level: "WARN", item: "derivación humana del agente", detail: "PLUSMEDIK_AGENT_HANDOFF=on solo tiene efecto si la cola al CRM está configurada y validada (hoy no lo está): sin ella el agente no puede derivar y responde el agente de siempre" }
    : { level: "OK", item: "derivación humana del agente", detail: "DESACTIVADA (PLUSMEDIK_AGENT_HANDOFF sin «on»): el agente nuevo aplaza con honestidad y lo pendiente queda visible" });
  return lines;
}
