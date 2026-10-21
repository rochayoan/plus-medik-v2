import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { publicEnv } from "../env";

// JWT enviado en el header (pruebas de carga, integraciones). Las páginas usan cookies.
export async function bearerToken(): Promise<string | undefined> {
  const authorization = (await headers()).get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

// Cliente con la identidad del usuario: todo lo que lee o escribe pasa por la RLS.
export async function createUserClient(): Promise<SupabaseClient> {
  const token = await bearerToken();
  if (token) {
    return createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  const cookieStore = await cookies();
  return createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Desde un Server Component no se pueden escribir cookies; el proxy ya refresca la sesión.
        }
      }
    }
  });
}
