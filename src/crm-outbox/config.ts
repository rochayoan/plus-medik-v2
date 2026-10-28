import { createCrmReviewClient, CrmConfigError, MIN_TOKEN_LENGTH } from "./client.js";
import { MIN_KEY_LENGTH } from "./payload.js";
import { createSupabaseOutboxRepository } from "./repository.js";
import { CrmOutbox } from "./service.js";

// Arma la cola de salida hacia el CRM a partir del entorno. APAGADA por defecto: nada de esto existe a menos que el que despliega la encienda Y la configure completa.
//   PLUSMEDIK_CRM_HANDOFF=on          la enciende (solo tiene efecto con turnos y manejador de texto; ver api/kapso/webhook.ts)
//   PLUSMEDIK_CRM_REVIEW_URL          base HTTPS del CRM (se le agrega /api/internal/agent/review-case)
//   PLUSMEDIK_CRM_REVIEW_TOKEN        el MISMO token que el CRM tiene en PLUSMEDIK_AGENT_REVIEW_INGEST_TOKEN (≥ 32 caracteres; exclusivo agente→CRM)
//   PLUSMEDIK_OUTBOX_KEY              secreto (≥ 32 caracteres) para cifrar en reposo el cuerpo de los eventos (lleva el teléfono)
//   KAPSO_PHONE_NUMBER_ID             phone_number_id de WhatsApp del laboratorio (el CRM valida que el mensaje pertenezca a ese número)
// Una configuración incompleta o inválida NO enciende la derivación (sigue bloqueada) y deja un código en el log, nunca el valor.

export type CrmOutboxConfigError = "NOT_ENABLED" | "MISSING_URL" | "INVALID_URL" | "MISSING_TOKEN" | "INVALID_TOKEN" | "MISSING_KEY" | "INVALID_KEY" | "MISSING_PHONE_NUMBER_ID";

export function resolveCrmOutbox(env: Record<string, string | undefined>, log: (event: string, data: Record<string, unknown>) => void, overrides: { fetchFn?: typeof fetch } = {}): CrmOutbox | undefined {
  if (env.PLUSMEDIK_CRM_HANDOFF?.trim().toLowerCase() !== "on") return undefined;
  const fail = (error: CrmOutboxConfigError) => {
    log("crm_handoff_config_invalid", { error });
    return undefined;
  };
  const url = env.PLUSMEDIK_CRM_REVIEW_URL?.trim();
  const token = env.PLUSMEDIK_CRM_REVIEW_TOKEN;
  const key = env.PLUSMEDIK_OUTBOX_KEY;
  const phoneNumberId = env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!url) return fail("MISSING_URL");
  if (!token) return fail("MISSING_TOKEN");
  if (!key) return fail("MISSING_KEY");
  if (!phoneNumberId) return fail("MISSING_PHONE_NUMBER_ID");
  if (key.length < MIN_KEY_LENGTH) return fail("INVALID_KEY");
  if (token.length < MIN_TOKEN_LENGTH) return fail("INVALID_TOKEN");
  try {
    return new CrmOutbox({
      repository: createSupabaseOutboxRepository({ requestTimeoutMs: 3000, retryDelayMs: 200 }),
      client: createCrmReviewClient({ baseUrl: url, token, ...(overrides.fetchFn ? { fetchFn: overrides.fetchFn } : {}) }),
      encryptionKey: key, phoneNumberId, log
    });
  } catch (error) {
    return fail(error instanceof CrmConfigError && error.code === "TOKEN" ? "INVALID_TOKEN" : "INVALID_URL");
  }
}
