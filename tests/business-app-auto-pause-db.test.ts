import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

const bin = findPostgresBin();
if (!bin) console.warn("[business-app-auto-pause-db] PostgreSQL no disponible.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const root = join(__dirname, "..", "supabase");
const required = [
  "20261020000000_plusmedik_persistent_audit.sql",
  "20261021000000_plusmedik_audit_telemetry.sql",
  "20261022000000_plusmedik_audit_transactional.sql",
  "20261023000000_plusmedik_audit_leases.sql",
  "20261024000000_plusmedik_human_control.sql"
];

describe.skipIf(!bin)("pausa humana a 10 minutos contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let seq = 0;
  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("auto_human_idle");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of required) await db.applyFile(join(root, "migrations", file));
    await db.applyFile(join(root, "pending-migrations", "20261105000000_plusmedik_human_idle_resume.sql"));
  });
  afterAll(async () => { await server?.stop(); });

  const key = () => createHash("sha256").update("auto-pause-" + (++seq) + "-" + Date.now()).digest("hex");
  const service = (sql: string) => "set role service_role; " + sql;
  const call = async (sql: string) => JSON.parse((await db.ok(service(sql))).split("\n")[0]!);
  const register = (who: string) => call("select public.plusmedik_attention_register_human_message('human_business_app:wamid." + (++seq) + "', '" + who + "', now());");
  const expire = (who: string) => db.ok("update public.plusmedik_attention_contacts set paused_at = now() - interval '11 minutes', last_human_event_at = now() - interval '11 minutes' where contact_key = '" + who + "';");
  const resume = (who: string) => call("select public.plusmedik_attention_resume_if_idle('" + who + "');");
  const state = (who: string) => db.ok("select state from public.plusmedik_attention_contacts where contact_key = '" + who + "';");

  it("dentro de 10 minutos preserva la pausa; al vencer reactiva una sola vez", async () => {
    const who = key();
    expect((await register(who)).outcome).toBe("PAUSED");
    expect(await resume(who)).toEqual({ outcome: "NOT_DUE" });
    expect(await state(who)).toBe("HUMAN_PAUSED");
    await expire(who);
    expect(await resume(who)).toEqual({ outcome: "RESUMED" });
    expect(await resume(who)).toEqual({ outcome: "ALREADY_ACTIVE" });
    expect(await state(who)).toBe("ACTIVE");
    expect(await db.ok("select count(*) from public.plusmedik_attention_events where contact_key = '" + who + "' and kind = 'MANUAL_RESUME' and detail->>'source' = 'agent_auto';")).toBe("1");
  });

  it("la última intervención reinicia los 10 minutos", async () => {
    const who = key();
    await register(who);
    await expire(who);
    expect((await register(who)).outcome).toBe("ALREADY_PAUSED");
    expect(await resume(who)).toEqual({ outcome: "NOT_DUE" });
    expect(await state(who)).toBe("HUMAN_PAUSED");
  });

  it("nunca reactiva pausas manuales ni afecta otros contactos", async () => {
    const one = key(), other = key();
    await register(one);
    await register(other);
    await expire(one);
    await db.ok("update public.plusmedik_attention_contacts set pause_source = 'crm_server' where contact_key = '" + one + "';");
    expect(await resume(one)).toEqual({ outcome: "MANUAL_PAUSED" });
    expect(await state(one)).toBe("HUMAN_PAUSED");
    expect(await resume(other)).toEqual({ outcome: "NOT_DUE" });
    expect(await state(other)).toBe("HUMAN_PAUSED");
  });

  it("la RPC es inaccesible para anon y authenticated", async () => {
    const who = key();
    expect(await db.fails("set role anon; select public.plusmedik_attention_resume_if_idle('" + who + "');")).toMatch(/permission denied|42501/i);
    expect(await db.fails("set role authenticated; select public.plusmedik_attention_resume_if_idle('" + who + "');")).toMatch(/permission denied|42501/i);
  });
});
