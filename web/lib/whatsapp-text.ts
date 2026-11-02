import { formatBs, formatDate, formatFolio } from "./format";
import { splitStudyName } from "./study-name";

export interface QuoteForText {
  folio: number;
  patientName: string | null;
  createdAt: string;
  validUntil: string;
  totalBs: number;
  items: Array<{ name: string; priceBs: number }>;
}

export interface BrandForText {
  name: string;
  address?: string;
  phone?: string;
  hours?: string;
  footerNote?: string;
}

// Texto listo para pegar en el chat de WhatsApp del paciente (*negritas* y viñetas de WhatsApp).
export function buildWhatsAppText(quote: QuoteForText, brand: BrandForText): string {
  const lines = [`*Cotización ${brand.name} N° ${formatFolio(quote.folio)}*`];
  if (quote.patientName) lines.push(`Paciente: ${quote.patientName}`);
  lines.push(`Fecha: ${formatDate(quote.createdAt)} · Válida hasta: ${formatDate(quote.validUntil)}`, "");
  for (const item of quote.items) lines.push(`• ${splitStudyName(item.name).title} — ${formatBs(item.priceBs)}`);
  lines.push("", `*Total: ${formatBs(quote.totalBs)}*`);
  const contact = [brand.address && `📍 ${brand.address}`, brand.hours && `🕒 ${brand.hours}`, brand.phone && `📞 ${brand.phone}`].filter(Boolean) as string[];
  if (contact.length > 0) lines.push("", ...contact);
  if (brand.footerNote) lines.push("", brand.footerNote);
  return lines.join("\n");
}
