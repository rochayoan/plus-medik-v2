import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Cuerpo del evento hacia el CRM (contrato REAL: CRM-PLUSMEDIK/docs/AGENT_REVIEW_CASE_CONTRACT.md, receptor src/app/api/internal/agent/review-case/route.ts) y su cifrado en reposo.
// El cuerpo lleva el teléfono (el contrato lo exige) y, por eso, en la base solo existe CIFRADO (AES-256-GCM, ligado al eventId); se borra al entregarse o vencer. Lo que queda como evidencia
// permanente son códigos, contadores y el hash del cuerpo. Nunca texto del paciente.

export const CRM_REASONS = ["HUMAN_REQUEST", "MEDICAL_QUERY", "NO_APPROVED_ANSWER", "AMBIGUOUS_STUDY", "UNRESOLVED_TEXT", "ENGINE_PARTIAL", "UNREADABLE_IMAGE", "STUDY_UNAVAILABLE", "PRICE_INVALID"] as const;
export type CrmReason = (typeof CRM_REASONS)[number];
export type CaseKind = "REVIEW_CASE" | "CONVERSATION";

// Qué le dice cada código a quien revisa (texto fijo; sin datos del paciente).
export const REASON_DESCRIPTIONS: Record<CrmReason, string> = {
  HUMAN_REQUEST: "el paciente pidió hablar con una persona",
  MEDICAL_QUERY: "consulta de salud que el agente no responde",
  NO_APPROVED_ANSWER: "pregunta sin respuesta aprobada disponible",
  AMBIGUOUS_STUDY: "un nombre coincide con más de un estudio del catálogo",
  UNRESOLVED_TEXT: "un estudio escrito no coincide con ningún estudio del catálogo",
  ENGINE_PARTIAL: "el motor de recetas dejó estudios sin identificar con certeza",
  UNREADABLE_IMAGE: "imagen que no se pudo leer",
  STUDY_UNAVAILABLE: "un estudio identificado ya no está activo en el catálogo",
  PRICE_INVALID: "un estudio identificado no tiene un precio válido en el catálogo"
};

// Etiqueta del caso para quien lo recibe en el CRM (convenio/aliado, domicilio). NO es un motivo de la cola (la base guarda uno de CRM_REASONS): solo encabeza el texto `failureReason`, que el CRM lee por su
// prefijo para avisar y etiquetar. Texto fijo, sin datos del paciente.
export const CASE_LABELS = ["ALLIED_LAB", "HOME_VISIT", "RESULTS_READY"] as const;
export type CaseLabel = (typeof CASE_LABELS)[number];
export const LABEL_DESCRIPTIONS: Record<CaseLabel, string> = {
  ALLIED_LAB: "convenio o laboratorio aliado: lo atiende una persona (el agente no responde)",
  HOME_VISIT: "solicitud de estudio a domicilio: un asesor confirma disponibilidad y costo",
  RESULTS_READY: "el paciente pregunta por un resultado ya realizado: recepción verifica con el nombre del paciente o el comprobante"
};

export interface DetectedTest {
  catalogTestId?: string;
  name: string;
  // Ambigüedad: número de grupo cuando el nombre pudo ser cualquiera de varios estudios.
  ambiguousGroup?: number;
}

// Lo que quiere derivar quien llama. Todo son códigos e ids del catálogo.
export interface CaseInput {
  // Corrida del mensaje original (la ancla del caso en el CRM). Sin indicarla, la del turno en curso.
  originRunId?: string;
  kapsoMessageId: string;
  mediaId?: string | null;
  contactPhone: string;
  kind: CaseKind;
  reasons: readonly CrmReason[];
  // Si se indica, `failureReason` empieza por este código (y agentResult lo lleva en reasonCodes). Los motivos de la cola siguen siendo los de `reasons`.
  label?: CaseLabel;
  detectedTests?: readonly DetectedTest[];
  sessionId?: string;
  itemStatus?: string;
  counts?: { studies?: number; ambiguousGroups?: number; unresolved?: number };
}

export interface CrmReviewPayload {
  eventId: string;
  requiresReview: true;
  kapsoMessageId: string;
  contactPhone: string;
  phoneNumberId: string;
  recipeMediaId: string | null;
  failureReason: string;
  auditId: string;
  agentResult: Record<string, unknown>;
  detectedTests: DetectedTest[];
}

export class PayloadError extends Error {
  constructor(readonly code: "INVALID_PHONE" | "INVALID_MESSAGE" | "INVALID_REASONS" | "INVALID_RUN" | "TOO_LARGE") {
    super(`crm_payload_${code.toLowerCase()}`);
    this.name = "PayloadError";
  }
}

// Límites del receptor (route.ts): eventId ≤ 120, kapsoMessageId ≤ 255, teléfono ≥ 8 dígitos, failureReason ≤ 1000, detectedTests ≤ 60 y agentResult + detectedTests ≤ 40.000 caracteres.
export const LIMITS = { eventId: 120, message: 255, failureReason: 1000, detectedTests: 60, evidence: 40_000, name: 200 } as const;

export const eventIdOf = (originRunId: string): string => `plusmedik-review:${originRunId}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clip = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export function buildPayload(input: CaseInput, originRunId: string, phoneNumberId: string): CrmReviewPayload {
  if (!UUID.test(originRunId)) throw new PayloadError("INVALID_RUN");
  const phone = input.contactPhone.replace(/\D/g, "");
  if (phone.length < 8 || phone.length > 20) throw new PayloadError("INVALID_PHONE");
  if (!input.kapsoMessageId || input.kapsoMessageId.length > LIMITS.message || !phoneNumberId || phoneNumberId.length > LIMITS.message) throw new PayloadError("INVALID_MESSAGE");
  const reasons = [...new Set(input.reasons)];
  if (reasons.length < 1 || reasons.length > 4 || reasons.some((reason) => !(CRM_REASONS as readonly string[]).includes(reason))) throw new PayloadError("INVALID_REASONS");
  const eventId = eventIdOf(originRunId);
  if (eventId.length > LIMITS.eventId) throw new PayloadError("INVALID_RUN");

  // Códigos, no texto libre: «CODIGO: descripción fija; …».
  const described = reasons.map((reason) => `${reason}: ${REASON_DESCRIPTIONS[reason]}`);
  const failureReason = clip((input.label ? [`${input.label}: ${LABEL_DESCRIPTIONS[input.label]}`, ...described] : described).join("; "), LIMITS.failureReason);
  const agentResult: Record<string, unknown> = {
    source: "plusmedik-v2", schema: 1, kind: input.kind, reasonCodes: input.label ? [input.label, ...reasons] : reasons,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.itemStatus ? { itemStatus: input.itemStatus } : {}), ...(input.counts ? { counts: input.counts } : {})
  };
  let detectedTests: DetectedTest[] = (input.detectedTests ?? []).slice(0, LIMITS.detectedTests).map((test) => ({
    ...(test.catalogTestId && UUID.test(test.catalogTestId) ? { catalogTestId: test.catalogTestId } : {}), name: clip(test.name, LIMITS.name), ...(test.ambiguousGroup !== undefined ? { ambiguousGroup: test.ambiguousGroup } : {})
  }));
  // Si la evidencia excede el límite del receptor, se poda la lista de estudios (nunca el motivo) y se deja constancia en el propio resultado.
  const size = () => JSON.stringify({ agentResult, detectedTests }).length;
  while (size() > LIMITS.evidence && detectedTests.length > 0) {
    detectedTests = detectedTests.slice(0, Math.floor(detectedTests.length / 2));
    agentResult.detectedTestsTruncated = true;
  }
  if (size() > LIMITS.evidence) throw new PayloadError("TOO_LARGE");
  return {
    eventId, requiresReview: true, kapsoMessageId: input.kapsoMessageId, contactPhone: phone, phoneNumberId, recipeMediaId: input.mediaId ? clip(input.mediaId, LIMITS.message) : null,
    failureReason, auditId: originRunId, agentResult, detectedTests
  };
}

// Evidencia permanente del evento: SOLO códigos y contadores (nunca el teléfono ni nombres de estudios).
export function evidenceOf(input: CaseInput, payload: CrmReviewPayload): Record<string, unknown> {
  return {
    schema: 1, reasonCodes: [...new Set(input.reasons)], kind: input.kind, studies: payload.detectedTests.length,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.itemStatus ? { itemStatus: input.itemStatus } : {}), ...(input.counts ? { counts: input.counts } : {}),
    ...(payload.agentResult.detectedTestsTruncated ? { truncated: true } : {})
  };
}

// JSON canónico (claves ordenadas): el MISMO cuerpo produce siempre el mismo hash y los mismos bytes en cada reintento.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export const payloadHash = (payload: CrmReviewPayload): string => createHash("sha256").update(canonicalJson(payload)).digest("hex");

// ───────────────────────────── cifrado en reposo ─────────────────────────────
export class CipherError extends Error {
  constructor() {
    super("crm_payload_cipher");
    this.name = "CipherError";
  }
}
export const MIN_KEY_LENGTH = 32;
const keyBytes = (secret: string): Buffer => {
  if (secret.length < MIN_KEY_LENGTH) throw new CipherError();
  return createHash("sha256").update(`plusmedik-outbox-v1:${secret}`).digest();
};
const b64 = (buffer: Buffer) => buffer.toString("base64url");

// v1.<iv>.<tag>.<texto cifrado>; el eventId va como dato autenticado: un cuerpo cifrado de un evento no se puede pasar por el de otro.
export function encryptPayload(payload: CrmReviewPayload, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(secret), iv);
  cipher.setAAD(Buffer.from(payload.eventId));
  const body = Buffer.concat([cipher.update(canonicalJson(payload), "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(body)}`;
}

export function decryptPayload(cipherText: string, eventId: string, secret: string): CrmReviewPayload {
  try {
    const [version, iv, tag, body] = cipherText.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new CipherError();
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(secret), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(eventId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8")) as CrmReviewPayload;
    if (payload.eventId !== eventId) throw new CipherError();
    return payload;
  } catch {
    throw new CipherError();
  }
}
