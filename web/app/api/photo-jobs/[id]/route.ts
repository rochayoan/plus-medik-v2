import { getSession } from "@/lib/session";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Estado del análisis (RLS: cada usuario solo ve sus fotos).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const { id } = await params;
  const { data } = await (await createUserClient())
    .from("photo_jobs")
    .select("id, status, decision, result, error")
    .eq("id", id)
    .maybeSingle();
  if (!data) return Response.json({ error: "No encontrado" }, { status: 404 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
