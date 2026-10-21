import { Repeat, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatBs, formatDate, formatFolio } from "@/lib/format";
import { getSession } from "@/lib/session";
import { createUserClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Historial" };

const PAGE_SIZE = 30;

interface Row {
  id: string;
  folio: number;
  patient_name: string | null;
  total_bs: number | string;
  created_at: string;
  creator: { full_name: string } | null;
  items: Array<{ count: number }>;
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { q = "", page = "1" } = await searchParams;
  const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
  const term = q.trim();

  // RLS: un member ve las suyas; org_admin, las de su organización; admin, todas.
  let query = (await createUserClient())
    .from("quotes")
    .select("id, folio, patient_name, total_bs, created_at, creator:profiles(full_name), items:quote_items(count)")
    .order("created_at", { ascending: false })
    .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE);
  if (term) {
    const folio = Number.parseInt(term.replace(/^pm-?/i, ""), 10);
    query = Number.isFinite(folio) && /^(pm-?)?\d+$/i.test(term)
      ? query.eq("folio", folio)
      : query.ilike("patient_name", `%${term.replace(/[%_\\]/g, (char) => `\\${char}`)}%`);
  }
  const { data } = await query;
  const rows = ((data as Row[] | null) ?? []);
  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);
  const showCreator = session.role !== "member";

  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Historial</h1>
        <form className="relative w-full sm:w-72" role="search">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input name="q" defaultValue={term} placeholder="Paciente o folio (PM-000123)" className="input pl-9" aria-label="Buscar cotización" />
        </form>
      </div>

      {visible.length === 0 ? (
        <p className="card p-8 text-center text-sm text-muted">{term ? "No hay cotizaciones que coincidan." : "Aún no hay cotizaciones."}</p>
      ) : (
        <ul className="card divide-y divide-line">
          {visible.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-4 py-3">
              <Link href={`/cotizacion/${row.id}`} className="min-w-0 flex-1">
                <p className="font-medium">
                  {formatFolio(row.folio)} <span className="font-normal text-muted">· {formatDate(row.created_at)}</span>
                </p>
                <p className="truncate text-sm text-muted">
                  {[row.patient_name ?? "Sin paciente", `${row.items[0]?.count ?? 0} estudios`, showCreator ? row.creator?.full_name : null].filter(Boolean).join(" · ")}
                </p>
              </Link>
              <span className="shrink-0 font-medium tabular-nums">{formatBs(Number(row.total_bs))}</span>
              <Link href={`/cotizar?repetir=${row.id}`} className="btn-ghost shrink-0 px-2" title="Repetir estudios">
                <Repeat className="size-4" aria-hidden /><span className="sr-only">Repetir</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between">
        {pageNumber > 1 ? <Link className="btn-secondary" href={`/historial?${new URLSearchParams({ q: term, page: String(pageNumber - 1) })}`}>Anteriores</Link> : <span />}
        {hasMore ? <Link className="btn-secondary" href={`/historial?${new URLSearchParams({ q: term, page: String(pageNumber + 1) })}`}>Más antiguas</Link> : null}
      </div>
    </main>
  );
}
