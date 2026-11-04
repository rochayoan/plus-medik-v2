import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 13 (cola de salida hacia el CRM) contra un PostgreSQL REAL y efímero: encolado idempotente y anclado al mensaje, reclamo con arrendamiento (sin dobles envíos concurrentes), reintentos
// acotados con retroceso, rechazos permanentes, vencimiento y recuperación, y privacidad. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[crm-outbox-db] PostgreSQL no disponible: se omiten las pruebas de la cola de salida contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const OUTBOX = "20261101000000_plusmedik_crm_outbox.sql";
type Json = Record<string, any>;
const read = (name: string) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n");
const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;
const sender = (n: number) => `sender-${String(n).padStart(8, "0")}`;
const CIPHER = "v1.aXZpdmk.dGFndGFn.Y2lwaGVydGV4dA";
const HASH = "d".repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!bin)("cola de salida hacia el CRM contra PostgreSQL real (migración 13)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("crm_outbox");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const q = (value: unknown) => `$q$${typeof value === "string" ? value : JSON.stringify(value)}$q$`;
  const call = async (sql: string): Promise<Json> => JSON.parse((await db.ok(asService(sql))).split("\n")[0]!);
  const fails = (sql: string) => db.fails(asService(sql));
  const newContact = () => (++counter).toString(16).padStart(64, "0");
  interface Turn { message: string; id: string; who: string; fence: number; contact: string }
  async function turn(contact: string, who = 1, media: string | null = null): Promise<Turn> {
    const message = `wamid.outbox-${++counter}-${Date.now()}`;
    const claimed = await call(`select public.plusmedik_turn_claim('${message}', ${media ? q(media) : "null"}, '${owner(who)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', 'TEXT');`);
    return { message, id: await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`), who: owner(who), fence: claimed.fence as number, contact };
  }
  const enqueueSql = (t: Turn, over: Json = {}) => {
    const a = { origin: t.id, kind: "CONVERSATION", message: t.message, reasons: ["HUMAN_REQUEST"], cipher: CIPHER, hash: HASH, evidence: { schema: 1 }, session: null, ttl: 604800, max: 8, ...over };
    return `select public.plusmedik_crm_outbox_enqueue('${t.id}'::uuid, '${t.who}', ${t.fence}, '${a.origin}'::uuid, ${q(a.kind)}, ${q(a.message)}, array[${a.reasons.map((r: string) => q(r)).join(",")}]::text[], ${q(a.cipher)}, ${q(a.hash)}, ${q(a.evidence)}::jsonb, ${a.session ? `'${a.session}'::uuid` : "null"}, ${a.ttl}, ${a.max});`;
  };
  const enqueue = (t: Turn, over: Json = {}) => call(enqueueSql(t, over));
  const claim = (who: number, over: { limit?: number; lease?: number; id?: string; force?: boolean } = {}) =>
    call(`select public.plusmedik_crm_outbox_claim('${sender(who)}', ${over.lease ?? 60}, ${over.limit ?? 10}, ${over.id ? `'${over.id}'::uuid` : "null"}, ${over.force ?? false});`);
  const record = (id: string, who: number, fence: number, result: string, http: number | null = 200) =>
    call(`select public.plusmedik_crm_outbox_record('${id}'::uuid, '${sender(who)}', ${fence}, ${http === null ? "null" : http}, '${result}', 120);`);
  const row = async (id: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(o) from public.plusmedik_crm_outbox o where id = '${id}'`));
  const attempts = async (id: string): Promise<Json[]> => JSON.parse(await db.ok(`select coalesce(json_agg(a order by a.at, a.id), '[]') from public.plusmedik_crm_outbox_attempts a where outbox_id = '${id}'`));
  const makeDue = (id: string) => db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set next_attempt_at = now() - interval '1 second' where id = '${id}';`);
  // Un evento nuevo, encolado y listo.
  async function queued(over: Json = {}) {
    const t = await turn(newContact());
    const e = await enqueue(t, over);
    return { t, e, id: e.outboxId as string };
  }

  describe("esquema, privilegios e inmutabilidad", () => {
    it("la migración se puede volver a aplicar sin error y sin tocar datos", async () => {
      const { id } = await queued();
      await db.applyFile(join(dir, OUTBOX));
      expect((await row(id)).status).toBe("PENDING");
    });

    it("RLS activo; service_role NO puede leer el cuerpo cifrado ni el arrendamiento con SELECT directo, ni escribir; nadie más tiene acceso", async () => {
      for (const table of ["plusmedik_crm_outbox", "plusmedik_crm_outbox_attempts"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        for (const privilege of ["insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', '${privilege}')`)).toBe("f");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', 'select')`)).toBe("f");
      }
      for (const column of ["payload_cipher", "lease_owner", "lease_fence"]) expect(await db.ok(`select has_column_privilege('service_role', 'public.plusmedik_crm_outbox', '${column}', 'select')`), column).toBe("f");
      for (const column of ["event_id", "status", "payload_hash", "reason_codes", "attempts"]) expect(await db.ok(`select has_column_privilege('service_role', 'public.plusmedik_crm_outbox', '${column}', 'select')`), column).toBe("t");
      expect(await db.fails(asService(`select payload_cipher from public.plusmedik_crm_outbox limit 1`))).toMatch(/permission denied/);
    });

    it("las funciones públicas son SECURITY DEFINER con search_path vacío; solo service_role las ejecuta", async () => {
      for (const signature of [
        "plusmedik_crm_outbox_enqueue(uuid, text, bigint, uuid, text, text, text[], text, text, jsonb, uuid, integer, integer)", "plusmedik_crm_outbox_purge()", "plusmedik_crm_outbox_claim(text, integer, integer, uuid, boolean)",
        "plusmedik_crm_outbox_record(uuid, text, bigint, integer, text, integer)", "plusmedik_crm_outbox_status(text[])", "plusmedik_crm_outbox_stats()", "plusmedik_crm_outbox_list(text, integer)",
        "plusmedik_crm_outbox_requeue(uuid, text)", "plusmedik_quote_review_targets(uuid, text, bigint, uuid)"
      ]) {
        expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toBe("t");
        expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toContain("search_path=");
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`), signature).toBe("t");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`), signature).toBe("f");
      }
    });

    it("nada se borra ni se vacía; la identidad, los motivos, la evidencia y el cuerpo no cambian; un evento enviado es inmutable; la bitácora es inmutable", async () => {
      const { id } = await queued();
      expect(await db.fails(`delete from public.plusmedik_crm_outbox where id = '${id}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_crm_outbox`)).toMatch(/PT409|immutable|cannot truncate/);
      for (const change of ["event_id = 'plusmedik-review:" + uuid(9) + "'", "reason_codes = array['MEDICAL_QUERY']", "payload_hash = '" + "e".repeat(64) + "'", "evidence = '{}'::jsonb", "expires_at = now() + interval '1 year'", "payload_cipher = 'v1.a.b.c'"]) {
        expect(await db.fails(`update public.plusmedik_crm_outbox set ${change} where id = '${id}'`), change).toMatch(/PT409|immutable|cannot change/);
      }
      const c = await claim(1, { id, force: true });
      await record(id, 1, c.claimed[0].fence, "CREATED");
      expect(await db.fails(`update public.plusmedik_crm_outbox set last_http_status = 500 where id = '${id}'`)).toMatch(/PT409|sent event is immutable/);
      expect(await db.fails(`update public.plusmedik_crm_outbox_attempts set result = 'IGNORED'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_crm_outbox_attempts`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_crm_outbox_attempts`)).toMatch(/PT409|immutable|cannot truncate/);
    });
  });

  describe("encolar: idempotente, anclado al mensaje y con lease", () => {
    it("crea el evento 'plusmedik-review:<corrida>' y repetirlo (turno repetido, ejecución que reclama el lease) devuelve el MISMO evento sin duplicar", async () => {
      const t = await turn(newContact());
      const first = await enqueue(t);
      expect(first).toMatchObject({ status: "created", state: "PENDING", eventId: `plusmedik-review:${t.id}` });
      const again = await enqueue(t);
      expect(again).toMatchObject({ status: "exists", outboxId: first.outboxId, state: "PENDING" });
      // con otro motivo o cuerpo, el evento ya existente NO se pisa
      const other = await enqueue(t, { reasons: ["MEDICAL_QUERY"], cipher: "v1.zz.zz.zz", hash: "f".repeat(64) });
      expect(other.status).toBe("exists");
      expect((await row(first.outboxId)).reason_codes).toEqual(["HUMAN_REQUEST"]);
      expect(await db.ok(`select count(*) from public.plusmedik_crm_outbox where contact_key = '${t.contact}'`)).toBe("1");
    });

    it("la base verifica el ancla: un mensaje que no es el de la corrida, o una corrida de OTRO contacto, se rechazan (PT409) y no queda nada", async () => {
      const mine = await turn(newContact());
      const theirs = await turn(newContact(), 2);
      expect(await fails(enqueueSql(mine, { message: "wamid.inventado-1" }))).toContain("PT409");
      expect(await fails(enqueueSql(mine, { origin: theirs.id, message: theirs.message }))).toContain("PT409");
      expect(await fails(enqueueSql(mine, { origin: uuid(404) }))).toContain("PT409");
      expect(await db.ok(`select count(*) from public.plusmedik_crm_outbox where contact_key in ('${mine.contact}', '${theirs.contact}')`)).toBe("0");
    });

    it("un mensaje anterior del MISMO contacto sí puede ser el ancla (un caso por mensaje de una solicitud)", async () => {
      const contact = newContact();
      const first = await turn(contact);
      const closing = await turn(contact);
      const result = await call(enqueueSql(closing, { origin: first.id, message: first.message, kind: "REVIEW_CASE", reasons: ["AMBIGUOUS_STUDY"] }));
      expect(result).toMatchObject({ status: "created", eventId: `plusmedik-review:${first.id}` });
    });

    it.each([
      ["tipo desconocido", { kind: "OTRO" }], ["motivo desconocido", { reasons: ["QUIERO_PRECIOS"] }], ["sin motivos", { reasons: [] }], ["más de 4 motivos", { reasons: ["HUMAN_REQUEST", "MEDICAL_QUERY", "NO_APPROVED_ANSWER", "AMBIGUOUS_STUDY", "UNRESOLVED_TEXT"] }],
      ["cuerpo que no está cifrado", { cipher: "{\"contactPhone\":\"59170000000\"}" }], ["cuerpo vacío", { cipher: "v1..." }], ["hash corto", { hash: "abc" }], ["ttl menor que una hora", { ttl: 60 }], ["ttl mayor que 30 días", { ttl: 3_000_000 }],
      ["intentos 0", { max: 0 }], ["intentos 21", { max: 21 }], ["mensaje con espacios", { message: "mensaje con espacios" }]
    ])("rechaza %s (PT422) sin encolar", async (_name, over) => {
      const t = await turn(newContact());
      expect(await fails(enqueueSql(t, over))).toContain("PT422");
      expect(await db.ok(`select count(*) from public.plusmedik_crm_outbox where contact_key = '${t.contact}'`)).toBe("0");
    });

    it("exige el lease vigente: otra generación u otro propietario no encola (PT410), y un turno inexistente es PT404", async () => {
      const t = await turn(newContact());
      expect(await fails(enqueueSql({ ...t, fence: t.fence + 1 }))).toContain("PT410");
      expect(await fails(enqueueSql({ ...t, who: owner(9) }))).toContain("PT410");
      expect(await fails(enqueueSql({ ...t, id: uuid(777) }))).toContain("PT404");
      expect(await db.ok(`select count(*) from public.plusmedik_crm_outbox where contact_key = '${t.contact}'`)).toBe("0");
    });
  });

  describe("reclamar y enviar: un solo envío en vuelo por evento", () => {
    it("reclama lo listo con arrendamiento y generación; cada reclamo cuenta un intento; lo no vencido y lo en vuelo no se reclaman", async () => {
      const { id } = await queued();
      const first = await claim(1, { limit: 50 });
      const mine = first.claimed.find((c: Json) => c.outboxId === id);
      expect(mine).toMatchObject({ attempt: 1, fence: 1 });
      expect(mine.cipher).toBe(CIPHER);
      expect(mine.eventId).toMatch(/^plusmedik-review:/);
      expect((await row(id)).status).toBe("IN_FLIGHT");
      expect((await claim(2, { limit: 50 })).claimed.some((c: Json) => c.outboxId === id)).toBe(false);
      await record(id, 1, 1, "UNAVAILABLE", 503);
      expect((await claim(2, { limit: 50 })).claimed.some((c: Json) => c.outboxId === id)).toBe(false);
    });

    it("dos procesos que reclaman a la vez reciben conjuntos DISTINTOS (nadie envía el mismo evento a la vez)", async () => {
      for (let i = 0; i < 6; i++) await queued();
      const [a, b] = await Promise.all([claim(1, { limit: 50 }), claim(2, { limit: 50 })]);
      const idsA = a.claimed.map((c: Json) => c.outboxId);
      const idsB = b.claimed.map((c: Json) => c.outboxId);
      expect(idsA.filter((id: string) => idsB.includes(id))).toEqual([]);
      expect(idsA.length + idsB.length).toBeGreaterThanOrEqual(6);
    });

    it("el reclamo forzado de un evento concreto ignora la hora (primer intento en línea), pero no a un evento ya en vuelo ni a uno entregado", async () => {
      const { id } = await queued();
      await record(id, 1, (await claim(1, { id, force: true })).claimed[0].fence, "TIMEOUT", null);
      expect(new Date((await row(id)).next_attempt_at).getTime()).toBeGreaterThan(Date.now());
      expect((await claim(2, { id })).claimed).toEqual([]);
      const forced = await claim(2, { id, force: true });
      expect(forced.claimed).toHaveLength(1);
      expect((await claim(3, { id, force: true })).claimed).toEqual([]);
    });

    it("si quien envía muere, el arrendamiento vence y otro retoma el evento con una generación nueva; el resultado tardío del primero se rechaza (PT410)", async () => {
      const { id } = await queued();
      const first = (await claim(1, { id, force: true, lease: 5 })).claimed[0];
      await db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set lease_expires_at = now() - interval '1 second' where id = '${id}';`);
      const second = (await claim(2, { id })).claimed[0];
      expect(second).toMatchObject({ attempt: 2, fence: first.fence + 1 });
      expect(await fails(`select public.plusmedik_crm_outbox_record('${id}'::uuid, '${sender(1)}', ${first.fence}, 200, 'CREATED', 10);`)).toContain("PT410");
      expect(await record(id, 2, second.fence, "CREATED")).toMatchObject({ status: "sent" });
    });

    it("el MISMO emisor que retoma el evento recibe una generación nueva: su resultado con la generación anterior se rechaza (PT410) y no cambia nada", async () => {
      const { id } = await queued();
      const first = (await claim(1, { id, force: true, lease: 5 })).claimed[0];
      await db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set lease_expires_at = now() - interval '1 second' where id = '${id}';`);
      const second = (await claim(1, { id })).claimed[0];
      expect(second.fence).toBe(first.fence + 1);
      expect(await fails(`select public.plusmedik_crm_outbox_record('${id}'::uuid, '${sender(1)}', ${first.fence}, 200, 'CREATED', 10);`)).toContain("PT410");
      expect(await db.ok(`select status from public.plusmedik_crm_outbox where id = '${id}'`)).toBe("IN_FLIGHT");
      expect(await record(id, 1, second.fence, "CREATED")).toMatchObject({ status: "sent" });
    });
  });

  describe("resultados, reintentos acotados y rechazos", () => {
    it.each([["CREATED"], ["DUPLICATE"]])("%s: el evento queda SENT, el cuerpo se BORRA y se conserva la evidencia (hash, motivos, estado HTTP)", async (result) => {
      const { id } = await queued();
      const c = (await claim(1, { id, force: true })).claimed[0];
      expect(await record(id, 1, c.fence, result)).toEqual({ status: "sent", delivery: result });
      const done = await row(id);
      expect(done).toMatchObject({ status: "SENT", delivery: result, payload_cipher: null, payload_hash: HASH, last_result: result, last_http_status: 200 });
      expect(done.sent_at).toBeTruthy();
      expect(await record(id, 1, c.fence, "CREATED")).toEqual({ status: "already_sent" });
      expect(await attempts(id)).toHaveLength(1);
    });

    it("409 message_not_ingested y los fallos transitorios se reintentan con retroceso exponencial (30 s, 2 min, 10 min...) sin perder el cuerpo", async () => {
      const { id } = await queued();
      const expected = [30, 120, 600, 1800];
      for (const [index, after] of expected.entries()) {
        const c = (await claim(1, { id, force: true })).claimed[0];
        expect(c.attempt).toBe(index + 1);
        expect(await record(id, 1, c.fence, index % 2 === 0 ? "MESSAGE_NOT_INGESTED" : "TIMEOUT", index % 2 === 0 ? 409 : null)).toEqual({ status: "retry", afterSeconds: after });
      }
      const state = await row(id);
      expect(state).toMatchObject({ status: "PENDING", attempts: 4, payload_cipher: null === null ? state.payload_cipher : null });
      expect(await db.ok(`select payload_cipher is not null from public.plusmedik_crm_outbox where id = '${id}'`)).toBe("t");
    });

    it("un token rechazado (401) no se reintenta cada medio minuto: espera al menos 30 minutos", async () => {
      const { id } = await queued();
      const c = (await claim(1, { id, force: true })).claimed[0];
      expect(await record(id, 1, c.fence, "UNAUTHORIZED", 401)).toEqual({ status: "retry", afterSeconds: 1800 });
    });

    it.each([["INVALID", 400, "REJECTED_INVALID"], ["TOO_LARGE", 413, "REJECTED_TOO_LARGE"], ["IGNORED", 200, "REJECTED_IGNORED"]])(
      "%s es un rechazo PERMANENTE: pasa a DEAD de inmediato (a la vista) conservando el cuerpo para poder reencolarlo tras corregir la causa", async (result, http, reason) => {
        const { id } = await queued();
        const c = (await claim(1, { id, force: true })).claimed[0];
        expect(await record(id, 1, c.fence, result, http)).toEqual({ status: "dead", reason });
        expect(await row(id)).toMatchObject({ status: "DEAD", dead_reason: reason });
        expect(await db.ok(`select payload_cipher is not null from public.plusmedik_crm_outbox where id = '${id}'`)).toBe("t");
      }
    );

    it("los reintentos están ACOTADOS: al llegar al máximo el evento pasa a DEAD (EXHAUSTED) y deja de reclamarse", async () => {
      const { id } = await queued({ max: 3 });
      for (let i = 0; i < 3; i++) {
        const c = (await claim(1, { id, force: true })).claimed[0];
        const outcome = await record(id, 1, c.fence, "SERVER_ERROR", 500);
        expect(outcome.status).toBe(i < 2 ? "retry" : "dead");
      }
      expect(await row(id)).toMatchObject({ status: "DEAD", dead_reason: "EXHAUSTED", attempts: 3 });
      expect((await claim(1, { id, force: true })).claimed).toEqual([]);
    });

    it("un envío en vuelo cuyo arrendamiento venció habiendo agotado los intentos pasa a DEAD al siguiente reclamo (nunca queda en vuelo para siempre)", async () => {
      const { id } = await queued({ max: 1 });
      await claim(1, { id, force: true });
      await db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set lease_expires_at = now() - interval '1 second' where id = '${id}';`);
      await claim(2, { limit: 50 });
      expect(await row(id)).toMatchObject({ status: "DEAD", dead_reason: "EXHAUSTED" });
    });

    it("la bitácora guarda solo estado HTTP y código de resultado por intento; argumentos inválidos se rechazan (PT422)", async () => {
      const { id } = await queued();
      const c = (await claim(1, { id, force: true })).claimed[0];
      expect(await fails(`select public.plusmedik_crm_outbox_record('${id}'::uuid, '${sender(1)}', ${c.fence}, 200, 'TODO_BIEN', 10);`)).toContain("PT422");
      expect(await fails(`select public.plusmedik_crm_outbox_record('${id}'::uuid, '${sender(1)}', ${c.fence}, 99, 'CREATED', 10);`)).toContain("PT422");
      await record(id, 1, c.fence, "MESSAGE_NOT_INGESTED", 409);
      expect(await attempts(id)).toEqual([expect.objectContaining({ attempt_no: 1, http_status: 409, result: "MESSAGE_NOT_INGESTED", duration_ms: 120 })]);
      expect(Object.keys((await attempts(id))[0]!).sort()).toEqual(["at", "attempt_no", "duration_ms", "http_status", "id", "outbox_id", "result"]);
    });
  });

  describe("vencimiento, consulta y recuperación manual", () => {
    it("lo vencido sin entregar pasa a DEAD (EXPIRED) y su cuerpo se borra; lo entregado no cambia", async () => {
      const { id } = await queued();
      const { id: sentId } = await queued();
      await record(sentId, 1, (await claim(1, { id: sentId, force: true })).claimed[0].fence, "CREATED");
      await db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set expires_at = now() - interval '1 second' where id in ('${id}', '${sentId}');`);
      expect((await call(`select public.plusmedik_crm_outbox_purge();`)).purged).toBeGreaterThanOrEqual(1);
      expect(await row(id)).toMatchObject({ status: "DEAD", dead_reason: "EXPIRED", payload_cipher: null });
      expect((await row(sentId)).status).toBe("SENT");
      expect((await claim(1, { id, force: true })).claimed).toEqual([]);
    });

    it("el estado por evento solo devuelve códigos; valida sus argumentos", async () => {
      const { e } = await queued();
      const status = await call(`select public.plusmedik_crm_outbox_status(array[${q(e.eventId)}]);`);
      expect(status.events).toEqual([{ eventId: e.eventId, state: "PENDING", delivery: null, attempts: 0, lastResult: null }]);
      expect(await fails(`select public.plusmedik_crm_outbox_status(array['no-es-un-evento']);`)).toContain("PT422");
      expect(await fails(`select public.plusmedik_crm_outbox_status(array[]::text[]);`)).toContain("PT422");
    });

    it("estadísticas y listado para vigilar la cola: conteos por estado, el pendiente más viejo y los muertos por motivo; el listado nunca trae el cuerpo", async () => {
      const { id } = await queued();
      const c = (await claim(1, { id, force: true })).claimed[0];
      await record(id, 1, c.fence, "INVALID", 400);
      const stats = await call(`select public.plusmedik_crm_outbox_stats();`);
      expect(stats.counts.DEAD).toBeGreaterThanOrEqual(1);
      expect(stats.deadByReason.REJECTED_INVALID).toBeGreaterThanOrEqual(1);
      expect(stats.oldestPendingSeconds === null || stats.oldestPendingSeconds >= 0).toBe(true);
      const list = await call(`select public.plusmedik_crm_outbox_list('DEAD', 500);`);
      const item = list.items.find((entry: Json) => entry.outboxId === id);
      expect(item).toMatchObject({ status: "DEAD", deadReason: "REJECTED_INVALID", canRequeue: true, lastHttpStatus: 400 });
      expect(JSON.stringify(list)).not.toContain(CIPHER);
      expect(await fails(`select public.plusmedik_crm_outbox_list('OTRO', 10);`)).toContain("PT422");
    });

    it("recuperación manual: un DEAD con cuerpo vuelve a la cola (intentos en cero) y queda constancia; uno vencido o no muerto no", async () => {
      const { id } = await queued();
      await record(id, 1, (await claim(1, { id, force: true })).claimed[0].fence, "INVALID", 400);
      expect(await call(`select public.plusmedik_crm_outbox_requeue('${id}'::uuid, 'operator:laura');`)).toEqual({ status: "requeued" });
      expect(await row(id)).toMatchObject({ status: "PENDING", attempts: 0, dead_reason: null });
      expect((await attempts(id)).at(-1)).toMatchObject({ result: "REQUEUED", attempt_no: 0 });
      expect(await call(`select public.plusmedik_crm_outbox_requeue('${id}'::uuid, 'operator:laura');`)).toEqual({ status: "not_dead", state: "PENDING" });
      const c = (await claim(1, { id, force: true })).claimed[0];
      expect(c.attempt).toBe(1);
      await record(id, 1, c.fence, "CREATED");
      expect(await call(`select public.plusmedik_crm_outbox_requeue('${id}'::uuid, 'operator:laura');`)).toEqual({ status: "not_dead", state: "SENT" });
      const expired = await queued();
      await record(expired.id, 1, (await claim(1, { id: expired.id, force: true })).claimed[0].fence, "INVALID", 400);
      await db.ok(`set session_replication_role = replica; update public.plusmedik_crm_outbox set expires_at = now() - interval '1 second' where id = '${expired.id}';`);
      expect(await call(`select public.plusmedik_crm_outbox_requeue('${expired.id}'::uuid, 'operator:laura');`)).toEqual({ status: "expired" });
      expect(await fails(`select public.plusmedik_crm_outbox_requeue('${id}'::uuid, 'Laura Pérez (laura@correo.com)');`)).toContain("PT422");
      expect(await fails(`select public.plusmedik_crm_outbox_requeue('${uuid(404)}'::uuid, 'operator:laura');`)).toContain("PT404");
    });
  });

  describe("casos de una solicitud en revisión (G4.0)", () => {
    const item = (studies: number[], over: Json = {}): Json => ({ status: "RESOLVED", studyIds: studies.map(uuid), ambiguous: [], unresolved: 0, reasons: [], ...over });
    async function reviewSession() {
      const contact = newContact();
      const textTurn = await turn(contact, 1);
      const imageTurn = await turn(contact, 2, "media-7");
      const begin = (t: Turn, kind: string, result: Json | null, hash: string | null = null) =>
        call(`select public.plusmedik_quote_item_begin('${t.id}'::uuid, '${t.who}', ${t.fence}, '${kind}', ${hash ? q(hash) : "null"}, ${result ? `${q(result)}::jsonb` : "null::jsonb"}, 1800, 20);`);
      const finish = (t: Turn) => db.ok(asService(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`));
      const a = await begin(textTurn, "TEXT", { status: "AMBIGUOUS", studyIds: [], ambiguous: [[uuid(7), uuid(8)]], unresolved: 0, reasons: ["AMBIGUOUS_STUDY"] });
      await begin(imageTurn, "IMAGE", { status: "UNCERTAIN", studyIds: [uuid(1)], ambiguous: [], unresolved: 0, reasons: ["ENGINE_PARTIAL"] }, "c".repeat(64));
      await finish(textTurn);
      await finish(imageTurn);
      const okTurn = await turn(contact, 3);
      await begin(okTurn, "TEXT", item([2]));
      await finish(okTurn);
      const closer = await turn(contact, 4);
      return { contact, sessionId: a.sessionId as string, textTurn, imageTurn, closer };
    }
    const close = (c: Turn, sessionId: string, reasons: string[]) =>
      call(`select public.plusmedik_quote_session_close('${c.id}'::uuid, '${c.who}', ${c.fence}, '${sessionId}'::uuid, 'NEEDS_REVIEW', null, null, array[${reasons.map((r) => q(r)).join(",")}]::text[], null);`);
    const targets = (c: Turn, sessionId: string) => call(`select public.plusmedik_quote_review_targets('${c.id}'::uuid, '${c.who}', ${c.fence}, '${sessionId}'::uuid);`);

    it("devuelve, por mensaje dudoso, el mensaje y el adjunto ORIGINALES (para el ancla de cada caso); no incluye los mensajes claros; incluye el mensaje de cierre y los motivos de toda la solicitud", async () => {
      const { sessionId, textTurn, imageTurn, closer } = await reviewSession();
      await close(closer, sessionId, ["AMBIGUOUS_STUDY", "ENGINE_PARTIAL", "STUDY_UNAVAILABLE"]);
      const result = await targets(closer, sessionId);
      expect(result).toMatchObject({ found: true, closing: { runId: closer.id, kapsoMessageId: closer.message }, sessionReasons: expect.arrayContaining(["STUDY_UNAVAILABLE"]) });
      expect(result.items).toHaveLength(2);
      const text = result.items.find((entry: Json) => entry.runId === textTurn.id);
      const image = result.items.find((entry: Json) => entry.runId === imageTurn.id);
      expect(text).toMatchObject({ kapsoMessageId: textTurn.message, mediaId: null, kind: "TEXT", status: "AMBIGUOUS", ambiguous: [[uuid(7), uuid(8)]] });
      expect(image).toMatchObject({ kapsoMessageId: imageTurn.message, mediaId: "media-7", kind: "IMAGE", status: "UNCERTAIN", studyIds: [uuid(1)] });
    });

    it("solo para la corrida que cerró la sesión con NEEDS_REVIEW: otra corrida, otra sesión, una sesión abierta o sin lease → nada / PT410", async () => {
      const { sessionId, closer, contact } = await reviewSession();
      expect(await targets(closer, sessionId)).toEqual({ found: false });
      await close(closer, sessionId, ["AMBIGUOUS_STUDY"]);
      const other = await turn(contact, 5);
      expect(await targets(other, sessionId)).toEqual({ found: false });
      expect(await targets(closer, uuid(555))).toEqual({ found: false });
      expect(await fails(`select public.plusmedik_quote_review_targets('${closer.id}'::uuid, '${closer.who}', ${closer.fence + 1}, '${sessionId}'::uuid);`)).toContain("PT410");
    });

    it("de punta a punta en la base: cada mensaje dudoso se encola anclado a SU corrida y los eventos son distintos", async () => {
      const { sessionId, textTurn, imageTurn, closer } = await reviewSession();
      await close(closer, sessionId, ["AMBIGUOUS_STUDY", "ENGINE_PARTIAL"]);
      const found = await targets(closer, sessionId);
      const ids: string[] = [];
      for (const target of found.items) {
        const result = await call(enqueueSql(closer, { origin: target.runId, message: target.kapsoMessageId, kind: "REVIEW_CASE", reasons: ["AMBIGUOUS_STUDY"], session: sessionId }));
        expect(result.status).toBe("created");
        ids.push(result.eventId);
      }
      expect(new Set(ids)).toEqual(new Set([`plusmedik-review:${textTurn.id}`, `plusmedik-review:${imageTurn.id}`]));
      expect(await fails(enqueueSql(closer, { origin: textTurn.id, message: imageTurn.message, session: sessionId }))).toContain("PT409");
      expect(await fails(enqueueSql(closer, { origin: closer.id, message: closer.message, session: uuid(555) }))).toContain("PT409");
    });
  });

  describe("privacidad y aditividad", () => {
    it("ninguna tabla de la cola guarda texto del paciente ni teléfonos: solo el cuerpo CIFRADO (no legible por service_role), códigos, ids y contadores", async () => {
      const columns = (await db.ok(`select table_name || '.' || column_name from information_schema.columns where table_schema = 'public' and table_name in ('plusmedik_crm_outbox', 'plusmedik_crm_outbox_attempts') order by 1`)).split(/\r?\n/);
      expect(columns.filter((c) => /phone|telefono|text|body|name|message_text|contact_phone/i.test(c))).toEqual([]);
      const { id } = await queued({ evidence: { schema: 1, reasonCodes: ["HUMAN_REQUEST"] } });
      expect(JSON.stringify(await call(`select public.plusmedik_crm_outbox_list(null, 500);`))).not.toMatch(/59170|v1\./);
      expect((await row(id)).payload_cipher).toBeDefined(); // el propietario de la base (no service_role) sí lo ve: es el texto opaco cifrado
    });

    const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
    const code = read(OUTBOX).replace(/--.*$/gm, "");

    it("es la trece (la 14, G5.9, solo reemplaza dos funciones de la 11) y las doce anteriores no se modificaron (hash de la 12 fijado)", () => {
      expect(MIGRATIONS[12]).toBe(OUTBOX);
      expect(MIGRATIONS).toHaveLength(21);
      expect(sha("20261031000000_plusmedik_study_facts.sql")).toBe("0958eb09426a1b56305f0988c97c21163ea44dd71108bb66e48d52fc6aae8391");
    });

    it("solo crea lo esperado: sin borrar, sin SQL dinámico, sin tocar lab_tests, el CRM ni tablas anteriores (solo las lee)", () => {
      expect([...code.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])).toEqual(["plusmedik_crm_outbox", "plusmedik_crm_outbox_attempts"]);
      expect(code).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\btruncate\s+table\b|\bexecute\s+(format|'|\$)|\bcreate\s+extension\b|\blab_tests\b|\bcrm\.\w+/i);
      expect(code).not.toMatch(/\binsert\s+into\s+public\.(?!plusmedik_crm_outbox)/i);
      expect(code).not.toMatch(/\bupdate\s+public\.(?!plusmedik_crm_outbox\b)/i);
      expect([...code.matchAll(/alter\s+table\s+([\w.]+)\s+([a-z ]+);/gi)].map((m) => `${m[1]} ${m[2]}`)).toEqual(["public.plusmedik_crm_outbox enable row level security", "public.plusmedik_crm_outbox_attempts enable row level security"]);
      expect(code.match(/security definer/gi)!.length).toBe(9);
    });
  });
});
