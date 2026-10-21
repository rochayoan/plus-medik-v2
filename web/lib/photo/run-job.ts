import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { analyzeImage, assembleAnalysis, type AnalysisResult } from "@core/analyze";
import { setUsageSink, type AiUsage } from "@core/cache";
import { buildSimpleConsensus } from "@core/consensus";
import type { CatalogStudy } from "@core/types";
import { getCoreCatalog } from "../catalog-server";
import { prefillFromAnalysis } from "../photo-prefill";
import { adminClient } from "../supabase/admin";

export const PHOTO_BUCKET = "quote-photos";
const ANALYSIS_TIMEOUT_MS = Number(process.env.PHOTO_ANALYSIS_TIMEOUT_MS ?? 240_000);
const DEDUPE_DAYS = 7;

// Cada llamada a un modelo se registra en ai_usage con el trabajo de foto que la originó (varios trabajos pueden
// correr a la vez en la misma instancia: el contexto asíncrono los separa).
const usageContext = new AsyncLocalStorage<{ jobId: string; costUsd: number }>();
let configured = false;

function configureCore(): void {
  if (configured) return;
  // En Vercel el disco no persiste: sin cache de archivos (la deduplicación por sha256 cumple ese rol).
  process.env.AI_CACHE = "off";
  setUsageSink(async (line) => {
    const context = usageContext.getStore();
    const usage = (line.usage ?? line.savedUsage) as AiUsage | undefined;
    if (context && line.cacheHit !== true && typeof usage?.costUsd === "number") context.costUsd += usage.costUsd;
    await adminClient().from("ai_usage").insert({
      photo_job_id: context?.jobId ?? null,
      label: String(line.label ?? ""),
      provider: String(line.provider ?? ""),
      model: String(line.model ?? ""),
      cache_hit: line.cacheHit === true,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      reasoning_tokens: usage?.reasoningTokens ?? null,
      cost_usd: usage?.costUsd ?? null
    });
  });
  configured = true;
}

// Modo de prueba de carga / desarrollo sin claves: resultado realista armado con el ensamblado puro del core. Nunca en producción.
async function mockAnalysis(catalog: CatalogStudy[]): Promise<AnalysisResult> {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.MOCK_ANALYSIS_DELAY_MS ?? 3000)));
  const picked = catalog.slice(0, 3).map((study) => ({ literalText: study.name, normalizedName: study.name, evidence: "explicit_text" as const, confidence: "high" as const }));
  const reading = { requestedStudies: [...picked, { literalText: "Estudio de prueba inexistente", normalizedName: "x", evidence: "explicit_text" as const, confidence: "high" as const }], uncertainStudies: [], notes: "" };
  return assembleAnalysis({
    consensus: buildSimpleConsensus(reading, reading),
    judgement: { resolvedStudies: [], unresolvedDisputes: [] },
    catalog,
    document: { documentType: "TEXT_EXPLICIT_REQUEST", completeDocumentVisible: true, agreement: true }
  });
}

export function analyzerMode(): "real" | "mock" {
  if (process.env.ANALYZER_MODE?.trim() !== "mock") return "real";
  if (process.env.VERCEL_ENV === "production") throw new Error("ANALYZER_MODE=mock no está permitido en producción");
  return "mock";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`análisis excedió ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface PhotoJobToRun {
  id: string;
  storage_path: string;
}

// Corre fuera de la respuesta HTTP (after()). Nunca lanza: todo fallo deja el trabajo en "failed" con un mensaje para el usuario.
export async function runPhotoJob(job: PhotoJobToRun): Promise<void> {
  const started = Date.now();
  const db = adminClient();
  try {
    configureCore();
    const { data: file, error: downloadError } = await db.storage.from(PHOTO_BUCKET).download(job.storage_path);
    if (downloadError || !file) throw new Error(`no se pudo leer la imagen: ${downloadError?.message ?? "vacía"}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // La misma imagen ya analizada: se reutiliza el resultado (costo $0, respuesta inmediata).
    const since = new Date(Date.now() - DEDUPE_DAYS * 86_400_000).toISOString();
    const { data: previous } = await db
      .from("photo_jobs")
      .select("id, decision, result")
      .eq("image_sha256", sha256)
      .eq("status", "done")
      .gte("finished_at", since)
      .neq("id", job.id)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previous) {
      await db.from("photo_jobs").update({
        status: "done",
        decision: previous.decision,
        result: previous.result,
        image_sha256: sha256,
        reused_from: previous.id,
        cost_usd: 0,
        duration_ms: Date.now() - started,
        finished_at: new Date().toISOString()
      }).eq("id", job.id);
      return;
    }

    const catalog = await getCoreCatalog();
    const context = { jobId: job.id, costUsd: 0 };
    const mimeType = file.type || "image/jpeg";
    const analysis = await usageContext.run(context, () =>
      withTimeout(
        analyzerMode() === "mock" ? mockAnalysis(catalog) : analyzeImage({ imageBase64: bytes.toString("base64"), mimeType, catalog }),
        ANALYSIS_TIMEOUT_MS
      )
    );
    const prefill = prefillFromAnalysis(analysis);
    await db.from("photo_jobs").update({
      status: "done",
      decision: prefill.decision,
      result: prefill,
      image_sha256: sha256,
      cost_usd: context.costUsd,
      duration_ms: Date.now() - started,
      finished_at: new Date().toISOString()
    }).eq("id", job.id);
  } catch (error) {
    console.error(`photo_job ${job.id} falló:`, error);
    await db.from("photo_jobs").update({
      status: "failed",
      error: "No se pudo analizar la foto. Intenta de nuevo o agrega los estudios con el buscador.",
      duration_ms: Date.now() - started,
      finished_at: new Date().toISOString()
    }).eq("id", job.id);
  }
}
