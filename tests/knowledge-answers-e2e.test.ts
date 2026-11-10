import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import { appendApprovedQuotePreparations } from "../src/quote-preparation.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { createKnowledgeAdminRepository, type KnowledgeActor, type KnowledgeAdminRepository } from "../src/knowledge/admin.js";
import { createSupabaseKnowledgeStore, KnowledgeService, type KnowledgeKind } from "../src/knowledge/index.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { gate } from "./support/faults.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Respuestas con conocimiento de extremo a extremo: cliente de ADMINISTRACIÓN real (publica y retira) + webhook real + manejador real + servicio de conocimiento real +
// repositorios reales + PostgreSQL real con las NUEVE migraciones. Kapso y el motor de recetas son simulaciones. Todos los datos son fixtures de PRUEBA.

const bin = findPostgresBin();
if (!bin) console.warn("[knowledge-answers-e2e] PostgreSQL no disponible: se omiten los escenarios de respuestas con conocimiento contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_3157";
const STUDY = "11111111-1111-4111-8111-111111111111";
const PILOT_STUDY = "33333333-3333-4333-8333-333333333333";
const ED: KnowledgeActor = { id: "crm:editor-1", type: "HUMAN", role: "EDITOR" };
const AA: KnowledgeActor = { id: "crm:admin-1", type: "HUMAN", role: "ADMIN_APPROVER" };
const AA2: KnowledgeActor = { id: "crm:admin-2", type: "HUMAN", role: "ADMIN_APPROVER" };
const CA: KnowledgeActor = { id: "crm:clinical-1", type: "HUMAN", role: "CLINICAL_APPROVER" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]);
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const okAnalysis = () => ({ decision: "AUTO_SAFE", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome: "AUTO_COMPLETE", publicQuote: { studies: [{ name: "HEMOGRAMA", priceBs: 45 }], totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" } }) as AnalysisResult;

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "image", from: phone, image: { id: "media-1" }, kapso: { ...inbound, has_media: true, media_url: "https://example.test/img.jpg" } }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };

describe.skipIf(!bin)("respuestas con conocimiento aprobado (extremo a extremo contra PostgreSQL real)", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let admin: KnowledgeAdminRepository;
  let counter = 0;
  const network = newNetwork();
  let catalog: CatalogStudy[];

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("knowledge_answers");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    await db.ok(`create table public.lab_tests (id uuid primary key, name text not null, price_bs numeric not null, active boolean not null); insert into public.lab_tests values ('${STUDY}', 'ESTUDIO ALFA DE PRUEBA', 1, true), ('${PILOT_STUDY}', 'ESTUDIO PILOTO FICTICIO', 45, true);`);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
    admin = createKnowledgeAdminRepository(rpcOptions());
    catalog = [{ id: STUDY, code: null, name: "ESTUDIO ALFA DE PRUEBA", normalizedName: normalizeStudyKey("ESTUDIO ALFA DE PRUEBA"), normalizedAliases: ["alfa"], priceBs: 1, active: true }];
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 20_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  // Un mundo de conocimiento por prueba (claves únicas): cada prueba publica lo que necesita.
  const world = () => {
    const tag = `t${++counter}`;
    return { branchKey: `branch-${tag}`, scheduleKey: `schedule:${tag}:office`, payKey: `payment:${tag}`, prepKey: `study:${STUDY}`, tag };
  };
  async function publish(kind: KnowledgeKind, key: string, payload: unknown, approver: KnowledgeActor = AA) {
    const draft = await admin.createDraft({ kind, key, payload, sourceRef: "prueba:fixture", validUntil: days(60) }, ED);
    await admin.submit(draft.versionId, ED);
    await admin.approve(draft.versionId, approver);
    return draft;
  }
  const publishOffice = async (w: ReturnType<typeof world>) => {
    const b = await publish("BRANCH", w.branchKey, { name: `SUCURSAL ${w.tag.toUpperCase()} DE PRUEBA`, address: "DIRECCION DE PRUEBA" });
    const s = await publish("SCHEDULE", w.scheduleKey, { branchKey: w.branchKey, service: "OFFICE", timezone: "America/La_Paz", weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: "08:00", closes: "12:00" })) });
    return { b, s };
  };

  // Cada instalación nueva ve SOLO su mundo: el servicio lee toda la base, así que las pruebas usan un contacto nuevo y consultan por temas que su mundo define. Para aislar los
  // horarios entre pruebas se usa una base por escenario cuando importa; aquí se aprovecha que las preguntas de cada prueba son sobre su propio conjunto.
  function setup(options: { service?: KnowledgeService; wrap?: (inner: (turn: never) => Promise<unknown>) => (turn: never) => Promise<unknown>; quote?: Partial<QuoteDeps>; now?: () => Date } = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const service = options.service ?? new KnowledgeService({ store: createSupabaseKnowledgeStore(rpcOptions()), revisionCheckMs: 0, maxStaleMs: 60_000, now: options.now });
    const inner = createTextHandler({ log, knowledge: { service, loadCatalog: async () => catalog, now: options.now } });
    const text = options.wrap ? (options.wrap(inner as never) as typeof inner) : inner;
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: jpeg })), loadCatalog: vi.fn(async () => []), analyze: vi.fn(async () => okAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor, handlers: { text }, busyDelayMs: 20, busyRetries: 400 }, ...options.quote
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { quote, sends, logs, scheduled, service, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const refsOf = async (message: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(f order by f.kind, f.key), '[]') from public.plusmedik_turn_knowledge_refs f join public.plusmedik_audit_runs r on r.id = f.run_id where r.kapso_message_id = '${message}'`));
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  const usage = async (kind: string, key: string, version: number | null = null): Promise<Array<Record<string, any>>> => (JSON.parse((await db.ok(`set role service_role; select public.plusmedik_kb_usage('${kind}', '${key}', ${version ?? "null"}, 100);`)).split("\n")[0]!) as { uses: Array<Record<string, any>> }).uses;
  const ask = async (w: ReturnType<typeof setup>, phone: string, text: string, message = id("txt")) => {
    expect((await w.hook(signedPost(textEvent(message, phone, text), RECEIVED))).status).toBe(200);
    await w.settle();
    return message;
  };

  it("publicado → preguntado → respondido con el dato aprobado; el rastro queda en la base ANTES del envío y la consulta de impacto encuentra a quién se le dijo", async () => {
    const k = world();
    const { s } = await publishOffice(k);
    const p = patient();
    const w = setup();
    const message = await ask(w, p.phone, `¿cuál es el horario? ${SENTINEL}`);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.body).toContain(`*SUCURSAL ${k.tag.toUpperCase()} DE PRUEBA* — Horario de atención`);
    expect(w.sends[0]!.body).toContain("Lunes: 08:00 a 12:00");
    expect(await run(message)).toMatchObject({ send_kind: "conversation", send_state: "ACCEPTED", contact_key: p.key });
    const refs = await refsOf(message);
    expect(refs.map((ref) => [ref.kind, ref.key, ref.version, ref.lease_fence]).filter(([kind, key]) => key === k.branchKey || key === k.scheduleKey)).toEqual([["BRANCH", k.branchKey, 1, 1], ["SCHEDULE", k.scheduleKey, 1, 1]]);
    // impacto: si esta versión del horario resultara incorrecta, ¿a quién se le dijo?
    const used = await usage("SCHEDULE", k.scheduleKey, 1);
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ contactKey: p.key, sendState: "ACCEPTED", replyState: "ACCEPTED" });
    // privacidad: ni el texto del paciente ni el de la respuesta ni su teléfono en ninguna tabla ni log
    const dump = await db.ok(`select string_agg(t, ' ') from (select to_json(x)::text t from public.plusmedik_audit_runs x union all select to_json(x)::text from public.plusmedik_turn_knowledge_refs x union all select to_json(x)::text from public.plusmedik_audit_checks x union all select to_json(x)::text from public.plusmedik_turns x) all_rows`);
    for (const secret of [SENTINEL, p.phone, "DIRECCION DE PRUEBA", "08:00"]) {
      expect(dump, secret).not.toContain(secret);
      expect(JSON.stringify(w.logs), secret).not.toContain(secret);
    }
    expect(s.version).toBe(1);
  });

  it("una versión nueva reemplaza a la anterior en la respuesta siguiente, y el rastro de cada respuesta apunta a SU versión", async () => {
    const k = world();
    const v1 = await publish("POLICY", `policy:${k.tag}`, { topic: "INVOICING", title: `FACTURA ${k.tag} UNO DE PRUEBA`, body: "CUERPO UNO DE PRUEBA" });
    const w = setup();
    const p = patient();
    const first = await ask(w, p.phone, "¿emiten factura?");
    expect(w.sends.at(-1)!.body).toContain(`FACTURA ${k.tag} UNO DE PRUEBA`);
    const v2 = await admin.createDraft({ kind: "POLICY", key: `policy:${k.tag}`, payload: { topic: "INVOICING", title: `FACTURA ${k.tag} DOS DE PRUEBA`, body: "CUERPO DOS DE PRUEBA" }, validUntil: days(60) }, ED);
    await admin.submit(v2.versionId, ED);
    await admin.approve(v2.versionId, AA2);
    const second = await ask(w, p.phone, "¿emiten factura?");
    expect(w.sends.at(-1)!.body).toContain(`FACTURA ${k.tag} DOS DE PRUEBA`);
    expect((await refsOf(first)).map((r) => r.version)).toEqual([1]);
    expect((await refsOf(second)).map((r) => r.version)).toEqual([2]);
    expect((await usage("POLICY", `policy:${k.tag}`, 1)).map((u) => u.runId)).toEqual([(await run(first)).id]);
    expect(v1.version).toBe(1);
  });

  it("RETIRADO: tras desactivar, la siguiente pregunta ya no usa el dato (responde como sin conocimiento) y no deja referencias", async () => {
    const k = world();
    const draft = await publish("POLICY", `policy:${k.tag}`, { topic: "APPOINTMENTS", title: `CITAS ${k.tag} DE PRUEBA`, body: "CUERPO DE PRUEBA" });
    const w = setup();
    const p = patient();
    await ask(w, p.phone, "¿puedo agendar una cita?");
    expect(w.sends.at(-1)!.body).toContain(`CITAS ${k.tag} DE PRUEBA`);
    await admin.deactivate(draft.versionId, AA2, "DATO_INCORRECTO");
    const message = await ask(w, p.phone, "¿puedo agendar una cita?");
    expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.fallback); // «agendar una cita» no es información general para el clasificador: recibe el texto genérico de siempre
    expect(await refsOf(message)).toEqual([]);
  });

  it("VENCIDO: con el reloj pasada la caducidad se responde como sin conocimiento aunque el dato siga aprobado en la base", async () => {
    const k = world();
    await publish("POLICY", `policy:${k.tag}`, { topic: "CONVENIOS", title: `CONVENIOS ${k.tag} DE PRUEBA`, body: "CUERPO DE PRUEBA" });
    const clock = { now: new Date() };
    clock.now = new Date(Date.now() + 1000);
    const w = setup({ now: () => clock.now });
    const p = patient();
    await ask(w, p.phone, "¿trabajan con convenio?");
    expect(w.sends.at(-1)!.body).toContain(`CONVENIOS ${k.tag} DE PRUEBA`);
    clock.now = new Date(Date.now() + 61 * 86_400_000);
    const message = await ask(w, p.phone, "¿trabajan con convenio?");
    expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.handoff_unavailable);
    expect(await refsOf(message)).toEqual([]);
  });

  it("PREPARACIÓN: solo con el aprobador CLÍNICO; antes de aprobarse (pendiente) se pide el estudio/no se responde; aprobada, se entrega tal cual con el nombre del catálogo", async () => {
    const p = patient();
    const w = setup();
    const draft = await admin.createDraft({ kind: "STUDY_PREPARATION", key: `study:${STUDY}`, payload: { labTestId: STUDY, prepState: "HAS_PREPARATION", fastingHours: 8, instructions: "INSTRUCCION DE PRUEBA" }, validUntil: days(60) }, ED);
    await admin.submit(draft.versionId, ED);
    await ask(w, p.phone, "¿necesito ayuno para alfa?");
    expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.handoff_unavailable); // pendiente = no existe para el paciente
    await expect(admin.approve(draft.versionId, AA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await ask(w, p.phone, "¿necesito ayuno para alfa?");
    expect(w.sends.at(-1)!.body).toBe(DRAFT_TEXTS.handoff_unavailable);
    await admin.approve(draft.versionId, CA);
    const message = await ask(w, p.phone, "¿necesito ayuno para alfa?");
    expect(w.sends.at(-1)!.body).toBe(["*ESTUDIO ALFA DE PRUEBA*", "Ayuno: 8 horas", "Indicaciones: INSTRUCCION DE PRUEBA"].join("\n"));
    expect((await refsOf(message)).map((r) => [r.kind, r.key])).toEqual([["STUDY_PREPARATION", `study:${STUDY}`]]);
    expect((await usage("STUDY_PREPARATION", `study:${STUDY}`, 1)).length).toBeGreaterThanOrEqual(1);
    // sin estudio identificable: se pregunta
    await ask(w, p.phone, "¿necesito ayuno?");
    expect(w.sends.at(-1)!.body).toBe(ANSWER_TEXTS.askStudy);
  });

  it("G4.2 piloto íntegro: foto -> cotización; solo tras aprobación clínica adjunta instrucciones ficticias y registra el rastro", async () => {
    const pilotCatalog: CatalogStudy[] = [{
      id: PILOT_STUDY, code: null, name: "ESTUDIO PILOTO FICTICIO",
      normalizedName: normalizeStudyKey("ESTUDIO PILOTO FICTICIO"),
      normalizedAliases: [], priceBs: 45, active: true
    }];
    const reading = new KnowledgeService({
      store: createSupabaseKnowledgeStore(rpcOptions()),
      revisionCheckMs: 0,
      maxStaleMs: 0
    });
    const w = setup({ quote: {
      loadCatalog: async () => pilotCatalog,
      analyze: async () => ({
        ...okAnalysis(),
        publicQuote: {
          studies: [{ name: "ESTUDIO PILOTO FICTICIO", priceBs: 45 }],
          totalBs: 45, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE"
        },
        // El motor entrega el UUID y la cotización; no se extrae ningún estudio del texto clínico.
        quote: { lines: [{ id: PILOT_STUDY, code: null, name: "ESTUDIO PILOTO FICTICIO", priceBs: 45 }], totalBs: 45 }
      }) as unknown as AnalysisResult,
      quotePreparations: (quote, studyIds, catalog, ctx) => appendApprovedQuotePreparations({
        quote, studyIds, catalog, knowledge: reading,
        trace: (refs) => ctx.persist("quote_preparation", async (repo, runId, lease) => {
          if ((await repo.recordKnowledgeRefs?.(runId, refs, lease)) !== "recorded") throw new Error("trace unavailable");
        })
      })
    } });
    const sendPilotPhoto = async (phone: string) => {
      const message = id("pilot-photo");
      expect((await w.hook(signedPost(imageEvent(message, phone), RECEIVED))).status).toBe(200);
      await w.settle();
      return message;
    };

    const draft = await admin.createDraft({
      kind: "STUDY_PREPARATION", key: `study:${PILOT_STUDY}`,
      payload: {
        labTestId: PILOT_STUDY, prepState: "HAS_PREPARATION",
        instructions: "CONTENIDO FICTICIO PARA PRUEBA AUTOMATIZADA - SIN RECOMENDACIONES MEDICAS."
      },
      sourceRef: "test:fixture", validUntil: days(60)
    }, ED);
    await admin.submit(draft.versionId, ED);

    const pendingMessage = await sendPilotPhoto(patient().phone);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.body).toContain("ESTUDIO PILOTO FICTICIO — Bs 45");
    expect(w.sends[0]!.body).not.toContain("CONTENIDO FICTICIO");
    expect(await refsOf(pendingMessage)).toEqual([]);

    await admin.approve(draft.versionId, CA); // aprobador distinto; SOLO en la DB de prueba
    const approvedMessage = await sendPilotPhoto(patient().phone);
    expect(w.sends).toHaveLength(2);
    expect(w.sends[1]!.body).toContain("ESTUDIO PILOTO FICTICIO — Bs 45");
    expect(w.sends[1]!.body).toContain("CONTENIDO FICTICIO PARA PRUEBA AUTOMATIZADA");
    const refs = await refsOf(approvedMessage);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ kind: "STUDY_PREPARATION", key: `study:${PILOT_STUDY}`, version: 1 });
    expect(await run(approvedMessage)).toMatchObject({ send_state: "ACCEPTED" });

    network.downFor.add("plusmedik_turn_record_knowledge");
    let failedTraceMessage = "";
    try {
      failedTraceMessage = await sendPilotPhoto(patient().phone);
    } finally {
      network.downFor.delete("plusmedik_turn_record_knowledge");
    }
    expect(w.sends).toHaveLength(3);
    expect(w.sends[2]!.body).toContain("ESTUDIO PILOTO FICTICIO — Bs 45");
    expect(w.sends[2]!.body).not.toContain("CONTENIDO FICTICIO");
    expect(await refsOf(failedTraceMessage)).toEqual([]);
  });

  describe("trazabilidad y fallos", () => {
    // Cada prueba usa su propio tema de política: dos políticas vigentes del mismo tema serían AMBIGUAS (y el bot, correctamente, no respondería con ninguna).
    it("si la base cae justo al registrar el rastro, NO se envía la respuesta con datos: se responde como sin conocimiento", async () => {
      const k = world();
      await publish("POLICY", `policy:${k.tag}`, { topic: "HOME_SAMPLING", title: `FACTURA ${k.tag} DE PRUEBA`, body: "CUERPO DE PRUEBA" });
      const w = setup();
      const p = patient();
      network.downFor.add("plusmedik_turn_record_knowledge");
      let message: string;
      try {
        message = await ask(w, p.phone, "¿hacen toma a domicilio?");
      } finally {
        network.downFor.delete("plusmedik_turn_record_knowledge");
      }
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toBe(DRAFT_TEXTS.handoff_unavailable);
      expect(w.sends[0]!.body).not.toContain("FACTURA");
      expect(logsOf(w.logs, "knowledge_trace_failed")).toHaveLength(1);
      expect(await refsOf(message)).toEqual([]);
      expect(await run(message)).toMatchObject({ send_state: "ACCEPTED" });
    });

    it("si la migración 9 NO estuviera aplicada (la función no existe), tampoco se envía lo basado en conocimiento", async () => {
      const k = world();
      await publish("POLICY", `policy:${k.tag}`, { topic: "INVOICING", title: `FACTURA ${k.tag} DE PRUEBA`, body: "CUERPO DE PRUEBA" });
      const w = setup();
      // simula 404 de PostgREST para la función: el adaptador devuelve el estado de la base (42883 → 500). Se emula con una red que rechaza esa función.
      const original = w.quote.audit!.recordKnowledgeRefs;
      w.quote.audit!.recordKnowledgeRefs = async () => { throw new Error("function does not exist"); };
      const p = patient();
      await ask(w, p.phone, "¿emiten factura?");
      expect(w.sends).toEqual([{ to: p.phone, body: DRAFT_TEXTS.handoff_unavailable }]);
      w.quote.audit!.recordKnowledgeRefs = original;
    });

    it("el mismo mensaje entregado dos veces a la vez y una tercera después: UNA respuesta y el rastro una sola vez", async () => {
      const k = world();
      await publishOffice(k);
      const w = setup();
      const p = patient();
      const message = id("txt");
      await Promise.all([w.hook(signedPost(textEvent(message, p.phone, "horario"), RECEIVED)), w.hook(signedPost(textEvent(message, p.phone, "horario"), RECEIVED))]);
      await w.settle();
      await w.hook(signedPost(textEvent(message, p.phone, "horario"), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      const refs = await refsOf(message);
      expect(new Set(refs.map((r) => `${r.lease_fence}|${r.kind}|${r.key}`)).size).toBe(refs.length);
      expect(refs.filter((r) => r.key === k.scheduleKey)).toHaveLength(1);
    });

    it("una ejecución colgada y otra que reclama el lease: responde la segunda con su propio rastro (generación 2); la primera, al revivir, no puede enviar", async () => {
      const k = world();
      await publishOffice(k);
      const hold = gate();
      let calls = 0;
      const w = setup({ wrap: (inner) => async (turn) => { if (++calls === 1) await hold.hook(); return inner(turn); } });
      const p = patient();
      const message = id("txt");
      await w.hook(signedPost(textEvent(message, p.phone, "horario"), RECEIVED));
      await hold.arrived;
      await db.ok(`select set_config('plusmedik.fence_proof', id::text || ':' || lease_fence::text, false) from public.plusmedik_audit_runs where kapso_message_id = '${message}'; update public.plusmedik_audit_runs set lease_expires_at = now() - interval '1 second' where kapso_message_id = '${message}';`);
      await w.hook(signedPost(textEvent(message, p.phone, "horario"), RECEIVED));
      await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 15_000, interval: 25 });
      hold.open();
      await w.settle();
      expect(w.sends).toHaveLength(1);
      const refs = await refsOf(message);
      expect([...new Set(refs.map((r) => r.lease_fence))]).toEqual([2]); // la primera ejecución nunca llegó a registrar (estaba colgada antes de producir la respuesta)
      expect((await usage("SCHEDULE", k.scheduleKey)).map((u) => u.runId)).toEqual([(await run(message)).id]);
    });
  });

  describe("concurrencia, orden y pausa humana", () => {
    it("dos preguntas distintas seguidas: AMBAS se responden (cada una con su dato), nunca solapadas en Kapso, y ninguna se descarta por obsoleta", async () => {
      const k = world();
      await publishOffice(k);
      await publish("PAYMENT_METHOD", k.payKey, { method: "prueba", label: `METODO ${k.tag.toUpperCase()} DE PRUEBA`, accepted: true });
      let active = 0;
      let maxActive = 0;
      const w = setup({ quote: { sendText: vi.fn(async (to: string, body: string) => { active++; maxActive = Math.max(maxActive, active); await sleep(120); w.sends.push({ to, body }); active--; return { providerMessageId: "wamid.out" }; }) } });
      const p = patient();
      const [a, b] = [id("txt"), id("txt")];
      await Promise.all([w.hook(signedPost(textEvent(a, p.phone, "¿cuál es el horario?"), RECEIVED)), w.hook(signedPost(textEvent(b, p.phone, "¿aceptan efectivo o qr? métodos de pago"), RECEIVED))]);
      await w.settle();
      expect(maxActive).toBe(1);
      expect(w.sends).toHaveLength(2);
      expect(w.sends.some((s) => s.body.includes("Horario de atención"))).toBe(true);
      expect(w.sends.some((s) => s.body.includes(`METODO ${k.tag.toUpperCase()} DE PRUEBA`))).toBe(true);
      expect((await run(a)).send_state).toBe("ACCEPTED");
      expect((await run(b)).send_state).toBe("ACCEPTED");
    });

    it("pausa humana ANTES: no se consulta el conocimiento ni se responde. DURANTE la preparación de la respuesta: no se envía y NO consta como 'dicho' en la consulta de impacto", async () => {
      const k = world();
      await publishOffice(k);
      const before = patient();
      const w1 = setup();
      await w1.hook(signedPost(humanEvent(id("human"), before.phone), SENT));
      const calls = network.calls.length;
      await ask(w1, before.phone, "horario");
      expect(w1.sends).toEqual([]);
      expect(network.calls.slice(calls).some((name) => name.startsWith("plusmedik_kb_"))).toBe(false);

      const during = patient();
      const hold = gate();
      const w2 = setup({ wrap: (inner) => async (turn) => { await hold.hook(); return inner(turn); } });
      const message = id("txt");
      await w2.hook(signedPost(textEvent(message, during.phone, "horario"), RECEIVED));
      await hold.arrived;
      await w2.hook(signedPost(humanEvent(id("human"), during.phone), SENT));
      hold.open();
      await w2.settle();
      expect(w2.sends).toEqual([]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
      const runId = (await run(message)).id;
      expect((await usage("SCHEDULE", k.scheduleKey)).some((u) => u.runId === runId)).toBe(false);
    });

    it("pausa humana ENTRE el rastro y el envío: la comprobación final cancela el envío; el turno no consta como respondido", async () => {
      const k = world();
      await publishOffice(k);
      const p = patient();
      let paused = false;
      const w = setup();
      const real = w.quote.audit!;
      const originalConfirm = real.confirmSend.bind(real);
      real.confirmSend = async (...args) => { if (!paused) { paused = true; await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT)); } return originalConfirm(...args); };
      const message = await ask(w, p.phone, "horario");
      expect(w.sends).toEqual([]);
      expect(await run(message)).toMatchObject({ send_state: "CANCELLED" });
      const runId = (await run(message)).id;
      expect((await usage("SCHEDULE", k.scheduleKey)).some((u) => u.runId === runId)).toBe(false);
    });
  });

  describe("lo que no cambia", () => {
    it("lo médico, pedir a una persona y los saludos NO consultan el conocimiento (ninguna llamada a plusmedik_kb_*) y reciben las respuestas de siempre", async () => {
      const w = setup();
      const p = patient();
      const calls = network.calls.length;
      await ask(w, p.phone, "me duele el pecho, ¿a qué hora abren?");
      await ask(w, p.phone, "quiero hablar con un asesor sobre el horario");
      await ask(w, p.phone, "hola");
      await ask(w, p.phone, "quiero cotizar");
      expect(w.sends.map((s) => s.body)).toEqual([DRAFT_TEXTS.medical_unavailable, DRAFT_TEXTS.handoff_unavailable, DRAFT_TEXTS.greeting, DRAFT_TEXTS.send_recipe]);
      expect(network.calls.slice(calls).filter((name) => name.startsWith("plusmedik_kb_"))).toEqual([]);
    });

    it("las IMÁGENES conservan su comportamiento: misma cotización, tipo 'quoted', sin referencias de conocimiento", async () => {
      const k = world();
      await publishOffice(k);
      const w = setup();
      const p = patient();
      const message = id("img");
      await w.hook(signedPost(imageEvent(message, p.phone), RECEIVED));
      await w.settle();
      expect(w.sends).toHaveLength(1);
      expect(w.sends[0]!.body).toContain("HEMOGRAMA — Bs 45");
      expect(await run(message)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
      expect(await refsOf(message)).toEqual([]);
    });
  });
});
