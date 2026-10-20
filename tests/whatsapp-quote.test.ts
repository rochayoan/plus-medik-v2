import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assembleAnalysis, type AnalysisResult } from "../src/analyze.js";
import { buildSimpleConsensus, normalizeStudyKey, type SimpleStudy } from "../src/consensus.js";
import type { SimpleReading } from "../src/ai.js";
import type { CatalogStudy } from "../src/types.js";
import {
  detectImageMime, emojiFor, extractIncomingImages, formatBs, formatQuoteMessage, handleImageMessage, isAllowedPhone, maskPhone, MAX_IMAGE_BYTES, NO_QUOTE_MESSAGE,
  TECHNICAL_ISSUE_MESSAGE, verifyWebhookSignature, type IncomingImage, type QuoteDeps
} from "../src/whatsapp-quote.js";
import { GET, POST } from "../api/kapso/webhook.js";

// Integración Kapso (mínima). Todo con simulaciones locales: la red está bloqueada y no se llama a ningún modelo.

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ message: { id: "wamid.1" } });
  it("acepta la firma HMAC-SHA256 hex del cuerpo crudo (con o sin prefijo, en mayúsculas o minúsculas)", () => {
    const signature = sign(body, "secreto");
    expect(verifyWebhookSignature(body, signature, "secreto")).toBe(true);
    expect(verifyWebhookSignature(body, `sha256=${signature}`, "secreto")).toBe(true);
    expect(verifyWebhookSignature(body, signature.toUpperCase(), "secreto")).toBe(true);
    expect(verifyWebhookSignature(body, `  ${signature}  `, "secreto")).toBe(true);
  });
  it("rechaza secreto distinto, cuerpo alterado, firma ausente, mal formada o de otra longitud", () => {
    const signature = sign(body, "secreto");
    expect(verifyWebhookSignature(body, signature, "otro")).toBe(false);
    expect(verifyWebhookSignature(`${body} `, signature, "secreto")).toBe(false);
    expect(verifyWebhookSignature(body, null, "secreto")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "secreto")).toBe(false);
    expect(verifyWebhookSignature(body, "", "secreto")).toBe(false);
    expect(verifyWebhookSignature(body, "zz".repeat(32), "secreto")).toBe(false);
    expect(verifyWebhookSignature(body, signature.slice(2), "secreto")).toBe(false);
    expect(verifyWebhookSignature(body, `${signature}00`, "secreto")).toBe(false);
  });
  it("sin secreto configurado falla cerrado, incluso con una firma 'válida' calculada con cadena vacía", () => {
    expect(verifyWebhookSignature(body, sign(body, ""), "")).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, "x"), undefined)).toBe(false);
  });
});

describe("extractIncomingImages", () => {
  const image = (extra: Record<string, any> = {}, kapso: Record<string, any> = {}) => ({
    message: { id: "wamid.A", from: "59171234567", type: "image", image: { id: "mid1" }, kapso: { direction: "inbound", media_url: "https://cdn.kapso.ai/x.jpg", ...kapso }, ...extra },
    conversation: { id: "c1", phone_number: "59171234567" }
  });
  it("una imagen entrante con URL de medio alojado", () => {
    expect(extractIncomingImages(image())).toEqual([{ messageId: "wamid.A", from: "59171234567", mediaUrl: "https://cdn.kapso.ai/x.jpg", mediaId: "mid1" }]);
  });
  it("URL alternativa (image.link) o solo el id del medio", () => {
    expect(extractIncomingImages(image({ image: { id: "m", link: "https://x/y.png" } }, { media_url: undefined }))[0]?.mediaUrl).toBe("https://x/y.png");
    const onlyId = extractIncomingImages(image({ image: { id: "m9" } }, { media_url: undefined }));
    expect(onlyId[0]).toMatchObject({ mediaId: "m9" });
    expect(onlyId[0]?.mediaUrl).toBeUndefined();
  });
  it("ignora texto, audio, reacciones, mensajes salientes, sin id/remitente y sin medio", () => {
    expect(extractIncomingImages({ message: { id: "1", from: "5917", type: "text", text: { body: "hola" } } })).toEqual([]);
    expect(extractIncomingImages({ message: { id: "1", from: "5917", type: "audio", audio: { id: "a" } } })).toEqual([]);
    expect(extractIncomingImages({ message: { id: "1", from: "5917", type: "reaction", reaction: { emoji: "👍" } } })).toEqual([]);
    expect(extractIncomingImages(image({}, { direction: "outbound" }))).toEqual([]);
    expect(extractIncomingImages(image({ id: "" }))).toEqual([]);
    expect(extractIncomingImages(image({ from: "" }, {}) && { message: { id: "1", type: "image", image: { id: "m" }, kapso: { direction: "inbound" } } })).toEqual([]);
    expect(extractIncomingImages(image({ image: {} }, { media_url: undefined }))).toEqual([]);
    expect(extractIncomingImages({})).toEqual([]);
  });
  it("lotes: por el campo batch o por el encabezado x-webhook-batch", () => {
    const batch = { batch: true, data: [image(), image({ id: "wamid.B", from: "59170000000" }), { message: { id: "t", from: "1", type: "text" } }] };
    expect(extractIncomingImages(batch).map((m) => m.messageId)).toEqual(["wamid.A", "wamid.B"]);
    expect(extractIncomingImages({ data: [image()] }, "true").map((m) => m.messageId)).toEqual(["wamid.A"]);
    expect(extractIncomingImages({ data: [image()] })).toEqual([]);
  });
});

describe("piloto por números", () => {
  it("sin ALLOWED_PHONES queda abierto; con la lista solo responde a esos números (ignora +, espacios y guiones)", () => {
    expect(isAllowedPhone("59171234567", undefined)).toBe(true);
    expect(isAllowedPhone("59171234567", "")).toBe(true);
    expect(isAllowedPhone("59171234567", "+591 7123-4567, 59170000000")).toBe(true);
    expect(isAllowedPhone("59179999999", "+591 7123-4567, 59170000000")).toBe(false);
  });
  it("maskPhone no deja ver el número completo", () => {
    expect(maskPhone("59171234567")).toBe("591****4567");
    expect(maskPhone("12")).toBe("****");
    expect(maskPhone(undefined)).toBe("****");
  });
});

describe("imagen", () => {
  it("detecta JPEG, PNG y WebP por su contenido (no por el nombre) y rechaza lo demás", () => {
    const pad = (bytes: number[]) => Uint8Array.from([...bytes, ...new Array(16).fill(0)]);
    expect(detectImageMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageMime(pad([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(detectImageMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]))).toBe("image/webp");
    expect(detectImageMime(pad([0x25, 0x50, 0x44, 0x46]))).toBeUndefined();
    expect(detectImageMime(new Uint8Array(0))).toBeUndefined();
  });
});

describe("mensaje al paciente", () => {
  it("emojis por tipo de estudio, con un valor por defecto", () => {
    expect(emojiFor("HEMOGRAMA COMPLETO AUTOMATIZADO")).toBe("🩸");
    expect(emojiFor("EXAMEN GENERAL DE ORINA COMPLETA")).toBe("💧");
    expect(emojiFor("TSH (ECLIA)")).toBe("🧬");
    expect(emojiFor("CREATININA")).toBe("🧪");
    expect(emojiFor("UROCULTIVO")).toBe("🧫");
  });
  it("formato de precios", () => {
    expect(formatBs(45)).toBe("Bs 45");
    expect(formatBs(45.5)).toBe("Bs 45,50");
    expect(formatBs(0)).toBe("Bs 0");
  });
  it("lista cada estudio con su precio y el total de los estudios cotizados, sin afirmar que cubre toda la receta", () => {
    const text = formatQuoteMessage({ studies: [{ name: "HEMOGRAMA COMPLETO AUTOMATIZADO", priceBs: 45 }, { name: "CREATININA", priceBs: 30 }], totalBs: 75, totalLabel: "Total de los estudios cotizados", tariff: "PACIENTE" });
    expect(text).toContain("🩸 HEMOGRAMA COMPLETO AUTOMATIZADO — Bs 45");
    expect(text).toContain("🧪 CREATININA — Bs 30");
    expect(text).toContain("💰 *Total de los estudios cotizados: Bs 75*");
    expect(text).not.toMatch(/receta completa|todos los estudios|pendiente|revisi[oó]n|HUMAN|\bAUTO\b/i);
  });
});

// ───────────────────── extremo a extremo con el motor real (assembleAnalysis) y dependencias simuladas ─────────────────────

const study = (code: string, name: string, priceBs: number, category = "QUIMICA SANGUINEA"): CatalogStudy => ({ id: `uuid-${code}`, code, name, normalizedName: normalizeStudyKey(name), normalizedAliases: [], priceBs, active: true, category });
const catalog = [study("108", "HEMOGRAMA COMPLETO", 45, "HEMATOLOGIA"), study("384", "CREATININA", 30), study("423", "UREA", 30), study("397", "GLUCOSA", 20), study("514", "EXAMEN GENERAL DE ORINA", 35, "URIANALISIS")];
const row = (literalText: string): SimpleStudy => ({ literalText, normalizedName: literalText, evidence: "check", confidence: "high" });
const analysisOf = (...texts: string[]): AnalysisResult => {
  const reading: SimpleReading = { requestedStudies: texts.map(row), uncertainStudies: [], notes: "" };
  return assembleAnalysis({
    consensus: buildSimpleConsensus(reading, reading), judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, partialAuto: true,
    document: { documentType: "MARK_DEPENDENT_FORM", completeDocumentVisible: true, agreement: true, integrityProblems: [], integrityKinds: [] }
  });
};
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(1)]);
const incoming: IncomingImage = { messageId: "wamid.X", from: "59171234567", mediaUrl: "https://cdn.kapso.ai/r.jpg" };

function makeDeps(overrides: Partial<QuoteDeps> & { analysis?: AnalysisResult } = {}) {
  const sent: Array<{ to: string; body: string }> = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps: QuoteDeps = {
    downloadImage: vi.fn(async () => ({ bytes: JPEG })),
    loadCatalog: vi.fn(async () => catalog),
    analyze: vi.fn(async () => overrides.analysis ?? analysisOf("Hemograma completo")),
    sendText: vi.fn(async (to: string, body: string) => { sent.push({ to, body }); }),
    log: (event, data) => { logs.push({ event, data }); },
    ...overrides
  };
  return { deps, sent, logs };
}

describe("handleImageMessage", () => {
  it("receta completa: una sola respuesta con cada estudio, su precio y el total", async () => {
    const { deps, sent } = makeDeps({ analysis: analysisOf("Hemograma completo", "Creatinina") });
    expect(await handleImageMessage(incoming, deps)).toBe("quoted");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("59171234567");
    expect(sent[0]?.body).toContain("HEMOGRAMA COMPLETO — Bs 45");
    expect(sent[0]?.body).toContain("CREATININA — Bs 30");
    expect(sent[0]?.body).toContain("Total de los estudios cotizados: Bs 75");
  });

  it("4 de 5 estudios: cotiza los 4 con su total y el pendiente NO se menciona al paciente, pero queda en el registro interno", async () => {
    const analysis = analysisOf("Hemograma completo", "Creatinina", "Urea", "Glucosa", "Estudio que no existe en el catalogo");
    expect(analysis.outcome).toBe("AUTO_PARTIAL");
    const { deps, sent, logs } = makeDeps({ analysis });
    expect(await handleImageMessage(incoming, deps)).toBe("quoted");
    const body = sent[0]!.body;
    for (const name of ["HEMOGRAMA COMPLETO", "CREATININA", "UREA", "GLUCOSA"]) expect(body).toContain(name);
    expect(body).toContain("Bs 125");
    expect(body).not.toMatch(/Estudio que no existe|pendiente|revisi[oó]n|HUMAN|\bAUTO\b|no pudimos|falta|incompleta/i);
    const log = logs.find((entry) => entry.event === "analysis")!;
    expect(JSON.stringify(log.data.pending)).toContain("Estudio que no existe en el catalogo");
    expect(log.data.outcome).toBe("AUTO_PARTIAL");
    expect(log.data.quotedCodes).toEqual(["108", "384", "423", "397"]);
    expect(log.data.phone).toBe("591****4567");
    expect(JSON.stringify(logs)).not.toContain("59171234567");
  });

  it("ningún estudio verificable (HUMAN_REVIEW): no hay cotización; se pide una foto más clara, sin hablar de revisión ni de pendientes", async () => {
    const { deps, sent } = makeDeps({ analysis: analysisOf("Estudio inexistente uno", "Estudio inexistente dos") });
    expect(await handleImageMessage(incoming, deps)).toBe("no_quote");
    expect(sent).toEqual([{ to: "59171234567", body: NO_QUOTE_MESSAGE }]);
    expect(NO_QUOTE_MESSAGE).not.toMatch(/HUMAN|\bAUTO\b|pendiente|revisi[oó]n/i);
  });

  it("un documento que no es una solicitud no recibe cotización", async () => {
    const analysis = assembleAnalysis({
      consensus: buildSimpleConsensus({ requestedStudies: [row("Hemograma completo")], uncertainStudies: [], notes: "" }, { requestedStudies: [row("Hemograma completo")], uncertainStudies: [], notes: "" }),
      judgement: { resolvedStudies: [], unresolvedDisputes: [] }, catalog, partialAuto: true,
      document: { documentType: "NOT_A_REQUEST", completeDocumentVisible: true, agreement: true }
    });
    const { deps, sent } = makeDeps({ analysis });
    expect(await handleImageMessage(incoming, deps)).toBe("no_quote");
    expect(sent[0]?.body).toBe(NO_QUOTE_MESSAGE);
  });

  it("una imagen sin formato reconocible (p. ej. PDF) o ilegible: se pide otra foto y NO se llama al motor", async () => {
    const { deps, sent } = makeDeps({ downloadImage: vi.fn(async () => ({ bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, ...new Array(32).fill(0)]) })) });
    expect(await handleImageMessage(incoming, deps)).toBe("no_quote");
    expect(deps.analyze).not.toHaveBeenCalled();
    expect(sent[0]?.body).toBe(NO_QUOTE_MESSAGE);
  });

  it("vacía o demasiado grande: se ignora sin responder ni llamar al motor", async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(MAX_IMAGE_BYTES + 1)]) {
      const { deps, sent } = makeDeps({ downloadImage: vi.fn(async () => ({ bytes })) });
      expect(await handleImageMessage(incoming, deps)).toBe("ignored");
      expect(sent).toEqual([]);
      expect(deps.analyze).not.toHaveBeenCalled();
    }
  });

  it("si el motor o la descarga fallan: un mensaje técnico neutro, sin detalles del error, y el error queda en el log", async () => {
    for (const failing of [{ analyze: vi.fn(async () => { throw new Error("OPENAI 503 secret-detail"); }) }, { downloadImage: vi.fn(async () => { throw new Error("HTTP 404"); }) }, { loadCatalog: vi.fn(async () => { throw new Error("supabase down"); }) }]) {
      const { deps, sent, logs } = makeDeps(failing);
      expect(await handleImageMessage(incoming, deps)).toBe("technical_issue");
      expect(sent).toEqual([{ to: "59171234567", body: TECHNICAL_ISSUE_MESSAGE }]);
      expect(sent[0]?.body).not.toMatch(/OPENAI|secret|HTTP|supabase/i);
      expect(logs.some((entry) => entry.event === "processing_failed")).toBe(true);
    }
  });

  it("si el envío falla no lanza (el webhook no debe reventar) y lo registra", async () => {
    const { deps, logs } = makeDeps({ sendText: vi.fn(async () => { throw new Error("Kapso 500"); }) });
    await expect(handleImageMessage(incoming, deps)).resolves.toBe("quoted");
    expect(logs.some((entry) => entry.event === "send_failed")).toBe(true);
  });

  it("el motor se invoca una sola vez con la imagen en base64 y el catálogo cargado", async () => {
    const { deps } = makeDeps();
    await handleImageMessage(incoming, deps);
    expect(deps.analyze).toHaveBeenCalledTimes(1);
    const args = vi.mocked(deps.analyze).mock.calls[0]![0];
    expect(args.mimeType).toBe("image/jpeg");
    expect(args.imageBase64).toBe(Buffer.from(JPEG).toString("base64"));
    expect(args.catalog).toBe(catalog);
  });
});

describe("api/kapso/webhook (sin procesar nada real)", () => {
  const SECRET = "secreto-de-prueba";
  const request = (body: string, headers: Record<string, string> = {}) => new Request("https://plusmedik.test/api/kapso/webhook", { method: "POST", body, headers });
  const imageBody = JSON.stringify({ message: { id: "wamid.Z", from: "59171234567", type: "image", image: { id: "m1" }, kapso: { direction: "inbound", media_url: "https://cdn.kapso.ai/z.jpg" } } });

  it("sin firma, con firma inválida o sin secreto configurado: 401 y nada se procesa", async () => {
    process.env.WEBHOOK_SECRET = SECRET;
    expect((await POST(request(imageBody))).status).toBe(401);
    expect((await POST(request(imageBody, { "x-webhook-signature": sign(imageBody, "otro") }))).status).toBe(401);
    delete process.env.WEBHOOK_SECRET;
    expect((await POST(request(imageBody, { "x-webhook-signature": sign(imageBody, SECRET) }))).status).toBe(401);
  });

  it("firma válida pero JSON inválido: 400", async () => {
    process.env.WEBHOOK_SECRET = SECRET;
    const body = "{no es json";
    expect((await POST(request(body, { "x-webhook-signature": sign(body, SECRET) }))).status).toBe(400);
  });

  it("firma válida con un mensaje que no es imagen, o de un número no autorizado: 200 'ignored' sin trabajo", async () => {
    process.env.WEBHOOK_SECRET = SECRET;
    const text = JSON.stringify({ message: { id: "t1", from: "59171234567", type: "text", text: { body: "hola" } } });
    const ok = await POST(request(text, { "x-webhook-signature": sign(text, SECRET) }));
    expect([ok.status, await ok.text()]).toEqual([200, "ignored"]);
    process.env.ALLOWED_PHONES = "59170000000";
    try {
      const blocked = await POST(request(imageBody, { "x-webhook-signature": sign(imageBody, SECRET) }));
      expect([blocked.status, await blocked.text()]).toEqual([200, "ignored"]);
    } finally {
      delete process.env.ALLOWED_PHONES;
    }
  });

  it("GET responde el estado sin exponer secretos", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("ok");
    expect(text).not.toMatch(/secret|key|token/i);
  });
});
