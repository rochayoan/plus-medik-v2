"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useActionState } from "react";
import { formatBs } from "@/lib/format";
import { importTariff, type ImportState } from "../actions";

export function ImportForm({ tariffId }: { tariffId: string }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importTariff, {});
  return (
    <div className="space-y-4">
      <form action={action} className="card space-y-3 p-4">
        <input type="hidden" name="tariffId" value={tariffId} />
        <input type="hidden" name="intent" value="preview" />
        <h2 className="font-semibold">Importar precios</h2>
        <p className="text-sm text-muted">
          Columnas: <code>codigo</code> (o <code>id</code> o <code>nombre</code>) y <code>precio</code>. En Excel: «Guardar como → CSV». Las filas sin precio se ignoran.
        </p>
        <input type="file" name="file" accept=".csv,text/csv" required className="block text-sm" />
        <button type="submit" className="btn-secondary" disabled={pending}>
          {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Ver vista previa
        </button>
      </form>

      {state.error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}
      {state.applied ? (
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700">
          Listo: {state.applied.count} precios guardados{state.applied.replaced ? " (se borraron los que no venían en el archivo)" : ""}. Los usuarios verán los precios nuevos en unos minutos.
        </p>
      ) : null}

      {state.preview && state.csv ? (
        <form action={action} className="card space-y-3 p-4">
          <input type="hidden" name="tariffId" value={tariffId} />
          <input type="hidden" name="intent" value="apply" />
          <textarea name="csv" defaultValue={state.csv} hidden readOnly />
          <h2 className="font-semibold">Vista previa</h2>
          <p className="text-sm">
            <strong>{state.preview.matched}</strong> estudios reconocidos · {state.preview.unmatched.length} sin reconocer · {state.preview.errors.length} filas con error · {state.preview.skipped} sin precio
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr><th className="py-1">Línea</th><th>Estudio</th><th className="text-right">Paciente</th><th className="text-right">Tarifa</th></tr>
            </thead>
            <tbody className="tabular-nums">
              {state.preview.sample.map((row) => (
                <tr key={row.line} className="border-t border-line">
                  <td className="py-1">{row.line}</td>
                  <td>{row.name}</td>
                  <td className="text-right text-muted">{formatBs(row.patientPrice)}</td>
                  <td className="text-right">{formatBs(row.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.preview.matched > state.preview.sample.length ? <p className="text-xs text-muted">…y {state.preview.matched - state.preview.sample.length} más.</p> : null}

          {state.preview.unmatched.length + state.preview.errors.length > 0 ? (
            <details className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" open={state.preview.unmatched.length + state.preview.errors.length <= 10}>
              <summary className="flex cursor-pointer items-center gap-2"><TriangleAlert className="size-4" aria-hidden /> Filas que no se importarán</summary>
              <ul className="mt-2 space-y-0.5">
                {state.preview.errors.map((row) => <li key={`e${row.line}`}>Línea {row.line}: {row.message}</li>)}
                {state.preview.unmatched.map((row) => <li key={`u${row.line}${row.reason}`}>Línea {row.line} ({row.label}): {row.reason}</li>)}
              </ul>
            </details>
          ) : null}

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="replace" className="mt-1" />
            <span>Reemplazar toda la tarifa: los estudios que no estén en el archivo vuelven al precio Paciente.</span>
          </label>
          <button type="submit" className="btn-primary" disabled={pending || state.preview.matched === 0}>
            {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Aplicar {state.preview.matched} precios
          </button>
        </form>
      ) : null}
    </div>
  );
}
