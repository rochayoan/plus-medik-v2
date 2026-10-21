import { getCoreCatalog } from "@/lib/catalog-server";
import { getSession } from "@/lib/session";
import { adminClient } from "@/lib/supabase/admin";
import { buildTariffTemplateCsv } from "@/lib/tariff-csv";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session?.role !== "admin") return Response.json({ error: "No autorizado" }, { status: 403 });
  const { id } = await params;
  const db = adminClient();
  const { data: tariff } = await db.from("tariffs").select("name").eq("id", id).maybeSingle();
  if (!tariff) return Response.json({ error: "No encontrada" }, { status: 404 });

  const prices = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("tariff_prices").select("lab_test_id, price_bs").eq("tariff_id", id).order("lab_test_id").range(from, from + 999);
    for (const row of (data ?? []) as Array<{ lab_test_id: string; price_bs: number | string }>) prices.set(row.lab_test_id, Number(row.price_bs));
    if (!data || data.length < 1000) break;
  }
  const csv = buildTariffTemplateCsv(await getCoreCatalog(), prices);
  const filename = `tarifa-${tariff.name.normalize("NFD").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").toLowerCase()}.csv`;
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` }
  });
}
