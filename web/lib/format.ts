const money = new Intl.NumberFormat("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatBs = (value: number): string => `Bs ${money.format(value)}`;

export const formatFolio = (folio: number): string => `PM-${String(folio).padStart(6, "0")}`;

// Fechas de calendario (YYYY-MM-DD) sin conversión de zona horaria: "2026-11-18" => "18/11/2026".
export function formatDate(value: string | Date): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return new Intl.DateTimeFormat("es-BO", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/La_Paz" }).format(new Date(value));
}
