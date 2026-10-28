import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Pausa y reactivación MANUAL desde el CRM (migración 15, plusmedik_attention_crm_action) contra un PostgreSQL REAL y efímero con las 15 migraciones: estado, revisión, idempotencia por
// operationId, conflictos, bloqueo de procesamientos pendientes, coexistencia con los mensajes humanos reales y privilegios. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[crm-attention-db] PostgreSQL no disponible: se omiten las pruebas de la pausa manual del CRM contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
type Json = Record<string, any>;

describe.skipIf(!bin)("pausa manual desde el CRM contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("crm_attention");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const contact = () => createHash("sha256").update(`crm-contacto-${++counter}-${Date.now()}`).digest("hex");
  const op = () => `op-${String(++counter).padStart(6, "0")}-${Date.now()}`;
  const message = () => `wamid.crm-${++counter}-${Date.now()}`;
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const first = (out: string): Json => JSON.parse(out.split("\n")[0]!);
  // Una llamada concurrente por proceso psql: el JSON de la función es la primera línea que empieza por «{».
  const concurrent = async (sql: string): Promise<Json> => {
    const result = await db.psql(sql);
    expect(result.code, result.stderr.slice(0, 300)).toBe(0);
    return JSON.parse(result.stdout.split("\n").map((line) => line.trim()).find((line) => line.startsWith("{"))!);
  };
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const reason = { pause: "CRM_MANUAL_PAUSE", resume: "CRM_MANUAL_RESUME" } as const;
  const crmSql = (operation: string, action: "pause" | "resume", key: string, actor = "crm:system", why: string = reason[action]) =>
    `select public.plusmedik_attention_crm_action('${operation}', '${action}', '${key}', '${why}', '${actor}');`;
  const act = (operation: string, action: "pause" | "resume", key: string, actor = "crm:system") => call(crmSql(operation, action, key, actor));
  const status = (key: string) => call(`select public.plusmedik_attention_status('${key}');`);
  const stateOf = async (key: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(c) from public.plusmedik_attention_contacts c where contact_key = '${key}'`));
  const eventsOf = (key: string) => db.ok(`select string_agg(kind || ':' || outcome, ',' order by received_at, id) from public.plusmedik_attention_events where contact_key = '${key}'`);
  const eventCount = async (key: string) => Number(await db.ok(`select count(*) from public.plusmedik_attention_events where contact_key = '${key}'`));
  const claim = (id: string, who: string, key: string) =>
    call(`select public.plusmedik_audit_claim_run('${id}', 'media-1', '${who}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${key}');`);
  const idOf = (id: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${id}'`);
  const row = async (id: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${id}'`));
  const reserveSql = (runId: string, who: string) => `select public.plusmedik_audit_reserve_send('${runId}'::uuid, '${who}', 1, 'quoted', 120);`;
  const humanSql = (key: string, eventKey: string, at = "now()") => `select public.plusmedik_attention_register_human_message('${eventKey}', '${key}', ${at});`;

  describe("pausar", () => {
    it("un contacto nuevo: queda HUMAN_PAUSED con motivo CRM_MANUAL_PAUSE y fuente crm_server, revisión 2, y UN evento con solo códigos", async () => {
      const key = contact();
      const operation = op();
      expect(await act(operation, "pause", key, "crm:3f2a9c")).toEqual({ outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2, replayed: false, blocked_runs: 0, late_reserved_runs: 0, replied_after_event_runs: 0 });
      expect(await stateOf(key)).toMatchObject({ state: "HUMAN_PAUSED", revision: 2, pause_reason: "CRM_MANUAL_PAUSE", pause_source: "crm_server", resumed_at: null });
      expect(await status(key)).toEqual({ exists: true, state: "HUMAN_PAUSED", revision: 2 });
      expect(await eventsOf(key)).toBe("CRM_MANUAL_PAUSE:PAUSED");
      const event = JSON.parse(await db.ok(`select to_json(e) from public.plusmedik_attention_events e where event_key = 'crm:${operation}'`));
      expect(event.detail).toEqual({ action: "pause", reason: "CRM_MANUAL_PAUSE", source: "crm_server", actor: "crm:3f2a9c" });
      expect(JSON.stringify(event)).not.toMatch(/phone|telefono|591/i);
    });

    it("NO es un mensaje humano de WhatsApp: no usa kind HUMAN_BUSINESS_APP, no guarda last_human_event_at y la fuente es distinta", async () => {
      const key = contact();
      await act(op(), "pause", key);
      expect(await eventsOf(key)).not.toMatch(/HUMAN_BUSINESS_APP/);
      expect((await stateOf(key)).last_human_event_at).toBeNull();
      expect((await stateOf(key)).pause_source).not.toBe("kapso_business_app");
    });

    it("pausar un contacto ya pausado: ALREADY_PAUSED, la revisión y el motivo originales no cambian, y queda el evento de la operación", async () => {
      const key = contact();
      await call(humanSql(key, `human_business_app:${message()}`));
      const before = await stateOf(key);
      expect(await act(op(), "pause", key)).toMatchObject({ outcome: "ALREADY_PAUSED", state: "HUMAN_PAUSED", revision: before.revision, replayed: false });
      expect(await stateOf(key)).toMatchObject({ revision: before.revision, pause_reason: "HUMAN_WHATSAPP_BUSINESS_APP", pause_source: "kapso_business_app" });
      expect(await eventsOf(key)).toBe("HUMAN_BUSINESS_APP:PAUSED,CRM_MANUAL_PAUSE:ALREADY_PAUSED");
    });

    it("bloquea los procesamientos PENDIENTES del contacto (no los de otros); su reserva responde 'blocked'", async () => {
      const key = contact();
      const other = contact();
      const [m1, m2] = [message(), message()];
      await claim(m1, owner(1), key);
      await claim(m2, owner(1), other);
      expect(await act(op(), "pause", key)).toMatchObject({ outcome: "PAUSED", blocked_runs: 1, late_reserved_runs: 0 });
      expect(await row(m1)).toMatchObject({ send_block_reason: "HUMAN_PAUSED", send_state: "NOT_RESERVED" });
      expect((await row(m1)).send_blocked_at).toBeTruthy();
      expect((await row(m2)).send_blocked_at).toBeNull();
      expect(await call(reserveSql(await idOf(m1), owner(1)))).toEqual({ status: "blocked" });
      expect(await call(reserveSql(await idOf(m2), owner(1)))).toEqual({ status: "reserved" });
    });

    it("carrera inevitable: si ya hay un envío RESERVADO, no se cancela; queda contado y la corrida marcada (igual que con una pausa humana)", async () => {
      const key = contact();
      const m = message();
      await claim(m, owner(1), key);
      expect(await call(reserveSql(await idOf(m), owner(1)))).toEqual({ status: "reserved" });
      expect(await act(op(), "pause", key)).toMatchObject({ outcome: "PAUSED", blocked_runs: 0, late_reserved_runs: 1 });
      expect(await row(m)).toMatchObject({ send_state: "RESERVED", attention_reason: "HUMAN_PAUSE_AFTER_RESERVATION" });
    });

    it("un contacto pausado no puede ser reclamado: el claim de un mensaje nuevo se suprime", async () => {
      const key = contact();
      await act(op(), "pause", key);
      const claimed = await claim(message(), owner(1), key);
      expect(claimed).toEqual({ outcome: "paused" });
      expect(await eventsOf(key)).toMatch(/PATIENT_SUPPRESSED:SUPPRESSED/);
    });
  });

  describe("reactivar", () => {
    it("pausa y reactivación: vuelve a ACTIVE (revisión +1), limpia motivo y fuente, fija resumed_at, y el estado lo refleja", async () => {
      const key = contact();
      await act(op(), "pause", key);
      const result = await act(op(), "resume", key, "crm:system");
      expect(result).toEqual({ outcome: "RESUMED", state: "ACTIVE", revision: 3, replayed: false, blocked_runs: 0, late_reserved_runs: 0, replied_after_event_runs: 0 });
      expect(await stateOf(key)).toMatchObject({ state: "ACTIVE", revision: 3, pause_reason: null, pause_source: null, paused_at: null });
      expect((await stateOf(key)).resumed_at).toBeTruthy();
      expect(await status(key)).toEqual({ exists: true, state: "ACTIVE", revision: 3 });
      expect(await eventsOf(key)).toBe("CRM_MANUAL_PAUSE:PAUSED,CRM_MANUAL_RESUME:RESUMED");
    });

    it("reactivar un contacto ya ACTIVE (o que nunca existió) es válido: ALREADY_ACTIVE, sin cambiar la revisión ni crear el registro del contacto", async () => {
      const unknown = contact();
      expect(await act(op(), "resume", unknown)).toMatchObject({ outcome: "ALREADY_ACTIVE", state: "ACTIVE", revision: 0, replayed: false });
      expect(await db.ok(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${unknown}'`)).toBe("0");
      expect(await eventsOf(unknown)).toBe("CRM_MANUAL_RESUME:ALREADY_ACTIVE");

      const key = contact();
      await act(op(), "pause", key);
      await act(op(), "resume", key);
      expect(await act(op(), "resume", key)).toMatchObject({ outcome: "ALREADY_ACTIVE", revision: 3 });
      expect((await stateOf(key)).revision).toBe(3);
    });

    it("puede reactivar una pausa HUMANA (el CRM reactiva a los 10 minutos), y un mensaje humano ANTERIOR a la reactivación ya no vuelve a pausar", async () => {
      const key = contact();
      await call(humanSql(key, `human_business_app:${message()}`));
      expect(await act(op(), "resume", key)).toMatchObject({ outcome: "RESUMED", state: "ACTIVE" });
      expect(await call(humanSql(key, `human_business_app:${message()}`, "now() - interval '5 minutes'"))).toMatchObject({ outcome: "STALE_IGNORED" });
      expect((await stateOf(key)).state).toBe("ACTIVE");
    });

    it("tras reactivar, un mensaje nuevo se procesa (el claim ya no se suprime)", async () => {
      const key = contact();
      await act(op(), "pause", key);
      await act(op(), "resume", key);
      const claimed = await claim(message(), owner(1), key);
      expect(claimed.outcome).not.toBe("paused");
      expect(claimed.run_id ?? claimed.id ?? claimed.outcome).toBeTruthy();
    });
  });

  describe("idempotencia", () => {
    it("repetir la MISMA pausa devuelve el resultado ya confirmado (replayed), sin evento nuevo ni revisión nueva", async () => {
      const key = contact();
      const operation = op();
      const firstCall = await act(operation, "pause", key);
      const again = await act(operation, "pause", key);
      expect(again).toEqual({ ...firstCall, replayed: true });
      expect(await eventCount(key)).toBe(1);
      expect((await stateOf(key)).revision).toBe(2);
    });

    it("la repetición devuelve el resultado de AQUEL momento aunque el estado haya cambiado después", async () => {
      const key = contact();
      const pauseOp = op();
      const resumeOp = op();
      await act(pauseOp, "pause", key);
      await act(resumeOp, "resume", key);
      expect(await act(pauseOp, "pause", key)).toMatchObject({ outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2, replayed: true });
      expect(await act(resumeOp, "resume", key)).toMatchObject({ outcome: "RESUMED", state: "ACTIVE", revision: 3, replayed: true });
      expect((await stateOf(key))).toMatchObject({ state: "ACTIVE", revision: 3 });
      expect(await eventCount(key)).toBe(2);
    });

    it("una repetición de reactivar sobre un contacto inexistente también es idempotente", async () => {
      const key = contact();
      const operation = op();
      await act(operation, "resume", key);
      expect(await act(operation, "resume", key)).toMatchObject({ outcome: "ALREADY_ACTIVE", replayed: true });
      expect(await eventCount(key)).toBe(1);
    });

    it("reusar un operationId para OTRA acción u OTRO contacto es un conflicto (PT409), nunca el resultado de otra operación", async () => {
      const key = contact();
      const operation = op();
      await act(operation, "pause", key);
      await expect(db.ok(asService(crmSql(operation, "resume", key)))).rejects.toThrow(/PT409|already used/);
      await expect(db.ok(asService(crmSql(operation, "pause", contact())))).rejects.toThrow(/PT409|already used/);
      expect(await eventCount(key)).toBe(1);
      expect((await stateOf(key)).state).toBe("HUMAN_PAUSED");
    });

    it("operaciones DISTINTAS sobre un contacto ya pausado: cada una deja su evento (ALREADY_PAUSED) sin tocar la revisión", async () => {
      const key = contact();
      await act(op(), "pause", key);
      const second = await act(op(), "pause", key);
      expect(second).toMatchObject({ outcome: "ALREADY_PAUSED", revision: 2, replayed: false });
      expect(await eventCount(key)).toBe(2);
    });

    it("concurrencia: 6 llamadas IDÉNTICAS a la vez producen UN solo cambio, UN solo evento y el mismo resultado confirmado", async () => {
      const key = contact();
      const operation = op();
      const results = await Promise.all(Array.from({ length: 6 }, () => concurrent(asService(crmSql(operation, "pause", key)))));
      expect(results.every((r) => r.outcome === "PAUSED" && r.revision === 2)).toBe(true);
      expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
      expect(await eventCount(key)).toBe(1);
      expect((await stateOf(key)).revision).toBe(2);
    });

    it("concurrencia: reactivar 6 veces a la vez sobre un contacto inexistente deja UN evento y todas confirman", async () => {
      const key = contact();
      const operation = op();
      const results = await Promise.all(Array.from({ length: 6 }, () => concurrent(asService(crmSql(operation, "resume", key)))));
      expect(results.every((r) => r.outcome === "ALREADY_ACTIVE")).toBe(true);
      expect(await eventCount(key)).toBe(1);
    });

    it("concurrencia: una pausa del CRM y un mensaje humano real a la vez dejan el contacto pausado con UNA sola subida de revisión", async () => {
      const key = contact();
      await Promise.all([db.psql(asService(crmSql(op(), "pause", key))), db.psql(asService(humanSql(key, `human_business_app:${message()}`)))]);
      expect(await stateOf(key)).toMatchObject({ state: "HUMAN_PAUSED", revision: 2 });
    });
  });

  describe("validación y privilegios", () => {
    it.each([
      ["operationId corto", () => crmSql("corto", "pause", "a".repeat(64))],
      ["operationId con caracteres no permitidos", () => crmSql("op con espacio 1", "pause", "a".repeat(64))],
      ["acción desconocida", () => `select public.plusmedik_attention_crm_action('op-valido-0001', 'delete', '${"a".repeat(64)}', 'CRM_MANUAL_PAUSE', 'crm:system');`],
      ["contacto que no es un HMAC", () => crmSql("op-valido-0002", "pause", "5917000000")],
      ["motivo que no corresponde a la acción", () => crmSql("op-valido-0003", "pause", "a".repeat(64), "crm:system", "CRM_MANUAL_RESUME")],
      ["motivo libre", () => crmSql("op-valido-0004", "pause", "a".repeat(64), "crm:system", "paciente molesto")],
      ["actor sin el prefijo crm:", () => crmSql("op-valido-0005", "pause", "a".repeat(64), "juan")],
      ["actor con correo", () => crmSql("op-valido-0006", "pause", "a".repeat(64), "crm:juan@gmail.com")]
    ])("rechaza %s (PT422) y no deja ningún rastro", async (_name, sql) => {
      await expect(db.ok(asService(sql()))).rejects.toThrow(/PT422|invalid crm action/);
      expect(await db.ok(`select count(*) from public.plusmedik_attention_events where event_key like 'crm:%' and contact_key = '${"a".repeat(64)}'`)).toBe("0");
    });

    it("solo service_role puede ejecutarla: anon, authenticated y public no", async () => {
      const key = contact();
      for (const role of ["anon", "authenticated"]) {
        await expect(db.ok(`set role ${role}; ${crmSql(op(), "pause", key)}`)).rejects.toThrow(/permission denied/);
      }
      expect(await db.ok(`select has_function_privilege('public', 'public.plusmedik_attention_crm_action(text,text,text,text,text)', 'execute')`)).toBe("f");
      expect(await db.ok(`select has_function_privilege('service_role', 'public.plusmedik_attention_crm_action(text,text,text,text,text)', 'execute')`)).toBe("t");
      expect(await db.ok(`select prosecdef from pg_proc where proname = 'plusmedik_attention_crm_action'`)).toBe("t");
    });

    it("las restricciones de eventos quedaron AMPLIADAS y reemplazadas (sin duplicados), y los eventos siguen siendo inmutables", async () => {
      expect((await db.ok(`select string_agg(conname, ',' order by conname) from pg_constraint where conrelid = 'public.plusmedik_attention_events'::regclass and contype = 'c'`)).split(",")).toEqual(
        expect.arrayContaining(["plusmedik_attention_events_kind_crm_check", "plusmedik_attention_events_outcome_crm_check"])
      );
      expect(await db.ok(`select count(*) from pg_constraint where conrelid = 'public.plusmedik_attention_events'::regclass and conname in ('plusmedik_attention_events_kind_check', 'plusmedik_attention_events_outcome_check')`)).toBe("0");
      const key = contact();
      const operation = op();
      await act(operation, "pause", key);
      await expect(db.ok(asService(`update public.plusmedik_attention_events set outcome = 'RESUMED' where event_key = 'crm:${operation}'`))).rejects.toThrow();
    });

    it("reaplicar la migración 15 (reintento tras un corte) no falla ni cambia lo ya confirmado", async () => {
      const key = contact();
      const operation = op();
      await act(operation, "pause", key);
      await db.applyFile(join(dir, MIGRATIONS.at(-1)!));
      expect(await act(operation, "pause", key)).toMatchObject({ outcome: "PAUSED", revision: 2, replayed: true });
      expect(await eventCount(key)).toBe(1);
    });
  });
});
