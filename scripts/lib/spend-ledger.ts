// Libro de gastos local: SOLO lee .cache/usage.jsonl y .cache/spend-baseline.json. No hace llamadas de red.
// Lo usan scripts/spend.ts (informes) y scripts/lib/paid-guard.ts (bloqueo de llamadas reales).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface UsageRow {
  timestamp: string;
  label: string;
  provider: string;
  cacheHit: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface Baseline {
  since: string;
  budgetUsd: number;
  stopUsd: number;
}

export const cacheDir = (): string => join(process.env.AI_CACHE_DIR ?? join(process.cwd(), ".cache"));
export const usagePath = (): string => join(cacheDir(), "usage.jsonl");
export const baselinePath = (): string => join(cacheDir(), "spend-baseline.json");

// Tarifas OpenAI por millón de tokens (las que el usuario indicó para gpt-6.1-sol). Se cobran TODOS los tokens de salida, incluido el
// razonamiento, y se ignora el descuento de entrada cacheada: la estimación es conservadora. OpenRouter registra su costo real (costUsd).
export const tariffs = () => ({
  input: Number(process.env.OPENAI_CATALOG_PRICE_INPUT_PER_MTOK ?? 2),
  output: Number(process.env.OPENAI_CATALOG_PRICE_OUTPUT_PER_MTOK ?? 10)
});

export function costOf(row: UsageRow): number {
  const u = row.usage;
  if (row.cacheHit || !u) return 0;
  if (row.provider === "openrouter") return u.costUsd ?? 0;
  const price = tariffs();
  return ((u.inputTokens ?? 0) * price.input + (u.outputTokens ?? 0) * price.output) / 1_000_000;
}

export async function readRows(path = usagePath()): Promise<UsageRow[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line) as UsageRow] : [];
    } catch {
      return [];
    }
  });
}

export async function readBaseline(path = baselinePath()): Promise<Baseline | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as Baseline;
}

export const realRows = (rows: UsageRow[]): UsageRow[] => rows.filter((row) => !row.cacheHit && row.usage);
export const spentSince = (rows: UsageRow[], since: string): number => realRows(rows).filter((row) => row.timestamp >= since).reduce((sum, row) => sum + costOf(row), 0);

export const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// Costo máximo observado por etapa (historial de llamadas reales).
export function maxCostByLabel(rows: UsageRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of realRows(rows)) out.set(row.label, Math.max(out.get(row.label) ?? 0, costOf(row)));
  return out;
}

export const money = (n: number): string => `US$${n.toFixed(4)}`;
