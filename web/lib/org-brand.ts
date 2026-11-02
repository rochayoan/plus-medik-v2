import type { BrandForText } from "./whatsapp-text";

export interface OrgContact {
  name: string;
  address: string | null;
  phone: string | null;
  note: string | null;
}

// Si la organización cargó sus datos de contacto, la cotización sale con su encabezado;
// si no, se mantiene la marca de PlusMedik.
export function brandForOrganization(base: BrandForText, org: OrgContact | null): BrandForText {
  if (!org || !(org.address || org.phone || org.note)) return base;
  return {
    name: org.name,
    address: org.address ?? undefined,
    phone: org.phone ?? undefined,
    footerNote: org.note ?? base.footerNote
  };
}

export function brandForQuote(base: BrandForText, quote: { organizationName: string | null; organizationContact: Omit<OrgContact, "name"> | null }): BrandForText {
  return brandForOrganization(base, quote.organizationName && quote.organizationContact ? { name: quote.organizationName, ...quote.organizationContact } : null);
}
