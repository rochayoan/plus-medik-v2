import "server-only";
import { randomInt } from "node:crypto";
import { getSession, type SessionContext } from "./session";

// Toda acción de administración vuelve a verificar el rol: las server actions se pueden invocar directamente.
export async function requireAdmin(): Promise<SessionContext> {
  const session = await getSession();
  if (!session || session.role !== "admin") throw new Error("No autorizado");
  return session;
}

// Contraseña temporal legible para dictar o enviar por WhatsApp (sin 0/O, 1/l/I). El usuario la cambia al primer ingreso.
export function temporaryPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (alphabet: string, count: number) => Array.from({ length: count }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${pick(letters, 4).toUpperCase()}-${pick(digits, 4)}-${pick(letters, 4)}`;
}

export const ORGANIZATION_KINDS = { convenio: "Convenio", clinica: "Clínica", medico: "Médico" } as const;
export const ROLES = { member: "Usuario", org_admin: "Responsable de organización", admin: "Administrador PlusMedik" } as const;
