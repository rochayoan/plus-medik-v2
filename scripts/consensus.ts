import { readImageWithGemini, readImageWithOpenAI } from "../src/ai.js";
import { buildSimpleConsensus } from "../src/consensus.js";
import { loadImageFile } from "../src/image.js";

try {
  process.loadEnvFile(".env");
} catch {
  // .env es opcional si las API keys ya están en el entorno
}

const imagePath = process.argv[2] ?? "private-data/receta.jpeg";

const { imageBase64, mimeType } = await loadImageFile(imagePath);
const [gemini, openai] = await Promise.all([
  readImageWithGemini(imageBase64, mimeType),
  readImageWithOpenAI(imageBase64, mimeType)
]);
console.log(JSON.stringify(buildSimpleConsensus(gemini, openai), null, 2));
