import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { waitUntil } from "@vercel/functions";
import { analyzeImage } from "../../src/analyze.js";
import { createSupabaseAuditRepository, type AuditRepository } from "../../src/audit.js";
import { loadActiveCatalog } from "../../src/supabase-catalog.js";
import { contactKeyOf, createAttentionRepository, type AttentionRepository } from "../../src/human-control.js";
import { handleKapsoWebhook } from "../../src/kapso-webhook.js";
import type { IncomingImage, QuoteDeps } from "../../src/whatsapp-quote.js";

// POST /api/kapso/webhook: recibe imágenes de WhatsApp (Kapso), las procesa con el motor de PlusMedik y responde con la cotización.
// Variables: WEBHOOK_SECRET, KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY (+ opcional ALLOWED_PHONES).
// Control de atención humana (APAGADO por defecto; ver README): PLUSMEDIK_HUMAN_CONTROL=on lo activa y exige PLUSMEDIK_CONTACT_HMAC_KEY (clave dedicada, >= 32 caracteres).
// Sin la clave, con el control activo, no se responde a nadie (falla cerrado). REQUIRE_AUDIT_GUARD=on exige el claim aunque el control esté apagado.
const on = (name: string) => process.env[name]?.trim().toLowerCase() === "on";
const humanControlEnabled = on("PLUSMEDIK_HUMAN_CONTROL");
const contactKeyFor = (phone: string) => contactKeyOf({ hmacKey: process.env.PLUSMEDIK_CONTACT_HMAC_KEY, labPhoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID, contactPhone: phone });

// El sistema de archivos de Vercel es de solo lectura: sin caché local (el registro de uso, si se escribe, va a /tmp).
process.env.AI_CACHE ??= "off";
process.env.AI_CACHE_DIR ??= "/tmp/plusmedik-cache";

function kapsoClient(): WhatsAppClient {
  const kapsoApiKey = process.env.KAPSO_API_KEY;
  if (!kapsoApiKey) throw new Error("Missing KAPSO_API_KEY");
  return new WhatsAppClient({ baseUrl: "https://api.kapso.ai/meta/whatsapp", kapsoApiKey });
}

function phoneNumberId(): string {
  const id = process.env.KAPSO_PHONE_NUMBER_ID;
  if (!id) throw new Error("Missing KAPSO_PHONE_NUMBER_ID");
  return id;
}

// Banderas del motor en producción: una sola fuente para el análisis y para el registro de auditoría (qué configuración produjo cada análisis).
const ENGINE_FLAGS = { semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" } as const;

let auditRepository: AuditRepository | undefined;
function audit(): AuditRepository {
  return auditRepository ??= createSupabaseAuditRepository({ runtime: { flags: ENGINE_FLAGS } });
}

const realDeps: QuoteDeps = {
  async downloadImage(image: IncomingImage) {
    const client = kapsoClient();
    if (image.mediaUrl) {
      // Las URLs de medios alojados suelen ser públicas/firmadas; si rechazan, se reintenta con la autenticación de Kapso.
      let response = await client.rawFetch(image.mediaUrl);
      if (response.status === 401 || response.status === 403) response = await client.fetch(image.mediaUrl);
      if (!response.ok) throw new Error(`media download failed: HTTP ${response.status}`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? undefined };
    }
    const data = (await client.media.download({ mediaId: image.mediaId!, phoneNumberId: phoneNumberId(), as: "arrayBuffer" })) as ArrayBuffer;
    return { bytes: new Uint8Array(data) };
  },
  loadCatalog: () => loadActiveCatalog(),
  // Motor actual de PlusMedik, con las banderas ya validadas pasadas por argumento (no se modifica el AUTO MATCH).
  analyze: ({ imageBase64, mimeType, catalog }) =>
    analyzeImage({ imageBase64, mimeType, catalog, ...ENGINE_FLAGS }),
  async sendText(to, body) {
    const response = await kapsoClient().messages.sendText({ phoneNumberId: phoneNumberId(), to, body });
    return { providerMessageId: response.messages[0]?.id };
  },
  audit: {
    claim: (...args) => audit().claim(...args),
    renewLease: (...args) => audit().renewLease(...args),
    recordIgnored: (...args) => audit().recordIgnored(...args),
    recordEvidence: (...args) => audit().recordEvidence(...args),
    recordFailure: (...args) => audit().recordFailure(...args),
    reserveSend: (...args) => audit().reserveSend(...args),
    confirmSend: (...args) => audit().confirmSend(...args),
    recordReply: (...args) => audit().recordReply(...args)
  },
  log: (event, data) => console.log(JSON.stringify({ app: "plusmedik", event, ...data })),
  requireAuditGuard: humanControlEnabled || on("REQUIRE_AUDIT_GUARD"),
  humanControl: humanControlEnabled ? { contactKeyFor } : undefined
};

// Plazos cortos para el registro de la pausa (se hace ANTES de responder; Kapso concede 10 s): 2 intentos de 3 s.
let attentionRepository: AttentionRepository | undefined;
const attention = (): AttentionRepository => (attentionRepository ??= createAttentionRepository({ requestTimeoutMs: 3000, retryDelayMs: 200 }));

const attentionProxy: AttentionRepository = {
  status: (...args) => attention().status(...args),
  registerHumanMessage: (...args) => attention().registerHumanMessage(...args),
  recordEvent: (...args) => attention().recordEvent(...args),
  resume: (...args) => attention().resume(...args)
};

export async function POST(request: Request): Promise<Response> {
  return handleKapsoWebhook(request, {
    secret: process.env.WEBHOOK_SECRET,
    allowedPhones: process.env.ALLOWED_PHONES,
    quote: realDeps,
    schedule: (task) => waitUntil(task),
    humanControl: humanControlEnabled ? { labPhoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID, contactKeyFor, attention: attentionProxy } : undefined,
    log: realDeps.log
  });
}

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true, service: "plusmedik-kapso-webhook" }), { status: 200, headers: { "content-type": "application/json" } });
}
