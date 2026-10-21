"use client";

import { Check, Copy, Download, Eye, LoaderCircle, MessageCircle, Share2 } from "lucide-react";
import { useEffect, useState } from "react";

interface QuoteActionsProps {
  quoteId: string;
  folio: string;
  whatsappText: string;
}

export function QuoteActions({ quoteId, folio, whatsappText }: QuoteActionsProps) {
  const [copied, setCopied] = useState(false);
  const [canShareFiles, setCanShareFiles] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pdfUrl = `/api/quotes/${quoteId}/pdf`;

  useEffect(() => {
    // Compartir archivos (PDF directo al chat) solo existe en celulares con Web Share nivel 2.
    try {
      const probe = new File([""], "x.pdf", { type: "application/pdf" });
      setCanShareFiles(typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }));
    } catch {
      setCanShareFiles(false);
    }
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(whatsappText);
    } catch {
      // Navegadores sin API de portapapeles: selección manual.
      const area = document.createElement("textarea");
      area.value = whatsappText;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const sharePdf = async () => {
    setSharing(true);
    setError(null);
    try {
      const response = await fetch(pdfUrl);
      if (!response.ok) throw new Error();
      const file = new File([await response.blob()], `Cotizacion-${folio}.pdf`, { type: "application/pdf" });
      await navigator.share({ files: [file], title: `Cotización ${folio}` });
    } catch (shareError) {
      if ((shareError as Error)?.name !== "AbortError") setError("No se pudo compartir el PDF. Descárgalo y envíalo manualmente.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <section className="card p-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <button type="button" onClick={() => void copy()} className="btn-primary">
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? "¡Copiado!" : "Copiar texto"}
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(whatsappText)}`} target="_blank" rel="noopener noreferrer" className="btn-secondary">
          <MessageCircle className="size-4" aria-hidden /> Abrir WhatsApp
        </a>
        <a href={pdfUrl} className="btn-secondary" download>
          <Download className="size-4" aria-hidden /> Descargar PDF
        </a>
        {canShareFiles ? (
          <button type="button" onClick={() => void sharePdf()} className="btn-secondary" disabled={sharing}>
            {sharing ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Share2 className="size-4" aria-hidden />} Enviar PDF
          </button>
        ) : (
          <a href={`${pdfUrl}?inline=1`} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            <Eye className="size-4" aria-hidden /> Ver PDF
          </a>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">«Copiar texto» deja el mensaje listo para pegar en el chat del paciente.</p>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    </section>
  );
}
