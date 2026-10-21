"use client";

import { LoaderCircle, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";

interface Template {
  id: string;
  name: string;
  lab_test_ids: string[];
}

interface TemplatesPanelProps {
  mode: "load" | "save";
  currentIds: string[];
  onLoad: (ids: string[]) => void;
  onClose: () => void;
}

// Plantillas propias del usuario ("Chequeo general", "Control diabético"...). RLS: cada uno ve solo las suyas.
export function TemplatesPanel({ mode, currentIds, onLoad, onClose }: TemplatesPanelProps) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void browserClient()
      .from("quote_templates")
      .select("id, name, lab_test_ids")
      .order("name")
      .then(({ data, error }) => {
        if (error) setMessage("No se pudieron cargar las plantillas.");
        setTemplates((data as Template[] | null) ?? []);
      });
  }, []);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    const existing = templates?.find((template) => template.name.toLowerCase() === trimmed.toLowerCase());
    const { error } = existing
      ? await browserClient().from("quote_templates").update({ lab_test_ids: currentIds, updated_at: new Date().toISOString() }).eq("id", existing.id)
      : await browserClient().from("quote_templates").insert({ name: trimmed, lab_test_ids: currentIds });
    setBusy(false);
    if (error) {
      setMessage("No se pudo guardar la plantilla.");
      return;
    }
    onClose();
  };

  const remove = async (template: Template) => {
    if (!window.confirm(`¿Borrar la plantilla «${template.name}»?`)) return;
    const { error } = await browserClient().from("quote_templates").delete().eq("id", template.id);
    if (error) setMessage("No se pudo borrar la plantilla.");
    else setTemplates((list) => list?.filter((item) => item.id !== template.id) ?? null);
  };

  return (
    <section className="card p-4" aria-label="Plantillas">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{mode === "save" ? "Guardar como plantilla" : "Plantillas"}</h2>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface" aria-label="Cerrar">
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {mode === "save" ? (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex gap-2">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="Ej.: Chequeo general" autoFocus list="template-names" />
          <datalist id="template-names">{templates?.map((template) => <option key={template.id} value={template.name} />)}</datalist>
          <button type="submit" className="btn-primary shrink-0" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null} Guardar
          </button>
        </form>
      ) : templates === null ? (
        <p className="flex items-center gap-2 text-sm text-muted"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Cargando…</p>
      ) : templates.length === 0 ? (
        <p className="text-sm text-muted">Aún no tienes plantillas. Arma una cotización y usa «Guardar como plantilla».</p>
      ) : (
        <ul className="divide-y divide-line">
          {templates.map((template) => (
            <li key={template.id} className="flex items-center gap-2 py-1.5">
              <button type="button" onClick={() => { onLoad(template.lab_test_ids); onClose(); }} className="flex min-h-10 flex-1 items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-brand-50">
                <span className="font-medium">{template.name}</span>
                <span className="text-xs text-muted">{template.lab_test_ids.length} estudios</span>
              </button>
              <button type="button" onClick={() => void remove(template)} className="rounded-md p-2 text-muted hover:bg-red-50 hover:text-red-700" aria-label={`Borrar ${template.name}`}>
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {mode === "save" && templates?.some((template) => template.name.toLowerCase() === name.trim().toLowerCase()) ? (
        <p className="mt-2 text-xs text-amber-700">Ya existe una plantilla con ese nombre: se reemplazará.</p>
      ) : null}
      {message ? <p role="alert" className="mt-2 text-sm text-red-700">{message}</p> : null}
    </section>
  );
}
