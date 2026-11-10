import { normalizeStudyKey } from "../../src/consensus.js";
import type { CatalogStudy } from "../../src/types.js";

// Catálogo sintético para las pruebas del intérprete de estudios: nombres reales de un laboratorio, precios inventados.
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const study = (n: number, name: string, aliases: string[], priceBs: number, active = true): CatalogStudy => ({
  id: uuid(n),
  code: `C${n}`,
  name,
  normalizedName: normalizeStudyKey(name),
  normalizedAliases: aliases.map(normalizeStudyKey),
  priceBs,
  active
});

export const HEMOGRAMA = study(1, "HEMOGRAMA COMPLETO AUTOMATIZADO", ["hemograma completo", "hemograma"], 45);
export const GLUCOSA = study(2, "GLUCOSA", ["glucosa en ayunas"], 30);
export const GLUCOSA_POST = study(3, "GLUCOSA POSTPANDRIAL", [], 35);
export const COLESTEROL = study(4, "COLESTEROL TOTAL", ["colesterol"], 25);
export const COLESTEROL_LDL = study(5, "COLESTEROL LDL", [], 28);
export const TRIGLICERIDOS = study(6, "TRIGLICERIDOS", [], 27);
export const TSH_ECLIA = study(7, "TSH (ECLIA)", [], 80);
export const TSH_NEO = study(8, "TSH NEONATAL", [], 60);
export const CREATININA = study(9, "CREATININA", [], 22);
export const ESPERMOGRAMA = study(10, "ESPERMOGRAMA", [], 90);
export const ORINA = study(11, "EXAMEN GENERAL DE ORINA COMPLETA", ["examen general de orina", "ego"], 20);
export const HBA1C = study(12, "HEMOGLOBINA GLICOSILADA (Hb A1c)", [], 70);
export const PCR = study(13, "PROTEINA C REACTIVA (PCR CUALITATIVO)", [], 50);
export const VITAMINA_D_INACTIVA = study(14, "VITAMINA D 25 (OH)", [], 120, false);

export const CATALOG: CatalogStudy[] = [HEMOGRAMA, GLUCOSA, GLUCOSA_POST, COLESTEROL, COLESTEROL_LDL, TRIGLICERIDOS, TSH_ECLIA, TSH_NEO, CREATININA, ESPERMOGRAMA, ORINA, HBA1C, PCR, VITAMINA_D_INACTIVA];
