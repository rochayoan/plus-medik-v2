"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";

export interface OrgFormState {
  error?: string;
  ok?: boolean;
}

const tariffField = z.union([z.literal(""), z.guid()]).transform((value) => value || null);

export async function createOrganization(_previous: OrgFormState, formData: FormData): Promise<OrgFormState> {
  await requireAdmin();
  const parsed = z.object({
    name: z.string().trim().min(1).max(160),
    kind: z.enum(["convenio", "clinica", "medico"]),
    tariffId: tariffField
  }).safeParse({ name: formData.get("name"), kind: formData.get("kind"), tariffId: formData.get("tariffId") ?? "" });
  if (!parsed.success) return { error: "Revisa el nombre y el tipo." };
  const { error } = await adminClient().from("organizations").insert({ name: parsed.data.name, kind: parsed.data.kind, tariff_id: parsed.data.tariffId });
  if (error) return { error: "No se pudo crear la organización." };
  revalidatePath("/admin/organizaciones");
  return { ok: true };
}

export async function updateOrganization(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = z.object({ id: z.guid(), tariffId: tariffField, active: z.enum(["true", "false"]) })
    .safeParse({ id: formData.get("id"), tariffId: formData.get("tariffId") ?? "", active: formData.get("active") });
  if (!parsed.success) return;
  await adminClient().from("organizations").update({ tariff_id: parsed.data.tariffId, active: parsed.data.active === "true" }).eq("id", parsed.data.id);
  revalidatePath("/admin/organizaciones");
}
