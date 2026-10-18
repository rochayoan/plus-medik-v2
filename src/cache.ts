import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Cambiar este número invalida todo el cache existente (formato de clave/entrada).
export const CACHE_VERSION = 1;

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  // Solo si el proveedor lo reporta (OpenRouter). No hay tabla de precios propia.
  costUsd?: number;
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
  return appendUsageLine({
    timestamp: new Date().toISOString(),
    ...record,
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

export async function cachedAiCall<T>(options: {
  label: string;
  provider: string;
  model: string;
  imageBase64: string;
  // Todo lo que, junto con la imagen y el modelo, determina la respuesta (prompt, schema, parámetros).
  config: unknown;
  parse: (raw: unknown) => T;
  // Debe lanzar si la respuesta no es válida: solo lo válido llega al cache.
  call: () => Promise<{ value: T; usage?: AiUsage }>;
}): Promise<T> {
  const mode = cacheMode();
  const { label, provider, model } = options;
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
      return hit.value;
    }
  }

  const { value, usage } = await options.call();
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
