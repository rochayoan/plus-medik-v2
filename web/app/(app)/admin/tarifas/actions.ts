"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getCoreCatalog, invalidateCatalogCache } from "@/lib/catalog-server";
import { adminClient } from "@/lib/supabase/admin";
import { matchTariffRows, parseTariffCsv, type TariffMatch } from "@/lib/tariff-csv";

export interface CreateTariffState {
  error?: string;
}

export async function createTariff(_previous: CreateTariffState, formData: FormData): Promise<CreateTariffState> {
  await requireAdmin();
  const name = z.string().trim().min(1).max(120).safeParse(formData.get("name"));
  if (!name.success) return { error: "Escribe un nombre." };
  const { error } = await adminClient().from("tariffs").insert({ name: name.data });
  if (error) return { error: error.code === "23505" ? "Ya existe una tarifa con ese nombre." : "No se pudo crear la tarifa." };
  revalidatePath("/admin/tarifas");
  return {};
}

export interface ImportState {
  error?: string;
  csv?: string;
  preview?: {
    matched: number;
    // Muestra para revisar antes de aplicar: precio Paciente vs. precio nuevo.
    sample: Array<{ line: number; name: string; patientPrice: number; price: number }>;
    unmatched: TariffMatch["unmatched"];
    errors: Array<{ line: number; message: string }>;
    skipped: number;
  };
  applied?: { count: number; replaced: boolean };
}

async function analyzeCsv(csv: string) {
  const parsed = parseTariffCsv(csv);
  const catalog = await getCoreCatalog();
  const match = matchTariffRows(parsed.rows, catalog.map((study) => ({ id: study.id, code: study.code, name: study.name, normalizedName: study.normalizedName })));
  return { parsed, match, catalog };
}

// Dos pasos: primero vista previa (nada cambia), luego aplicar el MISMO archivo, que se vuelve a validar en el servidor.
export async function importTariff(previous: ImportState, formData: FormData): Promise<ImportState> {
  await requireAdmin();
  const tariffId = z.guid().safeParse(formData.get("tariffId"));
  if (!tariffId.success) return { error: "Tarifa inválida." };
  const intent = formData.get("intent");

  if (intent === "apply") {
    const csv = String(formData.get("csv") ?? "");
    if (!csv) return { error: "Primero carga el archivo." };
    const { parsed, match } = await analyzeCsv(csv);
    if (parsed.errors.length > 0 && parsed.rows.length === 0) return { error: "El archivo no tiene filas válidas." };
    const replace = formData.get("replace") === "on";
    const prices = match.matched.map((row) => ({ lab_test_id: row.labTestId, price_bs: row.price }));
    const { data, error } = await adminClient().rpc("admin_set_tariff_prices", { p_tariff_id: tariffId.data, p_prices: prices, p_replace: replace });
    if (error) return { ...previous, error: "No se pudieron guardar los precios." };
    invalidateCatalogCache();
    revalidatePath(`/admin/tarifas/${tariffId.data}`);
    revalidatePath("/admin/tarifas");
    return { applied: { count: Number(data ?? prices.length), replaced: replace } };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Elige un archivo CSV." };
  if (file.size > 2_000_000) return { error: "El archivo es muy grande (máximo 2 MB)." };
  const csv = await file.text();
  const { parsed, match, catalog } = await analyzeCsv(csv);
  if (parsed.rows.length === 0) return { error: parsed.errors[0]?.message ?? "El archivo no tiene filas con precio." };
  const patientPrice = new Map(catalog.map((study) => [study.id, study.priceBs]));
  return {
    csv,
    preview: {
      matched: match.matched.length,
      sample: match.matched.slice(0, 15).map((row) => ({ line: row.line, name: row.name, patientPrice: patientPrice.get(row.labTestId) ?? 0, price: row.price })),
      unmatched: match.unmatched,
      errors: parsed.errors,
      skipped: parsed.skipped
    }
  };
}
