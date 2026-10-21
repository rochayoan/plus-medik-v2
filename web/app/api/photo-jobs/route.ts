import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PHOTO_BUCKET } from "@/lib/photo/run-job";
import { getSession } from "@/lib/session";
import { adminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DAILY_LIMIT = Number(process.env.PHOTO_DAILY_LIMIT ?? 40);
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const body = z.object({ mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]) });

// Paso 1: reserva el trabajo y entrega una URL firmada para subir la imagen DIRECTO a Storage (sin pasar por Vercel).
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Formato de imagen no soportado: usa JPG, PNG o WEBP." }, { status: 400 });

  const db = adminClient();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const [daily, running] = await Promise.all([
    db.from("photo_jobs").select("id", { count: "exact", head: true }).eq("user_id", session.userId).gte("created_at", dayAgo),
    db.from("photo_jobs").select("id", { count: "exact", head: true }).eq("user_id", session.userId).eq("status", "running").gte("started_at", fiveMinutesAgo)
  ]);
  if ((running.count ?? 0) > 0) {
    return Response.json({ error: "Ya hay una foto analizándose. Espera a que termine." }, { status: 429 });
  }
  if ((daily.count ?? 0) >= DAILY_LIMIT) {
    return Response.json({ error: `Llegaste al límite de ${DAILY_LIMIT} fotos por día. Usa el buscador o pegar lista.` }, { status: 429 });
  }

  const id = randomUUID();
  const path = `${session.organization?.id ?? "plusmedik"}/${session.userId}/${id}.${EXTENSIONS[parsed.data.mimeType]}`;
  const { error: insertError } = await db.from("photo_jobs").insert({
    id,
    user_id: session.userId,
    organization_id: session.organization?.id ?? null,
    storage_path: path,
    status: "uploading"
  });
  if (insertError) return Response.json({ error: "No se pudo iniciar la subida." }, { status: 500 });

  const { data: signed, error: signError } = await db.storage.from(PHOTO_BUCKET).createSignedUploadUrl(path);
  if (signError || !signed) return Response.json({ error: "No se pudo iniciar la subida." }, { status: 500 });
  return Response.json({ jobId: id, path: signed.path, token: signed.token });
}
