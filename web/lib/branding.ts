import "server-only";
import type { BrandForText } from "./whatsapp-text";

// Datos de marca para el PDF y el texto de WhatsApp. Se configuran en Vercel sin tocar código; los vacíos no se muestran.
export function getBranding(): BrandForText {
  return {
    name: process.env.BRAND_NAME?.trim() || "PlusMedik",
    address: process.env.BRAND_ADDRESS?.trim() || undefined,
    phone: process.env.BRAND_PHONE?.trim() || undefined,
    hours: process.env.BRAND_HOURS?.trim() || undefined,
    footerNote: process.env.BRAND_FOOTER_NOTE?.trim() || undefined
  };
}

export function quoteValidityDays(): number {
  const days = Number(process.env.QUOTE_VALIDITY_DAYS ?? 30);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
}
