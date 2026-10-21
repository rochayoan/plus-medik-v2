import { normalizeStudyKey } from "@core/consensus";

// Importación de tarifas desde CSV (Excel: "Guardar como CSV"). Acepta "," o ";" como separador y precios "1.234,50" o "1234.50".

export interface TariffCsvRow {
  line: number;
  id?: string;
  code?: string;
  name?: string;
  price: number;
}

export interface TariffCsvParse {
  rows: TariffCsvRow[];
  errors: Array<{ line: number; message: string }>;
  // Filas sin precio (p. ej. la plantilla exportada con estudios aún sin precio de tarifa): se ignoran.
  skipped: number;
}

function parseCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { record.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field); records.push(record); record = []; field = "";
    } else field += char;
  }
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

export function parsePrice(raw: string): number | undefined {
  let value = raw.replace(/bs\.?/i, "").replace(/\s/g, "");
  if (!value) return undefined;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  if (lastComma > lastDot) value = value.replace(/\./g, "").replace(",", ".");
  else value = value.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : undefined;
}

const HEADERS = {
  id: ["id", "uuid", "lab_test_id"],
  code: ["codigo", "code", "cod"],
  name: ["nombre", "estudio", "name", "examen"],
  price: ["precio", "price", "precio_bs", "precio bs", "tarifa"]
} as const;

export function parseTariffCsv(text: string): TariffCsvParse {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const records = parseCsv(clean, delimiter).filter((record) => record.some((cell) => cell.trim() !== ""));
  const header = (records[0] ?? []).map((cell) => normalizeStudyKey(cell).replace(/ /g, "_"));
  const column = (names: readonly string[]) => header.findIndex((cell) => names.some((name) => cell === name.replace(/ /g, "_")));
  const columns = { id: column(HEADERS.id), code: column(HEADERS.code), name: column(HEADERS.name), price: column(HEADERS.price) };

  const errors: TariffCsvParse["errors"] = [];
  if (columns.price < 0) errors.push({ line: 1, message: "Falta la columna de precio (precio)." });
  if (columns.id < 0 && columns.code < 0 && columns.name < 0) errors.push({ line: 1, message: "Falta una columna para identificar el estudio (codigo, id o nombre)." });
  if (errors.length > 0) return { rows: [], errors, skipped: 0 };

  const rows: TariffCsvRow[] = [];
  let skipped = 0;
  records.slice(1).forEach((record, index) => {
    const line = index + 2;
    const cell = (position: number) => (position >= 0 ? (record[position] ?? "").trim() : "");
    if (cell(columns.price) === "") {
      skipped++;
      return;
    }
    const price = parsePrice(cell(columns.price));
    if (price === undefined) {
      errors.push({ line, message: `Precio inválido: "${cell(columns.price)}"` });
      return;
    }
    const row: TariffCsvRow = { line, price };
    if (cell(columns.id)) row.id = cell(columns.id);
    if (cell(columns.code)) row.code = cell(columns.code);
    if (cell(columns.name)) row.name = cell(columns.name);
    if (!row.id && !row.code && !row.name) {
      errors.push({ line, message: "Fila sin código, id ni nombre." });
      return;
    }
    rows.push(row);
  });
  return { rows, errors, skipped };
}

export interface TariffCatalogEntry {
  id: string;
  code: string | null;
  name: string;
  normalizedName: string;
}

export interface TariffMatch {
  matched: Array<{ line: number; labTestId: string; name: string; price: number; by: "id" | "code" | "name" }>;
  unmatched: Array<{ line: number; label: string; reason: string }>;
}

// Empareja cada fila con un estudio activo: por UUID, luego por código (si es único) y luego por nombre exacto normalizado.
// Si dos filas apuntan al mismo estudio, gana la última (como en Excel), y se avisa.
export function matchTariffRows(rows: TariffCsvRow[], catalog: TariffCatalogEntry[]): TariffMatch {
  const byId = new Map(catalog.map((entry) => [entry.id.toLowerCase(), entry]));
  const byCode = new Map<string, TariffCatalogEntry[]>();
  const byName = new Map<string, TariffCatalogEntry[]>();
  for (const entry of catalog) {
    if (entry.code) byCode.set(normalizeStudyKey(entry.code), [...(byCode.get(normalizeStudyKey(entry.code)) ?? []), entry]);
    for (const key of new Set([normalizeStudyKey(entry.normalizedName), normalizeStudyKey(entry.name)])) {
      if (key) byName.set(key, [...(byName.get(key) ?? []), entry]);
    }
  }

  const matched = new Map<string, TariffMatch["matched"][number]>();
  const unmatched: TariffMatch["unmatched"] = [];
  for (const row of rows) {
    const label = row.code ?? row.name ?? row.id ?? "";
    let found: { entry: TariffCatalogEntry; by: "id" | "code" | "name" } | undefined;
    let reason = "No existe en el catálogo activo";
    if (row.id) {
      const entry = byId.get(row.id.toLowerCase());
      if (entry) found = { entry, by: "id" };
    }
    if (!found && row.code) {
      const entries = byCode.get(normalizeStudyKey(row.code)) ?? [];
      if (entries.length === 1) found = { entry: entries[0]!, by: "code" };
      else if (entries.length > 1) reason = "Código repetido en el catálogo: usa el id";
    }
    if (!found && row.name) {
      const entries = byName.get(normalizeStudyKey(row.name)) ?? [];
      if (entries.length === 1) found = { entry: entries[0]!, by: "name" };
      else if (entries.length > 1) reason = "Nombre repetido en el catálogo: usa el código o id";
    }
    if (!found) {
      unmatched.push({ line: row.line, label, reason });
      continue;
    }
    const previous = matched.get(found.entry.id);
    if (previous) unmatched.push({ line: previous.line, label: previous.name, reason: `Reemplazada por la línea ${row.line} (mismo estudio)` });
    matched.set(found.entry.id, { line: row.line, labTestId: found.entry.id, name: found.entry.name, price: row.price, by: found.by });
  }
  return { matched: [...matched.values()].sort((a, b) => a.line - b.line), unmatched };
}

const csvCell = (value: string | null | undefined): string => {
  const text = value ?? "";
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvDecimal = (value: number | undefined): string => (value === undefined ? "" : value.toFixed(2).replace(".", ","));

// Plantilla para Excel en español (";" y coma decimal, con BOM): todos los estudios activos, su precio Paciente y el de la tarifa.
// Se edita la columna "precio" y se vuelve a importar tal cual (las filas sin precio se ignoran).
export function buildTariffTemplateCsv(
  catalog: Array<{ id: string; code: string | null; name: string; priceBs: number }>,
  tariffPrices: Map<string, number>
): string {
  const lines = ["id;codigo;nombre;precio_paciente;precio"];
  for (const study of [...catalog].sort((a, b) => a.name.localeCompare(b.name, "es"))) {
    lines.push([csvCell(study.id), csvCell(study.code), csvCell(study.name), csvDecimal(study.priceBs), csvDecimal(tariffPrices.get(study.id))].join(";"));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
