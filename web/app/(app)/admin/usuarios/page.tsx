import type { Metadata } from "next";
import { requireAdmin, ROLES } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";
import { setUserActive, updateUser } from "./actions";
import { CreateUserForm, ResetPasswordButton } from "./user-forms";

export const metadata: Metadata = { title: "Usuarios" };
export const dynamic = "force-dynamic";

interface ProfileRow {
  user_id: string;
  full_name: string;
  role: keyof typeof ROLES;
  active: boolean;
  must_change_password: boolean;
  organization_id: string | null;
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const session = await requireAdmin();
  const { org: orgFilter = "" } = await searchParams;
  const db = adminClient();

  const emails = new Map<string, { email: string; lastSignIn: string | null }>();
  for (let page = 1; ; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    for (const user of data?.users ?? []) emails.set(user.id, { email: user.email ?? "", lastSignIn: user.last_sign_in_at ?? null });
    if (!data || data.users.length < 1000) break;
  }
  const [{ data: profiles }, { data: orgs }] = await Promise.all([
    db.from("profiles").select("user_id, full_name, role, active, must_change_password, organization_id").order("full_name"),
    db.from("organizations").select("id, name").order("name")
  ]);
  const organizations = (orgs ?? []) as Array<{ id: string; name: string }>;
  const orgName = new Map(organizations.map((org) => [org.id, org.name]));
  const rows = ((profiles ?? []) as ProfileRow[]).filter((row) => !orgFilter || row.organization_id === orgFilter);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Usuarios</h1>
      <CreateUserForm organizations={organizations} />

      <form className="flex items-center gap-2">
        <label htmlFor="org-filter" className="text-sm text-muted">Filtrar:</label>
        <select id="org-filter" name="org" defaultValue={orgFilter} className="input w-64 py-1.5">
          <option value="">Todas las organizaciones</option>
          {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
        <button type="submit" className="btn-secondary min-h-10 px-3 py-1.5">Aplicar</button>
      </form>

      <ul className="card divide-y divide-line">
        {rows.map((row) => {
          const auth = emails.get(row.user_id);
          return (
            <li key={row.user_id} className={`space-y-2 px-4 py-3 ${row.active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{row.full_name || "(sin nombre)"} <span className="font-normal text-muted">· {auth?.email}</span></p>
                  <p className="text-xs text-muted">
                    {row.organization_id ? orgName.get(row.organization_id) : "PlusMedik"} · {ROLES[row.role]}
                    {row.must_change_password ? " · contraseña temporal" : ""}
                    {auth?.lastSignIn ? ` · último ingreso ${new Date(auth.lastSignIn).toLocaleDateString("es-BO")}` : " · nunca ingresó"}
                    {row.active ? "" : " · DESACTIVADO"}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <ResetPasswordButton userId={row.user_id} />
                  {row.user_id !== session.userId ? (
                    <form action={setUserActive}>
                      <input type="hidden" name="userId" value={row.user_id} />
                      <input type="hidden" name="active" value={String(!row.active)} />
                      <button type="submit" className={`${row.active ? "btn-danger" : "btn-secondary"} min-h-9 px-3 py-1.5 text-xs`}>{row.active ? "Desactivar" : "Activar"}</button>
                    </form>
                  ) : null}
                </div>
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-brand-700">Editar</summary>
                <form action={updateUser} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <input type="hidden" name="userId" value={row.user_id} />
                  <input name="fullName" defaultValue={row.full_name} required maxLength={120} className="input py-1.5" aria-label="Nombre" />
                  <select name="organizationId" defaultValue={row.organization_id ?? ""} className="input py-1.5" aria-label="Organización">
                    <option value="">PlusMedik (solo administradores)</option>
                    {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                  </select>
                  <select name="role" defaultValue={row.role} className="input py-1.5" aria-label="Rol">
                    {Object.entries(ROLES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <button type="submit" className="btn-secondary min-h-10 px-3 py-1.5">Guardar</button>
                </form>
              </details>
            </li>
          );
        })}
        {rows.length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">No hay usuarios.</li> : null}
      </ul>
    </div>
  );
}
