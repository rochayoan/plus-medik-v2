"use client";

import { Bookmark, Camera, ClipboardList, ImageUp, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientStudy, PhotoPrefill, QuoteSource, ReviewItem } from "@/lib/catalog-types";
import { formatBs } from "@/lib/format";
import { looksLikeList, resolvePastedList } from "@/lib/paste";
import { createStudySearch } from "@/lib/search";
import { browserClient } from "@/lib/supabase/browser";
import { Cart } from "./cart";
import { PhotoPanel } from "./photo-panel";
import { ReviewList, type PendingItem } from "./review-list";
import { SearchBox } from "./search-box";
import { TemplatesPanel } from "./templates-panel";
import { useCatalog } from "./use-catalog";
import { usePhotoJob } from "./use-photo-job";

export interface QuoterInitial {
  ids: string[];
  source: QuoteSource;
  patientName: string | null;
}

interface QuoterProps {
  userId: string;
  tariffName: string;
  validityDays: number;
  initial: QuoterInitial | null;
}

interface Draft {
  ids: string[];
  patientName: string;
  source: QuoteSource;
  photoJobId: string | null;
}

let keySequence = 0;
const nextKey = () => `r${++keySequence}`;

export function Quoter({ userId, tariffName, validityDays, initial }: QuoterProps) {
  const router = useRouter();
  const { catalog, error: catalogError, reload } = useCatalog(userId);
  const byId = useMemo(() => new Map((catalog?.studies ?? []).map((study) => [study.id, study])), [catalog]);
  const search = useMemo(() => createStudySearch(catalog?.studies ?? []), [catalog]);

  const [ids, setIds] = useState<string[]>([]);
  const [patientName, setPatientName] = useState("");
  const [source, setSource] = useState<QuoteSource>("manual");
  const [photoJobId, setPhotoJobId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"none" | "paste" | "templates" | "save-template">("none");
  const [pasteText, setPasteText] = useState("");
  const [photoSummary, setPhotoSummary] = useState<string | null>(null);
  const [frequentIds, setFrequentIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const draftKey = `pm:draft:${userId}`;

  // Borrador local: recargar la página o perder señal no borra la cotización en curso.
  useEffect(() => {
    if (initial) {
      setIds(initial.ids);
      setSource(initial.source);
      setPatientName(initial.patientName ?? "");
      router.replace("/cotizar", { scroll: false });
    } else {
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey) ?? "null") as Draft | null;
        if (draft?.ids?.length) {
          setIds(draft.ids);
          setPatientName(draft.patientName ?? "");
          setSource(draft.source ?? "manual");
          setPhotoJobId(draft.photoJobId ?? null);
        }
      } catch {
        // borrador ilegible o sin almacenamiento
      }
    }
    setRestored(true);
    // Solo al montar.
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      if (ids.length === 0 && !patientName) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, JSON.stringify({ ids, patientName, source, photoJobId } satisfies Draft));
    } catch {
      // sin almacenamiento: no afecta el uso
    }
  }, [restored, draftKey, ids, patientName, source, photoJobId]);

  useEffect(() => {
    void browserClient()
      .rpc("frequent_studies", { p_limit: 12 })
      .then(({ data }) => setFrequentIds(((data as Array<{ lab_test_id: string }> | null) ?? []).map((row) => row.lab_test_id)));
  }, []);

  // "/" enfoca el buscador desde cualquier parte (como en las apps de búsqueda).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const inCart = useMemo(() => new Set(ids), [ids]);
  const total = useMemo(() => ids.reduce((sum, id) => sum + (byId.get(id)?.priceBs ?? 0), 0), [ids, byId]);
  const results = useMemo(() => search.search(query, 8), [search, query]);
  const frequent = useMemo(() => frequentIds.map((id) => byId.get(id)).filter((study): study is ClientStudy => Boolean(study)), [frequentIds, byId]);

  const markSource = useCallback((next: QuoteSource) => {
    // El primer atajo usado define el origen (para medir qué ahorra más tiempo).
    setSource((current) => (current === "manual" ? next : current));
  }, []);

  const addIds = useCallback((newIds: string[]) => {
    setIds((current) => [...current, ...newIds.filter((id, index) => !current.includes(id) && newIds.indexOf(id) === index)]);
    setSaveError(null);
  }, []);

  const toggle = useCallback((id: string) => {
    setIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    setSaveError(null);
  }, []);

  // Lo seguro entra al carrito; el resto queda para revisar con un toque.
  const applyReview = useCallback((items: ReviewItem[], origin: PendingItem["origin"]) => {
    const sure: string[] = [];
    const rest: PendingItem[] = [];
    for (const item of items) {
      if (item.kind === "sure") {
        if (byId.has(item.studyId)) sure.push(item.studyId);
        else rest.push({ kind: "not_found", text: item.text, key: nextKey(), origin, hint: "El estudio ya no está en el catálogo" });
      } else {
        rest.push({ ...item, key: nextKey(), origin });
      }
    }
    addIds(sure);
    setPending((current) => [...current, ...rest]);
    return { added: sure.length, toReview: rest.length };
  }, [addIds, byId]);

  const applyPaste = useCallback((text: string) => {
    if (!catalog) return false;
    const items = resolvePastedList(text, catalog.studies, search);
    if (items.length === 0) return false;
    applyReview(items, "lista");
    markSource("paste");
    return true;
  }, [applyReview, catalog, markSource, search]);

  const onPhotoResult = useCallback((jobId: string, prefill: PhotoPrefill) => {
    setPhotoJobId(jobId);
    markSource("photo");
    setWarnings(prefill.warnings);
    const { added, toReview } = applyReview(prefill.items, "foto");
    const parts = [`Se agregaron ${added} ${added === 1 ? "estudio" : "estudios"}`];
    if (toReview > 0) parts.push(`revisa ${toReview} abajo`);
    setPhotoSummary(`${parts.join("; ")}.`);
  }, [applyReview, markSource]);

  const photo = usePhotoJob(onPhotoResult);

  const onPhotoFile = (file: File | undefined) => {
    if (!file) return;
    setPhotoSummary(null);
    setWarnings([]);
    setPending((current) => current.filter((item) => item.origin !== "foto"));
    void photo.start(file);
  };

  const resolvePending = (key: string, addedIds: string[] = []) => {
    if (addedIds.length > 0) addIds(addedIds);
    setPending((current) => {
      const rest = current.filter((item) => item.key !== key);
      if (!rest.some((item) => item.origin === "foto")) setWarnings([]);
      return rest;
    });
  };

  const searchFor = (key: string, text: string) => {
    resolvePending(key);
    setQuery(text);
    searchRef.current?.focus();
    searchRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const clearAll = () => {
    setIds([]);
    setPatientName("");
    setSource("manual");
    setPhotoJobId(null);
    setPending([]);
    setWarnings([]);
    setSaveError(null);
    setPhotoSummary(null);
    photo.reset();
  };

  const generate = async () => {
    const valid = ids.filter((id) => byId.has(id));
    if (valid.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const { data, error } = await browserClient().rpc("create_quote", {
      p_lab_test_ids: valid,
      p_patient_name: patientName.trim() || null,
      p_source: source,
      p_photo_job_id: photoJobId,
      p_validity_days: validityDays
    });
    if (error || !data) {
      setSaving(false);
      if (/no existe o no está activo/.test(error?.message ?? "")) {
        setSaveError("Algún estudio cambió en el catálogo. Actualizamos la lista: revisa la cotización e intenta de nuevo.");
        void reload();
      } else {
        // 42501/22023: mensajes propios de create_quote (en español, pensados para el usuario).
        const own = error?.code === "42501" || error?.code === "22023";
        setSaveError(own && error?.message ? error.message : "No se pudo generar la cotización. Revisa tu conexión e intenta de nuevo.");
      }
      return;
    }
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // sin almacenamiento
    }
    router.push(`/cotizacion/${(data as { id: string }).id}`);
  };

  if (catalogError && !catalog) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <p className="text-red-700">{catalogError}</p>
        <button type="button" onClick={() => void reload()} className="btn-primary mt-4">Reintentar</button>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-4 px-4 pt-4 pb-28 lg:grid-cols-[minmax(0,1fr)_380px] lg:pb-8">
      <div className="space-y-4">
        <section className="card p-4">
          <SearchBox
            inputRef={searchRef}
            query={query}
            onQueryChange={setQuery}
            results={results}
            frequent={frequent}
            inCart={inCart}
            onToggle={toggle}
            onPasteList={(text) => looksLikeList(text) && applyPaste(text)}
            disabled={!catalog}
          />
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button type="button" className="btn-secondary" onClick={() => cameraRef.current?.click()} disabled={!catalog}>
              <Camera className="size-4" aria-hidden /> Tomar foto
            </button>
            <button type="button" className="btn-secondary" onClick={() => galleryRef.current?.click()} disabled={!catalog}>
              <ImageUp className="size-4" aria-hidden /> Subir imagen
            </button>
            <button type="button" className={panel === "paste" ? "btn-primary" : "btn-secondary"} onClick={() => setPanel(panel === "paste" ? "none" : "paste")} disabled={!catalog}>
              <ClipboardList className="size-4" aria-hidden /> Pegar lista
            </button>
            <button type="button" className={panel === "templates" ? "btn-primary" : "btn-secondary"} onClick={() => setPanel(panel === "templates" ? "none" : "templates")} disabled={!catalog}>
              <Bookmark className="size-4" aria-hidden /> Plantillas
            </button>
          </div>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => { onPhotoFile(event.target.files?.[0]); event.target.value = ""; }} />
          <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="hidden" onChange={(event) => { onPhotoFile(event.target.files?.[0]); event.target.value = ""; }} />
          {!catalog ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-muted"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Cargando catálogo…</p>
          ) : null}
        </section>

        {panel === "paste" ? (
          <section className="card p-4" aria-label="Pegar lista">
            <label htmlFor="paste" className="label">Pega la lista de estudios (uno por línea o separados por coma)</label>
            <textarea id="paste" value={pasteText} onChange={(event) => setPasteText(event.target.value)} rows={5} autoFocus className="input font-mono text-sm" placeholder={"Hemograma\nGlicemia\nTSH, T4 libre\nPerfil lipídico"} />
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-primary" disabled={!pasteText.trim()} onClick={() => { if (applyPaste(pasteText)) { setPasteText(""); setPanel("none"); } }}>
                Agregar a la cotización
              </button>
              <button type="button" className="btn-ghost" onClick={() => setPanel("none")}>Cancelar</button>
            </div>
          </section>
        ) : null}

        {panel === "templates" || panel === "save-template" ? (
          <TemplatesPanel
            mode={panel === "save-template" ? "save" : "load"}
            currentIds={ids}
            onLoad={(templateIds) => { addIds(templateIds.filter((id) => byId.has(id))); markSource("template"); }}
            onClose={() => setPanel("none")}
          />
        ) : null}

        <PhotoPanel state={photo.state} summary={photoSummary} onRetry={photo.retry} onClose={() => { photo.reset(); setPhotoSummary(null); }} />

        <ReviewList
          items={pending}
          warnings={warnings}
          byId={byId}
          onChoose={(key, studyId) => resolvePending(key, [studyId])}
          onConfirm={(key) => {
            const item = pending.find((candidate) => candidate.key === key);
            resolvePending(key, item?.kind === "confirm" ? item.studyIds.filter((id) => byId.has(id)) : []);
          }}
          onDismiss={(key) => resolvePending(key)}
          onSearch={searchFor}
        />
      </div>

      <div className="lg:sticky lg:top-18 lg:self-start">
        <Cart
          ids={ids}
          byId={byId}
          catalogReady={Boolean(catalog)}
          total={total}
          tariffName={catalog?.tariffName ?? tariffName}
          validityDays={validityDays}
          patientName={patientName}
          onPatientNameChange={setPatientName}
          onRemove={toggle}
          onClear={clearAll}
          onSaveTemplate={() => setPanel("save-template")}
          onGenerate={() => void generate()}
          saving={saving}
          saveError={saveError}
          pendingCount={pending.length}
        />
      </div>

      {/* Barra inferior en el celular: total siempre visible y acceso directo a la cotización. */}
      {ids.length > 0 ? (
        <a href="#carrito" className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-line bg-white px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] lg:hidden">
          <span className="text-sm">{ids.length} {ids.length === 1 ? "estudio" : "estudios"} · <strong className="tabular-nums">{formatBs(total)}</strong></span>
          <span className="btn-primary min-h-10 px-4 py-2">Ver cotización</span>
        </a>
      ) : null}
    </div>
  );
}
