import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertModelCallsAllowed, OfflineViolation } from "./offline.js";
import { describeProviderError, type ProviderErrorInfo } from "./provider-error.js";

// Cambiar este número invalida todo el cache existente (formato de clave/entrada).
export const CACHE_VERSION = 1;

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  // Solo si el proveedor lo reporta (OpenRouter). No hay tabla de precios propia.
  costUsd?: number;
}

// Clases de fallo de una llamada a un modelo. Se deducen de propiedades TIPADAS del error (clase, `name`, `status` HTTP numérico, `code` del sistema)
// y nunca del texto del mensaje: el mensaje de un proveedor puede traer datos sensibles y no es un contrato. Es lo único del error que se persiste.
export type AiErrorKind = "TIMEOUT" | "NETWORK" | "RATE_LIMITED" | "HTTP_CLIENT" | "HTTP_SERVER" | "SCHEMA_INVALID" | "BLOCKED" | "UNKNOWN";

// Observabilidad por procesamiento: recibe resultados ya parseados y nunca altera la llamada ni su salida.
// El consumidor debe reducir cualquier dato antes de persistirlo.
//
// Telemetría (todos los campos son opcionales: un evento sin ellos equivale a un registro anterior a la telemetría):
//  - callSeq:       orden de INICIO de la llamada lógica dentro del procesamiento (1, 2, 3...). Se asigna de forma síncrona al invocar cachedAiCall,
//                   así que es determinista aunque haya llamadas en paralelo.
//  - completionSeq: orden en que el evento quedó registrado (finalización). NO equivale al orden de inicio.
//  - attempt:       intento dentro de la llamada lógica (1 = primero). Solo se ven los intentos que el motor notifica (respuestas inválidas que se
//                   reintentan); los reintentos internos por 503 de Gemini no son observables.
//  - startedAt / durationMs: inicio y duración. En un intento posterior al primero se miden desde que terminó el intento anterior.
//  - reasoningEffort: esfuerzo de razonamiento del intento si la llamada lo informa; si no, el configurado en los parámetros de la petición. Si no consta, undefined.
//  - paramsHash:    hash de los PARÁMETROS de la petición (modelo, esquema de salida, razonamiento), nunca del prompt ni de la imagen.
//  - errorKind:     solo si la llamada falló (ver AiErrorKind).
export interface AiCallEvent {
  label: string;
  provider: string;
  model: string;
  cacheHit: boolean;
  outcome: "OK" | "FAILED" | "INVALID" | "CACHE_HIT";
  usage?: AiUsage;
  value?: unknown;
  callSeq?: number;
  completionSeq?: number;
  attempt?: number;
  startedAt?: string;
  durationMs?: number;
  reasoningEffort?: string;
  paramsHash?: string;
  errorKind?: AiErrorKind;
  // Causa del fallo con códigos de lista blanca (cuota vs. tasa, estado HTTP, retry-after…). Solo en memoria, para el registro de Vercel: NO se guarda en la auditoría (serializeAiCalls elige sus campos).
  failure?: ProviderErrorInfo;
}

export type AiCallObserver = (event: AiCallEvent) => void;

// Un procesamiento (una imagen) = un alcance con sus propios contadores. Dos procesamientos concurrentes nunca comparten orden ni eventos.
interface RunScope {
  observer: AiCallObserver;
  startedCalls: number;
  completedEvents: number;
}
const aiCallScope = new AsyncLocalStorage<RunScope>();

// Estado de UNA llamada lógica (una invocación de cachedAiCall), visible para los eventos que se emiten desde dentro de su `call` (recordAiUsage).
interface CallTelemetry {
  run: RunScope;
  label: string;
  provider: string;
  model: string;
  callSeq: number;
  nextAttempt: number;
  invalidAttempts: number;
  boundaryEpochMs: number;
  boundaryPerfMs: number;
  reasoningEffort?: string;
  paramsHash?: string;
}
const callScope = new AsyncLocalStorage<CallTelemetry>();

export function withAiCallObserver<T>(observer: AiCallObserver, operation: () => Promise<T>): Promise<T> {
  return aiCallScope.run({ observer, startedCalls: 0, completedEvents: 0 }, operation);
}

function deliver(run: RunScope, event: AiCallEvent): void {
  try {
    run.observer(event);
  } catch {
    // La auditoría nunca interrumpe el motor ni un proveedor.
  }
}

function beginCall(identity: { label: string; provider: string; model: string }, config: unknown): CallTelemetry | undefined {
  const run = aiCallScope.getStore();
  if (!run) return undefined;
  return {
    run,
    ...identity,
    callSeq: ++run.startedCalls,
    nextAttempt: 1,
    invalidAttempts: 0,
    boundaryEpochMs: Date.now(),
    boundaryPerfMs: performance.now(),
    reasoningEffort: reasoningEffortOf(config),
    paramsHash: paramsHashOf(config)
  };
}

// Emite el evento de un intento y avanza la frontera de tiempo (el siguiente intento se mide desde aquí).
function emitAttempt(call: CallTelemetry, attempt: Pick<AiCallEvent, "cacheHit" | "outcome" | "usage" | "value" | "errorKind" | "reasoningEffort"> & { failure?: ProviderErrorInfo }, endedPerfMs = performance.now()): void {
  const event: AiCallEvent = {
    label: call.label,
    provider: call.provider,
    model: call.model,
    cacheHit: attempt.cacheHit,
    outcome: attempt.outcome,
    usage: attempt.usage,
    value: attempt.value,
    callSeq: call.callSeq,
    completionSeq: ++call.run.completedEvents,
    attempt: call.nextAttempt++,
    startedAt: new Date(call.boundaryEpochMs).toISOString(),
    durationMs: Math.max(0, Math.round(endedPerfMs - call.boundaryPerfMs)),
    reasoningEffort: attempt.reasoningEffort ?? call.reasoningEffort,
    paramsHash: call.paramsHash,
    errorKind: attempt.errorKind,
    ...(attempt.failure ? { failure: attempt.failure } : {})
  };
  if (attempt.outcome === "INVALID") call.invalidAttempts++;
  call.boundaryEpochMs = Date.now();
  call.boundaryPerfMs = performance.now();
  deliver(call.run, event);
}

const EFFORT_PATTERN = /^[A-Za-z_.]{1,32}$/;

// Esfuerzo configurado en la petición (solo rutas conocidas; un texto cualquiera nunca se copia).
function reasoningEffortOf(config: unknown): string | undefined {
  const root = asRecord(config);
  const effort = asRecord(asRecord(root.params).reasoning).effort ?? asRecord(asRecord(root.requestConfig).thinkingConfig).thinkingLevel;
  return typeof effort === "string" && EFFORT_PATTERN.test(effort) ? effort : undefined;
}

// Los parámetros de la petición (esquema, modelo, razonamiento) no llevan datos del paciente; el prompt sí puede llevarlos (textos de estudios), por eso no se hashea.
function paramsHashOf(config: unknown): string | undefined {
  const root = asRecord(config);
  const params = root.params ?? root.requestConfig;
  return params === undefined ? undefined : sha256(JSON.stringify(params));
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED"]);
const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError", "APIConnectionTimeoutError"]);

export function classifyAiError(error: unknown, context: { invalidAttempts?: number } = {}): AiErrorKind {
  if (error instanceof OfflineViolation) return "BLOCKED";
  if (error instanceof SyntaxError) return "SCHEMA_INVALID";
  if (typeof error === "object" && error !== null) {
    const { name, status, code } = error as { name?: unknown; status?: unknown; code?: unknown };
    if (name === "PaidCallBlockedError") return "BLOCKED";
    if (name === "ZodError") return "SCHEMA_INVALID";
    if (typeof name === "string" && TIMEOUT_NAMES.has(name)) return "TIMEOUT";
    if (typeof status === "number") {
      if (status === 429) return "RATE_LIMITED";
      if (status === 408 || status === 504) return "TIMEOUT";
      if (status >= 500) return "HTTP_SERVER";
      if (status >= 400) return "HTTP_CLIENT";
    }
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "TIMEOUT";
    if (typeof code === "string" && NETWORK_CODES.has(code)) return "NETWORK";
    if (name === "APIConnectionError") return "NETWORK";
  }
  // Una llamada que ya recibió respuestas inválidas y terminó lanzando falló por el contenido, no por la red.
  return (context.invalidAttempts ?? 0) > 0 ? "SCHEMA_INVALID" : "UNKNOWN";
}

// Reintentos ante un límite de uso temporal (AI_RATE_LIMIT_RETRIES: 0 a 3, por defecto 2).
function rateLimitRetries(): number {
  const raw = (process.env.AI_RATE_LIMIT_RETRIES ?? "").trim();
  return /^[0-3]$/.test(raw) ? Number(raw) : 2;
}

type CacheMode = "on" | "off" | "refresh";

// AI_CACHE=off: no lee ni escribe cache (el usage de llamadas reales sí se registra).
// AI_CACHE=refresh: ignora el cache existente y lo sobrescribe solo si la nueva respuesta es válida.
function cacheMode(): CacheMode {
  const value = (process.env.AI_CACHE ?? "").trim().toLowerCase();
  if (value === "" || value === "on") return "on";
  if (value === "off" || value === "refresh") return value;
  throw new Error(`AI_CACHE inválido: "${process.env.AI_CACHE}" (usa off, refresh o déjalo vacío)`);
}

function cacheRoot(): string {
  return process.env.AI_CACHE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface UsageRecord {
  label: string;
  provider: string;
  model: string;
  usage?: AiUsage;
  // Respuesta que llegó pero no pasó el parseo/validación (se pagó igual).
  invalid?: boolean;
  // Solo telemetría (no se escribe en usage.jsonl): esfuerzo de razonamiento con el que se hizo ESTE intento.
  reasoningEffort?: string;
}

async function appendUsageLine(line: Record<string, unknown>): Promise<void> {
  try {
    const root = cacheRoot();
    await mkdir(root, { recursive: true });
    await appendFile(join(root, "usage.jsonl"), `${JSON.stringify(line)}\n`);
  } catch (error) {
    console.error(`No se pudo registrar usage: ${(error as Error).message}`);
  }
}

// Registra una llamada real al proveedor (también las respuestas inválidas que se reintentan).
export function recordAiUsage(record: UsageRecord): Promise<void> {
  const { reasoningEffort, ...loggable } = record;
  const attempt = { cacheHit: false, outcome: record.invalid ? ("INVALID" as const) : ("OK" as const), usage: record.usage, reasoningEffort };
  const call = callScope.getStore();
  if (call) {
    // Intento inválido dentro de una llamada lógica en curso: queda como un intento más de ESA llamada.
    emitAttempt(call, attempt);
  } else {
    // Sin llamada lógica en curso: evento propio, sin tiempos (no se sabe cuándo empezó).
    const run = aiCallScope.getStore();
    if (run) deliver(run, { label: record.label, provider: record.provider, model: record.model, ...attempt, callSeq: ++run.startedCalls, completionSeq: ++run.completedEvents, attempt: 1 });
  }
  return appendUsageLine({
    timestamp: new Date().toISOString(),
    ...loggable,
    cacheHit: false,
    cacheMode: cacheMode()
  });
}

interface CacheEntry<T> {
  cacheVersion: number;
  key: string;
  label: string;
  provider: string;
  model: string;
  createdAt: string;
  usage?: AiUsage;
  value: T;
}

async function readEntry<T>(file: string, key: string, parse: (raw: unknown) => T): Promise<CacheEntry<T> | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as CacheEntry<unknown>;
    if (entry.cacheVersion !== CACHE_VERSION || entry.key !== key) return undefined;
    return { ...entry, value: parse(entry.value) };
  } catch {
    return undefined; // ausente, corrupto o con formato viejo: se trata como miss
  }
}

// Gancho opcional que se ejecuta justo antes de CADA llamada real a un modelo (no en cache hits). Por defecto no hay ninguno; las herramientas
// de pruebas pagadas instalan uno (scripts/lib/paid-guard.ts) que lanza para bloquear la llamada. Si el gancho lanza, la llamada no se hace.
export type RealCallGate = (info: { label: string; provider: string; model: string }) => void | Promise<void>;
let realCallGate: RealCallGate | undefined;
export function setRealCallGate(gate: RealCallGate | undefined): void {
  realCallGate = gate;
}

export async function cachedAiCall<T>(options: {
  label: string;
  provider: string;
  model: string;
  imageBase64: string;
  // Todo lo que, junto con la imagen y el modelo, determina la respuesta (prompt, schema, parámetros).
  config: unknown;
  parse: (raw: unknown) => T;
  // Debe lanzar si la respuesta no es válida: solo lo válido llega al cache.
  // `reasoningEffort` (opcional) es solo telemetría: el esfuerzo con el que se hizo el intento que devolvió el valor, si difiere del configurado.
  call: () => Promise<{ value: T; usage?: AiUsage; reasoningEffort?: string }>;
  // Solo pruebas: espera entre reintentos por límite de uso (por defecto una espera real).
  retrySleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const mode = cacheMode();
  const { label, provider, model } = options;
  // Telemetría: la numeración de inicio se toma aquí, de forma síncrona, antes de cualquier espera (sin observador no se mide nada).
  const telemetry = beginCall({ label, provider, model }, options.config);
  const key = sha256(JSON.stringify({
    cacheVersion: CACHE_VERSION,
    provider,
    model,
    image: sha256(options.imageBase64),
    config: options.config
  }));
  const file = join(cacheRoot(), "ai", `${key}.json`);

  if (mode === "on") {
    const hit = await readEntry(file, key, options.parse);
    if (hit) {
      const endedPerfMs = performance.now();
      console.error(`CACHE HIT ${label} (${model})`);
      await appendUsageLine({
        timestamp: new Date().toISOString(),
        label,
        provider,
        model,
        cacheHit: true,
        cacheMode: mode,
        key,
        savedUsage: hit.usage
      });
      // El uso guardado se ahorró en esta ejecución: se informa como `usage` (compatibilidad) y el consumidor decide no contarlo como gasto.
      if (telemetry) emitAttempt(telemetry, { cacheHit: true, outcome: "CACHE_HIT", usage: hit.usage, value: hit.value }, endedPerfMs);
      return hit.value;
    }
  }

  let value: T;
  let usage: AiUsage | undefined;
  let attemptEffort: string | undefined;
  try {
    // Modo offline: ANTES de la guarda de gasto, para que ninguna guarda permisiva pueda dejar pasar una llamada real.
    assertModelCallsAllowed(label, provider, model);
    await realCallGate?.({ label, provider, model });
    const run = () => (telemetry ? callScope.run(telemetry, () => options.call()) : options.call());
    // Un 429 por «vas demasiado rápido» (varias llamadas a la vez) casi siempre se resuelve esperando un instante: se reintenta, con tope. Uno por cuota o saldo NO se reintenta (no se arregla esperando).
    const retries = rateLimitRetries();
    for (let attempt = 0; ; attempt++) {
      try {
        ({ value, usage, reasoningEffort: attemptEffort } = await run());
        break;
      } catch (error) {
        const info = describeProviderError(error);
        if (attempt >= retries || info.httpStatus !== 429 || info.cause === "QUOTA_OR_BILLING") throw error;
        const waitMs = Math.min(5000, info.retryAfterS !== undefined ? info.retryAfterS * 1000 : 1200 * (attempt + 1) + Math.floor(Math.random() * 600));
        console.error(`RATE LIMIT ${label} (${model}): reintento ${attempt + 1} en ${waitMs} ms`);
        await (options.retrySleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(waitMs);
      }
    }
  } catch (error) {
    if (telemetry) emitAttempt(telemetry, { cacheHit: false, outcome: "FAILED", errorKind: classifyAiError(error, { invalidAttempts: telemetry.invalidAttempts }), failure: describeProviderError(error) });
    throw error;
  }
  const endedPerfMs = performance.now();
  await appendUsageLine({
    timestamp: new Date().toISOString(),
    label,
    provider,
    model,
    cacheHit: false,
    cacheMode: mode,
    key,
    usage
  });
  if (telemetry) emitAttempt(telemetry, { cacheHit: false, outcome: "OK", usage, value, reasoningEffort: attemptEffort }, endedPerfMs);

  if (mode !== "off") {
    try {
      const entry: CacheEntry<T> = {
        cacheVersion: CACHE_VERSION,
        key,
        label,
        provider,
        model,
        createdAt: new Date().toISOString(),
        usage,
        value
      };
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(entry, null, 2));
    } catch (error) {
      console.error(`No se pudo escribir el cache: ${(error as Error).message}`);
    }
  }
  return value;
}

// Normalizadores de usage por proveedor: solo copian lo que el proveedor devuelve.
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

function compact(usage: AiUsage): AiUsage | undefined {
  const entries = Object.entries(usage).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as AiUsage) : undefined;
}

// OpenAI Responses API
export function usageFromResponses(raw: unknown): AiUsage | undefined {
  const usage = asRecord(raw);
  return compact({
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    reasoningTokens: asNumber(asRecord(usage.output_tokens_details).reasoning_tokens)
  });
}

// Chat Completions compatible (OpenRouter devuelve además usage.cost)
export function usageFromChatCompletions(raw: unknown): AiUsage | undefined {
  const usage = asRecord(raw);
  return compact({
    inputTokens: asNumber(usage.prompt_tokens),
    outputTokens: asNumber(usage.completion_tokens),
    reasoningTokens: asNumber(asRecord(usage.completion_tokens_details).reasoning_tokens),
    costUsd: asNumber(usage.cost)
  });
}

// Google AI Studio (usageMetadata)
export function usageFromGemini(raw: unknown): AiUsage | undefined {
  const usage = asRecord(raw);
  return compact({
    inputTokens: asNumber(usage.promptTokenCount),
    outputTokens: asNumber(usage.candidatesTokenCount),
    reasoningTokens: asNumber(usage.thoughtsTokenCount)
  });
}
