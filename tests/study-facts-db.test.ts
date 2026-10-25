import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Migración 12 (datos aprobados por estudio) contra un PostgreSQL REAL y efímero: gobierno (roles, cuatro ojos, la IA no aprueba), validación del contenido, versiones, revisión,
// trazabilidad, impacto y la lectura de la última cotización. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[study-facts-db] PostgreSQL no disponible: se omiten las pruebas de datos por estudio contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const FACTS = "20261031000000_plusmedik_study_facts.sql";
type Json = Record<string, any>;
const read = (name: string) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = (n: number) => `owner-${String(n).padStart(8, "0")}`;

type Actor = { id: string; type: "HUMAN" | "AI"; role: string };
const ED: Actor = { id: "crm:editor-1", type: "HUMAN", role: "EDITOR" };
const AA: Actor = { id: "crm:admin-1", type: "HUMAN", role: "ADMIN_APPROVER" };
const AA2: Actor = { id: "crm:admin-2", type: "HUMAN", role: "ADMIN_APPROVER" };
const CA: Actor = { id: "crm:clinical-1", type: "HUMAN", role: "CLINICAL_APPROVER" };
const CA2: Actor = { id: "crm:clinical-2", type: "HUMAN", role: "CLINICAL_APPROVER" };
const AI: Actor = { id: "ai:drafter-1", type: "AI", role: "AI_DRAFTER" };

const sample = (n: number, over: Json = {}): Json => ({ labTestId: uuid(n), sampleType: "Sangre venosa", requirementsState: "HAS_REQUIREMENTS", requirements: ["Traer el frasco estéril entregado en el laboratorio"], ...over });
const noReq = (n: number): Json => ({ labTestId: uuid(n), sampleType: "Sangre venosa", requirementsState: "NO_SPECIAL_REQUIREMENTS" });
const turn = (n: number, over: Json = {}): Json => ({ labTestId: uuid(n), unit: "HOURS", max: 24, countedFrom: "SAMPLE_COLLECTION", ...over });
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe.skipIf(!bin)("datos aprobados por estudio contra PostgreSQL real (migración 12)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 100;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("study_facts");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    await db.ok(`create table public.lab_tests (id uuid primary key, name text not null, price_bs numeric not null, active boolean not null);`);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  const asService = (sql: string) => `set role service_role; ${sql}`;
  const q = (value: unknown) => `$q$${typeof value === "string" ? value : JSON.stringify(value)}$q$`;
  const call = async (sql: string): Promise<Json> => JSON.parse((await db.ok(asService(sql))).split("\n")[0]!);
  const fails = (sql: string) => db.fails(asService(sql));
  const who = (a: Actor) => `${q(a.id)}, ${q(a.type)}, ${q(a.role)}`;
  const newStudy = async (active = true): Promise<number> => {
    const n = ++counter;
    await db.ok(`insert into public.lab_tests values ('${uuid(n)}', 'ESTUDIO ${n} DE PRUEBA', 10, ${active})`);
    return n;
  };
  const draftSql = (kind: string, n: number, payload: unknown, actor: Actor, validUntil: string | null = days(60), source: string | null = "prueba:fixture") =>
    `select public.plusmedik_study_fact_create_draft(${q(kind)}, '${uuid(n)}'::uuid, ${q(payload)}::jsonb, ${who(actor)}, ${source === null ? "null" : q(source)}, null, ${validUntil === null ? "null" : `${q(validUntil)}::timestamptz`});`;
  const draft = async (kind: string, n: number, payload: unknown, actor: Actor = ED, validUntil: string | null = days(60)): Promise<string> => (await call(draftSql(kind, n, payload, actor, validUntil))).fact_id;
  const submit = (id: string, actor: Actor = ED) => call(`select public.plusmedik_study_fact_submit('${id}'::uuid, ${who(actor)});`);
  const approve = (id: string, actor: Actor) => call(`select public.plusmedik_study_fact_approve('${id}'::uuid, ${who(actor)});`);
  const reject = (id: string, actor: Actor, reason = "DATO_INCORRECTO") => call(`select public.plusmedik_study_fact_reject('${id}'::uuid, ${who(actor)}, ${q(reason)});`);
  const deactivate = (id: string, actor: Actor, reason = "DATO_INCORRECTO") => call(`select public.plusmedik_study_fact_deactivate('${id}'::uuid, ${who(actor)}, ${q(reason)});`);
  const fact = async (id: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(f) from public.plusmedik_study_facts f where id = '${id}'`));
  const revision = async (): Promise<number> => Number((await call(`select public.plusmedik_kb_revision();`)).revision);
  const snapshot = (): Promise<Json> => call(`select public.plusmedik_study_facts_snapshot();`);
  const events = async (id: string): Promise<string[]> => (await db.ok(`select coalesce(string_agg(event, ',' order by at, id), '') from public.plusmedik_study_fact_events where fact_id = '${id}'`)).split(",").filter(Boolean);
  // Un dato aprobado de punta a punta.
  async function published(kind: string, n: number, payload: Json) {
    const id = await draft(kind, n, payload);
    await submit(id);
    await approve(id, kind === "SAMPLE" ? CA : AA);
    return id;
  }

  describe("esquema, privilegios e inmutabilidad", () => {
    it("la migración se puede volver a aplicar sin error y sin tocar datos", async () => {
      const n = await newStudy();
      const id = await published("TURNAROUND", n, turn(n));
      await db.applyFile(join(dir, FACTS));
      expect((await fact(id)).status).toBe("APPROVED");
    });

    it("las tres tablas tienen RLS; service_role solo lee y nadie más tiene acceso", async () => {
      for (const table of ["plusmedik_study_facts", "plusmedik_study_fact_events", "plusmedik_turn_fact_refs"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', 'select')`)).toBe("t");
        for (const privilege of ["insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', '${privilege}')`)).toBe("f");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', 'select')`)).toBe("f");
      }
    });

    it("las funciones públicas son SECURITY DEFINER con search_path vacío; solo service_role las ejecuta", async () => {
      for (const signature of [
        "plusmedik_study_fact_create_draft(text, uuid, jsonb, text, text, text, text, timestamptz, timestamptz)", "plusmedik_study_fact_edit_draft(uuid, jsonb, text, text, text, text, timestamptz, timestamptz)",
        "plusmedik_study_fact_submit(uuid, text, text, text)", "plusmedik_study_fact_reject(uuid, text, text, text, text)", "plusmedik_study_fact_approve(uuid, text, text, text)",
        "plusmedik_study_fact_deactivate(uuid, text, text, text, text)", "plusmedik_study_facts_snapshot()", "plusmedik_study_facts_list(text, integer)", "plusmedik_turn_record_facts(uuid, text, bigint, jsonb)",
        "plusmedik_facts_usage(text, uuid, integer, integer)", "plusmedik_quote_last_studies(uuid, text, bigint, integer)"
      ]) {
        expect(await db.ok(`select prosecdef from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toBe("t");
        expect(await db.ok(`select proconfig::text from pg_proc where oid = 'public.${signature}'::regprocedure`), signature).toContain("search_path=");
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${signature}'::regprocedure, 'execute')`), signature).toBe("t");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_function_privilege('${role}', 'public.${signature}'::regprocedure, 'execute')`), signature).toBe("f");
      }
    });

    it("nada se borra ni se vacía; un dato aprobado solo puede retirarse; uno retirado, enviado o con identidad cambiada es inmutable", async () => {
      const n = await newStudy();
      const id = await published("TURNAROUND", n, turn(n));
      expect(await db.fails(`delete from public.plusmedik_study_facts where id = '${id}'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_study_facts`)).toMatch(/PT409|immutable|cannot truncate/);
      expect(await db.fails(`delete from public.plusmedik_study_fact_events`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`update public.plusmedik_study_fact_events set event = 'EDITED'`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_study_fact_events`)).toMatch(/PT409|immutable|cannot truncate/);
      expect(await db.fails(`update public.plusmedik_study_facts set payload = '{"labTestId":"${uuid(n)}","unit":"HOURS","max":1,"countedFrom":"SAMPLE_COLLECTION"}' where id = '${id}'`)).toMatch(/PT409|can only be deactivated/);
      expect(await db.fails(`update public.plusmedik_study_facts set valid_until = now() + interval '1 day' where id = '${id}'`)).toMatch(/PT409|can only be deactivated/);
      expect(await db.fails(`update public.plusmedik_study_facts set lab_test_id = '${uuid(1)}' where id = '${id}'`)).toMatch(/PT409|identity/);
      await deactivate(id, AA2);
      expect(await db.fails(`update public.plusmedik_study_facts set status = 'APPROVED' where id = '${id}'`)).toMatch(/PT409|inactive/);
      const m = await newStudy();
      const pending = await draft("TURNAROUND", m, turn(m));
      await submit(pending);
      expect(await db.fails(`update public.plusmedik_study_facts set payload = '${JSON.stringify(turn(m, { max: 99 }))}' where id = '${pending}'`)).toMatch(/PT409|cannot change/);
    });

    it("solo hay ids de estudio, códigos y contenido de lista blanca: no hay columna para texto del paciente, teléfonos ni precios", async () => {
      const columns = (await db.ok(`select table_name || '.' || column_name from information_schema.columns where table_schema = 'public' and table_name in ('plusmedik_study_facts', 'plusmedik_study_fact_events', 'plusmedik_turn_fact_refs') order by 1`)).split(/\r?\n/);
      expect(columns.filter((c) => /price|phone|telefono|text|body|message|contact/i.test(c))).toEqual([]);
    });
  });

  describe("contenido: lista blanca y reglas", () => {
    it.each([
      ["horas sin tope", turn(1, { max: undefined })],
      ["horas con tipo de día", turn(1, { dayType: "BUSINESS" })],
      ["días sin tipo de día", turn(1, { unit: "DAYS", max: 3 })],
      ["días hábiles sin tope", { labTestId: uuid(1), unit: "DAYS", dayType: "BUSINESS", countedFrom: "SAMPLE_COLLECTION" }],
      ["más de 60 días", turn(1, { unit: "DAYS", dayType: "CALENDAR", max: 61 })],
      ["más de 720 horas", turn(1, { max: 721 })],
      ["cero horas", turn(1, { max: 0 })],
      ["tope fraccionario", turn(1, { max: 2.5 })],
      ["tope como texto", turn(1, { max: "24" })],
      ["mínimo igual al máximo", turn(1, { min: 24 })],
      ["mínimo mayor que el máximo", turn(1, { min: 30 })],
      ["unidad desconocida", turn(1, { unit: "SEMANAS" })],
      ["sin decir desde cuándo", (({ countedFrom: _c, ...rest }) => rest)(turn(1))],
      ["desde un momento desconocido", turn(1, { countedFrom: "ENTREGA" })],
      ["nota con importe", turn(1, { note: "Urgente: Bs 50 adicionales" })],
      ["clave extra", turn(1, { precio: 10 })],
      ["id que no es UUID", turn(1, { labTestId: "hemograma" })]
    ])("plazo de entrega: rechaza %s (PT422)", async (_name, payload) => {
      expect(await fails(draftSql("TURNAROUND", 1, payload, ED))).toContain("PT422");
    });

    it.each([
      ["con requisitos sin lista", sample(1, { requirements: undefined })],
      ["sin requisitos con lista", { ...noReq(1), requirements: ["Ayuno"] }],
      ["lista vacía", sample(1, { requirements: [] })],
      ["más de 6 requisitos", sample(1, { requirements: Array.from({ length: 7 }, (_, i) => `Requisito ${i}`) })],
      ["requisito que no es texto", sample(1, { requirements: [5] })],
      ["requisito con importe", sample(1, { requirements: ["Pagar Bs 20 por el frasco"] })],
      ["tipo de muestra largo", sample(1, { sampleType: "x".repeat(81) })],
      ["tipo de muestra vacío", sample(1, { sampleType: "  " })],
      ["estado desconocido", sample(1, { requirementsState: "TAL_VEZ" })],
      ["sin tipo de muestra", (({ sampleType: _s, ...rest }) => rest)(sample(1))],
      ["clave extra", sample(1, { urgente: true })]
    ])("tipo de muestra: rechaza %s (PT422)", async (_name, payload) => {
      expect(await fails(draftSql("SAMPLE", 1, payload, ED))).toContain("PT422");
    });

    it("acepta los contenidos bien formados (horas, rango de días hábiles, desde la recepción, con nota; con y sin requisitos)", async () => {
      for (const [kind, payload] of [
        ["TURNAROUND", turn(1)], ["TURNAROUND", turn(1, { unit: "DAYS", dayType: "BUSINESS", min: 2, max: 3, countedFrom: "SAMPLE_RECEIPT", note: "Los sábados no cuentan" })],
        ["SAMPLE", sample(1)], ["SAMPLE", noReq(1)]
      ] as Array<[string, Json]>) {
        const n = await newStudy();
        const result = await call(draftSql(kind, n, { ...payload, labTestId: uuid(n) }, ED));
        expect(result.status, JSON.stringify(payload)).toBe("created");
      }
    });

    it("rechaza un tipo desconocido, una clave que no coincide con el estudio y una fuente inválida", async () => {
      const n = await newStudy();
      expect(await fails(draftSql("PRECIO", n, turn(n), ED))).toContain("PT422");
      expect(await fails(draftSql("TURNAROUND", n + 1, turn(n), ED))).toContain("PT422");
      expect(await fails(draftSql("TURNAROUND", n, turn(n), ED, days(60), "con espacios y texto libre"))).toContain("PT422");
    });
  });

  describe("gobierno: roles, cuatro ojos y la IA", () => {
    it("ciclo completo: borrador → pendiente → aprobado; sube la revisión y queda la bitácora; el que aprueba es otra persona con el rol de la clasificación", async () => {
      const n = await newStudy();
      const before = await revision();
      const id = await draft("TURNAROUND", n, turn(n));
      expect((await fact(id)).status).toBe("DRAFT");
      expect(await submit(id)).toMatchObject({ status: "submitted" });
      expect((await submit(id)).status).toBe("already_submitted");
      expect(await approve(id, AA)).toMatchObject({ status: "approved" });
      expect(await revision()).toBe(before + 1);
      expect((await fact(id))).toMatchObject({ status: "APPROVED", approved_by: AA.id, approved_role: "ADMIN_APPROVER" });
      expect(await events(id)).toEqual(["CREATED", "SUBMITTED", "APPROVED"]);
      expect((await approve(id, AA)).status).toBe("already_approved");
    });

    it("cuatro ojos: quien creó, editó o envió no puede aprobar ni rechazar (PT403)", async () => {
      const n = await newStudy();
      const id = await draft("TURNAROUND", n, turn(n), AA);
      await submit(id, AA);
      expect(await fails(`select public.plusmedik_study_fact_approve('${id}'::uuid, ${who(AA)});`)).toContain("PT403");
      expect(await fails(`select public.plusmedik_study_fact_reject('${id}'::uuid, ${who(AA)}, 'DATO_INCORRECTO');`)).toContain("PT403");
      expect(await approve(id, AA2)).toMatchObject({ status: "approved" });
    });

    it("rol por clasificación: la muestra (clínica) solo la aprueba un aprobador clínico; el plazo (administrativo), un aprobador administrativo; un editor nunca (PT403)", async () => {
      const n = await newStudy();
      const s = await draft("SAMPLE", n, sample(n));
      await submit(s);
      for (const actor of [AA, ED]) expect(await fails(`select public.plusmedik_study_fact_approve('${s}'::uuid, ${who(actor)});`)).toContain("PT403");
      expect((await approve(s, CA)).status).toBe("approved");
      const t = await draft("TURNAROUND", n, turn(n));
      await submit(t);
      for (const actor of [CA, ED]) expect(await fails(`select public.plusmedik_study_fact_approve('${t}'::uuid, ${who(actor)});`)).toContain("PT403");
      expect((await approve(t, AA)).status).toBe("approved");
    });

    it("una IA jamás aprueba, rechaza, envía ni retira, ni redacta datos clínicos; solo redacta borradores administrativos propios", async () => {
      const n = await newStudy();
      expect(await fails(draftSql("SAMPLE", n, sample(n), AI))).toContain("PT403");
      const id = await draft("TURNAROUND", n, turn(n), AI);
      expect(await fails(`select public.plusmedik_study_fact_submit('${id}'::uuid, ${who(AI)});`)).toContain("PT403");
      await submit(id, ED);
      expect(await fails(`select public.plusmedik_study_fact_approve('${id}'::uuid, ${who(AI)});`)).toContain("PT403");
      expect(await fails(`select public.plusmedik_study_fact_reject('${id}'::uuid, ${who(AI)}, 'X');`)).toContain("PT403");
      expect(await approve(id, AA)).toMatchObject({ status: "approved" });
      expect(await fails(`select public.plusmedik_study_fact_deactivate('${id}'::uuid, ${who(AI)}, 'X');`)).toContain("PT403");
      // un actor que dice ser IA con un rol humano (o al revés) no pasa
      expect(await fails(`select public.plusmedik_study_fact_create_draft('TURNAROUND', '${uuid(n)}'::uuid, ${q(turn(n))}::jsonb, 'ai:x', 'AI', 'ADMIN_APPROVER');`)).toContain("PT403");
      expect(await fails(`select public.plusmedik_study_fact_create_draft('TURNAROUND', '${uuid(n)}'::uuid, ${q(turn(n))}::jsonb, 'crm:x', 'HUMAN', 'AI_DRAFTER');`)).toContain("PT403");
    });

    it("una IA no edita el borrador de un humano; un humano sí edita el de una IA", async () => {
      const n = await newStudy();
      const humanDraft = await draft("TURNAROUND", n, turn(n));
      expect(await fails(`select public.plusmedik_study_fact_edit_draft('${humanDraft}'::uuid, ${q(turn(n, { max: 48 }))}::jsonb, ${who(AI)});`)).toContain("PT403");
      const m = await newStudy();
      const aiDraft = await draft("TURNAROUND", m, turn(m), AI);
      expect(await call(`select public.plusmedik_study_fact_edit_draft('${aiDraft}'::uuid, ${q(turn(m, { max: 48 }))}::jsonb, ${who(ED)});`)).toEqual({ status: "edited" });
      expect((await fact(aiDraft)).payload.max).toBe(48);
    });

    it("rechazar devuelve a borrador (con motivo codificado); se puede corregir y volver a enviar; el rechazo lo hace otra persona", async () => {
      const n = await newStudy();
      const id = await draft("SAMPLE", n, sample(n));
      await submit(id);
      expect(await fails(`select public.plusmedik_study_fact_reject('${id}'::uuid, ${who(CA)}, 'minúsculas con espacios');`)).toContain("PT422");
      expect(await reject(id, CA)).toEqual({ status: "rejected" });
      expect((await fact(id)).status).toBe("DRAFT");
      await call(`select public.plusmedik_study_fact_edit_draft('${id}'::uuid, ${q(sample(n, { sampleType: "Orina" }))}::jsonb, ${who(ED)}, null, null, ${q(days(60))}::timestamptz);`);
      await submit(id);
      expect((await approve(id, CA2)).status).toBe("approved");
      expect(await events(id)).toEqual(["CREATED", "SUBMITTED", "REJECTED", "EDITED", "SUBMITTED", "APPROVED"]);
    });
  });

  describe("vigencia, estudio activo y versiones", () => {
    it("la caducidad es obligatoria y acotada: sin fecha no se envía; vencida o a más de 400 días no se aprueba", async () => {
      const n = await newStudy();
      const noDate = await draft("TURNAROUND", n, turn(n), ED, null);
      expect(await fails(`select public.plusmedik_study_fact_submit('${noDate}'::uuid, ${who(ED)});`)).toContain("PT422");
      const m = await newStudy();
      const far = await draft("TURNAROUND", m, turn(m), ED, days(401));
      await submit(far);
      expect(await fails(`select public.plusmedik_study_fact_approve('${far}'::uuid, ${who(AA)});`)).toContain("PT422");
      const k = await newStudy();
      const past = await draft("TURNAROUND", k, turn(k), ED, days(-1));
      await submit(past);
      expect(await fails(`select public.plusmedik_study_fact_approve('${past}'::uuid, ${who(AA)});`)).toContain("PT422");
    });

    it("solo se aprueba para un estudio que existe y está ACTIVO en lab_tests", async () => {
      const inactive = await newStudy(false);
      const id = await draft("TURNAROUND", inactive, turn(inactive));
      await submit(id);
      expect(await fails(`select public.plusmedik_study_fact_approve('${id}'::uuid, ${who(AA)});`)).toContain("PT422");
      const ghost = 900_000 + counter;
      const g = await draft("TURNAROUND", ghost, turn(ghost));
      await submit(g);
      expect(await fails(`select public.plusmedik_study_fact_approve('${g}'::uuid, ${who(AA)});`)).toContain("PT422");
    });

    it("una versión aprobada por (estudio, tipo): la nueva reemplaza a la anterior (que queda INACTIVE) y solo hay un borrador abierto a la vez", async () => {
      const n = await newStudy();
      const v1 = await published("TURNAROUND", n, turn(n));
      const v2 = await draft("TURNAROUND", n, turn(n, { max: 48 }));
      expect(await fails(draftSql("TURNAROUND", n, turn(n, { max: 72 }), ED))).toContain("PT409");
      await submit(v2);
      await approve(v2, AA2);
      expect((await fact(v1))).toMatchObject({ status: "INACTIVE", inactive_reason: "SUPERSEDED" });
      expect((await fact(v2))).toMatchObject({ status: "APPROVED", version: 2 });
      expect(await db.ok(`select count(*) from public.plusmedik_study_facts where lab_test_id = '${uuid(n)}' and fact_kind = 'TURNAROUND' and status = 'APPROVED'`)).toBe("1");
      // los dos tipos del mismo estudio son independientes
      const s = await published("SAMPLE", n, sample(n));
      expect((await fact(s)).status).toBe("APPROVED");
      expect((await fact(v2)).status).toBe("APPROVED");
    });

    it("retirar un dato aprobado lo saca de la instantánea y sube la revisión; retirar dos veces es idempotente; solo lo aprobado se retira", async () => {
      const n = await newStudy();
      const id = await published("TURNAROUND", n, turn(n));
      expect((await snapshot()).items.some((item: Json) => item.versionId === id)).toBe(true);
      const before = await revision();
      expect(await deactivate(id, AA2)).toMatchObject({ status: "deactivated" });
      expect(await revision()).toBe(before + 1);
      expect((await snapshot()).items.some((item: Json) => item.versionId === id)).toBe(false);
      expect((await deactivate(id, AA2)).status).toBe("already_inactive");
      const m = await newStudy();
      const pending = await draft("TURNAROUND", m, turn(m));
      expect(await fails(`select public.plusmedik_study_fact_deactivate('${pending}'::uuid, ${who(AA)}, 'DATO_INCORRECTO');`)).toContain("PT409");
    });

    it("la instantánea solo trae lo APROBADO (nunca borradores ni pendientes) con su revisión y procedencia", async () => {
      const n = await newStudy();
      const approved = await published("SAMPLE", n, sample(n));
      const m = await newStudy();
      const pending = await draft("TURNAROUND", m, turn(m));
      await submit(pending);
      const snap = await snapshot();
      expect(snap.revision).toBe(await revision());
      const ids = snap.items.map((item: Json) => item.versionId);
      expect(ids).toContain(approved);
      expect(ids).not.toContain(pending);
      expect(snap.items.find((item: Json) => item.versionId === approved)).toMatchObject({ kind: "SAMPLE", labTestId: uuid(n), classification: "CLINICAL", version: 1, approvedBy: CA.id });
    });

    it("la lista administrativa filtra por estado y valida sus argumentos", async () => {
      const result = await call(`select public.plusmedik_study_facts_list('APPROVED', 500);`);
      expect(result.items.every((item: Json) => item.status === "APPROVED")).toBe(true);
      expect(await fails(`select public.plusmedik_study_facts_list('OTRO', 10);`)).toContain("PT422");
      expect(await fails(`select public.plusmedik_study_facts_list(null, 0);`)).toContain("PT422");
    });
  });

  describe("trazabilidad e impacto", () => {
    const claim = (message: string, contact: string, who = 1) =>
      call(`select public.plusmedik_turn_claim('${message}', null, '${owner(who)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', 'TEXT');`);
    const contactKey = () => (++counter).toString(16).padStart(64, "0");
    const runOf = async (message: string) => db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`);
    const record = (runId: string, fence: number, refs: unknown, who = 1) => call(`select public.plusmedik_turn_record_facts('${runId}'::uuid, '${owner(who)}', ${fence}, ${q(refs)}::jsonb);`);
    async function turnFor(contact: string) {
      const message = `wamid.fact-${++counter}-${Date.now()}`;
      const claimed = await claim(message, contact);
      return { message, id: await runOf(message), fence: claimed.fence as number };
    }
    const ref = (n: number, over: Json = {}): Json => ({ kind: "TURNAROUND", labTestId: uuid(n), version: 1, contentHash: "a".repeat(64), ...over });

    it("registra qué datos respaldan la respuesta ANTES de reservar el envío; es idempotente y con 'closed' una vez reservado", async () => {
      const t = await turnFor(contactKey());
      expect(await record(t.id, t.fence, [ref(1), ref(2, { kind: "SAMPLE" })])).toEqual({ status: "recorded", count: 2 });
      expect(await record(t.id, t.fence, [ref(1)])).toEqual({ status: "recorded", count: 0 });
      await call(`select public.plusmedik_turn_reserve_send('${t.id}'::uuid, '${owner(1)}', ${t.fence}, 'conversation', 120, 'NONE');`);
      expect(await record(t.id, t.fence, [ref(3)])).toEqual({ status: "closed" });
      expect(await db.ok(`select count(*) from public.plusmedik_turn_fact_refs where run_id = '${t.id}'`)).toBe("2");
    });

    it.each([
      ["sin referencias", []],
      ["más de 20", Array.from({ length: 21 }, (_, i) => ref(i + 1))],
      ["tipo desconocido", [ref(1, { kind: "PRECIO" })]],
      ["id que no es UUID", [ref(1, { labTestId: "hemograma" })]],
      ["versión 0", [ref(1, { version: 0 })]],
      ["hash corto", [ref(1, { contentHash: "abc" })]],
      ["clave extra (texto)", [ref(1, { texto: "hola" })]],
      ["no es una lista", { kind: "SAMPLE" }]
    ])("rechaza referencias inválidas: %s (PT422)", async (_name, refs) => {
      const t = await turnFor(contactKey());
      expect(await fails(`select public.plusmedik_turn_record_facts('${t.id}'::uuid, '${owner(1)}', ${t.fence}, ${q(refs)}::jsonb);`)).toContain("PT422");
    });

    it("exige el lease vigente: otra generación u otro propietario no deja rastro (PT410) y un turno inexistente es PT404", async () => {
      const t = await turnFor(contactKey());
      expect(await fails(`select public.plusmedik_turn_record_facts('${t.id}'::uuid, '${owner(1)}', ${t.fence + 1}, ${q([ref(1)])}::jsonb);`)).toContain("PT410");
      expect(await fails(`select public.plusmedik_turn_record_facts('${t.id}'::uuid, '${owner(7)}', ${t.fence}, ${q([ref(1)])}::jsonb);`)).toContain("PT410");
      expect(await fails(`select public.plusmedik_turn_record_facts('${uuid(777)}'::uuid, '${owner(1)}', 1, ${q([ref(1)])}::jsonb);`)).toContain("PT404");
    });

    it("el rastro es inmutable", async () => {
      const t = await turnFor(contactKey());
      await record(t.id, t.fence, [ref(1)]);
      expect(await db.fails(`update public.plusmedik_turn_fact_refs set version = 9`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`delete from public.plusmedik_turn_fact_refs`)).toMatch(/PT409|immutable/);
      expect(await db.fails(`truncate public.plusmedik_turn_fact_refs`)).toMatch(/PT409|immutable|cannot truncate/);
    });

    it("impacto: ¿a quién se le dio esta versión? Solo cuenta envíos reservados; devuelve seudónimos, nunca texto ni teléfonos", async () => {
      const n = await newStudy();
      const contact = contactKey();
      const sent = await turnFor(contact);
      await record(sent.id, sent.fence, [ref(n, { version: 2 })]);
      await call(`select public.plusmedik_turn_reserve_send('${sent.id}'::uuid, '${owner(1)}', ${sent.fence}, 'conversation', 120, 'NONE');`);
      const unsent = await turnFor(contactKey());
      await record(unsent.id, unsent.fence, [ref(n, { version: 2 })]);
      const usage = await call(`select public.plusmedik_facts_usage('TURNAROUND', '${uuid(n)}'::uuid, 2, 100);`);
      expect(usage.uses).toHaveLength(1);
      expect(usage.uses[0]).toMatchObject({ runId: sent.id, contactKey: contact, version: 2, sendState: "RESERVED" });
      expect(Object.keys(usage.uses[0]).sort()).toEqual(["contactKey", "recordedAt", "replyState", "runId", "sendState", "version"]);
      expect((await call(`select public.plusmedik_facts_usage('TURNAROUND', '${uuid(n)}'::uuid, 3, 100);`)).uses).toEqual([]);
      expect(await fails(`select public.plusmedik_facts_usage('PRECIO', '${uuid(n)}'::uuid, null, 100);`)).toContain("PT422");
    });
  });

  describe("estudios de la última cotización", () => {
    const contactKey = () => (++counter).toString(16).padStart(64, "0");
    const claim = (message: string, contact: string, who = 1, kind = "TEXT") =>
      call(`select public.plusmedik_turn_claim('${message}', null, '${owner(who)}', 120, 2, 'abc1234', '{}'::jsonb, 3, '${contact}', '${kind}');`);
    async function turn(contact: string, who = 1) {
      const message = `wamid.last-${++counter}-${Date.now()}`;
      const claimed = await claim(message, contact, who);
      return { message, id: await db.ok(`select id from public.plusmedik_audit_runs where kapso_message_id = '${message}'`), who: owner(who), fence: claimed.fence as number };
    }
    const itemSql = (t: { id: string; who: string; fence: number }, studies: number[]) =>
      `select public.plusmedik_quote_item_begin('${t.id}'::uuid, '${t.who}', ${t.fence}, 'TEXT', null, ${q({ status: "RESOLVED", studyIds: studies.map(uuid), ambiguous: [], unresolved: 0, reasons: [] })}::jsonb, 1800, 20);`;
    const lastSql = (t: { id: string; who: string; fence: number }, age = 86400) => `select public.plusmedik_quote_last_studies('${t.id}'::uuid, '${t.who}', ${t.fence}, ${age});`;
    async function quoted(contact: string, studies: number[]) {
      const t = await turn(contact);
      const begun = await call(itemSql(t, studies));
      await db.ok(asService(`select public.plusmedik_audit_fenced_close('${t.id}'::uuid, '${t.who}', ${t.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`));
      const closer = await turn(contact);
      const lines = studies.map((n) => ({ studyId: uuid(n), name: `ESTUDIO ${n}`, priceBs: 10 }));
      await call(`select public.plusmedik_quote_session_close('${closer.id}'::uuid, '${closer.who}', ${closer.fence}, '${begun.sessionId}'::uuid, 'QUOTED', ${q(lines)}::jsonb, ${studies.length * 10}, null, ${q("b".repeat(64))});`);
      // el turno que cotiza termina (si no, seguiría «en proceso» y bloquearía el cierre de las cotizaciones posteriores)
      await db.ok(asService(`select public.plusmedik_audit_fenced_close('${closer.id}'::uuid, '${closer.who}', ${closer.fence}, '{"status":"IGNORED","error_code":"NO_REPLY","final":true}'::jsonb);`));
      return closer;
    }

    it("devuelve SOLO los ids de la última cotización entregada al contacto (sin precios), la más reciente si hay varias", async () => {
      const contact = contactKey();
      await quoted(contact, [1, 2]);
      await quoted(contact, [3]);
      const asker = await turn(contact);
      const result = await call(lastSql(asker));
      expect(result.studyIds).toEqual([uuid(3)]);
      expect(Object.keys(result).sort()).toEqual(["quotedAt", "studyIds"]);
      expect(JSON.stringify(result)).not.toMatch(/price|precio|Bs/i);
    });

    it("sin cotización, de otro contacto, vencida (más antigua que la antigüedad pedida) o solo en una sesión abierta o en revisión: vacío", async () => {
      expect((await call(lastSql(await turn(contactKey())))).studyIds).toEqual([]);
      const mine = contactKey();
      await quoted(contactKey(), [5]);
      expect((await call(lastSql(await turn(mine)))).studyIds).toEqual([]);
      const old = contactKey();
      await quoted(old, [6]);
      await db.ok(`set session_replication_role = replica; update public.plusmedik_quote_results set created_at = now() - interval '2 days' where session_id in (select id from public.plusmedik_quote_sessions where contact_key = '${old}');`);
      expect((await call(lastSql(await turn(old), 86400))).studyIds).toEqual([]);
      expect((await call(lastSql(await turn(old), 604800))).studyIds).toEqual([uuid(6)]);
      const open = contactKey();
      const t = await turn(open);
      await call(itemSql(t, [7]));
      expect((await call(lastSql(await turn(open)))).studyIds).toEqual([]);
    });

    it("exige el lease vigente (PT410), un turno existente (PT404) y una antigüedad válida (PT422)", async () => {
      const t = await turn(contactKey());
      expect(await fails(`select public.plusmedik_quote_last_studies('${t.id}'::uuid, '${t.who}', ${t.fence + 1}, 3600);`)).toContain("PT410");
      expect(await fails(`select public.plusmedik_quote_last_studies('${uuid(777)}'::uuid, '${t.who}', 1, 3600);`)).toContain("PT404");
      expect(await fails(lastSql(t, 10))).toContain("PT422");
      expect(await fails(lastSql(t, 10_000_000))).toContain("PT422");
    });
  });

  describe("la migración es aditiva", () => {
    const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
    const code = read(FACTS).replace(/--.*$/gm, "");

    it("es la duodécima (la 13 es la cola de salida hacia el CRM, G5.0) y las once anteriores no se modificaron (hash de la 11 fijado)", () => {
      expect(MIGRATIONS[11]).toBe(FACTS);
      expect(MIGRATIONS).toHaveLength(13);
      expect(sha("20261030000000_plusmedik_quote_sessions.sql")).toBe("af0b7ed8399ccda325b343b07b025a8e7978317659a533b2a2fb7eb2a68ad314");
    });

    it("solo crea lo esperado: sin borrar, sin datos, sin SQL dinámico; lab_tests solo se LEE al aprobar; sin precios", () => {
      expect([...code.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1])).toEqual(["plusmedik_study_facts", "plusmedik_study_fact_events", "plusmedik_turn_fact_refs"]);
      expect(code).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\btruncate\s+table\b|\bexecute\s+(format|'|\$)|\bcreate\s+extension\b|\bcrm\b/i);
      expect(code).not.toMatch(/\bprice_bs\b|\bprecio\b/i);
      expect([...code.matchAll(/\b(?:from|join)\s+public\.lab_tests\b/gi)]).toHaveLength(1);
      expect(code).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\.lab_tests\b/i);
      expect(code).not.toMatch(/\binsert\s+into\s+public\.(?!plusmedik_(study_fact|turn_fact))/i);
      expect(code).not.toMatch(/\bupdate\s+public\.(?!plusmedik_study_facts\b)/i);
      expect([...code.matchAll(/alter\s+table\s+([\w.]+)\s+([a-z ]+);/gi)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
        "public.plusmedik_study_facts enable row level security", "public.plusmedik_study_fact_events enable row level security", "public.plusmedik_turn_fact_refs enable row level security"
      ]);
    });
  });
});
