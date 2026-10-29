import { fold } from "./text-normalize.js";

// Datos comerciales del laboratorio que el modelo puede usar para conversar (G5.6). Salen de UN solo módulo editable (BUSINESS_DATA en src/system-prompt.ts), que se importa como código (sin archivos ni generación). Este módulo es PURO: decide qué secciones están disponibles AHORA (confirmadas y vigentes) y ofrece la verificación de que una respuesta del modelo
// no afirma nada que no esté en esos datos (cifras, horarios, teléfonos, enlaces, días y temas).
//
// Lo que este módulo NO conoce, a propósito: precios, estudios, preparación clínica, tipo de muestra, tiempos de entrega y derivaciones. Eso sale siempre de Supabase y lo hace el backend.

export const DATA_SECTION_IDS = ["NEGOCIO", "SUCURSALES", "HORARIOS", "TELEFONOS", "SERVICIOS", "METODOS_DE_PAGO", "POLITICAS"] as const;
export type DataSectionId = (typeof DATA_SECTION_IDS)[number];
export const SECTION_TITLES: Record<DataSectionId, string> = {
  NEGOCIO: "Datos del negocio",
  SUCURSALES: "Sucursales y direcciones",
  HORARIOS: "Horarios de atención",
  TELEFONOS: "Teléfonos y contacto",
  SERVICIOS: "Servicios",
  METODOS_DE_PAGO: "Métodos de pago",
  POLITICAS: "Políticas"
};

export interface DataSection {
  id: DataSectionId;
  title: string;
  status: "CONFIRMED" | "PENDING";
  // Código del documento donde consta el dato (solo CONFIRMED).
  source: string | null;
  // Último día de vigencia, AAAA-MM-DD (solo CONFIRMED). Pasado ese día el dato deja de usarse.
  validUntil: string | null;
  // Los datos, una línea por dato (solo CONFIRMED; vacío si está pendiente).
  text: string;
}

// ───────────────────────────── qué se puede usar ahora ─────────────────────────────

export type MissingReason = "PENDING" | "EXPIRED";
export interface FactsContext {
  // Texto (con títulos) de las secciones disponibles, normalizado: sirve para comprobar que una palabra del modelo está respaldada.
  folded: string;
  // Cifras, horarios, teléfonos, enlaces, correos y días que aparecen en esos datos.
  tokens: ReadonlySet<string>;
}
export interface FactsView {
  // Bloque que reemplaza a {{DATOS}} en el prompt.
  block: string;
  included: DataSectionId[];
  missing: Array<{ id: DataSectionId; reason: MissingReason }>;
  // Ausente si no hay ninguna sección disponible.
  context: FactsContext | undefined;
}

const endOfDay = (day: string): number => Date.parse(`${day}T23:59:59.000Z`);

// Una sección se usa solo si está CONFIRMADA y su vigencia no venció. Se evalúa al usar el dato (no al generar el código).
export function availableSections(sections: readonly DataSection[], now: Date): { usable: DataSection[]; missing: FactsView["missing"] } {
  const usable: DataSection[] = [];
  const missing: FactsView["missing"] = [];
  for (const section of sections) {
    if (section.status !== "CONFIRMED" || section.text.trim() === "") missing.push({ id: section.id, reason: "PENDING" });
    else if (!section.validUntil || !(endOfDay(section.validUntil) >= now.getTime())) missing.push({ id: section.id, reason: "EXPIRED" });
    else usable.push(section);
  }
  return { usable, missing };
}

export const NO_DATA_BLOCK = "(No hay datos del laboratorio disponibles en esta conversación: no menciones ninguno y, si te preguntan por ellos, clasifica INFO_REQUEST con el \"reply\" vacío.)";

export function renderFacts(sections: readonly DataSection[], now: Date): FactsView {
  const { usable, missing } = availableSections(sections, now);
  if (usable.length === 0) return { block: NO_DATA_BLOCK, included: [], missing, context: undefined };
  const parts = usable.map((section) => `[${section.title} — vigente hasta ${section.validUntil}]\n${section.text}`);
  const absent = missing.length > 0 ? `\n\nSin dato confirmado o vigente (de esto no sabes nada; no lo inventes): ${missing.map((item) => SECTION_TITLES[item.id]).join(", ")}.` : "";
  const grounding = usable.map((section) => `${section.title}\n${section.text}`).join("\n");
  return { block: `${parts.join("\n\n")}${absent}`, included: usable.map((section) => section.id), missing, context: buildFactsContext(grounding) };
}

// ───────────────────────────── cifras y datos «con forma» ─────────────────────────────

const WEEKDAY = /\b(lunes|martes|miercoles|jueves|viernes|sabados?|domingos?)\b/g;
const TIME = /\b(\d{1,2})\s*[:.h]\s*(\d{2})\b/g;
const PHONE = /\+?\d[\d ()\-]{5,}\d/g;
const URL = /https?:\/\/[^\s)>\]]+/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

const trimUrl = (value: string) => value.replace(/[.,;:!?)\]]+$/, "");

// Todo lo verificable de un texto como fichas: t:08:00 (hora), p:591... (teléfono), n:12 (número suelto), d:lunes (día), u:... (enlace), e:... (correo).
// Una respuesta del modelo solo puede usar fichas que existan en los datos confirmados.
export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  let rest = fold(text);
  for (const match of rest.matchAll(URL)) tokens.add(`u:${trimUrl(match[0])}`);
  rest = rest.replace(URL, " ");
  for (const match of rest.matchAll(EMAIL)) tokens.add(`e:${match[0]}`);
  rest = rest.replace(EMAIL, " ");
  for (const match of rest.matchAll(TIME)) {
    const hour = Number(match[1]);
    const minute = match[2]!;
    tokens.add(`t:${String(hour).padStart(2, "0")}:${minute}`);
    // «de 8 a 12» sin minutos: la hora suelta de un horario escrito con minutos también está respaldada.
    tokens.add(`n:${hour}`);
    if (minute !== "00") tokens.add(`n:${Number(minute)}`);
  }
  rest = rest.replace(TIME, " ");
  for (const match of rest.matchAll(PHONE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 6) tokens.add(`p:${digits}`);
  }
  rest = rest.replace(PHONE, (value) => (value.replace(/\D/g, "").length >= 6 ? " " : value));
  for (const match of rest.matchAll(/\d+/g)) tokens.add(`n:${Number(match[0])}`);
  for (const match of rest.matchAll(WEEKDAY)) tokens.add(`d:${match[1] === "sabados" ? "sabado" : match[1] === "domingos" ? "domingo" : match[1]}`);
  return tokens;
}

export function buildFactsContext(groundingText: string): FactsContext {
  return { folded: fold(groundingText), tokens: extractTokens(groundingText) };
}

// Fichas de la respuesta que NO están en los datos (vacío = todo respaldado).
export function ungroundedTokens(reply: string, context: FactsContext): string[] {
  return [...extractTokens(reply)].filter((token) => !context.tokens.has(token));
}

// ───────────────────────────── datos escritos a mano en src/system-prompt.ts ─────────────────────────────

// Cómo se escribe una sección en src/system-prompt.ts. `estado: "POR_COMPLETAR"` (o cualquier defecto) la deja FUERA: no se envía al modelo y el modelo sabe que no tiene ese dato.
export interface BusinessSection {
  estado: "POR_COMPLETAR" | "CONFIRMADO";
  // Código del documento donde consta el dato (letras, números y _ . : / # -, sin espacios).
  fuente: string;
  // Último día de vigencia, AAAA-MM-DD (máximo 400 días desde que se confirma). Pasado ese día el dato deja de usarse.
  vigenteHasta: string;
  // Un dato por línea, sin precios ni importes (los precios salen solo del catálogo) y sin ningún [POR COMPLETAR] si el estado es CONFIRMADO.
  datos: string;
}
export type BusinessData = Record<DataSectionId, BusinessSection>;

export const PLACEHOLDER = "[POR COMPLETAR";
const SOURCE_REF = /^[A-Za-z0-9_.:/#-]{1,120}$/;
// Misma regla que el conocimiento aprobado: los precios salen SOLO del catálogo (Supabase), nunca de un texto.
const AMOUNT = /(\b(bs|bob|usd|us\$|bolivianos?|d[oó]lar(es)?)\.?\s*\d|\$\s*\d|\d\s*(bs|bob|usd|bolivianos?|d[oó]lar(es)?)\b)/i;

export interface PendingItem { section: DataSectionId; missing: string[] }
export interface BusinessReport {
  sections: DataSection[];
  // Defectos de contenido de las secciones CONFIRMADAS (esas secciones quedan sin texto: no llegan al modelo). No dependen de la fecha.
  problems: string[];
  // Lo que falta en las secciones POR COMPLETAR (líneas con [POR COMPLETAR…]).
  pending: PendingItem[];
}

const dataLines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
const labelOf = (line: string): string => line.replace(/^[-*]\s*/, "").split(":")[0]!.trim();

// Convierte lo escrito a mano en las secciones que usa el agente. Una sección confirmada con defectos queda sin texto (no llega al modelo) y se informa el problema.
export function validateBusinessData(data: BusinessData): BusinessReport {
  const report: BusinessReport = { sections: [], problems: [], pending: [] };
  for (const id of DATA_SECTION_IDS) {
    const entry = data[id];
    const title = SECTION_TITLES[id];
    const lines = dataLines(entry?.datos ?? "");
    if (!entry || entry.estado !== "CONFIRMADO") {
      report.pending.push({ section: id, missing: lines.filter((line) => line.includes(PLACEHOLDER)).map(labelOf) });
      report.sections.push({ id, title, status: "PENDING", source: null, validUntil: null, text: "" });
      continue;
    }
    const text = lines.join("\n");
    const problems: string[] = [];
    if (!SOURCE_REF.test(entry.fuente)) problems.push("«fuente» obligatoria: código del documento (letras, números y _ . : / # -, sin espacios, hasta 120 caracteres)");
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(entry.vigenteHasta) || new Date(`${entry.vigenteHasta}T00:00:00.000Z`).toISOString().slice(0, 10) !== entry.vigenteHasta) problems.push("«vigenteHasta» obligatoria, con formato AAAA-MM-DD");
    if (lines.length === 0) problems.push("no tiene ningún dato");
    if (text.includes(PLACEHOLDER)) problems.push("tiene datos [POR COMPLETAR]: complétalos o deja la sección POR_COMPLETAR");
    if (AMOUNT.test(text)) problems.push("menciona un importe: los importes no se configuran aquí");
    if (/\{\{|\}\}/.test(text)) problems.push("contiene marcadores reservados");
    if (text.length > 3000) problems.push("supera 3000 caracteres");
    for (const problem of problems) report.problems.push(`${id}: ${problem}`);
    report.sections.push({ id, title, status: "CONFIRMED", source: entry.fuente || null, validUntil: entry.vigenteHasta || null, text: problems.length > 0 ? "" : text });
  }
  return report;
}
