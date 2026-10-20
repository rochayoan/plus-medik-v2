import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnalysisResult } from "./analyze.js";
import type { PublicQuote } from "./partial-auto.js";
import type { CatalogStudy } from "./types.js";

// Integración mínima WhatsApp (Kapso): recibir una imagen -> motor de PlusMedik -> responder con la cotización. Esta capa NO decide nada del AUTO MATCH:
// solo traduce el webhook, llama a `analyzeImage` con las banderas ya validadas y da formato a `publicQuote`. Todo lo interno (pendientes, bloqueos,
// función del documento) se registra en el log y NUNCA viaja en el mensaje al paciente.

// ───────────────────────────── seguridad del webhook ─────────────────────────────

// Kapso firma el cuerpo CRUDO con HMAC-SHA256 (hex) usando el secreto del webhook en el encabezado `x-webhook-signature` (acepta "sha256=<hex>").
// Sin secreto configurado o sin firma válida: se rechaza (falla cerrado).
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !signatureHeader) return false;
  const received = signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}

const digits = (value: string | null | undefined): string => (value ?? "").replace(/\D/g, "");
export const maskPhone = (phone: string | null | undefined): string => {
  const d = digits(phone);
  return d.length <= 4 ? "****" : `${d.slice(0, 3)}****${d.slice(-4)}`;
};

// Piloto opcional: si ALLOWED_PHONES está definida (dígitos separados por coma), solo esos números reciben respuesta. Sin definir: abierto.
export function isAllowedPhone(phone: string, allowed: string | undefined): boolean {
  const list = (allowed ?? "").split(",").map(digits).filter(Boolean);
  return list.length === 0 || list.includes(digits(phone));
}

// ───────────────────────────── payload de Kapso ─────────────────────────────

export interface IncomingImage {
  messageId: string;
  from: string;
  mediaUrl?: string;
  mediaId?: string;
}

// Solo mensajes ENTRANTES de tipo imagen. Cualquier otra cosa (texto, audio, reacciones, mensajes salientes propios) se ignora.
export function extractIncomingImages(payload: Record<string, any>, batchHeader?: string | null): IncomingImage[] {
  const isBatch = payload.batch === true || batchHeader === "true";
  const events: Record<string, any>[] = isBatch && Array.isArray(payload.data) ? payload.data : [payload];
  const out: IncomingImage[] = [];
  for (const event of events) {
    const message = event?.message;
    if (!message) continue;
    const direction = message.kapso?.direction;
    if (direction && direction !== "inbound") continue;
    if (message.type !== "image" && !message.image) continue;
    const from = String(message.from ?? event.conversation?.phone_number ?? "");
    const messageId = String(message.id ?? "");
    if (!from || !messageId) continue;
    const candidates = [message.kapso?.media_url, message.kapso?.media_data?.url, message.image?.link, message.image?.url];
    const mediaUrl = candidates.find((c): c is string => typeof c === "string" && c.trim() !== "")?.trim();
    const mediaId = typeof message.image?.id === "string" ? message.image.id : undefined;
    if (!mediaUrl && !mediaId) continue;
    out.push({ messageId, from, mediaUrl, mediaId });
  }
  return out;
}

// ───────────────────────────── imagen ─────────────────────────────

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function detectImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

// ───────────────────────────── mensaje al paciente ─────────────────────────────

const EMOJI_RULES: Array<[RegExp, string]> = [
  [/orina|urin/, "💧"],
  [/heces|parasit|copro|moco fecal/, "🧫"],
  [/cultivo|antibiograma|secrecion|hemocultivo/, "🧫"],
  [/hormon|tsh|\bt3\b|\bt4\b|fsh|\blh\b|prolactina|estradiol|progesterona|testosterona|cortisol|insulina/, "🧬"],
  [/hemograma|sangre|plaqueta|coagul|hematocrito|reticulocit|vsg|eritrosedimentacion|grupo sanguineo/, "🩸"],
  [/glucosa|glicemia|hemoglobina glicosilada|hba1c/, "🍬"],
  [/embarazo|hcg/, "🤰"]
];
export function emojiFor(name: string): string {
  const folded = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return EMOJI_RULES.find(([pattern]) => pattern.test(folded))?.[1] ?? "🧪";
}

export const formatBs = (amount: number): string => `Bs ${Number.isInteger(amount) ? amount : amount.toFixed(2).replace(".", ",")}`;

// Recibe SOLO la salida pública: estudios, precios y el total de los estudios cotizados. No afirma que el importe cubra toda la receta.
export function formatQuoteMessage(quote: PublicQuote): string {
  const lines = quote.studies.map((study) => `${emojiFor(study.name)} ${study.name} — ${formatBs(study.priceBs)}`);
  return [
    "🩺 *PlusMedik* · Cotización de tu receta",
    "",
    ...lines,
    "",
    `💰 *${quote.totalLabel}: ${formatBs(quote.totalBs)}*`,
    "",
    "Respóndenos por este chat para continuar. 😊"
  ].join("\n");
}

// Sin cotización automática (ningún estudio verificable, documento que no es una solicitud, etc.): se pide una mejor foto. No menciona estudios pendientes.
export const NO_QUOTE_MESSAGE = "🩺 *PlusMedik*\n\nNo pudimos generar la cotización con esta imagen. ¿Puedes enviarnos una foto más clara de tu receta, completa y bien iluminada? 📸";
export const TECHNICAL_ISSUE_MESSAGE = "🩺 *PlusMedik*\n\nTuvimos un inconveniente al revisar tu receta. Por favor, intenta enviarla de nuevo en unos minutos. 🙏";

// ───────────────────────────── orquestación (con dependencias inyectables) ─────────────────────────────

export interface QuoteDeps {
  downloadImage(image: IncomingImage): Promise<{ bytes: Uint8Array; contentType?: string }>;
  loadCatalog(): Promise<CatalogStudy[]>;
  analyze(args: { imageBase64: string; mimeType: string; catalog: CatalogStudy[] }): Promise<AnalysisResult>;
  sendText(to: string, body: string): Promise<void>;
  log(event: string, data: Record<string, unknown>): void;
  // Agrega el nombre (recortado) de lo leído en cada estudio al log de diagnóstico. Apagado por defecto.
  includeStudyText?: boolean;
}

export type QuoteResult = "quoted" | "no_quote" | "technical_issue" | "ignored";

// ───────────────────────────── registro de diagnóstico (minimizado) ─────────────────────────────
// El log del servidor explica por qué cada estudio se cotizó o quedó pendiente SIN datos personales ni clínicos innecesarios. Por defecto solo viajan códigos y
// enumeraciones: la decisión, los bloqueos, el riesgo visual, la certeza, códigos del catálogo y contadores. NUNCA se registran el teléfono completo, el
// texto de las líneas (lineText), ni texto libre de los modelos (razones del juez, notas de la verificación, evidencias de la función, avisos). El nombre de
// lo leído en cada estudio solo se agrega con `includeStudyText` (PILOT_LOG_STUDY_TEXT=on, para depurar un caso) y recortado.
export const LOG_TEXT_MAX = 60;
export const clipForLog = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LOG_TEXT_MAX);

export function buildAnalysisLog(analysis: AnalysisResult, options: { includeStudyText?: boolean } = {}): Record<string, unknown> {
  const internal = analysis.internal;
  const read = analysis.finalVisualStudies;
  const codeOfId = new Map((internal?.quoted.lines ?? []).map((line) => [line.id, line.code]));
  const lineGroups = new Map<string, number>();
  const groupOf = (lineText?: string): number | undefined => {
    if (!lineText) return undefined;
    const key = lineText.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!lineGroups.has(key)) lineGroups.set(key, lineGroups.size + 1);
    return lineGroups.get(key);
  };
  const studies = (internal?.studies ?? []).map((study, index) => {
    const source = read[index];
    return {
      i: index,
      ...(options.includeStudyText ? { text: clipForLog(study.text) } : {}),
      decision: study.decision,
      blockers: study.blockers,
      risk: study.risk?.class,
      codes: study.lineIds.map((id) => codeOfId.get(id)).filter(Boolean),
      confidence: source?.confidence,
      readBy: source?.source,
      certaintyResolvedByJudge: Boolean(source?.confidenceNote),
      lineGroup: groupOf(source?.lineText),
      inheritedAnalyte: Boolean(source?.inheritedFrom),
      collapsedRows: source?.collapsedFrom?.length,
      lineProblem: Boolean(source?.lineProblem)
    };
  });
  return {
    outcome: analysis.outcome,
    quotedCodes: internal?.quoted.lines.map((line) => line.code),
    studies,
    pending: internal?.pending.map((p) => ({
      kind: p.kind,
      // Los bloqueos de una disputa son texto libre del juez: no se registran.
      blockers: p.kind === "DISPUTE" ? undefined : p.blockers,
      candidates: p.candidates?.map((c) => c.code),
      ...(options.includeStudyText && p.text ? { text: clipForLog(p.text) } : {})
    })),
    recipeStops: internal?.recipeStops,
    documentType: internal?.document.type,
    documentFunction: internal?.document.function?.verdict,
    zones: internal?.document.zones.map((zone) => zone.kind),
    impact: internal?.document.impact && { available: internal.document.impact.available, qualifierRisk: internal.document.impact.qualifierRisk },
    disputes: analysis.disputes.map((dispute) => dispute.reason),
    judge: { confirmed: analysis.judgeResolved.filter((j) => j.verdict === "confirmed").length, rejected: analysis.judgeResolved.filter((j) => j.verdict === "rejected").length, unresolved: analysis.unresolvedDisputes.length },
    advisoryCount: internal?.advisories.length ?? 0
  };
}

export async function handleImageMessage(image: IncomingImage, deps: QuoteDeps): Promise<QuoteResult> {
  const who = maskPhone(image.from);
  let reply: string;
  let result: QuoteResult;
  try {
    const { bytes } = await deps.downloadImage(image);
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
      deps.log("image_rejected_size", { messageId: image.messageId, phone: who, bytes: bytes.length });
      return "ignored";
    }
    const mimeType = detectImageMime(bytes);
    if (!mimeType) {
      deps.log("image_rejected_type", { messageId: image.messageId, phone: who });
      reply = NO_QUOTE_MESSAGE;
      result = "no_quote";
    } else {
      const catalog = await deps.loadCatalog();
      const analysis = await deps.analyze({ imageBase64: Buffer.from(bytes).toString("base64"), mimeType, catalog });
      // Registro INTERNO (solo en el log del servidor, minimizado): lo pendiente y por qué. Nunca va al paciente.
      deps.log("analysis", { messageId: image.messageId, phone: who, ...buildAnalysisLog(analysis, { includeStudyText: deps.includeStudyText }) });
      if (analysis.publicQuote && analysis.outcome !== "HUMAN_REVIEW") {
        reply = formatQuoteMessage(analysis.publicQuote);
        result = "quoted";
      } else {
        reply = NO_QUOTE_MESSAGE;
        result = "no_quote";
      }
    }
  } catch (error) {
    deps.log("processing_failed", { messageId: image.messageId, phone: who, error: error instanceof Error ? error.message : String(error) });
    reply = TECHNICAL_ISSUE_MESSAGE;
    result = "technical_issue";
  }
  try {
    await deps.sendText(image.from, reply);
    deps.log("reply_sent", { messageId: image.messageId, phone: who, result });
  } catch (error) {
    deps.log("send_failed", { messageId: image.messageId, phone: who, error: error instanceof Error ? error.message : String(error) });
  }
  return result;
}
