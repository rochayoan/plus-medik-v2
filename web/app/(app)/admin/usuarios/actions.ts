"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin, temporaryPassword } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";

export interface CreateUserState {
  error?: string;
  created?: { email: string; password: string };
}

const orgField = z.union([z.literal(""), z.guid()]).transform((value) => value || null);

// Crea la cuenta con una contraseña temporal (se muestra UNA vez para enviarla al usuario) y su perfil.
export async function createUser(_previous: CreateUserState, formData: FormData): Promise<CreateUserState> {
  await requireAdmin();
  const parsed = z.object({
    email: z.email().transform((value) => value.trim().toLowerCase()),
    fullName: z.string().trim().min(1).max(120),
    organizationId: orgField,
    role: z.enum(["member", "org_admin", "admin"])
  }).safeParse({
    email: String(formData.get("email") ?? "").trim(),
    fullName: formData.get("fullName"),
    organizationId: formData.get("organizationId") ?? "",
    role: formData.get("role")
  });
  if (!parsed.success) return { error: "Revisa el correo y el nombre." };
  const { email, fullName, organizationId, role } = parsed.data;
  if (role !== "admin" && !organizationId) return { error: "Elige la organización del usuario." };

  const db = adminClient();
  const password = temporaryPassword();
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error || !data.user) {
    return { error: error?.code === "email_exists" ? "Ya existe un usuario con ese correo." : "No se pudo crear el usuario." };
  }
  const { error: profileError } = await db.from("profiles").insert({
    user_id: data.user.id,
    organization_id: role === "admin" ? null : organizationId,
    full_name: fullName,
    role,
    must_change_password: true
  });
  if (profileError) {
    await db.auth.admin.deleteUser(data.user.id);
    return { error: "No se pudo crear el perfil del usuario." };
  }
  revalidatePath("/admin/usuarios");
  return { created: { email, password } };
}

export interface ResetState {
  password?: string;
  error?: string;
}

export async function resetPassword(_previous: ResetState, formData: FormData): Promise<ResetState> {
  await requireAdmin();
  const userId = z.guid().safeParse(formData.get("userId"));
  if (!userId.success) return { error: "Usuario inválido." };
  const db = adminClient();
  const password = temporaryPassword();
  const { error } = await db.auth.admin.updateUserById(userId.data, { password });
  if (error) return { error: "No se pudo restablecer." };
  await db.from("profiles").update({ must_change_password: true }).eq("user_id", userId.data);
  return { password };
}

// Desactivar: sin acceso a datos (RLS) y sin poder volver a ingresar (bloqueo en Auth). No se borra: sus cotizaciones quedan.
export async function setUserActive(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  const parsed = z.object({ userId: z.guid(), active: z.enum(["true", "false"]) }).safeParse({ userId: formData.get("userId"), active: formData.get("active") });
  if (!parsed.success || parsed.data.userId === session.userId) return;
  const active = parsed.data.active === "true";
  const db = adminClient();
  await db.from("profiles").update({ active }).eq("user_id", parsed.data.userId);
  await db.auth.admin.updateUserById(parsed.data.userId, { ban_duration: active ? "none" : "876000h" });
  revalidatePath("/admin/usuarios");
}

export async function updateUser(formData: FormData): Promise<void> {
  await requireAdmin();
  const parsed = z.object({
    userId: z.guid(),
    fullName: z.string().trim().min(1).max(120),
    organizationId: orgField,
    role: z.enum(["member", "org_admin", "admin"])
  }).safeParse({ userId: formData.get("userId"), fullName: formData.get("fullName"), organizationId: formData.get("organizationId") ?? "", role: formData.get("role") });
  if (!parsed.success) return;
  const { userId, fullName, organizationId, role } = parsed.data;
  if (role !== "admin" && !organizationId) return;
  await adminClient().from("profiles").update({ full_name: fullName, organization_id: organizationId, role }).eq("user_id", userId);
  revalidatePath("/admin/usuarios");
}
