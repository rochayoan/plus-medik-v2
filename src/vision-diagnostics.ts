import { createHmac } from "node:crypto";
import type { AiCallEvent } from "./cache.js";

// Solo piloto explícito; el material clínico no se registra ni se expone.
// HMAC permite comparar imágenes idénticas sin revelar un SHA público de la foto.
const READER_LABELS = new Set(["gemini-openrouter", "gemini-aistudio", "openai-reader"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const EVIDENCE = new Set(["x", "check", "circle", "underline", "strike", "scribble", "explicit_text"]);

type Shape = Record<string, unknown>;
const asObject = (value: unknown): Shape =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Shape : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const limited = (value: unknown, allowed: Set<string>): string | undefined =>
  typeof value === "string" && allowed.has(value) ? value : undefined;

function fingerprint(key: string, namespace: string, contents: string | Uint8Array): string {
  return createHmac("sha256", key)
    .update("plusmedik-vision-v1:")
    .update(namespace)
    .update("\0")
    .update(contents)
    .digest("hex").slice(0, 32);
}

export function visionDiagnosticKeyFor(env: NodeJS.ProcessEnv, phone: string): string | undefined {
  if (env.PLUSMEDIK_VISION_DIAGNOSTICS?.trim().toLowerCase() !== "on") return undefined;
  const secret = env.PLUSMEDIK_VISION_DIAGNOSTICS_KEY;
  const raw = env.PLUSMEDIK_VISION_DIAGNOSTICS_PHONES?.trim();
  if (!secret || secret.length < 32 || !raw) return undefined;
  const allowed = raw.split(",").map((item) => item.trim());
  if (allowed.length < 1 || allowed.length > 10 || !allowed.every((item) => /^\d{8,15}$/.test(item))) return undefined;
  const incoming = phone.replace(/[\s+()\-]/g, "");
  return /^\d{8,15}$/.test(incoming) && allowed.includes(incoming) ? secret : undefined;
}

// Se invoca solo si el número de prueba fue autorizado. Sin textos, notas,
// nombres, teléfonos, URLs, imágenes ni valores arbitrarios del proveedor.
// Para dos lecturas con igual contenido las huellas son iguales, aun si cambia
// el orden de las filas. Igual HMAC de imagen => mismos bytes descargados.
export function buildVisionDiagnostic(bytes: Uint8Array, mimeType: string, events: readonly AiCallEvent[], key: string) {
  const readers = events
    .filter((event) => READER_LABELS.has(event.label) && (event.outcome === "OK" || event.outcome === "CACHE_HIT"))
    .map((event) => {
      const result = asObject(event.value);
      const requested = Array.isArray(result.requestedStudies) ? result.requestedStudies : [];
      const uncertain = Array.isArray(result.uncertainStudies) ? result.uncertainStudies : [];
      const rows = requested.slice(0, 40).map((item) => {
        const row = asObject(item);
        const literal = text(row.literalText);
        const line = text(row.lineText);
        return {
          literal: fingerprint(key, "literal", literal),
          line: line ? fingerprint(key, "line", line) : null,
          confidence: limited(row.confidence, CONFIDENCE) ?? "unknown",
          evidence: limited(row.evidence, EVIDENCE) ?? "unknown"
        };
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return {
        reader: event.label,
        cacheHit: event.cacheHit,
        requestedCount: requested.length,
        uncertainCount: uncertain.length,
        truncated: requested.length > 40,
        reading: fingerprint(key, "reading", JSON.stringify(rows)),
        rows
      };
    });
  return {
    version: 1,
    image: fingerprint(key, "image", bytes),
    imageBytes: bytes.byteLength,
    mimeType,
    readers
  };
}
