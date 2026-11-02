"use client";

import { Bookmark, FileText, LoaderCircle, Trash2, X } from "lucide-react";
import type { ClientStudy } from "@/lib/catalog-types";
import { formatBs } from "@/lib/format";
import { StudyName } from "@/components/study-name";

interface CartProps {
  ids: string[];
  byId: Map<string, ClientStudy>;
  catalogReady: boolean;
  total: number;
  tariffName: string;
  validityDays: number;
  patientName: string;
  onPatientNameChange: (value: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onSaveTemplate: () => void;
  onGenerate: () => void;
  saving: boolean;
  saveError: string | null;
  pendingCount: number;
}

export function Cart(props: CartProps) {
  const { ids, byId, catalogReady, total, pendingCount, saving } = props;
  const available = ids.filter((id) => byId.has(id));
  return (
    <section id="carrito" className="card flex flex-col p-4" aria-label="Cotización">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">Cotización</h2>
        <span className="text-xs text-muted">Tarifa {props.tariffName}</span>
      </div>

      {ids.length === 0 ? (
        <p className="rounded-lg bg-surface px-3 py-6 text-center text-sm text-muted">
          Agrega estudios con el buscador, una foto de la orden o pegando una lista.
        </p>
      ) : (
        <ul className="-mx-1 max-h-[50vh] divide-y divide-line overflow-y-auto lg:max-h-[calc(100dvh-24rem)]">
          {ids.map((id, index) => {
            const study = byId.get(id);
            return (
              <li key={id} className="flex items-center gap-2 px-1 py-2">
                <span className="w-5 shrink-0 text-xs text-muted tabular-nums">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  {study ? (
                    <>
                      <StudyName name={study.name} className="text-sm leading-snug" />
                      {study.sampleType ? <p className="text-xs text-muted">{study.sampleType}</p> : null}
                    </>
                  ) : (
                    <p className="text-sm text-red-700">{catalogReady ? "Estudio ya no disponible (no se cotizará)" : "Cargando…"}</p>
                  )}
                </div>
                <span className="shrink-0 text-sm tabular-nums">{study ? formatBs(study.priceBs) : ""}</span>
                <button type="button" onClick={() => props.onRemove(id)} className="shrink-0 rounded-md p-1.5 text-muted hover:bg-red-50 hover:text-red-700" aria-label={`Quitar ${study?.name ?? "estudio"}`}>
                  <X className="size-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
        <span className="text-sm text-muted">{available.length} {available.length === 1 ? "estudio" : "estudios"}</span>
        <span className="text-xl font-bold tabular-nums">{formatBs(total)}</span>
      </div>

      <label htmlFor="patient" className="label mt-4">Paciente <span className="font-normal text-muted">(opcional)</span></label>
      <input id="patient" className="input" value={props.patientName} maxLength={160} onChange={(event) => props.onPatientNameChange(event.target.value)} placeholder="Nombre para el PDF" autoComplete="off" />

      {props.saveError ? <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{props.saveError}</p> : null}

      <button type="button" onClick={props.onGenerate} disabled={available.length === 0 || saving} className={`mt-4 w-full ${pendingCount > 0 ? "btn-warning" : "btn-primary"}`}>
        {saving ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <FileText className="size-4" aria-hidden />}
        {pendingCount > 0 ? `Generar sin los ${pendingCount} por revisar` : "Generar cotización"}
      </button>
      <p className="mt-2 text-center text-xs text-muted">Válida por {props.validityDays} días · PDF y texto para WhatsApp</p>

      {ids.length > 0 ? (
        <div className="mt-3 flex justify-between">
          <button type="button" onClick={props.onSaveTemplate} className="btn-ghost min-h-9 px-2 py-1 text-xs">
            <Bookmark className="size-3.5" aria-hidden /> Guardar como plantilla
          </button>
          <button type="button" onClick={props.onClear} className="btn-ghost min-h-9 px-2 py-1 text-xs hover:text-red-700">
            <Trash2 className="size-3.5" aria-hidden /> Vaciar
          </button>
        </div>
      ) : null}
    </section>
  );
}
