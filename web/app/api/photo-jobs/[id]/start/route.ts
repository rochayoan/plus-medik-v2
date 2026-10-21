import { after } from "next/server";
import { runPhotoJob } from "@/lib/photo/run-job";
import { getSession } from "@/lib/session";
import { adminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// El análisis corre en after() dentro del tiempo máximo de esta función.
export const maxDuration = 300;

// Paso 2: la imagen ya está en Storage. Responde de inmediato (202) y analiza en segundo plano; el cliente consulta el estado.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const { id } = await params;

  // Transición atómica uploading -> running: un doble clic no lanza dos análisis.
  const { data: job } = await adminClient()
    .from("photo_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", session.userId)
    .eq("status", "uploading")
    .select("id, storage_path")
    .maybeSingle();
  if (!job?.storage_path) return Response.json({ error: "La foto no existe o ya se está analizando." }, { status: 409 });

  after(() => runPhotoJob({ id: job.id, storage_path: job.storage_path }));
  return Response.json({ status: "running" }, { status: 202 });
}
