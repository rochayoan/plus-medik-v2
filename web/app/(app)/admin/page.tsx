import type { Metadata } from "next";
import { formatBs } from "@/lib/format";
import { requireAdmin } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Monitoreo" };
export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = { manual: "Buscador", paste: "Pegar lista", photo: "Foto", template: "Plantilla", repeat: "Repetir" };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export default async function MonitorPage() {
  await requireAdmin();
  const db = adminClient();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const dayAgo = Date.now() - 86_400_000;

  const [quotesResult, jobsResult, usageResult, orgsResult] = await Promise.all([
    db.from("quotes").select("organization_id, created_by, total_bs, source, created_at").gte("created_at", since).limit(20_000),
    db.from("photo_jobs").select("status, decision, duration_ms, cost_usd, reused_from").gte("created_at", since).limit(20_000),
    db.from("ai_usage").select("model, input_tokens, output_tokens, cost_usd").gte("created_at", since).limit(50_000),
    db.from("organizations").select("id, name")
  ]);
  const quotes = (quotesResult.data ?? []) as Array<{ organization_id: string | null; created_by: string; total_bs: number | string; source: string; created_at: string }>;
  const jobs = (jobsResult.data ?? []) as Array<{ status: string; decision: string | null; duration_ms: number | null; cost_usd: number | string | null; reused_from: string | null }>;
  const usage = (usageResult.data ?? []) as Array<{ model: string; input_tokens: number | null; output_tokens: number | null; cost_usd: number | string | null }>;
  const orgNames = new Map(((orgsResult.data ?? []) as Array<{ id: string; name: string }>).map((org) => [org.id, org.name]));

  const today = quotes.filter((quote) => new Date(quote.created_at).getTime() >= dayAgo).length;
  const activeUsers = new Set(quotes.map((quote) => quote.created_by)).size;
  const bySource = new Map<string, number>();
  const byOrg = new Map<string, { count: number; total: number }>();
  for (const quote of quotes) {
    bySource.set(quote.source, (bySource.get(quote.source) ?? 0) + 1);
    const key = quote.organization_id ?? "plusmedik";
    const entry = byOrg.get(key) ?? { count: 0, total: 0 };
    byOrg.set(key, { count: entry.count + 1, total: entry.total + Number(quote.total_bs) });
  }

  const done = jobs.filter((job) => job.status === "done");
  const analyzed = done.filter((job) => !job.reused_from);
  const durations = analyzed.map((job) => job.duration_ms ?? 0).sort((a, b) => a - b);
  const p50 = durations.length ? durations[Math.floor(durations.length * 0.5)]! : 0;
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]! : 0;
  const autoSafe = done.filter((job) => job.decision === "AUTO_SAFE").length;
  const reportedCost = jobs.reduce((sum, job) => sum + Number(job.cost_usd ?? 0), 0);

  const byModel = new Map<string, { calls: number; input: number; output: number; cost: number }>();
  for (const row of usage) {
    const entry = byModel.get(row.model) ?? { calls: 0, input: 0, output: 0, cost: 0 };
    byModel.set(row.model, { calls: entry.calls + 1, input: entry.input + (row.input_tokens ?? 0), output: entry.output + (row.output_tokens ?? 0), cost: entry.cost + Number(row.cost_usd ?? 0) });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Últimos 7 días</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cotizaciones (7 días)" value={String(quotes.length)} hint={`${today} en las últimas 24 h`} />
        <Stat label="Usuarios activos" value={String(activeUsers)} />
        <Stat label="Fotos analizadas" value={String(done.length)} hint={`${jobs.filter((job) => job.status === "failed").length} fallidas · ${done.length - analyzed.length} reutilizadas`} />
        <Stat label="Tiempo de lectura" value={`${Math.round(p50 / 1000)} s`} hint={`p95: ${Math.round(p95 / 1000)} s · AUTO_SAFE: ${done.length ? Math.round((autoSafe / done.length) * 100) : 0}%`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Cómo cotizan</h2>
          <ul className="space-y-1 text-sm">
            {[...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => (
              <li key={source} className="flex justify-between"><span>{SOURCE_LABELS[source] ?? source}</span><span className="tabular-nums">{count}</span></li>
            ))}
            {bySource.size === 0 ? <li className="text-muted">Sin datos</li> : null}
          </ul>
        </section>
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Por organización</h2>
          <ul className="space-y-1 text-sm">
            {[...byOrg.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15).map(([id, entry]) => (
              <li key={id} className="flex justify-between gap-2">
                <span className="truncate">{orgNames.get(id) ?? "PlusMedik"}</span>
                <span className="shrink-0 tabular-nums">{entry.count} · {formatBs(entry.total)}</span>
              </li>
            ))}
            {byOrg.size === 0 ? <li className="text-muted">Sin datos</li> : null}
          </ul>
        </section>
      </div>

      <section className="card overflow-x-auto p-4">
        <h2 className="mb-1 font-semibold">Uso de IA (fotos)</h2>
        <p className="mb-3 text-xs text-muted">
          Costo reportado por los proveedores: US$ {reportedCost.toFixed(2)}. OpenAI no informa el costo por llamada: estímalo con los tokens y la tarifa vigente.
        </p>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr><th className="py-1">Modelo</th><th className="text-right">Llamadas</th><th className="text-right">Tokens entrada</th><th className="text-right">Tokens salida</th><th className="text-right">US$ reportado</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {[...byModel.entries()].map(([model, entry]) => (
              <tr key={model} className="border-t border-line">
                <td className="py-1.5">{model}</td>
                <td className="text-right">{entry.calls}</td>
                <td className="text-right">{entry.input.toLocaleString("es-BO")}</td>
                <td className="text-right">{entry.output.toLocaleString("es-BO")}</td>
                <td className="text-right">{entry.cost.toFixed(3)}</td>
              </tr>
            ))}
            {byModel.size === 0 ? <tr><td colSpan={5} className="py-2 text-muted">Sin llamadas</td></tr> : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
