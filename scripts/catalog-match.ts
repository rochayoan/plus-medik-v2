import { ExactAliasCatalogResolver } from "../src/catalog.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";
import type { CatalogStudy } from "../src/types.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const texts = process.argv.slice(2);
if (texts.length === 0) {
  console.error('Uso: npm run catalog-match -- "TSH" ["otro estudio" ...]');
  process.exit(1);
}

const studies = await loadActiveCatalog();
const resolver = new ExactAliasCatalogResolver(studies);
console.log(`Catálogo activo cargado: ${studies.length} estudios (solo lectura)`);

const show = (study: CatalogStudy) => {
  console.log(`  id:      ${study.id}`);
  console.log(`  code:    ${study.code ?? "(null)"}`);
  console.log(`  name:    ${study.name}`);
  console.log(`  priceBs: ${study.priceBs}`);
};

for (const text of texts) {
  const resolution = resolver.resolve({ text, evidenceType: "PRINTED_TEXT", certainty: "HIGH", evidenceSummary: "catalog-match" });
  console.log(`\n"${text}"`);
  console.log(`  status:  ${resolution.status}`);
  if (resolution.status === "MATCHED") show(resolution.study);
  if (resolution.status === "AMBIGUOUS") {
    for (const candidate of resolution.candidates) {
      console.log("  --- candidato");
      show(candidate);
    }
  }
}
