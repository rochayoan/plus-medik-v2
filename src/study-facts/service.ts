import type { UnavailableReason } from "../knowledge/types.js";
import type { CatalogStudy } from "../types.js";
import type { StudyFactsStore } from "./store.js";
import {
  factSnapshotItem, FACT_SCHEMAS,
  type FactProvenance, type FactResult, type FactSnapshotItem, type SamplePayload, type StudyFactItem, type StudyFactKind, type StudyFactsResult, type TurnaroundPayload
} from "./types.js";

// Consulta de los datos por estudio APROBADOS (tipo de muestra / requisitos y plazo de entrega). Mismas reglas que el servicio de conocimiento de G3:
//   · solo se entrega lo aprobado Y vigente en el instante de la consulta (la caducidad no depende de la caché);
//   · si falta, venció, no es válido o no se puede consultar: UNAVAILABLE con una razón codificada, nunca texto inventado, nunca «sin requisitos» ni un plazo supuesto;
//   · del catálogo solo se mira id, nombre y si está activo (nunca precios);
//   · caché con revisión (cada `revisionCheckMs` se compara; si cambió se recarga todo) y falla cerrado pasado `maxStaleMs`.

export interface StudyFactsServiceOptions {
  store: StudyFactsStore;
  now?: () => Date;
  revisionCheckMs?: number;
  maxStaleMs?: number;
}

export interface SampleView extends Omit<SamplePayload, "labTestId"> {
  studyId: string;
  studyName: string;
}
export interface TurnaroundView extends Omit<TurnaroundPayload, "labTestId"> {
  studyId: string;
  studyName: string;
}

interface Entry {
  item: FactSnapshotItem;
  payload?: unknown;
}
interface Cache {
  revision: number;
  entries: Map<string, Entry>;
  verifiedAt: number;
  rejected: number;
}

const idOf = (kind: StudyFactKind, labTestId: string) => `${kind}|${labTestId}`;
const time = (value: string | null): number | undefined => (value ? Date.parse(value) : undefined);

export class StudyFactsService {
  private cache?: Cache;
  private inflight?: Promise<void>;
  private forceReload = false;
  private readonly now: () => Date;
  private readonly revisionCheckMs: number;
  private readonly maxStaleMs: number;
  private readonly store: StudyFactsStore;

  constructor(options: StudyFactsServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.revisionCheckMs = options.revisionCheckMs ?? 15_000;
    this.maxStaleMs = options.maxStaleMs ?? 300_000;
  }

  invalidate(): void {
    this.forceReload = true;
  }
  get rejectedCount(): number {
    return this.cache?.rejected ?? 0;
  }

  private build(revision: number, items: unknown[], verifiedAt: number): Cache {
    const entries = new Map<string, Entry>();
    let rejected = 0;
    for (const raw of items) {
      const parsed = factSnapshotItem.safeParse(raw);
      if (!parsed.success) { rejected++; continue; }
      const item = parsed.data;
      const payload = FACT_SCHEMAS[item.kind].safeParse(item.payload);
      // Coherencia: el registro debe referirse al estudio de su clave.
      const coherent = payload.success && (payload.data as { labTestId: string }).labTestId === item.labTestId;
      if (!payload.success || !coherent) rejected++;
      entries.set(idOf(item.kind, item.labTestId), { item, ...(payload.success && coherent ? { payload: payload.data } : {}) });
    }
    return { revision, entries, verifiedAt, rejected };
  }

  private async load(): Promise<void> {
    const snapshot = await this.store.snapshot();
    if (this.cache && snapshot.revision < this.cache.revision) {
      this.cache.verifiedAt = this.now().getTime();
      return;
    }
    this.cache = this.build(snapshot.revision, snapshot.items, this.now().getTime());
  }

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

  private state(entry: Entry, nowMs: number): UnavailableReason | "OK" {
    if (entry.payload === undefined) return "INVALID_CONTENT";
    const from = time(entry.item.validFrom);
    const until = time(entry.item.validUntil);
    if (until === undefined || Number.isNaN(until) || (from !== undefined && Number.isNaN(from))) return "INVALID_CONTENT";
    if (from !== undefined && nowMs < from) return "NOT_YET_VALID";
    if (nowMs >= until) return "EXPIRED";
    return "OK";
  }

  private provenance(entry: Entry): FactProvenance {
    const { item } = entry;
    return { kind: item.kind, labTestId: item.labTestId, version: item.version, approvedAt: item.approvedAt, approvedBy: item.approvedBy, validUntil: item.validUntil, contentHash: item.contentHash };
  }

  private async facts<P extends { labTestId: string }, V>(
    kind: StudyFactKind, studyIds: readonly string[], catalog: readonly Pick<CatalogStudy, "id" | "name" | "active">[] | undefined, view: (payload: P, studyId: string, studyName: string) => V
  ): Promise<StudyFactsResult<V>> {
    const items: Array<StudyFactItem<V>> = [];
    const bad = (studyId: string, reason: UnavailableReason, studyName?: string): StudyFactItem<V> => ({ studyId, ...(studyName !== undefined ? { studyName } : {}), result: { status: "UNAVAILABLE", reason, kind, labTestId: studyId } });
    const fresh = await this.ensureFresh();
    for (const studyId of [...new Set(studyIds)]) {
      if (!catalog || catalog.length === 0) { items.push(bad(studyId, "CATALOG_UNAVAILABLE")); continue; }
      const study = catalog.find((candidate) => candidate.id === studyId);
      if (!study) { items.push(bad(studyId, "UNKNOWN_STUDY")); continue; }
      if (!study.active) { items.push(bad(studyId, "INACTIVE_STUDY", study.name)); continue; }
      if (!fresh) { items.push(bad(studyId, "STORE_UNAVAILABLE", study.name)); continue; }
      const entry = this.cache!.entries.get(idOf(kind, studyId));
      if (!entry) { items.push(bad(studyId, "NO_APPROVED_VERSION", study.name)); continue; }
      const state = this.state(entry, this.now().getTime());
      if (state !== "OK") { items.push(bad(studyId, state, study.name)); continue; }
      const { labTestId: _ignored, ...rest } = entry.payload as P;
      items.push({ studyId, studyName: study.name, result: { status: "AVAILABLE", data: view(rest as unknown as P, studyId, study.name), provenance: this.provenance(entry) } });
    }
    const ok = items.filter((item) => item.result.status === "AVAILABLE").length;
    return { status: items.length > 0 && ok === items.length ? "AVAILABLE" : ok > 0 ? "PARTIAL" : "UNAVAILABLE", items };
  }

  // Tipo de muestra y requisitos especiales (CLÍNICO). Un estudio sin registro aprobado NO se describe como «sin requisitos»: su resultado es UNAVAILABLE.
  getSample(studyIds: readonly string[], catalog: readonly Pick<CatalogStudy, "id" | "name" | "active">[] | undefined): Promise<StudyFactsResult<SampleView>> {
    return this.facts<SamplePayload, SampleView>("SAMPLE", studyIds, catalog, (payload, studyId, studyName) => ({ studyId, studyName, ...(payload as Omit<SamplePayload, "labTestId">) }));
  }

  // Plazo de entrega (ADMINISTRATIVO), en la unidad aprobada para ese estudio. No se convierte entre horas y días.
  getTurnaround(studyIds: readonly string[], catalog: readonly Pick<CatalogStudy, "id" | "name" | "active">[] | undefined): Promise<StudyFactsResult<TurnaroundView>> {
    return this.facts<TurnaroundPayload, TurnaroundView>("TURNAROUND", studyIds, catalog, (payload, studyId, studyName) => ({ studyId, studyName, ...(payload as Omit<TurnaroundPayload, "labTestId">) }));
  }
}

export type StudyFactsQueries = Pick<StudyFactsService, "getSample" | "getTurnaround">;
export type { FactResult };
