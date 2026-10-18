// Inspección SOLO LECTURA de la Supabase de PlusMedik (PostgREST). Solo hace GET; no escribe nada.
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

type Row = Record<string, unknown>;

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const PAGE_SIZE = 1000;

async function get(path: string, extra: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, { method: "GET", headers: { ...headers, ...extra } });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`GET ${path.split("?")[0]} -> HTTP ${response.status}: ${body}`);
  }
  return response;
}

async function fetchAll(table: string): Promise<{ rows: Row[]; totalCount?: number }> {
  const rows: Row[] = [];
  let totalCount: number | undefined;
  for (let from = 0; ; from += PAGE_SIZE) {
    const response = await get(`${table}?select=*`, {
      Range: `${from}-${from + PAGE_SIZE - 1}`,
      "Range-Unit": "items",
      Prefer: "count=exact"
    });
    const page = (await response.json()) as Row[];
    const total = response.headers.get("content-range")?.split("/")[1];
    if (total && total !== "*") totalCount = Number(total);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { rows, totalCount };
}

// Columnas declaradas en el esquema OpenAPI de PostgREST (sirve aunque la tabla esté vacía).
async function schemaColumns(table: string): Promise<string[] | undefined> {
  try {
    const spec = (await (await get("", { Accept: "application/openapi+json" })).json()) as {
      definitions?: Record<string, { properties?: Record<string, unknown> }>;
    };
    const properties = spec.definitions?.[table]?.properties;
    return properties ? Object.keys(properties) : undefined;
  } catch {
    return undefined;
  }
}

const truncate = (value: unknown): unknown =>
  typeof value === "string" && value.length > 80 ? `${value.slice(0, 80)}…` : value;

const sample = (rows: Row[], n = 5): Row[] =>
  rows.slice(0, n).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, truncate(value)])));

const columnsOf = (rows: Row[]): string[] => [...new Set(rows.flatMap((row) => Object.keys(row)))];

const normalize = (value: string): string =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

function duplicatesBy(rows: Row[], column: string, transform: (value: string) => string = (v) => v) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const value = row[column];
    if (typeof value !== "string" || value.trim() === "") continue;
    const key = transform(value);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].filter(([, group]) => group.length > 1);
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

const [tests, aliases] = await Promise.all([fetchAll("lab_tests"), fetchAll("lab_test_aliases")]);
const [testSchemaColumns, aliasSchemaColumns] = await Promise.all([
  schemaColumns("lab_tests"),
  schemaColumns("lab_test_aliases")
]);

for (const [table, data, declared] of [
  ["lab_tests", tests, testSchemaColumns],
  ["lab_test_aliases", aliases, aliasSchemaColumns]
] as const) {
  section(`${table}: estructura`);
  console.log(`registros: ${data.totalCount ?? data.rows.length} (leídos: ${data.rows.length})`);
  console.log(`columnas (según datos): ${columnsOf(data.rows).join(", ") || "(sin filas)"}`);
  if (declared) console.log(`columnas (según esquema OpenAPI): ${declared.join(", ")}`);
}

section("5 ejemplos de lab_tests");
console.log(JSON.stringify(sample(tests.rows), null, 2));

section("5 ejemplos de lab_test_aliases");
console.log(JSON.stringify(sample(aliases.rows), null, 2));

section("lab_tests: activos");
const testColumns = columnsOf(tests.rows);
const activeColumn = testColumns.find((column) => /^(is_)?active$|^activo$|^enabled$|^is_enabled$|^status$/i.test(column));
if (!activeColumn) {
  console.log("No se encontró una columna de activo/estado (active, is_active, activo, enabled, status).");
} else {
  const counts = new Map<string, number>();
  for (const row of tests.rows) counts.set(String(row[activeColumn]), (counts.get(String(row[activeColumn])) ?? 0) + 1);
  console.log(`columna: ${activeColumn}`);
  console.log(`distribución: ${JSON.stringify(Object.fromEntries(counts))}`);
}

section("lab_tests: code único");
if (!testColumns.includes("code")) {
  console.log("No existe la columna code.");
} else {
  const exact = duplicatesBy(tests.rows, "code");
  const loose = duplicatesBy(tests.rows, "code", normalize);
  const nulls = tests.rows.filter((row) => row.code === null || row.code === "").length;
  console.log(`code vacío/nulo: ${nulls}`);
  console.log(`duplicados exactos: ${exact.length}${exact.length ? ` -> ${exact.slice(0, 10).map(([key, group]) => `${key} (x${group.length})`).join(", ")}` : ""}`);
  console.log(`duplicados ignorando mayúsculas/tildes/espacios: ${loose.length}`);
  console.log(`code es único: ${exact.length === 0 ? "SÍ (en los datos leídos)" : "NO"}`);
}

section("lab_tests: nombres duplicados");
const nameColumns = testColumns.filter((column) => /^(name|nombre|display_name|title)$/i.test(column));
if (nameColumns.length === 0) console.log("No se encontró columna de nombre (name, nombre, display_name, title).");
for (const column of nameColumns) {
  const dups = duplicatesBy(tests.rows, column, normalize);
  console.log(`columna ${column}: ${dups.length} nombre(s) duplicado(s) (normalizado)`);
  for (const [key, group] of dups.slice(0, 10)) {
    const ids = group.map((row) => row.id ?? row.code ?? "?").join(", ");
    console.log(`  - "${key}" x${group.length} (id/code: ${ids})`);
  }
}

section("lab_tests: columnas de precios");
const priceColumns = testColumns.filter((column) => /price|precio|cost|costo|amount|monto|tarifa|fee|usd|bs|ves/i.test(column));
if (priceColumns.length === 0) console.log("No se encontraron columnas con nombre de precio/costo.");
for (const column of priceColumns) {
  const numeric = tests.rows.map((row) => row[column]).filter((value): value is number => typeof value === "number");
  const nulls = tests.rows.filter((row) => row[column] === null || row[column] === undefined).length;
  const range = numeric.length ? `min=${Math.min(...numeric)} max=${Math.max(...numeric)}` : "sin valores numéricos";
  console.log(`${column}: nulos=${nulls}/${tests.rows.length}, ${range}`);
}

section("lab_test_aliases -> lab_tests (FK inferida)");
const aliasColumns = columnsOf(aliases.rows);
const targets = ["id", "code"].filter((column) => testColumns.includes(column));
const results: Array<{ aliasColumn: string; testColumn: string; matched: number; total: number }> = [];
for (const aliasColumn of aliasColumns) {
  const values = aliases.rows.map((row) => row[aliasColumn]).filter((value) => value !== null && value !== undefined);
  if (values.length === 0) continue;
  for (const testColumn of targets) {
    const known = new Set(tests.rows.map((row) => String(row[testColumn])));
    const matched = values.filter((value) => known.has(String(value))).length;
    if (matched > 0) results.push({ aliasColumn, testColumn, matched, total: values.length });
  }
}
results.sort((a, b) => b.matched / b.total - a.matched / a.total);
if (results.length === 0) console.log("No se pudo inferir ninguna columna que apunte a lab_tests (id/code).");
for (const result of results.slice(0, 8)) {
  const pct = ((result.matched / result.total) * 100).toFixed(1);
  console.log(`lab_test_aliases.${result.aliasColumn} -> lab_tests.${result.testColumn}: ${result.matched}/${result.total} (${pct}%)`);
}
const best = results[0];
if (best && best.matched === best.total) {
  console.log(`FK probable: lab_test_aliases.${best.aliasColumn} -> lab_tests.${best.testColumn} (100% de los valores existen)`);
}
const orphans = best ? aliases.rows.filter((row) => row[best.aliasColumn] != null && !new Set(tests.rows.map((r) => String(r[best.testColumn]))).has(String(row[best.aliasColumn]))).length : 0;
if (best) console.log(`aliases huérfanos respecto a esa columna: ${orphans}`);
