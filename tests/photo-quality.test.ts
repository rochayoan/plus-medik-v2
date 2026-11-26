import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { simpleReaderInstructionsFor, type SimpleReading } from "../src/ai.js";
import { analyzeImage, type AnalyzeDeps } from "../src/analyze.js";
import { hintsBlock, LOW_RESOLUTION_SHORT_SIDE, photoQualityOf, readingHints } from "../src/photo-quality.js";
import type { SimpleJudgement } from "../src/judge.js";

// Mejora 6: condiciones de la foto desde sus METADATOS (sin decodificar ni modificar la imagen). Archivos sintéticos: solo cabeceras. Sin red.

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
// JPEG mínimo: SOI, APP1 con EXIF (orientación) opcional, SOF0 con el tamaño guardado, SOS.
function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation !== undefined) {
    const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, ...le16(orientation), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    parts.push(0xff, 0xe1, ...be16(body.length + 2), ...body);
  }
  const sof = [0x08, ...be16(height), ...be16(width), 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  parts.push(0xff, 0xc0, ...be16(sof.length + 2), ...sof, 0xff, 0xda, 0x00, 0x02);
  return Uint8Array.from(parts);
}
const png = (width: number, height: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, (width >>> 24) & 0xff, (width >> 16) & 0xff, (width >> 8) & 0xff, width & 0xff, (height >>> 24) & 0xff, (height >> 16) & 0xff, (height >> 8) & 0xff, height & 0xff]);
const webpVp8x = (width: number, height: number) => {
  const w = width - 1;
  const h = height - 1;
  return Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X"), 10, 0, 0, 0, 0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
};

describe("photoQualityOf: orientación, espejo y resolución desde los metadatos", () => {
  it("JPEG de celular guardado acostado (EXIF 6): se ve 1200×1600, girado 90°", () => {
    expect(photoQualityOf(jpeg(1600, 1200, 6))).toMatchObject({ format: "jpeg", width: 1200, height: 1600, orientation: 6, rotationDegrees: 90, mirrored: false, lowResolution: false });
  });
  it("EXIF 3 (de cabeza), 8 (270°) y 2 (espejo)", () => {
    expect(photoQualityOf(jpeg(1600, 1200, 3)).rotationDegrees).toBe(180);
    expect(photoQualityOf(jpeg(1600, 1200, 8))).toMatchObject({ rotationDegrees: 270, width: 1200 });
    expect(photoQualityOf(jpeg(1600, 1200, 2))).toMatchObject({ rotationDegrees: 0, mirrored: true });
  });
  it("sin EXIF: orientación normal; poca resolución si el lado corto es menor que el umbral", () => {
    expect(photoQualityOf(jpeg(1600, 1200))).toMatchObject({ rotationDegrees: 0, lowResolution: false });
    expect(photoQualityOf(jpeg(640, LOW_RESOLUTION_SHORT_SIDE - 1))).toMatchObject({ lowResolution: true });
  });
  it("PNG y WebP: tamaño desde la cabecera", () => {
    expect(photoQualityOf(png(800, 1000))).toMatchObject({ format: "png", width: 800, height: 1000, lowResolution: false });
    expect(photoQualityOf(webpVp8x(500, 700))).toMatchObject({ format: "webp", width: 500, height: 700, lowResolution: true });
  });
  it("archivo desconocido o truncado: sin datos, sin avisos y sin error", () => {
    for (const bytes of [Uint8Array.from([1, 2, 3]), jpeg(1600, 1200, 6).subarray(0, 20), new Uint8Array()]) {
      const quality = photoQualityOf(bytes);
      expect(quality.rotationDegrees === 0 || quality.format === "jpeg").toBe(true);
      expect(() => readingHints(quality)).not.toThrow();
    }
    expect(readingHints(photoQualityOf(Uint8Array.from([1, 2, 3])))).toEqual([]);
  });
});

describe("avisos: generales y solo cuando hay algo que avisar", () => {
  it("una foto normal no genera avisos y el prompt de los lectores es exactamente el de antes", () => {
    expect(readingHints(photoQualityOf(jpeg(1600, 1200, 1)))).toEqual([]);
    expect(hintsBlock([])).toBe("");
    expect(createHash("sha256").update(simpleReaderInstructionsFor(false)).digest("hex")).toBe("d54a9527df2681461f3306ea9fd9e990cb69d2b58ea62970760ebdce81d79b16");
  });
  it("girada, en espejo o chica: un aviso por condición, que nunca autoriza adivinar", () => {
    const hints = readingHints(photoQualityOf(jpeg(700, 500, 7)));
    expect(hints).toHaveLength(3);
    expect(hints.join(" ")).toContain("270°");
    expect(hints.join(" ")).toContain("espejo");
    expect(hints.join(" ")).toContain("uncertainStudies");
    expect(simpleReaderInstructionsFor(false, hints)).toContain("Condiciones de esta foto");
    expect(simpleReaderInstructionsFor(true, hints)).not.toContain("Condiciones de esta foto");
  });
});

describe("analyzeImage: avisos a lectores y juez, imagen original intacta", () => {
  const study = { literalText: "TSH", normalizedName: "TSH", evidence: "explicit_text" as const, confidence: "high" as const, lineText: "TSH" };
  const run = async (bytes: Uint8Array, b: SimpleReading = { requestedStudies: [study], uncertainStudies: [], notes: "" }) => {
    const readGemini = vi.fn(async (): Promise<SimpleReading> => ({ requestedStudies: [study], uncertainStudies: [], notes: "" }));
    const readOpenAI = vi.fn(async (): Promise<SimpleReading> => b);
    const judge = vi.fn(async (): Promise<SimpleJudgement> => ({ resolvedStudies: [], unresolvedDisputes: [] }));
    const deps: AnalyzeDeps = {
      readGemini: readGemini as unknown as AnalyzeDeps["readGemini"],
      readOpenAI: readOpenAI as unknown as AnalyzeDeps["readOpenAI"],
      judge,
      readDocument: vi.fn(async () => ({ signal: { documentType: "TEXT_EXPLICIT_REQUEST" as const, completeDocumentVisible: true, agreement: true, integrity: { problems: [], irrelevantCrops: [] }, reasons: ["", ""] as [string, string] } })) as AnalyzeDeps["readDocument"],
      resolveSemantic: vi.fn(async () => ({ items: [], model: "m", reasoning: "r", calledModel: false, cacheHit: true, usage: [], candidatesSentToModel: 0 })) as unknown as AnalyzeDeps["resolveSemantic"],
      shadowMatch: vi.fn()
    };
    const imageBase64 = Buffer.from(bytes).toString("base64");
    const catalog = [{ id: "tsh", code: "tsh", name: "TSH", normalizedName: "tsh", normalizedAliases: [], priceBs: 90, active: true, category: "HORMONAS" }];
    const result = await analyzeImage({ imageBase64, mimeType: "image/jpeg", catalog, semanticPrimary: false, partialAuto: false, handwrittenAuto: "off" }, deps);
    return { result, readGemini, readOpenAI, judge, imageBase64 };
  };
  it("foto girada: los dos lectores reciben el aviso y la MISMA imagen original", async () => {
    const { result, readGemini, readOpenAI, imageBase64 } = await run(jpeg(1600, 1200, 6));
    for (const reader of [readGemini, readOpenAI]) {
      const call = reader.mock.calls[0] as unknown[];
      expect(call[0]).toBe(imageBase64);
      expect((call[5] as string[]).join(" ")).toContain("90°");
    }
    expect(result.photo).toMatchObject({ rotationDegrees: 90 });
  });
  it("el juez también recibe el aviso cuando hay disputas", async () => {
    const { judge } = await run(jpeg(1600, 1200, 6), { requestedStudies: [], uncertainStudies: [], notes: "" });
    expect(judge).toHaveBeenCalledTimes(1);
    expect((judge.mock.calls[0] as unknown as [{ hints?: string[] }])[0].hints?.join(" ")).toContain("90°");
  });
  it("foto normal: las llamadas son exactamente las de siempre (sin avisos)", async () => {
    const { readGemini, result } = await run(jpeg(1600, 1200, 1));
    expect(readGemini.mock.calls[0]).toHaveLength(2);
    expect(result.photo).toMatchObject({ rotationDegrees: 0, lowResolution: false });
  });
});
