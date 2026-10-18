import { readImageWithGemini, readImageWithOpenAI } from "../src/ai.js";
import { loadImageFile } from "../src/image.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las API keys ya están en el entorno
}

const args = process.argv.slice(2);
const useOpenAI = args.includes("--openai");
const imagePath = args.find((arg) => !arg.startsWith("--"));
if (!imagePath) {
  console.error("Uso: npm run read-image -- <ruta-de-imagen> [--openai]");
  process.exit(1);
}

const { imageBase64, mimeType } = await loadImageFile(imagePath);
const reading = useOpenAI
  ? await readImageWithOpenAI(imageBase64, mimeType)
  : await readImageWithGemini(imageBase64, mimeType);
console.log(JSON.stringify(reading, null, 2));
