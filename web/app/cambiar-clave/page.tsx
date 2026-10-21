import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Cambiar contraseña" };

export default async function ChangePasswordPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Crea tu contraseña</h1>
          <p className="mt-1 mb-5 text-sm text-muted">
            {session.mustChangePassword ? "Estás usando una contraseña temporal. Elige una propia para continuar." : "Elige una contraseña nueva."}
          </p>
          <PasswordForm />
        </div>
      </div>
    </main>
  );
}
