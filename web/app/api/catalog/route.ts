import { getCatalogPayload } from "@/lib/catalog-server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Catálogo con la tarifa del usuario. El navegador lo guarda en IndexedDB y solo revalida con ETag (304 sin cuerpo).
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });

  const payload = await getCatalogPayload(session.organization?.tariffId ?? null, session.organization?.tariffName ?? "Paciente");
  const etag = `"${payload.version}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache", Vary: "Cookie, Authorization" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return Response.json(payload, { headers });
}
