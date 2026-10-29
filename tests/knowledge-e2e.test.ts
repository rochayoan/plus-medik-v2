import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createKnowledgeAdminRepository, KnowledgeAdminError, type KnowledgeActor, type KnowledgeAdminRepository } from "../src/knowledge/admin.js";
import { createSupabaseKnowledgeStore, KnowledgeService } from "../src/knowledge/index.js";
import { PAYLOAD_SCHEMAS, type KnowledgeKind } from "../src/knowledge/types.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// El conocimiento de extremo a extremo: cliente de ADMINISTRACIÓN real (contrato del CRM) + servicio de LECTURA real + PostgreSQL real con las ocho migraciones. Los datos son
// fixtures de PRUEBA. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[knowledge-e2e] PostgreSQL no disponible: se omiten los escenarios del conocimiento contra la base real.");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const STUDY = "11111111-1111-4111-8111-111111111111";
const STUDY_2 = "22222222-2222-4222-8222-222222222222";
const ED: KnowledgeActor = { id: "crm:editor-1", type: "HUMAN", role: "EDITOR" };
const AA: KnowledgeActor = { id: "crm:admin-1", type: "HUMAN", role: "ADMIN_APPROVER" };
const AA2: KnowledgeActor = { id: "crm:admin-2", type: "HUMAN", role: "ADMIN_APPROVER" };
const CA: KnowledgeActor = { id: "crm:clinical-1", type: "HUMAN", role: "CLINICAL_APPROVER" };
const AI: KnowledgeActor = { id: "ai:drafter-1", type: "AI", role: "AI_DRAFTER" };
const CATALOG = [{ id: STUDY, name: "ESTUDIO DE PRUEBA", active: true }, { id: STUDY_2, name: "OTRO ESTUDIO DE PRUEBA", active: true }];
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!bin)("conocimiento de extremo a extremo (administración → base → servicio)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let admin: KnowledgeAdminRepository;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("knowledge_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    await db.ok(`create table public.lab_tests (id uuid primary key, name text not null, price_bs numeric not null, active boolean not null); insert into public.lab_tests values ('${STUDY}', 'ESTUDIO DE PRUEBA', 1, true), ('${STUDY_2}', 'OTRO ESTUDIO DE PRUEBA', 1, true);`);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
    admin = createKnowledgeAdminRepository(rpcOptions());
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 20_000 });
  const reader = (options: { now?: () => Date; revisionCheckMs?: number; maxStaleMs?: number } = {}) => new KnowledgeService({ store: createSupabaseKnowledgeStore(rpcOptions()), revisionCheckMs: 0, maxStaleMs: 60_000, ...options });
  const key = (prefix: string) => `${prefix}-${++counter}`;

  async function publish(kind: KnowledgeKind, k: string, payload: unknown, approver: KnowledgeActor = AA, validUntil: Date = days(60)) {
    const draft = await admin.createDraft({ kind, key: k, payload, sourceRef: "prueba:fixture", validUntil }, ED);
    await admin.submit(draft.versionId, ED);
    const result = await admin.approve(draft.versionId, approver);
    return { ...draft, revision: result.revision };
  }

  it("el flujo completo: el CRM redacta, envía y aprueba; el agente lo lee con procedencia; lo clínico exige un aprobador clínico", async () => {
    const branchKey = key("branch");
    const reading = reader();
    expect((await reading.getBranch(branchKey)).status).toBe("UNAVAILABLE");
    await publish("BRANCH", branchKey, { name: "SUCURSAL DE PRUEBA", address: "DIRECCION DE PRUEBA 000" });
    await publish("SCHEDULE", `schedule:${branchKey}:office`, { branchKey, service: "OFFICE", timezone: "America/La_Paz", weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: "00:00", closes: "23:59" })) });
    await publish("PAYMENT_METHOD", `payment:${key("metodo")}`, { method: "prueba", label: "METODO DE PRUEBA", accepted: true });
    const status = await reading.getScheduleStatus({ branchKey, service: "OFFICE" });
    expect(status).toMatchObject({ status: "AVAILABLE", data: { open: true }, provenance: [{ kind: "BRANCH" }, { kind: "SCHEDULE", version: 1, approvedBy: AA.id }] });

    // preparación clínica
    const clinical = await admin.createDraft({ kind: "STUDY_PREPARATION", key: `study:${STUDY}`, payload: { labTestId: STUDY, prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" }, validUntil: days(60) }, ED);
    await admin.submit(clinical.versionId, ED);
    await expect(admin.approve(clinical.versionId, AA)).rejects.toMatchObject({ code: "FORBIDDEN" }); // un aprobador administrativo no aprueba lo clínico
    expect((await reading.getStudyPreparation([STUDY], CATALOG)).items[0]!.result.status).toBe("UNAVAILABLE"); // sigue sin estar aprobado
    expect(await admin.approve(clinical.versionId, CA)).toMatchObject({ status: "approved" });
    const prep = await reading.getStudyPreparation([STUDY, STUDY_2], CATALOG);
    expect(prep.status).toBe("PARTIAL");
    expect(prep.items[0]!.result).toMatchObject({ status: "AVAILABLE", data: { studyName: "ESTUDIO DE PRUEBA", fastingHours: 8 }, provenance: [{ approvedBy: CA.id }] });
    expect(prep.items[1]!.result).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION" });
  });

  it("INVALIDACIÓN: aprobar una versión nueva, retirar y restaurar se ven en el servicio en cuanto vence el plazo de revisión, y la revisión sube exactamente en cada cambio", async () => {
    const k = key("policy");
    const reading = reader({ revisionCheckMs: 0 });
    const v1 = await publish("POLICY", k, { topic: "INVALIDACION", title: "POLITICA DE PRUEBA", body: "VERSION UNO DE PRUEBA" });
    const read = async () => { const result = await reading.getPolicy("INVALIDACION"); return result.status === "AVAILABLE" ? result.data.body : result.reason; };
    expect(await read()).toBe("VERSION UNO DE PRUEBA");
    const revisionAfterV1 = reading.cachedRevision!;

    const v2 = await admin.createDraft({ kind: "POLICY", key: k, payload: { topic: "INVALIDACION", title: "POLITICA DE PRUEBA", body: "VERSION DOS DE PRUEBA" }, validUntil: days(60) }, ED);
    await admin.submit(v2.versionId, ED);
    expect(await read()).toBe("VERSION UNO DE PRUEBA"); // lo pendiente NO se entrega y no cambia la revisión
    expect(reading.cachedRevision).toBe(revisionAfterV1);
    await admin.approve(v2.versionId, AA2);
    expect(await read()).toBe("VERSION DOS DE PRUEBA");
    expect(reading.cachedRevision).toBe(revisionAfterV1 + 1);

    await admin.deactivate(v2.versionId, AA, "DATO_INCORRECTO");
    expect(await read()).toBe("NO_APPROVED_VERSION");
    await admin.restore(v1.versionId, AA2, "RECUPERACION");
    expect(await read()).toBe("VERSION UNO DE PRUEBA"); // se recuperó EXACTAMENTE la aprobada antes
    expect(reading.cachedRevision).toBe(revisionAfterV1 + 3);
  });

  it("dos instancias del agente (dos cachés) convergen a la misma revisión tras un cambio, y una desactivación se propaga a ambas", async () => {
    const k = key("faq");
    const [a, b] = [reader({ revisionCheckMs: 0 }), reader({ revisionCheckMs: 0 })];
    const version = await publish("FAQ", k, { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA" });
    expect((await Promise.all([a.getFaq(k), b.getFaq(k)])).every((r) => r.status === "AVAILABLE")).toBe(true);
    await admin.deactivate(version.versionId, AA2, "DATO_INCORRECTO");
    const after = await Promise.all([a.getFaq(k), b.getFaq(k)]);
    expect(after.map((r) => (r.status === "UNAVAILABLE" ? r.reason : "AVAILABLE"))).toEqual(["NO_APPROVED_VERSION", "NO_APPROVED_VERSION"]);
    expect(a.cachedRevision).toBe(b.cachedRevision);
  });

  it("CADUCIDAD: lo aprobado deja de entregarse al llegar su fecha aunque nadie lo retire ni cambie la revisión (reloj controlado)", async () => {
    const k = key("faq");
    const clock = { now: new Date() };
    const reading = reader({ now: () => clock.now, revisionCheckMs: 3_600_000 });
    await publish("FAQ", k, { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA" }, AA, days(10));
    // valid_from es el instante de la APROBACIÓN en el reloj de la base: un lector con el reloj unos milisegundos atrasado aún no lo ve (falla cerrado)
    clock.now = new Date(Date.now() + 1000);
    expect((await reading.getFaq(k)).status).toBe("AVAILABLE");
    clock.now = new Date(clock.now.getTime() + 10 * 86_400_000 + 1000);
    expect(await reading.getFaq(k)).toMatchObject({ status: "UNAVAILABLE", reason: "EXPIRED" });
  });

  it("PERMISOS vistos por el cliente: IA, editor, autor y aprobador de la otra clasificación reciben FORBIDDEN; conflicto, no encontrado y contenido inválido tienen su código; nada queda aprobado", async () => {
    const k = key("faq");
    const draft = await admin.createDraft({ kind: "FAQ", key: k, payload: { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA" }, validUntil: days(30) }, AI);
    await expect(admin.submit(draft.versionId, AI)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await admin.submit(draft.versionId, ED);
    for (const actor of [AI, ED, CA]) await expect(admin.approve(draft.versionId, actor), actor.id).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.createDraft({ kind: "FAQ", key: k, payload: { question: "OTRA", answer: "OTRA" }, validUntil: days(30) }, ED)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(admin.approve("00000000-0000-4000-8000-000000000000", AA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.createDraft({ kind: "FAQ", key: key("faq"), payload: { question: "x", answer: "cuesta Bs 45" } }, ED)).rejects.toBeInstanceOf(KnowledgeAdminError); // el cliente ya lo rechaza
    await expect(admin.createDraft({ kind: "FAQ", key: key("faq"), payload: { question: "x", answer: "y" }, validUntil: days(30) }, { id: "crm:x", type: "HUMAN", role: "AI_DRAFTER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await reader().getFaq(k)).toMatchObject({ status: "UNAVAILABLE", reason: "NO_APPROVED_VERSION" });
    const history = await admin.history("FAQ", k);
    expect(history.events.map((e) => e.event)).toEqual(["CREATED", "SUBMITTED"]); // los intentos denegados no dejan rastro
  });

  it("una IA redacta, una persona revisa y otra aprueba: queda la trazabilidad completa en la bitácora", async () => {
    const k = key("faq");
    const draft = await admin.createDraft({ kind: "FAQ", key: k, payload: { question: "PREGUNTA DE PRUEBA", answer: "BORRADOR DE IA DE PRUEBA" }, validUntil: days(30) }, AI);
    await admin.editDraft(draft.versionId, { payload: { question: "PREGUNTA DE PRUEBA", answer: "CORREGIDO POR UNA PERSONA DE PRUEBA" }, validUntil: days(30) }, ED, "FAQ");
    await admin.submit(draft.versionId, ED);
    await admin.approve(draft.versionId, AA);
    const history = await admin.history("FAQ", k);
    expect(history.events.map((e) => [e.event, e.actorId, e.actorType])).toEqual([["CREATED", AI.id, "AI"], ["EDITED", ED.id, "HUMAN"], ["SUBMITTED", ED.id, "HUMAN"], ["APPROVED", AA.id, "HUMAN"]]);
    expect(history.versions[0]).toMatchObject({ createdByType: "AI", approvedBy: AA.id });
  });

  it("la lista de pendientes para el CRM filtra por estado y tipo", async () => {
    const k = key("policy");
    const draft = await admin.createDraft({ kind: "POLICY", key: k, payload: { topic: "PENDIENTE", title: "POLITICA DE PRUEBA", body: "TEXTO DE PRUEBA" }, validUntil: days(30) }, ED);
    await admin.submit(draft.versionId, ED);
    const pending = await admin.list({ status: "PENDING_APPROVAL", kind: "POLICY" });
    expect(pending.some((entry) => entry.key === k)).toBe(true);
    expect(pending.every((entry) => entry.status === "PENDING_APPROVAL")).toBe(true);
  });

  it("la base caída: el servicio con copia sigue (hasta el plazo) y sin copia no responde; la administración informa UNAVAILABLE sin suponer que se guardó", async () => {
    const k = key("faq");
    await publish("FAQ", k, { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA" });
    const reading = reader({ revisionCheckMs: 0, maxStaleMs: 60_000 });
    expect((await reading.getFaq(k)).status).toBe("AVAILABLE");
    network.down = true;
    try {
      expect((await reading.getFaq(k)).status).toBe("AVAILABLE");
      expect(await reader().getFaq(k)).toMatchObject({ status: "UNAVAILABLE", reason: "STORE_UNAVAILABLE" });
      await expect(admin.createDraft({ kind: "FAQ", key: key("faq"), payload: { question: "x", answer: "y" }, validUntil: days(30) }, ED)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      network.down = false;
    }
  });

  it("lecturas concurrentes mientras se aprueba: cada lectura ve la versión anterior COMPLETA o la nueva COMPLETA, nunca una mezcla ni un error", async () => {
    const k = key("policy");
    await publish("POLICY", k, { topic: "CONCURRENTE", title: "TITULO UNO DE PRUEBA", body: "CUERPO UNO DE PRUEBA" });
    const draft = await admin.createDraft({ kind: "POLICY", key: k, payload: { topic: "CONCURRENTE", title: "TITULO DOS DE PRUEBA", body: "CUERPO DOS DE PRUEBA" }, validUntil: days(60) }, ED);
    await admin.submit(draft.versionId, ED);
    const approving = (async () => { await sleep(100); await admin.approve(draft.versionId, AA2); })();
    const seen: string[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await reader().getPolicy("CONCURRENTE");
      expect(result.status).toBe("AVAILABLE");
      if (result.status === "AVAILABLE") seen.push(`${result.data.title}|${result.data.body}`);
      if (seen.length > 8 && seen.at(-1)!.startsWith("TITULO DOS")) break;
    }
    await approving;
    expect(new Set(seen)).toEqual(new Set(["TITULO UNO DE PRUEBA|CUERPO UNO DE PRUEBA", "TITULO DOS DE PRUEBA|CUERPO DOS DE PRUEBA"]));
    // una vez que se ve la nueva, no se vuelve a ver la vieja
    const firstNew = seen.findIndex((entry) => entry.startsWith("TITULO DOS"));
    expect(seen.slice(firstNew).every((entry) => entry.startsWith("TITULO DOS"))).toBe(true);
  });

  describe("el validador SQL y el esquema de TypeScript aceptan y rechazan LO MISMO (prueba diferencial)", () => {
    const U = STUDY;
    const corpus: Array<[KnowledgeKind, unknown]> = [
      ["BRANCH", { name: "A", address: "B" }], ["BRANCH", { name: "A", address: "B", mapsUrl: "https://x.test/m", phone: "+591 7000 0000", notes: "N" }], ["BRANCH", { name: "A" }], ["BRANCH", { name: "A", address: "B", extra: 1 }],
      ["BRANCH", { name: "A", address: "B", mapsUrl: "http://x.test" }], ["BRANCH", { name: "A", address: "B", phone: "abc" }], ["BRANCH", { name: "", address: "B" }], ["BRANCH", { name: "A", address: "Bs 45" }], ["BRANCH", { name: 1, address: "B" }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 0, opens: "00:00", closes: "23:59" }] }],
      ["SCHEDULE", { branchKey: "b", service: "HUMAN_SUPPORT", timezone: "America/La_Paz", weekly: [{ day: 6, opens: "08:00", closes: "09:00" }], exceptions: [{ date: "2027-02-28", closed: true }, { date: "2027-03-01", closed: false, opens: "10:00", closes: "11:00", note: "N" }], notes: "N" }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [] }], ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 7, opens: "08:00", closes: "09:00" }] }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "09:00", closes: "08:00" }] }], ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "9:00", closes: "10:00" }] }],
      ["SCHEDULE", { branchKey: "b", service: "OTRO", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }] }], ["SCHEDULE", { branchKey: "B", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }] }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "UTC", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }] }], ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }], exceptions: [{ date: "2027-02-30", closed: true }] }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }], exceptions: [{ date: "2027-02-28", closed: true, opens: "08:00", closes: "09:00" }] }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }], exceptions: [{ date: "2027-02-28", closed: false }] }],
      ["SCHEDULE", { branchKey: "b", service: "OFFICE", timezone: "America/La_Paz", weekly: [{ day: 1, opens: "08:00", closes: "09:00" }], exceptions: [{ date: "2027-02-28", closed: true, note: "descuento Bs 5" }] }],
      ["POLICY", { topic: "ABC", title: "T", body: "B" }], ["POLICY", { topic: "abc", title: "T", body: "B" }], ["POLICY", { topic: "A", title: "T", body: "B" }], ["POLICY", { topic: "ABC", title: "T" }], ["POLICY", { topic: "ABC", title: "T", body: "cuesta $5" }],
      ["PAYMENT_METHOD", { method: "efectivo", label: "L", accepted: true }], ["PAYMENT_METHOD", { method: "Efectivo", label: "L", accepted: true }], ["PAYMENT_METHOD", { method: "e", label: "L", accepted: "si" }], ["PAYMENT_METHOD", { method: "e", label: "L" }],
      ["FAQ", { question: "Q", answer: "A" }], ["FAQ", { question: "Q", answer: "A", tags: ["a", "b-c", "d_e"] }], ["FAQ", { question: "Q", answer: "A", tags: ["A"] }], ["FAQ", { question: "Q", answer: "A", tags: Array(13).fill("a") }], ["FAQ", { question: "Q", answer: "10 dólares" }], ["FAQ", { question: "Q", answer: "A".repeat(2000) }], ["FAQ", { question: "Q", answer: "A".repeat(2001) }], ["FAQ", { question: "Q", answer: "45 bolivianos" }], ["FAQ", { question: "Q", answer: "Piso 2 oficina 4" }], ["FAQ", { question: "Q", answer: "A", priceBs: 3 }],
      ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", instructions: "I" }], ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", fastingHours: 12 }], ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", fastingHours: 0, instructions: "I", collectionWindow: "W" }],
      ["STUDY_PREPARATION", { labTestId: U, prepState: "NO_PREPARATION_REQUIRED" }], ["STUDY_PREPARATION", { labTestId: U, prepState: "NO_PREPARATION_REQUIRED", fastingHours: 0 }], ["STUDY_PREPARATION", { labTestId: U, prepState: "NO_PREPARATION_REQUIRED", instructions: "I" }],
      ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION" }], ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", fastingHours: 49 }], ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", fastingHours: 8.5 }], ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", fastingHours: -1, instructions: "I" }],
      ["STUDY_PREPARATION", { labTestId: "x", prepState: "HAS_PREPARATION", instructions: "I" }], ["STUDY_PREPARATION", { labTestId: U.toUpperCase(), prepState: "HAS_PREPARATION", instructions: "I" }], ["STUDY_PREPARATION", { labTestId: U, prepState: "OTRO", instructions: "I" }], ["STUDY_PREPARATION", { labTestId: U, prepState: "HAS_PREPARATION", instructions: "I", priceBs: 1 }]
    ];

    it(`${corpus.length} contenidos: el resultado de plusmedik_kb_payload_ok (SQL) coincide con el de zod (TypeScript) en cada uno`, async () => {
      const mismatches: string[] = [];
      let accepted = 0;
      for (const [kind, payload] of corpus) {
        const sqlOk = (await db.ok(`select public.plusmedik_kb_payload_ok('${kind}', $j$${JSON.stringify(payload)}$j$::jsonb)`)) === "t";
        const tsOk = PAYLOAD_SCHEMAS[kind].safeParse(payload).success;
        if (sqlOk) accepted++;
        if (sqlOk !== tsOk) mismatches.push(`${kind} ${JSON.stringify(payload).slice(0, 110)} → SQL=${sqlOk} TS=${tsOk}`);
      }
      expect(mismatches).toEqual([]);
      expect(accepted).toBeGreaterThan(10);
      expect(corpus.length - accepted).toBeGreaterThan(25);
    });
  });
});
