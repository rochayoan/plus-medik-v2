import { plain } from "../text-normalize.js";
import type { ToolCall, Utterance } from "./contracts.js";

// Los nombres de estudios pueden provenir de aliases y memoria validada.
// No hacer un control literal que bloquee esas cotizaciones legítimas.
// Solo suprimir errores inequívocos: el paciente busca RESULTADOS, enlaces
// o comprobantes, no pide un presupuesto.
const ADMIN_RESULTS = /\b(resultado\w*|enlace\w*|link\w*|descarg\w*|comprobante\w*|boleta\w*|contrase\w*)\b/;
const PRICE_REQUEST = /\b(cotiz\w*|cotic\w*|precio\w*|cuesta\w*|costo\w*|presupuesto\w*|tarifa\w*|cuanto (cuesta|cuestan|sale|salen|saldria|seria|es|vale|valen|cobran)|el total|monto total|en total)\b/;

export function filterAdministrativeQuoteCalls(calls: readonly ToolCall[], utterances: readonly Utterance[]): { calls: ToolCall[]; suppressed: boolean } {
  const current = plain(utterances.map((message) => message.text).join(" "));
  if (!ADMIN_RESULTS.test(current) || PRICE_REQUEST.test(current)) return { calls: [...calls], suppressed: false };
  const safe = calls.filter((call) => call.tool !== "quote_studies");
  return { calls: safe, suppressed: safe.length !== calls.length };
}
