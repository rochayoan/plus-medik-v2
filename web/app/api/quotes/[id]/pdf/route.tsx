import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { getBranding } from "@/lib/branding";
import { formatFolio } from "@/lib/format";
import { QuotePdf } from "@/lib/pdf/quote-pdf";
import { getQuote } from "@/lib/quotes";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Logo opcional: web/public/brand/logo.png. Sin archivo, el PDF usa el nombre de la marca como texto.
let logoPromise: Promise<Buffer | undefined> | undefined;
const loadLogo = () => (logoPromise ??= readFile(join(process.cwd(), "public", "brand", "logo.png")).catch(() => undefined));

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "No autenticado" }, { status: 401 });
  const { id } = await params;
  const quote = await getQuote(id);
  if (!quote) return Response.json({ error: "Cotización no encontrada" }, { status: 404 });

  const pdf = await renderToBuffer(<QuotePdf quote={quote} brand={getBranding()} logo={await loadLogo()} />);
  const filename = `Cotizacion-${formatFolio(quote.folio)}.pdf`;
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "private, max-age=300"
    }
  });
}
