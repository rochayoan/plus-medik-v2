import "server-only";
import { cache } from "react";
import { bearerToken, createUserClient } from "./supabase/server";

export type Role = "member" | "org_admin" | "admin";

export interface SessionContext {
  userId: string;
  email: string | null;
  fullName: string;
  role: Role;
  mustChangePassword: boolean;
  organization: { id: string; name: string; kind: string; tariffId: string | null; tariffName: string } | null;
}

interface ProfileRow {
  full_name: string;
  role: Role;
  active: boolean;
  must_change_password: boolean;
  organization: { id: string; name: string; kind: string; active: boolean; tariff_id: string | null; tariff: { name: string } | null } | null;
}

// Usuario actual + perfil + organización + tarifa, en UNA consulta y una vez por petición.
// null si no hay sesión válida, el perfil está inactivo o la organización está cerrada.
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createUserClient();
  const { data: claimsData, error } = await supabase.auth.getClaims(await bearerToken());
  const claims = claimsData?.claims;
  if (error || !claims?.sub) return null;

  const { data } = await supabase
    .from("profiles")
    .select("full_name, role, active, must_change_password, organization:organizations(id, name, kind, active, tariff_id, tariff:tariffs(name))")
    .eq("user_id", claims.sub)
    .maybeSingle();
  const profile = data as ProfileRow | null;
  if (!profile?.active) return null;
  const org = profile.organization;
  if (profile.role !== "admin" && (!org || !org.active)) return null;

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    fullName: profile.full_name,
    role: profile.role,
    mustChangePassword: profile.must_change_password,
    organization: org && {
      id: org.id,
      name: org.name,
      kind: org.kind,
      tariffId: org.tariff_id,
      tariffName: org.tariff?.name ?? "Paciente"
    }
  };
});
