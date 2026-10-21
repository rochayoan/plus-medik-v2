"use client";

import { useActionState } from "react";
import { createOrganization, type OrgFormState } from "./actions";

export function CreateOrgForm({ tariffs }: { tariffs: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState<OrgFormState, FormData>(createOrganization, {});
  return (
    <form action={action} className="card grid gap-3 p-4 sm:grid-cols-[1fr_160px_200px_auto] sm:items-end">
      <div>
        <label htmlFor="org-name" className="label">Nombre</label>
        <input id="org-name" name="name" required maxLength={160} className="input" placeholder="Clínica San Juan / Dr. Pérez" />
      </div>
      <div>
        <label htmlFor="org-kind" className="label">Tipo</label>
        <select id="org-kind" name="kind" className="input" defaultValue="convenio">
          <option value="convenio">Convenio</option>
          <option value="clinica">Clínica</option>
          <option value="medico">Médico</option>
        </select>
      </div>
      <div>
        <label htmlFor="org-tariff" className="label">Tarifa</label>
        <select id="org-tariff" name="tariffId" className="input" defaultValue="">
          <option value="">Paciente (sin tarifa)</option>
          {tariffs.map((tariff) => <option key={tariff.id} value={tariff.id}>{tariff.name}</option>)}
        </select>
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>Crear</button>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-4">{state.error}</p> : null}
    </form>
  );
}
