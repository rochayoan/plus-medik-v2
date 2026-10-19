// Protección de scripts que pueden gastar dinero real. Se instala con installPaidCallGuard("nombre") y actúa en el único punto por el que
// pasan todas las llamadas a modelos: cachedAiCall (src/cache.ts) llama a la guarda JUSTO ANTES de cada llamada real. Las respuestas servidas
// desde cache no la activan (cuestan 0).
//
// Una llamada real solo se permite si TODO esto se cumple:
//   1. PLUSMEDIK_AUTHORIZE_PAID_CALLS=<USD máximo para esta corrida> está definida con un número positivo (autorización explícita; sin ella se bloquea).
//   2. Existe un presupuesto fijado (npx tsx scripts/spend.ts init) y el gasto nuevo acumulado no alcanzó su tope de parada.
//   3. El costo estimado de la llamada (máximo histórico de esa etapa x1,3) cabe en lo autorizado y en lo que queda hasta el tope,
//      sumando lo ya reservado por las llamadas anteriores de esta corrida.
// Las estimaciones son conservadoras; las llamadas en paralelo reservan antes de ejecutarse, así que no se sobrepasa por concurrencia.
import { setRealCallGate, type RealCallGate } from "../../src/cache.js";
import { maxCostByLabel, money, readBaseline, readRows, spentSince, type Baseline, type UsageRow } from "./spend-ledger.js";

export const AUTHORIZATION_ENV = "PLUSMEDIK_AUTHORIZE_PAID_CALLS";
export const ESTIMATE_MARGIN = 1.3;
export const FALLBACK_ESTIMATE_USD = 0.1;

export class PaidCallBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaidCallBlockedError";
  }
}

export interface GuardDeps {
  env?: NodeJS.ProcessEnv;
  readRows?: () => Promise<UsageRow[]>;
  readBaseline?: () => Promise<Baseline | undefined>;
}

export function createPaidCallGate(script: string, deps: GuardDeps = {}): (info: Parameters<RealCallGate>[0]) => Promise<void> {
  const rowsReader = deps.readRows ?? readRows;
  const baselineReader = deps.readBaseline ?? readBaseline;
  // Se leen una sola vez: lo que se gasta durante la corrida lo cubre `reserved` (estimaciones, siempre >= lo gastado).
  let ledger: Promise<{ baseline: Baseline | undefined; spentAtStart: number; maxByLabel: Map<string, number> }> | undefined;
  let reserved = 0;

  return async ({ label, provider, model }) => {
    const env = deps.env ?? process.env;
    const raw = env[AUTHORIZATION_ENV]?.trim();
    const authorized = raw ? Number(raw) : Number.NaN;
    if (!Number.isFinite(authorized) || authorized <= 0) {
      throw new PaidCallBlockedError(
        `[${script}] Llamada real a ${provider}/${model} (${label}) BLOQUEADA: falta autorización explícita.\n` +
          `Este script puede gastar dinero. Estima el costo (npx tsx scripts/spend.ts estimate) y autoriza un máximo en USD, por ejemplo:\n` +
          `  ${AUTHORIZATION_ENV}=0.15 npx tsx scripts/${script}.ts ...\n` +
          `Con todas las respuestas en cache no hace falta autorización (costo 0).`
      );
    }
    ledger ??= (async () => {
      const rows = await rowsReader();
      const baseline = await baselineReader();
      return { baseline, spentAtStart: baseline ? spentSince(rows, baseline.since) : 0, maxByLabel: maxCostByLabel(rows) };
    })();
    const { baseline, spentAtStart, maxByLabel } = await ledger;
    if (!baseline) {
      throw new PaidCallBlockedError(`[${script}] Llamada real BLOQUEADA: no hay presupuesto fijado. Ejecuta primero: npx tsx scripts/spend.ts init`);
    }
    // Desde aquí todo es síncrono: la reserva es atómica aunque haya llamadas en paralelo.
    if (spentAtStart >= baseline.stopUsd) {
      throw new PaidCallBlockedError(`[${script}] Llamada real BLOQUEADA: el gasto nuevo (${money(spentAtStart)}) ya alcanzó el tope de parada (${money(baseline.stopUsd)}).`);
    }
    const estimate = (maxByLabel.get(label) ?? FALLBACK_ESTIMATE_USD) * ESTIMATE_MARGIN;
    if (reserved + estimate > authorized) {
      throw new PaidCallBlockedError(`[${script}] Llamada real (${label}) BLOQUEADA: reservado ${money(reserved)} + estimado ${money(estimate)} supera lo autorizado (${money(authorized)}).`);
    }
    if (spentAtStart + reserved + estimate > baseline.stopUsd) {
      throw new PaidCallBlockedError(
        `[${script}] Llamada real (${label}) BLOQUEADA: gasto nuevo ${money(spentAtStart)} + reservado ${money(reserved)} + estimado ${money(estimate)} superaría el tope de parada (${money(baseline.stopUsd)}).`
      );
    }
    reserved += estimate;
  };
}

export function installPaidCallGuard(script: string, deps: GuardDeps = {}): void {
  setRealCallGate(createPaidCallGate(script, deps));
}
