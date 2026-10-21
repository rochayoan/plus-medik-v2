import "server-only";
import { createUserClient } from "./supabase/server";

export interface QuoteDetail {
  id: string;
  folio: number;
  patientName: string | null;
  tariffName: string;
  totalBs: number;
  source: string;
  validUntil: string;
  createdAt: string;
  organizationName: string | null;
  createdByName: string | null;
  items: Array<{ labTestId: string; code: string | null; name: string; sampleType: string | null; priceBs: number }>;
}

interface QuoteRow {
  id: string;
  folio: number;
  patient_name: string | null;
  tariff_name: string;
  total_bs: number | string;
  source: string;
  valid_until: string;
  created_at: string;
  organization: { name: string } | null;
  creator: { full_name: string } | null;
  items: Array<{ position: number; lab_test_id: string; code: string | null; name: string; sample_type: string | null; price_bs: number | string }>;
}

// Una cotización con sus ítems (copias congeladas). La RLS decide si el usuario puede verla.
export async function getQuote(id: string): Promise<QuoteDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await (await createUserClient())
    .from("quotes")
    .select("id, folio, patient_name, tariff_name, total_bs, source, valid_until, created_at, organization:organizations(name), creator:profiles(full_name), items:quote_items(position, lab_test_id, code, name, sample_type, price_bs)")
    .eq("id", id)
    .maybeSingle();
  const row = data as QuoteRow | null;
  if (!row) return null;
  return {
    id: row.id,
    folio: row.folio,
    patientName: row.patient_name,
    tariffName: row.tariff_name,
    totalBs: Number(row.total_bs),
    source: row.source,
    validUntil: row.valid_until,
    createdAt: row.created_at,
    organizationName: row.organization?.name ?? null,
    createdByName: row.creator?.full_name ?? null,
    items: [...row.items]
      .sort((a, b) => a.position - b.position)
      .map((item) => ({ labTestId: item.lab_test_id, code: item.code, name: item.name, sampleType: item.sample_type, priceBs: Number(item.price_bs) }))
  };
}
