import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Leases, fencing, reserva de envío y recuperación contra un PostgreSQL REAL y efímero (ver tests/support/ephemeral-postgres.ts). Se omiten, con aviso, si no hay
// PostgreSQL instalado: no se sustituyen por pruebas de texto.

const bin = findPostgresBin();
if (!bin) console.warn("[audit-lease-db] PostgreSQL no disponible: se omiten las pruebas de leases contra la base real.");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const migrationsDir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = ["20261020000000_plusmedik_persistent_audit.sql", "20261021000000_plusmedik_audit_telemetry.sql", "20261022000000_plusmedik_audit_transactional.sql", "20261023000000_plusmedik_audit_leases.sql", "20261024000000_plusmedik_human_control.sql"].map((name) => join(migrationsDir, name));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;

const evidence = (): Json => ({
  contract: 1,
  run: { analysis_decision: "AUTO_SAFE", analysis_outcome: "AUTO_COMPLETE", review_required: false, recipe_stops: [] },
  studies: [{ study_index: 0, decision: "AUTO" }],
  model_calls: [],
  checks: [{ check_kind: "DOCUMENT", check_status: "PASS", summary: {} }]
});
const reply = (state = "ACCEPTED", result = "quoted", status = "COMPLETED", extra = ""): string => `{"state":"${state}","result":"${result}","processing_status":"${status}"${extra}}`;

describe.skipIf(!bin)("leases y recuperación contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("leases");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(file);
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const newMessage = () => `wamid.lease-${++counter}-${Date.now()}`;
  const claimSql = (message: string, owner: string, seconds = 120, maxAttempts = 3) =>
    asService(`select public.plusmedik_audit_claim_run('${message}', 'media-1', '${owner}', ${seconds}, 2, 'abc1234', '{"semanticPrimary":true}'::jsonb, ${maxAttempts});`);
  const claim = async (message: string, owner: string, seconds = 120, maxAttempts = 3): Promise<Json> => JSON.parse((await db.ok(claimSql(message, owner, seconds, maxAttempts))).split("\n")[0]!);
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const idOf = (message: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const row = async (message: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const phase = (message: string) => db.ok(`select phase from public.plusmedik_audit_run_phase where kapso_message_id = '${message}'`);
  // "Viaje en el tiempo": el propietario de la base puede mover el vencimiento presentando la prueba de fencing, igual que las funciones.
  const expire = (message: string) => db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 hour' where kapso_message_id = '${message}';`);
  const call = async (sql: string): Promise<Json> => JSON.parse((await db.ok(asService(sql))).split("\n")[0]!);
  const fenced = (name: string, runId: string, who: string, fence: number, last: string) => `select public.${name}('${runId}'::uuid, '${who}', ${fence}, ${last});`;
  const evidenceSql = (runId: string, who: string, fence: number, payload: Json = evidence()) => fenced("plusmedik_audit_fenced_record_evidence", runId, who, fence, `$j$${JSON.stringify(payload)}$j$::jsonb`);
  const reserveSql = (runId: string, who: string, fence: number, kind = "quoted") => `select public.plusmedik_audit_reserve_send('${runId}'::uuid, '${who}', ${fence}, '${kind}', 120);`;
  const replySql = (runId: string, who: string, fence: number, body = reply()) => fenced("plusmedik_audit_fenced_record_reply", runId, who, fence, `$j$${body}$j$::jsonb`);
  const closeSql = (runId: string, who: string, fence: number, status: string, code: string, final = false) =>
    fenced("plusmedik_audit_fenced_close", runId, who, fence, `$j$${JSON.stringify({ status, error_code: code, final })}$j$::jsonb`);
  const counts = (runId: string) => db.ok(`select (select count(*) from public.plusmedik_audit_studies where run_id='${runId}') || ',' || (select count(*) from public.plusmedik_audit_checks where run_id='${runId}')`);
  const recover = (reserved = 0, abandon = 0, limit = 50) => `select public.plusmedik_audit_recover_stale(${reserved}, ${abandon}, ${limit});`;

  describe("claim y lease", () => {
    it("un mensaje nuevo recibe el lease: propietario, vencimiento, generación 1, intento 1", async () => {
      const message = newMessage();
      expect(await claim(message, owner(1))).toMatchObject({ outcome: "claimed", fence: 1, attempt: 1, status: "PROCESSING" });
      expect(await row(message)).toMatchObject({ lease_owner: owner(1), lease_fence: 1, lease_attempts: 1, send_state: "NOT_RESERVED", processing_status: "PROCESSING", audit_schema_version: 2, engine_version: "abc1234" });
      expect(new Date((await row(message)).lease_expires_at).getTime()).toBeGreaterThan(Date.now());
      expect(await phase(message)).toBe("RECOVERABLE");
    });

    it("el reintento idéntico de la misma ejecución (respuesta perdida) sigue siendo suyo, no un duplicado", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      expect(await claim(message, owner(1))).toMatchObject({ outcome: "claimed", fence: 1, attempt: 1 });
    });

    it("con el lease VIGENTE otro webhook del mismo mensaje es un duplicado en curso (busy) y no cambia nada", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      expect(await claim(message, owner(2))).toMatchObject({ outcome: "busy" });
      expect(await row(message)).toMatchObject({ lease_owner: owner(1), lease_fence: 1, lease_attempts: 1 });
    });

    it("webhook duplicado CONCURRENTE: solo uno reclama; el otro espera y ve 'busy'", async () => {
      const message = newMessage();
      const first = db.psql(`set role service_role; begin; select public.plusmedik_audit_claim_run('${message}', 'media-1', '${owner(1)}', 120, 2, 'abc1234', '{}'::jsonb, 3); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const second = db.psql(claimSql(message, owner(2)));
      const [a, b] = await Promise.all([first, second]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect([JSON.parse(a.stdout.split("\n")[0]!).outcome, JSON.parse(b.stdout.split("\n")[0]!).outcome].sort()).toEqual(["busy", "claimed"]);
      expect(await row(message)).toMatchObject({ lease_owner: owner(1), lease_fence: 1 });
    });

    it("con el lease VENCIDO y el procesamiento recuperable, se reclama de forma atómica: nuevo propietario y generación + 1", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      await expire(message);
      expect(await claim(message, owner(2))).toMatchObject({ outcome: "taken_over", fence: 2, attempt: 2 });
      expect(await row(message)).toMatchObject({ lease_owner: owner(2), lease_fence: 2, lease_attempts: 2 });
      expect(await claim(message, owner(3))).toMatchObject({ outcome: "busy" });
    });

    it("dos reclamaciones simultáneas de un lease vencido: gana una (generación 2) y la otra ve 'busy'", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      await expire(message);
      const slow = db.psql(`set role service_role; begin; select public.plusmedik_audit_claim_run('${message}', 'media-1', '${owner(2)}', 120, 2, 'abc1234', '{}'::jsonb, 3); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const fast = db.psql(claimSql(message, owner(3)));
      const [a, b] = await Promise.all([slow, fast]);
      expect([JSON.parse(a.stdout.split("\n")[0]!).outcome, JSON.parse(b.stdout.split("\n")[0]!).outcome].sort()).toEqual(["busy", "taken_over"]);
      expect(await row(message)).toMatchObject({ lease_owner: owner(2), lease_fence: 2, lease_attempts: 2 });
    });

    it("agotados los intentos no se reclama más (exhausted) y el recuperador lo cierra", async () => {
      const message = newMessage();
      await claim(message, owner(1), 120, 2);
      await expire(message);
      expect((await claim(message, owner(2), 120, 2)).outcome).toBe("taken_over");
      await expire(message);
      expect((await claim(message, owner(3), 120, 2)).outcome).toBe("exhausted");
      await call(recover(0, 0));
      expect(await phase(message)).toBe("NEEDS_ATTENTION");
    });

    it("argumentos inválidos se rechazan sin eco de valores", async () => {
      const error = await db.fails(asService(`select public.plusmedik_audit_claim_run('con espacios SENTINELA', null, '${owner(1)}', 120, 2, null, '{}'::jsonb, 3);`));
      expect(error).toContain("PT422");
      expect(error).not.toContain("SENTINELA");
      expect(await db.fails(claimSql(newMessage(), "corto"))).toContain("PT422");
      expect(await db.fails(claimSql(newMessage(), owner(1), 0))).toContain("PT422");
    });

    it("un mensaje de una corrida anterior a F1.3 (sin lease) nunca se reabre: 'in_doubt'", async () => {
      const message = newMessage();
      await db.ok(asService(`insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('${message}', 'PROCESSING');`));
      expect(await claim(message, owner(1))).toMatchObject({ outcome: "in_doubt" });
      expect(await phase(message)).toBe("LEGACY_IN_PROGRESS");
    });
  });

  describe("fencing: una ejecución antigua no puede escribir ni enviar", () => {
    async function staleScenario() {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      await expire(message);
      await claim(message, owner(2)); // generación 2
      return { message, runId };
    }

    it("tras perder el lease, evidencia, cierre, reserva, resultado y renovación del propietario antiguo se rechazan (PT410) sin escribir nada", async () => {
      const { message, runId } = await staleScenario();
      for (const sql of [
        evidenceSql(runId, owner(1), 1),
        closeSql(runId, owner(1), 1, "FAILED", "AI_PROCESSING_FAILED"),
        reserveSql(runId, owner(1), 1),
        replySql(runId, owner(1), 1),
        `select public.plusmedik_audit_renew_lease('${runId}'::uuid, '${owner(1)}', 1, 120);`,
        evidenceSql(runId, owner(1), 2), // propietario antiguo con la generación nueva
        evidenceSql(runId, owner(2), 1) // propietario nuevo con la generación vieja
      ]) expect(await db.fails(asService(sql)), sql.slice(0, 60)).toContain("PT410");
      expect(await counts(runId)).toBe("0,0");
      expect(await row(message)).toMatchObject({ processing_status: "PROCESSING", send_state: "NOT_RESERVED", evidence_recorded_at: null, lease_owner: owner(2), lease_fence: 2 });
    });

    it("el propietario vigente sí puede: evidencia, reserva y resultado", async () => {
      const { message, runId } = await staleScenario();
      expect(await call(evidenceSql(runId, owner(2), 2))).toMatchObject({ status: "recorded" });
      expect(await call(reserveSql(runId, owner(2), 2))).toEqual({ status: "reserved" });
      expect(await call(replySql(runId, owner(2), 2, reply("ACCEPTED", "quoted", "COMPLETED", ',"provider_message_id":"wamid.out-1"')))).toEqual({ status: "recorded" });
      expect(await row(message)).toMatchObject({ processing_status: "COMPLETED", send_state: "ACCEPTED", reply_state: "ACCEPTED", kapso_outbound_message_id: "wamid.out-1" });
      expect(await phase(message)).toBe("SENT_ACCEPTED");
    });

    it("las funciones de F1.2 no se pueden usar directamente sobre una corrida con lease: sin la prueba de fencing se revierte todo", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      const direct = await db.fails(asService(`select public.plusmedik_audit_record_evidence('${runId}'::uuid, $j$${JSON.stringify(evidence())}$j$::jsonb);`));
      expect(direct).toContain("PT410");
      expect(await counts(runId)).toBe("0,0");
      expect(await db.fails(asService(`select public.plusmedik_audit_record_reply('${runId}'::uuid, '${reply()}'::jsonb);`))).toContain("PT410");
      expect(await row(message)).toMatchObject({ reply_state: "NOT_ATTEMPTED", send_state: "NOT_RESERVED" });
    });

    it("service_role tampoco puede modificar directamente una corrida con lease, ni las columnas de lease, ni forjar la prueba", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      expect(await db.fails(asService(`update public.plusmedik_audit_runs set processing_status = 'FAILED' where kapso_message_id = '${message}';`))).toContain("PT410");
      expect(await db.fails(asService(`update public.plusmedik_audit_runs set completed_at = now() where kapso_message_id = '${message}';`))).toContain("PT410");
      for (const column of ["lease_owner = 'owner-0000099'", "lease_fence = 99", "lease_expires_at = now()", "send_state = 'ACCEPTED'", "attention_reason = 'X'", "send_blocked_at = now()"]) {
        expect(await db.fails(asService(`update public.plusmedik_audit_runs set ${column} where kapso_message_id = '${message}';`)), column).toContain("42501");
      }
      expect(await db.fails(asService(`select public.plusmedik_audit_prove('${await idOf(message)}'::uuid, 1);`))).toContain("42501");
      expect(await db.fails(asService(`select public.plusmedik_audit_lock_leased('${await idOf(message)}'::uuid, '${owner(1)}', 1);`))).toContain("42501");
    });

    it("ni el propietario de la base puede cambiar una corrida con lease sin la prueba, bajar la generación o saltarse el estado de envío", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      expect(await db.fails(`update public.plusmedik_audit_runs set lease_owner = 'owner-0000099' where id = '${runId}';`)).toContain("PT410");
      const proof = `select set_config('plusmedik.fence_proof', '${runId}:1', false);`;
      expect(await db.fails(`${proof} update public.plusmedik_audit_runs set send_state = 'ACCEPTED' where id = '${runId}';`)).toContain("PT409");
      const other = newMessage();
      await claim(other, owner(1));
      const otherId = await idOf(other);
      await expire(other);
      await claim(other, owner(2));
      expect(await db.fails(`select set_config('plusmedik.fence_proof', '${otherId}:2', false); update public.plusmedik_audit_runs set lease_fence = 1 where id = '${otherId}';`)).toContain("PT409");
    });
  });

  describe("reserva de envío", () => {
    it("se concede una sola vez, es idempotente para el mismo propietario y no admite otro tipo de mensaje", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      expect(await call(reserveSql(runId, owner(1), 1))).toEqual({ status: "reserved" });
      expect(await call(reserveSql(runId, owner(1), 1))).toEqual({ status: "reserved" });
      expect(await db.fails(asService(reserveSql(runId, owner(1), 1, "no_quote")))).toContain("PT409");
      expect(await row(message)).toMatchObject({ send_state: "RESERVED", send_kind: "quoted" });
      expect(await phase(message)).toBe("SENDING");
    });

    it("con un envío reservado la corrida NO se reabre: otro webhook ve 'in_doubt' aunque el lease haya vencido", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      await call(reserveSql(await idOf(message), owner(1), 1));
      expect((await claim(message, owner(2))).outcome).toBe("in_doubt");
      await expire(message);
      expect(await claim(message, owner(2))).toMatchObject({ outcome: "in_doubt" });
      expect(await row(message)).toMatchObject({ lease_owner: owner(1), lease_fence: 1, send_state: "RESERVED" });
    });

    it("tampoco se puede cerrar como fallo una corrida con envío reservado", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      await call(reserveSql(runId, owner(1), 1));
      expect(await db.fails(asService(closeSql(runId, owner(1), 1, "FAILED", "AI_PROCESSING_FAILED")))).toContain("PT409");
    });

    it("el resultado solo se registra si el envío se reservó y es del tipo reservado", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      expect(await db.fails(asService(replySql(runId, owner(1), 1)))).toContain("PT409"); // sin reserva
      await call(reserveSql(runId, owner(1), 1, "no_quote"));
      expect(await db.fails(asService(replySql(runId, owner(1), 1, reply("ACCEPTED", "quoted"))))).toContain("PT409"); // otro tipo
      expect(await call(replySql(runId, owner(1), 1, reply("ACCEPTED", "no_quote")))).toEqual({ status: "recorded" });
      expect(await call(replySql(runId, owner(1), 1, reply("ACCEPTED", "no_quote")))).toEqual({ status: "already_recorded" });
      expect(await db.fails(asService(replySql(runId, owner(1), 1, reply("UNKNOWN", "no_quote"))))).toContain("PT409");
      expect(await db.ok(`select count(*) from public.plusmedik_audit_checks where run_id = '${runId}' and check_kind = 'REPLY'`)).toBe("1");
    });

    it("un envío de resultado desconocido (Kapso no respondió) queda UNKNOWN y pide revisión; la corrida no se reabre", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      await call(reserveSql(runId, owner(1), 1));
      await call(replySql(runId, owner(1), 1, reply("UNKNOWN")));
      expect(await row(message)).toMatchObject({ send_state: "UNKNOWN", reply_state: "UNKNOWN", attention_reason: "SEND_OUTCOME_UNKNOWN", processing_status: "COMPLETED" });
      expect(await phase(message)).toBe("SEND_UNKNOWN");
      await expire(message);
      expect((await claim(message, owner(2))).outcome).toBe("finished");
    });

    it("cierres del flujo real: imagen demasiado grande (sin respuesta), tipo no soportado (con aviso) y fallo (con aviso técnico)", async () => {
      const size = newMessage();
      await claim(size, owner(1));
      const sizeId = await idOf(size);
      await call(closeSql(sizeId, owner(1), 1, "IGNORED", "IMAGE_SIZE", true));
      expect(await row(size)).toMatchObject({ processing_status: "IGNORED", send_state: "NOT_APPLICABLE", error_code: "IMAGE_SIZE" });
      expect(await phase(size)).toBe("CLOSED_NO_SEND");
      expect((await claim(size, owner(2))).outcome).toBe("finished");
      expect(await call(closeSql(sizeId, owner(1), 1, "IGNORED", "IMAGE_SIZE", true))).toEqual({ status: "already_recorded" });

      const type = newMessage();
      await claim(type, owner(1));
      const typeId = await idOf(type);
      await call(closeSql(typeId, owner(1), 1, "IGNORED", "IMAGE_TYPE"));
      await call(reserveSql(typeId, owner(1), 1, "no_quote"));
      await call(replySql(typeId, owner(1), 1, reply("ACCEPTED", "no_quote")));
      expect(await row(type)).toMatchObject({ processing_status: "COMPLETED", send_state: "ACCEPTED", error_code: "IMAGE_TYPE" });

      const failed = newMessage();
      await claim(failed, owner(1));
      const failedId = await idOf(failed);
      await call(closeSql(failedId, owner(1), 1, "FAILED", "AI_PROCESSING_FAILED"));
      await call(reserveSql(failedId, owner(1), 1, "technical_issue"));
      await call(replySql(failedId, owner(1), 1, reply("ACCEPTED", "technical_issue", "FAILED")));
      expect(await row(failed)).toMatchObject({ processing_status: "FAILED", send_state: "ACCEPTED", error_code: "AI_PROCESSING_FAILED" });
    });
  });

  describe("bloqueo previo al envío (preparación para intervención humana)", () => {
    it("un bloqueo antes de la reserva cancela el envío: la reserva responde 'blocked' y nunca se envía", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      expect(await call(`select public.plusmedik_audit_block_send('${message}', 'staff_replied');`)).toEqual({ status: "blocked" });
      expect(await call(`select public.plusmedik_audit_block_send('${message}', 'staff_replied');`)).toEqual({ status: "blocked" });
      expect(await call(reserveSql(runId, owner(1), 1))).toEqual({ status: "blocked" });
      expect(await row(message)).toMatchObject({ send_state: "CANCELLED", processing_status: "COMPLETED", send_block_reason: "staff_replied" });
      expect(await phase(message)).toBe("CLOSED_NO_SEND");
      expect(await db.fails(asService(replySql(runId, owner(1), 1)))).toContain("PT409");
      expect((await claim(message, owner(2))).outcome).toBe("finished");
    });

    it("un bloqueo después de la reserva llega tarde y no impide el envío ya autorizado", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      await call(reserveSql(await idOf(message), owner(1), 1));
      expect(await call(`select public.plusmedik_audit_block_send('${message}', 'staff_replied');`)).toEqual({ status: "too_late", send_state: "RESERVED" });
      expect(await row(message)).toMatchObject({ send_state: "RESERVED", send_blocked_at: null });
    });

    it("sin condición de carrera: bloqueo y reserva simultáneos se serializan (gana el primero, el otro lo respeta)", async () => {
      const a = newMessage();
      await claim(a, owner(1));
      const aId = await idOf(a);
      const reserving = db.psql(`set role service_role; begin; ${reserveSql(aId, owner(1), 1)} select pg_sleep(1.5); commit;`);
      await sleep(500);
      const blocking = db.psql(asService(`select public.plusmedik_audit_block_send('${a}', 'staff_replied');`));
      const [r, b] = await Promise.all([reserving, blocking]);
      expect(JSON.parse(r.stdout.split("\n")[0]!).status).toBe("reserved");
      expect(JSON.parse(b.stdout.split("\n")[0]!).status).toBe("too_late");

      const second = newMessage();
      await claim(second, owner(1));
      const secondId = await idOf(second);
      const blockFirst = db.psql(`set role service_role; begin; select public.plusmedik_audit_block_send('${second}', 'staff_replied'); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const reserveAfter = db.psql(asService(reserveSql(secondId, owner(1), 1)));
      const [bf, ra] = await Promise.all([blockFirst, reserveAfter]);
      expect(JSON.parse(bf.stdout.split("\n")[0]!).status).toBe("blocked");
      expect(JSON.parse(ra.stdout.split("\n")[0]!).status).toBe("blocked");
    });

    it("casos límite: mensaje inexistente, corrida anterior a F1.3, ya cerrada sin respuesta", async () => {
      expect(await call(`select public.plusmedik_audit_block_send('wamid.no-existe', 'staff_replied');`)).toEqual({ status: "not_found" });
      const legacy = newMessage();
      await db.ok(asService(`insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('${legacy}', 'PROCESSING');`));
      expect(await call(`select public.plusmedik_audit_block_send('${legacy}', 'staff_replied');`)).toEqual({ status: "unsupported" });
      const closed = newMessage();
      await claim(closed, owner(1));
      await call(closeSql(await idOf(closed), owner(1), 1, "IGNORED", "IMAGE_SIZE", true));
      expect(await call(`select public.plusmedik_audit_block_send('${closed}', 'staff_replied');`)).toEqual({ status: "closed" });
      expect(await db.fails(asService(`select public.plusmedik_audit_block_send('${closed}', 'con espacios');`))).toContain("PT422");
    });
  });

  describe("recuperación segura", () => {
    it("nunca envía: un envío RESERVADO con lease vencido pasa a resultado DESCONOCIDO y exige revisión; no se reabre", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      await call(evidenceSql(runId, owner(1), 1));
      await call(reserveSql(runId, owner(1), 1));
      await call(recover(0, 0));
      expect((await row(message)).send_state).toBe("RESERVED"); // lease vigente: no se toca
      await expire(message);
      const result = await call(recover(0, 0));
      expect(result.send_outcome_unknown).toBeGreaterThanOrEqual(1);
      expect(await row(message)).toMatchObject({ send_state: "UNKNOWN", reply_state: "UNKNOWN", reply_kind: "quoted", attention_reason: "SEND_OUTCOME_UNKNOWN", processing_status: "COMPLETED", lease_fence: 2 });
      expect(await db.ok(`select check_status from public.plusmedik_audit_checks where run_id = '${runId}' and check_kind = 'REPLY'`)).toBe("UNKNOWN");
      expect(await phase(message)).toBe("SEND_UNKNOWN");
      expect((await claim(message, owner(2))).outcome).toBe("finished");
      // Idempotente: otra pasada de recuperación no vuelve a tocar ESTA corrida. (Los contadores de recover_stale son de TODA la base compartida: otra prueba cuyo lease venza justo en este
      // intervalo los alteraría, así que se comprueba la corrida propia y no un cero global.)
      const settled = await row(message);
      await call(recover(0, 0));
      expect(await row(message)).toEqual(settled);
      expect(await phase(message)).toBe("SEND_UNKNOWN");
    });

    it("el ejecutor antiguo que revive después de la recuperación ya no puede registrar nada (PT410)", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      await call(reserveSql(runId, owner(1), 1));
      await expire(message);
      await call(recover(0, 0));
      expect(await db.fails(asService(replySql(runId, owner(1), 1)))).toContain("PT410");
      expect(await db.fails(asService(reserveSql(runId, owner(1), 1)))).toContain("PT410");
      expect(await row(message)).toMatchObject({ send_state: "UNKNOWN" });
    });

    it("respeta la gracia: un lease vencido hace poco no se toca; uno vencido hace más de la gracia sí", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      await call(reserveSql(await idOf(message), owner(1), 1));
      await expire(message);
      expect(await call(recover(7200, 7200))).toMatchObject({ send_outcome_unknown: 0, abandoned_before_send: 0 });
      expect((await row(message)).send_state).toBe("RESERVED");
      expect((await call(recover(60, 900))).send_outcome_unknown).toBeGreaterThanOrEqual(1);
    });

    it("lo abandonado ANTES de reservar (sin envío) se cierra sin respuesta y queda para atención; no se reabre", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      await expire(message);
      expect((await call(recover(0, 0))).abandoned_before_send).toBeGreaterThanOrEqual(1);
      expect(await row(message)).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "FAILED", error_code: "LEASE_EXPIRED", attention_reason: "ABANDONED_BEFORE_SEND", reply_state: "NOT_ATTEMPTED" });
      expect(await phase(message)).toBe("NEEDS_ATTENTION");
      expect((await claim(message, owner(2))).outcome).toBe("finished");
    });

    it("un análisis terminado sin envío (ANALYZED) también se concilia como abandonado, con su evidencia intacta", async () => {
      const message = newMessage();
      await claim(message, owner(1));
      const runId = await idOf(message);
      await call(evidenceSql(runId, owner(1), 1));
      expect(await phase(message)).toBe("ANALYZED_UNSENT");
      await expire(message);
      await call(recover(0, 0));
      expect(await row(message)).toMatchObject({ attention_reason: "ABANDONED_BEFORE_SEND", analysis_decision: "AUTO_SAFE" });
      expect(await counts(runId)).toBe("1,1"); // 1 estudio y la verificación DOCUMENT; no se agrega nada
    });

    it("no toca corridas terminadas, con lease vigente ni anteriores a F1.3", async () => {
      const done = newMessage();
      await claim(done, owner(1));
      const doneId = await idOf(done);
      await call(reserveSql(doneId, owner(1), 1));
      await call(replySql(doneId, owner(1), 1));
      const live = newMessage();
      await claim(live, owner(1));
      const legacy = newMessage();
      await db.ok(asService(`insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('${legacy}', 'PROCESSING');`));
      await call(recover(0, 0));
      expect(await row(done)).toMatchObject({ send_state: "ACCEPTED", attention_reason: null });
      expect(await row(live)).toMatchObject({ send_state: "NOT_RESERVED", attention_reason: null, lease_fence: 1 });
      expect(await row(legacy)).toMatchObject({ processing_status: "PROCESSING", attention_reason: null });
    });

    it("dos recuperadores simultáneos nunca procesan la misma corrida (SKIP LOCKED): cada una se cierra una sola vez", async () => {
      const messages = [newMessage(), newMessage(), newMessage()];
      for (const message of messages) {
        await claim(message, owner(1));
        await call(reserveSql(await idOf(message), owner(1), 1));
        await expire(message);
      }
      const first = db.psql(`set role service_role; begin; ${recover(0, 0, 500)} select pg_sleep(1.5); commit;`);
      await sleep(500);
      const second = db.psql(asService(recover(0, 0, 500)));
      const [a, b] = await Promise.all([first, second]);
      const done = JSON.parse(a.stdout.split("\n")[0]!).send_outcome_unknown + JSON.parse(b.stdout.split("\n")[0]!).send_outcome_unknown;
      expect(JSON.parse(b.stdout.split("\n")[0]!).send_outcome_unknown).toBe(0); // todo lo vencido estaba bloqueado por el primero
      expect(done).toBeGreaterThanOrEqual(3);
      for (const message of messages) {
        expect(await row(message)).toMatchObject({ send_state: "UNKNOWN", lease_fence: 2 });
        expect(await db.ok(`select count(*) from public.plusmedik_audit_checks c join public.plusmedik_audit_runs r on r.id = c.run_id where r.kapso_message_id = '${message}' and c.check_kind = 'REPLY'`)).toBe("1");
      }
    });

    it("parámetros inválidos se rechazan; solo service_role la ejecuta", async () => {
      expect(await db.fails(asService(recover(-1, 0)))).toContain("PT422");
      expect(await db.fails(asService(recover(0, 0, 0)))).toContain("PT422");
      for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.fails(`set role ${role}; ${recover()}`), role).toContain("42501");
    });
  });

  describe("compatibilidad con registros anteriores (Fase 6, telemetría y F1.2)", () => {
    it("migrar encima de datos existentes los conserva, mantiene su contrato de F1.2, y nunca los reabre ni los toca el recuperador", async () => {
      const legacy = await server.createDatabase("legacy");
      await legacy.ok(SUPABASE_BOOTSTRAP_SQL);
      for (const file of MIGRATIONS.slice(0, 3)) await legacy.applyFile(file);
      await legacy.ok(`
        insert into public.plusmedik_audit_runs (id, kapso_message_id, processing_status, analysis_decision, analysis_outcome, review_required, reply_state, reply_kind, completed_at)
          values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'wamid.old-1', 'COMPLETED', 'AUTO_SAFE', 'AUTO_COMPLETE', false, 'ACCEPTED', 'quoted', now()),
                 ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'wamid.old-2', 'PROCESSING', null, null, null, 'NOT_ATTEMPTED', null, null),
                 ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'wamid.old-3', 'COMPLETED', null, null, null, 'UNKNOWN', 'quoted', now());
        insert into public.plusmedik_audit_studies (run_id, study_index, decision) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 'AUTO');
        insert into public.plusmedik_audit_checks (run_id, check_kind, check_status) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'REPLY', 'ACCEPTED');`);
      await legacy.applyFile(MIGRATIONS[3]!);
      await legacy.applyFile(MIGRATIONS[4]!);
      await legacy.applyFile(MIGRATIONS[3]!); // re-ejecutables también sobre datos (en orden)
      await legacy.applyFile(MIGRATIONS[4]!);

      expect(await legacy.ok("select count(*) from public.plusmedik_audit_runs")).toBe("3");
      expect(await legacy.ok("select (select count(*) from public.plusmedik_audit_studies) || ',' || (select count(*) from public.plusmedik_audit_checks)")).toBe("1,1");
      expect(await legacy.ok("select string_agg(phase, ',' order by kapso_message_id) from public.plusmedik_audit_run_phase")).toBe("SENT_ACCEPTED,LEGACY_IN_PROGRESS,SEND_UNKNOWN");
      expect(await legacy.ok("select count(*) from public.plusmedik_audit_runs where lease_fence is null and send_state = 'NOT_RESERVED' and attention_reason is null")).toBe("3");

      // su contrato de F1.2 sigue vigente: lo operativo se cierra directamente, sin lease
      await legacy.ok("set role service_role; update public.plusmedik_audit_runs set processing_status = 'FAILED', error_code = 'AI_PROCESSING_FAILED', completed_at = now() where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';");
      // pero nunca se reabren ni se les concede un lease, y las funciones con fencing no las reconocen
      expect(JSON.parse((await legacy.ok(`set role service_role; select public.plusmedik_audit_claim_run('wamid.old-2', null, '${owner(1)}', 120, 2, null, '{}'::jsonb, 3);`)).split("\n")[0]!).outcome).toBe("in_doubt");
      expect(await legacy.fails(`set role service_role; select public.plusmedik_audit_reserve_send('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '${owner(1)}', 1, 'quoted', 120);`)).toContain("PT410");
      expect(await legacy.fails(`set role service_role; select public.plusmedik_audit_fenced_record_evidence('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '${owner(1)}', 1, '{}'::jsonb);`)).toContain("PT410");
      expect(JSON.parse((await legacy.ok("set role service_role; select public.plusmedik_audit_recover_stale(0, 0, 500);")).split("\n")[0]!)).toEqual({ send_outcome_unknown: 0, abandoned_before_send: 0 });
      expect(await legacy.fails("update public.plusmedik_audit_runs set analysis_decision = 'HUMAN_REVIEW' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';")).toContain("PT409");
    });
  });

  describe("fases y privilegios", () => {
    it("la vista de fases cubre el ciclo completo", async () => {
      const m = newMessage();
      await claim(m, owner(1));
      const id = await idOf(m);
      expect(await phase(m)).toBe("RECOVERABLE");
      await call(evidenceSql(id, owner(1), 1));
      expect(await phase(m)).toBe("ANALYZED_UNSENT");
      await call(reserveSql(id, owner(1), 1));
      expect(await phase(m)).toBe("SENDING");
      await call(replySql(id, owner(1), 1));
      expect(await phase(m)).toBe("SENT_ACCEPTED");
      expect(await db.fails(`set role anon; select * from public.plusmedik_audit_run_phase;`)).toContain("42501");
    });

    it.each(["anon", "authenticated", "unprivileged"])("%s no puede ejecutar ninguna función de leases", async (role) => {
      const runId = "00000000-0000-0000-0000-000000000000";
      for (const sql of [
        `select public.plusmedik_audit_claim_run('wamid.x', null, '${owner(1)}', 120, 2, null, '{}'::jsonb, 3);`,
        `select public.plusmedik_audit_renew_lease('${runId}'::uuid, '${owner(1)}', 1, 120);`,
        evidenceSql(runId, owner(1), 1),
        closeSql(runId, owner(1), 1, "FAILED", "X"),
        reserveSql(runId, owner(1), 1),
        replySql(runId, owner(1), 1),
        `select public.plusmedik_audit_block_send('wamid.x', 'r');`
      ]) expect(await db.fails(`set role ${role}; ${sql}`), sql.slice(0, 50)).toContain("42501");
    });

    it("las funciones son SECURITY DEFINER con search_path vacío; service_role solo ejecuta las públicas", async () => {
      expect(await db.ok(`select count(*) from pg_proc where proname in ('plusmedik_audit_claim_run','plusmedik_audit_renew_lease','plusmedik_audit_lock_leased','plusmedik_audit_fenced_record_evidence','plusmedik_audit_fenced_close','plusmedik_audit_reserve_send','plusmedik_audit_fenced_record_reply','plusmedik_audit_recover_stale','plusmedik_audit_block_send') and (not prosecdef or proconfig is distinct from array['search_path=""'])`)).toBe("0");
      expect(await db.ok(`select count(*) from pg_proc where proname like 'plusmedik_audit_%' and proconfig is null`)).toBe("0");
      for (const fn of ["claim_run(text, text, text, integer, integer, text, jsonb, integer, text)", "renew_lease(uuid, text, bigint, integer)", "fenced_record_evidence(uuid, text, bigint, jsonb)", "fenced_close(uuid, text, bigint, jsonb)", "reserve_send(uuid, text, bigint, text, integer)", "fenced_record_reply(uuid, text, bigint, jsonb)", "recover_stale(integer, integer, integer)", "block_send(text, text)"]) {
        expect(await db.ok(`select has_function_privilege('service_role', 'public.plusmedik_audit_${fn}', 'execute')::text || has_function_privilege('public', 'public.plusmedik_audit_${fn}', 'execute')::text`), fn).toBe("truefalse");
      }
      for (const fn of ["prove(uuid, bigint)", "lock_leased(uuid, text, bigint)"]) expect(await db.ok(`select has_function_privilege('service_role', 'public.plusmedik_audit_${fn}', 'execute')::text`), fn).toBe("false");
    });
  });
});
