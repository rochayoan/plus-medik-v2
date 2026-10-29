import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { ANSWER_TEXTS, detectTopics, lazyKnowledge } from "../src/knowledge-answers.js";
import { createKnowledgeAdminRepository } from "../src/knowledge/admin.js";
import { createSupabaseKnowledgeStore, KnowledgeService } from "../src/knowledge/index.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { DEFAULT_REPLY_GUARD, type ReplyGuardConfig } from "../src/reply-guard.js";
import { createStudyFactsAdminRepository, type KnowledgeActor, type StudyFactsAdminRepository } from "../src/study-facts/admin.js";
import { createSupabaseStudyFactsStore, StudyFactsService } from "../src/study-facts/index.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Datos por estudio (G4.1) de extremo a extremo: cliente de ADMINISTRACIÓN real (borrador → aprobado → retirado) + webhook real + manejador real + servicios de lectura reales +
// sesiones de cotización (G4.0) + PostgreSQL real con las DOCE migraciones. Kapso y el motor de recetas son simulaciones. Todos los datos son fixtures de PRUEBA.

const bin = findPostgresBin();
if (!bin) console.warn("[study-facts-e2e] PostgreSQL no disponible: se omiten los escenarios de datos por estudio contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const SENTINEL = "TEXTO_CLINICO_SENTINELA_9902";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const ED: KnowledgeActor = { id: "crm:editor-1", type: "HUMAN", role: "EDITOR" };
const AA: KnowledgeActor = { id: "crm:admin-1", type: "HUMAN", role: "ADMIN_APPROVER" };
const AA2: KnowledgeActor = { id: "crm:admin-2", type: "HUMAN", role: "ADMIN_APPROVER" };
const CA: KnowledgeActor = { id: "crm:clinical-1", type: "HUMAN", role: "CLINICAL_APPROVER" };

const STUDIES: Array<[number, string, string[], number]> = [
  [1, "HEMOGRAMA DE PRUEBA", ["hemograma"], 45], [2, "GLUCOSA DE PRUEBA", ["glucosa"], 30], [3, "TSH DE PRUEBA", ["tsh"], 80], [4, "COLESTEROL DE PRUEBA", ["colesterol"], 25],
  [5, "GAMMA UNO DE PRUEBA", ["gamma"], 10], [6, "GAMMA DOS DE PRUEBA", ["gamma"], 12], [7, "UREA DE PRUEBA", ["urea"], 15], [8, "FOSFORO DE PRUEBA", ["fosforo"], 18]
];
const catalog = (): CatalogStudy[] => STUDIES.map(([n, name, aliases, priceBs]) => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true }));

const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const humanEvent = (id: string, phone: string) => ({ message: { id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", to: phone, text: { body: SENTINEL }, kapso: { direction: "outbound", status: "sent", origin: "business_app" } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string> = {}) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};
const RECEIVED = { "x-webhook-event": "whatsapp.message.received" };
const SENT = { "x-webhook-event": "whatsapp.message.sent" };
const noAnalysis = () => ({ decision: "HUMAN_REVIEW", outcome: "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [] }) as unknown as AnalysisResult;

describe.skipIf(!bin)("datos aprobados por estudio de extremo a extremo contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let facts: StudyFactsAdminRepository;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("study_facts_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    await db.ok(`create table public.lab_tests (id uuid primary key, name text not null, price_bs numeric not null, active boolean not null); insert into public.lab_tests values ${STUDIES.map(([n, name, , price]) => `('${uuid(n)}', '${name}', ${price}, true)`).join(", ")};`);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
    facts = createStudyFactsAdminRepository(rpcOptions());
  });
  afterAll(async () => {
    await server?.stop();
  });

  const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
  const id = (prefix: string) => `wamid.${prefix}-${++counter}-${Date.now()}`;
  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });
  const patient = () => {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    return { phone, key: contactKeyFor(phone)! };
  };

  // Cada prueba usa estudios propios publicados con las claves de la base; como la base es compartida, cada una publica SOLO lo que necesita y pregunta por sus estudios.
  async function publish(kind: "SAMPLE" | "TURNAROUND", n: number, payload: Record<string, unknown>, options: { validUntil?: Date } = {}) {
    const approver = kind === "SAMPLE" ? CA : AA;
    const draft = await facts.createDraft({ kind, labTestId: uuid(n), payload: { labTestId: uuid(n), ...payload }, sourceRef: "prueba:fixture", validUntil: options.validUntil ?? days(60) }, ED);
    await facts.submit(draft.factId, ED);
    await facts.approve(draft.factId, approver);
    return draft;
  }
  const hours = (max: number, extra: Record<string, unknown> = {}) => ({ unit: "HOURS", max, countedFrom: "SAMPLE_COLLECTION", ...extra });

  interface Options { facts?: boolean; sessions?: boolean; replyGuard?: ReplyGuardConfig }
  function setup(options: Options = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const withFacts = options.facts ?? true;
    const knowledge = new KnowledgeService({ store: createSupabaseKnowledgeStore(rpcOptions()), revisionCheckMs: 0, maxStaleMs: 60_000 });
    const studyFacts = new StudyFactsService({ store: createSupabaseStudyFactsStore(rpcOptions()), revisionCheckMs: 0, maxStaleMs: 60_000 });
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async () => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(20).fill(0)]) })), loadCatalog: vi.fn(async () => catalog()), analyze: vi.fn(async () => noAnalysis()),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: { text: createTextHandler({ log, loopProtection: options.replyGuard !== undefined, knowledge: { service: knowledge, loadCatalog: async () => catalog(), ...(withFacts ? { studyFacts } : {}) } }) },
        ...(options.replyGuard ? { replyGuard: options.replyGuard } : {}),
        ...(options.sessions ? { quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, isInfoQuestion: (text) => detectTopics(text, withFacts).length > 0, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] }) } : {})
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    return { sends, logs, scheduled, quote, hook: (request: Request) => handleKapsoWebhook(request, deps), settle: () => Promise.all(scheduled) };
  }
  type World = ReturnType<typeof setup>;
  const logsOf = (logs: Array<[string, Record<string, unknown>]>, name: string) => logs.filter(([event]) => event === name).map(([, data]) => data);
  const say = async (w: World, phone: string, body: string, message = id("txt")) => {
    expect((await w.hook(signedPost(textEvent(message, phone, body), RECEIVED))).status).toBe(200);
    await w.settle();
    return message;
  };
  const last = (w: World) => w.sends.at(-1)!.body;
  const run = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const refsOf = async (message: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(f order by f.fact_kind, f.lab_test_id), '[]') from public.plusmedik_turn_fact_refs f join public.plusmedik_audit_runs r on r.id = f.run_id where r.kapso_message_id = '${message}'`));
  const usage = async (kind: string, n: number, version: number | null = null): Promise<Array<Record<string, any>>> =>
    (JSON.parse((await db.ok(`set role service_role; select public.plusmedik_facts_usage('${kind}', '${uuid(n)}'::uuid, ${version ?? "null"}, 100);`)).split("\n")[0]!) as { uses: Array<Record<string, any>> }).uses;
  const hasPrice = (body: string) => /Bs\s?\d/.test(body);

  it("APAGADO (sin el servicio de datos por estudio): preguntar el plazo o la muestra recibe la respuesta de siempre y no se toca ninguna tabla nueva", async () => {
    await publish("TURNAROUND", 1, hours(24));
    const p = patient();
    const w = setup({ facts: false });
    await say(w, p.phone, "¿cuánto demora el hemograma?");
    expect(last(w)).toBe(DRAFT_TEXTS.fallback);
    await say(w, p.phone, "¿qué muestra necesito para la glucosa?");
    expect(last(w)).toBe(DRAFT_TEXTS.fallback);
    expect(await db.ok(`select count(*) from public.plusmedik_turn_fact_refs f join public.plusmedik_audit_runs r on r.id = f.run_id where r.contact_key = '${p.key}'`)).toBe("0");
  });

  it("publicado → preguntado por nombre → respondido con el plazo aprobado; el rastro queda en la base ANTES del envío y la consulta de impacto encuentra a quién se le dijo", async () => {
    const draft = await publish("TURNAROUND", 1, hours(24));
    const p = patient();
    const w = setup();
    const message = await say(w, p.phone, `¿cuánto demora el hemograma? ${SENTINEL}`);
    expect(w.sends).toHaveLength(1);
    expect(last(w)).toBe(["*HEMOGRAMA DE PRUEBA*", "Tiempo de entrega: hasta 24 horas (contado desde la toma de la muestra)"].join("\n"));
    expect(await run(message)).toMatchObject({ send_kind: "conversation", send_state: "ACCEPTED", contact_key: p.key });
    const refs = await refsOf(message);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ fact_kind: "TURNAROUND", lab_test_id: uuid(1), version: draft.version });
    const uses = await usage("TURNAROUND", 1, draft.version);
    expect(uses.find((use) => use.contactKey === p.key)).toMatchObject({ sendState: "ACCEPTED", version: draft.version });
  });

  it("cada estudio en SU unidad: horas, días hábiles con rango y días calendario desde la recepción; sin convertir ni mezclar", async () => {
    await publish("TURNAROUND", 2, { unit: "DAYS", dayType: "BUSINESS", min: 2, max: 3, countedFrom: "SAMPLE_COLLECTION" });
    await publish("TURNAROUND", 3, { unit: "DAYS", dayType: "CALENDAR", max: 5, countedFrom: "SAMPLE_RECEIPT", note: "Los feriados se suman" });
    const p = patient();
    const w = setup();
    await say(w, p.phone, "cuánto tardan la glucosa y la tsh");
    expect(last(w)).toContain("*GLUCOSA DE PRUEBA*\nTiempo de entrega: entre 2 y 3 días hábiles (contado desde la toma de la muestra)");
    expect(last(w)).toContain("*TSH DE PRUEBA*\nTiempo de entrega: hasta 5 días calendario (contado desde la recepción de la muestra en el laboratorio)\nLos feriados se suman");
    expect(hasPrice(last(w))).toBe(false);
  });

  it("tipo de muestra y requisitos especiales aprobados por personal clínico; «sin requisitos» solo si se declaró", async () => {
    await publish("SAMPLE", 4, { sampleType: "Sangre venosa", requirementsState: "HAS_REQUIREMENTS", requirements: ["Traer el frasco estéril", "No usar cremas en el brazo"] });
    await publish("SAMPLE", 7, { sampleType: "Sangre", requirementsState: "NO_SPECIAL_REQUIREMENTS" });
    const p = patient();
    const w = setup();
    await say(w, p.phone, "¿qué muestra y qué requisitos hay para el colesterol y la urea?");
    expect(last(w)).toBe([
      "*COLESTEROL DE PRUEBA*", "Tipo de muestra: Sangre venosa", "Requisitos:", "- Traer el frasco estéril", "- No usar cremas en el brazo", "",
      "*UREA DE PRUEBA*", "Tipo de muestra: Sangre", "Requisitos: el laboratorio indica que no tiene requisitos especiales."
    ].join("\n"));
    expect((await refsOf((await db.ok(`select kapso_message_id from public.plusmedik_audit_runs where contact_key = '${p.key}' order by created_at desc limit 1`)))).map((ref) => ref.fact_kind)).toEqual(["SAMPLE", "SAMPLE"]);
  });

  it("sin dato aprobado: dice claramente que no lo tiene, no inventa un plazo ni «sin requisitos», no promete una persona, y no deja rastro", async () => {
    const p = patient();
    const w = setup();
    const message = await say(w, p.phone, "¿cuánto demora la glucosa? ¿hay requisitos?");
    // la glucosa (id 2) ya tiene plazo de otra prueba; se consulta un estudio sin nada: la urea y el colesterol según la prueba
    await say(w, p.phone, "¿cuánto demora el fosforo?");
    expect(last(w)).toBe("No tengo el tiempo de entrega de FOSFORO DE PRUEBA disponible por ahora.");
    expect(last(w)).not.toMatch(/persona|equipo|asesor|llamar/i);
    expect(/\d/.test(last(w))).toBe(false);
    expect(message).toBeTruthy();
    const refs = await db.ok(`select count(*) from public.plusmedik_turn_fact_refs f join public.plusmedik_audit_runs r on r.id = f.run_id where r.contact_key = '${p.key}' and r.kapso_message_id <> '${message}'`);
    expect(refs).toBe("0");
  });

  it("estudio ambiguo (alias de dos estudios): no se responde por él y se indica", async () => {
    await publish("TURNAROUND", 5, hours(10));
    await publish("TURNAROUND", 6, hours(20));
    const p = patient();
    const w = setup();
    await say(w, p.phone, "cuánto demora gamma");
    expect(last(w)).toBe(ANSWER_TEXTS.studyAmbiguous);
    expect(last(w)).not.toMatch(/10|20/);
  });

  it("sin nombrar el estudio ni cotización previa: pide el nombre del estudio; no adivina", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "¿para cuándo estaría?");
    expect(last(w)).toBe(ANSWER_TEXTS.askStudyInfo);
  });

  it("después de una cotización (G4.0): «¿y cuándo estarán?» responde por los estudios cotizados, sin repetir nombres y SIN tocar los precios de la cotización", async () => {
    await publish("TURNAROUND", 1, hours(24));
    const p = patient();
    const w = setup({ sessions: true });
    await say(w, p.phone, "hemograma y colesterol");
    await say(w, p.phone, "listo");
    const quoted = last(w);
    expect(quoted).toContain("HEMOGRAMA DE PRUEBA — Bs 45");
    expect(quoted).toContain("COLESTEROL DE PRUEBA — Bs 25");
    expect(quoted).toContain("Total de los estudios cotizados: Bs 70");
    const message = await say(w, p.phone, "¿y para cuándo estarían?");
    const answer = last(w);
    expect(answer.split("\n")[0]).toBe(ANSWER_TEXTS.contextIntro);
    expect(answer).toContain("*HEMOGRAMA DE PRUEBA*\nTiempo de entrega: hasta 24 horas");
    expect(hasPrice(answer)).toBe(false);
    expect(answer).not.toMatch(/\b45\b|\b25\b|\b70\b/);
    expect((await refsOf(message)).map((ref) => ref.lab_test_id)).toEqual([uuid(1)]);
    // los precios de la cotización registrada no cambiaron
    const result = JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_results r join public.plusmedik_quote_sessions s on s.id = r.session_id where s.contact_key = '${p.key}'`));
    expect(result.total_bs).toBe(70);
  });

  it("la pregunta de información en medio de una solicitud no se anota como estudio ni la altera; la solicitud sigue y se cotiza completa", async () => {
    await publish("TURNAROUND", 1, hours(24));
    const p = patient();
    const w = setup({ sessions: true });
    await say(w, p.phone, "hemograma");
    const items = async () => db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`);
    expect(await items()).toBe("1");
    await say(w, p.phone, "¿cuánto demora el hemograma?");
    expect(last(w)).toContain("hasta 24 horas");
    expect(await items()).toBe("1");
    await say(w, p.phone, "listo");
    expect(last(w)).toContain("HEMOGRAMA DE PRUEBA — Bs 45");
    expect(last(w).match(/HEMOGRAMA DE PRUEBA —/g)).toHaveLength(1);
  });

  it("un mensaje que NOMBRA estudios y además pregunta el plazo se atiende como pregunta (no se anota como lista de estudios ni deja la solicitud con «algo sin resolver»)", async () => {
    await publish("TURNAROUND", 1, hours(24));
    const p = patient();
    const w = setup({ sessions: true });
    await say(w, p.phone, "hemograma y colesterol, ¿cuánto demoran?");
    expect(last(w)).toContain("*HEMOGRAMA DE PRUEBA*\nTiempo de entrega: hasta 24 horas");
    expect(await db.ok(`select count(*) from public.plusmedik_quote_items where contact_key = '${p.key}'`)).toBe("0");
    expect(await db.ok(`select count(*) from public.plusmedik_quote_sessions where contact_key = '${p.key}'`)).toBe("0");
  });

  it("un dato retirado o reemplazado deja de usarse de inmediato; uno vencido no se entrega", async () => {
    const first = await publish("TURNAROUND", 2, hours(24));
    const p = patient();
    const w = setup();
    await say(w, p.phone, "cuánto demora la glucosa");
    expect(last(w)).toContain("hasta 24 horas");
    const next = await facts.createDraft({ kind: "TURNAROUND", labTestId: uuid(2), payload: { labTestId: uuid(2), ...hours(48) }, sourceRef: "prueba:v2", validUntil: days(60) }, ED);
    await facts.submit(next.factId, ED);
    await facts.approve(next.factId, AA2);
    await say(w, p.phone, "cuánto demora la glucosa");
    expect(last(w)).toContain("hasta 48 horas");
    await facts.deactivate(next.factId, AA, "DATO_INCORRECTO");
    await say(w, p.phone, "cuánto demora la glucosa");
    expect(last(w)).toBe("No tengo el tiempo de entrega de GLUCOSA DE PRUEBA disponible por ahora.");
    expect(first.factId).not.toBe(next.factId);

    const q = patient();
    await publish("TURNAROUND", 3, hours(12));
    await db.ok(`set session_replication_role = replica; update public.plusmedik_study_facts set valid_until = now() - interval '1 day', valid_from = now() - interval '5 days' where lab_test_id = '${uuid(3)}' and fact_kind = 'TURNAROUND' and status = 'APPROVED';`);
    await say(w, q.phone, "cuánto demora la tsh");
    expect(last(w)).toBe("No tengo el tiempo de entrega de TSH DE PRUEBA disponible por ahora.");
  });

  it("idempotencia: el mismo mensaje entregado varias veces genera UNA respuesta y el rastro una vez", async () => {
    await publish("TURNAROUND", 1, hours(24)).catch(() => undefined);
    const p = patient();
    const w = setup();
    const message = id("dup");
    for (let i = 0; i < 4; i++) {
      expect((await w.hook(signedPost(textEvent(message, p.phone, "cuánto demora el hemograma"), RECEIVED))).status).toBe(200);
      await w.settle();
    }
    expect(w.sends).toHaveLength(1);
    expect(await refsOf(message)).toHaveLength(1);
  });

  it("concurrencia: varias preguntas simultáneas del mismo contacto se responden todas, sin solaparse y cada una con su rastro", async () => {
    await publish("TURNAROUND", 4, hours(6)).catch(() => undefined);
    const p = patient();
    const w = setup();
    const messages = Array.from({ length: 5 }, () => id("par"));
    await Promise.all(messages.map((message) => w.hook(signedPost(textEvent(message, p.phone, "cuánto demora el colesterol"), RECEIVED))));
    await w.settle();
    expect(w.sends).toHaveLength(5);
    for (const message of messages) expect(await refsOf(message)).toHaveLength(1);
  });

  it("pausa humana: un contacto pausado no recibe la respuesta ni deja rastro", async () => {
    const p = patient();
    const w = setup();
    await say(w, p.phone, "hola");
    const before = w.sends.length;
    expect((await w.hook(signedPost(humanEvent(id("human"), p.phone), SENT))).status).toBe(200);
    await w.settle();
    const message = await say(w, p.phone, "cuánto demora el hemograma");
    expect(w.sends).toHaveLength(before);
    expect(await refsOf(message)).toEqual([]);
  });

  it("antibucles: la misma consulta repetida sin parar se corta tras el tope de repetición", async () => {
    await publish("TURNAROUND", 7, hours(8)).catch(() => undefined);
    const p = patient();
    const w = setup({ replyGuard: DEFAULT_REPLY_GUARD });
    for (let i = 0; i < 8; i++) await say(w, p.phone, "cuánto demora la urea");
    expect(w.sends).toHaveLength(DEFAULT_REPLY_GUARD.repeat.max);
  });

  describe("falla cerrado", () => {
    it("si el rastro no se puede registrar (migración 12 ausente en esa función), NO se envía el dato: se responde lo que correspondería sin él", async () => {
      await publish("TURNAROUND", 1, hours(24)).catch(() => undefined);
      const p = patient();
      const w = setup();
      network.downFor.add("plusmedik_turn_record_facts");
      try {
        await say(w, p.phone, "cuánto demora el hemograma");
      } finally {
        network.downFor.delete("plusmedik_turn_record_facts");
      }
      expect(w.sends).toHaveLength(1);
      expect(last(w)).not.toContain("hasta 24 horas");
      expect(last(w)).toBe(DRAFT_TEXTS.fallback);
      expect(logsOf(w.logs, "knowledge_trace_failed").length).toBe(1);
    });

    it("si la base de datos por estudio no responde (o la migración 12 no está), el dato es «no disponible»: nunca se inventa", async () => {
      await publish("TURNAROUND", 1, hours(24)).catch(() => undefined);
      const p = patient();
      const w = setup();
      network.downFor.add("plusmedik_study_facts_snapshot");
      try {
        await say(w, p.phone, "cuánto demora el hemograma");
      } finally {
        network.downFor.delete("plusmedik_study_facts_snapshot");
      }
      expect(last(w)).toBe("No tengo el tiempo de entrega de HEMOGRAMA DE PRUEBA disponible por ahora.");
    });

    it("si la última cotización no se puede consultar, se pide el estudio (no se adivina)", async () => {
      const p = patient();
      const w = setup({ sessions: true });
      await say(w, p.phone, "hemograma");
      await say(w, p.phone, "listo");
      network.downFor.add("plusmedik_quote_last_studies");
      try {
        await say(w, p.phone, "¿y para cuándo estarían?");
      } finally {
        network.downFor.delete("plusmedik_quote_last_studies");
      }
      expect(last(w)).toBe(ANSWER_TEXTS.askStudyInfo);
    });
  });

  it("privacidad: ni los registros ni las tablas de datos por estudio contienen texto del paciente ni teléfonos", async () => {
    await publish("TURNAROUND", 1, hours(24)).catch(() => undefined);
    const p = patient();
    const w = setup({ sessions: true });
    await say(w, p.phone, `cuánto demora el hemograma ${SENTINEL}`);
    await say(w, p.phone, `hemograma ${SENTINEL}`);
    await say(w, p.phone, "listo");
    await say(w, p.phone, "¿y cuándo estarán?");
    const tables = await db.ok(`select (select coalesce(json_agg(f), '[]') from public.plusmedik_turn_fact_refs f)::text || (select coalesce(json_agg(e), '[]') from public.plusmedik_study_fact_events e)::text || (select coalesce(json_agg(s), '[]') from public.plusmedik_study_facts s)::text`);
    for (const text of [JSON.stringify(w.logs), tables, JSON.stringify(w.sends.map((s) => s.body))]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(p.phone);
    }
  });

  it("la administración del conocimiento de G3 sigue intacta junto a la nueva (misma revisión compartida)", async () => {
    const knowledgeAdmin = createKnowledgeAdminRepository(rpcOptions());
    const revision = async () => Number(JSON.parse((await db.ok(asService(`select public.plusmedik_kb_revision();`))).split("\n")[0]!).revision);
    const before = await revision();
    const draft = await knowledgeAdmin.createDraft({ kind: "FAQ", key: `faq:g41-${++counter}`, payload: { question: "PREGUNTA DE PRUEBA", answer: "RESPUESTA DE PRUEBA", tags: ["g41prueba"] }, sourceRef: "prueba:fixture", validUntil: days(30) }, ED);
    await knowledgeAdmin.submit(draft.versionId, ED);
    await knowledgeAdmin.approve(draft.versionId, AA);
    const after = await revision();
    expect(after).toBe(before + 1);
  });
});

const asService = (sql: string) => `set role service_role; ${sql}`;
