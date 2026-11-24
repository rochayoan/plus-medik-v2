// Carga CONTROLADA en el catálogo (lab_tests, lab_test_aliases) de las respuestas del laboratorio al Excel «Preguntas pendientes» (24-nov) y de los precios Médicos revisados a mano
// (Revision_precios_PlusMedik.csv). Dry-run por defecto: solo hace GET y muestra qué haría. Con --apply escribe, y se detiene ante el primer error.
//
//   npx tsx scripts/apply-lab-answers-24nov.ts            → muestra el plan
//   npx tsx scripts/apply-lab-answers-24nov.ts --apply    → lo aplica
//
// Cada cambio busca el estudio por su NOMBRE exacto (activo); si no lo encuentra, no hace nada con ese cambio y lo informa. Idempotente: un alias que ya existe, un valor que ya está o un estudio
// que ya se dio de alta no se repite.
import { normalizeStudyKey } from "../src/consensus.js";

try {
  process.loadEnvFile(".env");
} catch {
  // las variables pueden venir del entorno
}
const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

type Row = { id: string; code: string | null; name: string; normalized_name: string; sample_type: string | null; notes: string | null; price_bs: number; price_convenio_bs: number | null; price_medicos_bs: number | null; price_emergencia_bs: number | null; active: boolean };
async function call(method: string, path: string, body?: unknown, prefer = "return=minimal"): Promise<unknown> {
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, { method, headers: { ...headers, Prefer: prefer }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path.split("?")[0]} → HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

// ───────────── 1. Alias (nombres que escriben médicos y pacientes) ─────────────
const ALIASES: ReadonlyArray<{ study: string; aliases: readonly string[] }> = [
  { study: "HIV 1,2 AG-AC 4ta GENERACION (Elisa)", aliases: ["HIV cuantitativo", "VIH cuantitativo", "HIV Elisa", "VIH Elisa", "HIV 4ta generacion", "VIH 4ta generacion"] },
  { study: "ANTICUERPOS ANTI-TIROGLOBULINA a-TG (CLIA)", aliases: ["anti tiroglobulina", "antitiroglobulina", "anticuerpos antitiroglobulina", "a-TG", "ATG", "anti TG"] },
  { study: "ANTICUERPOS ANTI-TIROGLOBULINA a-TG (ECLIA)", aliases: ["anti tiroglobulina", "antitiroglobulina", "anticuerpos antitiroglobulina", "a-TG", "ATG", "anti TG"] },
  // «TG» a secas NO: muchos médicos lo usan para triglicéridos.
  { study: "TG TIROGLOBULINA (ECLIA)", aliases: ["tiroglobulina"] },
  { study: "BILIRRUBINA TOTAL Y FRACCIONES", aliases: ["bilirrubinas", "bilirrubina y fracciones"] },
  { study: "GASOMETRIA + LACTATO", aliases: ["gasometria mas lactato", "gasometria con lactato"] },
  { study: "BACILOSCOPIA SERIADA", aliases: ["baciloscopia seriado", "BAAR seriado", "baciloscopia x2", "basiloscopia x2"] },
  { study: "VITAMINA B9 - Acido Folico - Folato (ECLIA)", aliases: ["folato", "vitamina B9"] },
  // «RX» solo no (rayos X); sí «factor rx».
  { study: "LATEX FACTOR REUMATOIDE (SEMI CUANTITATIVO)", aliases: ["factor rx", "factor reumatoideo"] },
  { study: "PROTEINA C REACTIVA (PCR CUALITATIVO)", aliases: ["PCR cualitativo", "PCR cualitativa"] },
  { study: "PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO)", aliases: ["PCR semicuantitativo", "PCR semi cuantitativo", "PCR semicuantitativa"] },
  { study: "PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)", aliases: ["PCR cuantitativo", "PCR cuantitativa"] },
  { study: "RETROCULTIVO ADULTO - PEDIATRICO SIMPLE - CONVENCIONAL", aliases: ["retrocultivo", "retrocultivo adulto", "retrocultivo pediatrico"] },
  { study: "RETROCULTIVO ADULTO - PEDIATRICO SERIADO X 2 - CONVENCIONAL", aliases: ["retrocultivo x2", "retrocultivo seriado"] },
  { study: "MARIHUANA (prueba rapida)", aliases: ["THC", "TCH", "cannabis", "canabis"] },
  { study: "Tiroxina Globular de Transporte (TBG)", aliases: ["TBG", "TGB", "globulina transportadora de tiroxina"] },
  { study: "IONOGRAMA 1 (sodio, potasio, cloro)", aliases: ["electrolitos"] },
  { study: "EXAMEN GENERAL DE ORINA COMPLETA", aliases: ["EGO", "orina completa", "examen de orina", "examen general de orina"] },
  // «creatinina» a secas NO: es su propio estudio (CREATININA).
  { study: "COCIENTE ALBUMINA / CREATININA", aliases: ["cociente albumina", "cociente albumina creatinina", "relacion albumina creatinina"] },
  { study: "Detección de Microdeleciones del Sistema AZF del Cromosoma Y (Problemas de fertilidad masculina)", aliases: ["microdeleciones AZF", "AZF cromosoma Y"] },
  // Panel + la intención (laboratorio): con varios paneles, el agente ofrece las opciones con su precio.
  ...[
    "PANEL INTIMA PLUS 32 PATOGENOS",
    "PANEL INTIMA PLUS 34 PATOGENOS",
    "PANEL qPCR 17 PATOGENOS DE INFECCIONES DE TRANSMISION SEXUAL",
    "PANEL qPCR 12 PATOGENOS DE ITS + HIV 4ta GENERACION ELISA",
    "PANEL qPCR 12 PATOGENOS DE INFECCIONES DE TRANSMISION SEXUAL"
  ].map((prefix) => ({ study: `${prefix}*`, aliases: ["panel ITS", "panel ETS", "panel de transmision sexual", "panel sexual"] })),
  ...["PANEL RESPIRATORIO MIXTO qPCR (30 PATOGENOS)", "PANEL RESPIRATORIO MIXTO qPCR (20 PATOGENOS)", "PANEL AMPLIADO RESPIRATORIO PLUS Y TROPICAL qPCR (38 PATOGENOS)"].map((prefix) => ({ study: `${prefix}*`, aliases: ["panel respiratorio"] }))
];

// ───────────── 2. Correcciones de estudios existentes ─────────────
const INTIMA_34 = "PANEL INTIMA PLUS 34 PATOGENOS – INFECCIONES DE TRANSMISION SEXUAL + HPV + VIH 4ta Generacion (Elisa) VIRUS: Virus del Herpes simple 1, Virus del Herpes simple 2. BACTERIAS: Gardnerella vaginalis, Chlamydia trachomatis, Neisseria gonorrhoeae, Treponema pallidum, Ureaplasma parvum, Ureaplasma urealyticum, Mycoplasma genitalium, Mycoplasma hominis, Haemophilus ducreyi, Streptococcus agalactiae. PARASITOS: Trichomonas vaginalis. HONGOS: Candida albicans, Candida parapsilosis, Candida krusei, Candida glabrata, Candida tropicalis, Candida auris. HPV SCREENING 14 Genotipos de Alto Riesgo, Genotipificacion: HPV 16 y 18, Deteccion: HPV 31, 33, 35, 39, 45, 51, 52, 56, 58, 59, 66 y 68. HIV 1,2 AG-AC 4ta Generacion (Elisa)";
type Patch = Partial<Pick<Row, "name" | "normalized_name" | "notes" | "sample_type" | "price_bs" | "price_medicos_bs">>;
const UPDATES: ReadonlyArray<{ study: string; why: string; patch: (row: Row) => Patch }> = [
  { study: "HOMOCISTEINA", why: "tiempo de entrega 4 días (laboratorio)", patch: (row) => ({ notes: `${(row.notes ?? "").replace(/\s*\|\s*tiempo de entrega:[^|]*/i, "").trim()} | Tiempo de entrega: 4 dias` }) },
  { study: "PANEL INTIMA PLUS 32 PATOGENOS*", why: "34 patógenos y lista del laboratorio", patch: () => ({ name: INTIMA_34, normalized_name: normalizeStudyKey(INTIMA_34) }) },
  { study: "CITOGRAMA NASAL DERECHO / IZQUIERDO 60BS C/U", why: "precio por lado Bs 50, sin el precio en el nombre", patch: () => ({ name: "CITOGRAMA NASAL (DERECHO O IZQUIERDO, PRECIO POR LADO)", normalized_name: normalizeStudyKey("CITOGRAMA NASAL (DERECHO O IZQUIERDO, PRECIO POR LADO)"), price_bs: 50 }) },
  // Precios Médicos revisados a mano por el laboratorio (Revision_precios_PlusMedik.csv).
  ...([
    ["BETA HCG-CUANTITATIVA - VARON (FIA Fluorescencia)", 130],
    ["BETA HCG-CUANTITATIVA (FIA Fluorescencia)", 130],
    ["CLORO", 60],
    ["POTASIO", 60],
    ["SODIO", 60],
    ["HIV 1,2 AG-AC 4ta GENERACION (Elisa)", 150],
    ["IONOGRAMA 2 (sodio, potasio, cloro, calcio ionico)", 220]
  ] as const).map(([study, medicos]) => ({ study, why: `precio Médicos Bs ${medicos} (revisado)`, patch: (): Patch => ({ price_medicos_bs: medicos }) })),
  // «Ocacional» → «Ocasional» en el tipo de muestra.
  ...["SODIO EN ORINA OCASIONAL O 24 HORAS", "CLORO EN ORINA OCASIONAL O 24 HORAS", "POTASIO EN ORINA OCASIONAL O 24 HORAS"].map((study) => ({ study, why: "«Ocasional» bien escrito en el tipo de muestra", patch: (row: Row): Patch => ({ sample_type: (row.sample_type ?? "").replace(/ocacional/gi, "Ocasional") }) }))
];

// ───────────── 3. Altas nuevas (fotos de la lista del laboratorio, 24-nov) ─────────────
const NEW_STUDIES = [
  { code: null, name: "Tamizaje Neonatal (4 enfermedades)", category: "PRUEBAS ESPECIALES", sample_type: "Suero 500 ul", price_bs: 850, price_convenio_bs: 830, price_medicos_bs: 1186, price_emergencia_bs: 1000, notes: "Preparacion: No requiere condiciones especiales, pero se sugiere 8 a 12 horas de ayuno para evitar la lipemia. | Tiempo de entrega: 7 - 10 dias" },
  { code: null, name: "Tamizaje Neonatal (7 enfermedades)", category: "PRUEBAS ESPECIALES", sample_type: "Suero 500 ul", price_bs: 950, price_convenio_bs: 930, price_medicos_bs: 1329, price_emergencia_bs: 1188, notes: "Preparacion: No requiere condiciones especiales, pero se sugiere 8 a 12 horas de ayuno para evitar la lipemia. | Tiempo de entrega: 7 - 10 dias" },
  { code: null, name: "Tamizaje Neonatal Beta 22 enfermedades", category: "PRUEBAS ESPECIALES", sample_type: "Suero 500 ul", price_bs: 2500, price_convenio_bs: 2450, price_medicos_bs: 3500, price_emergencia_bs: 3125, notes: "Preparacion: No requiere condiciones especiales, pero se sugiere 8 a 12 horas de ayuno para evitar la lipemia. | Tiempo de entrega: 15 dias" },
  { code: "352", name: "Linfocitos CD4 , CD8", category: "PRUEBAS ESPECIALES", sample_type: "Sangre total con EDTA 3 ml", price_bs: 950, price_convenio_bs: 950, price_medicos_bs: 1357, price_emergencia_bs: 1188, notes: "Preparacion: No requiere ninguna preparación especial. | Tiempo de entrega: 7 dias" },
  { code: "353", name: "Linfocitos T Maduros CD3", category: "PRUEBAS ESPECIALES", sample_type: "Sangre total con EDTA 3 ml", price_bs: 420, price_convenio_bs: 410, price_medicos_bs: 586, price_emergencia_bs: 525, notes: "Preparacion: No requiere ninguna preparación especial. | Tiempo de entrega: 7 dias" }
] as const;

const rows = (await call("GET", "lab_tests?select=id,code,name,normalized_name,sample_type,notes,price_bs,price_convenio_bs,price_medicos_bs,price_emergencia_bs,active&limit=5000", undefined, "")) as Row[];
const existingAliases = (await call("GET", "lab_test_aliases?select=lab_test_id,normalized_alias&limit=10000", undefined, "")) as Array<{ lab_test_id: string; normalized_alias: string }>;
const find = (pattern: string): Row[] => {
  const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : undefined;
  return rows.filter((row) => row.active && (prefix ? row.name.startsWith(prefix) : row.name === pattern));
};
const problems: string[] = [];
const plan: Array<{ label: string; run: () => Promise<unknown> }> = [];

for (const { study, aliases } of ALIASES) {
  const matches = find(study);
  // «PANEL INTIMA PLUS 34» solo existe después del cambio de nombre: se resuelve al aplicar.
  if (matches.length === 0 && study.startsWith("PANEL INTIMA PLUS 34")) continue;
  if (matches.length !== 1) {
    problems.push(`alias: «${study}» → ${matches.length} estudios activos`);
    continue;
  }
  const row = matches[0]!;
  for (const alias of aliases) {
    const normalized = normalizeStudyKey(alias);
    if (existingAliases.some((item) => item.lab_test_id === row.id && item.normalized_alias === normalized)) continue;
    plan.push({ label: `ALIAS   «${alias}» → ${row.name.slice(0, 70)}`, run: () => call("POST", "lab_test_aliases", { lab_test_id: row.id, alias }) });
  }
}
for (const { study, why, patch } of UPDATES) {
  const matches = find(study);
  if (matches.length !== 1) {
    problems.push(`cambio: «${study}» → ${matches.length} estudios activos`);
    continue;
  }
  const row = matches[0]!;
  const changes = Object.fromEntries(Object.entries(patch(row)).filter(([field, value]) => (row as Record<string, unknown>)[field] !== value));
  if (Object.keys(changes).length === 0) continue;
  const shown = Object.entries(changes).filter(([field]) => field !== "normalized_name").map(([field, value]) => `${field}: ${String((row as Record<string, unknown>)[field]).slice(0, 60)} → ${String(value).slice(0, 60)}`).join(" · ");
  plan.push({ label: `CAMBIO  ${row.name.slice(0, 50)} (${why}): ${shown}`, run: () => call("PATCH", `lab_tests?id=eq.${row.id}`, changes) });
}
for (const study of NEW_STUDIES) {
  if (rows.some((row) => normalizeStudyKey(row.name) === normalizeStudyKey(study.name))) continue;
  plan.push({ label: `ALTA    ${study.name} · Paciente Bs ${study.price_bs} · Convenio ${study.price_convenio_bs} · Médicos ${study.price_medicos_bs} · Emergencia ${study.price_emergencia_bs} · ${study.notes.split("|")[1]?.trim()}`, run: () => call("POST", "lab_tests", { ...study, normalized_name: normalizeStudyKey(study.name), active: true, metadata: {} }) });
}

for (const item of plan) console.log(item.label);
console.log(`\n${plan.length} cambios${problems.length ? ` · ${problems.length} problemas:` : ""}`);
for (const problem of problems) console.log("  ⚠", problem);
if (!APPLY) {
  console.log("\n(dry-run: no se escribió nada; con --apply se aplica)");
  process.exit(0);
}
let done = 0;
for (const item of plan) {
  await item.run();
  done++;
}
// Alias del panel Íntima con su nombre nuevo.
const intima = (await call("GET", "lab_tests?select=id,name&active=eq.true&name=like.PANEL%20INTIMA%20PLUS%2034*", undefined, "")) as Array<{ id: string }>;
const aliasesNow = (await call("GET", "lab_test_aliases?select=lab_test_id,normalized_alias&limit=10000", undefined, "")) as Array<{ lab_test_id: string; normalized_alias: string }>;
if (intima.length === 1) {
  for (const alias of ["panel ITS", "panel ETS", "panel de transmision sexual", "panel sexual"]) {
    if (aliasesNow.some((item) => item.lab_test_id === intima[0]!.id && item.normalized_alias === normalizeStudyKey(alias))) continue;
    await call("POST", "lab_test_aliases", { lab_test_id: intima[0]!.id, alias });
    done++;
  }
}
console.log(`\nAplicados: ${done}`);
