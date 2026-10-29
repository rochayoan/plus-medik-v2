import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnalysisResult } from "./analyze.js";
import { catalogFingerprint, processingFailureCode, type AuditRepository, type ProcessingPhase } from "./audit.js";
import { withAiCallObserver, type AiCallEvent } from "./cache.js";
import { runGuardedTurn, type Produced, type TurnContext, type TurnProducer, type TurnsConfig } from "./guarded-turn.js";
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
  // Opt-in: solo apéndice de preparación APROBADA, con rastro antes de envío. No altera el matching ni la cotización.
  quotePreparations?: (quote: string, studyIds: readonly string[], catalog: readonly CatalogStudy[], ctx: TurnContext) => Promise<string>;
  sendText(to: string, body: string): Promise<void | { providerMessageId?: string }>;
  log(event: string, data: Record<string, unknown>): void;
  audit?: AuditRepository;
  // Cada cuántos ms se renueva el lease mientras se procesa (por defecto 40 s con un lease de 120 s). Solo disponibilidad: la seguridad no depende de esto.
  leaseRenewIntervalMs?: number;
  // true: si el claim falla (la base no responde) NO se responde, porque no se puede demostrar que nadie más responderá. Por defecto false (política heredada).
  requireAuditGuard?: boolean;
  // Control de atención humana (ver human-control.ts). Si está presente: el contacto se identifica con una clave estable (HMAC) y SIN ella no se responde; un
  // contacto con la IA pausada no se procesa; la reserva y la comprobación final de envío vuelven a consultar la pausa; y el claim de la auditoría pasa a ser
  // obligatorio (como requireAuditGuard).
  humanControl?: { contactKeyFor(phone: string): string | undefined };
  // Control acotado a una lista explícita de contactos (sin control humano global): SOLO para los contactos que `covers` reconoce se aplica la misma exigencia que arriba (clave de contacto,
  // claim obligatorio, pausa comprobada en la reserva y antes de enviar). Para cualquier otro contacto el flujo es EXACTAMENTE el de siempre. Ignorado si humanControl está definido.
  scopedControl?: { contactKeyFor(phone: string): string | undefined; covers(phone: string): boolean };
  // Modo turnos (G2.0, ver guarded-turn.ts): numeración de turnos por contacto, un solo envío en vuelo por contacto y descarte de respuestas obsoletas. Implica la
  // misma exigencia que el control humano (clave estable del contacto y claim obligatorio). Sin esto el flujo es el de siempre.
  turns?: TurnsConfig;
}

export type QuoteResult = "quoted" | "no_quote" | "technical_issue" | "ignored";

// ───────────────────────────── registro de diagnóstico (minimizado) ─────────────────────────────
// El log del servidor explica por qué cada estudio se cotizó o quedó pendiente SIN datos personales ni clínicos innecesarios. Por defecto solo viajan códigos y
// enumeraciones: la decisión, los bloqueos, el riesgo visual, la certeza, códigos del catálogo y contadores. NUNCA se registran el teléfono completo, el
// texto de las líneas (lineText), ni texto libre de los modelos (razones del juez, notas de la verificación, evidencias de la función, avisos).
export const LOG_TEXT_MAX = 60;
export const clipForLog = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, LOG_TEXT_MAX);

export function buildAnalysisLog(analysis: AnalysisResult): Record<string, unknown> {
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
      decision: study.decision,
      blockers: study.blockers,
      uncertainty: study.uncertainty,
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
      uncertainty: p.uncertainty,
      // Los bloqueos de una disputa son texto libre del juez: no se registran.
      blockers: p.kind === "DISPUTE" ? undefined : p.blockers,
      candidates: p.candidates?.map((c) => c.code)
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

// El TRABAJO de un turno de imagen: descargar, analizar, registrar la evidencia y decidir qué responder. No reclama ni reserva ni envía: eso lo hace la máquina
// común de guarded-turn.ts (claim -> trabajo -> reserva -> comprobación final -> Kapso -> resultado), que es la que garantiza que nunca se responda dos veces.
export function imageProducer(image: IncomingImage, deps: QuoteDeps): TurnProducer {
  const who = maskPhone(image.from);
  return async (ctx): Promise<Produced> => {
    let reply: string;
    let result: "quoted" | "no_quote" | "technical_issue";
    let processingStatus: "COMPLETED" | "FAILED" = "COMPLETED";
    const aiCalls: AiCallEvent[] = [];
    // Etapa en curso: el código de fallo de la auditoría sale de DÓNDE falló el flujo, no del texto del error.
    let phase: ProcessingPhase = "MEDIA_DOWNLOAD";
    let evidenceAttempted = false;
    try {
      const { bytes } = await deps.downloadImage(image);
      phase = "OTHER";
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        deps.log("image_rejected_size", { messageId: image.messageId, phone: who, bytes: bytes.length });
        await ctx.persist("image", (audit, runId, lease) => audit.recordIgnored(runId, "IMAGE_SIZE", lease));
        return { kind: "none" };
      }
      const mimeType = detectImageMime(bytes);
      if (!mimeType) {
        deps.log("image_rejected_type", { messageId: image.messageId, phone: who });
        await ctx.persist("image", (audit, runId, lease) => audit.recordIgnored(runId, "IMAGE_TYPE", lease));
        reply = NO_QUOTE_MESSAGE;
        result = "no_quote";
      } else {
        phase = "CATALOG_LOAD";
        const catalog = await deps.loadCatalog();
        phase = "AI_ANALYSIS";
        const analysis = await withAiCallObserver(
          (event) => aiCalls.push(event),
          () => deps.analyze({ imageBase64: Buffer.from(bytes).toString("base64"), mimeType, catalog })
        );
        phase = "OTHER";
        // Registro INTERNO (solo en el log del servidor, minimizado): lo pendiente y por qué. Nunca va al paciente.
        deps.log("analysis", { messageId: image.messageId, phone: who, ...buildAnalysisLog(analysis) });
        // Todas las evidencias del análisis se confirman juntas o ninguna (una transacción en la base). Si falla, el envío al paciente sigue igual.
        evidenceAttempted = true;
        await ctx.persist("evidence", (audit, runId, lease) => audit.recordEvidence(runId, { analysis, aiCalls, catalog: catalogFingerprint(catalog) }, lease));
        if (analysis.publicQuote && analysis.outcome !== "HUMAN_REVIEW") {
          reply = formatQuoteMessage(analysis.publicQuote);
          if (deps.quotePreparations) {
            // Solo los estudios realmente MOSTRADOS al paciente (AUTO parcial puede excluir otros).
            const visible = new Set(analysis.publicQuote.studies.map((item) => `${item.name}|${item.priceBs}`));
            const ids = [...new Set((analysis.internal?.quoted.lines ?? analysis.quote?.lines ?? [])
              .filter((item) => visible.has(`${item.name}|${item.priceBs}`))
              .map((item) => item.id))];
            try {
              reply = await deps.quotePreparations(reply, ids, catalog, ctx);
            } catch {
              deps.log("quote_preparation_skipped", { reason: "APPEND_FAILED" });
            }
          }
          result = "quoted";
        } else {
          reply = NO_QUOTE_MESSAGE;
          result = "no_quote";
        }
      }
    } catch (error) {
      const errorCode = processingFailureCode(phase);
      deps.log("processing_failed", { messageId: image.messageId, phone: who, errorCode });
      if (!evidenceAttempted) await ctx.persist("evidence", (audit, runId, lease) => audit.recordEvidence(runId, { aiCalls }, lease));
      await ctx.persist("failure", (audit, runId, lease) => audit.recordFailure(runId, errorCode, lease));
      reply = TECHNICAL_ISSUE_MESSAGE;
      result = "technical_issue";
      processingStatus = "FAILED";
    }
    // En modo turnos: una cotización o su pedido de otra foto NUNCA se descartan en silencio; solo el aviso técnico puede quedar obsoleto si el paciente ya escribió de nuevo.
    return { kind: "reply", body: reply, result, processingStatus, stale: result === "technical_issue" ? "NEWER_TURN" : "NONE" };
  };
}

export const imageTurnRef = (image: IncomingImage) => ({ messageId: image.messageId, mediaId: image.mediaId, from: image.from, kind: "IMAGE" as const, who: maskPhone(image.from) });

export async function handleImageMessage(image: IncomingImage, deps: QuoteDeps): Promise<QuoteResult> {
  return (await runGuardedTurn(imageTurnRef(image), deps, imageProducer(image, deps))) as QuoteResult;
}
