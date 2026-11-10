import { MAX_QUOTE_MESSAGE_CHARS } from "./quote-preparation.js";
import type { CatalogStudy } from "./types.js";

// Tiempo de entrega por estudio en la cotización. La fuente es la que ya usa el catálogo (lab_tests.notes: «Preparacion: … | Tiempo de entrega: 3 dias»), la misma lista de estudios y precios
// del laboratorio. Es texto del laboratorio mostrado TAL CUAL (solo se acentúa «dias»/«dia»): no se calcula, no se convierte y no se promete nada más. Un estudio sin dato no se menciona.
const FOOTER = "\n\nRespóndenos por este chat para continuar. 😊";

// «Tiempo de entrega: 3 dias» dentro de las notas del catálogo.
export function parseTurnaround(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const match = /tiempo de entrega\s*:\s*([^|\n]+)/i.exec(notes);
  const raw = match?.[1]?.trim().replace(/\s+/g, " ").replace(/[.;]+$/, "");
  if (!raw || raw.length > 60) return null;
  const shown = raw.replace(/\bdias\b/gi, "días").replace(/\bdia\b/gi, "día");
  return shown.charAt(0).toUpperCase() + shown.slice(1);
}

export function appendQuoteTurnaround(quote: string, studyIds: readonly string[], catalog: readonly CatalogStudy[]): string {
  const groups = new Map<string, string[]>();
  for (const id of new Set(studyIds)) {
    const study = catalog.find((item) => item.id === id && item.active);
    const label = study?.turnaroundText?.trim();
    if (!study || !label) continue;
    groups.set(label, [...(groups.get(label) ?? []), study.name]);
  }
  if (groups.size === 0) return quote;
  const lines = [...groups.entries()].map(([label, names]) => `▫️ *${names.join(" / ")}*: ${label}`);
  const section = ["⏱️ *TIEMPO DE ENTREGA*", "", ...lines].join("\n");
  const hasFooter = quote.endsWith(FOOTER);
  const base = hasFooter ? quote.slice(0, -FOOTER.length) : quote;
  const combined = `${base}\n\n${section}${hasFooter ? FOOTER : ""}`;
  // Nunca se parte una cotización en dos mensajes: si no cabe, sale como estaba.
  return combined.length > MAX_QUOTE_MESSAGE_CHARS ? quote : combined;
}
