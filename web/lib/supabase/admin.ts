import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "../env";

// Service role: ignora la RLS. Solo en el servidor y solo después de verificar quién llama.
let client: SupabaseClient | undefined;

export function adminClient(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY (ver web/.env.example)");
  client ??= createClient(publicEnv.supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
