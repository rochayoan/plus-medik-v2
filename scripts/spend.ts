// Control de gastos: SOLO lee .cache/usage.jsonl y .cache/spend-baseline.json. No hace llamadas de red.
//   npx tsx scripts/spend.ts init [presupuesto] [tope]   fija el punto de partida (ahora) y los límites (US$2 / US$1,50 por defecto)
//   npx tsx scripts/spend.ts                              gasto nuevo desde el punto de partida, por proveedor y etapa
//   npx tsx scripts/spend.ts estimate                     tarifas reales por etapa (historial) y costo de escenarios típicos
// Las llamadas servidas desde cache cuestan 0. Una llamada fallida (p. ej. 429) no se registra y tampoco se cobra.
// Los scripts que gastan dinero real exigen además una autorización explícita (ver scripts/lib/paid-guard.ts).
import { mkdir, writeFile } from "node:fs/promises";
import { baselinePath, cacheDir, costOf, median, money, readBaseline, readRows, realRows, type Baseline } from "./lib/spend-ledger.js";

const [command, arg1, arg2] = process.argv.slice(2);

if (command === "init") {
  const baseline: Baseline = { since: new Date().toISOString(), budgetUsd: Number(arg1 ?? 2), stopUsd: Number(arg2 ?? 1.5) };
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(baselinePath(), JSON.stringify(baseline, null, 2));
  console.log(`Punto de partida fijado: ${baseline.since} | presupuesto ${money(baseline.budgetUsd)} | se detiene en ${money(baseline.stopUsd)}`);
} else if (command === "estimate") {
  const rows = realRows(await readRows());
  const byLabel = new Map<string, number[]>();
  for (const row of rows) byLabel.set(row.label, [...(byLabel.get(row.label) ?? []), costOf(row)]);
  console.log("Tarifas reales por llamada (historial, solo llamadas reales):");
  const stage = new Map<string, number>();
  for (const [label, costs] of [...byLabel.entries()].sort()) {
    stage.set(label, median(costs));
    console.log(`  ${label.padEnd(26)} n=${String(costs.length).padStart(3)}  mediana ${money(median(costs))}  máx ${money(Math.max(...costs))}`);
  }
  const c = (label: string, times = 1) => (stage.get(label) ?? 0) * times;
  const scenarios: Array<[string, number]> = [
    ["Receta NUEVA completa sin cache (Gemini + lector OpenAI + 2 doc + 2 catálogo, sin juez ni bordes)", c("gemini-openrouter") + c("openai-reader") + c("openai-document-signal", 2) + c("openai-catalog-shadow", 2)],
    ["  + juez (si hay disputas)", c("openai-judge")],
    ["  + verificación de bordes (si la zona toca un borde)", c("openai-document-edges", 2)],
    ["Repetir SOLO el matching semántico (2 pasadas) con lecturas en cache", c("openai-catalog-shadow", 2)],
    ["Repetir SOLO la señal de documento (2 lecturas) con el resto en cache", c("openai-document-signal", 2)],
    ["Referencia independiente de total (1 llamada)", c("openai-quote-reference")],
    ["Cualquier corrida totalmente cacheada", 0]
  ];
  console.log("\nEstimación por escenario (medianas históricas; la guarda usa el máximo x1,3 como margen):");
  for (const [name, cost] of scenarios) console.log(`  ${money(cost)}  ${name}`);
} else {
  const baseline = await readBaseline();
  if (!baseline) {
    console.log("No hay punto de partida. Ejecuta: npx tsx scripts/spend.ts init");
    process.exit(1);
  }
  const rows = (await readRows()).filter((row) => row.timestamp >= baseline.since);
  const real = realRows(rows);
  const byProvider = new Map<string, { calls: number; cost: number }>();
  const byLabel = new Map<string, { calls: number; cost: number }>();
  for (const row of real) {
    const p = byProvider.get(row.provider) ?? { calls: 0, cost: 0 };
    byProvider.set(row.provider, { calls: p.calls + 1, cost: p.cost + costOf(row) });
    const l = byLabel.get(row.label) ?? { calls: 0, cost: 0 };
    byLabel.set(row.label, { calls: l.calls + 1, cost: l.cost + costOf(row) });
  }
  const total = [...byProvider.values()].reduce((sum, p) => sum + p.cost, 0);
  console.log(`Desde ${baseline.since}: ${real.length} llamadas reales, ${rows.length - real.length} servidas desde cache`);
  for (const [provider, p] of byProvider) console.log(`  ${provider.padEnd(11)} ${String(p.calls).padStart(3)} llamadas  ${money(p.cost)}`);
  for (const [label, l] of byLabel) console.log(`    ${label.padEnd(26)} ${String(l.calls).padStart(3)}  ${money(l.cost)}`);
  console.log(`GASTO NUEVO TOTAL: ${money(total)} de ${money(baseline.budgetUsd)} | tope de parada ${money(baseline.stopUsd)} | disponible hasta el tope: ${money(Math.max(0, baseline.stopUsd - total))}${total >= baseline.stopUsd ? "  >>> TOPE ALCANZADO: NO HACER MÁS LLAMADAS" : ""}`);
}
