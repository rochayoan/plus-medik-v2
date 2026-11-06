import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 11 (sesiones de cotización) contra un PostgreSQL REAL y efímero: ítems idempotentes, fotos repetidas, cierre que solo acepta lo identificado, turnos anteriores en
// proceso, repetición del cierre, cola de revisión, arrastre de lo posterior, concurrencia y privacidad. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[quote-session-db] PostgreSQL no disponible: se omiten las pruebas de sesiones de cotización contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SESSIONS = "20261030000000_plusmedik_quote_sessions.sql";
const TEXT_FLOW = "20261102000000_plusmedik_quote_text_flow.sql";
type Json = Record<string, any>;
const read = (name: string) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resolved = (...ids: number[]): Json => ({ status: "RESOLVED", studyIds: ids.map(uuid), ambiguous: [], unresolved: 0, reasons: [] });
const ambiguous = (...group: number[]): Json => ({ status: "AMBIGUOUS", studyIds: [], ambiguous: [group.map(uuid)], unresolved: 0, reasons: ["AMBIGUOUS_STUDY"] });
const unresolvedItem: Json = { status: "UNRESOLVED", studyIds: [], ambiguous: [], unresolved: 1, reasons: ["UNRESOLVED_TEXT"] };
const uncertain: Json = { status: "UNCERTAIN", studyIds: [uuid(1)], ambiguous: [], unresolved: 0, reasons: ["ENGINE_PARTIAL"] };
const unreadable: Json = { status: "UNREADABLE", studyIds: [], ambiguous: [], unresolved: 0, reasons: ["UNREADABLE_IMAGE"] };
const line = (n: number, price: number, name = `ESTUDIO ${n}`) => ({ studyId: uuid(n), name, priceBs: price });
const FP = "a".repeat(64);

describe.skipIf(!bin)("sesiones de cotización contra PostgreSQL real (migración 11)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("quote_sessions");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const newMessage = () => `wamid.quote-${++counter}-${Date.now()}`;
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
  const first = (out: string) => JSON.parse(out.split("\n")[0]!) as Json;
  const call = async (sql: string): Promise<Json> => first(await db.ok(asService(sql)));
  const json = (value: unknown) => (value === null || value === undefined ? "null::jsonb" : `$q$${JSON.stringify(value)}$q$::jsonb`);
  const text = (value: string | null) => (value === null ? "null::text" : `$q$${value}$q$::text`);
  const claim = (message: string, who: string, contact: string, kind = "TEXT") =>
    call(`select public.plusmedik_turn_claim('${message}', null, '${who}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', '${kind}');`);
  const idOf = (message: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
  interface Turn { message: string; id: string; who: string; fence: number }
  async function turn(contact: string, kind = "TEXT", who = 1): Promise<Turn> {
    const message = newMessage();
    const claimed = await claim(message, owner(who), contact, kind);
    return { message, id: await idOf(message), who: owner(who), fence: claimed.fence as number };
  }
  // Termina el procesamiento del turno (como lo haría el cierre de una corrida sin respuesta).
  const finish = (t: Turn) => db.ok(asService(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`));
  const beginSql = (t: Turn, kind: string, result: Json | null, hash: string | null = null, ttl = 1800, max = 20) =>
    `select public.plusmedik_quote_item_begin('${t.id}'::uuid, '${t.who}', ${t.fence}, '${kind}', ${text(hash)}, ${json(result)}, ${ttl}, ${max});`;
  const begin = (t: Turn, kind: string, result: Json | null, hash: string | null = null, ttl = 1800, max = 20) => call(beginSql(t, kind, result, hash, ttl, max));
  const finishItem = (t: Turn, result: Json) => call(`select public.plusmedik_quote_item_finish('${t.id}'::uuid, '${t.who}', ${t.fence}, ${json(result)});`);
  const readSql = (t: Turn) => `select public.plusmedik_quote_session_read('${t.id}'::uuid, '${t.who}', ${t.fence});`;
  const readState = (t: Turn) => call(readSql(t));
  const closeSql = (t: Turn, sessionId: string, outcome: string, extra: { lines?: unknown; total?: number | null; reasons?: string[] | null; fp?: string | null } = {}) =>
    `select public.plusmedik_quote_session_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '${sessionId}'::uuid, '${outcome}', ${json(extra.lines ?? null)}, ${extra.total ?? "null"}::numeric, ${extra.reasons ? `array[${extra.reasons.map((r) => `'${r}'`).join(",")}]::text[]` : "null::text[]"}, ${text(extra.fp ?? null)});`;
  const closeIt = (t: Turn, sessionId: string, outcome: string, extra = {}) => call(closeSql(t, sessionId, outcome, extra));
  const sessionRow = async (id: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(s) from public.plusmedik_quote_sessions s where id = '${id}'`));
  const items = async (sessionId: string): Promise<Json[]> => JSON.parse(await db.ok(`select coalesce(json_agg(i order by i.seq), '[]') from public.plusmedik_quote_items i where session_id = '${sessionId}'`));
  // Una sesión con ítems ya terminados, lista para cerrar con un turno posterior.
  async function sessionWith(contact: string, results: Json[]) {
    let sessionId = "";
    for (const result of results) {
      const t = await turn(contact);
      const b = await begin(t, "TEXT", result);
      sessionId = b.sessionId;
      await finish(t);
    }
    const closer = await turn(contact);
    return { sessionId, closer };
  }

  describe("esquema, privilegios e inmutabilidad", () => {
    it("la migración se puede volver a aplicar sin error y sin tocar datos", async () => {
      const contact = newContact();
      const t = await turn(contact);
      const b = await begin(t, "TEXT", resolved(1));
      await db.applyFile(join(dir, SESSIONS));
      // las migraciones posteriores que redefinen funciones de esta se vuelven a aplicar en su orden (si no, quedarían las versiones de la 11)
      await db.applyFile(join(dir, TEXT_FLOW));
      expect((await items(b.sessionId))).toHaveLength(1);
    });

    it("las cuatro tablas tienen RLS; service_role solo lee y nadie más tiene acceso", async () => {
      for (const table of ["plusmedik_quote_sessions", "plusmedik_quote_items", "plusmedik_quote_results", "plusmedik_quote_reviews"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', 'select')`)).toBe("t");
        for (const privilege of ["insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', '${privilege}')`)).toBe("f");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', 'select')`)).toBe("f");
      }
    });

    it("las funciones públicas son SECURITY DEFINER con search_path vacío; solo service_role las ejecuta", async () => {
      for (const signature of [
        "plusmedik_quote_item_begin(uuid, text, bigint, text, text, jsonb, integer, integer)", "plusmedik_quote_item_finish(uuid, text, bigint, jsonb)",
        "plusmedik_quote_session_read(uuid, text, bigint)", "plusmedik_quote_session_close(uuid, text, bigint, uuid, text, jsonb, numeric, text[], text)"
      ]) {
        expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`)).toBe("t");
        expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`)).toContain("search_path=");
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`)).toBe("t");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`)).toBe("f");
      }
    });

    it("nada se borra ni se vacía; el resultado y la cola son inmutables; un ítem terminado y una sesión cerrada no cambian", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP });
      const itemId = (await items(sessionId))[0]!.id;
      expect(await db.fails(`delete from public.plusmedik_quote_items where id = '${itemId}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_quote_items`)).toMatch(/PT409|immutable|cannot truncate/);
      expect(await db.fails(`delete from public.plusmedik_quote_sessions`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_quote_sessions`)).toMatch(/PT409|immutable|cannot truncate/);
      expect(await db.fails(`update public.plusmedik_quote_results set total_bs = 1 where session_id = '${sessionId}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_quote_results`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_quote_results`)).toMatch(/PT409|immutable|cannot truncate/);
      expect(await db.fails(`update public.plusmedik_quote_items set study_ids = '{}' where id = '${itemId}'`)).toMatch(/PT409|finished/);
      expect(await db.fails(`update public.plusmedik_quote_items set status = 'UNREADABLE' where id = '${itemId}'`)).toMatch(/PT409|finished/);
      expect(await db.fails(`update public.plusmedik_quote_sessions set expires_at = now() where id = '${sessionId}'`)).toMatch(/PT409|closed/);
      expect(await db.fails(`update public.plusmedik_quote_sessions set status = 'OPEN', closed_at = null, closed_by_run = null where id = '${sessionId}'`)).toMatch(/PT409|closed|check/);
    });

    it("solo hay códigos, ids de estudios, contadores y el hash de la foto: ninguna columna admite texto del paciente ni teléfonos", async () => {
      const columns = (await db.ok(`select table_name || '.' || column_name || ':' || data_type from information_schema.columns where table_schema = 'public' and table_name like 'plusmedik_quote_%' order by 1`)).split(/\r?\n/).sort();
      expect(columns).toEqual([
        "plusmedik_quote_items.ambiguous:jsonb", "plusmedik_quote_items.contact_key:text", "plusmedik_quote_items.created_at:timestamp with time zone", "plusmedik_quote_items.finished_at:timestamp with time zone",
        "plusmedik_quote_items.id:uuid", "plusmedik_quote_items.image_hash:text", "plusmedik_quote_items.kind:text", "plusmedik_quote_items.reasons:ARRAY", "plusmedik_quote_items.run_id:uuid",
        "plusmedik_quote_items.seq:bigint", "plusmedik_quote_items.session_id:uuid", "plusmedik_quote_items.status:text", "plusmedik_quote_items.study_ids:ARRAY", "plusmedik_quote_items.unresolved_count:integer",
        "plusmedik_quote_results.catalog_fingerprint:text", "plusmedik_quote_results.created_at:timestamp with time zone", "plusmedik_quote_results.lines:jsonb", "plusmedik_quote_results.run_id:uuid",
        "plusmedik_quote_results.session_id:uuid", "plusmedik_quote_results.total_bs:numeric",
        "plusmedik_quote_reviews.contact_key:text", "plusmedik_quote_reviews.created_at:timestamp with time zone", "plusmedik_quote_reviews.item_ids:ARRAY", "plusmedik_quote_reviews.reasons:ARRAY",
        "plusmedik_quote_reviews.run_id:uuid", "plusmedik_quote_reviews.session_id:uuid", "plusmedik_quote_reviews.status:text",
        "plusmedik_quote_sessions.closed_at:timestamp with time zone", "plusmedik_quote_sessions.closed_by_run:uuid", "plusmedik_quote_sessions.closed_seq:bigint", "plusmedik_quote_sessions.contact_key:text",
        "plusmedik_quote_sessions.created_at:timestamp with time zone", "plusmedik_quote_sessions.expires_at:timestamp with time zone", "plusmedik_quote_sessions.id:uuid",
        "plusmedik_quote_sessions.last_activity_at:timestamp with time zone", "plusmedik_quote_sessions.reasons:ARRAY", "plusmedik_quote_sessions.status:text"
      ].sort());
    });
  });

  describe("alta de ítems", () => {
    it("un texto nace terminado; repetir la llamada (reintento o ejecución que reclama el lease) devuelve el mismo ítem sin duplicar", async () => {
      const contact = newContact();
      const t = await turn(contact);
      const first = await begin(t, "TEXT", resolved(1, 2));
      expect(first).toMatchObject({ status: "created", itemStatus: "RESOLVED", position: 1, studyIds: [uuid(1), uuid(2)] });
      const again = await begin(t, "TEXT", resolved(1, 2));
      expect(again).toMatchObject({ status: "exists", itemId: first.itemId, sessionId: first.sessionId, studyIds: [uuid(1), uuid(2)] });
      expect(await items(first.sessionId)).toHaveLength(1);
    });

    it("varios mensajes del mismo contacto comparten UNA sesión abierta y se numeran; otro contacto tiene la suya", async () => {
      const a = newContact();
      const b = newContact();
      const t1 = await turn(a);
      const t2 = await turn(a);
      const tb = await turn(b);
      const r1 = await begin(t1, "TEXT", resolved(1));
      const r2 = await begin(t2, "TEXT", resolved(2));
      const rb = await begin(tb, "TEXT", resolved(3));
      expect(r2.sessionId).toBe(r1.sessionId);
      expect([r1.position, r2.position]).toEqual([1, 2]);
      expect(rb.sessionId).not.toBe(r1.sessionId);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_sessions where contact_key = '${a}' and status = 'OPEN'`)).toBe("1");
    });

    it("una foto nace EN PROCESO y se completa una vez; completarla otra vez con lo mismo es idempotente y con otro resultado es un conflicto", async () => {
      const t = await turn(newContact(), "IMAGE");
      const hash = createHash("sha256").update("foto-1").digest("hex");
      const b = await begin(t, "IMAGE", null, hash);
      expect(b).toMatchObject({ status: "created", itemStatus: "PROCESSING", studyIds: [] });
      expect(await finishItem(t, resolved(1, 2))).toMatchObject({ status: "finished" });
      expect(await finishItem(t, resolved(2, 1))).toMatchObject({ status: "already_finished" });
      expect(await db.fails(asService(`select public.plusmedik_quote_item_finish('${t.id}'::uuid, '${t.who}', ${t.fence}, ${json(resolved(3))});`))).toContain("PT409");
      expect((await items(b.sessionId))[0]).toMatchObject({ status: "RESOLVED", image_hash: hash });
    });

    it("la MISMA foto en la sesión se marca DUPLICATE antes de analizarla; una foto ilegible repetida sí se procesa de nuevo", async () => {
      const contact = newContact();
      const hash = createHash("sha256").update("receta").digest("hex");
      const t1 = await turn(contact, "IMAGE");
      await begin(t1, "IMAGE", null, hash);
      await finishItem(t1, resolved(1));
      const t2 = await turn(contact, "IMAGE");
      expect(await begin(t2, "IMAGE", null, hash)).toMatchObject({ status: "duplicate", itemStatus: "DUPLICATE" });
      const other = createHash("sha256").update("ilegible").digest("hex");
      const t3 = await turn(contact, "IMAGE");
      await begin(t3, "IMAGE", null, other);
      await finishItem(t3, unreadable);
      const t4 = await turn(contact, "IMAGE");
      expect(await begin(t4, "IMAGE", null, other)).toMatchObject({ status: "created", itemStatus: "PROCESSING" });
    });

    it("tope de ítems: pasado el máximo responde 'full' y no agrega nada (los repetidos no cuentan)", async () => {
      const contact = newContact();
      const sessionIds = new Set<string>();
      for (let i = 0; i < 3; i++) sessionIds.add((await begin(await turn(contact), "TEXT", resolved(i + 1), null, 1800, 3)).sessionId);
      const fourth = await turn(contact);
      expect(await begin(fourth, "TEXT", resolved(9), null, 1800, 3)).toMatchObject({ status: "full", count: 3 });
      expect(await items([...sessionIds][0]!)).toHaveLength(3);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where run_id = '${fourth.id}'`)).toBe("0");
    });

    it("una sesión vencida se cierra SIN cotizar nada y el siguiente mensaje abre otra", async () => {
      const contact = newContact();
      const t1 = await turn(contact);
      const r1 = await begin(t1, "TEXT", resolved(1), null, 60);
      await db.ok(`set session_replication_role = replica; update public.plusmedik_quote_sessions set expires_at = now() - interval '1 second' where id = '${r1.sessionId}';`);
      const t2 = await turn(contact);
      const r2 = await begin(t2, "TEXT", resolved(2), null, 60);
      expect(r2.sessionId).not.toBe(r1.sessionId);
      expect(await sessionRow(r1.sessionId)).toMatchObject({ status: "EXPIRED", closed_by_run: null });
      expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${r1.sessionId}'`)).toBe("0");
      expect(r2.position).toBe(1);
    });

    it.each([
      ["tipo desconocido", (t: Turn) => beginSql(t, "VIDEO", null)],
      ["ttl menor que un minuto", (t: Turn) => beginSql(t, "TEXT", resolved(1), null, 30)],
      ["máximo de ítems 0", (t: Turn) => beginSql(t, "TEXT", resolved(1), null, 1800, 0)],
      ["hash con mayúsculas", (t: Turn) => beginSql(t, "IMAGE", null, "A".repeat(64))],
      ["hash en un texto", (t: Turn) => beginSql(t, "TEXT", resolved(1), "a".repeat(64))],
      ["RESOLVED sin estudios", (t: Turn) => beginSql(t, "TEXT", { ...resolved(1), studyIds: [] })],
      ["RESOLVED con dudas", (t: Turn) => beginSql(t, "TEXT", { ...resolved(1), unresolved: 1 })],
      ["AMBIGUOUS sin grupos", (t: Turn) => beginSql(t, "TEXT", { ...ambiguous(7, 8), ambiguous: [] })],
      ["grupo ambiguo de un solo estudio", (t: Turn) => beginSql(t, "TEXT", { ...ambiguous(7, 8), ambiguous: [[uuid(7)]] })],
      ["UNRESOLVED sin fragmentos", (t: Turn) => beginSql(t, "TEXT", { ...unresolvedItem, unresolved: 0 })],
      ["UNCERTAIN sin motivo", (t: Turn) => beginSql(t, "TEXT", { ...uncertain, reasons: [] })],
      ["UNREADABLE con estudios", (t: Turn) => beginSql(t, "TEXT", { ...unreadable, studyIds: [uuid(1)] })],
      ["estado PROCESSING", (t: Turn) => beginSql(t, "TEXT", { ...resolved(1), status: "PROCESSING" })],
      ["id que no es UUID", (t: Turn) => beginSql(t, "TEXT", { ...resolved(1), studyIds: ["hemograma"] })],
      ["motivo desconocido", (t: Turn) => beginSql(t, "TEXT", { ...uncertain, reasons: ["OTRO"] })],
      ["clave extra (texto del paciente)", (t: Turn) => beginSql(t, "TEXT", { ...resolved(1), text: "quiero un hemograma" })],
      ["falta una clave", (t: Turn) => beginSql(t, "TEXT", (({ reasons: _r, ...rest }) => rest)(resolved(1)))],
      ["resultado que no es objeto", (t: Turn) => beginSql(t, "TEXT", ["RESOLVED"] as never)],
      ["más de 60 estudios", (t: Turn) => beginSql(t, "TEXT", resolved(...Array.from({ length: 61 }, (_, i) => i + 1)))]
    ])("rechaza %s (PT422) sin registrar nada", async (_name, make) => {
      const contact = newContact();
      const t = await turn(contact);
      expect(await db.fails(asService(make(t)))).toContain("PT422");
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where run_id = '${t.id}'`)).toBe("0");
    });

    it("sin lease vigente (otra generación u otro propietario) no se escribe: PT410; un turno inexistente: PT404", async () => {
      const t = await turn(newContact());
      const stale = { ...t, fence: t.fence + 3 };
      expect(await db.fails(asService(beginSql(stale, "TEXT", resolved(1))))).toContain("PT410");
      expect(await db.fails(asService(beginSql({ ...t, who: owner(9) }, "TEXT", resolved(1))))).toContain("PT410");
      expect(await db.fails(asService(beginSql({ ...t, id: uuid(777) }, "TEXT", resolved(1))))).toContain("PT404");
      expect(await db.ok(`select count(*) from public.plusmedik_quote_items where run_id = '${t.id}'`)).toBe("0");
    });
  });

  describe("lectura", () => {
    it("sin sesión: none; con ítems de turnos anteriores: ready (en orden, sin los posteriores)", async () => {
      const contact = newContact();
      const early = await turn(contact);
      expect(await readState(early)).toEqual({ state: "none" });
      await finish(early);
      const t1 = await turn(contact);
      await begin(t1, "TEXT", resolved(1));
      await finish(t1);
      const closer = await turn(contact);
      const later = await turn(contact);
      await begin(later, "TEXT", resolved(2));
      const state = await readState(closer);
      expect(state.state).toBe("ready");
      expect(state.items.map((item: Json) => item.studyIds)).toEqual([[uuid(1)]]);
    });

    it("mientras un turno ANTERIOR del contacto sigue en proceso responde 'pending' (aunque aún no tenga ítem)", async () => {
      const contact = newContact();
      const t1 = await turn(contact);
      await begin(t1, "TEXT", resolved(1));
      const slow = await turn(contact, "IMAGE");
      const closer = await turn(contact);
      expect(await readState(closer)).toMatchObject({ state: "pending", pending: 2 });
      await finish(t1);
      expect(await readState(closer)).toMatchObject({ state: "pending", pending: 1 });
      await begin(slow, "IMAGE", null, createHash("sha256").update("lenta").digest("hex"));
      await finishItem(slow, resolved(2));
      await finish(slow);
      expect(await readState(closer)).toMatchObject({ state: "ready" });
    });

    it("un ítem EN PROCESO cuya corrida ya terminó (se perdió el análisis) se informa como ilegible, no como pendiente", async () => {
      const contact = newContact();
      const t1 = await turn(contact, "IMAGE");
      await begin(t1, "IMAGE", null, createHash("sha256").update("perdida").digest("hex"));
      await finish(t1);
      const closer = await turn(contact);
      const state = await readState(closer);
      expect(state.state).toBe("ready");
      expect(state.items[0].status).toBe("UNREADABLE");
    });

    it("el turno que ya cerró una sesión recibe 'replay' con el mismo resultado", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP });
      expect(await readState(closer)).toMatchObject({ state: "replay", outcome: "QUOTED", sessionId, totalBs: 10, lines: [{ studyId: uuid(1), priceBs: 10 }] });
    });
  });

  describe("cierre: solo se cotiza lo identificado", () => {
    it("QUOTED: guarda el resultado inmutable con la huella del catálogo y deja la sesión cerrada", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1, 2), resolved(2, 3)]);
      const closed = await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10.5), line(2, 20), line(3, 30.25)], total: 60.75, fp: FP });
      expect(closed).toMatchObject({ status: "closed", outcome: "QUOTED" });
      expect(await sessionRow(sessionId)).toMatchObject({ status: "QUOTED", closed_by_run: closer.id });
      expect(JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_results r where session_id = '${sessionId}'`))).toMatchObject({ total_bs: 60.75, catalog_fingerprint: FP, run_id: closer.id });
    });

    it.each([
      ["un estudio de más que ningún ítem identificó", [line(1, 10), line(2, 20), line(9, 5)], 35],
      ["un estudio de menos", [line(1, 10)], 10],
      ["un estudio repetido", [line(1, 10), line(1, 10), line(2, 20)], 40],
      ["un total que no suma", [line(1, 10), line(2, 20)], 31],
      ["un precio cero", [line(1, 0), line(2, 20)], 20],
      ["un precio negativo", [line(1, -5), line(2, 20)], 15],
      ["sin nombre", [{ studyId: uuid(1), name: "", priceBs: 10 }, line(2, 20)], 30],
      ["un nombre con caracteres de control", [{ studyId: uuid(1), name: "A\u0007B", priceBs: 10 }, line(2, 20)], 30]
    ])("rechaza cotizar %s (PT409) y la sesión sigue abierta", async (_name, lines, total) => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1, 2)]);
      expect(await db.fails(asService(closeSql(closer, sessionId, "QUOTED", { lines, total, fp: FP })))).toContain("PT409");
      expect((await sessionRow(sessionId)).status).toBe("OPEN");
      expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${sessionId}'`)).toBe("0");
    });

    it.each([
      ["un ítem ambiguo", [resolved(1), ambiguous(7, 8)]],
      ["un fragmento sin resolver", [resolved(1), unresolvedItem]],
      ["un resultado dudoso del motor", [resolved(1), uncertain]],
      ["una foto ilegible", [resolved(1), unreadable]]
    ])("rechaza cotizar con %s (PT409): no se cotiza antes de completar la solicitud", async (_name, results) => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, results);
      expect(await db.fails(asService(closeSql(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP })))).toContain("PT409");
      expect((await sessionRow(sessionId)).status).toBe("OPEN");
    });

    it("no cierra mientras haya un turno anterior en proceso ('pending') ni una foto aún analizándose", async () => {
      const contact = newContact();
      const t1 = await turn(contact);
      const b1 = await begin(t1, "TEXT", resolved(1));
      await finish(t1);
      const slow = await turn(contact, "IMAGE");
      await begin(slow, "IMAGE", null, createHash("sha256").update("analizando").digest("hex"));
      const closer = await turn(contact);
      expect(await closeIt(closer, b1.sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP })).toEqual({ status: "pending" });
      expect((await sessionRow(b1.sessionId)).status).toBe("OPEN");
    });

    it("NEEDS_REVIEW registra el caso en la cola (PENDING) con los motivos y los ítems, sin texto; exige una causa real", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1), ambiguous(7, 8)]);
      expect(await db.fails(asService(closeSql(closer, sessionId, "NEEDS_REVIEW", { reasons: null })))).toContain("PT422");
      expect(await closeIt(closer, sessionId, "NEEDS_REVIEW", { reasons: ["AMBIGUOUS_STUDY"] })).toMatchObject({ status: "closed", outcome: "NEEDS_REVIEW" });
      const review = JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_reviews r where session_id = '${sessionId}'`));
      expect(review).toMatchObject({ status: "PENDING", reasons: ["AMBIGUOUS_STUDY"], contact_key: contact, run_id: closer.id });
      expect(review.item_ids).toHaveLength(2);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${sessionId}'`)).toBe("0");

      const clean = await sessionWith(newContact(), [resolved(1)]);
      expect(await db.fails(asService(closeSql(clean.closer, clean.sessionId, "NEEDS_REVIEW", { reasons: ["AMBIGUOUS_STUDY"] })))).toContain("PT409");
      const unread = await sessionWith(newContact(), [unreadable]);
      expect(await db.fails(asService(closeSql(unread.closer, unread.sessionId, "NEEDS_REVIEW", { reasons: ["AMBIGUOUS_STUDY"] })))).toContain("PT409");
    });

    it("NEEDS_REVIEW por catálogo (estudio retirado o precio inválido) se acepta aunque todos los ítems estuvieran claros", async () => {
      const { sessionId, closer } = await sessionWith(newContact(), [resolved(1)]);
      expect(await closeIt(closer, sessionId, "NEEDS_REVIEW", { reasons: ["STUDY_UNAVAILABLE"] })).toMatchObject({ status: "closed" });
    });

    it("NEEDS_RESEND cierra la sesión, deja las fotos ilegibles atrás y traslada lo legible a una sesión NUEVA abierta; exige algo ilegible", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1), unreadable, resolved(2)]);
      const closed = await closeIt(closer, sessionId, "NEEDS_RESEND");
      expect(closed).toMatchObject({ status: "closed", outcome: "NEEDS_RESEND" });
      expect(closed.carriedTo).toBeTruthy();
      expect(await sessionRow(closed.carriedTo)).toMatchObject({ status: "OPEN" });
      expect((await items(closed.carriedTo)).map((item) => item.status)).toEqual(["RESOLVED", "RESOLVED"]);
      expect((await items(sessionId)).map((item) => item.status)).toEqual(["UNREADABLE"]);
      const clean = await sessionWith(newContact(), [resolved(1)]);
      expect(await db.fails(asService(closeSql(clean.closer, clean.sessionId, "NEEDS_RESEND")))).toContain("PT409");
    });

    it("tras reenviar, la solicitud trasladada se cotiza completa", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1), unreadable]);
      const closed = await closeIt(closer, sessionId, "NEEDS_RESEND");
      await finish(closer);
      const fresh = await turn(contact);
      await begin(fresh, "TEXT", resolved(2));
      await finish(fresh);
      const again = await turn(contact);
      const state = await readState(again);
      expect(state).toMatchObject({ state: "ready", sessionId: closed.carriedTo });
      expect(await closeIt(again, state.sessionId, "QUOTED", { lines: [line(1, 10), line(2, 20)], total: 30, fp: FP })).toMatchObject({ status: "closed", outcome: "QUOTED" });
    });

    it("CANCELLED cierra sin cotizar ni crear caso; lo que llegó DESPUÉS del turno que cierra pasa a una sesión nueva", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      const later = await turn(contact);
      await begin(later, "TEXT", resolved(5));
      const closed = await closeIt(closer, sessionId, "CANCELLED");
      expect(closed).toMatchObject({ status: "closed", outcome: "CANCELLED" });
      expect((await items(closed.carriedTo)).map((item) => item.study_ids)).toEqual([[uuid(5)]]);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_reviews where session_id = '${sessionId}'`)).toBe("0");
      expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${sessionId}'`)).toBe("0");
    });

    it("un ítem de un turno POSTERIOR no se cotiza con la sesión que cierra un turno anterior", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      const later = await turn(contact);
      await begin(later, "TEXT", resolved(2));
      await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP });
      const result = JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_results r where session_id = '${sessionId}'`));
      expect(result.lines.map((l: Json) => l.studyId)).toEqual([uuid(1)]);
    });

    it("cerrar es idempotente por corrida: repetirlo devuelve 'replayed' y no vuelve a decidir; otro turno sobre una sesión ya cerrada recibe 'not_open'", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP });
      expect(await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP })).toMatchObject({ status: "replayed", outcome: "QUOTED" });
      expect(await closeIt(closer, sessionId, "CANCELLED")).toMatchObject({ status: "replayed", outcome: "QUOTED" });
      const other = await turn(contact);
      expect(await closeIt(other, sessionId, "CANCELLED")).toEqual({ status: "not_open" });
      expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${sessionId}'`)).toBe("1");
    });

    it("la sesión de OTRO contacto no se puede cerrar", async () => {
      const mine = await sessionWith(newContact(), [resolved(1)]);
      const theirs = await sessionWith(newContact(), [resolved(2)]);
      expect(await closeIt(mine.closer, theirs.sessionId, "CANCELLED")).toEqual({ status: "not_open" });
      expect((await sessionRow(theirs.sessionId)).status).toBe("OPEN");
    });

    it("sin lease vigente no se cierra (PT410) y los argumentos inválidos se rechazan (PT422)", async () => {
      const { sessionId, closer } = await sessionWith(newContact(), [resolved(1)]);
      expect(await db.fails(asService(closeSql({ ...closer, fence: closer.fence + 1 }, sessionId, "CANCELLED")))).toContain("PT410");
      expect(await db.fails(asService(closeSql(closer, sessionId, "OTRO")))).toContain("PT422");
      expect(await db.fails(asService(closeSql(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: "no válido!" })))).toContain("PT422");
      expect(await db.fails(asService(closeSql(closer, sessionId, "NEEDS_REVIEW", { reasons: ["INVENTADO"] })))).toContain("PT422");
      expect((await sessionRow(sessionId)).status).toBe("OPEN");
    });

    it("concurrencia: dos turnos que intentan cerrar la misma sesión a la vez → exactamente uno la cierra", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      const second = await turn(contact);
      const results = await Promise.all([
        closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP }),
        closeIt(second, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP }).catch((error) => ({ status: `error:${String(error).slice(0, 40)}` }))
      ]);
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === "closed")).toHaveLength(1);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_results where session_id = '${sessionId}'`)).toBe("1");
    });

    it("concurrencia: ítems que llegan a la vez del mismo contacto quedan en UNA sesión, sin duplicar", async () => {
      const contact = newContact();
      const turns: Turn[] = [];
      for (let i = 0; i < 6; i++) turns.push(await turn(contact, "TEXT", i + 1));
      const results = await Promise.all(turns.map((t, i) => begin(t, "TEXT", resolved(i + 1))));
      expect(new Set(results.map((r) => r.sessionId)).size).toBe(1);
      expect(await items(results[0]!.sessionId)).toHaveLength(6);
      expect(await db.ok(`select count(*) from public.plusmedik_quote_sessions where contact_key = '${contact}' and status = 'OPEN'`)).toBe("1");
      await sleep(1);
    });
  });

  describe("flujo por texto (migración 14): el turno que cierra puede traer su propio ítem, y una ambigüedad aclarada se puede cotizar", () => {
    const own = async (contact: string, result: Json) => {
      const t = await turn(contact);
      const b = await begin(t, "TEXT", result);
      return { t, b };
    };
    const group = (...ids: number[][]): Json => ({ status: "AMBIGUOUS", studyIds: [], ambiguous: ids.map((g) => g.map(uuid)), unresolved: 0, reasons: ["AMBIGUOUS_STUDY"] });
    const rejects = async (t: Turn, sessionId: string, lines: unknown[], total: number) => expect(await db.fails(asService(closeSql(t, sessionId, "QUOTED", { lines, total, fp: FP })))).toMatch(/PT409/);

    it("un mensaje que trae sus estudios Y pide cotizar cierra en el mismo turno: la lectura incluye el ítem propio y la cotización debe incluirlo", async () => {
      const contact = newContact();
      const earlier = await turn(contact);
      const first = await begin(earlier, "TEXT", resolved(1));
      await finish(earlier);
      const { t } = await own(contact, resolved(2));
      const state = await readState(t);
      expect(state).toMatchObject({ state: "ready", sessionId: first.sessionId });
      expect(state.items.map((item: Json) => item.studyIds[0])).toEqual([uuid(1), uuid(2)]);
      // sin el ítem propio la base la rechaza: lo cotizado debe ser EXACTAMENTE lo identificado
      await rejects(t, first.sessionId, [line(1, 10)], 10);
      const closed = await closeIt(t, first.sessionId, "QUOTED", { lines: [line(1, 10), line(2, 20)], total: 30, fp: FP });
      expect(closed).toMatchObject({ status: "closed", outcome: "QUOTED" });
      expect((await sessionRow(first.sessionId)).status).toBe("QUOTED");
      expect(await items(first.sessionId)).toHaveLength(2);
    });

    it("una solicitud nueva con un solo mensaje se cotiza en ese mismo turno; repetir el cierre del turno es idempotente", async () => {
      const contact = newContact();
      const { t, b } = await own(contact, resolved(3));
      expect(await readState(t)).toMatchObject({ state: "ready", sessionId: b.sessionId });
      expect(await closeIt(t, b.sessionId, "QUOTED", { lines: [line(3, 7)], total: 7, fp: FP })).toMatchObject({ status: "closed" });
      expect(await closeIt(t, b.sessionId, "QUOTED", { lines: [line(3, 7)], total: 7, fp: FP })).toMatchObject({ status: "replayed" });
      expect(await readState(t)).toMatchObject({ state: "replay", outcome: "QUOTED" });
    });

    it("el turno que cierra sigue esperando a los turnos anteriores aún en proceso", async () => {
      const contact = newContact();
      const photo = await turn(contact, "IMAGE");
      await begin(photo, "IMAGE", null, "b".repeat(64));
      const { t, b } = await own(contact, resolved(1));
      expect(await readState(t)).toMatchObject({ state: "pending" });
      expect(await closeIt(t, b.sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP })).toMatchObject({ status: "pending" });
    });

    it("una ambigüedad ACLARADA por un mensaje de texto posterior se cotiza: aporta lo que había identificado y la opción elegida, y solo esa", async () => {
      const contact = newContact();
      const a = await turn(contact);
      const first = await begin(a, "TEXT", { status: "AMBIGUOUS", studyIds: [uuid(1)], ambiguous: [[uuid(7), uuid(8)]], unresolved: 0, reasons: ["AMBIGUOUS_STUDY"] });
      await finish(a);
      const answer = await turn(contact);
      await begin(answer, "TEXT", resolved(8));
      await finish(answer);
      const closer = await turn(contact);
      // la opción no elegida no puede colarse en la cotización
      await rejects(closer, first.sessionId, [line(1, 10), line(7, 21), line(8, 22)], 53);
      expect(await closeIt(closer, first.sessionId, "QUOTED", { lines: [line(1, 10), line(8, 22)], total: 32, fp: FP })).toMatchObject({ status: "closed" });
    });

    it("sin aclarar sigue bloqueando la cotización (PT409), pero sí puede ir a revisión", async () => {
      const { sessionId, closer } = await sessionWith(newContact(), [resolved(1), group([7, 8])]);
      await rejects(closer, sessionId, [line(1, 10)], 10);
      expect(await closeIt(closer, sessionId, "NEEDS_REVIEW", { reasons: ["AMBIGUOUS_STUDY"] })).toMatchObject({ status: "closed" });
    });

    it("solo aclara un mensaje de TEXTO POSTERIOR: ni uno anterior a la duda, ni una foto, ni una opción de otro grupo", async () => {
      // la respuesta llegó ANTES que la pregunta
      const before = await sessionWith(newContact(), [resolved(8), group([7, 8])]);
      await rejects(before.closer, before.sessionId, [line(8, 22)], 22);
      // la opción la trae una FOTO
      const contact = newContact();
      const t1 = await turn(contact);
      const b1 = await begin(t1, "TEXT", group([7, 8]));
      await finish(t1);
      const t2 = await turn(contact, "IMAGE");
      await begin(t2, "IMAGE", resolved(8), "c".repeat(64));
      await finish(t2);
      await rejects(await turn(contact), b1.sessionId, [line(8, 22)], 22);
      // dos grupos y solo se aclara uno
      const partial = await sessionWith(newContact(), [group([7, 8], [9, 10]), resolved(8)]);
      await rejects(partial.closer, partial.sessionId, [line(8, 22)], 22);
      // con los dos aclarados sí
      const both = await sessionWith(newContact(), [group([7, 8], [9, 10]), resolved(8), resolved(10)]);
      expect(await closeIt(both.closer, both.sessionId, "QUOTED", { lines: [line(8, 22), line(10, 5)], total: 27, fp: FP })).toMatchObject({ status: "closed" });
    });

    it("lo no identificado (sin resolver, incierto) y lo ilegible siguen bloqueando la cotización aunque haya respuestas posteriores", async () => {
      const a = await sessionWith(newContact(), [unresolvedItem, resolved(1)]);
      await rejects(a.closer, a.sessionId, [line(1, 10)], 10);
      const b = await sessionWith(newContact(), [uncertain, resolved(2)]);
      await rejects(b.closer, b.sessionId, [line(1, 10), line(2, 20)], 30);
    });

    it("al pedir reenviar fotos, el ítem legible del PROPIO turno también pasa a la solicitud nueva", async () => {
      const contact = newContact();
      const t1 = await turn(contact, "IMAGE");
      const b1 = await begin(t1, "IMAGE", unreadable, "d".repeat(64));
      await finish(t1);
      const { t } = await own(contact, resolved(3));
      expect(await closeIt(t, b1.sessionId, "NEEDS_RESEND")).toMatchObject({ status: "closed", outcome: "NEEDS_RESEND" });
      await finish(t);
      const carried = await readState(await turn(contact));
      expect(carried).toMatchObject({ state: "ready" });
      expect(carried.items.map((item: Json) => item.studyIds[0])).toEqual([uuid(3)]);
    });

    it("sin ítem propio (el «listo» de siempre) nada cambia: no ve ítems de turnos posteriores y lo posterior pasa a una sesión nueva", async () => {
      const contact = newContact();
      const { sessionId, closer } = await sessionWith(contact, [resolved(1)]);
      const later = await turn(contact);
      await begin(later, "TEXT", resolved(2));
      expect((await readState(closer)).items).toHaveLength(1);
      expect(await closeIt(closer, sessionId, "QUOTED", { lines: [line(1, 10)], total: 10, fp: FP })).toMatchObject({ status: "closed" });
      expect(await items(sessionId)).toHaveLength(1);
      await finish(closer);
      await finish(later);
      expect((await readState(await turn(contact))).items).toHaveLength(1);
    });
  });

  describe("la migración es aditiva", () => {
    const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
    const code = read(SESSIONS).replace(/--.*$/gm, "");

    it("es la undécima (la 12 son los datos por estudio, G4.1; la 14 es el flujo por texto, G5.9) y las diez anteriores no se modificaron (hash de la 10 fijado)", () => {
      expect(MIGRATIONS[10]).toBe(SESSIONS);
      expect(MIGRATIONS[13]).toBe(TEXT_FLOW);
      expect(MIGRATIONS).toHaveLength(25);
      expect(sha("20261029000000_plusmedik_reply_guard.sql")).toBe("689c71aa2de466a38cf93fdfeb853a90a8f4ac3bca232995df194014456aec3f");
    });

    it("solo crea las tablas y funciones esperadas: sin borrar, sin datos, sin SQL dinámico, sin lab_tests ni el esquema del CRM", () => {
      expect([...code.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])).toEqual(["plusmedik_quote_sessions", "plusmedik_quote_items", "plusmedik_quote_results", "plusmedik_quote_reviews"]);
      expect([...code.matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1])).toEqual([
        "plusmedik_quote_items_guard", "plusmedik_quote_sessions_guard", "plusmedik_quote_result_valid", "plusmedik_quote_reasons_of", "plusmedik_quote_ids_of", "plusmedik_quote_pending_before",
        "plusmedik_quote_item_begin", "plusmedik_quote_item_finish", "plusmedik_quote_session_read", "plusmedik_quote_session_close"
      ]);
      expect(code).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\btruncate\s+table\b|\bexecute\s+(format|'|\$)|\bcreate\s+extension\b|\blab_tests\b|\bcrm\b/i);
      expect([...code.matchAll(/alter\s+table\s+([\w.]+)\s+([a-z ]+);/gi)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
        "public.plusmedik_quote_sessions enable row level security", "public.plusmedik_quote_items enable row level security", "public.plusmedik_quote_results enable row level security", "public.plusmedik_quote_reviews enable row level security"
      ]);
      expect(code).not.toMatch(/\binsert\s+into\s+public\.(?!plusmedik_quote_)/i);
      expect(code).not.toMatch(/\bupdate\s+public\.(?!plusmedik_quote_)/i);
      expect(code.match(/security definer/gi)).toHaveLength(4);
    });

    it("la migración 14 solo agrega una función de apoyo y REEMPLAZA las de lectura y cierre: sin tablas, columnas ni datos, y conserva sus privilegios", () => {
      const flow = read(TEXT_FLOW).replace(/--.*$/gm, "");
      expect([...flow.matchAll(/create or replace function public\.(\w+)/gi)].map((m) => m[1])).toEqual(["plusmedik_quote_ambiguity_state", "plusmedik_quote_session_read", "plusmedik_quote_session_close"]);
      expect(flow).not.toMatch(/\bcreate\s+table\b|\balter\s+table\b|\bdrop\b|\bdelete\s+from\b|\btruncate\b|\bexecute\s+(format|'|\$)|\blab_tests\b|\bcrm\b/i);
      expect(flow).not.toMatch(/\binsert\s+into\s+public\.(?!plusmedik_quote_)/i);
      expect(flow.match(/security definer/gi)).toHaveLength(2);
      expect(flow).toMatch(/grant execute on function public\.plusmedik_quote_session_read\(uuid, text, bigint\) to service_role;/);
      expect(flow).toMatch(/grant execute on function public\.plusmedik_quote_session_close\(uuid, text, bigint, uuid, text, jsonb, numeric, text\[\], text\) to service_role;/);
    });
  });
});
