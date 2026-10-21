import { Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Tarifa" };
export const dynamic = "force-dynamic";

export default async function TariffPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = adminClient();
  const [{ data: tariff }, { count }, { data: orgs }] = await Promise.all([
    db.from("tariffs").select("id, name").eq("id", id).maybeSingle(),
    db.from("tariff_prices").select("lab_test_id", { count: "exact", head: true }).eq("tariff_id", id),
    db.from("organizations").select("name").eq("tariff_id", id).order("name")
  ]);
  if (!tariff) notFound();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/tarifas" className="text-sm text-brand-700">← Tarifas</Link>
        <h1 className="mt-1 text-xl font-bold">{tariff.name}</h1>
        <p className="text-sm text-muted">
          {count ?? 0} precios propios · Usada por: {(orgs ?? []).map((org) => org.name).join(", ") || "ninguna organización"}
        </p>
      </div>
      <a href={`/api/admin/tarifas/${id}/csv`} className="btn-secondary">
        <Download className="size-4" aria-hidden /> Descargar plantilla con todos los estudios
      </a>
      <ImportForm tariffId={id} />
    </div>
  );
}
