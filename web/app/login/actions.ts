"use server";

import { redirect } from "next/navigation";
import { createUserClient } from "@/lib/supabase/server";

export interface LoginState {
  error?: string;
  email?: string;
}

// Solo rutas internas: evita redirecciones abiertas con ?next=https://...
const safeNext = (value: FormDataEntryValue | null): string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/cotizar";

export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Ingresa tu correo y contraseña.", email };

  const supabase = await createUserClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "user_banned") return { error: "Tu cuenta está desactivada. Comunícate con PlusMedik.", email };
    if (error.status === 429) return { error: "Demasiados intentos. Espera un minuto y vuelve a intentar.", email };
    return { error: "Correo o contraseña incorrectos.", email };
  }
  redirect(safeNext(formData.get("next")));
}
