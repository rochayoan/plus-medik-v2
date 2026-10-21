import Link from "next/link";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";

const TABS = [
  { href: "/admin", label: "Monitoreo" },
  { href: "/admin/organizaciones", label: "Organizaciones" },
  { href: "/admin/usuarios", label: "Usuarios" },
  { href: "/admin/tarifas", label: "Tarifas" }
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session?.role !== "admin") notFound();
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line" aria-label="Administración">
        {TABS.map((tab) => (
          <Link key={tab.href} href={tab.href} className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink">
            {tab.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
