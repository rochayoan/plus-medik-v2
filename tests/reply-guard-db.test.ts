import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 10 (protección contra bucles y exceso de respuestas) contra un PostgreSQL REAL y efímero: tope por contacto y ventana, ráfagas, repeticiones, supresión temporal,
// recuperación, precedencia de la pausa humana, idempotencia y concurrencia. NO se aplica a ningún Supabase remoto. Se omite, con aviso, si no hay PostgreSQL instalado.

const bin = findPostgresBin();
if (!bin) console.warn("[reply-guard-db] PostgreSQL no disponible: se omiten las pruebas de la guarda de respuestas contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const GUARD = "20261029000000_plusmedik_reply_guard.sql";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;
const read = (name: string) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n");

// Una guarda que solo aplica el tope (sin ráfaga ni repetición efectivas) y variantes.
const NO_BURST = { windowSeconds: 60, max: 1000 };
const NO_REPEAT = { windowSeconds: 900, max: 1000 };
const guard = (over: Json = {}): Json => ({ rules: [{ windowSeconds: 600, max: 3 }], burst: NO_BURST, repeat: NO_REPEAT, cooldownSeconds: 600, ...over });

describe.skipIf(!bin)("guarda de respuestas contra PostgreSQL real (migración 10)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("reply_guard");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("postflight de migración 16: SELECT real en PostgreSQL y BLOCK=0", async () => {
    const file = readFileSync(join(__dirname, "..", "supabase", "preflight", "v2_atomic_rate_post_apply_read_only.sql"), "utf8");
    const output = await db.ok(file);
    const lines = output.trim().split("\n").filter(Boolean);
    const verdict = lines.find((line) => line.startsWith("0|VEREDICTO|"));
    expect(verdict).toContain("|OK|BLOCK=0|INFO");
    const rows = lines.filter((line) => !line.startsWith("0|"));
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.endsWith("|BLOCK"), row).toBe(false);
    }
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const newMessage = () => `wamid.guard-${++counter}-${Date.now()}`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const claim = (message: string, who: string, contact: string, kind = "TEXT") =>
    call(`select public.plusmedik_turn_claim('${message}', null, '${who}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', '${kind}');`);
  const idOf = (message: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  const row = async (message: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const jsonSql = (value: unknown) => (value === null ? "null::jsonb" : `$g$${JSON.stringify(value)}$g$::jsonb`);
  const guardedSql = (runId: string, who: string, fence: number, g: unknown, kind = "conversation", stale = "NONE") =>
    `select public.plusmedik_turn_reserve_send_guarded('${runId}'::uuid, '${who}', ${fence}, '${kind}', 120, '${stale}', ${jsonSql(g)});`;
  const guarded = (t: Turn, g: unknown, kind = "conversation", stale = "NONE") => call(guardedSql(t.id, t.who, t.fence, g, kind, stale));
  const replySql = (runId: string, who: string, fence: number, state = "ACCEPTED", result = "conversation") =>
    `select public.plusmedik_audit_fenced_record_reply('${runId}'::uuid, '${who}', ${fence}, '{"state":"${state}","result":"${result}","processing_status":"COMPLETED"}'::jsonb);`;
  const pause = (contact: string) => call(`select public.plusmedik_attention_register_human_message('human:${contact}:${++counter}', '${contact}', null, 'HUMAN_WHATSAPP_BUSINESS_APP', 'kapso_business_app');`);
  const events = async (contact: string): Promise<Json[]> => JSON.parse(await db.ok(`select coalesce(json_agg(e order by e.created_at, e.id), '[]') from public.plusmedik_reply_guard_events e where contact_key = '${contact}'`));
  const state = async (contact: string): Promise<Json | null> => {
    const out = await db.ok(`select coalesce((select to_json(s) from public.plusmedik_reply_guard_state s where contact_key = '${contact}')::text, '')`);
    return out ? JSON.parse(out) : null;
  };
  // "Viaje en el tiempo": adelanta el pasado de TODO lo que la guarda mira de un contacto. El propietario de la base salta los disparadores de inmutabilidad (replica).
  const rewind = (contact: string, seconds: number) =>
    db.ok(`set session_replication_role = replica;
      update public.plusmedik_audit_runs set send_reserved_at = send_reserved_at - interval '${seconds} seconds' where contact_key = '${contact}' and send_reserved_at is not null;
      update public.plusmedik_turns set created_at = created_at - interval '${seconds} seconds' where contact_key = '${contact}';
      update public.plusmedik_reply_guard_marks set created_at = created_at - interval '${seconds} seconds' where contact_key = '${contact}';
      update public.plusmedik_reply_guard_events set created_at = created_at - interval '${seconds} seconds' where contact_key = '${contact}';
      update public.plusmedik_reply_guard_state set suppressed_until = suppressed_until - interval '${seconds} seconds', updated_at = updated_at - interval '${seconds} seconds',
        counted_since = counted_since - interval '${seconds} seconds' where contact_key = '${contact}';
      -- Simulación del tiempo también para el ledger agregado por migración 16.
      update public.plusmedik_guard_rate_ledger set state =
        jsonb_set(state, '{slots}', coalesce((
          select jsonb_agg(jsonb_set(e.value, '{t}', to_jsonb((e.value ->> 't')::numeric - ${seconds})) order by e.ord)
          from jsonb_array_elements(state -> 'slots') with ordinality as e(value, ord)
        ), '[]'::jsonb))
      where contact_key = '${contact}';`);

  interface Turn { message: string; id: string; who: string; fence: number }
  async function turn(contact: string, who = 1, kind = "TEXT"): Promise<Turn> {
    const message = newMessage();
    const claimed = await claim(message, owner(who), contact, kind);
    return { message, id: await idOf(message), who: owner(who), fence: claimed.fence as number };
  }
  // Un turno que reserva y envía su respuesta (reservado y aceptado).
  async function replied(contact: string, g: unknown = guard(), kind = "conversation", result = "ACCEPTED") {
    const t = await turn(contact);
    const reserved = await guarded(t, g, kind);
    expect(reserved.status, JSON.stringify(reserved)).toBe("reserved");
    await call(replySql(t.id, t.who, t.fence, result, kind));
    return t;
  }

  describe("esquema, privilegios e inmutabilidad", () => {
    it("la migración se puede volver a aplicar sin error y sin tocar datos", async () => {
      const contact = newContact();
      await replied(contact, guard({ signature: "INFO_REQUEST:HOURS" }));
      await db.applyFile(join(dir, GUARD));
      // La migración 10 reemplaza la firma vigente de la función. Restaurar
      // inmediatamente la migración 16 para que los demás tests no usen
      // accidentalmente el rate limiter anterior sin cuota atómica.
      await db.applyFile(join(dir, "20261104000000_plusmedik_reply_guard_atomic_rate.sql"));
      expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_marks where contact_key = '${contact}'`)).toBe("1");
    });

    it("las tres tablas tienen RLS; service_role solo lee y nadie más tiene acceso", async () => {
      for (const table of ["plusmedik_reply_guard_marks", "plusmedik_reply_guard_state", "plusmedik_reply_guard_events"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', 'select')`)).toBe("t");
        for (const privilege of ["insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', '${privilege}')`)).toBe("f");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', 'select')`)).toBe("f");
      }
    });

    it("las funciones públicas son SECURITY DEFINER con search_path vacío; solo service_role las ejecuta", async () => {
      for (const signature of ["plusmedik_turn_reserve_send_guarded(uuid, text, bigint, text, integer, text, jsonb)", "plusmedik_reply_guard_reset(text, text)", "plusmedik_reply_guard_status(text)"]) {
        expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`)).toBe("t");
        expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`)).toContain("search_path=");
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`)).toBe("t");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`)).toBe("f");
      }
      for (const signature of ["plusmedik_reply_guard_valid(jsonb)", "plusmedik_reply_guard_int(jsonb, integer, integer)", "plusmedik_reply_guard_state_guard()"]) {
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`)).toBe("f");
      }
    });

    it("marcas y bitácora son inmutables (ni el propietario las modifica, borra o vacía); el estado no se borra ni cambia de contacto y nunca supera 24 h", async () => {
      const contact = newContact();
      const t = await replied(contact, guard({ signature: "GREETING" }));
      await call(`select public.plusmedik_reply_guard_reset('${contact}', 'operator:test');`);
      expect(await db.fails(`update public.plusmedik_reply_guard_marks set signature = 'OTRA' where run_id = '${t.id}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_reply_guard_marks`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_reply_guard_marks`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`update public.plusmedik_reply_guard_events set kind = 'RATE_LIMITED' where contact_key = '${contact}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_reply_guard_events`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_reply_guard_events`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_reply_guard_state`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_reply_guard_state`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`update public.plusmedik_reply_guard_state set contact_key = '${newContact()}' where contact_key = '${contact}'`)).toMatch(/PT409|foreign key|immutable/);
      expect(await db.fails(`update public.plusmedik_reply_guard_state set suppressed_until = now() + interval '25 hours', reason = 'LOOP_BURST', updated_at = now() where contact_key = '${contact}'`)).toMatch(/check|violates/);
      expect(await db.fails(`update public.plusmedik_reply_guard_state set suppressed_until = now() + interval '1 hour' where contact_key = '${contact}'`)).toMatch(/check|violates/);
    });

    it("solo guardan códigos y contadores: ninguna columna admite texto libre largo ni teléfonos", async () => {
      const columns = await db.ok(`select table_name || '.' || column_name || ':' || data_type from information_schema.columns where table_schema = 'public' and table_name like 'plusmedik_reply_guard_%' order by 1`);
      expect(columns.split(/\r?\n/).sort()).toEqual([
        "plusmedik_reply_guard_events.contact_key:text", "plusmedik_reply_guard_events.created_at:timestamp with time zone", "plusmedik_reply_guard_events.detail:jsonb", "plusmedik_reply_guard_events.id:uuid",
        "plusmedik_reply_guard_events.kind:text", "plusmedik_reply_guard_events.run_id:uuid",
        "plusmedik_reply_guard_marks.contact_key:text", "plusmedik_reply_guard_marks.created_at:timestamp with time zone", "plusmedik_reply_guard_marks.run_id:uuid", "plusmedik_reply_guard_marks.signature:text",
        "plusmedik_reply_guard_state.contact_key:text", "plusmedik_reply_guard_state.counted_since:timestamp with time zone", "plusmedik_reply_guard_state.reason:text",
        "plusmedik_reply_guard_state.suppressed_until:timestamp with time zone", "plusmedik_reply_guard_state.updated_at:timestamp with time zone"
      ].sort());
      expect(await db.fails(`set role service_role; insert into public.plusmedik_reply_guard_marks (run_id, contact_key, signature) values (gen_random_uuid(), '${newContact()}', 'hola paciente')`)).toMatch(/permission|violates|denied/);
    });
  });

  describe("validación de la configuración y de los argumentos", () => {
    it.each([
      ["sin reglas", guard({ rules: [] })],
      ["cinco reglas", guard({ rules: Array.from({ length: 5 }, () => ({ windowSeconds: 60, max: 5 })) })],
      ["reglas que no es lista", guard({ rules: { windowSeconds: 60, max: 5 } })],
      ["ventana cero", guard({ rules: [{ windowSeconds: 0, max: 5 }] })],
      ["ventana mayor que un día", guard({ rules: [{ windowSeconds: 86401, max: 5 }] })],
      ["tope cero", guard({ rules: [{ windowSeconds: 60, max: 0 }] })],
      ["tope fraccionario", guard({ rules: [{ windowSeconds: 60, max: 1.5 }] })],
      ["tope como texto", guard({ rules: [{ windowSeconds: 60, max: "5" }] })],
      ["tope negativo", guard({ rules: [{ windowSeconds: 60, max: -1 }] })],
      ["regla con clave extra", guard({ rules: [{ windowSeconds: 60, max: 5, otra: 1 }] })],
      ["regla sin tope", guard({ rules: [{ windowSeconds: 60 }] })],
      ["ráfaga con tope 1 (cualquier mensaje sería ráfaga)", guard({ burst: { windowSeconds: 60, max: 1 } })],
      ["repetición con tope 1", guard({ repeat: { windowSeconds: 900, max: 1 } })],
      ["enfriamiento mayor que un día", guard({ cooldownSeconds: 86401 })],
      ["enfriamiento cero", guard({ cooldownSeconds: 0 })],
      ["firma en minúsculas", guard({ signature: "info_request" })],
      ["firma con espacio (texto del paciente)", guard({ signature: "hola quiero precios" })],
      ["firma como número", guard({ signature: 5 })],
      ["firma de 65 caracteres", guard({ signature: "A".repeat(65) })],
      ["clave extra en la raíz", guard({ extra: true })],
      ["sin ráfaga", (({ burst: _b, ...rest }) => rest)(guard())],
      ["configuración como lista", [guard()]],
      ["configuración como texto", "on"]
    ])("rechaza %s (PT422) sin reservar nada", async (_name, bad) => {
      const contact = newContact();
      const t = await turn(contact);
      expect(await db.fails(asService(guardedSql(t.id, t.who, t.fence, bad)))).toContain("PT422");
      expect((await row(t.message)).send_state).toBe("NOT_RESERVED");
    });

    it("rechaza tipo de envío, política y lease inválidos, y un turno inexistente", async () => {
      const t = await turn(newContact());
      const bad = (kind: string, stale: string, lease: number) => `select public.plusmedik_turn_reserve_send_guarded('${t.id}'::uuid, '${t.who}', ${t.fence}, '${kind}', ${lease}, '${stale}', ${jsonSql(guard())});`;
      expect(await db.fails(asService(bad("otro", "NONE", 120)))).toContain("PT422");
      expect(await db.fails(asService(bad("conversation", "ALGUNA", 120)))).toContain("PT422");
      expect(await db.fails(asService(bad("conversation", "NONE", 0)))).toContain("PT422");
      expect(await db.fails(asService(guardedSql("00000000-0000-4000-8000-000000000000", t.who, t.fence, guard())))).toContain("PT404");
    });

    it("sin la prueba del lease (otra generación) no hay reserva: PT410", async () => {
      const t = await turn(newContact());
      expect(await db.fails(asService(guardedSql(t.id, t.who, t.fence + 5, guard())))).toContain("PT410");
      expect(await db.fails(asService(guardedSql(t.id, owner(9), t.fence, guard())))).toContain("PT410");
      expect((await row(t.message)).send_state).toBe("NOT_RESERVED");
    });
  });

  describe("sin guarda, o fuera de lo conversacional, es la reserva de siempre", () => {
    it("guarda nula: mismo resultado que plusmedik_turn_reserve_send en reservar, repetir y pausa humana", async () => {
      const a = newContact();
      const b = newContact();
      const ta = await turn(a);
      const tb = await turn(b);
      const plain = (t: Turn) => call(`select public.plusmedik_turn_reserve_send('${t.id}'::uuid, '${t.who}', ${t.fence}, 'conversation', 120, 'NONE');`);
      expect((await plain(ta)).status).toBe("reserved");
      expect((await guarded(tb, null)).status).toBe("reserved");
      expect((await plain(ta)).status).toBe("reserved");
      expect((await guarded(tb, null)).status).toBe("reserved");
      expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_marks where contact_key in ('${a}', '${b}')`)).toBe("0");
      expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_state where contact_key in ('${a}', '${b}')`)).toBe("0");
      const paused = newContact();
      const tp = await turn(paused);
      await pause(paused);
      expect((await guarded(tp, null)).status).toBe("blocked");
    });

    it("un turno de IMAGEN nunca se limita, ni siquiera con un tope de 1", async () => {
      const contact = newContact();
      const strict = guard({ rules: [{ windowSeconds: 600, max: 1 }] });
      await replied(contact, strict);
      expect((await guarded(await turn(contact, 1, "TEXT"), strict)).status).toBe("limited");
      const image = await turn(contact, 1, "IMAGE");
      expect((await guarded(image, strict, "conversation")).status).toBe("reserved");
      await call(replySql(image.id, image.who, image.fence));
      const image2 = await turn(contact, 1, "IMAGE");
      expect((await guarded(image2, strict, "technical_issue")).status).toBe("reserved");
    });

    it("una cotización ('quoted', 'no_quote') de un turno de texto tampoco se limita", async () => {
      const contact = newContact();
      const strict = guard({ rules: [{ windowSeconds: 600, max: 1 }] });
      await replied(contact, strict);
      const quoted = await turn(contact);
      expect((await guarded(quoted, strict, "quoted")).status).toBe("reserved");
      await call(replySql(quoted.id, quoted.who, quoted.fence, "ACCEPTED", "quoted"));
      expect((await guarded(await turn(contact), strict, "no_quote")).status).toBe("reserved");
    });
  });

  describe("tope de respuestas por contacto y ventana", () => {
    it("deja pasar hasta el tope y limita la siguiente: la corrida queda cancelada con su motivo y la bitácora lo registra una vez por ventana", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      const fourth = await turn(contact);
      expect(await guarded(fourth, guard())).toEqual({ status: "limited", reason: "RATE_LIMITED" });
      const limited = await row(fourth.message);
      expect(limited).toMatchObject({ send_state: "CANCELLED", send_block_reason: "RATE_LIMITED", processing_status: "COMPLETED" });
      expect(limited.send_blocked_at).toBeTruthy();
      const fifth = await turn(contact);
      expect((await guarded(fifth, guard())).reason).toBe("RATE_LIMITED");
      const log = await events(contact);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ kind: "RATE_LIMITED", run_id: fourth.id, detail: { rule: 0, count: 3, windowSeconds: 600, max: 3 } });
      // un mensaje limitado queda cerrado: reservar de nuevo no lo revive
      expect((await guarded(fourth, guard())).status).toBe("closed");
    });

    it("la ventana es deslizante: al pasar el tiempo el contacto vuelve a recibir respuestas, sin intervención", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      expect((await guarded(await turn(contact), guard())).status).toBe("limited");
      await rewind(contact, 601);
      expect((await guarded(await turn(contact), guard())).status).toBe("reserved");
    });

    it("la ventana se libera de a una: solo cuentan los envíos dentro de la ventana", async () => {
      const contact = newContact();
      await replied(contact);
      await rewind(contact, 400);
      await replied(contact);
      await replied(contact);
      // 3 envíos en total pero solo 2 dentro de los últimos 300 s
      expect((await guarded(await turn(contact), guard({ rules: [{ windowSeconds: 300, max: 3 }] }))).status).toBe("reserved");
    });

    it("cualquiera de las reglas limita (p. ej. el tope diario aunque el de 10 minutos no se alcance)", async () => {
      const contact = newContact();
      const rules = [{ windowSeconds: 600, max: 5 }, { windowSeconds: 86400, max: 3 }];
      for (let i = 0; i < 3; i++) await replied(contact, guard({ rules }));
      await rewind(contact, 3600);
      const t = await turn(contact);
      expect(await guarded(t, guard({ rules }))).toEqual({ status: "limited", reason: "RATE_LIMITED" });
      expect((await events(contact))[0]).toMatchObject({ detail: { rule: 1, windowSeconds: 86400, max: 3 } });
    });

    it("cuenta lo enviado o de resultado incierto (UNKNOWN), no lo cancelado, limitado ni descartado por obsoleto", async () => {
      const contact = newContact();
      await replied(contact, guard(), "conversation", "UNKNOWN");
      await replied(contact, guard({ rules: [{ windowSeconds: 600, max: 50 }] }), "technical_issue");
      // un turno descartado por obsoleto NO cuenta
      const old = await turn(contact, 1);
      await replied(contact, guard({ rules: [{ windowSeconds: 600, max: 50 }] }));
      expect((await guarded(old, guard({ rules: [{ windowSeconds: 600, max: 50 }] }), "conversation", "NEWER_TURN")).status).toBe("superseded");
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}' and send_state = 'CANCELLED'`)).toBe("1");
      // 3 envíos contados (UNKNOWN + technical_issue + conversation): el siguiente con tope 3 se limita; con tope 4 pasa
      expect((await guarded(await turn(contact), guard({ rules: [{ windowSeconds: 600, max: 3 }] }))).status).toBe("limited");
      expect((await guarded(await turn(contact), guard({ rules: [{ windowSeconds: 600, max: 4 }] }))).status).toBe("reserved");
    });

    it("un aviso técnico de un turno de texto también cuenta y también se limita", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact, guard(), "technical_issue");
      expect((await guarded(await turn(contact), guard(), "technical_issue")).reason).toBe("RATE_LIMITED");
      expect((await guarded(await turn(contact), guard(), "conversation")).reason).toBe("RATE_LIMITED");
    });

    it("es idempotente: repetir una reserva ya concedida devuelve 'reserved' aunque el contacto ya esté en el tope (no se limita a sí misma)", async () => {
      const contact = newContact();
      await replied(contact);
      await replied(contact);
      const t = await turn(contact);
      expect((await guarded(t, guard())).status).toBe("reserved");
      expect((await guarded(t, guard())).status).toBe("reserved");
      expect((await guarded(t, guard({ rules: [{ windowSeconds: 600, max: 1 }] }))).status).toBe("reserved");
      expect((await row(t.message)).send_state).toBe("RESERVED");
    });

    it("cada contacto tiene su propio tope", async () => {
      const a = newContact();
      const b = newContact();
      for (let i = 0; i < 3; i++) await replied(a);
      expect((await guarded(await turn(a), guard())).status).toBe("limited");
      expect((await guarded(await turn(b), guard())).status).toBe("reserved");
    });

    it("concurrencia: 8 turnos del mismo contacto compiten por 3 huecos y no pasa ninguno de más", async () => {
      const contact = newContact();
      const turns: Turn[] = [];
      for (let i = 0; i < 8; i++) turns.push(await turn(contact, i + 1));
      const outcomes = await Promise.all(
        turns.map(async (t) => {
          for (let attempt = 0; attempt < 200; attempt++) {
            const result = await guarded(t, guard());
            if (result.status === "busy") {
              await sleep(25);
              continue;
            }
            if (result.status === "reserved") await call(replySql(t.id, t.who, t.fence));
            return result.status as string;
          }
          return "timeout";
        })
      );
      expect(outcomes.filter((status) => status === "reserved")).toHaveLength(3);
      expect(outcomes.filter((status) => status === "limited")).toHaveLength(5);
      expect(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}' and send_state = 'ACCEPTED'`)).toBe("3");
    });
  });

  describe("precedencia: pausa humana, otro envío en vuelo y respuestas obsoletas van antes que el tope", () => {
    it("un contacto en pausa humana recibe 'blocked' (HUMAN_PAUSED), no 'limited'; el tope no toca la pausa ni la pausa se levanta con el reset", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      // el turno ya estaba reclamado cuando llegó la pausa (un turno nuevo de un contacto pausado ni siquiera se reclama)
      const t = await turn(contact);
      await pause(contact);
      const result = await guarded(t, guard());
      expect(result.status).toBe("blocked");
      expect(await row(t.message)).toMatchObject({ send_block_reason: "HUMAN_PAUSED", send_state: "CANCELLED" });
      expect(await events(contact)).toHaveLength(0);
      await call(`select public.plusmedik_reply_guard_reset('${contact}', 'operator:test');`);
      expect(await db.ok(`select state from public.plusmedik_attention_contacts where contact_key = '${contact}'`)).toBe("HUMAN_PAUSED");
      expect((await claim(newMessage(), owner(1), contact)).outcome).toBe("paused");
    });

    it("limitar a un contacto no lo pausa ni toca la atención humana", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      expect((await guarded(await turn(contact), guard())).status).toBe("limited");
      expect(await db.ok(`select count(*) from public.plusmedik_attention_contacts where contact_key = '${contact}'`)).toBe("0");
    });

    it("con otro envío del contacto en vuelo responde 'busy' (se reintenta), aunque ya esté en el tope", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      const inFlight = await turn(contact, 1);
      // reserva sin tope (otra configuración) para dejar un envío 'RESERVED' en vuelo
      expect((await guarded(inFlight, guard({ rules: [{ windowSeconds: 600, max: 50 }] }))).status).toBe("reserved");
      const next = await turn(contact, 2);
      expect((await guarded(next, guard())).status).toBe("busy");
      expect((await row(next.message)).send_state).toBe("NOT_RESERVED");
      await call(replySql(inFlight.id, inFlight.who, inFlight.fence));
      expect((await guarded(next, guard())).status).toBe("limited");
    });

    it("una respuesta obsoleta (NEWER_TURN) se descarta como 'superseded' aunque también estuviera en el tope", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      const old = await turn(contact, 1);
      await replied(contact, guard({ rules: [{ windowSeconds: 600, max: 50 }] }));
      const result = await guarded(old, guard(), "conversation", "NEWER_TURN");
      expect(result.status).toBe("superseded");
      expect(await row(old.message)).toMatchObject({ send_block_reason: "SUPERSEDED" });
    });
  });

  describe("ráfagas y bucles", () => {
    const burst = (max: number, extra: Json = {}) => guard({ rules: [{ windowSeconds: 600, max: 1000 }], burst: { windowSeconds: 60, max }, ...extra });

    it("demasiados mensajes de texto en poco tiempo = ráfaga: se suprime al contacto (temporal), se registra una vez y el resto se descarta sin ruido", async () => {
      const contact = newContact();
      const g = burst(4);
      const turns: Turn[] = [];
      for (let i = 0; i < 6; i++) turns.push(await turn(contact, i + 1));
      // los tres primeros pasan (cuando se reserva el 4.º ya hay 4 mensajes... ) -> el turno que cierra la ráfaga dispara la supresión
      const results: string[] = [];
      for (const t of turns) {
        const result = await guarded(t, g);
        results.push(result.status === "limited" ? result.reason : result.status);
        if (result.status === "reserved") await call(replySql(t.id, t.who, t.fence));
      }
      // las 6 llegaron en el mismo instante: ya en la primera reserva hay 6 turnos recientes (>= 4)
      expect(results[0]).toBe("LOOP_SUSPECTED");
      expect(results.slice(1).every((value) => value === "SUPPRESSED")).toBe(true);
      const log = await events(contact);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ kind: "LOOP_SUSPECTED", detail: { signal: "BURST", windowSeconds: 60, max: 4, cooldownSeconds: 600 } });
      expect(await state(contact)).toMatchObject({ reason: "LOOP_BURST" });
      expect(await row(turns[0]!.message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "LOOP_SUSPECTED" });
      expect(await row(turns[3]!.message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "SUPPRESSED" });
    });

    it("una conversación humana normal (pocos mensajes) no es una ráfaga", async () => {
      const contact = newContact();
      const g = burst(8);
      for (let i = 0; i < 5; i++) await replied(contact, g);
    });

    it("la supresión CADUCA sola: pasado el enfriamiento el contacto vuelve a recibir respuestas", async () => {
      const contact = newContact();
      const g = burst(3, { cooldownSeconds: 120 });
      for (let i = 0; i < 3; i++) await turn(contact, i + 1);
      const t = await turn(contact, 9);
      expect((await guarded(t, g)).reason).toBe("LOOP_SUSPECTED");
      expect((await guarded(await turn(contact, 10), g)).reason).toBe("SUPPRESSED");
      await rewind(contact, 121);
      const later = await guarded(await turn(contact, 11), g);
      expect(later.status, JSON.stringify(later)).toBe("reserved");
    });

    it("las imágenes no cuentan para la ráfaga y no se redefine por reintentos del mismo mensaje", async () => {
      const contact = newContact();
      for (let i = 0; i < 6; i++) await turn(contact, i + 1, "IMAGE");
      expect((await guarded(await turn(contact, 9), burst(3))).status).toBe("reserved");
      // el mismo message_id entregado otra vez no es otro turno
      const message = newMessage();
      await claim(message, owner(1), contact, "TEXT");
      const again = await claim(message, owner(2), contact, "TEXT");
      expect(again.outcome).not.toBe("claimed");
      expect(await db.ok(`select count(*) from public.plusmedik_turns where contact_key = '${contact}' and turn_kind = 'TEXT'`)).toBe("2");
    });

    it("la supresión de un contacto no afecta a otro", async () => {
      const a = newContact();
      const b = newContact();
      for (let i = 0; i < 4; i++) await turn(a, i + 1);
      expect((await guarded(await turn(a, 9), burst(3))).reason).toBe("LOOP_SUSPECTED");
      expect((await guarded(await turn(b, 1), burst(3))).status).toBe("reserved");
    });
  });

  describe("repetición de la misma respuesta", () => {
    const repeat = (max: number, extra: Json = {}) => guard({ rules: [{ windowSeconds: 600, max: 1000 }], repeat: { windowSeconds: 900, max }, ...extra });

    it("la misma firma dada 3 veces en la ventana: la 4.ª se suprime (REPEAT_SUSPECTED) y queda registrada; otra firma antes de la supresión sí pasa", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact, repeat(3, { signature: "INFO_REQUEST:HOURS" }));
      await replied(contact, repeat(3, { signature: "INFO_REQUEST:LOCATION" }));
      const t = await turn(contact);
      expect(await guarded(t, repeat(3, { signature: "INFO_REQUEST:HOURS" }))).toEqual({ status: "limited", reason: "REPEAT_SUSPECTED" });
      expect((await events(contact)).at(-1)).toMatchObject({ kind: "REPEAT_SUSPECTED", detail: { signal: "REPEAT", signature: "INFO_REQUEST:HOURS", count: 3, max: 3 } });
      // ya suprimido: todo se descarta hasta que caduque
      expect((await guarded(await turn(contact), repeat(3, { signature: "GREETING" }))).reason).toBe("SUPPRESSED");
      expect(await state(contact)).toMatchObject({ reason: "LOOP_REPEAT" });
    });

    it("sin firma no hay detección de repetición (solo el tope)", async () => {
      const contact = newContact();
      for (let i = 0; i < 6; i++) await replied(contact, repeat(3));
    });

    it("solo cuentan las respuestas que realmente se enviaron: una reserva cancelada o limitada no deja marca que cuente", async () => {
      const contact = newContact();
      const sig = repeat(3, { signature: "GREETING" });
      for (let i = 0; i < 2; i++) await replied(contact, sig);
      // una tercera reservada pero cancelada por la comprobación final (pausa humana a mitad de camino)
      const t = await turn(contact);
      expect((await guarded(t, sig)).status).toBe("reserved");
      await pause(contact);
      expect((await call(`select public.plusmedik_audit_confirm_send('${t.id}'::uuid, '${t.who}', ${t.fence});`)).status).toBe("blocked");
      expect(await db.ok(`select count(*) from public.plusmedik_reply_guard_marks m join public.plusmedik_audit_runs r on r.id = m.run_id where m.contact_key = '${contact}' and r.send_state = 'CANCELLED'`)).toBe("1");
    });

    it("la repetición expira con la ventana", async () => {
      const contact = newContact();
      const sig = repeat(3, { signature: "GREETING" });
      for (let i = 0; i < 3; i++) await replied(contact, sig);
      await rewind(contact, 901);
      expect((await guarded(await turn(contact), sig)).status).toBe("reserved");
    });

    it("un bucle de saludos de un bot (la misma respuesta una y otra vez) se corta tras el tope y no vuelve a empezar hasta que caduque", async () => {
      const contact = newContact();
      const sig = repeat(3, { signature: "GREETING", cooldownSeconds: 300 });
      const statuses: string[] = [];
      for (let i = 0; i < 8; i++) {
        const t = await turn(contact, 1);
        const result = await guarded(t, sig);
        statuses.push(result.status === "limited" ? result.reason : result.status);
        if (result.status === "reserved") await call(replySql(t.id, t.who, t.fence));
      }
      expect(statuses).toEqual(["reserved", "reserved", "reserved", "REPEAT_SUSPECTED", "SUPPRESSED", "SUPPRESSED", "SUPPRESSED", "SUPPRESSED"]);
      expect(await events(contact)).toHaveLength(1);
    });
  });

  describe("recuperación: un paciente legítimo nunca queda bloqueado para siempre", () => {
    it("el reset levanta la supresión, reinicia el conteo y deja el registro RECOVERED con quién lo hizo", async () => {
      const contact = newContact();
      const g = guard({ burst: { windowSeconds: 60, max: 3 } });
      for (let i = 0; i < 4; i++) await turn(contact, i + 1);
      expect((await guarded(await turn(contact, 9), g)).reason).toBe("LOOP_SUSPECTED");
      expect((await guarded(await turn(contact, 10), g)).reason).toBe("SUPPRESSED");
      expect(await call(`select public.plusmedik_reply_guard_reset('${contact}', 'operator:laura');`)).toEqual({ status: "reset", hadSuppression: true });
      const after = await guarded(await turn(contact, 11), g);
      expect(after.status, JSON.stringify(after)).toBe("reserved");
      const log = await events(contact);
      expect(log.at(-1)).toMatchObject({ kind: "RECOVERED", run_id: null, detail: { actor: "operator:laura", hadSuppression: true } });
    });

    it("el reset también libera un tope alcanzado (los envíos anteriores dejan de contar) sin borrar ningún dato", async () => {
      const contact = newContact();
      for (let i = 0; i < 3; i++) await replied(contact);
      expect((await guarded(await turn(contact), guard())).status).toBe("limited");
      const sendsBefore = await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}'`);
      await sleep(30);
      expect(await call(`select public.plusmedik_reply_guard_reset('${contact}', 'operator:laura');`)).toEqual({ status: "reset", hadSuppression: false });
      expect((await guarded(await turn(contact), guard())).status).toBe("reserved");
      expect(Number(await db.ok(`select count(*) from public.plusmedik_audit_runs where contact_key = '${contact}'`))).toBe(Number(sendsBefore) + 1);
    });

    it("el reset valida sus argumentos y un contacto desconocido responde not_found", async () => {
      expect(await call(`select public.plusmedik_reply_guard_reset('${newContact()}', 'operator:laura');`)).toEqual({ status: "not_found" });
      expect(await db.fails(asService(`select public.plusmedik_reply_guard_reset('no-es-hex', 'operator:laura');`))).toContain("PT422");
      expect(await db.fails(asService(`select public.plusmedik_reply_guard_reset('${newContact()}', 'a');`))).toContain("PT422");
      expect(await db.fails(asService(`select public.plusmedik_reply_guard_reset('${newContact()}', 'Laura Pérez (laura@correo.com)');`))).toContain("PT422");
      expect(await db.fails(`set role unprivileged; select public.plusmedik_reply_guard_reset('${newContact()}', 'operator:laura');`)).toMatch(/permission denied/);
    });

    it("la supresión nunca pasa de 24 h aunque el enfriamiento pedido sea el máximo", async () => {
      const contact = newContact();
      for (let i = 0; i < 4; i++) await turn(contact, i + 1);
      expect((await guarded(await turn(contact, 9), guard({ burst: { windowSeconds: 60, max: 3 }, cooldownSeconds: 86400 }))).reason).toBe("LOOP_SUSPECTED");
      const hours = Number(await db.ok(`select extract(epoch from (suppressed_until - updated_at)) / 3600 from public.plusmedik_reply_guard_state where contact_key = '${contact}'`));
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it("el estado consultable muestra la supresión vigente y los últimos eventos, y deja de mostrarla al caducar; sin teléfonos ni texto", async () => {
      const contact = newContact();
      const g = guard({ burst: { windowSeconds: 60, max: 3 }, cooldownSeconds: 100 });
      for (let i = 0; i < 4; i++) await turn(contact, i + 1);
      await guarded(await turn(contact, 9), g);
      const status = await call(`select public.plusmedik_reply_guard_status('${contact}');`);
      expect(status.suppressedUntil).toBeTruthy();
      expect(status.reason).toBe("LOOP_BURST");
      expect(status.events).toHaveLength(1);
      expect(JSON.stringify(status)).not.toMatch(/\d{8}@|\+\d{6}/);
      await rewind(contact, 101);
      const later = await call(`select public.plusmedik_reply_guard_status('${contact}');`);
      expect(later.suppressedUntil).toBeNull();
      expect(later.events).toHaveLength(1);
      expect(await call(`select public.plusmedik_reply_guard_status('${newContact()}');`)).toMatchObject({ suppressedUntil: null, events: [] });
      expect(await db.fails(asService(`select public.plusmedik_reply_guard_status('x');`))).toContain("PT422");
    });
  });

  describe("la migración es aditiva", () => {
    const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
    const code = read(GUARD).replace(/--.*$/gm, "");

    it("es la décima (las siguientes: sesiones de cotización G4.0 y datos por estudio G4.1) y las nueve anteriores no se modificaron (hashes fijados)", () => {
      expect(MIGRATIONS[9]).toBe(GUARD);
      expect(MIGRATIONS).toHaveLength(16); // preserva el manifiesto oficial; el SQL de staging para Dokploy se guarda fuera de migrations/
      expect(sha("20261028000000_plusmedik_knowledge_refs.sql")).toBe("aa0b8644dc0f4a2ac98c84ae4c123b03c5e261c41618f4d45ec7dc9245690021");
    });

    it("solo crea las tablas, funciones e índices esperados: sin borrar, sin datos, sin SQL dinámico, sin tocar el catálogo ni el esquema del CRM", () => {
      expect([...code.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])).toEqual(["plusmedik_reply_guard_marks", "plusmedik_reply_guard_state", "plusmedik_reply_guard_events"]);
      expect([...code.matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1])).toEqual([
        "plusmedik_reply_guard_state_guard", "plusmedik_reply_guard_int", "plusmedik_reply_guard_valid", "plusmedik_turn_reserve_send_guarded", "plusmedik_reply_guard_reset", "plusmedik_reply_guard_status"
      ]);
      expect(code).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\btruncate\s+table\b|\bexecute\s+(format|'|\$)|\bcreate\s+extension\b|\blab_tests\b|\bcrm\b/i);
      // lo único que altera es activar la seguridad por filas de SUS tablas nuevas, y el único índice sobre una tabla anterior es aditivo
      expect([...code.matchAll(/alter\s+table\s+([\w.]+)\s+([a-z ]+);/gi)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
        "public.plusmedik_reply_guard_marks enable row level security", "public.plusmedik_reply_guard_state enable row level security", "public.plusmedik_reply_guard_events enable row level security"
      ]);
      expect([...code.matchAll(/create index if not exists (\w+) on public\.(\w+)/gi)].map((m) => m[2])).toEqual(["plusmedik_audit_runs", "plusmedik_reply_guard_marks", "plusmedik_reply_guard_events"]);
      expect(code).not.toMatch(/\binsert\s+into\s+public\.plusmedik_(?!reply_guard_)/i);
      expect(code).not.toMatch(/\bupdate\s+public\.plusmedik_(?!reply_guard_state\b|audit_runs\b)/i);
      expect(code.match(/security definer/gi)).toHaveLength(3);
      expect(code.match(/set search_path = ''/g)).toHaveLength(6);
    });
  });
});
