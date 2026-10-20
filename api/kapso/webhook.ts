import { WhatsAppClient } from "@kapso/whatsapp-cloud-api";
import { waitUntil } from "@vercel/functions";
import { analyzeImage } from "../../src/analyze.js";
import { loadActiveCatalog } from "../../src/supabase-catalog.js";
import { extractIncomingImages, handleImageMessage, isAllowedPhone, verifyWebhookSignature, type IncomingImage, type QuoteDeps } from "../../src/whatsapp-quote.js";

// POST /api/kapso/webhook: recibe imágenes de WhatsApp (Kapso), las procesa con el motor de PlusMedik y responde con la cotización.
// Variables: WEBHOOK_SECRET, KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY (+ opcional ALLOWED_PHONES).

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
    analyzeImage({ imageBase64, mimeType, catalog, semanticPrimary: true, semanticAuto: true, partialAuto: true, handwrittenAuto: "on" }),
  async sendText(to, body) {
    await kapsoClient().messages.sendText({ phoneNumberId: phoneNumberId(), to, body });
  },
  log: (event, data) => console.log(JSON.stringify({ app: "plusmedik", event, ...data }))
};

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-webhook-signature"), process.env.WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const images = extractIncomingImages(payload, request.headers.get("x-webhook-batch")).filter((image) => isAllowedPhone(image.from, process.env.ALLOWED_PHONES));
  if (images.length === 0) return new Response("ignored", { status: 200 });

  // Se responde 200 de inmediato (así Kapso no reintenta) y el trabajo sigue en segundo plano.
  waitUntil(Promise.all(images.map((image) => handleImageMessage(image, realDeps))));
  return new Response("ok", { status: 200 });
}

export function GET(): Response {
  return new Response(JSON.stringify({ ok: true, service: "plusmedik-kapso-webhook" }), { status: 200, headers: { "content-type": "application/json" } });
}
