import { randomUUID } from "node:crypto";
import type { TurnContext } from "../guarded-turn.js";
import type { CatalogStudy } from "../types.js";
import type { CrmClient, CrmResult } from "./client.js";
import { buildPayload, CipherError, decryptPayload, encryptPayload, evidenceOf, payloadHash, PayloadError, type CaseInput, type CrmReason, type DetectedTest } from "./payload.js";
import type { ClaimedEvent, EnqueueResult, OutboxRepository } from "./repository.js";
import type { CaseOutcome, CrmHandoff } from "./types.js";

// Servicio de la cola de salida hacia el CRM. Dos usos:
//   · submit / submitSessionReview: dentro de un turno. Guarda el caso (idempotente por mensaje) y hace el primer intento en línea. Solo un caso REGISTRADO por el CRM permite confirmarle la
//     derivación al paciente; todo lo demás queda en la cola y se reintenta sin que el paciente reciba nada más.
//   · drain: en segundo plano (ruta protegida). Reclama lo vencido y lo reintenta con retroceso. Repetir un envío es seguro: el CRM es idempotente por eventId (y por mensaje original).
// Nunca se registra el cuerpo, el teléfono, el token ni el texto de la respuesta del CRM: solo códigos.

export interface CrmOutboxOptions {
  repository: OutboxRepository;
  client: CrmClient;
  // Secreto (≥ 32 caracteres) con el que se cifra el cuerpo en reposo.
  encryptionKey: string;
  // phone_number_id de WhatsApp del laboratorio (lo exige el contrato del CRM).
  phoneNumberId: string;
  log(event: string, data: Record<string, unknown>): void;
  // Intentos en línea dentro del turno (por defecto 2, separados por immediateDelayMs). Cada uno cuenta para el máximo de intentos.
  immediateAttempts?: number;
  immediateDelayMs?: number;
  sleep?(ms: number): Promise<void>;
  leaseSeconds?: number;
  ttlSeconds?: number;
  maxAttempts?: number;
  ownerId?: () => string;
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  retry: number;
  dead: number;
  lost: number;
  failed: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Resultados que justifican un segundo intento inmediato dentro del turno (el CRM puede estar a punto de ingerir el mensaje original).
const WORTH_RETRYING_NOW: ReadonlySet<CrmResult> = new Set(["MESSAGE_NOT_INGESTED", "TIMEOUT", "NETWORK", "UNAVAILABLE", "SERVER_ERROR"]);

export class CrmOutbox implements CrmHandoff {
  private readonly immediateAttempts: number;
  private readonly immediateDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly leaseSeconds: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly ownerId: () => string;

  constructor(private readonly options: CrmOutboxOptions) {
    this.immediateAttempts = options.immediateAttempts ?? 2;
    this.immediateDelayMs = options.immediateDelayMs ?? 1500;
    this.sleep = options.sleep ?? realSleep;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.ttlSeconds = options.ttlSeconds ?? 604_800;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.ownerId = options.ownerId ?? (() => `outbox-${randomUUID()}`);
  }

  async submit(ctx: TurnContext, cases: readonly CaseInput[]): Promise<CaseOutcome[]> {
    const outcomes: CaseOutcome[] = [];
    for (const input of cases) outcomes.push(await this.submitOne(ctx, input));
    return outcomes;
  }

  private async submitOne(ctx: TurnContext, input: CaseInput): Promise<CaseOutcome> {
    const { log } = this.options;
    let enqueued: EnqueueResult | undefined;
    let failure: string | undefined;
    const stored = await ctx.persist("crm_enqueue", async (_audit, runId, lease) => {
      const origin = input.originRunId ?? runId;
      let built;
      try {
        built = buildPayload(input, origin, this.options.phoneNumberId);
      } catch (error) {
        failure = error instanceof PayloadError ? error.code : "PAYLOAD";
        return;
      }
      enqueued = await this.options.repository.enqueue(runId, lease, {
        originRunId: origin, kind: input.kind, kapsoMessageId: input.kapsoMessageId, reasons: [...new Set(input.reasons)], cipher: encryptPayload(built, this.options.encryptionKey),
        hash: payloadHash(built), evidence: evidenceOf(input, built), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ttlSeconds: this.ttlSeconds, maxAttempts: this.maxAttempts
      });
    });
    if (!stored || !enqueued) {
      log("crm_outbox", { event: "enqueue_failed", ...(failure ? { code: failure } : {}) });
      return { state: "FAILED", code: failure ?? "ENQUEUE_FAILED" };
    }
    log("crm_outbox", { event: enqueued.status === "created" ? "enqueued" : "already_enqueued", state: enqueued.state, reasons: [...new Set(input.reasons)] });
    if (enqueued.state === "SENT") return { state: "REGISTERED", eventId: enqueued.eventId, ...(enqueued.delivery ? { delivery: enqueued.delivery } : {}) };
    if (enqueued.state === "DEAD") return { state: "DEAD", eventId: enqueued.eventId };

    // Primer intento en línea: solo se confirma al paciente si el CRM ya registró el caso.
    for (let attempt = 1; attempt <= this.immediateAttempts; attempt++) {
      const owner = this.ownerId();
      let claimed: ClaimedEvent[];
      try {
        claimed = await this.options.repository.claim(owner, { limit: 1, leaseSeconds: this.leaseSeconds, outboxId: enqueued.outboxId, force: true });
      } catch {
        log("crm_outbox", { event: "claim_failed" });
        break;
      }
      // Otro proceso lo tiene en vuelo (o ya no es elegible): él se encarga; aquí no se confirma nada.
      if (claimed.length === 0) break;
      const delivered = await this.deliver(claimed[0]!, owner);
      if (delivered.state === "REGISTERED" || delivered.state === "DEAD") return { state: delivered.state, eventId: enqueued.eventId, ...(delivered.delivery ? { delivery: delivered.delivery } : {}) };
      if (attempt < this.immediateAttempts && delivered.result && WORTH_RETRYING_NOW.has(delivered.result)) await this.sleep(this.immediateDelayMs);
      else break;
    }
    return { state: "PENDING", eventId: enqueued.eventId };
  }

  // Descifra, envía y registra el resultado. Un fallo al registrar NO se trata como entrega: el evento queda en vuelo, su arrendamiento vence y se reintenta (el CRM deduplica).
  private async deliver(event: ClaimedEvent, owner: string): Promise<{ state: CaseOutcome["state"] | "RETRY" | "LOST"; delivery?: "CREATED" | "DUPLICATE"; result?: CrmResult }> {
    const { log } = this.options;
    let result: CrmResult;
    let httpStatus: number | undefined;
    let durationMs: number | undefined;
    try {
      const payload = decryptPayload(event.cipher, event.eventId, this.options.encryptionKey);
      const sent = await this.options.client.send(payload);
      result = sent.result;
      httpStatus = sent.httpStatus;
      durationMs = sent.durationMs;
    } catch (error) {
      // Un cuerpo que no se puede descifrar no mejora reintentando: se descarta como rechazo permanente (a la vista), sin mostrar nada de él.
      if (!(error instanceof CipherError)) throw error;
      result = "INVALID";
      log("crm_outbox", { event: "decrypt_failed" });
    }
    let recorded;
    try {
      recorded = await this.options.repository.record(event.outboxId, owner, event.fence, { result, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
    } catch {
      log("crm_outbox", { event: "record_failed", result });
      return { state: "RETRY", result };
    }
    log("crm_outbox", { event: "attempt", attempt: event.attempt, result, ...(httpStatus !== undefined ? { httpStatus } : {}), outcome: recorded.status });
    if (recorded.status === "sent") return { state: "REGISTERED", delivery: recorded.delivery, result };
    if (recorded.status === "already_sent") return { state: "REGISTERED", result };
    if (recorded.status === "dead") return { state: "DEAD", result };
    if (recorded.status === "lost") return { state: "LOST", result };
    return { state: "RETRY", result };
  }

  // Reintenta lo vencido. Cada reclamo cuenta un intento; con concurrencia acotada para no saturar al CRM.
  async drain(options: { limit?: number; concurrency?: number } = {}): Promise<DrainSummary> {
    const owner = this.ownerId();
    const claimed = await this.options.repository.claim(owner, { limit: options.limit ?? 20, leaseSeconds: this.leaseSeconds });
    const summary: DrainSummary = { claimed: claimed.length, sent: 0, retry: 0, dead: 0, lost: 0, failed: 0 };
    const queue = [...claimed];
    const worker = async () => {
      for (let event = queue.shift(); event; event = queue.shift()) {
        try {
          const outcome = await this.deliver(event, owner);
          if (outcome.state === "REGISTERED") summary.sent++;
          else if (outcome.state === "DEAD") summary.dead++;
          else if (outcome.state === "LOST") summary.lost++;
          else summary.retry++;
        } catch {
          summary.failed++;
          this.options.log("crm_outbox", { event: "drain_item_failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 10)) }, worker));
    this.options.log("crm_outbox", { event: "drained", ...summary });
    return summary;
  }

  async submitSessionReview(ctx: TurnContext, args: { sessionId: string; contactPhone: string; catalog: readonly CatalogStudy[] }): Promise<CaseOutcome[]> {
    let targets;
    const ok = await ctx.persist("crm_targets", async (_audit, runId, lease) => {
      targets = await this.options.repository.reviewTargets(runId, lease, args.sessionId);
    });
    if (!ok || !targets) return [];
    const found = targets as NonNullable<Awaited<ReturnType<OutboxRepository["reviewTargets"]>>>;
    const names = new Map(args.catalog.map((study) => [study.id, study.name]));
    const detected = (ids: readonly string[], group?: number): DetectedTest[] => ids.map((id) => ({ catalogTestId: id, name: names.get(id) ?? "(no disponible en el catálogo)", ...(group !== undefined ? { ambiguousGroup: group } : {}) }));
    const cases: CaseInput[] = found.items.slice(0, 20).map((item) => {
      const reasons = new Set<CrmReason>();
      if (item.status === "AMBIGUOUS" || item.ambiguous.length > 0) reasons.add("AMBIGUOUS_STUDY");
      if (item.status === "UNRESOLVED" || item.unresolved > 0) reasons.add("UNRESOLVED_TEXT");
      if (item.status === "UNCERTAIN") reasons.add("ENGINE_PARTIAL");
      return {
        originRunId: item.runId, kapsoMessageId: item.kapsoMessageId, mediaId: item.mediaId, contactPhone: args.contactPhone, kind: "REVIEW_CASE" as const, reasons: [...reasons],
        detectedTests: [...detected(item.studyIds), ...item.ambiguous.flatMap((group, index) => detected(group, index + 1))], sessionId: args.sessionId, itemStatus: item.status,
        counts: { studies: item.studyIds.length, ambiguousGroups: item.ambiguous.length, unresolved: item.unresolved }
      };
    });
    // Motivos de TODA la solicitud (un estudio ya no está en el catálogo, un precio inválido): se anclan al mensaje que la cerró.
    const wide = found.sessionReasons.filter((reason): reason is "STUDY_UNAVAILABLE" | "PRICE_INVALID" => reason === "STUDY_UNAVAILABLE" || reason === "PRICE_INVALID");
    if (wide.length > 0 && found.closing.runId && found.closing.kapsoMessageId) {
      cases.push({ originRunId: found.closing.runId, kapsoMessageId: found.closing.kapsoMessageId, contactPhone: args.contactPhone, kind: "REVIEW_CASE", reasons: wide, sessionId: args.sessionId });
    }
    return cases.length === 0 ? [] : this.submit(ctx, cases);
  }
}
