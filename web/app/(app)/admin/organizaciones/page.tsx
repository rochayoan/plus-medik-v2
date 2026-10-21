import type { Metadata } from "next";
import { ORGANIZATION_KINDS, requireAdmin } from "@/lib/admin";
import { adminClient } from "@/lib/supabase/admin";
import { updateOrganization } from "./actions";
import { CreateOrgForm } from "./create-org-form";

export const metadata: Metadata = { title: "Organizaciones" };
export const dynamic = "force-dynamic";

interface OrgRow {
  id: string;
  name: string;
  kind: keyof typeof ORGANIZATION_KINDS;
  tariff_id: string | null;
  active: boolean;
  profiles: Array<{ count: number }>;
}

export default async function OrganizationsPage() {
  await requireAdmin();
  const db = adminClient();
  const [{ data: orgs }, { data: tariffs }] = await Promise.all([
    db.from("organizations").select("id, name, kind, tariff_id, active, profiles(count)").order("name"),
    db.from("tariffs").select("id, name").order("name")
  ]);
  const tariffList = (tariffs ?? []) as Array<{ id: string; name: string }>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Organizaciones</h1>
      <p className="text-sm text-muted">Un médico independiente es una organización de tipo «Médico» con un solo usuario. La tarifa define los precios que ven todos sus usuarios.</p>
      <CreateOrgForm tariffs={tariffList} />
      <ul className="card divide-y divide-line">
        {((orgs ?? []) as OrgRow[]).map((org) => (
          <li key={org.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${org.active ? "" : "opacity-60"}`}>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{org.name}</p>
              <p className="text-xs text-muted">{ORGANIZATION_KINDS[org.kind]} · {org.profiles[0]?.count ?? 0} usuarios{org.active ? "" : " · desactivada"}</p>
            </div>
            <form action={updateOrganization} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={org.id} />
              <input type="hidden" name="active" value={String(org.active)} />
              <select name="tariffId" defaultValue={org.tariff_id ?? ""} className="input w-52 py-1.5" aria-label={`Tarifa de ${org.name}`}>
                <option value="">Paciente (sin tarifa)</option>
                {tariffList.map((tariff) => <option key={tariff.id} value={tariff.id}>{tariff.name}</option>)}
              </select>
              <button type="submit" className="btn-secondary min-h-10 px-3 py-1.5">Guardar</button>
            </form>
            <form action={updateOrganization}>
              <input type="hidden" name="id" value={org.id} />
              <input type="hidden" name="tariffId" value={org.tariff_id ?? ""} />
              <input type="hidden" name="active" value={String(!org.active)} />
              <button type="submit" className={org.active ? "btn-danger min-h-10 px-3 py-1.5" : "btn-secondary min-h-10 px-3 py-1.5"}>
                {org.active ? "Desactivar" : "Activar"}
              </button>
            </form>
          </li>
        ))}
        {(orgs ?? []).length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">Aún no hay organizaciones.</li> : null}
      </ul>
    </div>
  );
}
