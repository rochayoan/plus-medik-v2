import { History, LogOut, Plus, Shield } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.mustChangePassword) redirect("/cambiar-clave");

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href="/cotizar" className="text-lg font-bold text-brand-600">PlusMedik</Link>
          <div className="hidden min-w-0 flex-1 truncate text-sm text-muted sm:block">
            {session.organization ? `${session.organization.name} · Tarifa ${session.organization.tariffName}` : "Personal PlusMedik · Tarifa Paciente"}
          </div>
          <nav className="ml-auto flex items-center gap-1">
            <Link href="/cotizar" className="btn-ghost px-3" title="Nueva cotización">
              <Plus className="size-4" aria-hidden /><span className="hidden md:inline">Cotizar</span>
            </Link>
            <Link href="/historial" className="btn-ghost px-3" title="Historial">
              <History className="size-4" aria-hidden /><span className="hidden md:inline">Historial</span>
            </Link>
            {session.role === "admin" ? (
              <Link href="/admin" className="btn-ghost px-3" title="Administración">
                <Shield className="size-4" aria-hidden /><span className="hidden md:inline">Admin</span>
              </Link>
            ) : null}
            <form action={signOut}>
              <button type="submit" className="btn-ghost px-3" title={`Salir (${session.fullName || session.email || ""})`}>
                <LogOut className="size-4" aria-hidden /><span className="sr-only">Salir</span>
              </button>
            </form>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
