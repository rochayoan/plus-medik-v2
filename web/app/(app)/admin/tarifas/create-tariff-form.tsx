"use client";

import { useActionState } from "react";
import { createTariff, type CreateTariffState } from "./actions";

export function CreateTariffForm() {
  const [state, action, pending] = useActionState<CreateTariffState, FormData>(createTariff, {});
  return (
    <form action={action} className="card flex flex-wrap items-end gap-3 p-4">
      <div className="min-w-60 flex-1">
        <label htmlFor="tariff-name" className="label">Nueva tarifa</label>
        <input id="tariff-name" name="name" required maxLength={120} className="input" placeholder="Convenio Caja Nacional 2026" />
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>Crear</button>
      {state.error ? <p role="alert" className="w-full text-sm text-red-700">{state.error}</p> : null}
    </form>
  );
}
