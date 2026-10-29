import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";

// Base de conocimiento (migración 8) contra un PostgreSQL REAL y efímero. TODOS los datos de este archivo son FIXTURES DE PRUEBA (no son información del laboratorio ni
// se parecen a ella): la migración no siembra nada y estas pruebas verifican justamente eso. NO se aplica a ningún Supabase remoto.

const bin = findPostgresBin();
if (!bin) console.warn("[knowledge-db] PostgreSQL no disponible: se omiten las pruebas de la base de conocimiento contra la base real.");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const KNOWLEDGE = "20261027000000_plusmedik_knowledge.sql";
const read = (name: string) => readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;
type Actor = { id: string; type: "HUMAN" | "AI"; role: string };

const ED: Actor = { id: "crm:editor-1", type: "HUMAN", role: "EDITOR" };
const ED2: Actor = { id: "crm:editor-2", type: "HUMAN", role: "EDITOR" };
const AA: Actor = { id: "crm:admin-1", type: "HUMAN", role: "ADMIN_APPROVER" };
const AA2: Actor = { id: "crm:admin-2", type: "HUMAN", role: "ADMIN_APPROVER" };
const CA: Actor = { id: "crm:clinical-1", type: "HUMAN", role: "CLINICAL_APPROVER" };
const CA2: Actor = { id: "crm:clinical-2", type: "HUMAN", role: "CLINICAL_APPROVER" };
const AI: Actor = { id: "ai:drafter-1", type: "AI", role: "AI_DRAFTER" };

const STUDY = "11111111-1111-4111-8111-111111111111";
const STUDY_INACTIVE = "22222222-2222-4222-8222-222222222222";
const STUDY_UNKNOWN = "33333333-3333-4333-8333-333333333333";
const FIXTURES = {
  BRANCH: { key: "branch-prueba", payload: { name: "SUCURSAL DE PRUEBA", address: "DIRECCION DE PRUEBA 000" } },
  SCHEDULE: { key: "schedule:branch-prueba:office", payload: { branchKey: "branch-prueba", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "12:00" }] } },
  POLICY: { key: "policy:prueba", payload: { topic: "PRUEBA", title: "POLITICA DE PRUEBA", body: "TEXTO DE PRUEBA" } },
  PAYMENT_METHOD: { key: "payment:prueba", payload: { method: "prueba", label: "METODO DE PRUEBA", accepted: true } },
  FAQ: { key: "faq:prueba", payload: { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA", tags: ["prueba"] } },
  STUDY_PREPARATION: { key: `study:${STUDY}`, payload: { labTestId: STUDY, prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" } }
} as const;
type Kind = keyof typeof FIXTURES;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe.skipIf(!bin)("base de conocimiento contra PostgreSQL real (migración 8)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("knowledge");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    // catálogo mínimo SOLO de pruebas (en producción es public.lab_tests, que esta migración solo lee)
    await db.ok(`create table public.lab_tests (id uuid primary key, name text not null, price_bs numeric not null, active boolean not null);
      insert into public.lab_tests values ('${STUDY}', 'ESTUDIO DE PRUEBA', 1, true), ('${STUDY_INACTIVE}', 'ESTUDIO INACTIVO DE PRUEBA', 1, false);`);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => {
    await server?.stop();
  });

  // ── helpers: llamada por nombre con argumentos con nombre (como PostgREST)
  const lit = (value: unknown): string => {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number") return String(value);
    if (typeof value === "object") return `$j$${JSON.stringify(value)}$j$::jsonb`;
    return `'${String(value).replaceAll("'", "''")}'`;
  };
  const sql = (name: string, args: Record<string, unknown>) => `set role service_role; select public.${name}(${Object.entries(args).map(([key, value]) => `${key} => ${lit(value)}`).join(", ")});`;
  const rpc = async (name: string, args: Record<string, unknown>): Promise<Json> => JSON.parse((await db.ok(sql(name, args))).split("\n")[0]!);
  const fails = (name: string, args: Record<string, unknown>) => db.fails(sql(name, args));
  const who = (actor: Actor) => ({ p_actor_id: actor.id, p_actor_type: actor.type, p_actor_role: actor.role });
  const unique = (kind: Kind) => (kind === "STUDY_PREPARATION" ? FIXTURES[kind].key : `${FIXTURES[kind].key}-${++counter}`);
  const fixtureFor = (kind: Kind, key = unique(kind)): { key: string; payload: Json } => ({ key, payload: { ...FIXTURES[kind].payload } as Json });

  async function draft(kind: Kind, options: { key?: string; payload?: Json; actor?: Actor; validUntil?: string | null; validFrom?: string | null } = {}) {
    const fx = fixtureFor(kind, options.key);
    const result = await rpc("plusmedik_kb_create_draft", { p_kind: kind, p_key: fx.key, p_payload: options.payload ?? fx.payload, ...who(options.actor ?? ED), p_source_ref: "prueba:fixture", p_valid_from: options.validFrom ?? null, p_valid_until: options.validUntil === undefined ? days(90) : options.validUntil });
    return { key: fx.key, versionId: result.version_id as string, version: result.version as number, kind };
  }
  const submit = (versionId: string, actor = ED) => rpc("plusmedik_kb_submit", { p_version_id: versionId, ...who(actor) });
  const approve = (versionId: string, actor = AA) => rpc("plusmedik_kb_approve", { p_version_id: versionId, ...who(actor) });
  const approverFor = (kind: Kind) => (kind === "STUDY_PREPARATION" ? CA : AA);
  async function approved(kind: Kind, options: { key?: string; payload?: Json; validUntil?: string } = {}) {
    // el estudio de preparación es una clave fija: para versiones sucesivas se reutiliza
    const d = await draft(kind, options);
    await submit(d.versionId);
    await approve(d.versionId, approverFor(kind));
    return d;
  }
  const row = async (versionId: string): Promise<Json> => JSON.parse(await db.ok(`select to_json(v) from public.plusmedik_kb_versions v where id = '${versionId}'`));
  const revision = async (): Promise<number> => (JSON.parse((await db.ok(sql("plusmedik_kb_revision", {}))).split("\n")[0]!) as Json).revision;
  const snapshot = async (): Promise<Json> => JSON.parse((await db.ok(sql("plusmedik_kb_snapshot", {}))).split("\n")[0]!);
  const events = async (kind: string, key: string) => (await rpc("plusmedik_kb_history", { p_kind: kind, p_key: key })).events as Json[];
  const expire = (versionId: string) => db.ok(`alter table public.plusmedik_kb_versions disable trigger plusmedik_kb_versions_guard; update public.plusmedik_kb_versions set valid_until = now() - interval '1 second', valid_from = now() - interval '2 days' where id = '${versionId}'; alter table public.plusmedik_kb_versions enable trigger plusmedik_kb_versions_guard;`);

  describe("sin datos, privilegios e inmutabilidad", () => {
    it("la migración NO siembra conocimiento: tras aplicarla no hay documentos, versiones ni eventos, y la instantánea está vacía", async () => {
      const fresh = await server.createDatabase("knowledge_fresh");
      await fresh.ok(SUPABASE_BOOTSTRAP_SQL);
      for (const file of MIGRATIONS) await fresh.applyFile(join(dir, file));
      expect(await fresh.ok("select (select count(*) from public.plusmedik_kb_documents) || ',' || (select count(*) from public.plusmedik_kb_versions) || ',' || (select count(*) from public.plusmedik_kb_events) || ',' || (select count(*) from public.plusmedik_kb_state)")).toBe("0,0,0,0");
      expect(JSON.parse((await fresh.ok("set role service_role; select public.plusmedik_kb_snapshot();")).split("\n")[0]!)).toEqual({ revision: 0, items: [] });
      expect(JSON.parse((await fresh.ok("set role service_role; select public.plusmedik_kb_revision();")).split("\n")[0]!)).toEqual({ revision: 0 });
    });

    it("las tablas tienen RLS; service_role solo lee y nadie más tiene acceso; las funciones de uso interno no son ejecutables por nadie", async () => {
      for (const table of ["plusmedik_kb_state", "plusmedik_kb_documents", "plusmedik_kb_versions", "plusmedik_kb_events"]) {
        expect(await db.ok(`select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`)).toBe("t");
        expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', 'select')`)).toBe("t");
        for (const privilege of ["insert", "update", "delete", "truncate"]) expect(await db.ok(`select has_table_privilege('service_role', 'public.${table}', '${privilege}')`)).toBe("f");
        for (const role of ["anon", "authenticated", "unprivileged"]) expect(await db.ok(`select has_table_privilege('${role}', 'public.${table}', 'select')`)).toBe("f");
      }
      for (const internal of ["plusmedik_kb_bump()", "plusmedik_kb_payload_ok(text, jsonb)", "plusmedik_kb_assert_actor(text, text, text, text, text)", "plusmedik_kb_assert_not_author(uuid, text)"]) {
        expect(await db.ok(`select has_function_privilege('service_role', 'public.${internal}'::regprocedure, 'execute')`), internal).toBe("f");
      }
      for (const role of ["anon", "authenticated", "unprivileged"]) {
        for (const fn of ["plusmedik_kb_snapshot()", "plusmedik_kb_approve(uuid, text, text, text)", "plusmedik_kb_create_draft(text, text, jsonb, text, text, text, text, timestamptz, timestamptz)"]) {
          expect(await db.ok(`select has_function_privilege('${role}', 'public.${fn}'::regprocedure, 'execute')`), `${role} ${fn}`).toBe("f");
        }
      }
    });

    it("las funciones públicas son SECURITY DEFINER con search_path vacío", async () => {
      const rows = await db.ok(`select string_agg(proname || ':' || prosecdef || ':' || coalesce(proconfig::text, ''), ';' order by proname) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'plusmedik\\_kb\\_%' and prosecdef`);
      for (const entry of rows.split(";")) expect(entry).toMatch(/:true:.*search_path=/);
      expect(rows.split(";").length).toBeGreaterThanOrEqual(12);
    });

    it("el historial es inmutable: ni el propietario puede cambiar identidad, contenido enviado, ni borrar o vaciar documentos, versiones y eventos", async () => {
      const d = await approved("FAQ");
      const doc = await db.ok(`select document_id from public.plusmedik_kb_versions where id = '${d.versionId}'`);
      expect(await db.fails(`update public.plusmedik_kb_versions set payload = '{"question":"x","answer":"y"}'::jsonb where id = '${d.versionId}'`)).toContain("immutable");
      expect(await db.fails(`update public.plusmedik_kb_versions set version = 99 where id = '${d.versionId}'`)).toContain("immutable");
      expect(await db.fails(`update public.plusmedik_kb_versions set created_by = 'otro' where id = '${d.versionId}'`)).toContain("immutable");
      expect(await db.fails(`update public.plusmedik_kb_versions set status = 'DRAFT' where id = '${d.versionId}'`)).toContain("invalid status transition");
      expect(await db.fails(`delete from public.plusmedik_kb_versions where id = '${d.versionId}'`)).toMatch(/not allowed/);
      expect(await db.fails(`truncate public.plusmedik_kb_versions`)).toMatch(/not allowed|cannot truncate/);
      expect(await db.fails(`update public.plusmedik_kb_documents set key = 'otro' where id = '${doc}'`)).toMatch(/not allowed/);
      expect(await db.fails(`delete from public.plusmedik_kb_documents where id = '${doc}'`)).toMatch(/not allowed/);
      expect(await db.fails(`update public.plusmedik_kb_events set reason = 'X' where version_id = '${d.versionId}'`)).toMatch(/not allowed/);
      expect(await db.fails(`delete from public.plusmedik_kb_events where version_id = '${d.versionId}'`)).toMatch(/not allowed/);
      expect(await db.fails(`delete from public.plusmedik_kb_state`)).toMatch(/not allowed/);
      expect(await db.fails("set role service_role; update public.plusmedik_kb_versions set status = 'APPROVED'")).toContain("permission denied");
    });

    it("la clasificación se deriva del tipo y no se puede elegir", async () => {
      for (const kind of ["BRANCH", "SCHEDULE", "POLICY", "PAYMENT_METHOD", "FAQ"] as const) {
        const d = await draft(kind);
        expect(await db.ok(`select classification from public.plusmedik_kb_documents d join public.plusmedik_kb_versions v on v.document_id = d.id where v.id = '${d.versionId}'`)).toBe("ADMINISTRATIVE");
      }
      expect(await db.ok(`select classification from public.plusmedik_kb_documents where kind = 'STUDY_PREPARATION' limit 1`)).toMatch(/CLINICAL|^$/);
      expect(await db.fails("insert into public.plusmedik_kb_documents (kind, key, classification) values ('FAQ', 'faq:x', 'CLINICAL')")).toMatch(/generated column|cannot insert/i);
    });
  });

  describe("ciclo de vida y versionado", () => {
    it("cada tipo recorre borrador → pendiente → aprobado con sus eventos (quién, rol, estados) y aparece en la instantánea", async () => {
      for (const kind of Object.keys(FIXTURES) as Kind[]) {
        const key = kind === "STUDY_PREPARATION" ? `study:${STUDY}` : unique(kind);
        if (kind === "STUDY_PREPARATION" && (await db.ok(`select count(*) from public.plusmedik_kb_documents where key = '${key}'`)) !== "0") continue; // ya cubierto por otra prueba
        const d = await draft(kind, { key });
        expect(await row(d.versionId)).toMatchObject({ status: "DRAFT", version: 1, created_by: ED.id, created_by_type: "HUMAN" });
        expect(await submit(d.versionId)).toEqual({ status: "submitted" });
        expect(await row(d.versionId)).toMatchObject({ status: "PENDING_APPROVAL", submitted_by: ED.id });
        expect(await approve(d.versionId, approverFor(kind))).toMatchObject({ status: "approved" });
        expect(await row(d.versionId)).toMatchObject({ status: "APPROVED", approved_by: approverFor(kind).id, approved_role: approverFor(kind).role });
        const log = (await events(kind, key)).map((e) => [e.event, e.actorId, e.actorRole, e.from, e.to]);
        expect(log).toEqual([["CREATED", ED.id, "EDITOR", null, "DRAFT"], ["SUBMITTED", ED.id, "EDITOR", "DRAFT", "PENDING_APPROVAL"], ["APPROVED", approverFor(kind).id, approverFor(kind).role, "PENDING_APPROVAL", "APPROVED"]]);
        const item = (await snapshot()).items.find((i: Json) => i.kind === kind && i.key === key);
        expect(item).toMatchObject({ version: 1, approvedBy: approverFor(kind).id, payload: fixtureFor(kind, key).payload });
      }
    });

    it("una versión nueva reemplaza a la aprobada: la anterior queda INACTIVE (SUPERSEDED), solo hay UNA aprobada y el número de versión crece", async () => {
      const first = await approved("POLICY");
      const second = await draft("POLICY", { key: first.key, payload: { topic: "PRUEBA", title: "POLITICA DE PRUEBA 2", body: "TEXTO DE PRUEBA 2" } });
      expect(second.version).toBe(2);
      await submit(second.versionId);
      await approve(second.versionId);
      expect(await row(first.versionId)).toMatchObject({ status: "INACTIVE", inactive_reason: "SUPERSEDED", inactivated_by: AA.id });
      expect(await row(second.versionId)).toMatchObject({ status: "APPROVED" });
      expect(await db.ok(`select count(*) from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id where d.key = '${first.key}' and v.status = 'APPROVED'`)).toBe("1");
      expect((await events("POLICY", first.key)).map((e) => e.event)).toEqual(["CREATED", "SUBMITTED", "APPROVED", "CREATED", "SUBMITTED", "SUPERSEDED", "APPROVED"]);
      expect((await snapshot()).items.filter((i: Json) => i.key === first.key)).toHaveLength(1);
    });

    it("solo una versión abierta por elemento: un segundo borrador (o uno mientras hay una pendiente) se rechaza con 409 y no cambia nada", async () => {
      const d = await draft("FAQ");
      expect(await fails("plusmedik_kb_create_draft", { p_kind: "FAQ", p_key: d.key, p_payload: FIXTURES.FAQ.payload, ...who(ED2), p_valid_until: days(30) })).toContain("PT409");
      await submit(d.versionId);
      expect(await fails("plusmedik_kb_create_draft", { p_kind: "FAQ", p_key: d.key, p_payload: FIXTURES.FAQ.payload, ...who(ED2), p_valid_until: days(30) })).toContain("PT409");
      expect(await db.ok(`select count(*) from public.plusmedik_kb_versions where document_id = (select document_id from public.plusmedik_kb_versions where id = '${d.versionId}')`)).toBe("1");
    });

    it("editar: solo un borrador; cambia el hash y deja evento; tras enviarlo el contenido ya no se puede editar", async () => {
      const d = await draft("BRANCH");
      const before = (await row(d.versionId)).content_hash;
      await rpc("plusmedik_kb_edit_draft", { p_version_id: d.versionId, p_payload: { name: "SUCURSAL DE PRUEBA B", address: "DIRECCION DE PRUEBA 000" }, ...who(ED2), p_valid_until: days(60) });
      expect((await row(d.versionId)).content_hash).not.toBe(before);
      expect((await row(d.versionId)).payload.name).toBe("SUCURSAL DE PRUEBA B");
      await submit(d.versionId);
      expect(await fails("plusmedik_kb_edit_draft", { p_version_id: d.versionId, p_payload: FIXTURES.BRANCH.payload, ...who(ED2) })).toContain("PT409");
      expect((await events("BRANCH", d.key)).map((e) => [e.event, e.actorId])).toEqual([["CREATED", ED.id], ["EDITED", ED2.id], ["SUBMITTED", ED.id]]);
    });

    it("rechazar devuelve a borrador (motivo codificado); se puede corregir, volver a enviar y aprobar", async () => {
      const d = await draft("PAYMENT_METHOD");
      await submit(d.versionId);
      expect(await rpc("plusmedik_kb_reject", { p_version_id: d.versionId, ...who(AA), p_reason: "FALTA_FUENTE" })).toEqual({ status: "rejected" });
      expect(await row(d.versionId)).toMatchObject({ status: "DRAFT", submitted_by: null });
      expect(await fails("plusmedik_kb_reject", { p_version_id: d.versionId, ...who(AA), p_reason: "FALTA_FUENTE" })).toContain("PT409"); // ya no está pendiente
      await rpc("plusmedik_kb_edit_draft", { p_version_id: d.versionId, p_payload: { method: "prueba", label: "METODO DE PRUEBA CORREGIDO", accepted: false }, ...who(ED), p_valid_until: days(40) });
      await submit(d.versionId);
      expect(await approve(d.versionId, AA2)).toMatchObject({ status: "approved" });
      expect((await events("PAYMENT_METHOD", d.key)).map((e) => e.event)).toEqual(["CREATED", "SUBMITTED", "REJECTED", "EDITED", "SUBMITTED", "APPROVED"]);
      expect(await fails("plusmedik_kb_reject", { p_version_id: d.versionId, ...who(AA), p_reason: "texto libre" })).toContain("PT422");
    });

    it("la revisión sube exactamente 1 con aprobar, desactivar y restaurar; no cambia con crear, editar, enviar ni rechazar; y es idempotente al repetir", async () => {
      const start = await revision();
      const d = await draft("FAQ");
      await rpc("plusmedik_kb_edit_draft", { p_version_id: d.versionId, p_payload: FIXTURES.FAQ.payload, ...who(ED), p_valid_until: days(10) });
      await submit(d.versionId);
      await rpc("plusmedik_kb_reject", { p_version_id: d.versionId, ...who(AA), p_reason: "PRUEBA" });
      await submit(d.versionId);
      expect(await revision()).toBe(start);
      expect((await approve(d.versionId)).revision).toBe(start + 1);
      expect(await approve(d.versionId)).toEqual({ status: "already_approved" });
      expect(await revision()).toBe(start + 1);
      expect((await rpc("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(AA2), p_reason: "DATO_INCORRECTO" })).revision).toBe(start + 2);
      expect(await rpc("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(AA2), p_reason: "DATO_INCORRECTO" })).toEqual({ status: "already_inactive" });
      expect((await rpc("plusmedik_kb_restore", { p_version_id: d.versionId, ...who(AA2), p_reason: "ERROR_DE_RETIRO" })).revision).toBe(start + 3);
      expect(await revision()).toBe(start + 3);
    });
  });

  describe("recuperación de versiones aprobadas", () => {
    it("desactivar retira el dato de la instantánea al instante y la bitácora conserva quién y por qué", async () => {
      const d = await approved("POLICY");
      expect((await snapshot()).items.some((i: Json) => i.key === d.key)).toBe(true);
      await rpc("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(AA2), p_reason: "DATO_INCORRECTO" });
      expect((await snapshot()).items.some((i: Json) => i.key === d.key)).toBe(false);
      expect(await row(d.versionId)).toMatchObject({ status: "INACTIVE", inactive_reason: "DATO_INCORRECTO", inactivated_by: AA2.id });
      expect((await events("POLICY", d.key)).at(-1)).toMatchObject({ event: "DEACTIVATED", actorId: AA2.id, reason: "DATO_INCORRECTO", from: "APPROVED", to: "INACTIVE" });
    });

    it("restaurar una versión anterior: vuelve a ser la vigente, la actual pasa a INACTIVE y el contenido es EXACTAMENTE el aprobado entonces (mismo hash)", async () => {
      const v1 = await approved("FAQ");
      const hash = (await row(v1.versionId)).content_hash;
      const v2 = await draft("FAQ", { key: v1.key, payload: { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA ERRONEA DE PRUEBA" } });
      await submit(v2.versionId);
      await approve(v2.versionId);
      // se detecta que la versión 2 era errónea: se recupera la 1 sin escribir contenido nuevo
      expect(await rpc("plusmedik_kb_restore", { p_version_id: v1.versionId, ...who(AA2), p_reason: "VERSION_ERRONEA" })).toMatchObject({ status: "restored" });
      expect(await row(v1.versionId)).toMatchObject({ status: "APPROVED", approved_by: AA2.id, content_hash: hash, inactive_reason: null });
      expect(await row(v2.versionId)).toMatchObject({ status: "INACTIVE", inactive_reason: "SUPERSEDED" });
      const item = (await snapshot()).items.find((i: Json) => i.key === v1.key);
      expect(item).toMatchObject({ version: 1, contentHash: hash });
      expect((await events("FAQ", v1.key)).map((e) => e.event)).toEqual(["CREATED", "SUBMITTED", "APPROVED", "CREATED", "SUBMITTED", "SUPERSEDED", "APPROVED", "SUPERSEDED", "RESTORED"]);
    });

    it("no se puede restaurar lo que nunca estuvo aprobado, ni algo vencido, ni lo que ya está aprobado (idempotente)", async () => {
      const neverApproved = await draft("FAQ");
      expect(await fails("plusmedik_kb_restore", { p_version_id: neverApproved.versionId, ...who(AA), p_reason: "PRUEBA" })).toContain("PT409");
      await submit(neverApproved.versionId);
      expect(await fails("plusmedik_kb_restore", { p_version_id: neverApproved.versionId, ...who(AA), p_reason: "PRUEBA" })).toContain("PT409");
      const old = await approved("FAQ");
      await rpc("plusmedik_kb_deactivate", { p_version_id: old.versionId, ...who(AA), p_reason: "PRUEBA" });
      await expire(old.versionId);
      expect(await fails("plusmedik_kb_restore", { p_version_id: old.versionId, ...who(AA2), p_reason: "PRUEBA" })).toContain("PT422");
      const live = await approved("FAQ");
      expect(await rpc("plusmedik_kb_restore", { p_version_id: live.versionId, ...who(AA2), p_reason: "PRUEBA" })).toEqual({ status: "already_approved" });
    });

    it("restaurar exige un aprobador de la clasificación: ni un editor, ni una IA, ni el aprobador de la otra clasificación", async () => {
      const d = await approved("FAQ");
      await rpc("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(AA), p_reason: "PRUEBA" });
      for (const actor of [ED, AI, CA]) expect(await fails("plusmedik_kb_restore", { p_version_id: d.versionId, ...who(actor), p_reason: "PRUEBA" }), actor.id).toContain("PT403");
    });
  });

  describe("permisos y trazabilidad", () => {
    it("UNA IA no puede aprobar, enviar, rechazar, desactivar ni restaurar; ni siquiera sus propios borradores", async () => {
      const aiDraft = await draft("FAQ", { actor: AI });
      expect(await row(aiDraft.versionId)).toMatchObject({ created_by: AI.id, created_by_type: "AI" });
      expect(await fails("plusmedik_kb_submit", { p_version_id: aiDraft.versionId, ...who(AI) })).toContain("PT403");
      await submit(aiDraft.versionId, ED); // lo envía una persona
      for (const [name, args] of [["plusmedik_kb_approve", {}], ["plusmedik_kb_reject", { p_reason: "PRUEBA" }], ["plusmedik_kb_deactivate", { p_reason: "PRUEBA" }], ["plusmedik_kb_restore", { p_reason: "PRUEBA" }]] as const) {
        expect(await fails(name, { p_version_id: aiDraft.versionId, ...who(AI), ...args }), name).toContain("PT403");
      }
      expect(await row(aiDraft.versionId)).toMatchObject({ status: "PENDING_APPROVAL" });
    });

    it("una IA puede redactar borradores administrativos y editar los suyos, pero NO contenido clínico ni borradores humanos", async () => {
      const own = await draft("POLICY", { actor: AI });
      await rpc("plusmedik_kb_edit_draft", { p_version_id: own.versionId, p_payload: { topic: "PRUEBA", title: "EDITADO POR IA", body: "TEXTO DE PRUEBA" }, ...who(AI), p_valid_until: days(10) });
      const human = await draft("POLICY");
      expect(await fails("plusmedik_kb_edit_draft", { p_version_id: human.versionId, p_payload: FIXTURES.POLICY.payload, ...who(AI) })).toContain("PT403");
      expect(await fails("plusmedik_kb_create_draft", { p_kind: "STUDY_PREPARATION", p_key: `study:${STUDY_UNKNOWN}`, p_payload: { labTestId: STUDY_UNKNOWN, prepState: "HAS_PREPARATION", instructions: "X" }, ...who(AI), p_valid_until: days(10) })).toContain("PT403");
    });

    it("el tipo de actor y el rol deben corresponderse: una persona no puede usar el rol de IA, ni la IA un rol humano; actores mal formados se rechazan", async () => {
      const payload = FIXTURES.FAQ.payload;
      const base = { p_kind: "FAQ", p_key: unique("FAQ"), p_payload: payload };
      expect(await fails("plusmedik_kb_create_draft", { ...base, p_actor_id: "crm:x", p_actor_type: "HUMAN", p_actor_role: "AI_DRAFTER" })).toContain("PT403");
      expect(await fails("plusmedik_kb_create_draft", { ...base, p_actor_id: "ai:x", p_actor_type: "AI", p_actor_role: "ADMIN_APPROVER" })).toContain("PT403");
      for (const bad of [{ p_actor_id: "", p_actor_type: "HUMAN", p_actor_role: "EDITOR" }, { p_actor_id: "con espacios", p_actor_type: "HUMAN", p_actor_role: "EDITOR" }, { p_actor_id: "crm:x", p_actor_type: "SYSTEM", p_actor_role: "EDITOR" }, { p_actor_id: "crm:x", p_actor_type: "HUMAN", p_actor_role: "ROOT" }]) {
        expect(await fails("plusmedik_kb_create_draft", { ...base, ...bad }), JSON.stringify(bad)).toContain("PT422");
      }
    });

    it("el aprobador administrativo NO puede aprobar preparación clínica (y al revés); un editor no aprueba nada", async () => {
      const prep = await draft("STUDY_PREPARATION", { key: `study:${STUDY}` }).catch(async () => undefined);
      const target = prep ?? { versionId: await db.ok(`select v.id from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id where d.key = 'study:${STUDY}' and v.status in ('DRAFT','PENDING_APPROVAL') limit 1`) };
      if (target.versionId) {
        await submit(target.versionId).catch(() => undefined);
        expect(await fails("plusmedik_kb_approve", { p_version_id: target.versionId, ...who(AA) })).toContain("PT403");
        expect(await fails("plusmedik_kb_approve", { p_version_id: target.versionId, ...who(ED2) })).toContain("PT403");
      }
      const admin = await draft("FAQ");
      await submit(admin.versionId);
      expect(await fails("plusmedik_kb_approve", { p_version_id: admin.versionId, ...who(CA) })).toContain("PT403");
      expect(await fails("plusmedik_kb_approve", { p_version_id: admin.versionId, ...who(ED2) })).toContain("PT403");
      expect(await row(admin.versionId)).toMatchObject({ status: "PENDING_APPROVAL" });
    });

    it("CUATRO OJOS: quien creó, editó o envió una versión no puede aprobarla ni rechazarla, aunque tenga el rol aprobador", async () => {
      const d = await draft("FAQ", { actor: AA }); // la creó un aprobador
      await submit(d.versionId, ED);
      expect(await fails("plusmedik_kb_approve", { p_version_id: d.versionId, ...who(AA) })).toContain("PT403");
      expect(await fails("plusmedik_kb_reject", { p_version_id: d.versionId, ...who(AA), p_reason: "PRUEBA" })).toContain("PT403");
      const e = await draft("FAQ");
      await rpc("plusmedik_kb_edit_draft", { p_version_id: e.versionId, p_payload: FIXTURES.FAQ.payload, ...who(AA2), p_valid_until: days(10) });
      await submit(e.versionId);
      expect(await fails("plusmedik_kb_approve", { p_version_id: e.versionId, ...who(AA2) })).toContain("PT403"); // editó
      expect(await approve(e.versionId, AA)).toMatchObject({ status: "approved" });
      const s = await draft("FAQ");
      await submit(s.versionId, AA2); // lo envió un aprobador
      expect(await fails("plusmedik_kb_approve", { p_version_id: s.versionId, ...who(AA2) })).toContain("PT403");
    });

    it("desactivar no exige segundo humano (retirar un dato incorrecto debe ser inmediato), pero sí el rol de la clasificación", async () => {
      const d = await draft("PAYMENT_METHOD", { actor: AA });
      await submit(d.versionId, ED);
      await approve(d.versionId, AA2);
      expect(await fails("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(ED), p_reason: "PRUEBA" })).toContain("PT403");
      expect(await fails("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(CA), p_reason: "PRUEBA" })).toContain("PT403");
      expect(await rpc("plusmedik_kb_deactivate", { p_version_id: d.versionId, ...who(AA2), p_reason: "PRUEBA" })).toMatchObject({ status: "deactivated" });
    });

    it("un permiso denegado no deja rastro: ni evento, ni cambio de estado, ni de revisión", async () => {
      const d = await draft("FAQ");
      await submit(d.versionId);
      const before = { events: await db.ok("select count(*) from public.plusmedik_kb_events"), revision: await revision() };
      await fails("plusmedik_kb_approve", { p_version_id: d.versionId, ...who(ED2) });
      await fails("plusmedik_kb_approve", { p_version_id: d.versionId, ...who(AI) });
      expect({ events: await db.ok("select count(*) from public.plusmedik_kb_events"), revision: await revision() }).toEqual(before);
      expect((await row(d.versionId)).status).toBe("PENDING_APPROVAL");
    });
  });

  describe("caducidad", () => {
    it("no se puede enviar sin caducidad ni aprobar con caducidad pasada o a más de 400 días; los mensajes de error no revelan valores", async () => {
      const noExpiry = await draft("FAQ", { validUntil: null });
      expect(await fails("plusmedik_kb_submit", { p_version_id: noExpiry.versionId, ...who(ED) })).toContain("PT422");
      const far = await draft("FAQ", { validUntil: days(401) });
      await submit(far.versionId);
      expect(await fails("plusmedik_kb_approve", { p_version_id: far.versionId, ...who(AA) })).toContain("PT422");
      const past = await draft("FAQ");
      await submit(past.versionId);
      await expire(past.versionId);
      expect(await fails("plusmedik_kb_approve", { p_version_id: past.versionId, ...who(AA) })).toContain("PT422");
      expect(await fails("plusmedik_kb_create_draft", { p_kind: "FAQ", p_key: unique("FAQ"), p_payload: FIXTURES.FAQ.payload, ...who(ED), p_valid_from: days(10), p_valid_until: days(5) })).toContain("PT422");
      const ok = await draft("FAQ", { validUntil: days(400) });
      await submit(ok.versionId);
      expect(await approve(ok.versionId)).toMatchObject({ status: "approved" });
    });

    it("la vigencia desde se fija al aprobar si estaba vacía; lo vencido sigue en la instantánea (para distinguir 'vencido' de 'inexistente') con sus fechas", async () => {
      const d = await approved("FAQ");
      const v = await row(d.versionId);
      expect(new Date(v.valid_from).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      await expire(d.versionId);
      const item = (await snapshot()).items.find((i: Json) => i.key === d.key);
      expect(item).toBeDefined();
      expect(new Date(item.validUntil).getTime()).toBeLessThan(Date.now());
    });
  });

  describe("contenido: lista blanca, sin precios y sin inventar", () => {
    const bad = async (kind: Kind, payload: Json, label: string) => expect(await fails("plusmedik_kb_create_draft", { p_kind: kind, p_key: kind === "STUDY_PREPARATION" ? `study:${payload.labTestId}` : unique(kind), p_payload: payload, ...who(ED), p_valid_until: days(30) }), label).toContain("PT422");

    it("rechaza claves desconocidas (también las de precio), tipos incorrectos, faltantes y tamaños excesivos", async () => {
      await bad("FAQ", { ...FIXTURES.FAQ.payload, priceBs: 10 }, "clave de precio");
      await bad("BRANCH", { ...FIXTURES.BRANCH.payload, precio: "x" }, "precio");
      await bad("FAQ", { question: "solo pregunta" }, "falta respuesta");
      await bad("FAQ", { question: 5, answer: "x" }, "tipo");
      await bad("FAQ", { question: "x", answer: "y".repeat(2001) }, "texto largo");
      await bad("FAQ", { question: "x", answer: "y", tags: ["MAYUSCULAS"] }, "etiqueta inválida");
      await bad("POLICY", { topic: "minusculas", title: "x", body: "y" }, "tema inválido");
      await bad("PAYMENT_METHOD", { method: "x", label: "y", accepted: "si" }, "accepted no booleano");
      await bad("BRANCH", { name: "x", address: "y", mapsUrl: "http://inseguro" }, "url http");
      await bad("BRANCH", { name: "x", address: "y", phone: "llamar" }, "teléfono");
    });

    it("rechaza TEXTOS QUE MENCIONAN IMPORTES (variaciones): los precios salen solo del catálogo", async () => {
      for (const text of ["cuesta Bs 45", "cuesta Bs. 45", "cuesta 45 Bs", "cuesta 45bs", "BOB 120", "$ 10", "$10", "10 USD", "USD 10", "45 bolivianos", "Bolivianos 45", "10 dólares", "10 dolares"]) {
        await bad("FAQ", { question: "PREGUNTA DE PRUEBA", answer: text }, text);
      }
      await bad("SCHEDULE", { ...FIXTURES.SCHEDULE.payload, exceptions: [{ date: "2027-01-01", closed: true, note: "descuento Bs 5" }] }, "importe en nota de excepción");
      // lo que NO es un importe sí se acepta (números en direcciones, teléfonos, horarios y cantidades)
      const okays = ["Calle 21 número 123", "Atención de lunes a viernes", "Hasta 3 días hábiles", "Piso 2 oficina 4"];
      for (const text of okays) {
        const d = await draft("FAQ", { payload: { question: "PREGUNTA DE PRUEBA", answer: text } });
        expect((await row(d.versionId)).status).toBe("DRAFT");
      }
    });

    it("horarios: días 0-6, HH:MM, apertura anterior al cierre, excepciones coherentes (cerrado sin horas; abierto con horas)", async () => {
      const base = FIXTURES.SCHEDULE.payload;
      for (const [label, weekly] of [["día 7", [{ day: 7, opens: "08:00", closes: "12:00" }]], ["hora 24:00", [{ day: 1, opens: "08:00", closes: "24:00" }]], ["formato", [{ day: 1, opens: "8:00", closes: "12:00" }]], ["cierre antes de apertura", [{ day: 1, opens: "12:00", closes: "08:00" }]], ["igual", [{ day: 1, opens: "08:00", closes: "08:00" }]], ["vacío", []], ["clave extra", [{ day: 1, opens: "08:00", closes: "12:00", price: 1 }]]] as const) {
        await bad("SCHEDULE", { ...base, weekly }, label);
      }
      for (const [label, exceptions] of [["cerrado con horas", [{ date: "2027-01-01", closed: true, opens: "08:00", closes: "09:00" }]], ["abierto sin horas", [{ date: "2027-01-01", closed: false }]], ["fecha inválida", [{ date: "2027-13-01", closed: true }]]] as const) {
        await bad("SCHEDULE", { ...base, exceptions }, label);
      }
      await bad("SCHEDULE", { ...base, service: "OTRO" }, "servicio desconocido");
      await bad("SCHEDULE", { ...base, timezone: "no-zona" }, "zona");
      const good = await draft("SCHEDULE", { payload: { ...base, weekly: [{ day: 1, opens: "08:00", closes: "12:00" }, { day: 1, opens: "14:00", closes: "18:00" }, { day: 6, opens: "08:00", closes: "12:00" }], exceptions: [{ date: "2027-01-01", closed: true, note: "FERIADO DE PRUEBA" }, { date: "2027-01-02", closed: false, opens: "09:00", closes: "10:00" }] } });
      expect((await row(good.versionId)).status).toBe("DRAFT");
    });

    it("PREPARACIÓN: 'sin preparación' es una afirmación explícita y exclusiva; con preparación debe decir cuál; ayuno 0-48; la clave debe coincidir con el estudio", async () => {
      const id = STUDY_UNKNOWN;
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "NO_PREPARATION_REQUIRED", instructions: "algo" }, "sin preparación con instrucciones");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "NO_PREPARATION_REQUIRED", fastingHours: 0 }, "sin preparación con ayuno");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "HAS_PREPARATION" }, "con preparación pero vacía");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "HAS_PREPARATION", fastingHours: 49 }, "ayuno 49");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "HAS_PREPARATION", fastingHours: 8.5 }, "ayuno decimal");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "HAS_PREPARATION", fastingHours: -1 }, "ayuno negativo");
      await bad("STUDY_PREPARATION", { labTestId: "no-es-uuid", prepState: "HAS_PREPARATION", instructions: "x" }, "uuid");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "DESCONOCIDO", instructions: "x" }, "estado");
      await bad("STUDY_PREPARATION", { labTestId: id, prepState: "HAS_PREPARATION", instructions: "x", priceBs: 3 }, "precio");
      expect(await fails("plusmedik_kb_create_draft", { p_kind: "STUDY_PREPARATION", p_key: `study:${STUDY}`, p_payload: { labTestId: id, prepState: "HAS_PREPARATION", instructions: "x" }, ...who(ED), p_valid_until: days(30) })).toContain("PT422"); // clave ≠ estudio
    });

    it("una clave de elemento inválida o un tipo inexistente se rechaza", async () => {
      expect(await fails("plusmedik_kb_create_draft", { p_kind: "OTRO", p_key: "faq:x", p_payload: FIXTURES.FAQ.payload, ...who(ED) })).toContain("PT422");
      for (const key of ["", "MAYUSCULAS", "con espacio", "a".repeat(97)]) expect(await fails("plusmedik_kb_create_draft", { p_kind: "FAQ", p_key: key, p_payload: FIXTURES.FAQ.payload, ...who(ED) }), key).toContain("PT422");
    });
  });

  describe("catálogo real: la preparación se vincula por lab_tests.id", () => {
    it("aprobar exige que el estudio exista y esté ACTIVO en el catálogo; no se guarda ningún precio ni se duplica el catálogo", async () => {
      for (const unknown of [STUDY_UNKNOWN, STUDY_INACTIVE]) {
        const d = await draft("STUDY_PREPARATION", { key: `study:${unknown}`, payload: { labTestId: unknown, prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" } });
        await submit(d.versionId);
        expect(await fails("plusmedik_kb_approve", { p_version_id: d.versionId, ...who(CA) }), unknown).toContain("PT422");
        expect((await row(d.versionId)).status).toBe("PENDING_APPROVAL");
      }
      const columns = await db.ok(`select string_agg(table_name || '.' || column_name, ',') from information_schema.columns where table_schema = 'public' and table_name like 'plusmedik\\_kb\\_%'`);
      expect(columns).not.toMatch(/price|precio|cost|tarifa|name_|catalog/i);
    });

    it("una preparación aprobada se entrega por la instantánea con el identificador del catálogo, y requiere un aprobador CLÍNICO distinto del autor", async () => {
      const existing = await db.ok(`select v.id from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id where d.key = 'study:${STUDY}' and v.status = 'APPROVED'`);
      let versionId = existing;
      if (!existing) {
        const d = await draft("STUDY_PREPARATION", { key: `study:${STUDY}`, actor: ED });
        await submit(d.versionId, ED);
        expect(await fails("plusmedik_kb_approve", { p_version_id: d.versionId, ...who({ ...CA, id: ED.id }) })).toContain("PT403"); // mismo id que el autor
        await approve(d.versionId, CA);
        versionId = d.versionId;
      }
      const item = (await snapshot()).items.find((i: Json) => i.kind === "STUDY_PREPARATION" && i.key === `study:${STUDY}`);
      expect(item).toMatchObject({ classification: "CLINICAL", payload: { labTestId: STUDY } });
      expect(versionId).toBeTruthy();
    });

    it("sin la tabla de catálogo (staging incompleto) NO se aprueba preparación (falla cerrado), aunque lo administrativo sí", async () => {
      const bare = await server.createDatabase("knowledge_nocatalog");
      await bare.ok(SUPABASE_BOOTSTRAP_SQL);
      for (const file of MIGRATIONS) await bare.applyFile(join(dir, file));
      const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await bare.ok(sql(name, args))).split("\n")[0]!) as Json;
      const prep = await call("plusmedik_kb_create_draft", { p_kind: "STUDY_PREPARATION", p_key: `study:${STUDY}`, p_payload: FIXTURES.STUDY_PREPARATION.payload, ...who(ED), p_valid_until: days(30) });
      await call("plusmedik_kb_submit", { p_version_id: prep.version_id, ...who(ED) });
      expect(await bare.fails(sql("plusmedik_kb_approve", { p_version_id: prep.version_id, ...who(CA) }))).toContain("PT422");
      const faq = await call("plusmedik_kb_create_draft", { p_kind: "FAQ", p_key: "faq:x", p_payload: FIXTURES.FAQ.payload, ...who(ED), p_valid_until: days(30) });
      await call("plusmedik_kb_submit", { p_version_id: faq.version_id, ...who(ED) });
      expect(await call("plusmedik_kb_approve", { p_version_id: faq.version_id, ...who(AA) })).toMatchObject({ status: "approved" });
    });
  });

  describe("concurrencia y consistencia", () => {
    it("dos borradores simultáneos del mismo elemento: exactamente uno se crea y el otro recibe 409", async () => {
      const key = unique("FAQ");
      const args = (actor: Actor) => sql("plusmedik_kb_create_draft", { p_kind: "FAQ", p_key: key, p_payload: FIXTURES.FAQ.payload, ...who(actor), p_valid_until: days(30) });
      const [a, b] = await Promise.all([db.psql(args(ED)), db.psql(args(ED2))]);
      expect([a.code, b.code].sort()).toEqual([0, 3]);
      expect(await db.ok(`select count(*) from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id where d.key = '${key}'`)).toBe("1");
      expect(`${a.stderr}${b.stderr}`).toContain("PT409");
    });

    it("dos aprobaciones simultáneas de la misma versión por aprobadores distintos: una gana y la otra recibe 409; la revisión sube una sola vez", async () => {
      const d = await draft("FAQ");
      await submit(d.versionId);
      const start = await revision();
      const slow = db.psql(`set role service_role; begin; select public.plusmedik_kb_approve(p_version_id => '${d.versionId}', p_actor_id => '${AA.id}', p_actor_type => 'HUMAN', p_actor_role => 'ADMIN_APPROVER'); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const fast = db.psql(sql("plusmedik_kb_approve", { p_version_id: d.versionId, ...who(AA2) }));
      const [x, y] = await Promise.all([slow, fast]);
      expect(x.code).toBe(0);
      expect(y.code).not.toBe(0);
      expect(y.stderr).toContain("PT409");
      expect(await revision()).toBe(start + 1);
      expect((await row(d.versionId)).approved_by).toBe(AA.id);
    });

    it("aprobar la versión 2 mientras otro desactiva la 1: se serializan, queda una sola aprobada y la revisión refleja cada cambio efectivo", async () => {
      const v1 = await approved("FAQ");
      const v2 = await draft("FAQ", { key: v1.key, payload: { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA NUEVA DE PRUEBA" } });
      await submit(v2.versionId);
      const start = await revision();
      const slow = db.psql(`set role service_role; begin; select public.plusmedik_kb_approve(p_version_id => '${v2.versionId}', p_actor_id => '${AA2.id}', p_actor_type => 'HUMAN', p_actor_role => 'ADMIN_APPROVER'); select pg_sleep(1.5); commit;`);
      await sleep(500);
      const fast = db.psql(sql("plusmedik_kb_deactivate", { p_version_id: v1.versionId, ...who(AA), p_reason: "PRUEBA" }));
      const [a, b] = await Promise.all([slow, fast]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(JSON.parse(b.stdout.split("\n")[0]!).status).toBe("already_inactive"); // ya la había reemplazado la aprobación
      expect(await db.ok(`select count(*) from public.plusmedik_kb_versions v join public.plusmedik_kb_documents d on d.id = v.document_id where d.key = '${v1.key}' and v.status = 'APPROVED'`)).toBe("1");
      expect(await revision()).toBe(start + 1);
    });

    it("la instantánea es consistente: mientras una aprobación no se confirma, revisión y contenido son los anteriores; al confirmarse, ambos cambian a la vez", async () => {
      const d = await draft("FAQ");
      await submit(d.versionId);
      const before = await snapshot();
      const slow = db.psql(`set role service_role; begin; select public.plusmedik_kb_approve(p_version_id => '${d.versionId}', p_actor_id => '${AA.id}', p_actor_type => 'HUMAN', p_actor_role => 'ADMIN_APPROVER'); select pg_sleep(1.5); commit;`);
      await sleep(600);
      const during = await snapshot();
      expect(during.revision).toBe(before.revision);
      expect(during.items.some((i: Json) => i.key === d.key)).toBe(false);
      await slow;
      const after = await snapshot();
      expect(after.revision).toBe(before.revision + 1);
      expect(after.items.some((i: Json) => i.key === d.key)).toBe(true);
    });

    it("la revisión es monótona y sin saltos bajo varias aprobaciones simultáneas de elementos distintos", async () => {
      const drafts = [];
      for (let i = 0; i < 5; i++) { const d = await draft("PAYMENT_METHOD"); await submit(d.versionId); drafts.push(d); }
      const start = await revision();
      const results = await Promise.all(drafts.map((d) => db.psql(sql("plusmedik_kb_approve", { p_version_id: d.versionId, ...who(AA) }))));
      expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0, 0]);
      const seen = results.map((r) => JSON.parse(r.stdout.split("\n")[0]!).revision as number).sort((a, b) => a - b);
      expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => start + n));
    });
  });

  describe("lista e historial para la administración", () => {
    it("lista por estado y tipo (con tope) y rechaza filtros inválidos; el historial devuelve versiones y eventos en orden", async () => {
      const d = await draft("POLICY");
      await submit(d.versionId);
      const pending = (await rpc("plusmedik_kb_list", { p_status: "PENDING_APPROVAL", p_kind: "POLICY", p_limit: 500 })).items as Json[];
      expect(pending.some((i) => i.key === d.key && i.status === "PENDING_APPROVAL" && i.classification === "ADMINISTRATIVE")).toBe(true);
      expect(pending.every((i) => i.status === "PENDING_APPROVAL" && i.kind === "POLICY")).toBe(true);
      expect(((await rpc("plusmedik_kb_list", { p_limit: 1 })).items as Json[]).length).toBe(1);
      for (const bad of [{ p_status: "OTRO" }, { p_kind: "OTRO" }, { p_limit: 0 }, { p_limit: 501 }]) expect(await fails("plusmedik_kb_list", bad), JSON.stringify(bad)).toContain("PT422");
      const history = await rpc("plusmedik_kb_history", { p_kind: "POLICY", p_key: d.key });
      expect(history.versions).toHaveLength(1);
      expect((history.events as Json[]).map((e) => e.event)).toEqual(["CREATED", "SUBMITTED"]);
      expect(await rpc("plusmedik_kb_history", { p_kind: "POLICY", p_key: "no-existe" })).toEqual({ versions: [], events: [] });
    });
  });
});

describe("la migración 8 es aditiva y no cambia nada anterior", () => {
  const sha = (name: string) => createHash("sha256").update(read(name)).digest("hex");
  const code = read(KNOWLEDGE).replace(/--.*$/gm, "");

  it("es la última y las siete anteriores no se modificaron (hashes fijados)", () => {
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
    expect(files[7]).toBe(KNOWLEDGE); // posición absoluta: las migraciones posteriores (la 9 de trazabilidad) no la desplazan
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(Object.fromEntries(files.slice(0, 7).map((name) => [name, sha(name)]))).toEqual({
      "20261020000000_plusmedik_persistent_audit.sql": "1110edc1e1b3f6c4961b87bdb763ecea535ef5b1d6ba9086ff314a86b88ad61a",
      "20261021000000_plusmedik_audit_telemetry.sql": "08e555cf0c872ce2380cbd5046c2296a525c20b6caaddee6ae51ccdb53243256",
      "20261022000000_plusmedik_audit_transactional.sql": "1135f673e0a8e5de5ef03dae1acae55427c01ff99f4a5988f90595abe9244079",
      "20261023000000_plusmedik_audit_leases.sql": "1b6546c2a44142a00b771f303dccc43f5ea408cd912a340c3b3e406e63185ee7",
      "20261024000000_plusmedik_human_control.sql": "21430ed091a169945d1f5b9109484c11a34a5d7e9981d715dc2c83c36fc9658d",
      "20261025000000_plusmedik_turns.sql": "2db27531909ec6d2a3d394dba41aa705ae226f5b37bac9985a17de109e08af13",
      "20261026000000_plusmedik_turn_recovery.sql": "034f4ee6769c5537490aa881e96ba39221a9009ca4aedd6967c1aaa04ee02318"
    });
  });

  it("no siembra datos: sin INSERT a tablas de conocimiento (solo el contador de revisión dentro de plusmedik_kb_bump), sin UPDATE/DELETE/TRUNCATE de datos ajenos", () => {
    const inserts = [...code.matchAll(/insert\s+into\s+public\.(\w+)/gi)].map((match) => match[1]);
    expect(new Set(inserts)).toEqual(new Set(["plusmedik_kb_state", "plusmedik_kb_documents", "plusmedik_kb_versions", "plusmedik_kb_events"]));
    // los INSERT de documentos, versiones y eventos están dentro de funciones (no a nivel de script): ninguno antes del primer "create or replace function" que los contiene
    const topLevel = code.split(/create or replace function/i)[0]!;
    expect(topLevel).not.toMatch(/insert\s+into/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\s+(table\s+)?public/i);
    expect(code).not.toMatch(/\bdrop\s+/i);
    // solo se altera (RLS) lo que esta misma migración creó
    expect(code).not.toMatch(/\balter\s+table\s+(?!public\.plusmedik_kb_)/i);
    expect(code).not.toMatch(/\bexecute\s+(format|'|\()/i);
  });

  it("no escribe en el catálogo ni en el esquema del CRM: lab_tests solo aparece en SELECT/EXISTS y no hay claves foráneas hacia él", () => {
    expect(code).not.toMatch(/\bcrm\./);
    expect(code).not.toMatch(/lab_test_aliases/);
    for (const match of code.matchAll(/lab_tests/g)) {
      const around = code.slice(Math.max(0, match.index! - 60), match.index! + 20);
      expect(around, around).toMatch(/from public\.lab_tests|to_regclass\('public\.lab_tests'\)/);
    }
    expect(code).not.toMatch(/references\s+public\.lab_tests/i);
  });

  it("toda función SECURITY DEFINER fija su search_path y ninguna queda ejecutable por PUBLIC (se revocan explícitamente)", () => {
    for (const definition of code.split(/create or replace function/i).slice(1)) if (/security definer/i.test(definition)) expect(definition).toMatch(/set search_path = ''/);
    for (const name of ["create_draft", "edit_draft", "submit", "reject", "approve", "deactivate", "restore", "revision", "snapshot", "history", "list"]) {
      expect(code).toMatch(new RegExp(`revoke all on function public\\.plusmedik_kb_${name}\\(`));
    }
  });
});
