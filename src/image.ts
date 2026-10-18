import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const mimeTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif"
};

export async function loadImageFile(path: string): Promise<{ imageBase64: string; mimeType: string }> {
  const mimeType = mimeTypes[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`Formato no soportado: ${extname(path) || "(sin extensión)"}`);
  return { imageBase64: (await readFile(path)).toString("base64"), mimeType };
}
