import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Auditoría de la migración 19 (plusmedik_turn_fold, buffering nativo de Kapso) contra las 18 anteriores, en un PostgreSQL REAL y efímero. NO se aplica a ningún Supabase remoto.
// Qué se comprueba: forma estática (aditiva, sin tocar el CRM), privilegios, validación de entradas, qué hace con CADA estado de corrida, idempotencia, que no cambia nada más, y su
// relación con la pausa humana, el tope diario, el recuperador y la reserva de envío (incluida la carrera contra ella).

const bin = findPostgresBin();
if (!bin) console.warn("[batch-fold-db] PostgreSQL no disponible: se omiten las pruebas de la migración 19 contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const FOLD = "20261107000000_plusmedik_batch_fold.sql";
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
type Json = Record<string, any>;
const CAP = { max: 2, windowSeconds: 86_400 };

describe("migración 19 (plusmedik_turn_fold): forma estática", () => {
  const raw = readFileSync(join(dir, FOLD), "utf8").replaceAll("\r\n", "\n");
  const code = raw.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");

  it("es la 19 de la cadena (posterior a la del tope diario; la 20 es de solo lectura) y las 18 anteriores no cambian de nombre ni de orden", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(19);
    expect(MIGRATIONS[18]).toBe(FOLD);
    expect(MIGRATIONS[17]).toBe("20261106000000_plusmedik_daily_reply_cap.sql");
  });

  it("es ADITIVA: una sola función y nada destructivo; no toca el CRM, el catálogo ni otras capas", () => {
    expect([...code.matchAll(/create or replace function public\.([a-z_0-9]+)/g)].map((m) => m[1])).toEqual(["plusmedik_turn_fold"]);
    expect(code).not.toMatch(/\b(drop|delete\s+from|truncate|insert\s+into|create\s+table|create\s+(or\s+replace\s+)?(view|trigger)|alter\s+table|alter\s+function|create\s+index)\b/i);
    expect(code).not.toMatch(/\bcrm\./i);
    expect(code).not.toMatch(/\blab_tests\b/i);
    // solo actualiza la tabla de corridas (y lee la de turnos)
    expect([...code.matchAll(/\bupdate\s+(public\.[a-z_0-9]+)/gi)].map((m) => m[1])).toEqual(["public.plusmedik_audit_runs"]);
    expect([...code.matchAll(/public\.(plusmedik_[a-z_0-9]+)/g)].map((m) => m[1]).filter((name) => !["plusmedik_turn_fold"].includes(name!)).sort()).toEqual(
      [...new Set(["plusmedik_audit_lock_leased", "plusmedik_audit_prove", "plusmedik_audit_runs", "plusmedik_turns"])].flatMap((name) => Array(([...code.matchAll(new RegExp(`public\\.${name}\\b`, "g"))]).length).fill(name)).sort()
    );
  });

  it("es SECURITY DEFINER con search_path vacío, revoca a public/anon/authenticated y concede solo a service_role", () => {
    expect(code).toMatch(/security definer\s+set search_path = ''/);
    expect(code).toMatch(/revoke all on function public\.plusmedik_turn_fold\(uuid, text, bigint\) from public, anon, authenticated;/);
    expect(code).toMatch(/grant execute on function public\.plusmedik_turn_fold\(uuid, text, bigint\) to service_role;/);
    expect(code).not.toMatch(/to\s+(anon|authenticated|public)\b/i);
  });
});

describe.skipIf(!bin)("migración 19 (plusmedik_turn_fold) contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("batch_fold");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const failure = async (sql: string): Promise<string> => {
    const result = await db.psql(asService(sql));
    expect(result.code, result.stdout).not.toBe(0);
    return /ERROR:\s+(.*)/.exec(result.stderr)?.[0] ?? result.stderr;
  };
  const jsonSql = (value: unknown) => `$g$${JSON.stringify(value)}$g$::jsonb`;

  interface Turn { message: string; id: string; who: string; fence: number; contact: string }
  async function turn(contact: string, who = 1, kind = "TEXT"): Promise<Turn> {
    const message = `wamid.fold-${++counter}-${Date.now()}`;
    const claimed = await call(`select public.plusmedik_turn_claim('${message}', null, '${owner(who)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', '${kind}');`);
    const id = await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
    return { message, id, who: owner(who), fence: claimed.fence as number, contact };
  }
  const foldSql = (t: Turn, fence = t.fence, who = t.who) => `select public.plusmedik_turn_fold('${t.id}'::uuid, '${who}', ${fence});`;
  const fold = (t: Turn) => call(foldSql(t));
  const reserveSql = (t: Turn, cap: unknown = null, kind = "conversation") =>
    `select public.plusmedik_turn_reserve_send_capped('${t.id}'::uuid, '${t.who}', ${t.fence}, '${kind}', 120, 'NONE', null::jsonb, ${cap === null ? "null::jsonb" : jsonSql(cap)});`;
  const reserve = (t: Turn, cap: unknown = null, kind = "conversation") => call(reserveSql(t, cap, kind));
  const recordSql = (t: Turn, kind = "conversation") =>
    `select public.plusmedik_audit_fenced_record_reply('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"state":"ACCEPTED","result":"${kind}","processing_status":"COMPLETED"}'::jsonb);`;
  const row = async (t: Turn): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where id = '${t.id}'`));
  const proof = (t: Turn) => `select set_config('plusmedik.fence_proof', '${t.id}:${t.fence}', false);`;
  const counted = async (contact: string) => Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}' and send_state in ('RESERVED','ACCEPTED','UNKNOWN')`));
  // Huella de TODO lo demás: las otras corridas y el resto de las tablas de PlusMedik.
  const fingerprint = async (except: Turn): Promise<string> =>
    db.ok(`select md5(string_agg(t, '|' order by t)) from (
      select 'run:' || x::text as t from public.plusmedik_audit_runs x where x.id <> '${except.id}'
      union all select 'turn:' || x::text from public.plusmedik_turns x
      union all select 'contact:' || x::text from public.plusmedik_contact_turns x
      union all select 'attention:' || x::text from public.plusmedik_attention_contacts x
      union all select 'attention_event:' || x::text from public.plusmedik_attention_events x
      union all select 'check:' || x::text from public.plusmedik_audit_checks x
      union all select 'knowledge:' || x::text from public.plusmedik_turn_knowledge_refs x
      union all select 'session:' || x::text from public.plusmedik_quote_sessions x
      union all select 'item:' || x::text from public.plusmedik_quote_items x
      union all select 'outbox:' || x::text from public.plusmedik_crm_outbox x) all_rows`);

  it("la función existe una sola vez, es SECURITY DEFINER con search_path vacío y solo service_role puede ejecutarla", async () => {
    const meta = JSON.parse(await db.ok(`select json_build_object(
      'count', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'plusmedik_turn_fold'),
      'definer', (select p.prosecdef from pg_proc p where p.proname = 'plusmedik_turn_fold'),
      'config', (select p.proconfig from pg_proc p where p.proname = 'plusmedik_turn_fold'),
      'returns', (select pg_catalog.format_type(p.prorettype, null) from pg_proc p where p.proname = 'plusmedik_turn_fold'),
      'service', has_function_privilege('service_role', 'public.plusmedik_turn_fold(uuid,text,bigint)', 'execute'),
      'anon', has_function_privilege('anon', 'public.plusmedik_turn_fold(uuid,text,bigint)', 'execute'),
      'authenticated', has_function_privilege('authenticated', 'public.plusmedik_turn_fold(uuid,text,bigint)', 'execute'),
      'public', exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname = 'plusmedik_turn_fold' and a.grantee = 0 and a.privilege_type = 'EXECUTE'))`));
    expect(meta).toEqual({ count: 1, definer: true, config: ["search_path=\"\""], returns: "jsonb", service: true, anon: false, authenticated: false, public: false });
    // anon y authenticated reciben «permission denied» al intentarlo
    for (const role of ["anon", "authenticated"]) {
      const result = await db.psql(`set role ${role}; select public.plusmedik_turn_fold('00000000-0000-4000-8000-000000000001'::uuid, 'owner-00000001', 1);`);
      expect(result.code, role).not.toBe(0);
      expect(result.stderr, role).toMatch(/permission denied/i);
    }
  });

  it("entradas inválidas: corrida inexistente o sin turno (404), dueño mal formado (422), fence o dueño que no son los vigentes (410); no cambia nada", async () => {
    const t = await turn(newContact());
    const before = JSON.stringify(await row(t));
    expect(await failure(`select public.plusmedik_turn_fold('00000000-0000-4000-8000-0000000000aa'::uuid, '${t.who}', 1);`)).toContain("turn not found");
    expect(await failure(foldSql(t, t.fence, "x"))).toContain("invalid lease reference");
    expect(await failure(foldSql(t, 0))).toContain("invalid lease reference");
    expect(await failure(foldSql(t, t.fence + 1))).toContain("lease lost");
    expect(await failure(foldSql(t, t.fence, owner(9)))).toContain("lease lost");
    expect(await failure(`select public.plusmedik_turn_fold(null, '${t.who}', ${t.fence});`)).toBeTruthy();
    expect(JSON.stringify(await row(t))).toBe(before);
  });

  it("una corrida anterior a los leases (sin turno ni lease) no se puede plegar", async () => {
    await db.ok(`insert into public.plusmedik_audit_runs (kapso_message_id, processing_status) values ('wamid.legacy-fold-1', 'PROCESSING')`);
    const id = await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = 'wamid.legacy-fold-1'`);
    expect(await failure(`select public.plusmedik_turn_fold('${id}'::uuid, 'owner-00000001', 1);`)).toContain("turn not found");
    expect(await db.ok(`select processing_status || '/' || send_state from public.plusmedik_audit_runs where id = '${id}'`)).toBe("PROCESSING/NOT_RESERVED");
  });

  describe("qué hace con CADA estado de corrida", () => {
    it("PROCESSING -> COMPLETED sin envío (NOT_APPLICABLE, BATCHED), sin respuesta registrada y con el lease vencido", async () => {
      const t = await turn(newContact());
      expect(await fold(t)).toEqual({ status: "folded" });
      expect(await row(t)).toMatchObject({ processing_status: "COMPLETED", send_state: "NOT_APPLICABLE", error_code: "BATCHED", reply_state: "NOT_ATTEMPTED", reply_kind: null, send_kind: null, send_reserved_at: null, attention_reason: null });
      expect((await row(t)).completed_at).not.toBeNull();
      expect(Date.parse((await row(t)).lease_expires_at)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("ANALYZED (con el análisis ya registrado) -> COMPLETED: lo que la base no permite cerrar como «sin respuesta»", async () => {
      const t = await turn(newContact());
      await db.ok(`${proof(t)} update public.plusmedik_audit_runs set processing_status = 'ANALYZED' where id = '${t.id}';`);
      // el cierre «sin respuesta» de siempre NO es posible desde ANALYZED...
      expect(await failure(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`)).toContain("invalid processing status transition");
      // ...y plegar sí
      expect(await fold(t)).toEqual({ status: "folded" });
      expect(await row(t)).toMatchObject({ processing_status: "COMPLETED", send_state: "NOT_APPLICABLE", error_code: "BATCHED" });
    });

    it("IGNORED (cierre no final) -> COMPLETED conservando su código", async () => {
      const t = await turn(newContact());
      await call(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"IGNORED","error_code":"IMAGE_TYPE","final":false}'::jsonb);`);
      expect(await fold(t)).toEqual({ status: "folded" });
      expect(await row(t)).toMatchObject({ processing_status: "COMPLETED", send_state: "NOT_APPLICABLE", error_code: "IMAGE_TYPE" });
    });

    it("FAILED conserva el fallo (estado y código): solo se marca sin envío", async () => {
      const t = await turn(newContact());
      await call(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"FAILED","error_code":"AI_PROCESSING_FAILED","final":false}'::jsonb);`);
      expect(await fold(t)).toEqual({ status: "folded" });
      expect(await row(t)).toMatchObject({ processing_status: "FAILED", send_state: "NOT_APPLICABLE", error_code: "AI_PROCESSING_FAILED" });
    });

    it("con el envío RESERVADO no toca nada: nunca cancela ni libera un envío", async () => {
      const t = await turn(newContact());
      expect((await reserve(t)).status).toBe("reserved");
      const before = JSON.stringify(await row(t));
      expect(await fold(t)).toEqual({ status: "closed" });
      expect(JSON.stringify(await row(t))).toBe(before);
      // y el envío puede terminar con normalidad
      await call(recordSql(t));
      expect(await row(t)).toMatchObject({ send_state: "ACCEPTED", processing_status: "COMPLETED", reply_kind: "conversation" });
    });

    it("con el envío ya ACEPTADO, CANCELADO (pausa) o cerrado sin respuesta no toca nada", async () => {
      const sent = await turn(newContact());
      await reserve(sent);
      await call(recordSql(sent));
      const paused = await turn(newContact());
      await db.ok(`${proof(paused)} update public.plusmedik_audit_runs set send_blocked_at = now(), send_block_reason = 'HUMAN_PAUSED' where id = '${paused.id}';`);
      expect((await reserve(paused)).status).toBe("blocked");
      const quiet = await turn(newContact());
      await call(`select public.plusmedik_audit_fenced_close('${quiet.id}'::uuid, '${quiet.who}', ${quiet.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`);
      for (const t of [sent, paused, quiet]) {
        const before = JSON.stringify(await row(t));
        expect(await fold(t), t.message).toEqual({ status: "closed" });
        expect(JSON.stringify(await row(t)), t.message).toBe(before);
      }
      expect(await row(paused)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
    });
  });

  it("es IDEMPOTENTE: repetirla no cambia nada (ni siquiera updated_at)", async () => {
    const t = await turn(newContact());
    expect(await fold(t)).toEqual({ status: "folded" });
    const after = JSON.stringify(await row(t));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fold(t)).toEqual({ status: "already_recorded" });
    expect(await fold(t)).toEqual({ status: "already_recorded" });
    expect(JSON.stringify(await row(t))).toBe(after);
  });

  it("después de plegarla, el mensaje ya no se puede reclamar ni reprocesar (duplicado terminado) y la reserva de envío se rechaza", async () => {
    const contact = newContact();
    const t = await turn(contact);
    await fold(t);
    const again = await call(`select public.plusmedik_turn_claim('${t.message}', null, '${owner(2)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', 'TEXT');`);
    expect(again).toMatchObject({ outcome: "finished" });
    // aunque el dueño insista: no hay envío posible desde una corrida plegada
    expect((await reserve(t)).status).toBe("closed");
    expect(await counted(contact)).toBe(0);
    expect(await row(t)).toMatchObject({ send_state: "NOT_APPLICABLE", reply_kind: null });
  });

  it("no cambia NADA más: ni las otras corridas, ni los turnos, la atención, las sesiones de cotización, el rastro de conocimiento, la cola del CRM ni los esquemas ajenos", async () => {
    const contact = newContact();
    const other = await turn(contact);
    await turn(newContact(), 3, "IMAGE");
    const t = await turn(contact, 2, "IMAGE");
    const before = await fingerprint(t);
    const crmBefore = await db.ok(`select md5(string_agg(c::text, '|' order by c::text)) from (select table_schema || '.' || table_name || '.' || column_name as c from information_schema.columns where table_schema not in ('pg_catalog','information_schema') and (table_name !~ '^plusmedik_' or table_schema <> 'public')) x`);
    await fold(t);
    expect(await fingerprint(t)).toBe(before);
    expect(await db.ok(`select md5(string_agg(c::text, '|' order by c::text)) from (select table_schema || '.' || table_name || '.' || column_name as c from information_schema.columns where table_schema not in ('pg_catalog','information_schema') and (table_name !~ '^plusmedik_' or table_schema <> 'public')) x`)).toBe(crmBefore);
    expect(await row(other)).toMatchObject({ processing_status: "PROCESSING", send_state: "NOT_RESERVED" });
  });

  describe("pausa humana", () => {
    const pause = (contact: string, key: string) => call(`select public.plusmedik_attention_register_human_message('${key}', '${contact}', now());`);

    it("plegar ANTES de la pausa: la pausa no cuenta ni toca la corrida plegada, y sí bloquea las pendientes", async () => {
      const contact = newContact();
      const folded = await turn(contact);
      const pending = await turn(contact, 2);
      await fold(folded);
      const result = await pause(contact, `evt-fold-before-${counter}`);
      expect(result).toMatchObject({ outcome: "PAUSED", blocked_runs: 1 });
      expect(await row(folded)).toMatchObject({ send_state: "NOT_APPLICABLE", send_blocked_at: null, attention_reason: null });
      expect(await row(pending)).toMatchObject({ send_blocked_at: expect.any(String), send_block_reason: "HUMAN_PAUSED" });
      expect((await reserve(pending)).status).toBe("blocked");
    });

    it("plegar DESPUÉS de la pausa: la marca de bloqueo se conserva y la corrida que iba a responder sigue sin poder enviar", async () => {
      const contact = newContact();
      const draft = await turn(contact);
      const responder = await turn(contact, 2);
      const result = await pause(contact, `evt-fold-after-${counter}`);
      expect(result).toMatchObject({ outcome: "PAUSED", blocked_runs: 2 });
      expect(await fold(draft)).toEqual({ status: "folded" });
      expect(await row(draft)).toMatchObject({ send_state: "NOT_APPLICABLE", send_blocked_at: expect.any(String), send_block_reason: "HUMAN_PAUSED" });
      expect((await reserve(responder)).status).toBe("blocked");
      expect(await row(responder)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
      expect(await counted(contact)).toBe(0);
    });
  });

  describe("tope diario de respuestas", () => {
    it("las corridas plegadas NO ocupan cupo: con tope 2, plegar 5 no impide dos respuestas y la tercera sí se limita", async () => {
      const contact = newContact();
      for (let i = 0; i < 5; i++) await fold(await turn(contact));
      expect(await counted(contact)).toBe(0);
      const a = await turn(contact, 2);
      const b = await turn(contact, 3);
      const c = await turn(contact, 4);
      expect((await reserve(a, CAP)).status).toBe("reserved");
      await call(recordSql(a));
      expect((await reserve(b, CAP)).status).toBe("reserved");
      await call(recordSql(b));
      expect(await reserve(c, CAP)).toEqual({ status: "limited", reason: "DAILY_CAP" });
      expect(await counted(contact)).toBe(2);
    });

    it("plegar tampoco libera cupo: una corrida que ya envió sigue contando", async () => {
      const contact = newContact();
      const sent = await turn(contact);
      await reserve(sent, CAP);
      await call(recordSql(sent));
      expect(await fold(sent)).toEqual({ status: "closed" });
      expect(await counted(contact)).toBe(1);
    });
  });

  describe("recuperador y carreras", () => {
    const expire = (t: Turn) => db.ok(`${proof(t)} update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 hour' where id = '${t.id}';`);

    it("plegar antes del recuperador: la corrida ya no es candidata (queda CLOSED_NO_SEND); recuperar antes: la corrida es de otro lease y plegar se rechaza", async () => {
      const foldedFirst = await turn(newContact());
      const recoveredFirst = await turn(newContact());
      await expire(foldedFirst);
      await expire(recoveredFirst);
      await fold(foldedFirst);
      const recovery = await call(`select public.plusmedik_audit_recover_stale(0, 0, 500);`);
      expect(recovery.abandoned_before_send).toBe(1);
      expect(await row(foldedFirst)).toMatchObject({ processing_status: "COMPLETED", error_code: "BATCHED", attention_reason: null });
      expect(await row(recoveredFirst)).toMatchObject({ processing_status: "FAILED", error_code: "LEASE_EXPIRED", attention_reason: "ABANDONED_BEFORE_SEND" });
      expect(await failure(foldSql(recoveredFirst))).toContain("lease lost");
      expect(await db.ok(`select phase from public.plusmedik_audit_run_phase where id = '${foldedFirst.id}'`)).toBe("CLOSED_NO_SEND");
    });

    it("CARRERA contra la reserva de envío de la MISMA corrida: gana exactamente una; nunca queda una corrida plegada y reservada a la vez", async () => {
      const outcomes = { folded: 0, reserved: 0 };
      for (let round = 0; round < 12; round++) {
        const t = await turn(newContact());
        const [foldResult, reserveResult] = await Promise.all([db.psql(asService(foldSql(t))), db.psql(asService(reserveSql(t)))]);
        const final = await row(t);
        const folded = foldResult.stdout.includes("folded");
        const reserved = reserveResult.stdout.includes("\"status\": \"reserved\"") || reserveResult.stdout.includes("\"status\":\"reserved\"");
        // exactamente uno de los dos efectos
        expect(folded !== reserved, `ronda ${round}: ${foldResult.stdout} / ${reserveResult.stdout}`).toBe(true);
        if (folded) {
          expect(final, `ronda ${round}`).toMatchObject({ send_state: "NOT_APPLICABLE", processing_status: "COMPLETED", send_kind: null });
          outcomes.folded++;
        } else {
          expect(final, `ronda ${round}`).toMatchObject({ send_state: "RESERVED", send_kind: "conversation" });
          outcomes.reserved++;
        }
      }
      expect(outcomes.folded + outcomes.reserved).toBe(12);
    });

    it("SIN INTERBLOQUEOS: plegar, pausar al contacto, reservar un envío y recuperar a la vez sobre el mismo contacto terminan todos sin error", async () => {
      for (let round = 0; round < 10; round++) {
        const contact = newContact();
        const drafts = [await turn(contact, 1), await turn(contact, 2), await turn(contact, 3)];
        const responder = await turn(contact, 4);
        const results = await Promise.all([
          ...drafts.map((draft) => db.psql(asService(foldSql(draft)))),
          db.psql(asService(`select public.plusmedik_attention_register_human_message('evt-deadlock-${counter}-${round}', '${contact}', now());`)),
          db.psql(asService(reserveSql(responder, CAP))),
          db.psql(asService(`select public.plusmedik_audit_recover_stale(0, 0, 50);`))
        ]);
        for (const result of results) expect(result.code, `ronda ${round}: ${result.stderr.slice(0, 200)}`).toBe(0);
        // pase lo que pase en la carrera, ninguna corrida plegada quedó con un envío
        for (const draft of drafts) expect(await row(draft), `ronda ${round}`).toMatchObject({ send_state: "NOT_APPLICABLE", send_kind: null });
        expect(await counted(contact)).toBeLessThanOrEqual(1);
      }
    });

    it("CARRERA entre dos plegados de la misma corrida: uno pliega y el otro lo encuentra ya registrado", async () => {
      const t = await turn(newContact());
      const [a, b] = await Promise.all([db.psql(asService(foldSql(t))), db.psql(asService(foldSql(t)))]);
      expect([a.code, b.code]).toEqual([0, 0]);
      expect([a.stdout, b.stdout].join(" ").match(/folded/g)).toHaveLength(1);
      expect([a.stdout, b.stdout].join(" ")).toContain("already_recorded");
    });
  });

  it("volver a aplicar la migración (reintento tras un corte) no falla, no cambia la función y no toca los datos", async () => {
    const t = await turn(newContact());
    await fold(t);
    const definition = () => db.ok(`select md5(p.prosrc) || ':' || p.proacl::text from pg_proc p where p.proname = 'plusmedik_turn_fold'`);
    const before = { definition: await definition(), run: JSON.stringify(await row(t)), others: await fingerprint(t) };
    await db.applyFile(join(dir, FOLD));
    await db.applyFile(join(dir, FOLD));
    expect(await definition()).toBe(before.definition);
    expect(JSON.stringify(await row(t))).toBe(before.run);
    expect(await fingerprint(t)).toBe(before.others);
    expect(await fold(t)).toEqual({ status: "already_recorded" });
  });
});
