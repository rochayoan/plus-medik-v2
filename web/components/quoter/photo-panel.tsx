"use client";

import { Check, LoaderCircle, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PhotoState } from "./use-photo-job";

interface PhotoPanelProps {
  state: PhotoState;
  summary: string | null;
  onRetry: () => void;
  onClose: () => void;
}

export function PhotoPanel({ state, summary, onRetry, onClose }: PhotoPanelProps) {
  const [now, setNow] = useState(() => Date.now());
  const [zoom, setZoom] = useState(false);
  const busy = state.status === "uploading" || state.status === "analyzing";

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (state.status === "idle" || !state.previewUrl) return null;
  const seconds = state.startedAt ? Math.max(0, Math.round((now - state.startedAt) / 1000)) : 0;

  return (
    <section className="card flex gap-3 p-3" aria-label="Foto de la orden" aria-live="polite">
      <button type="button" onClick={() => setZoom(true)} className="shrink-0 overflow-hidden rounded-lg border border-line" aria-label="Ver la foto en grande">
        <img src={state.previewUrl} alt="Orden de laboratorio" className="h-28 w-24 object-cover sm:h-36 sm:w-28" />
      </button>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex items-start justify-between gap-2">
          <p className="font-medium">Foto de la orden</p>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Cerrar foto">
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {state.status === "uploading" ? (
          <p className="mt-1 flex items-center gap-2 text-muted"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Subiendo…</p>
        ) : null}
        {state.status === "analyzing" ? (
          <>
            <p className="mt-1 flex items-center gap-2"><LoaderCircle className="size-4 animate-spin text-brand-600" aria-hidden /> Leyendo la orden… {seconds} s</p>
            <p className="mt-1 text-xs text-muted">Suele tardar entre 20 y 60 segundos. Puedes seguir agregando estudios mientras tanto.</p>
          </>
        ) : null}
        {state.status === "done" ? (
          <p className="mt-1 flex items-start gap-2 text-brand-700"><Check className="mt-0.5 size-4 shrink-0" aria-hidden /> {summary ?? "Lectura lista."}</p>
        ) : null}
        {state.status === "failed" ? (
          <>
            <p className="mt-1 flex items-start gap-2 text-red-700"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {state.error}</p>
            <button type="button" onClick={onRetry} className="btn-secondary mt-2 min-h-9 px-3 py-1.5">
              <RotateCcw className="size-4" aria-hidden /> Reintentar
            </button>
          </>
        ) : null}
        <p className="mt-2 text-xs text-muted">Toca la foto para verla en grande y comparar.</p>
      </div>

      {zoom ? (
        <div role="dialog" aria-modal="true" aria-label="Foto de la orden" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2" onClick={() => setZoom(false)}>
          <img src={state.previewUrl} alt="Orden de laboratorio" className="max-h-full max-w-full object-contain" />
          <button type="button" className="absolute top-3 right-3 rounded-full bg-white/90 p-2" aria-label="Cerrar">
            <X className="size-5" aria-hidden />
          </button>
        </div>
      ) : null}
    </section>
  );
}
