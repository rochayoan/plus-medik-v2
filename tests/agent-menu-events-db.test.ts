import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 26 (plusmedik_agent_menu_events): medición del menú de intención. Contra PostgreSQL REAL y efímero; NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[agent-menu-events-db] PostgreSQL no disponible: se omiten las pruebas de la migración 26 contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const FILE = "20261119000000_plusmedik_agent_menu_events.sql";
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

describe("migración 26 (plusmedik_agent_menu_events): forma estática", () => {
  const code = readFileSync(join(dir, FILE), "utf8").replaceAll("\r\n", "\n").split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
  it("es la última de la cadena, posterior a la del piloto (25)", () => {
    expect(MIGRATIONS.at(-1)).toBe(FILE);
    expect(MIGRATIONS.at(-2)).toBe("20261113000000_plusmedik_agent_pilot.sql");
  });
  it("es ADITIVA: una tabla y dos funciones; no borra ni modifica nada; sin texto ni teléfonos", () => {
    expect([...code.matchAll(/create table if not exists public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_agent_menu_events"]);
    expect([...code.matchAll(/create or replace function public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_agent_menu_event", "plusmedik_agent_menu_report"]);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|constraint|schema)\b|\btruncate\b|\bdelete\s+from\b|\balter\s+table\s+public\.(?!plusmedik_agent_menu_events\b)/i);
    expect(code).not.toMatch(/\bbody\b|\bphone\b|\btext_|\bcrm\./i);
  });
  it("solo service_role registra; el reporte no se concede a ningún rol de la API", () => {
    expect(code).toMatch(/grant execute on function public\.plusmedik_agent_menu_event\(text, text, text, text\) to service_role;/);
    expect(code).toMatch(/revoke all on function public\.plusmedik_agent_menu_report\(timestamptz\) from public, anon, authenticated, service_role;/);
    expect(code).not.toMatch(/grant execute on function public\.plusmedik_agent_menu_report/);
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });
});

describe.skipIf(!bin)("migración 26 contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("agent_menu_events");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });
  const KEY = "c".repeat(64);
  const record = (event: string, option: string | null, via: string | null) => db.ok(`set role service_role; select public.plusmedik_agent_menu_event('${KEY}', '${event}', ${option ? `'${option}'` : "null"}, ${via ? `'${via}'` : "null"});`);

  it("service_role registra eventos válidos; los inválidos se rechazan (PT422)", async () => {
    await record("SHOWN", null, null);
    await record("CHOSEN", "RESULTS", "NUMBER");
    await record("CHOSEN", "QUOTE", "WORDS");
    await record("SKIPPED", null, null);
    expect(await db.fails(`set role service_role; select public.plusmedik_agent_menu_event('${KEY}', 'CHOSEN', null, null);`)).toContain("PT422");
    expect(await db.fails(`set role service_role; select public.plusmedik_agent_menu_event('${KEY}', 'SHOWN', 'QUOTE', 'NUMBER');`)).toContain("PT422");
    expect(await db.fails(`set role service_role; select public.plusmedik_agent_menu_event('no-es-clave', 'SHOWN', null, null);`)).toContain("PT422");
    expect(await db.fails(`set role service_role; select public.plusmedik_agent_menu_event('${KEY}', 'BORRAR', null, null);`)).toContain("PT422");
    expect(await db.ok(`select count(*) from public.plusmedik_agent_menu_events`)).toBe("4");
  });

  it("el reporte (administrador) cuenta por día, opción y forma de elegir", async () => {
    const out = await db.ok(`select shown || '|' || skipped || '|' || chosen || '|' || coalesce(option, '-') || '|' || coalesce(via, '-') || '|' || chosen_count from public.plusmedik_agent_menu_report(now() - interval '1 day') order by option`);
    expect(out.split(/\r?\n/).filter(Boolean)).toEqual(["1|1|2|QUOTE|WORDS|1", "1|1|2|RESULTS|NUMBER|1"]);
  });

  it("ningún rol de la API lee la tabla ni el reporte; anon y authenticated tampoco registran", async () => {
    for (const role of ["service_role", "anon", "authenticated"]) {
      expect(await db.fails(`set role ${role}; select * from public.plusmedik_agent_menu_events;`), role).toContain("permission denied");
      expect(await db.fails(`set role ${role}; select * from public.plusmedik_agent_menu_report(now());`), role).toContain("permission denied");
    }
    for (const role of ["anon", "authenticated"]) expect(await db.fails(`set role ${role}; select public.plusmedik_agent_menu_event('${KEY}', 'SHOWN', null, null);`), role).toContain("permission denied");
  });

  it("reaplicar la migración no pierde lo registrado", async () => {
    await db.ok(readFileSync(join(dir, FILE), "utf8"));
    expect(await db.ok(`select count(*) from public.plusmedik_agent_menu_events`)).toBe("4");
  });
});
