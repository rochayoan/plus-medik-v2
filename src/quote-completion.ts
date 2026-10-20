import { isPackageComponent } from "./catalog-shadow.js";
import { buildPublicQuote, revisionOf, type InternalLine, type InternalRecord, type PublicQuote } from "./partial-auto.js";
import type { CatalogStudy } from "./types.js";

// Completar una cotización parcial con revisión humana. Conserva las líneas ya validadas, no duplica cobros (un UUID ya cotizado no se agrega
// otra vez; un paquete y su componente no se cobran juntos) y solo acepta estudios activos del catálogo con su precio real. Toda resolución debe
// referirse a la revisión que el revisor vio: si la cotización cambió mientras tanto, se rechaza. Función pura: la persistencia es de otra capa.

export type HumanResolution =
  | { pendingKey: string; action: "ASSIGN"; studyIds: string[]; reviewer: string }
  | { pendingKey: string; action: "NOT_REQUESTED"; reviewer: string }
  | { pendingKey: "UNSEEN_REGION"; action: "CONFIRM_NO_MORE_STUDIES"; reviewer: string };

export interface CompletionResult {
  record: InternalRecord;
  // Lo que se le envía al paciente tras completar (estudios, precios e importe de esos estudios). Undefined si todavía no hay ningún estudio cotizado.
  publicQuote?: PublicQuote;
  applied: string[];
  rejected: Array<{ pendingKey: string; reason: string }>;
}

const validPrice = (priceBs: number) => Number.isFinite(priceBs) && priceBs >= 0;

export function completeQuote(
  record: InternalRecord,
  resolutions: HumanResolution[],
  options: { revision: string; catalog: CatalogStudy[]; now?: () => Date }
): CompletionResult {
  const rejectAll = (reason: string): CompletionResult => ({
    record,
    publicQuote: record.quoted.lines.length > 0 ? buildPublicQuote(record.quoted.lines) : undefined,
    applied: [],
    rejected: resolutions.map((resolution) => ({ pendingKey: resolution.pendingKey, reason }))
  });
  if (options.revision !== record.revision) return rejectAll("la cotización cambió desde que se revisó (revisión desactualizada)");
  if (record.recipeStops.length > 0) return rejectAll("la receta requiere una revisión completa (hay motivos que invalidan la lectura); no se completa por estudio");

  const working: InternalRecord = structuredClone(record);
  const catalogById = new Map(options.catalog.map((study) => [study.id, study]));
  const applied: string[] = [];
  const rejected: CompletionResult["rejected"] = [];
  const at = (options.now?.() ?? new Date()).toISOString();

  for (const resolution of resolutions) {
    const index = working.pending.findIndex((item) => item.key === resolution.pendingKey);
    const item = working.pending[index];
    if (!item) { rejected.push({ pendingKey: resolution.pendingKey, reason: "no existe un pendiente con esa clave (o ya se resolvió)" }); continue; }

    if (resolution.action === "CONFIRM_NO_MORE_STUDIES") {
      if (item.kind !== "UNSEEN_REGION") { rejected.push({ pendingKey: item.key, reason: "solo aplica a la zona de la receta que no se ve" }); continue; }
    } else if (item.kind === "UNSEEN_REGION") {
      rejected.push({ pendingKey: item.key, reason: "la zona que no se ve solo se resuelve confirmando que no hay más estudios" });
      continue;
    }

    if (resolution.action === "ASSIGN") {
      const ids = [...new Set(resolution.studyIds)];
      const studies = ids.map((id) => catalogById.get(id));
      if (ids.length === 0) { rejected.push({ pendingKey: item.key, reason: "no se indicó ningún estudio" }); continue; }
      const bad = studies.findIndex((study) => !study || !study.active || !validPrice(study.priceBs));
      if (bad >= 0) { rejected.push({ pendingKey: item.key, reason: `el estudio ${ids[bad]} no existe, no está activo o no tiene un precio válido en el catálogo` }); continue; }

      const fresh = (studies as CatalogStudy[]).filter((study) => !working.quoted.lines.some((line) => line.id === study.id));
      // Paquete y componente: ninguno de los nuevos puede solaparse con lo ya cotizado (ni entre sí), en ningún sentido.
      const combined = [...working.quoted.lines.map((line) => catalogById.get(line.id)).filter((s): s is CatalogStudy => Boolean(s)), ...fresh];
      const overlap = fresh.some((candidate) => combined.some((other) => other.id !== candidate.id && (isPackageComponent(other, candidate) || isPackageComponent(candidate, other))));
      if (overlap) { rejected.push({ pendingKey: item.key, reason: "solapamiento entre un paquete y uno de sus componentes: se cobraría dos veces" }); continue; }

      for (const study of studies as CatalogStudy[]) {
        const existing = working.quoted.lines.find((line) => line.id === study.id);
        if (existing) {
          // Ya estaba cotizado: no se vuelve a cobrar, solo se deja constancia de que este pendiente también lo pedía.
          if (item.text && !existing.texts.includes(item.text)) existing.texts.push(item.text);
          continue;
        }
        const line: InternalLine = { id: study.id, code: study.code, name: study.name, priceBs: study.priceBs, basis: ["HUMAN"], texts: item.text ? [item.text] : [] };
        working.quoted.lines.push(line);
      }
      working.history.push({ at, reviewer: resolution.reviewer, action: "ASSIGN", pendingKey: item.key, detail: ids.join(",") });
    } else if (resolution.action === "NOT_REQUESTED") {
      working.history.push({ at, reviewer: resolution.reviewer, action: "NOT_REQUESTED", pendingKey: item.key, detail: item.text ?? "" });
    } else {
      working.history.push({ at, reviewer: resolution.reviewer, action: "CONFIRM_NO_MORE_STUDIES", pendingKey: item.key, detail: "" });
    }
    working.pending.splice(working.pending.findIndex((candidate) => candidate.key === item.key), 1);
    applied.push(item.key);
  }

  working.quoted.subtotalBs = working.quoted.lines.reduce((sum, line) => sum + line.priceBs, 0);
  working.recipeComplete = working.pending.length === 0;
  working.reviewRequired = !working.recipeComplete;
  working.revision = revisionOf(working.quoted.lines, working.pending);
  return {
    record: working,
    publicQuote: working.quoted.lines.length > 0 ? buildPublicQuote(working.quoted.lines) : undefined,
    applied,
    rejected
  };
}
