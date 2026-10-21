"use client";

import { Check, Plus, Search, X } from "lucide-react";
import { useEffect, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import type { ClientStudy } from "@/lib/catalog-types";
import { formatBs } from "@/lib/format";

interface SearchBoxProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  results: ClientStudy[];
  frequent: ClientStudy[];
  inCart: Set<string>;
  onToggle: (id: string) => void;
  // Devuelve true si el texto pegado era una lista y ya se procesó.
  onPasteList: (text: string) => boolean;
  disabled: boolean;
}

export function SearchBox({ inputRef, query, onQueryChange, results, frequent, inCart, onToggle, onPasteList, disabled }: SearchBoxProps) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);

  const choose = (study: ClientStudy | undefined) => {
    if (!study) return;
    onToggle(study.id);
    // Agregar y seguir escribiendo: el foco vuelve al buscador vacío.
    if (!inCart.has(study.id)) onQueryChange("");
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(results[active]);
    } else if (event.key === "Escape") {
      onQueryChange("");
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (onPasteList(event.clipboardData.getData("text"))) event.preventDefault();
  };

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          disabled={disabled}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={disabled ? "Cargando catálogo…" : "Busca un estudio: hemograma, TSH, glic…  (o pega una lista)"}
          aria-label="Buscar estudio"
          aria-controls="search-results"
          aria-activedescendant={results[active] ? `result-${results[active].id}` : undefined}
          className="input h-13 pr-10 pl-10 text-base [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button type="button" onClick={() => { onQueryChange(""); inputRef.current?.focus(); }} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1.5 text-muted hover:bg-surface" aria-label="Limpiar búsqueda">
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {query ? (
        results.length > 0 ? (
          <ul id="search-results" role="listbox" className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">
            {results.map((study, index) => {
              const added = inCart.has(study.id);
              return (
                <li
                  key={study.id}
                  id={`result-${study.id}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(study)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 ${index === active ? "bg-brand-50" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{study.name}</p>
                    <p className="truncate text-xs text-muted">{[study.code && `Cód. ${study.code}`, study.sampleType].filter(Boolean).join(" · ") || " "}</p>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums">{formatBs(study.priceBs)}</span>
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${added ? "bg-brand-600 text-white" : "border border-line text-muted"}`} aria-label={added ? "En la cotización" : "Agregar"}>
                    {added ? <Check className="size-4" aria-hidden /> : <Plus className="size-4" aria-hidden />}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted">Sin resultados para «{query}». Prueba con otra palabra o una sigla.</p>
        )
      ) : frequent.length > 0 ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Tus frecuentes</p>
          <div className="flex flex-wrap gap-2">
            {frequent.map((study) => {
              const added = inCart.has(study.id);
              return (
                <button
                  key={study.id}
                  type="button"
                  onClick={() => onToggle(study.id)}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${added ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-white hover:border-brand-500"}`}
                >
                  {added ? <Check className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
                  {study.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
