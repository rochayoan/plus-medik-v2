// Escritura CONTROLADA de los 7 aliases aprobados en public.lab_test_aliases.
// Dry-run por defecto: sin --apply solo hace GET y muestra las filas que se insertarían.
import { pathToFileURL } from "node:url";
import { normalizeStudyKey } from "../src/consensus.js";

// SOLO estos 7. Fuera por decisión: Orina Completa, TSH y Perfil Tiroideo.
export const APPROVED_ALIASES = [
  { alias: "Hemograma Completo", labTestId: "7c360ee4-b7d1-44eb-bbcd-c3553a76c9e3" },
  { alias: "DHEA-S", labTestId: "691baa74-8b94-4479-99a9-97a62a6a98b4" },
  { alias: "FSH", labTestId: "2a2aa702-da3c-43cf-9c82-58c2161b957c" },
  { alias: "LH", labTestId: "7daac937-75dc-43da-8ca8-b61b2bf10b55" },
  { alias: "Progesterona [dia 21 del ciclo]", labTestId: "8fdabf2d-5c5c-4d99-a6d7-25d91b084bf4" },
  { alias: "Prolactina [PRL]", labTestId: "d3d1f902-d324-4a24-b447-010ea978c370" },
  { alias: "Estradiol [E2]", labTestId: "ed0e25b9-b99f-416f-b5cc-cba36059a4a9" }
] as const;

export interface AliasRow {
  lab_test_id: string;
  alias: string;
  // Calculado localmente SOLO para precondiciones, dry-run y verificación.
  // En la base es una columna generada: NO se envía en el INSERT.
  normalized_alias: string;
}

// Cantidad de aliases que debe haber antes de escribir (confirma que un intento previo fallido no insertó nada).
export const EXPECTED_EXISTING_ALIASES = 13;

export const toInsertPayload = (rows: AliasRow[]): Array<Pick<AliasRow, "lab_test_id" | "alias">> =>
  rows.map(({ lab_test_id, alias }) => ({ lab_test_id, alias }));

export const PROPOSED_ROWS: AliasRow[] = APPROVED_ALIASES.map(({ alias, labTestId }) => ({
  lab_test_id: labTestId,
  alias,
  normalized_alias: normalizeStudyKey(alias)
}));

export interface Connection {
  baseUrl: string;
  serviceKey: string;
  fetchFn: typeof fetch;
}

interface LabTestRow {
  id: string;
  code: string | null;
  name: string;
  normalized_name: string;
  active: boolean;
}

interface ExistingAliasRow {
  id: string;
  lab_test_id: string;
  alias: string;
  normalized_alias: string;
}

async function request(connection: Connection, method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}) {
  const response = await connection.fetchFn(`${connection.baseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: connection.serviceKey,
      Authorization: `Bearer ${connection.serviceKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 300);
    throw new Error(`${method} ${path.split("?")[0]} -> HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<unknown>;
}

const getAll = async <T>(connection: Connection, path: string) =>
  (await request(connection, "GET", `${path}&limit=5000`)) as T[];

export interface Snapshot {
  tests: LabTestRow[];
  aliases: ExistingAliasRow[];
}

export async function readSnapshot(connection: Connection): Promise<Snapshot> {
  const [tests, aliases] = await Promise.all([
    getAll<LabTestRow>(connection, "lab_tests?select=id,code,name,normalized_name,active"),
    getAll<ExistingAliasRow>(connection, "lab_test_aliases?select=id,lab_test_id,alias,normalized_alias")
  ]);
  return { tests, aliases };
}

export interface RowCheck {
  row: AliasRow;
  targetName?: string;
  problems: string[];
}

// Precondiciones: UUID activo, normalized_alias inexistente, sin choque con normalized_name activo, sin duplicados en el lote.
export function checkPreconditions(snapshot: Snapshot, rows: AliasRow[] = PROPOSED_ROWS): RowCheck[] {
  const testsById = new Map(snapshot.tests.map((test) => [test.id, test]));
  const activeNames = new Set(snapshot.tests.filter((test) => test.active).map((test) => test.normalized_name));
  const existingAliases = new Set(snapshot.aliases.map((alias) => alias.normalized_alias));
  const batchCounts = new Map<string, number>();
  for (const row of rows) batchCounts.set(row.normalized_alias, (batchCounts.get(row.normalized_alias) ?? 0) + 1);

  return rows.map((row) => {
    const problems: string[] = [];
    const target = testsById.get(row.lab_test_id);
    if (!target) problems.push("el UUID no existe en lab_tests");
    else if (target.active !== true) problems.push("el lab_test no está activo");
    if (row.normalized_alias === "") problems.push("normalized_alias vacío");
    if (existingAliases.has(row.normalized_alias)) problems.push("el normalized_alias ya existe en lab_test_aliases");
    if (activeNames.has(row.normalized_alias)) problems.push("choca con el normalized_name de un lab_test activo");
    if ((batchCounts.get(row.normalized_alias) ?? 0) > 1) problems.push("normalized_alias duplicado dentro del lote");
    return { row, targetName: target?.name, problems };
  });
}

export interface VerificationResult {
  ok: boolean;
  problems: string[];
  newRows: ExistingAliasRow[];
}

// Después de escribir: deben existir exactamente 7 filas nuevas, cada una apuntando al UUID correcto.
export function verifyInserted(before: Snapshot, after: Snapshot, rows: AliasRow[] = PROPOSED_ROWS): VerificationResult {
  const problems: string[] = [];
  const beforeIds = new Set(before.aliases.map((alias) => alias.id));
  const newRows = after.aliases.filter((alias) => !beforeIds.has(alias.id));

  if (newRows.length !== rows.length) problems.push(`se esperaban ${rows.length} filas nuevas y hay ${newRows.length}`);
  if (after.aliases.length !== before.aliases.length + rows.length) {
    problems.push(`total de aliases: antes ${before.aliases.length}, después ${after.aliases.length} (esperado ${before.aliases.length + rows.length})`);
  }
  const removed = before.aliases.filter((alias) => !after.aliases.some((candidate) => candidate.id === alias.id));
  if (removed.length > 0) problems.push(`${removed.length} alias previos desaparecieron`);

  for (const row of rows) {
    // Se busca por alias (lo único que se insertó); normalized_alias lo genera la base y se compara con el local.
    const found = newRows.filter((candidate) => candidate.alias === row.alias);
    if (found.length !== 1) problems.push(`"${row.alias}": se esperaba 1 fila nueva y hay ${found.length}`);
    else if (found[0]!.lab_test_id !== row.lab_test_id) problems.push(`"${row.alias}": apunta a ${found[0]!.lab_test_id} y debía apuntar a ${row.lab_test_id}`);
    else if (found[0]!.normalized_alias !== row.normalized_alias) {
      problems.push(`"${row.alias}": normalized_alias generado por la base ("${found[0]!.normalized_alias}") distinto del esperado ("${row.normalized_alias}")`);
    }
  }
  return { ok: problems.length === 0, problems, newRows };
}

export interface RunResult {
  exitCode: number;
  wrote: boolean;
}

export async function run(connection: Connection, options: { apply: boolean }, log: (line: string) => void = console.log): Promise<RunResult> {
  log(options.apply ? "MODO: --apply (escribirá en Supabase si todas las precondiciones pasan)" : "MODO: DRY-RUN (no se escribe nada)");

  const before = await readSnapshot(connection);
  log(`lab_tests leídos: ${before.tests.length} | aliases existentes: ${before.aliases.length}`);

  // Confirma que un intento previo fallido no insertó nada (y que nadie más tocó la tabla).
  const countOk = before.aliases.length === EXPECTED_EXISTING_ALIASES;
  log(
    countOk
      ? `Conteo de aliases OK: ${before.aliases.length} (esperado ${EXPECTED_EXISTING_ALIASES}); ningún intento previo insertó filas.`
      : `FALLA conteo de aliases: hay ${before.aliases.length} y se esperaban ${EXPECTED_EXISTING_ALIASES}.`
  );

  const checks = checkPreconditions(before);
  log("\nPrecondiciones:");
  for (const { row, targetName, problems } of checks) {
    log(`  ${problems.length === 0 ? "OK   " : "FALLA"} ${row.alias} -> ${row.lab_test_id}${targetName ? ` (${targetName})` : ""}`);
    for (const problem of problems) log(`         - ${problem}`);
  }

  log("\nFilas INSERT propuestas (public.lab_test_aliases; solo lab_test_id y alias; id, created_at y normalized_alias los genera la base):");
  for (const { row } of checks) {
    log(`  ('${row.lab_test_id}', '${row.alias}')   -- normalized_alias esperado: '${row.normalized_alias}'`);
  }

  if (!countOk || checks.some((check) => check.problems.length > 0)) {
    log("\nABORTADO: alguna precondición falló. No se escribió nada.");
    return { exitCode: 1, wrote: false };
  }
  if (!options.apply) {
    log("\nDRY-RUN completo: conteo y las 7 precondiciones pasan. NO se escribió nada. Para escribir: npm run catalog-aliases -- --apply");
    return { exitCode: 0, wrote: false };
  }

  // Un solo POST con arreglo: PostgREST lo ejecuta como un único INSERT (todo o nada).
  // normalized_alias es una columna generada: no se envía.
  const inserted = (await request(connection, "POST", "lab_test_aliases", toInsertPayload(PROPOSED_ROWS), { Prefer: "return=representation" })) as unknown[];
  log(`\nPOST ok: la base devolvió ${Array.isArray(inserted) ? inserted.length : "?"} filas.`);

  const after = await readSnapshot(connection);
  const verification = verifyInserted(before, after);
  if (!verification.ok) {
    log("\nVERIFICACIÓN FALLÓ (revisar manualmente, no se borró nada):");
    for (const problem of verification.problems) log(`  - ${problem}`);
    return { exitCode: 1, wrote: true };
  }
  log(`\nVerificación OK por GET: ${verification.newRows.length} filas nuevas, cada una apunta a su UUID:`);
  for (const row of verification.newRows) log(`  ${row.id}  ${row.normalized_alias} -> ${row.lab_test_id}`);
  return { exitCode: 0, wrote: true };
}

async function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((flag) => flag !== "--apply");
  if (unknown.length > 0) {
    console.error(`Argumento no reconocido: ${unknown.join(" ")} (solo existe --apply)`);
    process.exit(1);
  }
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env es opcional si las variables ya están en el entorno
  }
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env");
    process.exit(1);
  }
  try {
    const result = await run({ baseUrl, serviceKey, fetchFn: fetch }, { apply: flags.includes("--apply") });
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
