import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Control de atención humana contra un PostgreSQL REAL y efímero: estado persistente por contacto, deduplicación, orden de eventos, bloqueo de procesamientos
// pendientes y coordinación con la reserva de envío (concurrencia real con procesos psql). Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[human-control-db] PostgreSQL no disponible: se omiten las pruebas de control de atención contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = ["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql", "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"].map((name) => join(dir, name));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;
const SENTINEL = "SENTINELA_CLINICA_77";

describe.skipIf(!bin)("control de atención humana contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("attention");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(file);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const contact = () => createHash("sha256").update(`contacto-${++counter}-${Date.now()}`).digest("hex");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const messageId = () => `wamid.hc-${++counter}-${Date.now()}`;
  const first = (out: string): Json => JSON.parse(out.split("\n")[0]!);
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const sec = (seconds: number) => `now() + interval '${seconds} seconds'`;
  const registerSql = (key: string, eventKey: string, at = "now()") => `select public.plusmedik_attention_register_human_message('${eventKey}', '${key}', ${at});`;
  const register = (key: string, eventKey = `human_business_app:${messageId()}`, at = "now()") => call(registerSql(key, eventKey, at));
  const claimSql = (message: string, who: string, key?: string | null) =>
    `select public.plusmedik_audit_claim_run('${message}', 'media-1', '${who}', 120, 2, 'abc1234', '{}'::jsonb, 3${key === undefined ? "" : `, ${key === null ? "null" : `'${key}'`}`});`;
  const claim = (message: string, who: string, key?: string | null) => call(claimSql(message, who, key));
  const idOf = (message: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const row = async (message: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const state = async (key: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(c) from public.plusmedik_attention_contacts c where contact_key = '${key}'`));
  const events = (key: string) => db.ok(`select string_agg(kind || ':' || outcome, ',' order by received_at, id) from public.plusmedik_attention_events where contact_key = '${key}'`);
  const reserveSql = (runId: string, who: string, fence = 1, kind = "quoted") => `select public.plusmedik_audit_reserve_send('${runId}'::uuid, '${who}', ${fence}, '${kind}', 120);`;
  const confirmSql = (runId: string, who: string, fence = 1) => `select public.plusmedik_audit_confirm_send('${runId}'::uuid, '${who}', ${fence});`;
  const replySql = (runId: string, who: string, fence = 1) => `select public.plusmedik_audit_fenced_record_reply('${runId}'::uuid, '${who}', ${fence}, '{"state":"ACCEPTED","result":"quoted","processing_status":"COMPLETED"}'::jsonb);`;
  const evidenceSql = (runId: string, who: string, fence = 1) =>
    `select public.plusmedik_audit_fenced_record_evidence('${runId}'::uuid, '${who}', ${fence}, '{"contract":1,"run":{"analysis_decision":"AUTO_SAFE","analysis_outcome":"AUTO_COMPLETE","review_required":false,"recipe_stops":[]},"studies":[],"model_calls":[],"checks":[]}'::jsonb);`;
  const withProof = (message: string, update: string) => `select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; ${update}`;

  describe("estado persistente por contacto", () => {
    it("un contacto que todavía no existe: la fila se crea, se pausa con motivo/fuente/revisión y queda el evento", async () => {
      const key = contact();
      expect(await db.ok(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${key}'`)).toBe("0");
      expect(await call(`select public.plusmedik_attention_status('${key}');`)).toEqual({ exists: false, state: "ACTIVE", revision: 0 });
      const result = await register(key, "human_business_app:wamid.new-1");
      expect(result).toMatchObject({ outcome: "PAUSED", state: "HUMAN_PAUSED", revision: 2, blocked_runs: 0 });
      expect(await state(key)).toMatchObject({ state: "HUMAN_PAUSED", revision: 2, pause_reason: "HUMAN_WHATSAPP_BUSINESS_APP", pause_source: "kapso_business_app", resumed_at: null });
      expect((await state(key)).paused_at).toBeTruthy();
      expect(await events(key)).toBe("HUMAN_BUSINESS_APP:PAUSED");
      expect(await call(`select public.plusmedik_attention_status('${key}');`)).toEqual({ exists: true, state: "HUMAN_PAUSED", revision: 2 });
    });

    it("no guarda teléfonos: la tabla de control solo contiene la clave HMAC y datos de estado", async () => {
      const columns = await db.ok(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'plusmedik_attention_contacts'`);
      expect(columns).toBe("contact_key,state,revision,paused_at,pause_reason,pause_source,resumed_at,last_human_event_at,created_at,updated_at");
      expect(await db.ok(`select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'plusmedik_attention_events'`)).not.toMatch(/phone|text|body|content/);
    });

    it("evento DUPLICADO (mismo event_key): no cambia nada y no duplica el registro", async () => {
      const key = contact();
      await register(key, "human_business_app:dup-1");
      const again = await register(key, "human_business_app:dup-1");
      expect(again).toMatchObject({ outcome: "duplicate", revision: 2 });
      expect(await db.ok(`select count(*) from public.plusmedik_attention_events where event_key = 'human_business_app:dup-1'`)).toBe("1");
      expect((await state(key)).revision).toBe(2);
    });

    it("otro mensaje humano mientras está pausado: ALREADY_PAUSED sin subir la revisión; un evento FUERA DE ORDEN (más antiguo) no retrocede el último instante", async () => {
      const key = contact();
      await register(key, "human_business_app:ord-new", "now() - interval '1 minute'");
      const afterFirst = (await state(key)).last_human_event_at;
      const older = await register(key, "human_business_app:ord-old", "now() - interval '10 minutes'");
      expect(older).toMatchObject({ outcome: "ALREADY_PAUSED", revision: 2 });
      expect((await state(key)).last_human_event_at).toBe(afterFirst);
      const newer = await register(key, "human_business_app:ord-newest", "now()");
      expect(newer.outcome).toBe("ALREADY_PAUSED");
      expect(new Date((await state(key)).last_human_event_at).getTime()).toBeGreaterThan(new Date(afterFirst).getTime());
      expect(await events(key)).toBe("HUMAN_BUSINESS_APP:PAUSED,HUMAN_BUSINESS_APP:ALREADY_PAUSED,HUMAN_BUSINESS_APP:ALREADY_PAUSED");
    });

    it("EVENTO RETRASADO: uno anterior a una reactivación legítima NO vuelve a pausar; uno posterior sí", async () => {
      const key = contact();
      await register(key, "human_business_app:late-1", "now() - interval '5 minutes'");
      expect(await call(`select public.plusmedik_attention_resume('${key}', 'MANUAL_RESUME', 'ops_user');`)).toMatchObject({ outcome: "resumed", revision: 3 });
      expect(await state(key)).toMatchObject({ state: "ACTIVE", paused_at: null, pause_reason: null });
      // el mismo mensaje humano reenviado tarde (duplicado) o uno anterior a la reactivación
      expect((await register(key, "human_business_app:late-1", "now() - interval '5 minutes'")).outcome).toBe("duplicate");
      const stale = await register(key, "human_business_app:late-2", "now() - interval '4 minutes'");
      expect(stale).toMatchObject({ outcome: "STALE_IGNORED", state: "ACTIVE", revision: 3 });
      expect((await state(key)).state).toBe("ACTIVE");
      const fresh = await register(key, "human_business_app:late-3", sec(2));
      expect(fresh).toMatchObject({ outcome: "PAUSED", revision: 4 });
      expect(await events(key)).toBe("HUMAN_BUSINESS_APP:PAUSED,MANUAL_RESUME:RESUMED,HUMAN_BUSINESS_APP:STALE_IGNORED,HUMAN_BUSINESS_APP:PAUSED");
    });

    it("reactivar un contacto activo o inexistente no hace nada", async () => {
      const key = contact();
      expect(await call(`select public.plusmedik_attention_resume('${key}', 'MANUAL_RESUME', 'ops_user');`)).toMatchObject({ outcome: "already_active" });
      await register(key);
      await call(`select public.plusmedik_attention_resume('${key}', 'MANUAL_RESUME', 'ops_user');`);
      expect(await call(`select public.plusmedik_attention_resume('${key}', 'MANUAL_RESUME', 'ops_user');`)).toMatchObject({ outcome: "already_active", revision: 3 });
    });

    it("eventos informativos (origen desconocido, otra app, agente de Meta): se registran sin cambiar el estado y se deduplican", async () => {
      const key = contact();
      const record = (eventKey: string, kind: string, contactSql = `'${key}'`) => call(`select public.plusmedik_attention_record_event('${eventKey}', ${contactSql}, '${kind}', now(), '{"origin":"missing"}'::jsonb);`);
      expect(await record("unknown_origin:wamid.i-1", "UNKNOWN_ORIGIN")).toEqual({ outcome: "RECORDED" });
      expect(await record("unknown_origin:wamid.i-1", "UNKNOWN_ORIGIN")).toEqual({ outcome: "duplicate" });
      expect(await record("other_app_outbound:wamid.i-2", "OTHER_APP_OUTBOUND")).toEqual({ outcome: "RECORDED" });
      expect(await record("unknown_origin:wamid.i-3", "UNKNOWN_ORIGIN", "null")).toEqual({ outcome: "RECORDED" });
      expect(await db.ok(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${key}'`)).toBe("0"); // no crea ni cambia estado
      expect(await events(key)).toBe("UNKNOWN_ORIGIN:RECORDED,OTHER_APP_OUTBOUND:RECORDED");
      expect(await db.fails(asService(`select public.plusmedik_attention_record_event('x', '${key}', 'HUMAN_BUSINESS_APP', now(), '{}'::jsonb);`))).toContain("PT422");
    });
  });

  describe("procesamientos pendientes y reserva de envío", () => {
    it("un contacto pausado no se procesa: el claim lo informa, no crea corrida y deja el evento (una vez por mensaje)", async () => {
      const key = contact();
      await register(key);
      const message = messageId();
      expect(await claim(message, owner(1), key)).toEqual({ outcome: "paused" });
      expect(await claim(message, owner(2), key)).toEqual({ outcome: "paused" });
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where kapso_message_id = '${message}'`)).toBe("0");
      expect(await db.ok(`select count(*) from public.plusmedik_attention_events where event_key = 'inbound:${message}' and kind = 'PATIENT_SUPPRESSED' and outcome = 'SUPPRESSED'`)).toBe("1");
    });

    it("un contacto activo se procesa con normalidad y la corrida guarda su clave; otro contacto no se ve afectado por la pausa", async () => {
      const paused = contact();
      const active = contact();
      await register(paused);
      const message = messageId();
      expect(await claim(message, owner(1), active)).toMatchObject({ outcome: "claimed", fence: 1 });
      expect((await row(message)).contact_key).toBe(active);
      expect(await claim(messageId(), owner(1), null)).toMatchObject({ outcome: "claimed" }); // sin control de atención (comportamiento anterior)
      expect(await claim(messageId(), owner(1))).toMatchObject({ outcome: "claimed" });
      expect(await db.fails(asService(claimSql(messageId(), owner(1), "no-es-una-clave")))).toContain("PT422");
    });

    it("al pausar se bloquean los procesamientos PENDIENTES de ese contacto (no los de otros); su reserva responde 'blocked' y no hay envío", async () => {
      const key = contact();
      const other = contact();
      const [m1, m2, m3] = [messageId(), messageId(), messageId()];
      await claim(m1, owner(1), key);
      await claim(m2, owner(1), key);
      await call(evidenceSql(await idOf(m2), owner(1)));
      await claim(m3, owner(1), other);
      const result = await register(key);
      expect(result).toMatchObject({ outcome: "PAUSED", blocked_runs: 2, late_reserved_runs: 0 });
      expect(await row(m1)).toMatchObject({ send_block_reason: "HUMAN_PAUSED", send_state: "NOT_RESERVED" });
      expect((await row(m1)).send_blocked_at).toBeTruthy();
      expect(await row(m2)).toMatchObject({ send_block_reason: "HUMAN_PAUSED", processing_status: "ANALYZED" });
      expect((await row(m3)).send_blocked_at).toBeNull();
      expect(await call(reserveSql(await idOf(m1), owner(1)))).toEqual({ status: "blocked" });
      expect(await row(m1)).toMatchObject({ send_state: "CANCELLED", processing_status: "COMPLETED" });
      expect(await call(reserveSql(await idOf(m3), owner(1)))).toEqual({ status: "reserved" });
    });

    it("la pausa se cuenta una sola vez: reintentos y eventos adicionales no vuelven a bloquear lo ya bloqueado", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      expect(await register(key, "human_business_app:b-1")).toMatchObject({ blocked_runs: 1 });
      expect(await register(key, "human_business_app:b-2")).toMatchObject({ outcome: "ALREADY_PAUSED", blocked_runs: 0 });
    });

    it("respaldo de la reserva: aunque la corrida no se haya bloqueado (carrera con el claim), la reserva consulta el estado del contacto", async () => {
      const key = contact();
      const message = messageId();
      // El claim se confirma DESPUÉS de que se registró la pausa: la pausa no pudo ver la corrida (aún sin confirmar).
      const claiming = db.psql(`set role service_role; begin; ${claimSql(message, owner(1), key)} select pg_sleep(1.5); commit;`);
      await sleep(500);
      const pausing = await register(key);
      await claiming;
      expect(pausing).toMatchObject({ outcome: "PAUSED", blocked_runs: 0 });
      expect((await row(message)).send_blocked_at).toBeNull();
      expect(await call(reserveSql(await idOf(message), owner(1)))).toEqual({ status: "blocked" });
      expect(await row(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
    });

    it("reactivar no desbloquea lo ya cancelado (seguro): el paciente puede reenviar", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      await register(key);
      await call(`select public.plusmedik_attention_resume('${key}', 'MANUAL_RESUME', 'ops_user');`);
      expect(await call(reserveSql(await idOf(message), owner(1)))).toEqual({ status: "blocked" });
      const resend = messageId();
      expect(await claim(resend, owner(1), key)).toMatchObject({ outcome: "claimed" });
    });
  });

  describe("comprobación final y carreras que no se pueden evitar", () => {
    it("pausa DESPUÉS de reservar y ANTES de la comprobación final: la reserva se libera y no se envía", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      const runId = await idOf(message);
      await call(evidenceSql(runId, owner(1)));
      expect(await call(reserveSql(runId, owner(1)))).toEqual({ status: "reserved" });
      const race = await register(key);
      expect(race).toMatchObject({ outcome: "PAUSED", blocked_runs: 0, late_reserved_runs: 1, replied_after_event_runs: 0 }); // el mensaje humano es posterior a la reserva
      expect(await row(message)).toMatchObject({ send_state: "RESERVED", attention_reason: "HUMAN_PAUSE_AFTER_RESERVATION" });
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "blocked" });
      expect(await row(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED", attention_reason: null, processing_status: "COMPLETED" });
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "blocked" }); // idempotente
      expect(await db.fails(asService(replySql(runId, owner(1))))).toContain("PT409"); // no se puede registrar un envío que no ocurrió
      expect(await db.ok(`select string_agg(outcome || ':' || late_reserved_runs, ',') from public.plusmedik_attention_events where contact_key = '${key}'`)).toBe("PAUSED:1");
    });

    it("sin pausa, la comprobación final autoriza; sin reserva o con otro propietario no", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      const runId = await idOf(message);
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "closed" }); // sin reserva
      await call(reserveSql(runId, owner(1)));
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "proceed" });
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "proceed" });
      expect(await db.fails(asService(confirmSql(runId, owner(2))))).toContain("PT410");
      expect(await db.fails(asService(confirmSql(runId, owner(1), 2)))).toContain("PT410");
    });

    it("pausa DURANTE la llamada externa (después de la comprobación final): el envío NO se puede cancelar; queda registrado como carrera y marcado en la corrida", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      const runId = await idOf(message);
      await call(reserveSql(runId, owner(1)));
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "proceed" });
      // el evento humano llega mientras Kapso procesa el envío
      const race = await register(key);
      expect(race).toMatchObject({ outcome: "PAUSED", late_reserved_runs: 1, replied_after_event_runs: 0 });
      expect(await call(replySql(runId, owner(1)))).toEqual({ status: "recorded" });
      expect(await row(message)).toMatchObject({ send_state: "ACCEPTED", attention_reason: "HUMAN_PAUSE_AFTER_RESERVATION" });
    });

    it("el bot respondió DESPUÉS del mensaje humano pero antes de que se registrara la pausa: se cuenta y se marca (BOT_REPLIED_AFTER_HUMAN_EVENT); lo respondido antes no", async () => {
      const key = contact();
      const early = messageId();
      const late = messageId();
      await claim(early, owner(1), key);
      await call(reserveSql(await idOf(early), owner(1)));
      await call(replySql(await idOf(early), owner(1)));
      await sleep(1200);
      await claim(late, owner(1), key);
      await call(reserveSql(await idOf(late), owner(1)));
      await call(replySql(await idOf(late), owner(1)));
      // el mensaje humano ocurrió entre ambas reservas (instante derivado de la propia base: determinista)
      const between = `(select send_reserved_at - interval '500 milliseconds' from public.plusmedik_audit_runs where kapso_message_id = '${late}')`;
      const result = await register(key, `human_business_app:${messageId()}`, between);
      expect(result).toMatchObject({ outcome: "PAUSED", replied_after_event_runs: 1, late_reserved_runs: 0 });
      expect((await row(early)).attention_reason).toBeNull();
      expect((await row(late)).attention_reason).toBe("BOT_REPLIED_AFTER_HUMAN_EVENT");
    });
  });

  describe("concurrencia", () => {
    it("varios webhooks con el MISMO evento a la vez: una sola pausa, un solo registro, los demás son duplicados", async () => {
      const key = contact();
      const eventKey = "human_business_app:wamid.conc-1";
      const results = await Promise.all(Array.from({ length: 6 }, () => db.psql(asService(registerSql(key, eventKey)))));
      expect(results.every((r) => r.code === 0)).toBe(true);
      const outcomes = results.map((r) => first(r.stdout).outcome).sort();
      expect(outcomes.filter((o) => o === "PAUSED")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(5);
      expect(await db.ok(`select count(*) from public.plusmedik_attention_events where event_key = '${eventKey}'`)).toBe("1");
      expect((await state(key)).revision).toBe(2);
    });

    it("varios mensajes humanos distintos a la vez: una sola transición a pausa (revisión 2) y el resto ALREADY_PAUSED", async () => {
      const key = contact();
      const results = await Promise.all(Array.from({ length: 5 }, (_v, i) => db.psql(asService(registerSql(key, `human_business_app:wamid.multi-${counter}-${i}`)))));
      expect(results.every((r) => r.code === 0)).toBe(true);
      const outcomes = results.map((r) => first(r.stdout).outcome).sort();
      expect(outcomes).toEqual(["ALREADY_PAUSED", "ALREADY_PAUSED", "ALREADY_PAUSED", "ALREADY_PAUSED", "PAUSED"]);
      expect((await state(key)).revision).toBe(2);
    });

    it("pausa vs reserva en carrera, orden A: la reserva gana (la pausa llega tarde y lo registra)", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      const runId = await idOf(message);
      const reserving = db.psql(`set role service_role; begin; ${reserveSql(runId, owner(1))} select pg_sleep(1.5); commit;`);
      await sleep(500);
      const pausing = db.psql(asService(registerSql(key, "human_business_app:wamid.race-a")));
      const [r, p] = await Promise.all([reserving, pausing]);
      expect(first(r.stdout).status).toBe("reserved");
      expect(first(p.stdout)).toMatchObject({ outcome: "PAUSED", blocked_runs: 0, late_reserved_runs: 1 });
      expect(await call(confirmSql(runId, owner(1)))).toEqual({ status: "blocked" });
    });

    it("pausa vs reserva en carrera, orden B: la pausa gana (la reserva espera y se deniega)", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      const runId = await idOf(message);
      const pausing = db.psql(`set role service_role; begin; ${registerSql(key, "human_business_app:wamid.race-b")} select pg_sleep(1.5); commit;`);
      await sleep(500);
      const reserving = db.psql(asService(reserveSql(runId, owner(1))));
      const [p, r] = await Promise.all([pausing, reserving]);
      expect(first(p.stdout)).toMatchObject({ outcome: "PAUSED", blocked_runs: 1 });
      expect(first(r.stdout).status).toBe("blocked");
    });

    it("sin interbloqueos: pausas, reservas, confirmaciones y reclamos entrelazados sobre varios contactos terminan todos", async () => {
      const contacts = Array.from({ length: 4 }, () => contact());
      const runs: Array<{ key: string; message: string; runId: string }> = [];
      for (const key of contacts) for (let i = 0; i < 2; i++) {
        const message = messageId();
        await claim(message, owner(1), key);
        runs.push({ key, message, runId: await idOf(message) });
      }
      const jobs = [
        ...contacts.map((key, i) => db.psql(asService(registerSql(key, `human_business_app:wamid.dl-${counter}-${i}`)))),
        ...runs.map((run) => db.psql(asService(`${reserveSql(run.runId, owner(1))} ${confirmSql(run.runId, owner(1))}`))),
        ...contacts.map((key) => db.psql(asService(claimSql(messageId(), owner(3), key))))
      ];
      const results = await Promise.all(jobs);
      for (const result of results) expect(result.stderr, result.stderr).not.toMatch(/deadlock|40P01/i);
      expect(results.every((r) => r.code === 0)).toBe(true);
      // todas las corridas terminan en un estado coherente: o se autorizó el envío (RESERVED) o se canceló por la pausa
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = any(array['${contacts.join("','")}']) and send_state not in ('RESERVED','CANCELLED','NOT_RESERVED')`)).toBe("0");
    });
  });

  describe("seguridad de las tablas y de las funciones", () => {
    it.each(["anon", "authenticated", "unprivileged"])("%s no puede ejecutar las funciones de atención ni leer las tablas", async (role) => {
      const key = "a".repeat(64);
      for (const sql of [
        `select public.plusmedik_attention_status('${key}');`,
        registerSql(key, "k"),
        `select public.plusmedik_attention_record_event('k', null, 'UNKNOWN_ORIGIN');`,
        `select public.plusmedik_attention_resume('${key}', 'r', 'a');`,
        confirmSql("00000000-0000-0000-0000-000000000000", owner(1)),
        `select count(*) from public.plusmedik_attention_contacts;`,
        `select count(*) from public.plusmedik_attention_events;`
      ]) expect(await db.fails(`set role ${role}; ${sql}`), sql.slice(0, 60)).toContain("42501");
    });

    it("service_role solo LEE las tablas de atención: no inserta, no actualiza, no borra", async () => {
      const key = contact();
      await register(key);
      expect(await db.ok(asService(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${key}';`))).toBe("1");
      for (const sql of [
        `insert into public.plusmedik_attention_contacts (contact_key) values ('${"b".repeat(64)}');`,
        `update public.plusmedik_attention_contacts set state = 'ACTIVE' where contact_key = '${key}';`,
        `delete from public.plusmedik_attention_contacts;`,
        `truncate public.plusmedik_attention_contacts;`,
        `insert into public.plusmedik_attention_events (event_key, kind, outcome) values ('k', 'MANUAL_RESUME', 'RESUMED');`,
        `update public.plusmedik_attention_events set outcome = 'RECORDED';`,
        `delete from public.plusmedik_attention_events;`
      ]) expect(await db.fails(asService(sql)), sql.slice(0, 60)).toContain("42501");
    });

    it("ni el propietario puede saltarse las reglas: eventos inmutables, contactos sin borrar, revisión coherente, identidad fija", async () => {
      const key = contact();
      await register(key, "human_business_app:imm-1");
      expect(await db.fails(`update public.plusmedik_attention_events set outcome = 'RECORDED' where event_key = 'human_business_app:imm-1';`)).toContain("PT409");
      expect(await db.fails(`delete from public.plusmedik_attention_events where event_key = 'human_business_app:imm-1';`)).toContain("PT409");
      expect(await db.fails(`truncate public.plusmedik_attention_events;`)).toContain("PT409");
      expect(await db.fails(`delete from public.plusmedik_attention_contacts where contact_key = '${key}';`)).toContain("PT409");
      expect(await db.fails(`truncate public.plusmedik_attention_contacts;`)).toContain("PT409");
      expect(await db.fails(`update public.plusmedik_attention_contacts set state = 'ACTIVE' where contact_key = '${key}';`)).toContain("PT409"); // sin avanzar la revisión
      expect(await db.fails(`update public.plusmedik_attention_contacts set revision = revision + 5 where contact_key = '${key}';`)).toContain("PT409");
      expect(await db.fails(`update public.plusmedik_attention_contacts set contact_key = '${"c".repeat(64)}' where contact_key = '${key}';`)).toContain("PT409");
      expect(await db.fails(`update public.plusmedik_attention_contacts set state = 'HUMAN_PAUSED', revision = revision where contact_key = '${key}' and false; update public.plusmedik_attention_contacts set paused_at = null where contact_key = '${key}';`)).toContain("23514"); // pausado exige paused_at
    });

    it("entradas inválidas se rechazan sin eco de valores", async () => {
      const key = contact();
      for (const sql of [
        `select public.plusmedik_attention_register_human_message('con espacios ${SENTINEL}', '${key}');`,
        `select public.plusmedik_attention_register_human_message('k', 'no-hex ${SENTINEL}');`,
        `select public.plusmedik_attention_register_human_message('k', '${key}', now() + interval '3 days');`,
        `select public.plusmedik_attention_register_human_message('k', '${key}', now() - interval '3 years');`,
        `select public.plusmedik_attention_register_human_message('k', '${key}', now(), 'motivo libre ${SENTINEL}');`,
        `select public.plusmedik_attention_status('${SENTINEL}');`,
        `select public.plusmedik_attention_resume('${key}', 'ok', 'actor con espacios ${SENTINEL}');`
      ]) {
        const error = await db.fails(asService(sql));
        expect(error, sql.slice(0, 60)).toContain("PT422");
        expect(error).not.toContain(SENTINEL);
      }
      expect(await db.ok(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${key}'`)).toBe("0");
    });

    it("las funciones nuevas son SECURITY DEFINER con search_path vacío y solo service_role las ejecuta; el claim anterior de 8 argumentos ya no existe", async () => {
      expect(await db.ok(`select count(*) from pg_proc where proname like 'plusmedik_attention_%' and proname <> 'plusmedik_attention_contacts_guard' and (not prosecdef or proconfig is distinct from array['search_path=""'])`)).toBe("0");
      expect(await db.ok(`select count(*) from pg_proc where proname = 'plusmedik_audit_claim_run'`)).toBe("1");
      for (const fn of ["plusmedik_attention_status(text)", "plusmedik_attention_register_human_message(text, text, timestamptz, text, text)", "plusmedik_attention_record_event(text, text, text, timestamptz, jsonb)", "plusmedik_attention_resume(text, text, text)", "plusmedik_audit_confirm_send(uuid, text, bigint)"]) {
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${fn}', 'execute')::text || has_function_privilege('public', 'public.${fn}', 'execute')::text`), fn).toBe("truefalse");
      }
    });

    it("runs.contact_key es inmutable y las corridas anteriores (sin clave) siguen funcionando con su contrato", async () => {
      const key = contact();
      const message = messageId();
      await claim(message, owner(1), key);
      expect(await db.fails(withProof(message, `update public.plusmedik_audit_runs set contact_key = '${"d".repeat(64)}' where kapso_message_id = '${message}';`))).toContain("PT409");
      expect(await db.fails(withProof(message, `update public.plusmedik_audit_runs set contact_key = null where kapso_message_id = '${message}';`))).toContain("PT409");
      const legacy = messageId();
      await db.ok(asService(`insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('${legacy}', 'PROCESSING');`));
      expect((await row(legacy)).contact_key).toBeNull();
    });
  });

  describe("compatibilidad con migraciones anteriores", () => {
    it("migrar encima de datos de F1.3 los conserva (corridas en vuelo incluidas), mantiene los leases y se puede reaplicar", async () => {
      const old = await server.createDatabase("preexisting");
      await old.ok(SUPABASE_BOOTSTRAP_SQL);
      for (const file of MIGRATIONS.slice(0, 4)) await old.applyFile(file);
      await old.ok(asService(`select public.plusmedik_audit_claim_run('wamid.pre-1', 'media-1', '${owner(1)}', 120, 2, 'abc1234', '{}'::jsonb, 3);`));
      await old.ok(asService(`select public.plusmedik_audit_claim_run('wamid.pre-2', 'media-1', '${owner(2)}', 120, 2, 'abc1234', '{}'::jsonb, 3);`));
      const preRun = (await old.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = 'wamid.pre-2'`));
      await old.applyFile(MIGRATIONS[4]!);
      await old.applyFile(MIGRATIONS[4]!);
      expect(await old.ok("select count(*) from public.plusmedik_audit_runs where contact_key is null and lease_fence = 1")).toBe("2");
      // una corrida en vuelo (sin clave de contacto) puede reservar y confirmar como antes
      expect(first(await old.ok(asService(`select public.plusmedik_audit_reserve_send('${preRun}'::uuid, '${owner(2)}', 1, 'quoted', 120);`)))).toEqual({ status: "reserved" });
      expect(first(await old.ok(asService(`select public.plusmedik_audit_confirm_send('${preRun}'::uuid, '${owner(2)}', 1);`)))).toEqual({ status: "proceed" });
      // el claim por 8 argumentos posicionales sigue funcionando (sin control de atención)
      expect(first(await old.ok(asService(`select public.plusmedik_audit_claim_run('wamid.pre-3', null, '${owner(3)}', 120, 2, null, '{}'::jsonb, 3);`))).outcome).toBe("claimed");
      expect(await old.ok("select count(*) from public.plusmedik_attention_contacts")).toBe("0");
    });
  });
});
