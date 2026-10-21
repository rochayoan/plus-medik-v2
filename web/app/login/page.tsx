import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Ingresar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-2xl font-bold text-brand-600">PlusMedik</p>
          <h1 className="mt-1 text-sm text-muted">Cotizador para convenios, clínicas y médicos</h1>
        </div>
        <div className="card p-6 shadow-sm">
          <LoginForm next={next} />
        </div>
        <p className="mt-6 text-center text-xs text-muted">¿No tienes acceso o olvidaste tu contraseña? Comunícate con PlusMedik.</p>
      </div>
    </main>
  );
}
