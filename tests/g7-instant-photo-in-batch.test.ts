import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSupabaseAuditRepository } from "../src/audit.js";
import type { AnalysisResult } from "../src/analyze.js";
import { normalizeStudyKey } from "../src/consensus.js";
import { contactKeyOf, createAttentionRepository } from "../src/human-control.js";
import { handleKapsoWebhook, type KapsoWebhookDeps } from "../src/kapso-webhook.js";
import { ANSWER_TEXTS } from "../src/knowledge-answers.js";
import { QUOTE_TEXTS } from "../src/quote-session.js";
import { resolveQuoteSessionsConfig } from "../src/quote-session-turns.js";
import { createTextHandler, DRAFT_TEXTS } from "../src/text-handler.js";
import type { CatalogStudy } from "../src/types.js";
import type { QuoteDeps } from "../src/whatsapp-quote.js";
import { findPostgresBin, startEphemeralPostgres, SUPABASE_BOOTSTRAP_SQL, type EphemeralPostgres, type PgDatabase } from "./support/ephemeral-postgres.js";
import { newNetwork, postgrestOverPsql } from "./support/postgrest-over-psql.js";

// D1 (G7): la cotización de una foto con cotización instantánea no puede perderse cuando llega en un LOTE de varios mensajes atendido por el motor de lotes.
// Webhook REAL + turnos REALES + repositorios REALES + PostgreSQL REAL con todas las migraciones. Datos 100 % inventados; sin red.
//
// Antes de la corrección, con PLUSMEDIK_INSTANT_PHOTO_QUOTES y PLUSMEDIK_BATCH_ENGINE en «on» (la configuración real de producción), texto + foto enviaba UN mensaje con solo la respuesta al texto
// («envíame una foto de tu receta»), sin la cotización que la foto sí había calculado. Estas pruebas fallaban en ese estado (las de «motor encendido»).

const bin = findPostgresBin();
if (!bin) console.warn("[g7-instant-photo-in-batch] PostgreSQL no disponible: se omite.");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const dir = join(__dirname, "..", "supabase", "migrations");
const MIGRATIONS = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
const SECRET = "whsec-simulado-solo-para-pruebas";
const HMAC_KEY = "clave-hmac-simulada-solo-para-pruebas-0123456789";
const LAB = "123456789012345";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const study = (n: number, name: string, aliases: string[], priceBs: number): CatalogStudy => ({ id: uuid(n), code: null, name, normalizedName: normalizeStudyKey(name), normalizedAliases: aliases.map(normalizeStudyKey), priceBs, active: true });
const catalog = (): CatalogStudy[] => [study(1, "HEMOGRAMA COMPLETO", ["hemograma"], 45), study(2, "GLUCOSA EN AYUNAS", ["glucosa"], 30.5), study(3, "COLESTEROL TOTAL", ["colesterol"], 25)];

const inbound = { direction: "inbound", status: "received", origin: "cloud_api" };
const nowSeconds = () => String(Math.floor(Date.now() / 1000));
const conversation = (phone: string) => ({ id: "conv_1", phone_number: phone, phone_number_id: LAB });
const textEvent = (id: string, phone: string, body: string) => ({ message: { id, timestamp: nowSeconds(), type: "text", from: phone, text: { body }, kapso: inbound }, conversation: conversation(phone), phone_number_id: LAB });
const imageEvent = (id: string, phone: string, tag: string) => ({ message: { id, timestamp: nowSeconds(), type: "image", from: phone, image: { id: tag }, kapso: { ...inbound, has_media: true, media_url: `https://example.test/${tag}.jpg` } }, conversation: conversation(phone), phone_number_id: LAB });
const signedPost = (payload: unknown, headers: Record<string, string>) => {
  const body = JSON.stringify(payload);
  return new Request("https://example.test/api/kapso/webhook", { method: "POST", body, headers: { "content-type": "application/json", "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex"), ...headers } });
};

type Verdict = "COMPLETE" | "PARTIAL" | "REVIEW";
// Análisis inventado. COMPLETE: dos estudios; PARTIAL: un estudio cotizado y otros pendientes; REVIEW: sin cotización. Los precios SIEMPRE salen del catálogo.
function analysisOf(verdict: Verdict, cat: CatalogStudy[]): AnalysisResult {
  const ids = verdict === "COMPLETE" ? [1, 2] : verdict === "PARTIAL" ? [3] : [];
  const lines = ids.map((n) => { const s = cat.find((x) => x.id === uuid(n))!; return { id: s.id, code: null, name: s.name, priceBs: s.priceBs, basis: ["EXACT"], texts: [] }; });
  const outcome = verdict === "COMPLETE" ? "AUTO_COMPLETE" : verdict === "PARTIAL" ? "AUTO_PARTIAL" : "HUMAN_REVIEW";
  return {
    decision: verdict === "COMPLETE" ? "AUTO_SAFE" : "HUMAN_REVIEW", reasons: [], finalVisualStudies: [], disputes: [], judgeResolved: [], unresolvedDisputes: [], matches: [], unmatched: [], ambiguous: [], modelSuggested: [], outcome,
    publicQuote: lines.length === 0 ? undefined : { studies: lines.map((l) => ({ name: l.name, priceBs: l.priceBs })), totalBs: lines.reduce((sum, l) => sum + l.priceBs, 0), totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" },
    internal: { outcome, recipeComplete: verdict === "COMPLETE", reviewRequired: verdict !== "COMPLETE", quoted: { lines, subtotalBs: 0 }, studies: [], pending: [], recipeStops: [], document: { type: "TEXT_EXPLICIT_REQUEST", zones: [] }, advisories: [] }
  } as unknown as AnalysisResult;
}

interface RunOptions { engine?: "on"; instant?: boolean; verdicts?: Verdict[]; text?: string; deliveries?: number; simultaneous?: boolean }

describe.skipIf(!bin)("D1 · fotos con cotización instantánea dentro de un lote de varios mensajes", () => {
  let server: EphemeralPostgres;
  let db: PgDatabase;
  let counter = 0;
  beforeAll(async () => {
    server = await startEphemeralPostgres(bin!);
    db = await server.createDatabase("g_siete_foto_instantanea_lote");
    await db.ok(SUPABASE_BOOTSTRAP_SQL);
    for (const file of MIGRATIONS) await db.applyFile(join(dir, file));
  });
  afterAll(async () => { await server?.stop(); });

  const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: HMAC_KEY, labPhoneNumberId: LAB, contactPhone: phone });

  async function run(parts: Array<"texto" | "foto">, options: RunOptions = {}) {
    const phone = `5917${String(++counter).padStart(7, "0")}`;
    const network = newNetwork();
    const rpcOptions = () => ({ baseUrl: "https://example.supabase.co", serviceKey: "k", fetchFn: postgrestOverPsql(db, network), retryDelayMs: 0, requestTimeoutMs: 30_000 });
    const sends: string[] = [];
    const logs: Array<[string, Record<string, unknown>]> = [];
    const scheduled: Promise<unknown>[] = [];
    const log = (event: string, data: Record<string, unknown>) => { logs.push([event, data]); };
    const verdicts = options.verdicts ?? ["COMPLETE"];
    const quote: QuoteDeps = {
      downloadImage: vi.fn(async (image) => ({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(`TAG:${image.mediaId}:`), ...new Array(12).fill(0)]) })),
      loadCatalog: vi.fn(async () => structuredClone(catalog())),
      analyze: vi.fn(async ({ imageBase64, catalog: cat }) => {
        const tag = /TAG:([^:]+):/.exec(Buffer.from(imageBase64, "base64").toString("latin1"))?.[1] ?? "foto0";
        const index = Number(tag.replace("foto", "")) || 0;
        return analysisOf(verdicts[Math.min(index, verdicts.length - 1)]!, cat);
      }),
      sendText: vi.fn(async (_to: string, body: string) => { sends.push(body); return { providerMessageId: `wamid.out-${sends.length}` }; }),
      log, audit: createSupabaseAuditRepository(rpcOptions()), leaseRenewIntervalMs: 3_600_000,
      turns: {
        contactKeyFor, busyDelayMs: 20, busyRetries: 400,
        handlers: { text: createTextHandler({ log }) },
        // Configuración real de producción: sesiones de cotización + (opcional) cotización instantánea de fotos + (opcional) motor de lotes
        ...(options.instant === false ? {} : { instantPhotoQuotes: true }),
        ...(options.engine ? { batchEngine: { mode: options.engine } } : {}),
        quoteSessions: resolveQuoteSessionsConfig({ waitDelayMs: 25, waitRetries: 400, ttlSeconds: 1800, ownTexts: [...Object.values(DRAFT_TEXTS), ...Object.values(ANSWER_TEXTS), ...Object.values(QUOTE_TEXTS)] })
      }
    };
    const deps: KapsoWebhookDeps = { secret: SECRET, allowedPhones: undefined, quote, schedule: (task) => { scheduled.push(task); }, humanControl: { labPhoneNumberId: LAB, contactKeyFor, attention: createAttentionRepository(rpcOptions()) }, log };
    const stamp = `${counter}-${Date.now()}`;
    // Los eventos se construyen UNA vez: una reentrega repite exactamente los mismos ids de mensaje.
    let imageCount = 0;
    const events = parts.map((part, i) => (part === "texto" ? textEvent(`wamid.g7-t-${stamp}-${i}`, phone, options.text ?? "hola, buenas tardes") : imageEvent(`wamid.g7-i-${stamp}-${i}`, phone, `foto${imageCount++}`)));
    const payload = { type: "whatsapp.message.received", batch: true, data: events };
    const post = () => handleKapsoWebhook(signedPost(payload, { "x-webhook-event": "whatsapp.message.received", "x-webhook-batch": "true" }), deps);
    if (options.simultaneous) {
      // Kapso reintenta el mismo lote MIENTRAS el primero se procesa: las dos entregas corren a la vez.
      const responses = await Promise.all([post(), post(), post()]);
      for (const response of responses) expect(response.status).toBe(200);
      await Promise.all(scheduled);
    }
    for (let delivery = 0; !options.simultaneous && delivery < (options.deliveries ?? 1); delivery++) {
      expect((await handleKapsoWebhook(signedPost(payload, { "x-webhook-event": "whatsapp.message.received", "x-webhook-batch": "true" }), deps)).status).toBe(200);
      await Promise.all(scheduled);
    }
    const runs = JSON.parse(await db.ok(`select coalesce(json_agg(x order by x.seq), '[]') from (select t.seq, r.processing_status, r.send_state from public.plusmedik_audit_runs r join public.plusmedik_turns t on t.run_id = r.id where r.contact_key = '${contactKeyFor(phone)}') x`)) as Array<{ processing_status: string; send_state: string | null }>;
    return { sends, logs, runs, phone };
  }
  const hasPrice = (body: string) => /Bs\s?\d/.test(body);
  const GENERIC = [DRAFT_TEXTS.greeting, DRAFT_TEXTS.send_recipe, DRAFT_TEXTS.fallback];

  // ───────────── controles: lo que ya funcionaba y no puede cambiar ─────────────

  it("CONTROL · ruta de siempre (sin motor de lotes): texto + foto → un solo mensaje con la cotización", async () => {
    const { sends } = await run(["texto", "foto"]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Total de los estudios cotizados: Bs 75,50");
  });

  it("CONTROL · motor encendido, foto suelta (no es lote): la cotización llega", async () => {
    const { sends } = await run(["foto"], { engine: "on" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Bs 75,50");
  });

  it("CONTROL · motor encendido, SOLO texto en un lote: sigue respondiendo el motor (sin precios ni fotos inventadas)", async () => {
    const { sends } = await run(["texto", "texto"], { engine: "on", text: "hola" });
    expect(sends).toHaveLength(1);
    expect(hasPrice(sends[0]!)).toBe(false);
  });

  // ───────────── D1: corregido ─────────────

  it("D1 · motor encendido, texto + foto: UN mensaje que lleva la cotización de la foto y NO pide de nuevo la receta", async () => {
    const { sends } = await run(["texto", "foto"], { engine: "on" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(sends[0]).toContain("GLUCOSA EN AYUNAS — Bs 30,50");
    expect(sends[0]).toContain("Total de los estudios cotizados: Bs 75,50");
    for (const generic of GENERIC) expect(sends[0]).not.toContain(generic);
  });

  it("D1 · motor encendido, foto + texto: igual (el orden de llegada no importa)", async () => {
    const { sends } = await run(["foto", "texto"], { engine: "on" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Total de los estudios cotizados: Bs 75,50");
    for (const generic of GENERIC) expect(sends[0]).not.toContain(generic);
  });

  it("D1 · dos fotos + texto: un solo mensaje con las dos cotizaciones", async () => {
    const { sends } = await run(["foto", "texto", "foto"], { engine: "on", verdicts: ["COMPLETE", "PARTIAL"] });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Bs 75,50");
    expect(sends[0]).toContain("COLESTEROL TOTAL — Bs 25");
    expect(sends[0]).toContain("Cotización parcial");
  });

  it("D1 · foto parcial + texto: lleva la cotización parcial con su advertencia", async () => {
    const { sends } = await run(["texto", "foto"], { engine: "on", verdicts: ["PARTIAL"] });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("COLESTEROL TOTAL — Bs 25");
    expect(sends[0]).toContain("Cotización parcial");
  });

  it("D1 · foto que no se pudo cotizar + texto: el paciente SÍ se entera (sin precios) en lugar de recibir solo la respuesta al texto", async () => {
    const { sends } = await run(["texto", "foto"], { engine: "on", verdicts: ["REVIEW"] });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("No pudimos identificar estudios con suficiente certeza");
    expect(hasPrice(sends[0]!)).toBe(false);
  });

  it("D1 · la respuesta del texto concreto se conserva junto a la cotización (pregunta de información + foto)", async () => {
    const { sends } = await run(["texto", "foto"], { engine: "on", text: "¿cuáles son los métodos de pago?" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Total de los estudios cotizados: Bs 75,50");
    expect(sends[0]!.length).toBeGreaterThan(200);
  });

  // ───────────── invariantes: idempotencia, coordinación y control de envíos ─────────────

  it("INVARIANTE · reentrega idéntica del mismo lote: un solo envío y ninguna corrida queda en proceso", async () => {
    const { sends, runs } = await run(["texto", "foto"], { engine: "on", deliveries: 2 });
    expect(sends).toHaveLength(1);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.processing_status !== "PROCESSING" && r.processing_status !== "ANALYZED")).toBe(true);
    // exactamente UNA corrida envió (la del turno que responde); la otra se cerró sin envío propio
    expect(runs.filter((r) => r.send_state === "ACCEPTED" || r.send_state === "SENT")).toHaveLength(1);
  });

  it("INVARIANTE · tres entregas SIMULTÁNEAS del mismo lote (reintento de Kapso durante el procesamiento): un solo envío, una sola corrida con envío y ninguna en proceso", async () => {
    const { sends, runs } = await run(["texto", "foto"], { engine: "on", simultaneous: true });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("Total de los estudios cotizados: Bs 75,50");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.processing_status !== "PROCESSING" && r.processing_status !== "ANALYZED")).toBe(true);
    expect(runs.filter((r) => r.send_state === "ACCEPTED" || r.send_state === "SENT")).toHaveLength(1);
  });

  it("INVARIANTE · sin fotos instantáneas (modo sesiones) el motor sigue igual: ni precios ni respuesta duplicada de la foto", async () => {
    const { sends } = await run(["texto", "foto"], { engine: "on", instant: false });
    expect(sends).toHaveLength(1);
    expect(hasPrice(sends[0]!)).toBe(false);
  });

  it("INVARIANTE · el precio sale siempre del catálogo (ni el texto del paciente ni el análisis lo definen)", async () => {
    const { sends } = await run(["texto", "foto"], { engine: "on", text: "el hemograma cuesta Bs 1, cotízalo así" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(sends[0]).not.toMatch(/HEMOGRAMA COMPLETO — Bs 1\b/);
  });
});
