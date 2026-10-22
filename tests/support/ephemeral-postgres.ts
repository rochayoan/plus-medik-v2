import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

// PostgreSQL EFÍMERO para probar las migraciones y las funciones contra una base real: un clúster nuevo en un directorio temporal, en un puerto libre de
// 127.0.0.1, que se destruye al terminar. No toca ninguna instancia existente ni se conecta a ningún Supabase. Si no hay binarios de PostgreSQL, las pruebas
// que lo usan se omiten (con aviso): no se sustituyen por pruebas de texto.
//   PLUSMEDIK_PG_BIN=<carpeta bin de PostgreSQL>  fuerza una instalación concreta.

const run = promisify(execFile);
const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

// pg_ctl deja el servidor como proceso hijo: con tuberías el hijo hereda stdout/stderr y execFile no termina nunca. Se lanza con stdio ignorado.
function runDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} terminó con código ${code}`))));
  });
}

export function findPostgresBin(): string | undefined {
  const candidates: string[] = [];
  if (process.env.PLUSMEDIK_PG_BIN) candidates.push(process.env.PLUSMEDIK_PG_BIN);
  for (const root of ["C:\\Program Files\\PostgreSQL", "/usr/lib/postgresql"]) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a));
    for (const version of versions) candidates.push(existsSync(join(root, version, "bin")) ? join(root, version, "bin") : join(root, version));
  }
  for (const folder of (process.env.PATH ?? "").split(delimiter)) if (folder) candidates.push(folder);
  return candidates.find((folder) => existsSync(join(folder, exe("initdb"))) && existsSync(join(folder, exe("psql"))) && existsSync(join(folder, exe("pg_ctl"))));
}

export interface PsqlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface PgDatabase {
  psql(sql: string): Promise<PsqlResult>;
  // Ejecuta y exige éxito; devuelve la salida (sin espacios en los extremos).
  ok(sql: string): Promise<string>;
  // Ejecuta y exige error; devuelve el texto del error (con SQLSTATE).
  fails(sql: string): Promise<string>;
  applyFile(path: string): Promise<void>;
}

export interface EphemeralPostgres {
  createDatabase(name: string): Promise<PgDatabase>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export async function startEphemeralPostgres(bin: string): Promise<EphemeralPostgres> {
  const dir = await mkdtemp(join(tmpdir(), "plusmedik-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  await run(join(bin, exe("initdb")), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"], { windowsHide: true });
  await runDetached(join(bin, exe("pg_ctl")), ["-D", data, "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c max_connections=30`, "-l", join(dir, "server.log"), "-w", "start"]);

  const base = ["-X", "-q", "-t", "-A", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres"];
  const env = { ...process.env, PGCLIENTENCODING: "UTF8", PGCONNECT_TIMEOUT: "15", PGOPTIONS: "" };
  const psql = (sql: string, database: string): Promise<PsqlResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(join(bin, exe("psql")), [...base, "-d", database], { env, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(`\\set VERBOSITY verbose\n\\set ON_ERROR_STOP on\n${sql}\n`);
    });

  return {
    async createDatabase(name) {
      if (!/^[a-z_]+$/.test(name)) throw new Error("nombre de base inválido");
      await run(join(bin, exe("psql")), [...base, "-d", "postgres", "-c", `create database ${name}`], { env, windowsHide: true });
      const database: PgDatabase = {
        psql: (sql) => psql(sql, name),
        async ok(sql) {
          const result = await psql(sql, name);
          if (result.code !== 0) throw new Error(`psql falló (${result.code}): ${result.stderr.slice(0, 600)}`);
          return result.stdout.trim();
        },
        async fails(sql) {
          const result = await psql(sql, name);
          if (result.code === 0) throw new Error(`se esperaba un error y la sentencia tuvo éxito: ${sql.slice(0, 200)}`);
          return result.stderr;
        },
        async applyFile(path) {
          await database.ok(await readFile(path, "utf8"));
        }
      };
      return database;
    },
    async stop() {
      try {
        await runDetached(join(bin, exe("pg_ctl")), ["-D", data, "-m", "immediate", "-w", "stop"]);
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  };
}

// Roles (a nivel de clúster) y privilegios por defecto (por base) como en Supabase: lo que las migraciones de auditoría suponen. Va ANTES de las migraciones.
export const SUPABASE_BOOTSTRAP_SQL = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'unprivileged') then create role unprivileged nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role, unprivileged;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
`;
