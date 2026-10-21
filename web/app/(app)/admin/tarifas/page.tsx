import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";
import { CreateTariffForm } from "./create-tariff-form";

export const metadata: Metadata = { title: "Tarifas" };
export const dynamic = "force-dynamic";

interface TariffRow {
  id: string;
  name: string;
  tariff_prices: Array<{ count: number }>;
  organizations: Array<{ count: number }>;
}

export default async function TariffsPage() {
  await requireAdmin();
  const { data } = await adminClient().from("tariffs").select("id, name, tariff_prices(count), organizations(count)").order("name");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Tarifas</h1>
      <p className="text-sm text-muted">Cada tarifa guarda solo los precios distintos al precio Paciente. Los estudios sin precio en la tarifa se cotizan a precio Paciente.</p>
      <CreateTariffForm />
      <ul className="card divide-y divide-line">
        {((data ?? []) as TariffRow[]).map((tariff) => (
          <li key={tariff.id}>
            <Link href={`/admin/tarifas/${tariff.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{tariff.name}</p>
                <p className="text-xs text-muted">{tariff.tariff_prices[0]?.count ?? 0} precios propios · {tariff.organizations[0]?.count ?? 0} organizaciones</p>
              </div>
              <ChevronRight className="size-4 text-muted" aria-hidden />
            </Link>
          </li>
        ))}
        {(data ?? []).length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">Aún no hay tarifas.</li> : null}
      </ul>
    </div>
  );
}
