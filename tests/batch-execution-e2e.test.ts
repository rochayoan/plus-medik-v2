import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/analyze.js";
import { AuditWriteError, createSupabaseAuditRepository } from "../src/audit.js";
import { produceBatchReply, runBatchTurn, type BatchTurnInput, type BatchTurnTrace } from "../src/batch-execution.js";
import { BATCH_TEXTS } from "../src/batch-compose.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { beginTurn, runGuardedTurn, type TurnOutcome } from "../src/guarded-turn.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig, sessionImageProducer } from "../src/quote-session-turns.js";
import { BLOCKED_HANDOFF, createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import { maskPhone, TECHNICAL_ISSUE_MESSAGE, type QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// Ejecutores del plan de un lote (Fase 2) contra PostgreSQL REAL con TODAS las migraciones: las sesiones, el cierre con verificación de la base, los precios de lab_tests recargados al cotizar y la máquina de
// envío de siempre (reclamo, reserva, pausa humana, tope diario, deduplicación). El motor nuevo NO está conectado al webhook: aquí se ejecuta explícitamente. Se omite, con aviso, si no hay PostgreSQL.

const bin = findPostgresBin();
if (!bin) console.warn("[batch-execution-e2e] PostgreSQL no disponible: se omiten los escenarios de los ejecutores del lote contra la base real.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const baseCatalog = (): CatalogStudy[] => [
  study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45),
  study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5),
  study(3, "COLESTEROL TOTAL", ["colesterol"], 25),
  study(4, "TSH", ["tsh"], 80),
  study(7, "CREATININA SERICA", ["creatinina"], 20),
  study(8, "CREATININA EN ORINA", ["creatinina"], 22)
];

type Verdict = { kind: "COMPLETE"; ids: number[] } | { kind: "NONE" };
function analysisOf(verdict: Verdict, catalog: CatalogStudy[]): AnalysisResult {
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const lines = verdict.kind === "NONE" ? [] : verdict.ids.map((n) => ({ id: uuid(n), code: null, name: byId.get(uuid(n))?.name ?? "?", priceBs: byId.get(uuid(n))?.priceBs ?? 0, basis: ["EXACT"], texts: [] }));
  const outcome = verdict.kind === "COMPLETE" ? "AUTO_COMPLETE" : "HUMAN_REVIEW";
  return {
    decision: verdict.kind === "COMPLETE" ? "AUTO_SAFE" : "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome,
    publicQuote: verdict.kind === "NONE" ? undefined : { studies: lines.map((l) => ({ name: l.name, priceBs: l.priceBs })), totalBs: lines.reduce((sum, l) => sum + l.priceBs, 0), totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
    internal: { outcome, recipeComplete: verdict.kind === "COMPLETE", reviewRequired: verdict.kind !== "COMPLETE", quoted: { lines, subtotalBs: 0 }, studies: [], pending: [], recipeStops: [], document: { type: "TEXT_EXPLICIT_REQUEST", zones: [] }, advisories: [] }
  } as unknown as AnalysisResult;
}

describe.skipIf(!bin)("ejecutores del plan de un lote contra PostgreSQL real", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  const network = newNetwork();

  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("batch_execution_extremo");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
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

  interface Options { verdicts?: Record<string, Verdict>; failQuoteClose?: boolean; dailyCap?: { max: number; windowSeconds: number }; delegateFails?: boolean; onDelegate?: () => Promise<void> }
  function setup(options: Options = {}) {
    const sends: Array<{ to: string; body: string }> = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const world = { catalog: baseCatalog(), verdicts: { ...(options.verdicts ?? {}) } as Record<string, Verdict> };
    const realAudit = createSupabaseAuditRepository(rpcOptions());
    const audit = options.failQuoteClose ? { ...realAudit, quoteClose: async () => { throw new AuditWriteError("REJECTED"); } } : realAudit;
    const config = resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ttlSeconds: 1800, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(QUOTE_TEXTS)] });
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })),
      loadCatalog: vi.fn(async () => structuredClone(world.catalog)),
      analyze: vi.fn(async ({ imageBase64, catalog }) => {
        const tag = /TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "?";
        return analysisOf(world.verdicts[tag] ?? { kind: "COMPLETE", ids: [1] }, catalog);
      }),
      sendText: vi.fn(async (to: string, body: string) => { sends.push({ to, body }); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit, leaseRenewIntervalMs: 3_600_000,
      turns: { contactKeyFor, busyDelayMs: 20, busyRetries: 400, quoteSessions: config, ...(options.dailyCap ? { dailyCap: options.dailyCap } : {}) }
    };
    const handler = createTextHandler({ log, handoff: BLOCKED_HANDOFF });
    return { sends, logs, world, quote, config, handler, options, attention: createAttentionRepository(rpcOptions()) };
  }
  type World = ReturnType<typeof setup>;
  const logsOf = (w: World, name: string) => w.logs.filter(([event]) => event === name).map(([, data]) => data);

  // El manejador de siempre para lo delegado (urgencias, atención humana, preguntas), con los textos reales.
  const delegateFor = (w: World, messages: readonly string[]): BatchTurnInput["delegate"] => async (request) => {
    await w.options.onDelegate?.();
    if (w.options.delegateFails) throw new Error("el manejador falló");
    const text = request.fragmentIds.map((fragmentId) => messages[Number(fragmentId.slice(1))]).join(" ");
    const reply = await w.handler({ messageId: id("deleg"), from: "x", kind: "TEXT", text });
    return reply ? { body: reply.body, ...(reply.stale ? { stale: reply.stale } : {}) } : undefined;
  };

  interface Ran { ended: boolean; outcome?: TurnOutcome; trace?: BatchTurnTrace; messageId: string }
  // Un lote de un contacto por la máquina de envío de siempre: reclama el mensaje líder, ejecuta el plan y envía UNA respuesta.
  async function batch(w: World, phone: string, messages: readonly string[], extra: Partial<BatchTurnInput> & { messageId?: string } = {}): Promise<Ran> {
    const messageId = extra.messageId ?? id("txt");
    const begun = await beginTurn({ messageId, from: phone, kind: "TEXT", who: maskPhone(phone) }, w.quote);
    if ("ended" in begun) return { ended: true, messageId };
    let trace: BatchTurnTrace | undefined;
    const { messageId: _ignored, ...rest } = extra;
    void _ignored;
    const outcome = await begun.claimed.run(async (ctx) => {
      const result = await runBatchTurn({ ctx, deps: w.quote, config: w.config, from: phone, fragments: messages.map((text, index) => ({ id: `f${index}`, text })), delegate: delegateFor(w, messages), ...rest });
      trace = result.trace;
      return result.produced;
    });
    return { ended: false, outcome, ...(trace ? { trace } : {}), messageId };
  }
  const photo = async (w: World, phone: string, tag: string) => {
    const messageId = id("img");
    const image = { messageId, from: phone, mediaId: tag };
    return runGuardedTurn({ messageId, mediaId: tag, from: phone, kind: "IMAGE", who: maskPhone(phone) }, w.quote, sessionImageProducer(image, w.quote, w.config));
  };
  const lastBody = (w: World) => w.sends.at(-1)!.body;
  const sessionsOf = async (key: string): Promise<Array<Record<string, any>>> => JSON.parse(await db.ok(`select coalesce(json_agg(s order by s.created_at, s.id), '[]') from public.plusmedik_quote_sessions s where contact_key = '${key}'`));
  const itemStatuses = async (key: string): Promise<string[]> => JSON.parse(await db.ok(`select coalesce(json_agg(status order by seq), '[]') from public.plusmedik_quote_items where contact_key = '${key}'`));
  const resultOf = async (sessionId: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_quote_results r where session_id = '${sessionId}'`));
  const runOf = async (message: string): Promise<Record<string, any>> => JSON.parse(await db.ok(`select to_json(r) from public.plusmedik_audit_runs r where kapso_message_id = '${message}'`));
  const hasPrice = (body: string) => /Bs\s?\d/.test(body);

  // ───────────────────────────── cotización directa ─────────────────────────────

  it("EL CASO REAL: «quiero cotizar» + «hemograma» + «completo» cotiza DIRECTO el estudio, desde lab_tests, con una sola burbuja, un solo ítem de sesión y sin pedir confirmación", async () => {
    const p = patient();
    const w = setup();
    const ran = await batch(w, p.phone, ["quiero cotizar", "hemograma", "completo"]);
    expect(ran.outcome).toBe("quoted");
    expect(w.sends).toHaveLength(1);
    expect(lastBody(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(lastBody(w)).toContain("Total de los estudios cotizados: Bs 45");
    for (const unwanted of [QUOTE_TEXTS.confirm_done, QUOTE_TEXTS.added_text, DRAFT_TEXTS.send_recipe, DRAFT_TEXTS.fallback]) expect(lastBody(w)).not.toContain(unwanted);
    const [session] = await sessionsOf(p.key);
    expect(session).toMatchObject({ status: "QUOTED" });
    expect(await itemStatuses(p.key)).toEqual(["RESOLVED"]);
    expect(await resultOf(session!.id)).toMatchObject({ total_bs: 45 });
    expect(await runOf(ran.messageId)).toMatchObject({ send_kind: "quoted", send_state: "ACCEPTED" });
    expect(ran.trace!.plan.core).toMatchObject({ kind: "QUOTE", closeBy: "INTENT" });
  });

  it("varios estudios con intención clara -> una cotización con todos, sin repetidos y con el total del catálogo", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["Quiero cotizar", "Hemograma completo", "Y glucosa", "tsh"]);
    expect(w.sends).toHaveLength(1);
    const body = lastBody(w);
    for (const expected of ["HEMOGRAMA COMPLETO — Bs 45", "GLUCOSA EN AYUNAS — Bs 30,50", "TSH — Bs 80", "Total de los estudios cotizados: Bs 155,50"]) expect(body).toContain(expected);
    expect(body.match(/HEMOGRAMA COMPLETO —/g)).toHaveLength(1);
  });

  it("LOS PRECIOS SALEN DE lab_tests AL MOMENTO DE COTIZAR: si el precio cambia entre mensajes, la cotización usa el vigente", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["hemograma completo"]);
    expect(lastBody(w)).toContain(QUOTE_TEXTS.confirm_done);
    expect(hasPrice(lastBody(w))).toBe(false);
    w.world.catalog.find((s) => s.id === uuid(1))!.priceBs = 50;
    await batch(w, p.phone, ["cotiza"]);
    expect(lastBody(w)).toContain("HEMOGRAMA COMPLETO — Bs 50");
    expect(lastBody(w)).not.toContain("Bs 45");
    expect((await resultOf((await sessionsOf(p.key))[0]!.id)).total_bs).toBe(50);
  });

  it("una LISTA de estudios sin pedir cotizar se cotiza directo (sin «¿eso es todo?»)", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["hemograma", "completo", "y glucosa"]);
    expect(lastBody(w)).toContain("Total de los estudios cotizados: Bs 75,50");
    expect(lastBody(w)).not.toContain(QUOTE_TEXTS.confirm_done);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "QUOTED" });
  });

  it("un estudio SUELTO solo se anota y se pregunta si falta algo; «sí» en el siguiente lote cotiza", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["hemograma"]);
    expect(lastBody(w)).toBe([QUOTE_TEXTS.added_text, `${QUOTE_TEXTS.identified_so_far} HEMOGRAMA COMPLETO.`, QUOTE_TEXTS.confirm_done].join("\n"));
    expect(hasPrice(lastBody(w))).toBe(false);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
    await batch(w, p.phone, ["sí"]);
    expect(lastBody(w)).toContain("Total de los estudios cotizados: Bs 45");
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "QUOTED" });
  });

  it("«listo» en el mismo lote cotiza; la sesión activa se suma", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["glucosa"]);
    await batch(w, p.phone, ["tsh", "listo"]);
    expect(lastBody(w)).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
    expect(lastBody(w)).toContain("TSH — Bs 80");
    expect(lastBody(w)).toContain("Total de los estudios cotizados: Bs 110,50");
    expect(w.sends).toHaveLength(2);
  });

  // ───────────────────────────── ambigüedad y dudas ─────────────────────────────

  it("AMBIGÜEDAD: no se cotiza, se pregunta SOLO por las opciones y el número elegido se resuelve en el lote siguiente", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["quiero cotizar", "glucosa", "creatinina"]);
    const asked = lastBody(w);
    expect(asked).toContain(QUOTE_TEXTS.ask_option_intro);
    expect(asked).toMatch(/1\. CREATININA/);
    expect(asked).not.toContain(QUOTE_TEXTS.ask_unresolved);
    expect(hasPrice(asked)).toBe(false);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
    const second = asked.match(/2\. (CREATININA [A-Z ]+)/)![1]!.trim();
    await batch(w, p.phone, ["2", "listo"]);
    expect(lastBody(w)).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
    expect(lastBody(w)).toContain(second);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "QUOTED" });
  });

  it("la unión aclara la ambigüedad dentro del lote: «quiero cotizar creatinina» + «en orina» cotiza directo", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["quiero cotizar", "creatinina", "en orina"]);
    expect(lastBody(w)).toContain("CREATININA EN ORINA — Bs 22");
    expect(lastBody(w)).not.toContain(QUOTE_TEXTS.ask_option_intro);
  });

  it("un estudio que el catálogo no tiene NO se descarta: se cotiza lo identificado y se dice cuál falta", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["quiero cotizar", "hemograma", "xhq"]);
    expect(lastBody(w)).toContain("No encontré en nuestro catálogo: «xhq»");
    expect(hasPrice(lastBody(w))).toBe(true);
    expect(await itemStatuses(p.key)).toEqual(["RESOLVED"]);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "QUOTED" });
  });

  it("«listo» con dudas sin aclarar cierra a REVISIÓN (nunca cotiza a medias)", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["hemograma", "creatinina"]);
    await batch(w, p.phone, ["listo"]);
    expect(lastBody(w)).toBe(QUOTE_TEXTS.review);
    expect(hasPrice(lastBody(w))).toBe(false);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "NEEDS_REVIEW" });
  });

  // ───────────────────────────── intención negada ─────────────────────────────

  it("«no quiero cotizar» NO cotiza: respeta la decisión, no abre ningún ítem y no insiste", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["no quiero cotizar"]);
    expect(lastBody(w)).toBe(BATCH_TEXTS.declined);
    expect(hasPrice(lastBody(w))).toBe(false);
    expect(await sessionsOf(p.key)).toEqual([]);
  });

  it("negar el cotizar con estudios ya anotados los conserva y no cierra la sesión; después sí se puede cotizar", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["hemograma"]);
    await batch(w, p.phone, ["no quiero cotizar todavía"]);
    expect(lastBody(w)).toContain(BATCH_TEXTS.declined);
    expect(lastBody(w)).toContain(`${QUOTE_TEXTS.identified_so_far} HEMOGRAMA COMPLETO.`);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
    await batch(w, p.phone, ["listo"]);
    expect(lastBody(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
  });

  it("un estudio negado no entra en la cotización: «no quiero hemograma, quiero cotizar glucosa» cotiza solo la glucosa", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["no quiero hemograma, quiero cotizar glucosa"]);
    expect(lastBody(w)).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
    expect(lastBody(w)).not.toContain("HEMOGRAMA");
  });

  // ───────────────────────────── cancelar ─────────────────────────────

  it("«cancelar» cierra la solicitud abierta (CANCELLED) y avisa; sin solicitud abierta lo dice", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["cancelar"]);
    expect(lastBody(w)).toBe(QUOTE_TEXTS.nothing_to_cancel);
    await batch(w, p.phone, ["hemograma"]);
    await batch(w, p.phone, ["cancelar"]);
    expect(lastBody(w)).toBe(QUOTE_TEXTS.cancelled);
    const sessions = await sessionsOf(p.key);
    expect(sessions.map((session) => session.status)).toEqual(["CANCELLED"]);
  });

  it("cancelar y volver a pedir en el mismo lote: la solicitud vieja se descarta, lo nuevo se anota y se pide confirmar (un turno cierra una sola sesión); con «sí» se cotiza solo lo nuevo", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["hemograma"]);
    await batch(w, p.phone, ["cancelar", "quiero cotizar tsh"]);
    expect(w.sends).toHaveLength(2);
    expect(lastBody(w)).toContain(QUOTE_TEXTS.cancelled);
    expect(lastBody(w)).toContain(`${QUOTE_TEXTS.identified_so_far} TSH.`);
    expect(lastBody(w)).toContain(QUOTE_TEXTS.confirm_done);
    expect(lastBody(w)).not.toContain("HEMOGRAMA");
    expect(hasPrice(lastBody(w))).toBe(false);
    expect((await sessionsOf(p.key)).map((session) => session.status)).toEqual(["CANCELLED", "OPEN"]);
    await batch(w, p.phone, ["sí"]);
    expect(lastBody(w)).toContain("TSH — Bs 80");
    expect(lastBody(w)).not.toContain("HEMOGRAMA");
    expect((await sessionsOf(p.key)).map((session) => session.status)).toEqual(["CANCELLED", "QUOTED"]);
  });

  // ───────────────────────────── seguridad ─────────────────────────────

  it("AVISO MÉDICO + cotización: las dos cosas, en una burbuja, el aviso primero", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["quiero cotizar hemograma", "me duele mucho el pecho"]);
    expect(w.sends).toHaveLength(1);
    const body = lastBody(w);
    expect(body).toContain(DRAFT_TEXTS.medical_unavailable);
    expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(body.indexOf(DRAFT_TEXTS.medical_unavailable)).toBeLessThan(body.indexOf("HEMOGRAMA COMPLETO"));
  });

  it("ATENCIÓN HUMANA + cotización: se conservan las dos y no se promete una persona sin registro", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["quiero cotizar hemograma", "quiero hablar con una persona"]);
    const body = lastBody(w);
    expect(body).toContain(DRAFT_TEXTS.handoff_unavailable);
    expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(body).not.toContain(DRAFT_TEXTS.handoff_confirmed);
  });

  it("solo seguridad: sale el aviso y nada genérico; ninguna sesión", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["me duele mucho el pecho"]);
    expect(lastBody(w)).toBe(DRAFT_TEXTS.medical_unavailable);
    expect(await sessionsOf(p.key)).toEqual([]);
  });

  it("si el manejador de siempre FALLA, el aviso médico y el de atención humana salen igual con su texto fijo seguro", async () => {
    const p = patient();
    const w = setup({ delegateFails: true });
    await batch(w, p.phone, ["quiero cotizar hemograma", "me duele mucho el pecho", "quiero hablar con una persona"]);
    const body = lastBody(w);
    expect(body).toContain(DRAFT_TEXTS.medical_unavailable);
    expect(body).toContain(DRAFT_TEXTS.handoff_unavailable);
    expect(body).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(logsOf(w, "batch_delegate_failed").length).toBeGreaterThanOrEqual(2);
  });

  it("si FALLA el cierre de la sesión, el aviso médico se conserva, se agrega el aviso técnico, se audita el fallo y NO se cotiza", async () => {
    const p = patient();
    const w = setup({ failQuoteClose: true });
    const ran = await batch(w, p.phone, ["quiero cotizar hemograma", "me duele mucho el pecho"]);
    expect(lastBody(w)).toContain(DRAFT_TEXTS.medical_unavailable);
    expect(lastBody(w)).toContain(TECHNICAL_ISSUE_MESSAGE);
    expect(hasPrice(lastBody(w))).toBe(false);
    // el fallo queda auditado (FAILED con su código) y la respuesta —con el aviso médico— sí se envió
    expect(await runOf(ran.messageId)).toMatchObject({ processing_status: "FAILED", error_code: "UNEXPECTED_PROCESSING_FAILED", send_state: "ACCEPTED" });
    expect(logsOf(w, "processing_failed")).toHaveLength(1);
    expect(JSON.stringify(w.logs)).not.toContain("hemograma");
  });

  // ───────────────────────────── fotografías ─────────────────────────────

  it("FOTOS: la foto de la sesión se suma al texto y con intención clara se cotiza todo junto, con los precios del catálogo", async () => {
    const p = patient();
    const w = setup({ verdicts: { A: { kind: "COMPLETE", ids: [3] } } });
    await photo(w, p.phone, "A");
    expect(w.sends).toHaveLength(1);
    await batch(w, p.phone, ["quiero cotizar", "hemograma"], { photos: [{ status: "RESOLVED", studyIds: [uuid(3)] }] });
    expect(w.sends).toHaveLength(2);
    expect(lastBody(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(lastBody(w)).toContain("COLESTEROL TOTAL — Bs 25");
    expect(lastBody(w)).toContain("Total de los estudios cotizados: Bs 70");
  });

  it("una foto ilegible impide cotizar: se avisa que se reenvíe, se resume lo anotado y la sesión sigue abierta", async () => {
    const p = patient();
    const w = setup({ verdicts: { B: { kind: "NONE" } } });
    await photo(w, p.phone, "B");
    await batch(w, p.phone, ["quiero cotizar hemograma"], { photos: [{ status: "UNREADABLE", studyIds: [] }] });
    expect(lastBody(w)).toContain(QUOTE_TEXTS.resend);
    expect(lastBody(w)).toContain("HEMOGRAMA COMPLETO");
    expect(hasPrice(lastBody(w))).toBe(false);
    expect((await sessionsOf(p.key))[0]).toMatchObject({ status: "OPEN" });
  });

  // ───────────────────────────── deduplicación, pausa humana y tope diario ─────────────────────────────

  it("DEDUPLICACIÓN: el mismo lote reentregado no responde ni cotiza dos veces", async () => {
    const p = patient();
    const w = setup();
    const messageId = id("txt");
    const first = await batch(w, p.phone, ["quiero cotizar", "hemograma"], { messageId });
    expect(first.outcome).toBe("quoted");
    const again = await batch(w, p.phone, ["quiero cotizar", "hemograma"], { messageId });
    expect(again.ended).toBe(true);
    expect(w.sends).toHaveLength(1);
    expect(await sessionsOf(p.key)).toHaveLength(1);
  });

  it("REPETICIÓN SEGURA: si el mismo turno vuelve a producir su respuesta tras cerrar la sesión, devuelve EXACTAMENTE la misma cotización (sin recalcular precios)", async () => {
    const p = patient();
    const w = setup();
    const messageId = id("txt");
    const begun = await beginTurn({ messageId, from: p.phone, kind: "TEXT", who: maskPhone(p.phone) }, w.quote);
    if ("ended" in begun) throw new Error("no se pudo reclamar");
    const bodies: string[] = [];
    await begun.claimed.run(async (ctx) => {
      const input = { ctx, deps: w.quote, config: w.config, from: p.phone, fragments: [{ id: "f0", text: "quiero cotizar hemograma" }], delegate: delegateFor(w, ["quiero cotizar hemograma"]) };
      const first = await produceBatchReply(input);
      w.world.catalog.find((s) => s.id === uuid(1))!.priceBs = 99;
      const second = await produceBatchReply(input);
      for (const produced of [first, second]) if (produced.kind === "reply") bodies.push(produced.body);
      return first;
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[1]).toContain("Bs 45");
    expect(bodies[1]).not.toContain("Bs 99");
  });

  it("PAUSA HUMANA: con el contacto pausado el lote no se procesa ni se responde; si la pausa llega MIENTRAS se procesa, no se envía nada", async () => {
    const paused = patient();
    const w = setup();
    expect((await w.attention.registerHumanMessage({ eventKey: id("hum"), contactKey: paused.key, occurredAt: new Date().toISOString() })).outcome).toBe("PAUSED");
    const ran = await batch(w, paused.phone, ["quiero cotizar hemograma"]);
    expect(ran.ended).toBe(true);
    expect(w.sends).toEqual([]);
    expect(await sessionsOf(paused.key)).toEqual([]);

    const midRun = patient();
    const w2 = setup({ onDelegate: async () => { await w2.attention.registerHumanMessage({ eventKey: id("hum"), contactKey: midRun.key, occurredAt: new Date().toISOString() }); } });
    const ran2 = await batch(w2, midRun.phone, ["quiero cotizar hemograma", "me duele mucho el pecho"]);
    expect(w2.sends).toEqual([]);
    expect(ran2.outcome).toBe("ignored");
    expect(await runOf(ran2.messageId)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "HUMAN_PAUSED" });
  });

  it("TOPE DE RESPUESTAS: cada lote cuenta UNA respuesta; al alcanzar el tope no se responde y otro contacto no se ve afectado", async () => {
    const p = patient();
    const other = patient();
    const w = setup({ dailyCap: { max: 2, windowSeconds: 86_400 } });
    await batch(w, p.phone, ["quiero cotizar", "hemograma", "completo"]);
    await batch(w, p.phone, ["quiero cotizar", "glucosa", "en ayunas", "y tsh"]);
    expect(w.sends).toHaveLength(2);
    const blocked = await batch(w, p.phone, ["quiero cotizar tsh"]);
    expect(w.sends).toHaveLength(2);
    expect(blocked.outcome).toBe("ignored");
    expect(await runOf(blocked.messageId)).toMatchObject({ send_state: "CANCELLED", send_block_reason: "DAILY_CAP" });
    await batch(w, other.phone, ["quiero cotizar tsh"]);
    expect(w.sends).toHaveLength(3);
  });

  // ───────────────────────────── modelo de apoyo ─────────────────────────────

  it("OpenAI de apoyo: entiende una petición natural y cotiza directo, pero lo que cotiza sale del catálogo, no del modelo", async () => {
    const p = patient();
    const w = setup();
    const interpret = vi.fn(async () => ({ isQuoteRequest: true, wantsQuote: true, matched: [], ambiguous: [], unclear: [], notFound: [], priceBs: 1, total: 1 }));
    await batch(w, p.phone, ["hemograma completo", "agradecería el valor total"], { understand: { interpret: interpret as never } });
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(lastBody(w)).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(lastBody(w)).not.toContain("Bs 1");
    expect(logsOf(w, "batch_plan")[0]).toMatchObject({ core: "QUOTE", intentSource: "MODEL", model: "USED" });
  });

  it("el registro del plan solo lleva códigos: ni el texto de los mensajes, ni el teléfono, ni ids ni precios", async () => {
    const p = patient();
    const w = setup();
    await batch(w, p.phone, ["quiero cotizar", "hemograma", "completo", "me duele mucho el pecho"]);
    const serialized = JSON.stringify(w.logs);
    for (const forbidden of ["hemograma", "me duele", p.phone, "0000-4000", "Bs 45"]) expect(serialized, forbidden).not.toContain(forbidden);
    expect(logsOf(w, "batch_plan")[0]).toMatchObject({ core: "QUOTE", safety: ["MEDICAL"] });
  });
});
