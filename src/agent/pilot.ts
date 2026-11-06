import { auditErrorFields, createSupabaseRpc } from "../audit.js";
import type { ObservedTurn } from "../conversation-state-store.js";
import type { ReplyQuality } from "../conversation-state.js";
import type { Act, AgentModel, Capabilities, HandoffReason, RecentEntry, Utterance } from "./contracts.js";
import { runAgentTurn } from "./pipeline.js";
import { prepareAgentTurn, summarizeDecision, type AgentContextOptions } from "./shadow.js";

// PILOTO del nuevo agente (G7, Fase 4): el núcleo conversacional RESPONDE de verdad, pero SOLO a los números de una lista permitida y SOLO mientras el interruptor de la base diga «encendido». Para todos los demás
// contactos nada cambia: no hay llamadas al modelo, no hay lecturas nuevas y responde el agente de siempre.
//
// Cómo responde sin crear un camino de envío paralelo: este módulo NO envía. Entrega a los turnos (src/turns.ts) la respuesta ya decidida y verificada, y los turnos la mandan por la MISMA máquina de siempre
// (guarded-turn: claim con lease, reserva de envío, comprobación de pausa humana, un solo envío por lote, idempotencia, guarda de respuestas, tope diario). Si el piloto no puede o no debe responder (interruptor
// apagado o ilegible, modelo caído, verificación fallida, derivación no completada, plazo vencido, lote con fotos), devuelve `undefined` y responde la ruta de siempre COMO SI EL PILOTO NO EXISTIERA.

export const PILOT_LIMITS = { maxPhones: 5, maxExcluded: 20, switchTtlMs: 5000, switchTimeoutMs: 2000, deadlineMs: 40_000, dailyMax: 40, recentLimit: 7, recentWindowMs: 24 * 3600 * 1000, breakerFailures: 3, breakerOpenMs: 60_000 } as const;

// ───────────────────────────── interruptor (desactivación inmediata) ─────────────────────────────

export interface PilotSwitch {
  // true SOLO si la base dice «encendido» (lectura de no más de unos segundos). Falla CERRADO: ante cualquier error, false.
  enabled(): Promise<boolean>;
}

export function createPilotSwitch(options: {
  rpc?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  ttlMs?: number;
  now?: () => number;
  log(event: string, data: Record<string, unknown>): void;
}): PilotSwitch {
  let rpc = options.rpc;
  const call = (name: string, args: Record<string, unknown>) => (rpc ??= createSupabaseRpc({ requestTimeoutMs: PILOT_LIMITS.switchTimeoutMs, retryDelayMs: 100 }))(name, args);
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? PILOT_LIMITS.switchTtlMs;
  let cached: { value: boolean; at: number } | undefined;
  let inflight: Promise<boolean> | undefined;
  let lastLogged: boolean | undefined;
  const read = async (): Promise<boolean> => {
    try {
      const result = await call("plusmedik_agent_pilot_state", {});
      const value = result.enabled === true;
      if (lastLogged !== value) { lastLogged = value; options.log("agent_pilot_switch", { enabled: value }); }
      cached = { value, at: now() };
      return value;
    } catch (error) {
      // Fail-closed: sin saber el estado, el piloto NO responde. Un valor viejo «encendido» no se reutiliza (el interruptor podría estar apagado).
      cached = undefined;
      options.log("agent_pilot_switch", { enabled: false, ...auditErrorFields(error), unreadable: true });
      lastLogged = undefined;
      return false;
    }
  };
  return {
    async enabled() {
      if (cached && now() - cached.at < ttl) return cached.value;
      inflight ??= read().finally(() => { inflight = undefined; });
      return inflight;
    }
  };
}

// ───────────────────────────── mensajes recientes (desde el historial) ─────────────────────────────


// Los últimos mensajes de texto de UN contacto (migración 25: plusmedik_history_recent), listos para el modelo: quién habló, y los que tocan salud sin su contenido (nunca se envía al proveedor). El saneado final
// (enlaces, correos, teléfonos, cifras largas) lo hace el adaptador. Nunca lanza: sin historial, el agente decide con la memoria estructurada.
export function createRecentProvider(options: {
  rpc?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  now?: () => number;
}): NonNullable<AgentContextOptions["recent"]> {
  let rpc = options.rpc;
  const call = (name: string, args: Record<string, unknown>) => (rpc ??= createSupabaseRpc({ requestTimeoutMs: 3000, retryDelayMs: 150 }))(name, args);
  const now = options.now ?? Date.now;
  return async ({ contactKey, excludeIds }) => {
    const result = await call("plusmedik_history_recent", { p_contact_key: contactKey, p_limit: PILOT_LIMITS.recentLimit, p_exclude: [...excludeIds].slice(0, 50), p_since: new Date(now() - PILOT_LIMITS.recentWindowMs).toISOString() });
    const rows = Array.isArray(result.messages) ? result.messages : [];
    const entries: RecentEntry[] = [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const { direction, actor, body } = row as { direction?: unknown; actor?: unknown; body?: unknown };
      if (typeof body !== "string" || body.trim() === "") continue;
      const from: RecentEntry["from"] | undefined = direction === "IN" ? "PATIENT" : actor === "AGENT" ? "ASSISTANT" : actor === "HUMAN" ? "STAFF" : undefined;
      if (!from) continue;
      entries.push({ from, text: body });
    }
    return entries;
  };
}

// ───────────────────────────── el piloto ─────────────────────────────

// Lo que el piloto entrega a los turnos (que lo envían por la ruta de siempre). Misma forma que una respuesta producida, sin importar la ruta de envío.
export interface PilotReply {
  body: string;
  result: "conversation" | "quoted";
  processingStatus: "COMPLETED";
  stale: "NEWER_TURN";
  signature?: string;
  quality: ReplyQuality;
  // Tope diario propio del contacto del piloto (el tope global de 5 respuestas haría imposible probar una conversación).
  cap?: { max: number; windowSeconds: number };
  // ids de estudios de la cotización (para la memoria): nunca precios.
  quotedStudyIds: string[];
  // Ids de mensajes de peticiones pendientes de antes que esta respuesta atendió de verdad (un acto distinto de aplazar las cubre).
  closes: string[];
  // true: no hay nada que enviar (mensaje claramente ajeno al laboratorio); los turnos cierran el lote sin respuesta.
  silent?: true;
}

export interface AgentPilotOptions {
  model: AgentModel;
  modelName: string;
  // PILOTO: teléfonos permitidos (solo dígitos); nada más cambia de ruta. Con `everyone` (modo global) no se usa.
  phones?: ReadonlySet<string>;
  // GLOBAL (PLUSMEDIK_AGENT=live): TODOS los contactos elegibles (los que se pueden identificar), menos los números excluidos, que siguen siempre con el agente de siempre. Sin porcentajes.
  everyone?: { exclude: ReadonlySet<string>; contactKeyFor(phone: string): string | undefined };
  switch: PilotSwitch;
  context: AgentContextOptions;
  // Derivación humana: solo si está habilitada Y el turno trae un ejecutor registrado (cola al CRM). Hoy en producción no hay CRM, así que no está disponible.
  handoffEnabled?: boolean;
  dailyCap?: { max: number; windowSeconds: number };
  deadlineMs?: number;
  log(event: string, data: Record<string, unknown>): void;
  now?: () => number;
}

export interface AgentPilot {
  readonly mode: "pilot" | "live";
  isPilot(phone: string): boolean;
  // Decide y verifica la respuesta de UN lote de texto de un contacto del piloto. `undefined`: que responda la ruta de siempre.
  produce(input: { from: string; turns: readonly ObservedTurn[]; handoff?: (reason: HandoffReason) => Promise<boolean> }): Promise<PilotReply | undefined>;
}

const digits = (phone: string): string => phone.replace(/\D/g, "");

// ¿Es un contacto elegible? Debe poder identificarse (clave del contacto = HMAC del teléfono y la línea): sin clave NO entra, para no tratar a nadie sin la separación de conversaciones que exige la memoria.
const identifiable = (contactKey: string | undefined): boolean => contactKey !== undefined && /^[0-9a-f]{8,}$/.test(contactKey);

export function createAgentPilot(options: AgentPilotOptions): AgentPilot {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? PILOT_LIMITS.deadlineMs;
  const fallback = (reason: string, extra: Record<string, unknown> = {}): undefined => { options.log("agent_pilot", { status: "FALLBACK", reason, ...extra }); return undefined; };
  const isPilot = (phone: string): boolean => {
    const own = digits(phone);
    if (options.everyone) return !options.everyone.exclude.has(own) && identifiable(options.everyone.contactKeyFor(phone));
    return options.phones?.has(own) ?? false;
  };
  // Corta-circuito (por instancia): si el modelo falla seguido (cuota, caída, plazo), durante un minuto NO se le espera: todos responden por la ruta de siempre al instante. Así una caída de OpenAI no retrasa a nadie.
  let failures = 0;
  let openUntil = 0;
  const noteOutcome = (modelWorked: boolean): void => {
    if (modelWorked) { failures = 0; return; }
    failures += 1;
    if (failures >= PILOT_LIMITS.breakerFailures) {
      openUntil = now() + PILOT_LIMITS.breakerOpenMs;
      failures = 0;
      options.log("agent_pilot_breaker", { open: true, forMs: PILOT_LIMITS.breakerOpenMs });
    }
  };

  return {
    mode: options.everyone ? "live" : "pilot",
    isPilot,
    async produce({ from, turns, handoff }) {
      if (!isPilot(from) || turns.length === 0) return undefined;
      const started = now();
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // 1. Interruptor: apagado o ilegible → ruta de siempre, sin tocar el modelo.
        if (!(await options.switch.enabled())) return fallback("SWITCH_OFF");
        if (now() < openUntil) return fallback("BREAKER_OPEN");
        const run = (async (): Promise<PilotReply | undefined> => {
          // 2. Peticiones, memoria, mensajes recientes y herramientas (lo mismo que la sombra).
          const prepared = await prepareAgentTurn(options.context, from, turns);
          if (prepared.kind === "skip") return fallback(prepared.reason);
          const capabilities: Capabilities = { handoff: Boolean(options.handoffEnabled && handoff), quote: options.context.capabilities?.quote ?? true };
          // 3. Decide (plan → herramientas → actos y texto → verificación por procedencia → derivación registrada si hace falta).
          const decision = await runAgentTurn(
            { model: options.model, tools: prepared.tools, ...(capabilities.handoff && handoff ? { handoff } : {}), cancelled: () => cancelled },
            { utterances: prepared.utterances, recent: prepared.recent, capabilities, now: new Date(now()) }
          );
          options.log("agent_pilot", { ...summarizeDecision(decision, { utterances: prepared.current, carried: prepared.carried, mediaSkipped: prepared.mediaSkipped, latencyMs: now() - started, model: options.modelName }), ...(decision.handoffRegistered ? { handoff: "REGISTERED" } : {}), ...(decision.intents ? { intents: decision.intents.map((reading) => reading.intent) } : {}) });
          // El modelo «funcionó» si respondió (aunque el verificador lo rechazara); falló si hubo error del proveedor.
          noteOutcome(decision.status !== "MODEL_ERROR");
          // Claramente ajeno al laboratorio y nada pendiente: no se responde (el turno se cierra sin respuesta, sin caer al modo esencial).
          if (decision.status === "SILENT" && !cancelled) return { body: "", result: "conversation", processingStatus: "COMPLETED", stale: "NEWER_TURN", quality: "ANSWER", quotedStudyIds: [], closes: [], silent: true };
          if (decision.status !== "VERIFIED" || !decision.reply || cancelled) return undefined;
          return replyOf(decision, options, prepared.utterances);
        })();
        const limit = new Promise<"TIMEOUT">((resolve) => { timer = setTimeout(() => resolve("TIMEOUT"), deadlineMs); timer.unref?.(); });
        const winner = await Promise.race([run, limit]);
        if (winner === "TIMEOUT") { cancelled = true; noteOutcome(false); return fallback("DEADLINE", { latencyMs: now() - started }); }
        return winner;
      } catch {
        cancelled = true;
        return fallback("ERROR");
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}

function replyOf(decision: Awaited<ReturnType<typeof runAgentTurn>>, options: AgentPilotOptions, utterances: readonly Utterance[]): PilotReply {
  const acts = decision.acts ?? [];
  const kinds = new Set(acts.map((act) => act.kind));
  const quoted = kinds.has("QUOTE");
  // Qué le pasa a lo que el paciente pidió, para la memoria: cotizado, aplazado (queda pendiente a la vista) o atendido. Un aplazo por salud o por «quiero una persona» queda como «sin derivación».
  const deferred = acts.filter((act) => act.kind === "DEFER");
  const humanOrMedical = new Set((decision.intents ?? []).filter((reading) => reading.intent === "MEDICAL" || reading.intent === "HUMAN").map((reading) => reading.utterance));
  const blocked = deferred.some((act) => act.utterances.some((id) => humanOrMedical.has(id)));
  // Una cotización acompañada de una pregunta de aclaración es parcial: lo que falta sigue pendiente a la vista.
  const partial = quoted && kinds.has("CLARIFY");
  const quality: ReplyQuality = quoted && deferred.length === 0 && !partial ? "QUOTE" : blocked ? "BLOCKED" : deferred.length > 0 || partial ? "UNRESOLVED" : quoted ? "QUOTE" : "ANSWER";
  const quotedStudyIds = quoted ? [...new Set(decision.facts.filter((fact) => fact.source === "QUOTE_ENGINE").flatMap((fact) => fact.refs).filter((ref) => ref.startsWith("study:")).map((ref) => ref.slice(6)))] : [];
  return {
    body: decision.reply!,
    result: quoted ? "quoted" : "conversation",
    processingStatus: "COMPLETED",
    stale: "NEWER_TURN",
    signature: `agent:${[...kinds].sort().join("+")}`,
    closes: closesOf(acts, utterances),
    quality,
    ...(options.dailyCap ? { cap: options.dailyCap } : {}),
    quotedStudyIds
  };
}

// Las peticiones pendientes (P#) que algún acto distinto de aplazar cubrió: el paciente ya fue atendido en eso. Un DEFER sobre ellas las deja pendientes a la vista.
function closesOf(acts: readonly Act[], utterances: readonly Utterance[]): string[] {
  const answered = new Set(acts.filter((act) => act.kind !== "DEFER").flatMap((act) => act.utterances));
  const deferred = new Set(acts.filter((act) => act.kind === "DEFER").flatMap((act) => act.utterances));
  return utterances.filter((utterance) => utterance.carried && utterance.ref && answered.has(utterance.id) && !deferred.has(utterance.id)).map((utterance) => utterance.ref!);
}
