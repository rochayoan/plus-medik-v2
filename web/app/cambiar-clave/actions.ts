"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { createUserClient } from "@/lib/supabase/server";

export interface PasswordState {
  error?: string;
}

export async function changePassword(_previous: PasswordState, formData: FormData): Promise<PasswordState> {
  const session = await getSession();
  if (!session) redirect("/login");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 8) return { error: "La contraseña debe tener al menos 8 caracteres." };
  if (password !== confirm) return { error: "Las contraseñas no coinciden." };

  const supabase = await createUserClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "same_password") return { error: "Elige una contraseña distinta a la temporal." };
    if (error.code === "weak_password") return { error: "La contraseña es muy débil: combina letras y números." };
    return { error: "No se pudo cambiar la contraseña. Intenta de nuevo." };
  }
  await supabase.rpc("mark_password_changed");
  redirect("/cotizar");
}
