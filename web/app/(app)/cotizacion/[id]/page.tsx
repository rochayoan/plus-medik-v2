import { Repeat } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getBranding } from "@/lib/branding";
import { formatBs, formatDate, formatFolio } from "@/lib/format";
import { getQuote } from "@/lib/quotes";
import { buildWhatsAppText } from "@/lib/whatsapp-text";
import { QuoteActions } from "./quote-actions";

export const metadata: Metadata = { title: "Cotización" };

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const quote = await getQuote(id);
  if (!quote) notFound();

  const text = buildWhatsAppText(
    { folio: quote.folio, patientName: quote.patientName, createdAt: quote.createdAt, validUntil: quote.validUntil, totalBs: quote.totalBs, items: quote.items },
    getBranding()
  );

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm text-muted">Cotización</p>
          <h1 className="text-2xl font-bold">{formatFolio(quote.folio)}</h1>
        </div>
        <div className="text-right text-sm text-muted">
          <p>{formatDate(quote.createdAt)} · válida hasta {formatDate(quote.validUntil)}</p>
          <p>Tarifa {quote.tariffName}{quote.patientName ? ` · ${quote.patientName}` : ""}</p>
        </div>
      </div>

      <QuoteActions quoteId={quote.id} folio={formatFolio(quote.folio)} whatsappText={text} />

      <section className="card overflow-hidden">
        <ul className="divide-y divide-line">
          {quote.items.map((item, index) => (
            <li key={item.labTestId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-5 text-xs text-muted tabular-nums">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p>{item.name}</p>
                {item.sampleType || item.code ? <p className="text-xs text-muted">{[item.code && `Cód. ${item.code}`, item.sampleType].filter(Boolean).join(" · ")}</p> : null}
              </div>
              <span className="tabular-nums">{formatBs(item.priceBs)}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t border-line bg-surface px-4 py-3">
          <span className="font-medium">Total</span>
          <span className="text-xl font-bold tabular-nums">{formatBs(quote.totalBs)}</span>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">Vista previa del mensaje de WhatsApp</h2>
        <pre className="rounded-lg bg-surface p-3 font-sans text-sm whitespace-pre-wrap">{text}</pre>
      </section>

      <div className="flex flex-wrap gap-2">
        <Link href="/cotizar" className="btn-primary">Nueva cotización</Link>
        <Link href={`/cotizar?repetir=${quote.id}`} className="btn-secondary">
          <Repeat className="size-4" aria-hidden /> Repetir estos estudios
        </Link>
      </div>
    </main>
  );
}
