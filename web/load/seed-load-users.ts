// Crea una organización de prueba y N usuarios para la prueba de carga, y escribe load/users.json.
// Solo para un Supabase de staging/branch: se niega a correr si no se confirma explícitamente el proyecto.
//
//   npx tsx web/load/seed-load-users.ts --url https://<staging>.supabase.co --confirm <ref-del-proyecto> --count 100
// (SUPABASE_SERVICE_ROLE_KEY del proyecto de staging en el entorno)
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index]!.replace(/^--/, ""), process.argv[index + 1] ?? "");

const url = args.get("url");
const confirm = args.get("confirm");
const count = Number(args.get("count") ?? 100);
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) throw new Error("Faltan --url y SUPABASE_SERVICE_ROLE_KEY");
const ref = new URL(url).hostname.split(".")[0];
if (confirm !== ref) throw new Error(`Para evitar accidentes, repite el ref del proyecto: --confirm ${ref}`);

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: org, error: orgError } = await db.from("organizations").insert({ name: "Prueba de carga", kind: "convenio" }).select("id").single();
if (orgError) throw orgError;

const password = `Carga-${Math.random().toString(36).slice(2, 10)}`;
const users: Array<{ email: string; password: string }> = [];
for (let index = 1; index <= count; index++) {
  const email = `carga${String(index).padStart(3, "0")}@prueba.invalid`;
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { error: profileError } = await db.from("profiles").insert({ user_id: data.user.id, organization_id: org.id, full_name: `Carga ${index}`, role: "member", must_change_password: false });
  if (profileError) throw profileError;
  users.push({ email, password });
}
const out = join(import.meta.dirname, "users.json");
await writeFile(out, JSON.stringify(users, null, 2));
console.log(`${users.length} usuarios en ${out} (organización ${org.id}). Borra la organización y sus usuarios al terminar.`);
