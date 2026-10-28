import type { CatalogStudy } from "../types.js";
import { scheduleStatusAt, type ScheduleStatus } from "./schedule.js";
import type { KnowledgeStore } from "./store.js";
import {
  available, PAYLOAD_SCHEMAS, snapshotItem, unavailable,
  type BranchPayload, type FaqPayload, type KnowledgeKind, type KnowledgeResult, type OmittedItem, type PaymentMethodPayload, type PolicyPayload, type Provenance,
  type ScheduleService, type SchedulePayload, type SnapshotItem, type StudyPreparationPayload, type UnavailableReason
} from "./types.js";

// Consulta del conocimiento APROBADO del laboratorio para el manejador conversacional. Reglas:
//   · Solo se entrega lo que está aprobado Y vigente en el instante de la consulta. La caducidad se evalúa al usar el dato, aunque la copia local sea más vieja.
//   · Si falta, venció, no es válido o no se puede consultar, el resultado es UNAVAILABLE con una razón codificada: nunca texto inventado, nunca "no requiere".
//   · Esta capa no conoce recetas, cotizaciones ni precios: del catálogo solo mira id, nombre y si está activo.
//
// Caché e invalidación: se guarda la última instantánea con su revisión. Como máximo cada `revisionCheckMs` se consulta la revisión (barata); si cambió, se recarga TODA la
// instantánea (una sola recarga a la vez, nunca se sustituye por una más vieja). Si la base no responde se sigue usando la copia hasta `maxStaleMs` desde la última
// verificación exitosa; pasado ese plazo todo es "no disponible" (falla cerrado). `invalidate()` fuerza la recarga en la siguiente consulta. Límite: tras retirar un dato
// en la base, una instancia puede seguir usándolo hasta `revisionCheckMs` (por defecto 15 s) salvo que se invalide; la caducidad nunca depende de la caché.

export interface KnowledgeServiceOptions {
  store: KnowledgeStore;
  now?: () => Date;
  revisionCheckMs?: number;
  maxStaleMs?: number;
}

export const DEFAULT_REVISION_CHECK_MS = 15_000;
export const DEFAULT_MAX_STALE_MS = 300_000;

interface Entry {
  item: SnapshotItem;
  // undefined si el contenido no cumple el contrato (no se usa).
  payload?: unknown;
}

interface Cache {
  revision: number;
  entries: Map<string, Entry>;
  byKind: Map<KnowledgeKind, Entry[]>;
  verifiedAt: number;
  rejected: number;
}

const idOf = (kind: KnowledgeKind, key: string) => `${kind}|${key}`;
const time = (value: string | null): number | undefined => (value ? Date.parse(value) : undefined);

export interface BranchView extends BranchPayload { key: string }
export interface PolicyView extends PolicyPayload { key: string }
export interface FaqView extends FaqPayload { key: string }
export type ScheduleView = SchedulePayload & { key: string };

export interface StudyPreparationView {
  studyId: string;
  studyName: string;
  prepState: StudyPreparationPayload["prepState"];
  fastingHours?: number;
  instructions?: string;
  collectionWindow?: string;
}
export interface StudyPreparationItem {
  studyId: string;
  studyName?: string;
  result: KnowledgeResult<StudyPreparationView>;
}
// AVAILABLE = todos los estudios consultados tienen preparación aprobada y vigente; PARTIAL = algunos; UNAVAILABLE = ninguno. NO hay consolidación clínica automática (p. ej. el
// ayuno máximo de varios estudios): esa regla la decide el laboratorio y hoy no existe. Cada estudio se informa por separado.
export interface StudyPreparationResult {
  status: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  items: StudyPreparationItem[];
}

export class KnowledgeService {
  private cache?: Cache;
  private inflight?: Promise<void>;
  private forceReload = false;
  private readonly now: () => Date;
  private readonly revisionCheckMs: number;
  private readonly maxStaleMs: number;
  private readonly store: KnowledgeStore;

  constructor(options: KnowledgeServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.revisionCheckMs = options.revisionCheckMs ?? DEFAULT_REVISION_CHECK_MS;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  }

  // Descarta la confianza en la copia local: la próxima consulta recarga desde la base.
  invalidate(): void {
    this.forceReload = true;
  }

  // Elementos de la copia local descartados por no cumplir el contrato (diagnóstico).
  get rejectedCount(): number {
    return this.cache?.rejected ?? 0;
  }
  get cachedRevision(): number | undefined {
    return this.cache?.revision;
  }

  // ───────────────────────── carga ─────────────────────────
  private build(revision: number, items: unknown[], verifiedAt: number): Cache {
    const entries = new Map<string, Entry>();
    const byKind = new Map<KnowledgeKind, Entry[]>();
    let rejected = 0;
    for (const raw of items) {
      const parsed = snapshotItem.safeParse(raw);
      if (!parsed.success) { rejected++; continue; }
      const item = parsed.data;
      const payload = PAYLOAD_SCHEMAS[item.kind].safeParse(item.payload);
      // Coherencia: la clave de una preparación DEBE ser la de su estudio.
      const coherent = item.kind !== "STUDY_PREPARATION" || (payload.success && item.key === `study:${(payload.data as StudyPreparationPayload).labTestId}`);
      const entry: Entry = { item, ...(payload.success && coherent ? { payload: payload.data } : {}) };
      if (entry.payload === undefined) rejected++;
      entries.set(idOf(item.kind, item.key), entry);
      byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), entry]);
    }
    return { revision, entries, byKind, verifiedAt, rejected };
  }

  private async load(): Promise<void> {
    const snapshot = await this.store.snapshot();
    // Nunca se pisa una copia más NUEVA con una más vieja (dos instancias de recarga solapadas).
    if (this.cache && snapshot.revision < this.cache.revision) {
      this.cache.verifiedAt = this.now().getTime();
      return;
    }
    this.cache = this.build(snapshot.revision, snapshot.items, this.now().getTime());
  }

  // true = hay una copia utilizable (fresca o dentro del plazo máximo de antigüedad).
  private async ensureFresh(): Promise<boolean> {
    const nowMs = this.now().getTime();
    const cache = this.cache;
    if (cache && !this.forceReload && nowMs - cache.verifiedAt < this.revisionCheckMs) return true;
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          if (this.cache && !this.forceReload) {
            const revision = await this.store.revision();
            if (revision === this.cache.revision) { this.cache.verifiedAt = this.now().getTime(); return; }
          }
          this.forceReload = false;
          await this.load();
        } catch {
          // la base no respondió: se decide abajo según la antigüedad de la copia
        }
      })().finally(() => { this.inflight = undefined; });
    }
    await this.inflight;
    const current = this.cache;
    return current !== undefined && !this.forceReload && this.now().getTime() - current.verifiedAt <= this.maxStaleMs;
  }

  // ───────────────────────── resolución ─────────────────────────
  private state(entry: Entry, nowMs: number): UnavailableReason | "OK" {
    if (entry.payload === undefined) return "INVALID_CONTENT";
    const from = time(entry.item.validFrom);
    const until = time(entry.item.validUntil);
    if (until === undefined || Number.isNaN(until) || (from !== undefined && Number.isNaN(from))) return "INVALID_CONTENT";
    if (from !== undefined && nowMs < from) return "NOT_YET_VALID";
    if (nowMs >= until) return "EXPIRED";
    return "OK";
  }

  private provenance(entry: Entry): Provenance {
    const { item } = entry;
    return { kind: item.kind, key: item.key, version: item.version, approvedAt: item.approvedAt, approvedBy: item.approvedBy, validUntil: item.validUntil, contentHash: item.contentHash };
  }

  private async one<T>(kind: KnowledgeKind, key: string): Promise<KnowledgeResult<T>> {
    if (!(await this.ensureFresh())) return unavailable(kind, "STORE_UNAVAILABLE", key);
    const entry = this.cache!.entries.get(idOf(kind, key));
    if (!entry) return unavailable(kind, "NO_APPROVED_VERSION", key);
    const state = this.state(entry, this.now().getTime());
    return state === "OK" ? available(entry.payload as T, [this.provenance(entry)]) : unavailable(kind, state, key);
  }

  // Lista los elementos VIGENTES de un tipo (con filtro opcional). Los no utilizables se informan en `omitted`; si no queda ninguno, se devuelve la razón más grave.
  private async many<P, V>(kind: KnowledgeKind, pick: (payload: P, key: string) => V | undefined): Promise<KnowledgeResult<V[]>> {
    if (!(await this.ensureFresh())) return unavailable(kind, "STORE_UNAVAILABLE");
    const nowMs = this.now().getTime();
    const data: V[] = [];
    const provenance: Provenance[] = [];
    const omitted: OmittedItem[] = [];
    for (const entry of this.cache!.byKind.get(kind) ?? []) {
      const state = this.state(entry, nowMs);
      if (state !== "OK") {
        // un elemento inválido o vencido solo cuenta como omitido si podría haber pertenecido al filtro; sin payload no se puede saber: se informa siempre
        if (entry.payload === undefined || pick(entry.payload as P, entry.item.key) !== undefined) omitted.push({ key: entry.item.key, reason: state });
        continue;
      }
      const view = pick(entry.payload as P, entry.item.key);
      if (view === undefined) continue;
      data.push(view);
      provenance.push(this.provenance(entry));
    }
    if (data.length > 0) return available(data, provenance, omitted);
    if (omitted.length === 0) return unavailable(kind, "NO_APPROVED_VERSION");
    const reasons = new Set(omitted.map((item) => item.reason));
    const worst: UnavailableReason = (["INVALID_CONTENT", "EXPIRED", "NOT_YET_VALID"] as const).find((reason) => reasons.has(reason)) ?? "NO_APPROVED_VERSION";
    return unavailable(kind, worst);
  }

  // ───────────────────────── consultas administrativas ─────────────────────────
  async getBranches(): Promise<KnowledgeResult<BranchView[]>> {
    return this.many<BranchPayload, BranchView>("BRANCH", (payload, key) => ({ key, ...payload }));
  }

  async getBranch(key: string): Promise<KnowledgeResult<BranchView>> {
    const result = await this.one<BranchPayload>("BRANCH", key);
    return result.status === "AVAILABLE" ? available({ key, ...result.data }, result.provenance) : result;
  }

  // El horario de un servicio de una sucursal. Exige que la sucursal también esté aprobada y vigente: un horario de una sucursal retirada no se entrega.
  async getSchedule(query: { branchKey: string; service: ScheduleService }): Promise<KnowledgeResult<ScheduleView>> {
    const branch = await this.getBranch(query.branchKey);
    if (branch.status === "UNAVAILABLE") return unavailable("SCHEDULE", branch.reason, `${query.branchKey}:${query.service}`);
    const found = await this.many<SchedulePayload, ScheduleView>("SCHEDULE", (payload, key) => (payload.branchKey === query.branchKey && payload.service === query.service ? { key, ...payload } : undefined));
    if (found.status === "UNAVAILABLE") return { ...found, key: `${query.branchKey}:${query.service}` };
    if (found.data.length > 1) return unavailable("SCHEDULE", "AMBIGUOUS", `${query.branchKey}:${query.service}`);
    return available(found.data[0]!, [...branch.provenance, ...found.provenance], found.omitted);
  }

  // ¿Abierto en `at`? Siempre sobre el horario aprobado (zona horaria incluida). Un horario con zona inválida no se usa.
  async getScheduleStatus(query: { branchKey: string; service: ScheduleService }, at: Date = this.now()): Promise<KnowledgeResult<ScheduleStatus & { schedule: ScheduleView }>> {
    const schedule = await this.getSchedule(query);
    if (schedule.status === "UNAVAILABLE") return schedule;
    const status = scheduleStatusAt(schedule.data, at);
    if (!status) return unavailable("SCHEDULE", "INVALID_CONTENT", schedule.data.key);
    return available({ ...status, schedule: schedule.data }, schedule.provenance, schedule.omitted);
  }

  async getPolicy(topic: string): Promise<KnowledgeResult<PolicyView>> {
    const found = await this.many<PolicyPayload, PolicyView>("POLICY", (payload, key) => (payload.topic === topic ? { key, ...payload } : undefined));
    if (found.status === "UNAVAILABLE") return { ...found, key: topic };
    if (found.data.length > 1) return unavailable("POLICY", "AMBIGUOUS", topic);
    return available(found.data[0]!, found.provenance, found.omitted);
  }

  async getPaymentMethods(): Promise<KnowledgeResult<PaymentMethodPayload[]>> {
    return this.many<PaymentMethodPayload, PaymentMethodPayload>("PAYMENT_METHOD", (payload) => payload);
  }

  async getFaq(key: string): Promise<KnowledgeResult<FaqView>> {
    const result = await this.one<FaqPayload>("FAQ", key);
    return result.status === "AVAILABLE" ? available({ key, ...result.data }, result.provenance) : result;
  }

  async findFaqByTag(tag: string): Promise<KnowledgeResult<FaqView[]>> {
    return this.many<FaqPayload, FaqView>("FAQ", (payload, key) => (payload.tags?.includes(tag) ? { key, ...payload } : undefined));
  }

  // ───────────────────────── preparación de estudios (CLÍNICA) ─────────────────────────
  // Solo se entrega la preparación APROBADA por personal clínico y vigente de un estudio que existe y está ACTIVO en el catálogo recibido. Un estudio sin registro aprobado NO
  // se describe como "sin preparación": su resultado es UNAVAILABLE. Del catálogo solo se lee id, nombre y estado.
  async getStudyPreparation(studyIds: readonly string[], catalog: readonly Pick<CatalogStudy, "id" | "name" | "active">[] | undefined): Promise<StudyPreparationResult> {
    const unique = [...new Set(studyIds)];
    const items: StudyPreparationItem[] = [];
    for (const studyId of unique) {
      if (!catalog || catalog.length === 0) { items.push({ studyId, result: unavailable("STUDY_PREPARATION", "CATALOG_UNAVAILABLE", `study:${studyId}`) }); continue; }
      const study = catalog.find((candidate) => candidate.id === studyId);
      if (!study) { items.push({ studyId, result: unavailable("STUDY_PREPARATION", "UNKNOWN_STUDY", `study:${studyId}`) }); continue; }
      if (!study.active) { items.push({ studyId, studyName: study.name, result: unavailable("STUDY_PREPARATION", "INACTIVE_STUDY", `study:${studyId}`) }); continue; }
      const result = await this.one<StudyPreparationPayload>("STUDY_PREPARATION", `study:${studyId}`);
      if (result.status === "UNAVAILABLE") { items.push({ studyId, studyName: study.name, result }); continue; }
      const { labTestId: _ignored, ...rest } = result.data;
      items.push({ studyId, studyName: study.name, result: available<StudyPreparationView>({ studyId, studyName: study.name, ...rest }, result.provenance) });
    }
    const ok = items.filter((item) => item.result.status === "AVAILABLE").length;
    return { status: items.length > 0 && ok === items.length ? "AVAILABLE" : ok > 0 ? "PARTIAL" : "UNAVAILABLE", items };
  }
}
