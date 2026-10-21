"use client";

import { Check, Search, TriangleAlert, X } from "lucide-react";
import type { ClientStudy, ReviewItem } from "@/lib/catalog-types";
import { formatBs } from "@/lib/format";

export type PendingItem = Exclude<ReviewItem, { kind: "sure" }> & { key: string; origin: "foto" | "lista" };

interface ReviewListProps {
  items: PendingItem[];
  warnings: string[];
  byId: Map<string, ClientStudy>;
  onChoose: (key: string, studyId: string) => void;
  onConfirm: (key: string) => void;
  onDismiss: (key: string) => void;
  onSearch: (key: string, text: string) => void;
}

// Lo que no entró solo al carrito: el usuario lo resuelve con un toque (elegir, confirmar o buscar).
export function ReviewList({ items, warnings, byId, onChoose, onConfirm, onDismiss, onSearch }: ReviewListProps) {
  if (items.length === 0 && warnings.length === 0) return null;
  return (
    <section className="card border-amber-200 p-4" aria-label="Estudios por revisar">
      {warnings.map((warning) => (
        <p key={warning} className="mb-2 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {warning}
        </p>
      ))}
      {items.length > 0 ? (
        <>
          <h2 className="mt-1 mb-2 text-sm font-semibold">Por revisar ({items.length})</h2>
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.key} className="rounded-lg border border-line p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="text-muted">{item.origin === "foto" ? "En la foto" : "En la lista"}: </span>
                      <span className="font-medium">«{item.text}»</span>
                    </p>
                    {item.hint ? <p className="mt-0.5 text-xs text-muted">{item.hint}</p> : null}
                  </div>
                  <button type="button" onClick={() => onDismiss(item.key)} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Descartar">
                    <X className="size-4" aria-hidden />
                  </button>
                </div>

                {item.kind === "choose" ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <p className="text-xs text-muted">¿Cuál de estos es?</p>
                    {item.candidateIds.map((id) => byId.get(id)).filter((study): study is ClientStudy => Boolean(study)).map((study) => (
                      <button key={study.id} type="button" onClick={() => onChoose(item.key, study.id)} className="flex min-h-10 items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-brand-500 hover:bg-brand-50">
                        <span className="flex-1">{study.name}</span>
                        <span className="text-muted tabular-nums">{formatBs(study.priceBs)}</span>
                      </button>
                    ))}
                    <button type="button" onClick={() => onSearch(item.key, item.text)} className="self-start text-xs text-brand-700 underline underline-offset-2">
                      Ninguno: buscar otro
                    </button>
                  </div>
                ) : null}

                {item.kind === "confirm" ? (
                  <div className="mt-2">
                    <p className="text-sm">
                      ¿Es {item.studyIds.map((id) => byId.get(id)?.name ?? "estudio no disponible").join(" + ")}?
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button type="button" onClick={() => onConfirm(item.key)} className="btn-primary min-h-9 px-3 py-1.5">
                        <Check className="size-4" aria-hidden /> Sí, agregar
                      </button>
                      <button type="button" onClick={() => onSearch(item.key, item.text)} className="btn-secondary min-h-9 px-3 py-1.5">
                        No, buscar otro
                      </button>
                    </div>
                  </div>
                ) : null}

                {item.kind === "not_found" ? (
                  <button type="button" onClick={() => onSearch(item.key, item.text)} className="btn-secondary mt-2 min-h-9 px-3 py-1.5">
                    <Search className="size-4" aria-hidden /> Buscar en el catálogo
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
