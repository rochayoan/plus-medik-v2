"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoPrefill } from "@/lib/catalog-types";
import { browserClient } from "@/lib/supabase/browser";

export type PhotoStatus = "idle" | "uploading" | "analyzing" | "done" | "failed";

export interface PhotoState {
  status: PhotoStatus;
  previewUrl: string | null;
  jobId: string | null;
  startedAt: number | null;
  error: string | null;
}

const MAX_EDGE = 2400;
const POLL_LIMIT_MS = 4 * 60_000;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

// Reduce la foto a 2400 px por lado (legible para los lectores, liviana para subir con datos móviles) y respeta la orientación EXIF.
async function prepareImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === "image/jpeg" && file.size < 2_500_000) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob"))), "image/jpeg", 0.88)
    );
  } catch {
    if (ACCEPTED.includes(file.type)) return file;
    throw new Error("Formato no soportado. Usa una foto JPG o PNG.");
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

const initial: PhotoState = { status: "idle", previewUrl: null, jobId: null, startedAt: null, error: null };

export function usePhotoJob(onResult: (jobId: string, prefill: PhotoPrefill) => void) {
  const [state, setState] = useState<PhotoState>(initial);
  const runRef = useRef(0);
  const fileRef = useRef<File | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => () => {
    runRef.current++;
  }, []);

  const start = useCallback(async (file: File) => {
    const run = ++runRef.current;
    fileRef.current = file;
    const alive = () => runRef.current === run;
    setState((previous) => {
      if (previous.previewUrl) URL.revokeObjectURL(previous.previewUrl);
      return { status: "uploading", previewUrl: URL.createObjectURL(file), jobId: null, startedAt: Date.now(), error: null };
    });
    const fail = (error: string) => alive() && setState((previous) => ({ ...previous, status: "failed", error }));

    try {
      const blob = await prepareImage(file);
      const created = await fetch("/api/photo-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mimeType: blob.type || "image/jpeg" })
      });
      if (!created.ok) return fail(await errorMessage(created, "No se pudo iniciar la subida."));
      const { jobId, path, token } = (await created.json()) as { jobId: string; path: string; token: string };

      const { error: uploadError } = await browserClient().storage.from("quote-photos").uploadToSignedUrl(path, token, blob, { contentType: blob.type || "image/jpeg" });
      if (uploadError) return fail("No se pudo subir la foto. Revisa tu conexión e intenta de nuevo.");

      const started = await fetch(`/api/photo-jobs/${jobId}/start`, { method: "POST" });
      if (!started.ok) return fail(await errorMessage(started, "No se pudo iniciar el análisis."));
      if (!alive()) return;
      setState((previous) => ({ ...previous, status: "analyzing", jobId }));

      // Consulta cada 1,5 s al principio y luego cada 3 s; nunca bloquea el resto del cotizador.
      const pollStart = Date.now();
      while (alive()) {
        const elapsed = Date.now() - pollStart;
        if (elapsed > POLL_LIMIT_MS) return fail("El análisis está tardando demasiado. Agrega los estudios con el buscador o intenta de nuevo.");
        await new Promise((resolve) => setTimeout(resolve, elapsed < 20_000 ? 1500 : 3000));
        if (!alive()) return;
        const response = await fetch(`/api/photo-jobs/${jobId}`, { cache: "no-store" }).catch(() => null);
        if (!response?.ok) continue;
        const job = (await response.json()) as { status: string; result: PhotoPrefill | null; error: string | null };
        if (job.status === "done" && job.result) {
          if (!alive()) return;
          setState((previous) => ({ ...previous, status: "done" }));
          onResultRef.current(jobId, job.result);
          return;
        }
        if (job.status === "failed") return fail(job.error ?? "No se pudo analizar la foto.");
      }
    } catch (error) {
      fail(error instanceof Error && error.message.startsWith("Formato") ? error.message : "No se pudo procesar la foto. Intenta de nuevo.");
    }
  }, []);

  const retry = useCallback(() => {
    if (fileRef.current) void start(fileRef.current);
  }, [start]);

  const reset = useCallback(() => {
    runRef.current++;
    fileRef.current = null;
    setState((previous) => {
      if (previous.previewUrl) URL.revokeObjectURL(previous.previewUrl);
      return initial;
    });
  }, []);

  return { state, start, retry, reset };
}
