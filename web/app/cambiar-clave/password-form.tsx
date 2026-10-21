"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState } from "react";
import { changePassword, type PasswordState } from "./actions";

export function PasswordForm() {
  const [state, action, pending] = useActionState<PasswordState, FormData>(changePassword, {});
  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="password" className="label">Nueva contraseña</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required autoFocus className="input" />
      </div>
      <div>
        <label htmlFor="confirm" className="label">Repite la contraseña</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required className="input" />
      </div>
      {state.error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p> : null}
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
        Guardar y continuar
      </button>
    </form>
  );
}
