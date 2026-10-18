import { analyzeImage } from "../src/analyze.js";
import { loadImageFile } from "../src/image.js";
import { loadActiveCatalog } from "../src/supabase-catalog.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las variables ya están en el entorno
}

const imagePath = process.argv[2] ?? "private-data/receta.jpeg";

const { imageBase64, mimeType } = await loadImageFile(imagePath);
// Catálogo en solo lectura; los lectores y el juez usan el cache local (AI_CACHE=off/refresh para saltarlo).
const catalog = await loadActiveCatalog();
const result = await analyzeImage({ imageBase64, mimeType, catalog });

console.log(JSON.stringify(result, null, 2));
