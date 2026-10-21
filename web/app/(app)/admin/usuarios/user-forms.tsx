"use client";

import { Check, Copy } from "lucide-react";
import { useActionState, useState } from "react";
import { createUser, resetPassword, type CreateUserState, type ResetState } from "./actions";

type Org = { id: string; name: string };

function CredentialsBox({ email, password }: { email?: string; password: string }) {
  const [copied, setCopied] = useState(false);
  const text = email
    ? `Tu acceso al cotizador PlusMedik:\nCorreo: ${email}\nContraseña temporal: ${password}\nAl ingresar te pedirá crear tu propia contraseña.`
    : `Tu nueva contraseña temporal del cotizador PlusMedik: ${password}\nAl ingresar te pedirá crear una propia.`;
  return (
    <div className="rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm">
      <p className="font-medium">Contraseña temporal (solo se muestra ahora): <code className="rounded bg-white px-1.5 py-0.5">{password}</code></p>
      <button
        type="button"
        className="btn-secondary mt-2 min-h-9 px-3 py-1.5"
        onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
      >
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} Copiar mensaje para enviar
      </button>
    </div>
  );
}

export function CreateUserForm({ organizations }: { organizations: Org[] }) {
  const [state, action, pending] = useActionState<CreateUserState, FormData>(createUser, {});
  return (
    <form action={action} className="card space-y-3 p-4">
      <h2 className="font-semibold">Nuevo usuario</h2>
      <div className="grid gap-3 md:grid-cols-4">
        <div>
          <label htmlFor="u-email" className="label">Correo</label>
          <input id="u-email" name="email" type="email" required className="input" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="u-name" className="label">Nombre</label>
          <input id="u-name" name="fullName" required maxLength={120} className="input" placeholder="Dra. Ana Rojas" />
        </div>
        <div>
          <label htmlFor="u-org" className="label">Organización</label>
          <select id="u-org" name="organizationId" className="input" defaultValue="">
            <option value="">— Elegir —</option>
            {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="u-role" className="label">Rol</label>
          <select id="u-role" name="role" className="input" defaultValue="member">
            <option value="member">Usuario</option>
            <option value="org_admin">Responsable (ve todo lo de su organización)</option>
            <option value="admin">Administrador PlusMedik</option>
          </select>
        </div>
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>Crear usuario</button>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
      {state.created ? <CredentialsBox email={state.created.email} password={state.created.password} /> : null}
    </form>
  );
}

export function ResetPasswordButton({ userId }: { userId: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(resetPassword, {});
  return (
    <div>
      <form action={action} onSubmit={(event) => { if (!window.confirm("¿Generar una contraseña temporal nueva para este usuario?")) event.preventDefault(); }}>
        <input type="hidden" name="userId" value={userId} />
        <button type="submit" className="btn-secondary min-h-9 px-3 py-1.5 text-xs" disabled={pending}>Restablecer contraseña</button>
      </form>
      {state.password ? <div className="mt-2"><CredentialsBox password={state.password} /></div> : null}
      {state.error ? <p className="mt-1 text-xs text-red-700">{state.error}</p> : null}
    </div>
  );
}
