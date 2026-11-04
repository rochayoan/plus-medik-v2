// Exportación AUTORIZADA del historial de mensajes (src/message-history.ts). Se ejecuta en una máquina de confianza, con las claves en el entorno: NO hay ninguna ruta HTTP que lo haga, y las claves nunca
// salen de ahí. La base solo devuelve texto CIFRADO; se descifra aquí. Cada exportación exige un motivo y deja un rastro (sin contenido) en plusmedik_message_history_access.
//
//   Variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PLUSMEDIK_HISTORY_KEY (la actual), KAPSO_PHONE_NUMBER_ID,
//              opcional PLUSMEDIK_HISTORY_KEY_PREVIOUS (varias separadas por coma, si se rotó la clave),
//              y PLUSMEDIK_CONTACT_HMAC_KEY solo si se filtra por --phone.
//
//   npx tsx scripts/history-export.ts --reason "revisión de calidad noviembre 2026" --out export.jsonl [--format jsonl|csv]
//        [--phone 591XXXXXXXX | --contact-key <hmac>] [--from 2026-11-01] [--to 2026-11-04] [--gaps] [--erase]
//
//   --gaps    no exporta: lista (solo ids) los mensajes que la auditoría procesó y que faltan en el historial (escrituras que fallaron). Usa --from como inicio.
//   --erase   suprime TODO lo guardado de un contacto (exige --phone o --contact-key y --reason).
//
// El archivo contiene conversaciones reales con datos de salud: se crea con permisos 0600, no se sube a ningún lado, y hay que borrarlo al terminar la auditoría.

import { writeFileSync } from "node:fs";
import { contactKeyOf } from "../src/human-control.js";
import { CSV_COLUMNS, createSupabaseHistoryStore, csvLine, exportHistory, MIN_HISTORY_KEY_LENGTH } from "../src/message-history.js";

function args(argv: string[]): Map<string, string | true> {
  const map = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      map.set(token.slice(2), next);
      index++;
    } else map.set(token.slice(2), true);
  }
  return map;
}
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const text = (value: string | true | undefined): string | undefined => (typeof value === "string" ? value : undefined);
const dateOf = (value: string | undefined, name: string): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fail(`--${name}: fecha inválida`) : parsed;
};

async function main(): Promise<void> {
  const flags = args(process.argv.slice(2));
  const reason = text(flags.get("reason"))?.trim();
  const accountId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  const keys = [process.env.PLUSMEDIK_HISTORY_KEY, ...(process.env.PLUSMEDIK_HISTORY_KEY_PREVIOUS ?? "").split(",")].map((key) => key?.trim() ?? "").filter((key) => key !== "");
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) fail("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.");
  if (!accountId) fail("Falta KAPSO_PHONE_NUMBER_ID.");

  let contactKey = text(flags.get("contact-key"));
  const phone = text(flags.get("phone"));
  if (phone) {
    contactKey = contactKeyOf({ hmacKey: process.env.PLUSMEDIK_CONTACT_HMAC_KEY, labPhoneNumberId: accountId, contactPhone: phone });
    if (!contactKey) fail("No se pudo calcular la clave del contacto (revisa PLUSMEDIK_CONTACT_HMAC_KEY y el teléfono).");
  }
  const from = dateOf(text(flags.get("from")), "from");
  const to = dateOf(text(flags.get("to")), "to");
  const store = createSupabaseHistoryStore({ requestTimeoutMs: 30_000 });

  if (flags.has("gaps")) {
    const gaps = await store.gaps({ ...(from ? { since: from } : {}), limit: 1000 });
    console.log(JSON.stringify({ inboundMissing: gaps.inbound.length, outboundMissing: gaps.outbound.length, inbound: gaps.inbound, outbound: gaps.outbound }, null, 2));
    return;
  }
  if (!reason || reason.length < 10) fail('Indica el motivo con --reason "..." (mínimo 10 caracteres): queda registrado.');

  if (flags.has("erase")) {
    if (!contactKey) fail("--erase exige --phone o --contact-key.");
    const deleted = await store.erase({ contactKey: contactKey!, reason: reason! });
    console.log(`Suprimidos ${deleted} mensajes de ese contacto.`);
    return;
  }

  if (keys.length === 0 || keys.some((key) => key.length < MIN_HISTORY_KEY_LENGTH)) fail("Falta PLUSMEDIK_HISTORY_KEY (>= 32 caracteres).");
  const out = text(flags.get("out"));
  if (!out) fail("Indica el archivo de salida con --out (el contenido no se imprime en la terminal).");
  const format = text(flags.get("format")) ?? "jsonl";
  if (format !== "jsonl" && format !== "csv") fail("--format debe ser jsonl o csv.");

  const lines: string[] = format === "csv" ? [CSV_COLUMNS.join(",")] : [];
  const counts = { total: 0, withText: 0, unreadable: 0 };
  for await (const message of exportHistory({ store, accountId: accountId!, keys, reason: reason!, ...(contactKey ? { contactKey } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) })) {
    counts.total++;
    if (message.textStatus === "OK") counts.withText++;
    if (message.textStatus === "UNREADABLE") counts.unreadable++;
    lines.push(format === "csv" ? csvLine(message) : JSON.stringify(message));
  }
  writeFileSync(out!, `${lines.join("\n")}\n`, { mode: 0o600 });
  // Solo contadores: el contenido va al archivo, nunca a la terminal.
  console.log(`Exportados ${counts.total} mensajes (${counts.withText} con texto, ${counts.unreadable} ilegibles) en ${out}.`);
}

main().catch(() => {
  // Nunca el texto del error: puede traer filas o mensajes.
  console.error("La exportación falló (revisa la conexión, las claves y que la migración 21 esté aplicada).");
  process.exit(1);
});
