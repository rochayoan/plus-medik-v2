import { readImageWithGemini, readImageWithOpenAI } from "../src/ai.js";
import { buildSimpleConsensus } from "../src/consensus.js";
import { loadImageFile } from "../src/image.js";
import { judgeDisputesWithOpenAI } from "../src/judge.js";

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
const consensus = buildSimpleConsensus(gemini, openai);
const judgement = await judgeDisputesWithOpenAI({
  imageBase64,
  mimeType,
  gemini,
  openai,
  disputes: consensus.disputes
});

console.log(JSON.stringify({ agreedStudies: consensus.agreedStudies, disputes: consensus.disputes, ...judgement }, null, 2));
