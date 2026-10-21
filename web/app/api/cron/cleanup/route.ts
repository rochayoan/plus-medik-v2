import { PHOTO_BUCKET } from "@/lib/photo/run-job";
import { adminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const RETENTION_DAYS = Number(process.env.PHOTO_RETENTION_DAYS ?? 30);

// Cron diario (vercel.json): las fotos de órdenes son datos clínicos y no se guardan más de lo necesario.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }
  const db = adminClient();
  const now = Date.now();

  // Trabajos colgados (la función murió a mitad del análisis o la subida nunca terminó).
  await db.from("photo_jobs")
    .update({ status: "failed", error: "El análisis no terminó a tiempo. Intenta de nuevo.", finished_at: new Date().toISOString() })
    .eq("status", "running")
    .lt("started_at", new Date(now - 10 * 60_000).toISOString());
  await db.from("photo_jobs")
    .update({ status: "failed", error: "La subida no se completó.", finished_at: new Date().toISOString() })
    .eq("status", "uploading")
    .lt("created_at", new Date(now - 86_400_000).toISOString());

  let removed = 0;
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
  for (let batch = 0; batch < 20; batch++) {
    const { data: jobs, error } = await db.from("photo_jobs")
      .select("id, storage_path")
      .not("storage_path", "is", null)
      .lt("created_at", cutoff)
      .limit(500);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!jobs || jobs.length === 0) break;
    const { error: removeError } = await db.storage.from(PHOTO_BUCKET).remove(jobs.map((job) => job.storage_path as string));
    if (removeError) return Response.json({ error: removeError.message, removed }, { status: 500 });
    await db.from("photo_jobs").update({ storage_path: null }).in("id", jobs.map((job) => job.id));
    removed += jobs.length;
  }
  return Response.json({ ok: true, removedPhotos: removed });
}
