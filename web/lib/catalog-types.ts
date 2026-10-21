// Catálogo que recibe el navegador: estudios activos con el precio YA resuelto para la tarifa del usuario.
export interface ClientStudy {
  id: string;
  code: string | null;
  name: string;
  // lab_tests.normalized_name y lab_test_aliases.normalized_alias (para la coincidencia exacta al pegar listas).
  normalizedName: string;
  aliases: string[];
  category: string | null;
  sampleType: string | null;
  priceBs: number;
}

export interface CatalogPayload {
  // Hash del contenido: sirve de ETag y de clave de cache en IndexedDB.
  version: string;
  tariffName: string;
  studies: ClientStudy[];
}

export type QuoteSource = "manual" | "paste" | "photo" | "template" | "repeat";

// Ítem pendiente de revisión (al pegar una lista o al leer una foto). Solo los "sure" entran al carrito sin intervención.
export type ReviewItem =
  | { kind: "sure"; text: string; studyId: string }
  | { kind: "choose"; text: string; candidateIds: string[]; hint?: string }
  | { kind: "confirm"; text: string; studyIds: string[]; hint?: string }
  | { kind: "not_found"; text: string; hint?: string };

export interface PhotoPrefill {
  decision: "AUTO_SAFE" | "HUMAN_REVIEW";
  warnings: string[];
  items: ReviewItem[];
}
